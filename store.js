// Jednoduché úložisko v JSON súboroch: aktivita, inšpirácia.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

function readJson(name, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch (_) { return def; }
}
// Windows: premenovanie zlyhá (EPERM/EBUSY), keď súbor práve číta antivírus alebo iný proces → skúsiť znova, inak prepísať priamo
function replaceFile(tmp, dst) {
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(tmp, dst); return; } catch (e) { if (i === 5) break; const t = Date.now() + 150 * (i + 1); while (Date.now() < t); }
  }
  fs.copyFileSync(tmp, dst); try { fs.unlinkSync(tmp); } catch (_) {}
}
function writeJson(name, val) {
  const f = path.join(DATA, name);
  fs.writeFileSync(f + '.tmp', JSON.stringify(val, null, 2));
  replaceFile(f + '.tmp', f);
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

// ---------- míňanie na AI (odhad podľa cenníka) ----------
// ceny v USD za 1 milión tokenov [vstup, výstup]
const PRICES = [
  [/opus/i, 5, 25], [/haiku/i, 1, 5], [/sonnet|claude/i, 3, 15], [/gemini.*flash/i, 0.5, 3], [/gemini/i, 2, 12],
];
const priceOf = (model) => (PRICES.find(([re]) => re.test(model || '')) || [null, 3, 15]).slice(1);
let usage = readJson('usage.json', []);
let usageTimer = null;
function addUsage({ kind, provider, model, input, output, phone }) {
  input = Math.max(0, Number(input) || 0); output = Math.max(0, Number(output) || 0);
  if (!input && !output) return;
  const [pi, po] = priceOf(model);
  usage.push({ at: new Date().toISOString(), kind: kind || 'iné', provider: provider || '', model: model || '', input, output, phone: phone || '', usd: +(input / 1e6 * pi + output / 1e6 * po).toFixed(5) });
  if (usage.length > 50000) usage = usage.slice(-50000);
  clearTimeout(usageTimer); usageTimer = setTimeout(() => writeJson('usage.json', usage), 1500);
}
function usageSummary(days = 30) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const out = { today: 0, month: 0, total: 0, days: [], byKind: {}, byPhone: {}, byProvider: {} };
  for (let i = days - 1; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); out.days.push({ date: d.toISOString(), key: dayKey(d), usd: 0, calls: 0 }); }
  const byKey = new Map(out.days.map((d) => [d.key, d]));
  for (const u of usage) {
    const t = new Date(u.at);
    out.total += u.usd;
    if (t >= today) out.today += u.usd;
    if (t >= monthStart) {
      out.month += u.usd;
      out.byKind[u.kind] = (out.byKind[u.kind] || 0) + u.usd;
      if (u.phone) out.byPhone[u.phone] = (out.byPhone[u.phone] || 0) + u.usd;
      out.byProvider[u.provider || '?'] = (out.byProvider[u.provider || '?'] || 0) + u.usd;
    }
    const d = byKey.get(dayKey(t)); if (d) { d.usd += u.usd; d.calls++; }
  }
  return out;
}

module.exports = { replaceFile, addUsage, usageSummary, DATA, INSP_DIR, readJson, writeJson, newId, addActivity, listActivity, activityStats, addInspiration, removeInspiration, listInspiration };
