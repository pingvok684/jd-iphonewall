// Stena telefónov: živý obraz, dotyky, text, AI úlohy, šablóny, fotky/videá do galérie.
const grid = document.getElementById('grid');
// dlaždica „+ Pridať telefón“ – vždy posledná v zozname telefónov
const addCard = document.createElement('div');
addCard.className = 'card addcard'; addCard.tabIndex = 0;
addCard.innerHTML = '<div class="addin"><div class="addplus">+</div><b>Pridať telefón</b><small>nový iPhone, ktorý ešte nie je nastavený</small></div>';
addCard.onclick = () => openAddPhone();
addCard.onkeydown = (e) => { if (e.key === 'Enter') openAddPhone(); };
function openAddPhone() {
  if (window.jdApp && window.jdApp.setup) return window.jdApp.setup(); // aplikácia: sprievodca nastavením
  const win = /Windows/i.test(navigator.userAgent);
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal addph"><div class="mhead"><h3>Pridať telefón</h3></div>
    <ol class="addsteps">
      <li><b>Pripoj iPhone káblom</b> k počítaču, na ktorom beží JD Phone Studio. Odomkni ho a ťukni <b>Dôverovať</b> (Trust) + zadaj kód.</li>
      ${win ? '<li><b>Windows:</b> musí byť nainštalované <b>Apple Devices</b> (Microsoft Store) alebo <b>iTunes</b> z apple.com.</li>' : ''}
      <li><b>WebDriverAgent:</b> ${win ? 'nahraj do iPhonu <b>WebDriverAgent.ipa</b> cez <b>Sideloadly</b> (súbor nájdeš v priečinku aplikácie).' : 'v režime Xcode sa nainštaluje sám (pár minút). Pri Sideloadly nahraj <b>WebDriverAgent.ipa</b>.'}</li>
      <li>Na iPhone: <b>Nastavenia → Súkromie a bezpečnosť → Režim pre vývojárov (Developer Mode) → Zapnúť</b> (iPhone sa reštartuje). Potom <b>Nastavenia → Vývojár → Enable UI Automation</b>.</li>
      <li><b>Nastavenia → Všeobecné → VPN a správa zariadení</b> → ťukni na svoje Apple ID → <b>Dôverovať</b>.</li>
      <li>Skratka <b>JD Save</b> (fotky cez kábel): <b>Nastavenia → Fotky a videá</b> → naskenuj QR kód.</li>
    </ol>
    <p class="hint">Telefón sa v zozname objaví sám do pár sekúnd po pripojení. Ak svieti chyba, prečítaj si hlášku hore na stránke Telefóny.</p>
    <div class="mact"><a class="btn" href="#navod" data-x>Celý návod</a><button class="go" data-x>Rozumiem</button></div></div>`;
  document.body.appendChild(bg);
  bg.onclick = (e) => { if (e.target === bg || e.target.closest('[data-x]')) bg.remove(); };
}
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
    <div class="top"><span class="dot" data-tip="Zelená = telefón je pripojený a pripravený, červená = odpojený alebo sa ešte pripája"></span><span class="nm"><span class="name" data-tip="Názov telefónu – dvojklik ho premenuje"></span><span class="ver"></span></span>
      <button data-a="unlock" data-tip="Zobudí a odomkne tento iPhone">${icon('unlock')}</button><button data-a="lock" data-tip="Uspí tento iPhone (zamkne obrazovku)">${icon('lock')}</button>
      <button data-a="solo" data-tip="Zväčší tento telefón – ovládaš ho pohodlnejšie">${icon('expand')}</button></div>
    <div class="screen" data-tip="Živý obraz iPhonu: klik = ťuknutie, potiahnutie myšou = potiahnutie prstom"><img alt=""><div class="ph">Čakám na WebDriverAgent…</div><div class="pstat"></div></div>
    <div class="log"></div>
    <div class="bar">
      <input placeholder="Text… (Enter = poslať)" data-tip="Napíše text do tohto iPhonu – najprv ťukni do políčka v telefóne, Enter = odoslať">
      <button data-a="home" data-tip="Tlačidlo Domov na tomto iPhone">${icon('home')}</button>
      <button data-a="reset" data-tip="Obnoví spojenie s týmto iPhonom (keď obraz zamrzne)">${icon('refresh')}</button>
    </div>
    <div class="tplrow"><button class="tplbtn" data-a="tpick" data-tip="Hotové AI príkazy (prieskum reels, story, plánovanie…) len pre TENTO iPhone">${icon('list')}<span>Šablóny</span></button><button data-a="tsave" data-tip="Uloží napísanú úlohu ako vlastnú šablónu">${icon('save')}</button></div>
    <div class="row"><textarea placeholder="Úloha pre AI…" data-tip="Napíš po slovensky, čo má AI na tomto iPhone urobiť – napr. „otvor Instagram a pozri 5 reelov“"></textarea><button class="go" data-a="run" data-tip="Spustí AI úlohu na tomto iPhone (počas behu sa tlačidlo zmení na Stop)">Spustiť</button></div>
    <div class="alog"></div>
    <label class="drop" data-tip="Pošle fotky a videá cez kábel do galérie tohto iPhonu (uloží ich skratka JD Save)"><b>Fotky / videá do galérie</b><br>pretiahni sem alebo klikni
      <input type="file" multiple accept="image/*,video/*,.heic,.mov,.mp4"></label>
    <div class="mlist"></div>`;
  const c = { el, d, img: el.querySelector('img'), ph: el.querySelector('.ph'), dot: el.querySelector('.dot'),
    name: el.querySelector('.name'), ver: el.querySelector('.ver'), pstat: el.querySelector('.pstat'), log: el.querySelector('.log'),
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
  const v = kind === 'reel', st = kind === 'story';
  return `<div class="pdrop" data-drop="${kind}"><label class="drop"><input type="file" ${st ? 'accept="image/*,video/*,.heic,.mov,.mp4"' : v ? 'accept="video/*,.mov,.mp4"' : 'accept="image/*,.heic" multiple'}>
    <div>${icon(v ? 'play' : 'image')}<b>${st ? 'Pretiahni sem fotku alebo video' : v ? 'Pretiahni sem video' : 'Pretiahni sem fotky'}</b><small>${v || st ? 'alebo klikni' : 'v poradí, v akom majú byť v carouseli – alebo klikni'}</small></div></label>
    <div class="pdact"><button type="button" class="ghost" data-lib>${icon('image')}Z knižnice</button></div>
    <div class="pfiles" data-files></div></div>`;
}
// knižnica (cache pre plánovač)
let LIB = [];
const loadLib = async () => { try { LIB = await (await fetch('/api/library')).json(); } catch (_) {} return LIB; };
const libItem = (id) => LIB.find((x) => x.id === id);
const usedText = (it) => (it && it.used && it.used.length) ? 'Použité: ' + it.used.map((u) => `${phoneLabel(u.udid)} (${new Date(u.at).toLocaleDateString('sk-SK')})`).join(', ') : '';
// upozornenie: rovnaké médium na rovnakom účte druhýkrát
function dupCheck(rows, skipCal) {
  const w = [];
  for (const r of rows) for (const f of r.files) { const it = libItem(f.id); if (!it) continue;
    for (const u of r.phones) { const hit = (it.used || []).find((x) => x.udid === u && (!skipCal || x.calId !== skipCal)); if (hit) w.push(`• ${f.name} → ${phoneLabel(u)} (už použité ${new Date(hit.at).toLocaleDateString('sk-SK')})`); } }
  return !w.length || confirm('Tieto médiá už boli na danom účte použité:\n' + w.join('\n') + '\n\nNaozaj ich chceš použiť znova?');
}
// výber z knižnice – najprv súbory daného telefónu (každý telefón má vlastnú knižnicu)
function pickFromLibrary(kind, udid) {
  return new Promise(async (resolve) => {
    await loadLib();
    const all = LIB.filter((x) => (kind === 'story' ? true : kind === 'reel' ? x.kind === 'video' : x.kind === 'photo'));
    const mine = udid ? all.filter((x) => (x.owners || []).includes(udid)) : [];
    const none = all.filter((x) => !(x.owners || []).length);
    let tab = udid && mine.length ? 'mine' : 'all';
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    const sel = [];
    bg.innerHTML = `<div class="modal libpick"><div class="mhead"><h3>Knižnica · ${kind === 'story' ? 'fotky a videá' : kind === 'reel' ? 'videá' : 'fotky'}</h3></div>
      ${udid ? `<div class="libtabs"><button type="button" data-t="mine">${esc(phoneLabel(udid))} (${mine.length})</button><button type="button" data-t="none">Nepriradené (${none.length})</button><button type="button" data-t="all">Všetky (${all.length})</button></div>` : ''}
      <small class="hint">${kind === 'story' ? 'Vyber 1 fotku alebo video.' : kind === 'reel' ? 'Vyber 1 video.' : 'Vyber fotky v poradí, v akom majú byť v carouseli.'} Červený štítok = už použité.</small>
      <div class="lgrid"></div>
      <div class="mact"><button data-x>Zrušiť</button><button class="go" data-ok>Pridať</button></div></div>`;
    document.body.appendChild(bg);
    const grid = bg.querySelector('.lgrid');
    const mark = () => bg.querySelectorAll('.lit').forEach((x) => { const n = sel.indexOf(x.dataset.id); x.classList.toggle('on', n >= 0); x.querySelector('.lnum').textContent = n >= 0 ? n + 1 : ''; });
    const draw = () => {
      const items = tab === 'mine' ? mine : tab === 'none' ? none : all;
      bg.querySelectorAll('.libtabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
      grid.innerHTML = items.map((it) => `<button type="button" class="lit" data-id="${it.id}" title="${esc(it.name + (usedText(it) ? '\n' + usedText(it) : ''))}">
        ${it.kind === 'video' ? `<video src="/lib/${it.id}#t=0.1" muted playsinline preload="metadata"></video>` : `<img src="/lib/${it.id}" loading="lazy" alt="">`}
        ${it.used && it.used.length ? `<span class="lused">${it.used.length}×</span>` : ''}<span class="lnum"></span></button>`).join('')
        || `<div class="empty-s" style="grid-column:1/-1">${tab === 'mine' ? 'Tento telefón zatiaľ nemá v knižnici nič – pozri „Všetky“ alebo nahraj súbory v Knižnici pod jeho záložkou.' : 'Knižnica je prázdna – nahraj médiá v sekcii Knižnica.'}</div>`;
      mark();
    };
    draw();
    const close = (v) => { bg.remove(); resolve(v); };
    bg.querySelector('[data-x]').onclick = () => close(null);
    bg.onclick = (e) => { if (e.target === bg) close(null); };
    const tabs = bg.querySelector('.libtabs'); if (tabs) tabs.onclick = (e) => { const b = e.target.closest('button'); if (b) { tab = b.dataset.t; draw(); } };
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.lit'); if (!b) return;
      const id = b.dataset.id, k = sel.indexOf(id);
      if (k >= 0) sel.splice(k, 1); else { if (kind === 'reel' || kind === 'story') sel.length = 0; sel.push(id); }
      mark();
    });
    bg.querySelector('[data-ok]').onclick = () => close(sel.map(libItem).filter(Boolean));
  });
}
// pripojí štvorček; vráti objekt s .files [{id,name}] a .busy
function attachDrop(box, onChange, prev) {
  const st = prev || { files: [] };
  const kind = box.dataset.drop, list = box.querySelector('[data-files]'), lab = box.querySelector('.drop'), inp = box.querySelector('input');
  // telefón, ku ktorému štvorček patrí (čipy v tom istom príspevku, inak v okne)
  const boxPhone = () => { const sc = box.closest('.mitem2') || box.closest('.modal'); return readChips(sc && sc.querySelector('[data-ph]'))[0] || ''; };
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
    list.classList.toggle('one', kind === 'reel' || kind === 'story');
    box.classList.toggle('has', st.files.length > 0);
    onChange && onChange(st);
  };
  st.render = render;
  const add = (fl) => {
    let arr = [...fl]; if (!arr.length) return;
    if (kind === 'reel' || kind === 'story') { arr = arr.slice(0, 1); st.files = []; }
    for (const f of arr) {
      const it = { name: f.name, pct: 0, url: URL.createObjectURL(f), video: /^video\//.test(f.type) || /\.(mov|mp4|m4v)$/i.test(f.name) };
      st.files.push(it);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/plan-file?name=${encodeURIComponent(f.name)}${boxPhone() ? '&owner=' + encodeURIComponent(boxPhone()) : ''}`);
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
    const got = await pickFromLibrary(kind, boxPhone()); if (!got || !got.length) return;
    if (kind === 'reel' || kind === 'story') st.files = [];
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
const igName = (h) => { h = String(h || '').trim(); const m = h.match(/instagram\.com\/([A-Za-z0-9._]+)/i); return m ? m[1] : h.replace(/^@+/, '').replace(/[/?#].*$/, ''); };
const fullLabel = (d) => d ? d.label + (d.profile && d.profile.handle ? ` (@${igName(d.profile.handle)})` : '') : 'telefón';
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

// ---------- kam zverejniť: klikacie karty ----------
const PLACES = [['Len Instagram', '📸', 'Len Instagram', 'príspevok pôjde iba na IG'], ['Instagram aj Facebook', '📸📘', 'Instagram aj Facebook', 'rovnaký príspevok aj na FB stránku']];
let PLACE_DEF = 'Len Instagram';
try { PLACE_DEF = localStorage.getItem('jd-place') || PLACE_DEF; } catch (_) {}
const placeHtml = (extra = 'data-place') => `<div class="plc" ${extra}>${PLACES.map(([v, ic, t, s]) => `<button type="button" class="plcb${v === PLACE_DEF ? ' on' : ''}" data-pv="${v}"><span class="pic">${ic}</span><span><b>${t}</b><small>${s}</small></span></button>`).join('')}</div>`;
const readPlace = (box) => { const b = box && box.querySelector('.plcb.on'); return b ? b.dataset.pv : PLACE_DEF; };
// X (Twitter): voliteľne aj na X – samostatný post v aplikácii X (naplánovaný na rovnaký čas)
let X_DEF = false; try { X_DEF = localStorage.getItem('jd-x') === '1'; } catch (_) {}
const xToggleHtml = () => `<label class="xtog" data-xtog><input type="checkbox"${X_DEF ? ' checked' : ''}><span class="xlogo">𝕏</span><span><b>Aj na X (Twitter)</b><small>rovnaký post naplánuje aj v aplikácii X v iPhone</small></span></label>`;
const readX = (root) => { const c = root && root.querySelector('[data-xtog] input'); const v = !!(c && c.checked); X_DEF = v; try { localStorage.setItem('jd-x', v ? '1' : '0'); } catch (_) {} return v; };
const X_MAX = 280;
// úloha: naplánovať post v aplikácii X (médiá sú už v galérii ako najnovšie)
function postTaskX(isReel, x, pick, title) {
  const text = String(x.cap || '').slice(0, X_MAX);
  const which = isReel
    ? (pick && pick.k > 1 ? `vyber ${pick.k}. najnovšie VIDEO (počítaj od prvej položky vľavo hore, fotky preskakuj)` : 'vyber NAJNOVŠIE VIDEO (prvé video vľavo hore; video má v rohu dĺžku)')
    : (pick && pick.from > 1 ? `vyber fotky č. ${pick.from} až ${pick.from + Math.min(4, x.cnt) - 1} (od najnovšej vľavo hore, videá preskakuj)` : `vyber ${Math.min(4, x.cnt)} ${Math.min(4, x.cnt) === 1 ? 'NAJNOVŠIU fotku' : 'najnovšie fotky'} (od prvej vľavo hore, videá preskakuj)`);
  return { title: title + ' · X', files: [], maxSteps: 90,
    meta: { kind: isReel ? 'reel' : 'carousel', platform: 'x', when: x.whenISO, whenText: x.when, caption: text, music: '', place: 'X (Twitter)' }, task:
    `Otvor aplikáciu X (Twitter). Naplánuj post na X s ${isReel ? 'VIDEOM' : 'FOTKAMI'}: ťukni na tlačidlo nového postu (+ / pierko vpravo dole) a vyber Post. Napíš presne tento text postu: „${text}“. ` +
    `Ťukni na ikonu obrázka / galérie, v galérii nechaj Recents / Nedávne (iný album NEPOUŽÍVAJ) a ${which}; potvrď (Add / Pridať). ` +
    'Ak je pri médiu možnosť označiť ho ako citlivý obsah (Flag / Sensitive content / citlivý obsah), zapni ju. ' +
    `Potom ťukni na ikonu kalendára / Schedule (naplánovať) v okne postu a nastav dátum a čas: ${x.when} – stačí odchýlka do ±10 minút, minúty nedolaďuj presne. Potvrď (Confirm / Potvrdiť) a ťukni Schedule / Naplánovať. ` +
    'NIKDY neťukaj „Post“ bez naplánovaného času – post sa nesmie zverejniť hneď. Ak v aplikácii X plánovanie nie je (chýba ikona kalendára), nič nezverejňuj, zmaž koncept a skonči so správou „X: plánovanie nie je dostupné“.' };
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.plcb'); if (!b) return;
  b.closest('.plc').querySelectorAll('.plcb').forEach((x) => x.classList.toggle('on', x === b));
  PLACE_DEF = b.dataset.pv; try { localStorage.setItem('jd-place', PLACE_DEF); } catch (_) {}
});

// ---------- hashtagy: áno / nie, najviac 5 (viac Instagram ani Facebook neprijme) ----------
const MAX_TAGS = 5;
const TAG_RE = /#[\p{L}\p{N}_]+/gu;
let TAGS_DEF = true;
try { TAGS_DEF = localStorage.getItem('jd-tags') !== '0'; } catch (_) {}
const tagsHtml = () => `<div class="tagsel" data-tags><span class="hint">Hashtagy:</span>
  <button type="button" class="tgc${TAGS_DEF ? ' on' : ''}" data-tv="1"># Áno (max ${MAX_TAGS})</button><button type="button" class="tgc${TAGS_DEF ? '' : ' on'}" data-tv="0">🚫 Bez hashtagov</button></div>`;
const readTags = (box) => { const b = box && box.querySelector('.tgc.on'); return b ? b.dataset.tv === '1' : TAGS_DEF; };
function setTags(box, on) { if (box) box.querySelectorAll('.tgc').forEach((x) => x.classList.toggle('on', (x.dataset.tv === '1') === !!on)); }
// upraví popis: bez hashtagov = všetky # zmaže; s hashtagmi = najprv stále hashtagy účtu, potom tie z popisu, spolu najviac 5 (na konci)
function applyTags(cap, on, fixed) {
  cap = String(cap || '');
  const own = cap.match(TAG_RE) || [];
  const text = cap.replace(TAG_RE, '').replace(/[ \t]+$/gm, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!on) return text;
  const tags = [];
  for (const t of [...(String(fixed || '').match(TAG_RE) || []), ...own]) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  const top = tags.slice(0, MAX_TAGS);
  return top.length ? (text ? text + '\n\n' : '') + top.join(' ') : text;
}
const fixedTagsOf = (u) => (((phoneList().find((p) => p.udid === u) || {}).profile) || {}).hashtags || '';
document.addEventListener('click', (e) => {
  const b = e.target.closest('.tgc'); if (!b) return;
  setTags(b.closest('[data-tags]'), b.dataset.tv === '1');
  TAGS_DEF = b.dataset.tv === '1'; try { localStorage.setItem('jd-tags', TAGS_DEF ? '1' : '0'); } catch (_) {}
  const w = b.closest('[data-capwrap]'); if (w) w.dispatchEvent(new CustomEvent('tagschange', { bubbles: true }));
});

// ✨ návrhy popisov – tlačidlo pod poľom popisu
const capHtml = () => tagsHtml() + `<div class="capbar"><button type="button" class="ghost capbtn" data-capgen>✨ Navrhni popis</button><small class="hint">AI si prezrie nahraté ${''}fotky / video a navrhne 3 popisy v štýle účtu. Do poľa môžeš dopísať pár slov navyše.</small></div><div class="capsug" data-capsug></div>`;
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
      const r = await (await fetch('/api/captions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rest, tags: readTags(wrap), images, hint: ta.value }) })).json();
      if (r.error) throw new Error(r.error);
      sug.innerHTML = r.captions.map((c) => `<button type="button" class="capopt" data-capuse data-text="${esc(c)}">${esc(c)}</button>`).join('');
    } catch (err) { sug.innerHTML = `<small class="hint" style="color:var(--bad)">${esc(err.message)}</small>`; }
    b.disabled = false;
  });
}

// okno na vyplnenie [premenných]; [Názov|a|b|c] = rolovacie menu s možnosťami
// ---------- prieskum: naposledy použité profily (z archívu prieskumov + tohto prehliadača) ----------
const splitProfs = (t) => String(t || '').split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean);
const profKey = (x) => x.toLowerCase().replace(/^@/, '');
function rememberProfiles(t) {
  const now = splitProfs(t); if (!now.length) return;
  let l = []; try { l = JSON.parse(localStorage.getItem('jd-research-profiles') || '[]'); } catch (_) {}
  l = [...now, ...l.filter((x) => !now.some((y) => profKey(y) === profKey(x)))].slice(0, 30);
  try { localStorage.setItem('jd-research-profiles', JSON.stringify(l)); } catch (_) {}
}
async function wireRecentProfiles(bg, input) {
  let mine = []; try { mine = JSON.parse(localStorage.getItem('jd-research-profiles') || '[]'); } catch (_) {}
  let arch = []; try { arch = (await (await fetch('/api/research')).json()).map((r) => r.profile); } catch (_) {}
  const list = [];
  for (const p of [...mine, ...arch.flatMap(splitProfs)]) if (p && !/^reels feed$/i.test(p) && !list.some((x) => profKey(x) === profKey(p))) list.push(p);
  const box = bg.querySelector('[data-rp]'), pl = box.querySelector('.rpl');
  if (!list.length) return;
  box.hidden = false;
  const paint = () => { const cur = splitProfs(input.value).map(profKey); pl.innerHTML = list.slice(0, 16).map((p) => `<button type="button" class="pchip${cur.includes(profKey(p)) ? ' on' : ''}" data-p="${esc(p)}">${esc(p)}</button>`).join(''); };
  paint();
  input.addEventListener('input', paint);
  pl.onclick = (e) => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const cur = splitProfs(input.value), p = b.dataset.p, i = cur.findIndex((x) => profKey(x) === profKey(p));
    if (i >= 0) cur.splice(i, 1); else cur.push(p);
    input.value = cur.join(', '); paint();
  };
}

