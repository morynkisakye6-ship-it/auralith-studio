// Shared helpers for Tapehead Pro server-side entitlements.
export async function getBearerUser(req) {
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

export function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

export function sbBase() { return String(process.env.SUPABASE_URL || '').replace(/\/$/, ''); }

export const PLANS = {
  month: { label: 'Monthly', days: 30, price: 4.99, env: 'PRO_MONTHLY_PRICE' },
  year: { label: 'Yearly', days: 365, price: 29, env: 'PRO_YEARLY_PRICE' },
  lifetime: { label: 'Lifetime', days: null, price: 49, env: 'PRO_LIFETIME_PRICE' }
};

// Tapehead Pro currency: USD by default. Set PRO_CURRENCY=UGX to charge in Ugandan shillings.
// Only these two values are accepted, so a stray env var can never change the charged currency.
export const PRO_CURRENCY = String(process.env.PRO_CURRENCY || 'USD').toUpperCase() === 'UGX' ? 'UGX' : 'USD';
export function proCurrency() {
  return PRO_CURRENCY;
}
const UGX_DEFAULTS = { month: 25000 };

/**
 * Resolve the canonical public origin for payment redirects and provider IPNs.
 * Never trust the request Origin header for payment URLs: a caller can spoof it
 * and cause provider callbacks/redirects to point at an attacker-controlled host.
 * Configure PUBLIC_APP_URL explicitly in each deployment.
 */
export function publicAppUrl() {
  const raw = String(process.env.PUBLIC_APP_URL || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash) return '';
    if (url.pathname && url.pathname !== '/') return '';
    if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local && url.protocol === 'http:')) return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

export function planAmount(planId) {
  const plan = PLANS[planId];
  if (!plan) return null;
  const raw = process.env[plan.env];
  const fallback = PRO_CURRENCY === 'UGX' ? UGX_DEFAULTS[planId] : plan.price;
  if (raw === undefined || raw === '') { if (fallback == null) return null; }
  const amount = Number(raw !== undefined && raw !== '' ? raw : fallback);
  if (PRO_CURRENCY === 'UGX') return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

export async function getEntitlement(userId) {
  const base = sbBase();
  if (!base || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const r = await fetch(`${base}/rest/v1/pro_entitlements?user_id=eq.${encodeURIComponent(userId)}&status=eq.active&select=*`, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Entitlement lookup failed');
  const rows = await r.json();
  const row = rows[0] || null;
  if (!row) return null;
  if (row.expires_at && Date.now() >= new Date(row.expires_at).getTime()) return null;
  return row;
}

export async function upsertEntitlement({ userId, plan, source, provider, providerTxId, txRef, amount, currency, expiresAt }) {
  const base = sbBase();
  const body = {
    user_id: userId, plan, status: 'active', source: source || 'payment',
    provider: provider || 'pesapal', provider_tx_id: providerTxId ? String(providerTxId) : null,
    tx_ref: txRef || null, amount: amount ?? null, currency: currency || null,
    started_at: new Date().toISOString(), expires_at: expiresAt || null, updated_at: new Date().toISOString()
  };
  const r = await fetch(`${base}/rest/v1/pro_entitlements?on_conflict=user_id`, {
    method: 'POST', headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Entitlement write failed: ${await r.text()}`);
  const rows = await r.json();
  return rows[0] || body;
}

export async function findPending(txRef) {
  const base = sbBase();
  const r = await fetch(`${base}/rest/v1/pro_transactions?tx_ref=eq.${encodeURIComponent(txRef)}&select=*&limit=1`, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Transaction lookup failed');
  const rows = await r.json();
  return rows[0] || null;
}
