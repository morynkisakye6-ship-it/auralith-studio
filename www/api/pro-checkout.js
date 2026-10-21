import crypto from 'crypto';
import { getBearerUser, sbBase, sbHeaders, PLANS, planAmount, proCurrency, publicAppUrl } from './_pro.js';
import { getIpnId, submitOrder } from './_pesapal.js';
import { rateLimit } from './security.js';

function json(res, status, body) { res.status(status).json(body); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
  const ipLimit = await rateLimit(req, { name: 'checkout-ip', limit: 20, windowMs: 60_000 });
  if (!ipLimit.ok) { res.setHeader('Retry-After', String(ipLimit.retryAfter || 60)); return json(res, 429, { error: 'Too many requests. Try again shortly.' }); }
  try {
    const user = await getBearerUser(req);
    if (!user?.id || !user.email) return json(res, 401, { error: 'Sign in with an email account first.' });
    const userLimit = await rateLimit(req, { name: 'checkout-user', key: user.id, limit: 6, windowMs: 10 * 60_000 });
    if (!userLimit.ok) { res.setHeader('Retry-After', String(userLimit.retryAfter || 60)); return json(res, 429, { error: 'Too many checkout attempts. Try again in a few minutes.' }); }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const planId = String(body.plan || '');
    const plan = PLANS[planId];
    const amount = planAmount(planId);
    const currency = proCurrency();
    if (!plan || !amount || !process.env.PESAPAL_CONSUMER_KEY || !process.env.PESAPAL_CONSUMER_SECRET) {
      return json(res, 503, { error: 'Checkout is temporarily unavailable. Please try again later or contact burstcomepsp@gmail.com.' });
    }
    const origin = publicAppUrl();
    if (!origin) return json(res, 500, { error: 'Checkout could not start. Please try again later.' });

    // Pesapal merchant references: max 50 chars, alphanumeric plus - _ . :
    const txRef = `TH-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
    const base = sbBase();
    const insert = await fetch(`${base}/rest/v1/pro_transactions`, {
      method: 'POST', headers: { ...sbHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: user.id, tx_ref: txRef, plan: planId, amount, currency, status: 'pending' })
    });
    if (!insert.ok) return json(res, 500, { error: 'Could not create payment record.' });

    let order;
    try {
      const ipnId = await getIpnId(origin);
      order = await submitOrder({
        ref: txRef, amount, currency, description: `Auralith Pro ${plan.label}`,
        callbackUrl: `${origin}/?payment=complete`, cancelUrl: `${origin}/?payment=cancelled`,
        ipnId, email: user.email, name: user.user_metadata?.username || user.email.split('@')[0]
      });
    } catch (e) {
      console.error('pro-checkout pesapal', e);
      await fetch(`${base}/rest/v1/pro_transactions?tx_ref=eq.${encodeURIComponent(txRef)}`, {
        method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ status: 'failed', provider_response: { error: String(e.message || e) } })
      }).catch(() => {});
      return json(res, 502, { error: 'Pesapal checkout could not be created.' });
    }

    // Persist the provider tracking ID before returning the payment link. If this
    // write fails, don't hand out a checkout that our own verification flow cannot
    // reliably bind to its provider order.
    const bind = await fetch(`${base}/rest/v1/pro_transactions?tx_ref=eq.${encodeURIComponent(txRef)}&status=eq.pending`, {
      method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({ provider_transaction_id: order.orderTrackingId, provider_response: order.raw, updated_at: new Date().toISOString() })
    });
    if (!bind.ok) {
      console.error('pro-checkout: failed to bind Pesapal tracking ID', { txRef, status: bind.status });
      return json(res, 502, { error: 'Checkout was created but could not be safely linked. Please contact support before retrying.' });
    }
    const boundRows = await bind.json().catch(() => []);
    if (!Array.isArray(boundRows) || boundRows.length !== 1 || boundRows[0]?.provider_transaction_id !== order.orderTrackingId) {
      console.error('pro-checkout: Pesapal tracking ID binding did not update exactly one pending transaction', { txRef });
      return json(res, 502, { error: 'Checkout could not be safely linked. Please contact support before retrying.' });
    }

    return json(res, 200, { link: order.redirectUrl, tx_ref: txRef, plan: planId });
  } catch (e) {
    console.error('pro-checkout', e);
    return json(res, 500, { error: 'Unable to start checkout.' });
  }
}
