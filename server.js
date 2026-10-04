// iPhone Wall – lokálny server na Macu
// Zobrazuje obrazovky iPhonov pripojených cez USB a umožňuje ich ovládať.
// Používa go-ios (port forward + spustenie WebDriverAgent) a WebDriverAgent (stream + dotyky).
// Bez npm závislostí: stačí `node server.js`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_WIN = process.platform === 'win32';
// go-ios: najprv lokálna kópia v bin/ (Windows inštalátor ju tam stiahne), inak z PATH
const LOCAL_IOS = path.join(__dirname, 'bin', IS_WIN ? 'ios.exe' : 'ios');
const IOS_BIN = process.env.IOS_BIN || (fs.existsSync(LOCAL_IOS) ? LOCAL_IOS : 'ios');
const WDA_BUNDLE = process.env.WDA_BUNDLE || ''; // prázdne = nájde sa automaticky v telefóne
const BASE_PORT = parseInt(process.env.BASE_PORT || '20000', 10);
const LABELS_FILE = path.join(__dirname, 'labels.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const { startAgent } = require('./agent');
const media = require('./media');
const templates = require('./templates');
const store = require('./store');
const magnific = require('./magnific');
const updater = require('./updater');
const auth = require('./auth');
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
auth.init(config, () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)));
const apiKey = () => process.env.ANTHROPIC_API_KEY || config.apiKey || '';

// Ako sa spúšťa WebDriverAgent:
//   xcode  – automaticky cez xcodebuild (nastaví install.command)  ← odporúčané
//   goios  – cez go-ios runwda
//   none   – spúšťaš ho sám v Xcode (Cmd+U)
// build mimo Plochy/Dokumentov – iCloud tam pridáva skryté atribúty a podpis (CodeSign) potom zlyhá
const BUILD_ROOT = process.env.WDA_BUILD_DIR || path.join(process.env.HOME || __dirname, 'Library', 'Developer', 'JD-IphoneWall', 'build');
const WDA_PROJECT = process.env.WDA_PROJECT || path.join(__dirname, 'WebDriverAgent', 'WebDriverAgent.xcodeproj');
const WDA_MODE = process.env.AUTO_WDA === '0' ? 'none'
  : process.env.WDA_MODE || (config.teamId && config.bundleId && fs.existsSync(WDA_PROJECT) ? 'xcode' : 'goios');

let labels = {};
try { labels = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); } catch (_) {}
const saveLabels = () => fs.writeFile(LABELS_FILE, JSON.stringify(labels, null, 2), () => {});

const devices = new Map(); // udid -> device
let nextSlot = 0;

function log(...a) { console.log(new Date().toLocaleTimeString(), ...a); }

function startProc(dev, bin, args, tag, delay = 3000) {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.on('error', (e) => log(`[${dev.label}] ${tag} chyba:`, e.message));
  const onOut = (d) => {
    const lines = String(d).split('\n').map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      if (tag === 'xcode') {
        if (/ServerURLHere/.test(l)) { dev.lastLog = 'WDA beží'; log(`[${dev.label}] WebDriverAgent beží`); }
        else if (/error:|failed|not trusted|Developer Mode|locked|could not|TEST FAILED|BUILD FAILED/i.test(l)) dev.lastLog = `xcode: ${l.slice(-300)}`;
        else if (/^(Testing started|Test Suite|\*\*)/.test(l)) dev.lastLog = `xcode: ${l.slice(-200)}`;
      } else dev.lastLog = `${tag}: ${l.slice(-300)}`;
    }
  };
  p.stdout.on('data', onOut);
  p.stderr.on('data', onOut);
  p.on('exit', (code) => {
    dev.procs = dev.procs.filter((x) => x !== p);
    if (!dev.gone) {
      log(`[${dev.label}] ${tag} skončil (${code}), reštart o ${delay / 1000} s${dev.lastLog ? ' – ' + dev.lastLog : ''}`);
      setTimeout(() => { if (!dev.gone) dev.procs.push(startProc(dev, bin, args, tag, delay)); }, delay);
    }
  });
  return p;
}

