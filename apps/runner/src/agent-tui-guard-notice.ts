/**
 * The notice for an agent TUI that was opened WITHOUT the managed-worktree guard (#1438).
 *
 * A provider loads its hooks when it starts, so a running TUI cannot be given the guard afterwards.
 * Every guardable TUI is provisioned with it from the start, over an empty list the live refresh
 * keeps in step — but provisioning can fail for a session that owns nothing to protect (for Codex,
 * the person's own untrusted hooks rule out the trust bypass; for Claude, their own `--settings`
 * would be shadowed), and that TUI is opened anyway rather than refused. If the session then
 * acquires a runner-owned worktree while that TUI is still open, the worktree is unprotected inside
 * it. Nothing can repair that from outside the process, so the session is told, once per TUI, to
 * reopen it. Reopening provisions again with the worktree present, which guards or refuses.
 */

export interface AgentTuiGuardState {
  active: boolean;
  reason?: string;
}

interface UnguardedAgentTui {
  sessionId: string;
  reason?: string;
  notified: boolean;
}

export function unguardedAgentTuiNotice(reason?: string): string {
  return "The native TUI open for this session was started without Wollipog managed worktree " +
    `protection${reason ? ` (${reason})` : ""}, and a TUI cannot be given it while it runs. The ` +
    "worktree this session now owns is not protected inside that TUI. Close the TUI and open it " +
    "again to protect it.";
}

export class UnguardedAgentTuiRegistry {
  private readonly open = new Map<string, UnguardedAgentTui>();

  /**
   * Record an agent TUI that has just been opened. Returns the notice when the session already
   * owns a worktree: provisioning resolved its list before the open, and one created inside that
   * window is as unprotected in this TUI as one created later.
   */
  opened(
    shellId: string,
    sessionId: string,
    guard: AgentTuiGuardState | undefined,
    protectionCount: number,
  ): string | null {
    // No guard state means a provider with no guard mechanism at all; there is nothing to reopen for.
    if (!guard || guard.active) return null;
    this.open.set(shellId, { sessionId, reason: guard.reason, notified: false });
    return this.protectionsChanged(sessionId, protectionCount);
  }

  exited(shellId: string): void {
    this.open.delete(shellId);
  }

  /** The session's runner-owned worktree set changed; returns the notice the first time it matters. */
  protectionsChanged(sessionId: string, protectionCount: number): string | null {
    if (protectionCount === 0) return null;
    for (const tui of this.open.values()) {
      if (tui.sessionId !== sessionId || tui.notified) continue;
      tui.notified = true;
      return unguardedAgentTuiNotice(tui.reason);
    }
    return null;
  }
}
