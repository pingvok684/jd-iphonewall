// JD Phone Studio – lokálny server na Macu
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

const { startAgent, askText, grabFrame } = require('./agent');
const content = require('./content');
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
// cez koho ide AI (klikanie, šablóny, popisy): 'anthropic' | 'kie' | 'auto' (Claude kľúč má prednosť, inak KIE)
const aiProvider = () => {
  const p = config.aiProvider || 'auto';
  if (p === 'kie') return config.kieKey ? 'kie' : null;
  if (p === 'anthropic') return apiKey() ? 'anthropic' : null;
  return apiKey() ? 'anthropic' : (config.kieKey ? 'kie' : null);
};
// AI klikanie potrebuje vidieť obrazovku → ide vždy cez Claude priamo, ak je kľúč (KIE obrázky Claudovi neposiela)
const agentAuth = () => apiKey() || aiAuth();
const aiAuth = () => { const p = aiProvider(); return p === 'kie' ? { provider: 'kie', key: config.kieKey, model: config.kieModel || 'claude-sonnet-5' } : p === 'anthropic' ? apiKey() : null; };

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
      if (m) { dev.wdaBundle = m[0]; return resolve(m[0]); }
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
    if (!seen.has(udid)) {
      log(`Odpojený: ${dev.label}`); store.addActivity('phone', `${dev.label} odpojený`, { phone: dev.label }); stopDevice(dev); devices.delete(udid);
      // upozornenie, len ak sa do 2 minút nevráti (krátke odpojenie kábla nevadí)
      setTimeout(() => { if (!devices.has(udid)) notify('offline', `🔌 ${dev.label} je odpojený od počítača už 2 minúty.${dev.agent && dev.agent.running ? ' Bežala na ňom úloha – skontroluj ju.' : ''}`); }, 120000);
    }
  }
  await Promise.all([...devices.values()].map(async (dev) => {
    try {
      const s = await wda(dev, 'GET', '/status', null, 3000);
      const was = dev.wdaOk;
      dev.wdaOk = !!(s && (s.value || s.status === 0));
      if (dev.wdaOk && !was) wdaCameUp(dev);
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

// ---------- prístup z mobilu cez rozcestník (bez domény a bez Cloudflare účtu) ----------
// Aplikácia otvorí bezplatný Cloudflare tunel na túto stránku a jeho aktuálnu adresu nahlási rozcestníku
// (go.iphonewalljd.app/<id>). Ikona na mobile vedie vždy na rozcestník → ten presmeruje na aktuálnu adresu.
const RELAY = (process.env.JD_RELAY || config.relayUrl || 'https://go.iphonewalljd.app').replace(/\/+$/, '');
const RELAY_ORIGIN = (() => { try { return new URL(RELAY).origin; } catch (_) { return ''; } })();
const web = { proc: null, url: null, verified: false, state: 'vypnuté', fails: 0, registeredAt: 0, relayError: '' };
const remoteOn = () => !!(config.remote && config.remote.enabled);
function remoteIds() {
  const r = auth.remoteCfg();
  if (!r.id) { r.id = require('crypto').randomBytes(9).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12).padEnd(12, '7'); r.secret = require('crypto').randomBytes(32).toString('hex'); saveConfig(); }
  return r;
}
const remoteLink = () => `${RELAY}/${remoteIds().id}`;
function cloudflaredBin() { const local = path.join(__dirname, 'bin', IS_WIN ? 'cloudflared.exe' : 'cloudflared'); return process.env.CLOUDFLARED || (fs.existsSync(local) ? local : 'cloudflared'); }
async function pingUrl(u) { try { const r = await fetch(`${u}/pair/ping?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) }); return r.ok; } catch (_) { return false; } }
function startWebTunnel() {
  if (web.proc || !remoteOn()) return;
  web.state = 'spúšťam…'; web.verified = false;
  const p = web.proc = spawn(cloudflaredBin(), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== web.url) { web.url = m[0]; web.verified = false; web.state = 'overujem…'; log('Tunel pre mobil:', web.url); verifyWeb(m[0]); }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('error', (e) => { web.state = e.code === 'ENOENT' ? 'chýba program cloudflared' : e.message; });
  p.on('exit', () => { if (web.proc === p) web.proc = null; web.url = null; web.verified = false;
    if (remoteOn() && web.state !== 'chýba program cloudflared') { web.state = 'reštartujem…'; setTimeout(startWebTunnel, 5000); } else if (!remoteOn()) web.state = 'vypnuté'; });
}
function stopWebTunnel() { const p = web.proc; web.proc = null; web.url = null; web.verified = false; web.state = 'vypnuté'; try { p && p.kill(); } catch (_) {} }
async function verifyWeb(u) {
  for (let i = 0; i < 25 && web.url === u; i++) { if (await pingUrl(u)) { web.verified = true; web.fails = 0; web.state = 'beží'; registerRelay(); return; } await pause(3000); }
  if (web.url === u) { web.state = 'nedostupný – reštartujem'; try { web.proc && web.proc.kill(); } catch (_) {} }
}
async function registerRelay() {
  if (!web.url || !web.verified) return;
  const r = remoteIds();
  try {
    const res = await fetch(`${RELAY}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: r.id, secret: r.secret, url: web.url }), signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    web.registeredAt = Date.now(); web.relayError = '';
  } catch (e) { web.relayError = `rozcestník neodpovedá (${e.message})`; log('Rozcestník:', e.message); }
}
setInterval(async () => {
  if (!remoteOn() || !web.url || !web.verified) return;
  if (await pingUrl(web.url)) { web.fails = 0; if (Date.now() - web.registeredAt > 30 * 60000 || web.relayError) registerRelay(); }
  else if (++web.fails >= 2) { log('Tunel pre mobil neodpovedá – reštartujem'); web.state = 'reštartujem…'; try { web.proc && web.proc.kill(); } catch (_) {} }
}, 60000);
process.on('exit', () => { try { web.proc && web.proc.kill(); } catch (_) {} });
const corsHeaders = () => ({ 'Access-Control-Allow-Origin': RELAY_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Vary': 'Origin', 'Cache-Control': 'no-store' });

// ---------- upozornenia cez Telegram ----------
// config.telegram = { token, chatId, bot, events: { done, fail, offline, battery, wda, ai } }
const TG_EVENTS = { done: true, fail: true, offline: true, battery: true, wda: true, ai: false };
const tgCfg = () => config.telegram || {};
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
async function tgApi(method, body, token = tgCfg().token) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, body instanceof FormData ? { method: 'POST', body } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `Telegram ${r.status}`);
  return j.result;
}
async function tgSend(text, photo) {
  const t = tgCfg(); if (!t.token || !t.chatId) return;
  try {
    if (photo) {
      const fd = new FormData();
      fd.append('chat_id', String(t.chatId)); fd.append('caption', String(text).slice(0, 1000));
      fd.append('photo', new Blob([photo.buf], { type: photo.type }), 'dokaz' + (photo.type === 'image/png' ? '.png' : '.jpg'));
      await tgApi('sendPhoto', fd);
    } else await tgApi('sendMessage', { chat_id: t.chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true });
  } catch (e) { log('Telegram:', e.message); }
}
function notify(ev, text, photo) {
  const t = tgCfg(); if (!t.token || !t.chatId) return;
  const on = { ...TG_EVENTS, ...(t.events || {}) };
  if (!on[ev]) return;
  tgSend(text, photo);
}

// ---------- dôkaz: snímka obrazovky iPhonu po naplánovaní (alebo pri chybe) ----------
const PROOF_DIR = path.join(store.DATA, 'proofs');
fs.mkdirSync(PROOF_DIR, { recursive: true });
async function takeProof(dev, id) {
  if (!id) return null;
  let buf = null, type = 'image/png';
  try { const r = await wda(dev, 'GET', '/screenshot', null, 20000); if (r && r.value) buf = Buffer.from(r.value, 'base64'); } catch (_) {}
  if (!buf) { try { buf = await grabFrame(dev.mjpegPort); type = 'image/jpeg'; } catch (_) {} }
  if (!buf || buf.length < 1000) return null;
  const file = path.join(PROOF_DIR, `${id}${type === 'image/png' ? '.png' : '.jpg'}`);
  try { fs.writeFileSync(file, buf); } catch (_) { return null; }
  return { buf, type };
}
const proofFile = (id) => { if (!/^[a-f0-9]{8,32}$/.test(String(id))) return null; for (const e of ['.png', '.jpg']) { const f = path.join(PROOF_DIR, id + e); if (fs.existsSync(f)) return f; } return null; };

// ---------- platnosť podpisu WebDriverAgenta (bezplatné Apple ID = 7 dní) ----------
// presný dátum z provisioning profilu v iPhone (go-ios „profile list“); ak sa nedá zistiť, odhad 7 dní od prvého úspešného spustenia
let wdaSeen = store.readJson('wda.json', {});
const saveWdaSeen = () => store.writeJson('wda.json', wdaSeen);
const DAY = 86400000;
function wdaCameUp(dev) {
  const rec = wdaSeen[dev.udid];
  // nový podpis po vypršaní alebo prvé spustenie → začni počítať odznova
  if (!rec || Date.now() > rec.firstOk + 7 * DAY) { wdaSeen[dev.udid] = { firstOk: Date.now(), label: dev.label }; saveWdaSeen(); }
}
async function readWdaExpiry(dev) {
  if (WDA_MODE === 'xcode') { dev.wdaExp = { auto: true }; return; } // Xcode podpisuje pri každom štarte
  const out = await runIos(['profile', 'list', `--udid=${dev.udid}`]);
  const objs = [];
  const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk);
    if (Object.keys(o).some((k) => /expir/i.test(k))) objs.push(o); Object.values(o).forEach(walk); };
  for (const line of [out, ...String(out).split('\n')]) { try { walk(JSON.parse(line)); } catch (_) {} }
  const want = new RegExp(['xctrunner', 'WebDriverAgent', dev.wdaBundle ? dev.wdaBundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null].filter(Boolean).join('|'), 'i');
  let best = null;
  for (const o of objs) {
    if (!want.test(JSON.stringify(o))) continue;
    const k = Object.keys(o).find((x) => /expir/i.test(x)); const t = Date.parse(o[k]);
    if (!isNaN(t) && (!best || t > best)) best = t;
  }
  if (best) dev.wdaExp = { at: best, exact: true };
  else if (wdaSeen[dev.udid]) dev.wdaExp = { at: wdaSeen[dev.udid].firstOk + 7 * DAY, exact: false };
  else dev.wdaExp = null;
  // upozornenie deň vopred (raz za deň)
  if (dev.wdaExp && dev.wdaExp.at) {
    const left = dev.wdaExp.at - Date.now();
    const key = new Date().toDateString();
    if (left < 1.2 * DAY && dev.wdaWarned !== key) {
      dev.wdaWarned = key;
      notify('wda', left <= 0 ? `⛔ ${dev.label}: podpis WebDriverAgenta vypršal – obnov ho v Sideloadly (pretiahni WebDriverAgent.ipa a Start).`
        : `⏳ ${dev.label}: podpis WebDriverAgenta vyprší ${left < DAY / 2 ? 'o pár hodín' : 'zajtra'} – obnov ho v Sideloadly, nech sa telefón nevypne.`);
    }
  }
}

