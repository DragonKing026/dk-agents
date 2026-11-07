/** The part of a chat session the map needs; `ClaudeChatSession` satisfies it. */
export interface ManagedChatSession {
  readonly stopping: boolean;
  readonly alive: boolean;
  stop(opts?: { immediate?: boolean }): void;
}

interface Entry<S, W> {
  session: S;
  sender: W;
}

/**
 * One chat session per agent. A session that is shutting down (`stopping`) counts as absent for lookups,
 * so a new start gets a fresh session while the old one finishes dying in the background; its late `exit`
 * must only remove itself (`removeIfCurrent`). Replaced sessions stay tracked until they exit so that
 * `stopAll` can still reach them on application quit.
 */
export class ChatSessionMap<S extends ManagedChatSession, W = unknown> {
  private readonly current = new Map<string, Entry<S, W>>();
  private readonly dying = new Set<S>();

  /** The live (not stopping) session entry of the agent, if any. */
  get(agentId: string): Entry<S, W> | undefined {
    const e = this.current.get(agentId);
    return e && !e.session.stopping && e.session.alive !== false ? e : undefined;
  }

  set(agentId: string, session: S, sender: W): Entry<S, W> {
    const prev = this.current.get(agentId);
    if (prev && prev.session !== session) this.dying.add(prev.session);
    const entry = { session, sender };
    this.current.set(agentId, entry);
    return entry;
  }

  /** Forget `session` (called on its `exit`); a newer session of the same agent is left alone. */
  removeIfCurrent(agentId: string, session: S): void {
    this.dying.delete(session);
    if (this.current.get(agentId)?.session === session) this.current.delete(agentId);
  }

  stopForSender(sender: W): void {
    for (const e of this.current.values()) if (e.sender === sender) e.session.stop();
  }

  stopAll(opts?: { immediate?: boolean }): void {
    const all = [...[...this.current.values()].map((e) => e.session), ...this.dying];
    for (const s of all) {
      try {
        s.stop(opts);
      } catch (e) {
        console.error('[chat] stop failed:', e);
      }
    }
  }
}
