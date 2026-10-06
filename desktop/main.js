// JD Phone Studio – aplikácia pre Mac a Windows.
// Spustí stránku (server.js) na pozadí, zobrazí ju v okne a postará sa o go-ios tunel, cloudflared a reštarty.
// Súbory stránky sa kopírujú do priečinka používateľa, aby fungovali aktualizácie zo stránky (Aktualizácie → Aktualizovať).

const { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain, nativeImage, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile } = require('child_process');

const IS_MAC = process.platform === 'darwin', IS_WIN = process.platform === 'win32';
const PORT = 3000;
const URL = `http://127.0.0.1:${PORT}`;

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const RES = app.isPackaged ? process.resourcesPath : __dirname;
const BUNDLED_APP = app.isPackaged ? path.join(RES, 'app') : path.join(__dirname, 'app-files');
const BUNDLED_BIN = app.isPackaged ? path.join(RES, 'bin') : path.join(__dirname, 'bin', `${IS_MAC ? 'mac' : 'win'}-${process.arch}`);
const USER = app.getPath('userData');
const HOME = path.join(USER, 'app');          // tu beží stránka (dá sa aktualizovať)
const BIN = path.join(HOME, 'bin');
const LOGS = path.join(USER, 'logs');
const STATE_FILE = path.join(USER, 'desktop.json');
const IOS = path.join(BIN, IS_WIN ? 'ios.exe' : 'ios');

let win = null, tray = null, server = null, tunnel = null, quitting = false, restarting = false, external = false, restarts = 0, okTimer = null;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
let state = readJson(STATE_FILE, {});
const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) {} };
const cfg = () => readJson(path.join(HOME, 'config.json'), {});
const log = (...a) => { try { fs.mkdirSync(LOGS, { recursive: true }); fs.appendFileSync(path.join(LOGS, 'app.log'), `${new Date().toISOString()} ${a.join(' ')}\n`); } catch (_) {} };
// stav štartu – zobrazuje ho úvodná obrazovka (splash.html)
const status = { step: 'Spúšťam…', error: '', ready: false };
const step = (t) => { status.step = t; log('krok:', t); };
const fail = (t, e) => { status.error = `${t}: ${(e && e.message) || e}`; log('CHYBA', status.error, (e && e.stack) || ''); };
process.on('uncaughtException', (e) => fail('Neočakávaná chyba', e));
process.on('unhandledRejection', (e) => fail('Neočakávaná chyba', e));
function tail(f, n = 14) { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n).join('\n'); } catch (_) { return ''; } }

// ---------- súbory stránky ----------
// nastavenia, kľúče a dáta (config.json, data/ …) sa nikdy neprepíšu
const PROTECT = new Set(['config.json', 'labels.json', 'templates.json', 'data', 'WebDriverAgent', 'bin', 'logs']);
const ver = (dir) => String(readJson(path.join(dir, 'version.json'), {}).version || '0');
function syncApp() {
  fs.mkdirSync(HOME, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true });
  const fresh = !fs.existsSync(path.join(HOME, 'server.js'));
  // po súboroch – keď jeden zlyhá (zamknutý, antivírus…), ostatné sa aj tak skopírujú
  const walk = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (!rel && PROTECT.has(e.name)) return [];
    return e.isDirectory() ? walk(dir, r) : e.isFile() ? [r] : [];
  });
  const copy = (r) => {
    const src = path.join(BUNDLED_APP, r), dst = path.join(HOME, r);
    for (let i = 0; i < 3; i++) {
      try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); return true; }
      catch (err) { if (i === 2) log('kopírovanie', r, err.message); }
    }
    return false;
  };
  let files = [];
  try { files = walk(BUNDLED_APP); } catch (e) { log('balík stránky', e.message); }
  if (fresh || ver(BUNDLED_APP) > ver(HOME)) {
    log('kopírujem stránku', ver(BUNDLED_APP), '→', HOME);
    let bad = 0; for (const r of files) if (!copy(r)) bad++;
    if (bad) log('nepodarilo sa skopírovať', bad, 'súborov');
  } else {
    // oprava: chýbajúce súbory (napr. zmazané antivírusom alebo nedokončená aktualizácia) doplň z inštalácie
    const miss = files.filter((r) => !fs.existsSync(path.join(HOME, r)));
    if (miss.length) { log('dopĺňam chýbajúce súbory', miss.length, miss.slice(0, 5).join(', ')); miss.forEach(copy); }
  }
  // go-ios a cloudflared (stránka ich hľadá v bin/)
  if (fs.existsSync(BUNDLED_BIN)) {
    fs.mkdirSync(BIN, { recursive: true });
    for (const f of fs.readdirSync(BUNDLED_BIN)) {
      const src = path.join(BUNDLED_BIN, f), dst = path.join(BIN, f);
      try {
        if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
        if (!IS_WIN) fs.chmodSync(dst, 0o755);
      } catch (e) { log('bin', f, e.message); }
    }
  }
  return fresh;
}
// prenos nastavení a dát zo starého priečinka (START_STRANKY verzia)
function importFrom(dir) {
  let n = 0;
  for (const f of ['config.json', 'labels.json', 'templates.json']) {
    try { if (fs.existsSync(path.join(dir, f))) { fs.copyFileSync(path.join(dir, f), path.join(HOME, f)); n++; } } catch (e) { log('prenos', f, e.message); }
  }
  for (const d of ['data', 'WebDriverAgent']) {
    try { if (fs.existsSync(path.join(dir, d))) { fs.cpSync(path.join(dir, d), path.join(HOME, d), { recursive: true, force: true }); n++; } } catch (e) { log('prenos', d, e.message); }
  }
  return n;
}
function findOldFolder() {
  const desk = app.getPath('desktop');
  for (const name of ['iphone-wall', 'JD-IphoneWall', 'JD-PhoneStudio', 'iPhone-Wall']) { const d = path.join(desk, name); if (fs.existsSync(path.join(d, 'config.json')) || fs.existsSync(path.join(d, 'data'))) return d; }
  return null;
}

