// Collaboration: host creates a room and shares a vocal, a collaborator joins by code, an outsider is locked out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startWorld } from './harness.mjs';
import { signUp, goNav, makeWav } from './flows.mjs';

let world, A, B, C, code, nameA, nameB, nameC, take;
const S = () => world.backend.state, T = () => world.backend.tables;
const uid = name => S().users.get(`${name}@example.test`).id;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const sbPost = async (path, token, body) => (await fetch(`${world.origin}/__sb/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok_' + token }, body: JSON.stringify(body) })).json();
const vocalFor = name => T().room_vocals.filter(v => v.user_id === uid(name));
const hasText = (pg, re) => pg.waitForFunction(src => new RegExp(src, 'i').test(document.body.innerText), re.source, { timeout: 8000 });

before(async () => {
  world = await startWorld();
  A = await world.device('iphone-14 390x844'); B = await world.device('pixel-7 412x915'); C = await world.device('small-android 360x640');
  nameA = await signUp(A, 'host_a'); nameB = await signUp(B, 'friend_b'); nameC = await signUp(C, 'outsider_c');
  take = makeWav({ seconds: 1.5 });
});
after(async () => { await world.close(); });

test('host creates a room: code is well-formed and the host is its first member', async () => {
  await goNav(A, 'collab'); await A.page.tap('#createRoomBtn');
  await A.page.waitForFunction(() => /^TH-[A-Z0-9]{8}$/.test(document.getElementById('roomCodeDisplay')?.textContent.trim()));
  code = (await A.page.textContent('#roomCodeDisplay')).trim();
  assert.match(code, /^TH-[2-9A-HJ-NP-Z]{8}$/, 'no ambiguous characters (0/O, 1/I)');
  assert.equal(T().rooms.length, 1);
  assert.deepEqual(T().room_members.map(m => m.user_id), [uid(nameA)]);
});

test('host uploads a vocal: stored privately under their own folder, metadata saved, no overwrite', async () => {
  await A.page.setInputFiles('#vocalUpload', { name: 'lead vocal.wav', mimeType: 'audio/wav', buffer: take });
  await A.page.waitForFunction(() => document.querySelectorAll('#view-collab .vocal-slot').length >= 1);
  const paths = [...world.backend.objects.keys()];
  assert.equal(paths.length, 1);
  assert.ok(paths[0].startsWith(uid(nameA) + '/'), paths[0]);
  assert.ok(!paths[0].includes('..') && paths[0].split('/').length === 2);
  assert.equal(vocalFor(nameA).length, 1);
  assert.equal(vocalFor(nameA)[0].file_path, paths[0]);
  assert.deepEqual(A.errors, []);
});

test('outsider cannot read the room, its vocal, or sign the audio file', async () => {
  const path = [...world.backend.objects.keys()][0];
  assert.deepEqual((await sbPost('q', uid(nameC), { table: 'room_vocals', op: 'select', filters: [], ors: [], order: [] })).data, []);
  assert.deepEqual((await sbPost('q', uid(nameC), { table: 'rooms', op: 'select', filters: [], ors: [], order: [] })).data, []);
  assert.ok((await sbPost('storage', uid(nameC), { op: 'sign', path })).error, 'signing refused');
  // wrong / guessed codes never create membership
  await goNav(C, 'collab'); await C.page.tap('#focusJoinCodeBtn'); await C.page.fill('#joinCodeInput', 'TH-AAAAAAAA'); await C.page.tap('#joinRoomBtn');
  await C.page.waitForTimeout(1200);
  assert.ok(!T().room_members.some(m => m.user_id === uid(nameC)), 'guessing a code does not add a member');
  assert.deepEqual(C.errors, [], 'a failed join is handled gracefully, not an exception');
});

test('collaborator joins by code and receives the host\'s vocal', async () => {
  await goNav(B, 'collab'); await B.page.tap('#focusJoinCodeBtn'); await B.page.fill('#joinCodeInput', code.toLowerCase()); await B.page.tap('#joinRoomBtn');
  await B.page.waitForFunction(() => document.querySelectorAll('#view-collab .vocal-slot').length >= 1, null, { timeout: 10000 });
  assert.ok(T().room_members.some(m => m.user_id === uid(nameB)));
  assert.match(await B.page.textContent('#view-collab .vocal-slot'), new RegExp(nameA));
  // the audio B can fetch is byte-identical to what A uploaded
  const src = await B.page.evaluate(() => { const a = document.querySelector('#view-collab audio'); return a ? a.src : null; });
  if (src) { const got = Buffer.from(await (await fetch(src)).arrayBuffer()); assert.equal(sha(got), sha(take)); }
  else { const path = [...world.backend.objects.keys()][0]; const signed = (await sbPost('storage', uid(nameB), { op: 'sign', path })).data.signedUrl; assert.equal(sha(Buffer.from(await (await fetch(signed)).arrayBuffer())), sha(take)); }
});

test('live updates: a note from the collaborator reaches the host without a refresh', async () => {
  await B.page.fill('#activityInput', 'love the hook!'); await B.page.tap('#activitySendBtn');
  await hasText(A.page, /love the hook!/);
});

test('collaborator cannot overwrite, delete, spoof or plant files in the host\'s space', async () => {
  const path = [...world.backend.objects.keys()][0], before = world.backend.objects.get(path).bytes;
  assert.ok((await sbPost('storage', uid(nameB), { op: 'upload', path, type: 'audio/wav', base64: Buffer.from('evil').toString('base64') })).error, 'overwrite refused');
  assert.ok((await sbPost('storage', uid(nameB), { op: 'upload', path: `${uid(nameA)}/planted.wav`, type: 'audio/wav', base64: 'AAAA' })).error, 'planting refused');
  assert.deepEqual((await sbPost('storage', uid(nameB), { op: 'remove', paths: [path] })).data, [], 'delete removes nothing');
  assert.equal(world.backend.objects.get(path).bytes.equals(before), true);
  const spoof = await sbPost('q', uid(nameB), { table: 'room_vocals', op: 'insert', data: { room_code: code, user_id: uid(nameA), file_path: path }, filters: [], ors: [], order: [] });
  assert.ok(spoof.error, 'cannot register metadata as the host');
  const del = await sbPost('q', uid(nameB), { table: 'room_vocals', op: 'delete', filters: [['room_code', 'eq', code]], ors: [], order: [], returning: true });
  assert.deepEqual(del.data, [], 'cannot delete the host\'s vocal row');
  assert.equal(vocalFor(nameA).length, 1);
  const hostile = await sbPost('q', uid(nameB), { table: 'rooms', op: 'update', data: { host_id: uid(nameB) }, filters: [['code', 'eq', code]], ors: [], order: [], returning: true });
  assert.ok(hostile.error, 'a member cannot take over the room');
  assert.equal(T().rooms[0].host_id, uid(nameA));
});

test('upload failure recovery: a failed upload leaves no metadata and no stray file, and a retry works', async () => {
  const objectsBefore = world.backend.objects.size, rowsBefore = T().room_vocals.length;
  S().fail.push({ match: (p, b) => p === '/__sb/storage' && b.op === 'upload', status: 500, times: 1 });
  await B.page.setInputFiles('#vocalUpload', { name: 'b take.wav', mimeType: 'audio/wav', buffer: take });
  await B.page.waitForTimeout(1500);
  assert.equal(S().fail.filter(f => f.times > 0).length, 0, 'the injected fault was actually hit');
  assert.equal(world.backend.objects.size, objectsBefore); assert.equal(T().room_vocals.length, rowsBefore);
  await B.page.setInputFiles('#vocalUpload', { name: 'b take.wav', mimeType: 'audio/wav', buffer: take });   // retry
  await B.page.waitForFunction(() => document.querySelectorAll('#view-collab .vocal-slot').length >= 2, null, { timeout: 10000 });
  assert.equal(vocalFor(nameB).length, 1);
});

test('replace failure recovery: metadata save fails -> new file removed, the previous vocal and its audio survive', async () => {
  const before = vocalFor(nameA)[0], beforePath = before.file_path;
  S().fail.push({ match: (p, b) => p === '/__sb/q' && b.table === 'room_vocals' && b.op === 'insert', status: 500, times: 1 });
  await A.page.setInputFiles('#vocalUpload', { name: 'replacement.wav', mimeType: 'audio/wav', buffer: makeWav({ seconds: 1, freq: 660 }) });
  await A.page.waitForTimeout(2200);
  assert.equal(S().fail.filter(f => f.times > 0).length, 0, 'the injected fault was actually hit');
  const own = [...world.backend.objects.keys()].filter(k => k.startsWith(uid(nameA) + '/'));
  assert.deepEqual(own, [beforePath], 'only the original audio remains (no orphan from the failed replacement)');
  assert.equal(vocalFor(nameA).length, 1, 'the previous vocal row was restored');
  assert.equal(vocalFor(nameA)[0].file_path, beforePath);
  assert.ok(S().log.some(l => l.kind === 'remove' && l.by === uid(nameA)), 'cleanup of the new object happened');
});

test('replacing a vocal does not leave the previous audio file behind', async () => {
  const oldPath = vocalFor(nameA)[0].file_path;
  await A.page.setInputFiles('#vocalUpload', { name: 'take two.wav', mimeType: 'audio/wav', buffer: makeWav({ seconds: 1, freq: 880 }) });
  await A.page.waitForFunction(p => true, null);
  await A.page.waitForTimeout(2500);
  const own = [...world.backend.objects.keys()].filter(k => k.startsWith(uid(nameA) + '/'));
  assert.equal(vocalFor(nameA).length, 1, 'one vocal row per artist per room');
  assert.equal(own.length, 1, 'old file deleted when replaced (private audio must not linger): ' + own.join(', '));
  assert.notEqual(own[0], oldPath);
  assert.equal(vocalFor(nameA)[0].file_path, own[0]);
});

test('efficiency: an idle room generates no write/refresh storm (battery, data and DB-cost regression)', async () => {
  await A.page.waitForTimeout(1000);                                   // let post-upload activity settle
  const mark = S().log.length;
  await A.page.waitForTimeout(3000);
  const L = S().log.slice(mark).filter(l => l.path !== '/__sb/events');   // ignore the test stub's own event polling
  const updates = L.filter(l => l.table === 'rooms' && l.op === 'update').length;
  assert.ok(updates <= 1, `rooms were rewritten ${updates}x while idle (feedback loop)`);
  assert.ok(L.length <= 15, `${L.length} backend requests in 3s of idle time; a realtime feedback loop would be hundreds`);
});

test('hostile uploads are rejected client-side without touching storage', async () => {
  const before = world.backend.objects.size, reqs = S().log.filter(l => l.kind === 'req' && l.op === 'upload').length;
  await B.page.setInputFiles('#vocalUpload', { name: 'virus.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') }).catch(() => {});
  await B.page.setInputFiles('#vocalUpload', { name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<script>1</script>') }).catch(() => {});
  await B.page.waitForTimeout(800);
  assert.equal(world.backend.objects.size, before);
  assert.equal(S().log.filter(l => l.kind === 'req' && l.op === 'upload').length, reqs, 'no upload request was even made');
});

test('leaving a room revokes access to its audio', async () => {
  const path = vocalFor(nameA)[0].file_path;
  assert.ok((await sbPost('storage', uid(nameB), { op: 'sign', path })).data, 'member can sign before leaving');
  B.page.once('dialog', dlg => dlg.accept());
  await B.page.tap('#leaveRoomBtn');
  await B.page.waitForTimeout(1200);
  assert.ok(!T().room_members.some(m => m.user_id === uid(nameB)), 'membership removed');
  assert.ok((await sbPost('storage', uid(nameB), { op: 'sign', path })).error, 'cannot sign after leaving');
});

test('no uncaught page errors for any participant', async () => {
  for (const [n, d] of [['A', A], ['B', B], ['C', C]]) assert.deepEqual(d.errors, [], `${n}: ${d.errors.join(' | ')}`);
});
