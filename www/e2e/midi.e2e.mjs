// MIDI keyboard input on the Keys screen, driven by a fake Web MIDI implementation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './harness.mjs';
import { signUp, goStudio } from './flows.mjs';

let world;
before(async () => { world = await startWorld(); });
after(async () => { await world.close(); });

const FAKE = () => {
  const inputs = new Map();
  const acc = { inputs, outputs: new Map(), onstatechange: null, sysexEnabled: false };
  const mk = (id, name) => ({ id, name, type: 'input', state: 'connected', connection: 'open', onmidimessage: null, addEventListener() {}, removeEventListener() {} });
  window.__midi = {
    requests: 0, acc,
    add(id, name) { const p = mk(id, name); inputs.set(id, p); acc.onstatechange && acc.onstatechange({ port: p }); },
    remove(id) { const p = inputs.get(id); p.state = 'disconnected'; acc.onstatechange && acc.onstatechange({ port: p }); inputs.delete(id); },
    send(bytes, id) { const p = id ? inputs.get(id) : [...inputs.values()][0]; if (p && p.onmidimessage) p.onmidimessage({ data: Uint8Array.from(bytes), target: p }); }
  };
  navigator.requestMIDIAccess = async () => { window.__midi.requests++; try { localStorage.setItem('__midiGranted', '1'); } catch (_) {} return acc; };
  const q = navigator.permissions && navigator.permissions.query ? navigator.permissions.query.bind(navigator.permissions) : null;
  navigator.permissions.query = async d => (d && d.name === 'midi' ? { state: localStorage.getItem('__midiGranted') === '1' ? 'granted' : 'prompt' } : q(d));
};

async function keysDevice(variant = 'ok', name = 'midi_' + Math.random().toString(36).slice(2, 7)) {
  const d = await world.device('pixel-7 412x915');
  if (variant === 'ok') await d.ctx.addInitScript(FAKE);
  if (variant === 'none') await d.ctx.addInitScript(() => { delete Navigator.prototype.requestMIDIAccess; delete navigator.requestMIDIAccess; });   // like iOS Safari: the API does not exist at all
  if (variant === 'blocked') await d.ctx.addInitScript(() => { navigator.requestMIDIAccess = async () => { throw new DOMException('denied', 'SecurityError'); }; });
  await signUp(d, name); await goStudio(d, 'keys');
  return d;
}
const send = (d, bytes, id) => d.page.evaluate(([b, i]) => window.__midi.send(b, i), [bytes, id]);
const voices = d => d.page.evaluate(() => Object.keys(state._keyVoices || {}).sort());
const status = d => d.page.textContent('#midiStatus');
const enable = async d => { await d.page.tap('#midiBtn'); await d.page.waitForFunction(() => /MIDI/.test(document.getElementById('midiStatus').textContent)); };

