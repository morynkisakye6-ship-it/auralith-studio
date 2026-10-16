// Regression coverage for mobile transient messages and bottom-sheet dialogs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld, VIEWPORTS } from './harness.mjs';

let world;
before(async () => { world = await startWorld(); });
after(async () => { await world.close(); });

for (const vp of ['small-android 360x640', 'iphone-14 390x844', 'pixel-7 412x915']) {
  test(`[${vp}] long command messages stay inside the viewport`, async () => {
    const d = await world.device(vp);
    const pg = d.page;
    await d.open();
    await pg.evaluate(() => toast(
      'Payment is still processing. Pro turns on automatically once Pesapal confirms it.',
      5000
    ));
    const r = await pg.$eval('#toast', e => {
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return {
        left: b.left, right: b.right, top: b.top, bottom: b.bottom,
        width: b.width, height: b.height,
        whiteSpace: cs.whiteSpace,
        overflowWrap: cs.overflowWrap,
        wordBreak: cs.wordBreak,
        visible: e.classList.contains('show')
      };
    });
    const width = VIEWPORTS[vp].viewport.width;
    const height = VIEWPORTS[vp].viewport.height;
    assert.ok(r.visible, 'toast is visible');
    assert.ok(r.left >= 0 && r.right <= width + 1, `toast horizontally fits: ${JSON.stringify(r)}`);
    assert.ok(r.top >= 0 && r.bottom <= height + 1, `toast vertically fits: ${JSON.stringify(r)}`);
    assert.equal(r.whiteSpace, 'normal');
    assert.ok(r.height > 20, 'long message wraps to multiple lines');
    assert.deepEqual(d.errors, [], d.errors.join('\n'));
    await d.ctx.close();
  });

  test(`[${vp}] Explore as guest closes auth and preserves usable mobile chrome`, async () => {
    const d = await world.device(vp);
    const pg = d.page;
    await d.open();
    await pg.tap('#closeAuth');
    await pg.waitForTimeout(250);
    const state = await pg.evaluate(() => {
      const app = document.querySelector('.app');
      const auth = document.querySelector('#authModal');
      const nav = document.querySelector('#bottomNav').getBoundingClientRect();
      return {
        guest: app?.classList.contains('app-guest'),
        authOpen: auth?.classList.contains('show'),
        navBottom: nav.bottom,
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth
      };
    });
    assert.equal(state.guest, true);
    assert.equal(state.authOpen, false);
    assert.ok(state.navBottom <= VIEWPORTS[vp].viewport.height + 1);
    assert.ok(state.scrollWidth <= state.width + 1, `no horizontal overflow: ${JSON.stringify(state)}`);
    assert.deepEqual(d.errors, [], d.errors.join('\n'));
    await d.ctx.close();
  });
}
