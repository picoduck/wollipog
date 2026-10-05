import {
  MAX_SKILL_REPORT_REQUESTS,
  SKILL_REPORT_REQUEST_LIFETIME_MS,
  type PendingSkillReportRequest,
  type SkillsStateMessage,
  type SkillLinkRemoval,
} from "@wollipog/protocol";
import { skillsStateMessage, type ReconcileSkillsResult } from "./skills.js";

const REQUEST_LIFETIME_MS = SKILL_REPORT_REQUEST_LIFETIME_MS;
const MAX_DEFERRED_REQUESTS = MAX_SKILL_REPORT_REQUESTS;
const MAX_PENDING_REMOVALS = 256; // ControlPlaneDb's latest-removal event bound.
const STALE_INVENTORY_ERROR = "Skill inventory is stale: synchronization was superseded.";

export interface SkillReportRequest {
  readonly id: string;
  readonly expiresAt: number;
  readonly generation: number;
}

/** Keep a cancelled aggregate out of the full-replacement skills_state protocol. Observations
 * are copies handed to the normal send path, not acknowledgements of control-plane persistence.
 * Cold-start supersession and server-authorized replacement admissions defer correlations;
 * their original bounded lifetime and existing server request behavior remain the fallback.
 */
export class SkillStateReporter {
  private observation?: SkillsStateMessage;
  // Admission and deferral share one bound. Capture duplicate identity before an earlier queued
  // pass finishes, so a later ticket cannot extend its lifetime or resurrect an evicted request.
  private readonly requests = new Map<string, { request: SkillReportRequest; deferred: boolean; currentResultOnly?: boolean }>();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private connectionStartedAt = 0;
  private awaitingAuthority = false;

  get connectionGeneration(): number { return this.generation; }
  get awaitingConnectionAuthority(): boolean { return this.awaitingAuthority; }
  private pendingRemovals: SkillLinkRemoval[] = [];

