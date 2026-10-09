// Účet a synchronizácia – aby sa dala aplikácia používať striedavo na viacerých počítačoch.
// Knižnica (aj fotky a videá), kalendár, šablóny, profily účtov, názvy telefónov a štatistiky sa ukladajú
// na tvoj rozcestník (Cloudflare Worker + R2). API kľúče a heslá sa NIKDY neposielajú.
//
// Princíp (pre striedavé používanie): pri každom dokumente si pamätáme, ako vyzeral pri poslednej synchronizácii (base).
//   zmenil sa len u mňa → nahrám · zmenil sa len v cloude → stiahnem · oboje → zlúčim (podľa id) a nahrám.
// Médiá z knižnice sa ukladajú podľa obsahu (sha1) – nahrávajú sa a sťahujú postupne na pozadí.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let ctx = null; // { root, data, libDir, config, saveConfig, reload, log, relay }
const st = { running: false, at: 0, error: '', phase: '', up: 0, down: 0, pendingUp: 0, pendingDown: 0, skipped: 0 };
const MAX_BLOB = 95 * 1024 * 1024; // limit rozcestníka na jeden súbor

// dokumenty: meno v cloude → súbor v počítači + spôsob zlúčenia
function docs() {
  const d = ctx.data, r = ctx.root;
  return {
    tombstones: { file: path.join(d, 'sync-tombstones.json'), merge: 'tomb' }, // najprv – podľa nich sa filtruje zlúčenie
    library: { file: path.join(d, 'library.json'), merge: 'byId' },
    calendar: { file: path.join(d, 'calendar.json'), merge: 'byId' },
    profiles: { file: path.join(d, 'profiles.json'), merge: 'object' },
    templates: { file: path.join(r, 'templates.json'), merge: 'byName' },
    labels: { file: path.join(r, 'labels.json'), merge: 'object' },
    stats: { file: path.join(d, 'stats.json'), merge: 'byId' },
    research: { file: path.join(d, 'research.json'), merge: 'byId' },
  };
}
const cfg = () => (ctx.config().sync = ctx.config().sync || {});
const loggedIn = () => !!(cfg().token && cfg().email);
const stateFile = () => path.join(ctx.data, 'sync-state.json');
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return def; } };
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

async function api(method, p, body, extra = {}) {
  const headers = { ...(extra.headers || {}) };
  if (cfg().token) headers.authorization = 'Bearer ' + cfg().token;
  let b = body;
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') { b = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const r = await fetch(ctx.relay() + p, { method, headers, body: b, signal: AbortSignal.timeout(extra.timeout || 30000) });
  if (r.status === 401 && cfg().token) { const c = cfg(); delete c.token; ctx.saveConfig(); }
  return r;
}
async function apiJson(method, p, body) {
  const r = await api(method, p, body);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || (r.status === 404 ? 'Synchronizácia ešte nie je zapnutá na rozcestníku.' : `rozcestník odpovedal ${r.status}`));
  return j;
}

// ---------- účet ----------
async function login(email, password, create) {
  const j = await apiJson('POST', create ? '/sync/signup' : '/sync/login', { email, password });
  const c = cfg(); c.token = j.token; c.email = j.email; c.decided = true; c.since = Date.now();
  ctx.saveConfig();
  try { fs.unlinkSync(stateFile()); } catch (_) {} // nový účet/počítač → prvé zlúčenie
  syncNow();
  return { email: j.email };
}
async function logout() {
  try { await api('POST', '/sync/logout'); } catch (_) {}
  const c = cfg(); delete c.token; delete c.email; c.decided = true; ctx.saveConfig();
}
function skip() { cfg().decided = true; ctx.saveConfig(); }

