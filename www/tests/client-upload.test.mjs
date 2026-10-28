import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCloudModule, fakeSupabase } from './helpers.mjs';

const A = { id: 'user-a' };
const file = (over = {}) => ({ name: 'take 1.wav', type: 'audio/wav', size: 1024, ...over });
const removes = sb => sb.calls.filter(c => c[0] === 'remove');
const uploads = sb => sb.calls.filter(c => c[0] === 'upload');
const setup = (fail = {}, authUser = A) => { const sb = fakeSupabase({ fail }); const m = loadCloudModule(sb, authUser); return { sb, ...m }; };

test('upload: happy path uploads into the caller\'s own folder, no overwrite, no cleanup', async () => {
  const { sb, Cloud } = setup();
  const url = await Cloud.uploadVocal('th-abc123', A, file());
  assert.ok(url);
  const [, path, opts] = uploads(sb)[0];
  assert.ok(path.startsWith('user-a/'), path);
  assert.equal(opts.upsert, false);
  assert.equal(removes(sb).length, 0);
  assert.ok(sb.calls.some(c => c[0] === 'db' && c[1] === 'room_vocals' && c[2] === 'insert'));
});

test('upload: a spoofed profile object (another user) is refused BEFORE any storage call', async () => {
  const { sb, Cloud, toasts } = setup();
  assert.equal(await Cloud.uploadVocal('th-abc123', { id: 'victim-b' }, file()), null);
  assert.equal(sb.calls.length, 0);
  assert.ok(toasts.length);
});

test('upload: signed-out callers are refused', async () => {
  const { sb, Cloud } = setup({}, null);
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file()), null);
  assert.equal(sb.calls.length, 0);
});

test('upload: hostile room codes, types and sizes never reach storage', async () => {
  const { sb, Cloud } = setup();
  for (const room of ['../../victim', 'a/b', '', 'x'.repeat(80), 'ab', 'room code', '<script>']) {
    assert.equal(await Cloud.uploadVocal(room, A, file()), null, 'room: ' + room);
  }
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file({ type: 'text/html' })), null);
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file({ type: 'application/x-msdownload' })), null);
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file({ size: 26 * 1024 * 1024 })), null);
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file({ size: 0 })), null);
  assert.equal(uploads(sb).length, 0);
});

test('upload: path traversal in the file name is neutralized', async () => {
  const { sb, Cloud } = setup();
  await Cloud.uploadVocal('th-abc123', A, file({ name: '../../user-b/steal.wav' }));
  const path = uploads(sb)[0][1];
  const segs = path.split('/');
  assert.ok(path.startsWith('user-a/'));
  assert.equal(segs.length, 2, 'single folder level: ' + path);
  assert.ok(!segs.some(x => x === '..' || x === '.'), path);
  assert.ok(!/\.\./.test(segs[1]), 'no ".." sequences survive (they break account deletion): ' + segs[1]);
});

test('upload failure recovery: signed-URL failure removes the new object', async () => {
  const { sb, Cloud } = setup({ sign: true });
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file()), null);
  assert.equal(removes(sb).length, 1);
  assert.equal(removes(sb)[0][1][0], uploads(sb)[0][1], 'removes exactly the object it created');
});

test('upload failure recovery: failure replacing old metadata removes the new object', async () => {
  const { sb, Cloud } = setup({ 'room_vocals.delete': true });
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file()), null);
  assert.equal(removes(sb).length, 1);
  assert.ok(!sb.calls.some(c => c[0] === 'db' && c[2] === 'insert'), 'did not insert metadata after failing to clear the old row');
});

test('upload failure recovery: metadata insert failure removes the new object', async () => {
  const { sb, Cloud } = setup({ 'room_vocals.insert': true });
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file()), null);
  assert.equal(removes(sb).length, 1);
});

test('upload failure recovery: a failing cleanup is logged for investigation, not swallowed', async () => {
  const { sb, Cloud, errors } = setup({ 'room_vocals.insert': true, remove: true });
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file()), null);
  assert.ok(errors.some(e => /orphan vocal cleanup failed/.test(String(e[0]))));
});

test('upload: a failed storage upload leaves no metadata behind', async () => {
  const { sb, Cloud } = setup({ upload: true });
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file()), null);
  assert.ok(!sb.calls.some(c => c[0] === 'db'));
  assert.equal(removes(sb).length, 0);
});

test('rooms: joins go through the rate-limited RPC, never the raw join_room', async () => {
  const { sb, Cloud } = setup();
  await Cloud.joinRoom('th-abc123', A).catch(() => {});
  const rpcs = sb.calls.filter(c => c[0] === 'rpc').map(c => c[1]);
  assert.ok(rpcs.includes('join_room_limited'));
  assert.ok(!rpcs.includes('join_room'));
});

