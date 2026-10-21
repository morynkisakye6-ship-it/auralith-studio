// DSP correctness against published references (ITU-R BS.1770-4 / EBU R128) and analytic cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dsp from '../js/dsp.js';

const sine = (rate, secs, freq, amp, phase = 0) => { const n = Math.round(rate * secs), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / rate + phase); return x; };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const db = x => 20 * Math.log10(x);

test('loudness: a 997 Hz stereo sine at -20 dBFS reads -20.0 LUFS (BS.1770 calibration), at 44.1k and 48k', () => {
  for (const rate of [44100, 48000]) {
    const x = sine(rate, 5, 997, 0.1);
    near(dsp.integratedLoudness([x, x], rate), -20.0, 0.1, `rate ${rate}`);
  }
});
test('loudness: one channel only is 3 LU quieter than both (channel summing)', () => {
  const x = sine(48000, 4, 997, 0.1), z = new Float32Array(x.length);
  near(dsp.integratedLoudness([x, z], 48000), -23.01, 0.1);
});
test('loudness: K-weighting rolls off lows and lifts highs (a 60 Hz tone reads quieter than a 4 kHz tone at equal level)', () => {
  const lo = dsp.integratedLoudness([sine(48000, 4, 60, 0.1)], 48000), hi = dsp.integratedLoudness([sine(48000, 4, 4000, 0.1)], 48000);
  assert.ok(hi - lo > 3, `4 kHz ${hi} vs 60 Hz ${lo}`);
  near(hi - dsp.integratedLoudness([sine(48000, 4, 997, 0.1)], 48000), 3.0, 1.2, 'high shelf is roughly +3-4 dB at 4 kHz');
});
test('loudness: silence reads -Infinity and digital silence does not drag the average down (absolute gate)', () => {
  assert.equal(dsp.integratedLoudness([new Float32Array(48000 * 3)], 48000), -Infinity);
  // 20 s of tone: the few partially filled blocks at the tone's edge move the result by a few hundredths of an LU, as in any BS.1770 meter
  const tone = sine(48000, 20, 997, 0.1), padded = new Float32Array(48000 * 40); padded.set(tone);
  near(dsp.integratedLoudness([padded, padded], 48000), dsp.integratedLoudness([tone, tone], 48000), 0.1);
  near(dsp.integratedLoudness([padded, padded], 48000), -20, 0.12);
});
test('loudness: a section 20 LU below the main part is ignored (relative gate)', () => {
  const loud = sine(48000, 6, 997, 0.1), quiet = sine(48000, 6, 997, 0.01), both = new Float32Array(loud.length + quiet.length);
  both.set(loud); both.set(quiet, loud.length);
  near(dsp.integratedLoudness([both, both], 48000), dsp.integratedLoudness([loud, loud], 48000), 0.15);
});
test('loudness: signals shorter than one 400 ms block still measure', () => {
  near(dsp.integratedLoudness([sine(48000, 0.2, 997, 0.1), sine(48000, 0.2, 997, 0.1)], 48000), -20, 1.0);
});

test('true peak: finds inter-sample peaks that sample peak misses (fs/4 sine at 45 degrees)', () => {
  const x = sine(48000, 0.5, 12000, 1, Math.PI / 4);        // every sample is +/-0.7071 but the waveform reaches 1.0
  near(dsp.samplePeak([x]), 0.7071, 0.001);
  near(dsp.truePeak([x]), 1.0, 0.03, 'true peak');
});
test('true peak: matches sample peak for low-frequency material', () => {
  const x = sine(48000, 0.5, 200, 0.5);
  near(dsp.truePeak([x]), 0.5, 0.002);
});

