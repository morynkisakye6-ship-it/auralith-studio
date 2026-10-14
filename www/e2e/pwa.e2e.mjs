// Installable-app behaviour: service worker, offline start, and a signed-in session surviving a cold offline launch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './harness.mjs';
import { signUp, goStudio, goNav } from './flows.mjs';


const SDK = /cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/;
async function goOffline(d) { await d.ctx.setOffline(true); await d.ctx.route(SDK, r => r.abort('internetdisconnected')); }

let world;
before(async () => { world = await startWorld(); });
after(async () => { await world.close(); });

test('service worker installs, activates and precaches the app shell', async () => {
  const d = await world.device('pixel-7 412x915', { serviceWorkers: 'allow' });
  await d.open();
  await d.page.evaluate(() => navigator.serviceWorker.ready);
  await d.page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated', null, { timeout: 8000 });
  await d.page.waitForTimeout(800);
  const cached = await d.page.evaluate(async () => { const names = await caches.keys(); const out = {}; for (const n of names) out[n] = (await (await caches.open(n)).keys()).map(r => new URL(r.url).pathname); return out; });
  const files = Object.values(cached).flat();
  for (const must of ['/index.html', '/app.js', '/js/cloud.js', '/js/state.js', '/manifest.webmanifest']) assert.ok(files.includes(must), `${must} is precached: ${files.join(', ')}`);
  const gens = Object.keys(cached).filter(n => !/^tapehead-cdn/.test(n));
  assert.equal(gens.length, 1, 'exactly one shell cache generation: ' + gens);
  assert.ok(Object.keys(cached).some(n => /^tapehead-cdn/.test(n) && cached[n].some(p => /supabase-js/.test(p))), 'the Supabase SDK is cached for offline starts: ' + JSON.stringify(Object.keys(cached)));
  assert.deepEqual(d.errors, []);
  await d.ctx.close();
});

test('cold start with no network: the installed app still opens', async () => {
  const d = await world.device('pixel-7 412x915', { serviceWorkers: 'allow' });
  await d.open(); await d.page.evaluate(() => navigator.serviceWorker.ready); await d.page.waitForTimeout(1000);
  await goOffline(d);
  await d.page.reload({ waitUntil: 'domcontentloaded' });
  assert.match(await d.page.title(), /Tapehead/);
  await d.page.waitForSelector('#authModal.show, [data-nav="studio"]', { timeout: 8000 });
  const fatal = d.errors.filter(e => !/Failed to load|ERR_INTERNET_DISCONNECTED|fetch/i.test(e));
  assert.deepEqual(fatal, [], fatal.join('\n'));
  await d.ctx.close();
});

test('a signed-in artist who relaunches offline keeps their session and can open the studio', async () => {
  const d = await world.device('iphone-14 390x844', { serviceWorkers: 'allow' });
  await signUp(d, 'offline_a');
  await d.page.evaluate(() => navigator.serviceWorker.ready); await d.page.waitForTimeout(1200);
  await goOffline(d);
  await d.page.reload({ waitUntil: 'domcontentloaded' });
  await d.page.waitForSelector('[data-nav="studio"]', { timeout: 10000 });
  assert.ok(!(await d.page.$eval('#authModal', e => e.classList.contains('show'))), 'not bounced to the sign-in wall');
  await goStudio(d, 'beat');
  const pad = await d.page.$('#view-beat .st:not(.on)'); await pad.tap();
  await d.page.tap('#playBtn'); await d.page.waitForFunction(() => /playing/i.test(document.getElementById('transportStatus')?.textContent || ''));
  await d.page.tap('#playBtn');
  const fatal = d.errors.filter(e => !/Failed to load|ERR_INTERNET_DISCONNECTED|fetch|NetworkError/i.test(e));
  assert.deepEqual(fatal, [], fatal.join('\n'));
  await d.ctx.close();
});

test('API calls are never served from the cache (no stale entitlement or payment state)', async () => {
  const d = await world.device('pixel-7 412x915', { serviceWorkers: 'allow' });
  await d.open(); await d.page.evaluate(() => navigator.serviceWorker.ready);
  const cachedApi = await d.page.evaluate(async () => { const out = []; for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) if (new URL(r.url).pathname.startsWith('/api/')) out.push(r.url); return out; });
  assert.deepEqual(cachedApi, []);
  await d.ctx.close();
});

test('manifest icons referenced by the app exist on disk', async t => {
  const fs = await import('node:fs'); const { WWW } = await import('./harness.mjs');
  const m = JSON.parse(fs.readFileSync(WWW + '/manifest.webmanifest', 'utf8'));
  const present = m.icons.filter(i => fs.existsSync(WWW + '/' + i.src.replace(/^\.?\//, '')));
  if (present.length === 0) return t.skip('no icon files in this checkout (e.g. a stripped archive); runs in CI against the full repo');
  const missing = m.icons.filter(i => !present.includes(i)).map(i => i.src);
  assert.deepEqual(missing, [], 'manifest icons missing from the build: ' + missing.join(', '));
  const html = fs.readFileSync(WWW + '/index.html', 'utf8');
  for (const href of [...html.matchAll(/rel="apple-touch-icon"[^>]*href="([^"]+)"/g)].map(x => x[1])) assert.ok(fs.existsSync(WWW + '/' + href), 'apple-touch-icon exists: ' + href);
});
