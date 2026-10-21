import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../js/project-store.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window, Map, Array, String, Number, JSON, Object });
const store = window.AuralithProjectStore;

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    data
  };
}

test('isolates signed-in projects and keeps a guest key', () => {
  assert.equal(store.userStorageKey({ id: 'user-a' }), 'th-songs-user-a');
  assert.equal(store.userStorageKey({ id: 'user-b' }), 'th-songs-user-b');
  assert.equal(store.userStorageKey(null), 'th-songs-guest');
  assert.equal(store.userStorageKey({}), 'th-songs-guest');
});

test('malformed JSON and non-array values safely load as empty projects', () => {
  assert.equal(JSON.stringify(store.read(memoryStorage({ key: '{bad json' }), 'key')), '[]');
  assert.equal(JSON.stringify(store.read(memoryStorage({ key: '{"id":"x"}' }), 'key')), '[]');
});

test('read and write reject malformed project entries', () => {
  const storage = memoryStorage();
  const result = store.write(storage, 'projects', [{ id: 'ok', title: 'Song' }, null, [], { title: 'missing id' }]);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(storage.getItem('projects')), [{ id: 'ok', title: 'Song' }]);
  assert.equal(JSON.stringify(store.read(storage, 'projects')), '[{"id":"ok","title":"Song"}]');
});

test('merge retains unique projects and chooses newer remote version', () => {
  const merged = store.merge(
    [{ id: 'same', updated: 10, title: 'old' }, { id: 'local-only', updated: 8 }],
    [{ id: 'same', updated: 11, title: 'new' }, { id: 'remote-only', updated: 9 }]
  );
  assert.equal(merged.length, 3);
  assert.equal(merged.find(p => p.id === 'same').title, 'new');
  assert.equal(JSON.stringify(merged.map(p => p.id)), '["same","remote-only","local-only"]');
});

test('equal timestamps prefer local edits to avoid overwriting them', () => {
  const merged = store.merge([{ id: 'x', updated: 20, title: 'local' }], [{ id: 'x', updated: 20, title: 'remote' }]);
  assert.equal(merged[0].title, 'local');
});

test('storage quota errors are returned without crashing the app', () => {
  const storage = { getItem() { return null; }, setItem() { throw new Error('quota exceeded'); } };
  const result = store.write(storage, 'projects', [{ id: 'x' }]);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /quota exceeded/);
});

/* ───────────── deletion tombstones (v2.0.4) ───────────── */

function removableStorage(seed = {}) {
  const m = memoryStorage(seed);
  m.removeItem = key => m.data.delete(key);
  return m;
}

test('tombstone key is per user with a guest fallback', () => {
  assert.equal(store.tombstoneKey({ id: 'user-a' }), 'th-deleted-user-a');
  assert.equal(store.tombstoneKey(null), 'th-deleted-guest');
});

test('tombstones: add, read, remove round-trip; duplicates collapse; junk is ignored', () => {
  const st = removableStorage();
  store.addTombstones(st, 'k', ['a', 'b', 'a', '', null], 100);
  assert.equal(JSON.stringify(store.readTombstones(st, 'k').map(t => t.id).sort()), '["a","b"]');
  store.removeTombstones(st, 'k', ['a']);
  assert.equal(JSON.stringify(store.readTombstones(st, 'k')), '[{"id":"b","at":100}]');
  store.removeTombstones(st, 'k', ['b']);
  assert.equal(st.getItem('k'), null, 'empty list removes the key');
  assert.equal(store.readTombstones(memoryStorage({ k: '{bad' }), 'k').length, 0);
  assert.equal(store.readTombstones(memoryStorage({ k: '{"id":"x"}' }), 'k').length, 0);
  assert.equal(store.readTombstones(memoryStorage({ k: JSON.stringify([null, 5, { id: '' }, { id: 'ok', at: 'x' }]) }), 'k').length, 1);
});

test('tombstones: storage failures are returned, not thrown', () => {
  const st = { getItem() { return null; }, setItem() { throw new Error('quota'); } };
  assert.equal(store.addTombstones(st, 'k', ['a'], 1).ok, false);
});

