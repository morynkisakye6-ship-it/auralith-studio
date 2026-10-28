# Auralith Pro v1.12.14: Studio engine maturity (Mix, Beat, Record, Keys)

Audit method: measured a real bounce (loudness, clipping, DC, stereo), probed Keys with real touch events (CDP), and read the engine code.
The studio already had a metronome, latency nudge, EQ, glue compressor, A/B, arrangement, sustain, velocity, scale lock and
a live-graph limiter, so none of those were duplicated. Gaps found and closed below.

## Premium functionality added
| Area | Feature |
|---|---|
| Mix / export | **Master** selector on Bounce: As mixed, Streaming (-14 LUFS), Podcast (-16), Loud (-11). ITU-R BS.1770-4 loudness (K-weighting, absolute + relative gating), 4x oversampled **true-peak limiter** at -1 dBTP, lookahead, smooth release. Measured before: as-mixed bounce was -21.7 LUFS (about 7 dB quieter than streaming-ready). |
| Mix / export | **Loudness report** after every bounce (LUFS and dBTP, before and after, gain applied) with plain-language hints; says when a target cannot be reached without heavy limiting. |
| Mix / export | **Dithered 16-bit export** (TPDF) so quiet tails and fades do not distort. |
| Mix / export | **MP3 export that works** (192 kbps), encoded from the mastered audio in slices so the UI stays responsive; encoder cached offline by the service worker; clear message and WAV fallback if it cannot load. |
| Record | **Take quality check**: every take is analysed; clipping, very quiet or silent takes are flagged with actionable advice on the take and in the status line. |
| Keys | **All-notes-off safety net** (app backgrounded, screen locked, tab switched, touch cancelled). |

## Bugs found and fixed
1. **MP3 export never produced an MP3.** The code lived in `index.html` and wrapped `window.bounceFullSong`, which is private to `app.js`, so the wrapper never ran: choosing MP3 silently gave a WAV with a "multi-bus WAV" toast. (My earlier note that "no encoder is bundled" described the symptom, not the cause.) Rebuilt as `js/mp3.js`.
2. **Take names were wrong**: `'Take ' + count + 1` concatenates strings, giving "Take 01", "Take 11", "Take 21". Both recorded and uploaded takes. Now sequential and robust to the 6-take cap.
3. **Held keys kept sounding** when the app was backgrounded or the Keys tab was left, and a note could be lost entirely when the browser had already dropped the pointer (`setPointerCapture` threw before the note started). Note now starts first, capture is guarded, release uses the voice that was actually started.
4. Limiter edge case (found by the new unit tests): a loud transient at the very first sample was not limited.

## Tests added
- `tests/dsp.test.mjs` (21): BS.1770 calibration (997 Hz stereo sine at -20 dBFS reads -20.0 LUFS at 44.1k and 48k), channel summing, K-weighting, absolute/relative gating, short signals, inter-sample true peak, limiter ceiling/bit-exact passthrough/smooth gain/stereo image, mastering accuracy and boost cap, silence handling, dither unbiasedness, take analysis, performance (75 s stereo).
- `e2e/engine.e2e.mjs` (11): bounces at all four Master settings are measured from the downloaded WAV; on-screen report matches the file; MP3 wiring (stubbed encoder: channels, sample rate, bitrate, every sample encoded once) and failure fallback; synthetic microphone at clipping / very quiet / healthy levels; take numbering; Keys (chords, octave change while held, touch cancel, backgrounding, tab switch, sustain, fast-tap race).
- Mutation check: 9 of the above were reintroduced one at a time; each made a test fail.

## Totals
85 unit tests, 51 end-to-end tests (1 skipped: icon files are not in this archive), source assertions in `scripts/verify-security.mjs`.

## Not done / honest limits
- Not verified on a physical phone: sound, latency, iOS silent switch, Bluetooth. Use `../qa/MOBILE-QA-CHECKLIST.md` (updated).
- The real `lamejs` encoder was not run (no network here); its integration was tested with a stub. First online export on a real device is a required check.
- Mastering runs on the main thread: about 2 s for a 73 s stereo song in Node; a low-end phone may take several seconds with the progress bar visible. A Web Worker would remove the pause.
- The bounce is still effectively mono-compatible (stereo correlation 1.00 in the test song): there is no stereo width processing. Not changed.
- Not added: MIDI input for Keys, auto latency calibration, per-channel meters/EQ visualisation, undo/redo for the beat grid. These are larger features; say which you want next.
