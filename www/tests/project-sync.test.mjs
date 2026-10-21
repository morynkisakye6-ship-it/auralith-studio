import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../js/project-sync.js', import.meta.url), 'utf8');
const win = {};
vm.runInNewContext(source, { window: win, Map, Array, String, Number, JSON, Object, Math, Date, Promise, isFinite, isNaN, setTimeout, clearTimeout });
const Sync = win.AuralithProjectSync;

const good = (over = {}) => ({ id: 's_1', title: 'Song', lyrics: 'la', bpm: 120, stepCount: 16, kit: 'trap', sections: [{ id: 'a', text: 'x' }], pattern: { kick: [1, 0], _res: 8 }, updated: 1000, ...over });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ───────────── validation ───────────── */

test('validate: a normal project (including pattern._res and a numeric id) is accepted', () => {
  assert.equal(Sync.validateProject(good()).ok, true);
  assert.equal(Sync.validateProject(good({ id: 42 })).ok, true);
  assert.equal(Sync.validateProject({ id: 'minimal' }).ok, true);
});

test('validate: malformed projects are rejected with a reason', () => {
  const bad = [
    [null, /not an object/], [[], /not an object/], ['str', /not an object/],
    [good({ id: '' }), /missing id/], [good({ id: '   ' }), /missing id/], [good({ id: undefined }), /missing id/],
    [good({ id: 'has space' }), /whitespace/], [good({ id: 'x'.repeat(200) }), /too long/],
    [good({ title: 5 }), /title/], [good({ lyrics: {} }), /lyrics/],
    [good({ sections: 'nope' }), /sections/], [good({ sections: [1] }), /sections/],
    [good({ pattern: [] }), /pattern/], [good({ vocalMeta: 'x' }), /vocalMeta/],
    [good({ bpm: NaN }), /bpm/], [good({ bpm: 0 }), /bpm/], [good({ bpm: 5000 }), /bpm/], [good({ bpm: '120' }), /bpm/],
    [good({ stepCount: 1.5 }), /stepCount/], [good({ stepCount: 0 }), /stepCount/],
    [good({ updated: 'abc' }), /timestamp/], [good({ updated: Infinity }), /timestamp/], [good({ updated: -5 }), /timestamp/]
  ];
  for (const [p, re] of bad) {
    const r = Sync.validateProject(p);
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.match(r.errors.join('; '), re, JSON.stringify(p));
  }
});

test('validate: oversized and unserializable projects are rejected', () => {
  assert.equal(Sync.validateProject(good({ lyrics: 'x'.repeat(Sync.LIMITS.projectMaxChars + 1) })).ok, false);
  const cyc = good(); cyc.pattern.self = cyc.pattern;
  const r = Sync.validateProject(cyc);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /serializable/);
});

test('prepare: separates valid from rejected, reports ids, and never throws on junk input', () => {
  const r = Sync.prepareProjects([good({ id: 'a' }), null, good({ id: 'b', bpm: -1 }), good({ id: 'c' })]);
  assert.equal(JSON.stringify(r.valid.map(p => p.id)), '["a","c"]');
  assert.equal(r.rejected.length, 2);
  assert.equal(r.rejected.find(x => x.id === 'b').errors[0], 'bpm out of range');
  assert.equal(JSON.stringify(Sync.prepareProjects(undefined)), '{"valid":[],"rejected":[],"deduped":0}');
  assert.equal(Sync.prepareProjects('junk').valid.length, 0);
});

test('prepare: duplicate ids collapse to the newest (one upsert with a repeated key fails the whole batch)', () => {
  const r = Sync.prepareProjects([good({ id: 'd', title: 'old', updated: 1 }), good({ id: 'd', title: 'new', updated: 2 }), good({ id: 'd', title: 'older', updated: 0 })]);
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0].title, 'new');
  assert.equal(r.deduped, 2);
});

/* ───────────── error classification ───────────── */

