// Pesapal API 3.0 helpers + shared payment settlement (used by verify + IPN).
import { sbBase, sbHeaders, PLANS, planAmount, proCurrency, getEntitlement, upsertEntitlement, findPending } from './_pro.js';

export function pesapalBase() {
  // Default to sandbox so a missing setting can never take live payments by accident.
  const live = String(process.env.PESAPAL_ENV || 'sandbox').toLowerCase() === 'live';
  return live ? 'https://pay.pesapal.com/v3/api' : 'https://cybqa.pesapal.com/pesapalv3/api';
}

let tokenCache = { token: null, exp: 0, base: '' };

export async function getToken() {
  const base = pesapalBase();
  if (tokenCache.token && tokenCache.base === base && Date.now() < tokenCache.exp - 30000) return tokenCache.token;
  const key = process.env.PESAPAL_CONSUMER_KEY;
  const secret = process.env.PESAPAL_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('Pesapal credentials are not configured');
  const r = await fetch(`${base}/Auth/RequestToken`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ consumer_key: key, consumer_secret: secret })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.token) throw new Error(`Pesapal auth failed: ${d?.error?.message || d?.message || r.status}`);
  let exp = d.expiryDate ? new Date(d.expiryDate).getTime() : NaN;
  if (!Number.isFinite(exp)) exp = Date.now() + 4 * 60000;
  exp = Math.min(exp, Date.now() + 4.5 * 60000);
  tokenCache = { token: d.token, exp, base };
  return d.token;
}

async function authed(path, init = {}) {
  const token = await getToken();
  const r = await fetch(`${pesapalBase()}${path}`, {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) }
  });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

let ipnCache = { key: '', id: '' };

// Pesapal needs a registered IPN id (notification_id) for every order.
// Use PESAPAL_IPN_ID if you set one, otherwise find/register it automatically.
export async function getIpnId(appUrl) {
  if (process.env.PESAPAL_IPN_ID) return process.env.PESAPAL_IPN_ID;
  const url = `${appUrl}/api/pesapal-ipn`;
  const cacheKey = `${pesapalBase()}|${url}`;
  if (ipnCache.key === cacheKey && ipnCache.id) return ipnCache.id;
  const norm = s => String(s || '').trim().replace(/\/$/, '').toLowerCase();
  let id = null;
  const list = await authed('/URLSetup/GetIpnList');
  if (list.ok && Array.isArray(list.data)) {
    const hit = list.data.find(x => norm(x.url) === norm(url) && x.ipn_id);
    if (hit) id = hit.ipn_id;
  }
  if (!id) {
    const reg = await authed('/URLSetup/RegisterIPN', { method: 'POST', body: JSON.stringify({ url, ipn_notification_type: 'GET' }) });
    if (!reg.ok || !reg.data?.ipn_id) throw new Error(`Pesapal IPN registration failed: ${reg.data?.error?.message || reg.status}`);
    id = reg.data.ipn_id;
  }
  ipnCache = { key: cacheKey, id };
  return id;
}

export async function submitOrder({ ref, amount, currency, description, callbackUrl, cancelUrl, ipnId, email, name }) {
  const first = String(name || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40);
  const res = await authed('/Transactions/SubmitOrderRequest', {
    method: 'POST',
    body: JSON.stringify({
      id: ref, currency, amount, description: String(description).slice(0, 100),
      callback_url: callbackUrl, cancellation_url: cancelUrl, notification_id: ipnId,
      billing_address: { email_address: email, first_name: first || undefined }
    })
  });
  const d = res.data || {};
  if (!res.ok || !d.order_tracking_id || !d.redirect_url) {
    throw new Error(`Pesapal order failed: ${d?.error?.message || d?.message || res.status}`);
  }
  return { orderTrackingId: d.order_tracking_id, redirectUrl: d.redirect_url, raw: d };
}

export async function getTransactionStatus(orderTrackingId) {
  const res = await authed(`/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`);
  if (!res.ok || !res.data) throw new Error(`Pesapal status lookup failed: ${res.status}`);
  return res.data;
}

