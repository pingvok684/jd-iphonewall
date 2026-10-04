// Stena telefónov: živý obraz, dotyky, text, AI úlohy, šablóny, fotky/videá do galérie.
const grid = document.getElementById('grid');
const cards = new Map();
let focused = null;
let lastDevices = null;

const sizeEl = document.getElementById('size');
try { sizeEl.value = localStorage.getItem('wall-size') || 260; } catch (_) {}
const applySize = () => { document.documentElement.style.setProperty('--col', sizeEl.value + 'px'); try { localStorage.setItem('wall-size', sizeEl.value); } catch (_) {} };
sizeEl.oninput = applySize; applySize();

async function post(udid, action, body = {}) {
  try {
    const r = await fetch(`/api/${udid}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) flash(udid, j.error || 'Chyba');
    return j;
  } catch (e) { flash(udid, e.message); }
}

function flash(udid, text) {
  const c = cards.get(udid); if (!c) return;
  c.log.textContent = '⚠ ' + text; c.log.style.display = 'block';
  clearTimeout(c.t); c.t = setTimeout(() => { c.log.style.display = ''; c.t = null; }, 5000);
}

function makeCard(d) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="top"><span class="dot"></span><span class="name" title="Dvojklik = premenovať"></span><span class="ver"></span>
      <button data-a="unlock" title="Zobudiť a odomknúť">${icon('unlock')}</button><button data-a="lock" title="Uspať">${icon('lock')}</button>
      <button data-a="solo" title="Zväčšiť">${icon('expand')}</button></div>
    <div class="screen"><img alt=""><div class="ph">Čakám na WebDriverAgent…</div></div>
    <div class="log"></div>
    <div class="bar">
      <input placeholder="Text… (Enter = poslať)">
      <button data-a="home" title="Domov">${icon('home')}</button>
      <button data-a="reset" title="Obnoviť spojenie">${icon('refresh')}</button>
    </div>
    <div class="tplrow"><button class="tplbtn" data-a="tpick">${icon('list')}<span>Šablóny</span></button><button data-a="tsave" title="Uložiť text ako šablónu">${icon('save')}</button></div>
    <div class="row"><textarea placeholder="Úloha pre AI…"></textarea><button class="go" data-a="run">Spustiť</button></div>
    <div class="alog"></div>
    <label class="drop"><b>Fotky / videá do galérie</b><br>pretiahni sem alebo klikni
      <input type="file" multiple accept="image/*,video/*,.heic,.mov,.mp4"></label>
    <div class="mlist"></div>`;
  const c = { el, d, img: el.querySelector('img'), ph: el.querySelector('.ph'), dot: el.querySelector('.dot'),
    name: el.querySelector('.name'), ver: el.querySelector('.ver'), log: el.querySelector('.log'),
    input: el.querySelector('.bar input'), streaming: false };

  // obraz
  const startStream = () => { c.img.src = `/stream/${d.udid}?t=${Date.now()}`; c.streaming = true; };
  c.img.onload = () => { c.ph.style.display = 'none'; };
  c.img.onerror = () => { c.ph.style.display = 'flex'; c.streaming = false; setTimeout(() => { if (c.d.wdaOk) startStream(); }, 3000); };
  c.startStream = startStream;

  // dotyky: krátky klik = tap, podržanie = long press, ťah = swipe
  let s = null;
  c.img.addEventListener('pointerdown', (e) => {
    e.preventDefault(); setFocus(c);
    const r = c.img.getBoundingClientRect();
    s = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, t: performance.now(), px: e.clientX - r.left, py: e.clientY - r.top };
    c.img.setPointerCapture(e.pointerId);
  });
  c.img.addEventListener('pointerup', (e) => {
    if (!s) return;
    const r = c.img.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const dist = Math.hypot(x - s.x, (y - s.y) * (r.height / r.width));
    const dt = performance.now() - s.t;
    ripple(c, s.px, s.py);
    if (dist < 0.025) post(d.udid, dt > 500 ? 'longpress' : 'tap', { x: s.x, y: s.y });
    else post(d.udid, 'swipe', { x1: s.x, y1: s.y, x2: x, y2: y, ms: Math.min(1500, Math.max(120, dt)) });
    s = null;
  });
  c.img.addEventListener('pointercancel', () => { s = null; });

  // text
  c.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const text = c.input.value + (e.shiftKey ? '\n' : '');
    if (!text) return;
    const targets = document.getElementById('all').checked ? [...cards.keys()] : [d.udid];
    targets.forEach((u) => post(u, 'type', { text }));
    c.input.value = '';
  });
  c.input.addEventListener('focus', () => setFocus(c));

  // AI
  c.task = el.querySelector('.row textarea');
  c.runBtn = el.querySelector('[data-a=run]');
  c.alog = el.querySelector('.alog');
  c.runBtn.onclick = () => {
    if (c.d.agent && c.d.agent.running) return post(d.udid, 'agent-stop');
    const task = c.task.value.trim(); if (!task) return c.task.focus();
    if (c.task.dataset.plan) return runSteps(JSON.parse(c.task.dataset.plan), d.udid);
    post(d.udid, 'agent', { task, maxSteps: c.task.dataset.maxSteps ? +c.task.dataset.maxSteps : undefined }).then(() => setTimeout(poll, 300));
  };
  c.task.addEventListener('input', () => { if (!c.task.value.trim()) { delete c.task.dataset.maxSteps; delete c.task.dataset.plan; } });
  c.task.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) c.runBtn.click(); });

  // fotky a videá
  c.drop = el.querySelector('.drop');
  c.mlist = el.querySelector('.mlist');
  c.uploads = new Map();
  const sendFiles = (files) => [...files].forEach((f) => upload(c, f));
  c.drop.querySelector('input').onchange = (e) => { sendFiles(e.target.files); e.target.value = ''; };
  c.drop.addEventListener('dragover', (e) => { e.preventDefault(); c.drop.classList.add('over'); });
  c.drop.addEventListener('dragleave', () => c.drop.classList.remove('over'));
  c.drop.addEventListener('drop', (e) => { e.preventDefault(); c.drop.classList.remove('over'); sendFiles(e.dataTransfer.files); });

  // šablóny
  el.querySelector('[data-a=tpick]').onclick = () => pickTemplate(c.task, c.d.label);
  el.querySelector('[data-a=tsave]').onclick = () => saveTemplate(c.task.value, c.lastTpl);

  el.querySelector('[data-a=unlock]').onclick = () => post(d.udid, 'unlock').then(() => setTimeout(poll, 300));
  el.querySelector('[data-a=lock]').onclick = () => post(d.udid, 'lock').then(() => setTimeout(poll, 300));
  el.querySelector('[data-a=home]').onclick = () => post(d.udid, 'home');
  el.querySelector('[data-a=reset]').onclick = async () => { await post(d.udid, 'reset'); startStream(); };
  el.querySelector('[data-a=solo]').onclick = () => { setFocus(c); document.body.classList.toggle('solo'); };
  c.name.ondblclick = () => openProfile(c.d);
  c.name.title = 'Dvojklik = upraviť profil (názov, @účet, farba)';
  return c;
}

