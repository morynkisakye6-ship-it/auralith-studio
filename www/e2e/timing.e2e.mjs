// Vocal timing: mic-latency auto-calibration and where a recorded take actually lands in the mix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startWorld, LOOPBACK } from './harness.mjs';
import { signUp, goStudio, recordTake, readDownload } from './flows.mjs';

const dsp = createRequire(import.meta.url)('../js/dsp.js');
let world;
before(async () => { world = await startWorld(); });
after(async () => { await world.close(); });

async function timingDevice(name, cfg) {
  const d = await world.device('iphone-14 390x844');
  await d.ctx.addInitScript(LOOPBACK, cfg);
  await signUp(d, name); await goStudio(d, 'record');
  return d;
}
const calibrate = async d => {
  await d.page.tap('#recCalibrateBtn');
  await d.page.waitForFunction(() => { const s = document.getElementById('recCalibrateResult'); return s && /^(Measured|Couldn't|Too noisy|The timing|Calibration)/.test(s.textContent); }, null, { timeout: 30000 });
  return { text: await d.page.textContent('#recCalibrateResult'), delay: await d.page.evaluate(() => state.recordDelayMs), state: await d.page.getAttribute('#recCalibrateResult', 'data-state') };
};
const measured = r => Number((/Measured (-?\d+) ms/.exec(r.text) || [])[1]);

function pcm(buf) { const ch = buf.readUInt16LE(22), rate = buf.readUInt32LE(24), n = (buf.length - 44) / (2 * ch); const out = Array.from({ length: ch }, () => new Float32Array(n)); for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = buf.readInt16LE(44 + (i * ch + c) * 2) / 32768; return { ch: out, rate }; }
async function bounce(d) {
  const pg = d.page; await pg.selectOption('#bounceQuality', 'draft'); await pg.selectOption('#bounceMaster', 'off');
  const dl = pg.waitForEvent('download', { timeout: 120000 }); await pg.tap('#mixdownBtn'); const f = await dl;
  await pg.waitForFunction(() => { const b = document.getElementById('mixdownBtn'); return !b.disabled && /Bounce Full Mix/.test(b.textContent); }, null, { timeout: 30000 });
  return pcm(await readDownload(f));
}
/** Where does the vocal land relative to the beat it was sung to? The loopback take IS the beat, so the answer should be 0 ms. */
const vocalVsBeat = async d => {
  const pg = d.page; await pg.tap('#recSendMixBtn'); await pg.waitForSelector('#view-mix:not([hidden])');
  await pg.evaluate(() => { state.vocal.reverb = 0; });      // keep the measurement clean: no reverb smear on the vocal
  const withV = await bounce(d);
  await pg.evaluate(() => { window.__v = state.vocal; state.vocal = null; });
  const only = await bounce(d);
  await pg.evaluate(() => { state.vocal = window.__v; });
  const n = Math.min(withV.ch[0].length, only.ch[0].length), V = new Float32Array(n);
  for (let i = 0; i < n; i++) V[i] = withV.ch[0][i] - only.ch[0][i];
  return dsp.delayBetween(only.ch[0].subarray(0, n), V, only.rate, 1500);
};

test('calibration measures the round-trip delay: two known cable delays differ by 100 ms in the result', async () => {
  const d = await timingDevice('cal_a', { delayMs: 40 });
  const a = await calibrate(d); assert.equal(a.state, 'ok', a.text);
  await d.page.evaluate(() => window.__loop.setDelay(140));
  const b = await calibrate(d); assert.equal(b.state, 'ok', b.text);
  const ma = measured(a), mb = measured(b);
  assert.ok(Math.abs((mb - ma) - 100) <= 10, `40 ms cable -> ${ma} ms, 140 ms cable -> ${mb} ms (difference ${mb - ma}, expected 100)`);
  assert.ok(Math.abs(ma - 40) <= 150 && mb >= 40 - 150, `value is the cable delay plus the recorder's own start-up offset: ${ma}, ${mb}`);
  assert.equal(b.delay, -mb, 'new takes will be placed that much earlier');
  assert.match(b.text, /New takes are placed \d+ ms (earlier|later) automatically/);
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('calibration is repeatable (three runs agree within 3 ms), and the setting survives a reload', async () => {
  const d = await timingDevice('cal_b', { delayMs: 75 });
  const runs = []; for (let i = 0; i < 3; i++) runs.push(measured(await calibrate(d)));
  assert.ok(Math.max(...runs) - Math.min(...runs) <= 3, 'runs: ' + runs.join(', '));
  const stored = await d.page.evaluate(() => state.recordDelayMs);
  await d.page.reload(); await d.page.waitForSelector('[data-nav="studio"]'); await goStudio(d, 'record');
  assert.equal(await d.page.evaluate(() => state.recordDelayMs), stored, 'restored after reload');
  assert.equal(await d.page.textContent('#recDelayVal'), stored + ' ms');
  await d.ctx.close();
});

test('calibration works with room noise', async () => {
  const quiet = await timingDevice('cal_c1', { delayMs: 90 }), noisy = await timingDevice('cal_c2', { delayMs: 90, noise: 0.08 });
  const q = measured(await calibrate(quiet)), n = measured(await calibrate(noisy));
  assert.ok(Math.abs(q - n) <= 10, `quiet ${q} ms vs noisy ${n} ms`);
  await quiet.ctx.close(); await noisy.ctx.close();
});

test('calibration failure: a silent room is explained, and nothing is changed', async () => {
  const d = await timingDevice('cal_d', { delayMs: 60 });
  await d.page.evaluate(() => { state.recordDelayMs = -33; window.__loop.setLevel(0); });
  const r = await calibrate(d);
  assert.equal(r.state, 'error'); assert.match(r.text, /Couldn't hear the test sounds/); assert.match(r.text, /phone speaker/);
  assert.equal(r.delay, -33, 'the previous setting is untouched'); assert.equal(await d.page.$eval('#recCalibrateBtn', e => e.textContent), 'Auto-calibrate');
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('calibration can be cancelled: the microphone is released and the button recovers', async () => {
  const d = await timingDevice('cal_e', { delayMs: 60 });
  await d.page.tap('#recCalibrateBtn'); await d.page.waitForFunction(() => document.getElementById('recCalibrateBtn').textContent === 'Cancel');
  await d.page.waitForTimeout(1200); await d.page.tap('#recCalibrateBtn');
  await d.page.waitForFunction(() => /cancelled/i.test(document.getElementById('recCalibrateResult').textContent), null, { timeout: 8000 });
  assert.equal(await d.page.textContent('#recCalibrateBtn'), 'Auto-calibrate');
  const live = await d.page.evaluate(() => window.__loop.streams.flatMap(s => s.getTracks()).filter(t => t.readyState === 'live').length);
  assert.equal(live, 0, 'no microphone track left running');
  assert.equal(await d.page.evaluate(() => state.recordDelayMs), 0, 'a cancelled run changes nothing');
  await d.ctx.close();
});

test('calibration refuses to run while a recording is in progress', async () => {
  const d = await timingDevice('cal_f', { delayMs: 60 });
  await d.page.tap('#vocalRecBtn'); await d.page.waitForFunction(() => /sing now|recording/i.test(document.getElementById('recStatus').textContent));
  await d.page.tap('#recCalibrateBtn'); assert.match(await d.page.textContent('#recCalibrateResult'), /Stop the current recording first/);
  await d.page.tap('#vocalRecBtn'); await d.page.waitForFunction(() => /saved/i.test(document.getElementById('recStatus').textContent), null, { timeout: 15000 });
  await d.ctx.close();
});

test('a take records how far the beat was ahead of the recorder, and takes the calibrated timing', async () => {
  const d = await timingDevice('take_a', { delayMs: 80 });
  const cal = measured(await calibrate(d));
  await goStudio(d, 'beat'); await d.page.evaluate(() => { window.__qa.firstSrcAt = null; });   // calibration chirps also count as audio starts
  await recordTake(d, 2500);
  const take = await d.page.evaluate(() => ({ gap: state.vocal.gapMs, off: state.vocal.offsetMs, wall: window.__qa.recStartAt - window.__qa.firstSrcAt }));
  assert.ok(take.gap >= 200 && take.gap <= 3000, 'beat-to-recorder gap measured on the audio clock: ' + take.gap);
  // the audio clock measures from the beat's first sounding step, which is scheduled ~80 ms after the wall-clock call
  assert.ok(Math.abs(take.gap - (take.wall - 80)) <= 70, `audio-clock gap ${take.gap} ms agrees with wall-clock ${Math.round(take.wall)} ms minus the 80 ms schedule lead`);
  assert.equal(take.off, -cal, 'the take carries the calibrated (negative) timing');
  await d.ctx.close();
});

test('END TO END: calibration removes almost all of the hardware latency between a recorded vocal and its beat', async () => {
  // A 260 ms speaker-to-mic path is far worse than real hardware, which makes the uncorrected error unmistakable.
  const d = await timingDevice('e2e_a', { delayMs: 260 });
  await recordTake(d, 4000);                               // uncalibrated: the beat-to-recorder gap is compensated, hardware latency is not
  const uncal = await vocalVsBeat(d);
  await goStudio(d, 'record'); const cal = measured(await calibrate(d));
  await recordTake(d, 4000);
  const calibrated = await vocalVsBeat(d);
  assert.ok(Math.abs(uncal.ms) >= 150, `without calibration the vocal is ${uncal.ms.toFixed(1)} ms off the beat`);
  assert.ok(Math.abs(calibrated.ms) <= 45, `with calibration (${cal} ms measured) it is ${calibrated.ms.toFixed(1)} ms off`);
  assert.ok(Math.abs(calibrated.ms) < Math.abs(uncal.ms) * 0.25, `calibration removes at least 75% of the error: ${uncal.ms.toFixed(0)} -> ${calibrated.ms.toFixed(0)} ms`);
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('takes are placed consistently: three calibrated takes land within 12 ms of each other (browser recorder start-up jitter is ~10 ms)', async () => {
  const d = await timingDevice('e2e_b', { delayMs: 150 });
  await calibrate(d); const r = [];
  for (let i = 0; i < 3; i++) { await goStudio(d, 'record'); await recordTake(d, 3500); r.push((await vocalVsBeat(d)).ms); }
  assert.ok(Math.max(...r) - Math.min(...r) <= 12, 'residuals: ' + r.map(x => x.toFixed(1)).join(', '));
  await d.ctx.close();
});

test('a negative timing offset on the first section really moves the vocal earlier in the bounce (it used to be ignored)', async () => {
  const d = await timingDevice('neg_a', { delayMs: 30 });
  await recordTake(d, 4000); await d.page.tap('#recSendMixBtn'); await d.page.waitForSelector('#view-mix:not([hidden])');
  const vocalOnly = async off => {
    await d.page.evaluate(o => { state.vocal.gapMs = 0; state.vocal.offsetMs = o; state.vocal.section = 'intro'; }, off);
    const withV = await bounce(d); await d.page.evaluate(() => { window.__v = state.vocal; state.vocal = null; }); const only = await bounce(d); await d.page.evaluate(() => { state.vocal = window.__v; });
    const n = Math.min(withV.ch[0].length, only.ch[0].length), V = new Float32Array(n); for (let i = 0; i < n; i++) V[i] = withV.ch[0][i] - only.ch[0][i]; return { V, rate: only.rate };
  };
  const base = await vocalOnly(0), early = await vocalOnly(-200);
  const r = dsp.delayBetween(base.V, early.V, base.rate, 600);
  assert.ok(Math.abs(r.ms - (-200)) <= 4, `moved by ${r.ms.toFixed(1)} ms, expected -200`);
  await d.ctx.close();
});
