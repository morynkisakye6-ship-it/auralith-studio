/* Auralith Studio project sync (v2.0.3).
 *
 * Three small, dependency-free pieces used by the cloud save path:
 *   1. prepareProjects()  - validates/dedupes projects BEFORE they are uploaded.
 *   2. classifyError()    - decides whether a failed upload is worth retrying.
 *   3. createSaver()      - a debounced, single-flight, retrying save queue whose
 *                           pending work is bound to the user who made the edit,
 *                           so signing out cannot silently drop it.
 *
 * Everything with side effects (network, timers, clock) is injected so the
 * behaviour can be tested offline.
 */
(function (global) {
  'use strict';

  var LIMITS = Object.freeze({
    idMax: 128,
    bpmMax: 1000,
    stepCountMax: 512,
    // Serialized project size (characters). Far above any real project, well below request limits.
    projectMaxChars: 900000
  });

  var STRING_FIELDS = ['title', 'lyrics', 'hook', 'key', 'mood', 'ref', 'kit'];

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** Returns { ok, errors[] } for one project. Never throws. */
  function validateProject(p) {
    var errors = [];
    if (!isPlainObject(p)) return { ok: false, errors: ['not an object'] };

    var id = p.id;
    if (typeof id === 'number') id = String(id);
    if (typeof id !== 'string' || !id.trim()) errors.push('missing id');
    else if (id.length > LIMITS.idMax) errors.push('id too long');
    else if (/[\s\u0000-\u001f]/.test(id)) errors.push('id contains whitespace or control characters');

    STRING_FIELDS.forEach(function (f) {
      if (p[f] != null && typeof p[f] !== 'string') errors.push(f + ' must be text');
    });

    if (p.sections != null) {
      if (!Array.isArray(p.sections)) errors.push('sections must be a list');
      else if (!p.sections.every(isPlainObject)) errors.push('sections contains an invalid entry');
    }
    if (p.pattern != null && !isPlainObject(p.pattern)) errors.push('pattern must be an object');
    if (p.vocalMeta != null && !isPlainObject(p.vocalMeta)) errors.push('vocalMeta must be an object');

    if (p.bpm != null && !(isFiniteNumber(p.bpm) && p.bpm > 0 && p.bpm <= LIMITS.bpmMax)) errors.push('bpm out of range');
    if (p.stepCount != null &&
        !(isFiniteNumber(p.stepCount) && p.stepCount >= 1 && p.stepCount <= LIMITS.stepCountMax && Math.floor(p.stepCount) === p.stepCount)) {
      errors.push('stepCount out of range');
    }
    // A bad timestamp makes new Date(x).toISOString() throw, which would fail the whole batch.
    if (p.updated != null && !(isFiniteNumber(p.updated) && p.updated >= 0 && !isNaN(new Date(p.updated).getTime()))) {
      errors.push('updated is not a valid timestamp');
    }

    if (!errors.length) {
      try {
        var size = JSON.stringify(p).length;
        if (size > LIMITS.projectMaxChars) errors.push('project too large (' + size + ' characters)');
      } catch (e) {
        errors.push('project is not serializable');
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /**
   * Splits songs into uploadable and rejected. Duplicate ids are collapsed (newest wins) because one
   * upsert containing the same primary key twice makes Postgres fail the entire batch.
   * Returns { valid: [], rejected: [{id, index, errors}], deduped: n }.
   */
  function prepareProjects(songs) {
    var list = Array.isArray(songs) ? songs : [];
    var rejected = [];
    var byId = new Map();
    var deduped = 0;
    list.forEach(function (song, index) {
      var res = validateProject(song);
      if (!res.ok) {
        rejected.push({ id: isPlainObject(song) && song.id != null ? String(song.id) : null, index: index, errors: res.errors });
        return;
      }
      var key = String(song.id);
      var existing = byId.get(key);
      if (existing) {
        deduped++;
        if (Number(song.updated || 0) <= Number(existing.updated || 0)) return;
      }
      byId.set(key, song);
    });
    return { valid: Array.from(byId.values()), rejected: rejected, deduped: deduped };
  }

  var TRANSIENT_STATUS = { 408: 1, 425: 1, 429: 1 };
  // PostgREST/Postgres codes that mean "try again": cannot connect, schema cache reloading, connection
  // failures (08*), resource limits/shutdown (53*, 57*), serialization failure and deadlock.
  var TRANSIENT_CODE = /^(PGRST00[0-3]|08\w{3}|53\w{3}|57\w{3}|40001|40P01)$/;
  var NETWORK_MESSAGE = /failed to fetch|networkerror|network request failed|load failed|network|timed? ?out|timeout|offline|connection|econn|enotfound|socket|aborted/i;

  /** Classifies a Supabase error object, a thrown Error, or a string. */
  function classifyError(err) {
    if (err == null) return { retryable: false, auth: false, reason: 'unknown' };
    var status = Number(err.status != null ? err.status : err.statusCode);
    var code = err.code != null ? String(err.code) : '';
    var message = String(err.message || err.error || (typeof err === 'string' ? err : '') || '');

    if (status === 401 || code === 'PGRST301' || /jwt (expired|invalid)/i.test(message)) {
      return { retryable: false, auth: true, reason: 'session expired or invalid' };
    }
    if (status === 403 || code === '42501') return { retryable: false, auth: false, reason: 'permission denied' };
    if (isFinite(status) && status > 0) {
      if (status >= 500 || TRANSIENT_STATUS[status]) return { retryable: true, auth: false, reason: 'server busy or unavailable (' + status + ')' };
      return { retryable: false, auth: false, reason: 'request rejected (' + status + ')' };
    }
    if (code && TRANSIENT_CODE.test(code)) return { retryable: true, auth: false, reason: 'temporary database error (' + code + ')' };
    if (code) return { retryable: false, auth: false, reason: 'database rejected the data (' + code + ')' };
    if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.name === 'TypeError' || NETWORK_MESSAGE.test(message)) {
      return { retryable: true, auth: false, reason: 'network problem' };
    }
    return { retryable: false, auth: false, reason: message || 'unknown error' };
  }

  /**
   * deps:
   *   getSnapshot() -> { userId, songs, deletions? } | null   signed-in cloud user, their songs, ids deleted locally but not yet in the cloud
   *   upload(userId, songs, deletions) -> Promise<{ok, retryable?, error?, rejected?, uploaded?}> (may throw/reject)
   *   onStatus(status)      optional UI callback
   *   timers                optional { setTimeout, clearTimeout, now } (tests inject these)
   *   debounceMs, retryDelays, maxBackgroundRetries, attemptTimeoutMs   tuning
   */
  function createSaver(deps) {
    var timers = deps.timers || {};
    var setT = timers.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearT = timers.clearTimeout || function (h) { clearTimeout(h); };
    var now = timers.now || function () { return Date.now(); };
    var debounceMs = deps.debounceMs != null ? deps.debounceMs : 900;
    var retryDelays = deps.retryDelays || [1500, 4000, 10000, 30000, 60000];
    var maxRetries = deps.maxBackgroundRetries != null ? deps.maxBackgroundRetries : retryDelays.length;
    var attemptTimeoutMs = deps.attemptTimeoutMs != null ? deps.attemptTimeoutMs : 20000;
    // A debounce alone lets a steady stream of edits (or any save loop) postpone the upload forever; cap the total wait.
    var maxWaitMs = deps.maxWaitMs != null ? deps.maxWaitMs : 5000;
    var firstRequestAt = null;
    var onStatus = deps.onStatus || function () {};

    var pending = null;       // { userId, songs, version } - cleared only after a successful upload
    var version = 0;
    var inflight = null;
    var debounceTimer = null;
    var retryTimer = null;
    var attempts = 0;         // consecutive failed background attempts
    var lastResult = null;

    function emit(status) { try { onStatus(status); } catch (e) { /* UI errors must never break saving */ } }
    function clearTimers() {
      if (debounceTimer != null) { clearT(debounceTimer); debounceTimer = null; }
      if (retryTimer != null) { clearT(retryTimer); retryTimer = null; }
      firstRequestAt = null;
    }
    function sleep(ms) { return new Promise(function (resolve) { setT(resolve, ms); }); }

    /** Records that the current user's projects changed. Captures WHO and WHAT now, not at fire time. */
    function request() {
      var snap = deps.getSnapshot();
      if (!snap || !snap.userId) return false;
      version++;
      pending = { userId: snap.userId, songs: snap.songs || [], deletions: snap.deletions || [], version: version };
      attempts = 0;
      if (debounceTimer != null) clearT(debounceTimer);
      if (retryTimer != null) { clearT(retryTimer); retryTimer = null; }
      if (firstRequestAt == null) firstRequestAt = now();
      var wait = Math.max(0, Math.min(debounceMs, firstRequestAt + maxWaitMs - now()));
      debounceTimer = setT(background, wait);
      emit({ state: 'pending' });
      return true;
    }

    function withTimeout(promise) {
      return new Promise(function (resolve) {
        var done = false;
        var handle = setT(function () {
          if (done) return;
          done = true;
          resolve({ ok: false, retryable: true, error: 'timeout', reason: 'upload timed out' });
        }, attemptTimeoutMs);
        promise.then(function (res) { if (!done) { done = true; clearT(handle); resolve(res); } },
                     function (err) { if (!done) { done = true; clearT(handle); resolve(failureFrom(err)); } });
      });
    }

    function failureFrom(err) {
      var c = classifyError(err);
      return { ok: false, retryable: c.retryable, auth: c.auth, error: (err && err.message) || String(err), reason: c.reason };
    }

    /** One upload attempt of whatever is pending. Single-flight: callers must check `inflight` first. */
    function runOnce() {
      var job = pending;
      var current = deps.getSnapshot();
      // Same user still signed in: upload their freshest songs. Otherwise use what was captured with the edit.
      var same = current && current.userId === job.userId;
      var songs = same ? (current.songs || []) : job.songs;
      var deletions = same ? (current.deletions || []) : job.deletions;
      emit({ state: 'saving', attempt: attempts + 1 });
      var call;
      try { call = Promise.resolve(deps.upload(job.userId, songs, deletions)); }
      catch (e) { call = Promise.reject(e); }
      inflight = withTimeout(call.then(function (res) {
        if (res && typeof res === 'object') return res;
        return { ok: !!res, retryable: !res };   // tolerate a plain boolean from older upload functions
      })).then(function (res) {
        inflight = null;
        lastResult = res;
        if (res.ok && pending && pending.version === job.version) pending = null;
        return res;
      });
      return inflight;
    }

    function afterAttempt(res) {
      if (res.ok) {
        attempts = 0;
        if (pending && debounceTimer == null) debounceTimer = setT(background, debounceMs);   // edits arrived mid-upload
        else emit({ state: 'saved', rejected: res.rejected || [], uploaded: res.uploaded });
        return;
      }
      if (res.retryable && attempts < maxRetries) {
        var delay = retryDelays[Math.min(attempts, retryDelays.length - 1)];
        attempts++;
        emit({ state: 'retrying', attempt: attempts, nextRetryMs: delay, reason: res.reason, error: res.error });
        retryTimer = setT(background, delay);
        return;
      }
      emit({ state: 'failed', retryable: !!res.retryable, auth: !!res.auth, reason: res.reason, error: res.error, rejected: res.rejected || [] });
    }

    function background() {
      debounceTimer = null; retryTimer = null; firstRequestAt = null;
      if (!pending) return Promise.resolve();
      if (inflight) { debounceTimer = setT(background, debounceMs); return Promise.resolve(); }
      return runOnce().then(afterAttempt);
    }

    /**
     * Uploads everything pending now, retrying transient failures until opts.timeoutMs elapses.
     * Used before sign-out. Resolves (never rejects) with { ok, retryable, timedOut, reason, rejected }.
     */
    function flush(opts) {
      opts = opts || {};
      var deadline = opts.timeoutMs != null ? now() + opts.timeoutMs : Infinity;
      var delays = opts.retryDelays || [400, 1000, 2500];
      clearTimers();
      var n = 0;
      var stopped = false;   // set when the deadline passes so a late retry can never upload after sign-out
      function remaining() { return deadline - now(); }
      function step() {
        if (stopped) return Promise.resolve({ ok: false, retryable: true, timedOut: true, reason: 'timed out' });
        if (inflight) return inflight.then(step, step);
        if (!pending) return Promise.resolve({ ok: true, rejected: (lastResult && lastResult.rejected) || [] });
        return runOnce().then(function (res) {
          if (res.ok) return pending ? step() : { ok: true, rejected: res.rejected || [] };
          if (!res.retryable) return { ok: false, retryable: false, auth: !!res.auth, reason: res.reason, error: res.error };
          var wait = delays[Math.min(n++, delays.length - 1)];
          if (remaining() <= wait) return { ok: false, retryable: true, timedOut: true, reason: res.reason, error: res.error };
          return sleep(wait).then(step);
        });
      }
      var outer = step();
      if (deadline === Infinity) return outer;
      return new Promise(function (resolve) {
        var done = false;
        var guard = setT(function () {
          if (!done) { done = true; stopped = true; resolve({ ok: false, retryable: true, timedOut: true, reason: 'timed out' }); }
        }, Math.max(0, remaining()));
        outer.then(function (r) { if (!done) { done = true; clearT(guard); resolve(r); } },
                   function (e) { if (!done) { done = true; clearT(guard); resolve(failureFrom(e)); } });
      });
    }

    /** Network came back or the tab became visible: retry immediately instead of waiting out a backoff. */
    function retryNow() {
      if (!pending) return Promise.resolve();
      attempts = 0;
      clearTimers();
      return background();
    }

    /** Drops queued work (e.g. after sign-out, when the session can no longer authorize an upload). */
    function discard() { clearTimers(); pending = null; attempts = 0; firstRequestAt = null; }

    return {
      request: request,
      flush: flush,
      retryNow: retryNow,
      discard: discard,
      hasPending: function () { return !!pending || !!inflight; }
    };
  }

  global.AuralithProjectSync = Object.freeze({
    LIMITS: LIMITS,
    validateProject: validateProject,
    prepareProjects: prepareProjects,
    classifyError: classifyError,
    createSaver: createSaver
  });
})(typeof window !== 'undefined' ? window : globalThis);