// ---------- zlúčenie ----------
function tombs() { const t = readJson(path.join(ctx.data, 'sync-tombstones.json'), {}); return { lib: t.lib || [], cal: t.cal || [], res: t.res || [] }; }
function mergeDoc(kind, local, remote, name) {
  if (kind === 'object') return { ...(remote || {}), ...(local || {}) };
  if (kind === 'tomb') {
    const u = (a, b) => [...new Set([...(a || []), ...(b || [])])].slice(-5000);
    return { lib: u(local && local.lib, remote && remote.lib), cal: u(local && local.cal, remote && remote.cal), res: u(local && local.res, remote && remote.res) };
  }
  const key = kind === 'byName' ? 'name' : 'id';
  if (!Array.isArray(local) || !Array.isArray(remote)) return Array.isArray(local) ? local : remote;
  const t = tombs(), dead = new Set(name === 'library' ? t.lib : name === 'calendar' ? t.cal : name === 'research' ? t.res : []);
  const out = new Map();
  for (const x of remote) if (x && x[key] != null && !dead.has(x[key])) out.set(x[key], x);
  for (const x of local) {
    if (!x || x[key] == null || dead.has(x[key])) continue;
    const r = out.get(x[key]);
    if (r && name === 'library') {
      // knižnica: spojiť vlastníkov a použitia
      const used = [...(r.used || []), ...(x.used || [])].filter((v, i, a) => a.findIndex((w) => w.udid === v.udid && w.at === v.at) === i);
      out.set(x[key], { ...r, ...x, owners: [...new Set([...(r.owners || []), ...(x.owners || [])])], used });
    } else out.set(x[key], x);
  }
  const arr = [...out.values()];
  // poradie: najnovšie hore (knižnica podľa pridania)
  if (name === 'library') arr.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
  return arr;
}