const MBS_WARN = "<div class=\"mbswarn\"><b>!!! Potrebuješ aplikáciu Meta Business Suite !!!</b><span>Príspevky sa plánujú cez <b>Meta Business Suite</b> – samotná aplikácia Instagram nestačí. Musí byť v každom iPhone nainštalovaná, prihlásená a prepojená s Instagram účtom (profesionálny účet: Tvorca alebo Firma).</span></div>";

// naposledy použité hodnoty jedného políčka (napr. odkaz v story) – klik = vložiť
function rememberRecent(key, v) {
  v = String(v || '').trim(); if (!v) return;
  let l = []; try { l = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) {}
  l = [v, ...l.filter((x) => x !== v)].slice(0, 15);
  try { localStorage.setItem(key, JSON.stringify(l)); } catch (_) {}
}
function wireRecent(input) {
  let list = []; try { list = JSON.parse(localStorage.getItem(input.dataset.recent) || '[]'); } catch (_) {}
  const box = input.nextElementSibling, pl = box && box.querySelector('.rpl');
  if (!pl || !list.length) return;
  box.hidden = false;
  const paint = () => { pl.innerHTML = list.map((v, k) => `<button type="button" class="pchip${input.value.trim() === v ? ' on' : ''}" data-k="${k}" title="${esc(v)}">${esc(v.length > 42 ? v.slice(0, 40) + '…' : v)}</button>`).join(''); };
  paint();
  input.addEventListener('input', paint);
  pl.onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; const v = list[+b.dataset.k]; input.value = input.value.trim() === v ? '' : v; paint(); };
}

