// JD Phone Studio – rozcestník (Cloudflare Worker)
// Každá aplikácia JD Phone Studio sem nahlási aktuálnu adresu svojho počítača.
// Ikona na mobile vedie na https://go.<tvoja-doména>/<id> → tu sa presmeruje na aktuálnu adresu.
// Rozcestník nevidí žiadne dáta ani telefóny – pozná len adresu tunela.
// Potrebuje KV úložisko pripojené pod názvom KV.
// Synchronizácia účtov (/sync/...): potrebuje aj R2 úložisko pripojené pod názvom R2 (knižnica, kalendár, šablóny…).

const PAGE = "<!doctype html>\n<html lang=\"sk\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<title>JD Phone Studio</title>\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\"><meta name=\"mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Phone Studio\"><meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\">\n<meta name=\"theme-color\" content=\"#0c0d11\"><meta name=\"referrer\" content=\"no-referrer\">\n<link rel=\"apple-touch-icon\" href=\"/icon.png\"><link rel=\"icon\" href=\"/icon.png\">\n<style>\n*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:radial-gradient(circle at 50% 0,#3a1422,#0c0d11 60%);color:#eceef3;font:16px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}\n.box{min-height:100vh;display:grid;place-items:center;padding:28px 20px}\n.in{width:min(380px,100%);display:grid;gap:14px;text-align:center;justify-items:center}\nimg{width:76px;height:76px;border-radius:20px;box-shadow:0 14px 40px rgba(255,61,104,.35)}\nh1{margin:6px 0 0;font-size:22px}p{margin:0;color:#a3a8b5;font-size:15px}\n.spin{width:28px;height:28px;border-radius:50%;border:3px solid rgba(255,255,255,.15);border-top-color:#ff4f76;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}\n.steps{text-align:left;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:14px 16px 14px 34px;margin:4px 0 0;color:#d6d9e0;font-size:14.5px}\n.steps li{margin:5px 0}b{color:#fff}\nbutton{font:700 16px -apple-system,sans-serif;padding:14px 22px;border-radius:14px;border:0;color:#fff;background:linear-gradient(180deg,#ff4f76,#e8285a);width:100%;max-width:300px}\n</style></head>\n<body><div class=\"box\"><div class=\"in\">\n<img src=\"/icon.png\" alt=\"\">\n<h1 id=\"t\">JD Phone Studio</h1>\n<div class=\"spin\" id=\"sp\"></div>\n<p id=\"m\">Prip\u00e1jam sa k tvojmu po\u010d\u00edta\u010du\u2026</p>\n<div id=\"x\"></div>\n<button id=\"b\" hidden></button>\n</div></div>\n<script>\n(function () {\n  var id = location.pathname.slice(1);\n  var LS = 'jdps:' + id;\n  var hp = new URLSearchParams(location.hash.slice(1));\n  var key = hp.get('d'); try { if (!key) key = localStorage.getItem(LS); } catch (e) {}\n  var pair = hp.get('pair');\n  var $ = function (i) { return document.getElementById(i); };\n  var standalone = window.navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);\n  function show(title, text, extra, btn, fn) {\n    $('t').textContent = title; $('m').innerHTML = text; $('x').innerHTML = extra || ''; $('sp').hidden = !!(btn || extra || title !== 'JD Phone Studio');\n    $('b').hidden = !btn; if (btn) { $('b').textContent = btn; $('b').onclick = fn; }\n  }\n  function rnd() { var a = new Uint8Array(32); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }\n  function devName() { var u = navigator.userAgent; return (/iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : 'Mobil') + ' \u00b7 ' + new Date().toLocaleDateString('sk-SK'); }\n  function remember(k) { try { localStorage.setItem(LS, k); } catch (e) {} history.replaceState(null, '', location.pathname + '#d=' + k); }\n  function timeout(ms) { var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal; }\n  function login(base, k) {\n    var f = document.createElement('form'); f.method = 'POST'; f.action = base + '/pair/login';\n    var i = document.createElement('input'); i.type = 'hidden'; i.name = 'd'; i.value = k; f.appendChild(i);\n    document.body.appendChild(f); f.submit();\n  }\n  async function go() {\n    show('JD Phone Studio', 'Prip\u00e1jam sa k tvojmu po\u010d\u00edta\u010du\u2026');\n    var info;\n    try { var r = await fetch('/api/where/' + id, { cache: 'no-store', signal: timeout(10000) }); if (!r.ok) throw new Error(r.status); info = await r.json(); }\n    catch (e) { return show('Nezn\u00e1my odkaz', 'Tento odkaz e\u0161te nie je akt\u00edvny. V aplik\u00e1cii JD Phone Studio na po\u010d\u00edta\u010di zapni <b>Pr\u00edstup z mobilu</b>.', '', 'Sk\u00fasi\u0165 znova', go); }\n    try { var p = await fetch(info.url + '/pair/ping', { cache: 'no-store', signal: timeout(9000) }); if (!p.ok) throw 0; }\n    catch (e) { return show('Po\u010d\u00edta\u010d je nedostupn\u00fd', 'Aplik\u00e1cia JD Phone Studio na po\u010d\u00edta\u010di asi nebe\u017e\u00ed, po\u010d\u00edta\u010d sp\u00ed alebo nem\u00e1 internet. Skontroluj to a sk\u00fas znova.', '', 'Sk\u00fasi\u0165 znova', go); }\n    if (pair) {\n      var k = key || rnd();\n      try {\n        var c = await fetch(info.url + '/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair, key: k, name: devName() }) });\n        if (!c.ok) throw 0;\n      } catch (e) { return show('P\u00e1rovanie zlyhalo', 'QR k\u00f3d u\u017e bol pou\u017eit\u00fd alebo vypr\u0161al (plat\u00ed 10 min\u00fat). V aplik\u00e1cii klikni znova <b>Prida\u0165 mobil</b>.'); }\n      pair = null; key = k; remember(k);\n      return show('Mobil je sp\u00e1rovan\u00fd \u2713', standalone ? 'Hotovo.' : 'E\u0161te si pridaj ikonu na plochu \u2013 potom str\u00e1nku otv\u00e1raj v\u017edy cez \u0148u:',\n        standalone ? '' : '<ol class=\"steps\"><li><b>iPhone:</b> \u0165ukni <b>Zdie\u013ea\u0165</b> (\u0161tvor\u010dek so \u0161\u00edpkou) \u2192 <b>Prida\u0165 na plochu</b></li><li><b>Android:</b> \u0165ukni <b>\u22ee</b> \u2192 <b>Prida\u0165 na plochu</b></li></ol>',\n        'Otvori\u0165 str\u00e1nku', function () { login(info.url, key); });\n    }\n    if (!key) return show('Mobil nie je sp\u00e1rovan\u00fd', 'V aplik\u00e1cii JD Phone Studio na po\u010d\u00edta\u010di klikni <b>Nastavenia \u2192 Pr\u00edstup z mobilu \u2192 Prida\u0165 mobil</b> a naskenuj QR k\u00f3d.');\n    remember(key);\n    login(info.url, key);\n  }\n  go();\n  window.addEventListener('pageshow', function (e) { if (e.persisted) go(); });\n})();\n</script></body></html>";
const ICON_URL = 'https://raw.githubusercontent.com/pingvok684/jd-iphonewall/main/public/ikona.png';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
async function sha(t) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
const ID = /^[a-z0-9]{10,32}$/;

