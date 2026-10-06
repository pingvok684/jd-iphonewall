// Sprievodca „Nový príspevok“: telefón → médiá → popis → čas → kontrola. Všetko v jednom okne, krok za krokom.
// Používa funkcie z wall.js (attachDrop, chipsHtml, postTask, wireCaptions…) a obsah.js (ownerLabel, devColor).

function toast(text, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = text;
  Object.assign(t.style, { position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: 9999, padding: '12px 18px', borderRadius: '14px',
    background: bad ? '#3a1218' : '#10291d', border: `1px solid ${bad ? 'rgba(255,84,104,.5)' : 'rgba(61,220,151,.5)'}`, color: '#fff', fontWeight: 600, boxShadow: '0 12px 30px rgba(0,0,0,.45)', maxWidth: '90vw' });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

const W_STEPS = ['Účet a typ', 'Médiá', 'Popis', 'Čas', 'Kontrola'];

async function openWizard(opts = {}) {
  await Promise.all([loadLib(), loadRecentMusic()]);
  const pre = (opts.files || []).map(libItem).filter(Boolean);
  let kind = pre.length ? (pre[0].kind === 'video' ? 'reel' : 'carousel') : (opts.kind || 'reel');
  const startFiles = pre.filter((x) => (kind === 'reel' ? x.kind === 'video' : x.kind === 'photo')).slice(0, kind === 'reel' ? 1 : 20)
    .map((it) => ({ id: it.id, name: it.name, url: `/lib/${it.id}`, video: it.kind === 'video', pct: 100 }));
  const all = phoneList();
  const selPhones = opts.udid && all.some((p) => p.udid === opts.udid) ? [opts.udid] : all.length === 1 ? [all[0].udid] : [];
  let step = 0, libTab = 'mine', st = null, stopClock = () => {};

  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal wiz"><div class="mhead"><h3>Nový príspevok</h3>${clockBox()}</div>
    <div class="wsteps">${W_STEPS.map((s, i) => `<span data-n="${i + 1}">${i + 1}. ${s}</span>`).join('')}</div>

    <div class="wpane" data-p="0">
      <div class="wkinds"><button type="button" class="wkind" data-kind="reel"><b>🎬 Reel</b><small>1 video</small></button>
        <button type="button" class="wkind" data-kind="carousel"><b>🖼️ Carousel</b><small>1 až 20 fotiek</small></button></div>
      <div class="fld"><span>Na ktorý účet (telefón) – môžeš vybrať viac</span>${chipsHtml(selPhones)}</div>
      <small class="hint" data-profhint></small>
      <div class="mbsnote">📱 Plánuje sa cez aplikáciu <b>Meta Business Suite</b> – samotný Instagram nestačí. Musí byť v iPhone nainštalovaná, prihlásená a prepojená s Instagram účtom (profesionálny účet: Tvorca alebo Firma).</div>
    </div>

    <div class="wpane" data-p="1">
      <div data-dropwrap></div>
      <div class="fld"><span>Alebo vyber z knižnice</span>
        <div class="libtabs" data-ltabs></div><div class="wlib lgrid" data-wlib></div></div>
      <small class="hint" data-mhint></small>
    </div>

    <div class="wpane" data-p="2">
      <div class="fld" data-capwrap><span>Popis + #hashtagy</span><textarea data-cap rows="4" placeholder="Napíš popis alebo pár slov a klikni ✨ Navrhni popis"></textarea>${capHtml()}</div>
      <small class="hint" data-hashtxt></small>
      <div class="fld"><span>Hudba</span>${musicHtml()}</div>
      <div class="fld"><span>Kam zverejniť</span>${placeHtml()}</div>
      <label data-cntrow hidden><span>Počet fotiek (berú sa najnovšie v iPhone)</span><select data-cnt>${Array.from({ length: 20 }, (_, k) => k + 1).map((k) => `<option${k === 3 ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
    </div>

    <div class="wpane" data-p="3">
      <label><span>Dátum a čas (slovenský čas)</span>${dtPicker(0, opts.date)}<small class="hint us-conv" data-conv></small></label>
      <div class="wquick" data-quick><button type="button" data-q="today19">Dnes 19:00</button><button type="button" data-q="tom12">Zajtra 12:00</button><button type="button" data-q="tom19">Zajtra 19:00</button></div>
      <small class="hint">Meta dovolí naplánovať najskôr asi 20 minút dopredu.</small>
      <div class="fld"><span>V ten deň už je naplánované</span><div data-dayinfo class="hint">…</div></div>
    </div>

    <div class="wpane" data-p="4"><div class="wsum" data-sum></div><div class="wres" data-res></div></div>

    <div class="mact"><button data-x>Zrušiť</button><span class="sp"></span><button data-back>Späť</button><button class="go" data-next>Ďalej</button></div></div>`;
  document.body.appendChild(bg);
  paintIcons(bg);
  stopClock = startClock(bg);
  const $ = (q) => bg.querySelector(q);
  const phones = () => readChips($('[data-ph]'));
  const close = () => { stopClock(); bg.remove(); };
  $('[data-x]').onclick = close;
  bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // --- 1. typ + telefón
  const setKind = (k) => {
    if (k !== kind && st) st.files = st.files.filter((f) => (k === 'reel' ? f.video : !f.video));
    kind = k;
    bg.querySelectorAll('.wkind').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
    buildDrop();
  };
  bg.querySelectorAll('.wkind').forEach((b) => (b.onclick = () => setKind(b.dataset.kind)));
  const profOf = (u) => ((all.find((p) => p.udid === u) || {}).profile) || {};
  const profHint = () => {
    const ph = phones();
    $('[data-profhint]').innerHTML = ph.length ? ph.map((u) => { const p = profOf(u); return `<b>${esc(phoneLabel(u))}</b>${p.hashtags ? ' · stále hashtagy: ' + esc(p.hashtags) : ''}${p.note ? ' · štýl: ' + esc(p.note.slice(0, 60)) : ''}`; }).join('<br>')
      : 'Vyber účet – podľa neho sa ponúknu médiá z jeho knižnice a AI napíše popis v jeho štýle.';
  };
  $('[data-ph]') && $('[data-ph]').addEventListener('click', () => setTimeout(() => { profHint(); drawLib(); }, 0));

  // --- 2. médiá
  function buildDrop() {
    const keep = st ? st.files : startFiles;
    $('[data-dropwrap]').innerHTML = dropHtml(kind);
    paintIcons($('[data-dropwrap]'));
    st = attachDrop($('[data-dropwrap] [data-drop]'), () => { markLib(); mediaHint(); }, { files: keep.filter((f) => (kind === 'reel' ? f.video : !f.video)) });
    $('[data-dropwrap] .pdact').style.display = 'none'; // knižnica je priamo pod tým
    drawLib();
  }
  const mediaHint = () => {
    const n = st ? st.files.length : 0;
    $('[data-mhint]').textContent = n ? (kind === 'reel' ? 'Video sa pred plánovaním pošle do galérie iPhonu ako najnovšie – AI vyberie presne toto.' : `${n} ${n < 5 ? 'fotky' : 'fotiek'} v tomto poradí – pred plánovaním sa pošlú do galérie ako najnovšie.`)
      : `Bez médií AI použije ${kind === 'reel' ? 'najnovšie video' : 'najnovšie fotky'}, ktoré už v iPhone sú.`;
  };
  function drawLib() {
    if (!st) return;
    const u = phones()[0];
    const pool = LIB.filter((x) => (kind === 'reel' ? x.kind === 'video' : x.kind === 'photo'));
    const mine = u ? pool.filter((x) => (x.owners || []).includes(u)) : [], none = pool.filter((x) => !(x.owners || []).length);
    if (libTab === 'mine' && !u) libTab = 'all';
    $('[data-ltabs]').innerHTML = (u ? `<button type="button" data-t="mine" class="${libTab === 'mine' ? 'on' : ''}">${esc(phoneLabel(u))} (${mine.length})</button>` : '') +
      `<button type="button" data-t="none" class="${libTab === 'none' ? 'on' : ''}">Nepriradené (${none.length})</button><button type="button" data-t="all" class="${libTab === 'all' ? 'on' : ''}">Všetky (${pool.length})</button>`;
    const items = libTab === 'mine' ? mine : libTab === 'none' ? none : pool;
    $('[data-wlib]').innerHTML = items.map((it) => `<button type="button" class="lit" data-id="${it.id}" title="${esc(it.name + (usedText(it) ? '\n' + usedText(it) : ''))}">
      ${it.kind === 'video' ? `<video src="/lib/${it.id}#t=0.1" muted playsinline preload="metadata"></video>` : `<img src="/lib/${it.id}" loading="lazy" alt="">`}
      ${it.used && it.used.length ? `<span class="lused">${it.used.length}×</span>` : ''}<span class="lnum"></span></button>`).join('')
      || `<div class="empty-s" style="grid-column:1/-1">${libTab === 'mine' ? 'Tento účet zatiaľ nemá v knižnici nič – pozri „Všetky“ alebo pretiahni súbor hore.' : 'Nič tu nie je.'}</div>`;
    markLib(); mediaHint();
  }
  function markLib() {
    if (!st) return;
    const ids = st.files.map((f) => f.id);
    bg.querySelectorAll('[data-wlib] .lit').forEach((x) => { const n = ids.indexOf(x.dataset.id); x.classList.toggle('on', n >= 0); x.querySelector('.lnum').textContent = n >= 0 ? n + 1 : ''; });
  }
  $('[data-ltabs]').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { libTab = b.dataset.t; drawLib(); } };
  $('[data-wlib]').onclick = (e) => {
    const b = e.target.closest('.lit'); if (!b) return;
    const it = libItem(b.dataset.id), k = st.files.findIndex((f) => f.id === it.id);
    if (k >= 0) st.files.splice(k, 1);
    else { if (kind === 'reel') st.files = []; if (st.files.length >= 20) return alert('Carousel môže mať najviac 20 fotiek.'); st.files.push({ id: it.id, name: it.name, url: `/lib/${it.id}`, video: it.kind === 'video', pct: 100 }); }
    st.render();
  };

  // --- 3. popis
  bg.addEventListener('tagschange', () => hashRow());
  wireCaptions(bg, () => { const fl = st ? st.files.filter((x) => x.id) : []; return { udid: phones()[0], kind, fileId: fl[0] && fl[0].id, fileName: fl[0] && fl[0].name, files: fl }; });
  const tagsOn = () => readTags($('[data-capwrap]'));
  const hashFor = (u, cap) => applyTags(cap, tagsOn(), profOf(u).hashtags);
  const hashRow = () => {
    const tags = phones().map((u) => profOf(u).hashtags).filter(Boolean);
    $('[data-hashtxt]').innerHTML = !tagsOn() ? 'Popis pôjde bez hashtagov – ak nejaké v texte sú, odstránia sa.'
      : `Najviac ${MAX_TAGS} hashtagov (viac Instagram ani Facebook neprijme) – navyše sa automaticky odstránia.` + (tags.length ? ` Prednosť majú stále hashtagy účtu: <b>${esc([...new Set(tags)].join(' | '))}</b>` : '');
    $('[data-cntrow]').hidden = kind !== 'carousel' || (st && st.files.length > 0);
  };

  // --- 4. čas
  const setDt = (d) => { const box = $('.dtp'); box.querySelector('[data-d]').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    box.querySelector('[data-h]').value = pad(d.getHours()); box.querySelector('[data-m]').value = pad(Math.floor(d.getMinutes() / 5) * 5); updateConv(bg); dayInfo(); };
  $('[data-quick]').onclick = (e) => {
    const q = e.target.closest('[data-q]')?.dataset.q; if (!q) return;
    const d = new Date(); if (q !== 'today19') d.setDate(d.getDate() + 1); d.setHours(q === 'tom12' ? 12 : 19, 0, 0, 0);
    if (d < minSched()) return alert(`Na dnes je už neskoro – najskorší čas je ${fmtSk(minSched())}.`);
    setDt(d);
  };
  async function dayInfo() {
    const d = dtpValue($('.dtp')); if (isNaN(d)) return;
    const a = new Date(d); a.setHours(0, 0, 0, 0); const b = new Date(a.getTime() + 86400000);
    let list = []; try { list = await jfetch(`/api/calendar?from=${a.toISOString()}&to=${b.toISOString()}`); } catch (_) {}
    const ph = phones();
    const rows = ph.map((u) => { const l = list.filter((x) => x.udid === u); return `<div><b>${esc(phoneLabel(u))}:</b> ${l.length ? l.map((x) => `${hm(new Date(x.when))} ${x.kind === 'carousel' ? '🖼️' : '🎬'} (${esc(x.status)})`).join(', ') : 'nič'}</div>`; });
    $('[data-dayinfo]').innerHTML = rows.join('') || '—';
  }
  bg.addEventListener('change', (e) => { if (e.target.closest('.dtp')) dayInfo(); });

  // --- 5. kontrola
  const thumb = (f) => f.video ? `<video src="${f.url}#t=0.1" muted playsinline preload="metadata"></video>` : `<img src="${f.url}" alt="">`;
  function summary() {
    const d = dtpValue($('.dtp')), cap = $('[data-cap]').value.trim(), ph = phones(), fl = st.files;
    const tz = tzOf($('[data-us]').value);
    $('[data-sum]').innerHTML = `
      <div class="kv"><span>Typ</span><b>${kind === 'reel' ? '🎬 Reel' : `🖼️ Carousel (${fl.length || $('[data-cnt]').value} fotiek)`}</b></div>
      <div class="kv"><span>Účty</span><b>${ph.map((u) => esc(phoneLabel(u))).join(', ')}</b></div>
      <div class="kv"><span>Čas</span><b>${esc(fmtSk(d))}<br><small class="hint">${esc($('[data-us]').value)}: ${fmtDay(d, tz)} ${fmtTime(d, tz)}</small></b></div>
      <div class="kv"><span>Médiá</span><b>${fl.length ? `<div class="wthumbs">${fl.map(thumb).join('')}</div>` : `<span style="color:var(--warn)">bez médií – AI vyberie ${kind === 'reel' ? 'najnovšie video' : 'najnovšie fotky'} v iPhone</span>`}</b></div>
      <div class="kv"><span>Hudba</span><b>${esc(musicLabel(readMusic($('[data-mus]'))))} · ${esc(readPlace($('[data-place]')))}</b></div>
      ${ph.map((u) => `<div class="kv"><span>Popis · ${esc(phoneLabel(u))}</span><b style="white-space:pre-wrap;font-weight:500">${esc(hashFor(u, cap)) || '<span class="hint">bez popisu</span>'}</b></div>`).join('')}`;
    $('[data-res]').innerHTML = '';
  }

  // --- navigácia medzi krokmi
  function check(i) {
    if (i === 0) { if (!phones().length) { alert('Vyber aspoň jeden účet (telefón).'); return false; } }
    if (i === 1) {
      if (!planReady(st, kind === 'reel' ? 'Video' : 'Fotky')) return false;
      if (st.files.length > 20) { alert('Carousel môže mať najviac 20 fotiek.'); return false; }
    }
    if (i === 3) {
      const d = dtpValue($('.dtp'));
      if (isNaN(d)) { alert('Vyber dátum.'); return false; }
      if (d < minSched()) { alert(`Tento čas je príliš skoro. Najskorší možný čas je ${fmtSk(minSched())}.`); return false; }
    }
    return true;
  }
  function go(i) {
    step = i;
    bg.querySelectorAll('.wpane').forEach((p) => p.classList.toggle('on', +p.dataset.p === i));
    bg.querySelectorAll('.wsteps span').forEach((s, k) => { s.classList.toggle('on', k === i); s.classList.toggle('done', k < i); });
    $('[data-back]').style.visibility = i ? 'visible' : 'hidden';
    $('[data-next]').textContent = i === W_STEPS.length - 1 ? 'Naplánovať' : 'Ďalej';
    $('[data-next]').disabled = false;
    if (i === 0) profHint();
    if (i === 1) drawLib();
    if (i === 2) hashRow();
    if (i === 3) { updateConv(bg); dayInfo(); }
    if (i === 4) summary();
  }
  bg.querySelectorAll('.wsteps span').forEach((s, k) => (s.onclick = () => { if (k < step) go(k); else { for (let j = step; j < k; j++) if (!check(j)) return go(j); go(k); } }));
  $('[data-back]').onclick = () => go(Math.max(0, step - 1));
  $('[data-next]').onclick = async () => {
    if (step < W_STEPS.length - 1) { if (check(step)) go(step + 1); return; }
    // naplánovať
    const ph = phones(), fl = planFiles(st), d = dtpValue($('.dtp'));
    if (d < minSched()) { alert(`Čas medzitým prešiel – najskorší možný je ${fmtSk(minSched())}.`); return go(3); }
    if (!dupCheck([{ files: fl, phones: ph }])) return;
    const cap = $('[data-cap]').value.trim(), cnt = kind === 'reel' ? 1 : (fl.length || +$('[data-cnt]').value);
    const btn = $('[data-next]'); btn.disabled = true; btn.textContent = 'Spúšťam…';
    const res = $('[data-res]'); res.innerHTML = '';
    let ok = 0;
    for (const u of ph) {
      const x = { files: fl, cap: hashFor(u, cap), mus: readMusic($('[data-mus]')), when: fmtSk(d), whenISO: d.toISOString(), cnt };
      const stp = postTask(kind === 'reel', readPlace($('[data-place]')), x, null, kind === 'reel' ? 'Reel' : 'Carousel');
      let r = {}; try { const rr = await fetch(`/api/${u}/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps: [stp] }) }); r = await rr.json(); if (!rr.ok) throw new Error(r.error || 'Chyba'); ok++;
        res.insertAdjacentHTML('beforeend', `<div style="color:var(--ok)">✓ ${esc(phoneLabel(u))}: spustené – najprv pošlem médiá, potom to AI naplánuje.</div>`); }
      catch (e) { res.insertAdjacentHTML('beforeend', `<div style="color:var(--bad)">⚠ ${esc(phoneLabel(u))}: ${esc(e.message)}</div>`); }
    }
    setTimeout(() => poll(), 300);
    if (ok === ph.length) { toast(`Spustené na ${ok === 1 ? '1 účte' : ok + ' účtoch'} – priebeh uvidíš v Prehľade (Dnes) a pri telefóne.`); close(); if (view === 'prehlad') loadOverview(); else if (view === 'kalendar') loadCalendar(); }
    else { btn.disabled = false; btn.textContent = 'Skúsiť znova'; }
  };

  // štart
  bg.querySelectorAll('.wkind').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
  buildDrop();
  if (opts.date) setTimeout(dayInfo, 0);
  // ak už je vybraný účet aj médiá (napr. pretiahnuté do kalendára), začni rovno popisom
  go(selPhones.length && startFiles.length ? 2 : selPhones.length ? 1 : 0);
}

// znova spustí príspevok, ktorý zlyhal (ak čas prešiel, opýta sa na nový)
async function retryPost(id, when) {
  const body = { id };
  if (when) { body.when = when.toISOString(); body.whenText = fmtSk(when); }
  let r, j = {};
  try { r = await fetch('/api/calendar/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); j = await r.json(); } catch (e) { return toast(e.message, true); }
  if (r.ok) { toast('Spustené znova – najprv pošlem médiá, potom to AI naplánuje.'); setTimeout(poll, 300); if (view === 'prehlad') setTimeout(loadOverview, 800); if (view === 'kalendar') setTimeout(loadCalendar, 800); return; }
  if (!j.needTime) return toast(j.error || 'Chyba', true);
  // nový čas
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><div class="mhead"><h3>Nový čas príspevku</h3>${clockBox()}</div>
    <small class="hint">Pôvodný čas už prešiel. Vyber nový – médiá aj popis ostanú rovnaké.</small>
    <label><span>Dátum a čas</span>${dtPicker(0)}<small class="hint us-conv" data-conv></small></label>
    <div class="mact"><button data-x>Zrušiť</button><button class="go" data-ok>Spustiť znova</button></div></div>`;
  document.body.appendChild(bg);
  const stop = startClock(bg);
  const close = () => { stop(); bg.remove(); };
  bg.querySelector('[data-x]').onclick = close;
  bg.querySelector('[data-ok]').onclick = () => {
    const d = dtpValue(bg.querySelector('.dtp'));
    if (isNaN(d) || d < minSched()) return alert(`Najskorší možný čas je ${fmtSk(minSched())}.`);
    close(); retryPost(id, d);
  };
}

// všetky tlačidlá „Nový príspevok“
document.addEventListener('click', (e) => { const b = e.target.closest('[data-newpost]'); if (b) { e.preventDefault(); openWizard({ udid: view === 'kniznica' && OB.libPhone && OB.libPhone !== 'none' ? OB.libPhone : '' }); } });
paintIcons();
