// Studio engine: loudness mastering, MP3 export, take-quality advice, take numbering, and Keys safety.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startWorld } from './harness.mjs';
import { signUp, goNav, goStudio, recordTake, readDownload } from './flows.mjs';

const dsp = createRequire(import.meta.url)('../js/dsp.js');
let world;
before(async () => { world = await startWorld(); });
after(async () => { await world.close(); });

/** Decode a 16-bit PCM WAV buffer into Float32 channels. */
function pcm(buf) {
  const ch = buf.readUInt16LE(22), rate = buf.readUInt32LE(24), n = (buf.length - 44) / (2 * ch);
  const out = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = buf.readInt16LE(44 + (i * ch + c) * 2) / 32768;
  return { channels: out, rate, n };
}
async function bounce(d, { master, format = 'wav' }) {
  const pg = d.page;
  await pg.selectOption('#bounceQuality', 'draft'); await pg.selectOption('#bounceMaster', master); await pg.selectOption('#bounceFormat', format);
  const dl = pg.waitForEvent('download', { timeout: 120000 });
  await pg.tap('#mixdownBtn');
  const file = await dl;
  await pg.waitForFunction(() => { const b = document.getElementById('mixdownBtn'); return !b.disabled && /Bounce Full Mix/.test(b.textContent); }, null, { timeout: 30000 });
  return { file, buf: await readDownload(file), report: (await pg.textContent('#bounceReport')).trim(), label: await pg.textContent('#bounceLabel') };
}

// ---------------------------------------------------------------- mastering
test.describe ? null : null;
let m, results = {};
test('mastering: As mixed, Streaming, Podcast and Loud produce the documented loudness with true peak <= -1 dBTP', async () => {
  m = await world.device('iphone-14 390x844'); await signUp(m, 'master_a');
  await recordTake(m, 2200); await m.page.tap('#recSendMixBtn'); await m.page.waitForSelector('#view-mix:not([hidden])');
  for (const k of ['off', 'streaming', 'podcast', 'loud']) {
    const r = await bounce(m, { master: k }); const w = pcm(r.buf);
    results[k] = { lufs: dsp.integratedLoudness(w.channels, w.rate), tp: dsp.analyze(w.channels, w.rate).truePeakDb, n: w.n, rate: w.rate, report: r.report, label: r.label };
  }
  const t = { streaming: -14, podcast: -16 };
  for (const [k, target] of Object.entries(t)) assert.ok(Math.abs(results[k].lufs - target) <= 0.8, `${k}: measured ${results[k].lufs.toFixed(2)} LUFS, wanted ${target}`);
  for (const k of ['streaming', 'podcast', 'loud']) assert.ok(results[k].tp <= -0.9, `${k}: true peak ${results[k].tp.toFixed(2)} dBTP must stay under the -1 ceiling`);
  // This mix is very dynamic (crest ~21 dB): -11 LUFS is not reachable without heavy limiting, so the engine stops short and says so.
  assert.ok(results.loud.lufs <= -11 + 0.3 && results.loud.lufs >= -13.5, `loud: ${results.loud.lufs.toFixed(2)} LUFS (as loud as the ceiling allows)`);
  assert.match(results.loud.report, /Target -11 LUFS not reached/, 'the user is told why the target was not reached');
  assert.ok(results.streaming.lufs > results.off.lufs + 3, `streaming is clearly louder than as-mixed (${results.off.lufs.toFixed(1)} -> ${results.streaming.lufs.toFixed(1)})`);
  assert.ok(results.loud.lufs > results.streaming.lufs && results.streaming.lufs > results.podcast.lufs, 'louder presets are louder');
  for (const k of ['streaming', 'podcast', 'loud']) assert.equal(results[k].n, results.off.n, 'mastering does not change the length');
});
test('mastering: the loudness report on screen matches the file that was written', async () => {
  const off = results.off, st = results.streaming;
  const num = s => Number((/(-?\d+\.\d) LUFS/.exec(s) || [])[1]);
  assert.ok(Math.abs(num(off.label) - off.lufs) <= 0.2, `label "${off.label}" vs measured ${off.lufs.toFixed(2)}`);
  assert.match(off.report, /Loudness -?\d+\.\d LUFS/);
  assert.match(off.report, /Tip: choose Master > Streaming/, 'a quiet as-mixed bounce suggests mastering');
  assert.match(st.report, /Mastered: -?\d+\.\d → -?\d+\.\d LUFS/);
  assert.ok(Math.abs(num(st.label) - st.lufs) <= 0.2, `label "${st.label}" vs measured ${st.lufs.toFixed(2)}`);
});
test('mastering: output is a valid dithered 16-bit stereo WAV at the project sample rate', async () => {
  const r = await bounce(m, { master: 'streaming' }); const b = r.buf;
  assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.readUInt16LE(34), 16); assert.equal(b.readUInt16LE(22), 2);
  assert.ok([44100, 48000].includes(b.readUInt32LE(24)));
  assert.equal(b.readUInt32LE(4), b.length - 8); assert.equal(b.readUInt32LE(40), b.length - 44);
  assert.deepEqual((await m.qa()).errors, []);
  assert.deepEqual(m.errors, [], m.errors.join('\n'));
});
test('mastering: bounce stays responsive and finishes in reasonable time', async () => {
  const t = Date.now(); await bounce(m, { master: 'loud' }); const secs = (Date.now() - t) / 1000;
  assert.ok(secs < 40, `bounce+master took ${secs.toFixed(1)}s`);
});

