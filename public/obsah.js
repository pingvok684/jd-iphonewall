// Kalendár, Knižnica médií, Štatistiky, Prieskumy a profily telefónov.
const OB = { week: 0, libFilter: 'all', statsPhone: '' };
const jfetch = async (u, body) => {
  const r = await fetch(u, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Chyba');
  return j;
};
const PALETTE = ['#ff4f76', '#3987e5', '#3ddc97', '#ffb547', '#a46bff', '#2ec7d6', '#ff8a3d', '#e5e7eb'];
const devsAll = () => phoneList();
// farba telefónu: z profilu, inak prvá voľná z palety (nech sa telefóny nelíšia len názvom)
const devColor = (udid, i = 0) => {
  const own = ((devsAll().find((d) => d.udid === udid) || {}).profile || {}).color;
  if (own) return own;
  const taken = new Set(devsAll().map((d) => d.profile && d.profile.color).filter(Boolean));
  const free = PALETTE.filter((c) => !taken.has(c));
  return (free.length ? free : PALETTE)[i % (free.length || PALETTE.length)];
};
const dts = (d) => new Date(d).toLocaleString('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const DOW = ['ne', 'po', 'ut', 'st', 'št', 'pi', 'so'];
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const STATUS = { 'čaká': 'wait', 'naplánované': 'ok', 'chyba': 'bad', 'nespustené': 'off' };

// ---------- profil telefónu ----------
function openProfile(d) {
  if (!d) return;
  const p = d.profile || {};
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><div class="mhead"><h3>Profil telefónu</h3></div>
    <label><span>Názov telefónu</span><input data-f="label" value="${esc(d.label)}" placeholder="napr. Lara 1"></label>
    <label><span>Instagram účet</span><input data-f="handle" value="${esc(p.handle || '')}" placeholder="@ucet"></label>
    <div class="fld"><span>Farba</span><div class="pcolors">${PALETTE.map((c) => `<button type="button" class="pcol${(p.color || '') === c ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div></div>
    <label><span>Poznámka / štýl účtu (použije sa pri návrhoch popisov)</span><textarea data-f="note" rows="3" placeholder="napr. hravý tón, anglicky, emoji áno, téma fitness">${esc(p.note || '')}</textarea></label>
    <div class="mact"><button data-x>Zrušiť</button><button class="go" data-ok>Uložiť</button></div></div>`;
  document.body.appendChild(bg);
  let color = p.color || '';
  bg.querySelector('.pcolors').onclick = (e) => { const b = e.target.closest('.pcol'); if (!b) return; color = b.dataset.c; bg.querySelectorAll('.pcol').forEach((x) => x.classList.toggle('on', x === b)); };
  const close = () => bg.remove();
  bg.querySelector('[data-x]').onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
  bg.querySelector('[data-ok]').onclick = async () => {
    const v = (f) => bg.querySelector(`[data-f="${f}"]`).value;
    try { await jfetch('/api/profile', { udid: d.udid, label: v('label'), handle: v('handle'), note: v('note'), color }); close(); poll(); }
    catch (e) { alert(e.message); }
  };
  bg.querySelector('input').focus();
}

// ---------- KALENDÁR ----------
async function loadCalendar() {
  const start = dayStart(new Date()); start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + OB.week * 7); // pondelok
  const end = new Date(start); end.setDate(end.getDate() + 7);
  let list = []; try { list = await jfetch(`/api/calendar?from=${start.toISOString()}&to=${end.toISOString()}`); } catch (_) {}
  const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  document.getElementById('calRange').textContent = `${days[0].toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric' })} – ${days[6].toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric' })}`;
  // riadky = telefóny (pripojené + tie, ktoré majú v týždni príspevok)
  const rows = devsAll().map((d) => ({ udid: d.udid, label: fullLabel(d) }));
  for (const e of list) if (!rows.some((r) => r.udid === e.udid)) rows.push({ udid: e.udid, label: e.phone || 'telefón' });
  const today = dayStart(new Date()).getTime();
  const head = `<div class="cg-h"></div>` + days.map((d) => `<div class="cg-h${d.getTime() === today ? ' today' : ''}"><b>${DOW[d.getDay()]}</b> ${d.getDate()}. ${d.getMonth() + 1}.</div>`).join('');
  const body = rows.map((r, ri) => `<div class="cg-ph" style="--pc:${devColor(r.udid, ri)}"><i class="pcd"></i>${esc(r.label)}</div>` + days.map((d) => {
    const items = list.filter((e) => e.udid === r.udid && dayStart(e.when).getTime() === d.getTime()).sort((a, b) => a.when.localeCompare(b.when));
    const past = d.getTime() < today;
    return `<div class="cg-c${items.length ? '' : ' cg-empty'}${past ? ' past' : ''}">${items.map((e) => `<button type="button" class="ce s-${STATUS[e.status] || 'off'}" data-ce="${e.id}" style="--pc:${devColor(r.udid, ri)}">
      <b>${hm(new Date(e.when))}</b> ${e.kind === 'carousel' ? '🖼️' : '🎬'} <span>${esc(e.caption ? e.caption.slice(0, 40) : (e.kind || 'príspevok'))}</span></button>`).join('') || (past ? '' : '<span class="cg-free">voľno</span>')}</div>`;
  }).join('')).join('');
  const grid = document.getElementById('calGrid');
  grid.innerHTML = rows.length ? `<div class="cg">${head}${body}</div>` : '<div class="empty">Žiadny telefón ani naplánovaný príspevok v tomto týždni.</div>';
  grid.onclick = (e) => { const b = e.target.closest('[data-ce]'); if (b) openCalEntry(list.find((x) => x.id === b.dataset.ce)); };
  const free = rows.map((r) => ({ r, n: days.filter((d) => d.getTime() >= today && !list.some((e) => e.udid === r.udid && dayStart(e.when).getTime() === d.getTime())).length }));
  document.getElementById('calSum').innerHTML = `${list.length} ${list.length === 1 ? 'príspevok' : 'príspevkov'} v týždni` +
    (free.some((f) => f.n) ? ' · voľné dni: ' + free.filter((f) => f.n).map((f) => `${esc(f.r.label)} ${f.n}`).join(', ') : '');
}
function openCalEntry(e) {
  if (!e) return;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const d = new Date(e.when);
  bg.innerHTML = `<div class="modal"><div class="mhead"><h3>${e.kind === 'carousel' ? '🖼️ Carousel' : '🎬 Reel'} · ${esc(e.phone || '')}</h3></div>
    <div class="kv"><span>Čas</span><b>${d.toLocaleString('sk-SK', { weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}</b></div>
    <div class="kv"><span>Stav</span><b><select data-st>${Object.keys(STATUS).map((s) => `<option${s === e.status ? ' selected' : ''}>${s}</option>`).join('')}</select></b></div>
    ${e.place ? `<div class="kv"><span>Kam</span><b>${esc(e.place)}</b></div>` : ''}
    ${e.music ? `<div class="kv"><span>Hudba</span><b>${esc(e.music)}</b></div>` : ''}
    ${e.files && e.files.length ? `<div class="kv"><span>Médiá</span><b>${e.files.map((f) => esc(f.name)).join(', ')}</b></div>` : ''}
    ${e.caption ? `<div class="capshow">${esc(e.caption)}</div>` : ''}
    <small class="hint">Kalendár je prehľad toho, čo naplánovala stránka. Ak príspevok zmažeš alebo presunieš v Meta Business Suite, uprav tu stav alebo ho zmaž.</small>
    <div class="mact"><button data-del>${icon('trash')}Zmazať z kalendára</button><span class="sp"></span><button class="go" data-x>Hotovo</button></div></div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); loadCalendar(); };
  bg.onclick = (ev) => { if (ev.target === bg) close(); };
  bg.querySelector('[data-x]').onclick = close;
  bg.querySelector('[data-st]').onchange = (ev) => jfetch('/api/calendar/status', { id: e.id, status: ev.target.value });
  bg.querySelector('[data-del]').onclick = async () => { if (confirm('Zmazať záznam z kalendára? (V Meta Business Suite ostane.)')) { await jfetch('/api/calendar/delete', { id: e.id }); close(); } };
}

// ---------- KNIŽNICA ----------
async function loadLibrary() {
  await loadLib();
  const f = OB.libFilter;
  const items = LIB.filter((x) => f === 'all' || (f === 'video' && x.kind === 'video') || (f === 'photo' && x.kind === 'photo') || (f === 'unused' && !(x.used || []).length));
  document.querySelectorAll('#libFilters button').forEach((b) => b.classList.toggle('on', b.dataset.f === f));
  document.getElementById('libCount').textContent = `${LIB.length} ${LIB.length === 1 ? 'súbor' : 'súborov'} · ${LIB.filter((x) => !(x.used || []).length).length} nepoužitých`;
  document.getElementById('libGrid').innerHTML = items.map((it) => `<div class="lcard">
      <div class="lprev">${it.kind === 'video' ? `<video src="/lib/${it.id}#t=0.1" muted playsinline preload="metadata"></video><span class="pvid">${icon('play')}</span>` : `<img src="/lib/${it.id}" loading="lazy" alt="">`}
        ${(it.used || []).length ? `<span class="lused">${it.used.length}× použité</span>` : '<span class="lnew">nepoužité</span>'}</div>
      <div class="lmeta"><b title="${esc(it.name)}">${esc(it.name)}</b>
        <small>${(it.size / 1e6).toFixed(1)} MB · ${new Date(it.addedAt).toLocaleDateString('sk-SK')}</small>
        ${(it.used || []).length ? `<small class="lu">${esc(usedText(it).replace('Použité: ', ''))}</small>` : ''}
        <button class="ghost" data-ldel="${it.id}" title="Zmazať">${icon('trash')}</button></div></div>`).join('')
    || '<div class="empty" style="grid-column:1/-1">Zatiaľ prázdne. Pretiahni sem videá a fotky – v plánovači ich potom vyberieš cez „Z knižnice“.</div>';
}
function initLibrary() {
  const drop = document.getElementById('libDrop'), inp = document.getElementById('libInput'), msg = document.getElementById('libMsg');
  const up = async (files) => {
    const arr = [...files]; let n = 0;
    for (const f of arr) {
      msg.textContent = `Nahrávam ${++n}/${arr.length}: ${f.name}…`;
      try { const r = await fetch('/api/library/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f }); const j = await r.json(); if (!r.ok) throw new Error(j.error); }
      catch (e) { msg.textContent = `${f.name}: ${e.message}`; await new Promise((r) => setTimeout(r, 1500)); }
    }
    msg.textContent = arr.length ? 'Hotovo ✓' : ''; setTimeout(() => (msg.textContent = ''), 2500);
    loadLibrary();
  };
  inp.onchange = () => { up(inp.files); inp.value = ''; };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); up(e.dataTransfer.files); });
  document.getElementById('libFilters').onclick = (e) => { const b = e.target.closest('button'); if (b) { OB.libFilter = b.dataset.f; loadLibrary(); } };
  document.getElementById('libGrid').onclick = async (e) => {
    const b = e.target.closest('[data-ldel]'); if (!b) return;
    if (confirm('Zmazať súbor z knižnice?')) { await jfetch('/api/library/delete', { id: b.dataset.ldel }); loadLibrary(); }
  };
}

// ---------- ŠTATISTIKY ----------
async function loadStats() {
  let list = []; try { list = await jfetch('/api/stats'); } catch (_) {}
  const by = new Map();
  for (const s of list) { if (!by.has(s.udid)) by.set(s.udid, []); by.get(s.udid).push(s); }
  const phones = [...by.keys()];
  const name = (u) => { const d = devsAll().find((x) => x.udid === u); return d ? fullLabel(d) : ((by.get(u) || [])[0] || {}).label || 'telefón'; };
  // dlaždice: posledná hodnota a zmena oproti predošlej
  document.getElementById('statTiles').innerHTML = phones.map((u, i) => {
    const a = by.get(u), last = a[a.length - 1], prev = a[a.length - 2];
    const diff = prev ? last.views - prev.views : null;
    return `<div class="tile" style="--pc:${devColor(u, i)}"><div class="lab"><i class="pcd"></i>${esc(name(u))}</div><div class="num">${last.views.toLocaleString('sk-SK')}</div>
      <div class="note">${diff == null ? 'prvé meranie' : (diff >= 0 ? '▲ ' : '▼ ') + Math.abs(diff).toLocaleString('sk-SK') + ' oproti minulému'} · ${new Date(last.at).toLocaleDateString('sk-SK')}</div></div>`;
  }).join('') || '<div class="empty" style="grid-column:1/-1">Zatiaľ žiadne merania. Na telefóne spusti šablónu <b>📊 Skontroluj posledný post</b> – výsledok sa uloží sem.</div>';
  drawStatChart(phones.map((u, i) => ({ udid: u, name: name(u), color: devColor(u, i), pts: by.get(u) })));
  document.getElementById('statList').innerHTML = list.slice(-40).reverse().map((s) => `<div class="li"><div class="tx"><b>${esc(name(s.udid))} · ${s.views.toLocaleString('sk-SK')} zhliadnutí</b>
    <small>${dts(s.at)}${s.postDate ? ' · post z ' + esc(s.postDate) : ''}${s.type ? ' · ' + esc(s.type) : ''}</small></div>
    <button class="ghost" data-sdel="${s.id}" title="Zmazať meranie">${icon('trash')}</button></div>`).join('') || '';
  document.getElementById('statList').onclick = async (e) => { const b = e.target.closest('[data-sdel]'); if (b && confirm('Zmazať meranie?')) { await jfetch('/api/stats/delete', { id: b.dataset.sdel }); loadStats(); } };
}
function drawStatChart(series) {
  const box = document.getElementById('statChart');
  const pts = series.flatMap((s) => s.pts);
  if (!pts.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = '';
  const W = Math.max(320, box.clientWidth || 700), H = 260, L = 56, R = 12, T = 14, B = 34;
  const t0 = Math.min(...pts.map((p) => +new Date(p.at))), t1 = Math.max(...pts.map((p) => +new Date(p.at)), t0 + 86400000);
  const vmax = Math.max(10, ...pts.map((p) => p.views)), step = Math.pow(10, Math.floor(Math.log10(vmax))) / 2, top = Math.ceil(vmax / step) * step;
  const x = (t) => L + (W - L - R) * (t - t0) / (t1 - t0), y = (v) => T + (H - T - B) * (1 - v / top);
  const fmt = (v) => v >= 1e6 ? (v / 1e6).toFixed(1).replace('.0', '') + ' mil' : v >= 1e3 ? Math.round(v / 1e3) + ' tis' : String(v);
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = top * i / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="gt">${fmt(v)}</text>`; }
  const days = Math.max(1, Math.round((t1 - t0) / 86400000)), every = Math.ceil(days / 6);
  for (let i = 0; i <= days; i += every) { const t = t0 + i * 86400000; g += `<text x="${x(t)}" y="${H - 10}" text-anchor="middle" class="gt">${new Date(t).toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric' })}</text>`; }
  for (const s of series) {
    const p = s.pts.map((q) => [x(+new Date(q.at)), y(q.views)]);
    g += `<polyline points="${p.map((q) => q.join(',')).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    g += p.map((q, i) => `<circle cx="${q[0]}" cy="${q[1]}" r="${i === p.length - 1 ? 4.5 : 3}" fill="${s.color}"><title>${esc(s.name)}: ${s.pts[i].views.toLocaleString('sk-SK')} (${new Date(s.pts[i].at).toLocaleDateString('sk-SK')})</title></circle>`).join('');
  }
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${g}</svg>
    <div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}

// ---------- PRIESKUMY ----------
let RES = [];
async function loadResearch() {
  try { RES = await jfetch('/api/research'); } catch (_) {}
  renderResearch();
}
function renderResearch() {
  const q = (document.getElementById('resQ').value || '').toLowerCase().trim();
  const list = RES.filter((r) => !q || (r.text + ' ' + r.profile + ' ' + r.phone).toLowerCase().includes(q));
  const mark = (t) => { const e = esc(t); return q ? e.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`) : e; };
  document.getElementById('resList').innerHTML = list.map((r) => `<div class="panel rcard">
      <h3>🔎 ${esc(r.profile || 'Reels feed')}<span class="sp"></span><button class="ghost" data-rcopy="${r.id}" title="Kopírovať">${icon('save')}</button><button class="ghost" data-rdel="${r.id}" title="Zmazať">${icon('trash')}</button></h3>
      <div class="sub">${dts(r.at)} · ${esc(r.phone || '')}${r.reels ? ` · ${r.reels} reelov` : ''}${r.ads ? ` · ${r.ads} reklám preskočených` : ''}</div>
      <div class="rtext">${mark(r.text || '')}</div></div>`).join('')
    || `<div class="empty">${RES.length ? 'Nič sa nenašlo.' : 'Zatiaľ žiadne prieskumy. Spusti šablónu <b>🔎 Prieskum reels</b> – výsledok sa uloží sem.'}</div>`;
}
function initResearch() {
  document.getElementById('resQ').oninput = renderResearch;
  document.getElementById('resList').onclick = async (e) => {
    const d = e.target.closest('[data-rdel]'), c = e.target.closest('[data-rcopy]');
    if (d && confirm('Zmazať prieskum?')) { await jfetch('/api/research/delete', { id: d.dataset.rdel }); loadResearch(); }
    if (c) { const r = RES.find((x) => x.id === c.dataset.rcopy); try { await navigator.clipboard.writeText(r.text); c.innerHTML = '✓'; setTimeout(() => (c.innerHTML = icon('save')), 1500); } catch (_) {} }
  };
}

// ---------- spustenie ----------
document.getElementById('calPrev').onclick = () => { OB.week--; loadCalendar(); };
document.getElementById('calNext').onclick = () => { OB.week++; loadCalendar(); };
document.getElementById('calToday').onclick = () => { OB.week = 0; loadCalendar(); };
initLibrary();
initResearch();
window.addEventListener('hashchange', () => setTimeout(obsahRoute, 0));
function obsahRoute() {
  if (view === 'kalendar') loadCalendar();
  if (view === 'kniznica') loadLibrary();
  if (view === 'statistiky') loadStats();
  if (view === 'prieskumy') loadResearch();
}
setTimeout(obsahRoute, 300);
setInterval(() => { if (view === 'kalendar') loadCalendar(); }, 30000);