  constructor(
    private readonly runnerId: string,
    private readonly send: (message: SkillsStateMessage) => void,
    private readonly log: (message: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Capture before a task enters the serialized reconciliation queue. */
  request(id?: string): SkillReportRequest | undefined {
    this.prune();
    if (id === undefined || this.awaitingAuthority) return undefined;
    const previous = this.requests.get(id);
    if (previous) return previous.request;
    if (this.requests.size === MAX_DEFERRED_REQUESTS) {
      const oldest = [...this.requests.values()].reduce((left, right) =>
        left.request.expiresAt <= right.request.expiresAt ? left : right).request;
      this.requests.delete(oldest.id);
      this.note("skill_request_evicted", oldest, { fallback: "server_timeout", capacity: MAX_DEFERRED_REQUESTS });
    }
    const request = { id, expiresAt: this.now() + REQUEST_LIFETIME_MS, generation: this.generation };
    this.requests.set(id, { request, deferred: false });
    this.armExpiry();
    return request;
  }

  /** Invalidate old work, retaining only bounded inactive evidence for registration's intersection. */
  beginConnection(): void {
    this.prune();
    this.generation++;
    this.connectionStartedAt = this.now();
    this.awaitingAuthority = true;
    this.pendingRemovals = [];
  }

  /** Accept authority once, anchored before register was sent, never at delayed receipt time. */
  resumeRequests(authority?: readonly PendingSkillReportRequest[]): void {
    if (!this.awaitingAuthority) return;
    this.awaitingAuthority = false;
    this.prune();
    const candidates = new Map(this.requests);
    this.requests.clear();
    const seen = new Set<string>();
    const valid = Array.isArray(authority) && authority.length <= MAX_DEFERRED_REQUESTS && authority.every(entry => {
      if (!entry || typeof entry !== "object" || typeof entry.requestId !== "string" ||
          entry.requestId.length === 0 || entry.requestId.length > 1024 || /[\x00-\x1f\x7f]/.test(entry.requestId) ||
          seen.has(entry.requestId) || !Number.isFinite(entry.remainingMs) ||
          entry.remainingMs <= 0 || entry.remainingMs > REQUEST_LIFETIME_MS) return false;
      seen.add(entry.requestId);
      return true;
    });
    if (valid) for (const { requestId, remainingMs } of authority) {
      const candidate = candidates.get(requestId);
      if (!candidate) continue;
      // Server projection causally follows connectionStartedAt. The conservative anchor charges
      // all registration delay, while min also preserves earliest admission across reconnects.
      const expiresAt = Math.min(candidate.request.expiresAt, this.connectionStartedAt + remainingMs);
      if (expiresAt <= this.now()) continue;
      const request = { id: requestId, expiresAt, generation: this.generation };
      this.requests.set(requestId, { request, deferred: true, currentResultOnly: true });
    }
    this.armExpiry();
  }

  /** Full disposal invalidates unanswered requests, not the last local observation. */
  resetRequests(): void {
    this.generation++;
    this.requests.clear();
    this.awaitingAuthority = false;
    this.pendingRemovals = [];
    this.armExpiry();
  }

  report(result: ReconcileSkillsResult, request?: SkillReportRequest, current = true, generation = this.generation): void {
    if (generation !== this.generation || this.awaitingAuthority) return;
    this.prune();
    const liveRequest = request && this.live(request) ? request : undefined;
    if (result.superseded || !current) {
      this.note("skill_inventory_superseded", liveRequest, { retainedObservation: Boolean(this.observation) });
      if (!this.observation) {
        if (result.removedLinks.length) {
          this.pendingRemovals = structuredClone(result.removedLinks.slice(0, MAX_PENDING_REMOVALS));
        }
        if (liveRequest) this.requests.get(liveRequest.id)!.deferred = true;
        return;
      }
      const staleRequest = liveRequest && !this.requests.get(liveRequest.id)?.currentResultOnly ? liveRequest : undefined;
      const errors = [STALE_INVENTORY_ERROR, this.observation.error, result.error,
        ...result.deployed.map(row => row.error)]
        .filter((error): error is string => Boolean(error));
      this.send({
        ...structuredClone(this.observation),
        ...(staleRequest ? { requestId: staleRequest.id } : {}),
        removals: structuredClone(result.removedLinks),
        error: [...new Set(errors)].join("; "),
      });
      if (staleRequest) this.requests.delete(staleRequest.id);
      this.armExpiry();
      return;
    }

    const message = skillsStateMessage(this.runnerId, result);
    message.removals = structuredClone(result.removedLinks.length ? result.removedLinks : this.pendingRemovals);
    // Keep real events across a failed handoff for a fresh pass in this generation. The
    // connection boundary clears them; successful first handoff consumes them exactly once.
    this.pendingRemovals = structuredClone(message.removals.slice(0, MAX_PENDING_REMOVALS));
    // Snapshot before calling transport so a caller or transport cannot mutate the retained copy.
    const observation = structuredClone({ ...message, removals: [] });
    const requests = new Set([...this.requests.values()]
      .filter(entry => entry.deferred && this.live(entry.request)).map(entry => entry.request.id));
    if (liveRequest) requests.add(liveRequest.id);
    const ids: Array<string | undefined> = requests.size ? [...requests] : [undefined];
    for (const [index, id] of ids.entries()) {
      this.send({
        ...structuredClone(message),
        ...(id === undefined ? {} : { requestId: id }),
        ...(index === 0 ? {} : { removals: [] }),
      });
      // A throwing send did not hand off an observation or consume its removal event/correlation.
      this.observation = observation;
      this.pendingRemovals = [];
      if (id !== undefined) this.requests.delete(id);
    }
    this.armExpiry();
  }

  private live(request: SkillReportRequest): boolean {
    return request.generation === this.generation && request.expiresAt > this.now() &&
      this.requests.get(request.id)?.request === request;
  }

  private prune(): void {
    for (const [id, { request }] of this.requests) {
      if (request.expiresAt <= this.now()) {
        this.requests.delete(id);
        this.note("skill_request_expired", request, { fallback: "server_timeout" });
      }
    }
    this.armExpiry();
  }

  private armExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (!this.requests.size) return;
    const earliest = Math.min(...[...this.requests.values()].map(entry => entry.request.expiresAt));
    this.expiryTimer = setTimeout(() => this.prune(), Math.max(1, earliest - this.now()));
    this.expiryTimer.unref?.();
  }

  /** Diagnostics answer whether an observation was retained and why a correlation fell back to
   * its server timeout. Allowlist metadata only: no skill content, account homes or error bodies. */
  private note(event: string, request: SkillReportRequest | undefined, fields: Record<string, unknown>): void {
    this.log(JSON.stringify({ event, level: "warn", entryPoint: "skill_reconciliation",
      runnerId: this.runnerId, requestId: request?.id ?? null, ...fields }));
  }
}
