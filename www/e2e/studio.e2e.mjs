// Beat making -> recording -> mixing -> bounce, on a phone-sized viewport with a fake microphone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './harness.mjs';
import { signUp, goNav, goStudio, recordTake, analyzeWav, readDownload, visibleView } from './flows.mjs';

let world, d, pg;
before(async () => { world = await startWorld(); d = await world.device('iphone-14 390x844'); pg = d.page; await signUp(d, 'studio_artist'); });
after(async () => { await world.close(); });

test('beat maker: pads cycle off/soft/normal/accent and BPM controls work', async () => {
  await goStudio(d, 'beat');
  const pad = await pg.$('#view-beat .st:not(.on)');
  const id = await pad.evaluate(e => `${e.dataset.track}:${e.dataset.step}`);
  const states = [];
  for (let i = 0; i < 4; i++) { await pad.tap(); states.push((await pad.getAttribute('aria-label')).split(': ')[1]); }
  assert.deepEqual(states, ['soft', 'normal', 'accent', 'off'], `pad ${id}`);
  const bpm = async () => Number((await pg.textContent('#beatBpmValue')).replace(/\D/g, ''));
  const b0 = await bpm();
  await pg.tap('#beatBpmUp'); await pg.tap('#beatBpmUp'); await pg.tap('#beatBpmDown');
  assert.equal(await bpm(), b0 + 1, 'each tap changes tempo by exactly 1 (no duplicate handlers)');
  assert.match(await pg.textContent('#bpmBadge'), new RegExp(String(b0 + 1)));
  for (let i = 0; i < 4; i++) { await pg.tap('#beatTapTempo'); await pg.waitForTimeout(500); }       // ~120 BPM taps
  const tapped = await bpm();
  assert.ok(tapped >= 100 && tapped <= 140, 'tap tempo lands near the tapped speed: ' + tapped);
});

test('beat maker: the hits/accents counter reflects the pattern', async () => {
  await goStudio(d, 'beat');
  const label = await pg.textContent('#beatHitCount');
  const { on, accents } = await pg.$$eval('#view-beat .st.on', els => ({ on: els.length, accents: els.filter(e => Number(e.dataset.velocity) >= 0.99).length }));
  assert.ok(on > 0);
  assert.equal(label, `${on} hits · ${accents} accents`, 'counter must match the visible pads (was stuck at 0)');
  const pad = await pg.$('#view-beat .st:not(.on)'); await pad.tap();                       // adds a soft hit
  assert.equal(await pg.textContent('#beatHitCount'), `${on + 1} hits · ${accents} accents`, 'counter updates live');
});

test('beat maker: play produces audio, transport reports state, stop silences it', async () => {
  await goStudio(d, 'beat');
  const before = (await d.qa()).sourcesStarted;
  await pg.tap('#playBtn');
  await pg.waitForFunction(() => /playing/i.test(document.getElementById('transportStatus')?.textContent || ''));
  await pg.waitForTimeout(1500);
  const during = (await d.qa()).sourcesStarted;
  assert.ok(during > before + 5, `audio nodes were scheduled while playing (${before} -> ${during})`);
  const ctxState = await pg.evaluate(() => window.__qa.contexts.map(c => c.state));
  assert.ok(ctxState.includes('running'), 'AudioContext is running after a user gesture: ' + ctxState);
  await pg.tap('#playBtn');
  await pg.waitForFunction(() => /stopped/i.test(document.getElementById('transportStatus')?.textContent || ''));
  const settled = (await d.qa()).sourcesStarted; await pg.waitForTimeout(800);
  assert.equal((await d.qa()).sourcesStarted, settled, 'nothing keeps scheduling after stop');
});

test('beat maker: pattern and tempo survive a reload', async () => {
  await goStudio(d, 'beat');
  const pad = await pg.$('#view-beat .st:not(.on)'); const key = await pad.evaluate(e => `${e.dataset.track}:${e.dataset.step}`);
  await pad.tap();
  const bpm = (await pg.textContent('#beatBpmValue')).trim();
  await pg.waitForTimeout(600);
  await pg.reload(); await pg.waitForSelector('[data-nav="studio"]'); await goStudio(d, 'beat');
  const [track, step] = key.split(':');
  assert.ok(await pg.$eval(`#view-beat .st[data-track="${track}"][data-step="${step}"]`, e => e.classList.contains('on')), 'edited pad is still on after reload');
  assert.equal((await pg.textContent('#beatBpmValue')).trim(), bpm, 'tempo restored');
});