function askVars(title, vars, kind, defUdid) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    const fields = vars.map((v, i) => {
      const [label, ...opts] = v.slice(1, -1).split('|');
      const isPlace = /kam zverejniť/i.test(label);
      const ctl = isPlace ? placeHtml(`data-i="${i}"`) : opts.length
        ? `<select data-i="${i}">${opts.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
        : /dátum a čas/i.test(label) ? dtPicker(i)
        : /popis/i.test(label) ? `<textarea data-i="${i}" rows="3"></textarea>${kind ? capHtml() : ''}`
        : /pesnič/i.test(label) ? musicHtml(`data-i="${i}"`, kind === 'reel' || kind === 'carousel' ? 'nie' : '')
        : /^profil/i.test(label) ? `<input data-i="${i}" data-prof placeholder="napr. @sophieraiin – viac profilov oddeľ čiarkou"><div class="rprofs" data-rp hidden><small>Naposledy použité – klikni a vyber aj viac:</small><div class="rpl"></div></div>`
        : /^odkaz v story/i.test(label) ? `<input data-i="${i}" data-recent="jd-story-links" type="url" placeholder="https://…"><div class="rprofs" data-rp hidden><small>Naposledy použité – klikni a vlož:</small><div class="rpl"></div></div>`
        : /^text na tlačidle/i.test(label) ? `<input data-i="${i}" data-recent="jd-story-linktexts" placeholder="napr. Klikni sem"><div class="rprofs" data-rp hidden><small>Naposledy použité – klikni a vlož:</small><div class="rpl"></div></div>`
        : `<input data-i="${i}">`;
      const hint = /^odkaz v story/i.test(label) ? '<small class="hint">Prázdne = story bez odkazu. Odkaz sa pridá ako nálepka LINK, na ktorú ľudia ťuknú.</small>' : /^text na tlačidle/i.test(label) ? '<small class="hint">Prázdne = Instagram ukáže samotnú adresu odkazu.</small>' : /dátum a čas/i.test(label) ? '<small class="hint">Čas zadávaš slovenský. Meta dovolí naplánovať najskôr asi 20 minút dopredu.</small><small class="tolnote">⏱️ Čas sa nastaví s odchýlkou do ±10 minút – AI nedolaďuje minúty presne, aby plánovanie bolo rýchlejšie a lacnejšie.</small><small class="hint us-conv" data-conv></small>' : '';
      const isMus = /pesnič/i.test(label), tag = (kind && /popis/i.test(label)) || isMus || isPlace ? 'div' : 'label';
      return `<${tag} class="${tag === 'div' ? 'fld' : ''}"${tag === 'div' && !isMus && !isPlace ? ' data-capwrap' : ''}><span>${esc(isMus ? 'Hudba' : isPlace ? 'Kam zverejniť' : label.replace(/\s*\(napr\..*\)$/, ''))}</span>${ctl}${hint}</${tag}>`;
    }).join('');
    const phones = kind ? `<div class="fld"><span>Na ktorý telefón (môžeš vybrať viac)</span>${chipsHtml(defUdid ? [defUdid] : [])}</div>` : '';
    const drop = kind === 'story' ? phones + `<div class="fld"><span>Fotka alebo video (voliteľné)</span>${dropHtml(kind)}<small class="hint">Ak ju sem pretiahneš, najprv sa cez kábel pošle do galérie iPhonu ako najnovšia – AI ju tak dá do story. Inak použije najnovšiu fotku/video, ktoré už v iPhone sú.</small></div>`
      : kind ? phones + `<div class="fld"><span>${kind === 'reel' ? 'Video' : 'Fotky'} (voliteľné)</span>${dropHtml(kind)}<small class="hint">${kind === 'reel' ? 'Ak ho sem pretiahneš, pred plánovaním sa pošle' : 'Ak ich sem pretiahneš, pred plánovaním sa pošlú'} do galérie iPhonu ako najnovšie – AI tak vyberie presne ${kind === 'reel' ? 'toto video' : 'tieto fotky'}. Inak použije ${kind === 'reel' ? 'najnovšie video' : 'najnovšie fotky'}, ktoré už v iPhone sú.</small></div>` : '';
    bg.innerHTML = `<div class="modal"><div class="mhead"><h3>${esc(title)}</h3>${clockBox()}</div>${kind === 'reel' || kind === 'carousel' ? MBS_WARN : ''}${drop}${fields}<div class="mact"><button data-x>Zrušiť</button><button class="go" data-ok>Vložiť príkaz</button></div></div>`;
    const stopClock = startClock(bg);
    document.body.appendChild(bg);
    paintIcons(bg);
    const profIn = bg.querySelector('[data-prof]');
    if (profIn) wireRecentProfiles(bg, profIn);
    bg.querySelectorAll('[data-recent]').forEach((el) => wireRecent(el));
    const dst = kind ? attachDrop(bg.querySelector('[data-drop]'), (st) => {
      // carousel: počet fotiek = počet pretiahnutých fotiek
      if (kind !== 'carousel') return;
      const n = st.files.length, i = vars.findIndex((v) => /počet fotiek/i.test(v)), sel = i >= 0 && bg.querySelector(`[data-i="${i}"]`);
      if (sel) { if (n >= 1 && n <= 20) sel.value = String(n); sel.disabled = n > 0; }
    }) : null;
    if (kind) wireCaptions(bg, () => { const fl = dst ? dst.files.filter((x) => x.id) : []; return { udid: readChips(bg.querySelector('[data-ph]'))[0], kind, fileId: fl[0] && fl[0].id, fileName: fl[0] && fl[0].name, files: fl }; });
    const close = (val) => { stopClock(); bg.remove(); resolve(val); };
    bg.querySelector('[data-x]').onclick = () => close(null);
    bg.onclick = (e) => { if (e.target === bg) close(null); };
    bg.querySelector('[data-ok]').onclick = () => {
      const out = [];
      out.meta = { kind };
      const firstPhone = kind ? readChips(bg.querySelector('[data-ph]'))[0] : null;
      for (let i = 0; i < vars.length; i++) {
        const el = bg.querySelector(`[data-i="${i}"]`);
        if (el.dataset.dt !== undefined) {
          const dv = el.querySelector('[data-d]').value;
          const d = new Date(`${dv}T${el.querySelector('[data-h]').value}:${el.querySelector('[data-m]').value}`);
          if (!dv || isNaN(d)) { el.querySelector('[data-d]').focus(); return; }
          if (d < minSched()) { alert(`Tento čas je príliš skoro. Najskorší možný čas je ${fmtSk(minSched())}.`); el.querySelector('[data-h]').focus(); return; }
          out.push(fmtSk(d)); out.meta.when = d.toISOString(); out.meta.whenText = fmtSk(d);
        } else {
          const lab = vars[i], capW = /popis/i.test(lab) && el.closest('[data-capwrap]');
          out.push(el.classList.contains('plc') ? readPlace(el) : el.classList.contains('mus') ? readMusic(el) : capW ? applyTags(el.value, readTags(capW), fixedTagsOf(firstPhone)) : el.value);
          if (/popis/i.test(lab)) out.meta.caption = String(out[out.length - 1]).trim();
          else if (/pesnič/i.test(lab)) out.meta.music = out[out.length - 1];
          else if (/kam zverejniť/i.test(lab)) out.meta.place = out[out.length - 1];
        }
      }
      if (profIn) rememberProfiles(profIn.value);
      bg.querySelectorAll('[data-recent]').forEach((el) => rememberRecent(el.dataset.recent, el.value));
      if (kind) {
        out.phones = readChips(bg.querySelector('[data-ph]'));
        if (!out.phones.length) return alert('Vyber aspoň jeden telefón.');
      }
      if (dst) {
        if (!planReady(dst, kind === 'story' ? 'Story' : kind === 'reel' ? 'Video' : 'Fotky')) return;
        out.files = planFiles(dst);
        if (out.files.length > 20) return alert('Carousel môže mať najviac 20 fotiek.');
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
    if (r.steps && r.autoRun) {
      // Publikovať z karty Kontrola → plán sa spustí hneď, netreba klikať Spustiť
      runSteps(r.steps, defUdid);
      target.value = ''; toast(`🚀 Spustené: ${r.steps.length} ${r.steps.length === 1 ? 'príspevok' : r.steps.length < 5 ? 'príspevky' : 'príspevkov'} – priebeh uvidíš pri telefónoch.`);
      return true;
    }
    if (r.steps) target.dataset.plan = JSON.stringify(r.steps); else target.dataset.maxSteps = r.maxSteps;
    target.focus();
    return true;
  }
  delete target.dataset.maxSteps; delete target.dataset.plan;
  let text = t.text, files = [], phones = [], meta = null;
  const kind = /story/i.test(t.name) ? 'story' : /Meta Business Suite/.test(t.text) && /naplánuj/i.test(t.name) ? (/reel/i.test(t.name) ? 'reel' : /carousel/i.test(t.name) ? 'carousel' : null) : null;
  const vars = [...new Set(text.match(/\[[^\]]+\]/g) || [])];
  if (vars.length || kind) {
    const vals = await askVars(t.name, vars, kind, defUdid);
    if (!vals) return false;
    vars.forEach((v, i) => { text = text.split(v).join(vals[i]); });
    files = vals.files || []; phones = vals.phones || []; meta = vals.meta || null;
  }
  if (kind) {
    const title = splitName(t.name)[1];
    target.dataset.plan = JSON.stringify(phones.map((u) => ({ udid: u, title, task: text, files, maxSteps: 120, meta })));
    target.value = `📦 ${title} → ${phones.map(phoneLabel).join(', ')}` + (files.length ? `: najprv pošlem ${files.length === 1 ? files[0].name : files.length + ' fotiek'} do galérie (bude na 1. mieste), potom to AI ${kind === 'story' ? 'pridá do story' : 'naplánuje'}.` : '') + `\n(Tento text neupravuj – stlač Spustiť.)\n\n${text}`;
    target.focus();
    return true;
  }
  // prieskum: viac profilov / reelov = viac krokov pre AI
  const pm = text.match(/Profil na prieskum:\s*„([^“”"]*)[“”"]/), rm = text.match(/pozri\s+(\d+)\s+reel/i);
  if (pm && rm) { const np = Math.max(1, splitProfs(pm[1]).length); target.dataset.maxSteps = Math.min(400, Math.max(90, np * (+rm[1] * 4 + 15))); }
  target.value = text;
  target.focus();
  return true;
}

// ---------- úloha pre AI: naplánuj 1 reel / carousel v Meta Business Suite ----------
// x = { files, cap, mus, when (text), whenISO, cnt }; pick = null → médiá poslané pred tým (najnovšie), inak k-te najnovšie v telefóne
function postTask(isReel, place, x, pick, title) {
  // vždy album Recents / Nedávne (nikdy iné priečinky) – médiá poslané pred plánovaním sú v ňom ako prvé vľavo hore
  const REC = 'v galérii nechaj / prepni album na Recents / Nedávne (iný priečinok ani album – Videos, Favorites, Instagram… – NEPOUŽÍVAJ); ';
  const which = isReel
    ? REC + (pick && pick.k > 1 ? `vyber ${pick.k}. najnovšie VIDEO – počítaj od prvej položky vľavo hore, zľava doprava, zhora nadol a fotky preskakuj (video má na náhľade v rohu dĺžku, napr. 0:15); ťukni Next; `
      : 'vyber NAJNOVŠIE VIDEO – prvé video vľavo hore (video má na náhľade v rohu dĺžku, napr. 0:15; fotku nevyberaj); ťukni Next; ')
    : 'ťukni na pridanie fotiek; ' + REC + (pick && pick.from > 1 ? (x.cnt === 1 ? `vyber fotku č. ${pick.from} (počítané od najnovšej fotky vľavo hore, zľava doprava, zhora nadol; videá preskakuj); potvrď výber; ` : `vyber fotky č. ${pick.from} až ${pick.from + x.cnt - 1} (počítané od najnovšej fotky vľavo hore, zľava doprava, zhora nadol; videá preskakuj) v tomto poradí; potvrď výber; `)
      : (x.cnt === 1 ? 'vyber 1 fotku – NAJNOVŠIU (prvá fotka vľavo hore; video nevyberaj); potvrď výber; ' : `vyber ${x.cnt} najnovších fotiek v poradí – začni prvou fotkou vľavo hore (najnovšia), pokračuj zľava doprava, videá preskakuj; potvrď výber; `));
  return { title, files: x.files, maxSteps: isReel ? 110 : 130,
    meta: { kind: isReel ? 'reel' : 'carousel', when: x.whenISO, whenText: x.when, caption: x.cap, music: x.mus, place }, task:
    `Otvor aplikáciu Meta Business Suite. Naplánuj 1 ${isReel ? 'reel' : 'carousel'}: ťukni na „+“ / „Create“ a vyber ${isReel ? 'Reel' : 'Post / Príspevok'}; pri účtoch / umiestneniach nastav: ${place}; ` + which +
    `${MUSIC_RULE} Hudba: „${x.mus}“. Napíš presne tento popis: „${x.cap}“. Ak je možnosť označiť obsah ako vytvorený AI (AI info / AI label), zapni ju. ` +
    `Otvor „Scheduling options“ / „Možnosti plánovania“, vyber „Schedule for later“, nastav dátum a čas: ${x.when} a ťukni „Schedule“ – NIKDY „Publish now“. ` +
    'Čas NEMUSÍ byť presný na minútu – stačí odchýlka do ±10 minút (dátum a hodina musia sedieť); minúty nastav jedným-dvoma potiahnutiami na najbližšiu hodnotu a nestrácaj čas presným dolaďovaním. ' +
    'Na konci otvor plánovač (Planner / Content → Scheduled) a over, že príspevok je naplánovaný na správny deň a čas (±10 minút je v poriadku). Ak sa niečo nepodarí, nič nezverejňuj a skonči so správou, kde si sa zasekol.' };
}

// ---------- hudba: klikacie možnosti namiesto písania ----------
// '' = prvá pesnička v ponuke, 'nie' = bez hudby, inak názov pesničky (naposledy použité sa ponúknu samé)
let RECENT_MUSIC = [];
async function loadRecentMusic() {
  try {
    const l = await (await fetch('/api/calendar')).json(), seen = [];
    for (const x of l.slice().reverse()) { const m = String(x.music || '').trim(); if (m && !/^nie$/i.test(m) && !seen.some((s) => s.toLowerCase() === m.toLowerCase())) seen.push(m); if (seen.length >= 8) break; }
    RECENT_MUSIC = seen;
  } catch (_) {}
}
loadRecentMusic();
function musicHtml(extra = 'data-mus', def = '') {
  const off = def === 'nie';
  return `<div class="mus" ${extra}><div class="muschips">
    <button type="button" class="musc${off ? '' : ' on'}" data-mv="">🔥 Prvá v ponuke</button><button type="button" class="musc${off ? ' on' : ''}" data-mv="nie">🔇 Bez hudby</button>
    ${RECENT_MUSIC.map((m) => `<button type="button" class="musc" data-mv="${esc(m)}" title="Naposledy použitá">🎵 ${esc(m)}</button>`).join('')}
    <button type="button" class="musc" data-mv="__own">✏️ Iná pesnička…</button></div>
    <input class="musown" placeholder="Názov pesničky – interpret" hidden></div>`;
}
const readMusic = (box) => { if (!box) return ''; const on = box.querySelector('.musc.on'), v = on ? on.dataset.mv : ''; return v === '__own' ? box.querySelector('.musown').value.trim() : v; };
function setMusic(box, val) {
  if (!box) return; val = String(val || '').trim();
  let b = [...box.querySelectorAll('.musc')].find((x) => x.dataset.mv !== '__own' && x.dataset.mv.toLowerCase() === val.toLowerCase());
  if (!b) { b = box.querySelector('[data-mv="__own"]'); box.querySelector('.musown').value = val; }
  box.querySelectorAll('.musc').forEach((x) => x.classList.toggle('on', x === b));
  box.querySelector('.musown').hidden = b.dataset.mv !== '__own';
}
const musicLabel = (v) => !v ? 'prvá v ponuke' : /^nie$/i.test(v) ? 'bez hudby' : v;
document.addEventListener('click', (e) => {
  const b = e.target.closest('.musc'); if (!b) return;
  const box = b.closest('.mus');
  box.querySelectorAll('.musc').forEach((x) => x.classList.toggle('on', x === b));
  const own = box.querySelector('.musown'); own.hidden = b.dataset.mv !== '__own'; if (!own.hidden) own.focus();
});

// ---------- plánovač: 1 až 10 reelov / carouselov v jednom kroku (Meta Business Suite) ----------
const MUSIC_RULE = 'Ak editor ponúka hudbu (Audio / Music): pri hudbe „nie“ hudbu nepridávaj; pri prázdnej nič nevyhľadávaj a vyber úplne prvú pesničku v ponuke (For you / Trending); inak napíš názov pesničky do vyhľadávania a vyber výsledok so správnym interpretom (ak sa nedá nájsť, prvú v ponuke); ponechaj predvolený úsek a ťukni Done. Ak hudbu neponúka, pokračuj bez nej.';
function askMulti(t, defUdid) {
  // každý príspevok má vlastný typ: 🎬 reel alebo 🖼️ carousel (1 až 10 príspevkov naraz)
  const defKind = t.multi === 'carousel' ? 'carousel' : 'reel';
  const nounOf = (k) => (k === 'reel' ? 'Reel' : 'Carousel');
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal multi"><div class="mhead"><h3>${esc(t.name)}</h3>${clockBox()}</div>${MBS_WARN}
      <div class="mrow2"><label><span>Koľko príspevkov</span><select data-n>${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option>${n}</option>`).join('')}</select></label>
        </div><div class="fld"><span>Kam zverejniť</span>${placeHtml()}${xToggleHtml()}</div>
      <div class="fld" data-allph><span>Telefón pre všetky (alebo vyber pri každom zvlášť nižšie)</span>${chipsHtml([], 'data-allbox')}</div>
      <small class="tolnote">⏱️ Čas sa nastaví s odchýlkou do ±10 minút – AI nedolaďuje minúty presne, aby plánovanie bolo rýchlejšie a lacnejšie.</small>
      <small class="hint">Pri každom príspevku vyber, či je to <b>reel</b> alebo <b>carousel</b>, a pretiahni k nemu video / fotky – pred plánovaním sa pošlú do galérie iPhonu ako najnovšie, takže AI vyberie presne ich. Bez médií: použijú sa najnovšie videá / fotky, ktoré už sú v iPhone. Čas zadávaš slovenský, najskôr ~20 min dopredu.</small>
      <div class="mitems" data-items></div>
      <div class="mact"><button data-x>Zrušiť</button><button class="go" data-ok>Kontrola →</button></div></div>`;
    document.body.appendChild(bg);
    const stopClock = startClock(bg);
    const items = bg.querySelector('[data-items]');
    const kinds = [], drops = [];
    const render = () => {
      const n = +bg.querySelector('[data-n]').value, old = [...items.querySelectorAll('.mitem2')].map((el) => ({
        ph: readChips(el.querySelector('[data-ph]')),
        cap: el.querySelector('[data-cap]').value, tags: readTags(el.querySelector('[data-capwrap]')), mus: readMusic(el.querySelector('[data-mus]')), cnt: el.querySelector('[data-cnt]')?.value,
        d: el.querySelector('[data-d]').value, h: el.querySelector('[data-h]').value, m: el.querySelector('[data-m]').value }));
      for (let i = kinds.length; i < n; i++) kinds[i] = kinds[i - 1] || defKind; // nový príspevok = typ ako predchádzajúci
      kinds.length = n;
      const base = new Date(Date.now() + 30 * 60000); // dnes – prvý príspevok o ~30 min, ďalšie vždy o hodinu neskôr (zmeň si podľa seba)
      items.innerHTML = [...Array(n)].map((_, i) => {
        const k = kinds[i], isReel = k === 'reel';
        const def = new Date(base.getTime() + i * 3600000);
        return `<div class="mitem2"><div class="mtit">${n > 1 ? `Príspevok ${i + 1}` : 'Príspevok'}</div>
          <div class="mkinds"><button type="button" class="mkind${isReel ? ' on' : ''}" data-kind="reel">🎬 Reel<small>1 video</small></button><button type="button" class="mkind${isReel ? '' : ' on'}" data-kind="carousel">🖼️ Carousel<small>1 až 20 fotiek</small></button></div>
          <div class="fld"><span>Telefón</span>${chipsHtml(defUdid ? [defUdid] : [])}</div>${dropHtml(k)}
          ${isReel ? '' : `<label><span>Počet fotiek</span><select data-cnt>${Array.from({ length: 20 }, (_, k) => k + 1).map((c) => `<option${c === 3 ? ' selected' : ''}>${c}</option>`).join('')}</select></label>`}
          <div class="fld" data-capwrap><span>Popis + #hashtagy</span><textarea data-cap rows="2"></textarea>${capHtml()}</div>
          <div class="fld"><span>Hudba</span>${musicHtml('data-mus', 'nie')}</div>
          <label><span>Dátum a čas</span>${dtPicker(i, def)}<small class="hint us-conv" data-conv></small></label></div>`;
      }).join('');
      old.forEach((o, i) => { const el = items.children[i]; if (!el) return;
        el.querySelectorAll('[data-ph] .phc').forEach((b) => b.classList.toggle('on', o.ph.includes(b.dataset.u)));
        el.querySelector('[data-cap]').value = o.cap; setMusic(el.querySelector('[data-mus]'), o.mus); setTags(el.querySelector('[data-tags]'), o.tags);
        if (o.cnt && el.querySelector('[data-cnt]')) el.querySelector('[data-cnt]').value = o.cnt;
        el.querySelector('[data-d]').value = o.d; el.querySelector('[data-h]').value = o.h; el.querySelector('[data-m]').value = o.m; });
      paintIcons(items);
      // štvorčeky na médiá (súbory ostanú aj po zmene počtu)
      [...items.children].forEach((el, i) => {
        drops[i] = attachDrop(el.querySelector('[data-drop]'), (s2) => {
          const sel = el.querySelector('[data-cnt]'); if (!sel) return;
          const c = s2.files.length; if (c >= 1 && c <= 20) sel.value = String(c); sel.disabled = c > 0;
        }, drops[i]);
      });
      drops.length = items.children.length;
      updateConv(bg);
    };
    wireCaptions(items, (wrap) => {
      const el = wrap.closest('.mitem2'), i = [...items.children].indexOf(el), fl = drops[i] ? drops[i].files.filter((x) => x.id) : [];
      return { udid: readChips(el.querySelector('[data-ph]'))[0], kind: kinds[i], fileId: fl[0] && fl[0].id, fileName: fl[0] && fl[0].name, files: fl };
    });
    // prepnutie reel ↔ carousel pri jednom príspevku (médiá iného typu sa zahodia)
    items.addEventListener('click', (e) => {
      const b = e.target.closest('.mkind'); if (!b) return;
      const i = [...items.children].indexOf(b.closest('.mitem2'));
      if (i < 0 || kinds[i] === b.dataset.kind) return;
      kinds[i] = b.dataset.kind; drops[i] = null;
      render();
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
    bg.querySelector('[data-ok]').onclick = () => {
      const place = readPlace(bg.querySelector('[data-place]')), wantX = readX(bg), list = [];
      const lbl = (i) => (items.children.length > 1 ? `Príspevok ${i + 1} (${nounOf(kinds[i]).toLowerCase()})` : nounOf(kinds[i]));
      for (const [i] of [...items.children].entries()) if (!planReady(drops[i], lbl(i))) return;
      const withFiles = drops.filter((st) => planFiles(st).length).length;
      if (withFiles && withFiles < drops.length) return alert('Pretiahni video / fotky ku každému príspevku – alebo ku žiadnemu (vtedy sa použijú médiá, ktoré už sú v iPhone).');
      for (const [i, el] of [...items.children].entries()) {
        const isReel = kinds[i] === 'reel';
        const d = dtpValue(el.querySelector('.dtp'));
        if (isNaN(d)) return alert(`${lbl(i)}: vyber dátum.`);
        if (d < minSched()) return alert(`${lbl(i)}: čas je príliš skoro. Najskorší možný čas je ${fmtSk(minSched())}.`);
        const fl = planFiles(drops[i]);
        if (!isReel && fl.length > 20) return alert(`${lbl(i)}: carousel môže mať najviac 20 fotiek.`);
        const cnt = isReel ? 1 : (fl.length || +el.querySelector('[data-cnt]').value);
        const ph = readChips(el.querySelector('[data-ph]'));
        if (!ph.length) return alert(`${lbl(i)}: vyber telefón.`);
        list.push({ isReel, whenISO: d.toISOString(), ph, files: fl, cap: applyTags(el.querySelector('[data-cap]').value, readTags(el.querySelector('[data-capwrap]')), fixedTagsOf(ph[0])), mus: readMusic(el.querySelector('[data-mus]')), when: fmtSk(d), cnt });
      }
      if (!dupCheck(list.map((x) => ({ files: x.files, phones: x.ph })))) return;
      // plán: každý príspevok zvlášť (na svojom telefóne) – najprv jeho médiá do galérie, potom ho AI naplánuje.
      // Bez médií: pre každý telefón sa počíta poradie zvlášť – videá (1. reel = najnovšie video…) aj fotky (carousely idú po sebe)
      const seen = new Map(), steps = [];
      list.forEach((x, i) => x.ph.forEach((u) => {
        const o = seen.get(u) || { v: 0, from: 1 };
        const pick = x.files.length ? null : (x.isReel ? { k: o.v + 1 } : { from: o.from });
        seen.set(u, x.isReel ? { v: o.v + 1, from: o.from } : { v: o.v, from: o.from + x.cnt });
        const title = list.length > 1 ? `${nounOf(x.isReel ? 'reel' : 'carousel')} ${i + 1}` : nounOf(x.isReel ? 'reel' : 'carousel');
        steps.push({ udid: u, ...postTask(x.isReel, place, x, pick, title) });
        if (wantX) steps.push({ udid: u, ...postTaskX(x.isReel, x, pick, title) });
      }));
      const nR = list.filter((x) => x.isReel).length, nC = list.length - nR;
      const what = [nR ? `${nR} ${nR === 1 ? 'reel' : nR < 5 ? 'reely' : 'reelov'}` : '', nC ? `${nC} ${nC === 1 ? 'carousel' : nC < 5 ? 'carousely' : 'carouselov'}` : ''].filter(Boolean).join(' + ');
      const summary = `📦 Plán: ${what} v Meta Business Suite` + (withFiles ? '. Pred každým pošlem jeho médiá do galérie (budú na 1. mieste), potom ho AI naplánuje' : '') + ':\n' +
        list.map((x, i) => `${i + 1}. ${x.isReel ? '🎬' : '🖼️'} ${x.ph.map(phoneLabel).join(' + ')} · ${x.when}${x.files.length ? ' – ' + x.files.map((f) => f.name).join(', ') : ''}${x.cap ? ' – „' + x.cap.slice(0, 40) + (x.cap.length > 40 ? '…' : '') + '“' : ''}`).join('\n') + '\n(Tento text neupravuj – stlač Spustiť.)';
      showReview(list, place + (wantX ? ' + 𝕏 X (Twitter)' : ''), steps, summary);
    };
    // ---------- karta Kontrola: všetko ešte raz prehľadne, potom Publikovať = hneď sa spustí ----------
    const showReview = (list, place, steps, summary) => {
      const modal = bg.querySelector('.modal');
      const form = [...modal.children].filter((x) => !x.classList.contains('mhead'));
      const convs = [...items.children].map((el) => (el.querySelector('[data-conv]') || {}).textContent || '');
      // náhľad médií príspevku (video sa dá prehrať)
      const prevHtml = (i) => {
        const fs = ((drops[i] && drops[i].files) || []).filter((f) => f.id && (f.url || f.id));
        if (!fs.length) return '<div class="mrv-prev none">Bez náhľadu – AI použije najnovšie médiá, ktoré už sú v iPhone.</div>';
        return `<div class="mrv-prev">${fs.map((f) => { const u = f.url || `/lib/${f.id}`; return f.video
          ? `<video src="${esc(u)}#t=0.1" controls muted playsinline preload="metadata"></video>` : `<img src="${esc(u)}" alt="" loading="lazy">`; }).join('')}</div>`;
      };
      const musTxt = (m) => (!m ? '🔥 prvá pesnička v ponuke' : /^nie$/i.test(m) ? '🔇 bez hudby' : '🎵 ' + m);
      const rv = document.createElement('div'); rv.className = 'mreview';
      rv.innerHTML = `<div class="mrv-h"><b>Kontrola</b> – skontroluj časy a nastavenia. Po kliknutí na <b>Publikovať</b> sa plán hneď spustí na telefónoch. Časy sa nastavia s odchýlkou do ±10 minút.</div>
        <div class="kv"><span>Kam zverejniť</span><b>${esc(place)}</b></div>
        ${list.map((x, i) => `<div class="mrv-it"><div class="mrv-t">${x.isReel ? '🎬 Reel' : `🖼️ Carousel · ${x.cnt} ${x.cnt === 1 ? 'fotka' : x.cnt < 5 ? 'fotky' : 'fotiek'}`}${list.length > 1 ? ` <small>príspevok ${i + 1}</small>` : ''}</div>
          <div class="kv"><span>📅 Čas (Slovensko)</span><b>${esc(x.when)} <small class="tolx">±10 min</small></b></div>${convs[i] ? `<div class="mrv-conv">${esc(convs[i])}</div>` : ''}
          <div class="kv"><span>📱 Telefón</span><b>${x.ph.map((u) => esc(phoneLabel(u))).join(', ')}</b></div>
          <div class="kv"><span>🎵 Hudba</span><b>${esc(musTxt(x.mus))}</b></div>
          <div class="kv"><span>🎞️ Médiá</span><b>${x.files.length ? x.files.map((f) => esc(f.name)).join(', ') : 'najnovšie v galérii iPhonu'}</b></div>
          ${prevHtml(i)}
          <div class="mrv-cap">${x.cap ? esc(x.cap) : '<i>bez popisu</i>'}</div>${/𝕏/.test(place) && (x.cap || '').length > X_MAX ? `<div class="mrv-conv" style="text-align:left">𝕏 Na X sa popis skráti na ${X_MAX} znakov.</div>` : ''}</div>`).join('')}
        <div class="mact"><button data-back>← Upraviť</button><span class="sp"></span><button class="go" data-pub>🚀 Publikovať</button></div>`;
      form.forEach((x) => (x.hidden = true));
      modal.appendChild(rv); modal.scrollTop = 0;
      rv.querySelector('[data-back]').onclick = () => { rv.remove(); form.forEach((x) => (x.hidden = false)); };
      rv.querySelector('[data-pub]').onclick = () => close({ text: summary, steps, autoRun: true });
    };
  });
}

// sklenené okno so šablónami ako dlaždicami
const splitName = (n) => { const m = n.match(/^(\S+)\s+(.*)$/); return m && !/[A-Za-zÀ-ž0-9]/.test(m[1]) ? [m[1], m[2]] : ['✦', n]; };
function pickTemplate(target, phoneLabel) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const render = () => {
    bg.innerHTML = `<div class="modal picker"><div class="phead"><div><h3>Šablóny</h3><div class="sub">${phoneLabel ? 'Len pre telefón <b>' + esc(phoneLabel) + '</b>' : '<b class="allph">Pre VŠETKY iPhony naraz</b> – úloha sa spustí na každom pripojenom telefóne'} · vyber, čo má AI urobiť</div></div>
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
  const net = document.getElementById('net'), bad = (data.devices || []).filter((d) => d.usb && !/funguje/.test(d.usb));
  net.className = 'chip ' + (bad.length ? 'warn' : 'ok');
  net.innerHTML = icon('image') + (bad.length ? `Médiá cez kábel – problém: ${esc(bad.map((d) => d.label).join(', '))}` : 'Médiá cez kábel');
  net.title = bad.map((d) => `${d.label}: ${d.usb}`).join('\n');

  const seen = new Set();
  for (const d of data.devices) {
    seen.add(d.udid);
    let c = cards.get(d.udid);
    if (!c) { c = makeCard(d); cards.set(d.udid, c); }
    c.d = d;
    const pf = d.profile || {}, nm = `${esc(d.label)}${pf.handle ? ` <small>@${esc(pf.handle)}</small>` : ''}`;
    if (c.name.dataset.h !== nm) { c.name.innerHTML = nm; c.name.dataset.h = nm; }
    c.el.style.setProperty('--pc', pf.color || 'transparent');
    const inf = d.info || {}, bits = [];
    if (inf.battery != null) bits.push(`<span class="${inf.battery < 15 && !inf.charging ? 'crit' : inf.battery < 30 && !inf.charging ? 'lo' : ''}" title="Batéria">${inf.charging ? '⚡' : '🔋'}${inf.battery}%</span>`);
    if (inf.freeGB != null) bits.push(`<span class="${inf.freeGB < 1 ? 'crit' : inf.freeGB < 3 ? 'lo' : ''}" title="Voľné miesto v iPhone">💾${inf.freeGB} GB</span>`);
    c.ver.textContent = d.version ? 'iOS ' + d.version : '';
    const vh = bits.join('');
    if (c.pstat.dataset.h !== vh) { c.pstat.innerHTML = vh; c.pstat.dataset.h = vh; c.pstat.hidden = !vh; }
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
  if (!list.length) { if (!grid.querySelector('.empty')) { grid.innerHTML = '<div class="empty">Žiadny iPhone. Pripoj ho USB káblom, odomkni a potvrď „Dôverovať tomuto počítaču“.</div>'; } grid.appendChild(addCard); }
  else {
    grid.querySelector('.empty')?.remove();
    const want = [...list.map((c) => c.el), addCard], cur = [...grid.children];
    if (cur.length !== want.length || want.some((el, i) => cur[i] !== el)) want.forEach((el) => grid.appendChild(el));
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
