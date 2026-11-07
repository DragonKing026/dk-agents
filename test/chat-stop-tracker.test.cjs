'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstop-'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'chatStopTracker.ts'), 'utf8');
fs.writeFileSync(path.join(out, 't.js'), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText);
const { StopTracker } = require(path.join(out, 't.js'));

test('a requested stop silences exactly one exit', () => {
  const t = new StopTracker();
  t.requestStop('a', false);
  assert.strictEqual(t.consumeExit('a'), true);
  assert.strictEqual(t.consumeExit('a'), false);
});

test('a stale stop does not silence the next session (beginStart resets it)', () => {
  const t = new StopTracker();
  t.requestStop('a', false); // process had already died: no exit consumed it
  t.beginStart('a');
  assert.strictEqual(t.consumeExit('a'), false);
});

test('stop during start is remembered until the start returns', () => {
  const t = new StopTracker();
  t.beginStart('a');
  t.requestStop('a', true);
  assert.strictEqual(t.consumeAbortStart('a'), true);
  assert.strictEqual(t.consumeAbortStart('a'), false);
  assert.strictEqual(t.consumeExit('a'), true, 'its exit is still expected');
});

test('stop outside a start never aborts a later start; agents are independent; cancelStop forgets', () => {
  const t = new StopTracker();
  t.requestStop('a', false);
  assert.strictEqual(t.consumeAbortStart('a'), false);
  t.requestStop('b', true);
  t.cancelStop('b');
  assert.strictEqual(t.consumeAbortStart('b'), false);
  assert.strictEqual(t.consumeExit('b'), false);
  assert.strictEqual(t.consumeExit('a'), true);
});
