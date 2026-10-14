// Phone-sized layout, touch ergonomics and device-condition resilience.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld, VIEWPORTS } from './harness.mjs';
import { signUp, goNav, goStudio, recordTake } from './flows.mjs';

let world;
before(async () => { world = await startWorld(); });
after(async () => { await world.close(); });

const SCREENS = [['write', 'write'], ['beat', 'studio', 'beat'], ['keys', 'studio', 'keys'], ['record', 'studio', 'record'], ['mix', 'studio', 'mix'], ['feed', 'community'], ['collab', 'collab']];
const openScreen = async (d, [, nav, sub]) => { await goNav(d, nav); if (sub) await d.page.tap(`[data-studio="${sub}"]`); await d.page.waitForTimeout(250); };
const overflow = pg => pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const vp of Object.keys(VIEWPORTS)) {
  test(`[${vp}] every screen fits the width, keeps its nav on screen and raises no errors`, async () => {
    const d = await world.device(vp); const pg = d.page;
    await signUp(d, 'm' + Math.abs([...vp].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 100000);
    const { width, height } = VIEWPORTS[vp].viewport;
    for (const sc of SCREENS) {
      await openScreen(d, sc);
      assert.ok((await overflow(pg)) <= 1, `${sc[0]}: page scrolls sideways by ${await overflow(pg)}px`);
      const nav = await pg.$eval('#bottomNav', e => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return { top: r.top, bottom: r.bottom, h: r.height, vis: cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0 }; });
      assert.ok(nav.vis && nav.bottom <= height + 1 && nav.top > height * 0.7, `${sc[0]}: bottom nav on screen ${JSON.stringify(nav)}`);
      const tabs = await pg.$$eval('#bottomNav .bottom-tab', els => els.map(e => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right }; }));
      assert.ok(tabs.every(t => t.h >= 44 && t.w >= 44 && t.right <= width + 1), `${sc[0]}: nav tabs are tappable: ` + JSON.stringify(tabs));
    }
    assert.deepEqual(d.errors, [], d.errors.join('\n'));
    await d.ctx.close();
  });
}

test('page chrome: viewport meta, notch safe-area, theme colour and manifest are present', async () => {
  const d = await world.device('iphone-14 390x844'); await d.open();
  const info = await d.page.evaluate(() => ({ vp: document.querySelector('meta[name=viewport]')?.content || '', theme: !!document.querySelector('meta[name=theme-color]'), manifest: document.querySelector('link[rel=manifest]')?.href || '', lang: document.documentElement.lang, safe: [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => /safe-area-inset/.test(r.cssText)); } catch { return false; } }) }));
  assert.match(info.vp, /width=device-width/); assert.match(info.vp, /viewport-fit=cover/);
  assert.ok(info.theme && info.manifest && info.lang);
  assert.ok(info.safe, 'CSS uses env(safe-area-inset-*) so controls clear the notch/home bar');
  const res = await fetch(info.manifest); const m = await res.json();
  assert.ok(m.name && m.icons?.length && m.start_url && m.display, 'manifest is installable');
  await d.ctx.close();
});

test('touch targets: primary studio controls are at least 44x44 CSS px', async () => {
  const d = await world.device('iphone-14 390x844'); const pg = d.page; await signUp(d, 'touch_a');
  const checks = [['beat', ['#playBtn', '#beatBpmDown', '#beatBpmUp', '#beatTapTempo']], ['record', ['#vocalRecBtn', '#recSendMixBtn', '#recPlayVocalBtn']], ['mix', ['#mixPlayTop', '#mixMasterPlay', '#mixdownBtn', '#stemsBtn']]];
  const small = [];
  for (const [sub, sels] of checks) {
    await goStudio(d, sub);
    for (const sel of sels) { const r = await pg.$eval(sel, e => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; }); if (r.w < 44 || r.h < 44) small.push(`${sel} ${r.w}x${r.h}`); }
  }
  await goNav(d, 'collab'); await pg.tap('#focusJoinCodeBtn');
  for (const sel of ['#createRoomBtn', '#joinRoomBtn']) { const r = await pg.$eval(sel, e => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; }); if (r.w < 44 || r.h < 44) small.push(`${sel} ${r.w}x${r.h}`); }
  assert.deepEqual(small, [], 'controls below the 44px touch minimum: ' + small.join(', '));
  await d.ctx.close();
});

test('touch targets: beat pads are large enough to tap accurately', async () => {
  const d = await world.device('small-android 360x640'); const pg = d.page; await signUp(d, 'touch_b'); await goStudio(d, 'beat');
  const sizes = await pg.$$eval('#view-beat .st', els => els.slice(0, 16).map(e => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height); }));
  assert.ok(Math.min(...sizes) >= 18, 'smallest pad on the narrowest phone: ' + Math.min(...sizes).toFixed(1) + 'px (pads are scrolled/zoomed, not shrunk below ~18px)');
  await d.ctx.close();
});

