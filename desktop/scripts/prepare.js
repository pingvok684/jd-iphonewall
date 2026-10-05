// Pred zostavením aplikácie: skopíruje súbory stránky (z hlavného priečinka) do desktop/app-files.
// Nikdy nekopíruje nastavenia, kľúče ani dáta (config.json, labels.json, templates.json, data/).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'app-files');
const SKIP = new Set(['config.json', 'labels.json', 'templates.json', 'package.json', 'package-lock.json']);
const OK_EXT = /\.(js|html|json|md|ipa|png|ico|txt)$/i;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (e.isFile() && OK_EXT.test(e.name) && !SKIP.has(e.name)) { fs.copyFileSync(path.join(ROOT, e.name), path.join(OUT, e.name)); n++; }
}
fs.cpSync(path.join(ROOT, 'public'), path.join(OUT, 'public'), { recursive: true, filter: (s) => !s.endsWith('.DS_Store') });
for (const need of ['server.js', 'version.json', 'public/index.html']) {
  if (!fs.existsSync(path.join(OUT, need))) { console.error('Chýba ' + need); process.exit(1); }
}
console.log(`app-files: ${n} súborov + public/ (verzia ${JSON.parse(fs.readFileSync(path.join(OUT, 'version.json'), 'utf8')).version})`);
