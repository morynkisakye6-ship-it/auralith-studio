import { getBearerUser, getEntitlement } from './_pro.js';
import { rateLimit } from './security.js';
function json(res, status, body) { res.status(status).json(body); }
export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'GET required' });
  const ipLimit = await rateLimit(req, { name: 'pro-status', limit: 120, windowMs: 60_000 });
  if (!ipLimit.ok) { res.setHeader('Retry-After', String(ipLimit.retryAfter || 60)); return json(res, 429, { error: 'Too many requests.' }); }
  try {
    const user = await getBearerUser(req);
    if (!user?.id) return json(res, 401, { error: 'Sign in required.' });
    return json(res, 200, { entitlement: await getEntitlement(user.id) });
  } catch (e) { console.error('pro-status', e); return json(res, 500, { error: 'Could not load Pro status.' }); }
}