// ---------- server ----------
function envFor() {
  const sep = IS_WIN ? ';' : ':';
  const extra = IS_MAC ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'] : [];
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', JD_DESKTOP: '1', PORT: String(PORT), PATH: [BIN, ...extra, process.env.PATH || ''].join(sep) };
}
function openLog(name) {
  const f = path.join(LOGS, name);
  try { if (fs.existsSync(f) && fs.statSync(f).size > 5e6) fs.renameSync(f, f + '.old'); } catch (_) {}
  return fs.createWriteStream(f, { flags: 'a' });
}
function startServer() {
  const out = openLog('server.log');
  out.write(`\n===== štart ${new Date().toLocaleString()} (verzia ${ver(HOME)}) =====\n`);
  server = spawn(process.execPath, [path.join(HOME, 'server.js')], { cwd: HOME, env: envFor(), windowsHide: true });
  server.stdout.pipe(out); server.stderr.pipe(out);
  server.on('error', (e) => fail('Server sa nedá spustiť', e));
  clearTimeout(okTimer); okTimer = setTimeout(() => (restarts = 0), 60000);
  const me = server;
  server.on('exit', (code) => {
    if (server === me) server = null;
    if (quitting || restarting) return;
    if (code === 75) { log('aktualizácia → reštart'); syncApp(); setTimeout(startServer, 1000); showWhenReady(); return; }
    restarts++;
    log('server skončil', code, 'pokus', restarts);
    status.error = `Stránka sa zastavila (kód ${code}) – skúšam znova (${restarts}/5)`;
    if (restarts <= 5) return setTimeout(startServer, 2000 * restarts);
    dialog.showMessageBox({ type: 'error', title: 'JD Phone Studio', message: 'Stránka sa nedá spustiť.', detail: `Pozri záznam: ${path.join(LOGS, 'server.log')}`, buttons: ['Otvoriť záznam', 'Zavrieť'] })
      .then((r) => { if (r.response === 0) shell.openPath(path.join(LOGS, 'server.log')); });
  });
}
function stopServer() {
  if (!server) return;
  const s = server;
  if (IS_WIN) execFile('taskkill', ['/pid', String(s.pid), '/T', '/F'], () => {});
  else try { s.kill('SIGTERM'); } catch (_) {}
}
function restartServer() {
  if (external) return dialog.showMessageBox({ message: 'Stránka beží cez START_STRANKY. Zavri jeho okno a otvor aplikáciu znova.' });
  restarts = 0;
  if (server) { restarting = true; server.once('exit', () => { restarting = false; if (!quitting) { syncApp(); startServer(); } }); stopServer(); }
  else startServer();
  showWhenReady();
}
// počas reštartu ukáž úvodnú obrazovku a stránku načítaj, až keď naozaj beží
let waiting = false;
async function showWhenReady() {
  if (win) win.loadFile(path.join(__dirname, 'splash.html'));
  if (waiting) return; waiting = true;
  await new Promise((r) => setTimeout(r, 1500));
  while (!quitting && !(await ping())) await new Promise((r) => setTimeout(r, 800));
  waiting = false; status.error = '';
  if (win && !quitting) openPage();
}

