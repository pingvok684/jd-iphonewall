// Fotky a videá do galérie iPhonu.
// Ako to funguje: súbor sa nahrá na Mac → server cez WebDriverAgent otvorí v iPhone skratku
// „JD Save“ (aplikácia Skratky) s odkazom na súbor → skratka si ho stiahne a uloží do Fotiek.
// Odkaz ide cez internet (Cloudflare tunel), takže iPhone môže byť na mobilných dátach / hotspote.
// Cez kábel (USB): súbor sa najprv nahrá priamo do priečinka WebDriverAgenta v iPhone (go-ios, bez internetu)
// a skratka si ho vezme odtiaľ (Súbory → Na mojom iPhone). Ak to nejde, automaticky sa použije internet.
// Cez tunel je dostupné IBA sťahovanie súborov s jednorazovým tajným kľúčom – nič iné zo stránky.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const SHORTCUT_NAME = process.env.SHORTCUT_NAME || 'JD Save';
const MEDIA_DIR = path.join(__dirname, 'media');
const MAX_SIZE = 4 * 1024 * 1024 * 1024; // 4 GB
const tokens = new Map(); // token -> item
const MEDIA_PORT = parseInt(process.env.MEDIA_PORT || '3001', 10);

// ---------- verejná adresa pre iPhony na dátach ----------
// 1) vlastná stála adresa (napr. Tailscale Funnel): MEDIA_PUBLIC_URL=https://... alebo config.json → mediaPublicUrl
// 2) inak automaticky Cloudflare quick tunel (potrebuje program cloudflared)
let publicUrl = null;
let tunnelState = 'vypnutý';

function startMediaServer(config) {
  // samostatný mini-server len na súbory → tunel nevidí ovládanie telefónov
  http.createServer((req, res) => {
    const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && parts[0] === 'media' && parts[1] === 'ping') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (req.method === 'GET' && parts[0] === 'media') return serveMedia(req, res, parts);
    res.writeHead(404); res.end();
  }).listen(MEDIA_PORT, '127.0.0.1');

  const fixed = process.env.MEDIA_PUBLIC_URL || (config && config.mediaPublicUrl);
  if (fixed) { publicUrl = fixed.replace(/\/+$/, ''); tunnelState = 'vlastná adresa'; verified = true; return; }
  startTunnel();
  setInterval(healthCheck, 60000);
}

