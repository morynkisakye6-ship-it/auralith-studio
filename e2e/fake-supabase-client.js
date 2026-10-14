/* Browser-side stand-in for @supabase/supabase-js (UMD global `supabase`). Used only by the e2e suite.
   Forwards every call to the fake backend at /__sb/* so several browser contexts share one world. */
(function () {
  const KEY = 'sb-fake-session';
  function createClient(url, key) {
    let session = null, listeners = [];
    try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {}
    const hdr = () => ({ 'content-type': 'application/json', ...(session ? { authorization: 'Bearer ' + session.access_token } : {}) });
    const post = async (path, body) => { const r = await fetch('/__sb/' + path, { method: 'POST', headers: hdr(), body: JSON.stringify(body) }); return r.json(); };
    const notify = (ev) => listeners.forEach(l => { try { l(ev, session); } catch (e) { console.error(e); } });
    const setSession = (s, ev) => { session = s; if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); notify(ev); };
    const A = { // auth
      async getSession() { return { data: { session }, error: null }; },
      async getUser() { return { data: { user: session ? session.user : null }, error: null }; },
      onAuthStateChange(cb) { listeners.push(cb); setTimeout(() => { try { cb('INITIAL_SESSION', session); } catch (e) { console.error(e); } }, 0); return { data: { subscription: { unsubscribe() { listeners = listeners.filter(l => l !== cb); } } } }; },
      async signUp({ email, password, options }) { const r = await post('auth', { op: 'signUp', email, password, options }); if (r.error) return { data: { user: null, session: null }, error: r.error }; setSession(r.data.session, 'SIGNED_IN'); return { data: r.data, error: null }; },
      async signInWithPassword({ email, password }) { const r = await post('auth', { op: 'signIn', email, password }); if (r.error) return { data: { user: null, session: null }, error: r.error }; setSession(r.data.session, 'SIGNED_IN'); return { data: r.data, error: null }; },
      async signOut() { setSession(null, 'SIGNED_OUT'); return { error: null }; },
      async resetPasswordForEmail(email) { await post('auth', { op: 'reset', email }); return { data: {}, error: null }; },
      async updateUser() { return { data: { user: session && session.user }, error: null }; }
    };
    class Q { // PostgREST builder (thenable)
      constructor(table) { this.q = { table, op: 'select', filters: [], ors: [], order: [], returning: false }; }
      select(_cols, opts) { if (this.q.op === 'select') { if (opts && opts.head) this.q.head = true; } else this.q.returning = true; return this; }
      insert(d) { this.q.op = 'insert'; this.q.data = d; return this; }
      upsert(d, o) { this.q.op = 'upsert'; this.q.data = d; if (o && o.onConflict) this.q.onConflict = o.onConflict; return this; }
      update(d) { this.q.op = 'update'; this.q.data = d; return this; }
      delete() { this.q.op = 'delete'; return this; }
      eq(c, v) { this.q.filters.push([c, 'eq', v]); return this; }
      neq(c, v) { this.q.filters.push([c, 'neq', v]); return this; }
      in(c, v) { this.q.filters.push([c, 'in', v]); return this; }
      ilike(c, v) { this.q.filters.push([c, 'ilike', v]); return this; }
      gte(c, v) { this.q.filters.push([c, 'gte', v]); return this; }
      lte(c, v) { this.q.filters.push([c, 'lte', v]); return this; }
      is(c, v) { this.q.filters.push([c, 'is', v]); return this; }
      or(expr) { this.q.ors.push(String(expr).split(',').map(p => { const [c, op, ...rest] = p.split('.'); return [c, op, rest.join('.')]; })); return this; }
      order(c, o) { this.q.order.push({ col: c, ascending: !(o && o.ascending === false) }); return this; }
      limit(n) { this.q.limit = n; return this; }
      single() { this.q.single = true; return this; }
      maybeSingle() { this.q.maybeSingle = true; return this; }
      then(res, rej) { return post('q', this.q).then(r => ({ data: r.data === undefined ? null : r.data, error: r.error || null, count: r.count }), e => ({ data: null, error: { message: String(e) } })).then(res, rej); }
    }
    const b64 = blob => new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1] || ''); fr.onerror = () => no(fr.error); fr.readAsDataURL(blob); });
    const storage = { from: () => ({
      async upload(path, file, opts) { try { const r = await post('storage', { op: 'upload', path, type: (file && file.type) || '', base64: await b64(file), upsert: !!(opts && opts.upsert) }); return r.error ? { data: null, error: r.error } : { data: r.data, error: null }; } catch (e) { return { data: null, error: { message: String(e) } }; } },
      async createSignedUrl(path, expiresIn) { const r = await post('storage', { op: 'sign', path, expiresIn }); return r.error ? { data: null, error: r.error } : { data: r.data, error: null }; },
      async remove(paths) { const r = await post('storage', { op: 'remove', paths }); return r.error ? { data: null, error: r.error } : { data: r.data, error: null }; }
    }) };
    // Realtime: poll the event log and dispatch postgres_changes to matching channels.
    const channels = []; let since = 0, timer = null;
    const matches = (f, row) => !f || !f.filter || (() => { const m = /^(\w+)=eq\.(.*)$/.exec(f.filter); return m ? String(row && row[m[1]]) === m[2] : true; })();
    const poll = async () => {
      if (!session) return;
      try {
        const r = await (await fetch('/__sb/events?since=' + since, { headers: hdr() })).json();
        since = Math.max(since, r.seq || 0);
        for (const ev of r.events || []) for (const ch of channels) for (const h of ch.handlers) {
          if (h.f.table === ev.table && (h.f.event === '*' || h.f.event === ev.type) && matches(h.f, ev.new || ev.old)) h.cb({ eventType: ev.type, new: ev.new || {}, old: ev.old || {}, table: ev.table });
        }
      } catch (_) {}
    };
    const ensurePolling = async () => { if (timer) return; if (session) { try { since = (await (await fetch('/__sb/events?since=999999999', { headers: hdr() })).json()).seq || 0; } catch (_) {} } timer = setInterval(poll, 250); };
    const channel = name => { const ch = { name, handlers: [], on(type, f, cb) { ch.handlers.push({ f, cb }); return ch; }, subscribe(cb) { channels.push(ch); ensurePolling(); if (cb) setTimeout(() => cb('SUBSCRIBED'), 0); return ch; }, unsubscribe() { const i = channels.indexOf(ch); if (i >= 0) channels.splice(i, 1); } }; return ch; };
    return {
      auth: A, storage, channel,
      removeChannel(ch) { if (ch && ch.unsubscribe) ch.unsubscribe(); return Promise.resolve('ok'); },
      from: t => new Q(t),
      async rpc(name, args) { const r = await post('rpc', { name, args }); return { data: r.data === undefined ? null : r.data, error: r.error || null }; }
    };
  }
  window.supabase = { createClient };
})();
