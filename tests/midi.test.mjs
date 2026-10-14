import { test } from 'node:test';
import assert from 'node:assert/strict';
import midi from '../js/midi.js';

test('note numbers map to scientific pitch names (60 = C4, 69 = A4)', () => {
  assert.deepEqual(midi.noteInfo(60), { note: 'C', octave: 4 });
  assert.deepEqual(midi.noteInfo(69), { note: 'A', octave: 4 });
  assert.deepEqual(midi.noteInfo(61), { note: 'C#', octave: 4 });
  assert.deepEqual(midi.noteInfo(21), { note: 'A', octave: 0 });
  assert.deepEqual(midi.noteInfo(108), { note: 'C', octave: 8 });
  assert.deepEqual(midi.noteInfo(0), { note: 'C', octave: -1 });
});
test('frequencies follow equal temperament around A440', () => {
  assert.equal(midi.frequency(69), 440);
  assert.ok(Math.abs(midi.frequency(60) - 261.6256) < 0.001);
  assert.ok(Math.abs(midi.frequency(81) - 880) < 1e-9);
  assert.ok(Math.abs(midi.frequency(21) - 27.5) < 1e-9);
});
test('note on carries velocity 0..1; note on with velocity 0 is a note off; explicit note off', () => {
  assert.deepEqual(midi.parse([0x90, 60, 127]), { type: 'on', note: 60, velocity: 1, raw: 127, channel: 0 });
  const soft = midi.parse([0x93, 64, 32]); assert.equal(soft.type, 'on'); assert.equal(soft.channel, 3); assert.ok(Math.abs(soft.velocity - 32 / 127) < 1e-12);
  assert.deepEqual(midi.parse([0x90, 60, 0]), { type: 'off', note: 60, channel: 0 });
  assert.deepEqual(midi.parse([0x80, 60, 64]), { type: 'off', note: 60, channel: 0 });
  assert.deepEqual(midi.parse(new Uint8Array([0x81, 72, 0])), { type: 'off', note: 72, channel: 1 });
});
test('sustain pedal: CC64 >= 64 is down, below is up', () => {
  assert.deepEqual(midi.parse([0xB0, 64, 127]), { type: 'pedal', down: true, channel: 0 });
  assert.deepEqual(midi.parse([0xB0, 64, 64]), { type: 'pedal', down: true, channel: 0 });
  assert.deepEqual(midi.parse([0xB0, 64, 63]), { type: 'pedal', down: false, channel: 0 });
  assert.deepEqual(midi.parse([0xB2, 64, 0]), { type: 'pedal', down: false, channel: 2 });
});
test('All Sound Off (120) and All Notes Off (123) are panic events', () => {
  assert.equal(midi.parse([0xB0, 123, 0]).type, 'panic'); assert.equal(midi.parse([0xB4, 120, 0]).type, 'panic');
});
test('the drum channel (10) is ignored so drum machines do not play pitched notes', () => {
  assert.equal(midi.parse([0x99, 36, 100]), null); assert.equal(midi.parse([0x89, 36, 0]), null); assert.equal(midi.parse([0xB9, 123, 0]), null);
  assert.equal(midi.parse([0x98, 36, 100]).type, 'on', 'channel 9 (index 8) is still a normal channel');
});
test('malformed, short and irrelevant messages are ignored without throwing', () => {
  for (const m of [null, undefined, [], [0x90], [0x90, 60], [0xF8], [0xFE], [0xE0, 0, 64], [0xC0, 5], [0xB0, 7, 100], [0xB0, 64], [60, 100, 100], 'x', {}]) assert.equal(midi.parse(m), null, JSON.stringify(m));
  assert.doesNotThrow(() => midi.parse([0x90, 300, 400]));
  const hi = midi.parse([0x90, 0xFF & 0x7F, 0xFF]); assert.ok(hi && hi.note <= 127 && hi.velocity <= 1);
});