// ---------- nahlásené chyby (Report a bug) ----------
// POST /bugs (ktokoľvek, max 10 za hodinu z jednej IP) → R2 bugs/<id>.json (+ bugs/<id>.img)
// GET /bugs, PATCH/DELETE /bugs/<id>, GET /bugs/<id>/img – len prihlásený účet, ktorého e-mail je v premennej ADMIN_EMAIL
// voliteľne: TG_TOKEN + TG_CHAT → správa do Telegramu pri každej novej chybe
async function bugsApi(request, env, url) {
  if (!env.R2) return json({ error: 'Nahlasovanie chýb nie je zapnuté.' }, 503);
  const p = url.pathname, m = request.method;
  if (p === '/bugs' && m === 'POST') {
    const ip = request.headers.get('cf-connecting-ip') || 'x';
    const n = +(await env.KV.get('bip:' + ip)) || 0;
    if (n >= 10) return json({ error: 'Príliš veľa hlásení – skús to o hodinu.' }, 429);
    await env.KV.put('bip:' + ip, String(n + 1), { expirationTtl: 3600 });
    let b = {}; try { b = await request.json(); } catch (_) {}
    const text = String(b.text || '').trim().slice(0, 5000);
    if (text.length < 5) return json({ error: 'Prázdne hlásenie.' }, 400);
    const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + rnd(3);
    let img = false;
    const sm = String(b.shot || '').match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/);
    if (sm && sm[2].length < 5e6) {
      const bin = Uint8Array.from(atob(sm[2]), (c) => c.charCodeAt(0));
      await env.R2.put('bugs/' + id + '.img', bin, { httpMetadata: { contentType: sm[1] } }); img = true;
    }
    const info = b.info && typeof b.info === 'object' ? b.info : {};
    const bug = { id, at: Date.now(), text, contact: String(b.contact || '').slice(0, 200), where: String(b.where || '').slice(0, 100),
      info: { version: String(info.version || '').slice(0, 40), platform: String(info.platform || '').slice(0, 80), wda: String(info.wda || '').slice(0, 20), phones: (Array.isArray(info.phones) ? info.phones : []).slice(0, 30).map((x) => String(x).slice(0, 120)) },
      log: String(b.log || '').slice(-15000), img, done: false, country: (request.cf && request.cf.country) || '' };
    await env.R2.put('bugs/' + id + '.json', JSON.stringify(bug));
    if (env.TG_TOKEN && env.TG_CHAT) {
      const msg = `🐞 Nová chyba v JD Phone Studio\n\n${text.slice(0, 1500)}\n\n${bug.contact ? 'Od: ' + bug.contact + '\n' : ''}Verzia: ${bug.info.version} · ${bug.info.platform}`;
      try { await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TG_CHAT, text: msg }) }); } catch (_) {}
    }
    return json({ ok: true, id });
  }
  // správa hlásení – len autor
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const s = await session(env, token);
  const admins = String(env.ADMIN_EMAIL || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (!s) return json({ error: 'Prihlás sa (Nastavenia → Účet a synchronizácia).' }, 401);
  if (!admins.includes(String(s.email).toLowerCase())) return json({ error: 'Hlásenia vidí len autor aplikácie.' }, 403);
  if (p === '/bugs' && m === 'GET') {
    const list = []; let cursor;
    do {
      const r = await env.R2.list({ prefix: 'bugs/', cursor, limit: 1000 });
      for (const o of r.objects) if (o.key.endsWith('.json')) list.push(o.key);
      cursor = r.truncated ? r.cursor : null;
    } while (cursor);
    list.sort().reverse();
    const out = [];
    for (const k of list.slice(0, 200)) { const o = await env.R2.get(k); if (o) out.push(await o.json()); }
    return json({ bugs: out, total: list.length });
  }
  const mm = p.match(/^\/bugs\/([0-9a-f-]{10,40})(\/img)?$/);
  if (!mm) return json({ error: 'nenájdené' }, 404);
  if (mm[2] && m === 'GET') { const o = await env.R2.get('bugs/' + mm[1] + '.img'); return o ? new Response(o.body, { headers: { 'content-type': (o.httpMetadata && o.httpMetadata.contentType) || 'image/jpeg' } }) : new Response(null, { status: 404 }); }
  if (m === 'DELETE') { await env.R2.delete(['bugs/' + mm[1] + '.json', 'bugs/' + mm[1] + '.img']); return json({ ok: true }); }
  if (m === 'PATCH') {
    const o = await env.R2.get('bugs/' + mm[1] + '.json'); if (!o) return json({ error: 'nenájdené' }, 404);
    const bug = await o.json(); let b = {}; try { b = await request.json(); } catch (_) {}
    bug.done = !!b.done; await env.R2.put('bugs/' + mm[1] + '.json', JSON.stringify(bug)); return json({ ok: true });
  }
  return json({ error: 'nenájdené' }, 404);
}

