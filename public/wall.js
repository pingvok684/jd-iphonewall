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
    post(d.udid, 'agent', { task, maxSteps: c.task.dataset.maxSteps ? +c.task.dataset.maxSteps : undefined }).then(() => setTimeout(poll, 300));
  };
  c.task.addEventListener('input', () => { if (!c.task.value.trim()) delete c.task.dataset.maxSteps; });
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
  c.name.ondblclick = async () => {
    const v = prompt('Názov telefónu:', c.d.label);
    if (v != null) { await post(d.udid, 'label', { label: v }); c.name.textContent = v; }
  };
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

// okno na vyplnenie [premenných]; [Názov|a|b|c] = rolovacie menu s možnosťami
function askVars(title, vars) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    const fields = vars.map((v, i) => {
      const [label, ...opts] = v.slice(1, -1).split('|');
      const ctl = opts.length
        ? `<select data-i="${i}">${opts.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
        : /dátum a čas/i.test(label) ? dtPicker(i)
        : /popis/i.test(label) ? `<textarea data-i="${i}" rows="3"></textarea>` : `<input data-i="${i}">`;
      const hint = /dátum a čas/i.test(label) ? '<small class="hint">Čas zadávaš slovenský. Meta dovolí naplánovať najskôr asi 20 minút dopredu.</small><small class="hint us-conv" data-conv></small>' : '';
      return `<label><span>${esc(label.replace(/\s*\(napr\..*\)$/, ''))}</span>${ctl}${hint}</label>`;
    }).join('');
    bg.innerHTML = `<div class="modal"><div class="mhead"><h3>${esc(title)}</h3>${clockBox()}</div>${fields}<div class="mact"><button data-x>Zrušiť</button><button class="go" data-ok>Vložiť príkaz</button></div></div>`;
    const stopClock = startClock(bg);
    document.body.appendChild(bg);
    const close = (val) => { stopClock(); bg.remove(); resolve(val); };
    bg.querySelector('[data-x]').onclick = () => close(null);
    bg.onclick = (e) => { if (e.target === bg) close(null); };
    bg.querySelector('[data-ok]').onclick = () => {
      const out = [];
      for (let i = 0; i < vars.length; i++) {
        const el = bg.querySelector(`[data-i="${i}"]`);
        if (el.dataset.dt !== undefined) {
          const dv = el.querySelector('[data-d]').value;
          const d = new Date(`${dv}T${el.querySelector('[data-h]').value}:${el.querySelector('[data-m]').value}`);
          if (!dv || isNaN(d)) { el.querySelector('[data-d]').focus(); return; }
          if (d < minSched()) { alert(`Tento čas je príliš skoro. Najskorší možný čas je ${fmtSk(minSched())}.`); el.querySelector('[data-h]').focus(); return; }
          out.push(fmtSk(d));
        } else out.push(el.value);
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
  if (t.multi) {
    const r = await askMulti(t);
    if (!r) return false;
    target.value = r.text; target.dataset.maxSteps = r.maxSteps; target.focus();
    return true;
  }
  delete target.dataset.maxSteps;
  let text = t.text;
  const vars = [...new Set(text.match(/\[[^\]]+\]/g) || [])];
  if (vars.length) {
    const vals = await askVars(t.name, vars);
    if (!vals) return false;
    vars.forEach((v, i) => { text = text.split(v).join(vals[i]); });
  }
  target.value = text;
  target.focus();
  return true;
}

// ---------- viac reelov / carouselov v jednom kroku (plánovač Meta Business Suite) ----------
const MUSIC_RULE = 'Ak editor ponúka hudbu (Audio / Music): pri hudbe „nie“ hudbu nepridávaj; pri prázdnej nič nevyhľadávaj a vyber úplne prvú pesničku v ponuke (For you / Trending); inak napíš názov pesničky do vyhľadávania a vyber výsledok so správnym interpretom (ak sa nedá nájsť, prvú v ponuke); ponechaj predvolený úsek a ťukni Done. Ak hudbu neponúka, pokračuj bez nej.';
function askMulti(t) {
  const isReel = t.multi === 'reel', noun = isReel ? 'Reel' : 'Carousel';
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal multi"><div class="mhead"><h3>${esc(t.name)}</h3>${clockBox()}</div>
      <div class="mrow2"><label><span>Koľko ${isReel ? 'reelov' : 'carouselov'}</span><select data-n>${[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option>${n}</option>`).join('')}</select></label>
        <label><span>Kam zverejniť</span><select data-place><option>Len Instagram</option><option>Instagram aj Facebook</option></select></label></div>
      <small class="hint">${isReel ? 'Reel 1 použije najnovšie video v galérii, Reel 2 druhé najnovšie atď. Videá teda nahraj do telefónu v opačnom poradí (posledné nahraté = Reel 1).'
        : 'Carousel 1 použije najnovšie fotky, ďalší nasledujúce fotky v poradí. Fotky nahraj do telefónu tak, aby najnovšie patrili carouselu 1.'} Čas zadávaš slovenský, najskôr ~20 min dopredu.</small>
      <div class="mitems" data-items></div>
      <div class="mact"><button data-x>Zrušiť</button><button class="go" data-ok>Vložiť príkaz</button></div></div>`;
    document.body.appendChild(bg);
    const stopClock = startClock(bg);
    const items = bg.querySelector('[data-items]');
    const render = () => {
      const n = +bg.querySelector('[data-n]').value, old = [...items.querySelectorAll('.mitem2')].map((el) => ({
        cap: el.querySelector('[data-cap]').value, mus: el.querySelector('[data-mus]').value, cnt: el.querySelector('[data-cnt]')?.value,
        d: el.querySelector('[data-d]').value, h: el.querySelector('[data-h]').value, m: el.querySelector('[data-m]').value }));
      const base = new Date(Date.now() + 30 * 60000);
      items.innerHTML = [...Array(n)].map((_, i) => {
        const def = new Date(base.getTime() + i * 24 * 3600000); // predvolene každý deň v rovnakom čase – uprav si podľa seba
        return `<div class="mitem2"><div class="mtit">${noun} ${i + 1}${isReel ? (i === 0 ? ' · najnovšie video' : ` · ${i + 1}. najnovšie video`) : ''}</div>
          ${isReel ? '' : `<label><span>Počet fotiek</span><select data-cnt>${[2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => `<option${k === 3 ? ' selected' : ''}>${k}</option>`).join('')}</select></label>`}
          <label><span>Popis + #hashtagy</span><textarea data-cap rows="2"></textarea></label>
          <label><span>Pesnička (prázdne = prvá v ponuke, nie = bez hudby)</span><input data-mus></label>
          <label><span>Dátum a čas</span>${dtPicker(i, def)}<small class="hint us-conv" data-conv></small></label></div>`;
      }).join('');
      old.forEach((o, i) => { const el = items.children[i]; if (!el) return;
        el.querySelector('[data-cap]').value = o.cap; el.querySelector('[data-mus]').value = o.mus;
        if (o.cnt && el.querySelector('[data-cnt]')) el.querySelector('[data-cnt]').value = o.cnt;
        el.querySelector('[data-d]').value = o.d; el.querySelector('[data-h]').value = o.h; el.querySelector('[data-m]').value = o.m; });
      updateConv(bg);
    };
    bg.querySelector('[data-n]').onchange = render;
    render();
    const close = (v) => { stopClock(); bg.remove(); resolve(v); };
    bg.querySelector('[data-x]').onclick = () => close(null);
    bg.onclick = (e) => { if (e.target === bg) close(null); };
    bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
    bg.querySelector('[data-ok]').onclick = () => {
      const place = bg.querySelector('[data-place]').value, list = [];
      let photoStart = 1;
      for (const [i, el] of [...items.children].entries()) {
        const d = dtpValue(el.querySelector('.dtp'));
        if (isNaN(d)) return alert(`${noun} ${i + 1}: vyber dátum.`);
        if (d < minSched()) return alert(`${noun} ${i + 1}: čas je príliš skoro. Najskorší možný čas je ${fmtSk(minSched())}.`);
        const cnt = isReel ? 1 : +el.querySelector('[data-cnt]').value;
        list.push({ cap: el.querySelector('[data-cap]').value.trim(), mus: el.querySelector('[data-mus]').value.trim(), when: fmtSk(d), cnt, from: photoStart });
        photoStart += cnt;
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
    showMsg('Server nebeží. Spusti START_STRANKY.command.');
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
    c.name.textContent = d.label;
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
  for (const c of cards.values()) if (c.d.wdaOk && !(c.d.agent && c.d.agent.running)) post(c.d.udid, 'agent', { task });
  setTimeout(poll, 300);
};
gtask.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('gbtn').click(); });
document.getElementById('gtpl').onclick = () => pickTemplate(gtask, null);

// štart
window.addEventListener('hashchange', () => setTimeout(poll, 50));
loadTemplates().then(() => { route(); poll(); });
setInterval(poll, 3000);
setInterval(() => { if (view === 'prehlad') loadOverview(); else if (view === 'aktivita') loadActivity(); }, 6000);
setInterval(() => { if (view === 'magnific') loadMagnific(); }, 4000);
