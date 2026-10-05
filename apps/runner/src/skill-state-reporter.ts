import type { SkillsStateMessage, SkillLinkRemoval } from "@wollipog/protocol";
import { skillsStateMessage, type ReconcileSkillsResult } from "./skills.js";

const REQUEST_LIFETIME_MS = 30_000; // Existing skills-route/Hub request timeout, never extended here.
const MAX_DEFERRED_REQUESTS = 64;
const MAX_PENDING_REMOVALS = 256; // ControlPlaneDb's latest-removal event bound.
const STALE_INVENTORY_ERROR = "Skill inventory is stale: synchronization was superseded.";

export interface SkillReportRequest {
  readonly id: string;
  readonly expiresAt: number;
  readonly generation: number;
}

/** Keep a cancelled aggregate out of the full-replacement skills_state protocol. Observations
 * are copies handed to the normal send path, not acknowledgements of control-plane persistence.
 * Only cold-start supersession defers correlations; their existing server timeout is the fallback.
 */
export class SkillStateReporter {
  private observation?: SkillsStateMessage;
  // Admission and deferral share one bound. Capture duplicate identity before an earlier queued
  // pass finishes, so a later ticket cannot extend its lifetime or resurrect an evicted request.
  private readonly requests = new Map<string, { request: SkillReportRequest; deferred: boolean }>();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
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
    if (id === undefined) return undefined;
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

  /** The connection boundary invalidates unanswered requests, not the last local observation. */
  resetRequests(): void {
    this.generation++;
    this.requests.clear();
    this.armExpiry();
  }

  report(result: ReconcileSkillsResult, request?: SkillReportRequest, current = true): void {
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
      const errors = [STALE_INVENTORY_ERROR, this.observation.error, result.error,
        ...result.deployed.map(row => row.error)]
        .filter((error): error is string => Boolean(error));
      this.send({
        ...structuredClone(this.observation),
        ...(liveRequest ? { requestId: liveRequest.id } : {}),
        removals: structuredClone(result.removedLinks),
        error: [...new Set(errors)].join("; "),
      });
      if (liveRequest) this.requests.delete(liveRequest.id);
      this.armExpiry();
      return;
    }

    const message = skillsStateMessage(this.runnerId, result);
    message.removals = structuredClone(result.removedLinks.length ? result.removedLinks : this.pendingRemovals);
    // Snapshot before calling transport so a caller or transport cannot mutate the retained copy.
    const observation = structuredClone({ ...message, removals: [] });
    const requests = new Set([...this.requests.values()]
      .filter(entry => entry.deferred).map(entry => entry.request.id));
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
      if (!this.live(request)) {
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
