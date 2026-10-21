# Auralith Studio v2.0.3 — Reliable Project Saving

Baseline: v2.0.2. Scope is limited to the cloud save path, its verification, and one packaging defect found while testing.

## Fixed
- **Pending cloud saves were lost on sign-out.** `signOut()` scheduled the upload ~0.9 s ahead, then ended the session and cleared the user; when the timer fired there was no user, so the save was skipped and reported as success. Sign-out now uploads first (up to 8 s of retries, one quick attempt if the browser is offline) and only then ends the session.
- **`js/project-store.js` never loaded in browsers.** `index.html` had an unclosed `<script>` tag on `runtime.js`, so the next tag was swallowed as text. The v2.0.2 persistence module was dead code in production and the inline fallback ran instead. Tags are fixed, and `verify:engineering` now parses real script elements and fails on any unclosed tag or non-empty external script.
- **Signing in did not pull cloud projects** until the next reload (only app start did). Sign-in now merges cloud and local projects, which also uploads any local edits that missed the cloud before sign-out.

## Added
- **Save retries** (`js/project-sync.js`). One upload at a time, debounced. Transient failures (network errors, 408/425/429/5xx, connection/resource Postgres codes, timeouts) retry with 1.5 s → 60 s backoff, up to 5 times, and retry immediately when the browser comes back online or the tab is hidden. Permanent failures (RLS, constraint, expired session) are not retried and tell the person plainly. A request that hangs is cut off after 20 s so it cannot block later saves.
- **Edits are bound to their user.** Pending work records who made the edit and which projects, so it is never uploaded under another account; edits made *during* an upload are not marked saved.
- **Project integrity checks before upload**: id present and sane, text fields are text, `sections`/`pattern`/`vocalMeta` have the right shape, `bpm`/`stepCount`/`updated` are valid numbers, size limit, duplicate ids collapsed (a repeated key fails a whole Postgres upsert). Invalid projects are skipped, reported ("N projects couldn't be uploaded…"), and stay in local storage; valid ones still upload. A bad `updated` value previously threw inside the upload.
- Uploads go in chunks of 25, and are refused unless the active session belongs to the user being saved.
- `Cloud.saveProjectsDetailed()` returns `{ ok, uploaded, rejected, retryable, auth, error }`. `Cloud.saveProjects()` still returns a boolean.

## Behaviour to know about
- If the upload cannot complete at sign-out, sign-out still proceeds and the person is told their changes stay on this device and upload at next sign-in. Only if **neither** the cloud nor local storage could save is a confirmation prompt shown.
- Service-worker cache is now `auralith-v203-shell` and pre-caches `project-sync.js`.
- No database, API, `appId`, or cloud-global changes.

## Verification
- `npm run verify:engineering`: package + engineering checks passed; **156 unit tests passed, 0 failed** (108 existing + 48 new).
- `node scripts/verify-security.mjs` and `node scripts/test-limiter.mjs` passed.
- Each new control was deliberately broken to confirm its tests fail (sign-out flush removed, validation removed, chunking removed, 5xx retry removed, mid-upload edit handling removed, v2.0.2 drop-on-sign-out restored).
- Browser e2e (Playwright, fake backend): 96 tests; all pass. One run showed a failure in `meters.e2e` ("clip latch") that passed on the next full run. **Correction (see v2.0.4):** this was not a harmless flake. It was a one-frame ordering race in the clip warning that loading the new `project-sync.js` made more likely; it is fixed in v2.0.4. `pwa.e2e` had a stale assertion from the v2.0.0 rebrand (title expected the pre-rebrand product name); this failed identically on v2.0.2 and is corrected here.
- **Not run**: `two-user-*` live staging tests (need real Supabase credentials). Run the post-deploy check from the v2.0.2 notes: sign in, edit, sign out immediately, sign in on a second browser.
