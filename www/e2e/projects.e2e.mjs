// Project persistence in a real browser: deletes reach the cloud, and a failed cloud delete never resurrects the project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './harness.mjs';
import { signUp } from './flows.mjs';

let world, d;
const rows = () => world.backend.tables.projects;
const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
const libraryTitles = () => d.page.evaluate(() => { window.openLibrary(); return [...document.querySelectorAll('#thLibList .card .t')].map(e => e.textContent); });
const deleteViaLibrary = async title => {
  await d.page.evaluate(() => window.openLibrary());
  d.page.once('dialog', dlg => dlg.accept());
  await d.page.evaluate(t => {
    const card = [...document.querySelectorAll('#thLibList .card')].find(c => c.querySelector('.t').textContent === t);
    card.querySelector('[data-a="del"]').click();
  }, title);
};

before(async () => {
  world = await startWorld();
  d = await world.device('iphone-14 390x844');
  await signUp(d, 'proj_a');
  // three named projects
  await d.page.evaluate(() => { for (const n of ['Alpha', 'Bravo', 'Charlie']) { newSong(); document.getElementById('songTitle').value = n; saveCurrentSong(); } });
  assert.ok(await until(() => ['Alpha', 'Bravo', 'Charlie'].every(n => rows().some(r => r.title === n))), 'projects reach the cloud');
});
after(async () => { await world.close(); });

test('deleting from the library removes the project from the cloud, and it stays gone after a reload', async () => {
  await deleteViaLibrary('Alpha');
  assert.ok(await until(() => !rows().some(r => r.title === 'Alpha')), 'cloud row deleted');
  await d.page.reload();
  await d.page.waitForFunction(() => window.state && window.state.user, null, { timeout: 10000 });
  await d.page.waitForTimeout(1500);
  const titles = await libraryTitles();
  assert.ok(!titles.includes('Alpha'), 'Alpha must not return: ' + titles);
  assert.ok(titles.includes('Bravo') && titles.includes('Charlie'));
});

test('REGRESSION: a delete the cloud rejects is remembered, the project does not come back on reload, and the delete lands once the cloud recovers', async () => {
  let fail = true, blocked = 0;
  await d.ctx.route('**/__sb/q', route => {
    let q = {}; try { q = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    if (fail && q.table === 'projects' && q.op === 'delete') { blocked++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: { status: 503, message: 'service unavailable' } }) }); }
    return route.fallback();
  });
  await deleteViaLibrary('Bravo');
  assert.ok(await until(() => blocked > 0), 'the delete was attempted and rejected');
  assert.ok(rows().some(r => r.title === 'Bravo'), 'cloud still has it while the delete is failing');
  assert.ok(await d.page.evaluate(() => !!localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('th-deleted-')) || 'x')), 'deletion is recorded locally');
  // reload while the cloud delete is still failing: cloud hands Bravo back, the app must ignore it
  await d.page.reload();
  await d.page.waitForFunction(() => window.state && window.state.user, null, { timeout: 10000 });
  await d.page.waitForTimeout(1500);
  assert.ok(!(await libraryTitles()).includes('Bravo'), 'Bravo must stay deleted even though the cloud still holds it');
  // cloud recovers
  fail = false;
  await d.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await d.page.evaluate(() => persistSongs());      // any save/retry trigger
  assert.ok(await until(() => !rows().some(r => r.title === 'Bravo'), 15000), 'pending delete applied after recovery');
  assert.ok(rows().some(r => r.title === 'Charlie'), 'unrelated projects untouched');
  assert.equal(await d.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('th-deleted-')).length), 0, 'tombstone cleared after success');
});

test('sign out right after typing an edit: the edit is in the cloud when the session ends', async () => {
  // Type and sign out in the same tick (no autosave, no debounce has elapsed) using the real button.
  await d.page.evaluate(() => { document.getElementById('songTitle').value = 'Charlie v2'; document.getElementById('signOutBtn').click(); });
  assert.ok(await until(() => rows().some(r => r.title === 'Charlie v2'), 10000), 'edit uploaded before the session ended');
  await d.page.waitForFunction(() => document.querySelector('#authModal.show'), null, { timeout: 10000 });
  assert.equal(await d.page.evaluate(() => window.state.user), null, 'signed out');
});

test('autosave settles: one edit causes a bounded number of saves, not a save loop, and reaches the cloud without needing sign-out', async () => {
  await d.open();
  await d.page.waitForSelector('#signinContact, #gotoSignup', { state: 'visible' });
  await d.page.fill('#signinContact', 'proj_a@example.test').catch(() => {});
  await d.page.fill('#signinPass', 'password123').catch(() => {});
  await d.page.tap('#doSignIn').catch(() => {});
  await d.page.waitForFunction(() => window.state && window.state.user, null, { timeout: 10000 });
  await d.page.waitForTimeout(1500);
  await d.page.evaluate(() => { window.__saves = 0; const o = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('th-songs-')) window.__saves++; return o.call(this, k, v); }; });   // counts every local project write, however it was triggered
  await d.page.evaluate(() => { document.getElementById('songTitle').value = 'Charlie v3'; scheduleSave(); });
  assert.ok(await until(() => rows().some(r => r.title === 'Charlie v3'), 8000), 'background cloud save fired by itself (v2.0.2 starved it)');
  await d.page.waitForTimeout(3000);
  const first = await d.page.evaluate(() => window.__saves);
  await d.page.waitForTimeout(3000);
  const second = await d.page.evaluate(() => window.__saves);
  assert.ok(first <= 3, 'a single edit saves a handful of times at most: ' + first);
  assert.equal(second, first, 'and then stops (no 600 ms self-triggering loop)');
});

test('no uncaught page errors', () => { assert.deepEqual(d.errors, []); });