function upload(c, f) {
  const key = Math.random().toString(36).slice(2);
  c.uploads.set(key, { name: f.name, pct: 0 });
  renderMedia(c);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/${c.d.udid}/upload?name=${encodeURIComponent(f.name)}`);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { c.uploads.get(key).pct = Math.round(e.loaded / e.total * 100); renderMedia(c); } };
  xhr.onload = () => {
    let j = {}; try { j = JSON.parse(xhr.responseText); } catch (_) {}
    if (xhr.status >= 400) { c.uploads.set(key, { name: f.name, err: j.error || 'Chyba nahrávania' }); setTimeout(() => { c.uploads.delete(key); renderMedia(c); }, 15000); }
    else c.uploads.delete(key);
    renderMedia(c); poll();
  };
  xhr.onerror = () => { c.uploads.set(key, { name: f.name, err: 'Spojenie so serverom zlyhalo' }); renderMedia(c); };
  xhr.send(f);
}

function renderMedia(c) {
  const rows = [];
  for (const u of c.uploads.values()) {
    rows.push(u.err
      ? `<div class="mitem err"><span class="mn">${esc(u.name)}</span><span class="ms">${esc(u.err)}</span></div>`
      : `<div class="mitem"><div class="mn">${esc(u.name)}<div class="pb" style="width:${u.pct}%"></div></div><span class="ms">nahrávam ${u.pct}%</span></div>`);
  }
  for (const m of (c.d.media || []).slice().reverse()) {
    const cls = m.status.startsWith('✓') ? 'ok' : m.status.startsWith('chyba') ? 'err' : '';
    rows.push(`<div class="mitem ${cls}"><span class="mn">${esc(m.name)}</span><span class="ms">${esc(m.status)}</span></div>`);
  }
  const html = rows.join('');
  if (c.mlist.innerHTML !== html) c.mlist.innerHTML = html;
}

// ---------- šablóny AI príkazov ----------
let TEMPLATES = [];
function fillTplSelect(sel) {
  const cur = sel.value;
  sel.innerHTML = '<option value="">Šablóny…</option>' +
    TEMPLATES.map((t) => `<option>${esc(t.name)}</option>`).join('') +
    '<option value="__reset">↺ Obnoviť pôvodné šablóny</option>';
  if (TEMPLATES.some((t) => t.name === cur)) sel.value = cur;
}
function refreshTplSelects() { document.querySelectorAll('select.tpl').forEach(fillTplSelect); }
async function loadTemplates(list) {
  TEMPLATES = list || await (await fetch('/api/templates')).json();
  refreshTplSelects();
}
async function tplApi(body) {
  const r = await fetch('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) return alert(j.error || 'Chyba');
  await loadTemplates(j);
  if (view === 'nastavenia') loadSettings();
}
// čas plánovania: najskôr ~20 min dopredu (zaokrúhlené na 5 min nahor)
function minSched() { const d = new Date(Date.now() + 21 * 60000); d.setSeconds(0, 0); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5); return d; }
const pad = (n) => String(n).padStart(2, '0');
const dtLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const SK_DAYS = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'];
const fmtSk = (d) => `${SK_DAYS[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()} o ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// ---------- hodiny: Slovensko + vybraný štát USA ----------
const US_TZ = [
  ['Alabama', 'America/Chicago'], ['Alaska', 'America/Anchorage'], ['Arizona', 'America/Phoenix'], ['Arkansas', 'America/Chicago'],
  ['California', 'America/Los_Angeles'], ['Colorado', 'America/Denver'], ['Connecticut', 'America/New_York'], ['Delaware', 'America/New_York'],
  ['District of Columbia', 'America/New_York'], ['Florida', 'America/New_York'], ['Georgia', 'America/New_York'], ['Hawaii', 'Pacific/Honolulu'],
  ['Idaho', 'America/Boise'], ['Illinois', 'America/Chicago'], ['Indiana', 'America/Indiana/Indianapolis'], ['Iowa', 'America/Chicago'],
  ['Kansas', 'America/Chicago'], ['Kentucky', 'America/New_York'], ['Louisiana', 'America/Chicago'], ['Maine', 'America/New_York'],
  ['Maryland', 'America/New_York'], ['Massachusetts', 'America/New_York'], ['Michigan', 'America/Detroit'], ['Minnesota', 'America/Chicago'],
  ['Mississippi', 'America/Chicago'], ['Missouri', 'America/Chicago'], ['Montana', 'America/Denver'], ['Nebraska', 'America/Chicago'],
  ['Nevada', 'America/Los_Angeles'], ['New Hampshire', 'America/New_York'], ['New Jersey', 'America/New_York'], ['New Mexico', 'America/Denver'],
  ['New York', 'America/New_York'], ['North Carolina', 'America/New_York'], ['North Dakota', 'America/Chicago'], ['Ohio', 'America/New_York'],
  ['Oklahoma', 'America/Chicago'], ['Oregon', 'America/Los_Angeles'], ['Pennsylvania', 'America/New_York'], ['Rhode Island', 'America/New_York'],
  ['South Carolina', 'America/New_York'], ['South Dakota', 'America/Chicago'], ['Tennessee', 'America/Chicago'], ['Texas', 'America/Chicago'],
  ['Utah', 'America/Denver'], ['Vermont', 'America/New_York'], ['Virginia', 'America/New_York'], ['Washington', 'America/Los_Angeles'],
  ['West Virginia', 'America/New_York'], ['Wisconsin', 'America/Chicago'], ['Wyoming', 'America/Denver'],
];
let usState = 'California';
try { usState = localStorage.getItem('us-state') || usState; } catch (_) {}
const tzOf = (st) => (US_TZ.find((x) => x[0] === st) || US_TZ[4])[1];
const fmtTime = (d, tz, sec) => new Intl.DateTimeFormat('sk-SK', { timeZone: tz, hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) }).format(d);
const fmtDay = (d, tz) => new Intl.DateTimeFormat('sk-SK', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric' }).format(d);
function clockBox() {
  return `<div class="clocks">
    <div class="clk"><span class="cl">🇸🇰 Slovensko</span><b data-sk></b></div>
    <div class="clk"><select data-us aria-label="Štát USA">${US_TZ.map(([n]) => `<option${n === usState ? ' selected' : ''}>${n}</option>`).join('')}</select><b data-usb></b></div></div>`;
}
function startClock(root) {
  const sk = root.querySelector('[data-sk]'), us = root.querySelector('[data-usb]'), sel = root.querySelector('[data-us]');
  const tick = () => {
    const now = new Date();
    sk.textContent = fmtTime(now, 'Europe/Bratislava', true);
    us.textContent = fmtTime(now, tzOf(sel.value), true);
    us.title = fmtDay(now, tzOf(sel.value));
    updateConv(root);
  };
  sel.onchange = () => { usState = sel.value; try { localStorage.setItem('us-state', usState); } catch (_) {} tick(); };
  root.addEventListener('change', (e) => { if (e.target.closest('.dtp')) updateConv(root); });
  tick();
  const t = setInterval(tick, 1000);
  return () => clearInterval(t);
}
// pod výberom času ukáže, koľko to bude v zvolenom štáte USA
function updateConv(root) {
  const sel = root.querySelector('[data-us]'); if (!sel) return;
  const tz = tzOf(sel.value);
  root.querySelectorAll('.dtp').forEach((box) => {
    const out = box.parentElement.querySelector('[data-conv]'); if (!out) return;
    const d = dtpValue(box);
    out.textContent = isNaN(d) ? '' : `V štáte ${sel.value} to bude ${fmtDay(d, tz)} o ${fmtTime(d, tz)}.`;
  });
}
const dtpValue = (box) => new Date(`${box.querySelector('[data-d]').value}T${box.querySelector('[data-h]').value}:${box.querySelector('[data-m]').value}`);

// dátum (kalendár) + hodina a minúty v rolovacích menu
function dtPicker(i, defDate) {
  const def = defDate ? new Date(defDate) : new Date(Date.now() + 30 * 60000); def.setMinutes(Math.ceil(def.getMinutes() / 5) * 5, 0, 0);
  const min = minSched();
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hours = [...Array(24)].map((_, h) => `<option${h === def.getHours() ? ' selected' : ''}>${pad(h)}</option>`).join('');
  const mins = [...Array(12)].map((_, k) => `<option${k * 5 === def.getMinutes() ? ' selected' : ''}>${pad(k * 5)}</option>`).join('');
  return `<div class="dtp" data-i="${i}" data-dt><input type="date" data-d min="${ymd(min)}" value="${ymd(def)}">
    <select data-h aria-label="Hodina">${hours}</select><b>:</b><select data-m aria-label="Minúty">${mins}</select></div>`;
}

// ---------- štvorček na médiá: video / fotky sa pred plánovaním pošlú do galérie ako najnovšie ----------
function dropHtml(kind) {
  const v = kind === 'reel';
  return `<div class="pdrop" data-drop="${kind}"><label class="drop"><input type="file" ${v ? 'accept="video/*,.mov,.mp4"' : 'accept="image/*,.heic" multiple'}>
    <div>${icon(v ? 'play' : 'image')}<b>${v ? 'Pretiahni sem video' : 'Pretiahni sem fotky'}</b><small>${v ? 'alebo klikni' : 'v poradí, v akom majú byť v carouseli – alebo klikni'}</small></div></label>
    <div class="pdact"><button type="button" class="ghost" data-lib>${icon('image')}Z knižnice</button></div>
    <div class="pfiles" data-files></div></div>`;
}
// knižnica (cache pre plánovač)
let LIB = [];
const loadLib = async () => { try { LIB = await (await fetch('/api/library')).json(); } catch (_) {} return LIB; };
const libItem = (id) => LIB.find((x) => x.id === id);
const usedText = (it) => (it && it.used && it.used.length) ? 'Použité: ' + it.used.map((u) => `${phoneLabel(u.udid)} (${new Date(u.at).toLocaleDateString('sk-SK')})`).join(', ') : '';
// upozornenie: rovnaké médium na rovnakom účte druhýkrát
function dupCheck(rows) {
  const w = [];
  for (const r of rows) for (const f of r.files) { const it = libItem(f.id); if (!it) continue;
    for (const u of r.phones) { const hit = (it.used || []).find((x) => x.udid === u); if (hit) w.push(`• ${f.name} → ${phoneLabel(u)} (už použité ${new Date(hit.at).toLocaleDateString('sk-SK')})`); } }
  return !w.length || confirm('Tieto médiá už boli na danom účte použité:\n' + w.join('\n') + '\n\nNaozaj ich chceš použiť znova?');
}
// výber z knižnice
function pickFromLibrary(kind) {
  return new Promise(async (resolve) => {
    await loadLib();
    const items = LIB.filter((x) => (kind === 'reel' ? x.kind === 'video' : x.kind === 'photo'));
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    const sel = [];
    bg.innerHTML = `<div class="modal libpick"><div class="mhead"><h3>Knižnica · ${kind === 'reel' ? 'videá' : 'fotky'}</h3></div>
      <small class="hint">${kind === 'reel' ? 'Vyber 1 video.' : 'Vyber fotky v poradí, v akom majú byť v carouseli.'} Červený štítok = už použité.</small>
      <div class="lgrid">${items.map((it) => `<button type="button" class="lit" data-id="${it.id}" title="${esc(it.name + (usedText(it) ? '\n' + usedText(it) : ''))}">
        ${it.kind === 'video' ? `<video src="/lib/${it.id}#t=0.1" muted playsinline preload="metadata"></video>` : `<img src="/lib/${it.id}" loading="lazy" alt="">`}
        ${it.used && it.used.length ? `<span class="lused">${it.used.length}×</span>` : ''}<span class="lnum"></span></button>`).join('') || '<div class="empty-s" style="grid-column:1/-1">Knižnica je prázdna – nahraj médiá v sekcii Knižnica.</div>'}</div>
      <div class="mact"><button data-x>Zrušiť</button><button class="go" data-ok>Pridať</button></div></div>`;
    document.body.appendChild(bg);
    const close = (v) => { bg.remove(); resolve(v); };
    bg.querySelector('[data-x]').onclick = () => close(null);
    bg.onclick = (e) => { if (e.target === bg) close(null); };
    bg.querySelector('.lgrid').addEventListener('click', (e) => {
      const b = e.target.closest('.lit'); if (!b) return;
      const id = b.dataset.id, k = sel.indexOf(id);
      if (k >= 0) sel.splice(k, 1); else { if (kind === 'reel') sel.length = 0; sel.push(id); }
      bg.querySelectorAll('.lit').forEach((x) => { const n = sel.indexOf(x.dataset.id); x.classList.toggle('on', n >= 0); x.querySelector('.lnum').textContent = n >= 0 ? n + 1 : ''; });
    });
    bg.querySelector('[data-ok]').onclick = () => close(sel.map(libItem).filter(Boolean));
  });
}
// pripojí štvorček; vráti objekt s .files [{id,name}] a .busy
function attachDrop(box, onChange, prev) {
  const st = prev || { files: [] };
  const kind = box.dataset.drop, list = box.querySelector('[data-files]'), lab = box.querySelector('.drop'), inp = box.querySelector('input');
  const render = () => {
    // náhľady: obrázok / prvý snímok videa; stav nahrávania v rohu
    const sig = st.files.map((f) => f.url).join('|');
    if (list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      list.innerHTML = st.files.map((f, i) => `<div class="pf" data-k="${i}" title="${esc(f.name)}">
        ${f.video ? `<video src="${f.url}#t=0.1" muted playsinline preload="metadata"></video><span class="pvid">${icon('play')}</span>` : `<img src="${f.url}" alt="">`}
        <span class="pnum">${i + 1}</span><span class="pst"></span>${usedText(libItem(f.id)) ? `<span class="pused" title="${esc(usedText(libItem(f.id)))}">použité</span>` : ''}
        <button type="button" class="prm" data-rm="${i}" title="Odstrániť">×</button><span class="pnm">${esc(f.name)}</span></div>`).join('');
      list.querySelectorAll('img, video').forEach((m) => m.addEventListener('error', () => m.closest('.pf').classList.add('noprev')));
    }
    st.files.forEach((f, i) => {
      const el = list.querySelector(`[data-k="${i}"]`); if (!el) return;
      el.className = `pf ${f.err ? 'err' : f.id ? 'ok' : 'up'}${el.classList.contains('noprev') ? ' noprev' : ''}`;
      el.querySelector('.pst').textContent = f.err ? '!' : f.id ? '✓' : (f.pct || 0) + '%';
      el.querySelector('.pst').title = f.err || '';
    });
    list.classList.toggle('one', kind === 'reel');
    box.classList.toggle('has', st.files.length > 0);
    onChange && onChange(st);
  };
  st.render = render;
  const add = (fl) => {
    let arr = [...fl]; if (!arr.length) return;
    if (kind === 'reel') { arr = arr.slice(0, 1); st.files = []; }
    for (const f of arr) {
      const it = { name: f.name, pct: 0, url: URL.createObjectURL(f), video: /^video\//.test(f.type) || /\.(mov|mp4|m4v)$/i.test(f.name) };
      st.files.push(it);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/plan-file?name=${encodeURIComponent(f.name)}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { it.pct = Math.round(e.loaded / e.total * 100); st.render(); } };
      xhr.onload = () => { let j = {}; try { j = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status >= 400 || !j.id) it.err = j.error || 'Chyba nahrávania'; else { it.id = j.id; if (!libItem(j.id)) LIB.unshift(j); else Object.assign(libItem(j.id), j); list.dataset.sig = ''; } st.render(); };
      xhr.onerror = () => { it.err = 'Spojenie zlyhalo'; st.render(); };
      xhr.send(f);
    }
    render();
  };
  inp.onchange = () => { add(inp.files); inp.value = ''; };
  lab.addEventListener('dragover', (e) => { e.preventDefault(); lab.classList.add('over'); });
  lab.addEventListener('dragleave', () => lab.classList.remove('over'));
  lab.addEventListener('drop', (e) => { e.preventDefault(); lab.classList.remove('over'); add(e.dataTransfer.files); });
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { st.files.splice(+b.dataset.rm, 1); render(); } });
  box.querySelector('[data-lib]').onclick = async () => {
    const got = await pickFromLibrary(kind); if (!got || !got.length) return;
    if (kind === 'reel') st.files = [];
    for (const it of got) st.files.push({ id: it.id, name: it.name, url: `/lib/${it.id}`, video: it.kind === 'video', pct: 100 });
    list.dataset.sig = ''; render();
  };
  loadLib().then(() => { list.dataset.sig = ''; render(); });
  if (prev) render();
  return st;
}
const planReady = (st, label) => {
  if (st.files.some((f) => !f.id && !f.err)) { alert(`${label}: počkaj, kým sa súbory nahrajú.`); return false; }
  if (st.files.some((f) => f.err)) { alert(`${label}: niektorý súbor sa nenahral – odstráň ho (×) a skús znova.`); return false; }
  return true;
};
const planFiles = (st) => st.files.filter((f) => f.id).map((f) => ({ id: f.id, name: f.name }));