// ---------- jedna synchronizácia ----------
async function syncOnce() {
  const s = readJson(stateFile(), { base: {}, uploaded: {} });
  st.phase = 'Porovnávam s cloudom…';
  const remote = await apiJson('GET', '/sync/state');
  const rdocs = remote.docs || {};
  let changed = false;
  for (const [name, d] of Object.entries(docs())) {
    const raw = fs.existsSync(d.file) ? fs.readFileSync(d.file, 'utf8') : null;
    const lh = raw == null ? null : sha1(raw), base = s.base[name] || null, r = rdocs[name] || null;
    const localChanged = lh !== base, remoteChanged = r ? r.hash !== base : false;
    if (!localChanged && !remoteChanged) continue;
    if (!remoteChanged && raw != null) { // len u mňa → nahrať
      st.phase = `Nahrávam ${name}…`;
      const j = await apiJson('PUT', `/sync/doc/${name}`, raw); s.base[name] = j.hash; continue;
    }
    st.phase = `Sťahujem ${name}…`;
    const rr = await api('GET', `/sync/doc/${name}`);
    if (!rr.ok) continue;
    const rtext = await rr.text();
    let out = rtext;
    if (localChanged && raw != null) { // zmenené aj tu aj v cloude → zlúčiť
      let lj, rj; try { lj = JSON.parse(raw); rj = JSON.parse(rtext); } catch (_) { lj = null; }
      if (lj != null) out = JSON.stringify(mergeDoc(d.merge, lj, rj, name), null, 2);
    }
    fs.mkdirSync(path.dirname(d.file), { recursive: true });
    fs.writeFileSync(d.file + '.sync', out); require('./store').replaceFile(d.file + '.sync', d.file);
    changed = true;
    if (out !== rtext) { const j = await apiJson('PUT', `/sync/doc/${name}`, out); s.base[name] = j.hash; }
    else s.base[name] = sha1(rtext);
  }
  // zmazané v inom počítači → zmazať aj tu
  const t = tombs();
  for (const id of t.lib) { const f = path.join(ctx.libDir, id); if (/^[a-f0-9]{16}\.[a-z0-9]{2,5}$/.test(id) && fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {} }
  if (t.lib.length || t.cal.length || t.res.length) {
    for (const [name, list] of [['library', t.lib], ['calendar', t.cal], ['research', t.res]]) {
      const f = docs()[name].file, arr = readJson(f, null);
      if (!Array.isArray(arr)) continue;
      const keep = arr.filter((x) => !list.includes(x.id));
      if (keep.length !== arr.length) {
        if (name === 'library') for (const x of arr) if (list.includes(x.id)) { try { fs.unlinkSync(path.join(ctx.libDir, x.id)); } catch (_) {} }
        fs.writeFileSync(f, JSON.stringify(keep, null, 2)); changed = true;
        const j = await apiJson('PUT', `/sync/doc/${name}`, fs.readFileSync(f, 'utf8')); s.base[name] = j.hash;
      }
    }
  }
  fs.writeFileSync(stateFile(), JSON.stringify(s));
  if (changed) ctx.reload();
  await syncMedia(s);
  fs.writeFileSync(stateFile(), JSON.stringify(s));
}

// fotky a videá z knižnice: nahrať chýbajúce v cloude, stiahnuť chýbajúce v počítači
async function syncMedia(s) {
  const shotDir = path.join(ctx.data, 'research-shots');
  const lib = readJson(docs().library.file, []).filter((x) => x.hash).map((x) => ({ ...x, f: path.join(ctx.libDir, x.id), dir: ctx.libDir }));
  const seen = new Set();
  for (const r of readJson(docs().research.file, [])) for (const n of (r && r.notes) || []) if (n && /^[a-f0-9]{40}$/.test(n.shot || '') && !seen.has(n.shot)) {
    seen.add(n.shot); lib.push({ hash: n.shot, name: 'screenshot reelu', f: path.join(shotDir, n.shot + '.jpg'), dir: shotDir });
  }
  s.uploaded = s.uploaded || {};
  const up = lib.filter((x) => fs.existsSync(x.f) && !s.uploaded[x.hash]);
  const down = lib.filter((x) => !fs.existsSync(x.f));
  st.pendingUp = up.length; st.pendingDown = down.length; st.skipped = 0;
  for (const x of up) {
    if (!loggedIn()) return;
    const f = x.f, size = fs.statSync(f).size;
    if (size > MAX_BLOB) { st.skipped++; st.pendingUp--; continue; }
    const h = await api('HEAD', `/sync/blob/${x.hash}`);
    if (h.status !== 200) {
      st.phase = `Nahrávam ${x.name} (${(size / 1048576).toFixed(1)} MB)…`;
      const r = await api('PUT', `/sync/blob/${x.hash}`, fs.readFileSync(f), { headers: { 'content-type': 'application/octet-stream' }, timeout: 15 * 60000 });
      if (!r.ok) throw new Error(`nahrávanie ${x.name} zlyhalo (${r.status})`);
      st.up++;
    }
    s.uploaded[x.hash] = 1; st.pendingUp--;
    fs.writeFileSync(stateFile(), JSON.stringify(s));
  }
  for (const x of down) {
    fs.mkdirSync(x.dir, { recursive: true });
    if (!loggedIn()) return;
    st.phase = `Sťahujem ${x.name}…`;
    const r = await api('GET', `/sync/blob/${x.hash}`, undefined, { timeout: 15 * 60000 });
    if (r.status === 404) { st.pendingDown--; continue; } // ešte nenahraté z iného počítača
    if (!r.ok) throw new Error(`sťahovanie ${x.name} zlyhalo (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (crypto.createHash('sha1').update(buf).digest('hex') !== x.hash) throw new Error(`${x.name} sa stiahol poškodený`);
    const f = x.f;
    fs.writeFileSync(f + '.part', buf); require('./store').replaceFile(f + '.part', f);
    s.uploaded[x.hash] = 1; st.down++; st.pendingDown--;
  }
}

let queued = false, touchT = null;
// zmena v aplikácii → synchronizovať o chvíľu (viac zmien naraz = jedna synchronizácia)
function touch() { if (!loggedIn()) return; clearTimeout(touchT); touchT = setTimeout(syncNow, 5000); }
async function syncNow() {
  if (!loggedIn()) return;
  if (st.running) { queued = true; return; }
  st.running = true; st.error = '';
  try { await syncOnce(); st.at = Date.now(); st.phase = ''; }
  catch (e) { st.error = e.message || String(e); st.phase = ''; ctx.log('Synchronizácia: ' + st.error); }
  finally { st.running = false; if (queued) { queued = false; setTimeout(syncNow, 1000); } }
}

// zaznamenať zmazanie (aby sa položka po synchronizácii nevrátila z iného počítača)
function tombstone(kind, id) {
  if (!ctx || !loggedIn()) return;
  const f = path.join(ctx.data, 'sync-tombstones.json'), t = tombs();
  const k = kind === 'library' ? 'lib' : kind === 'research' ? 'res' : 'cal';
  if (!t[k].includes(id)) { t[k].push(id); fs.writeFileSync(f, JSON.stringify(t)); }
}

function status() {
  const c = cfg();
  return { loggedIn: loggedIn(), email: c.email || '', decided: !!c.decided || loggedIn(), lastAt: st.at, running: st.running, phase: st.phase, error: st.error,
    pendingUp: st.pendingUp, pendingDown: st.pendingDown, skipped: st.skipped };
}

function init(o) {
  ctx = o;
  setTimeout(syncNow, 4000);
  setInterval(syncNow, 90 * 1000);
}

module.exports = { init, login, logout, skip, syncNow, touch, status, tombstone, mergeDoc, api, email: () => cfg().email || '' };