test('classify: transient failures are retryable', () => {
  const retry = [
    new TypeError('Failed to fetch'), { message: 'NetworkError when attempting to fetch resource.' },
    { status: 503, message: 'x' }, { status: 502 }, { status: 500 }, { status: 429 }, { status: 408 },
    { code: '57014', message: 'canceling statement due to statement timeout' }, { code: '53300' }, { code: '08006' },
    { code: '40001' }, { code: '40P01' }, { code: 'PGRST002' },
    Object.assign(new Error('x'), { name: 'AbortError' })
  ];
  for (const e of retry) assert.equal(Sync.classifyError(e).retryable, true, JSON.stringify(e) + String(e));
});

test('classify: permanent failures are not retried; auth failures are flagged', () => {
  for (const e of [{ status: 400 }, { status: 404 }, { status: 409 }, { status: 422 }, { code: '23505' }, { code: '22P02' }, { code: '42501' }, { status: 403 }]) {
    assert.equal(Sync.classifyError(e).retryable, false, JSON.stringify(e));
  }
  for (const e of [{ status: 401 }, { code: 'PGRST301' }, { message: 'JWT expired' }]) {
    const c = Sync.classifyError(e);
    assert.equal(c.retryable, false); assert.equal(c.auth, true);
  }
  assert.equal(Sync.classifyError(null).retryable, false);
  assert.equal(Sync.classifyError({ message: 'something odd' }).retryable, false);
});

/* ───────────── saver ───────────── */

function harness({ upload, user = 'user-a', songs = [good()], tuning = {} } = {}) {
  const st = { user, songs };
  const statuses = [];
  const uploads = [];
  let active = 0, maxActive = 0;
  const saver = Sync.createSaver({
    getSnapshot: () => (st.user ? { userId: st.user, songs: st.songs } : null),
    upload: async (userId, s) => {
      active++; maxActive = Math.max(maxActive, active);
      uploads.push({ userId, ids: s.map(p => p.id), titles: s.map(p => p.title) });
      try { return await (upload ? upload(uploads.length, userId, s) : { ok: true, uploaded: s.length }); }
      finally { active--; }
    },
    onStatus: s => statuses.push(s),
    debounceMs: 5, retryDelays: [5, 5, 5], attemptTimeoutMs: 200, ...tuning
  });
  return { st, saver, statuses, uploads, maxActive: () => maxActive, states: () => statuses.map(s => s.state) };
}

test('saver: rapid edits are debounced into one upload of the latest data', async () => {
  const h = harness();
  h.saver.request(); h.saver.request(); h.saver.request();
  await sleep(40);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.saver.hasPending(), false);
  assert.equal(h.states().at(-1), 'saved');
});

test('REGRESSION sign-out: a save pending when the user signs out is still uploaded for that user', async () => {
  const h = harness({ songs: [good({ id: 'keep-me', title: 'unsaved edit' })] });
  h.saver.request();                       // edit -> cloud save scheduled
  h.st.user = null; h.st.songs = [];       // what signOut() does to app state
  await sleep(40);                         // the debounce fires AFTER sign-out
  assert.equal(h.uploads.length, 1, 'v2.0.2 silently dropped this save');
  assert.equal(h.uploads[0].userId, 'user-a');
  assert.deepEqual(h.uploads[0].ids, ['keep-me']);
});

