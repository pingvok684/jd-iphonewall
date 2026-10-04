// Magnific: generovanie videí cez Magnific API + galéria hotových videí, ktoré sa dajú poslať do telefónov.
// API: https://api.magnific.com, hlavička x-magnific-api-key. Úlohy sú asynchrónne (task_id → stav → URL videa).

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const store = require('./store');
const media = require('./media');

const API = process.env.MAGNIFIC_API || 'https://api.magnific.com';
const DIR = path.join(store.DATA, 'magnific');
fs.mkdirSync(DIR, { recursive: true });

// modely zdokumentované vo verejnom API (Wan 3.0 480p tam zatiaľ nie je)
const MODELS = [
  { id: 'wan26-i2v', label: 'Wan 2.6 · z obrázka · 1080p', path: '/v1/ai/image-to-video/wan-v2-6-1080p', needsImage: true,
    sizes: { vertical: '1080*1920', square: '1440*1440', horizontal: '1920*1080' } },
  { id: 'wan26-t2v', label: 'Wan 2.6 · z textu · 720p', path: '/v1/ai/text-to-video/wan-v2-6-720p', needsImage: false,
    sizes: { vertical: '720*1280', horizontal: '1280*720' } },
];

let items = store.readJson('magnific.json', []);
// rozbehnuté generovania po reštarte nevieme dokončiť bez task_id → necháme ich dopollovať
const save = () => store.writeJson('magnific.json', items);

// Priečinok „magnific-inbox“: každé video, ktoré sa doň uloží (napr. stiahnuté z Magnificu
// alebo vygenerované cez Claude s Wan 3.0 480p), sa samo objaví v galérii na stránke.
const INBOX = path.join(__dirname, 'magnific-inbox');
fs.mkdirSync(INBOX, { recursive: true });
const seenSizes = new Map();
function scanInbox() {
  let files = [];
  try { files = fs.readdirSync(INBOX); } catch (_) { return; }
  for (const f of files) {
    if (!/\.(mp4|mov|m4v)$/i.test(f) || f.startsWith('.')) continue;
    const full = path.join(INBOX, f);
    let size; try { size = fs.statSync(full).size; } catch (_) { continue; }
    if (!size || seenSizes.get(f) !== size) { seenSizes.set(f, size); continue; } // ešte sa zapisuje – počkáme
    seenSizes.delete(f);
    const it = { id: store.newId(), kind: 'inbox', status: 'hotovo', prompt: '', name: f, at: new Date().toISOString() };
    it.file = `${it.id}${path.extname(f).toLowerCase()}`;
    try { fs.renameSync(full, path.join(DIR, it.file)); } catch (_) { try { fs.copyFileSync(full, path.join(DIR, it.file)); fs.unlinkSync(full); } catch (e) { continue; } }
    items.unshift(it); save();
    store.addActivity('media', `Magnific: nové video v galérii (${f})`);
  }
}

let getKey = () => '';
function init(keyGetter) {
  getKey = keyGetter;
  setInterval(scanInbox, 4000);
  for (const it of items) if (it.status === 'generujem' && it.taskId) poll(it);
  for (const it of items) if (['čaká', 'sťahujem'].includes(it.status) && !it.taskId) { it.status = 'chyba'; it.error = 'Prerušené reštartom servera'; }
  save();
}

const list = () => items.map(({ id, kind, status, prompt, model, file, error, at, name, progress }) => ({ id, kind, status, prompt, model, file, error, at, name, progress }));

