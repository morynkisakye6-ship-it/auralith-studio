import { getBearerUser } from './_pro.js';
import { findPending } from './_pro.js';
import { settleTransaction } from './_pesapal.js';
import { rateLimit } from './security.js';

function json(res, status, body) { res.status(status).json(body); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
  const ipLimit = await rateLimit(req, { name: 'verify-ip', limit: 40, windowMs: 60_000 });
  if (!ipLimit.ok) { res.setHeader('Retry-After', String(ipLimit.retryAfter || 60)); return json(res, 429, { error: 'Too many requests. Try again shortly.' }); }
  try {
    const user = await getBearerUser(req);
    if (!user?.id) return json(res, 401, { error: 'Sign in required.' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const txRef = String(body.tx_ref || '').trim().slice(0, 60);
    const orderTrackingId = String(body.order_tracking_id || '').trim().slice(0, 80);
    if (!txRef) return json(res, 400, { error: 'Missing payment reference.' });
    const pending = await findPending(txRef);
    if (!pending || pending.user_id !== user.id) return json(res, 404, { error: 'Payment reference not found.' });

    const result = await settleTransaction({ txRef, orderTrackingId });
    if (result.state === 'completed') return json(res, 200, { ok: true, entitlement: result.entitlement });
    if (result.state === 'pending') return json(res, 202, { pending: true, error: 'Payment is still processing. Pro will activate as soon as Pesapal confirms it.' });
    return json(res, 400, { error: 'Payment could not be verified.' });
  } catch (e) {
    console.error('pro-verify', e);
    return json(res, 500, { error: 'Payment verification failed.' });
  }
}