// ---------- výber telefónov (na ktorý telefón ide daný príspevok) ----------
const phoneList = () => [...cards.values()].map((c) => c.d).filter(Boolean);
const fullLabel = (d) => d ? d.label + (d.profile && d.profile.handle ? ` (@${d.profile.handle})` : '') : 'telefón';
const phoneLabel = (u) => fullLabel(phoneList().find((p) => p.udid === u));
function chipsHtml(sel, attr = 'data-ph') {
  const ph = phoneList();
  if (!ph.length) return '<small class="hint">Žiadny pripojený telefón</small>';
  return `<div class="phchips" ${attr}>${ph.map((p) => `<button type="button" class="phc${sel.includes(p.udid) ? ' on' : ''}${p.wdaOk ? '' : ' off'}" data-u="${p.udid}"${p.profile && p.profile.color ? ` style="--pc:${p.profile.color}"` : ''}><i class="pcd"></i>${esc(fullLabel(p))}</button>`).join('')}</div>`;
}
const readChips = (box) => box ? [...box.querySelectorAll('.phc.on')].map((b) => b.dataset.u) : [];
// klik na čip = zapnúť/vypnúť
document.addEventListener('click', (e) => { const b = e.target.closest('.phc'); if (b && !b.closest('[data-allph]')) b.classList.toggle('on'); });
// spustí plán: kroky sa rozdelia podľa telefónu, každý telefón ide svoje príspevky postupne
function runSteps(steps, fallbackUdid) {
  const by = new Map();
  for (const st of steps) { const u = st.udid || fallbackUdid; if (!u) return alert('Pri príspevkoch vyber telefón.'); if (!by.has(u)) by.set(u, []); by.get(u).push(st); }
  for (const [u, list] of by) post(u, 'plan', { steps: list });
  setTimeout(poll, 300);
}
const samePhones = (a, def) => a.length === 1 && a[0] === def;

