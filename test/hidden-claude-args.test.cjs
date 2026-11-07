'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

// hiddenClaude.ts imports node-pty and electron-adjacent modules; stub the native one.
const ptyPath = require.resolve('node-pty');
const spawned = [];
require.cache[ptyPath] = {
  id: ptyPath, filename: ptyPath, loaded: true,
  // Capture the argv runHiddenClaude really hands to the PTY, then fail the spawn
  // so the call settles immediately without a real claude.
  exports: { spawn: (file, args) => { spawned.push({ file, args }); throw new Error('stub: no real spawn'); } }
};

const { buildHiddenClaudeArgs, DEFAULT_ALLOWED_TOOLS, DEFAULT_DISALLOWED_TOOLS } = loadTs('src/main/hiddenClaude.ts');

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS']);
const after = (args, flag) => {
  const i = args.indexOf(flag);
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
};

test('default args never bypass permissions', () => {
  const joined = buildHiddenClaudeArgs({ model: 'm' }).join(' ');
  assert.doesNotMatch(joined, /bypassPermissions|dangerously-skip-permissions|yolo/);
  assert.deepEqual(after(buildHiddenClaudeArgs({ model: 'm' }), '--permission-mode'), ['default']);
});

test('default allow-list is read-only and Bash is denied', () => {
  const args = buildHiddenClaudeArgs({ model: 'm' });
  const allowed = after(args, '--allowedTools');
  assert.ok(allowed.length > 0);
  for (const t of allowed) assert.ok(READ_ONLY.has(t), `${t} is not read-only`);
  const denied = after(args, '--disallowedTools');
  for (const t of ['Bash', 'Edit', 'Write', 'NotebookEdit']) assert.ok(denied.includes(t), `${t} not denied`);
  assert.deepEqual(DEFAULT_ALLOWED_TOOLS.filter((t) => DEFAULT_DISALLOWED_TOOLS.includes(t)), []);
});

test('add-dir entries are passed through', () => {
  const args = buildHiddenClaudeArgs({ model: 'm', addDirs: ['/a'] });
  assert.deepEqual(after(args, '--add-dir'), ['/a']);
});

test('runHiddenClaude spawns with exactly the args buildHiddenClaudeArgs produces', async () => {
  const { runHiddenClaude } = loadTs('src/main/hiddenClaude.ts');
  spawned.length = 0;
  const r = await runHiddenClaude('hello', { model: 'm', cwd: process.cwd(), command: 'claude' });
  assert.equal(r.ok, false);
  assert.equal(spawned.length, 1);
  const args = spawned[0].args;
  assert.deepEqual(args, buildHiddenClaudeArgs({ model: 'm' }));
  assert.doesNotMatch(args.join(' '), /bypassPermissions|dangerously-skip-permissions|yolo/);
  assert.ok(after(args, '--disallowedTools').includes('Bash'));
});