test('rooms: saveRoom updates by code and never upserts (host/code stay immutable)', async () => {
  const { sb, Cloud } = setup();
  await Cloud.saveRoom({ code: 'TH-ABC', hostId: 'someone-else', title: 't', bpm: 90, kit: 'trap', pattern: {}, sections: [] });
  const ops = sb.calls.filter(c => c[0] === 'db').map(c => c[2]);
  assert.deepEqual(ops, ['update']);
});

// ---- replacing a vocal (privacy + data-loss regressions) ----
const prev = (over = {}) => ({ id: 'row1', room_code: 'TH-ABC123', user_id: 'user-a', username: 'A', file_path: 'user-a/TH-ABC123_1_old.wav', file_url: 'x', created_at: 't', ...over });
const setupWith = (data, fail = {}) => { const sb = fakeSupabase({ data, fail }); return { sb, ...loadCloudModule(sb, A) }; };

test('replace: the previous audio file is deleted once the new one is saved (no lingering private audio)', async () => {
  const { sb, Cloud } = setupWith({ 'room_vocals.select': [prev()] });
  assert.ok(await Cloud.uploadVocal('th-abc123', A, file()));
  const rm = removes(sb);
  assert.equal(rm.length, 1);
  assert.deepEqual(rm[0][1], ['user-a/TH-ABC123_1_old.wav']);
  const ops = sb.calls.filter(c => c[0] === 'db').map(c => c[2]);
  assert.deepEqual(ops, ['select', 'delete', 'insert'], 'old metadata is read before it is replaced');
});

test('replace: cleanup never deletes files outside the caller\'s own folder, even if a row says so', async () => {
  const { sb, Cloud } = setupWith({ 'room_vocals.select': [prev({ file_path: 'victim-b/TH-ABC123_9_theirs.wav' }), prev({ file_path: 'user-a/../victim-b/x.wav' })] });
  await Cloud.uploadVocal('th-abc123', A, file());
  assert.equal(removes(sb).length, 0, 'nothing removed: ' + JSON.stringify(removes(sb)));
});

test('replace failure recovery: if saving the new vocal fails, the old vocal is restored and kept', async () => {
  const { sb, Cloud } = setupWith({ 'room_vocals.select': [prev()] }, { 'room_vocals.insert': true });
  // first insert (new vocal) fails; the restore insert uses the same key so also fails in this fake: allow it by counting attempts
  assert.equal(await Cloud.uploadVocal('th-abc123', A, file()), null);
  const inserts = sb.calls.filter(c => c[0] === 'db' && c[2] === 'insert');
  assert.equal(inserts.length, 2, 'a restore of the previous metadata was attempted');
  const restored = inserts[1][3];
  assert.equal(restored.length, 1);
  assert.equal(restored[0].file_path, 'user-a/TH-ABC123_1_old.wav');
  assert.ok(!('id' in restored[0]) && !('created_at' in restored[0]), 'server-generated columns are not replayed');
  const rm = removes(sb);
  assert.equal(rm.length, 1);
  assert.ok(!rm[0][1].includes('user-a/TH-ABC123_1_old.wav'), 'the OLD file is not deleted when the replacement failed');
});

test('upload: file names with ".." are accepted and become safe single-segment names', async () => {
  const { sb, Cloud } = setup();
  assert.ok(await Cloud.uploadVocal('th-abc123', A, file({ name: 'my..take.wav' })));
  assert.ok(!/\.\./.test(uploads(sb)[0][1]));
});

test('rooms: redundant saves are skipped, and a remote change re-enables saving', async () => {
  const { sb, Cloud } = setup();
  const room = { code: 'TH-ABC', title: 't', bpm: 90, kit: 'trap', pattern: { kick: [1] }, sections: [] };
  await Cloud.saveRoom(room); await Cloud.saveRoom({ ...room }); await Cloud.saveRoom({ ...room });
  assert.equal(sb.calls.filter(c => c[0] === 'db' && c[2] === 'update').length, 1, 'identical content saved once');
  await Cloud.saveRoom({ ...room, bpm: 91 });
  assert.equal(sb.calls.filter(c => c[0] === 'db' && c[2] === 'update').length, 2, 'real change is saved');
});

test('rooms: leaving removes the caller\'s membership server-side (access to room audio is revoked)', async () => {
  const { sb, Cloud } = setup();
  assert.equal(await Cloud.leaveRoom('th-abc123'), true);
  assert.ok(sb.calls.some(c => c[0] === 'db' && c[1] === 'room_members' && c[2] === 'delete'));
  assert.equal(await Cloud.leaveRoom('../../x'), false, 'malformed codes never reach the database');
  const failing = setup({ 'room_members.delete': true });
  assert.equal(await failing.Cloud.leaveRoom('th-abc123'), false, 'reports failure so the UI can warn');
});