test('limiter: output never exceeds the ceiling (true peak), and material away from peaks is left bit-identical', () => {
  const rate = 48000, x = sine(rate, 8, 220, 0.4);
  x[0] = 1.6; x[8 * rate - 10] = -1.6;                      // hot transients at the very start and near the end
  const r = dsp.limit([x], rate, { ceilingDb: -1 });
  const tp = dsp.truePeak(r.channels);
  assert.ok(tp <= dsp.fromDb(-1) + 0.003, `true peak ${db(tp)} dBTP must be <= -1 dBTP`);
  assert.ok(r.maxReductionDb > 3, 'reduction happened: ' + r.maxReductionDb);
  let untouched = 0; for (let i = 3 * rate; i < 7 * rate; i++) if (r.channels[0][i] === x[i]) untouched++;
  assert.equal(untouched, 4 * rate, 'quiet middle section is untouched once the release has finished');
});
test('limiter: gain changes smoothly (no zipper/click) around a peak', () => {
  const rate = 48000, x = new Float32Array(rate).fill(0.2); x[24000] = 1.5;
  const r = dsp.limit([x], rate, { ceilingDb: -1, lookaheadMs: 3 });
  let maxStep = 0; for (let i = 1; i < x.length; i++) maxStep = Math.max(maxStep, Math.abs(r.channels[0][i] / (x[i] || 1) - r.channels[0][i - 1] / (x[i - 1] || 1)));
  assert.ok(maxStep < 0.02, 'largest per-sample gain step ' + maxStep);
});
test('limiter: below the ceiling the signal passes through unchanged', () => {
  const x = sine(48000, 1, 440, 0.3), r = dsp.limit([x], 48000, { ceilingDb: -1 });
  for (let i = 0; i < x.length; i += 97) assert.equal(r.channels[0][i], x[i]);
  assert.equal(r.maxReductionDb, 0);
});
test('limiter: preserves stereo image (both channels get the same gain)', () => {
  const l = sine(48000, 1, 220, 0.9), r = sine(48000, 1, 330, 0.3), out = dsp.limit([l, r], 48000, { ceilingDb: -3 });
  for (let i = 1000; i < 40000; i += 997) near(out.channels[0][i] / l[i], out.channels[1][i] / r[i], 1e-3);
});

test('mastering: brings a quiet mix to -14 LUFS within 0.5 LU with true peak <= -1 dBTP', () => {
  const rate = 44100, kick = sine(rate, 8, 55, 0.08), mid = sine(rate, 8, 440, 0.03), x = kick.map((v, i) => v + mid[i]);
  const r = dsp.masterToTarget([x, x], rate, { targetLufs: -14, ceilingDb: -1 });
  assert.ok(r.applied);
  near(dsp.integratedLoudness(r.channels, rate), -14, 0.5);
  assert.ok(db(dsp.truePeak(r.channels)) <= -0.97, 'dBTP ' + db(dsp.truePeak(r.channels)));
  assert.ok(r.gainDb > 6);
});
test('mastering: a too-loud mix is turned down to the target', () => {
  const rate = 48000, x = sine(rate, 5, 300, 0.9), r = dsp.masterToTarget([x, x], rate, { targetLufs: -16, ceilingDb: -1 });
  near(dsp.integratedLoudness(r.channels, rate), -16, 0.5); assert.ok(r.gainDb < 0);
});
test('mastering: silence is left alone and reported, not amplified into noise', () => {
  const z = new Float32Array(48000 * 2), r = dsp.masterToTarget([z, z], 48000, { targetLufs: -14 });
  assert.equal(r.applied, false); assert.equal(r.reason, 'silent'); assert.equal(r.channels[0], z);
});
test('mastering: boost is capped, so a near-silent take is not blown up to full level', () => {
  const x = sine(48000, 3, 440, 0.0005), r = dsp.masterToTarget([x], 48000, { targetLufs: -14, maxBoostDb: 24 });
  assert.ok(r.gainDb <= 24 + 1e-6);
  assert.ok(db(dsp.truePeak(r.channels)) < -9);
});
test('mastering: presets exist with the documented targets', () => {
  assert.equal(dsp.PRESETS.streaming.targetLufs, -14); assert.equal(dsp.PRESETS.podcast.targetLufs, -16); assert.equal(dsp.PRESETS.loud.targetLufs, -11);
  assert.equal(dsp.PRESETS.off, null);
});
test('performance: mastering a 75 s stereo mix takes a few seconds, not minutes', () => {
  const rate = 44100, n = rate * 75, x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.1 * Math.sin(i * 0.05) + 0.05 * Math.sin(i * 0.31);
  const t = Date.now(); dsp.masterToTarget([x, x], rate, { targetLufs: -14 }); const ms = Date.now() - t;
  assert.ok(ms < 20000, ms + ' ms');
});

