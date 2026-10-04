// Jednoduché úložisko v JSON súboroch: aktivita, inšpirácia.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

function readJson(name, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch (_) { return def; }
}
function writeJson(name, val) {
  const f = path.join(DATA, name);
  fs.writeFileSync(f + '.tmp', JSON.stringify(val, null, 2));
  fs.renameSync(f + '.tmp', f);
}
const newId = () => crypto.randomBytes(6).toString('hex');

// ---------- aktivita ----------
// type: ai | ai_done | media | media_done | phone | error
let activity = readJson('activity.json', []);
let saveTimer = null;
function addActivity(type, text, extra = {}) {
  activity.push({ id: newId(), at: new Date().toISOString(), type, text, ...extra });
  if (activity.length > 2000) activity = activity.slice(-2000);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson('activity.json', activity), 500);
}
function listActivity(limit = 100, type) {
  const l = type ? activity.filter((a) => a.type.startsWith(type)) : activity;
  return l.slice(-limit).reverse();
}

// počty udalostí za posledných N dní (podľa miestneho času Macu)
function dayKey(d) { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`; }
function activityStats(days = 7) {
  const out = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    out.push({ date: d.toISOString(), key: dayKey(d), ai: 0, media: 0, errors: 0, reels: 0 });
  }
  const byKey = new Map(out.map((o) => [o.key, o]));
  for (const a of activity) {
    const o = byKey.get(dayKey(a.at)); if (!o) continue;
    if (a.type === 'ai_done') o.ai++;
    else if (a.type === 'media_done') o.media++;
    else if (a.type === 'error') o.errors++;
    else if (a.type === 'reels') o.reels += a.reels || 0;
  }
  return out;
}

// ---------- inšpirácia ----------
const INSP_DIR = path.join(DATA, 'inspiration');
fs.mkdirSync(INSP_DIR, { recursive: true });
let insp = readJson('inspiration.json', []);
function addInspiration({ link, note, tags, file, ext }) {
  const item = { id: newId(), at: new Date().toISOString(), link: link || '', note: note || '', tags: tags || '' };
  if (file) {
    item.file = `${item.id}${ext || '.jpg'}`;
    fs.renameSync(file, path.join(INSP_DIR, item.file));
  }
  insp.unshift(item);
  writeJson('inspiration.json', insp);
  return item;
}
function removeInspiration(id) {
  const it = insp.find((x) => x.id === id);
  if (it && it.file) fs.unlink(path.join(INSP_DIR, it.file), () => {});
  insp = insp.filter((x) => x.id !== id);
  writeJson('inspiration.json', insp);
}
const listInspiration = () => insp;

module.exports = { DATA, INSP_DIR, readJson, writeJson, newId, addActivity, listActivity, activityStats, addInspiration, removeInspiration, listInspiration };
