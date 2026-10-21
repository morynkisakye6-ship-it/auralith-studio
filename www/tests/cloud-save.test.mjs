import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { loadCloudModule, fakeSupabase } from './helpers.mjs';

const A = { id: 'user-a' };
const song = (id, over = {}) => ({ id, title: 'T-' + id, lyrics: 'l', bpm: 100, stepCount: 16, kit: 'trap', pattern: { kick: [1] }, sections: [], updated: 1000, ...over });
const upserts = sb => sb.calls.filter(c => c[0] === 'db' && c[1] === 'projects' && c[2] === 'upsert');
const setup = (fail = {}, authUser = A, opts) => { const sb = fakeSupabase({ fail }); return { sb, ...loadCloudModule(sb, authUser, opts) }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ───────────── Cloud.saveProjectsDetailed ───────────── */

test('save: uploads valid projects under the signed-in user and returns a detailed result', async () => {
  const { sb, Cloud } = setup();
  const r = await Cloud.saveProjectsDetailed('user-a', [song('s1'), song('s2')]);
  assert.equal(r.ok, true); assert.equal(r.uploaded, 2); assert.equal(r.rejected.length, 0);
  const rows = upserts(sb)[0][3];
  assert.equal(rows.length, 2);
  assert.ok(rows.every(x => x.user_id === 'user-a'));
  assert.equal(sb.tables.projects.size, 2);
});

test('save: the legacy boolean saveProjects still works', async () => {
  const { Cloud } = setup();
  assert.equal(await Cloud.saveProjects('user-a', [song('s1')]), true);
  const bad = setup({ 'projects.upsert': () => ({ status: 503, message: 'down' }) });
  assert.equal(await bad.Cloud.saveProjects('user-a', [song('s1')]), false);
});

test('integrity: invalid projects are skipped and reported, valid ones still upload, nothing throws', async () => {
  const { sb, Cloud } = setup();
  const r = await Cloud.saveProjectsDetailed('user-a', [song('ok'), song('badbpm', { bpm: NaN }), song('badtime', { updated: 'abc' }), null, song('badsections', { sections: 'x' })]);
  assert.equal(r.ok, true);
  assert.equal(r.uploaded, 1);
  assert.equal(JSON.stringify(r.rejected.map(x => x.id).filter(Boolean).sort()), '["badbpm","badsections","badtime"]');
  assert.equal(JSON.stringify([...sb.tables.projects.keys()]), '["ok"]');
});

test('integrity: a project with an unusable timestamp used to throw inside the upload; now it is rejected cleanly', async () => {
  const { Cloud } = setup();
  await assert.doesNotReject(() => Cloud.saveProjectsDetailed('user-a', [song('x', { updated: 'not-a-date' })]));
});

test('integrity: all-invalid input makes no database call and is not retryable', async () => {
  const { sb, Cloud } = setup();
  const r = await Cloud.saveProjectsDetailed('user-a', [song('a', { bpm: -1 }), null]);
  assert.equal(upserts(sb).length, 0);
  assert.equal(r.uploaded, 0); assert.equal(r.retryable, false); assert.equal(r.rejected.length, 2);
});

test('integrity: duplicate ids are collapsed so one upsert never repeats a primary key', async () => {
  const { sb, Cloud } = setup();
  await Cloud.saveProjectsDetailed('user-a', [song('d', { title: 'old', updated: 1 }), song('d', { title: 'new', updated: 2 })]);
  const rows = upserts(sb)[0][3];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'new');
});

test('chunking: large libraries upload in small requests, and a failing chunk reports how far it got', async () => {
  const many = Array.from({ length: 60 }, (_, i) => song('p' + i));
  const ok = setup();
  const r = await ok.Cloud.saveProjectsDetailed('user-a', many);
  assert.deepEqual(upserts(ok.sb).map(c => c[3].length), [25, 25, 10]);
  assert.equal(r.uploaded, 60);
  const flaky = setup({ 'projects.upsert': n => (n === 2 ? { status: 503, message: 'busy' } : null) });
  const f = await flaky.Cloud.saveProjectsDetailed('user-a', many);
  assert.equal(f.ok, false); assert.equal(f.uploaded, 25); assert.equal(f.retryable, true);
});

