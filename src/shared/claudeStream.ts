import type { ChatEvent, PermissionDecision } from './chatEvents';

/**
 * Claude Code CLI flags for a long-lived, bidirectional `stream-json` session. Recorded against
 * claude 2.1.319: permission prompts arrive as `control_request` (`can_use_tool`) lines on stdout
 * and are answered with a `control_response` line on stdin (no `initialize` handshake is needed).
 */
export const CLAUDE_STREAM_ARGS: readonly string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-prompt-tool',
  'stdio'
];

/** Reassembles NDJSON lines from arbitrarily split `data` chunks. */
export class LineBuffer {
  private pending = '';

  /** Feed a chunk; returns the complete, non-empty lines it finished (without line terminators). */
  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
  }

  /** Returns the unterminated tail (if any) and clears the buffer. */
  flush(): string[] {
    const rest = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending;
    this.pending = '';
    return rest.length > 0 ? [rest] : [];
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function flattenToolContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : ''))
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return '';
}

/** Parses one NDJSON line from the CLI's stdout. Unknown event types yield `[]`; invalid JSON yields one `error`. */
export function parseClaudeLine(line: string): ChatEvent[] {
  if (line.trim().length === 0) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    return [{ kind: 'error', message: `Unparseable line from claude: ${(err as Error).message}` }];
  }
  if (!isObj(raw)) return [];

  switch (raw.type) {
    case 'system':
      if (raw.subtype !== 'init') return [];
      return [{ kind: 'session', sessionId: str(raw.session_id), model: str(raw.model), cwd: str(raw.cwd) }];

    case 'assistant': {
      const message = isObj(raw.message) ? raw.message : {};
      const messageId = str(message.id);
      const events: ChatEvent[] = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isObj(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          events.push({ kind: 'text', messageId, text: block.text });
        } else if (block.type === 'tool_use') {
          events.push({ kind: 'tool_use', id: str(block.id), name: str(block.name), input: block.input });
        }
      }
      return events;
    }

    case 'user': {
      const message = isObj(raw.message) ? raw.message : {};
      const events: ChatEvent[] = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (isObj(block) && block.type === 'tool_result') {
          events.push({
            kind: 'tool_result',
            toolUseId: str(block.tool_use_id),
            content: flattenToolContent(block.content),
            isError: block.is_error === true
          });
        }
      }
      return events;
    }

    case 'control_request': {
      const req = isObj(raw.request) ? raw.request : {};
      if (req.subtype !== 'can_use_tool') return [];
      const ev: ChatEvent = {
        kind: 'permission_request',
        requestId: str(raw.request_id),
        toolName: str(req.tool_name),
        input: req.input
      };
      if (typeof req.tool_use_id === 'string') ev.toolUseId = req.tool_use_id;
      return [ev];
    }

    case 'control_cancel_request':
      return typeof raw.request_id === 'string' ? [{ kind: 'permission_cancelled', requestId: raw.request_id }] : [];

    case 'result': {
      const ev: ChatEvent = {
        kind: 'result',
        isError: raw.is_error === true || (typeof raw.subtype === 'string' && raw.subtype !== 'success')
      };
      if (typeof raw.result === 'string') ev.text = raw.result;
      if (typeof raw.total_cost_usd === 'number') ev.costUsd = raw.total_cost_usd;
      if (typeof raw.duration_ms === 'number') ev.durationMs = raw.duration_ms;
      return [ev];
    }

    default:
      return [];
  }
}

/** One NDJSON line (ending in `\n`) carrying a user chat message for the CLI's stdin. */
export function encodeUserMessage(text: string): string {
  return (
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'
  );
}

/** One NDJSON line (ending in `\n`) answering a `can_use_tool` control request. */
export function encodePermissionResponse(requestId: string, d: PermissionDecision): string {
  const response = d.allow
    ? { behavior: 'allow', updatedInput: d.input }
    : { behavior: 'deny', message: d.message };
  return (
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
    }) + '\n'
  );
}
