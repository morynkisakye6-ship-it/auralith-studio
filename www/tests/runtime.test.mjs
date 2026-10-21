import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/runtime.js', import.meta.url), 'utf8');
function runtime() {
  const context = { Date, Object, Math };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context;
}

test('runtime guard allows first command and blocks duplicate taps within window', () => {
  const r = runtime();
  assert.equal(r.thAllowCommandTap('save', 300), true);
  assert.equal(r.thAllowCommandTap('save', 300), false);
  assert.equal(r.thAllowCommandTap('open', 300), true);
});

test('runtime guard rejects invalid command names and records valid diagnostics', () => {
  const r = runtime();
  assert.equal(r.thAllowCommandTap('', 300), false);
  assert.equal(r.thRecordCommand(''), null);
  const entry = r.thRecordCommand('saveProject');
  assert.equal(entry.name, 'saveProject');
  assert.equal(typeof entry.at, 'number');
  assert.equal(r.__thLastCommand.name, 'saveProject');
  assert.equal(Object.isFrozen(entry), true);
});
