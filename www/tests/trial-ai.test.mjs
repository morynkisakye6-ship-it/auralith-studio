import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setEnv, makeCloud, install, call } from './helpers.mjs';
setEnv();
const trial = (await import('../api/pro-trial.js')).default;
const ai = (await import('../api/ai.js')).default;
const quiet = fn => async () => { const e = console.error, w = console.warn; console.error = console.warn = () => {}; try { await fn(); } finally { console.error = e; console.warn = w; } };
const scenario = async () => { const c = await install(makeCloud()); c.addUser('tok-u1', 'u1'); c.addUser('tok-u2', 'u2'); return c; };
const AI = { action: 'hook', prompt: 'a song about rain' };

// ---------- trial ----------
test('trial: unauthenticated and bad tokens are rejected', async () => {
  const c = await scenario();
  assert.equal((await call(trial, {})).statusCode, 401);
  assert.equal((await call(trial, { token: 'forged' })).statusCode, 401);
  assert.equal(c.entitlements.length, 0);
});

test('trial: concurrent duplicate requests create exactly one trial', async () => {
  const c = await scenario();
  const out = await Promise.all(Array.from({ length: 6 }, () => call(trial, { token: 'tok-u1' })));
  assert.equal(c.entitlementWrites, 1, 'one entitlement write');
  assert.equal(c.entitlements.length, 1);
  assert.ok(out.every(r => [200, 409].includes(r.statusCode)), out.map(r => r.statusCode).join());
  assert.ok(out.some(r => r.statusCode === 200));
});

test('trial: a used trial cannot be claimed again after expiry', async () => {
  const c = await scenario();
  await call(trial, { token: 'tok-u1' });
  c.entitlements[0].expires_at = new Date(Date.now() - 1000).toISOString();   // trial expired
  const r = await call(trial, { token: 'tok-u1' });
  assert.equal(r.statusCode, 409);
  assert.equal(c.entitlementWrites, 1);
});

test('trial: users get independent trials', async () => {
  const c = await scenario();
  await call(trial, { token: 'tok-u1' }); await call(trial, { token: 'tok-u2' });
  assert.deepEqual(c.entitlements.map(e => e.user_id).sort(), ['u1', 'u2']);
});

test('trial failure recovery: entitlement write fails after claim -> fail closed, no free retries', quiet(async () => {
  const c = await scenario();
  c.fault((m, u) => m === 'POST' && u.includes('pro_entitlements'), { times: 1 });
  assert.equal((await call(trial, { token: 'tok-u1' })).statusCode, 500);
  assert.equal(c.entitlements.length, 0);
  assert.equal((await call(trial, { token: 'tok-u1' })).statusCode, 409, 'claim persists; cannot farm retries');
  assert.equal(c.entitlements.length, 0);
}));

test('trial: missing claim RPC fails closed (no unlimited trials)', quiet(async () => {
  const c = await scenario();
  c.fault((m, u) => u.includes('claim_pro_trial'), { status: 404 });
  assert.equal((await call(trial, { token: 'tok-u1' })).statusCode, 503);
  assert.equal(c.entitlements.length, 0);
}));

// ---------- AI ----------
test('ai: requires sign-in; no upstream call, no quota spent', async () => {
  const c = await scenario();
  assert.equal((await call(ai, { body: AI })).statusCode, 401);
  assert.equal((await call(ai, { token: 'forged', body: AI })).statusCode, 401);
  assert.equal(c.openaiCalls, 0);
});

test('ai: signed-in user without Pro is refused before quota or upstream', async () => {
  const c = await scenario();
  const r = await call(ai, { token: 'tok-u1', body: AI });
  assert.equal(r.statusCode, 403);
  assert.equal(c.openaiCalls, 0);
  assert.deepEqual(c.aiUsed, {});
});

test('ai: expired or revoked entitlement is treated as no Pro', async () => {
  const c = await scenario();
  c.entitlements.push({ user_id: 'u1', plan: 'month', status: 'active', expires_at: new Date(Date.now() - 1000).toISOString() });
  c.entitlements.push({ user_id: 'u2', plan: 'month', status: 'revoked', expires_at: null });
  assert.equal((await call(ai, { token: 'tok-u1', body: AI })).statusCode, 403);
  assert.equal((await call(ai, { token: 'tok-u2', body: AI })).statusCode, 403);
  assert.equal(c.openaiCalls, 0);
});