test('sign-out flush: resolves only after the upload completed, before the caller ends the session', async () => {
  let finished = false;
  const h = harness({ upload: async () => { await sleep(30); finished = true; return { ok: true }; } });
  h.saver.request();
  const r = await h.saver.flush({ timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(finished, true, 'flush returned before the upload finished');
  assert.equal(h.saver.hasPending(), false);
});

test('flush with nothing pending is an immediate success', async () => {
  const h = harness();
  assert.equal((await h.saver.flush({ timeoutMs: 50 })).ok, true);
  assert.equal(h.uploads.length, 0);
});

test('retry: transient failures back off and eventually save', async () => {
  const h = harness({ upload: async n => (n < 3 ? { ok: false, retryable: true, reason: 'network problem' } : { ok: true }) });
  h.saver.request();
  await sleep(120);
  assert.equal(h.uploads.length, 3);
  assert.deepEqual(h.states().filter(s => s !== 'pending' && s !== 'saving'), ['retrying', 'retrying', 'saved']);
  assert.equal(h.saver.hasPending(), false);
});

test('retry: thrown network errors (not just returned ones) are retried', async () => {
  const h = harness({ upload: async n => { if (n === 1) throw new TypeError('Failed to fetch'); return { ok: true }; } });
  h.saver.request();
  await sleep(80);
  assert.equal(h.uploads.length, 2);
  assert.equal(h.states().at(-1), 'saved');
});

test('retry: permanent failures are not retried and are reported', async () => {
  const h = harness({ upload: async () => ({ ok: false, retryable: false, reason: 'database rejected the data (23505)' }) });
  h.saver.request();
  await sleep(60);
  assert.equal(h.uploads.length, 1);
  const last = h.statuses.at(-1);
  assert.equal(last.state, 'failed'); assert.equal(last.retryable, false);
  assert.equal(h.saver.hasPending(), true, 'work stays queued so sign-out/next edit can try again');
});

test('retry: gives up after the cap, then a new edit or retryNow() starts over', async () => {
  let fail = true;
  const h = harness({ upload: async () => (fail ? { ok: false, retryable: true } : { ok: true }) });
  h.saver.request();
  await sleep(120);
  assert.equal(h.uploads.length, 1 + 3, 'initial attempt + 3 retries');
  assert.equal(h.statuses.at(-1).state, 'failed');
  assert.equal(h.saver.hasPending(), true);
  fail = false;
  await h.saver.retryNow();                // e.g. the browser fired "online"
  assert.equal(h.statuses.at(-1).state, 'saved');
  assert.equal(h.saver.hasPending(), false);
});

test('single-flight: uploads never overlap, and edits made mid-upload are uploaded next, not marked saved', async () => {
  const h = harness({ upload: async () => { await sleep(25); return { ok: true }; } });
  h.saver.request();
  await sleep(15);                         // first upload is now in flight
  h.st.songs = [good({ id: 's_1', title: 'edited during upload' })];
  h.saver.request();
  await sleep(120);
  assert.equal(h.maxActive(), 1);
  assert.equal(h.uploads.length, 2);
  assert.deepEqual(h.uploads[1].titles, ['edited during upload']);
  assert.equal(h.saver.hasPending(), false);
});

test('flush: keeps retrying transient failures within its time budget and then succeeds', async () => {
  const h = harness({ upload: async n => (n < 3 ? { ok: false, retryable: true } : { ok: true }) });
  h.saver.request();
  const r = await h.saver.flush({ timeoutMs: 1000, retryDelays: [5, 5] });
  assert.equal(r.ok, true);
  assert.equal(h.uploads.length, 3);
});

test('flush: returns timedOut when the network stays down, and stops retrying afterwards', async () => {
  const h = harness({ upload: async () => ({ ok: false, retryable: true, reason: 'network problem' }) });
  h.saver.request();
  const r = await h.saver.flush({ timeoutMs: 60, retryDelays: [20] });
  assert.equal(r.ok, false); assert.equal(r.retryable, true);
  const at = h.uploads.length;
  await sleep(120);
  assert.ok(h.uploads.length <= at + 1, 'no further uploads after flush gave up (at most one already in flight)');
});

test('flush: a permanent failure returns immediately instead of waiting out the timeout', async () => {
  const h = harness({ upload: async () => ({ ok: false, retryable: false, auth: true, reason: 'session expired or invalid' }) });
  h.saver.request();
  const t = Date.now();
  const r = await h.saver.flush({ timeoutMs: 5000 });
  assert.equal(r.ok, false); assert.equal(r.auth, true);
  assert.ok(Date.now() - t < 1000);
  assert.equal(h.uploads.length, 1);
});

test('hung upload: a request that never answers is cut off, treated as retryable, and does not wedge the queue', async () => {
  let n = 0;
  const h = harness({ tuning: { attemptTimeoutMs: 20 }, upload: () => (++n === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true })) });
  h.saver.request();
  await sleep(150);
  assert.equal(h.uploads.length, 2, 'second attempt ran after the first timed out');
  assert.equal(h.states().at(-1), 'saved');
  // and flush itself cannot hang forever on a dead connection
  const h2 = harness({ tuning: { attemptTimeoutMs: 1000 }, upload: () => new Promise(() => {}) });
  h2.saver.request();
  const r = await h2.saver.flush({ timeoutMs: 40 });
  assert.equal(r.ok, false); assert.equal(r.timedOut, true);
});

