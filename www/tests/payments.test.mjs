import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setEnv, paymentScenario, call } from './helpers.mjs';
setEnv();
const { settleTransaction } = await import('../api/_pesapal.js');
const verify = (await import('../api/pro-verify.js')).default;
const ipn = (await import('../api/pesapal-ipn.js')).default;
const settle = () => settleTransaction({ txRef: 'TX1', orderTrackingId: 'trk1' });
const quiet = fn => async () => { const e = console.error; console.error = () => {}; try { await fn(); } finally { console.error = e; } };

test('duplicate callbacks (sequential) grant Pro exactly once', async () => {
  const c = await paymentScenario();
  const out = [await settle(), await settle(), await settle()];
  assert.deepEqual(out.map(o => o.state), ['completed', 'completed', 'completed']);
  assert.equal(c.entitlementWrites, 1, 'entitlement written once');
  assert.equal(c.txs[0].status, 'successful');
});

test('concurrent IPN + verify race cannot double-extend the subscription', async () => {
  const c = await paymentScenario();
  const out = await Promise.all([settle(), settle(), settle(), settle()]);
  assert.equal(c.entitlementWrites, 1, 'only the claim winner writes the entitlement');
  assert.ok(out.some(o => o.state === 'completed'));
  assert.ok(out.every(o => ['completed', 'pending'].includes(o.state)), JSON.stringify(out.map(o => o.state)));
  const days = (Date.parse(c.entitlements[0].expires_at) - Date.now()) / 864e5;
  assert.ok(days > 29 && days < 30.1, 'monthly = 30 days, not 60/90: ' + days);
});

test('wrong amount, currency or merchant reference never grants Pro', async () => {
  for (const bad of [{ amount: 0.01 }, { currency: 'UGX' }, { merchant_reference: 'OTHER' }]) {
    const c = await paymentScenario();
    c.pesapalStatus.trk1 = { ...c.pesapalStatus.trk1, ...bad };
    const r = await settle();
    assert.equal(r.state, 'mismatch', JSON.stringify(bad));
    assert.equal(c.entitlements.length, 0);
    assert.notEqual(c.txs[0].status, 'successful');
  }
});

test('stored amount that differs from the configured plan price is refused', async () => {
  const c = await paymentScenario({ amount: 0.5 });   // tx row tampered/cheap
  c.pesapalStatus.trk1.amount = 0.5;
  assert.equal((await settle()).state, 'mismatch');
  assert.equal(c.entitlements.length, 0);
});

test('callback with a different tracking id than the stored one is rejected', async () => {
  const c = await paymentScenario();
  const r = await settleTransaction({ txRef: 'TX1', orderTrackingId: 'attacker-trk' });
  assert.equal(r.state, 'mismatch');
  assert.equal(c.entitlements.length, 0);
});

test('unpaid / pending / failed statuses grant nothing', async () => {
  for (const code of [0, 2]) {
    const c = await paymentScenario();
    c.pesapalStatus.trk1.status_code = code;
    const r = await settle();
    assert.ok(['pending', 'failed'].includes(r.state));
    assert.equal(c.entitlements.length, 0);
  }
});

test('unknown transaction reference is a no-op', async () => {
  const c = await paymentScenario();
  assert.equal((await settleTransaction({ txRef: 'NOPE', orderTrackingId: 'x' })).state, 'unknown');
  assert.equal(c.entitlements.length, 0);
});

test('reversal after success revokes the entitlement', async () => {
  const c = await paymentScenario();
  await settle();
  assert.equal(c.entitlements[0].status, 'active');
  c.pesapalStatus.trk1.status_code = 3;
  const r = await settleTransaction({ txRef: 'TX1', orderTrackingId: 'trk1', recheck: true });
  assert.equal(r.state, 'reversed');
  assert.equal(c.entitlements[0].status, 'revoked');
  assert.equal(c.txs[0].status, 'failed');
});

test('failure recovery: crash after entitlement write, retry finalizes without extending twice', quiet(async () => {
  const c = await paymentScenario();
  // First attempt: entitlement is written, then finalizing the transaction fails.
  c.fault((m, u, b) => m === 'PATCH' && u.includes('pro_transactions') && b?.status === 'successful', { times: 1 });
  await assert.rejects(settle());
  assert.equal(c.entitlementWrites, 1);
  assert.equal(c.txs[0].status, 'processing', 'claim marker stays so a retry can recover');
  const expiresBefore = c.entitlements[0].expires_at;
  const r = await settle();                      // retry (e.g. provider re-sends the IPN)
  assert.equal(r.state, 'completed');
  assert.equal(c.entitlementWrites, 1, 'retry must not write/extend the entitlement again');
  assert.equal(c.entitlements[0].expires_at, expiresBefore);
  assert.equal(c.txs[0].status, 'successful');
}));

test('failure recovery: crash before entitlement write is retried after the claim goes stale', quiet(async () => {
  const c = await paymentScenario();
  c.fault((m, u) => m === 'POST' && u.includes('pro_entitlements'), { times: 1 });
  await assert.rejects(settle());
  assert.equal(c.entitlements.length, 0);
  assert.equal((await settle()).state, 'pending', 'fresh claim is respected (another worker may be running)');
  c.txs[0].updated_at = new Date(Date.now() - 300000).toISOString();   // claim is now stale
  assert.equal((await settle()).state, 'completed');
  assert.equal(c.entitlementWrites, 1);
}));

test('provider outage while checking status leaves the transaction retryable', quiet(async () => {
  const c = await paymentScenario();
  c.fault((m, u) => u.includes('GetTransactionStatus'), { times: 1, status: 503 });
  await assert.rejects(settle());
  assert.equal(c.entitlements.length, 0);
  assert.equal((await settle()).state, 'completed');
}));

test('lifetime owners are not downgraded or extended by a later monthly payment', async () => {
  const c = await paymentScenario();
  c.entitlements.push({ user_id: 'u1', plan: 'lifetime', status: 'active', expires_at: null, tx_ref: 'OLD' });
  const r = await settle();
  assert.equal(r.state, 'completed');
  assert.equal(c.entitlementWrites, 0);
  assert.equal(c.entitlements[0].plan, 'lifetime');
});

test('pro-verify: requires sign-in and refuses another user\'s transaction', async () => {
  const c = await paymentScenario();
  assert.equal((await call(verify, { body: { tx_ref: 'TX1' } })).statusCode, 401);
  const other = await call(verify, { token: 'tok-u2', body: { tx_ref: 'TX1', order_tracking_id: 'trk1' } });
  assert.equal(other.statusCode, 404);
  assert.equal(c.entitlements.length, 0);
  const owner = await call(verify, { token: 'tok-u1', body: { tx_ref: 'TX1', order_tracking_id: 'trk1' } });
  assert.equal(owner.statusCode, 200);
  assert.equal(c.entitlements[0].user_id, 'u1');
});

test('IPN content is never trusted: forged IPN for an unpaid order grants nothing', async () => {
  const c = await paymentScenario();
  c.pesapalStatus.trk1.status_code = 0;
  const res = await call(ipn, { method: 'GET', query: { OrderTrackingId: 'trk1', OrderMerchantReference: 'TX1', status: 'COMPLETED' } });
  assert.ok([200, 202].includes(res.statusCode));
  assert.equal(c.entitlements.length, 0);
});
