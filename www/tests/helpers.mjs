// Shared test harness: a stateful fake of Supabase (auth, PostgREST, RPC, storage) and Pesapal,
// installed as globalThis.fetch. No network, no dependencies. Requests are handled atomically
// (one JS turn each), like a single Postgres statement, so concurrent callbacks interleave only
// BETWEEN requests, which is exactly the race the production code must survive.
import vm from 'node:vm';
import fs from 'node:fs';

export const SB = 'https://sb.test';
export function setEnv(extra = {}) {
  Object.assign(process.env, {
    SUPABASE_URL: SB, SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    PESAPAL_CONSUMER_KEY: 'ck', PESAPAL_CONSUMER_SECRET: 'cs', PESAPAL_ENV: 'sandbox',
    PESAPAL_IPN_ID: 'ipn-1', PUBLIC_APP_URL: 'https://auralith.example', OPENAI_API_KEY: 'sk-test',
    JOBS_PROCESS_SECRET: '', CRON_SECRET: ''
  }, extra);
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
}

let ipCounter = 0;
export const freshIp = () => `10.${(++ipCounter >> 8) & 255}.${ipCounter & 255}.${(ipCounter * 7) & 255}`;

export function mockReq({ method = 'POST', token, body, query = {}, headers = {} } = {}) {
  return { method, query, body, headers: { 'x-real-ip': freshIp(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } };
}
export function mockRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
export async function call(handler, reqOpts) { const res = mockRes(); await handler(mockReq(reqOpts), res); return res; }

const matchFilter = (row, [k, v]) => {
  if (['select', 'limit', 'order', 'on_conflict'].includes(k)) return true;
  const val = row[k];
  if (v.startsWith('eq.')) return String(val) === v.slice(3);
  if (v.startsWith('neq.')) return String(val) !== v.slice(4);
  if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(val));
  if (v.startsWith('lt.')) return Date.parse(val) < Date.parse(v.slice(3));
  throw new Error('fake PostgREST: unsupported filter ' + k + '=' + v);
};