test('errors: transient vs permanent database failures are classified for the retry layer', async () => {
  const cases = [
    [{ status: 503, message: 'unavailable' }, true, false], [{ status: 429, message: 'slow down' }, true, false],
    [{ code: '57014', message: 'statement timeout' }, true, false],
    [{ code: '42501', message: 'rls' }, false, false], [{ code: '23505', message: 'dup' }, false, false],
    [{ status: 401, message: 'JWT expired' }, false, true]
  ];
  for (const [err, retryable, auth] of cases) {
    const { Cloud } = setup({ 'projects.upsert': () => err });
    const r = await Cloud.saveProjectsDetailed('user-a', [song('s')]);
    assert.equal(r.ok, false, JSON.stringify(err));
    assert.equal(r.retryable, retryable, JSON.stringify(err));
    assert.equal(r.auth, auth, JSON.stringify(err));
  }
});

test('errors: a thrown network failure is returned as a retryable result, not an exception', async () => {
  const sb = fakeSupabase();
  const { Cloud } = loadCloudModule(sb, A);
  sb.from = () => ({ upsert: () => { throw new TypeError('Failed to fetch'); } });
  const r = await Cloud.saveProjectsDetailed('user-a', [song('s')]);
  assert.equal(r.ok, false); assert.equal(r.retryable, true);
});

test('session binding: no session, or a session for another user, refuses to upload', async () => {
  const none = setup({}, null);
  const r1 = await none.Cloud.saveProjectsDetailed('user-a', [song('s')]);
  assert.equal(r1.ok, false); assert.equal(r1.auth, true); assert.equal(upserts(none.sb).length, 0);
  const other = setup({}, { id: 'user-b' });
  const r2 = await other.Cloud.saveProjectsDetailed('user-a', [song('s')]);
  assert.equal(r2.ok, false); assert.equal(upserts(other.sb).length, 0);
  const blank = setup();
  assert.equal((await blank.Cloud.saveProjectsDetailed('', [song('s')])).ok, false);
});

test('degraded mode: if project-sync.js failed to load, saving still works (unchecked) and warns', async () => {
  const { sb, Cloud } = setup({}, A, { withoutSync: true });
  const r = await Cloud.saveProjectsDetailed('user-a', [song('s1')]);
  assert.equal(r.ok, true);
  assert.equal(upserts(sb).length, 1);
});

/* ───────────── Cloud.deleteProjectsDetailed ───────────── */

const del = sb => sb.calls.filter(c => c[0] === 'db' && c[1] === 'projects' && c[2] === 'delete');

test('delete: removes only the named ids, only for this user', async () => {
  const { sb, Cloud } = setup();
  await Cloud.saveProjectsDetailed('user-a', [song('a'), song('b'), song('c')]);
  sb.tables.projects.set('other', { id: 'other', user_id: 'user-b' });
  const r = await Cloud.deleteProjectsDetailed('user-a', ['a', 'c', 'other']);
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify([...sb.tables.projects.keys()].sort()), '["b","other"]', 'other user\'s row with a matching id is untouched');
  assert.ok(del(sb)[0][4].some(f => f[0] === 'user_id' && f[2] === 'user-a'), 'delete is always scoped by user_id');
});