test('user binding: queued work is never uploaded under a different user', async () => {
  const h = harness({ songs: [good({ id: 'a-song' })] });
  h.saver.request();
  const r = await h.saver.flush({ timeoutMs: 500 });
  assert.equal(r.ok, true);
  h.saver.discard();
  h.st.user = 'user-b'; h.st.songs = [good({ id: 'b-song' })];
  h.saver.request();
  await sleep(40);
  assert.deepEqual(h.uploads.map(u => [u.userId, u.ids[0]]), [['user-a', 'a-song'], ['user-b', 'b-song']]);
});

test('discard drops queued work and cancels timers', async () => {
  const h = harness();
  h.saver.request();
  h.saver.discard();
  await sleep(40);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.saver.hasPending(), false);
});

test('request while signed out queues nothing', async () => {
  const h = harness({ user: null });
  assert.equal(h.saver.request(), false);
  await sleep(30);
  assert.equal(h.uploads.length, 0);
});

test('a throwing status listener cannot break saving', async () => {
  const st = { songs: [good()] };
  const uploads = [];
  const saver = Sync.createSaver({ getSnapshot: () => ({ userId: 'u', songs: st.songs }), upload: async (u, s) => { uploads.push(u); return { ok: true }; }, onStatus() { throw new Error('ui bug'); }, debounceMs: 5 });
  saver.request();
  await sleep(40);
  assert.equal(uploads.length, 1);
  assert.equal(saver.hasPending(), false);
});

test('rejected (invalid) projects are surfaced in the saved status', async () => {
  const h = harness({ upload: async () => ({ ok: true, uploaded: 1, rejected: [{ id: 'bad', errors: ['bpm out of range'] }] }) });
  h.saver.request();
  await sleep(40);
  const last = h.statuses.at(-1);
  assert.equal(last.state, 'saved');
  assert.equal(last.rejected[0].id, 'bad');
});

test('deletions: pending deletions travel with the save, bound to the user, and use the freshest list', async () => {
  const calls = [];
  const st = { user: 'user-a', songs: [good({ id: 'a' })], deletions: ['x'] };
  const saver = Sync.createSaver({
    getSnapshot: () => (st.user ? { userId: st.user, songs: st.songs, deletions: st.deletions } : null),
    upload: async (u, songs, deletions) => { calls.push([u, songs.map(p => p.id).join(), deletions.join()]); return { ok: true }; },
    debounceMs: 5
  });
  saver.request();
  st.deletions = ['x', 'y'];                         // another delete before the timer fires
  await sleep(40);
  assert.equal(JSON.stringify(calls), '[["user-a","a","x,y"]]');
  saver.request(); st.user = null; st.songs = []; st.deletions = [];   // sign-out race again: captured values are used
  await sleep(40);
  assert.equal(JSON.stringify(calls[1]), '["user-a","a","x,y"]');
});

test('deletions: a delete with no remaining projects still gets uploaded', async () => {
  const calls = [];
  const saver = Sync.createSaver({ getSnapshot: () => ({ userId: 'u', songs: [], deletions: ['only'] }), upload: async (u, s, d) => { calls.push(d.join()); return { ok: true }; }, debounceMs: 5 });
  saver.request();
  await sleep(40);
  assert.equal(JSON.stringify(calls), '["only"]');
});

test('REGRESSION starvation: a steady stream of edits cannot postpone the cloud upload forever (max wait)', async () => {
  const h = harness({ tuning: { debounceMs: 40, maxWaitMs: 90 } });
  const t0 = Date.now();
  while (Date.now() - t0 < 400) { h.saver.request(); await sleep(10); }   // edits every 10 ms, debounce 40 ms would never fire
  assert.ok(h.uploads.length >= 3, 'uploads happened while edits were still arriving: ' + h.uploads.length);
  await sleep(120);
  assert.equal(h.saver.hasPending(), false);
});

test('max wait does not fire early: a single edit still waits the normal debounce', async () => {
  const h = harness({ tuning: { debounceMs: 60, maxWaitMs: 500 } });
  h.saver.request();
  await sleep(25);
  assert.equal(h.uploads.length, 0);
  await sleep(120);
  assert.equal(h.uploads.length, 1);
});
