// Aktualizácie stránky z GitHubu.
// Zdroj je v update.json ({"repo":"meno/jd-iphonewall"}), aktuálna verzia vo version.json.
// Prepíšu sa len súbory stránky – config.json, templates.json, data/, WebDriverAgent/ atď. ostávajú.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = __dirname;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (_) { return d; } };

// čo smie aktualizácia prepísať (nič iné sa nikdy nemení)
const ALLOWED_FILES = new Set(['server.js', 'agent.js', 'media.js', 'store.js', 'magnific.js', 'templates.js', 'updater.js',
  'install.command', 'START_STRANKY.command', 'NAVOD.html', 'README.md', 'version.json', 'update.json',
  'START_STRANKY.bat', 'install-windows.bat', 'install-windows.ps1', 'WebDriverAgent.ipa', 'auth.js', 'content.js', 'changelog.json']);
const ALLOWED_DIRS = ['public/'];
// aby budúce verzie mohli pridať nové súbory: povolené sú aj ďalšie súbory v hlavnom priečinku s týmito príponami
const ALLOWED_EXT = /^[\w.-]+\.(js|command|bat|ps1|html|md|txt|ipa|ico)$/i;
const PROTECTED = new Set(['config.json', 'templates.json', 'labels.json']); // tvoje nastavenia sa nikdy neprepíšu

const local = () => readJson('version.json', { version: '0' });
const source = () => readJson('update.json', {}).repo || '';
const RAW = process.env.UPDATE_RAW || 'https://raw.githubusercontent.com';
const ZIP = process.env.UPDATE_ZIP || 'https://codeload.github.com';

let cache = { at: 0, data: null };

async function check(force) {
  const repo = source();
  if (!repo) return { configured: false, current: local().version };
  if (!force && cache.data && Date.now() - cache.at < 30 * 60 * 1000) return cache.data;
  const r = await fetch(`${RAW}/${repo}/main/version.json?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`GitHub odpovedal ${r.status} – skontroluj, či je repozitár ${repo} verejný`);
  const remote = await r.json();
  const cur = local();
  const data = { configured: true, repo, current: cur.version, latest: remote.version, notes: remote.notes || '', title: remote.title || '', date: remote.date || '',
    available: String(remote.version) > String(cur.version) };
  cache = { at: Date.now(), data };
  return data;
}

const run = (cmd, args, opts = {}) => new Promise((ok, bad) =>
  execFile(cmd, args, { maxBuffer: 1 << 26, ...opts }, (e, out, err) => (e ? bad(new Error((err || e.message).toString().trim())) : ok(out))));

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, rel)); else if (e.isFile()) out.push(rel);
  }
  return out;
}

let busy = false;
async function apply() {
  if (busy) throw new Error('Aktualizácia už beží');
  const repo = source();
  if (!repo) throw new Error('Aktualizácie nie sú nastavené');
  busy = true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-update-'));
  try {
    const r = await fetch(`${ZIP}/${repo}/zip/refs/heads/main`);
    if (!r.ok) throw new Error(`Stiahnutie zlyhalo (${r.status})`);
    const zip = path.join(tmp, 'u.zip');
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    if (process.platform === 'win32') await run('tar', ['-xf', zip, '-C', tmp]); // Windows 10+ má tar, ktorý rozbalí aj zip
    else await run('unzip', ['-q', '-o', zip, '-d', tmp]);
    const top = fs.readdirSync(tmp, { withFileTypes: true }).find((e) => e.isDirectory());
    if (!top) throw new Error('Balík z GitHubu je prázdny');
    const src = path.join(tmp, top.name);
    if (!fs.existsSync(path.join(src, 'server.js')) || !fs.existsSync(path.join(src, 'version.json'))) throw new Error('V repozitári chýba server.js alebo version.json');

    const files = walk(src).filter((f) => !PROTECTED.has(f) && (ALLOWED_FILES.has(f) || ALLOWED_DIRS.some((d) => f.startsWith(d)) || (!f.includes('/') && ALLOWED_EXT.test(f))));
    // najprv záloha, aby sa dalo vrátiť
    const backup = path.join(ROOT, 'data', 'backup-' + local().version.replace(/[^\w.-]/g, '_'));
    for (const f of files) {
      const dst = path.join(ROOT, f);
      if (fs.existsSync(dst)) { fs.mkdirSync(path.dirname(path.join(backup, f)), { recursive: true }); fs.copyFileSync(dst, path.join(backup, f)); }
    }
    for (const f of files) {
      const dst = path.join(ROOT, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(src, f), dst + '.new');
      fs.renameSync(dst + '.new', dst);
      if (f.endsWith('.command') && process.platform !== 'win32') fs.chmodSync(dst, 0o755);
    }
    cache = { at: 0, data: null };
    return { ok: true, version: local().version, files: files.length };
  } finally {
    busy = false;
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

// novinky: zoznam verzií s popisom (najnovšie prvé); berie sa z GitHubu, inak z lokálneho súboru
async function changelog() {
  const loc = readJson('changelog.json', []);
  const repo = source();
  let list = loc;
  if (repo) {
    try {
      const r = await fetch(`${RAW}/${repo}/main/changelog.json?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) list = j; }
    } catch (_) {}
  }
  const cur = local().version;
  return { current: cur, items: list.map((x) => ({ ...x, installed: String(x.version) <= String(cur) })) };
}

module.exports = { check, apply, local, changelog };
