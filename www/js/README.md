# Studio runtime modules

These browser-loaded modules are deliberately loaded before `app.js` from `index.html`.

- `state.js` — shared state and local persistence helpers.
- `cloud.js` — Supabase authentication and cloud/social adapter (`window.AuralithCloud` remains a compatibility API).
- `continuity.js` — musical continuity/context helpers.
- `dsp.js`, `midi.js`, `mp3.js` — audio/DSP, MIDI and MP3 utilities.
- `project-store.js` — local project persistence (per-user keys, validated read/write, merge by newest).
- `project-sync.js` — cloud save pipeline: validation before upload, error classification, and the debounced, single-flight, retrying save queue that flushes before sign-out. Loaded before `cloud.js`.
- `app.js` — current application orchestration and UI event wiring.

## Refactor contract

Do not rename global APIs, Supabase schema objects, DOM IDs, or event contracts as part of a branding-only change. Extract one feature at a time, keep the public interface stable, and add behavior-level tests before removing the old implementation. The current `app.js` is still a legacy monolith; it is intentionally identified as the next decomposition target rather than being mechanically split in a way that could break event ordering.