test('tombstones: the list is capped to the newest 1000', () => {
  const st = removableStorage();
  const ids = Array.from({ length: 1200 }, (_, i) => 'p' + i);
  ids.forEach((id, i) => store.addTombstones(st, 'k', [id], i + 1));
  const list = store.readTombstones(st, 'k');
  assert.equal(list.length, 1000);
  assert.ok(list.some(t => t.id === 'p1199') && !list.some(t => t.id === 'p0'));
});

test('partitionRemote: deleted projects are dropped, edits made elsewhere after deletion are kept, others untouched', () => {
  const r = store.partitionRemote(
    [{ id: 'gone', updated: 50 }, { id: 'edited-later', updated: 500 }, { id: 'normal', updated: 1 }, null],
    [{ id: 'gone', at: 100 }, { id: 'edited-later', at: 100 }]
  );
  assert.equal(JSON.stringify(r.keep.map(p => p.id)), '["edited-later","normal"]');
  assert.equal(JSON.stringify(r.dropped), '["gone"]');
  assert.equal(JSON.stringify(r.revived), '["edited-later"]');
});

/* ───────────── cross-tab adoption ───────────── */

const ids = r => JSON.stringify(r.songs.map(p => p.id));

test('adopt: projects created in another tab are added, newer copies replace older, older ones are ignored', () => {
  const cur = [{ id: 'a', updated: 10, title: 'mine' }, { id: 'b', updated: 50, title: 'newer here' }];
  const inc = [{ id: 'a', updated: 20, title: 'edited in other tab' }, { id: 'b', updated: 5, title: 'stale' }, { id: 'c', updated: 30, title: 'new' }];
  const r = store.adopt(cur, inc, [], {});
  assert.equal(JSON.stringify(r.added), '["c"]');
  assert.equal(JSON.stringify(r.replaced), '["a"]');
  assert.equal(r.songs.find(p => p.id === 'a').title, 'edited in other tab');
  assert.equal(r.songs.find(p => p.id === 'b').title, 'newer here');
  assert.equal(ids(r), '["b","c","a"]', 'sorted newest first');
});

test('adopt: a project merely ABSENT from the other tab is kept (it may not have seen it yet) - no lost update', () => {
  const r = store.adopt([{ id: 'mine', updated: 5 }, { id: 'shared', updated: 5 }], [{ id: 'shared', updated: 5 }, { id: 'theirs', updated: 6 }], [], {});
  assert.equal(JSON.stringify(r.songs.map(p => p.id).sort()), '["mine","shared","theirs"]');
  assert.equal(r.removed.length, 0);
});

test('adopt: deletions recorded as tombstones are honoured, but an edit made after the deletion survives', () => {
  const r = store.adopt([{ id: 'gone', updated: 5 }, { id: 'edited', updated: 500 }, { id: 'ok', updated: 5 }], [], [{ id: 'gone', at: 100 }, { id: 'edited', at: 100 }], {});
  assert.equal(JSON.stringify(r.removed), '["gone"]');
  assert.equal(ids(r), '["edited","ok"]');
  const again = store.adopt([], [{ id: 'gone', updated: 5 }], [{ id: 'gone', at: 100 }], {});
  assert.equal(again.songs.length, 0, 'a deleted project in the incoming list is not re-added');
});

test('adopt: the open project with unsaved edits here is not overwritten; without edits it is replaced and flagged', () => {
  const cur = [{ id: 'open', updated: 10, title: 'typing' }];
  const inc = [{ id: 'open', updated: 99, title: 'other tab' }];
  const dirty = store.adopt(cur, inc, [], { openId: 'open', openDirty: true });
  assert.equal(dirty.songs[0].title, 'typing'); assert.equal(dirty.openReplaced, false);
  const clean = store.adopt(cur, inc, [], { openId: 'open', openDirty: false });
  assert.equal(clean.songs[0].title, 'other tab'); assert.equal(clean.openReplaced, true);
});

test('adopt: junk input never throws and never loses the current list', () => {
  const cur = [{ id: 'a', updated: 1 }];
  for (const bad of [null, undefined, 'x', 5, {}, [null, 3, { id: '' }]]) {
    const r = store.adopt(cur, bad, null, undefined);
    assert.equal(JSON.stringify(r.songs.map(p => p.id)), '["a"]');
  }
});
