'use strict';
/**
 * ClaudeChatSession tests (src/main/chatSession.ts) against a stand-in CLI
 * (test/fixtures/fake-claude.cjs) that replays the recorded stream-json fixtures.
 * No real `claude` is ever started.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ClaudeChatSession } = loadTs('src/main/chatSession.ts');
const { parseClaudeLine } = loadTs('src/shared/claudeStream.ts');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.cjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'claude-stream', 'read-and-write.ndjson');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsession-'));
let seq = 0;

/** Expected events of fixture turn `n` (0-based), as the parser produces them. */
function turnEvents(n) {
  const turns = [];
  let cur = [];
  for (const l of fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean)) {
    cur.push(l);
    if (JSON.parse(l).type === 'result') {
      turns.push(cur);
      cur = [];
    }
  }
  return turns[n].flatMap((l) => parseClaudeLine(l));
}

function makeSession(extra = {}, mode = '') {
  const log = path.join(TMP, `stdin-${++seq}.log`);
  const session = new ClaudeChatSession({
    agentId: 'a1',
    cwd: TMP,
    command: process.execPath,
    args: [FAKE, FIXTURE],
    env: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: mode },
    ...extra
  });
  const events = [];
  session.on('event', (ev) => events.push(ev));
  const received = () =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { session, events, received };
}

