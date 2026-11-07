import { useCallback, useSyncExternalStore } from 'react';
import type { ChatEvent } from '@shared/chatEvents';
import {
  addUserMessage,
  applyChatEvent,
  emptyTranscript,
  resolvePermission,
  type ChatTranscript
} from '@shared/chatTranscript';
import { StopTracker } from '@shared/chatStopTracker';

/**
 * Chat transcripts live in this module, not in component state: the panel unmounts when the user
 * switches tab or agent while the `claude` process in the main process keeps running, and the
 * conversation has to still be there on return. Memory only — persistence is a later stage.
 */
const transcripts = new Map<string, ChatTranscript>();
/** Agents whose main-process session is believed alive (set on a successful start, cleared on `exit`). */
const live = new Set<string>();
/** Stop requests: an expected `exit` shows no error notice; a Stop during `chat:start` stops the session once it started. */
const stops = new StopTracker();
/** In-flight `chat:start` calls, so a quick second message waits for the first start. */
const starting = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();
const EMPTY = emptyTranscript();
let unsubscribeIpc: (() => void) | null = null;

function emit(): void {
  for (const l of listeners) l();
}

function update(agentId: string, fn: (t: ChatTranscript) => ChatTranscript): void {
  const next = fn(transcripts.get(agentId) ?? EMPTY);
  transcripts.set(agentId, next);
  emit();
}

function apply(agentId: string, ev: ChatEvent): void {
  if (ev.kind === 'exit') {
    live.delete(agentId);
    if (stops.consumeExit(agentId)) ev = { kind: 'exit', code: null, signal: null };
  }
  update(agentId, (t) => applyChatEvent(t, ev));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // One IPC subscription for the whole renderer, created with the first panel and kept for its lifetime
  // (events arrive for every agent, also while its panel is not mounted).
  if (!unsubscribeIpc) unsubscribeIpc = window.cth.chat.onEvent(apply);
  return () => {
    listeners.delete(listener);
  };
}

async function ensureStarted(agentId: string, model: string | undefined): Promise<boolean> {
  if (live.has(agentId)) return true;
  const pending = starting.get(agentId);
  if (pending) return pending;
  stops.beginStart(agentId);
  const p = (async () => {
    try {
      const res = await window.cth.chat.start(agentId, model ? { model } : undefined);
      if (!res.ok) {
        apply(agentId, { kind: 'error', message: res.error ?? 'Could not start the chat session.' });
        apply(agentId, { kind: 'exit', code: null, signal: null });
        return false;
      }
      if (stops.consumeAbortStart(agentId)) {
        // Stop was pressed while the session was starting: stop it now; its `exit` ends the transcript.
        void window.cth.chat.stop(agentId);
        return false;
      }
      live.add(agentId);
      return true;
    } catch (err) {
      apply(agentId, { kind: 'error', message: err instanceof Error ? err.message : String(err) });
      apply(agentId, { kind: 'exit', code: null, signal: null });
      return false;
    } finally {
      starting.delete(agentId);
    }
  })();
  starting.set(agentId, p);
  return p;
}

export interface UseChat {
  transcript: ChatTranscript;
  /** Sends a message; the session starts lazily with the first one (and again after it ended). */
  send(text: string): void;
  /** Answers a permission card. */
  decide(requestId: string, allow: boolean): void;
  /** Stops the running session (the transcript then shows "ended"). */
  stop(): void;
  /** Leaves the ended state; the next message starts a fresh session (the old transcript stays visible). */
  restart(): void;
}

export function useChat(agentId: string, model?: string): UseChat {
  const transcript = useSyncExternalStore(
    subscribe,
    () => transcripts.get(agentId) ?? EMPTY
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      update(agentId, (t) => addUserMessage(t, trimmed));
      void (async () => {
        if (!(await ensureStarted(agentId, model))) return;
        try {
          const res = await window.cth.chat.send(agentId, trimmed);
          if (!res.ok) apply(agentId, { kind: 'error', message: res.error ?? 'Could not send the message.' });
        } catch (err) {
          apply(agentId, { kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      })();
    },
    [agentId, model]
  );

  const decide = useCallback(
    (requestId: string, allow: boolean) => {
      update(agentId, (t) => resolvePermission(t, requestId, allow ? 'allowed' : 'denied'));
      void window.cth.chat.permission(agentId, requestId, allow).then((res) => {
        if (!res.ok) apply(agentId, { kind: 'error', message: res.error ?? 'Could not answer the permission request.' });
      });
    },
    [agentId]
  );

  const stop = useCallback(() => {
    const inFlight = starting.has(agentId);
    stops.requestStop(agentId, inFlight);
    if (inFlight) return; // the start handler stops the session as soon as it exists
    void window.cth.chat.stop(agentId).then((res) => {
      if (!res.ok) stops.cancelStop(agentId);
    });
  }, [agentId]);

  const restart = useCallback(() => {
    live.delete(agentId);
    update(agentId, (t) => ({ ...t, status: 'idle' }));
  }, [agentId]);

  return { transcript, send, decide, stop, restart };
}
