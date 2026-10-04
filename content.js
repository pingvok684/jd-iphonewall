// Obsah: knižnica médií, kalendár príspevkov, štatistiky účtov, archív prieskumov, profily telefónov.
// Všetko sa ukladá do priečinka data/ (aktualizácie stránky ho nikdy neprepíšu).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const LIB_DIR = path.join(store.DATA, 'library');
fs.mkdirSync(LIB_DIR, { recursive: true });
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.heif': 'image/heif', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v' };
const isVideo = (ext) => /^\.(mp4|mov|m4v)$/i.test(ext);
const newId = () => crypto.randomBytes(8).toString('hex');

let lib = store.readJson('library.json', []);
let cal = store.readJson('calendar.json', []);
let stats = store.readJson('stats.json', []);
let research = store.readJson('research.json', []);
let profiles = store.readJson('profiles.json', {});
const saveLib = () => store.writeJson('library.json', lib);
const saveCal = () => store.writeJson('calendar.json', cal);

// ---------- knižnica ----------
// nahranie súboru; rovnaký súbor (podľa obsahu) sa neukladá dvakrát
function addToLibrary(req, name) {
  return new Promise((resolve, reject) => {
    name = String(name || 'subor').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    const ext = path.extname(name).toLowerCase();
    if (!TYPES[ext]) return reject(new Error(`Nepodporovaný typ súboru (${ext || '?'}). Fotky: jpg, png, heic. Videá: mp4, mov.`));
    const id = newId() + ext;
    const tmp = path.join(LIB_DIR, id + '.part');
    const out = fs.createWriteStream(tmp);
    const h = crypto.createHash('sha1');
    let size = 0;
    req.on('data', (c) => { h.update(c); size += c.length; });
    req.pipe(out);
    out.on('error', reject);
    out.on('finish', () => {
      const hash = h.digest('hex');
      const dup = lib.find((x) => x.hash === hash);
      if (dup) { fs.unlink(tmp, () => {}); return resolve(view(dup)); }
      fs.renameSync(tmp, path.join(LIB_DIR, id));
      const it = { id, name, ext, size, hash, kind: isVideo(ext) ? 'video' : 'photo', addedAt: new Date().toISOString(), used: [] };
      lib.unshift(it); saveLib();
      resolve(view(it));
    });
  });
}
const view = (it) => ({ ...it, used: it.used || [] });
const listLibrary = () => lib.map(view);
const libFile = (id) => {
  if (!/^[a-f0-9]{16}\.[a-z0-9]{2,5}$/.test(String(id))) return null;
  const fp = path.join(LIB_DIR, id);
  return fs.existsSync(fp) ? fp : null;
};
function removeFromLibrary(id) {
  const fp = libFile(id); if (fp) fs.unlink(fp, () => {});
  lib = lib.filter((x) => x.id !== id); saveLib();
}
function markUsed(ids, udid, calId) {
  let ch = false;
  for (const it of lib) if (ids.includes(it.id)) { it.used = it.used || []; it.used.push({ udid, at: new Date().toISOString(), calId }); ch = true; }
  if (ch) saveLib();
}
function setLibNote(id, note) { const it = lib.find((x) => x.id === id); if (it) { it.note = String(note || '').slice(0, 200); saveLib(); } }

// ---------- kalendár ----------
function addCalendar(e) {
  const it = { id: newId(), createdAt: new Date().toISOString(), status: 'čaká', ...e };
  cal.push(it); if (cal.length > 3000) cal = cal.slice(-3000); saveCal();
  return it;
}
function setCalendar(id, patch) { const it = cal.find((x) => x.id === id); if (it) { Object.assign(it, patch); saveCal(); } }
function removeCalendar(id) { cal = cal.filter((x) => x.id !== id); saveCal(); }
const listCalendar = (from, to) => cal.filter((x) => (!from || x.when >= from) && (!to || x.when < to));

// ---------- štatistiky ----------
// z výsledku AI „ZHLIADNUTIA: 12 400; DÁTUM: …; TYP: reel“
function parseNum(s) {
  s = String(s || '').replace(/\s/g, '').replace(',', '.');
  const m = s.match(/^([\d.]+)([kKmM]|tis\.?|mil\.?)?/); if (!m) return null;
  let n = parseFloat(m[1].replace(/\.(?=\d{3}(\D|$))/g, ''));
  const u = (m[2] || '').toLowerCase();
  if (u.startsWith('k') || u.startsWith('tis')) n *= 1e3; else if (u.startsWith('m')) n *= 1e6;
  return Math.round(n);
}
function addStatFromText(udid, label, text) {
  const v = String(text).match(/ZHLIADNUTIA\s*[:=]\s*([^;\n]+)/i);
  if (!v) return null;
  const views = parseNum(v[1]);
  if (views == null) return null;
  const d = String(text).match(/DÁTUM\s*[:=]\s*([^;\n]+)/i), t = String(text).match(/TYP\s*[:=]\s*([^;\n]+)/i);
  const s = { id: newId(), udid, label, at: new Date().toISOString(), views, postDate: d ? d[1].trim() : '', type: t ? t[1].trim() : '' };
  stats.push(s); if (stats.length > 5000) stats = stats.slice(-5000); store.writeJson('stats.json', stats);
  return s;
}
const listStats = () => stats;
function removeStat(id) { stats = stats.filter((x) => x.id !== id); store.writeJson('stats.json', stats); }

// ---------- archív prieskumov ----------
function addResearch(r) {
  const it = { id: newId(), at: new Date().toISOString(), ...r };
  research.unshift(it); if (research.length > 1000) research = research.slice(0, 1000); store.writeJson('research.json', research);
  return it;
}
const listResearch = () => research;
function removeResearch(id) { research = research.filter((x) => x.id !== id); store.writeJson('research.json', research); }

// ---------- profily telefónov ----------
const getProfile = (udid) => profiles[udid] || {};
function setProfile(udid, p) {
  const cur = profiles[udid] || {};
  profiles[udid] = {
    handle: String(p.handle ?? cur.handle ?? '').trim().replace(/^@?/, '').slice(0, 40),
    color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : (cur.color || ''),
    note: String(p.note ?? cur.note ?? '').slice(0, 500),
  };
  store.writeJson('profiles.json', profiles);
  return profiles[udid];
}

module.exports = { TYPES, LIB_DIR, addToLibrary, listLibrary, libFile, removeFromLibrary, markUsed, setLibNote,
  addCalendar, setCalendar, removeCalendar, listCalendar, addStatFromText, listStats, removeStat, addResearch, listResearch, removeResearch,
  getProfile, setProfile };
