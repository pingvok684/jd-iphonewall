// Video Upscaler (nástroj v JD Phone Studio) – zväčšenie videa AI (Real-ESRGAN) + plynulejší pohyb (RIFE, 60 fps).
// Beží lokálne na grafike počítača (Vulkan) – Windows aj Mac. Programy (ffmpeg, Real-ESRGAN, RIFE) sa stiahnu
// pri prvom použití do bin/upscaler/ (~150 MB) z ich oficiálnych stránok na GitHube.
// Prepis pôvodného „Video Upscaler“ (Python) do Node – netreba inštalovať Python.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32', IS_MAC = process.platform === 'darwin';
const ROOT = __dirname;
const TOOLS = path.join(ROOT, 'bin', 'upscaler');
const MY_MODELS = path.join(ROOT, 'public', 'tools', 'upscaler-models'); // vlastný „prirodzený“ model (realesr-general-wdn-x4v3)
let OUT_DIR = path.join(ROOT, 'data', 'upscaled');
const EXE = IS_WIN ? '.exe' : '';

// ---------- programy na stiahnutie ----------
const GH = 'https://github.com';
const PLAT = IS_WIN ? 'windows' : IS_MAC ? 'macos' : 'ubuntu';
const FF_PLAT = IS_WIN ? 'win32-x64' : IS_MAC ? `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : 'linux-x64';
const DOWNLOADS = [
  { key: 'esrgan', label: 'Real-ESRGAN (AI zväčšenie)', url: `${GH}/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-${PLAT}.zip`, zip: true, exe: 'realesrgan-ncnn-vulkan' },
  { key: 'rife', label: 'RIFE (60 fps)', url: `${GH}/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-${PLAT}.zip`, zip: true, exe: 'rife-ncnn-vulkan' },
  { key: 'ffmpeg', label: 'FFmpeg (spracovanie videa)', url: `${GH}/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-${FF_PLAT}.gz`, gz: true, exe: 'ffmpeg' },
];
const install = { running: false, step: '', pct: 0, error: '' };

function findFile(dir, name, depth = 4) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const r = findFile(p, name, depth - 1); if (r) return r; }
  }
  return null;
}
function findDir(dir, name, depth = 4) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === name) return p;
    const r = findDir(p, name, depth - 1); if (r) return r;
  }
  return null;
}
function paths() {
  const ff = path.join(TOOLS, 'ffmpeg', 'ffmpeg' + EXE);
  const esr = findFile(path.join(TOOLS, 'esrgan'), 'realesrgan-ncnn-vulkan' + EXE);
  const rife = findFile(path.join(TOOLS, 'rife'), 'rife-ncnn-vulkan' + EXE);
  return {
    ffmpeg: fs.existsSync(ff) ? ff : null,
    esrgan: esr, esrganModels: esr ? path.join(path.dirname(esr), 'models') : null,
    rife, rifeModel: rife ? findDir(path.dirname(rife), 'rife-v4.6', 1) : null,
  };
}
const ready = () => { const p = paths(); return !!(p.ffmpeg && p.esrgan && p.rife && p.rifeModel); };

async function download(url, file, onPct) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`sťahovanie zlyhalo (${r.status}) – ${url.split('/').pop()}`);
  const total = +r.headers.get('content-length') || 0;
  const out = fs.createWriteStream(file);
  let got = 0;
  for await (const chunk of r.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
    if (total) onPct(got / total);
  }
  await new Promise((ok, no) => { out.end(ok); out.on('error', no); });
}
const unzip = (zip, dir) => new Promise((ok, no) => {
  fs.mkdirSync(dir, { recursive: true });
  // Windows 10+ má tar, ktorý rozbalí aj zip; Mac má unzip
  const [bin, args] = IS_WIN ? ['tar', ['-xf', zip, '-C', dir]] : ['unzip', ['-q', '-o', zip, '-d', dir]];
  execFile(bin, args, { windowsHide: true, maxBuffer: 1e7 }, (e, so, se) => (e ? no(new Error('rozbalenie zlyhalo: ' + String(se || e.message).slice(-200))) : ok()));
});

async function installTools() {
  if (install.running) return;
  Object.assign(install, { running: true, error: '', pct: 0 });
  try {
    fs.mkdirSync(TOOLS, { recursive: true });
    for (const [i, d] of DOWNLOADS.entries()) {
      const target = path.join(TOOLS, d.key);
      const have = d.key === 'ffmpeg' ? paths().ffmpeg : d.key === 'esrgan' ? paths().esrgan : paths().rife;
      if (have) continue;
      install.step = `Sťahujem ${d.label}…`;
      const tmp = path.join(TOOLS, `${d.key}.download`);
      await download(d.url, tmp, (f) => { install.pct = Math.round(((i + f) / DOWNLOADS.length) * 100); });
      install.step = `Rozbaľujem ${d.label}…`;
      fs.rmSync(target, { recursive: true, force: true });
      if (d.zip) await unzip(tmp, target);
      else {
        fs.mkdirSync(target, { recursive: true });
        await new Promise((ok, no) => fs.createReadStream(tmp).pipe(zlib.createGunzip()).pipe(fs.createWriteStream(path.join(target, d.exe + EXE))).on('finish', ok).on('error', no));
      }
      fs.rmSync(tmp, { force: true });
    }
    // spustiteľné + na Macu zrušiť karanténu (inak by ich macOS mohol zablokovať)
    const p = paths();
    for (const f of [p.ffmpeg, p.esrgan, p.rife]) if (f && !IS_WIN) { try { fs.chmodSync(f, 0o755); } catch (_) {} }
    if (IS_MAC) try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', TOOLS]); } catch (_) {}
    // Apple Silicon spustí len podpísané programy – podpíšeme ich lokálne (ad-hoc), ak podpis chýba
    if (IS_MAC) for (const f of [p.ffmpeg, p.esrgan, p.rife]) { if (f) try { execFileSync('codesign', ['--verify', f]); } catch (_) { try { execFileSync('codesign', ['--force', '-s', '-', f]); } catch (_) {} } }
    // náš „prirodzený“ model k modelom Real-ESRGAN
    if (p.esrganModels) fs.mkdirSync(p.esrganModels, { recursive: true });
    if (p.esrganModels && fs.existsSync(MY_MODELS)) for (const f of fs.readdirSync(MY_MODELS)) fs.copyFileSync(path.join(MY_MODELS, f), path.join(p.esrganModels, f));
    if (!ready()) throw new Error('po stiahnutí chýbajú niektoré súbory – skús znova');
    install.step = 'Hotovo'; install.pct = 100;
  } catch (e) {
    install.error = e.message; install.step = '';
  } finally { install.running = false; }
}

// ---------- pomocné ----------
// Windows: krátka (8.3) ASCII cesta – ncnn programy nemajú problém s „á“ v mene používateľa
function shortPath(p) {
  if (!IS_WIN) return p;
  try { fs.mkdirSync(p, { recursive: true }); const o = execFileSync('cmd', ['/c', `for %I in ("${p}") do @echo %~sI`], { windowsHide: true }).toString().trim(); return o || p; } catch (_) { return p; }
}
let WORK = null;
const work = () => (WORK = WORK || path.join(shortPath(os.tmpdir()), 'jd-upscaler'));
const MODELS = { natural: ['realesr-general-wdn-x4v3', 60], heavy: ['realesrgan-x4plus', 40] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (d) => { try { return fs.readdirSync(d).length; } catch (_) { return 0; } };
class Cancelled extends Error {}

function runProc(args, job, opts = {}) {
  return new Promise((ok, no) => {
    const p = spawn(args[0], args.slice(1), { windowsHide: true, stdio: ['ignore', opts.stdout ? 'pipe' : 'ignore', 'pipe'] });
    job._proc = p;
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    if (opts.stdout) p.stdout.on('data', opts.stdout);
    p.on('error', (e) => no(e));
    p.on('exit', (code) => {
      job._proc = null;
      if (job.cancel) return no(new Cancelled());
      if (code !== 0) return no(new Error(`${path.basename(args[0])} zlyhal: ${err.trim().split(/\r?\n/).slice(-3).join(' | ')}`));
      ok();
    });
  });
}
// spustí proces a počas behu volá tick() (napr. počíta hotové snímky)
async function runWatch(args, job, tick) {
  const pr = runProc(args, job);
  let done = false; pr.then(() => (done = true), () => (done = true));
  while (!done) { tick(); await sleep(500); }
  return pr;
}

function probe(ff, file) {
  return new Promise((ok, no) => execFile(ff, ['-hide_banner', '-i', file], { windowsHide: true, maxBuffer: 1e7 }, (e, so, se) => {
    const s = String(se || '');
    const v = s.match(/Stream #\S+.*Video: .*?(\d{2,5})x(\d{2,5})/);
    if (!v) return no(new Error('Súbor nevyzerá ako video.'));
    const fps = s.match(/([\d.]+) fps/), dur = s.match(/Duration: (\d+):(\d+):([\d.]+)/), rot = s.match(/rotate\s*:\s*(-?\d+)|rotation of (-?[\d.]+)/);
    let w = +v[1], h = +v[2];
    if (rot && Math.abs(Math.round(parseFloat(rot[1] || rot[2]))) % 180 === 90) [w, h] = [h, w];
    ok({ w, h, fps: fps ? parseFloat(fps[1]) : 30, dur: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0, audio: /Stream #\S+.*Audio:/.test(s) });
  }));
}
const STD = [[9, 16], [16, 9], [1, 1], [4, 5], [5, 4], [3, 4], [4, 3], [2, 3], [3, 2]];
function targetSize(w, h, short) {
  for (const [a, b] of STD) if (Math.abs((w / h) / (a / b) - 1) < 0.015) { const k = short / Math.min(a, b); return [Math.round(a * k / 2) * 2, Math.round(b * k / 2) * 2]; }
  const k = short / Math.min(w, h); return [Math.round(w * k / 2) * 2, Math.round(h * k / 2) * 2];
}
function uniqueOut(name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = (path.parse(name).name.replace(/[<>:"/\\|?*]+/g, '_').slice(0, 120)) || 'video';
  let p = path.join(OUT_DIR, `${base}_upscaled.mp4`), i = 2;
  while (fs.existsSync(p)) p = path.join(OUT_DIR, `${base}_upscaled_${i++}.mp4`);
  return p;
}

// ---------- spracovanie ----------
const jobs = new Map(); const order = [];
let busy = false;
function setStage(job, stage, lo, hi) { job.stage = stage; job._lo = lo; job._hi = hi; job.progress = lo; }
const sub = (job, f) => { job.progress = job._lo + (job._hi - job._lo) * Math.max(0, Math.min(1, f)); };

async function processJob(job) {
  const P = paths(), FF = P.ffmpeg, s = job.settings, d = path.join(work(), job.id), src = job.src, info = job.info;
  const [tw, th] = targetSize(info.w, info.h, +s.res);
  job.target = `${tw}×${th}`;
  const ai = Math.max(0, Math.min(100, +s.ai)) / 100, tfps = +s.fps > 0 ? +s.fps : null;
  const frames = path.join(d, 'frames'), mid = path.join(d, 'mid'), interp = path.join(d, 'interp');
  for (const x of [frames, mid, interp]) fs.mkdirSync(x, { recursive: true });
  const doRife = tfps && tfps > info.fps * 1.05;
  const wAi = ai <= 0 ? 0 : s.model === 'heavy' ? 80 : 45, wRife = doRife ? 25 : 0, wRest = 25, tot = wAi + wRife + wRest;
  let a = 0; const span = (w) => { const lo = a; a += w * 100 / tot; return [lo, a]; };

  // 1) rozloženie na snímky
  setStage(job, 'Rozkladám video na snímky', ...span(wRest * 0.3));
  if (ai > 0) await runProc([FF, '-v', 'error', '-y', '-i', src, '-fps_mode', 'passthrough', path.join(frames, '%08d.png')], job);
  else await runProc([FF, '-v', 'error', '-y', '-i', src, '-fps_mode', 'passthrough', '-vf', `scale=${tw}:${th}:flags=lanczos`, path.join(mid, '%08d.png')], job);
  const n = ai > 0 ? count(frames) : count(mid);
  if (n < 2) throw new Error('Z videa sa nepodarilo vytiahnuť snímky.');
  let srcFps = info.dur > 0.3 ? n / info.dur : info.fps;
  if (Math.abs(srcFps - info.fps) < 0.6) srcFps = info.fps;

  // 2) AI zväčšenie po dávkach + zmiešanie s obyčajným zväčšením (prirodzenejšia tvár)
  if (ai > 0) {
    const [model, chunk] = MODELS[s.model] || MODELS.natural;
    setStage(job, 'AI zväčšenie (Real-ESRGAN)', ...span(wAi));
    const names = fs.readdirSync(frames).sort(); const t0 = Date.now();
    const blend = `[0]scale=${tw}:${th}:flags=lanczos[l];[1]scale=${tw}:${th}:flags=lanczos[a];[l][a]blend=all_expr='A*${(1 - ai).toFixed(3)}+B*${ai.toFixed(3)}'`;
    let pending = null; // miešanie predchádzajúcej dávky beží súbežne s ďalšou dávkou AI
    const finishBlend = async () => { if (!pending) return; const [pr, dirs] = pending; pending = null; await pr; for (const x of dirs) fs.rmSync(x, { recursive: true, force: true }); };
    for (let i = 0; i < n; i += chunk) {
      const cin = path.join(d, `cin${i}`), cout = path.join(d, `cout${i}`);
      for (const x of [cin, cout]) fs.mkdirSync(x, { recursive: true });
      const part = names.slice(i, i + chunk);
      part.forEach((nm, k) => fs.renameSync(path.join(frames, nm), path.join(cin, `${String(k + 1).padStart(8, '0')}.png`)));
      await runWatch([P.esrgan, '-i', cin, '-o', cout, '-n', model, '-s', '4', '-m', P.esrganModels, '-f', 'png', '-j', '2:2:4'], job, () => {
        const done = i + count(cout); sub(job, done / n);
        if (done > 2) job.eta_stage = (Date.now() - t0) / 1000 / done * (n - done);
      }).catch((e) => { throw e instanceof Cancelled ? e : new Error('Real-ESRGAN zlyhal (skontroluj ovládače grafiky). ' + e.message.slice(-160)); });
      if (count(cout) < part.length) throw new Error('Real-ESRGAN zlyhal (skontroluj ovládače grafiky).');
      await finishBlend();
      const bjob = {}; // vlastný „job“, aby sa nezrušil proces AI
      const pr = runProc([FF, '-v', 'error', '-y', '-i', path.join(cin, '%08d.png'), '-i', path.join(cout, '%08d.png'), '-filter_complex', blend,
        '-compression_level', '1', '-start_number', String(i + 1), path.join(mid, '%08d.png')], bjob);
      pr.catch(() => {});
      job._blend = bjob;
      pending = [pr, [cin, cout]];
      if (job.cancel) throw new Cancelled();
    }
    await finishBlend();
    delete job.eta_stage;
    fs.rmSync(frames, { recursive: true, force: true });
  }

  // 3) dopočítanie snímok
  let seq = mid, outFps = srcFps;
  if (doRife) {
    setStage(job, `Plynulosť ${tfps} fps (RIFE)`, ...span(wRife));
    const m = Math.round(n * tfps / srcFps), t0 = Date.now();
    await runWatch([P.rife, '-i', mid, '-o', interp, '-m', P.rifeModel, '-n', String(m), '-f', '%08d.png', '-j', '4:4:8'], job, () => {
      const done = count(interp); sub(job, done / m); if (done > 4) job.eta_stage = (Date.now() - t0) / 1000 / done * (m - done);
    }).catch((e) => { throw e instanceof Cancelled ? e : new Error('RIFE zlyhal (skontroluj ovládače grafiky). ' + e.message.slice(-160)); });
    delete job.eta_stage;
    if (count(interp) < m * 0.9) throw new Error('RIFE zlyhal (skontroluj ovládače grafiky).');
    fs.rmSync(mid, { recursive: true, force: true });
    seq = interp; outFps = tfps;
  }

  // 4) zakódovanie: H.264 High, bt709, ~16 Mb/s, AAC 48 kHz
  setStage(job, 'Kódujem výsledné video', ...span(wRest * 0.7));
  const sharp = Math.max(0, Math.min(100, +s.sharp)) / 100, grain = Math.max(0, Math.min(20, +s.grain));
  const vf = [];
  if (sharp > 0) vf.push(`cas=${sharp.toFixed(2)}`);
  if (grain > 0) vf.push(`noise=alls=${grain}:allf=t`);
  vf.push('scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
  const mbps = +s.bitrate || 16, tmpOut = path.join(d, 'out.mp4'), total = count(seq);
  const args = [FF, '-v', 'error', '-progress', 'pipe:1', '-nostats', '-y', '-framerate', outFps.toFixed(6), '-i', path.join(seq, '%08d.png')];
  if (info.audio) args.push('-i', src, '-map', '0:v', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest');
  args.push('-vf', vf.join(','), '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'fast', '-b:v', `${mbps}M`, '-maxrate', `${Math.round(mbps * 1.25)}M`, '-bufsize', `${mbps * 2}M`,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-map_metadata', '-1', '-movflags', '+faststart', tmpOut);
  await runProc(args, job, { stdout: (b) => { const m = String(b).match(/frame=(\d+)/g); if (m && total) sub(job, +m.pop().slice(6) / total); } })
    .catch((e) => { throw e instanceof Cancelled ? e : new Error('Kódovanie zlyhalo: ' + e.message.slice(-200)); });
  const out = uniqueOut(job.name);
  fs.copyFileSync(tmpOut, out);
  Object.assign(job, { out, out_name: path.basename(out), out_size: fs.statSync(out).size, out_fps: Math.round(outFps * 100) / 100 });
}

async function worker() {
  if (busy) return; busy = true;
  try {
    let job;
    while ((job = order.map((i) => jobs.get(i)).find((j) => j && j.status === 'queued'))) {
      job.status = 'running'; job.started = Date.now() / 1000;
      try { await processJob(job); Object.assign(job, { status: 'done', progress: 100, stage: 'Hotovo' }); }
      catch (e) {
        if (e instanceof Cancelled || job.cancel) Object.assign(job, { status: 'cancelled', stage: 'Zrušené' });
        else Object.assign(job, { status: 'error', stage: e.message || String(e) });
      } finally {
        job.finished = Date.now() / 1000;
        fs.rm(path.join(work(), job.id), { recursive: true, force: true }, () => {});
      }
    }
  } finally { busy = false; }
}

const PUBLIC = ['id', 'name', 'status', 'stage', 'progress', 'settings', 'target', 'out_name', 'out_size', 'out_fps', 'eta_stage', 'started', 'finished', 'info', 'size', 'libId'];
const pub = (j) => Object.fromEntries(PUBLIC.map((k) => [k, j[k]]));

// ---------- HTTP (/api/upscaler/...) ----------
// ctx = { json, addToLibrary(stream, name) → Promise<item>, openPath(file|dir, select) }
async function handle(req, res, parts, url, ctx) {
  const { json } = ctx; const a = parts[2];
  if (req.method === 'GET' && a === 'status') return json(res, 200, { ready: ready(), install: { ...install }, platform: process.platform, outDir: OUT_DIR });
  if (req.method === 'POST' && a === 'install') { installTools(); return json(res, 200, { ok: true }); }
  if (req.method === 'GET' && a === 'jobs') return json(res, 200, { jobs: order.map((i) => jobs.get(i)).filter(Boolean).map(pub), now: Date.now() / 1000 });
  if (req.method === 'POST' && a === 'upload') {
    if (!ready()) return json(res, 400, { error: 'Najprv stiahni programy pre upscaler.' });
    const name = path.basename(url.searchParams.get('name') || 'video.mp4');
    let settings = {}; try { settings = JSON.parse(url.searchParams.get('settings') || '{}'); } catch (_) {}
    settings = { res: 1080, fps: 60, model: 'natural', ai: 60, sharp: 30, grain: 3, bitrate: 16, ...settings };
    const id = crypto.randomBytes(6).toString('hex'), d = path.join(work(), id);
    fs.mkdirSync(d, { recursive: true });
    const src = path.join(d, 'src' + (path.extname(name).toLowerCase() || '.mp4'));
    await new Promise((ok, no) => { const o = fs.createWriteStream(src); req.pipe(o); o.on('finish', ok); o.on('error', no); });
    const job = { id, name, src, settings, status: 'queued', stage: 'Čaká v poradí', progress: 0, size: fs.statSync(src).size };
    try { job.info = await probe(paths().ffmpeg, src); } catch (e) { fs.rmSync(d, { recursive: true, force: true }); return json(res, 400, { error: e.message }); }
    jobs.set(id, job); order.push(id);
    worker();
    return json(res, 200, { id });
  }
  const job = parts[3] && jobs.get(parts[3]);
  if ((a === 'download' || a === 'stream') && req.method === 'GET') {
    if (!job || !job.out || !fs.existsSync(job.out)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(job.out).size, range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    const head = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Disposition': `${a === 'download' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(job.out_name)}` };
    if (range && a === 'stream') {
      const s = range[1] ? +range[1] : 0, e = range[2] ? Math.min(+range[2], size - 1) : size - 1;
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 });
      return fs.createReadStream(job.out, { start: s, end: e }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': size });
    return fs.createReadStream(job.out).pipe(res);
  }
  if (req.method === 'POST' && (a === 'cancel' || a === 'remove')) {
    if (!job) return json(res, 404, { error: 'nenájdené' });
    if (job.status === 'queued' || job.status === 'running') {
      job.cancel = true;
      for (const p of [job._proc, job._blend && job._blend._proc]) { try { p && p.kill(); } catch (_) {} }
      if (job.status === 'queued') { Object.assign(job, { status: 'cancelled', stage: 'Zrušené' }); fs.rm(path.join(work(), job.id), { recursive: true, force: true }, () => {}); }
    }
    if (a === 'remove' && !['queued', 'running'].includes(job.status)) { jobs.delete(job.id); const i = order.indexOf(job.id); if (i >= 0) order.splice(i, 1); }
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && a === 'library') {
    if (!job || !job.out || !fs.existsSync(job.out)) return json(res, 404, { error: 'nenájdené' });
    try { const it = await ctx.addToLibrary(fs.createReadStream(job.out), job.out_name, url.searchParams.get('owner') || ''); job.libId = it.id; return json(res, 200, { ok: true, item: it }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (req.method === 'POST' && a === 'open-folder') {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    ctx.openPath(job && job.out && fs.existsSync(job.out) ? job.out : OUT_DIR, !!(job && job.out));
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'nenájdené' });
}

function init(dataDir) { OUT_DIR = path.join(dataDir, 'upscaled'); fs.rm(work(), { recursive: true, force: true }, () => {}); }

module.exports = { handle, init, ready, paths, DOWNLOADS };