function startDevice(dev) {
  const u = `--udid=${dev.udid}`;
  dev.procs.push(startProc(dev, IOS_BIN, ['forward', u, String(dev.wdaPort), '8100'], 'forward-wda'));
  dev.procs.push(startProc(dev, IOS_BIN, ['forward', u, String(dev.mjpegPort), '9100'], 'forward-mjpeg'));

  if (WDA_MODE === 'xcode') {
    // WebDriverAgent spúšťa priamo Xcode (xcodebuild) – najspoľahlivejšie, bez otvárania Xcode
    dev.lastLog = 'xcode: pripravujem WebDriverAgent (prvýkrát to trvá pár minút)…';
    dev.procs.push(startProc(dev, 'xcodebuild', [
      '-project', WDA_PROJECT,
      '-scheme', 'WebDriverAgentRunner',
      '-destination', `id=${dev.udid}`,
      '-derivedDataPath', path.join(BUILD_ROOT, dev.udid),
      '-allowProvisioningUpdates',
      `DEVELOPMENT_TEAM=${config.teamId}`,
      `PRODUCT_BUNDLE_IDENTIFIER=${config.bundleId}`,
      'CODE_SIGN_STYLE=Automatic',
      'test',
    ], 'xcode', 15000));
  } else if (WDA_MODE === 'goios') {
    // Developer Disk Image – bez neho WDA na iOS 17+ nenaštartuje (testmanagerd chýba)
    execFile(IOS_BIN, ['image', 'auto', u], { timeout: 120000 }, (err, so, se) => {
      log(`[${dev.label}] developer image: ${err ? 'chyba – ' + String(se || err.message).trim().slice(-200) : 'OK'}`);
    });
    findWdaBundle(dev).then((bundle) => {
      if (dev.gone) return;
      if (!bundle) { dev.lastLog = 'WebDriverAgent nie je v telefóne nainštalovaný (pozri návod – Sideloadly / install)'; return; }
      log(`[${dev.label}] WebDriverAgent: ${bundle}`);
      dev.procs.push(startProc(dev, IOS_BIN, [
        'runwda', u,
        `--bundleid=${bundle}`,
        `--testrunnerbundleid=${bundle}`,
        '--xctestconfig=WebDriverAgentRunner.xctest',
      ], 'wda'));
    });
  }
}

// Nájde bundle ID WebDriverAgenta v telefóne (napr. po podpise cez Sideloadly sa mení)
function findWdaBundle(dev, tries = 0) {
  if (WDA_BUNDLE) return Promise.resolve(WDA_BUNDLE);
  return new Promise((resolve) => {
    execFile(IOS_BIN, ['apps', '--list', `--udid=${dev.udid}`], { timeout: 20000, maxBuffer: 4e6 }, (err, so) => {
      const m = String(so || '').match(/[A-Za-z0-9._\-]*(?:xctrunner|WebDriverAgentRunner)[A-Za-z0-9._\-]*/i);
      if (m) return resolve(m[0]);
      if (tries < 40 && !dev.gone) return setTimeout(() => findWdaBundle(dev, tries + 1).then(resolve), 15000);
      resolve(null);
    });
  });
}

function stopDevice(dev) {
  dev.gone = true;
  dev.procs.forEach((p) => { try { p.kill(); } catch (_) {} });
  dev.procs = [];
}

function listDevices() {
  return new Promise((resolve) => {
    execFile(IOS_BIN, ['list', '--details'], { timeout: 8000 }, (err, stdout) => {
      if (err) { lastListError = err.code === 'ENOENT' ? 'go-ios nie je nainštalovaný – spusti inštaláciu (install)' : String(err.message).slice(0, 200); return resolve(null); }
      lastListError = null;
      const out = [];
      for (const line of stdout.split('\n')) {
        try {
          const j = JSON.parse(line);
          for (const d of j.deviceList || []) {
            if (typeof d === 'string') out.push({ udid: d });
            else out.push({
              udid: d.Udid || d.udid || d.UniqueDeviceID,
              name: d.DeviceName || d.ProductName,
              version: d.ProductVersion,
            });
          }
        } catch (_) {}
      }
      resolve(out.filter((d) => d.udid));
    });
  });
}
let lastListError = null;

