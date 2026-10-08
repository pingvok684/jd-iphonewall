// AI agent: dostane úlohu v slovenčine, pozerá sa na obrazovku iPhonu a sám kliká.
// Používa Claude API (potrebuje API kľúč z console.anthropic.com).

const http = require('http');
const store = require('./store');

let MODEL = process.env.CLAUDE_MODEL || ''; // prázdne = vyberie sa automaticky najnovší dostupný

// Zistí, aké modely má tvoj API kľúč k dispozícii (najnovšie prvé)
let MODEL_IDS = null;
async function listModels(apiKey, fresh) {
  if (MODEL_IDS && !fresh) return MODEL_IDS;
  const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || `Claude API ${r.status}`);
  MODEL_IDS = (j.data || []).map((m) => m.id); // API vracia najnovšie ako prvé
  if (!MODEL_IDS.length) throw new Error('API kľúč nemá prístup k žiadnemu modelu');
  return MODEL_IDS;
}
// najnovší model danej rodiny: sonnet (presný), haiku (najlacnejší), opus (najdrahší)
async function modelFor(apiKey, family = 'sonnet', fresh) {
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;
  const ids = await listModels(apiKey, fresh);
  const fam = /^(haiku|sonnet|opus)$/.test(family) ? family : 'sonnet';
  return ids.find((id) => id.includes(fam)) || ids.find((id) => /sonnet/i.test(id)) || ids[0];
}
const pickModel = (apiKey) => modelFor(apiKey, 'sonnet');
const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || '90', 10);
const KEEP_IMAGES = 2; // koľko posledných screenshotov posielať (šetrí peniaze): aktuálny + predchádzajúci
// Premýšľanie modelu vypíname: jeho bloky sú viazané na presnú históriu a tú pri skracovaní
// screenshotov meníme. Ak by model vypnutie nepodporoval, prepneme sa na režim bez skracovania.
let thinkingOff = true;

const SYSTEM = `Ovládaš iPhone podľa úlohy od používateľa. Po každej akcii dostaneš nový screenshot.
Súradnice x a y sú v rozsahu 0–1000 vzhľadom na screenshot (0,0 = ľavý horný roh, 1000,1000 = pravý dolný).
Pravidlá:
- Pred akciami napíš len veľmi krátku poznámku po slovensky (najviac 6 slov), nič viac.
- Ak si istý, ako bude obrazovka po akcii vyzerať, pošli aj viac akcií naraz (najviac 4) – napr. ťuknúť do poľa, napísať text a ťuknúť Next. Keď si nie si istý (načítavanie, nové okno, výber v zozname), pošli len jednu akciu. Nový screenshot dostaneš po celej sérii.
- Ak treba niečo napísať, najprv ťukni do textového poľa, potom použi type_text.
- Na scrollovanie použi swipe (napr. nahor: y1=750 → y2=300).
- Keď je úloha hotová alebo sa nedá dokončiť, zavolaj done so stručným zhrnutím.
- Nikdy nezadávaj heslá ani platobné údaje, nemaž účty a nič nekupuj – v takom prípade zavolaj done a vysvetli prečo.`;