// načítanie stránky so strážcom: keď sa nenačíta do 25 s alebo zlyhá, ukáže úvodnú obrazovku so stavom a skúsi znova
let pageTimer = null;
function openPage() {
  if (!win || quitting) return;
  clearTimeout(pageTimer);
  const wc = win.webContents;
  const ok = () => { clearTimeout(pageTimer); wc.removeListener('did-fail-load', bad); };
  const bad = (_e, code, desc, url, main) => {
    if (main === false || (url && !String(url).startsWith(URL))) return;
    ok(); log('stránka sa nenačítala', code, desc);
    status.error = `Stránka sa nenačítala (${desc || code}) – skúšam znova…`;
    showWhenReady();
  };
  wc.once('did-finish-load', ok);
  wc.on('did-fail-load', bad);
  pageTimer = setTimeout(() => { wc.removeListener('did-fail-load', bad); log('stránka sa nenačítala do 25 s'); status.error = 'Stránka sa nenačítala do 25 sekúnd – skúšam znova…'; showWhenReady(); }, 25000);
  win.loadURL(URL);
}

// go-ios tunel (iOS 17+): Windows vždy, Mac len bez Xcode režimu
function needTunnel() { return IS_WIN || (IS_MAC && !cfg().teamId); }
function startTunnel() {
  if (tunnel || quitting || !needTunnel() || !fs.existsSync(IOS)) return;
  const out = openLog('tunel.log');
  tunnel = spawn(IOS, ['tunnel', 'start', '--userspace'], { cwd: HOME, env: envFor(), windowsHide: true });
  tunnel.stdout.pipe(out); tunnel.stderr.pipe(out);
  tunnel.on('error', (e) => log('tunel', e.message));
  tunnel.on('exit', () => { tunnel = null; if (!quitting) setTimeout(startTunnel, 5000); });
}
function stopTunnel() { if (!tunnel) return; const t = tunnel; tunnel = null; if (IS_WIN) execFile('taskkill', ['/pid', String(t.pid), '/T', '/F'], () => {}); else try { t.kill(); } catch (_) {} }

function ping(timeout = 1500) {
  return new Promise((ok) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/update', timeout }, (res) => { res.resume(); ok(res.statusCode < 500); });
    r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); });
  });
}

// ---------- okno ----------
function showWin() { if (!win) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, backgroundColor: '#0c0d11', title: 'JD Phone Studio', show: false,
    autoHideMenuBar: true, icon: IS_WIN ? undefined : path.join(__dirname, 'tray@2x.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  // stránka spadla alebo zamrzla → úvodná obrazovka a znova načítať
  win.webContents.on('render-process-gone', (_e, d) => { log('okno spadlo', d && d.reason); if (!quitting) showWhenReady(); });
  win.loadFile(path.join(__dirname, 'splash.html'));
  // odkazy von (Cloudflare, Sideloadly, App Store…) do bežného prehliadača
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#0c0d11' } };
    shell.openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(URL) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  win.on('close', async (e) => {
    if (quitting) return;
    if (state.closeAction === 'quit') { quitAll(); return; }
    e.preventDefault();
    if (state.closeAction === 'hide') { win.hide(); return; }
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Nechať bežať na pozadí', 'Úplne vypnúť', 'Zrušiť'], defaultId: 0, cancelId: 2,
      message: 'Zavrieť JD Phone Studio?', detail: 'Na pozadí ďalej beží plánovanie a ovládanie telefónov. Okno znova otvoríš cez ikonu ' + (IS_MAC ? 'v hornej lište alebo v Docku.' : 'pri hodinách (vpravo dole).'),
      checkboxLabel: 'Zapamätať si moju voľbu', checkboxChecked: false,
    });
    if (r.response === 2) return;
    if (r.checkboxChecked) { state.closeAction = r.response === 0 ? 'hide' : 'quit'; saveState(); }
    if (r.response === 0) win.hide(); else quitAll();
  });
  win.on('closed', () => { win = null; });
}

