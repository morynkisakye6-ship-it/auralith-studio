# Tapehead Pro v1.12.15: Studio features (undo/redo, meters, MIDI, latency calibration)

## Added
| Feature | Details |
|---|---|
| **Beat undo / redo** | Buttons plus Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z / Ctrl+Y. Covers pad edits (including drag-painting), Randomize, Clear, Duplicate, step count, kit, swing, tempo. Tempo and swing bursts merge into one step. History is discarded if something else replaces the pattern (song load, room restore). 60 steps. |
| **Channel and master meters** | Per-channel peak meters with peak hold, a clip latch and `role="meter"` accessibility, plus a master dBFS readout. The meter loop now sleeps when silent or hidden (it used to redraw 60 times a second forever after the first play). |
| **MIDI keyboard input** | Web MIDI (Chrome/Edge on desktop and Android; not iOS Safari, which the UI says). Absolute pitch, velocity, sustain pedal (CC64), All Notes Off, drum channel ignored, hot-plug, auto-reconnect only once already granted, notes released on unplug/background. |
| **Mic latency auto-calibration** | "Auto-calibrate" on the Record screen plays chirps and records them through the same capture path and recorder a real take uses, finds the delay by FFT cross-correlation, and sets the mic timing for new takes. Explains failures (silent room, noise, unsteady timing), cancellable, refuses during a recording, persisted. |

## Timing bugs found and fixed (important)
1. **A recorded take was placed hundreds of milliseconds early in every bounce.** The beat starts first, the app waits 350 ms, then opens the microphone and starts the recorder, so a take's timeline begins that much after the beat's. Nothing compensated for it. Measured: vocal landed about 248 ms early in a bounce. Each take now records the gap on the audio clock (`gapMs`) and the bounce places it at section start + timing + gap. Older takes (no `gapMs`) behave as before.
2. **Negative mic-timing offsets were ignored on the first section** (`Math.max(0, offset)`), and negative offsets are the only direction that can compensate for hardware latency. A take that must start before 0 now has its head trimmed.
3. **New takes ignored the mic-timing setting**: they were created with offset 0 even if the slider said otherwise.
4. The published/saved vocal metadata now carries the gap, so shared posts play in time too.

## Tests
- `tests/dsp.test.mjs` (29): FFT, delay finding to <0.1 ms, latency estimation with noise, echo, low-pass, missing clicks, silence, jitter, 44.1/48 kHz.
- `tests/midi.test.mjs` (7), `e2e/beat-history.e2e.mjs` (11), `e2e/meters.e2e.mjs` (8, includes dB calibration against a known sine and an idle-redraw guard), `e2e/midi.e2e.mjs` (13, fake Web MIDI device), `e2e/timing.e2e.mjs` (9, virtual speaker-to-mic cable with known delay).
- Mutation checks run on undo/redo, meters, MIDI velocity, limiter; all caught (one MIDI pedal mutant is equivalent).
- Totals at release: 100 unit tests; e2e specs all pass in the final runs.

## Honest limits
- **Residual vocal offset of about 20-30 ms in the emulated test environment** after calibration (down from about 230 ms uncalibrated with a deliberately bad 260 ms cable, a 90%+ reduction). It is stable between takes to within about 10 ms, which is the browser MediaRecorder's start-up jitter. I could not fully explain the last ~25 ms (the bounce's vocal path adds 12 ms of compressor lookahead; the rest is unaccounted for). Real phones will differ. **Verify with the clap test in `qa/MOBILE-QA-CHECKLIST.md` on real devices before relying on it.**
- Calibration needs an acoustic path: speaker to mic. With Bluetooth or closed headphones it reports that it cannot hear the test sounds. Calibrate on the output you will record with.
- Uploaded-backing-track takes still start with the track and use gap 0.
- Vocal has no live meter (vocal preview plays through an audio element outside the mix graph); drum/keys channels and master do.
- Existing takes are never re-timed by calibration; only new takes use it. Use the nudge buttons for old ones.
- Not done: per-take sync pilot (automatic alignment of every take), Web Worker mastering, MIDI output/learn, undo for Keys takes.
