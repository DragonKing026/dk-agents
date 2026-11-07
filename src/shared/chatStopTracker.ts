/**
 * Bookkeeping for the chat Stop button, kept pure so it can be tested. Two facts per agent:
 * - `stopped`: the user asked to stop, so the coming `exit` (SIGTERM, code 143...) is expected, not an error;
 * - `abortStart`: Stop was pressed while `chat:start` was still in flight, so the session must be
 *   stopped as soon as the start returns and the pending message must not be sent.
 */
export class StopTracker {
  private readonly stopped = new Set<string>();
  private readonly abortStart = new Set<string>();

  /** A new session is about to start: a stale request from an earlier session must not leak into it. */
  beginStart(agentId: string): void {
    this.stopped.delete(agentId);
    this.abortStart.delete(agentId);
  }

  /** The user pressed Stop. `starting` = a `chat:start` call is in flight. */
  requestStop(agentId: string, starting: boolean): void {
    this.stopped.add(agentId);
    if (starting) this.abortStart.add(agentId);
  }

  /** A stop turned out to be impossible (no session): forget it. */
  cancelStop(agentId: string): void {
    this.stopped.delete(agentId);
    this.abortStart.delete(agentId);
  }

  /** Called when the start returned: true when Stop was pressed meanwhile (the session must be stopped now). */
  consumeAbortStart(agentId: string): boolean {
    return this.abortStart.delete(agentId);
  }

  /** Called on `exit`: true when this exit was requested by the user (show it as a clean end). */
  consumeExit(agentId: string): boolean {
    this.abortStart.delete(agentId);
    return this.stopped.delete(agentId);
  }
}