async function waitFor(pred, what, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timeout waiting for ${what}`);
}

const kinds = (events) => events.map((e) => e.kind);
const count = (events, kind) => events.filter((e) => e.kind === kind).length;

test('send() replays a turn in recorded order; permission_request precedes the rest; allow finishes the turn', async () => {
  const { session, events, received } = makeSession();
  session.start();
  session.send('przeczytaj notes.txt');
  await waitFor(() => count(events, 'result') === 1, 'first result');
  assert.deepStrictEqual(events, turnEvents(0));

  events.length = 0;
  session.send('zapisz hello.txt');
  await waitFor(() => count(events, 'permission_request') === 1, 'permission_request');
  const expected = turnEvents(1);
  const idx = expected.findIndex((e) => e.kind === 'permission_request');
  assert.deepStrictEqual(events, expected.slice(0, idx + 1)); // nothing after the request yet
  const req = events[events.length - 1];

  const input = { file_path: '/tmp/x/hello.txt', content: 'cześć' };
  session.respondPermission(req.requestId, { allow: true, input });
  await waitFor(() => count(events, 'result') === 1, 'result after allow');
  assert.deepStrictEqual(events, expected);

  const resp = received().find((m) => m.type === 'control_response');
  assert.strictEqual(resp.response.request_id, req.requestId);
  assert.strictEqual(resp.response.response.behavior, 'allow');
  assert.deepStrictEqual(resp.response.response.updatedInput, input);

  session.stop();
  await waitFor(() => count(events, 'exit') === 1, 'exit');
});

test('allow without input falls back to the remembered input of the request; unknown id is ignored', async () => {
  const { session, events, received } = makeSession();
  session.start();
  session.send('a');
  await waitFor(() => count(events, 'result') === 1, 'first result');
  session.send('b');
  await waitFor(() => count(events, 'permission_request') === 1, 'permission_request');
  const req = events.find((e) => e.kind === 'permission_request');

  assert.doesNotThrow(() => session.respondPermission('nie-ma-takiego', { allow: true, input: {} }));
  assert.strictEqual(received().filter((m) => m.type === 'control_response').length, 0);

  session.respondPermission(req.requestId, { allow: true, input: undefined });
  await waitFor(() => count(events, 'result') === 2, 'result after allow');
  const resp = received().find((m) => m.type === 'control_response');
  assert.deepStrictEqual(resp.response.response.updatedInput, req.input);

  // already resolved -> ignored, no second response
  session.respondPermission(req.requestId, { allow: false, message: 'late' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(received().filter((m) => m.type === 'control_response').length, 1);
  session.stop();
  await waitFor(() => count(events, 'exit') === 1, 'exit');
});

test('deny reaches the CLI as behavior deny with the message', async () => {
  const { session, events, received } = makeSession();
  session.start();
  session.send('a');
  await waitFor(() => count(events, 'result') === 1, 'first result');
  session.send('b');
  await waitFor(() => count(events, 'permission_request') === 1, 'permission_request');
  const req = events.find((e) => e.kind === 'permission_request');
  session.respondPermission(req.requestId, { allow: false, message: 'Nie.' });
  await waitFor(() => received().some((m) => m.type === 'control_response'), 'control_response');
  const resp = received().find((m) => m.type === 'control_response');
  assert.deepStrictEqual(resp.response.response, { behavior: 'deny', message: 'Nie.' });
  session.stop();
  await waitFor(() => count(events, 'exit') === 1, 'exit');
});

test('missing binary: error naming the path, then exit; no exception', async () => {
  const session = new ClaudeChatSession({ agentId: 'a1', cwd: TMP, command: '/nie/ma/takiego' });
  const events = [];
  session.on('event', (ev) => events.push(ev));
  assert.doesNotThrow(() => session.start());
  await waitFor(() => count(events, 'exit') === 1, 'exit');
  assert.deepStrictEqual(kinds(events), ['error', 'exit']);
  assert.ok(events[0].message.includes('/nie/ma/takiego'), events[0].message);
  assert.doesNotThrow(() => session.send('x'));
  assert.doesNotThrow(() => session.stop());
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(count(events, 'exit'), 1);
});

test('stop() with a pending permission sends deny, then exit exactly once; repeat and late stop are harmless', async () => {
  const { session, events, received } = makeSession();
  session.start();
  session.send('a');
  await waitFor(() => count(events, 'result') === 1, 'first result');
  session.send('b');
  await waitFor(() => count(events, 'permission_request') === 1, 'permission_request');
  const req = events.find((e) => e.kind === 'permission_request');

  session.stop();
  session.stop();
  await waitFor(() => count(events, 'exit') === 1, 'exit');
  const resp = received().find((m) => m.type === 'control_response');
  assert.strictEqual(resp.response.request_id, req.requestId);
  assert.strictEqual(resp.response.response.behavior, 'deny');
  assert.strictEqual(events[events.length - 1].kind, 'exit');

  assert.doesNotThrow(() => session.stop());
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(count(events, 'exit'), 1);
});

test('stop() escalates to SIGKILL when the process ignores SIGTERM and stdin EOF', async () => {
  const { session, events } = makeSession({ killTimeoutMs: 200 }, 'stubborn');
  session.start();
  session.send('a');
  await waitFor(() => count(events, 'result') === 1, 'first result');
  session.stop();
  await waitFor(() => count(events, 'exit') === 1, 'exit after SIGKILL', 3000);
  assert.strictEqual(events[events.length - 1].signal, 'SIGKILL');
});

test('natural exit emits exit once; send() after exit and before start() give an error event, not an exception', async () => {
  const early = makeSession();
  assert.doesNotThrow(() => early.session.send('za wcześnie'));
  assert.deepStrictEqual(kinds(early.events), ['error']);

  const { session, events } = makeSession();
  session.start();
  session.send('a');
  await waitFor(() => count(events, 'result') === 1, 'first result');
  session.stop();
  await waitFor(() => count(events, 'exit') === 1, 'exit');
  events.length = 0;
  assert.doesNotThrow(() => session.send('za późno'));
  assert.deepStrictEqual(kinds(events), ['error']);
});

test('multibyte characters split between stdout chunks are decoded intact', async () => {
  const { session, events } = makeSession({}, 'utf8');
  session.start();
  session.send('x');
  await waitFor(() => count(events, 'result') === 1, 'result');
  const text = events.find((e) => e.kind === 'text');
  assert.strictEqual(text.text, 'Zażółć gęślą jaźń — źdźbło');
  assert.strictEqual(count(events, 'error'), 0);
  session.stop();
  await waitFor(() => count(events, 'exit') === 1, 'exit');
});

test('CLI arguments: extra args first, then the stream flags, then --model', async () => {
  const { session, events, received } = makeSession({ model: 'haiku' });
  assert.deepStrictEqual(session.buildArgs().slice(0, 2), [FAKE, FIXTURE]);
  const args = session.buildArgs();
  assert.ok(args.indexOf('stream-json') > 1);
  assert.deepStrictEqual(args.slice(-2), ['--model', 'haiku']);
  assert.ok(events.length === 0 && received().length === 0);
});

// ─── round 1 review fixes ────────────────────────────────────────────────────

const { validateChatModel, MAX_CHAT_MESSAGE_CHARS } = loadTs('src/main/chatSession.ts');
const { ChatSessionMap } = loadTs('src/main/chatSessionMap.ts');

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('stop({immediate:true}) kills a process that ignores EOF and SIGTERM, without waiting for timers', async () => {
  const { session, events } = makeSession({ killTimeoutMs: 60000 }, 'stubborn');
  session.start();
  session.send('a');
  await waitFor(() => count(events, 'result') === 1, 'first result');
  const pid = session.pid;
  assert.ok(pid > 0 && pidAlive(pid));
  session.stop({ immediate: true });
  await waitFor(() => !pidAlive(pid), 'process gone', 2000);
  await waitFor(() => count(events, 'exit') === 1, 'exit', 2000);
  assert.strictEqual(events[events.length - 1].signal, 'SIGKILL');
});

test('stop() before start(): a later start() gives an error + exit and spawns nothing', async () => {
  const { session, events } = makeSession();
  session.stop();
  assert.doesNotThrow(() => session.start());
  assert.deepStrictEqual(kinds(events), ['error', 'exit']);
  assert.strictEqual(session.pid, undefined);
});

test('send() above the length limit gives an error event and is not written', async () => {
  const { session, events, received } = makeSession();
  session.start();
  session.send('x'.repeat(MAX_CHAT_MESSAGE_CHARS + 1));
  assert.deepStrictEqual(kinds(events), ['error']);
  session.stop();
  await waitFor(() => count(events, 'exit') === 1, 'exit');
  assert.strictEqual(received().length, 0);
});

test('validateChatModel accepts model names and rejects anything else', () => {
  for (const ok of ['claude-haiku-5-5', 'opus', 'claude-opus-5-5[1m]', 'a.b:c_d'.replace('_', '-')]) {
    assert.deepStrictEqual(validateChatModel(ok), { ok: true, model: ok }, ok);
  }
  assert.deepStrictEqual(validateChatModel(undefined), { ok: true });
  assert.deepStrictEqual(validateChatModel(''), { ok: true });
  for (const bad of ['--dangerous', '-x', 'a b', 'a;b', 'a'.repeat(101), 5, {}, 'x\n']) {
    assert.strictEqual(validateChatModel(bad).ok, false, String(bad));
  }
});

test('ChatSessionMap: a stopping or exited session counts as absent; an old exit cannot evict a newer session', () => {
  const map = new ChatSessionMap();
  const old = { stopping: false, alive: true, stop() { this.stopping = true; } };
  const sender = {};
  map.set('a', old, sender);
  assert.strictEqual(map.get('a').session, old);

  old.stop();
  assert.strictEqual(map.get('a'), undefined); // stopping -> start must create a new one

  const fresh = { stopping: false, alive: true, stop() { this.stopping = true; } };
  map.set('a', fresh, sender);
  map.removeIfCurrent('a', old); // the old session's late 'exit'
  assert.strictEqual(map.get('a').session, fresh);
  map.removeIfCurrent('a', fresh);
  assert.strictEqual(map.get('a'), undefined);
});

test('ChatSessionMap.stopAll(immediate) stops every session, including stopping ones, and stopForSender is selective', () => {
  const map = new ChatSessionMap();
  const calls = [];
  const mk = (n) => ({ stopping: false, alive: true, stop(o) { calls.push([n, !!(o && o.immediate)]); this.stopping = true; } });
  const w1 = {};
  const w2 = {};
  map.set('a', mk('a'), w1);
  map.set('b', mk('b'), w2);
  map.stopForSender(w1);
  assert.deepStrictEqual(calls, [['a', false]]);
  map.stopAll({ immediate: true });
  assert.deepStrictEqual(calls.slice(1).sort(), [['a', true], ['b', true]]);
});
