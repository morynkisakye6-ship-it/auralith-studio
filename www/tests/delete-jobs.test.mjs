import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setEnv, makeCloud, install, call } from './helpers.mjs';
setEnv();
const del = (await import('../api/delete-account.js')).default;
const jobs = (await import('../api/jobs.js')).default;
const quiet = fn => async () => { const e = console.error, w = console.warn; console.error = console.warn = () => {}; try { await fn(); } finally { console.error = e; console.warn = w; } };
const scenario = async () => { const c = await install(makeCloud()); c.addUser('tok-u1', 'u1'); c.addUser('tok-u2', 'u2'); return c; };

// ---------- account deletion ----------
test('delete-account: unauthenticated callers cannot delete anything', async () => {
  const c = await scenario(); c.storage.set('u1/a.wav', true);
  assert.equal((await call(del, {})).statusCode, 401);
  assert.equal((await call(del, { token: 'forged' })).statusCode, 401);
  assert.deepEqual(c.authDeletes, []); assert.deepEqual(c.storageDeletes, []);
});

test('delete-account: removes only the caller\'s audio (nested folders, many pages) then the auth user', async () => {
  const c = await scenario();
  for (let i = 0; i < 1200; i++) c.storage.set(`u1/room${i % 3}/take_${String(i).padStart(4, '0')}.wav`, true);
  c.storage.set('u1/root.wav', true); c.storage.set('u2/keep.wav', true); c.storage.set('u10/keep.wav', true);
  const r = await call(del, { token: 'tok-u1' });
  assert.equal(r.statusCode, 200);
  assert.equal(c.storageDeletes.length, 1201);
  assert.ok(c.storageDeletes.every(k => k.startsWith('u1/')), 'never touches another user\'s prefix (u10 vs u1)');
  assert.ok(c.storage.has('u2/keep.wav') && c.storage.has('u10/keep.wav'));
  assert.deepEqual(c.authDeletes, ['u1']);
  const lastStorage = c.log.map((l, i) => [l, i]).filter(([l]) => l.method === 'DELETE' && l.url.includes('/storage/')).at(-1)[1];
  const authIdx = c.log.findIndex(l => l.url.includes('/auth/v1/admin/users/'));
  assert.ok(lastStorage < authIdx, 'storage cleanup finishes before the auth user is removed');
});

test('delete-account failure recovery: storage listing fails -> account is NOT deleted', quiet(async () => {
  const c = await scenario(); c.storage.set('u1/a.wav', true);
  c.fault((m, u) => u.includes('/storage/v1/object/list/'), { status: 500 });
  const r = await call(del, { token: 'tok-u1' });
  assert.equal(r.statusCode, 502);
  assert.deepEqual(c.authDeletes, []);
  assert.ok(c.storage.has('u1/a.wav'));
}));

test('delete-account failure recovery: storage delete fails -> account is NOT deleted, retry succeeds', quiet(async () => {
  const c = await scenario(); c.storage.set('u1/a.wav', true);
  c.fault((m, u) => m === 'DELETE' && u.includes('/storage/v1/object/vocals'), { times: 1, status: 500 });
  assert.equal((await call(del, { token: 'tok-u1' })).statusCode, 502);
  assert.deepEqual(c.authDeletes, []);
  assert.equal((await call(del, { token: 'tok-u1' })).statusCode, 200);
  assert.deepEqual(c.authDeletes, ['u1']);
  assert.equal(c.storage.size, 0);
}));

test('delete-account failure recovery: auth deletion fails after cleanup -> honest 502', quiet(async () => {
  const c = await scenario(); c.storage.set('u1/a.wav', true);
  c.fault((m, u) => m === 'DELETE' && u.includes('/auth/v1/admin/users/'), { times: 1, status: 500 });
  assert.equal((await call(del, { token: 'tok-u1' })).statusCode, 502);
  assert.equal((await call(del, { token: 'tok-u1' })).statusCode, 200);
}));

test('delete-account: legacy files whose names contain ".." do not block account deletion', async () => {
  const c = await scenario();
  c.storage.set('u1/ROOM_1_my..take.wav', true); c.storage.set('u1/ROOM_1_.._.._x.wav', true);
  assert.equal((await call(del, { token: 'tok-u1' })).statusCode, 200);
  assert.equal(c.storage.size, 0);
  assert.deepEqual(c.authDeletes, ['u1']);
});

