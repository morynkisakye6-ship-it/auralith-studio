import { findPending } from './_pro.js';
import { settleTransaction } from './_pesapal.js';
import { rateLimit } from './security.js';

// Pesapal calls this (GET or POST) when a payment status changes.
// The call carries no status and no signature, so we ignore its content beyond the
// identifiers and always confirm the real status with Pesapal before granting anything.
export default async function handler(req, res) {
  // Generous cap: legitimate IPN retries must pass; this only blunts floods that trigger upstream status calls.
  const ipLimit = await rateLimit(req, { name: 'pesapal-ipn', limit: 300, windowMs: 60_000 });
  if (!ipLimit.ok) { res.setHeader('Retry-After', String(ipLimit.retryAfter || 60)); return res.status(429).json({ error: 'Too many requests.' }); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const src = { ...(body && typeof body === 'object' ? body : {}), ...(req.query || {}) };
  const orderTrackingId = String(src.OrderTrackingId || '').trim().slice(0, 80);
  const merchantRef = String(src.OrderMerchantReference || '').trim().slice(0, 60);
  const notificationType = String(src.OrderNotificationType || 'IPNCHANGE').slice(0, 30);
  const reply = status => res.status(200).json({
    orderNotificationType: notificationType, orderTrackingId, orderMerchantReference: merchantRef, status
  });
  if (!orderTrackingId || !merchantRef) return reply(500);
  try {
    const pending = await findPending(merchantRef);
    if (!pending) return reply(200); // not ours / unknown: acknowledge so Pesapal stops retrying
    await settleTransaction({ txRef: merchantRef, orderTrackingId, recheck: true });
    return reply(200);
  } catch (e) {
    console.error('pesapal-ipn', e);
    return reply(500);
  }
}