async function refresh() {
  const list = await listDevices();
  if (!list) return;
  const seen = new Set();
  for (const d of list) {
    seen.add(d.udid);
    if (!devices.has(d.udid)) {
      const slot = nextSlot++;
      const dev = {
        udid: d.udid,
        name: d.name || d.udid.slice(0, 8),
        version: d.version || '',
        label: labels[d.udid] || d.name || `iPhone ${slot + 1}`,
        wdaPort: BASE_PORT + slot * 2,
        mjpegPort: BASE_PORT + slot * 2 + 1,
        procs: [], sessionId: null, size: null, wdaOk: false, gone: false, lastLog: '',
      };
      devices.set(d.udid, dev);
      log(`Pripojený: ${dev.label} (${dev.udid}) WDA:${dev.wdaPort} stream:${dev.mjpegPort}`);
      store.addActivity('phone', `${dev.label} pripojený`, { phone: dev.label });
      startDevice(dev);
    }
  }
  for (const [udid, dev] of devices) {
    if (!seen.has(udid)) { log(`Odpojený: ${dev.label}`); store.addActivity('phone', `${dev.label} odpojený`, { phone: dev.label }); stopDevice(dev); devices.delete(udid); }
  }
  await Promise.all([...devices.values()].map(async (dev) => {
    try {
      const s = await wda(dev, 'GET', '/status', null, 3000);
      dev.wdaOk = !!(s && (s.value || s.status === 0));
      if (dev.wdaOk) dev.locked = await isLocked(dev).catch(() => dev.locked);
      if (s && s.sessionId && !dev.sessionId) dev.sessionId = s.sessionId;
    } catch (_) { dev.wdaOk = false; dev.sessionId = null; }
  }));
}

function wda(dev, method, p, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: dev.wdaPort, path: p, method, timeout,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (_) {}
        if (res.statusCode >= 400) {
          const e = new Error((j && j.value && (j.value.message || j.value.error)) || `HTTP ${res.statusCode}`);
          e.invalidSession = /session/i.test(e.message) || res.statusCode === 404;
          return reject(e);
        }
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('WDA timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ensureSession(dev) {
  if (dev.sessionId && dev.size) return dev.sessionId;
  if (!dev.sessionId) {
    const r = await wda(dev, 'POST', '/session', { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
    dev.sessionId = r.sessionId || (r.value && r.value.sessionId);
  }
  const sid = dev.sessionId;
  try {
    await wda(dev, 'POST', `/session/${sid}/appium/settings`, {
      settings: { mjpegServerFramerate: 15, mjpegServerScreenshotQuality: 40, mjpegScalingFactor: 50 },
    });
  } catch (_) {}
  const sz = await wda(dev, 'GET', `/session/${sid}/window/size`);
  dev.size = sz.value; // v bodoch (points)
  return sid;
}

async function withSession(dev, fn) {
  try {
    return await fn(await ensureSession(dev));
  } catch (e) {
    if (!e.invalidSession) throw e;
    dev.sessionId = null; dev.size = null;
    return fn(await ensureSession(dev));
  }
}

// ---------- zamknutie / odomknutie ----------
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function isLocked(dev) {
  const r = await wda(dev, 'GET', '/wda/locked', null, 5000);
  return !!(r && r.value);
}
// Zobudí a odomkne telefón, ak spí. Funguje len bez kódu (Face ID / číselný kód musí byť vypnutý).
async function wake(dev) {
  let locked;
  try { locked = await isLocked(dev); } catch (_) { return; }
  if (!locked) return;
  await wda(dev, 'POST', '/wda/unlock', null, 15000);
  await pause(1200);
  dev.locked = await isLocked(dev).catch(() => false);
  if (dev.locked) throw new Error('Telefón sa nepodarilo odomknúť – má nastavený kód? (Nastavenia → Face ID a kód → Vypnúť kód)');
}

function pointer(actions) {
  return { actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }] };
}

const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));

async function tap(dev, fx, fy) {
  return withSession(dev, (sid) => {
    const x = Math.round(clamp(fx) * dev.size.width), y = Math.round(clamp(fy) * dev.size.height);
    return wda(dev, 'POST', `/session/${sid}/actions`, pointer([
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 60 },
      { type: 'pointerUp', button: 0 },
    ]));
  });
}

async function swipe(dev, b) {
  return withSession(dev, (sid) => {
    const W = dev.size.width, H = dev.size.height;
    const ms = Math.max(80, Math.min(3000, Number(b.ms) || 300));
    const hold = Number(b.hold) || 0; // dlhé podržanie pred ťahom
    return wda(dev, 'POST', `/session/${sid}/actions`, pointer([
      { type: 'pointerMove', duration: 0, x: Math.round(clamp(b.x1) * W), y: Math.round(clamp(b.y1) * H) },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 50 + hold },
      { type: 'pointerMove', duration: ms, x: Math.round(clamp(b.x2) * W), y: Math.round(clamp(b.y2) * H) },
      { type: 'pointerUp', button: 0 },
    ]));
  });
}

async function longPress(dev, fx, fy) {
  return withSession(dev, (sid) => {
    const x = Math.round(clamp(fx) * dev.size.width), y = Math.round(clamp(fy) * dev.size.height);
    return wda(dev, 'POST', `/session/${sid}/actions`, pointer([
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 900 },
      { type: 'pointerUp', button: 0 },
    ]));
  });
}