test('landscape: layout survives rotation without overflow and the nav does not swallow the screen', async () => {
  const d = await world.device('iphone-14 390x844'); const pg = d.page; await signUp(d, 'rot_a'); await goStudio(d, 'mix');
  await pg.setViewportSize({ width: 844, height: 390 }); await pg.waitForTimeout(400);
  assert.ok((await overflow(pg)) <= 1, 'no sideways scroll in landscape');
  const navH = await pg.$eval('#bottomNav', e => e.getBoundingClientRect().height);
  assert.ok(navH <= 390 * 0.25, 'bottom nav takes at most a quarter of landscape height: ' + navH);
  await pg.setViewportSize({ width: 390, height: 844 }); await pg.waitForTimeout(300);
  assert.ok((await overflow(pg)) <= 1);
  assert.deepEqual(d.errors, []); await d.ctx.close();
});

test('microphone denied: recording fails gracefully, the UI recovers and nothing throws', async () => {
  const d = await world.device('pixel-7 412x915'); const pg = d.page;
  await d.ctx.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); });
  await signUp(d, 'nomic_a'); await goStudio(d, 'record');
  await pg.tap('#vocalRecBtn'); await pg.waitForTimeout(1500);
  const status = await pg.textContent('#recStatus');
  assert.match(status, /mic|microphone|permission|allow|denied|access/i, 'user is told why: ' + status);
  assert.ok(!(await pg.$eval('#vocalRecBtn', e => /recording|stop/i.test(e.textContent + e.className))), 'REC button is not stuck');
  assert.equal(await pg.$$eval('#vocalTakes .vocal-take-item', e => e.length), 0, 'no phantom take');
  await pg.tap('#vocalRecBtn'); await pg.waitForTimeout(600);                      // user can retry
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('no microphone hardware: same graceful failure', async () => {
  const d = await world.device('pixel-7 412x915'); const pg = d.page;
  await d.ctx.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError')); });
  await signUp(d, 'nomic_b'); await goStudio(d, 'record'); await pg.tap('#vocalRecBtn'); await pg.waitForTimeout(1200);
  assert.match(await pg.textContent('#recStatus'), /mic|microphone|device|found|access/i);
  assert.deepEqual(d.errors, []); await d.ctx.close();
});

test('backgrounding while playing or recording does not crash or wedge the app', async () => {
  const d = await world.device('iphone-14 390x844'); const pg = d.page; await signUp(d, 'bg_a');
  await goStudio(d, 'beat'); await pg.tap('#playBtn'); await pg.waitForTimeout(600);
  await pg.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide')); });
  await pg.waitForTimeout(500);
  await pg.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow')); });
  await pg.waitForTimeout(400);
  const state = await pg.textContent('#transportStatus');
  if (/playing/i.test(state)) await pg.tap('#playBtn');
  await pg.waitForFunction(() => /stopped/i.test(document.getElementById('transportStatus')?.textContent || ''), null, { timeout: 4000 });
  await pg.tap('#playBtn'); await pg.waitForFunction(() => /playing/i.test(document.getElementById('transportStatus')?.textContent || ''), null, { timeout: 4000 });   // still playable afterwards
  await pg.tap('#playBtn');
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('rapid interaction: hammering transport, tempo and pads does not throw or desync', async () => {
  const d = await world.device('small-android 360x640'); const pg = d.page; await signUp(d, 'rapid_a'); await goStudio(d, 'beat');
  for (let i = 0; i < 12; i++) { await pg.tap('#playBtn'); }
  await pg.waitForTimeout(300);
  const status = await pg.textContent('#transportStatus'), btn = await pg.textContent('#playBtn');
  assert.ok(/stopped|playing/i.test(status));
  assert.equal(/playing/i.test(status), btn.includes('■'), 'transport label and button glyph agree: ' + status + ' / ' + btn);
  const b0 = Number(await pg.textContent('#beatBpmValue'));
  for (let i = 0; i < 20; i++) await pg.tap('#beatBpmUp');
  assert.equal(Number(await pg.textContent('#beatBpmValue')), Math.min(200, b0 + 20));
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('slow/failed network: the studio keeps working and a failed save does not break editing', async () => {
  const d = await world.device('iphone-14 390x844'); const pg = d.page; await signUp(d, 'net_a'); await goStudio(d, 'beat');
  await d.ctx.setOffline(true);
  const pad = await pg.$('#view-beat .st:not(.on)'); await pad.tap(); await pg.tap('#beatBpmUp'); await pg.tap('#playBtn'); await pg.waitForTimeout(800); await pg.tap('#playBtn');
  assert.ok(await pad.evaluate(e => e.classList.contains('on')), 'edits apply locally while offline');
  await d.ctx.setOffline(false); await pg.waitForTimeout(500);
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});