export function makeCloud() {
  const c = {
    users: {},                 // token -> { id, email }
    entitlements: [], txs: [], jobs: [], trialClaims: new Set(), aiUsed: {}, aiLimitSeen: [],
    storage: new Map(),        // object path -> true
    log: [],                   // every request: { method, url, body }
    entitlementWrites: 0, openaiCalls: 0, authDeletes: [], storageDeletes: [],
    pesapalStatus: {},         // orderTrackingId -> status payload
    aiRpcMissing: false, faults: []
  };
  c.addUser = (token, id, email = id + '@x.test') => { c.users[token] = { id, email }; };
  // fault(pred, { status, times }) makes matching requests fail (times = Infinity by default)
  c.fault = (pred, opts = {}) => { c.faults.push({ pred, status: opts.status || 500, times: opts.times ?? Infinity }); };
  c.countLog = pred => c.log.filter(pred).length;

  const R = (body, status = 200) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  c.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    let body; try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    const entry = { method, url: String(url), body, headers: init.headers || {} };
    c.log.push(entry);
    for (const f of c.faults) if (f.times > 0 && f.pred(method, String(url), body)) { f.times--; return R({ message: 'injected fault' }, f.status); }
    const p = u.pathname, filters = [...u.searchParams.entries()];
    const rows = tbl => c[tbl].filter(r => filters.every(f => matchFilter(r, f)));

    if (u.origin === SB) {
      if (p === '/auth/v1/user') {
        const t = String(init.headers?.Authorization || '').replace('Bearer ', '');
        return c.users[t] ? R(c.users[t]) : R({ message: 'bad jwt' }, 401);
      }
      if (p.startsWith('/auth/v1/admin/users/') && method === 'DELETE') { c.authDeletes.push(decodeURIComponent(p.split('/').pop())); return R({}); }
      if (p === '/rest/v1/pro_entitlements') {
        if (method === 'GET') return R(rows('entitlements'));
        if (method === 'POST') { c.entitlementWrites++; const i = c.entitlements.findIndex(e => e.user_id === body.user_id); if (i >= 0) c.entitlements[i] = { ...c.entitlements[i], ...body }; else c.entitlements.push({ ...body }); return R([c.entitlements.find(e => e.user_id === body.user_id)]); }
        if (method === 'PATCH') { const hit = rows('entitlements'); hit.forEach(r => Object.assign(r, body)); return R(hit); }
      }
      if (p === '/rest/v1/pro_transactions') {
        if (method === 'GET') return R(rows('txs'));
        if (method === 'POST') { c.txs.push({ updated_at: new Date().toISOString(), ...body }); return R([c.txs.at(-1)]); }
        if (method === 'PATCH') { const hit = rows('txs'); hit.forEach(r => Object.assign(r, body)); return R(hit); }
      }
      if (p === '/rest/v1/tapehead_jobs') {
        if (method === 'GET') return R(rows('jobs'));
        if (method === 'POST') { const j = { id: 'job_' + (c.jobs.length + 1), created_at: new Date().toISOString(), ...body }; c.jobs.push(j); return R([j]); }
        if (method === 'PATCH') { const hit = rows('jobs'); hit.forEach(r => Object.assign(r, body)); return R(hit); }
      }
      if (p === '/rest/v1/rpc/claim_pro_trial') { if (c.trialClaims.has(body.p_user_id)) return R(false); c.trialClaims.add(body.p_user_id); return R(true); }
      if (p === '/rest/v1/rpc/reserve_ai_usage') {
        if (c.aiRpcMissing) return R({ message: 'not found' }, 404);
        c.aiLimitSeen.push(body.p_limit);
        const n = (c.aiUsed[body.p_user_id] || 0); if (n >= body.p_limit) return R(false);
        c.aiUsed[body.p_user_id] = n + 1; return R(true);
      }
      if (p === '/rest/v1/rpc/claim_tapehead_job') return R(null);
      if (p === '/storage/v1/object/list/vocals' && method === 'POST') {
        const { prefix, limit, offset } = body, seen = new Map();
        for (const k of [...c.storage.keys()].sort()) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length), seg = rest.split('/')[0];
          seen.set(seg, rest.includes('/') ? { name: seg, id: null, metadata: null } : { name: seg, id: 'o_' + seg, metadata: { size: 1 } });
        }
        return R([...seen.values()].slice(offset, offset + limit));
      }
      if (p === '/storage/v1/object/vocals' && method === 'DELETE') { for (const k of body.prefixes) { c.storage.delete(k); c.storageDeletes.push(k); } return R([]); }
    }
    if (u.hostname.includes('pesapal.com')) {
      if (p.endsWith('/Auth/RequestToken')) return R({ token: 'pp-token', expiryDate: new Date(Date.now() + 5 * 60000).toISOString() });
      if (p.endsWith('/Transactions/GetTransactionStatus')) {
        const st = c.pesapalStatus[u.searchParams.get('orderTrackingId')];
        return st ? R(st) : R({ error: { message: 'not found' } }, 404);
      }
    }
    if (u.hostname === 'api.openai.com') { c.openaiCalls++; return R({ output_text: 'generated lyrics', output: [] }); }
    throw new Error(`fake fetch: unhandled ${method} ${url}`);
  };
  return c;
}

export async function install(cloud) {
  globalThis.fetch = cloud.fetch;
  try { (await import('../api/security.js')).__resetRateLimitsForTests(); } catch {}
  return cloud;
}

/** Standard seeded scenario for payment tests. */
export async function paymentScenario(over = {}) {
  const c = await install(makeCloud());
  c.addUser('tok-u1', 'u1'); c.addUser('tok-u2', 'u2');
  c.txs.push({ tx_ref: 'TX1', user_id: 'u1', plan: 'month', amount: 4.99, currency: 'USD', status: 'pending', provider_transaction_id: 'trk1', updated_at: new Date(Date.now() - 600000).toISOString(), ...over });
  c.pesapalStatus.trk1 = { status_code: 1, merchant_reference: 'TX1', amount: 4.99, currency: 'USD' };
  return c;
}

