'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'chattoolsummary-'));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'chatToolSummary.ts'), 'utf8');
fs.writeFileSync(
  path.join(out, 'chatToolSummary.js'),
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
);
const m = require(path.join(out, 'chatToolSummary.js'));

test('summary prefers the path, then the command, and is empty for unknown shapes', () => {
  assert.strictEqual(m.summarizeToolInput({ file_path: '/tmp/x/notes.txt', limit: 5 }), '/tmp/x/notes.txt');
  assert.strictEqual(m.summarizeToolInput({ command: 'ls -la' }), 'ls -la');
  assert.strictEqual(m.summarizeToolInput({ foo: 1 }), '');
  assert.strictEqual(m.summarizeToolInput(null), '');
  assert.strictEqual(m.summarizeToolInput([1]), '');
});

test('summary is one line and clipped', () => {
  const s = m.summarizeToolInput({ command: 'echo a\n  echo b' });
  assert.strictEqual(s, 'echo a echo b');
  const long = m.summarizeToolInput({ command: 'x'.repeat(500) });
  assert.ok(long.length <= 90 && long.endsWith('…'));
});

test('formatToolInput pretty-prints and survives cycles', () => {
  assert.strictEqual(m.formatToolInput({ a: 1 }), '{\n  "a": 1\n}');
  const c = {}; c.self = c;
  assert.strictEqual(typeof m.formatToolInput(c), 'string');
});
