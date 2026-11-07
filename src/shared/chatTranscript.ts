import type { ChatEvent } from './chatEvents';

export type PermissionState = 'pending' | 'allowed' | 'denied' | 'cancelled';

/** One row of the chat panel. Discriminated by `type`; `id` is unique and stable within a transcript. */
export type ChatItem =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'assistant'; messageId: string; text: string }
  | {
      id: string;
      type: 'tool';
      toolUseId: string;
      name: string;
      input: unknown;
      status: 'running' | 'done' | 'error';
      result?: string;
      isError?: boolean;
    }
  | {
      id: string;
      type: 'permission';
      requestId: string;
      toolName: string;
      input: unknown;
      toolUseId?: string;
      state: PermissionState;
    }
  | { id: string; type: 'notice'; level: 'info' | 'error'; text: string };

export interface ChatTranscript {
  items: ChatItem[];
  status: 'idle' | 'running' | 'waiting' | 'ended';
  sessionId?: string;
}

export function emptyTranscript(): ChatTranscript {
  return { items: [], status: 'idle' };
}

function nextId(t: ChatTranscript): string {
  return `i${t.items.length + 1}`;
}

function append(t: ChatTranscript, build: (id: string) => ChatItem): ChatTranscript {
  return { ...t, items: [...t.items, build(nextId(t))] };
}

function hasPending(items: ChatItem[]): boolean {
  return items.some((i) => i.type === 'permission' && i.state === 'pending');
}

function cancelPending(items: ChatItem[]): ChatItem[] {
  return items.map((i) => (i.type === 'permission' && i.state === 'pending' ? { ...i, state: 'cancelled' } : i));
}

/** Appends the user's message and marks the session as running (also restarts an ended one). */
export function addUserMessage(t: ChatTranscript, text: string): ChatTranscript {
  return { ...append(t, (id) => ({ id, type: 'user', text })), status: 'running' };
}

/** Records the user's answer to a pending permission card; leaves `waiting` once none are pending. */
export function resolvePermission(
  t: ChatTranscript,
  requestId: string,
  state: 'allowed' | 'denied'
): ChatTranscript {
  const items = t.items.map((i) =>
    i.type === 'permission' && i.requestId === requestId && i.state === 'pending' ? { ...i, state } : i
  );
  const status = t.status === 'waiting' && !hasPending(items) ? 'running' : t.status;
  return { ...t, items, status };
}

export function applyChatEvent(t: ChatTranscript, ev: ChatEvent): ChatTranscript {
  switch (ev.kind) {
    case 'session':
      return { ...t, sessionId: ev.sessionId };

    case 'text': {
      const last = t.items[t.items.length - 1];
      if (last && last.type === 'assistant' && last.messageId === ev.messageId) {
        const merged: ChatItem = { ...last, text: `${last.text}\n\n${ev.text}` };
        return { ...t, items: [...t.items.slice(0, -1), merged] };
      }
      return append(t, (id) => ({ id, type: 'assistant', messageId: ev.messageId, text: ev.text }));
    }

    case 'tool_use':
      return append(t, (id) => ({
        id,
        type: 'tool',
        toolUseId: ev.id,
        name: ev.name,
        input: ev.input,
        status: 'running'
      }));

    case 'tool_result': {
      let found = false;
      const items = t.items.map((i) => {
        if (i.type !== 'tool' || i.toolUseId !== ev.toolUseId) return i;
        found = true;
        return { ...i, result: ev.content, isError: ev.isError, status: ev.isError ? 'error' : 'done' } as ChatItem;
      });
      return found ? { ...t, items } : t;
    }

    case 'permission_request':
      return {
        ...append(t, (id) => ({
          id,
          type: 'permission',
          requestId: ev.requestId,
          toolName: ev.toolName,
          input: ev.input,
          ...(ev.toolUseId !== undefined ? { toolUseId: ev.toolUseId } : {}),
          state: 'pending'
        })),
        status: 'waiting'
      };

    case 'permission_cancelled': {
      const known = t.items.some((i) => i.type === 'permission' && i.requestId === ev.requestId && i.state === 'pending');
      if (!known) return t;
      const items = t.items.map((i) =>
        i.type === 'permission' && i.requestId === ev.requestId && i.state === 'pending' ? { ...i, state: 'cancelled' as const } : i
      );
      return { ...t, items, status: t.status === 'waiting' && !hasPending(items) ? 'running' : t.status };
    }

    case 'result': {
      const base: ChatTranscript = { ...t, items: cancelPending(t.items), status: 'idle' };
      return ev.isError
        ? append(base, (id) => ({ id, type: 'notice', level: 'error', text: ev.text ?? 'The agent finished with an error.' }))
        : base;
    }

    case 'error':
      return append(t, (id) => ({ id, type: 'notice', level: 'error', text: ev.message }));

    case 'exit': {
      const base: ChatTranscript = { ...t, items: cancelPending(t.items), status: 'ended' };
      if (ev.code === 0 || (ev.code === null && ev.signal === null)) return base;
      const how = ev.signal !== null ? `signal ${ev.signal}` : `code ${ev.code}`;
      return append(base, (id) => ({ id, type: 'notice', level: 'error', text: `The agent process exited (${how}).` }));
    }
  }
}