// náhľady pre AI: fotky zmenšené na JPEG, z videa 3 zábery (začiatok, stred, koniec)
const toJpeg = (src, w, h) => { const k = Math.min(1, 768 / Math.max(w, h)); const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.72); };
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
function photoPreview(url) {
  return withTimeout(new Promise((res) => { const im = new Image(); im.onload = () => { try { res(toJpeg(im, im.naturalWidth, im.naturalHeight)); } catch (_) { res(null); } }; im.onerror = () => res(null); im.src = url; }), 8000);
}
function videoFrames(url, n = 3) {
  return withTimeout(new Promise((res) => {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    const out = []; let i = 0;
    const next = () => { if (i >= n) { v.src = ''; return res(out); } v.currentTime = Math.max(0.1, v.duration * (0.15 + 0.7 * i / Math.max(1, n - 1))); };
    v.onloadedmetadata = () => (isFinite(v.duration) && v.duration > 0 ? next() : res(out));
    v.onseeked = () => { try { out.push(toJpeg(v, v.videoWidth, v.videoHeight)); } catch (_) {} i++; next(); };
    v.onerror = () => res(out);
  }), 15000).then((r) => r || []);
}
async function previewsFor(files, kind) {
  const out = [];
  for (const f of files.slice(0, 6)) {
    if (f.video) out.push(...await videoFrames(f.url, kind === 'reel' ? 3 : 1));
    else { const j = await photoPreview(f.url); if (j) out.push(j); }
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

// ✨ návrhy popisov – tlačidlo pod poľom popisu
const capHtml = () => `<div class="capbar"><button type="button" class="ghost capbtn" data-capgen>✨ Navrhni popis</button><small class="hint">AI si prezrie nahraté ${''}fotky / video a navrhne 3 popisy v štýle účtu. Do poľa môžeš dopísať pár slov navyše.</small></div><div class="capsug" data-capsug></div>`;
function wireCaptions(root, getCtx) {
  root.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-capuse]');
    if (pick) { const ta = pick.closest('[data-capwrap]').querySelector('textarea'); ta.value = pick.dataset.text; ta.dispatchEvent(new Event('input')); pick.parentElement.innerHTML = ''; return; }
    const b = e.target.closest('[data-capgen]'); if (!b) return;
    const wrap = b.closest('[data-capwrap]'), ta = wrap.querySelector('textarea'), sug = wrap.querySelector('[data-capsug]');
    const ctx = getCtx(wrap);
    if (!ctx.udid) return alert('Najprv vyber telefón (účet).');
    b.disabled = true;
    try {
      let images = [];
      if (ctx.files && ctx.files.length) { sug.innerHTML = `<small class="hint">Pozerám ${ctx.kind === 'reel' ? 'video' : 'fotky'}…</small>`; images = await previewsFor(ctx.files, ctx.kind); }
      sug.innerHTML = '<small class="hint">Píšem návrhy…</small>';
      const { files, ...rest } = ctx;
      const r = await (await fetch('/api/captions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rest, images, hint: ta.value }) })).json();
      if (r.error) throw new Error(r.error);
      sug.innerHTML = r.captions.map((c) => `<button type="button" class="capopt" data-capuse data-text="${esc(c)}">${esc(c)}</button>`).join('');
    } catch (err) { sug.innerHTML = `<small class="hint" style="color:var(--bad)">${esc(err.message)}</small>`; }
    b.disabled = false;
  });
}

// okno na vyplnenie [premenných]; [Názov|a|b|c] = rolovacie menu s možnosťami
function askVars(title, vars, kind, defUdid) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    const fields = vars.map((v, i) => {
      const [label, ...opts] = v.slice(1, -1).split('|');
      const ctl = opts.length
        ? `<select data-i="${i}">${opts.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
        : /dátum a čas/i.test(label) ? dtPicker(i)
        : /popis/i.test(label) ? `<textarea data-i="${i}" rows="3"></textarea>${kind ? capHtml() : ''}` : `<input data-i="${i}">`;
      const hint = /dátum a čas/i.test(label) ? '<small class="hint">Čas zadávaš slovenský. Meta dovolí naplánovať najskôr asi 20 minút dopredu.</small><small class="hint us-conv" data-conv></small>' : '';
      const tag = kind && /popis/i.test(label) ? 'div' : 'label';
      return `<${tag} class="${tag === 'div' ? 'fld' : ''}"${tag === 'div' ? ' data-capwrap' : ''}><span>${esc(label.replace(/\s*\(napr\..*\)$/, ''))}</span>${ctl}${hint}</${tag}>`;
    }).join('');
    const phones = kind ? `<div class="fld"><span>Na ktorý telefón (môžeš vybrať viac)</span>${chipsHtml(defUdid ? [defUdid] : [])}</div>` : '';
    const drop = kind ? phones + `<div class="fld"><span>${kind === 'reel' ? 'Video' : 'Fotky'} (voliteľné)</span>${dropHtml(kind)}<small class="hint">${kind === 'reel' ? 'Ak ho sem pretiahneš, pred plánovaním sa pošle' : 'Ak ich sem pretiahneš, pred plánovaním sa pošlú'} do galérie iPhonu ako najnovšie – AI tak vyberie presne ${kind === 'reel' ? 'toto video' : 'tieto fotky'}. Inak použije ${kind === 'reel' ? 'najnovšie video' : 'najnovšie fotky'}, ktoré už v iPhone sú.</small></div>` : '';
    bg.innerHTML = `<div class="modal"><div class="mhead"><h3>${esc(title)}</h3>${clockBox()}</div>${drop}${fields}<div class="mact"><button data-x>Zrušiť</button><button class="go" data-ok>Vložiť príkaz</button></div></div>`;
    const stopClock = startClock(bg);
    document.body.appendChild(bg);
    paintIcons(bg);
    const dst = kind ? attachDrop(bg.querySelector('[data-drop]'), (st) => {
      // carousel: počet fotiek = počet pretiahnutých fotiek
      if (kind !== 'carousel') return;
      const n = st.files.length, i = vars.findIndex((v) => /počet fotiek/i.test(v)), sel = i >= 0 && bg.querySelector(`[data-i="${i}"]`);
      if (sel) { if (n >= 2 && n <= 10) sel.value = String(n); sel.disabled = n > 0; }
    }) : null;
    if (kind) wireCaptions(bg, () => { const fl = dst ? dst.files.filter((x) => x.id) : []; return { udid: readChips(bg.querySelector('[data-ph]'))[0], kind, fileId: fl[0] && fl[0].id, fileName: fl[0] && fl[0].name, files: fl }; });
    const close = (val) => { stopClock(); bg.remove(); resolve(val); };
    bg.querySelector('[data-x]').onclick = () => close(null);
    bg.onclick = (e) => { if (e.target === bg) close(null); };
    bg.querySelector('[data-ok]').onclick = () => {
      const out = [];
      out.meta = { kind };
      for (let i = 0; i < vars.length; i++) {
        const el = bg.querySelector(`[data-i="${i}"]`);
        if (el.dataset.dt !== undefined) {
          const dv = el.querySelector('[data-d]').value;
          const d = new Date(`${dv}T${el.querySelector('[data-h]').value}:${el.querySelector('[data-m]').value}`);
          if (!dv || isNaN(d)) { el.querySelector('[data-d]').focus(); return; }
          if (d < minSched()) { alert(`Tento čas je príliš skoro. Najskorší možný čas je ${fmtSk(minSched())}.`); el.querySelector('[data-h]').focus(); return; }
          out.push(fmtSk(d)); out.meta.when = d.toISOString(); out.meta.whenText = fmtSk(d);
        } else {
          out.push(el.value);
          const lab = vars[i];
          if (/popis/i.test(lab)) out.meta.caption = el.value.trim();
          else if (/pesnič/i.test(lab)) out.meta.music = el.value.trim();
          else if (/kam zverejniť/i.test(lab)) out.meta.place = el.value;
        }
      }
      if (kind) {
        out.phones = readChips(bg.querySelector('[data-ph]'));
        if (!out.phones.length) return alert('Vyber aspoň jeden telefón.');
      }
      if (dst) {
        if (!planReady(dst, kind === 'reel' ? 'Video' : 'Fotky')) return;
        out.files = planFiles(dst);
        if (kind === 'carousel' && out.files.length === 1) return alert('Carousel potrebuje aspoň 2 fotky.');
        if (out.files.length > 10) return alert('Carousel môže mať najviac 10 fotiek.');
        if (!dupCheck([{ files: out.files, phones: out.phones }])) return;
      }
      close(out);
    };
    bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); if (e.key === 'Enter' && e.target.tagName === 'INPUT') bg.querySelector('[data-ok]').click(); });
    (bg.querySelector('input, textarea, select') || bg.querySelector('[data-ok]')).focus();
  });
}

async function applyTemplateByName(name, target) {
  const t = TEMPLATES.find((x) => x.name === name);
  if (!t) return false;
  const defUdid = ([...cards.values()].find((x) => x.task === target) || {}).d?.udid || null;
  if (t.multi) {
    const r = await askMulti(t, defUdid);
    if (!r) return false;
    target.value = r.text; delete target.dataset.plan; delete target.dataset.maxSteps;
    if (r.steps) target.dataset.plan = JSON.stringify(r.steps); else target.dataset.maxSteps = r.maxSteps;
    target.focus();
    return true;
  }
  delete target.dataset.maxSteps; delete target.dataset.plan;
  let text = t.text, files = [], phones = [], meta = null;
  const kind = /Meta Business Suite/.test(t.text) && /naplánuj/i.test(t.name) ? (/reel/i.test(t.name) ? 'reel' : /carousel/i.test(t.name) ? 'carousel' : null) : null;
  const vars = [...new Set(text.match(/\[[^\]]+\]/g) || [])];
  if (vars.length) {
    const vals = await askVars(t.name, vars, kind, defUdid);
    if (!vals) return false;
    vars.forEach((v, i) => { text = text.split(v).join(vals[i]); });
    files = vals.files || []; phones = vals.phones || []; meta = vals.meta || null;
  }
  if (kind) {
    const title = splitName(t.name)[1];
    target.dataset.plan = JSON.stringify(phones.map((u) => ({ udid: u, title, task: text, files, maxSteps: 120, meta })));
    target.value = `📦 ${title} → ${phones.map(phoneLabel).join(', ')}` + (files.length ? `: najprv pošlem ${files.length === 1 ? files[0].name : files.length + ' fotiek'} do galérie (bude na 1. mieste), potom to AI naplánuje.` : '') + `\n(Tento text neupravuj – stlač Spustiť.)\n\n${text}`;
    target.focus();
    return true;
  }
  target.value = text;
  target.focus();
  return true;
}

// ---------- viac reelov / carouselov v jednom kroku (plánovač Meta Business Suite) ----------
const MUSIC_RULE = 'Ak editor ponúka hudbu (Audio / Music): pri hudbe „nie“ hudbu nepridávaj; pri prázdnej nič nevyhľadávaj a vyber úplne prvú pesničku v ponuke (For you / Trending); inak napíš názov pesničky do vyhľadávania a vyber výsledok so správnym interpretom (ak sa nedá nájsť, prvú v ponuke); ponechaj predvolený úsek a ťukni Done. Ak hudbu neponúka, pokračuj bez nej.';
function askMulti(t, defUdid) {
  const isReel = t.multi === 'reel', noun = isReel ? 'Reel' : 'Carousel';
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal multi"><div class="mhead"><h3>${esc(t.name)}</h3>${clockBox()}</div>
      <div class="mrow2"><label><span>Koľko ${isReel ? 'reelov' : 'carouselov'}</span><select data-n>${[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option>${n}</option>`).join('')}</select></label>
        <label><span>Kam zverejniť</span><select data-place><option>Len Instagram</option><option>Instagram aj Facebook</option></select></label></div>
      <div class="fld" data-allph><span>Telefón pre všetky (alebo vyber pri každom zvlášť nižšie)</span>${chipsHtml([], 'data-allbox')}</div>
      <small class="hint">Ku každému ${isReel ? 'reelu pretiahni jeho video' : 'carouselu pretiahni jeho fotky'} – pred plánovaním každého príspevku sa jeho médiá pošlú do galérie iPhonu ako najnovšie (na 1. miesto), takže AI vyberie presne ${isReel ? 'to video' : 'tie fotky'}. Bez médií: ${isReel ? 'Reel 1 = najnovšie video v iPhone, Reel 2 = druhé najnovšie atď.' : 'Carousel 1 = najnovšie fotky v iPhone, ďalší nasledujúce.'} Čas zadávaš slovenský, najskôr ~20 min dopredu.</small>
      <div class="mitems" data-items></div>
      <div class="mact"><button data-x>Zrušiť</button><button class="go" data-ok>Vložiť príkaz</button></div></div>`;
    document.body.appendChild(bg);
    const stopClock = startClock(bg);
    const items = bg.querySelector('[data-items]');
    const render = () => {
      const n = +bg.querySelector('[data-n]').value, old = [...items.querySelectorAll('.mitem2')].map((el) => ({
        ph: readChips(el.querySelector('[data-ph]')),
        cap: el.querySelector('[data-cap]').value, mus: el.querySelector('[data-mus]').value, cnt: el.querySelector('[data-cnt]')?.value,
        d: el.querySelector('[data-d]').value, h: el.querySelector('[data-h]').value, m: el.querySelector('[data-m]').value }));
      const base = new Date(Date.now() + 30 * 60000);
      items.innerHTML = [...Array(n)].map((_, i) => {
        const def = new Date(base.getTime() + i * 24 * 3600000); // predvolene každý deň v rovnakom čase – uprav si podľa seba
        return `<div class="mitem2"><div class="mtit">${noun} ${i + 1}</div><div class="fld"><span>Telefón</span>${chipsHtml(defUdid ? [defUdid] : [])}</div>${dropHtml(isReel ? 'reel' : 'carousel')}
          ${isReel ? '' : `<label><span>Počet fotiek</span><select data-cnt>${[2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => `<option${k === 3 ? ' selected' : ''}>${k}</option>`).join('')}</select></label>`}
          <div class="fld" data-capwrap><span>Popis + #hashtagy</span><textarea data-cap rows="2"></textarea>${capHtml()}</div>
          <label><span>Pesnička (prázdne = prvá v ponuke, nie = bez hudby)</span><input data-mus></label>
          <label><span>Dátum a čas</span>${dtPicker(i, def)}<small class="hint us-conv" data-conv></small></label></div>`;
      }).join('');
      old.forEach((o, i) => { const el = items.children[i]; if (!el) return;
        el.querySelectorAll('[data-ph] .phc').forEach((b) => b.classList.toggle('on', o.ph.includes(b.dataset.u)));
        el.querySelector('[data-cap]').value = o.cap; el.querySelector('[data-mus]').value = o.mus;
        if (o.cnt && el.querySelector('[data-cnt]')) el.querySelector('[data-cnt]').value = o.cnt;
        el.querySelector('[data-d]').value = o.d; el.querySelector('[data-h]').value = o.h; el.querySelector('[data-m]').value = o.m; });
      paintIcons(items);
      // štvorčeky na médiá (súbory ostanú aj po zmene počtu)
      [...items.children].forEach((el, i) => {
        drops[i] = attachDrop(el.querySelector('[data-drop]'), (s2) => {
          const sel = el.querySelector('[data-cnt]'); if (!sel) return;
          const n = s2.files.length; if (n >= 2 && n <= 10) sel.value = String(n); sel.disabled = n > 0;
        }, drops[i]);
      });
      drops.length = items.children.length;
      updateConv(bg);
    };
    const drops = [];
    wireCaptions(items, (wrap) => {
      const el = wrap.closest('.mitem2'), i = [...items.children].indexOf(el), fl = drops[i] ? drops[i].files.filter((x) => x.id) : [];
      return { udid: readChips(el.querySelector('[data-ph]'))[0], kind: isReel ? 'reel' : 'carousel', fileId: fl[0] && fl[0].id, fileName: fl[0] && fl[0].name, files: fl };
    });
    // „pre všetky“: klik na telefón ho nastaví pri všetkých príspevkoch
    bg.querySelector('[data-allph]').addEventListener('click', (e) => {
      const b = e.target.closest('.phc'); if (!b) return;
      b.classList.toggle('on');
      const sel = readChips(bg.querySelector('[data-allph]'));
      items.querySelectorAll('[data-ph]').forEach((box) => box.querySelectorAll('.phc').forEach((c) => c.classList.toggle('on', sel.includes(c.dataset.u))));
    });
    bg.querySelector('[data-n]').onchange = render;
    render();
    const close = (v) => { stopClock(); bg.remove(); resolve(v); };
    bg.querySelector('[data-x]').onclick = () => close(null);
    bg.onclick = (e) => { if (e.target === bg) close(null); };
    bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
    // úloha pre 1 príspevok; pick = null → najnovšie (médiá poslané pred tým), inak k-te najnovšie v telefóne
    const oneStep = (x, i, pick) => {
      const place = bg.querySelector('[data-place]').value;
      const which = isReel
        ? (pick && pick.k > 1 ? `v galérii prepni album na Videos / Videá a vyber ${pick.k}. najnovšie video (počítaj od prvého vľavo hore, zľava doprava, zhora nadol) – fotku nevyberaj; ťukni Next; `
          : 'v galérii prepni album na Videos / Videá a vyber NAJNOVŠIE video (prvé vľavo hore) – fotku nevyberaj; ťukni Next; ')
        : (pick && pick.from > 1 ? `ťukni na pridanie fotiek a vyber fotky č. ${pick.from} až ${pick.from + x.cnt - 1} (počítané od najnovšej fotky vľavo hore, zľava doprava, zhora nadol) v tomto poradí; potvrď výber; `
          : `ťukni na pridanie fotiek a vyber ${x.cnt} najnovších fotiek v poradí – začni prvou vľavo hore (najnovšia), pokračuj zľava doprava; potvrď výber; `);
      return { title: `${noun} ${i + 1}`, files: x.files, maxSteps: isReel ? 110 : 130,
        meta: { kind: isReel ? 'reel' : 'carousel', when: x.whenISO, whenText: x.when, caption: x.cap, music: x.mus, place }, task:
        `Otvor aplikáciu Meta Business Suite. Naplánuj 1 ${isReel ? 'reel' : 'carousel'}: ťukni na „+“ / „Create“ a vyber ${isReel ? 'Reel' : 'Post / Príspevok'}; pri účtoch / umiestneniach nastav: ${place}; ` + which +
        `${MUSIC_RULE} Hudba: „${x.mus}“. Napíš presne tento popis: „${x.cap}“. Ak je možnosť označiť obsah ako vytvorený AI (AI info / AI label), zapni ju. ` +
        `Otvor „Scheduling options“ / „Možnosti plánovania“, vyber „Schedule for later“, nastav dátum a čas: ${x.when} a ťukni „Schedule“ – NIKDY „Publish now“. ` +
        'Na konci otvor plánovač (Planner / Content → Scheduled) a over, že príspevok je naplánovaný na správny čas. Ak sa niečo nepodarí, nič nezverejňuj a skonči so správou, kde si sa zasekol.' };
    };
    bg.querySelector('[data-ok]').onclick = () => {
      const place = bg.querySelector('[data-place]').value, list = [];
      let photoStart = 1;
      for (const [i] of [...items.children].entries()) if (!planReady(drops[i], `${noun} ${i + 1}`)) return;
      const withFiles = drops.filter((st) => planFiles(st).length).length;
      if (withFiles && withFiles < drops.length) return alert(`Pretiahni ${isReel ? 'video' : 'fotky'} ku každému príspevku – alebo ku žiadnemu (vtedy sa použijú médiá, ktoré už sú v iPhone).`);
      for (const [i, el] of [...items.children].entries()) {
        const d = dtpValue(el.querySelector('.dtp'));
        if (isNaN(d)) return alert(`${noun} ${i + 1}: vyber dátum.`);
        if (d < minSched()) return alert(`${noun} ${i + 1}: čas je príliš skoro. Najskorší možný čas je ${fmtSk(minSched())}.`);
        const fl = planFiles(drops[i]);
        if (!isReel && fl.length === 1) return alert(`${noun} ${i + 1}: carousel potrebuje aspoň 2 fotky.`);
        const cnt = isReel ? 1 : (fl.length || +el.querySelector('[data-cnt]').value);
        const ph = readChips(el.querySelector('[data-ph]'));
        if (!ph.length) return alert(`${noun} ${i + 1}: vyber telefón.`);
        list.push({ whenISO: d.toISOString(), ph, files: fl, cap: el.querySelector('[data-cap]').value.trim(), mus: el.querySelector('[data-mus]').value.trim(), when: fmtSk(d), cnt, from: photoStart });
        photoStart += cnt;
      }
      if (!dupCheck(list.map((x) => ({ files: x.files, phones: x.ph })))) return;
      {
        // plán: každý príspevok zvlášť (na svojom telefóne) – najprv jeho médiá do galérie, potom ho AI naplánuje.
        // Bez médií: pre každý telefón sa počíta poradie zvlášť (1. príspevok = najnovšie video, 2. = druhé najnovšie…)
        const seen = new Map(), steps = [];
        list.forEach((x, i) => x.ph.forEach((u) => {
          const o = seen.get(u) || { n: 0, from: 1 }; seen.set(u, { n: o.n + 1, from: o.from + x.cnt });
          const pick = x.files.length ? null : { k: o.n + 1, from: o.from };
          steps.push({ udid: u, ...oneStep(x, i, pick) });
        }));
        const summary = `📦 Plán: ${list.length} ${isReel ? 'reelov' : 'carouselov'} v Meta Business Suite` + (withFiles ? `. Pred každým pošlem jeho ${isReel ? 'video' : 'fotky'} do galérie (bude na 1. mieste), potom ho AI naplánuje` : '') + ':\n' +
          list.map((x, i) => `${i + 1}. ${x.ph.map(phoneLabel).join(' + ')} · ${x.when}${x.files.length ? ' – ' + x.files.map((f) => f.name).join(', ') : ''}${x.cap ? ' – „' + x.cap.slice(0, 40) + (x.cap.length > 40 ? '…' : '') + '“' : ''}`).join('\n') + '\n(Tento text neupravuj – stlač Spustiť.)';
        return close({ text: summary, steps });
      }
      const parts = list.map((x, i) => isReel
        ? `REEL ${i + 1}: video = ${i === 0 ? 'najnovšie video' : `${i + 1}. najnovšie video`} v albume Videos / Videá (počítaj zľava doprava, zhora nadol). Popis presne: „${x.cap}“. Hudba: „${x.mus}“. Naplánuj na: ${x.when}.`
        : `CAROUSEL ${i + 1}: fotky č. ${x.from} až ${x.from + x.cnt - 1} (počítané od najnovšej fotky vľavo hore, zľava doprava, zhora nadol), vyber ich v tomto poradí. Popis presne: „${x.cap}“. Hudba: „${x.mus}“. Naplánuj na: ${x.when}.`).join(' ');
      const text = `Otvor aplikáciu Meta Business Suite. Postupne naplánuj ${list.length} ${isReel ? 'reelov' : 'carouselov'} – každý ako samostatný príspevok, jeden po druhom. ` +
        `Pre každý: ťukni na „+“ / „Create“ a vyber ${isReel ? 'Reel' : 'Post / Príspevok'}; pri účtoch / umiestneniach nastav: ${place}; ` +
        (isReel ? 'v galérii prepni album na Videos / Videá a vyber správne video (fotku nevyberaj); ťukni Next; ' : 'ťukni na pridanie fotiek a vyber správne fotky v poradí; potvrď výber; ') +
        `${MUSIC_RULE} Napíš presne daný popis. Ak je možnosť označiť obsah ako vytvorený AI (AI info / AI label), zapni ju. ` +
        'Otvor „Scheduling options“ / „Možnosti plánovania“, vyber „Schedule for later“, nastav daný dátum a čas a ťukni „Schedule“ – NIKDY „Publish now“. Po naplánovaní pokračuj ďalším. ' +
        parts + ` Na konci otvor plánovač (Planner / Content → Scheduled), over, že je tam všetkých ${list.length} príspevkov na správne časy, a napíš mi prehľad. ` +
        'Ak sa niektorý nepodarí, nič nezverejňuj, preskoč ho, pokračuj ďalším a na konci napíš, ktorý chýba a prečo.';
      close({ text, maxSteps: Math.min(400, 30 + list.length * 45) });
    };
  });
}

// sklenené okno so šablónami ako dlaždicami
const splitName = (n) => { const m = n.match(/^(\S+)\s+(.*)$/); return m && !/[A-Za-zÀ-ž0-9]/.test(m[1]) ? [m[1], m[2]] : ['✦', n]; };
function pickTemplate(target, phoneLabel) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const render = () => {
    bg.innerHTML = `<div class="modal picker"><div class="phead"><div><h3>Šablóny</h3><div class="sub">${phoneLabel ? 'Pre telefón ' + esc(phoneLabel) : 'Pre všetky telefóny'} · vyber, čo má AI urobiť</div></div>
      <button class="ghost" data-x>${icon('plus').replace('<svg', '<svg style="transform:rotate(45deg)"')}</button></div>
      <div class="tgrid">${TEMPLATES.map((t, i) => { const [em, nm] = splitName(t.name); return `
        <div class="ttile" data-i="${i}" tabindex="0"><div class="tem">${esc(em)}</div><div class="tnm">${esc(nm)}</div>
          <div class="tds">${esc((t.desc || t.text).replace(/\[[^\]]+\]/g, '…').slice(0, 95))}…</div>
          <button class="tdel ghost" data-del="${i}" title="Zmazať šablónu">${icon('trash')}</button></div>`; }).join('') || '<div class="empty-s">Žiadne šablóny</div>'}</div>
      <div class="pfoot"><span class="lnk" data-reset>↺ Obnoviť pôvodné šablóny</span><span class="sub">Vlastnú šablónu uložíš tlačidlom 💾 pri poli úlohy</span></div></div>`;
    paintIcons(bg);
  };
  render();
  document.body.appendChild(bg);
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('click', async (e) => {
    if (e.target === bg || e.target.closest('[data-x]')) return close();
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const t = TEMPLATES[del.dataset.del];
      if (t && confirm(`Zmazať šablónu „${t.name}“?`)) { await tplApi({ action: 'delete', name: t.name }); render(); }
      return;
    }
    if (e.target.closest('[data-reset]')) {
      if (confirm('Obnoviť pôvodné šablóny? Tvoje vlastné sa zmažú.')) { await tplApi({ action: 'reset' }); render(); }
      return;
    }
    const tile = e.target.closest('.ttile');
    if (tile) {
      const t = TEMPLATES[tile.dataset.i];
      close();
      if (await applyTemplateByName(t.name, target)) { const c = [...cards.values()].find((x) => x.task === target); if (c) c.lastTpl = t.name; }
    }
  });
  bg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('ttile')) e.target.click(); });
}

function saveTemplate(text, current) {
  text = text.trim();
  if (!text) return alert('Najprv napíš príkaz do poľa, potom ho ulož ako šablónu.');
  const name = prompt('Názov šablóny – môžeš začať emoji (napr. 🎬 Reel pre Laru 1):', current || '');
  if (name) tplApi({ name, text });
}
function deleteTemplate(name) {
  if (!name || name === '__reset') return alert('Najprv vyber šablónu v menu.');
  if (confirm(`Zmazať šablónu „${name}“?`)) tplApi({ action: 'delete', name });
}

function setFocus(c) {
  if (focused) focused.el.classList.remove('focus');
  focused = c; c.el.classList.add('focus');
}

function ripple(c, x, y) {
  const r = document.createElement('div'); r.className = 'ripple';
  r.style.left = x + 'px'; r.style.top = y + 'px';
  c.img.parentElement.appendChild(r); setTimeout(() => r.remove(), 500);
}

// ---------- stav telefónov ----------
async function poll() {
  let data;
  try { data = await (await fetch('/api/devices')).json(); }
  catch (_) {
    showMsg('Server nebeží. Spusti START_STRANKY.');
    sideStatus(null); return;
  }
  lastDevices = data;
  showMsg(data.error);
  const n = data.mediaNet || {}, net = document.getElementById('net');
  net.className = 'chip ' + (n.via === 'internet' ? 'ok' : 'warn');
  net.innerHTML = icon('wifi') + (n.via === 'internet' ? 'Médiá cez internet' : `Médiá len cez Wi-Fi (tunel: ${esc(n.tunnel || '?')})`);

  const seen = new Set();
  for (const d of data.devices) {
    seen.add(d.udid);
    let c = cards.get(d.udid);
    if (!c) { c = makeCard(d); cards.set(d.udid, c); }
    c.d = d;
    const pf = d.profile || {}, nm = `${esc(d.label)}${pf.handle ? ` <small>@${esc(pf.handle)}</small>` : ''}`;
    if (c.name.dataset.h !== nm) { c.name.innerHTML = nm; c.name.dataset.h = nm; }
    c.el.style.setProperty('--pc', pf.color || 'transparent');
    c.ver.textContent = d.version ? 'iOS ' + d.version : '';
    c.dot.classList.toggle('ok', d.wdaOk);
    c.el.classList.toggle('wda', d.wdaOk);
    if (!d.wdaOk) { c.ph.textContent = 'Čakám na WebDriverAgent… (odomkni telefón)'; if (d.lastLog && !c.t) c.log.textContent = d.lastLog; }
    if (d.wdaOk && !c.streaming && view === 'telefony') c.startStream();
    if (view !== 'telefony' && c.streaming) { c.img.src = ''; c.streaming = false; } // šetrí výkon, keď stenu nevidíš
    renderMedia(c);
    c.el.classList.toggle('locked', !!d.locked);
    const running = !!(d.agent && d.agent.running);
    c.el.classList.toggle('running', running);
    c.runBtn.textContent = running ? 'Stop' : 'Spustiť';
    c.runBtn.className = running ? 'stop' : 'go';
    if (d.agent && d.agent.log.length) {
      const txt = d.agent.log.join('\n');
      if (c.alog.textContent !== txt) { c.alog.textContent = txt; c.alog.scrollTop = c.alog.scrollHeight; }
      c.alog.classList.add('on');
    }
  }
  for (const [u, c] of cards) if (!seen.has(u)) { c.img.src = ''; c.el.remove(); cards.delete(u); }
  const list = [...cards.values()].sort((a, b) => a.d.label.localeCompare(b.d.label, 'sk', { numeric: true }));
  if (!list.length) grid.innerHTML = '<div class="empty">Žiadny iPhone. Pripoj ho USB káblom, odomkni a potvrď „Dôverovať tomuto počítaču“.</div>';
  else {
    grid.querySelector('.empty')?.remove();
    const cur = [...grid.children];
    if (cur.length !== list.length || list.some((c, i) => cur[i] !== c.el)) list.forEach((c) => grid.appendChild(c.el));
  }
  const cnt = plural(list.length, 'telefón', 'telefóny', 'telefónov');
  document.getElementById('count').textContent = cnt;
  document.getElementById('navCount').textContent = list.length;
  document.getElementById('brandSub').textContent = 'Instagram · ' + cnt;
  sideStatus(data);
}

function sideStatus(data) {
  const dot = document.getElementById('sDot'), t = document.getElementById('sTitle'), s = document.getElementById('sSub');
  if (!data) { dot.className = 'dot'; t.textContent = 'Server nebeží'; s.textContent = ''; return; }
  const total = data.devices.length, on = data.devices.filter((d) => d.wdaOk).length;
  const run = data.devices.filter((d) => d.agent && d.agent.running).length;
  dot.className = 'dot' + (on ? ' ok' : '');
  t.textContent = run ? 'AI pracuje' : on ? 'Pripravené' : 'Nečinné';
  s.textContent = `${on}/${total} online` + (data.hasKey ? '' : ' · chýba API kľúč');
}

function showMsg(t) { const m = document.getElementById('msg'); m.style.display = t ? 'block' : 'none'; m.textContent = t || ''; }

const gtask = document.getElementById('gtask');
document.getElementById('gbtn').onclick = () => {
  const task = gtask.value.trim(); if (!task) return gtask.focus();
  if (gtask.dataset.plan) return runSteps(JSON.parse(gtask.dataset.plan), null);
  for (const c of cards.values()) if (c.d.wdaOk && !(c.d.agent && c.d.agent.running)) post(c.d.udid, 'agent', { task });
  setTimeout(poll, 300);
};
gtask.addEventListener('input', () => { if (!gtask.value.trim()) delete gtask.dataset.plan; });
gtask.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('gbtn').click(); });
document.getElementById('gtpl').onclick = () => pickTemplate(gtask, null);

// štart
window.addEventListener('hashchange', () => setTimeout(poll, 50));
loadTemplates().then(() => { route(); poll(); });
setInterval(poll, 3000);
setInterval(() => { if (view === 'prehlad') loadOverview(); else if (view === 'aktivita') loadActivity(); }, 6000);