// rýchlosť písania v znakoch za sekundu (Nastavenia → Písanie na klávesnici)
const typingSpeed = () => Math.max(1, Math.min(60, Number(config.typingSpeed) || 60));
async function typeText(dev, text) {
  const chars = [...String(text)];
  // dlhý text pri pomalom písaní trvá dlhšie – podľa toho predĺžime čakanie na WDA
  const timeout = 15000 + Math.ceil(chars.length / typingSpeed()) * 1000;
  return withSession(dev, (sid) => wda(dev, 'POST', `/session/${sid}/wda/keys`, { value: chars, frequency: typingSpeed() }, timeout));
}

// ---------- HTTP ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
  });
}

function proxyStream(dev, req, res) {
  const up = http.get({ host: '127.0.0.1', port: dev.mjpegPort, path: '/' }, (r) => {
    res.writeHead(r.statusCode || 200, {
      'Content-Type': r.headers['content-type'] || 'multipart/x-mixed-replace',
      'Cache-Control': 'no-store', Connection: 'close',
    });
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('close', () => up.destroy());
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const mediaCtx = {
  port: PORT,
  json,
  openUrl: async (dev, link) => { await wake(dev); return withSession(dev, (sid) => wda(dev, 'POST', `/session/${sid}/url`, { url: link })); },
  home: (dev) => wda(dev, 'POST', '/wda/homescreen'),
  onMedia: (dev, item) => store.addActivity('media', `${item.name} → ${dev.label}`, { phone: dev.label }),
  onMediaDone: (dev, item, ok) => store.addActivity(ok ? 'media_done' : 'error',
    ok ? `${item.name} je v telefóne ${dev.label}` : `${item.name}: ${item.status}`, { phone: dev.label }),
};

// koľko reelov AI prezrela pri prieskume (prvý reel + každé potiahnutie na ďalší, max. zvolený počet)
function isResearch(task) { return /Postupne si pozri\s+\d+\s+reel/i.test(task || ''); }
function reelsViewed(dev, task) {
  if (!isResearch(task) || !dev.agent) return 0;
  const want = parseInt((task.match(/pozri\s+(\d+)\s+reel/i) || [])[1], 10) || 999;
  return Math.min(want, (dev.agent.swipes || 0) + 1);
}

// sleduje AI úlohu a zapíše výsledok do aktivity
function watchAgent(dev, task) {
  const short = task.length > 90 ? task.slice(0, 90) + '…' : task;
  store.addActivity('ai', `AI úloha: ${short}`, { phone: dev.label });
  if (dev.agent) dev.agent.task = task;
  const t = setInterval(() => {
    if (!dev.agent || dev.agent.running) return;
    clearInterval(t);
    const last = dev.agent.log[dev.agent.log.length - 1] || '';
    const ok = last.startsWith('✓');
    const extra = { phone: dev.label };
    const reels = reelsViewed(dev, task);
    const ads = (dev.agent && dev.agent.ads) || 0;
    if (reels) { extra.reels = reels; store.addActivity('reels', `Prezreté reels: ${reels}${ads ? ` · preskočené reklamy: ${ads}` : ''}`, extra); }
    store.addActivity(ok ? 'ai_done' : 'error', ok ? last.replace(/^✓\s*/, '') : `AI: ${last.replace(/^[⚠■]\s*/, '')}`, { phone: dev.label });
  }, 2000);
}

// spustí AI úlohu na telefóne
async function runAgentTask(dev, task, maxSteps) {
  await wake(dev);
  await pause(800); // nech je na obrazovke už odomknutý telefón
  startAgent(dev, task, apiKey(), {
    tap: async (x, y) => { await wake(dev); return tap(dev, x, y); },
    longPress: async (x, y) => { await wake(dev); return longPress(dev, x, y); },
    swipe: async (sw) => { await wake(dev); return swipe(dev, sw); },
    type: async (t) => { await wake(dev); return typeText(dev, t); },
    home: async () => { await wake(dev); return wda(dev, 'POST', '/wda/homescreen'); },
  }, { maxSteps });
  watchAgent(dev, task);
}

// ---------- plán: pred každým príspevkom najprv pošle jeho video/fotky do galérie ----------
// Takto je médium pri plánovaní vždy najnovšie (na 1. mieste) a AI vyberie to správne.
const PLAN_DIR = path.join(store.DATA, 'plan-files');
fs.mkdirSync(PLAN_DIR, { recursive: true });
// staré nepoužité súbory (> 2 dni) uprac
for (const f of fs.readdirSync(PLAN_DIR)) { const fp = path.join(PLAN_DIR, f); try { if (Date.now() - fs.statSync(fp).mtimeMs > 2 * 86400000) fs.unlinkSync(fp); } catch (_) {} }
function planFile(id) {
  if (!/^[a-f0-9]{16}\.[a-z0-9]{2,5}$/.test(id)) return null;
  const fp = path.join(PLAN_DIR, id);
  return fs.existsSync(fp) ? fp : null;
}
function savePlanFile(req, name) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(name).toLowerCase();
    if (!media.TYPES[ext]) return reject(new Error(`Nepodporovaný typ súboru (${ext || '?'}). Fotky: jpg, png, heic. Videá: mp4, mov.`));
    const id = require('crypto').randomBytes(8).toString('hex') + ext;
    const out = fs.createWriteStream(path.join(PLAN_DIR, id));
    req.pipe(out);
    out.on('error', reject);
    out.on('finish', () => resolve({ id, name }));
  });
}