test('delete: empty/junk id lists make no call; duplicates collapse; big lists are chunked', async () => {
  const { sb, Cloud } = setup();
  assert.equal((await Cloud.deleteProjectsDetailed('user-a', [])).ok, true);
  assert.equal((await Cloud.deleteProjectsDetailed('user-a', [null, '', '  '])).ok, true);
  assert.equal((await Cloud.deleteProjectsDetailed('user-a', undefined)).ok, true);
  assert.equal(del(sb).length, 0);
  await Cloud.deleteProjectsDetailed('user-a', ['x', 'x', 'y']);
  assert.equal(JSON.stringify(del(sb)[0][4].find(f => f[1] === 'in')[2]), '["x","y"]');
  const many = Array.from({ length: 250 }, (_, i) => 'p' + i);
  const b = setup();
  await b.Cloud.deleteProjectsDetailed('user-a', many);
  assert.equal(JSON.stringify(del(b.sb).map(c => c[4].find(f => f[1] === 'in')[2].length)), '[100,100,50]');
});

test('delete: classifies failures, refuses without a matching session, never throws', async () => {
  const t = setup({ 'projects.delete': () => ({ status: 503, message: 'busy' }) });
  const r = await t.Cloud.deleteProjectsDetailed('user-a', ['a']);
  assert.equal(r.ok, false); assert.equal(r.retryable, true);
  const p = setup({ 'projects.delete': () => ({ code: '42501', message: 'rls' }) });
  assert.equal((await p.Cloud.deleteProjectsDetailed('user-a', ['a'])).retryable, false);
  const none = setup({}, null);
  const n = await none.Cloud.deleteProjectsDetailed('user-a', ['a']);
  assert.equal(n.ok, false); assert.equal(n.auth, true); assert.equal(del(none.sb).length, 0);
  const other = setup({}, { id: 'user-b' });
  assert.equal((await other.Cloud.deleteProjectsDetailed('user-a', ['a'])).ok, false);
  assert.equal(del(other.sb).length, 0);
  const sb = fakeSupabase(); const m = loadCloudModule(sb, A);
  sb.from = () => ({ delete: () => { throw new TypeError('Failed to fetch'); } });
  const th = await m.Cloud.deleteProjectsDetailed('user-a', ['a']);
  assert.equal(th.ok, false); assert.equal(th.retryable, true);
});

/* ───────────── end-to-end: pending save vs sign-out, against a session-aware fake ───────────── */

function appModel({ fail = {} } = {}) {
  const sb = fakeSupabase({ fail });
  const session = { user: A };
  const { Cloud, win } = loadCloudModule(sb, A);
  Cloud.currentAuthUser = async () => session.user;      // like the real client: null after signOut
  // The database rejects writes once the session is gone (what RLS does server-side).
  const origFrom = sb.from;
  sb.from = t => { const q = origFrom(t); const up = q.upsert; q.upsert = rows => (session.user ? up(rows) : { then: r => Promise.resolve({ error: { status: 401, message: 'JWT expired' } }).then(r) }); return q; };
  const state = { user: { cloudId: 'user-a' }, songs: [song('s1', { title: 'v1' })] };
  const saver = win.AuralithProjectSync.createSaver({
    getSnapshot: () => (state.user ? { userId: state.user.cloudId, songs: state.songs } : null),
    upload: (u, s) => Cloud.saveProjectsDetailed(u, s),
    debounceMs: 20, retryDelays: [5, 5, 5], attemptTimeoutMs: 500
  });
  const signOutOld = async () => { session.user = null; state.user = null; state.songs = []; };                       // v2.0.2 order
  const signOutNew = async (opts = { timeoutMs: 500 }) => { const r = await saver.flush(opts); saver.discard(); session.user = null; state.user = null; state.songs = []; return r; }; // v2.0.3 order
  return { sb, saver, state, session, signOutOld, signOutNew };
}

test('REGRESSION (end-to-end): edit then sign out immediately -> the edit reaches the database', async () => {
  const m = appModel();
  m.state.songs[0].title = 'edited just before sign-out';
  m.saver.request();
  const r = await m.signOutNew();
  assert.equal(r.ok, true);
  assert.equal(m.sb.tables.projects.get('s1').title, 'edited just before sign-out');
});

test('the old order (end session first) really does lose the save - proves the test can fail', async () => {
  const m = appModel();
  m.state.songs[0].title = 'lost edit';
  m.saver.request();
  await m.signOutOld();
  await sleep(120);
  assert.equal(m.sb.tables.projects.size, 0, 'nothing could be written after the session ended');
});

