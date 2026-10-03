/**
 * Observed-status invalidation for the campaign work ledger (#2417, docs/campaign-work-ledger.md).
 *
 * A work item's derived state reads the observed status of its open attempt's session, so a child
 * going idle, failing, being held, or raising a request can move an item without any ledger write.
 * Readers bind their cursors and reloads to the ledger revision, so such a change needs a new
 * revision too. Every session upsert is checked here, but only a change to what the ledger observes
 * of an attempt's session counts, and changes are coalesced per campaign: a burst of child status
 * changes costs one revision and one refresh of the campaign views.
 */
import type { ControlPlaneDb } from "./db.js";

/** How long changes in one campaign are gathered before its single revision bump. */
export const CAMPAIGN_OBSERVATION_COALESCE_MS = 1_000;

interface ObservedAttempt {
  campaignSessionId: string;
  attemptId: string;
  key: string;
}

export class CampaignWorkObservations {
  /** What was last observed of each session executing an open attempt. */
  private readonly observed = new Map<string, ObservedAttempt>();
  /** Campaigns awaiting their coalesced bump, with the attempt sessions that changed. */
  private readonly pending = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: {
    db: Pick<ControlPlaneDb, "campaignWorkLedger">;
    /** Re-send the campaign's views after its revision moved. */
    refresh(campaignSessionId: string, sessionIds: readonly string[]): void;
    warn(message: string): void;
    delayMs?: number;
    now?: () => number;
  }) {}

  /** Called for every session upsert. Costs one indexed lookup for a session with no open attempt. */
  sessionChanged(sessionId: string): void {
    try {
      const current = this.deps.db.campaignWorkLedger.observedAttempt(sessionId);
      const previous = this.observed.get(sessionId);
      if (!current) {
        this.observed.delete(sessionId);
        return;
      }
      this.observed.set(sessionId, current);
      // An attempt this process has not observed yet may have changed since it was opened (or
      // since a restart), so it counts once; assignment itself already bumped the revision.
      if (previous?.attemptId === current.attemptId && previous.key === current.key) return;
      this.schedule(current.campaignSessionId, sessionId);
    } catch (error) {
      this.deps.warn(`campaign work observation failed for ${sessionId}: ${String(error)}`);
    }
  }

  /** A deleted session's attempts were already bumped by the ledger's deletion trigger; this only
   * re-sends the campaign views that show it. */
  sessionRemoved(sessionId: string): void {
    const previous = this.observed.get(sessionId);
    this.observed.delete(sessionId);
    if (previous) this.schedule(previous.campaignSessionId, null);
  }

  /** Apply every pending bump now. Used by tests and on shutdown. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = [...this.pending];
    this.pending.clear();
    const now = this.deps.now?.() ?? Date.now();
    for (const [campaignSessionId, sessionIds] of pending) {
      try {
        this.deps.db.campaignWorkLedger.observedChanged(campaignSessionId, now);
        this.deps.refresh(campaignSessionId, [...sessionIds]);
      } catch (error) {
        this.deps.warn(`campaign work observation bump failed for ${campaignSessionId}: ${String(error)}`);
      }
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.observed.clear();
  }

  private schedule(campaignSessionId: string, sessionId: string | null): void {
    const sessions = this.pending.get(campaignSessionId) ?? new Set<string>();
    if (sessionId) sessions.add(sessionId);
    this.pending.set(campaignSessionId, sessions);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.deps.delayMs ?? CAMPAIGN_OBSERVATION_COALESCE_MS);
    this.timer.unref?.();
  }
}
