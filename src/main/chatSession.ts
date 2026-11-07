import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ChatEvent, PermissionDecision } from '../shared/chatEvents';
import {
  CLAUDE_STREAM_ARGS,
  LineBuffer,
  encodePermissionResponse,
  encodeUserMessage,
  parseClaudeLine
} from '../shared/claudeStream';
import { buildPtyEnv } from './ptyEnv';
import { resolveCommand, userShellPath } from './shellEnv';

export interface ChatSessionOptions {
  agentId: string;
  cwd: string;
  /** Binary to run. Defaults to `claude`, resolved like PtyManager does (user's interactive-shell PATH). */
  command?: string;
  /** Extra arguments placed BEFORE `CLAUDE_STREAM_ARGS` (tests use this to run a stand-in script). */
  args?: string[];
  /** Passed as `--model`. */
  model?: string;
  /** Child environment. Defaults to the app environment with the user's shell PATH. */
  env?: NodeJS.ProcessEnv;
  /** Grace period between SIGTERM and SIGKILL in `stop()`. Default 3000 ms. */
  killTimeoutMs?: number;
}

const STDERR_TAIL_BYTES = 2000;
const TERM_DELAY_MS = 200;

/**
 * One long-lived `claude -p` stream-json session (a plain child process, no PTY). Emits `'event'`
 * with every `ChatEvent`; process-level problems arrive as `error` / `exit` events, never as exceptions.
 */
export class ClaudeChatSession extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private exited = false;
  private stopping = false;
  private killTimer: NodeJS.Timeout | null = null;
  private stderrTail = '';
  private readonly lines = new LineBuffer();
  /** requestId -> the tool input of the pending permission request. */
  private readonly pending = new Map<string, unknown>();

  constructor(private readonly opts: ChatSessionOptions) {
    super();
  }

  get agentId(): string {
    return this.opts.agentId;
  }

  /** True between `start()` and `exit`. */
  get alive(): boolean {
    return this.started && !this.exited;
  }

  /** The full argument vector handed to the child. */
  buildArgs(): string[] {
    const args = [...(this.opts.args ?? []), ...CLAUDE_STREAM_ARGS];
    if (this.opts.model) args.push('--model', this.opts.model);
    return args;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const command = this.opts.command ?? resolveCommand('claude');
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, this.buildArgs(), {
        cwd: this.opts.cwd,
        env: this.opts.env ?? defaultEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      this.fail(command, err);
      return;
    }
    this.child = child;

    child.on('error', (err) => {
      this.fail(command, err);
    });
    child.stdin.on('error', (err) => {
      console.warn(`[chat ${this.opts.agentId}] stdin: ${err.message}`);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.handleLines(this.lines.push(chunk));
    });
    child.stdout.on('end', () => {
      this.handleLines(this.lines.flush());
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      console.warn(`[chat ${this.opts.agentId}] stderr: ${chunk.trimEnd()}`);
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on('close', (code, signal) => {
      if (code !== 0 && !this.stopping && this.stderrTail.trim().length > 0) {
        this.emitEvent({ kind: 'error', message: `claude exited with an error: ${this.stderrTail.trim()}` });
      }
      this.finish(code, signal);
    });
  }

  send(text: string): void {
    if (!this.alive || !this.child || this.stopping) {
      this.emitEvent({ kind: 'error', message: 'Cannot send: the chat session is not running.' });
      return;
    }
    this.write(encodeUserMessage(text));
  }

  /**
   * Answers a pending permission request. An `allow` without `input` reuses the input remembered from
   * the request (or `{}`), so `updatedInput` is never lost. Unknown / already answered ids are ignored.
   */
  respondPermission(requestId: string, d: PermissionDecision): void {
    if (!this.pending.has(requestId)) {
      console.warn(`[chat ${this.opts.agentId}] permission response for unknown request ${requestId} ignored`);
      return;
    }
    const remembered = this.pending.get(requestId);
    this.pending.delete(requestId);
    const decision: PermissionDecision = d.allow ? { allow: true, input: d.input ?? remembered ?? {} } : d;
    this.write(encodePermissionResponse(requestId, decision));
  }

  /** Denies pending permissions, closes stdin, SIGTERM (after a short delay), then SIGKILL after the grace period. Idempotent. */
  stop(): void {
    if (this.exited || this.stopping) return;
    this.stopping = true;
    const child = this.child;
    if (!child) return; // never started (or failed to spawn): nothing to stop
    for (const id of [...this.pending.keys()]) {
      this.pending.delete(id);
      this.write(encodePermissionResponse(id, { allow: false, message: 'Session stopped.' }));
    }
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    // Give the CLI a moment to read the denials and exit on stdin EOF before the signals start.
    this.killTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      this.killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, this.opts.killTimeoutMs ?? 3000);
      this.killTimer.unref();
    }, TERM_DELAY_MS);
    this.killTimer.unref();
  }

  private write(line: string): void {
    const child = this.child;
    if (!child || this.exited || child.stdin.destroyed || !child.stdin.writable) return;
    try {
      child.stdin.write(line);
    } catch (err) {
      console.warn(`[chat ${this.opts.agentId}] write failed: ${(err as Error).message}`);
    }
  }

  private handleLines(lines: string[]): void {
    for (const line of lines) {
      for (const ev of parseClaudeLine(line)) {
        if (ev.kind === 'permission_request') this.pending.set(ev.requestId, ev.input);
        else if (ev.kind === 'permission_cancelled') this.pending.delete(ev.requestId);
        this.emitEvent(ev);
      }
    }
  }

  private fail(command: string, err: unknown): void {
    const e = err as NodeJS.ErrnoException;
    const hint = e.code === 'ENOENT' ? ' Is the Claude Code CLI installed and is the working directory valid?' : '';
    this.emitEvent({ kind: 'error', message: `Cannot start claude (${command}): ${e.message}.${hint}` });
    this.finish(null, null);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.pending.clear();
    if (this.killTimer) clearTimeout(this.killTimer);
    this.emitEvent({ kind: 'exit', code, signal });
  }

  private emitEvent(ev: ChatEvent): void {
    this.emit('event', ev);
  }
}

function defaultEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = buildPtyEnv(process.env, userShellPath());
  // PTY-oriented extras that make no sense for a piped child.
  delete env.FORCE_COLOR;
  delete env.COLORTERM;
  delete env.TERM;
  return env;
}
