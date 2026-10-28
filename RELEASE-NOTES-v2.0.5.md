# Auralith Studio v2.0.5 — Two Tabs, One Account

Baseline: v2.0.4. Closes the "two tabs last-write-wins" gap that v2.0.3 and v2.0.4 listed as still open.

## Fixed
- **Two tabs on the same account overwrote each other's local saves.** Each tab kept its own in-memory project list and wrote all of it on every save, so whichever tab saved last erased the other's new projects and deletions from this device.
  - **Tabs now listen for each other** (`storage` event). New projects appear, newer edits arrive, and deletions disappear, without a reload. If the removed project was open, another opens (or a fresh one is created, so the editor is never empty).
  - **Saves fold in whatever is already stored** before writing. Storage events are asynchronous, so a tab can save before hearing about another tab's newest project; without this, that save would drop it. This was found by the new browser test failing 1 run in 8, not by inspection.
  - **A project merely missing from the other tab's list is kept**; only a recorded deletion (tombstone) removes it. Unsaved typing in the open project is never overwritten by another tab; the next save wins.
  - Deletions now record a tombstone for **every** user (previously cloud users only), so other tabs can tell "deleted" from "not seen yet". Guest tombstones are never sent to the cloud; the list is capped at 1000.
- **A failed local save is now reported.** If browser storage is full or blocked, a toast says so once (not on every autosave) and says whether the cloud copy is still being updated. Previously only a tooltip changed.

## Tests
- 185 unit tests (174 in v2.0.4). New: `adopt()` merge rules, the real `app.js` cross-tab listener and write-time fold run against stubs, tombstone-not-resurrected, one-time local-failure toast.
- New browser suite `e2e/tabs.e2e.mjs` (two real tabs, shared storage): creation both ways, simultaneous creation, deletion without write-back, typing not clobbered. Repeated 10 times clean after the write-time fold; before it, 1 failure in 8.
- Controls broken on purpose to confirm failures: listener removed (unit + browser), deletions ignored, new projects ignored, typing overwrite allowed, write-time fold removed, failure toast removed.

## Known limits
- A tab that is suspended for a long time and receives a deletion event only after the cloud delete finished (tombstone already cleared) could re-add that project from its own memory. Rare; the project would then need deleting again.
- If two tabs edit the **same** project at once, the later save wins (no field-level merge).
- Not run here: live-staging two-user tests (need real Supabase credentials). No database, API, `appId`, or cloud-global changes.

## Browser test status (read before relying on it)
Every e2e file passes when run on its own on this build: tabs 5/5 (10 repeated runs clean), projects 5/5 (12 consecutive clean runs), pwa 5/5, midi 13/13, studio 10/10, meters 8/8, timing 10/10 (twice).

Running the whole suite back to back on a loaded machine is less stable, on this build **and on untouched v2.0.2**:
- v2.0.2, full run: 97/99. The failures were a meters test that passes alone, and the known stale `pwa` title assertion (fixed in v2.0.3).
- v2.0.5, full run 1: 108/109. One `timing.e2e` failure (take placement 27-40 ms against a 12 ms limit) that passes alone.
- v2.0.5, full run 2: stopped at test 84 (environment killed it). One failure before that, in `midi.e2e`, was a 30 s sign-up form timeout in test setup; the file passes 13/13 alone.

Not explained: `projects.e2e` test 2 (cloud-rejected delete must not resurrect) failed once in about 13 runs and I did not capture its message; it passed on all 12 following runs. Treat that as an open item: if it recurs in CI, capture the assertion text first, since this test guards data safety.

Recommendation: run the browser suite per file (or with a lower load) in CI, and keep `--test-concurrency=1`.