async function patchTx(txRef, body, extraFilter = '') {
  const r = await fetch(`${sbBase()}/rest/v1/pro_transactions?tx_ref=eq.${encodeURIComponent(txRef)}${extraFilter}`, {
    method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error(`Transaction update failed: ${await r.text()}`);
  return r.json();
}

/**
 * Verify a Pesapal payment server-side and grant Pro exactly once.
 * Never trusts the browser or the IPN body: status comes from GetTransactionStatus.
 * Returns { state: 'completed'|'pending'|'failed'|'reversed'|'mismatch', entitlement? }
 */
export async function settleTransaction({ txRef, orderTrackingId, recheck = false }) {
  const pending = await findPending(txRef);
  if (!pending) return { state: 'unknown' };
  if (pending.provider_transaction_id && orderTrackingId && pending.provider_transaction_id !== orderTrackingId) {
    return { state: 'mismatch' };
  }
  const trackingId = orderTrackingId || pending.provider_transaction_id;
  if (!trackingId) return { state: 'pending' };

  if (pending.status === 'successful' && !recheck) {
    return { state: 'completed', entitlement: await getEntitlement(pending.user_id) };
  }

  const st = await getTransactionStatus(trackingId);
  const code = Number(st.status_code);

  // Confirm the provider reference before considering status or amount.
  if (String(st.merchant_reference || '') !== txRef) return { state: 'mismatch' };

  if (code === 3) { // REVERSED
    // Revoke by the exact transaction reference regardless of the transaction
    // row's current status. A prior worker may have written the entitlement but
    // failed before finalizing the transaction, leaving status='processing'.
    // Reversal must still remove that partially-settled entitlement.
    await patchTx(txRef, { status: 'failed', provider_response: st });
    const revoke = await fetch(`${sbBase()}/rest/v1/pro_entitlements?user_id=eq.${encodeURIComponent(pending.user_id)}&tx_ref=eq.${encodeURIComponent(txRef)}`, {
      method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'revoked', updated_at: new Date().toISOString() })
    });
    if (!revoke.ok) throw new Error('Could not revoke entitlement for reversed payment');
    return { state: 'reversed' };
  }
  if (code === 2) { // FAILED (customer may still retry on the same order)
    if (pending.status !== 'successful') await patchTx(txRef, { status: 'failed', provider_response: st });
    return { state: 'failed' };
  }
  if (code !== 1) return { state: 'pending' }; // not yet confirmed as paid

  const plan = PLANS[pending.plan];
  const configuredAmount = planAmount(pending.plan);
  const configuredCurrency = proCurrency();
  const currencyOk = String(st.currency || '').toUpperCase() === String(pending.currency || '').toUpperCase()
    && String(pending.currency || '').toUpperCase() === configuredCurrency;
  const paid = Number(st.amount);
  const expected = Number(pending.amount);
  const amountOk = Number.isFinite(paid) && Number.isFinite(expected)
    && Number.isFinite(configuredAmount)
    && Math.abs(paid - expected) < 0.005
    && Math.abs(expected - configuredAmount) < 0.005;
  if (!plan || !currencyOk || !amountOk) {
    console.error('pesapal mismatch', { txRef, paid: st.amount, currency: st.currency, expected: pending.amount, expectedCurrency: pending.currency, configuredAmount, configuredCurrency });
    return { state: 'mismatch' };
  }

  // Recovery happens only after the provider has again confirmed a successful,
  // matching payment; a later reversal must never be hidden by recovery logic.
  if (pending.status === 'processing') {
    const current = await getEntitlement(pending.user_id);
    if (current?.tx_ref === txRef) {
      const finalized = await patchTx(txRef, { status: 'successful', provider_transaction_id: String(trackingId), provider_response: st }, '&status=eq.processing');
      if (!finalized.length) return { state: 'pending' };
      return { state: 'completed', entitlement: current };
    }
    const updated = Date.parse(pending.updated_at || '');
    if (Number.isFinite(updated) && Date.now() - updated < 120000) return { state: 'pending' };
  }

  // Claim settlement before writing an entitlement. A concurrent callback sees
  // `processing` and cannot also extend the subscription. Only reclaim a stale
  // processing claim after the previous worker has had time to finish.
  const staleBefore = new Date(Date.now() - 120000).toISOString();
  let claimed = [];
  if (pending.status === 'processing') {
    claimed = await patchTx(txRef, {
      status: 'processing', provider_transaction_id: String(trackingId), provider_response: st
    }, `&status=eq.processing&updated_at=lt.${encodeURIComponent(staleBefore)}`);
  } else {
    claimed = await patchTx(txRef, {
      status: 'processing', provider_transaction_id: String(trackingId), provider_response: st
    }, '&status=in.(pending,failed)');
  }
  if (!claimed.length) {
    const latest = await findPending(txRef);
    if (latest?.status === 'successful') return { state: 'completed', entitlement: await getEntitlement(latest.user_id) };
    return { state: 'pending' };
  }

  try {
    const current = await getEntitlement(pending.user_id);
    if (current?.plan === 'lifetime') {
      await patchTx(txRef, { status: 'successful', provider_transaction_id: String(trackingId) }, '&status=eq.processing');
      return { state: 'completed', entitlement: current };
    }
    const baseTime = current?.expires_at ? Math.max(Date.now(), new Date(current.expires_at).getTime()) : Date.now();
    const expiresAt = plan.days ? new Date(baseTime + plan.days * 864e5).toISOString() : null;
    const entitlement = await upsertEntitlement({
      userId: pending.user_id, plan: pending.plan, source: 'pesapal', provider: 'pesapal',
      providerTxId: trackingId, txRef, amount: paid, currency: String(pending.currency), expiresAt
    });
    const finalized = await patchTx(txRef, { status: 'successful', provider_transaction_id: String(trackingId), provider_response: st }, '&status=eq.processing');
    if (!finalized.length) throw new Error('Could not finalize payment transaction');
    return { state: 'completed', entitlement };
  } catch (e) {
    // Keep the processing marker if an entitlement may already have been written;
    // a retry will inspect tx_ref and avoid extending the same payment twice.
    console.error('pesapal settlement failed', { txRef, message: String(e?.message || e) });
    throw e;
  }
}