function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  if (IS_MAC) img.setTemplateImage(false);
  tray = new Tray(img.resize({ width: IS_MAC ? 18 : 16, height: IS_MAC ? 18 : 16 }));
  tray.setToolTip('JD Phone Studio');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Otvoriť JD Phone Studio', click: showWin },
    { label: 'Otvoriť v prehliadači', click: () => shell.openExternal(URL) },
    { type: 'separator' },
    { label: 'Sprievodca nastavením', click: () => { showWin(); win.loadFile(path.join(__dirname, 'setup.html')); } },
    { label: 'Reštartovať stránku', click: restartServer },
    { label: 'Preniesť nastavenia zo starého priečinka…', click: askImport },
    { label: 'Otvoriť priečinok s dátami', click: () => shell.openPath(HOME) },
    { label: 'Záznamy (logy)', click: () => shell.openPath(LOGS) },
    { type: 'separator' },
    { label: 'Spustiť po zapnutí počítača', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: 'Pri zatvorení okna sa pýtať', type: 'checkbox', checked: !state.closeAction, click: (i) => { if (i.checked) delete state.closeAction; else state.closeAction = 'hide'; saveState(); } },
    { type: 'separator' },
    { label: 'Ukončiť', click: quitAll },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', () => { if (!IS_MAC) showWin(); });
  tray.on('right-click', () => tray.setContextMenu(menu()));
}
async function askImport() {
  const r = await dialog.showOpenDialog({ title: 'Vyber priečinok starej verzie (napr. iphone-wall na Ploche)', properties: ['openDirectory'], defaultPath: app.getPath('desktop') });
  if (r.canceled || !r.filePaths[0]) return;
  const n = importFrom(r.filePaths[0]);
  await dialog.showMessageBox({ message: n ? 'Nastavenia a dáta sú prenesené.' : 'V priečinku som nenašiel nastavenia (config.json, data).', detail: n ? 'Stránka sa reštartuje.' : '' });
  if (n) restartServer();
}