test('delete-account: a malicious storage listing entry cannot escape the user prefix', quiet(async () => {
  const c = await scenario();
  const orig = c.fetch;
  globalThis.fetch = async (u, i) => String(u).includes('/object/list/') ? new Response(JSON.stringify([{ name: '../u2/secret.wav', id: 'x', metadata: {} }]), { status: 200 }) : orig(u, i);
  assert.equal((await call(del, { token: 'tok-u1' })).statusCode, 502);
  assert.deepEqual(c.storageDeletes, []); assert.deepEqual(c.authDeletes, []);
}));

// ---------- jobs ----------
test('jobs: create/status/cancel require authentication', async () => {
  await scenario();
  assert.equal((await call(jobs, { body: { kind: 'bounce' } })).statusCode, 401);
  assert.equal((await call(jobs, { method: 'GET', query: { id: 'job_1' } })).statusCode, 401);
  assert.equal((await call(jobs, { method: 'DELETE', query: { id: 'job_1' } })).statusCode, 401);
});

test('jobs: users can only read and cancel their own jobs', async () => {
  const c = await scenario();
  const made = await call(jobs, { token: 'tok-u1', body: { kind: 'bounce', payload: { x: 1 } } });
  assert.equal(made.statusCode, 201);
  const id = made.body.job.id;
  assert.equal((await call(jobs, { method: 'GET', token: 'tok-u2', query: { id } })).statusCode, 404, 'IDOR: u2 reading u1 job');
  assert.equal((await call(jobs, { method: 'GET', token: 'tok-u1', query: { id } })).statusCode, 200);
  assert.equal((await call(jobs, { method: 'DELETE', token: 'tok-u2', query: { id } })).statusCode, 404);
  assert.equal(c.jobs[0].status, 'queued', 'u2 could not cancel u1\'s job');
  assert.equal((await call(jobs, { method: 'DELETE', token: 'tok-u1', query: { id } })).statusCode, 200);
  assert.equal(c.jobs[0].status, 'canceled');
});

test('jobs: clients cannot choose priority, kind or oversize payloads; AI jobs need Pro', async () => {
  const c = await scenario();
  assert.equal((await call(jobs, { token: 'tok-u1', body: { kind: 'rm -rf' } })).statusCode, 400);
  assert.equal((await call(jobs, { token: 'tok-u1', body: { kind: 'bounce', payload: { blob: 'x'.repeat(90000) } } })).statusCode, 413);
  assert.equal((await call(jobs, { token: 'tok-u1', body: { kind: 'ai_generate', payload: {} } })).statusCode, 403);
  await call(jobs, { token: 'tok-u1', body: { kind: 'bounce', priority: 0, payload: {} } });
  assert.equal(c.jobs.at(-1).priority, 8, 'priority comes from server policy, not the client');
  assert.equal(c.jobs.at(-1).user_id, 'u1');
});

test('jobs worker endpoint fails closed without a secret and rejects wrong secrets', quiet(async () => {
  const c = await scenario();
  process.env.JOBS_PROCESS_SECRET = ''; process.env.CRON_SECRET = '';
  assert.equal((await call(jobs, { query: { op: 'process' }, headers: { authorization: 'Bearer anything' } })).statusCode, 503);
  process.env.JOBS_PROCESS_SECRET = 'correct-horse-battery';
  assert.equal((await call(jobs, { query: { op: 'process' } })).statusCode, 401);
  assert.equal((await call(jobs, { query: { op: 'process' }, headers: { authorization: 'Bearer wrong-horse-battery!' } })).statusCode, 401);
  assert.equal((await call(jobs, { query: { op: 'process' }, headers: { authorization: 'Bearer short' } })).statusCode, 401);
  assert.equal((await call(jobs, { query: { op: 'process' }, token: 'tok-u1' })).statusCode, 401, 'a user JWT is not the worker secret');
  const ok = await call(jobs, { query: { op: 'process' }, headers: { authorization: 'Bearer correct-horse-battery' } });
  assert.equal(ok.statusCode, 200);
  process.env.JOBS_PROCESS_SECRET = '';
}));

test('jobs failure recovery: store outage returns a clean 5xx, not a crash', quiet(async () => {
  const c = await scenario();
  c.fault((m, u) => u.includes('tapehead_jobs'), { status: 500 });
  const r = await call(jobs, { token: 'tok-u1', body: { kind: 'bounce', payload: {} } });
  assert.ok(r.statusCode >= 500 && r.statusCode < 600);
}));