// ---------- synchronizácia (účty JD Phone Studio) ----------
// KV: u:<email> = { id, salt, hash }, s:<token> = { uid, email } (60 dní), f:<email> = počet zlých prihlásení (1 h)
// R2: u/<uid>/state.json = { docs: { <meno>: { hash, at } } }, u/<uid>/doc/<meno>, u/<uid>/blob/<sha1>
const DOC = /^[a-z0-9-]{2,40}$/, SHA1 = /^[a-f0-9]{40}$/, EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, k, 256));
}
const rnd = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); };
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function session(env, token) {
  return token && /^[a-f0-9]{64}$/.test(token) ? env.KV.get('s:' + token, 'json') : null;
}
async function newSession(env, uid, email) {
  const token = rnd(32);
  await env.KV.put('s:' + token, JSON.stringify({ uid, email }), { expirationTtl: 60 * 86400 });
  return token;
}
async function syncApi(request, env, url) {
  const p = url.pathname, m = request.method;
  if (!env.R2) return json({ error: 'Synchronizácia nie je zapnutá (chýba R2 úložisko v rozcestníku).' }, 503);
  if ((p === '/sync/signup' || p === '/sync/login') && m === 'POST') {
    let b = {}; try { b = await request.json(); } catch (_) {}
    const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    if (!EMAIL.test(email)) return json({ error: 'Zadaj platný e-mail.' }, 400);
    if (pw.length < 8 || pw.length > 200) return json({ error: 'Heslo musí mať aspoň 8 znakov.' }, 400);
    const fails = +(await env.KV.get('f:' + email)) || 0;
    if (fails >= 10) return json({ error: 'Príliš veľa pokusov. Skús to o hodinu.' }, 429);
    const cur = await env.KV.get('u:' + email, 'json');
    if (p === '/sync/signup') {
      if (cur) return json({ error: 'Účet s týmto e-mailom už existuje – prihlás sa.' }, 409);
      const salt = rnd(16), u = { id: rnd(12), salt, hash: await pbkdf2(pw, salt), at: Date.now() };
      await env.KV.put('u:' + email, JSON.stringify(u));
      return json({ token: await newSession(env, u.id, email), email });
    }
    if (!cur || !same(await pbkdf2(pw, cur.salt), cur.hash)) {
      await env.KV.put('f:' + email, String(fails + 1), { expirationTtl: 3600 });
      return json({ error: 'Nesprávny e-mail alebo heslo.' }, 401);
    }
    return json({ token: await newSession(env, cur.id, email), email });
  }
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const s = await session(env, token);
  if (!s) return json({ error: 'Prihlásenie vypršalo – prihlás sa znova.' }, 401);
  const base = `u/${s.uid}/`;
  if (p === '/sync/logout' && m === 'POST') { await env.KV.delete('s:' + token); return json({ ok: true }); }
  if (p === '/sync/me') return json({ email: s.email });
  if (p === '/sync/state' && m === 'GET') {
    const o = await env.R2.get(base + 'state.json');
    return json(o ? await o.json() : { docs: {} });
  }
  const d = p.match(/^\/sync\/doc\/([a-z0-9-]+)$/);
  if (d && DOC.test(d[1])) {
    if (m === 'GET') { const o = await env.R2.get(base + 'doc/' + d[1]); return o ? new Response(o.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) : json({ error: 'nie je' }, 404); }
    if (m === 'PUT') {
      const body = await request.text();
      if (body.length > 20e6) return json({ error: 'príliš veľké' }, 413);
      const hash = hex(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body)));
      await env.R2.put(base + 'doc/' + d[1], body);
      const so = await env.R2.get(base + 'state.json'), st = so ? await so.json() : { docs: {} };
      st.docs[d[1]] = { hash, at: Date.now() };
      await env.R2.put(base + 'state.json', JSON.stringify(st));
      return json({ ok: true, hash });
    }
  }
  const bl = p.match(/^\/sync\/blob\/([a-f0-9]{40})$/);
  if (bl && SHA1.test(bl[1])) {
    const key = base + 'blob/' + bl[1];
    if (m === 'HEAD') { const h = await env.R2.head(key); return new Response(null, { status: h ? 200 : 404 }); }
    if (m === 'GET') { const o = await env.R2.get(key); return o ? new Response(o.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(o.size) } }) : new Response(null, { status: 404 }); }
    if (m === 'PUT') { await env.R2.put(key, request.body); return json({ ok: true }); }
  }
  return json({ error: 'nenájdené' }, 404);
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    // aplikácia nahlási svoju adresu
    if (p === '/api/register' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch (_) {}
      const id = String(b.id || ''), secret = String(b.secret || ''), target = String(b.url || '');
      if (!ID.test(id) || secret.length < 32) return json({ error: 'zlé údaje' }, 400);
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(target)) return json({ error: 'zlá adresa' }, 400);
      const h = await sha(secret);
      const cur = await env.KV.get('r:' + id, 'json');
      if (cur && cur.h !== h) return json({ error: 'tento odkaz patrí inému počítaču' }, 403);
      if (cur && cur.url === target) return json({ ok: true });
      await env.KV.put('r:' + id, JSON.stringify({ h, url: target, at: Date.now() }));
      return json({ ok: true });
    }
    // stránka rozcestníka zistí aktuálnu adresu
    const w = p.match(/^\/api\/where\/([a-z0-9]{10,32})$/);
    if (w) {
      const cur = await env.KV.get('r:' + w[1], 'json');
      return cur ? json({ url: cur.url, at: cur.at }) : json({ error: 'neznámy odkaz' }, 404);
    }
    if (p.startsWith('/sync/')) return syncApi(request, env, url);
    if (p === '/bugs' || p.startsWith('/bugs/')) return bugsApi(request, env, url);
    if (p === '/icon.png') { const r = await fetch(ICON_URL, { cf: { cacheTtl: 604800 } }); return new Response(r.body, { status: r.status, headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' } }); }
    if (ID.test(p.slice(1))) return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' } });
    if (p === '/') return new Response('JD Phone Studio – rozcestník funguje ✓', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response('Nenájdené', { status: 404 });
  },
};
