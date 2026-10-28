import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const cap = JSON.parse(read('capacitor.config.json'));
const manifest = JSON.parse(read('www/manifest.webmanifest'));
const html = read('www/index.html');
const cssTokens = [
  '--bg:#0E1113', '--panel:#15191C', '--panel2:#1C2124',
  '--brass:#C47A45', '--indigo:#6B9FA8', '--green:#68A77F'
];

assert.equal(pkg.name, 'auralith-studio-native');
assert.equal(pkg.version, '2.0.6');
assert.equal(cap.appName, 'Auralith Studio');
assert.equal(cap.appId, 'com.tapehead.pro', 'Keep app ID stable for installed-app upgrade continuity');
assert.ok(cap.server.url.startsWith('https://'), 'Native shell must use HTTPS');
assert.equal(cap.server.cleartext, false, 'Cleartext network traffic must remain disabled');
assert.equal(manifest.name, 'Auralith Studio');
assert.equal(manifest.short_name, 'Auralith');
for (const token of cssTokens) assert.ok(html.includes(token), `Preserved visual token missing: ${token}`);
for (const file of ['www/index.html','www/app.js','www/sw.js','www/js/runtime.js','www/js/cloud.js','www/js/state.js','www/js/project-store.js','www/js/project-sync.js']) {
  assert.ok(fs.statSync(path.join(root,file)).size > 0, `Required runtime file empty: ${file}`);
}
// Parse real <script> elements. An unclosed tag makes the browser swallow the NEXT script tag as text, so
// every external script must have an empty body and be properly closed (this shipped broken in v2.0.2).
const scriptEls = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const opens = (html.match(/<script\b/gi) || []).length;
assert.equal(scriptEls.length, opens, 'Every <script> tag in index.html must be closed with </script>');
const external = scriptEls.map(m => ({ src: (m[1].match(/\bsrc="([^"]+)"/) || [])[1], body: m[2] })).filter(e => e.src);
for (const e of external) assert.equal(e.body.trim(), '', `External script ${e.src} must not contain inline text (unclosed tag swallows the next script)`);
const order = (name) => external.findIndex(e => e.src.startsWith(name));
for (const name of ['js/runtime.js', 'js/project-store.js', 'js/project-sync.js', 'js/cloud.js', 'app.js']) {
  assert.ok(order(name) >= 0, `${name} must load as a real script element`);
}
assert.ok(order('js/project-store.js') < order('app.js'), 'Project store must load before the app runtime');
assert.ok(order('js/project-sync.js') < order('js/cloud.js'), 'Project sync must load before the cloud layer');
assert.ok(order('js/project-sync.js') < order('app.js'), 'Project sync must load before the app runtime');
assert.ok(external.every(e => !/\?v=2\.0\.[012]\b(?!\d)/.test(e.src) || !e.src.startsWith('js/project-')), 'Project modules must carry the current version');
assert.ok(read('www/sw.js').includes('js/project-sync.js'), 'Service worker must pre-cache the project sync module');
// Brand guard: the product is Auralith. The old name may survive ONLY inside these external contracts, which cannot be
// renamed without a coordinated migration (store listing, hosting domain, live database, saved user media).
const LEGACY_CONTRACTS = ['com.tapehead.pro', 'tapehead-pro-phi.vercel.app', 'claim_tapehead_job', 'tapehead_jobs', 'tapehead-media'];
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (['node_modules', '.git'].includes(e.name)) return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
for (const file of walk(root)) {
  if (path.relative(root, file) === path.join('scripts', 'verify-engineering.mjs')) continue;   // this guard necessarily names the old brand
  if (/\.(png|jpe?g|webp|ico|icns|zip|woff2?|mp3|wav)$/i.test(file)) continue;
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;
  let masked = text; for (const t of LEGACY_CONTRACTS) masked = masked.split(t).join('');
  assert.ok(!/tapehead/i.test(masked), `Old product name found in ${path.relative(root, file)}; use Auralith (only ${LEGACY_CONTRACTS.join(', ')} may keep the old name)`);
}

console.log('Auralith engineering checks passed: identity, upgrade continuity, HTTPS, visual tokens, and project store/sync script integrity and load order.');