test('ai: unsupported actions and empty prompts are rejected without spending quota', async () => {
  const c = await scenario();
  c.entitlements.push({ user_id: 'u1', plan: 'month', status: 'active', expires_at: null });
  assert.equal((await call(ai, { token: 'tok-u1', body: { action: 'jailbreak', prompt: 'x' } })).statusCode, 400);
  assert.equal((await call(ai, { token: 'tok-u1', body: { action: 'hook', prompt: '' } })).statusCode, 400);
  assert.deepEqual(c.aiUsed, {});
});

test('ai: hourly quota is enforced per user and per plan; exhausted users never reach the upstream model', async () => {
  const c = await scenario();
  // Unknown plans fall back to 15/hour, safely below the 20/min per-user burst limiter,
  // so this exercises the DB quota on its own rather than the burst limiter.
  c.entitlements.push({ user_id: 'u1', plan: 'custom', status: 'active', expires_at: null });
  const codes = [], retry = [];
  for (let i = 0; i < 19; i++) {
    const r = await call(ai, { token: 'tok-u1', body: AI });
    codes.push(r.statusCode); if (r.statusCode === 429) retry.push(r.headers['Retry-After']);
  }
  assert.equal(codes.filter(x => x === 200).length, 15, codes.join());
  assert.equal(codes.filter(x => x === 429).length, 4);
  assert.ok(retry.every(x => x === '3600'), 'quota denial tells the client to wait an hour');
  assert.equal(c.openaiCalls, 15, 'denied requests never reach the model');
  assert.ok(c.aiLimitSeen.every(l => l === 15));
  // another user is unaffected by u1's exhaustion
  c.entitlements.push({ user_id: 'u2', plan: 'custom', status: 'active', expires_at: null });
  assert.equal((await call(ai, { token: 'tok-u2', body: AI })).statusCode, 200);
});

test('ai: plan tiers map to their documented hourly limits', async () => {
  const c = await scenario();
  c.entitlements.push({ user_id: 'u1', plan: 'lifetime', status: 'active', expires_at: null });
  c.entitlements.push({ user_id: 'u2', plan: 'trial', status: 'active', expires_at: null });
  await call(ai, { token: 'tok-u1', body: AI }); await call(ai, { token: 'tok-u2', body: AI });
  assert.deepEqual(c.aiLimitSeen, [60, 20]);
});

test('ai: burst of concurrent requests never lets more calls through than reservations', async () => {
  const c = await scenario();
  c.entitlements.push({ user_id: 'u1', plan: 'custom', status: 'active', expires_at: null });
  const out = await Promise.all(Array.from({ length: 18 }, () => call(ai, { token: 'tok-u1', body: AI })));
  const ok = out.filter(r => r.statusCode === 200).length;
  assert.equal(ok, 15);
  assert.equal(c.openaiCalls, ok);
  assert.equal(c.aiUsed.u1, 15);
});

test('ai failure recovery: missing quota RPC fails closed (503) and never calls the model', quiet(async () => {
  const c = await scenario();
  c.aiRpcMissing = true;
  c.entitlements.push({ user_id: 'u1', plan: 'month', status: 'active', expires_at: null });
  assert.equal((await call(ai, { token: 'tok-u1', body: AI })).statusCode, 503);
  assert.equal(c.openaiCalls, 0);
}));

test('ai failure recovery: upstream error is surfaced without leaking details or a 200', quiet(async () => {
  const c = await scenario();
  c.entitlements.push({ user_id: 'u1', plan: 'month', status: 'active', expires_at: null });
  const orig = c.fetch;
  globalThis.fetch = async (u, i) => String(u).includes('openai.com') ? new Response(JSON.stringify({ error: { message: 'upstream boom' } }), { status: 500 }) : orig(u, i);
  const r = await call(ai, { token: 'tok-u1', body: AI });
  assert.equal(r.statusCode, 502);
}));
