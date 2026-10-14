# Tapehead Pro v1.12.13: End-to-End Mobile Music QA

Priority 5. Real Chromium at phone sizes (360x640, 390x844, 412x915) drives the actual app against a fake Supabase backend
that enforces the same ownership rules as the SQL migrations, with a fake microphone. Run: `node --test --test-concurrency=1 e2e/*.e2e.mjs`
(needs `npm i --no-save playwright && npx playwright install chromium`). 40 tests, ~100 s, stable over repeated runs.
Real-device items that cannot be automated are in `../qa/MOBILE-QA-CHECKLIST.md`.

## Bugs found and fixed
| # | Severity | Bug | Fix |
|---|---|---|---|
| 1 | **High** | **Bounce Full Mix, Export Stems and stem downloads never worked**: `setBounceProgress`, `hideBounceProgress` and `audioBufferToWavBlob` were called but not defined anywhere (present in the uploaded 1.12.9 too). The button stuck on "Bouncing...". | Implemented all three (progress UI + 16-bit PCM WAV encoder). Verified: valid RIFF/WAVE, stereo, 16-bit, non-silent. |
| 2 | **High** | **Realtime request storm in collaboration rooms**: rendering a room wrote it to the cloud (presence heartbeat); every write fired a realtime event that re-rendered and wrote again, forever (~60 requests/s idle, ~160/s after an upload in the test). Drains battery, data and Supabase quota. | Render-time presence is local-only; cloud saves skip unchanged content; the save cache resets on remote change. Idle traffic dropped to ~0. |
| 3 | **High (privacy)** | **Leaving a room did nothing server-side**: membership stayed, so ex-members kept read access to the room's private vocals. | New `Cloud.leaveRoom()` deletes the membership row; reports failure to the user. |
| 4 | **High (privacy)** | **Replacing a vocal never deleted the old audio file**, leaving every previous recording in private storage indefinitely. | Previous files (own folder only) are deleted after the replacement is saved. |
| 5 | Medium | Failed replace lost the artist's existing vocal reference (old row deleted before the new insert). | Previous metadata is restored if the insert fails; the new file is removed. |
| 6 | **High (UX)** | **Transport Play button on the Beat screen was squeezed to a ~14 px sliver** on phones (52 px in CSS, but shrank in its flex row). | `flex:0 0 52px; min-width:52px`. Visually verified. |
| 7 | Medium | Beat hit/accent counter stuck at "0 hits" (`updateBeatPadHint` defined in another scope; the ReferenceError was swallowed). | Function published on `window`; counter updates live. |
| 8 | Medium | After a reload the Beat tab showed 120 BPM while the audio and badge used the saved tempo. | Tempo readout synced on state restore. |
| 9 | Medium | Tempo -/+ were 28 px, tap tempo/send/bounce/stems/bottom tabs 40-42 px. | 44 px minimum on touch devices (`pointer:coarse`); desktop unchanged. |
| 10 | Medium | **Signed-in artists launching offline were dropped to the sign-in wall**: the Supabase SDK (CDN) was not cached, so the app fell into "Local mode". | Service worker warms and serves the pinned SDK from cache. |
| 11 | Low | Service-worker precache used `cache.addAll()`: any single missing file silently disabled the whole offline shell. | Per-file precache. |
| 12 | Low | A file named like `my..take.wav` could be uploaded, but account deletion refused any listing containing `..` and failed closed, so the account could never be deleted (found in v1.12.12). | Upload collapses `..`; deletion rejects only genuine traversal. |

## What the suite covers
- **studio**: pad cycling, tempo, tap tempo, play/stop audio scheduling, persistence after reload, fake-mic recording and waveform, second take, Send to Mix, mute/solo/fader state, WAV bounce validity, stems ZIP.
- **collab (3 phones)**: room code, host upload to own private folder, outsider lockout, join by code and receive audio (byte-identical), live notes, no overwrite/delete/spoof by members, upload failure recovery, replace failure recovery, no orphan audio, hostile files rejected client-side, leave revokes access, **idle-traffic guard against the storm**.
- **mobile**: no horizontal overflow on every screen at 3 sizes, nav on screen and finger-sized, viewport/safe-area/manifest, 44 px controls, landscape, mic denied and no mic hardware, backgrounding, rapid taps, offline editing.
- **pwa**: service worker, precache, SDK cache, cold offline start, signed-in offline relaunch, API never cached, manifest icons (skipped here: the archive has no icon files).
- Mutation check: 12 of the above bugs were reintroduced one at a time and each made the suite fail (two initial misses were fixed by strengthening tests).

## Things to know / not verified
- **Nothing was tried on a physical phone.** Chromium emulation cannot judge sound quality, latency, iOS silent-switch behavior, Bluetooth routing, or Safari/WebKit quirks. Use the checklist.
- The fake backend mirrors the RLS migrations but is not Postgres. The staging scripts remain the proof.
- The format menu offers **MP3** but the build only encodes WAV (no encoder is bundled); selecting MP3 still produces WAV. Not changed: decide whether to add an encoder or remove the option.
- `www/.vercelignore` (new) keeps tests, scripts, SQL migrations and `SECURITY-HARDENING-*.md` out of the public deployment (they were previously served as static files). If your Vercel project root is not `www`, move it.
- Manifest/apple-touch icons (12 PNGs) are not in the archive; confirm they exist in your repo (the new CI-run test checks).
- Not covered: Safari/Firefox engines (Chromium only), real Pesapal checkout UI, push notifications, native Capacitor builds.