test('dither: TPDF quantisation is unbiased and deterministic for a given seed', () => {
  const r1 = dsp.makeRng(42), r2 = dsp.makeRng(42), a = [], b = [];
  for (let i = 0; i < 50; i++) { a.push(dsp.quantize16(0.3, r1)); b.push(dsp.quantize16(0.3, r2)); }
  assert.deepEqual(a, b);
  const rng = dsp.makeRng(7); let sum = 0; const N = 200000;
  for (let i = 0; i < N; i++) sum += dsp.quantize16(0.30001, rng);
  near(sum / N, 0.30001 * 32767, 0.05, 'mean of dithered samples equals the true value to <0.05 LSB (plain rounding would be off by up to 0.5)');
});
test('dither: clamps and handles full-scale without wrapping', () => {
  const rng = dsp.makeRng(1);
  for (let i = 0; i < 1000; i++) { const p = dsp.quantize16(1.0, rng), m = dsp.quantize16(-1.0, rng), o = dsp.quantize16(3.0, rng); assert.ok(p <= 32767 && m >= -32768 && o === 32767); }
  assert.equal(dsp.quantize16(0, null), 0);
});

test('take analysis: detects clipping, quiet takes, silence and good levels', () => {
  const clipped = sine(48000, 1, 200, 3).map(v => Math.max(-1, Math.min(1, v)));
  assert.equal(dsp.takeAdvice(dsp.analyzeLevels(clipped)).level, 'clipping');
  assert.equal(dsp.takeAdvice(dsp.analyzeLevels(sine(48000, 1, 200, 0.02))).level, 'quiet');
  assert.equal(dsp.takeAdvice(dsp.analyzeLevels(new Float32Array(4800))).level, 'silent');
  const good = dsp.takeAdvice(dsp.analyzeLevels(sine(48000, 1, 200, 0.4)));
  assert.equal(good.level, 'good'); assert.equal(good.text, null);
  assert.equal(dsp.analyzeLevels(clipped).clipCount > 100, true);
});

// ---------------------------------------------------------------- timing / latency estimation
function placeChirps(rate, secs, times, delayMs, o = {}) {
  const x = new Float32Array(Math.round(rate * secs)), c = dsp.makeChirp(rate), d = Math.round(delayMs * rate / 1000);
  for (const t of times) { const s = Math.round(t * rate) + d; for (let i = 0; i < c.length && s + i < x.length; i++) x[s + i] += c[i] * (o.gain || 1); }
  return x;
}
const noise = (x, amp, seed = 3) => { const r = dsp.makeRng(seed); for (let i = 0; i < x.length; i++) x[i] += amp * (r() + r() + r() + r() - 2) * 1.7; return x; };
const TIMES = [0.6, 1.15, 1.8, 2.4, 3.05, 3.6, 4.3, 4.9];

