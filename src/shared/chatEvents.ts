/** Normalized chat events produced by the Claude Code `stream-json` parser (and by the session wrapper). */
export type ChatEvent =
  | { kind: 'session'; sessionId: string; model: string; cwd: string }
  | { kind: 'text'; messageId: string; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'permission_request'; requestId: string; toolName: string; input: unknown; toolUseId?: string }
  | { kind: 'permission_cancelled'; requestId: string }
  | { kind: 'result'; isError: boolean; text?: string; costUsd?: number; durationMs?: number }
  | { kind: 'error'; message: string }
  | { kind: 'exit'; code: number | null; signal: string | null };

/** The user's answer to a permission request. `input` is the (possibly edited) tool input to run with. */
export type PermissionDecision = { allow: true; input: unknown } | { allow: false; message: string };