test('browsers without Web MIDI (iOS Safari) get a disabled button and a clear explanation', async () => {
  const d = await keysDevice('none');
  assert.equal(await d.page.$eval('#midiBtn', e => e.disabled), true);
  assert.match(await status(d), /not available in this browser/i);
  assert.deepEqual(d.errors, []); await d.ctx.close();
});
test('blocked permission is explained and the button can be tried again', async () => {
  const d = await keysDevice('blocked');
  await d.page.tap('#midiBtn'); await d.page.waitForFunction(() => /blocked/i.test(document.getElementById('midiStatus').textContent));
  assert.match(await status(d), /Allow it in the browser or site settings/i);
  assert.equal(await d.page.$eval('#midiBtn', e => e.disabled), false); assert.equal(await d.page.getAttribute('#midiBtn', 'aria-pressed'), 'false');
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('enabling lists connected devices, follows hot-plug, and toggles off', async () => {
  const d = await keysDevice();
  await enable(d); assert.match(await status(d), /connect a keyboard/i); assert.equal(await d.page.getAttribute('#midiBtn', 'aria-pressed'), 'true');
  await d.page.evaluate(() => window.__midi.add('a', 'KeyStep 37'));
  await d.page.waitForFunction(() => /KeyStep 37/.test(document.getElementById('midiStatus').textContent));
  await d.page.evaluate(() => window.__midi.add('b', 'Launchkey Mini'));
  await d.page.waitForFunction(() => /KeyStep 37, Launchkey Mini/.test(document.getElementById('midiStatus').textContent));
  await d.page.evaluate(() => window.__midi.remove('a'));
  await d.page.waitForFunction(() => !/KeyStep/.test(document.getElementById('midiStatus').textContent));
  await send(d, [0x90, 60, 100], 'b'); assert.deepEqual(await voices(d), ['C4'], 'a newly plugged device plays');
  await send(d, [0x80, 60, 0], 'b');
  await d.page.tap('#midiBtn'); assert.match(await status(d), /MIDI off/); await send(d, [0x90, 62, 100], 'b');
  assert.deepEqual(await voices(d), [], 'a disabled MIDI input makes no sound');
  assert.equal(await d.page.evaluate(() => localStorage.getItem('th-midi')), null);
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('pitch is exact across the whole keyboard, independent of the on-screen octave', async () => {
  const d = await keysDevice(); await enable(d); await d.page.evaluate(() => window.__midi.add('a', 'Kbd'));
  for (const [n, key, hz] of [[21, 'A0', 27.5], [36, 'C2', 65.406], [60, 'C4', 261.626], [61, 'C#4', 277.183], [69, 'A4', 440], [96, 'C7', 2093.005], [108, 'C8', 4186.009]]) {
    await send(d, [0x90, n, 90]);
    const got = await d.page.evaluate(k => state._keyVoices[k] && state._keyVoices[k].o.frequency.value, key);
    assert.ok(got && Math.abs(got - hz) / hz < 0.0005, `${key}: ${got} Hz, expected ${hz}`);
    await send(d, [0x80, n, 0]);
  }
  await d.page.evaluate(() => document.getElementById('octaveUp').click()); await send(d, [0x90, 60, 90]);
  assert.deepEqual(await voices(d), ['C4'], 'octave buttons only shift the touch keyboard'); await send(d, [0x80, 60, 0]);
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('velocity controls loudness proportionally', async () => {
  const d = await keysDevice(); await enable(d); await d.page.evaluate(() => window.__midi.add('a', 'Kbd'));
  const level = async v => { await send(d, [0x90, 64, v]); await d.page.waitForTimeout(160); const g = await d.page.evaluate(() => state._keyVoices.E4.g.gain.value); await send(d, [0x80, 64, 0]); return g; };
  const soft = await level(20), loud = await level(127), mid = await level(64);
  assert.ok(Math.abs(loud / soft - 127 / 20) / (127 / 20) < 0.12, `ratio ${(loud / soft).toFixed(2)} vs ${(127 / 20).toFixed(2)}`);
  assert.ok(soft < mid && mid < loud);
  await d.ctx.close();
});

test('note off, note-on-with-velocity-0, and All Notes Off / All Sound Off release voices; chords are polyphonic', async () => {
  const d = await keysDevice(); await enable(d); await d.page.evaluate(() => window.__midi.add('a', 'Kbd'));
  await send(d, [0x90, 60, 80]); await send(d, [0x90, 60, 0]); assert.deepEqual(await voices(d), [], 'velocity-0 note-on is a note-off');
  await send(d, [0x90, 60, 80]); await send(d, [0x80, 60, 40]); assert.deepEqual(await voices(d), []);
  for (const n of [48, 52, 55, 59, 62, 65, 69, 72]) await send(d, [0x90, n, 90]);
  assert.equal((await voices(d)).length, 8, 'eight simultaneous notes');
  await send(d, [0xB0, 123, 0]); assert.deepEqual(await voices(d), [], 'CC123 All Notes Off');
  await send(d, [0x90, 60, 90]); await send(d, [0x90, 64, 90]); await send(d, [0xB0, 120, 0]); assert.deepEqual(await voices(d), [], 'CC120 All Sound Off');
  await d.ctx.close();
});

test('sustain pedal holds released notes, spares notes still held, and releases on pedal up', async () => {
  const d = await keysDevice(); await enable(d); await d.page.evaluate(() => window.__midi.add('a', 'Kbd'));
  await send(d, [0xB0, 64, 127]);
  await send(d, [0x90, 60, 90]); await send(d, [0x80, 60, 0]);
  await send(d, [0x90, 64, 90]);
  assert.deepEqual(await voices(d), ['C4', 'E4'], 'C4 is sustained and E4 is held');
  await send(d, [0xB0, 64, 0]);
  assert.deepEqual(await voices(d), ['E4'], 'pedal up releases only the notes no longer held');
  await send(d, [0x80, 64, 0]); assert.deepEqual(await voices(d), []);
  await send(d, [0xB0, 64, 127]); await send(d, [0x90, 67, 90]); await send(d, [0x80, 67, 0]); await send(d, [0x90, 67, 90]);   // re-strike while sustained
  assert.deepEqual(await voices(d), ['G4']); await send(d, [0xB0, 64, 0]); assert.deepEqual(await voices(d), ['G4'], 'a note that is held again survives pedal up'); await send(d, [0x80, 67, 0]);
  assert.deepEqual(await voices(d), []); await d.ctx.close();
});

test('the drum channel is ignored, other channels play, and malformed bytes never throw', async () => {
  const d = await keysDevice(); await enable(d); await d.page.evaluate(() => window.__midi.add('a', 'Kbd'));
  await send(d, [0x99, 36, 100]); assert.deepEqual(await voices(d), [], 'channel 10');
  await send(d, [0x94, 60, 100]); assert.deepEqual(await voices(d), ['C4'], 'channel 5'); await send(d, [0x84, 60, 0]);
  for (const m of [[], [0x90], [0x90, 60], [0xF8], [0xFE], [0xE0, 0, 64], [0xC0, 5], [0xB0, 7, 100], [0xFF, 0xFF, 0xFF], [0x90, 200, 200]]) await send(d, m);
  await send(d, [0xB0, 123, 0]);
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('on-screen keys light up for MIDI notes in the visible octave only', async () => {
  const d = await keysDevice(); await enable(d); await d.page.evaluate(() => window.__midi.add('a', 'Kbd'));
  const oct = await d.page.evaluate(() => state.octave), midiC = (oct + 1) * 12;
  await send(d, [0x90, midiC, 90]); assert.equal(await d.page.$eval('#piano .pkey[data-note="C"]', e => e.classList.contains('on')), true, 'C in the visible octave lights');
  await send(d, [0x80, midiC, 0]); assert.equal(await d.page.$eval('#piano .pkey[data-note="C"]', e => e.classList.contains('on')), false);
  await send(d, [0x90, midiC + 12, 90]); assert.equal(await d.page.$$eval('#piano .pkey.on', e => e.length), 0, 'a different octave lights nothing'); await send(d, [0x80, midiC + 12, 0]);
  await d.ctx.close();
});

test('safety: unplugging, or backgrounding the app, with notes and pedal held releases everything', async () => {
  const d = await keysDevice(); await enable(d); await d.page.evaluate(() => window.__midi.add('a', 'Kbd'));
  await send(d, [0xB0, 64, 127]); await send(d, [0x90, 60, 90]); await send(d, [0x90, 64, 90]); await send(d, [0x80, 64, 0]);
  await d.page.evaluate(() => window.__midi.remove('a')); assert.deepEqual(await voices(d), [], 'cable pulled');
  await d.page.evaluate(() => window.__midi.add('a', 'Kbd')); await send(d, [0xB0, 64, 127]); await send(d, [0x90, 67, 90]); await send(d, [0x80, 67, 0]);
  await d.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.deepEqual(await voices(d), [], 'backgrounded'); await d.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await send(d, [0x90, 72, 90]); await send(d, [0x80, 72, 0]); assert.deepEqual(await voices(d), [], 'the stale pedal state was cleared: a normal note-off releases');
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});

test('MIDI notes are captured by Keys recording with their velocity', async () => {
  const d = await keysDevice(); await enable(d); await d.page.evaluate(() => window.__midi.add('a', 'Kbd'));
  await d.page.tap('#keysRecordBtn'); await d.page.waitForFunction(() => state.keysRecording);
  await send(d, [0x90, 60, 127]); await d.page.waitForTimeout(120); await send(d, [0x80, 60, 0]); await send(d, [0x90, 64, 40]); await send(d, [0x80, 64, 0]);
  const take = await d.page.evaluate(() => state.keysTake.map(n => ({ n: n.note + n.octave, v: Math.round(n.velocity * 100) / 100 })));
  assert.deepEqual(take.map(t => t.n), ['C4', 'E4']); assert.equal(take[0].v, 1); assert.ok(take[1].v >= 0.3 && take[1].v <= 0.33, 'velocity 40/127: ' + take[1].v);
  await d.ctx.close();
});

test('once granted, MIDI reconnects by itself the next time Keys opens (no repeat prompt, no click)', async () => {
  const d = await keysDevice(); await enable(d);
  await d.page.reload(); await d.page.waitForSelector('[data-nav="studio"]'); await goStudio(d, 'keys');
  await d.page.waitForFunction(() => /MIDI on/.test(document.getElementById('midiStatus').textContent), null, { timeout: 8000 });
  await d.page.evaluate(() => window.__midi.add('a', 'Kbd')); await d.page.waitForFunction(() => /Kbd/.test(document.getElementById('midiStatus').textContent));
  await send(d, [0x90, 60, 90]); assert.deepEqual(await voices(d), ['C4']);
  assert.deepEqual(d.errors, [], d.errors.join('\n')); await d.ctx.close();
});
test('a never-granted browser is not prompted automatically', async () => {
  const d = await keysDevice(); await d.page.waitForTimeout(600);
  assert.equal(await d.page.evaluate(() => window.__midi.requests), 0, 'no requestMIDIAccess call until the user taps MIDI');
  await d.ctx.close();
});
