'use strict';
/**
 * Stand-in for `claude -p --input-format stream-json ...` used by chat-session.test.cjs.
 * Usage: node fake-claude.cjs <fixture.ndjson>
 * Replays the recorded fixture one turn (up to a `result` line) per user message on stdin.
 * A `control_request` line pauses the replay until a `control_response` arrives on stdin.
 * Every stdin line is appended to $FAKE_CLAUDE_LOG. $FAKE_CLAUDE_MODE:
 *   utf8     - on a user message, emit a Polish text line split in the middle of a multi-byte character
 *   stubborn - ignore SIGTERM and stdin EOF (only SIGKILL stops it)
 */
const fs = require('node:fs');
const readline = require('node:readline');

const mode = process.env.FAKE_CLAUDE_MODE || '';
const logPath = process.env.FAKE_CLAUDE_LOG || '';
const fixture = process.argv[2];

const turns = [];
let cur = [];
if (fixture) {
  for (const l of fs.readFileSync(fixture, 'utf8').split('\n').filter(Boolean)) {
    cur.push(l);
    if (JSON.parse(l).type === 'result') {
      turns.push(cur);
      cur = [];
    }
  }
}

let turn = 0;
const queue = [];
let waiting = false;

function pump() {
  while (queue.length > 0 && !waiting) {
    const l = queue.shift();
    process.stdout.write(l + '\n');
    if (JSON.parse(l).type === 'control_request') waiting = true;
  }
}

if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (logPath) fs.appendFileSync(logPath, line + '\n');
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'user') {
    if (mode === 'utf8') {
      const text = 'Zażółć gęślą jaźń — źdźbło';
      const buf = Buffer.from(
        JSON.stringify({
          type: 'assistant',
          message: { id: 'msg_u', content: [{ type: 'text', text }] }
        }) + '\n',
        'utf8'
      );
      const cut = buf.indexOf(Buffer.from('ż', 'utf8')) + 1; // between the two bytes of 'ż'
      process.stdout.write(buf.subarray(0, cut));
      setTimeout(() => {
        process.stdout.write(buf.subarray(cut));
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\n');
      }, 50);
      return;
    }
    const next = turns[turn++];
    if (next) queue.push(...next);
    pump();
  } else if (msg.type === 'control_response') {
    waiting = false;
    pump();
  }
});
rl.on('close', () => {
  if (mode !== 'stubborn') process.exit(0);
});