const XY = { x: { type: 'number', description: '0–1000' }, y: { type: 'number', description: '0–1000' } };
const TOOLS = [
  { name: 'tap', description: 'Ťuknutie na bod.', input_schema: { type: 'object', properties: XY, required: ['x', 'y'] } },
  { name: 'long_press', description: 'Dlhé podržanie na bode.', input_schema: { type: 'object', properties: XY, required: ['x', 'y'] } },
  { name: 'swipe', description: 'Potiahnutie prstom z bodu 1 do bodu 2.', input_schema: { type: 'object',
    properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'type_text', description: 'Napíše text do aktívneho poľa. \\n = Enter.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'skip_ad', description: 'Reklama v Reels (Sponsored / Sponzorované / Reklama) – okamžite prejde na ďalší reel. Nepočíta sa medzi prezreté reely.', input_schema: { type: 'object', properties: {} } },
  { name: 'home', description: 'Tlačidlo Domov (návrat na plochu).', input_schema: { type: 'object', properties: {} } },
  { name: 'wait', description: 'Počká N sekúnd (načítavanie).', input_schema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] } },
  { name: 'music_note', description: 'Zapíše pesničku, ktorú si práve pridal k príspevku (aby sa na účte neopakovala).', input_schema: { type: 'object', properties: { title: { type: 'string', description: 'názov – interpret' } }, required: ['title'] } },
  { name: 'reel_note', description: 'Pri prieskume reels: zapíše poznámku o PRÁVE pozeranom reeli (volaj raz pri každom reeli, pred potiahnutím na ďalší). Píš po slovensky, stručne.', input_schema: { type: 'object',
    properties: { profil: { type: 'string', description: 'profil, ktorého reel pozeráš (ako bol zadaný v úlohe; prázdne = Reels feed)' }, hook: { type: 'string', description: 'prvý text na obrazovke alebo prvá veta' }, format: { type: 'string', description: 'formát videa (napr. tanec, POV, lip-sync, vlog, trend…)' }, prostredie: { type: 'string', description: 'prostredie a outfit' }, hudba: { type: 'string', description: 'pesnička / zvuk, ak je vidieť' }, zhliadnutia: { type: 'string', description: 'počet zhliadnutí, ak je vidieť' } }, required: ['hook', 'format'] } },
  { name: 'done', description: 'Úloha hotová alebo nemožná. Pri prieskume reels daj do summary 3 opakujúce sa trendy, ktoré sa dajú použiť pre náš obsah.', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
];

const NAV_TOOLS = [...TOOLS.filter((t) => !['reel_note', 'skip_ad', 'music_note'].includes(t.name)),
  { name: 'reels_ready', description: 'Prvý reel sa prehráva na celú obrazovku – ďalej to preberie aplikácia.', input_schema: { type: 'object', properties: {} } }];
const REEL_TOOLS = TOOLS.filter((t) => ['reel_note', 'skip_ad'].includes(t.name));
const SAME_TOOL = { name: 'same_reel', description: 'Na screenshote je stále ten istý reel ako naposledy zapísaný (nový sa ešte nezačal).', input_schema: { type: 'object', properties: {} } };
const REEL_SYSTEM = 'Pozeráš screenshot reelu na Instagrame a zapisuješ si ho pre prieskum obsahu. Vždy zavolaj presne jeden nástroj: same_reel ak je to ten istý reel ako naposledy (ak ten nástroj máš), skip_ad pri reklame, inak reel_note. Píš po slovensky, stručne.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jeden JPEG snímok z MJPEG streamu WDA (malý, rýchly)
function grabFrame(port) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        const s = buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (s < 0) return;
        const e = buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
        if (e < 0) return;
        req.destroy();
        resolve(buf.subarray(s, e + 2));
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('Stream neodpovedá')));
    req.on('error', reject);
  });
}