// ---------- kontrola, či je tunel naozaj dostupný z internetu ----------
// quick tunel občas „zamrzne“ (adresa prestane existovať) – vtedy ho spustíme znova s novou adresou
let tunnelProc = null, verified = false, fails = 0;
async function ping(url) {
  try { const r = await fetch(`${url}/media/ping?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) }); return r.ok; } catch (_) { return false; }
}
async function verifyNew(url) {
  verified = false; fails = 0;
  for (let i = 0; i < 20 && publicUrl === url; i++) { // nová adresa sa v DNS objaví až o pár sekúnd
    if (await ping(url)) { verified = true; tunnelState = 'beží'; console.log('Tunel overený:', url); return; }
    await sleep(3000);
  }
  if (publicUrl === url) { tunnelState = 'nedostupný – reštartujem'; restartTunnel(); }
}
async function healthCheck() {
  if (!publicUrl || !tunnelProc || !verified) return;
  if (await ping(publicUrl)) { fails = 0; return; }
  if (++fails >= 2) { console.log('Tunel neodpovedá – reštartujem'); restartTunnel(); }
}
function restartTunnel() { verified = false; publicUrl = null; try { tunnelProc && tunnelProc.kill(); } catch (_) {} }

function startTunnel() {
  tunnelState = 'spúšťam…';
  const local = path.join(__dirname, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const bin = process.env.CLOUDFLARED || (fs.existsSync(local) ? local : 'cloudflared');
  const p = tunnelProc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${MEDIA_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== publicUrl) { publicUrl = m[0]; tunnelState = 'overujem…'; console.log('Tunel pre fotky/videá:', publicUrl); verifyNew(m[0]); }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('error', (e) => { tunnelState = e.code === 'ENOENT' ? 'chýba program cloudflared' : e.message; publicUrl = null; });
  p.on('exit', () => {
    publicUrl = null;
    if (tunnelState === 'chýba program cloudflared') return;
    tunnelState = 'reštartujem…'; setTimeout(startTunnel, 5000);
  });
}

function baseUrl(port) {
  if (publicUrl && verified) return publicUrl;
  const ip = lanIp();
  return ip ? `http://${ip}:${port}` : null; // záloha: rovnaká Wi-Fi
}
function mediaInfo() { return { via: publicUrl && verified ? 'internet' : 'wifi', tunnel: tunnelState, url: publicUrl }; }

const TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.heif': 'image/heif',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
};

function lanIp() {
  const all = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  const pref = all.find((i) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(i.address));
  return (pref || all[0] || {}).address || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeName = (n) => String(n || 'subor').replace(/[^\w.\- ]+/g, '_').slice(-80) || 'subor';

// Uloží nahrávaný súbor (raw body) a zaradí ho do fronty telefónu
function handleUpload(dev, req, res, url, ctx) {
  const name = safeName(url.searchParams.get('name'));
  const ext = path.extname(name).toLowerCase();
  if (!TYPES[ext]) return ctx.json(res, 400, { error: `Nepodporovaný typ súboru (${ext || '?'}). Fotky: jpg, png, heic. Videá: mp4, mov.` });
  const size = parseInt(req.headers['content-length'] || '0', 10);
  if (size > MAX_SIZE) return ctx.json(res, 413, { error: 'Súbor je príliš veľký (max 4 GB)' });

  const dir = path.join(MEDIA_DIR, dev.udid.replace(/[^\w-]/g, ''));
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomBytes(8).toString('hex');
  const file = path.join(dir, `${id}${ext}`);
  const out = fs.createWriteStream(file);
  req.pipe(out);
  out.on('error', (e) => ctx.json(res, 500, { error: e.message }));
  out.on('finish', () => {
    const item = addItem(dev, file, name, ctx);
    ctx.json(res, 200, { ok: true, id: item.id });
  });
}

// zaradí súbor (už uložený na disku) do fronty telefónu
function addItem(dev, file, name, ctx) {
  const item = { id: path.basename(file, path.extname(file)), name, file, ext: path.extname(file).toLowerCase(),
    size: fs.statSync(file).size, status: 'čaká', token: crypto.randomBytes(16).toString('hex') };
  dev.media = dev.media || [];
  dev.media.push(item);
  if (dev.media.length > 50) dev.media.splice(0, dev.media.length - 50);
  if (ctx.onMedia) ctx.onMedia(dev, item);
  runQueue(dev, ctx);
  return item;
}

// skopíruje súbor (napr. z naplánovaného príspevku) a pošle ho do telefónu
function enqueueCopy(dev, src, name, ctx) {
  const ext = path.extname(name).toLowerCase();
  if (!TYPES[ext]) throw new Error(`Nepodporovaný typ súboru ${ext}`);
  const dir = path.join(MEDIA_DIR, dev.udid.replace(/[^\w-]/g, ''));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}${ext}`);
  fs.copyFileSync(src, file);
  return addItem(dev, file, safeName(name), ctx);
}

const done = (ctx, dev, item, ok) => { if (ctx.onMediaDone) ctx.onMediaDone(dev, item, ok); };

// Pošle súbory z fronty do iPhonu jeden po druhom
async function runQueue(dev, ctx) {
  if (dev.mediaBusy) return;
  dev.mediaBusy = true;
  try {
    let item;
    while ((item = (dev.media || []).find((m) => m.status === 'čaká'))) {
      if (dev.gone) break;
      if (!dev.wdaOk) { item.status = 'čaká'; await sleep(3000); continue; }

      // 1) najprv cez kábel – rýchlejšie a bez internetu
      if (await sendUsb(dev, item, ctx)) {
        item.status = '✓ uložené cez kábel – skontroluj Fotky'; item.via = 'kábel';
        done(ctx, dev, item, true); fs.unlink(item.file, () => {});
        continue;
      }

      // 2) cez internet / Wi-Fi
      if (publicUrl && !verified) { item.status = 'čakám na tunel…'; for (let i = 0; i < 30 && publicUrl && !verified; i++) await sleep(1000); }
      const base = baseUrl(ctx.port);
      if (!base) { item.status = 'chyba: kábel nevyšiel, tunel nebeží a počítač nie je na sieti'; done(ctx, dev, item, false); continue; }
      tokens.set(item.token, item);
      const fileUrl = `${base}/media/${item.token}/${encodeURIComponent(item.name)}`;
      const open = `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}&input=text&text=${encodeURIComponent(fileUrl)}`;
      const via = publicUrl ? 'internet' : 'Wi-Fi';
      item.status = `otváram skratku ${SHORTCUT_NAME}…`;
      console.log(`[médiá] ${dev.label}: ${item.name} → otváram skratku (cez ${via}: ${base})`);
      item.downloaded = false;
      try {
        await ctx.openUrl(dev, open);
        item.status = `skratka spustená – čakám, kým si iPhone stiahne súbor (cez ${via})…`;
        console.log(`[médiá] ${dev.label}: skratka otvorená, čakám na stiahnutie`);
      } catch (e) {
        item.status = `chyba: ${e.message}`; tokens.delete(item.token); done(ctx, dev, item, false); continue;
      }
      // čakáme, kým si iPhone súbor stiahne (max ~3 min + podľa veľkosti)
      const limit = Date.now() + 180000 + item.size / 1e5;
      while (!item.downloaded && Date.now() < limit && !dev.gone) await sleep(500);
      if (!item.downloaded) {
        item.status = `chyba: iPhone si súbor nestiahol – je skratka „${SHORTCUT_NAME}“ nastavená a povolil si jej pripojenie (Allow)?`;
        tokens.delete(item.token);
        done(ctx, dev, item, false);
        continue;
      }
      item.status = 'ukladám do galérie…';
      await sleep(3000 + Math.min(20000, item.size / 5e6 * 1000)); // čas na uloženie do Fotiek
      item.status = '✓ iPhone stiahol – skontroluj Fotky';
      done(ctx, dev, item, true);
      tokens.delete(item.token);
      fs.unlink(item.file, () => {});
    }
    if (!dev.gone && dev.wdaOk) { try { await ctx.home(dev); } catch (_) {} }
  } finally {
    dev.mediaBusy = false;
  }
}

// ---------- cez kábel ----------
// Súbor sa nahrá do Documents WebDriverAgenta (go-ios fsync --app). Skratka dostane ako vstup len meno súboru,
// vezme ho zo Súborov (Na mojom iPhone → WebDriverAgentRunner), uloží do Fotiek a zmaže → podľa zmazania vieme, že je hotovo.
async function sendUsb(dev, item, ctx) {
  if (!ctx.usb || !ctx.usb.enabled()) return false;
  if (dev.usbSkipUntil && Date.now() < dev.usbSkipUntil) return false;
  const name = `JD-${item.id}${item.ext}`;
  item.status = 'posielam cez kábel…';
  const up = await ctx.usb.push(dev, item.file, name, item.size);
  if (!up.ok) {
    console.log(`[médiá] ${dev.label}: kábel nevyšiel (${up.err}) → internet`);
    dev.usbInfo = `nedá sa nahrať: ${up.err}`;
    dev.usbSkipUntil = Date.now() + 10 * 60000; item.status = 'čaká';
    return false;
  }
  console.log(`[médiá] ${dev.label}: ${item.name} nahraté cez kábel → otváram skratku`);
  try {
    // bez vstupu → skratka ide do vetvy „Inak/Otherwise“ (vezme súbory JD-… z priečinka)
    await ctx.openUrl(dev, `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}`);
  } catch (e) { await ctx.usb.remove(dev, up); item.status = 'čaká'; return false; }
  item.status = 'skratka ukladá súbor z kábla do Fotiek…';
  const limit = Date.now() + 60000 + item.size / 2e4;
  await sleep(4000);
  while (Date.now() < limit && !dev.gone) {
    const ex = await ctx.usb.exists(dev, up);
    if (ex === false) { dev.usbInfo = 'funguje ✓'; dev.usbSkipUntil = 0; await sleep(2000); return true; }
    await sleep(2500);
  }
  // skratka si súbor nevzala (stará verzia skratky / chýba prístup k priečinku) → upraceme a skúsime internet
  await ctx.usb.remove(dev, up);
  dev.usbInfo = `skratka „${SHORTCUT_NAME}“ si súbor z kábla nevzala – uprav ju podľa návodu (Nastavenia → Fotky a videá)`;
  dev.usbSkipUntil = Date.now() + 30 * 60000;
  console.log(`[médiá] ${dev.label}: ${dev.usbInfo} → internet`);
  item.status = 'čaká';
  return false;
}

// GET /media/<token>/<meno> – sem si iPhone (skratka) chodí po súbor
function serveMedia(req, res, parts) {
  const item = tokens.get(parts[1]);
  console.log(`[médiá] iPhone si pýta súbor ${item ? item.name : '(neplatný alebo starý odkaz)'}`);
  if (!item || !fs.existsSync(item.file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'Content-Type': TYPES[item.ext] || 'application/octet-stream',
    'Content-Length': item.size,
    'Content-Disposition': `attachment; filename="${item.name}"`,
  });
  const s = fs.createReadStream(item.file);
  s.pipe(res);
  res.on('finish', () => { item.downloaded = true; });
}

function mediaState(dev) {
  return (dev.media || []).slice(-8).map((m) => ({ id: m.id, name: m.name, size: m.size, status: m.status }));
}

// dočasne zverejní súbor cez tunel (napr. obrázok pre Magnific, ktorý potrebuje verejnú adresu)
function publishTemp(file, name, minutes = 60) {
  if (!publicUrl || !verified) return null;
  const token = crypto.randomBytes(16).toString('hex');
  const ext = path.extname(name).toLowerCase();
  tokens.set(token, { name: safeName(name), file, ext, size: fs.statSync(file).size, temp: true });
  setTimeout(() => tokens.delete(token), minutes * 60000);
  return `${publicUrl}/media/${token}/${encodeURIComponent(safeName(name))}`;
}

module.exports = { publishTemp, TYPES, safeName, enqueueCopy, handleUpload, serveMedia, mediaState, lanIp, SHORTCUT_NAME, startMediaServer, mediaInfo, restartTunnel };
