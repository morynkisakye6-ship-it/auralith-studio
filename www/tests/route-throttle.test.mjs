import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setEnv, makeCloud, install, mockReq, mockRes } from './helpers.mjs';
setEnv();
const trial = (await import('../api/pro-trial.js')).default;
const checkout = (await import('../api/pro-checkout.js')).default;
const ipn = (await import('../api/pesapal-ipn.js')).default;
const del = (await import('../api/delete-account.js')).default;

async function hammer(handler, n, opts) {
  const codes = []; let retry;
  for (let i = 0; i < n; i++) { const res = mockRes(); await handler(mockReq({ ...opts, headers: { 'x-real-ip': '203.0.113.9' } }), res); codes.push(res.statusCode); if (res.statusCode === 429) retry = res.headers['Retry-After']; }
  return { codes, retry };
}
const setup = async () => { const c = await install(makeCloud()); c.addUser('t', 'u1'); return c; };

test('throttle: pro-trial returns 429 + Retry-After once an IP exceeds its limit', async () => {
  await setup();
  const { codes, retry } = await hammer(trial, 20, { token: 't' });
  assert.ok(codes.slice(0, 15).every(c => c !== 429));
  assert.ok(codes.slice(15).every(c => c === 429), codes.join());
  assert.ok(Number(retry) >= 1);
});

test('throttle: account deletion is limited to 5 attempts/minute per IP', async () => {
  await setup();
  const { codes } = await hammer(del, 8, { token: 'bad' });
  assert.deepEqual(codes.map(c => c === 429), [false, false, false, false, false, true, true, true]);
});

test('throttle: checkout and IPN endpoints are limited (they trigger paid upstream calls)', async () => {
  await setup();
  assert.ok((await hammer(checkout, 25, { token: 'bad', body: { plan: 'month' } })).codes.includes(429));
  assert.ok((await hammer(ipn, 310, { method: 'GET', query: {} })).codes.includes(429));
});

test('throttle: one abusive IP does not throttle others', async () => {
  await setup();
  await hammer(trial, 20, { token: 't' });
  const res = mockRes(); await trial(mockReq({ token: 't', headers: { 'x-real-ip': '198.51.100.77' } }), res);
  assert.notEqual(res.statusCode, 429);
});

test('throttle: spoofed X-Forwarded-For cannot evade the per-IP limit', async () => {
  await setup();
  const codes = [];
  for (let i = 0; i < 20; i++) {
    const res = mockRes();
    await trial({ method: 'POST', query: {}, body: {}, headers: { authorization: 'Bearer t', 'x-forwarded-for': `1.1.1.${i}, 198.51.100.200` } }, res);
    codes.push(res.statusCode);
  }
  assert.ok(codes.includes(429), 'rightmost proxy hop is the identity, leftmost is attacker-controlled');
});
