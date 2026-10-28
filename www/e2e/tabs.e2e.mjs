// Two tabs, one account: changes in one tab reach the other, and neither tab overwrites the other's work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './harness.mjs';
import { signUp } from './flows.mjs';

let world, d, t1, t2;
const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
const titles = pg => pg.evaluate(() => (window.state.songs || []).map(s => s.title));
const stored = pg => pg.evaluate(() => JSON.parse(localStorage.getItem(AuralithProjectStore.userStorageKey(state.user)) || '[]').map(s => s.title));
const create = (pg, name) => pg.evaluate(n => { newSong(); document.getElementById('songTitle').value = n; saveCurrentSong(); }, name);

before(async () => {
  world = await startWorld();
  d = await world.device('iphone-14 390x844');
  await signUp(d, 'tabs_a');
  t1 = d.page;
  t2 = await d.ctx.newPage();
  await t2.goto(world.origin + '/');
  await t2.waitForFunction(() => window.state && window.state.user, null, { timeout: 15000 });
  await t2.waitForTimeout(1500);
});
after(async () => { await world.close(); });

test('a project created in tab 1 appears in tab 2 without a reload, and vice versa', async () => {
  await create(t1, 'FromTab1');
  assert.ok(await until(async () => (await titles(t2)).includes('FromTab1')), 'tab 2 sees it: ' + await titles(t2));
  await create(t2, 'FromTab2');
  assert.ok(await until(async () => (await titles(t1)).includes('FromTab2')), 'tab 1 sees it: ' + await titles(t1));
});

test('REGRESSION lost update: both tabs create a project at the same moment and neither is lost', async () => {
  await Promise.all([create(t1, 'Simul-1'), create(t2, 'Simul-2')]);
  const both = async pg => { const t = await titles(pg); return t.includes('Simul-1') && t.includes('Simul-2'); };
  assert.ok(await until(async () => (await both(t1)) && (await both(t2)), 10000), `tab1=${await titles(t1)} tab2=${await titles(t2)}`);
  // and after each tab saves again, the stored list still has both
  await create(t1, 'After-1'); await create(t2, 'After-2');
  assert.ok(await until(async () => { const s = await stored(t1); return ['Simul-1', 'Simul-2', 'After-1', 'After-2', 'FromTab1', 'FromTab2'].every(n => s.includes(n)); }, 10000), 'stored: ' + await stored(t1));
});

test('a project deleted in tab 1 disappears from tab 2 and does not come back when tab 2 saves', async () => {
  await t1.evaluate(() => { const s = state.songs.find(x => x.title === 'FromTab1'); deleteProjects([s.id]); });
  assert.ok(await until(async () => !(await titles(t2)).includes('FromTab1')), 'removed in tab 2');
  await create(t2, 'Tab2-after-delete');       // tab 2 saves its list
  await t2.waitForTimeout(800);
  assert.ok(!(await stored(t2)).includes('FromTab1'), 'deleted project must not be written back by tab 2');
  assert.ok(!(await titles(t1)).includes('FromTab1'));
});

test('typing in tab 2 is not clobbered by tab 1 saving other projects', async () => {
  await t2.evaluate(() => { document.getElementById('songTitle').value = 'Typing-in-2'; scheduleSave(); });
  await create(t1, 'Noise-from-1');
  await t2.waitForTimeout(1800);
  assert.equal(await t2.evaluate(() => document.getElementById('songTitle').value), 'Typing-in-2');
  assert.ok(await until(async () => (await stored(t1)).includes('Typing-in-2'), 6000), 'tab 2 edit reached shared storage: ' + await stored(t1));
});

test('no uncaught page errors in either tab', async () => { assert.deepEqual(d.errors, []); });
