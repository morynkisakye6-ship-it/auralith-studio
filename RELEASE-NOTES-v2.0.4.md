# Auralith Studio v2.0.4 — Cloud Saves That Actually Fire, and Deletes That Stick

Baseline: v2.0.3. Two data-integrity bugs that predate this series were found by running the real app in a browser. Both are fixed and covered by browser tests.

## Fixed
- **Background cloud saves were starved by an autosave loop (present since before v2.0.2).** `saveCurrentSong()` called `commitSectionEditor()`, which always scheduled another save, so after any edit the app re-saved itself every 600 ms forever. The cloud upload waits 900 ms of quiet, and never got it. Reproduced on the untouched v2.0.2 package: zero cloud rows 4 s after an edit. v2.0.3's sign-out flush and tab-hidden trigger hid most of it, but background sync during editing still didn't run.
  - Fix at the source: `saveCurrentSong()` now uses a new `commitSectionEditorQuiet()`; real user edits still schedule saves.
  - Defence in depth: the saver now has a max wait (5 s), so no future save loop or steady stream of edits can postpone the upload indefinitely.
  - Side benefit: no more local write + list re-render every 600 ms (battery and storage wear).
- **Deleted projects came back.** Delete only removed the local copy; nothing ever deleted the cloud row, so the next load or sign-in merged it back. Deletes now go to the cloud through the same retrying, sign-out-safe queue.
  - A per-user "tombstone" (`th-deleted-<userId>`) records the deletion until the cloud confirms it, so a failed or offline delete is retried and the project does not reappear in the meantime.
  - If the same project was edited on another device *after* you deleted it, the newer edit wins and the project is kept (no silent loss of newer work).
  - Covers library delete, "Delete all projects", sign-out (pending deletes are flushed first), and the 1000-entry cap on tombstones.
  - `Cloud.deleteProjectsDetailed()` only ever deletes rows for the signed-in user, requires a matching session, chunks 100 ids, and classifies errors like saves do.

- **Clip warning could lag the meters by one frame** (found because the full browser suite failed `meters.e2e` "clip latch" and, as a knock-on, "idle efficiency", on this build but not on v2.0.2). The master block decided "Peak clip risk" from channel `.clip` classes that were only painted later in the same frame, so the warning trailed by a frame and a test that checked the instant the class appeared failed. The v2.0.2 timing hid it; adding one more script shifted frame timing and exposed it. The warning is now re-checked after the channel meters paint. Bisected by swapping files: baseline `index.html` passed, removing only the `project-sync.js` tag passed, then the real cause was traced to the frame order.

## Tests
- **174 unit tests** (156 in v2.0.3). New: tombstone store, cloud delete, saver deletions and starvation, the real `deleteProjects`/hydrate/sign-out code from `app.js` run against a stateful cloud stub, and a guard that `saveCurrentSong` cannot re-schedule itself.
- **New browser suite `e2e/projects.e2e.mjs`** (real UI, fake backend): library delete reaches the cloud and survives reload; a cloud-rejected delete does not resurrect on reload and lands after recovery; typing then signing out in the same tick still uploads the edit; one edit causes a bounded number of local saves and uploads by itself.
- Controls were deliberately broken to confirm the tests fail: hydrate ignoring tombstones, no tombstone recorded, tombstone never cleared, delete failure ignored, later-edit rule removed, delete not scoped to the user, autosave loop reintroduced (unit and browser), max-wait removed. One browser test initially failed to catch the loop because it counted the wrong thing; it now counts actual local writes (14 with the loop vs a few without).

## Not changed / still open
- No database, API, `appId`, or cloud-global changes. The `projects` delete RLS policy already existed; staging should confirm it works for real accounts (`two-user-rls-test.mjs` was not run here).
- Two tabs open on the same account still last-write-wins on local storage.
- Cloud deletion of projects is by id for the signed-in user only; there is no server-side soft-delete or undo.