async function api(method, p, body) {
  const key = getKey();
  if (!key) throw new Error('Chýba Magnific API kľúč (Nastavenia)');
  const r = await fetch(API + p, {
    method,
    headers: { 'x-magnific-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (_) {}
  if (!r.ok) throw new Error((j.message || j.error || (j.data && j.data.message) || txt || `HTTP ${r.status}`).toString().slice(0, 300));
  return j;
}

// nájde v odpovedi URL hotového videa (rôzne endpointy ho vracajú trochu inak)
function findVideoUrl(obj) {
  const d = obj && (obj.data || obj);
  if (d && Array.isArray(d.generated) && d.generated.length) return typeof d.generated[0] === 'string' ? d.generated[0] : d.generated[0].url;
  let found = null;
  JSON.stringify(obj, (k, v) => { if (!found && typeof v === 'string' && /^https?:\/\/\S+\.(mp4|mov|webm)(\?|$)/i.test(v)) found = v; return v; });
  return found;
}

async function download(url, it) {
  it.status = 'sťahujem'; save();
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Sťahovanie zlyhalo (HTTP ${r.status})`);
  const ct = r.headers.get('content-type') || '';
  if (/text\/html/i.test(ct)) throw new Error('Odkaz vedie na stránku, nie na video. V Magnificu daj Stiahnuť a skopíruj priamy odkaz na súbor (.mp4).');
  const ext = /quicktime/.test(ct) ? '.mov' : '.mp4';
  const file = `${it.id}${ext}`;
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(path.join(DIR, file)));
  it.file = file; it.status = 'hotovo'; save();
  store.addActivity('media', `Magnific: video pripravené (${it.name || it.prompt || 'video'})`);
}

async function poll(it) {
  const model = MODELS.find((m) => m.id === it.model);
  const started = Date.now();
  while (Date.now() - started < 30 * 60000) {
    await new Promise((r) => setTimeout(r, 6000));
    try {
      const j = await api('GET', `${model.path}/${it.taskId}`);
      const st = String((j.data && j.data.status) || j.status || '').toUpperCase();
      it.progress = st; save();
      if (st === 'COMPLETED' || st === 'SUCCEEDED' || st === 'DONE') {
        const url = findVideoUrl(j);
        if (!url) throw new Error('Magnific nevrátil odkaz na video');
        return download(url, it);
      }
      if (st === 'FAILED' || st === 'ERROR' || st === 'CANCELLED') throw new Error('Magnific: generovanie zlyhalo');
    } catch (e) {
      if (/HTTP 5\d\d|fetch failed|ECONN/i.test(e.message)) continue; // dočasný výpadok – skúsime znova
      it.status = 'chyba'; it.error = e.message; save();
      store.addActivity('error', `Magnific: ${e.message}`);
      return;
    }
  }
  it.status = 'chyba'; it.error = 'Generovanie trvalo príliš dlho'; save();
}

// POST /api/magnific/generate?model=&prompt=&duration=&format=&name=   (telo = obrázok, ak ho model potrebuje)
async function generate(req, q) {
  const model = MODELS.find((m) => m.id === q.get('model')) || MODELS[0];
  const prompt = (q.get('prompt') || '').trim().slice(0, 2000);
  if (!prompt) { req.resume(); throw new Error('Napíš prompt'); }
  const it = { id: store.newId(), kind: 'gen', status: 'čaká', prompt, model: model.id, at: new Date().toISOString(), name: q.get('name') || '' };
  const body = { prompt, duration: ['5', '10', '15'].includes(q.get('duration')) ? q.get('duration') : '5' };
  const size = model.sizes[q.get('format')] || Object.values(model.sizes)[0];
  body.size = size;
  if (q.get('negative')) body.negative_prompt = q.get('negative').slice(0, 1000);

  if (model.needsImage) {
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (!len) { req.resume(); throw new Error('Tento model potrebuje fotku – pretiahni ju do políčka'); }
    const ext = (path.extname(q.get('name') || '') || '.jpg').toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) { req.resume(); throw new Error('Fotka musí byť jpg, png alebo webp'); }
    const imgFile = path.join(DIR, `${it.id}-src${ext}`);
    await pipeline(req, fs.createWriteStream(imgFile));
    const url = media.publishTemp(imgFile, `zdroj${ext}`, 120);
    if (!url) throw new Error('Na posielanie fotky do Magnificu musí bežať tunel (📡 Médiá cez internet)');
    body.image = url;
    it.source = path.basename(imgFile);
  } else req.resume();

  items.unshift(it); save();
  try {
    const j = await api('POST', model.path, body);
    it.taskId = (j.data && j.data.task_id) || j.task_id || (j.task && j.task.task_id);
    if (!it.taskId) throw new Error('Magnific nevrátil task_id');
    it.status = 'generujem'; save();
    store.addActivity('media', `Magnific: generujem video (${model.label})`);
    poll(it);
  } catch (e) {
    it.status = 'chyba'; it.error = e.message; save();
    throw e;
  }
  return it;
}

// hotové video z odkazu (priamy odkaz na súbor z Magnificu)
async function addLink(url, name) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('Vlož odkaz začínajúci https://');
  const it = { id: store.newId(), kind: 'link', status: 'čaká', prompt: '', name: name || '', at: new Date().toISOString(), link: url };
  items.unshift(it); save();
  download(url, it).catch((e) => { it.status = 'chyba'; it.error = e.message; save(); });
  return it;
}

// hotové video nahraté z počítača
async function addUpload(req, name) {
  const ext = path.extname(name || '').toLowerCase();
  if (!['.mp4', '.mov', '.m4v'].includes(ext)) { req.resume(); throw new Error('Nahraj video mp4 alebo mov'); }
  const it = { id: store.newId(), kind: 'upload', status: 'sťahujem', prompt: '', name, at: new Date().toISOString() };
  const file = `${it.id}${ext}`;
  await pipeline(req, fs.createWriteStream(path.join(DIR, file)));
  it.file = file; it.status = 'hotovo';
  items.unshift(it); save();
  return it;
}

function remove(id) {
  const it = items.find((x) => x.id === id);
  if (it) for (const f of [it.file, it.source]) if (f) fs.unlink(path.join(DIR, f), () => {});
  items = items.filter((x) => x.id !== id); save();
}

const filePath = (id) => { const it = items.find((x) => x.id === id); return it && it.file ? { file: path.join(DIR, it.file), name: it.name && /\.\w+$/.test(it.name) ? it.name : `magnific-${it.id}${path.extname(it.file)}` } : null; };

module.exports = { MODELS, DIR, INBOX, init, list, generate, addLink, addUpload, remove, filePath };