// ---------- poskytovateľ AI: Claude priamo (Anthropic) alebo cez KIE ----------
// auth = 'sk-ant-…' (Anthropic) alebo { provider: 'kie', key, model }
const KIE_URL = process.env.KIE_URL || 'https://api.kie.ai/claude/v1/messages';
const isKie = (a) => a && typeof a === 'object' && a.provider === 'kie';
const keyOf = (a) => (typeof a === 'string' ? a : (a && a.key) || '');
let kieSystemInline = false; // ak KIE nepozná pole „system“, vložíme pokyny do prvej správy
function inlineSystem(sys, messages) {
  const [first, ...rest] = messages;
  const c = typeof first.content === 'string' ? [{ type: 'text', text: first.content }] : first.content;
  return [{ ...first, content: [{ type: 'text', text: `POKYNY:\n${sys}` }, ...c] }, ...rest];
}
async function kieSend(auth, body) {
  const b = { ...body, model: auth.model || 'claude-sonnet-5', stream: false };
  if (kieSystemInline && b.system) { b.messages = inlineSystem(b.system, b.messages); delete b.system; }
  const r = await fetch(KIE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.key}`, 'x-api-key': auth.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (_) { throw new Error(`KIE ${r.status}: ${txt.slice(0, 160)}`); }
  const d = j && j.data && Array.isArray(j.data.content) ? j.data : j; // niekedy je odpoveď zabalená v „data“
  const err = !r.ok || (j.code && j.code !== 200 && !Array.isArray(d.content)) || j.type === 'error'
    ? ((j.error && (j.error.message || j.error)) || j.msg || j.message || `KIE ${r.status}`) : null;
  if (err) {
    if (!kieSystemInline && body.system && /system/i.test(String(err))) { kieSystemInline = true; return kieSend(auth, body); }
    if (/credit|balance|insufficient/i.test(String(err))) throw new Error('KIE: nemáš dosť kreditu – dobi si ho na kie.ai');
    if (r.status === 401 || /key|auth/i.test(String(err))) throw new Error('KIE: neplatný API kľúč (Nastavenia → KIE API kľúč)');
    throw new Error(`KIE: ${err}`);
  }
  if (!Array.isArray(d.content)) throw new Error('KIE: neočakávaná odpoveď');
  return d;
}

// zapíše spotrebu tokenov (Prehľad → míňanie na AI)
function track(kind, auth, res, phone) {
  try {
    const u = (res && res.usage) || {};
    store.addUsage({ kind, provider: isKie(auth) ? 'KIE' : 'Claude', model: isKie(auth) ? (auth.model || 'claude-sonnet-5') : (res.model || MODEL || ''),
      input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1, output: u.output_tokens || 0, phone });
  } catch (_) {}
}
// prompt caching: pravidlá + nástroje a ustálená časť histórie sa platia len ~10 % ceny pri ďalších krokoch
const hasImage = (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image' || (p.type === 'tool_result' && Array.isArray(p.content) && p.content.some((q) => q.type === 'image')));
function withCache(messages) {
  let idx = -1;
  if (!thinkingOff) idx = messages.length - 1; // história sa nemení → cache až po koniec
  else for (let i = 0; i < messages.length - 1; i++) { if (hasImage(messages[i])) break; idx = i; }
  if (idx < 0) return messages;
  return messages.map((m, i) => {
    if (i !== idx) return m;
    const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.slice();
    c[c.length - 1] = { ...c[c.length - 1], cache_control: { type: 'ephemeral' } };
    return { ...m, content: c };
  });
}
const noToolChoice = new Set();
async function callClaude(auth, messages, o = {}) {
  const system = o.system || SYSTEM, tools = o.tools === undefined ? TOOLS : o.tools, maxTokens = o.maxTokens || 1024;
  if (isKie(auth)) return kieSend(auth, Object.assign({ max_tokens: maxTokens, system, messages }, tools ? { tools } : {}));
  const apiKey = keyOf(auth);
  const model = o.model || await modelFor(apiKey, o.family || 'sonnet');
  const body = { model, max_tokens: maxTokens, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: withCache(messages) };
  if (tools && tools.length) body.tools = tools;
  if (o.toolChoice && tools && tools.length && !noToolChoice.has(model)) body.tool_choice = o.toolChoice;
  if (thinkingOff) body.thinking = { type: 'disabled' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = (j.error && j.error.message) || `Claude API ${r.status}`;
    if (/tool_choice/i.test(msg) && body.tool_choice) { noToolChoice.add(model); return callClaude(auth, messages, { ...o, model }); } // niektoré modely tool_choice nepodporujú
    if (!o.retried && thinkingOff && /thinking/i.test(msg) && !/signature|block_binding/i.test(msg)) { thinkingOff = false; return callClaude(auth, messages, { ...o, retried: true }); }
    // neplatný / starý názov modelu → vyber znova automaticky
    if (!o.retried && (r.status === 404 || /model/i.test(msg))) { const m2 = await modelFor(apiKey, o.family || 'sonnet', true); return callClaude(auth, messages, { ...o, model: m2, retried: true }); }
    throw new Error(msg);
  }
  return j;
}

function trimImages(messages) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    const holders = [m.content, ...m.content.filter((p) => p.type === 'tool_result' && Array.isArray(p.content)).map((p) => p.content)];
    for (const arr of holders) {
      for (let k = arr.length - 1; k >= 0; k--) {
        if (arr[k].type === 'image' && ++seen > KEEP_IMAGES) arr[k] = { type: 'text', text: '[starší screenshot vynechaný]' };
      }
    }
  }
}

const img = (jpeg) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } });

// actions: { tap(fx,fy), longPress(fx,fy), swipe({x1,y1,x2,y2,ms}), type(text), home() }  – súradnice 0..1
const sayFor = (A) => (t) => { A.log.push(t); if (A.log.length > 60) A.log.shift(); };
async function prepModel(apiKey, family, say, extra = '') {
  if (isKie(apiKey) && !process.env.KIE_AGENT) {
    // Claude cez KIE neprijíma obrázky → AI by ťukala naslepo (a mohla by napr. zverejniť namiesto naplánovania). To nedovolíme.
    throw new Error('Ovládanie telefónov cez KIE zatiaľ nejde – KIE neposiela AI obrázok obrazovky. Prepni v Nastaveniach „AI klikanie… cez“ na Claude priamo a vlož Claude kľúč.');
  }
  if (isKie(apiKey)) { say(`🧠 Model: ${apiKey.model || 'claude-sonnet-5'} (cez KIE)`); return null; }
  const model = await modelFor(keyOf(apiKey), family);
  say(`🧠 Model: ${model}${extra}`);
  return model;
}

async function runAgent(dev, task, apiKey, actions, opts = {}) {
  const A = dev.agent, say = sayFor(A);
  say(`▶ Úloha: ${task}`);
  const model = await prepModel(apiKey, opts.family, say);
  let aiTask = task;
  // 4) aplikáciu otvorí appka sama (bez AI) – ušetrí hľadanie ikony na ploche
  for (const [re, ids, name] of OPEN_APPS) {
    if (!re.test(task) || !actions.openApp) continue;
    for (const id of ids) {
      try { await actions.openApp(id); say(`📲 ${name} otvorená bez AI`); aiTask = `(${name} je už otvorená – spustila ju appka, neotváraj ju znova.) ` + task; await sleep(3500); break; } catch (_) {}
    }
    break;
  }
  // 7) zapamätaný postup: prvé kroky zopakuje appka bez AI, AI pokračuje až tam, kde sa obrazovka líši
  const key = routineKey(task), vars = taskVars(task), rkey = key && `${dev.udid}|${key}`;
  let record = null;
  if (key && opts.routines !== false && actions.tapLabel && actions.describeAt) {
    const all = store.readJson('routines.json', {}), r = all[rkey];
    if (r && r.steps && r.steps.length) {
      const done = [];
      for (const st of r.steps) {
        if (A.stop) { say('■ Zastavené'); return; }
        let ok = false;
        try {
          if (st.a === 'tap') ok = await actions.tapLabel(st.el);
          else if (st.a === 'type') { await actions.type(fillVars(st.text, vars)); ok = true; }
          else if (st.a === 'wait') { await sleep(Math.min(10, st.s || 1) * 1000); ok = true; }
        } catch (_) { ok = false; }
        if (!ok) break;
        done.push(st.a === 'tap' ? `ťuknutie na „${st.el.label}“` : st.a === 'type' ? 'napísanie textu' : 'čakanie');
        await sleep(1200);
      }
      if (done.length) {
        say(`⚡ ${done.length} ${done.length === 1 ? 'krok zopakovaný' : done.length < 5 ? 'kroky zopakované' : 'krokov zopakovaných'} bez AI (zapamätaný postup)`);
        aiTask += `\n\nAPPKA UŽ AUTOMATICKY UROBILA PRVÉ KROKY: ${done.join(' → ')}. Pokračuj od aktuálnej obrazovky – nezačínaj odznova a tieto kroky neopakuj.`;
        r.fails = 0;
      } else { r.fails = (r.fails || 0) + 1; say('↪ zapamätaný postup tentoraz nesedel – pokračuje AI'); }
      if (r.fails >= 2) { delete all[rkey]; say('🧠 postup sa zmenil – nabudúce si ho zapamätám znova'); }
      else all[rkey] = r;
      store.writeJson('routines.json', all);
    } else record = { steps: [], stop: false, vars };
  }
  const res = await agentLoop(dev, apiKey, actions, { task: aiTask, model, maxSteps: opts.maxSteps, record });
  // úspešný beh → zapamätať prvé kroky (len tie, ktoré sa dajú bezpečne zopakovať)
  if (record && res && res.status === 'done' && record.steps.length >= 2 && !/nepodar|zlyhal|nedá|nedal|chyb|zasekol|nenaš|nemôž/i.test(res.summary || '')) {
    const all = store.readJson('routines.json', {});
    all[rkey] = { steps: record.steps.slice(0, 15), at: new Date().toISOString(), fails: 0 };
    store.writeJson('routines.json', all);
    say(`🧠 zapamätaných ${Math.min(15, record.steps.length)} krokov – nabudúce ich appka urobí bez AI`);
  }
}

// ---------- úspory: otváranie aplikácií a zapamätané postupy ----------
const OPEN_APPS = [
  [/^Otvor aplikáciu Meta Business Suite/i, ['com.facebook.PagesManager', 'com.facebook.Pages'], 'Meta Business Suite'],
  [/^Otvor Instagram/i, ['com.burbn.instagram'], 'Instagram'],
  [/^Otvor aplikáciu X\b/i, ['com.atebits.Tweetie2'], 'X (Twitter)'],
];
function routineKey(t) {
  if (/Naplánuj 1 reel/.test(t)) return 'mbs-reel' + (/Instagram aj Facebook/.test(t) ? '-fb' : '');
  if (/Naplánuj 1 carousel/.test(t)) return 'mbs-carousel' + (/Instagram aj Facebook/.test(t) ? '-fb' : '');
  if (/pridať do Story/i.test(t)) return 'story';
  if (/Naplánuj post na X/.test(t)) return /VIDEO/.test(t) ? 'x-video' : 'x-photo';
  return null;
}
function taskVars(t) {
  const g = (re) => ((t.match(re) || [])[1] || '');
  return { caption: g(/Napíš presne tento (?:popis|text postu): „([\s\S]*?)“/), music: g(/Hudba: „([^“]*)“/), link: g(/Odkaz: „([^“]*)“/), linktext: g(/text na tlačidle: „([^“]*)“/) };
}
const fillVars = (text, v) => String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] || '');
// nahrávanie: ťuknutia podľa popisu tlačidla (nie súradníc), písanie s premennými; pri prvom kroku, ktorý sa nedá bezpečne zopakovať, nahrávanie končí
async function recordStep(rec, name, i, f, actions) {
  try {
    if (name === 'tap') {
      const el = await actions.describeAt(f(i.x), f(i.y));
      if (!el || !el.label || el.dup > 2) { rec.stop = true; return; }
      rec.steps.push({ a: 'tap', el });
    } else if (name === 'type_text') {
      let t = String(i.text || ''); const v = rec.vars || {};
      for (const k of ['caption', 'music', 'link', 'linktext']) if (v[k] && t === v[k]) t = `{{${k}}}`;
      if (t.length > 60 && !/^\{\{/.test(t)) { rec.stop = true; return; } // dlhý jedinečný text sa neopakuje
      rec.steps.push({ a: 'type', text: t });
    } else if (name === 'wait') rec.steps.push({ a: 'wait', s: Math.min(10, Number(i.seconds) || 1) });
    else if (name !== 'done') rec.stop = true; // swipe, podržanie… → ďalej už len AI
  } catch (_) { rec.stop = true; }
}

// jedna AI úloha: screenshot → akcia → screenshot … (vráti { status: done|ready|stopped|limit|end, summary })
async function agentLoop(dev, apiKey, actions, o) {
  const maxSteps = Math.max(10, Math.min(400, Number(o.maxSteps) || MAX_STEPS));
  const A = dev.agent, say = sayFor(A), tools = o.tools || TOOLS, kind = o.kind || 'agent';
  const f = (v) => Math.max(0, Math.min(1000, Number(v) || 0)) / 1000;
  const messages = [{ role: 'user', content: [{ type: 'text', text: `Úloha: ${o.task}\nAktuálna obrazovka:` }, img(await grabFrame(dev.mjpegPort))] }];

  for (let step = 1; step <= maxSteps; step++) {
    if (A.stop) { say('■ Zastavené'); return { status: 'stopped' }; }
    if (thinkingOff) trimImages(messages);
    const res = await callClaude(apiKey, messages, { model: o.model, tools });
    track(kind, apiKey, res, dev.label);
    // bloky premýšľania si necháme len vtedy, keď sa premýšľanie nedá vypnúť (vtedy históriu nemeníme)
    const content = thinkingOff ? res.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') : res.content;
    messages.push({ role: 'assistant', content });

    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text.trim()).filter(Boolean).join(' ');
    if (text) say(`💬 ${text}`);
    const uses = res.content.filter((c) => c.type === 'tool_use');
    if (!uses.length) { say('✓ Koniec'); return { status: 'end', summary: text }; }

    const results = [];
    let finished = false, status = 'done', summary = '';
    for (const [ui, u] of uses.entries()) {
      const i = u.input || {};
      let out = 'OK';
      if (ui > 0) await sleep(700); // séria akcií: nech sa obrazovka stihne zmeniť
      if (o.record && !o.record.stop) await recordStep(o.record, u.name, i, f, actions);
      try {
        switch (u.name) {
          case 'tap': say(`👆 tap ${Math.round(i.x)},${Math.round(i.y)}`); await actions.tap(f(i.x), f(i.y)); break;
          case 'long_press': say(`👆 podržanie ${Math.round(i.x)},${Math.round(i.y)}`); await actions.longPress(f(i.x), f(i.y)); break;
          case 'swipe': say('↕ swipe'); A.swipes = (A.swipes || 0) + 1; await actions.swipe({ x1: f(i.x1), y1: f(i.y1), x2: f(i.x2), y2: f(i.y2), ms: 350 }); break;
          case 'type_text': say(`⌨ „${String(i.text).slice(0, 60)}“`); await actions.type(String(i.text || '')); break;
          case 'skip_ad': say('⏭ reklama – preskakujem'); A.ads = (A.ads || 0) + 1; await actions.swipe({ x1: 0.5, y1: 0.75, x2: 0.5, y2: 0.25, ms: 250 }); break;
          case 'home': say('⌂ domov'); await actions.home(); break;
          case 'wait': await sleep(Math.min(15, Number(i.seconds) || 1) * 1000); break;
          case 'reel_note': {
            A.reelNotes = A.reelNotes || [];
            const n = { profil: String(i.profil || '').trim(), hook: String(i.hook || '').trim(), format: String(i.format || '').trim(), prostredie: String(i.prostredie || '').trim(), hudba: String(i.hudba || '').trim(), zhliadnutia: String(i.zhliadnutia || '').trim() };
            try { n.jpg = await grabFrame(dev.mjpegPort); } catch (_) {}
            A.reelNotes.push(n); say(`📝 Reel ${A.reelNotes.length}: ${n.hook.slice(0, 80)}`); out = `Zapísané (reel ${A.reelNotes.length}).`; break;
          }
          case 'done': summary = String(i.summary || ''); if (!o.quietDone) say(`✓ Hotovo: ${summary}`); A.summary = summary; finished = true; break;
          case 'music_note': A.music = String(i.title || '').trim().slice(0, 120); say(`🎵 ${A.music}`); break;
          case 'reels_ready': say('▶ reely sú otvorené – ďalej ich už len čítam'); status = 'ready'; finished = true; break;
          default: out = 'Neznámy nástroj';
        }
      } catch (e) { out = `Chyba: ${e.message}`; say(`⚠ ${e.message}`); }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: [{ type: 'text', text: out }] });
    }
    if (finished) return { status, summary };

    await sleep(1200); // nech sa obrazovka prekreslí
    const last = results[results.length - 1];
    last.content.push(img(await grabFrame(dev.mjpegPort)));
    messages.push({ role: 'user', content: results });
  }
  say(`■ Limit ${maxSteps} krokov – zastavujem`);
  return { status: 'limit' };
}


// ---------- prieskum reels: AI otvorí profil, posúvanie robí appka a AI sa pozrie raz na každý reel ----------
const isResearchTask = (t) => /Profil na prieskum:/.test(t || '') && /pozri\s+\d+\s+reel/i.test(t || '');
async function runResearch(dev, task, apiKey, actions, opts = {}) {
  const A = dev.agent, say = sayFor(A);
  const profs = (((task.match(/Profil na prieskum:\s*„([^“”"]*)[“”"]/) || [])[1]) || '').split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean);
  const want = Math.max(1, Math.min(50, parseInt((task.match(/pozri\s+(\d+)\s+reel/i) || [])[1], 10) || 5));
  say(`▶ Úloha: ${task}`);
  // ťukanie (otvoriť profil, reely) robí presnejší model, čítanie reelov lacný model
  const navModel = await prepModel(apiKey, opts.navFamily || 'sonnet', say, ' · otvára profil');
  const model = isKie(apiKey) ? null : await modelFor(keyOf(apiKey), opts.family || 'haiku');
  if (model) say(`🧠 Model: ${model} · číta reely`);
  A.reelNotes = []; A.ads = 0; A.swipes = 0;
  const up = () => actions.swipe({ x1: 0.5, y1: 0.75, x2: 0.5, y2: 0.25, ms: 280 });
  const scroll = opts.scroll === 'app' ? 'app' : 'auto';
  if (scroll === 'auto') say('🔁 posúvanie: Auto scroll v Instagrame (reely sa pozrú celé)');
  const autoRule = scroll === 'auto' ? ' Keď sa prvý reel prehráva, zapni v Instagrame automatické posúvanie: na reeli ťukni na ⋯ (tri bodky, More / Viac), otvor Playback / Prehrávanie a zapni Auto scroll / Automatické posúvanie (ak už je zapnuté, nechaj ho tak). Menu zavri, aby sa reel znova prehrával na celú obrazovku.' : '';
  const rule = autoRule + ' Keď sa reel prehráva na celú obrazovku, zavolaj reels_ready. Nič nelajkuj, nesleduj, nekomentuj ani nezdieľaj. Ak sa profil nedá nájsť, zavolaj done a napíš prečo.';
  for (const [pi, p] of (profs.length ? profs : ['']).entries()) {
    if (A.stop) { say('■ Zastavené'); return; }
    if (pi) say(`→ ďalší profil: ${p}`);
    // Instagram otvorí appka sama (bez AI); používateľské meno rovno ako profil
    const user = /^@?[a-z0-9._]{2,30}$/i.test(p) ? p.replace(/^@/, '') : '';
    let opened = '';
    try {
      if (user && actions.openUrl) { await actions.openUrl(`instagram://user?username=${encodeURIComponent(user)}`); opened = 'profile'; say(`📲 otváram profil @${user} v Instagrame`); }
      else if (actions.openApp) { await actions.openApp('com.burbn.instagram'); opened = 'app'; say('📲 otváram Instagram'); }
    } catch (e) { say(`⚠ Instagram sa nepodarilo otvoriť priamo (${e.message}) – skúsi to AI`); }
    if (opened) await sleep(3500);
    const nav = opened === 'profile'
      ? `Na obrazovke je otvorený Instagram s profilom @${user} (ak sa pýta „Otvoriť v Instagrame?“, ťukni Otvoriť; ak profil nie je otvorený, v Instagrame ťukni na Hľadať, napíš ${user} a otvor ho). Na profile ťukni na záložku Reels (ikona prehrávača pod hlavičkou profilu, v rade s mriežkou príspevkov) a potom ťukni na prvý reel vľavo hore.${rule}`
      : p
        ? `${opened ? 'Instagram je otvorený.' : 'Otvor Instagram.'} Ťukni na Hľadať (lupa) dole, ťukni do vyhľadávacieho poľa hore, napíš „${p}“ a otvor správny účet (pri mene osobnosti vyber overený účet s modrou fajkou alebo ten s najviac sledovateľmi). Na profile ťukni na záložku Reels a na prvý reel.${rule}`
        : `${opened ? 'Instagram je otvorený.' : 'Otvor Instagram.'} Ťukni na ikonu Reels v dolnej lište.${rule}`;
    const r = await agentLoop(dev, apiKey, actions, { task: nav, model: navModel, maxSteps: 35, tools: NAV_TOOLS, kind: 'prieskum', quietDone: true });
    if (r.status === 'stopped') return;
    if (r.status !== 'ready') { say(`⚠ ${p || 'Reels'}: reely sa nepodarilo otvoriť${r.summary ? ' – ' + r.summary : ''}`); continue; }
    let seen = 0, ads = 0, last = null, sameSince = Date.now(), checks = 0;
    const auto = scroll === 'auto';
    while (seen < want && ads < 15 && checks < want * 40) {
      if (A.stop) { say('■ Zastavené'); return; }
      await sleep(auto ? (last ? 6000 : 2500) : 2500); // auto: Instagram posúva sám, len sa pozrieme každých pár sekúnd
      checks++;
      const jpg = await grabFrame(dev.mjpegPort);
      const prev = auto && last ? ` Naposledy zapísaný reel mal hook „${last.hook}“ (formát: ${last.format || '?'}${last.prostredie ? ', ' + last.prostredie : ''}). Ak je na screenshote stále TEN ISTÝ reel, zavolaj same_reel.` : '';
      const res = await callClaude(apiKey, [{ role: 'user', content: [{ type: 'text', text: `Profil: ${p || 'Reels feed'} – reel ${seen + 1} z ${want}.${prev} Ak je to reklama (Sponsored / Sponzorované / Reklama / Ad, tlačidlo Shop now / Learn more / Install / Nakupovať), zavolaj skip_ad. Inak zavolaj reel_note (profil vyplň „${p || 'Reels feed'}“).` }, img(jpg)] }],
        { model, system: REEL_SYSTEM, tools: auto && last ? [...REEL_TOOLS, SAME_TOOL] : REEL_TOOLS, toolChoice: { type: 'any' }, maxTokens: 400 });
      track('prieskum', apiKey, res, dev.label);
      let u = (res.content || []).find((c) => c.type === 'tool_use') || {};
      if (!u.name) { // model odpovedal len textom → ešte raz, tentoraz výslovne nástrojom
        const r2 = await callClaude(apiKey, [{ role: 'user', content: [{ type: 'text', text: `Profil: ${p || 'Reels feed'}. Odpovedz IBA zavolaním jedného nástroja (reel_note, skip_ad${auto && last ? ' alebo same_reel' : ''}), bez textu.` }, img(jpg)] }],
          { model, system: REEL_SYSTEM, tools: auto && last ? [...REEL_TOOLS, SAME_TOOL] : REEL_TOOLS, toolChoice: { type: 'any' }, maxTokens: 400 });
        track('prieskum', apiKey, r2, dev.label);
        u = (r2.content || []).find((c) => c.type === 'tool_use') || {};
      }
      const i = u.input || {};
      if (u.name === 'same_reel') {
        // Auto scroll neposúva (napr. sa vypol) → po 75 s posunieme sami
        if (Date.now() - sameSince > 75000) { say('↕ Auto scroll sa nehýbe – posúvam sám'); await up(); A.swipes++; sameSince = Date.now(); }
        continue;
      }
      sameSince = Date.now();
      if (u.name === 'skip_ad') { ads++; A.ads++; say('⏭ reklama – preskakujem'); await up(); A.swipes++; continue; }
      seen++;
      const n = { profil: p || 'Reels feed', hook: String(i.hook || '').trim(), format: String(i.format || '').trim(), prostredie: String(i.prostredie || '').trim(), hudba: String(i.hudba || '').trim(), zhliadnutia: String(i.zhliadnutia || '').trim(), jpg };
      if (actions.reelLink) { try { n.link = await actions.reelLink(); } catch (_) {} }
      A.reelNotes.push(n); last = n; say(`📝 Reel ${A.reelNotes.length}: ${(n.hook || '—').slice(0, 80)}${n.link ? ' 🔗' : ''}`);
      if (!auto && seen < want) { await up(); A.swipes++; }
      else if (auto) A.swipes++;
    }
  }
  // trendy zo všetkých poznámok – jedno krátke textové volanie
  let summary = '';
  if (A.reelNotes.length) {
    const list = A.reelNotes.map((n, k) => `${k + 1}. [${n.profil}] ${n.hook} | ${n.format} | ${n.prostredie} | ${n.hudba} | ${n.zhliadnutia}`).join('\n');
    try {
      const res = await callClaude(apiKey, [{ role: 'user', content: `Poznámky z prezretých reelov:\n${list}\n\nNapíš 3 opakujúce sa trendy, ktoré by sa dali použiť pre náš obsah – očíslované, každý jednou vetou, po slovensky. Nič iné nepíš.` }],
        { model, system: 'Si analytik obsahu na Instagrame. Odpovedáš stručne po slovensky.', tools: null, maxTokens: 500 });
      track('prieskum', apiKey, res, dev.label);
      summary = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    } catch (e) { say(`⚠ trendy: ${e.message}`); }
  }
  try { await actions.home(); say('⌂ domov'); } catch (_) {}
  A.summary = summary;
  if (!A.reelNotes.length) throw new Error('Nepodarilo sa pozrieť žiadny reel.');
  say(`✓ Hotovo: prezreté reely ${A.reelNotes.length}${A.ads ? `, preskočené reklamy ${A.ads}` : ''}. ${summary}`);
}

function startAgent(dev, task, apiKey, actions, opts) {
  if (dev.agent && dev.agent.running) throw new Error('Agent už beží');
  dev.agent = { running: true, stop: false, log: [] };
  (isResearchTask(task) && !isKie(apiKey) ? runResearch : runAgent)(dev, task, apiKey, actions, opts || {})
    .catch((e) => dev.agent.log.push(`⚠ ${e.message}`))
    .finally(() => { dev.agent.running = false; });
}

// jednoduchá textová otázka pre Claude (napr. návrhy popisov)
async function askText(auth, system, content, maxTokens = 1200) {
  if (isKie(auth)) {
    const j = await kieSend(auth, { max_tokens: maxTokens, system, messages: [{ role: 'user', content }] });
    track('popisy', auth, j);
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  }
  const apiKey = keyOf(auth);
  const model = await pickModel(apiKey);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || `Claude API ${r.status}`);
  track('popisy', auth, j);
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

module.exports = { startAgent, askText, grabFrame, clearRoutines: () => store.writeJson('routines.json', {}), routineCount: () => Object.keys(store.readJson('routines.json', {})).length };