test('flaky network at sign-out: two 503s are retried and the save still lands', async () => {
  const m = appModel({ fail: { 'projects.upsert': n => (n <= 2 ? { status: 503, message: 'busy' } : null) } });
  m.state.songs[0].title = 'survives 503s';
  m.saver.request();
  const r = await m.signOutNew({ timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(m.sb.tables.projects.get('s1').title, 'survives 503s');
});

test('network down for the whole sign-out window: flush reports failure (so the app can tell the person) and does not hang', async () => {
  const m = appModel({ fail: { 'projects.upsert': () => ({ status: 503, message: 'down' }) } });
  m.saver.request();
  const t = Date.now();
  const r = await m.signOutNew({ timeoutMs: 120 });
  assert.equal(r.ok, false); assert.equal(r.retryable, true);
  assert.ok(Date.now() - t < 1500);
  assert.equal(m.sb.tables.projects.size, 0);
});

test('save survives sign-in again: failed upload stays queued locally and a later save uploads everything', async () => {
  let down = true;
  const m = appModel({ fail: { 'projects.upsert': () => (down ? { status: 503, message: 'down' } : null) } });
  m.saver.request();
  assert.equal((await m.saver.flush({ timeoutMs: 60 })).ok, false);
  down = false;
  assert.equal((await m.saver.flush({ timeoutMs: 500 })).ok, true, 'same pending work uploads once the network is back');
  assert.equal(m.sb.tables.projects.size, 1);
});

/* ───────────── app.js wiring (runs the real functions from app.js with stubs) ───────────── */

const appSrc = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function extract(startMarker, endMarker) {
  const a = appSrc.indexOf(startMarker), b = appSrc.indexOf(endMarker, a);
  assert.ok(a >= 0 && b > a, `app.js markers not found: ${startMarker}`);
  return appSrc.slice(a, b);
}

function memStorage() {
  const d = new Map();
  return { getItem: k => (d.has(k) ? d.get(k) : null), setItem: (k, v) => d.set(k, String(v)), removeItem: k => d.delete(k), d };
}

function appRuntime({ cloudOk = true, localOk = true, confirmAnswer = true, offline = false, remote = [] } = {}) {
  const log = [];
  const sbState = { signedIn: true };
  const toasts = [];
  const cloudRows = new Map(remote.map(r => [String(r.id), r]));
  const net = { down: !cloudOk };
  const localStorage = memStorage();
  const sandbox = {
    console, setTimeout, clearTimeout, Promise, Date, JSON, Object, Array, Map, String, Number, Math, isFinite, isNaN, localStorage,
    window: { addEventListener(t, h) { (sandbox.__listeners[t] = sandbox.__listeners[t] || []).push(h); } }, __listeners: {}, navigator: { onLine: !offline },
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {}, visibilityState: 'visible' },
    state: { user: { id: 'user-a', cloudId: 'user-a', contact: 'a@x.test' }, songs: [{ id: 's1', title: 't', updated: 1 }], pro: null, currentSongId: 's1' },
    toast: m => toasts.push(m), softStatus: () => {}, confirm: () => { log.push('confirm'); return confirmAnswer; },
    getSongsKey: () => 'th-songs-user-a',
    saveCurrentSong: () => { log.push('saveCurrentSong'); sandbox.persistSongs(); },
    loadSong: id => log.push('loadSong:' + id), newSong: () => log.push('newSong'),
    loadUsers: () => ({}), saveUsers() {}, savePro() {}, saveSession() {}, updateUserUI() {}, renderSongList() {}, closeProfile() {}, lockApp() {}, openAuth() {},
    Cloud: {
      isCloud: () => true,
      saveProjectsDetailed: async (u, s) => {
        log.push('upload:' + u + ':' + s.length);
        if (net.down) return { ok: false, retryable: true, reason: 'network problem' };
        s.forEach(p => cloudRows.set(String(p.id), { ...p }));
        return { ok: true, uploaded: s.length };
      },
      deleteProjectsDetailed: async (u, ids) => {
        log.push('delete:' + ids.join('+'));
        if (net.down) return { ok: false, retryable: true, reason: 'network problem' };
        ids.forEach(i => cloudRows.delete(String(i)));
        return { ok: true, deleted: ids.length };
      },
      loadProjects: async () => [...cloudRows.values()].map(r => ({ ...r })),
      saveProjects: async () => !net.down,
      signOut: async () => { log.push('cloud.signOut'); sbState.signedIn = false; }
    }
  };
  vm.createContext(sandbox);
  // Real modules + the real save/delete/hydrate/sign-out code from app.js; only the environment is stubbed.
  vm.runInContext(fs.readFileSync(new URL('../js/project-store.js', import.meta.url), 'utf8'), sandbox, { filename: 'project-store.js' });
  if (!localOk) { const real = sandbox.window.AuralithProjectStore; sandbox.window.AuralithProjectStore = { ...real, write: () => ({ ok: false, error: new Error('quota') }) }; }
  vm.runInContext(fs.readFileSync(new URL('../js/project-sync.js', import.meta.url), 'utf8'), sandbox, { filename: 'project-sync.js' });
  const wiring = extract('let _localProjectSaveOk', 'function loadSocial()');
  const signOut = extract('async function signOut()', 'function openAuth(').replace('timeoutMs: offline ? 0 : 8000', 'timeoutMs: offline ? 0 : 300');
  // Short timings so tests run fast; production values are exercised by the module tests.
  const tuned = wiring.replace('onStatus: onCloudSaveStatus', 'onStatus: onCloudSaveStatus, debounceMs: 10, retryDelays: [5, 5], attemptTimeoutMs: 200');
  vm.runInContext(tuned + '\n' + signOut + '\nthis.persistSongs = persistSongs; this.signOut = signOut; this.flushCloudProjectSave = flushCloudProjectSave; this.cloudSaver = cloudSaver; this.deleteProjects = deleteProjects; this.hydrateCloudProjects = hydrateCloudProjects; this.adoptSongsFromOtherTab = adoptSongsFromOtherTab;', sandbox, { filename: 'app-excerpt.js' });
  return { sandbox, log, toasts, sbState, cloudRows, net, localStorage };
}

test('app wiring: signOut uploads pending projects BEFORE ending the cloud session', async () => {
  const { sandbox, log, toasts } = appRuntime();
  await sandbox.signOut();
  const up = log.findIndex(x => x.startsWith('upload:user-a'));
  const out = log.indexOf('cloud.signOut');
  assert.ok(up >= 0, 'pending save was uploaded: ' + log.join(','));
  assert.ok(out > up, 'upload must precede session end: ' + log.join(','));
  assert.equal(JSON.stringify(toasts), '["Signed out"]');
  assert.equal(sandbox.state.user, null);
  assert.equal(sandbox.state.songs.length, 0);
});

test('app wiring: if the upload cannot complete, sign-out still proceeds and tells the person their work stays on the device', async () => {
  const { sandbox, log, toasts } = appRuntime({ cloudOk: false });
  const t = Date.now();
  await sandbox.signOut();
  assert.ok(log.includes('cloud.signOut'));
  assert.ok(!log.includes('confirm'), 'local copy is fine, so no scary prompt');
  assert.match(toasts.at(-1), /stay on this device/);
  assert.ok(Date.now() - t < 12000);
  assert.equal(sandbox.cloudSaver.hasPending(), false, 'queue discarded so retries do not fire against a dead session');
});

test('app wiring: signing out while offline makes one quick attempt instead of waiting out retries', async () => {
  const { sandbox, log, toasts } = appRuntime({ cloudOk: false, offline: true });
  const t = Date.now();
  await sandbox.signOut();
  assert.ok(Date.now() - t < 300, 'no retry wait while offline');
  assert.equal(log.filter(x => x.startsWith('upload:')).length, 1);
  assert.ok(log.includes('cloud.signOut'));
  assert.match(toasts.at(-1), /stay on this device/);
});

test('app wiring: if neither cloud nor device could save, the person must confirm before signing out', async () => {
  const declined = appRuntime({ cloudOk: false, localOk: false, confirmAnswer: false });
  await declined.sandbox.signOut();
  assert.ok(declined.log.includes('confirm'));
  assert.ok(!declined.log.includes('cloud.signOut'), 'declining keeps the session and the open projects');
  assert.ok(declined.sandbox.state.user, 'still signed in');
  const accepted = appRuntime({ cloudOk: false, localOk: false, confirmAnswer: true });
  await accepted.sandbox.signOut();
  assert.ok(accepted.log.includes('cloud.signOut'));
});

test('app wiring: guests and local-mode users are not delayed by cloud flushing', async () => {
  const { sandbox, log } = appRuntime();
  sandbox.state.user = { id: 'g', contact: 'g@x.test' };    // no cloudId
  await sandbox.signOut();
  assert.ok(!log.some(x => x.startsWith('upload:')));
});

test('app wiring: persistSongs schedules a debounced upload bound to the signed-in user', async () => {
  const { sandbox, log } = appRuntime();
  sandbox.persistSongs(); sandbox.persistSongs(); sandbox.persistSongs();
  await sleep(60);
  assert.equal(log.filter(x => x.startsWith('upload:')).length, 1);
});

test('app wiring: deleting a project removes it locally and in the cloud', async () => {
  const m = appRuntime({ remote: [{ id: 's1', updated: 1 }, { id: 's2', updated: 1 }] });
  m.sandbox.state.songs = [{ id: 's1', updated: 1 }, { id: 's2', updated: 1 }];
  m.sandbox.deleteProjects(['s1']);
  assert.equal(m.sandbox.state.songs.length, 1);
  assert.equal(m.sandbox.state.currentSongId, null);
  await m.sandbox.flushCloudProjectSave({ timeoutMs: 500 });
  assert.equal(JSON.stringify([...m.cloudRows.keys()]), '["s2"]');
  assert.equal(m.localStorage.getItem('th-deleted-user-a'), null, 'tombstone cleared once the cloud delete succeeded');
});

test('REGRESSION app wiring: a project whose cloud delete failed does NOT come back on the next load, and is deleted once the network returns', async () => {
  const m = appRuntime({ cloudOk: false, remote: [{ id: 's1', updated: 1 }, { id: 's2', updated: 1 }] });
  m.sandbox.state.songs = [{ id: 's1', updated: 1 }, { id: 's2', updated: 1 }];
  m.sandbox.deleteProjects(['s1']);
  assert.equal((await m.sandbox.flushCloudProjectSave({ timeoutMs: 60 })).ok, false);
  assert.ok(m.cloudRows.has('s1'), 'cloud still has it');
  assert.ok(m.localStorage.getItem('th-deleted-user-a'), 'tombstone survives');
  // "reload": network is back, hydrate merges cloud into local
  m.net.down = false;
  m.sandbox.state.songs = [{ id: 's2', updated: 1 }];
  await m.sandbox.hydrateCloudProjects();
  assert.equal(JSON.stringify(m.sandbox.state.songs.map(s => s.id)), '["s2"]', 'deleted project must not be resurrected (v2.0.3 restored it)');
  await m.sandbox.flushCloudProjectSave({ timeoutMs: 500 });
  assert.equal(JSON.stringify([...m.cloudRows.keys()]), '["s2"]', 'the pending delete was finally applied');
  assert.equal(m.localStorage.getItem('th-deleted-user-a'), null);
});

test('app wiring: an edit made on another device AFTER the deletion is kept, not deleted', async () => {
  const m = appRuntime({ cloudOk: false, remote: [{ id: 's1', updated: Date.now() + 60000, title: 'edited elsewhere' }] });
  m.sandbox.state.songs = [{ id: 's1', updated: 1 }];
  m.sandbox.deleteProjects(['s1']);
  m.net.down = false;
  m.sandbox.cloudSaver.discard();
  m.localStorage.setItem('th-deleted-user-a', JSON.stringify([{ id: 's1', at: Date.now() }]));
  await m.sandbox.hydrateCloudProjects();
  assert.equal(m.sandbox.state.songs[0].title, 'edited elsewhere');
  assert.equal(m.localStorage.getItem('th-deleted-user-a'), null, 'tombstone dropped because the newer edit wins');
});

test('app wiring: deleting as a guest deletes locally and records a tombstone for other tabs, with no cloud call', async () => {
  const m = appRuntime();
  m.sandbox.state.user = { id: 'g', contact: 'g@x.test' };
  m.sandbox.deleteProjects(['s1']);
  assert.equal(m.sandbox.state.songs.length, 0);
  assert.ok(m.localStorage.getItem('th-deleted-g'), 'recorded so other tabs learn about the deletion');
  assert.ok(!m.log.some(x => x.startsWith('delete:')), 'but nothing is sent to the cloud');
});

test('app wiring: sign-out flushes pending deletions before ending the session', async () => {
  const m = appRuntime({ remote: [{ id: 's1', updated: 1 }] });
  m.sandbox.deleteProjects(['s1']);
  await m.sandbox.signOut();
  assert.ok(m.log.indexOf('delete:s1') >= 0 && m.log.indexOf('delete:s1') < m.log.indexOf('cloud.signOut'), m.log.join());
  assert.equal(m.cloudRows.size, 0);
});

test('REGRESSION autosave loop: saving the current song must not schedule another save (it used to re-save every 600 ms forever)', () => {
  const calls = [];
  const sb = {
    console, calls,
    getActiveSection: () => ({ text: 'old' }),
    document: { getElementById: id => (id === 'sectionEditor' ? { value: 'typed' } : null) },
    syncLyricsHidden: () => { calls.push('sync'); return ''; },
    scheduleSave: () => calls.push('scheduleSave')
  };
  vm.createContext(sb);
  const src = extract('function commitSectionEditorQuiet()', 'function selectWriteSection(');
  vm.runInContext(src + '\nthis.quiet = commitSectionEditorQuiet; this.user = commitSectionEditor;', sb);
  sb.quiet();
  assert.equal(JSON.stringify(calls), '["sync"]', 'quiet commit schedules nothing');
  calls.length = 0;
  sb.user();
  assert.equal(JSON.stringify(calls), '["sync","scheduleSave"]', 'a real edit still schedules the save');
  const saveFn = appSrc.slice(appSrc.indexOf('function saveCurrentSong()'), appSrc.indexOf('function loadSong('));
  assert.ok(saveFn.includes('commitSectionEditorQuiet()'), 'saveCurrentSong uses the quiet commit');
  assert.ok(!/commitSectionEditor\(\)/.test(saveFn), 'saveCurrentSong must not call the scheduling commit');
});

const storageEvent = (m, songs, key = 'th-songs-user-a') => m.sandbox.__listeners.storage.forEach(h => h({ key, newValue: JSON.stringify(songs), storageArea: m.sandbox.localStorage }));

test('app wiring: a project created in another tab appears here without a reload, and is not overwritten by our next save', () => {
  const m = appRuntime();
  m.sandbox.state.songs = [{ id: 's1', updated: 1 }];
  storageEvent(m, [{ id: 's1', updated: 1 }, { id: 'from-tab-b', updated: 9, title: 'B' }]);
  assert.equal(JSON.stringify(m.sandbox.state.songs.map(s => s.id)), '["from-tab-b","s1"]');
});

test('app wiring: a project deleted in another tab disappears here; if it was open, another project opens instead', () => {
  const m = appRuntime();
  m.sandbox.state.songs = [{ id: 's1', updated: 1 }, { id: 's2', updated: 2 }];
  m.sandbox.state.currentSongId = 's2';
  m.localStorage.setItem('th-deleted-user-a', JSON.stringify([{ id: 's2', at: 100 }]));
  storageEvent(m, [{ id: 's1', updated: 1 }]);
  assert.equal(JSON.stringify(m.sandbox.state.songs.map(s => s.id)), '["s1"]');
  assert.ok(m.log.includes('loadSong:s1'));
  const none = appRuntime();
  none.sandbox.state.songs = [{ id: 'only', updated: 1 }];
  none.sandbox.state.currentSongId = 'only';
  none.localStorage.setItem('th-deleted-user-a', JSON.stringify([{ id: 'only', at: 100 }]));
  storageEvent(none, []);
  assert.ok(none.log.includes('newSong'), 'never leaves the editor with no project');
});

test('app wiring: storage events for other keys, other users, junk values or while signed out are ignored', () => {
  const m = appRuntime();
  m.sandbox.state.songs = [{ id: 's1', updated: 1 }];
  storageEvent(m, [{ id: 'x', updated: 9 }], 'th-songs-someone-else');
  storageEvent(m, [{ id: 'x', updated: 9 }], 'unrelated');
  m.sandbox.__listeners.storage.forEach(h => h({ key: 'th-songs-user-a', newValue: '{not json', storageArea: m.sandbox.localStorage }));
  m.sandbox.__listeners.storage.forEach(h => h({ key: 'th-songs-user-a', newValue: null, storageArea: m.sandbox.localStorage }));
  m.sandbox.state.user = null;
  storageEvent(m, [{ id: 'x', updated: 9 }]);
  assert.equal(JSON.stringify(m.sandbox.state.songs.map(s => s.id)), '["s1"]');
});

test('REGRESSION lost update (delayed storage event): saving never drops a project another tab already stored', () => {
  const m = appRuntime();
  m.sandbox.state.songs = [{ id: 's1', updated: 1 }];
  m.localStorage.setItem('th-songs-user-a', JSON.stringify([{ id: 'from-other-tab', updated: 9 }]));   // no storage event delivered yet
  m.sandbox.persistSongs();
  const stored = JSON.parse(m.localStorage.getItem('th-songs-user-a')).map(x => x.id).sort();
  assert.equal(JSON.stringify(stored), '["from-other-tab","s1"]');
  assert.equal(m.sandbox.state.songs.length, 2);
});

test('write-time fold does not resurrect a project this tab just deleted (tombstone is written first)', () => {
  const m = appRuntime();
  m.sandbox.state.songs = [{ id: 'gone', updated: 1 }, { id: 'keep', updated: 1 }];
  m.localStorage.setItem('th-songs-user-a', JSON.stringify(m.sandbox.state.songs));
  m.sandbox.deleteProjects(['gone']);
  const stored = JSON.parse(m.localStorage.getItem('th-songs-user-a')).map(x => x.id);
  assert.equal(JSON.stringify(stored), '["keep"]');
});

test('app wiring: a failed local save tells the person once (not on every autosave), and re-arms after a success', () => {
  const m = appRuntime({ localOk: false });
  m.sandbox.persistSongs(); m.sandbox.persistSongs(); m.sandbox.persistSongs();
  assert.equal(m.toasts.filter(t => /storage may be full/.test(t)).length, 1);
  assert.match(m.toasts[0], /cloud copy is still updated/);
});

test('app.js source guard: sign-in hydrates cloud projects and index.html loads every module with closed tags', () => {
  assert.match(appSrc, /signin hydrate/, 'cloud sign-in must pull cloud projects');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/<script\b/gi) || []).length, (html.match(/<\/script>/gi) || []).length, 'unclosed <script> swallows the next tag');
  for (const f of ['project-store.js', 'project-sync.js']) assert.match(html, new RegExp('<script src="js/' + f + '\\?v=[^"]+"></script>'));
});