test('record: take is captured from the microphone, waveform is drawn, take can be played back', async () => {
  const mics = (await d.qa()).micRequests;
  await recordTake(d, 2500);
  assert.equal((await d.qa()).micRequests, mics + 1, 'asked for the microphone exactly once');
  assert.match(await pg.textContent('#recStatus'), /Take \d+ saved/);
  assert.equal(await pg.$$eval('#vocalTakes .vocal-take-item', e => e.length), 1);
  const inked = await pg.$eval('#recWaveCanvas', c => { const x = c.getContext('2d'); const { data } = x.getImageData(0, 0, c.width, c.height); let n = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++; return n; });
  assert.ok(inked > 50, 'waveform canvas has drawn pixels: ' + inked);
  const before = await d.qa();
  await pg.tap('#recPlayVocalBtn'); await pg.waitForTimeout(800);
  const after = await d.qa();
  assert.ok(after.mediaPlays > before.mediaPlays || after.sourcesStarted > before.sourcesStarted, 'playing the take starts audio');
});

test('record: a second take is added without losing the first; recording state resets cleanly', async () => {
  await recordTake(d, 1500);
  assert.equal(await pg.$$eval('#vocalTakes .vocal-take-item', e => e.length), 2);
  assert.ok(!(await pg.$eval('#vocalRecBtn', e => /stop|recording/i.test(e.textContent + e.className))), 'REC button is not stuck in the recording state');
});

test('mix: vocal channel appears after Send to Mix; mute, solo and faders change state', async () => {
  await pg.tap('#recSendMixBtn');
  await pg.waitForSelector('#view-mix:not([hidden])');
  const names = await pg.$$eval('#channelStrip .ch-row', rows => rows.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
  assert.ok(names.some(n => /^Vocal/.test(n)), 'vocal channel present: ' + names.join(' | '));
  const row = pg.locator('#channelStrip .ch-row', { hasText: 'Vocal' });
  const mute = row.locator('[data-mute="vocal"]'), solo = row.locator('[data-solo="vocal"]');
  await mute.tap(); assert.ok(await mute.evaluate(e => /\bon\b/.test(e.className) || e.getAttribute('aria-pressed') === 'true'), 'mute engaged');
  await mute.tap(); assert.ok(!(await mute.evaluate(e => /\bon\b/.test(e.className) || e.getAttribute('aria-pressed') === 'true')), 'mute released');
  await solo.tap(); assert.ok(await solo.evaluate(e => /\bon\b/.test(e.className) || e.getAttribute('aria-pressed') === 'true'), 'solo engaged'); await solo.tap();
  const level = row.locator('input[data-vol="vocal"]');
  const vol0 = await pg.evaluate(() => state.volumes.vocal);
  await level.evaluate(e => { e.value = '40'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  const vol1 = await pg.evaluate(() => state.volumes.vocal);
  assert.notEqual(vol1, vol0, 'moving the fader changes the vocal level in the mix state');
  assert.ok(Math.abs(vol1 - 0.4) < 0.01, 'level 40 -> 0.4, got ' + vol1);
});

test('mix: Bounce Full Mix downloads a valid, non-silent stereo WAV and the button recovers', async () => {
  await pg.selectOption('#bounceQuality', 'draft');
  const dl = pg.waitForEvent('download', { timeout: 90000 });
  await pg.tap('#mixdownBtn');
  assert.ok(await pg.$eval('#bounceProgress', e => !e.hidden), 'progress UI is shown while rendering');
  const file = await dl;
  assert.match(file.suggestedFilename(), /_full\.wav$/);
  const wav = analyzeWav(await readDownload(file));
  assert.ok(wav.valid, wav.reason);
  assert.equal(wav.format, 1, 'PCM'); assert.equal(wav.bits, 16); assert.equal(wav.channels, 2);
  assert.ok([44100, 48000].includes(wav.rate), 'sample rate ' + wav.rate);
  assert.ok(wav.riffSizeOk && wav.dataSizeOk, 'header sizes match the file');
  assert.ok(wav.seconds >= 4 && wav.seconds <= 300, 'plausible duration: ' + wav.seconds);
  assert.ok(wav.peak > 0.05, 'not silent, peak ' + wav.peak);
  assert.ok(wav.peak <= 1, 'no overflow');
  await pg.waitForFunction(() => /downloaded/i.test(document.getElementById('bounceLabel')?.textContent || ''));
  await pg.waitForFunction(() => { const b = document.getElementById('mixdownBtn'); return !b.disabled && /Bounce Full Mix/.test(b.textContent); }, null, { timeout: 5000 });
  assert.deepEqual((await d.qa()).errors, []);
});

test('mix: Export Stems downloads a ZIP of stems', async () => {
  const dl = pg.waitForEvent('download', { timeout: 120000 });
  await pg.tap('#stemsBtn');
  const file = await dl; const buf = await readDownload(file);
  assert.match(file.suggestedFilename(), /\.zip$/i);
  assert.equal(buf.toString('ascii', 0, 2), 'PK', 'ZIP signature');
  assert.ok(buf.length > 10000);
  await pg.waitForFunction(() => { const b = document.getElementById('stemsBtn'); return !b.disabled; }, null, { timeout: 5000 });
});

test('app stays healthy: no uncaught errors across the whole studio flow', async () => {
  assert.deepEqual(d.errors, [], 'page errors: ' + d.errors.join('\n'));
  assert.deepEqual((await d.qa()).errors, []);
});
