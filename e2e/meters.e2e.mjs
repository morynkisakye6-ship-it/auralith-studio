// Per-channel and master level meters: calibration, behaviour, clip latch, and idle efficiency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './harness.mjs';
import { signUp, goStudio } from './flows.mjs';

let world, d, pg;
before(async () => { world = await startWorld(); d = await world.device('iphone-14 390x844'); pg = d.page; await signUp(d, 'meter_a'); await goStudio(d, 'mix'); });
after(async () => { await world.close(); });

const db = id => pg.$eval(`#channelStrip .ch-meter[data-meter="${id}"]`, e => Number(e.dataset.db));
const masterDb = () => pg.$eval('#masterMeter', e => Number(e.parentElement.dataset.db));
const play = async () => { await pg.tap('#mixMasterPlay'); await pg.waitForFunction(() => state.playing); };
const stop = async () => { await pg.tap('#mixMasterPlay'); await pg.waitForFunction(() => !state.playing); };
const maxOver = async (id, ms) => { let m = -99; const end = Date.now() + ms; while (Date.now() < end) { m = Math.max(m, await db(id)); await pg.waitForTimeout(40); } return m; };
// The meter loop sleeps when idle and wakes on playback or when the Mix screen is (re)opened; signals injected by a test need that wake-up.
const wake = async () => { await pg.tap('[data-studio="beat"]'); await pg.tap('[data-studio="mix"]'); await pg.waitForSelector('#view-mix:not([hidden])'); };
const rafCount = () => pg.evaluate(() => window.__qa.raf);

test('every mixer channel has an accessible meter that sits at the floor when nothing plays', async () => {
  const rows = await pg.$$eval('#channelStrip .ch-meter', els => els.map(e => ({ id: e.dataset.meter, role: e.getAttribute('role'), label: e.getAttribute('aria-label'), min: e.getAttribute('aria-valuemin'), max: e.getAttribute('aria-valuemax') })));
  assert.deepEqual(rows.map(r => r.id), ['kick', 'snare', 'hat', 'clap', 'chords', 'vocal']);
  for (const r of rows) { assert.equal(r.role, 'meter'); assert.match(r.label, /level$/); assert.equal(r.min, '-60'); assert.equal(r.max, '0'); }
  assert.ok(await db('kick') <= -59);
});

test('playing the beat moves the drum meters and the master meter; the readout shows a real dB value', async () => {
  await play();
  const [k, h, m] = await Promise.all([maxOver('kick', 1800), maxOver('hat', 1800), (async () => { let x = -99; const end = Date.now() + 1800; while (Date.now() < end) { x = Math.max(x, await masterDb()); await pg.waitForTimeout(40); } return x; })()]);
  assert.ok(k > -40, `kick peaked at ${k} dB`); assert.ok(h > -40, `hat peaked at ${h} dB`); assert.ok(m > -30, `master peaked at ${m} dB`);
  assert.match(await pg.textContent('#masterDb'), /^-\d+(\.\d)? dB$/);
  const widths = await pg.$$eval('#channelStrip .ch-meter i', e => e.map(x => parseFloat(x.style.width)));
  assert.ok(widths.some(w => w < 90), 'the fill reveals part of the scale');
});