async function runPlan(dev, steps) {
  const plan = dev.plan = { running: true, stop: false, fileIds: steps.flatMap((x) => x.files.map((f) => f.id)) };
  const say = (t) => { if (dev.agent) { dev.agent.log.push(t); if (dev.agent.log.length > 60) dev.agent.log.shift(); } };
  // „agent“ zobrazuje stav na karte telefónu a dá sa ním plán zastaviť
  dev.agent = { running: true, stop: false, log: [`📦 Plán: ${steps.length} ${steps.length === 1 ? 'príspevok' : 'príspevky'} – pred každým pošlem jeho médiá do galérie`] };
  store.addActivity('ai', `Plán: ${steps.map((x) => x.title).join(', ')}`, { phone: dev.label });
  const stopped = () => plan.stop || (dev.agent && dev.agent.stop) || dev.gone;
  let okCount = 0;
  try {
    for (const [i, st] of steps.entries()) {
      if (stopped()) { say('■ Plán zastavený'); break; }
      const head = `${st.title || 'Príspevok'} (${i + 1}/${steps.length})`;
      if (!dev.agent || !dev.agent.running) dev.agent = { running: true, stop: false, log: [] };
      // 1) médiá do galérie – v opačnom poradí, aby prvý súbor bol najnovší (na 1. mieste)
      if (st.files.length) {
        say(`📤 ${head}: posielam ${st.files.length === 1 ? st.files[0].name : st.files.length + ' súbory'} do galérie…`);
        const items = st.files.slice().reverse().map((f) => media.enqueueCopy(dev, planFile(f.id), f.name, mediaCtx));
        while (!stopped() && items.some((it) => !/^(✓|chyba)/.test(it.status))) await pause(1000);
        if (stopped()) { say('■ Plán zastavený'); break; }
        const bad = items.find((it) => it.status.startsWith('chyba'));
        if (bad) { say(`⚠ ${head}: ${bad.name} sa nepodarilo poslať (${bad.status.replace(/^chyba:\s*/, '')}). Plán zastavujem, nič som nezverejnil.`); break; }
        say(`✓ ${head}: médiá sú v galérii na 1. mieste`);
        await pause(2000);
      }
      // 2) AI naplánuje príspevok v Meta Business Suite
      const prev = dev.agent.log.slice(-6);
      dev.agent.running = false;
      await runAgentTask(dev, st.task, st.maxSteps);
      dev.agent.log.unshift(...prev, `🗓️ ${head}: plánujem v Meta Business Suite…`);
      while (dev.agent && dev.agent.running) { if (plan.stop) dev.agent.stop = true; await pause(1500); }
      await pause(2600); // nech si watchAgent stihne zapísať výsledok do Aktivity
      const last = (dev.agent && dev.agent.log[dev.agent.log.length - 1]) || '';
      if (!last.startsWith('✓')) { say(`⚠ ${head} sa nepodaril – plán zastavujem, aby sa ďalšie médiá nepomiešali.`); break; }
      okCount++;
      if (i < steps.length - 1) { dev.agent.running = true; say(`→ pokračujem ďalším príspevkom`); }
    }
  } catch (e) {
    say(`⚠ ${e.message}`);
  } finally {
    plan.running = false;
    // súbor zmaž, až keď ho nepotrebuje ani plán na inom telefóne (rovnaké video môže ísť na viac telefónov)
    const inUse = new Set([...devices.values()].filter((d) => d.plan && d.plan.running).flatMap((d) => d.plan.fileIds || []));
    for (const st of steps) for (const f of st.files) { const fp = planFile(f.id); if (fp && !inUse.has(f.id)) fs.unlink(fp, () => {}); }
    say(okCount === steps.length ? `✓ Plán hotový: naplánované ${okCount}/${steps.length}` : `■ Plán skončil: naplánované ${okCount}/${steps.length}`);
    if (dev.agent) dev.agent.running = false;
    plan.running = false;
  }
}