// ---------- batéria a voľné miesto v iPhone ----------
// batéria: z WebDriverAgenta; miesto: z go-ios (ak to daná verzia vie) – každých 5 minút
function jsonBits(out) {
  const objs = [];
  for (const line of String(out || '').split('\n')) { const t = line.trim(); if (!/^[{\[]/.test(t)) continue; try { objs.push(JSON.parse(t)); } catch (_) {} }
  if (!objs.length) { try { objs.push(JSON.parse(String(out))); } catch (_) {} }
  const flat = {};
  const walk = (o) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') walk(v); else flat[k] = v; } };
  objs.forEach(walk);
  return flat;
}
const runIos = (args) => new Promise((ok) => execFile(IOS_BIN, args, { timeout: 15000, maxBuffer: 4e6 }, (e, so) => ok(e ? '' : String(so || ''))));
async function readStorage(dev) {
  const u = `--udid=${dev.udid}`;
  for (const args of [['diskspace', u], ['lockdown', 'get', '--domain=com.apple.disk_usage', u], ['info', 'lockdown', '--domain=com.apple.disk_usage', u]]) {
    const f = jsonBits(await runIos(args));
    const pick = (re) => { for (const [k, v] of Object.entries(f)) if (re.test(k) && Number(v) > 0) return Number(v); return null; };
    const free = pick(/^(TotalDataAvailable|AmountDataAvailable|FreeBytes|FreeSpace|Free|AvailableBytes)$/i) ?? pick(/avail|free/i);
    const total = pick(/^(TotalDataCapacity|TotalDiskCapacity|TotalBytes|TotalSpace|Total|Capacity)$/i) ?? pick(/capacity|total/i);
    if (free != null) return { free, total };
  }
  return null;
}
async function readPhoneInfo(dev) {
  const info = dev.info || {};
  if (dev.wdaOk) {
    try {
      const r = await withSession(dev, (sid) => wda(dev, 'GET', `/session/${sid}/wda/batteryInfo`, null, 5000));
      const v = r && r.value;
      if (v && typeof v.level === 'number' && v.level >= 0) { info.battery = Math.round(v.level * 100); info.charging = v.state === 2 || v.state === 3; }
    } catch (_) {}
  }
  if (info.battery == null) {
    const f = jsonBits(await runIos(['batterycheck', `--udid=${dev.udid}`]));
    if (f.BatteryCurrentCapacity != null) { info.battery = Number(f.BatteryCurrentCapacity); info.charging = !!f.BatteryIsCharging; }
  }
  const st = await readStorage(dev).catch(() => null);
  if (st) { info.freeGB = +(st.free / 1e9).toFixed(1); info.totalGB = st.total ? Math.round(st.total / 1e9) : null; }
  info.at = Date.now();
  dev.info = info;
  if (info.battery != null) {
    if (info.battery < 20 && !info.charging && !dev.lowBatNotified) { dev.lowBatNotified = true; notify('battery', `🔋 ${dev.label}: batéria ${info.battery} % a nenabíja sa.`); }
    if (info.battery > 30 || info.charging) dev.lowBatNotified = false;
  }
  if (!dev.wdaCheckAt || Date.now() - dev.wdaCheckAt > 3 * 3600000) { dev.wdaCheckAt = Date.now(); await readWdaExpiry(dev).catch(() => {}); }
}
setInterval(() => { for (const d of devices.values()) if (!d.gone && (!d.info || Date.now() - d.info.at > 5 * 60000)) readPhoneInfo(d).catch(() => {}); }, 30000);

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
function readBody(req, max = 1e6) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > max) req.destroy(); });
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
    ok ? `${item.name} je v telefóne ${dev.label}${item.via ? ' (cez ' + item.via + ')' : ''}` : `${item.name}: ${item.status}`, { phone: dev.label }),
  // posielanie cez kábel: súbor do Documents WebDriverAgenta cez go-ios (AFC / house_arrest)
  usb: {
    enabled: () => config.mediaUsb !== false,
    async push(dev, src, name, size) {
      const b = dev.wdaBundle || WDA_BUNDLE || await findWdaBundle(dev, 40);
      if (!b) return { ok: false, err: 'v telefóne som nenašiel WebDriverAgent' };
      let err = '';
      for (const dst of [`Documents/${name}`, name]) {
        const r = await afc(dev, b, ['push', `--srcPath=${src}`, `--dstPath=${dst}`], Math.round(60000 + size / 5e3));
        if (!r.ok) { err = r.err; continue; }
        const f = { b, dst };
        if ((await mediaCtx.usb.exists(dev, f)) !== false) return { ok: true, ...f };
        err = 'súbor sa po nahratí v telefóne nenašiel';
      }
      return { ok: false, err: err || 'neznáma chyba' };
    },
    async exists(dev, f) {
      const dir = path.posix.dirname(f.dst);
      const r = await afc(dev, f.b, ['tree', `--path=${dir === '.' ? '/' : dir}`]);
      if (!r.ok) return null;
      return r.out.includes(path.posix.basename(f.dst));
    },
    remove: (dev, f) => afc(dev, f.b, ['rm', `--path=${f.dst}`]),
  },
};
function afc(dev, bundle, args, timeout = 20000) {
  return new Promise((ok) => execFile(IOS_BIN, ['fsync', `--app=${bundle}`, `--udid=${dev.udid}`, ...args], { timeout: Math.round(timeout), maxBuffer: 8e6, windowsHide: true }, (e, so, se) => {
    const last = String(se || (e && e.message) || '').trim().split('\n').pop() || '';
    let msg = last; try { const j = JSON.parse(last); msg = j.err || j.error || j.msg || last; } catch (_) {}
    ok({ ok: !e, out: String(so || ''), err: String(msg).slice(0, 200) });
  }));
}

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
    if (!dev.plan || !dev.plan.running) {
      if (ok) notify('ai', `🤖 ${dev.label}: AI úloha hotová – ${last.replace(/^✓\s*(Hotovo:\s*)?/, '').slice(0, 300)}`);
      else if (!/^■/.test(last)) notify('fail', `⚠ ${dev.label}: AI úloha zlyhala – ${last.replace(/^[⚠■]\s*/, '').slice(0, 300)}`);
    }
    if (ok) {
      // výsledok AI: záverečné zhrnutie + posledné poznámky (prehľad býva v nich)
      const log = dev.agent.log, done = last.replace(/^✓\s*(Hotovo:\s*)?/, '');
      const notes = log.filter((l) => l.startsWith('💬')).slice(-3).map((l) => l.replace(/^💬\s*/, ''));
      const full = done.length > 200 ? done : [...notes, done].join('\n');
      if (/ZHLIADNUTIA\s*:/i.test(task)) { const st = content.addStatFromText(dev.udid, dev.label, full); if (st) store.addActivity('ai_done', `Štatistika ${dev.label}: ${st.views.toLocaleString('sk-SK')} zhliadnutí`, { phone: dev.label }); }
      if (isResearch(task)) {
        const prof = (task.match(/Profil na prieskum:\s*„([^“”"]*)[“”"]/) || [])[1] || '';
        content.addResearch({ udid: dev.udid, phone: dev.label, profile: prof.trim() || 'Reels feed', reels: reels || 0, ads, text: full });
      }
    }
  }, 2000);
}

