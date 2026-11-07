'use strict';
/**
 * Chat transcript reducer tests (src/shared/chatTranscript.ts). Same transpile-to-tmp
 * approach as claude-stream.test.cjs; the recorded fixtures drive the reducer.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SHARED = path.join(__dirname, '..', 'src', 'shared');
const FIXTURES = path.join(__dirname, 'fixtures', 'claude-stream');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'chattranscript-'));
for (const name of ['chatEvents', 'claudeStream', 'chatTranscript']) {
  const src = fs.readFileSync(path.join(SHARED, `${name}.ts`), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js, 'utf8');
}
const cs = require(path.join(out, 'claudeStream.js'));
const ct = require(path.join(out, 'chatTranscript.js'));

function fixtureEvents(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean).flatMap((l) => cs.parseClaudeLine(l));
}
function run(events, start = ct.emptyTranscript()) {
  return events.reduce((t, e) => ct.applyChatEvent(t, e), start);
}
const pendingPerms = (t) => t.items.filter((i) => i.type === 'permission' && i.state === 'pending');

test('emptyTranscript is idle with no items', () => {
  assert.deepStrictEqual(ct.emptyTranscript(), { items: [], status: 'idle' });
});

test('addUserMessage appends a user item and sets running, without mutating', () => {
  const t0 = ct.emptyTranscript();
  const t1 = ct.addUserMessage(t0, 'hej');
  assert.strictEqual(t0.items.length, 0);
  assert.strictEqual(t1.status, 'running');
  assert.strictEqual(t1.items[0].type, 'user');
  assert.strictEqual(t1.items[0].text, 'hej');
});

test('tool_result lands on the tool card with the same id', () => {
  const events = fixtureEvents('read-and-write.ndjson');
  const upToResult = events.slice(0, events.findIndex((e) => e.kind === 'tool_result') + 1);
  const t = run(upToResult, ct.addUserMessage(ct.emptyTranscript(), 'czytaj'));
  const tool = t.items.find((i) => i.type === 'tool');
  assert.ok(tool);
  assert.strictEqual(tool.name, 'Read');
  assert.match(tool.result, /mleko/);
  assert.strictEqual(tool.isError, false);
  assert.strictEqual(tool.status, 'done');
  assert.strictEqual(t.sessionId, 'SESSION');
  assert.strictEqual(t.items.filter((i) => i.type === 'tool').length, 1, 'result does not add a second card');
});

test('permission_request sets waiting; resolving it resumes running; result goes idle', () => {
  const events = fixtureEvents('read-and-write.ndjson');
  const permIdx = events.findIndex((e) => e.kind === 'permission_request');
  let t = run(events.slice(0, permIdx + 1), ct.addUserMessage(ct.emptyTranscript(), 'x'));
  assert.strictEqual(t.status, 'waiting');
  const perm = pendingPerms(t);
  assert.strictEqual(perm.length, 1);
  assert.strictEqual(perm[0].toolName, 'Write');

  t = ct.resolvePermission(t, perm[0].requestId, 'allowed');
  assert.strictEqual(t.status, 'running');
  assert.strictEqual(pendingPerms(t).length, 0);
  assert.strictEqual(t.items.find((i) => i.type === 'permission').state, 'allowed');

  t = run(events.slice(permIdx + 1), t);
  assert.strictEqual(t.status, 'idle');
});

test('a denied Write ends with an error tool card and a denied permission', () => {
  const events = fixtureEvents('deny-write.ndjson');
  const permIdx = events.findIndex((e) => e.kind === 'permission_request');
  let t = run(events.slice(0, permIdx + 1));
  t = ct.resolvePermission(t, pendingPerms(t)[0].requestId, 'denied');
  t = run(events.slice(permIdx + 1), t);
  const write = t.items.find((i) => i.type === 'tool' && i.name === 'Write');
  assert.strictEqual(write.status, 'error');
  assert.strictEqual(write.isError, true);
  assert.strictEqual(t.items.find((i) => i.type === 'permission').state, 'denied');
  assert.strictEqual(t.status, 'idle');
});

test('the whole fixture ends idle with user-visible assistant text', () => {
  const t = run(fixtureEvents('read-and-write.ndjson'), ct.addUserMessage(ct.emptyTranscript(), 'x'));
  // the fixture has no pending resolution step, so unresolved permission is cancelled by result
  assert.strictEqual(t.status, 'idle');
  assert.strictEqual(pendingPerms(t).length, 0);
  assert.ok(t.items.some((i) => i.type === 'assistant' && i.text.length > 0));
});

test('repeated session events (one per turn) do not add items', () => {
  const t = run([
    { kind: 'session', sessionId: 's', model: 'm', cwd: '/c' },
    { kind: 'session', sessionId: 's', model: 'm', cwd: '/c' }
  ]);
  assert.strictEqual(t.items.length, 0);
  assert.strictEqual(t.sessionId, 's');
});

test('text blocks of the same message merge into one assistant item', () => {
  const t = run([
    { kind: 'text', messageId: 'm1', text: 'a' },
    { kind: 'text', messageId: 'm1', text: 'b' },
    { kind: 'text', messageId: 'm2', text: 'c' }
  ]);
  const a = t.items.filter((i) => i.type === 'assistant');
  assert.strictEqual(a.length, 2);
  assert.strictEqual(a[0].text, 'a\n\nb');
});

test('exit ends the session and cancels pending permissions', () => {
  let t = run([
    { kind: 'session', sessionId: 's', model: 'm', cwd: '/c' },
    { kind: 'permission_request', requestId: 'r1', toolName: 'Write', input: {}, toolUseId: 'tu' },
    { kind: 'exit', code: 1, signal: null }
  ]);
  assert.strictEqual(t.status, 'ended');
  assert.strictEqual(pendingPerms(t).length, 0);
  assert.strictEqual(t.items.find((i) => i.type === 'permission').state, 'cancelled');
  assert.ok(t.items.some((i) => i.type === 'notice'), 'non-zero exit leaves a notice');
  // a clean exit adds no notice
  t = run([{ kind: 'exit', code: 0, signal: null }]);
  assert.strictEqual(t.status, 'ended');
  assert.strictEqual(t.items.length, 0);
});

test('error event adds an error notice and does not change status', () => {
  const t = run([{ kind: 'error', message: 'boom' }], ct.addUserMessage(ct.emptyTranscript(), 'x'));
  const n = t.items.find((i) => i.type === 'notice');
  assert.strictEqual(n.level, 'error');
  assert.strictEqual(n.text, 'boom');
  assert.strictEqual(t.status, 'running');
});

test('result with isError adds an error notice', () => {
  const t = run([{ kind: 'result', isError: true, text: 'zle' }]);
  assert.strictEqual(t.status, 'idle');
  assert.strictEqual(t.items.find((i) => i.type === 'notice').text, 'zle');
});

test('tool_result for an unknown tool_use id is ignored', () => {
  const t = run([{ kind: 'tool_result', toolUseId: 'nope', content: 'x', isError: false }]);
  assert.strictEqual(t.items.length, 0);
});

test('a user message after ended starts over as running', () => {
  const t = ct.addUserMessage(run([{ kind: 'exit', code: 0, signal: null }]), 'again');
  assert.strictEqual(t.status, 'running');
});

test('permission_cancelled marks the card cancelled and resumes running', () => {
  const t = run([
    { kind: 'permission_request', requestId: 'r1', toolName: 'Write', input: {} },
    { kind: 'permission_request', requestId: 'r2', toolName: 'Bash', input: {} },
    { kind: 'permission_cancelled', requestId: 'r1' }
  ]);
  assert.strictEqual(t.status, 'waiting', 'another permission is still pending');
  const t2 = ct.applyChatEvent(t, { kind: 'permission_cancelled', requestId: 'r2' });
  assert.strictEqual(t2.status, 'running');
  assert.deepStrictEqual(t2.items.map((i) => i.state), ['cancelled', 'cancelled']);
});

test('permission_cancelled for an unknown id leaves the transcript unchanged', () => {
  const t = run([{ kind: 'permission_request', requestId: 'r1', toolName: 'Write', input: {} }]);
  assert.deepStrictEqual(ct.applyChatEvent(t, { kind: 'permission_cancelled', requestId: 'zz' }), t);
});