// ---------- súhrn pre Prehľad ----------
function overview() {
  const list = [...devices.values()];
  const stats = store.activityStats(7);
  const today = stats[stats.length - 1];
  return {
    now: new Date().toISOString(),
    phones: list.map((d) => ({ udid: d.udid, label: d.label, wdaOk: d.wdaOk, locked: !!d.locked, aiRunning: !!(d.agent && d.agent.running) })),
    online: list.filter((d) => d.wdaOk).length,
    aiRunning: list.filter((d) => d.agent && d.agent.running).length,
    today, week: stats,
    reelsLive: list.reduce((n, d) => n + (d.agent && d.agent.running && d.agent.task ? reelsViewed(d, d.agent.task) : 0), 0),
    templates: templates.load().length,
    inspiration: store.listInspiration().slice(0, 8),
    inspirationCount: store.listInspiration().length,
    activity: store.listActivity(8),
    mediaNet: media.mediaInfo(),
    hasKey: !!apiKey(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  // Zo siete (iPhony cez Wi-Fi) je dostupné IBA sťahovanie súborov s tajným kľúčom, nič iné
  if (parts[0] === 'media' && req.method === 'GET') return media.serveMedia(req, res, parts);
  // zvonku (mobil cez Cloudflare) len po prihlásení – inak prihlasovacia stránka / zákaz
  if (!(await auth.gate(req, res, url))) return;
  const remote = auth.isRemote(req);

  // ikona a manifest (stránka ako aplikácia na ploche mobilu)
  if (url.pathname === '/ikona.png' || url.pathname === '/manifest.json') {
    const f = path.join(PUBLIC_DIR, url.pathname.slice(1));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.png') ? 'image/png' : 'application/manifest+json', 'Cache-Control': 'max-age=86400' });
    return fs.createReadStream(f).pipe(res);
  }
  // PIN pre mobil – meniť sa dá len priamo na počítači
  if (url.pathname === '/api/pin') {
    if (req.method === 'GET') return json(res, 200, { hasPin: auth.hasPin(), remote, remoteUrl: config.remoteUrl || '' });
    if (remote) return json(res, 403, { error: 'PIN sa dá meniť len priamo na počítači' });
    const b = await readBody(req);
    try {
      if (b.remove) auth.removePin(); else if (b.pin !== undefined) auth.setPin(b.pin);
      if (b.remoteUrl !== undefined) { config.remoteUrl = String(b.remoteUrl || '').trim().slice(0, 200); fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
      return json(res, 200, { ok: true, hasPin: auth.hasPin() });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (parts[0] === 'api' && parts[2] === 'upload' && req.method === 'POST') {
    const dev = devices.get(parts[1]);
    if (!dev) { req.resume(); return json(res, 404, { error: 'Telefón nenájdený' }); }
    return media.handleUpload(dev, req, res, url, mediaCtx);
  }

  if (parts[0] === 'tools' && parts[1] && /^[\w.-]+\.html$/.test(parts[1])) {
    const f = path.join(PUBLIC_DIR, 'tools', parts[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(f).pipe(res);
  }
  if (url.pathname === '/wall.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'wall.js')).pipe(res);
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
  }

  if (url.pathname === '/api/devices') {
    return json(res, 200, {
      error: lastListError,
      hasKey: !!apiKey(),
      hasMagnificKey: !!(process.env.MAGNIFIC_API_KEY || config.magnificKey),
      typingSpeed: typingSpeed(),
      lanIp: media.lanIp(),
      mediaNet: media.mediaInfo(),
      shortcut: media.SHORTCUT_NAME,
      devices: [...devices.values()].map((d) => ({
        udid: d.udid, name: d.name, label: d.label, version: d.version,
        wdaOk: d.wdaOk, size: d.size, lastLog: d.wdaOk ? '' : d.lastLog,
        agent: d.agent ? { running: d.agent.running, log: d.agent.log.slice(-15) } : null,
        media: media.mediaState(d),
        locked: !!d.locked,
      })),
    });
  }

  if (url.pathname === '/api/overview') return json(res, 200, overview());
  if (url.pathname === '/api/activity') {
    return json(res, 200, store.listActivity(Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10)), url.searchParams.get('type') || undefined));
  }

  // ---------- inšpirácia ----------
  if (parts[0] === 'insp' && parts[1]) {
    const f = path.join(store.INSP_DIR, path.basename(parts[1]));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': media.TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
    return fs.createReadStream(f).pipe(res);
  }
  if (url.pathname === '/api/inspiration' && req.method === 'GET') return json(res, 200, store.listInspiration());
  if (url.pathname === '/api/inspiration/delete' && req.method === 'POST') {
    const b = await readBody(req); store.removeInspiration(b.id); return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/inspiration' && req.method === 'POST') {
    const q = url.searchParams;
    const meta = { link: (q.get('link') || '').slice(0, 500), note: (q.get('note') || '').slice(0, 500), tags: (q.get('tags') || '').slice(0, 200) };
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (!len) { req.resume(); if (!meta.link && !meta.note) return json(res, 400, { error: 'Pridaj obrázok, odkaz alebo poznámku' }); return json(res, 200, store.addInspiration(meta)); }
    const ext = path.extname(q.get('name') || '').toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.mp4', '.mov'].includes(ext)) { req.resume(); return json(res, 400, { error: 'Podporované sú obrázky (jpg, png, webp) a videá (mp4, mov)' }); }
    if (len > 300 * 1024 * 1024) { req.resume(); return json(res, 413, { error: 'Max 300 MB' }); }
    const tmp = path.join(store.INSP_DIR, `.up-${store.newId()}`);
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => json(res, 200, store.addInspiration({ ...meta, file: tmp, ext })));
    out.on('error', (e) => json(res, 500, { error: e.message }));
    return;
  }

  // ---------- Magnific ----------
  if (url.pathname === '/api/magnific' && req.method === 'GET') {
    return json(res, 200, { inbox: magnific.INBOX, hasKey: !!(process.env.MAGNIFIC_API_KEY || config.magnificKey), models: magnific.MODELS.map(({ id, label, needsImage, sizes }) => ({ id, label, needsImage, formats: Object.keys(sizes) })), items: magnific.list() });
  }
  if (parts[0] === 'mag' && parts[1]) {
    const f = path.join(magnific.DIR, path.basename(parts[1]));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(f).size, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const type = media.TYPES[path.extname(f).toLowerCase()] || 'video/mp4';
    if (range) { // prehrávač videa potrebuje Range
      const start = range[1] ? parseInt(range[1], 10) : 0, end = range[2] ? parseInt(range[2], 10) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(f).pipe(res);
  }
  if (url.pathname === '/api/magnific/generate' && req.method === 'POST') {
    try { const it = await magnific.generate(req, url.searchParams); return json(res, 200, { ok: true, id: it.id }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/api/plan-file' && req.method === 'POST') {
    try { return json(res, 200, await savePlanFile(req, String(url.searchParams.get('name') || 'subor').slice(0, 120))); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/api/magnific/upload' && req.method === 'POST') {
    try { const it = await magnific.addUpload(req, url.searchParams.get('name') || 'video.mp4'); return json(res, 200, { ok: true, id: it.id }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (url.pathname.startsWith('/api/magnific/') && req.method === 'POST') {
    const b = await readBody(req);
    try {
      switch (parts[2]) {
        case 'link': await magnific.addLink(String(b.url || '').trim(), String(b.name || '').slice(0, 80)); break;
        case 'delete': magnific.remove(b.id); break;
        case 'send': {
          const fp = magnific.filePath(b.id);
          if (!fp) return json(res, 400, { error: 'Video ešte nie je hotové' });
          const sent = [];
          for (const udid of [].concat(b.phones || [])) {
            const dev = devices.get(udid);
            if (!dev) continue;
            media.enqueueCopy(dev, fp.file, fp.name, mediaCtx);
            sent.push(dev.label);
          }
          if (!sent.length) return json(res, 400, { error: 'Vyber aspoň jeden pripojený telefón' });
          return json(res, 200, { ok: true, sent });
        }
        default: return json(res, 404, { error: 'Neznáma akcia' });
      }
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (url.pathname === '/api/templates') {
    try {
      if (req.method === 'GET') return json(res, 200, templates.load());
      const b = await readBody(req);
      if (b.action === 'delete') return json(res, 200, templates.remove(b.name));
      if (b.action === 'reset') return json(res, 200, templates.reset());
      return json(res, 200, templates.upsert(b.name, b.text));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ---------- aktualizácie ----------
  if (url.pathname === '/api/update' && req.method === 'GET') {
    try { return json(res, 200, await updater.check(url.searchParams.get('force') === '1')); }
    catch (e) { return json(res, 200, { configured: true, current: updater.local().version, error: e.message }); }
  }
  if (url.pathname === '/api/update' && req.method === 'POST') {
    try {
      const r = await updater.apply();
      store.addActivity('phone', `Stránka aktualizovaná na verziu ${r.version}`);
      json(res, 200, r);
      // reštart: START_STRANKY server po kóde 75 spustí znova
      setTimeout(() => { devices.forEach(stopDevice); process.exit(75); }, 1200);
      return;
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.apiKey !== undefined) config.apiKey = String(b.apiKey || '').trim();
    if (b.magnificKey !== undefined) config.magnificKey = String(b.magnificKey || '').trim();
    if (b.typingSpeed !== undefined) config.typingSpeed = Math.max(1, Math.min(60, parseInt(b.typingSpeed, 10) || 60));
    fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), () => {});
    return json(res, 200, { ok: true });
  }

  if (parts[0] === 'stream' && parts[1]) {
    const dev = devices.get(parts[1]);
    if (!dev) { res.writeHead(404); return res.end(); }
    return proxyStream(dev, req, res);
  }

  if (parts[0] === 'api' && parts[1] && req.method === 'POST') {
    const dev = devices.get(parts[1]);
    if (!dev) return json(res, 404, { error: 'Telefón nenájdený' });
    const b = await readBody(req);
    try {
      switch (parts[2]) {
        case 'tap': await wake(dev); await tap(dev, b.x, b.y); break;
        case 'longpress': await wake(dev); await longPress(dev, b.x, b.y); break;
        case 'swipe': await wake(dev); await swipe(dev, b); break;
        case 'type': await wake(dev); await typeText(dev, b.text || ''); break;
        case 'home': await wake(dev); await wda(dev, 'POST', '/wda/homescreen'); break;
        case 'unlock': await wake(dev); dev.locked = false; break;
        case 'lock': await wda(dev, 'POST', '/wda/lock', null, 10000); dev.locked = true; break;
        case 'label':
          dev.label = String(b.label || '').slice(0, 40) || dev.name;
          labels[dev.udid] = dev.label; saveLabels(); break;
        case 'agent': {
          if (!apiKey()) return json(res, 400, { error: 'Chýba Claude API kľúč (hore vpravo)' });
          if (!dev.wdaOk) return json(res, 400, { error: 'Telefón ešte nie je pripravený (WDA)' });
          const task = String(b.task || '').trim();
          if (!task) return json(res, 400, { error: 'Prázdna úloha' });
          await runAgentTask(dev, task, b.maxSteps);
          break;
        }
        case 'agent-stop': if (dev.agent) dev.agent.stop = true; if (dev.plan) dev.plan.stop = true; break;
        case 'plan': {
          if (!apiKey()) return json(res, 400, { error: 'Chýba Claude API kľúč (Nastavenia)' });
          if (!dev.wdaOk) return json(res, 400, { error: 'Telefón ešte nie je pripravený (WDA)' });
          if ((dev.agent && dev.agent.running) || (dev.plan && dev.plan.running)) return json(res, 400, { error: 'Na telefóne už beží úloha' });
          const steps = (Array.isArray(b.steps) ? b.steps : []).slice(0, 10).map((x) => ({
            title: String(x.title || '').slice(0, 60), task: String(x.task || '').trim(), maxSteps: x.maxSteps,
            files: (Array.isArray(x.files) ? x.files : []).slice(0, 10).map((f) => ({ id: String(f.id || ''), name: String(f.name || '') })) }));
          if (!steps.length || steps.some((x) => !x.task)) return json(res, 400, { error: 'Prázdny plán' });
          for (const st of steps) for (const f of st.files) if (!planFile(f.id)) return json(res, 400, { error: `Súbor ${f.name} sa nenašiel – nahraj ho znova` });
          runPlan(dev, steps);
          break;
        }
        case 'reset':
          dev.sessionId = null; dev.size = null; break;
        default: return json(res, 404, { error: 'Neznáma akcia' });
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  log(`JD - IphoneWall beží na http://localhost:${PORT}  (WebDriverAgent: ${WDA_MODE})`);
  media.startMediaServer(config);
  magnific.init(() => process.env.MAGNIFIC_API_KEY || config.magnificKey || '');
  refresh();
  setInterval(refresh, 5000);
});

process.on('SIGINT', () => { devices.forEach(stopDevice); process.exit(0); });
process.on('SIGTERM', () => { devices.forEach(stopDevice); process.exit(0); });