function appMenu() {
  // Mac potrebuje menu Úpravy – inak nefunguje Cmd+C / Cmd+V v poliach
  const tpl = [
    ...(IS_MAC ? [{ label: app.name, submenu: [{ role: 'about', label: 'O aplikácii' }, { type: 'separator' }, { role: 'hide', label: 'Skryť' }, { role: 'hideOthers', label: 'Skryť ostatné' }, { type: 'separator' }, { label: 'Ukončiť', accelerator: 'Cmd+Q', click: quitAll }] }] : []),
    { label: 'Úpravy', submenu: [{ role: 'undo', label: 'Späť' }, { role: 'redo', label: 'Znova' }, { type: 'separator' }, { role: 'cut', label: 'Vystrihnúť' }, { role: 'copy', label: 'Kopírovať' }, { role: 'paste', label: 'Vložiť' }, { role: 'selectAll', label: 'Vybrať všetko' }] },
    { label: 'Zobraziť', submenu: [{ role: 'reload', label: 'Obnoviť' }, { role: 'resetZoom', label: 'Pôvodná veľkosť' }, { role: 'zoomIn', label: 'Zväčšiť' }, { role: 'zoomOut', label: 'Zmenšiť' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Celá obrazovka' }, { role: 'toggleDevTools', label: 'Vývojárske nástroje' }] },
    { label: 'Okno', submenu: [{ role: 'minimize', label: 'Minimalizovať' }, { label: 'Sprievodca nastavením', click: () => { showWin(); win.loadFile(path.join(__dirname, 'setup.html')); } }, { label: 'Reštartovať stránku', click: restartServer }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function quitAll() {
  quitting = true;
  stopTunnel(); stopServer();
  if (IS_MAC) execFile('pkill', ['-f', 'cloudflared.*127.0.0.1:300'], () => {});
  if (IS_WIN) execFile('taskkill', ['/f', '/im', 'cloudflared.exe'], () => {});
  setTimeout(() => app.exit(0), 800);
}

// ---------- sprievodca nastavením (setup.html) ----------
const run = (bin, args, timeout = 20000) => new Promise((ok) => execFile(bin, args, { timeout, maxBuffer: 8e6, windowsHide: true, env: envFor() }, (e, so, se) => ok({ ok: !e, out: String(so || ''), err: String(se || (e && e.message) || '') })));
async function checkSetup() {
  const res = { platform: process.platform, hasIos: fs.existsSync(IOS), phones: [], listError: '', drivers: null, xcode: IS_MAC && fs.existsSync('/Applications/Xcode.app'), xcodeMode: !!cfg().teamId, serverOk: await ping(), version: ver(HOME) };
  if (IS_WIN) {
    const d = await run('powershell', ['-NoProfile', '-Command', "[bool](Get-AppxPackage -Name '*AppleDevices*') -or [bool](Get-AppxPackage -Name '*iTunes*') -or (Test-Path \"$env:ProgramFiles\\iTunes\\iTunes.exe\") -or [bool](Get-Service | Where-Object { $_.DisplayName -match 'Apple Mobile Device' })"]);
    res.drivers = /true/i.test(d.out);
  }
  if (!res.hasIos) return res;
  const l = await run(IOS, ['list', '--details']);
  if (!l.ok && !l.out) res.listError = l.err.slice(0, 300);
  for (const line of l.out.split('\n')) {
    try { const j = JSON.parse(line); for (const d of j.deviceList || []) res.phones.push(typeof d === 'string' ? { udid: d } : { udid: d.Udid || d.udid, name: d.DeviceName || '', version: d.ProductVersion || '' }); } catch (_) {}
  }
  for (const p of res.phones) {
    const a = await run(IOS, ['apps', `--udid=${p.udid}`], 30000);
    const app = wdaApp(a.out);
    p.wda = !!app || /xctrunner|WebDriverAgentRunner/i.test(a.out);
    p.appsError = a.ok ? '' : a.err.slice(0, 200);
    p.bundle = app ? app.CFBundleIdentifier : ((a.out.match(/[A-Za-z0-9._\-]*(?:xctrunner|WebDriverAgentRunner)[A-Za-z0-9._\-]*/i) || [])[0] || '');
    // starý WebDriverAgent bez zdieľania súborov → priečinok sa v aplikácii Súbory neukáže
    p.fileSharing = app ? app.UIFileSharingEnabled === true : null;
    // režim pre vývojárov (Developer Mode) – existuje až od iOS 16
    if (parseInt(p.version, 10) && parseInt(p.version, 10) < 16) p.devMode = true;
    else {
      const d = await run(IOS, ['devmode', 'get', `--udid=${p.udid}`], 15000);
      const t = d.out + ' ' + d.err;
      p.devMode = /DeveloperModeEnabled"?\s*:\s*true|enabled:\s*true/i.test(t) ? true : /DeveloperModeEnabled"?\s*:\s*false|enabled:\s*false/i.test(t) ? false : null;
    }
    // priečinok pre skratku JD Save (Súbory → Na mojom iPhone) – stačí nainštalovaný WDA, nemusí bežať
    p.folder = !!(p.wda && p.bundle && p.fileSharing !== false && await ensureShortcutFolder(p.udid, p.bundle));
  }
  return res;
}
function wdaApp(out) {
  let list = [];
  for (const chunk of [out, ...out.split('\n')]) { try { const j = JSON.parse(chunk); if (Array.isArray(j)) { list = j; break; } } catch (_) {} }
  return list.find((x) => x && /xctrunner|WebDriverAgentRunner/i.test(String(x.CFBundleIdentifier || '') + ' ' + String(x.CFBundleName || ''))) || null;
}
const folderDone = new Map();
async function ensureShortcutFolder(udid, bundle) {
  const k = udid + '|' + bundle;
  if (folderDone.get(k)) return true;
  const t = path.join(require('os').tmpdir(), '_Nemazat-JD-Phone-Studio.txt');
  try { fs.writeFileSync(t, 'Priečinok pre JD Phone Studio – sem chodia fotky a videá cez kábel. Nemaž ho.\n'); } catch (_) {}
  for (const d of ['Documents/_Nemazat-JD-Phone-Studio.txt', '_Nemazat-JD-Phone-Studio.txt']) {
    const r = await run(IOS, ['fsync', `--app=${bundle}`, `--udid=${udid}`, 'push', `--srcPath=${t}`, `--dstPath=${d}`], 20000);
    if (r.ok) { folderDone.set(k, true); return true; }
  }
  return false;
}
ipcMain.handle('jd:check', () => checkSetup());
// zobrazí prepínač „Režim pre vývojárov“ v Nastaveniach iPhonu (aj keď ešte nie je nainštalovaný WDA)
ipcMain.handle('jd:revealDev', async () => {
  const l = await run(IOS, ['list']); let ids = [];
  try { ids = (JSON.parse(l.out.trim().split('\n').pop()).deviceList || []).map((d) => (typeof d === 'string' ? d : d.Udid || d.udid)); } catch (_) {}
  for (const u of ids) await run(IOS, ['devmode', 'reveal', `--udid=${u}`], 15000);
  return ids.length;
});
ipcMain.handle('jd:open', (_, url) => { if (/^(https?|ms-windows-store|macappstore):/.test(url)) shell.openExternal(url); });
ipcMain.handle('jd:showIpa', () => { const f = path.join(HOME, 'WebDriverAgent.ipa'); if (fs.existsSync(f)) shell.showItemInFolder(f); else shell.openPath(HOME); return f; });
ipcMain.handle('jd:xcodeSetup', () => {
  if (!IS_MAC) return false;
  const src = path.join(app.isPackaged ? RES : __dirname, 'xcode-setup.command'), dst = path.join(HOME, 'xcode-setup.command');
  fs.copyFileSync(src, dst); fs.chmodSync(dst, 0o755);
  execFile('open', ['-a', 'Terminal', dst]);
  return true;
});
ipcMain.handle('jd:done', async () => {
  state.setupDone = true; state.setupBuild = buildId(); saveState();
  if (!win) return;
  if (await ping(2500)) openPage(); else showWhenReady(); // server ešte nebeží → úvodná obrazovka so stavom
});
ipcMain.handle('jd:setup', () => { showWin(); win.loadFile(path.join(__dirname, 'setup.html')); });
ipcMain.handle('jd:restart', () => restartServer());
ipcMain.handle('jd:status', () => ({ ...status, log: tail(path.join(LOGS, 'server.log')), appLog: tail(path.join(LOGS, 'app.log'), 6), logs: LOGS }));
ipcMain.handle('jd:openLogs', () => shell.openPath(LOGS));
ipcMain.handle('jd:info', () => ({ platform: process.platform, version: ver(HOME), home: HOME, external }));

// identita nainštalovanej verzie aplikácie – po každej novej inštalácii z GitHubu sa znova ukáže sprievodca nastavením
function buildId() {
  try { return `${app.getVersion()}-${Math.round(fs.statSync(path.join(process.resourcesPath, 'app.asar')).mtimeMs)}`; } catch (_) { return app.getVersion(); }
}

// ---------- štart ----------
app.on('second-instance', showWin);
app.on('activate', showWin);
app.on('before-quit', () => { if (!quitting) { quitting = true; stopTunnel(); stopServer(); } });
app.whenReady().then(async () => {
  app.setAppUserModelId('sk.jd.phonestudio');
  appMenu();
  createWindow();
  buildTray();
  powerSaveBlocker.start('prevent-app-suspension'); // počítač nezaspí, kým beží aplikácia

  // beží už stránka cez START_STRANKY? → len ju zobraz
  step('Kontrolujem, či stránka už nebeží…');
  if (await ping(1200)) external = true;
  else {
    try { step('Pripravujem súbory…'); var fresh = syncApp(); } catch (e) { fail('Príprava súborov zlyhala', e); }
    try {
      const old = fresh && findOldFolder();
      if (old) {
        const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Áno, preniesť', 'Nie, začať odznova'], defaultId: 0,
          message: 'Našiel som staršiu verziu JD Phone Studio', detail: `${old}\n\nPreniesť nastavenia, kľúče, názvy telefónov, knižnicu a kalendár do aplikácie?` });
        if (r.response === 0) { step('Prenášam staré nastavenia…'); importFrom(old); }
      }
    } catch (e) { fail('Prenos starých nastavení zlyhal', e); }
    try { startTunnel(); } catch (e) { log('tunel', e.message); }
    try { step('Spúšťam stránku…'); startServer(); } catch (e) { fail('Server sa nedá spustiť', e); }
    // keď sa dokončí Xcode nastavenie (pribudne teamId), prepni režim
    let hadTeam = !!cfg().teamId;
    fs.watchFile(path.join(HOME, 'config.json'), { interval: 4000 }, () => {
      const has = !!cfg().teamId;
      if (has !== hadTeam) { hadTeam = has; log('zmena režimu WDA'); if (has) stopTunnel(); else startTunnel(); restartServer(); }
    });
  }
  step('Čakám, kým sa stránka spustí…');
  // čakáme bez limitu – úvodná obrazovka medzitým ukazuje stav a záznam
  while (!(await ping())) await new Promise((r) => setTimeout(r, 800));
  status.ready = true; status.error = ''; step('Hotovo');
  if (!win) return;
  if ((!state.setupDone || (app.isPackaged && state.setupBuild !== buildId())) && !external) win.loadFile(path.join(__dirname, 'setup.html'));
  else openPage();
});
app.on('window-all-closed', () => {}); // aplikácia beží ďalej v lište
