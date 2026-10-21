/* Auralith Studio project persistence store.
 * Keeps projects isolated per signed-in local user, validates stored payloads,
 * and merges cloud/local versions without discarding newer edits.
 */
(function (global) {
  'use strict';

  function userStorageKey(user) {
    const id = user && user.id != null ? String(user.id).trim() : '';
    return id ? 'th-songs-' + id : 'th-songs-guest';
  }

  function normalizeProjects(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(function (project) {
      return project && typeof project === 'object' &&
        !Array.isArray(project) && project.id != null &&
        String(project.id).trim() !== '';
    });
  }

  function read(storage, key) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return [];
      return normalizeProjects(JSON.parse(raw));
    } catch (error) {
      return [];
    }
  }

  function write(storage, key, projects) {
    try {
      storage.setItem(key, JSON.stringify(normalizeProjects(projects)));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error };
    }
  }

  function merge(localProjects, remoteProjects) {
    const merged = new Map();
    normalizeProjects(localProjects).forEach(function (project) {
      merged.set(String(project.id), project);
    });
    normalizeProjects(remoteProjects).forEach(function (remote) {
      const key = String(remote.id);
      const local = merged.get(key);
      if (!local || Number(remote.updated || 0) > Number(local.updated || 0)) {
        merged.set(key, remote);
      }
    });
    return Array.from(merged.values()).sort(function (a, b) {
      return Number(b.updated || 0) - Number(a.updated || 0);
    });
  }

  /* Deletion tombstones. The cloud path only upserts, so without a record of deletions a project removed on
   * this device would be merged straight back from the cloud. A tombstone stays until the cloud delete succeeds. */
  var TOMBSTONE_CAP = 1000;

  function tombstoneKey(user) {
    var id = user && user.id != null ? String(user.id).trim() : '';
    return id ? 'th-deleted-' + id : 'th-deleted-guest';
  }

  function readTombstones(storage, key) {
    try {
      var raw = storage.getItem(key);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      var byId = new Map();
      parsed.forEach(function (t) {
        if (!t || typeof t !== 'object' || t.id == null || String(t.id).trim() === '') return;
        var at = Number(t.at);
        byId.set(String(t.id), { id: String(t.id), at: Number.isFinite(at) && at > 0 ? at : 0 });
      });
      return Array.from(byId.values());
    } catch (error) {
      return [];
    }
  }

  function writeTombstones(storage, key, list) {
    try {
      var kept = list.slice().sort(function (a, b) { return b.at - a.at; }).slice(0, TOMBSTONE_CAP);
      if (kept.length) storage.setItem(key, JSON.stringify(kept));
      else if (storage.removeItem) storage.removeItem(key);
      else storage.setItem(key, '[]');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error };
    }
  }

  function addTombstones(storage, key, ids, at) {
    var byId = new Map();
    readTombstones(storage, key).forEach(function (t) { byId.set(t.id, t); });
    (ids || []).forEach(function (id) {
      if (id != null && String(id).trim() !== '') byId.set(String(id), { id: String(id), at: Number(at) > 0 ? Number(at) : 1 });
    });
    return writeTombstones(storage, key, Array.from(byId.values()));
  }

  function removeTombstones(storage, key, ids) {
    var drop = new Map();
    (ids || []).forEach(function (id) { drop.set(String(id), true); });
    return writeTombstones(storage, key, readTombstones(storage, key).filter(function (t) { return !drop.has(t.id); }));
  }

  /** Splits cloud projects into those to keep, those that were deleted here (dropped), and those edited elsewhere after the deletion (revived). */
  function partitionRemote(remote, tombstones) {
    var t = new Map();
    (tombstones || []).forEach(function (x) { t.set(String(x.id), x); });
    var out = { keep: [], dropped: [], revived: [] };
    normalizeProjects(remote).forEach(function (p) {
      var ts = t.get(String(p.id));
      if (!ts) out.keep.push(p);
      else if (Number(p.updated || 0) > ts.at) { out.keep.push(p); out.revived.push(String(p.id)); }
      else out.dropped.push(String(p.id));
    });
    return out;
  }

  /**
   * Cross-tab sync. Folds a project list written by ANOTHER tab into this tab's list:
   *  - new projects are added, newer copies replace older ones (except the open project when it has unsaved edits here),
   *  - projects with a deletion tombstone are removed,
   *  - a project that is merely absent from the other list is KEPT (that tab may simply not have seen it yet).
   * Pure function: returns { songs, added[], replaced[], removed[], openReplaced }.
   */
  function adopt(current, incoming, tombstones, opts) {
    opts = opts || {};
    var dead = new Map();
    (tombstones || []).forEach(function (t) { dead.set(String(t.id), t); });
    var byId = new Map();
    normalizeProjects(current).forEach(function (s) { byId.set(String(s.id), s); });
    var out = { added: [], replaced: [], removed: [], openReplaced: false };
    var upd = function (p) { return Number(p && p.updated) || 0; };
    normalizeProjects(incoming).forEach(function (p) {
      var id = String(p.id), ts = dead.get(id), cur = byId.get(id);
      if (ts && upd(p) <= ts.at) return;                       // deleted
      if (!cur) { byId.set(id, p); out.added.push(id); return; }
      if (upd(p) > upd(cur)) {
        if (id === String(opts.openId) && opts.openDirty) return;   // keep what is being typed here; the next save wins
        byId.set(id, p); out.replaced.push(id);
        if (id === String(opts.openId)) out.openReplaced = true;
      }
    });
    Array.from(byId.keys()).forEach(function (id) {
      var ts = dead.get(id);
      if (ts && upd(byId.get(id)) <= ts.at) { byId.delete(id); out.removed.push(id); }
    });
    out.songs = Array.from(byId.values()).sort(function (a, b) { return upd(b) - upd(a); });
    return out;
  }

  global.AuralithProjectStore = Object.freeze({
    userStorageKey: userStorageKey,
    normalizeProjects: normalizeProjects,
    read: read,
    write: write,
    merge: merge,
    tombstoneKey: tombstoneKey,
    readTombstones: readTombstones,
    addTombstones: addTombstones,
    removeTombstones: removeTombstones,
    partitionRemote: partitionRemote,
    adopt: adopt
  });
})(typeof window !== 'undefined' ? window : globalThis);