test('fft: forward then inverse restores the signal; a sine concentrates in one bin', () => {
  const n = 1024, re = new Float64Array(n), im = new Float64Array(n); for (let i = 0; i < n; i++) re[i] = Math.sin(2 * Math.PI * 50 * i / n);
  const orig = Float64Array.from(re); dsp.fft(re, im, false);
  let peak = 0, pi = 0; for (let k = 0; k < n / 2; k++) { const m = Math.hypot(re[k], im[k]); if (m > peak) { peak = m; pi = k; } }
  assert.equal(pi, 50); near(peak, n / 2, 1e-6);
  dsp.fft(re, im, true); for (let i = 0; i < n; i += 37) near(re[i], orig[i], 1e-9);
});
test('delayBetween finds a known delay to well under a millisecond (positive and negative)', () => {
  const rate = 48000, a = noise(new Float32Array(rate), 0.3, 11);
  for (const ms of [0, 12.5, 83.3, -41.7, 250]) {
    const k = Math.round(ms * rate / 1000), b = new Float32Array(a.length); for (let i = 0; i < a.length; i++) { const j = i - k; if (j >= 0 && j < a.length) b[i] = a[j]; }
    const r = dsp.delayBetween(a, b, rate, 400); near(r.ms, ms, 0.1, 'delay ' + ms); assert.ok(r.score > 0.5);
  }
});
test('latency estimate: recovers the round-trip delay to within 1 ms, clean signal', () => {
  const rate = 48000;
  for (const ms of [18, 64.5, 120, 187.3, 340]) {
    const r = dsp.estimateLatency(placeChirps(rate, 6, TIMES, ms), rate, TIMES);
    assert.ok(r.ok, JSON.stringify(r)); near(r.latencyMs, ms, 1.0, 'latency ' + ms); assert.equal(r.found, TIMES.length); assert.ok(r.spreadMs < 1.5);
  }
});
test('latency estimate: works at 44.1 kHz and with room noise at 0 dB signal-to-noise', () => {
  const rate = 44100, x = noise(placeChirps(rate, 6, TIMES, 96.4, { gain: 0.5 }), 0.16, 5);
  const r = dsp.estimateLatency(x, rate, TIMES); assert.ok(r.ok, JSON.stringify(r)); near(r.latencyMs, 96.4, 2.0);
});
test('latency estimate: survives an echo, speaker colouring (low-pass), and a few clicks being drowned out', () => {
  const rate = 48000, x = placeChirps(rate, 6, TIMES, 77);
  for (let i = x.length - 1; i > 3000; i--) x[i] += 0.5 * x[i - 3000];                       // 62 ms room echo
  let y = 0; for (let i = 0; i < x.length; i++) { y += 0.6 * (x[i] - y); x[i] = y; }          // gentle low-pass
  for (const t of [1.15, 3.05]) { const s = Math.round((t + 0.077) * rate); for (let i = 0; i < 3000; i++) x[s + i] += 0.8 * Math.sin(i * 0.3); }   // two clicks masked by a tone
  const r = dsp.estimateLatency(x, rate, TIMES); assert.ok(r.ok, JSON.stringify(r)); near(r.latencyMs, 77, 2.5);
});
test('latency estimate: refuses silence, pure noise and inconsistent detections instead of guessing', () => {
  const rate = 48000;
  assert.deepEqual([dsp.estimateLatency(new Float32Array(rate * 6), rate, TIMES).ok, dsp.estimateLatency(new Float32Array(rate * 6), rate, TIMES).reason], [false, 'silent']);
  const n = dsp.estimateLatency(noise(new Float32Array(rate * 6), 0.3, 9), rate, TIMES); assert.equal(n.ok, false);
  const jitter = new Float32Array(rate * 6); TIMES.forEach((t, i) => { const c = dsp.makeChirp(rate), s = Math.round((t + 0.05 + i * 0.03) * rate); for (let j = 0; j < c.length; j++) jitter[s + j] += c[j]; });
  const j = dsp.estimateLatency(jitter, rate, TIMES); assert.equal(j.ok, false); assert.equal(j.reason, 'inconsistent');
});
test('latency estimate: a recording that starts late or misses the first clicks still measures the rest', () => {
  const rate = 48000, x = placeChirps(rate, 6, TIMES, 110); for (let i = 0; i < Math.round(1.0 * rate); i++) x[i] = 0;   // first click never recorded
  const r = dsp.estimateLatency(x, rate, TIMES); assert.ok(r.ok, JSON.stringify(r)); near(r.latencyMs, 110, 1.0); assert.equal(r.found, 7, 'only the first click (arriving at 0.71 s, inside the silenced start) is lost');
});
test('latency estimate: speed (a 6 s recording is analysed in well under a second)', () => {
  const rate = 48000, x = placeChirps(rate, 6, TIMES, 90), t = Date.now(); dsp.estimateLatency(x, rate, TIMES); assert.ok(Date.now() - t < 1500, (Date.now() - t) + ' ms');
});
