'use strict';
/**
 * Claude Code `stream-json` parser tests. The parser lives in TypeScript
 * (src/shared/claudeStream.ts), so — like agent-provider.test.cjs — we transpile
 * the module into a temp dir with the bundled `typescript` compiler and require it.
 * Fixtures in test/fixtures/claude-stream/ are real recordings from claude 2.1.319
 * (ids and paths masked), see the README note in the task report.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SHARED = path.join(__dirname, '..', 'src', 'shared');
const FIXTURES = path.join(__dirname, 'fixtures', 'claude-stream');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'claudestream-'));
for (const name of ['chatEvents', 'claudeStream']) {
  const src = fs.readFileSync(path.join(SHARED, `${name}.ts`), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js, 'utf8');
}
const cs = require(path.join(out, 'claudeStream.js'));

function parseFixture(name) {
  const lines = fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean);
  return lines.flatMap((l) => cs.parseClaudeLine(l));
}

test('fixture read-and-write yields session, Read tool_use/result, Write permission, text, result', () => {
  const events = parseFixture('read-and-write.ndjson');
  const kinds = events.map((e) => e.kind);
  const at = (kind, from = 0) => kinds.indexOf(kind, from);

  const session = at('session');
  assert.ok(session >= 0, 'session event');
  assert.strictEqual(events[session].sessionId, 'SESSION');
  assert.strictEqual(events[session].cwd, '/tmp/x');
  assert.ok(events[session].model);

  const toolUse = at('tool_use', session);
  assert.ok(toolUse > session, 'tool_use after session');
  assert.strictEqual(events[toolUse].name, 'Read');
  assert.deepStrictEqual(events[toolUse].input, { file_path: '/tmp/x/notes.txt' });

  const toolResult = at('tool_result', toolUse);
  assert.ok(toolResult > toolUse, 'tool_result after tool_use');
  assert.strictEqual(events[toolResult].toolUseId, events[toolUse].id);
  assert.strictEqual(events[toolResult].isError, false);
  assert.match(events[toolResult].content, /mleko/);

  const perm = at('permission_request', toolResult);
  assert.ok(perm > toolResult, 'permission_request after the Read result');
  assert.strictEqual(events[perm].toolName, 'Write');
  assert.ok(events[perm].requestId);
  assert.ok(events[perm].toolUseId, 'permission carries the tool_use id');
  assert.strictEqual(events[perm].input.file_path, '/tmp/x/hello.txt');

  const text = at('text', perm);
  assert.ok(text > perm, 'text after permission');
  assert.ok(events[text].text.length > 0);
  assert.ok(events[text].messageId);

  const result = at('result', text);
  assert.ok(result > text, 'result after text');
  assert.strictEqual(events[result].isError, false);
  assert.strictEqual(typeof events[result].costUsd, 'number');
  assert.strictEqual(typeof events[result].durationMs, 'number');
});

test('fixture deny-write yields an error tool_result for the denied Write', () => {
  const events = parseFixture('deny-write.ndjson');
  const perm = events.find((e) => e.kind === 'permission_request');
  assert.ok(perm);
  const denied = events.find((e) => e.kind === 'tool_result' && e.toolUseId === perm.toolUseId);
  assert.ok(denied);
  assert.strictEqual(denied.isError, true);
});

test('assistant message with empty content and thinking blocks yields nothing', () => {
  const empty = JSON.stringify({ type: 'assistant', message: { id: 'm', content: [] } });
  assert.deepStrictEqual(cs.parseClaudeLine(empty), []);
  const thinking = JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'thinking', thinking: '' }] } });
  assert.deepStrictEqual(cs.parseClaudeLine(thinking), []);
});

test('tool_result content given as a block array is flattened to text', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }
  });
  assert.deepStrictEqual(cs.parseClaudeLine(line), [{ kind: 'tool_result', toolUseId: 't1', content: 'a\nb', isError: true }]);
});

test('result with a non-success subtype is an error', () => {
  const [ev] = cs.parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: false }));
  assert.strictEqual(ev.kind, 'result');
  assert.strictEqual(ev.isError, true);
});

test('unknown event types and non-can_use_tool control requests are ignored', () => {
  assert.deepStrictEqual(cs.parseClaudeLine('{"type":"nowy_typ"}'), []);
  assert.deepStrictEqual(cs.parseClaudeLine('{"type":"control_request","request_id":"x","request":{"subtype":"cos_innego"}}'), []);
  assert.deepStrictEqual(cs.parseClaudeLine('{"type":"system","subtype":"hook_started"}'), []);
  assert.deepStrictEqual(cs.parseClaudeLine(''), []);
  assert.deepStrictEqual(cs.parseClaudeLine('   '), []);
});

test('control_cancel_request maps to permission_cancelled', () => {
  assert.deepStrictEqual(
    cs.parseClaudeLine('{"type":"control_cancel_request","request_id":"r9"}'),
    [{ kind: 'permission_cancelled', requestId: 'r9' }]
  );
  assert.deepStrictEqual(cs.parseClaudeLine('{"type":"control_cancel_request"}'), []);
});

test('invalid JSON becomes one error event; non-object JSON is ignored', () => {
  const evs = cs.parseClaudeLine('nie json');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].kind, 'error');
  assert.ok(evs[0].message.length > 0);
  assert.deepStrictEqual(cs.parseClaudeLine('42'), []);
  assert.deepStrictEqual(cs.parseClaudeLine('null'), []);
});

test('LineBuffer joins lines split across chunks', () => {
  const b = new cs.LineBuffer();
  assert.deepStrictEqual(b.push('{"a":'), []);
  assert.deepStrictEqual(b.push('1}\n{"b"'), ['{"a":1}']);
  assert.deepStrictEqual(b.push(':2}\n'), ['{"b":2}']);
  assert.deepStrictEqual(b.flush(), []);
});

test('LineBuffer: several lines in one chunk, CRLF, blank lines, tail without newline', () => {
  const b = new cs.LineBuffer();
  assert.deepStrictEqual(b.push('a\r\nb\n\nc\nd'), ['a', 'b', 'c']);
  assert.deepStrictEqual(b.flush(), ['d']);
  assert.deepStrictEqual(b.flush(), []);
  const c = new cs.LineBuffer();
  c.push('x');
  assert.deepStrictEqual(c.flush(), ['x']);
});

test('LineBuffer handles a very long line arriving in many chunks', () => {
  const b = new cs.LineBuffer();
  const big = 'y'.repeat(1_000_000);
  for (let i = 0; i < big.length; i += 65536) assert.deepStrictEqual(b.push(big.slice(i, i + 65536)), []);
  assert.deepStrictEqual(b.push('\n'), [big]);
});

test('encodeUserMessage emits one NDJSON line', () => {
  const s = cs.encodeUserMessage('hej');
  assert.ok(s.endsWith('\n'));
  assert.strictEqual(s.indexOf('\n'), s.length - 1);
  assert.deepStrictEqual(JSON.parse(s), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hej' }] } });
  const multi = cs.encodeUserMessage('a\nb');
  assert.strictEqual(multi.split('\n').length, 2, 'embedded newline is escaped');
});

test('encodePermissionResponse: deny and allow', () => {
  const deny = cs.encodePermissionResponse('r1', { allow: false, message: 'nie' });
  assert.ok(deny.endsWith('\n'));
  assert.deepStrictEqual(JSON.parse(deny), {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: 'nie' } }
  });
  const input = { file_path: '/tmp/x/hello.txt', content: 'hi' };
  const allow = cs.encodePermissionResponse('r2', { allow: true, input });
  assert.deepStrictEqual(JSON.parse(allow), {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'r2', response: { behavior: 'allow', updatedInput: input } }
  });
});

test('CLAUDE_STREAM_ARGS has the recorded flag set', () => {
  assert.deepStrictEqual([...cs.CLAUDE_STREAM_ARGS], [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio'
  ]);
});