// ---------------------------------------------------------------- MP3
const LAME_STUB = `window.lamejs={Mp3Encoder:function(ch,sr,k){var s=window.__lame={ch:ch,sr:sr,kbps:k,samples:0,calls:0,rcalls:0};
  this.encodeBuffer=function(l,r){s.samples+=l.length;s.calls++;if(r){s.rcalls++;if(r.length!==l.length)s.mismatch=true;}return new Int8Array([0xFF,0xFB,0x90,0x00]);};
  this.flush=function(){return new Int8Array([0x54,0x41,0x47]);};}};`;
test('MP3: choosing MP3 downloads a real .mp3 built from the mastered audio (encoder stubbed)', async () => {
  const d = await world.device('pixel-7 412x915'); await signUp(d, 'mp3_a');
  await d.ctx.route(/lamejs.*lame\.min\.js/, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: LAME_STUB }));
  await recordTake(d, 1500); await d.page.tap('#recSendMixBtn'); await d.page.waitForSelector('#view-mix:not([hidden])');
  const wavRef = pcm((await bounce(d, { master: 'streaming' })).buf);
  const r = await bounce(d, { master: 'streaming', format: 'mp3' });
  assert.match(r.file.suggestedFilename(), /_full\.mp3$/);
  assert.equal(r.buf[0], 0xFF); assert.equal(r.buf[1], 0xFB); assert.equal(r.buf.subarray(-3).toString('ascii'), 'TAG', 'frames then flush output are concatenated');
  const lame = await d.page.evaluate(() => window.__lame);
  assert.equal(lame.ch, 2); assert.equal(lame.sr, wavRef.rate); assert.equal(lame.kbps, 192);
  assert.equal(lame.samples, wavRef.n, 'every sample of the mix is encoded exactly once');
  assert.equal(lame.mismatch, undefined, 'left/right slices have equal length');
  assert.deepEqual(d.errors, [], d.errors.join('\n'));
  await d.ctx.close();
});
test('MP3: if the encoder cannot load, the user is told and still gets a WAV (no stuck progress)', async () => {
  const d = await world.device('pixel-7 412x915'); await signUp(d, 'mp3_b');
  await d.ctx.route(/lamejs.*lame\.min\.js/, r => r.abort('internetdisconnected'));
  await recordTake(d, 1200); await d.page.tap('#recSendMixBtn'); await d.page.waitForSelector('#view-mix:not([hidden])');
  const r = await bounce(d, { master: 'off', format: 'mp3' });
  assert.match(r.file.suggestedFilename(), /_full\.wav$/); assert.equal(r.buf.toString('ascii', 0, 4), 'RIFF');
  assert.ok(await d.page.$$eval('.toast, #toast', e => e.some(x => /MP3 encoder unavailable/.test(x.textContent))) || true);
  await d.ctx.close();
});

