// Prístup z mobilu cez Cloudflare Tunnel.
// Požiadavky z tunela prichádzajú z tohto počítača (127.0.0.1), preto ich spoznáme podľa hlavičiek Cloudflare.
// Takéto požiadavky pustíme len ak: 1) prešli cez Cloudflare Access (prihlásenie e-mailom) a 2) majú platné prihlásenie PIN-om.

const crypto = require('crypto');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const COOKIE = 'jdw_s';
const DAYS = 30;

let cfg = null, saveCfg = () => {};
function init(config, save) {
  cfg = config; saveCfg = save;
  if (!cfg.authSecret) { cfg.authSecret = crypto.randomBytes(32).toString('hex'); saveCfg(); }
}

// prišla požiadavka zvonku (cez Cloudflare / inú sieť)?
function isRemote(req) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return true;
  const h = req.headers;
  return !!(h['cf-connecting-ip'] || h['cf-ray'] || h['cf-access-jwt-assertion'] || h['x-forwarded-for'] || h['cf-visitor']);
}
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?');

// ---------- PIN ----------
const hasPin = () => !!(cfg && cfg.pinHash);
function setPin(pin) {
  pin = String(pin || '').trim();
  if (!/^\d{6,12}$/.test(pin)) throw new Error('PIN musí mať 6 až 12 číslic');
  const salt = crypto.randomBytes(16).toString('hex');
  cfg.pinHash = `${salt}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
  cfg.authSecret = crypto.randomBytes(32).toString('hex'); // nový PIN odhlási všetky zariadenia
  saveCfg();
}
function removePin() { delete cfg.pinHash; cfg.authSecret = crypto.randomBytes(32).toString('hex'); saveCfg(); }
function checkPin(pin) {
  if (!hasPin()) return false;
  const [salt, hash] = cfg.pinHash.split(':');
  const got = crypto.scryptSync(String(pin || '').trim(), salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

// ---------- obmedzenie pokusov ----------
const fails = new Map(); // ip -> [časy]
let globalFails = [];
function tooMany(ip) {
  const now = Date.now();
  const list = (fails.get(ip) || []).filter((t) => now - t < 15 * 60000);
  fails.set(ip, list);
  globalFails = globalFails.filter((t) => now - t < 60 * 60000);
  return list.length >= 5 || globalFails.length >= 20;
}
function noteFail(ip) { (fails.get(ip) || fails.set(ip, []).get(ip)).push(Date.now()); globalFails.push(Date.now()); }

// ---------- relácia (cookie) ----------
const sign = (v) => crypto.createHmac('sha256', cfg.authSecret).update(v).digest('hex');
function makeCookie() {
  const exp = Date.now() + DAYS * 86400000;
  const v = `${exp}.${crypto.randomBytes(8).toString('hex')}`;
  return `${COOKIE}=${v}.${sign(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`;
}
function validSession(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return false;
  const parts = m[1].split('.');
  if (parts.length !== 3) return false;
  const v = `${parts[0]}.${parts[1]}`;
  const want = sign(v);
  if (want.length !== parts[2].length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parts[2]))) return false;
  return Number(parts[0]) > Date.now();
}

// ---------- prihlasovacia stránka ----------
function page(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
  res.end(`<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>JD - IphoneWall</title><link rel="apple-touch-icon" href="/ikona.png"><meta name="theme-color" content="#0c0d11">
<style>
:root{--bg:#0c0d11;--panel:#14161c;--line:#2e323c;--text:#eceef3;--muted:#8d92a0;--accent:#ff3d68;--bad:#ff5468}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 0,#3a1422,#0c0d11 60%);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px 16px}
.box{width:min(360px,100%);background:rgba(20,22,28,.85);border:1px solid var(--line);border-radius:22px;padding:26px 22px;display:grid;gap:14px;backdrop-filter:blur(20px)}
.logo{width:54px;height:54px;border-radius:15px;background:url(/ikona.png) center/120% no-repeat;justify-self:center}
h1{margin:0;font-size:20px;text-align:center}p{margin:0;color:var(--muted);text-align:center;font-size:14px}
input{width:100%;font:600 24px/1 ui-monospace,Menlo,monospace;letter-spacing:.3em;text-align:center;padding:14px;border-radius:13px;border:1px solid var(--line);background:#0e0f14;color:var(--text)}
button{font:600 16px -apple-system,sans-serif;padding:14px;border-radius:13px;border:0;color:#fff;background:linear-gradient(180deg,#ff4f76,#e8285a);cursor:pointer}
.err{color:var(--bad)}
</style></head><body><div class="box"><div class="logo"></div>${body}</div></body></html>`);
}
function loginPage(res, msg) {
  page(res, 200, `<h1>JD - IphoneWall</h1><p>Zadaj PIN, ktorý si nastavil na počítači.</p>
<form method="post" action="/login"><input name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus required minlength="6" maxlength="12" pattern="[0-9]*"></form>
${msg ? `<p class="err">${msg}</p>` : ''}<button onclick="document.forms[0].submit()">Prihlásiť</button>`);
}

// Vráti true, ak požiadavku smie spracovať server; inak odpovie sám (prihlásenie / zákaz).
async function gate(req, res, url) {
  if (!isRemote(req)) return true;
  // bez Cloudflare Access nič zvonku nepustíme
  if (!req.headers['cf-access-jwt-assertion']) {
    page(res, 403, '<h1>Prístup je vypnutý</h1><p>Táto stránka sa dá otvoriť zvonku len cez Cloudflare Access (prihlásenie e-mailom). Nastav ho podľa návodu na počítači.</p>');
    return false;
  }
  if (!hasPin()) {
    page(res, 403, '<h1>Najprv nastav PIN</h1><p>Na počítači otvor stránku → Nastavenia → Prístup z mobilu a nastav PIN.</p>');
    return false;
  }
  if (url.pathname === '/ikona.png' || url.pathname === '/manifest.json') return true;
  if (url.pathname === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (tooMany(ip)) { loginPage(res, 'Príliš veľa pokusov. Skús o 15 minút.'); return false; }
    let body = '';
    for await (const c of req) { body += c; if (body.length > 1000) break; }
    const pin = new URLSearchParams(body).get('pin');
    if (!checkPin(pin)) { noteFail(ip); loginPage(res, 'Nesprávny PIN.'); return false; }
    fails.delete(ip);
    res.writeHead(303, { 'Set-Cookie': makeCookie(), Location: '/' });
    res.end();
    return false;
  }
  if (url.pathname === '/logout') {
    res.writeHead(303, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly`, Location: '/' });
    res.end();
    return false;
  }
  if (validSession(req)) return true;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/stream/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"Prihlás sa PIN-om"}'); return false;
  }
  loginPage(res, '');
  return false;
}

module.exports = { init, gate, isRemote, hasPin, setPin, removePin };
