// In-memory fake of the Supabase pieces Tapehead uses (auth, PostgREST, RPC, storage, realtime events),
// enforcing the SAME ownership rules as supabase/migrations/20261012_database_ownership_rls.sql and
// 20261011_private_audio_rls.sql. Lets Playwright drive real multi-user flows with no network.
import crypto from 'node:crypto';

const uuid = () => crypto.randomUUID();
const RLS = { message: 'new row violates row-level security policy', code: '42501' };

export function createBackend({ now = () => new Date() } = {}) {
  const S = {
    users: new Map(),            // email -> { id, email, password }
    tables: Object.fromEntries(['profiles', 'projects', 'feed_posts', 'likes', 'comments', 'follows', 'blocks', 'reports', 'messages', 'rooms', 'room_members', 'room_vocals', 'collab_messages'].map(t => [t, []])),
    objects: new Map(),          // path -> { bytes, type }
    signed: new Map(),           // token -> { path, exp }
    events: [], seq: 0,
    log: [],                     // { kind, ... } for assertions
    fail: [],                    // injected faults: { match(req), status, times }
    api: { entitlement: null }
  };
  const byId = Object.fromEntries([...Object.keys(S.tables)].map(t => [t, null]));
  const T = n => S.tables[n];
  const member = (uid, code) => T('room_members').some(m => m.room_code === code && m.user_id === uid);
  const host = (uid, code) => T('rooms').some(r => r.code === code && r.host_id === uid);

  // ---- policies (mirror of the SQL migrations) ----
  const P = {
    profiles: { sel: (u, r) => r.id === u, ins: (u, r) => r.id === u, upd: (u, r) => r.id === u, del: () => false },
    projects: { sel: (u, r) => r.user_id === u, ins: (u, r) => r.user_id === u, upd: (u, r) => r.user_id === u, del: (u, r) => r.user_id === u },
    feed_posts: { sel: () => true, ins: (u, r) => r.user_id === u, upd: (u, r) => r.user_id === u, del: (u, r) => r.user_id === u },
    likes: { sel: () => true, ins: (u, r) => r.user_id === u && T('feed_posts').some(p => p.id === r.post_id), upd: () => false,
      del: (u, r) => r.user_id === u || T('feed_posts').some(p => p.id === r.post_id && p.user_id === u) },
    comments: { sel: () => true, ins: (u, r) => r.user_id === u && T('feed_posts').some(p => p.id === r.post_id), upd: () => false,
      del: (u, r) => r.user_id === u || T('feed_posts').some(p => p.id === r.post_id && p.user_id === u) },
    follows: { sel: () => true, ins: (u, r) => r.follower_id === u && r.following_id !== u, upd: (u, r) => r.follower_id === u, del: (u, r) => r.follower_id === u },
    blocks: { sel: (u, r) => r.blocker_id === u, ins: (u, r) => r.blocker_id === u, upd: (u, r) => r.blocker_id === u, del: (u, r) => r.blocker_id === u },
    reports: { sel: () => false, ins: (u, r) => r.reporter_id === u, upd: () => false, del: () => false },
    messages: { sel: (u, r) => r.sender_id === u || r.recipient_id === u,
      ins: (u, r) => r.sender_id === u && r.recipient_id !== u && !T('blocks').some(b => (b.blocker_id === r.sender_id && b.blocked_id === r.recipient_id) || (b.blocker_id === r.recipient_id && b.blocked_id === r.sender_id)),
      upd: () => false, del: () => false },
    rooms: { sel: (u, r) => r.host_id === u || member(u, r.code), ins: (u, r) => r.host_id === u,
      upd: (u, r) => r.host_id === u || member(u, r.code), del: (u, r) => r.host_id === u },
    room_members: { sel: (u, r) => member(u, r.room_code), ins: () => false, upd: () => false, del: (u, r) => r.user_id === u },
    room_vocals: { sel: (u, r) => member(u, r.room_code), ins: (u, r) => r.user_id === u && String(r.file_path).startsWith(u + '/') && member(u, r.room_code),
      upd: () => false, del: (u, r) => r.user_id === u },
    collab_messages: { sel: (u, r) => member(u, r.room_code), ins: (u, r) => r.user_id === u && member(u, r.room_code), upd: () => false, del: () => false }
  };
  const PUBLIC_PROFILE_COLS = ['id', 'username', 'avatar_url', 'bio', 'location', 'genres', 'links', 'open_to_collab'];

  const emit = (table, type, row, old) => { S.events.push({ seq: ++S.seq, table, type, new: row, old }); };
  const userFrom = req => {
    const t = String(req.headers.authorization || '').replace('Bearer ', '');
    if (!t.startsWith('tok_')) return null;
    for (const u of S.users.values()) if ('tok_' + u.id === t) return u;
    return null;
  };

  // ---- filter evaluation ----
  const cmp = (row, [col, op, val]) => {
    const v = row[col];
    switch (op) {
      case 'eq': return String(v) === String(val);
      case 'neq': return String(v) !== String(val);
      case 'in': return val.map(String).includes(String(v));
      case 'ilike': return new RegExp('^' + String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i').test(String(v ?? ''));
      case 'gte': return v >= val; case 'lte': return v <= val; case 'gt': return v > val; case 'lt': return v < val;
      case 'is': return (val === null ? v == null : v === val);
      default: throw new Error('fake backend: unsupported op ' + op);
    }
  };
  const evalFilters = (row, filters = [], ors = []) =>
    filters.every(f => cmp(row, f)) && ors.every(group => group.some(f => cmp(row, f)));

  function query(user, q) {
    const uid = user?.id;
    let table = q.table;
    if (table === 'public_profiles') {
      const rows = T('profiles').map(r => Object.fromEntries(PUBLIC_PROFILE_COLS.map(c => [c, r[c] ?? null])));
      return finishSelect(rows.filter(r => evalFilters(r, q.filters, q.ors)), q);
    }
    if (!P[table]) return { error: { message: 'relation "' + table + '" does not exist', code: '42P01' } };
    if (!uid && !(['feed_posts', 'likes', 'comments', 'follows'].includes(table) && q.op === 'select')) return { error: { message: 'permission denied for table ' + table, code: '42501' } };
    const pol = P[table], rows = T(table);
    if (q.op === 'select') {
      return finishSelect(rows.filter(r => pol.sel(uid, r) && evalFilters(r, q.filters, q.ors)), q);
    }
    if (q.op === 'insert' || q.op === 'upsert') {
      const out = [];
      for (const raw of [].concat(q.data)) {
        const row = { id: raw.id ?? (table === 'profiles' || table === 'follows' || table === 'blocks' || table === 'room_members' ? undefined : uuid()), created_at: now().toISOString(), ...raw };
        if (row.id === undefined) delete row.id;
        const keys = String(q.onConflict || 'id').split(',');
        const existing = q.op === 'upsert' ? rows.find(r => keys.every(k => String(r[k]) === String(row[k]))) : null;
        if (existing) {
          if (!pol.ins(uid, row)) return { error: RLS };     // INSERT check runs first, like Postgres
          if (!pol.upd(uid, existing) || !pol.upd(uid, row)) return { error: RLS };
          if (table === 'rooms' && (row.host_id !== existing.host_id || row.code !== existing.code)) return { error: { message: 'room host and code are immutable', code: '42501' } };
          const old = { ...existing }; Object.assign(existing, row); emit(table, 'UPDATE', { ...existing }, old); out.push({ ...existing });
        } else {
          if (!pol.ins(uid, row)) return { error: RLS };
          if (q.op === 'insert' && q.unique && rows.some(r => q.unique.every(k => String(r[k]) === String(row[k])))) return { error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
          rows.push(row); emit(table, 'INSERT', { ...row }); out.push({ ...row });
        }
      }
      return finishWrite(out, q);
    }
    if (q.op === 'update') {
      const hit = rows.filter(r => pol.sel(uid, r) && evalFilters(r, q.filters, q.ors) && pol.upd(uid, r));
      for (const r of hit) {
        const next = { ...r, ...q.data };
        if (table === 'rooms' && (next.host_id !== r.host_id || next.code !== r.code)) return { error: { message: 'room host and code are immutable', code: '42501' } };
        if (!pol.upd(uid, next)) return { error: RLS };
        const old = { ...r }; Object.assign(r, q.data); emit(table, 'UPDATE', { ...r }, old);
      }
      return finishWrite(hit.map(r => ({ ...r })), q);
    }
    if (q.op === 'delete') {
      const hit = rows.filter(r => pol.sel(uid, r) && evalFilters(r, q.filters, q.ors) && pol.del(uid, r));
      for (const r of hit) { rows.splice(rows.indexOf(r), 1); emit(table, 'DELETE', null, { ...r }); }
      return finishWrite(hit, q);
    }
    return { error: { message: 'unsupported op' } };
  }
  function finishSelect(rows, q) {
    let out = rows.map(r => ({ ...r }));
    for (const o of q.order || []) out.sort((a, b) => (a[o.col] > b[o.col] ? 1 : a[o.col] < b[o.col] ? -1 : 0) * (o.ascending === false ? -1 : 1));
    const count = out.length;
    if (q.limit != null) out = out.slice(0, q.limit);
    if (q.head) return { data: null, count };
    return shape(out, q, count);
  }
  const finishWrite = (rows, q) => (q.returning ? shape(rows, q) : { data: null });
  function shape(rows, q, count) {
    if (q.single) { if (rows.length !== 1) return { error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }; return { data: rows[0], count }; }
    if (q.maybeSingle) return rows.length > 1 ? { error: { message: 'multiple rows returned', code: 'PGRST116' } } : { data: rows[0] ?? null, count };
    return { data: rows, count };
  }

  // ---- RPC ----
  function rpc(user, name, args) {
    if (!user) return { error: { message: 'not authenticated', code: '28000' } };
    if (name === 'join_room_limited') {
      const code = String(args.p_room_code || '').toUpperCase();
      const room = T('rooms').find(r => r.code === code);
      if (!room) return { data: false };
      if (!member(user.id, code)) {
        const prof = T('profiles').find(p => p.id === user.id);
        const row = { room_code: code, user_id: user.id, username: prof?.username || user.email.split('@')[0], avatar_url: prof?.avatar_url || null, joined_at: now().toISOString() };
        T('room_members').push(row); emit('room_members', 'INSERT', { ...row });
      }
      return { data: true };
    }
    if (name === 'mark_messages_read') {
      for (const m of T('messages')) if (m.recipient_id === user.id && m.sender_id === args.p_sender_id && !m.read_at) m.read_at = now().toISOString();
      return { data: null };
    }
    return { error: { message: 'function ' + name + ' does not exist', code: '42883' } };
  }

  // ---- storage ----
  const folder = p => String(p).split('/')[0];
  const canRead = (uid, p) => folder(p) === uid || T('room_vocals').some(v => v.file_path === p && member(uid, v.room_code));
  function storage(user, body, req) {
    const { op, path } = body;
    if (!user) return { status: 401, error: { message: 'Unauthorized' } };
    if (op === 'upload') {
      if (folder(path) !== user.id || String(path).includes('..')) return { status: 403, error: { message: RLS.message } };
      if (S.objects.has(path)) return { status: 409, error: { message: 'The resource already exists' } };
      const bytes = Buffer.from(body.base64 || '', 'base64');
      if (bytes.length > 25 * 1024 * 1024) return { status: 413, error: { message: 'The object exceeded the maximum allowed size' } };
      if (!/^audio\//.test(body.type || '')) return { status: 415, error: { message: 'mime type ' + body.type + ' is not supported' } };
      S.objects.set(path, { bytes, type: body.type }); S.log.push({ kind: 'upload', path, size: bytes.length, by: user.id });
      return { data: { path } };
    }
    if (op === 'sign') {
      if (!S.objects.has(path) || !canRead(user.id, path)) return { status: 400, error: { message: 'Object not found' } };
      const token = crypto.randomBytes(12).toString('hex'); S.signed.set(token, { path, exp: Date.now() + (body.expiresIn || 3600) * 1000 });
      return { data: { signedUrl: `${req.origin}/__sb/object/${token}` } };
    }
    if (op === 'remove') {
      const removed = [];
      for (const p of body.paths || []) if (folder(p) === user.id && S.objects.delete(p)) removed.push({ name: p });
      S.log.push({ kind: 'remove', paths: body.paths, by: user.id });
      return { data: removed };
    }
    return { status: 400, error: { message: 'bad storage op' } };
  }

  // ---- auth ----
  function auth(body) {
    const { op, email, password } = body;
    const session = u => ({ access_token: 'tok_' + u.id, refresh_token: 'r_' + u.id, expires_in: 3600, user: { id: u.id, email: u.email, user_metadata: {} } });
    const e = String(email || '').trim().toLowerCase();
    if (op === 'signUp') {
      if (!e || !password || password.length < 6) return { error: { message: 'Password should be at least 6 characters', status: 422 } };
      if (S.users.has(e)) return { error: { message: 'User already registered', status: 422 } };
      const u = { id: uuid(), email: e, password }; S.users.set(e, u);
      return { data: { user: session(u).user, session: session(u) } };
    }
    if (op === 'signIn') {
      const u = S.users.get(e);
      if (!u || u.password !== password) return { error: { message: 'Invalid login credentials', status: 400 } };
      return { data: { user: session(u).user, session: session(u) } };
    }
    if (op === 'reset' || op === 'update') return { data: {} };
    return { error: { message: 'bad auth op' } };
  }

  // ---- HTTP entry ----
  async function handle(req, res, origin) {
    const url = new URL(req.url, origin);
    const p = url.pathname;
    const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (p.startsWith('/__sb/object/')) {
      const rec = S.signed.get(p.split('/').pop());
      if (!rec || rec.exp < Date.now()) return (res.writeHead(403), res.end('expired or invalid'), true);
      const o = S.objects.get(rec.path); if (!o) return (res.writeHead(404), res.end('gone'), true);
      res.writeHead(200, { 'content-type': o.type, 'content-length': o.bytes.length }); res.end(o.bytes); return true;
    }
    if (p.startsWith('/api/')) return handleApi(req, res, p, send);
    if (!p.startsWith('/__sb/')) return false;
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
    const user = userFrom(req);
    const f = S.fail.find(f => f.times > 0 && f.match(p, body)); if (f) { f.times--; return send(f.status || 500, { error: { message: 'injected fault', status: f.status || 500 } }), true; }
    S.log.push({ kind: 'req', path: p, op: body.op, table: body.table });
    if (p === '/__sb/q') return send(200, query(user, body)), true;
    if (p === '/__sb/rpc') return send(200, rpc(user, body.name, body.args || {})), true;
    if (p === '/__sb/auth') return send(200, auth(body)), true;
    if (p === '/__sb/storage') { const r = storage(user, body, { origin }); return send(r.status || 200, r.error ? { error: r.error } : r), true; }
    if (p === '/__sb/events') {
      const since = Number(url.searchParams.get('since') || 0);
      const ev = S.events.filter(e => e.seq > since && user && (!e.new || P[e.table]?.sel(user.id, e.new)) && (e.new || P[e.table]?.sel(user.id, e.old)));
      return send(200, { events: ev, seq: S.seq }), true;
    }
    return send(404, { error: 'unknown fake endpoint ' + p }), true;
  }
  function handleApi(req, res, p, send) {
    S.log.push({ kind: 'api', path: p, method: req.method });
    if (p === '/api/pro-status') return send(200, { entitlement: S.api.entitlement, pro: !!S.api.entitlement }), true;
    if (p === '/api/pro-trial') { S.api.entitlement = S.api.entitlement || { plan: 'trial', status: 'active', expires_at: new Date(Date.now() + 30 * 864e5).toISOString() }; return send(200, { entitlement: S.api.entitlement }), true; }
    if (p === '/api/pro-plans') return send(200, { currency: 'USD', plans: [] }), true;
    return send(503, { error: 'not available in e2e' }), true;
  }

  return { state: S, handle, now, tables: S.tables, objects: S.objects, signIn: auth };
}
