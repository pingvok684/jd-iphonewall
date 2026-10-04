// AI agent: dostane úlohu v slovenčine, pozerá sa na obrazovku iPhonu a sám kliká.
// Používa Claude API (potrebuje API kľúč z console.anthropic.com).

const http = require('http');

let MODEL = process.env.CLAUDE_MODEL || ''; // prázdne = vyberie sa automaticky najnovší dostupný

// Zistí, aké modely má tvoj API kľúč k dispozícii, a vyberie najnovší Sonnet (rýchly a lacnejší)
async function pickModel(apiKey) {
  const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || `Claude API ${r.status}`);
  const ids = (j.data || []).map((m) => m.id); // API vracia najnovšie ako prvé
  const pick = ids.find((id) => /sonnet/i.test(id)) || ids.find((id) => /opus/i.test(id)) || ids[0];
  if (!pick) throw new Error('API kľúč nemá prístup k žiadnemu modelu');
  return pick;
}
const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || '90', 10);
const KEEP_IMAGES = 3; // koľko posledných screenshotov posielať (šetrí peniaze)
// Premýšľanie modelu vypíname: jeho bloky sú viazané na presnú históriu a tú pri skracovaní
// screenshotov meníme. Ak by model vypnutie nepodporoval, prepneme sa na režim bez skracovania.
let thinkingOff = true;

const SYSTEM = `Ovládaš iPhone podľa úlohy od používateľa. Po každej akcii dostaneš nový screenshot.
Súradnice x a y sú v rozsahu 0–1000 vzhľadom na screenshot (0,0 = ľavý horný roh, 1000,1000 = pravý dolný).
Pravidlá:
- Rob vždy JEDNU akciu naraz a pred ňou krátko (1 veta po slovensky) napíš, čo robíš a prečo.
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
  { name: 'done', description: 'Úloha hotová alebo nemožná.', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
];

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

async function callClaude(apiKey, messages, retried) {
  if (!MODEL) MODEL = await pickModel(apiKey);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign(
      { model: MODEL, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages },
      thinkingOff ? { thinking: { type: 'disabled' } } : {},
    )),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = (j.error && j.error.message) || `Claude API ${r.status}`;
    // neplatný / starý názov modelu → vyber znova automaticky
    if (!retried && thinkingOff && /thinking/i.test(msg) && !/signature|block_binding/i.test(msg)) { thinkingOff = false; return callClaude(apiKey, messages, true); }
    if (!retried && (r.status === 404 || /model/i.test(msg))) { MODEL = await pickModel(apiKey); return callClaude(apiKey, messages, true); }
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
async function runAgent(dev, task, apiKey, actions, opts = {}) {
  const maxSteps = Math.max(10, Math.min(400, Number(opts.maxSteps) || MAX_STEPS));
  const A = dev.agent;
  const say = (t) => { A.log.push(t); if (A.log.length > 60) A.log.shift(); };
  const f = (v) => Math.max(0, Math.min(1000, Number(v) || 0)) / 1000;

  say(`▶ Úloha: ${task}`);
  if (!MODEL) { MODEL = await pickModel(apiKey); }
  say(`🧠 Model: ${MODEL}`);
  const messages = [{ role: 'user', content: [{ type: 'text', text: `Úloha: ${task}\nAktuálna obrazovka:` }, img(await grabFrame(dev.mjpegPort))] }];

  for (let step = 1; step <= maxSteps; step++) {
    if (A.stop) { say('■ Zastavené'); return; }
    if (thinkingOff) trimImages(messages);
    const res = await callClaude(apiKey, messages);
    // bloky premýšľania si necháme len vtedy, keď sa premýšľanie nedá vypnúť (vtedy históriu nemeníme)
    const content = thinkingOff ? res.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') : res.content;
    messages.push({ role: 'assistant', content });

    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text.trim()).filter(Boolean).join(' ');
    if (text) say(`💬 ${text}`);
    const uses = res.content.filter((c) => c.type === 'tool_use');
    if (!uses.length) { say('✓ Koniec'); return; }

    const results = [];
    let finished = false;
    for (const u of uses) {
      const i = u.input || {};
      let out = 'OK';
      try {
        switch (u.name) {
          case 'tap': say(`👆 tap ${Math.round(i.x)},${Math.round(i.y)}`); await actions.tap(f(i.x), f(i.y)); break;
          case 'long_press': say(`👆 podržanie ${Math.round(i.x)},${Math.round(i.y)}`); await actions.longPress(f(i.x), f(i.y)); break;
          case 'swipe': say('↕ swipe'); A.swipes = (A.swipes || 0) + 1; await actions.swipe({ x1: f(i.x1), y1: f(i.y1), x2: f(i.x2), y2: f(i.y2), ms: 350 }); break;
          case 'type_text': say(`⌨ „${String(i.text).slice(0, 60)}“`); await actions.type(String(i.text || '')); break;
          case 'skip_ad': say('⏭ reklama – preskakujem'); A.ads = (A.ads || 0) + 1; await actions.swipe({ x1: 0.5, y1: 0.75, x2: 0.5, y2: 0.25, ms: 250 }); break;
          case 'home': say('⌂ domov'); await actions.home(); break;
          case 'wait': await sleep(Math.min(15, Number(i.seconds) || 1) * 1000); break;
          case 'done': say(`✓ Hotovo: ${i.summary || ''}`); finished = true; break;
          default: out = 'Neznámy nástroj';
        }
      } catch (e) { out = `Chyba: ${e.message}`; say(`⚠ ${e.message}`); }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: [{ type: 'text', text: out }] });
    }
    if (finished) return;

    await sleep(1200); // nech sa obrazovka prekreslí
    const last = results[results.length - 1];
    last.content.push(img(await grabFrame(dev.mjpegPort)));
    messages.push({ role: 'user', content: results });
  }
  say(`■ Limit ${maxSteps} krokov – zastavujem`);
}

function startAgent(dev, task, apiKey, actions, opts) {
  if (dev.agent && dev.agent.running) throw new Error('Agent už beží');
  dev.agent = { running: true, stop: false, log: [] };
  runAgent(dev, task, apiKey, actions, opts)
    .catch((e) => dev.agent.log.push(`⚠ ${e.message}`))
    .finally(() => { dev.agent.running = false; });
}

module.exports = { startAgent };