/** Load js/cloud.js (browser module) into a vm sandbox with a fake Supabase client. */
export function loadCloudModule(fakeSb, authUser, opts = {}) {
  const toasts = [], errors = [];
  const win = { toast: m => toasts.push(m), AURALITH_CLOUD: {} };
  const ctx = vm.createContext({ window: win, console: { log() {}, warn() {}, error: (...a) => errors.push(a) }, navigator: {}, setTimeout, clearTimeout, Date, Promise, JSON, Math, URL, Blob, Uint8Array });
  // project-sync.js is a sibling module that cloud.js uses (via window.AuralithProjectSync) when present.
  if (!opts.withoutSync) vm.runInContext(fs.readFileSync(new URL('../js/project-sync.js', import.meta.url), 'utf8'), ctx, { filename: 'project-sync.js' });
  vm.runInContext(fs.readFileSync(new URL('../js/cloud.js', import.meta.url), 'utf8'), ctx, { filename: 'cloud.js' });
  const Cloud = win.AuralithCloud;
  Cloud.mode = 'cloud'; Cloud.sb = fakeSb; Cloud.currentAuthUser = async () => authUser;
  return { Cloud, toasts, errors, win };
}

/** Minimal chainable Supabase client fake that records calls and supports per-step failures. */
export function fakeSupabase({ fail = {}, data = {} } = {}) {
  const calls = [];
  // fail[key] may be `true`, an error object, or a function(callNumber) returning an error object / falsy (programmable faults).
  const counts = {};
  const res = (key, ok = { data: data[key] ?? null, error: null }) => {
    let f = fail[key];
    if (typeof f === 'function') { counts[key] = (counts[key] || 0) + 1; f = f(counts[key]); }
    if (!f) return ok;
    return { data: null, error: f === true ? { message: 'injected ' + key } : f };
  };
  const chain = (table, op) => {
    const q = { filters: [], eq(c, v) { q.filters.push([c, 'eq', v]); return q; }, in(c, v) { q.filters.push([c, 'in', v]); return q; }, select() { return q; }, single() { return q; },
      then(r, j) {
        calls.push(['db', table, op, q.payload, q.filters]);
        const out = res(`${table}.${op}`);
        if (!out.error && op === 'delete' && sbTables[table]) {
          for (const [id, row] of [...sbTables[table]]) if (q.filters.every(([c, k, v]) => (k === 'eq' ? row[c] === v : v.includes(row[c])))) sbTables[table].delete(id);
        }
        return Promise.resolve(out).then(r, j);
      } };
    return q;
  };
  const sbTables = { projects: new Map() };
  return {
    calls,
    storage: { from: () => ({
      upload: async (path, _f, opts) => { calls.push(['upload', path, opts]); return res('upload'); },
      createSignedUrl: async path => { calls.push(['sign', path]); return fail.sign ? { data: null, error: { message: 'sign failed' } } : { data: { signedUrl: 'https://s.test/' + path }, error: null }; },
      remove: async paths => { calls.push(['remove', paths]); return res('remove'); }
    }) },
    tables: sbTables,
    from: table => ({ upsert: rows => { const c = chain(table, 'upsert'); c.payload = rows; const t = c.then; c.then = (r, j) => { const out = res(`${table}.upsert`); if (!out.error && sbTables[table]) (Array.isArray(rows) ? rows : [rows]).forEach(x => sbTables[table].set(x.id, x)); calls.push(['db', table, 'upsert', rows]); return Promise.resolve(out).then(r, j); }; return c; }, delete: () => chain(table, 'delete'), insert: p => { const c = chain(table, 'insert'); c.payload = p; return c; }, update: () => chain(table, 'update'), select: () => chain(table, 'select') }),
    rpc: async (name, args) => { calls.push(['rpc', name, args]); return res('rpc.' + name, { data: true, error: null }); }
  };
}