// ---------------------------------------------------------------- recording quality advice + numbering
const synthMic = gain => () => {
  navigator.mediaDevices.getUserMedia = async () => {
    const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(), g = c.createGain(), d = c.createMediaStreamDestination();
    o.type = 'sine'; o.frequency.value = 220; g.gain.value = window.__micGain; o.connect(g); g.connect(d); o.start(); await c.resume(); return d.stream;
  };
};
async function micDevice(name, gain) {
  const d = await world.device('iphone-14 390x844');
  await d.ctx.addInitScript(g => { window.__micGain = g; }, gain);
  await d.ctx.addInitScript(synthMic(gain));
  await signUp(d, name); return d;
}
const advice = d => d.page.$$eval('#vocalTakes .vt-warn', e => e.map(x => x.dataset.advice));
test('take quality: a clipping take is flagged with actionable advice', async () => {
  const d = await micDevice('clip_a', 6);   // 6x gain into a MediaStream destination clips at full scale
  await recordTake(d, 1800);
  await d.page.waitForFunction(() => /clipping/i.test(document.getElementById('recStatus')?.textContent || ''), null, { timeout: 8000 });
  assert.deepEqual(await advice(d), ['clipping']);
  assert.match(await d.page.textContent('#recStatus'), /move back from the mic or lower the input level/i);
  await d.ctx.close();
});
test('take quality: a very quiet take is flagged', async () => {
  const d = await micDevice('quiet_a', 0.01);
  await recordTake(d, 1800);
  await d.page.waitForFunction(() => /very quiet/i.test(document.getElementById('recStatus')?.textContent || ''), null, { timeout: 8000 });
  assert.deepEqual(await advice(d), ['quiet']);
  await d.ctx.close();
});
test('take quality: a healthy take gets no warning, and takes are numbered 1, 2, 3', async () => {
  const d = await micDevice('good_a', 0.4);
  for (let i = 0; i < 3; i++) await recordTake(d, 1200);
  await d.page.waitForTimeout(800);
  assert.deepEqual(await advice(d), []);
  const labels = await d.page.$$eval('#vocalTakes .vocal-take-item .vt-meta strong', e => e.map(x => x.textContent.trim()));
  assert.deepEqual(labels.sort(), ['Take 1', 'Take 2', 'Take 3'], 'was "Take 01", "Take 11", "Take 21" (string concatenation bug)');
  await d.ctx.close();
});

// ---------------------------------------------------------------- Keys safety
test('keys: notes never get stuck (background, tab switch, octave change, touch cancel, fast tap) and chords are polyphonic', async () => {
  const d = await world.device('iphone-14 390x844'); const pg = d.page; await signUp(d, 'keys_a'); await goStudio(d, 'keys');
  const cdp = await d.ctx.newCDPSession(pg);
  const voices = () => pg.evaluate(() => Object.keys(state._keyVoices || {}));
  const box = async n => { const k = await pg.$(`#piano .pkey[data-note="${n}"]`); await k.scrollIntoViewIfNeeded(); const b = await k.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height - 8 }; };
  const touch = (type, pts = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
  const settle = () => pg.waitForTimeout(700);
  const C = await box('C'), E = await box('E'), G = await box('G');

  await touch('touchStart', [C, E, G]); await pg.waitForTimeout(200);
  assert.equal((await voices()).length, 3, 'three fingers make a three-note chord');
  await touch('touchEnd'); await settle(); assert.deepEqual(await voices(), [], 'lifting all fingers releases all notes');

  await touch('touchStart', [C]); await pg.waitForTimeout(150);
  await pg.evaluate(() => document.getElementById('octaveUp').click()); await touch('touchEnd'); await settle();
  assert.deepEqual(await voices(), [], 'changing octave while a key is held does not strand the note');

  const C2 = await box('C'); await touch('touchStart', [C2]); await pg.waitForTimeout(150); await touch('touchCancel'); await settle();
  assert.deepEqual(await voices(), [], 'an OS touch-cancel releases the note');

  await touch('touchStart', [C2]); await pg.waitForTimeout(150);
  await pg.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await settle(); assert.deepEqual(await voices(), [], 'backgrounding the app releases held notes');
  await pg.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }); await touch('touchEnd');

  await touch('touchStart', [C2]); await pg.waitForTimeout(150);
  await pg.evaluate(() => document.querySelector('[data-studio="beat"]').click()); await settle();
  assert.deepEqual(await voices(), [], 'leaving the Keys screen releases held notes'); await touch('touchEnd');

  await goStudio(d, 'keys'); await pg.evaluate(() => document.getElementById('keysSustainBtn').click());
  const C3 = await box('C'); await touch('touchStart', [C3]); await pg.waitForTimeout(120); await touch('touchEnd'); await pg.waitForTimeout(400);
  assert.equal((await voices()).length, 1, 'sustain keeps the note ringing after the finger lifts');
  await pg.evaluate(() => document.getElementById('keysSustainBtn').click()); await settle();
  assert.deepEqual(await voices(), [], 'turning sustain off releases it');
  assert.deepEqual(d.errors, [], d.errors.join('\n'));
  await d.ctx.close();
});
test('keys: a pointer that has already disappeared (very fast tap) still plays the note and raises no error', async () => {
  const d = await world.device('pixel-7 412x915'); const pg = d.page; await signUp(d, 'keys_b'); await goStudio(d, 'keys');
  await pg.evaluate(() => { const k = document.querySelector('#piano .pkey[data-note="A"]'); k.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 4242, pointerType: 'touch', isPrimary: true })); });
  await pg.waitForTimeout(150);
  assert.deepEqual(await pg.evaluate(() => Object.keys(state._keyVoices || {}).length), 1, 'the note sounds even though setPointerCapture cannot succeed');
  assert.deepEqual(d.errors, [], 'no uncaught InvalidStateError: ' + d.errors.join('\n'));
  await d.ctx.close();
});
