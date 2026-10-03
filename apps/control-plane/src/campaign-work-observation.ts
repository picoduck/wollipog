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
  /** Campaigns awaiting their coalesced refresh, and whether it also needs a revision bump. */
  private readonly pending = new Map<string, { bump: boolean }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: {
    db: Pick<ControlPlaneDb, "campaignWorkLedger">;
    /** Re-send every view that embeds the campaign's summary after its revision moved. */
    refresh(campaignSessionId: string): void;
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
      this.schedule(current.campaignSessionId, true);
    } catch (error) {
      this.deps.warn(`campaign work observation failed for ${sessionId}: ${String(error)}`);
    }
  }

  /** Called for every session removal. Deleting an attempt's session already moved its campaign's
   * revision in the database, which also queued the campaign, whether or not this process ever
   * observed the attempt; drain that queue so the views follow. A cascade that removed several
   * sessions is drained by whichever removal is broadcast first. */
  sessionRemoved(sessionId: string): void {
    this.observed.delete(sessionId);
    try {
      for (const campaignSessionId of this.deps.db.campaignWorkLedger.takeCampaignsWithDeletedAttemptSessions()) {
        this.schedule(campaignSessionId, false);
      }
    } catch (error) {
      this.deps.warn(`campaign work deletion refresh failed for ${sessionId}: ${String(error)}`);
    }
  }

  /** A stored forge fact (slice 8) changed its value or availability. Details read it, so it moves
   * the revision exactly like an observed session change, coalesced with them per campaign. */
  forgeChanged(campaignSessionId: string): void {
    this.schedule(campaignSessionId, true);
  }

  /** Apply every pending bump and refresh now. Used by tests and on shutdown. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = [...this.pending];
    this.pending.clear();
    const now = this.deps.now?.() ?? Date.now();
    for (const [campaignSessionId, { bump }] of pending) {
      try {
        if (bump) this.deps.db.campaignWorkLedger.observedChanged(campaignSessionId, now);
        this.deps.refresh(campaignSessionId);
      } catch (error) {
        this.deps.warn(`campaign work observation refresh failed for ${campaignSessionId}: ${String(error)}`);
      }
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.observed.clear();
  }

  private schedule(campaignSessionId: string, bump: boolean): void {
    this.pending.set(campaignSessionId, { bump: bump || (this.pending.get(campaignSessionId)?.bump ?? false) });
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.deps.delayMs ?? CAMPAIGN_OBSERVATION_COALESCE_MS);
    this.timer.unref?.();
  }
}