test('muting or silencing a channel drops only that channel\'s meter', async () => {
  await pg.tap('#channelStrip [data-mute="kick"]'); await pg.waitForTimeout(1700);   // release ballistics are ~50 dB/s
  const kick = await maxOver('kick', 700), hat = await maxOver('hat', 900);
  assert.ok(kick < -50, `muted kick reads ${kick}`); assert.ok(hat > -40, `hat still reads ${hat}`);
  await pg.tap('#channelStrip [data-mute="kick"]');
  await pg.evaluate(() => { const i = document.querySelector('#channelStrip [data-vol="snare"]'); i.value = 0; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await pg.waitForTimeout(1500); assert.ok(await maxOver('snare', 900) < -50, 'snare fader at zero');
  await pg.evaluate(() => { const i = document.querySelector('#channelStrip [data-vol="snare"]'); i.value = 80; i.dispatchEvent(new Event('input', { bubbles: true })); });
});

test('calibration: a -12 dBFS sine on a channel reads about -15 dB (centre pan law), and louder means a higher reading', async () => {
  await stop(); await pg.waitForTimeout(1200); await wake();
  const read = amp => pg.evaluate(async amp => {
    const g = state._liveGraph, c = g.ctx, o = c.createOscillator(), a = c.createGain(); o.frequency.value = 997; a.gain.value = amp; o.connect(a); a.connect(g.tracks.chords.gain); o.start();
    await new Promise(r => setTimeout(r, 700)); const v = Number(document.querySelector('#channelStrip .ch-meter[data-meter="chords"]').dataset.db); o.stop(); o.disconnect(); a.disconnect(); return v;
  }, amp);
  const quiet = await read(0.125), mid = await read(0.25);
  const expected = 20 * Math.log10(0.25 * Math.SQRT1_2);
  assert.ok(Math.abs(mid - expected) <= 1.5, `read ${mid}, expected about ${expected.toFixed(1)}`);
  assert.ok(Math.abs((mid - quiet) - 6.02) <= 1.0, `doubling the amplitude adds about 6 dB: ${quiet} -> ${mid}`);
  await pg.waitForTimeout(1200);
});

test('clip latch: a signal at full scale lights the clip indicators and warns; they clear again afterwards', async () => {
  await wake();
  await pg.evaluate(() => { const g = state._liveGraph, c = g.ctx, o = c.createOscillator(), a = c.createGain(); o.frequency.value = 220; a.gain.value = 3; o.connect(a); a.connect(g.tracks.chords.gain); o.start(); window.__clipOsc = [o, a]; });
  await pg.waitForFunction(() => document.querySelector('#channelStrip .ch-meter[data-meter="chords"]').classList.contains('clip'), null, { timeout: 4000 });
  assert.equal(await pg.$eval('#clipWarn', e => /Peak clip risk/.test(e.textContent)), true);
  await pg.evaluate(() => { const [o, a] = window.__clipOsc; o.stop(); o.disconnect(); a.disconnect(); });
  await pg.waitForFunction(() => !document.querySelector('#channelStrip .ch-meter[data-meter="chords"]').classList.contains('clip'), null, { timeout: 5000 });
});

test('peak hold: the hold marker stays above the falling level, then follows it down', async () => {
  await wake();
  await pg.evaluate(() => { const g = state._liveGraph, c = g.ctx, o = c.createOscillator(), a = c.createGain(); o.frequency.value = 330; a.gain.value = 0.3; o.connect(a); a.connect(g.tracks.hat.gain); o.start(); setTimeout(() => { o.stop(); }, 300); });
  await pg.waitForTimeout(500);
  const pos = () => pg.$eval('#channelStrip .ch-meter[data-meter="hat"]', e => ({ fill: 100 - parseFloat(e.firstElementChild.style.width), hold: parseFloat(e.lastElementChild.style.left) }));
  const early = await pos(); assert.ok(early.hold > 40, 'hold marker is up: ' + JSON.stringify(early));
  await pg.waitForTimeout(2600); const late = await pos(); assert.ok(late.hold < early.hold, 'hold marker falls after ~1.5 s');
});

test('efficiency: when silent and idle the meter loop stops redrawing (it used to run at 60 fps forever)', async () => {
  await pg.waitForTimeout(3000);
  const a = await rafCount(); await pg.waitForTimeout(1000); const b = await rafCount();
  assert.ok(b - a <= 8, `${b - a} animation frames requested in 1 s of silence`);
  await play(); await pg.waitForTimeout(500); const c1 = await rafCount(); await pg.waitForTimeout(500); const c2 = await rafCount();
  assert.ok(c2 - c1 >= 15, `meters animate again once playback starts (${c2 - c1} frames per 0.5 s)`);
  await stop();
});

test('efficiency: nothing is redrawn while the app is in the background', async () => {
  await play();
  await pg.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); });
  await pg.waitForTimeout(300); const before = await pg.$eval('#channelStrip .ch-meter[data-meter="kick"] i', e => e.style.width);
  await pg.waitForTimeout(800); const after = await pg.$eval('#channelStrip .ch-meter[data-meter="kick"] i', e => e.style.width);
  assert.equal(after, before, 'meter DOM untouched while hidden');
  await pg.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); }); await stop();
  assert.deepEqual(d.errors, [], d.errors.join('\n')); assert.deepEqual((await d.qa()).errors, []);
});
