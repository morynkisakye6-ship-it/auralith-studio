import { getBearerUser, sbBase, sbHeaders, getEntitlement, upsertEntitlement } from './_pro.js';
import { rateLimit } from './security.js';
function json(res, status, body) { res.status(status).json(body); }
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
  const limit = await rateLimit(req, { name: 'pro-trial', limit: 15, windowMs: 60_000 });
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter || 60));
    return json(res, 429, { error: 'Too many trial requests. Try again later.' });
  }
  try {
    const user = await getBearerUser(req);
    if (!user?.id) return json(res, 401, { error: 'Sign in required.' });
    const existing = await getEntitlement(user.id);
    if (existing) return json(res, 200, { entitlement: existing });
    const base = sbBase();
    if (!base || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(res, 503, { error: 'Trial service is not configured.' });

    // The database unique constraint is the source of truth. A preflight SELECT alone
    // is race-prone: two concurrent sign-up requests could both pass it.
    const claim = await fetch(`${base}/rest/v1/rpc/claim_pro_trial`, {
      method: 'POST', headers: sbHeaders(), body: JSON.stringify({ p_user_id: user.id })
    });
    if (!claim.ok) {
      console.error('pro-trial claim RPC failed', claim.status);
      return json(res, 503, { error: 'Trial service is not fully configured.' });
    }
    const claimed = await claim.json();
    if (!(claimed === true || claimed?.claimed === true)) {
      // A concurrent request may have completed the entitlement after our initial lookup.
      const latest = await getEntitlement(user.id);
      if (latest) return json(res, 200, { entitlement: latest });
      return json(res, 409, { error: 'Trial already used.' });
    }

    const expiresAt = new Date(Date.now() + 30 * 864e5).toISOString();
    try {
      const entitlement = await upsertEntitlement({ userId: user.id, plan: 'trial', source: 'trial', provider: null, providerTxId: null, txRef: null, amount: 0, currency: null, expiresAt });
      return json(res, 200, { entitlement });
    } catch (e) {
      // Fail closed. The durable claim stays in place so a failed write cannot be
      // exploited to repeatedly retry trial creation; an operator can reconcile it.
      console.error('pro-trial entitlement write failed after claim');
      return json(res, 500, { error: 'Could not finish starting trial. Contact support.' });
    }
  } catch (e) { console.error('pro-trial', e); return json(res, 500, { error: 'Could not start trial.' }); }
}
