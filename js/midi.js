/* Tapehead MIDI helpers: pure parsing of raw MIDI bytes into note/pedal events (no DOM, no Web MIDI).
   Used by the Keys screen; unit-tested in Node. Exposes window.TapeheadMidi. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TapeheadMidi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  /** MIDI note number -> { note: 'C#', octave: 4 } using the scientific scale where 60 = C4. */
  function noteInfo(n) { return { note: NAMES[n % 12], octave: Math.floor(n / 12) - 1 }; }
  function frequency(n) { return 440 * Math.pow(2, (n - 69) / 12); }
  /**
   * Parse one MIDI message (array-like of bytes). Returns null for anything we do not act on.
   *   { type:'on',  note, velocity (0..1), raw, channel }   note on with velocity > 0
   *   { type:'off', note, channel }                          note off, or note on with velocity 0
   *   { type:'pedal', down, channel }                        CC64 (sustain), down when value >= 64
   *   { type:'panic', channel }                              CC120 all sound off / CC123 all notes off
   * Channel 10 (index 9) is the General MIDI drum channel and is ignored so drum machines do not play pitched notes.
   */
  function parse(data) {
    if (!data || data.length < 2) return null;
    const status = data[0];
    if (!(status >= 0x80 && status <= 0xEF)) return null;          // system / realtime / running-status data: ignored
    const kind = status & 0xF0, channel = status & 0x0F;
    if (channel === 9) return null;
    const d1 = data[1] & 0x7F, d2 = data.length > 2 ? data[2] & 0x7F : NaN;
    if (kind === 0x90 || kind === 0x80) {
      if (kind === 0x80 || d2 === 0) return { type: 'off', note: d1, channel };
      if (!Number.isFinite(d2)) return null;
      return { type: 'on', note: d1, velocity: d2 / 127, raw: d2, channel };
    }
    if (kind === 0xB0) {
      if (d1 === 64) return Number.isFinite(d2) ? { type: 'pedal', down: d2 >= 64, channel } : null;
      if (d1 === 120 || d1 === 123) return { type: 'panic', channel };
    }
    return null;
  }
  return { parse, noteInfo, frequency, NAMES };
});
