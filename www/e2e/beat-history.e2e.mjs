// Beat grid undo / redo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './harness.mjs';
import { signUp, goStudio } from './flows.mjs';

let world, d, pg;
before(async () => { world = await startWorld(); d = await world.device('iphone-14 390x844'); pg = d.page; await signUp(d, 'history_a'); await goStudio(d, 'beat'); });
after(async () => { await world.close(); });

const snap = () => pg.evaluate(() => JSON.stringify({ p: state.pattern, n: state.stepCount, s: state.swing || 0, k: state.kit, b: state.bpm }));
const settle = () => pg.waitForTimeout(260);                       // history flushes ~120 ms after a gesture
const undo = async () => { await pg.tap('#beatUndo'); await pg.waitForTimeout(80); };
const redo = async () => { await pg.tap('#beatRedo'); await pg.waitForTimeout(80); };
const disabled = id => pg.$eval(id, e => e.disabled);
const pads = async () => pg.$$eval('#view-beat .st:not(.on)', els => els.slice(0, 8).map(e => `${e.dataset.track}:${e.dataset.step}`));
const tapPad = async key => { const [t, s] = key.split(':'); await pg.tap(`#view-beat .st[data-track="${t}"][data-step="${s}"]`); await settle(); };
const velocity = key => { const [t, s] = key.split(':'); return pg.evaluate(([t, s]) => state.pattern[t][s], [t, s]); };

test('undo and redo start disabled, are labelled, and are finger-sized', async () => {
  assert.equal(await disabled('#beatUndo'), true); assert.equal(await disabled('#beatRedo'), true);
  assert.equal(await pg.getAttribute('#beatUndo', 'aria-label'), 'Undo'); assert.equal(await pg.getAttribute('#beatRedo', 'aria-label'), 'Redo');
  for (const id of ['#beatUndo', '#beatRedo']) { const b = await pg.$eval(id, e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }); assert.ok(b[0] >= 40 && b[1] >= 44, id + ' ' + b); }
});

test('a pad edit can be undone and redone exactly', async () => {
  const [k] = await pads(); const before = await snap();
  await tapPad(k);
  assert.notEqual(await snap(), before); assert.equal(await disabled('#beatUndo'), false); assert.equal(await disabled('#beatRedo'), true);
  await undo(); assert.equal(await snap(), before, 'undo restores the exact previous state'); assert.equal(await velocity(k), 0);
  assert.equal(await disabled('#beatUndo'), true); assert.equal(await disabled('#beatRedo'), false);
  const hitsBefore = await pg.textContent('#beatHitCount');
  await redo(); assert.ok(await velocity(k) > 0, 'redo re-applies the edit'); assert.equal(await disabled('#beatRedo'), true);
  assert.notEqual(await pg.textContent('#beatHitCount'), hitsBefore, 'the grid and counter follow the state');
  await undo();
});

test('several edits unwind in reverse order and replay forward', async () => {
  const base = await snap(), [a, b, c] = await pads(), states = [base];
  for (const k of [a, b, c]) { await tapPad(k); states.push(await snap()); }
  for (let i = 2; i >= 0; i--) { await undo(); assert.equal(await snap(), states[i], `after undo ${3 - i}`); }
  for (let i = 1; i <= 3; i++) { await redo(); assert.equal(await snap(), states[i], `after redo ${i}`); }
  for (let i = 0; i < 3; i++) await undo();
});

test('a new edit after an undo discards the redo branch', async () => {
  const [a, b] = await pads(); await tapPad(a); await undo(); assert.equal(await disabled('#beatRedo'), false);
  await tapPad(b); assert.equal(await disabled('#beatRedo'), true, 'redo is cleared by a fresh edit'); await undo();
});

test('Randomize and Clear are undoable', async () => {
  const base = await snap();
  await pg.tap('#randomizePattern'); await settle(); assert.notEqual(await snap(), base);
  await undo(); assert.equal(await snap(), base, 'randomize undone');
  pg.once('dialog', x => x.accept()); await pg.tap('#clearPattern'); await settle();
  assert.equal(await pg.$$eval('#view-beat .st.on', e => e.length), 0, 'cleared');
  await undo(); assert.equal(await snap(), base, 'clear undone'); assert.ok(await pg.$$eval('#view-beat .st.on', e => e.length) > 0);
});