// spustí AI úlohu na telefóne
async function runAgentTask(dev, task, maxSteps) {
  await wake(dev);
  await pause(800); // nech je na obrazovke už odomknutý telefón
  startAgent(dev, task, agentAuth(), {
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
  const lf = content.libFile(id); if (lf) return lf; // súbory z knižnice médií
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
  let okCount = 0, failMsg = '', failProof = null, lastProof = null;
  const doneList = [];
  // kalendár: každý príspevok s dátumom sa zapíše hneď (stav „čaká“) a po naplánovaní sa aktualizuje
  for (const st of steps) if (st.meta && st.meta.when) st.calId = content.addCalendar({
    udid: dev.udid, phone: dev.label, kind: st.meta.kind || '', when: st.meta.when, whenText: st.meta.whenText || '',
    caption: st.meta.caption || '', music: st.meta.music || '', place: st.meta.place || '', title: st.title || '',
    task: st.task, maxSteps: st.maxSteps || null,
    files: st.files.map((f) => ({ id: f.id, name: f.name })) }).id;
  const calSet = (st, status) => { if (st.calId) content.setCalendar(st.calId, { status, doneAt: new Date().toISOString() }); };
  try {
    for (const [i, st] of steps.entries()) {
      if (stopped()) { say('■ Plán zastavený'); break; }
      const head = `${st.title || 'Príspevok'} (${i + 1}/${steps.length})`;
      if (!dev.agent || !dev.agent.running) dev.agent = { running: true, stop: false, log: [] };
      // 1) médiá do galérie – v opačnom poradí, aby prvý súbor bol najnovší (na 1. mieste)
      if (st.files.length) {
        if (dev.info && dev.info.freeGB != null && dev.info.freeGB < 0.5) { calSet(st, 'chyba'); say(`⚠ ${head}: v iPhone je len ${dev.info.freeGB} GB voľného miesta – uvoľni miesto (napr. zmaž staré videá) a skús znova.`); break; }
        say(`📤 ${head}: posielam ${st.files.length === 1 ? st.files[0].name : st.files.length + ' súbory'} do galérie…`);
        const items = st.files.slice().reverse().map((f) => media.enqueueCopy(dev, planFile(f.id), f.name, mediaCtx));
        while (!stopped() && items.some((it) => !/^(✓|chyba)/.test(it.status))) await pause(1000);
        if (stopped()) { say('■ Plán zastavený'); break; }
        const bad = items.find((it) => it.status.startsWith('chyba'));
        if (bad) { calSet(st, 'chyba'); failMsg = `${bad.name} sa nepodarilo poslať do iPhonu (${bad.status.replace(/^chyba:\s*/, '')})`; say(`⚠ ${head}: ${bad.name} sa nepodarilo poslať (${bad.status.replace(/^chyba:\s*/, '')}). Plán zastavujem, nič som nezverejnil.`); break; }
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
      if (!last.startsWith('✓')) {
        calSet(st, 'chyba');
        failMsg = `${head}: ${last.replace(/^[⚠■✓]\s*/, '').slice(0, 300)}`;
        failProof = await takeProof(dev, st.calId); if (failProof && st.calId) content.setCalendar(st.calId, { proof: true });
        say(`⚠ ${head} sa nepodaril – plán zastavujem, aby sa ďalšie médiá nepomiešali.`); break;
      }
      calSet(st, 'naplánované');
      // dôkaz: snímka plánovača v Meta Business Suite (AI ho na konci otvorí)
      const pr = await takeProof(dev, st.calId);
      if (pr) { lastProof = pr; if (st.calId) content.setCalendar(st.calId, { proof: true }); say(`📸 ${head}: uložená snímka plánovača (Kalendár)`); }
      doneList.push(`${st.title || 'Príspevok'}${st.meta && st.meta.whenText ? ' – ' + st.meta.whenText : ''}`);
      content.markUsed(st.files.map((f) => f.id), dev.udid, st.calId);
      okCount++;
      if (i < steps.length - 1) { dev.agent.running = true; say(`→ pokračujem ďalším príspevkom`); }
    }
  } catch (e) {
    say(`⚠ ${e.message}`); failMsg = e.message;
  } finally {
    plan.running = false;
    // súbor zmaž, až keď ho nepotrebuje ani plán na inom telefóne (rovnaké video môže ísť na viac telefónov)
    const inUse = new Set([...devices.values()].filter((d) => d.plan && d.plan.running).flatMap((d) => d.plan.fileIds || []));
    for (const st of steps) for (const f of st.files) { if (content.libFile(f.id)) continue; const fp = planFile(f.id); if (fp && !inUse.has(f.id)) fs.unlink(fp, () => {}); }
    for (const st of steps) if (st.calId && st.status !== 'done') { const c = content.listCalendar().find((x) => x.id === st.calId); if (c && c.status === 'čaká') content.setCalendar(st.calId, { status: 'nespustené' }); }
    say(okCount === steps.length ? `✓ Plán hotový: naplánované ${okCount}/${steps.length}` : `■ Plán skončil: naplánované ${okCount}/${steps.length}`);
    if (okCount === steps.length) notify('done', `✅ ${dev.label}: naplánované ${okCount}/${steps.length}\n${doneList.map((x) => '• ' + x).join('\n')}`, lastProof);
    else if (plan.stop || (dev.agent && dev.agent.stop)) notify('fail', `■ ${dev.label}: plán zastavený ručne – naplánované ${okCount}/${steps.length}.`);
    else notify('fail', `⚠ ${dev.label}: plán zlyhal – naplánované ${okCount}/${steps.length}.\n${failMsg || 'Pozri kartu telefónu na stránke.'}${okCount < steps.length ? '\nV Prehľade (Dnes) môžeš dať „Skúsiť znova“.' : ''}`, failProof);
    if (dev.agent) dev.agent.running = false;
    plan.running = false;
  }
}

// ---------- návrhy popisov (Claude) ----------
// hashtagy: bez = všetky preč; s = stále hashtagy účtu + z popisu, spolu najviac 5 (viac IG/FB neprijme)
const TAG_RE = /#[\p{L}\p{N}_]+/gu;
function limitTags(cap, on, fixed) {
  cap = String(cap || '');
  const own = cap.match(TAG_RE) || [];
  const text = cap.replace(TAG_RE, '').replace(/[ \t]+$/gm, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!on) return text;
  const tags = [];
  for (const t of [...(String(fixed || '').match(TAG_RE) || []), ...own]) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  return tags.length ? (text ? text + '\n\n' : '') + tags.slice(0, 5).join(' ') : text;
}
async function suggestCaptions(b) {
  const noTags = b.tags === false || b.tags === 0 || b.tags === '0';
  if (!aiAuth()) throw new Error('Chýba kľúč pre AI – nastav Claude alebo KIE kľúč (Nastavenia)');
  const dev = devices.get(String(b.udid || '')), prof = content.getProfile(String(b.udid || ''));
  const recent = content.listCalendar().filter((x) => x.udid === b.udid && x.caption).slice(-6).map((x) => x.caption);
  const kind = b.kind === 'carousel' ? 'carousel (viac fotiek)' : 'reel (video)';
  const parts = [];
  // náhľady fotiek / záberov z videa pripraví prehliadač (JPEG); AI si ich prezrie a popis napíše podľa nich
  const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 6)
    .map((x) => String(x || '').replace(/^data:image\/\w+;base64,/, '')).filter((x) => x.length > 100 && x.length < 3e6);
  for (const data of imgs) parts.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
  const fp = !imgs.length && b.fileId ? content.libFile(String(b.fileId)) : null;
  if (fp && /\.(jpe?g|png|webp|gif)$/i.test(fp) && fs.statSync(fp).size < 4.5e6) {
    const ext = path.extname(fp).toLowerCase();
    parts.push({ type: 'image', source: { type: 'base64', media_type: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg', data: fs.readFileSync(fp).toString('base64') } });
  }
  parts.push({ type: 'text', text: [
    `Navrhni 3 rôzne popisy pre Instagram ${kind}.`,
    parts.length ? (b.kind === 'reel' ? `Priložené sú zábery z videa (${parts.length}). Pozri si ich a popis napíš podľa toho, čo sa vo videu deje – prostredie, outfit, nálada, aktivita.` : `Priložené sú fotky z carouselu (${parts.length}) v poradí. Pozri si ich a popis napíš podľa toho, čo na nich je.`) : '',
    prof.handle ? `Účet: @${prof.handle}.` : (dev ? `Účet: ${dev.label}.` : ''),
    prof.note ? `Štýl a poznámky k účtu: ${prof.note}` : '',
    !noTags && prof.hashtags ? `Stále hashtagy účtu (musia byť medzi hashtagmi): ${prof.hashtags}.` : '',
    recent.length ? `Doterajšie popisy tohto účtu (drž sa ich štýlu, ale píš po anglicky):\n- ${recent.join('\n- ')}` : '',
    b.hint ? `O čom je príspevok / čo chcem: ${String(b.hint).slice(0, 500)}` : '',
    b.fileName ? `Názov súboru: ${String(b.fileName).slice(0, 100)}` : '',
    noTags ? 'Each caption MUST be written in English (even if the notes or hints above are in Slovak): a short hook at the start, 1–3 sentences. Do NOT use any hashtags at all. No misleading claims.'
      : 'Each caption MUST be written in English (even if the notes or hints above are in Slovak): a short hook at the start, 1–3 sentences, then hashtags at the end – AT MOST 5 hashtags in total (Instagram and Facebook do not accept more), including the account\'s fixed ones. No misleading claims.',
    'Odpovedz IBA ako JSON: {"captions":["…","…","…"]}',
  ].filter(Boolean).join('\n') });
  const SYS = 'You are an experienced Instagram copywriter. Always write captions in natural, native-sounding English, in the style of the given account.';
  const auth = aiAuth();
  // KIE: Claude cez KIE obrázky neprijíma → fotky si prezrie Gemini (cez KIE) z dočasných verejných odkazov
  const out = auth && auth.provider === 'kie' ? await kieVision(auth.key, SYS, parts) : await askText(auth, SYS, parts);
  const m = out.match(/\{[\s\S]*\}/);
  let caps;
  try { const j = JSON.parse(m ? m[0] : out); if (Array.isArray(j.captions)) caps = j.captions.slice(0, 3).map(String); } catch (_) {}
  if (!caps) caps = out.split(/\n\s*\n/).slice(0, 3);
  return caps.map((c) => limitTags(c, !noTags, prof.hashtags));
}

// Gemini cez KIE (OpenAI formát) – obrázky musia byť na verejnej adrese, preto ich dočasne zverejníme cez tunel
const CAP_TMP = path.join(store.DATA, 'tmp-captions');
fs.mkdirSync(CAP_TMP, { recursive: true });
async function kieVision(key, system, parts) {
  const content = [];
  for (const p of parts) {
    if (p.type === 'text') { content.push({ type: 'text', text: p.text }); continue; }
    // 1) nahraj obrázok priamo do KIE (dočasné úložisko KIE, 3 dni) – nepotrebuje tunel
    let url = null; const errs = [];
    // KIE má nahrávanie na dvoch adresách – skúsime obe
    for (const base of (process.env.KIE_UPLOAD_URL ? [process.env.KIE_UPLOAD_URL] : ['https://api.kie.ai/api/file-base64-upload', 'https://kieai.redpandaai.co/api/file-base64-upload'])) {
      try {
        const up = await fetch(base, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ base64Data: `data:image/jpeg;base64,${p.source.data}`, uploadPath: 'iphonewall', fileName: require('crypto').randomBytes(6).toString('hex') + '.jpg' }),
        });
        const txt = await up.text(); let uj = {}; try { uj = JSON.parse(txt); } catch (_) {}
        url = (uj.data && (uj.data.downloadUrl || uj.data.fileUrl || uj.data.url)) || null;
        if (url) break;
        errs.push(`${new URL(base).host}: ${uj.msg || uj.message || ('HTTP ' + up.status + ' ' + txt.slice(0, 80))}`);
      } catch (e) { errs.push(`${new URL(base).host}: ${e.message}`); }
    }
    const upErr = errs.join(' | ');
    console.log(url ? `[popisy] fotka nahratá do KIE: ${url}` : `[popisy] nahratie do KIE zlyhalo: ${upErr}`);
    if (!url) throw new Error(`KIE: fotku sa nepodarilo nahrať do KIE (${upErr || 'neznáma chyba'}).`);
    content.push({ type: 'image_url', image_url: { url } });
  }
  // text daj na začiatok (pokyn), obrázky za ním
  content.sort((a, b) => (a.type === 'text' ? 0 : 1) - (b.type === 'text' ? 0 : 1));
  const r = await fetch(process.env.KIE_VISION_URL || 'https://api.kie.ai/gemini-3-8-flash-openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-3-8-flash', stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (_) { throw new Error(`KIE ${r.status}: ${txt.slice(0, 160)}`); }
  const d = j.choices ? j : (j.data || {});
  const msg = d.choices && d.choices[0] && d.choices[0].message;
  if (d.usage) store.addUsage({ kind: 'popisy', provider: 'KIE', model: 'gemini-3-8-flash', input: d.usage.prompt_tokens, output: d.usage.completion_tokens });
  if (!msg) {
    const err = (j.error && (j.error.message || j.error)) || j.msg || `KIE ${r.status}`;
    if (/credit|balance|insufficient/i.test(String(err))) throw new Error('KIE: nemáš dosť kreditu – dobi si ho na kie.ai');
    throw new Error(`KIE: ${err}`);
  }
  return Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join('\n') : String(msg.content || '');
}

// ---------- stav systému: čo funguje a čo treba opraviť ----------
function diskFree() { try { const st = fs.statfsSync(__dirname); return st.bavail * st.bsize; } catch (_) { return null; } }
function health() {
  const items = [];
  const add = (status, title, detail, fix) => items.push({ status, title, detail, fix: fix || null });
  // server + go-ios
  if (lastListError) add('bad', 'Pripojenie iPhonov (go-ios)', lastListError, { label: 'Návod', href: '#navod' });
  else add('ok', 'Pripojenie iPhonov', 'go-ios beží');
  // AI
  if (config.apiKey && !/^sk-ant-/.test(config.apiKey)) add('bad', 'Claude API kľúč', 'Vložený kľúč nie je Claude kľúč (nezačína sk-ant-).', { label: 'Opraviť kľúč', href: '#nastavenia' });
  else if (apiKey()) add('ok', 'AI ovládanie telefónov', 'Claude kľúč je nastavený');
  else add('bad', 'AI ovládanie telefónov', 'Chýba Claude kľúč – šablóny a plánovanie nepôjdu.', { label: 'Vložiť kľúč', href: '#nastavenia' });
  if (aiAuth()) add('ok', 'Návrhy popisov', aiProvider() === 'kie' ? 'cez KIE' : 'cez Claude');
  else add('warn', 'Návrhy popisov', 'Nie je nastavený KIE ani Claude kľúč.', { label: 'Nastaviť', href: '#nastavenia' });
  // médiá
  const m = media.mediaInfo();
  if (m.via === 'internet') add('ok', 'Posielanie fotiek a videí', m.tunnel === 'vlastná adresa' ? 'cez tvoju stálu adresu' : 'cez internet (tunel)');
  else if (m.tunnel === 'vlastná adresa') add('warn', 'Posielanie fotiek a videí', 'Vlastná adresa neodpovedá.', { label: 'Nastavenia', href: '#nastavenia' });
  else if (/chýba/i.test(m.tunnel || '')) add('warn', 'Posielanie fotiek a videí', `${m.tunnel} – iPhony musia byť na rovnakej Wi-Fi. Spusti stránku znova cez START_STRANKY (doinštaluje ho).`);
  else add('warn', 'Posielanie fotiek a videí', `Tunel: ${m.tunnel || 'nebeží'} – iPhony musia byť na rovnakej Wi-Fi.`, { label: 'Reštartovať tunel', action: 'tunnel' });
  // prístup z mobilu
  if (remoteOn()) {
    if (web.verified && !web.relayError) add('ok', 'Prístup z mobilu', `zapnutý · ${auth.listDevices().length} spárovaných mobilov`);
    else add('warn', 'Prístup z mobilu', web.relayError || `tunel: ${web.state}`, { label: 'Nastavenia', href: '#nastavenia' });
  }
  // disk počítača
  const free = diskFree();
  if (free != null) {
    const gb = free / 1e9, lib = content.librarySize() / 1e9;
    add(gb < 2 ? 'bad' : gb < 10 ? 'warn' : 'ok', 'Miesto na počítači', `${gb.toFixed(1)} GB voľných · knižnica zaberá ${lib.toFixed(1)} GB`, gb < 10 ? { label: 'Upratať knižnicu', href: '#kniznica' } : null);
  }
  // telefóny
  for (const d of devices.values()) {
    const i = d.info || {}, bits = [];
    let st = 'ok', fix = null;
    const expired = /expired|not been explicitly trusted|invalid code signature|0xe800801[8c]|profile/i.test(d.lastLog || '');
    if (!d.wdaOk && expired) { st = 'bad'; bits.push('podpis WebDriverAgenta vypršal alebo nie je dôveryhodný – obnov ho v Sideloadly'); fix = { label: 'Obnovil som', action: 'wda-renewed', udid: d.udid }; }
    else if (!d.wdaOk) { st = 'bad'; bits.push(d.lastLog ? d.lastLog.slice(0, 120) : 'čaká na WebDriverAgent – odomkni telefón'); fix = { label: 'Obnoviť spojenie', action: 'reset', udid: d.udid }; }
    else if (d.locked) { st = 'warn'; bits.push('spí'); fix = { label: 'Zobudiť', action: 'unlock', udid: d.udid }; }
    else bits.push('pripravený');
    if (i.battery != null) { bits.push(`batéria ${i.battery} %${i.charging ? ' (nabíja sa)' : ''}`); if (i.battery < 15 && !i.charging) st = 'bad'; else if (i.battery < 30 && !i.charging && st === 'ok') st = 'warn'; }
    if (d.wdaExp && d.wdaExp.auto) bits.push('podpis WDA sa obnovuje sám (Xcode)');
    else if (d.wdaExp && d.wdaExp.at) {
      const days = Math.ceil((d.wdaExp.at - Date.now()) / DAY);
      bits.push(days <= 0 ? 'podpis WDA vypršal' : `podpis WDA platí ešte ${days} ${days === 1 ? 'deň' : days < 5 ? 'dni' : 'dní'}${d.wdaExp.exact ? '' : ' (odhad)'}`);
      if (days <= 0) { st = 'bad'; fix = fix || { label: 'Obnovil som', action: 'wda-renewed', udid: d.udid }; }
      else if (days <= 2) { if (st === 'ok') st = 'warn'; fix = fix || { label: 'Obnovil som', action: 'wda-renewed', udid: d.udid }; }
    }
    if (i.freeGB != null) { bits.push(`${i.freeGB} GB voľných`); if (i.freeGB < 1) st = 'bad'; else if (i.freeGB < 3 && st === 'ok') st = 'warn'; }
    add(st, d.label, bits.join(' · '), fix);
  }
  if (!devices.size) add('warn', 'Telefóny', 'Žiadny iPhone nie je pripojený.');
  const worst = items.some((x) => x.status === 'bad') ? 'bad' : items.some((x) => x.status === 'warn') ? 'warn' : 'ok';
  return { status: worst, items };
}

// ---------- „Dnes“: čo sa dnes plánovalo na ktorom telefóne ----------
function todayBoard() {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0); const t1 = new Date(t0.getTime() + 86400000);
  const isToday = (iso) => iso && new Date(iso) >= t0 && new Date(iso) < t1;
  const cal = content.listCalendar().filter((c) => isToday(c.createdAt) || isToday(c.when) || isToday(c.doneAt) || (['chyba', 'nespustené'].includes(c.status) && new Date(c.when) > Date.now()));
  const ids = new Set([...devices.keys(), ...cal.map((c) => c.udid)]);
  return [...ids].map((u) => {
    const d = devices.get(u);
    return { udid: u, label: d ? d.label : ((cal.find((c) => c.udid === u) || {}).phone || 'telefón'), online: !!(d && d.wdaOk),
      running: !!(d && d.agent && d.agent.running), last: d && d.agent && d.agent.log.length ? d.agent.log[d.agent.log.length - 1] : '',
      items: cal.filter((c) => c.udid === u).sort((a, b) => String(a.when).localeCompare(String(b.when)))
        .map((c) => ({ id: c.id, kind: c.kind, when: c.when, status: c.status, caption: (c.caption || '').slice(0, 80), files: (c.files || []).length, proof: !!c.proof, retry: !!c.task && ['chyba', 'nespustené'].includes(c.status) })) };
  });
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
    hasKey: !!aiAuth(),
    usage: (() => { const u = store.usageSummary(1); return { today: u.today, month: u.month }; })(),
    board: todayBoard(),
    health: health(),
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

  // ---------- párovanie mobilu (volá ho stránka rozcestníka) ----------
  if (parts[0] === 'pair') {
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }
    if (url.pathname === '/pair/ping') { res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    const ip = auth.clientIp(req);
    if (auth.tooMany(ip)) { res.writeHead(429, { ...corsHeaders(), 'Content-Type': 'application/json' }); return res.end('{"error":"Príliš veľa pokusov – skús o 15 minút"}'); }
    if (url.pathname === '/pair/claim' && req.method === 'POST') {
      const b = await readBody(req, 10000);
      const dev = auth.claimPair(b.code, b.key, b.name);
      if (!dev) { auth.noteFail(ip); res.writeHead(403, { ...corsHeaders(), 'Content-Type': 'application/json' }); return res.end('{"error":"QR kód je neplatný alebo vypršal"}'); }
      store.addActivity('phone', `Spárovaný nový mobil: ${dev.name}`);
      notify('offline', `📱 K JD Phone Studio bol spárovaný nový mobil (${dev.name}). Ak si to nebol ty, odober ho v Nastaveniach → Prístup z mobilu.`);
      res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' }); return res.end('{"ok":true}');
    }
    if (url.pathname === '/pair/login' && req.method === 'POST') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 2000) break; }
      const key = new URLSearchParams(body).get('d') || '';
      const dev = /^[a-f0-9]{64}$/.test(key) && auth.findDevice(key);
      if (!dev) { auth.noteFail(ip); auth.page(res, 403, '<h1>Mobil nie je spárovaný</h1><p>Tento mobil bol odobraný alebo kľúč nesedí. V aplikácii na počítači klikni <b>Nastavenia → Prístup z mobilu → Pridať mobil</b> a naskenuj nový QR kód.</p>'); return; }
      res.writeHead(303, { 'Set-Cookie': auth.deviceCookie(dev), Location: '/', 'Cache-Control': 'no-store' }); return res.end();
    }
    res.writeHead(404); return res.end();
  }

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

  if (parts[0] === 'api' && parts[2] === 'upload' && parts[1] !== 'library' && parts[1] !== 'magnific' && req.method === 'POST') {
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
  if (url.pathname === '/qr.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'qr.js')).pipe(res);
  }
  if (url.pathname === '/novy.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'novy.js')).pipe(res);
  }
  if (url.pathname === '/obsah.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'obsah.js')).pipe(res);
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
      hasKey: !!aiAuth(),
      hasClaudeKey: !!apiKey(),
      aiProvider: config.aiProvider || 'auto', aiUsing: aiProvider(), kieModel: config.kieModel || 'claude-sonnet-5',
      hasMagnificKey: !!(process.env.MAGNIFIC_API_KEY || config.magnificKey),
      hasKieKey: !!config.kieKey,
      keyLooksWrong: !!(config.apiKey && !/^sk-ant-/.test(config.apiKey)),
      typingSpeed: typingSpeed(),
      cleanupDays: config.cleanupDays || 0,
      mediaUsb: config.mediaUsb !== false,
      telegram: { bot: tgCfg().bot || '', linked: !!(tgCfg().token && tgCfg().chatId), chatName: tgCfg().chatName || '', events: { ...TG_EVENTS, ...(tgCfg().events || {}) } },
      lanIp: media.lanIp(),
      mediaNet: media.mediaInfo(),
      shortcut: media.SHORTCUT_NAME,
      devices: [...devices.values()].map((d) => ({
        udid: d.udid, name: d.name, label: d.label, version: d.version,
        wdaOk: d.wdaOk, size: d.size, lastLog: d.wdaOk ? '' : d.lastLog,
        agent: d.agent ? { running: d.agent.running, log: d.agent.log.slice(-15) } : null,
        media: media.mediaState(d),
        usb: d.usbInfo || '',
        locked: !!d.locked,
        profile: content.getProfile(d.udid),
        info: d.info ? { battery: d.info.battery, charging: d.info.charging, freeGB: d.info.freeGB, totalGB: d.info.totalGB } : null,
      })),
    });
  }

  // ---------- knižnica médií ----------
  if (url.pathname === '/api/library' && req.method === 'GET') return json(res, 200, content.listLibrary());
  if (url.pathname === '/api/library/bulk' && req.method === 'POST') {
    const b = await readBody(req);
    if (!['assign', 'unassign', 'delete'].includes(b.action)) return json(res, 400, { error: 'Neznáma akcia' });
    return json(res, 200, { ok: true, count: content.bulkLibrary(b.ids, b.action, b.owners) });
  }
  if (url.pathname === '/api/library/cleanup') {
    if (req.method === 'GET') return json(res, 200, { ...content.cleanupLibrary(url.searchParams.get('days') || config.cleanupDays || 30, true), size: content.librarySize(), days: config.cleanupDays || 0, diskFree: diskFree() });
    const b = await readBody(req);
    const r = content.cleanupLibrary(b.days || 30, false);
    if (r.count) store.addActivity('media', `Upratané: ${r.count} starých súborov (${(r.bytes / 1e9).toFixed(2)} GB)`);
    return json(res, 200, r);
  }
  // mená aj odpojených telefónov (pre knižnice jednotlivých telefónov)
  if (url.pathname === '/api/phone-names' && req.method === 'GET') {
    const out = {};
    for (const u of new Set([...Object.keys(labels), ...content.listLibrary().flatMap((x) => x.owners)])) out[u] = { label: labels[u] || '', ...content.getProfile(u) };
    return json(res, 200, out);
  }
  if ((url.pathname === '/api/library/upload' || url.pathname === '/api/plan-file') && req.method === 'POST') {
    try { return json(res, 200, await content.addToLibrary(req, String(url.searchParams.get('name') || 'subor'), url.searchParams.get('owner') || '')); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (parts[0] === 'lib' && parts[1]) {
    const f = content.libFile(parts[1]);
    if (!f) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(f).size, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const type = content.TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream';
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 0, end = range[2] ? Math.min(size - 1, parseInt(range[2], 10)) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=86400' });
    return fs.createReadStream(f).pipe(res);
  }
  // ---------- kalendár, štatistiky, prieskumy, profily, popisy ----------
  if (url.pathname === '/api/calendar' && req.method === 'GET') return json(res, 200, content.listCalendar(url.searchParams.get('from'), url.searchParams.get('to')));
  if (url.pathname === '/api/stats' && req.method === 'GET') return json(res, 200, content.listStats());
  if (url.pathname === '/api/research' && req.method === 'GET') return json(res, 200, content.listResearch());
  if (['/api/library/delete', '/api/library/note', '/api/library/owners', '/api/calendar/delete', '/api/calendar/status', '/api/stats/delete', '/api/research/delete', '/api/profile', '/api/captions'].includes(url.pathname) && req.method === 'POST') {
    const b = await readBody(req, url.pathname === '/api/captions' ? 12e6 : 1e6);
    try {
      switch (url.pathname) {
        case '/api/library/delete': content.removeFromLibrary(String(b.id)); break;
        case '/api/library/note': content.setLibNote(String(b.id), b.note); break;
        case '/api/library/owners': content.setOwners(String(b.id), b.owners); break;
        case '/api/calendar/delete': content.removeCalendar(String(b.id)); break;
        case '/api/calendar/status': content.setCalendar(String(b.id), { status: String(b.status || '').slice(0, 20) }); break;
        case '/api/stats/delete': content.removeStat(String(b.id)); break;
        case '/api/research/delete': content.removeResearch(String(b.id)); break;
        case '/api/profile': {
          const dev = devices.get(String(b.udid));
          if (b.label !== undefined && dev) { dev.label = String(b.label || '').slice(0, 40) || dev.name; labels[dev.udid] = dev.label; saveLabels(); }
          return json(res, 200, content.setProfile(String(b.udid), b));
        }
        case '/api/captions': return json(res, 200, { captions: await suggestCaptions(b) });
      }
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (url.pathname === '/api/overview') return json(res, 200, overview());
  if (url.pathname === '/api/health') return json(res, 200, health());
  // ---------- prístup z mobilu ----------
  if (url.pathname === '/api/remote' && req.method === 'GET') {
    return json(res, 200, { enabled: remoteOn(), state: web.state, url: web.verified ? web.url : null, link: remoteLink(), relay: RELAY, relayError: web.relayError,
      registered: !!web.registeredAt && !web.relayError, devices: auth.listDevices(), remote });
  }
  if (url.pathname.startsWith('/api/remote/') && req.method === 'POST') {
    const b = await readBody(req);
    if (url.pathname === '/api/remote/revoke') { auth.removeDevice(String(b.id || '')); return json(res, 200, { ok: true }); }
    if (remote) return json(res, 403, { error: 'Toto sa dá nastaviť len priamo na počítači' });
    if (url.pathname === '/api/remote/enable') {
      auth.remoteCfg().enabled = !!b.on; saveConfig(); remoteIds();
      if (b.on) startWebTunnel(); else stopWebTunnel();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/remote/pair') {
      if (!remoteOn()) return json(res, 400, { error: 'Najprv zapni prístup z mobilu' });
      const code = auth.newPairCode();
      return json(res, 200, { link: `${remoteLink()}#pair=${code}`, expires: Date.now() + 10 * 60000, ready: web.verified && !web.relayError });
    }
    return json(res, 404, { error: 'Neznáma akcia' });
  }
  // dôkaz o naplánovaní (snímka obrazovky)
  if (parts[0] === 'proof' && parts[1]) {
    const f = proofFile(parts[1].replace(/\.(png|jpg)$/, ''));
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'max-age=86400' });
    return fs.createReadStream(f).pipe(res);
  }
  // WDA bol znova podpísaný (Sideloadly) → počítaj 7 dní odznova
  if (url.pathname === '/api/wda/renewed' && req.method === 'POST') {
    const b = await readBody(req); const dev = devices.get(String(b.udid || ''));
    wdaSeen[String(b.udid)] = { firstOk: Date.now(), label: dev ? dev.label : '' }; saveWdaSeen();
    if (dev) { dev.wdaCheckAt = 0; dev.wdaWarned = null; readWdaExpiry(dev).catch(() => {}); }
    return json(res, 200, { ok: true });
  }
  // ---------- Telegram ----------
  if (url.pathname.startsWith('/api/telegram') && req.method === 'POST') {
    const b = await readBody(req);
    try {
      switch (url.pathname) {
        case '/api/telegram': {
          const token = String(b.token || '').trim();
          if (!/^\d{5,}:[\w-]{20,}$/.test(token)) return json(res, 400, { error: 'Toto nevyzerá ako token od BotFathera (napr. 123456789:AAH…).' });
          const me = await tgApi('getMe', {}, token);
          config.telegram = { ...tgCfg(), token, bot: me.username, chatId: '' }; saveConfig();
          return json(res, 200, { ok: true, bot: me.username });
        }
        case '/api/telegram/link': {
          const ups = await tgApi('getUpdates', { limit: 50 });
          const m = ups.map((u) => u.message || u.edited_message || u.my_chat_member || u.channel_post).filter((x) => x && x.chat).pop();
          if (!m) return json(res, 400, { error: `Najprv napíš svojmu botovi @${tgCfg().bot || ''} v Telegrame ľubovoľnú správu (napr. /start) a potom klikni znova.` });
          config.telegram = { ...tgCfg(), chatId: m.chat.id, chatName: m.chat.first_name || m.chat.title || m.chat.username || '' }; saveConfig();
          await tgSend('✅ JD Phone Studio je prepojené. Sem ti budú chodiť upozornenia.');
          return json(res, 200, { ok: true, chatName: config.telegram.chatName });
        }
        case '/api/telegram/test': await tgApi('sendMessage', { chat_id: tgCfg().chatId, text: '🔔 Test upozornenia z JD Phone Studio – funguje to.' }); break;
        case '/api/telegram/events': config.telegram = { ...tgCfg(), events: Object.fromEntries(Object.keys(TG_EVENTS).map((k) => [k, !!(b.events || {})[k]])) }; saveConfig(); break;
        case '/api/telegram/remove': delete config.telegram; saveConfig(); break;
        default: return json(res, 404, { error: 'Neznáma akcia' });
      }
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: 'Telegram: ' + e.message }); }
  }
  if (url.pathname === '/api/usage') return json(res, 200, store.usageSummary(30));
  if (url.pathname === '/api/tunnel/restart' && req.method === 'POST') {
    if (media.mediaInfo().tunnel === 'vlastná adresa') return json(res, 400, { error: 'Používaš vlastnú adresu – skontroluj ju v Cloudflare.' });
    media.restartTunnel(); return json(res, 200, { ok: true });
  }
  // znova naplánovať príspevok, ktorý zlyhal (voliteľne s novým časom)
  if (url.pathname === '/api/calendar/retry' && req.method === 'POST') {
    const b = await readBody(req);
    const c = content.getCalendar(String(b.id || ''));
    if (!c || !c.task) return json(res, 400, { error: 'Tento príspevok sa nedá zopakovať – naplánuj ho znova cez Nový príspevok.' });
    const dev = devices.get(c.udid);
    if (!dev) return json(res, 400, { error: `Telefón ${c.phone || ''} nie je pripojený.` });
    if (!dev.wdaOk) return json(res, 400, { error: 'Telefón ešte nie je pripravený (WDA).' });
    if ((dev.agent && dev.agent.running) || (dev.plan && dev.plan.running)) return json(res, 400, { error: 'Na telefóne práve beží iná úloha.' });
    let task = c.task, when = c.when, whenText = c.whenText;
    if (b.when && b.whenText) {
      if (new Date(b.when) < Date.now() + 19 * 60000) return json(res, 400, { error: 'Čas musí byť aspoň 20 minút dopredu.' });
      if (c.whenText) task = task.split(c.whenText).join(String(b.whenText));
      when = String(b.when); whenText = String(b.whenText).slice(0, 80);
    } else if (new Date(c.when) < Date.now() + 19 * 60000) return json(res, 400, { error: 'Pôvodný čas už prešiel – vyber nový.', needTime: true });
    const files = (c.files || []).filter((f) => planFile(f.id));
    if (files.length !== (c.files || []).length) return json(res, 400, { error: 'Niektoré médium už nie je v knižnici – naplánuj príspevok znova.' });
    content.removeCalendar(c.id);
    runPlan(dev, [{ title: c.title || 'Príspevok', task, maxSteps: c.maxSteps || 120, files,
      meta: { kind: c.kind, when, whenText, caption: c.caption, music: c.music, place: c.place } }]);
    return json(res, 200, { ok: true });
  }
  // ---------- záloha ----------
  if (url.pathname === '/api/backup' && req.method === 'GET') {
    const withMedia = url.searchParams.get('media') === '1';
    const out = path.join(require('os').tmpdir(), `jd-zaloha-${Date.now()}.zip`);
    const names = ['data'].concat(['labels.json', 'templates.json'].filter((f) => fs.existsSync(path.join(__dirname, f))));
    const skip = ['data/backup-*', 'data/plan-files', 'data/tmp-captions', 'data/magnific', 'data/inspiration'].concat(withMedia ? [] : ['data/library', 'data/proofs']);
    const args = IS_WIN ? ['-a', '-c', '-f', out, ...skip.map((x) => `--exclude=${x}`), ...names]
      : ['-r', '-q', out, ...names, '-x', ...skip.map((x) => `${x}/*`), ...skip.map((x) => x)];
    execFile(IS_WIN ? 'tar' : 'zip', args, { cwd: __dirname, timeout: 600000, maxBuffer: 1 << 24 }, (err) => {
      if (err || !fs.existsSync(out)) return json(res, 500, { error: 'Zálohu sa nepodarilo vytvoriť: ' + (err ? err.message : '?') });
      const d = new Date(), stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(out).size, 'Content-Disposition': `attachment; filename="JD-PhoneStudio-zaloha-${stamp}${withMedia ? '-s-mediami' : ''}.zip"` });
      const rs = fs.createReadStream(out); rs.pipe(res); rs.on('close', () => fs.unlink(out, () => {}));
    });
    return;
  }
  if (url.pathname === '/api/restore' && req.method === 'POST') {
    if (remote) { req.resume(); return json(res, 403, { error: 'Obnovu zo zálohy rob priamo na počítači.' }); }
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'jd-restore-'));
    const zip = path.join(tmp, 'z.zip');
    const ws = fs.createWriteStream(zip); req.pipe(ws);
    ws.on('finish', () => {
      execFile(IS_WIN ? 'tar' : 'unzip', IS_WIN ? ['-xf', zip, '-C', tmp] : ['-q', '-o', zip, '-d', tmp], { timeout: 600000 }, (err) => {
        const done = (code, obj) => { fs.rm(tmp, { recursive: true, force: true }, () => {}); json(res, code, obj); };
        if (err) return done(400, { error: 'Súbor nie je platná záloha (zip).' });
        const src = path.join(tmp, 'data');
        if (!fs.existsSync(src)) return done(400, { error: 'V zálohe chýba priečinok data – je to záloha z JD Phone Studio?' });
        let n = 0;
        // iba známe súbory: JSON dáta, médiá knižnice, názvy telefónov a šablóny
        for (const f of fs.readdirSync(src)) if (/^[\w-]+\.json$/.test(f)) { fs.copyFileSync(path.join(src, f), path.join(store.DATA, f)); n++; }
        const lsrc = path.join(src, 'library');
        if (fs.existsSync(lsrc)) for (const f of fs.readdirSync(lsrc)) if (/^[a-f0-9]{16}\.[a-z0-9]{2,5}$/.test(f)) { fs.copyFileSync(path.join(lsrc, f), path.join(content.LIB_DIR, f)); n++; }
        for (const f of ['labels.json', 'templates.json']) if (fs.existsSync(path.join(tmp, f))) { fs.copyFileSync(path.join(tmp, f), path.join(__dirname, f)); n++; }
        done(200, { ok: true, files: n });
        store.addActivity('phone', `Obnovené zo zálohy (${n} súborov) – reštartujem stránku`);
        setTimeout(() => { devices.forEach(stopDevice); process.exit(75); }, 1500);
      });
    });
    return;
  }
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
  if (url.pathname === '/api/changelog' && req.method === 'GET') return json(res, 200, await updater.changelog());
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
    if (b.apiKey !== undefined) {
      const k = String(b.apiKey || '').trim();
      // Claude kľúč vždy začína sk-ant- (ochrana pred vložením kľúča z inej služby, napr. KIE)
      if (k && !/^sk-ant-/.test(k)) return json(res, 400, { error: 'Toto nie je Claude API kľúč – ten začína „sk-ant-“ (console.anthropic.com → API Keys). Kľúč z KIE patrí do poľa „KIE API kľúč“.' });
      config.apiKey = k;
    }
    if (b.mediaPublicUrl !== undefined) {
      const u = String(b.mediaPublicUrl || '').trim().replace(/\/+$/, '');
      if (u && !/^https:\/\/[\w.-]+(:\d+)?$/.test(u)) return json(res, 400, { error: 'Adresa musí byť v tvare https://media.tvojadomena.com' });
      if (u) config.mediaPublicUrl = u; else delete config.mediaPublicUrl;
    }
    if (b.aiProvider !== undefined && ['auto', 'anthropic', 'kie'].includes(b.aiProvider)) config.aiProvider = b.aiProvider;
    if (b.kieModel !== undefined) config.kieModel = String(b.kieModel || '').trim().slice(0, 60) || 'claude-sonnet-5';
    if (b.kieKey !== undefined) {
      const k = String(b.kieKey || '').trim();
      if (/^sk-ant-/.test(k)) return json(res, 400, { error: 'Toto je Claude kľúč – patrí do poľa „Claude API kľúč“.' });
      config.kieKey = k;
    }
    if (b.magnificKey !== undefined) config.magnificKey = String(b.magnificKey || '').trim();
    if (b.mediaUsb !== undefined) { config.mediaUsb = !!b.mediaUsb; for (const d of devices.values()) { d.usbSkipUntil = 0; d.usbInfo = ''; } }
    if (b.cleanupDays !== undefined) config.cleanupDays = [0, 14, 30, 60, 90].includes(+b.cleanupDays) ? +b.cleanupDays : 0;
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
          if (!aiAuth()) return json(res, 400, { error: 'Chýba kľúč pre AI – nastav Claude alebo KIE kľúč v Nastaveniach' });
          if (!dev.wdaOk) return json(res, 400, { error: 'Telefón ešte nie je pripravený (WDA)' });
          const task = String(b.task || '').trim();
          if (!task) return json(res, 400, { error: 'Prázdna úloha' });
          await runAgentTask(dev, task, b.maxSteps);
          break;
        }
        case 'agent-stop': if (dev.agent) dev.agent.stop = true; if (dev.plan) dev.plan.stop = true; break;
        case 'plan': {
          if (!aiAuth()) return json(res, 400, { error: 'Chýba kľúč pre AI – nastav Claude alebo KIE kľúč v Nastaveniach' });
          if (!dev.wdaOk) return json(res, 400, { error: 'Telefón ešte nie je pripravený (WDA)' });
          if ((dev.agent && dev.agent.running) || (dev.plan && dev.plan.running)) return json(res, 400, { error: 'Na telefóne už beží úloha' });
          const steps = (Array.isArray(b.steps) ? b.steps : []).slice(0, 10).map((x) => ({
            title: String(x.title || '').slice(0, 60), task: String(x.task || '').trim(), maxSteps: x.maxSteps,
            meta: x.meta && typeof x.meta === 'object' ? { kind: String(x.meta.kind || '').slice(0, 20), when: String(x.meta.when || '').slice(0, 40), whenText: String(x.meta.whenText || '').slice(0, 80),
              caption: String(x.meta.caption || '').slice(0, 2200), music: String(x.meta.music || '').slice(0, 120), place: String(x.meta.place || '').slice(0, 60) } : null,
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
  log(`JD Phone Studio beží na http://localhost:${PORT}  (WebDriverAgent: ${WDA_MODE})`);
  media.startMediaServer(config);
  if (remoteOn()) startWebTunnel();
  magnific.init(() => process.env.MAGNIFIC_API_KEY || config.magnificKey || '');
  refresh();
  setInterval(refresh, 5000);
  // automatické upratovanie (Nastavenia → Upratovanie): raz za 6 hodín
  const tidy = () => {
    if (config.cleanupDays) { const r = content.cleanupLibrary(config.cleanupDays, false); if (r.count) store.addActivity('media', `Automaticky upratané: ${r.count} súborov (${(r.bytes / 1e9).toFixed(2)} GB)`); }
    // zálohy starých verzií po aktualizácii – nechaj posledné 3
    try { const bk = fs.readdirSync(store.DATA).filter((f) => f.startsWith('backup-')).sort(); for (const f of bk.slice(0, -3)) fs.rm(path.join(store.DATA, f), { recursive: true, force: true }, () => {}); } catch (_) {}
    try { for (const f of fs.readdirSync(CAP_TMP)) fs.unlink(path.join(CAP_TMP, f), () => {}); } catch (_) {}
    // snímky „dôkaz“ staršie ako 90 dní
    try { for (const f of fs.readdirSync(PROOF_DIR)) { const fp = path.join(PROOF_DIR, f); if (Date.now() - fs.statSync(fp).mtimeMs > 90 * DAY) fs.unlink(fp, () => {}); } } catch (_) {}
  };
  setTimeout(tidy, 60000); setInterval(tidy, 6 * 3600000);
});

process.on('SIGINT', () => { devices.forEach(stopDevice); process.exit(0); });
process.on('SIGTERM', () => { devices.forEach(stopDevice); process.exit(0); });
