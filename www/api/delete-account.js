import { rateLimit } from './security.js';
// Permanently delete the authenticated Auralith account.
// Requires SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.
function json(res, status, body) { res.status(status).json(body); }

async function verifyUser(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!token || !base || !anon) return null;
  const r = await fetch(`${base}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return r.json();
}

async function listUserObjects(base, headers, userId) {
  const found = [];
  const visited = new Set();
  const pageSize = 500;

  async function walk(prefix) {
    if (visited.has(prefix)) throw new Error('Storage folder cycle detected');
    visited.add(prefix);
    for (let offset = 0; ; offset += pageSize) {
      const r = await fetch(`${base}/storage/v1/object/list/vocals`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } })
      });
      if (!r.ok) throw new Error(`Storage listing failed (${r.status})`);
      const rows = await r.json();
      if (!Array.isArray(rows)) throw new Error('Unexpected storage listing response');
      for (const item of rows) {
        if (!item || typeof item.name !== 'string' || !item.name || item.name.includes('/') || item.name.includes('\\') || item.name === '.' || item.name === '..') {
          throw new Error('Invalid storage listing entry');
        }
        const objectPath = `${prefix}${item.name}`;
        // Storage folder entries have no object id; descend rather than attempting
        // to delete a folder as if it were a file.
        if (item.id == null && item.metadata == null) {
          await walk(`${objectPath}/`);
        } else {
          found.push(objectPath);
        }
      }
      if (rows.length < pageSize) break;
    }
  }

  await walk(`${userId}/`);
  return found;
}

async function deleteUserObjects(base, headers, paths) {
  // Keep batches bounded to avoid oversized requests. Do not delete the auth user
  // unless every storage deletion has been confirmed successful.
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const r = await fetch(`${base}/storage/v1/object/vocals`, {
      method: 'DELETE',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: batch })
    });
    if (!r.ok) throw new Error(`Storage deletion failed (${r.status})`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
  const limit = await rateLimit(req, { name: 'delete-account', limit: 5, windowMs: 60_000 });
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter || 60));
    return json(res, 429, { error: 'Too many account-deletion attempts. Try again later.' });
  }
  try {
    const user = await verifyUser(req);
    if (!user?.id) return json(res, 401, { error: 'Sign in required.' });
    const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) return json(res, 503, { error: 'Account deletion is temporarily unavailable. Contact burstcomepsp@gmail.com.' });
    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    // Fail closed: preserve the account if storage cannot be enumerated or cleaned.
    // This avoids reporting successful deletion while leaving private audio behind.
    const objects = await listUserObjects(base, headers, user.id);
    if (objects.length) await deleteUserObjects(base, headers, objects);

    const del = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', headers });
    if (!del.ok) {
      const detail = await del.text().catch(() => '');
      console.error('delete auth user failed', del.status, detail);
      return json(res, 502, { error: 'Could not delete the account. Private audio cleanup completed; contact support if this persists.' });
    }
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error('delete-account error', e);
    return json(res, 502, { error: 'Account deletion could not be completed safely. Your account has not been removed; contact support if this persists.' });
  }
}