test('tempo and swing changes in a burst count as one undo step', async () => {
  const base = await snap(), bpm0 = JSON.parse(base).b;
  for (let i = 0; i < 6; i++) { await pg.tap('#beatBpmUp'); await pg.waitForTimeout(260); }   // human pace: each tap is its own gesture
  await settle(); assert.equal(JSON.parse(await snap()).b, bpm0 + 6);
  await undo(); assert.equal(JSON.parse(await snap()).b, bpm0, 'six taps undone together'); assert.equal(await pg.textContent('#beatBpmValue'), String(bpm0));
  for (const v of [10, 20, 30]) { await pg.evaluate(v => { const s = document.getElementById('swingSlider'); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); }, v); await pg.waitForTimeout(260); }
  await settle(); assert.equal(JSON.parse(await snap()).s, 30);
  await undo(); assert.equal(JSON.parse(await snap()).s, 0); assert.equal(await pg.$eval('#swingSlider', e => e.value), '0'); assert.equal(await pg.textContent('#swingVal'), '0%');
  assert.equal(await disabled('#beatUndo'), true, 'swing burst was a single step');
});

test('changing the step count and the genre kit are undoable and the controls follow', async () => {
  const base = await snap();
  await pg.tap('#stepLenChips .chip[data-steps="32"]'); await settle();
  assert.equal(await pg.evaluate(() => state.stepCount), 32); assert.equal(await pg.$$eval('#view-beat .st[data-track="kick"]', e => e.length), 32);
  await undo(); assert.equal(await snap(), base);
  assert.equal(await pg.$eval('#stepLenChips .chip.on', e => e.dataset.steps), '16', 'step chip highlight restored');
  const other = await pg.$$eval('#genreSelect option', o => o.map(x => x.value)).then(v => v.find(x => x !== JSON.parse(JSON.stringify(1)) && x));
  const current = await pg.$eval('#genreSelect', e => e.value), alt = (await pg.$$eval('#genreSelect option', o => o.map(x => x.value))).find(v => v !== current);
  await pg.selectOption('#genreSelect', alt); await settle(); assert.equal(await pg.evaluate(() => state.kit), alt);
  await undo(); assert.equal(await snap(), base); assert.equal(await pg.$eval('#genreSelect', e => e.value), current, 'kit selector restored');
});

test('keyboard shortcuts: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo; text fields keep their own undo', async () => {
  const [k] = await pads(); const base = await snap(); await tapPad(k); const edited = await snap();
  await pg.keyboard.press('Control+z'); await pg.waitForTimeout(80); assert.equal(await snap(), base);
  await pg.keyboard.press('Control+Shift+z'); await pg.waitForTimeout(80); assert.equal(await snap(), edited);
  await pg.keyboard.press('Control+z'); await pg.keyboard.press('Control+y'); await pg.waitForTimeout(80); assert.equal(await snap(), edited);
  await pg.keyboard.press('Control+z'); await pg.waitForTimeout(80); assert.equal(await snap(), base);
  await pg.evaluate(() => { const i = document.createElement('input'); i.id = 'tmpField'; document.getElementById('view-beat').appendChild(i); });
  await tapPad(k); const again = await snap(); await pg.focus('#tmpField'); await pg.keyboard.press('Control+z'); await pg.waitForTimeout(80);
  assert.equal(await snap(), again, 'Ctrl+Z inside a text field is not hijacked'); await pg.evaluate(() => document.getElementById('tmpField').remove()); await undo();
});

test('undo while the beat is playing keeps the transport running and changes the sound immediately', async () => {
  const [k] = await pads(); await tapPad(k); await pg.tap('#playBtn');
  await pg.waitForFunction(() => /playing/i.test(document.getElementById('transportStatus')?.textContent || ''));
  await undo(); await pg.waitForTimeout(400);
  assert.match(await pg.textContent('#transportStatus'), /playing/i); assert.equal(await velocity(k), 0);
  await pg.tap('#playBtn'); assert.deepEqual(d.errors, [], d.errors.join('\n'));
});

test('history is discarded when the pattern is replaced from outside (song load, room restore)', async () => {
  const [a, b] = await pads(); await tapPad(a); assert.equal(await disabled('#beatUndo'), false);
  await pg.evaluate(() => { state.pattern = { kick: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], snare: new Array(16).fill(0), hat: new Array(16).fill(0), clap: new Array(16).fill(0) }; buildTracks && 0; });
  await pg.evaluate(() => document.querySelector('[data-studio="keys"]').click()); await pg.tap('[data-studio="beat"]'); await pg.waitForTimeout(200);
  const loaded = await snap();
  await tapPad(b);                                     // first interaction after the external change
  await undo(); assert.equal(await snap(), loaded, 'undo returns to the loaded pattern, not to a stale one');
  assert.equal(await disabled('#beatUndo'), true, 'nothing older than the load is reachable');
});

test('an undone state survives a reload', async () => {
  const [k] = await pads(); await tapPad(k); await undo(); const want = await pg.evaluate(() => JSON.stringify(state.pattern));
  await pg.waitForTimeout(600); await pg.reload(); await pg.waitForSelector('[data-nav="studio"]'); await goStudio(d, 'beat');
  assert.equal(await pg.evaluate(() => JSON.stringify(state.pattern)), want);
});
