/**
 * Merge closure watch (#4323, protocol v328; see `@wollipog/protocol` merge-closure-watch).
 *
 * `mergeClosures` reads what a `pr_merge` would close when it is requested, when it is armed and
 * before Wollipog's own enqueue. The forge closes issues when the merge lands, from the description
 * it has then, so after the decision is consumed this watcher keeps reading the same thing through
 * the child's runner until the pull request merges or closes:
 *
 * - Open at the approved head with closures that differ from `intendedClosures`: the decision is
 *   invalidated (it no longer covers the merge, and no longer proves delivery), the pull request is
 *   taken out of the merge queue or train for as long as it stays open at that head, and the child
 *   is told why. Once invalidated it stays so: a new merge needs a new decision.
 * - Merged: every issue it closed that `intendedClosures` does not list is reported to the
 *   campaign's owner with the pull request and the text that closed it.
 * - Unreadable: never "unchanged". After `unreadReportAfterMs` the owner is told the merge cannot be
 *   checked; after `giveUpAfterMs` the watch ends `unverified`.
 *
 * An unchanged pull request costs one read per interval and nothing else. A child whose runner
 * predates v328 is not watched, exactly as before.
 */
import {
  MERGE_CLOSURE_DEQUEUE_OUTCOMES,
  MERGE_CLOSURE_WATCH,
  campaignRepositoryLocation,
  runnerSupportsProtocol,
  type MergeClosureDequeueOutcome,
  type MergeClosureWatch,
  type MergeClosureWatchMessage,
  type MergeClosureWatchResultMessage,
  type PullRequestClosure,
  type WorkflowDecisionResourceSnapshot,
  type WorkflowDecisionView,
} from "@wollipog/protocol";
import { prMergeClosureMismatch, validClosingReferenceCheck } from "./pr-merge-closures.js";

/** What the owner is told: a landed merge closed an issue nobody approved, what it closes could not
 * be read, or Wollipog could not take a changed merge out of the queue. */
export type MergeClosureReportKind = "landed" | "unverified" | "not_dequeued";

type MergeSnapshot = Extract<WorkflowDecisionResourceSnapshot, { category: "pr_merge" }>;
export type WatchedMerge = WorkflowDecisionView & { resourceSnapshot: MergeSnapshot };

export interface MergeClosureWatcherDeps {
  /** Consumed merges not watched yet, and those still watched, oldest first. */
  targets(): WatchedMerge[];
  /** The runner of the child session, as last registered; null when either is gone. */
  childRunner(sessionId: string): { runnerId: string; protocolVersion: number | null | undefined; online: boolean } | null;
  requestFromRunner(runnerId: string, requestId: string, message: MergeClosureWatchMessage, timeoutMs: number): Promise<unknown>;
  /** Store `next` if the stored watch is still `previous`. */
  save(occurrenceId: string, previous: MergeClosureWatch | undefined, next: MergeClosureWatch): boolean;
  /** A later `pr_merge` for the same pull request and head that is pending, approved or consumed. */
  newerDecision(decision: WatchedMerge): boolean;
  /** Revoke an approved decision that has not been consumed yet. */
  revokeApproved(decision: WatchedMerge): void;
  /** Tell the child its decision no longer covers the merge. True once delivered or queued. */
  notifyChild(decision: WatchedMerge, watch: MergeClosureWatch): boolean;
  /** Tell the campaign's owner. */
  reportOwner(decision: WatchedMerge, watch: MergeClosureWatch, kind: MergeClosureReportKind): NonNullable<MergeClosureWatch["report"]>;
  /** The decision's watch changed in a way its views show. */
  changed(decision: WatchedMerge): void;
  log(event: Record<string, unknown>): void;
  warn(message: string): void;
  newRequestId(): string;
  now?: () => number;
}

const SUMMARY_LIMIT = 300;
const bounded = (text: string) => text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1)}…` : text;

/** The closures a landed merge made that the snapshot did not approve. */
export function unapprovedClosures(snapshot: MergeSnapshot, closures: readonly PullRequestClosure[]): PullRequestClosure[] {
  const approved = new Set(snapshot.intendedClosures ?? []);
  return closures.filter((closure) => !approved.has(closure.issue));
}

function changeRequestUrl(snapshot: MergeSnapshot): string {
  const gitlab = campaignRepositoryLocation(snapshot.repository);
  if (gitlab?.forge === "gitlab") return `https://${gitlab.host.toLowerCase()}/${gitlab.project}/-/merge_requests/${snapshot.pullRequest}`;
  return `https://github.com/${snapshot.repository}/pull/${snapshot.pullRequest}`;
}

/** Closures a report names one by one before summarizing the rest. */
const SHOWN_CLOSURES = 20;

/** Untrusted text as one plain line: no line breaks, code spans, tags or link syntax. */
function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/gu, " ").replace(/[`<>[\]]/gu, "'").trim();
}

/** One closure as untrusted text from the forge: one line, bounded, quoted, never Markdown. Only
 * this, never the comparison sentence that embeds the same text, reaches a prompt or the owner. */
function closureLine(closure: PullRequestClosure): string {
  const excerpt = closure.excerpt === undefined ? undefined : oneLine(closure.excerpt);
  const sources = closure.sources.includes("linked") && !excerpt ? "linked to the pull request on the forge"
    : closure.sources.includes("linked") ? "linked on the forge, and the description says" : "the description says";
  return `- ${closure.issue}: ${sources}${excerpt ? ` "${excerpt.length > 200 ? `${excerpt.slice(0, 199)}…` : excerpt}"` : ""}`;
}

function closureList(closures: readonly PullRequestClosure[]): string {
  const lines = closures.slice(0, SHOWN_CLOSURES).map(closureLine);
  if (closures.length > SHOWN_CLOSURES) lines.push(`- and ${closures.length - SHOWN_CLOSURES} more`);
  return lines.join("\n");
}

/** The child's notice that its merge decision no longer covers the merge (#4323). */
export function mergeClosureChangedPrompt(decision: WatchedMerge, watch: MergeClosureWatch): string {
  const snapshot = decision.resourceSnapshot;
  const kind = snapshot.mergeMethod !== undefined ? "merge request" : "pull request";
  const dequeued = watch.dequeue?.outcome === "dequeued" ? `Wollipog took it out of the ${snapshot.mergeMethod !== undefined ? "merge train" : "merge queue"}`
    : watch.dequeue?.outcome === "not_queued" ? "It was not queued, and Wollipog will take it out of the queue if it is enqueued"
    : "Wollipog is taking it out of the queue";
  return [
    `What ${changeRequestUrl(snapshot)} would close changed after its pr_merge decision (${decision.occurrenceId}) was approved, ` +
      `so that decision no longer covers this ${kind}. ${dequeued} while it stays open at ${snapshot.headSha}.`,
    `The decision approved closing ${snapshot.intendedClosures?.length ? snapshot.intendedClosures.join(", ") : "no issue"}.`,
    watch.mismatch?.closures.length ? `It would now close:\n${closureList(watch.mismatch.closures)}` : "It would now close no issue.",
    "Fix the description (reference an issue that must stay open as \"Refs #N\"), check it with `wollipog pr closures`, " +
      "and request a new pr_merge decision for this head before merging again.",
  ].filter(Boolean).join("\n\n");
}

/** The owner question that reports a merge's closures (#4323). Untrusted forge text appears only as
 * quoted single lines in the material. */
export function mergeClosureOwnerReport(decision: WatchedMerge, watch: MergeClosureWatch, kind: MergeClosureReportKind):
  { question: string; material: string; options: Array<{ optionId: string; label: string; description?: string }> } {
  const snapshot = decision.resourceSnapshot;
  const url = changeRequestUrl(snapshot);
  const approved = snapshot.intendedClosures?.length ? snapshot.intendedClosures.join(", ") : "none";
  const facts = [
    `- Pull request: ${url}`,
    `- Approved head: ${snapshot.headSha}`,
    `- Merge decision: ${decision.occurrenceId}, requested by session ${decision.sessionId}`,
    `- Closures the decision approved: ${approved}`,
  ];
  if (kind === "landed") {
    const closures = watch.unapprovedClosures ?? [];
    return {
      question: `${url} merged and closed ${closures.length === 1 ? "an issue" : `${closures.length} issues`} its approved merge did not list: ` +
        `${closures.slice(0, SHOWN_CLOSURES).map((closure) => closure.issue).join(", ")}${closures.length > SHOWN_CLOSURES ? ", and more" : ""}. ` +
        "Nobody approved these closures. Wollipog did not reopen them.",
      material: [...facts,
        ...(watch.invalidatedAt ? ["- Wollipog had found the change while it was queued and was taking it out of the queue."] : []),
        "", "What closed each issue:", closureList(closures)].join("\n"),
      options: [
        { optionId: "reopen", label: "Reopen Them", description: "Your Orchestrator reopens the issues and reports back." },
        { optionId: "keep", label: "Keep Them Closed", description: "The closures stand." },
      ],
    };
  }
  if (kind === "not_dequeued") {
    return {
      question: `What ${url} would close changed after its merge was approved, and Wollipog could not take it out of the queue. ` +
        "Remove it from the queue before it lands, or it may close issues nobody approved.",
      material: [...facts, `- Last attempt: ${watch.dequeue?.outcome ?? "none"}`,
        "", "What it would close:", closureList(watch.mismatch?.closures ?? []) || "- no issue"].join("\n"),
      options: [],
    };
  }
  return {
    question: `Wollipog cannot check what ${url} closes after its merge was approved: ${oneLine(watch.failure ?? "the forge could not be read.")} ` +
      "Check that it closes only the approved issues, before or after it lands.",
    material: facts.join("\n"),
    options: [],
  };
}

export class MergeClosureWatcher {
  private readonly attempted = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly deps: MergeClosureWatcherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pass(), MERGE_CLOSURE_WATCH.tickMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: start new watches, then read the due ones, at most `readsPerTick`. Never rejects. */
  async pass(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      const due: WatchedMerge[] = [];
      for (const decision of this.deps.targets()) {
        const watch = decision.closureWatch ?? this.begin(decision, now);
        if (!watch || (watch.state !== "watching" && watch.state !== "invalidated")) continue;
        const current = { ...decision, closureWatch: watch };
        if (now - watch.since > MERGE_CLOSURE_WATCH.expireAfterMs) {
          this.store(current, { ...watch, state: "ended", updatedAt: now, endReason: "Still open two weeks after approval; no longer watched." });
          continue;
        }
        const interval = now - watch.since > MERGE_CLOSURE_WATCH.slowAfterMs ? MERGE_CLOSURE_WATCH.slowReadIntervalMs : MERGE_CLOSURE_WATCH.readIntervalMs;
        const last = Math.max(this.attempted.get(decision.occurrenceId) ?? 0, watch.checkedAt ?? 0);
        if (this.inFlight.has(decision.occurrenceId) || now - last < interval) continue;
        due.push(current);
      }
      // Oldest reads first, so one busy campaign cannot starve another.
      due.sort((a, b) => (this.attempted.get(a.occurrenceId) ?? 0) - (this.attempted.get(b.occurrenceId) ?? 0));
      await Promise.all(due.slice(0, MERGE_CLOSURE_WATCH.readsPerTick).map((decision) => this.check(decision)));
    } catch (error) {
      this.deps.warn(`merge closure watch pass failed: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  /** Start watching a consumed merge, or record why it is not watched. */
  private begin(decision: WatchedMerge, now: number): MergeClosureWatch | null {
    const runner = this.deps.childRunner(decision.sessionId);
    // Only a runner known to be too old keeps today's behavior. A child already gone is watched
    // anyway: its reads fail, and the owner is told the merge could not be checked.
    const watch: MergeClosureWatch = runner && !runnerSupportsProtocol(runner.protocolVersion, "mergeClosureWatch")
      ? { state: "not_watched", since: now, updatedAt: now, endReason: "The child's runner predates the merge closure watch." }
      : { state: "watching", since: now, updatedAt: now };
    return this.deps.save(decision.occurrenceId, undefined, watch) ? watch : null;
  }

  private store(decision: WatchedMerge, next: MergeClosureWatch): boolean {
    const saved = this.deps.save(decision.occurrenceId, decision.closureWatch, next);
    if (saved) {
      if (next.state !== decision.closureWatch?.state) {
        this.deps.log({ event: "merge_closure_watch", occurrenceId: decision.occurrenceId, sessionId: decision.sessionId,
          repository: decision.resourceSnapshot.repository, pullRequest: decision.resourceSnapshot.pullRequest,
          state: next.state, ...(next.endReason ? { endReason: next.endReason } : {}) });
      }
      decision.closureWatch = next;
      this.deps.changed(decision);
    }
    return saved;
  }

  private async request(runnerId: string, decision: WatchedMerge, operation: "read" | "dequeue"): Promise<Partial<MergeClosureWatchResultMessage> | null> {
    const snapshot = decision.resourceSnapshot;
    const requestId = this.deps.newRequestId();
    try {
      const answer = await this.deps.requestFromRunner(runnerId, requestId, {
        type: "merge_closure_watch", requestId, sessionId: decision.sessionId, operation,
        repository: snapshot.repository, pullRequest: snapshot.pullRequest, headSha: snapshot.headSha,
      }, MERGE_CLOSURE_WATCH.requestTimeoutMs) as Partial<MergeClosureWatchResultMessage> | null;
      return answer?.type === "merge_closure_watch_result" && answer.sessionId === decision.sessionId && answer.operation === operation ? answer : null;
    } catch {
      return null;
    }
  }

  /** Read one watched merge now and act on what it says. */
  async check(decision: WatchedMerge): Promise<void> {
    if (this.inFlight.has(decision.occurrenceId)) return;
    this.inFlight.add(decision.occurrenceId);
    this.attempted.set(decision.occurrenceId, this.now());
    try {
      await this.checkOnce(decision);
    } finally {
      this.inFlight.delete(decision.occurrenceId);
    }
  }

  private async checkOnce(decision: WatchedMerge): Promise<void> {
    const watch = decision.closureWatch!;
    const snapshot = decision.resourceSnapshot;
    const gitlab = snapshot.mergeMethod !== undefined;
    const runner = this.deps.childRunner(decision.sessionId);
    const answer = runner?.online ? await this.request(runner.runnerId, decision, "read") : null;
    const check = answer?.ok === true ? validClosingReferenceCheck(answer.check, gitlab ? snapshot.repository : undefined) : null;
    const now = this.now();
    if (!answer || answer.ok !== true || !check || !["open", "merged", "closed"].includes(answer.state as string) ||
        typeof answer.headSha !== "string") {
      const reason = !runner ? "The child session or its runner is gone."
        : !runner.online ? "The child's runner is offline."
        : answer?.ok === false && typeof answer.reason === "string" ? bounded(answer.reason) : "The runner gave no valid answer.";
      this.unread(decision, reason, now);
      return;
    }
    const read: MergeClosureWatch = { ...watch, checkedAt: now, updatedAt: now };
    delete read.unreadSince;
    delete read.failure;
    // A newer merge of this pull request that was itself approved and consumed has its own checks
    // and its own watch, including of the landing. A request still pending or approved does not.
    if (answer.state !== "closed" && this.deps.newerDecision(decision)) {
      this.store(decision, { ...read, state: "ended", endReason: "A newer consumed merge decision for this pull request replaced this one." });
      return;
    }
    if (answer.state === "merged") {
      // Whatever head it merged at, what it closed is checked against this decision.
      this.landed(decision, read, check.closures, now);
      return;
    }
    if (answer.state === "closed") {
      this.store(decision, { ...read, state: "ended", endReason: "Closed without merging." });
      return;
    }
    const quiet = () => {
      // Only the read time is kept, quietly, unless it recovers from failed reads.
      if (watch.unreadSince !== undefined) this.store(decision, read);
      else if (this.deps.save(decision.occurrenceId, watch, read)) decision.closureWatch = read;
    };
    if (answer.headSha.toLowerCase() !== snapshot.headSha) {
      // The decision never covered another head, and its dequeue is pinned to its own: keep reading,
      // so a merge that lands from there is still checked and reported.
      quiet();
      return;
    }
    const mismatch = prMergeClosureMismatch(snapshot.intendedClosures ?? [], check.closures, gitlab ? "gitlab" : "github");
    if (!mismatch && watch.state === "watching") {
      quiet();
      return;
    }
    let next: MergeClosureWatch = read;
    if (mismatch && read.invalidatedAt === undefined) {
      next = { ...read, state: "invalidated", invalidatedAt: now, mismatch: { message: bounded(mismatch), closures: check.closures } };
      if (decision.status === "approved") this.deps.revokeApproved(decision);
    }
    if (!this.store(decision, next)) return;
    await this.dequeue(decision, runner!.runnerId);
  }

  /** Keep an invalidated merge out of the queue while it stays open at the approved head. */
  private async dequeue(decision: WatchedMerge, runnerId: string): Promise<void> {
    let watch = decision.closureWatch!;
    const attempts = watch.dequeue?.attempts ?? 0;
    const settled = watch.dequeue && (watch.dequeue.outcome === "dequeued" || watch.dequeue.outcome === "not_queued");
    // A dequeued pull request is read again every interval; it is dequeued again if re-enqueued.
    if (attempts < MERGE_CLOSURE_WATCH.maxDequeueAttempts || settled) {
      const answer = await this.request(runnerId, decision, "dequeue");
      const outcome: MergeClosureDequeueOutcome = answer?.ok === true && MERGE_CLOSURE_DEQUEUE_OUTCOMES.includes(answer.outcome as MergeClosureDequeueOutcome)
        ? answer.outcome as MergeClosureDequeueOutcome : "uncertain";
      const now = this.now();
      const unchanged = watch.dequeue?.outcome === outcome && (outcome === "dequeued" || outcome === "not_queued");
      const next: MergeClosureWatch = { ...watch, updatedAt: now,
        dequeue: { outcome, at: now, attempts: unchanged ? attempts : attempts + 1 } };
      if (!unchanged || outcome === "dequeued") {
        this.deps.log({ event: "merge_closure_dequeue", occurrenceId: decision.occurrenceId, sessionId: decision.sessionId,
          repository: decision.resourceSnapshot.repository, pullRequest: decision.resourceSnapshot.pullRequest, outcome });
      }
      if (this.store(decision, next)) watch = next;
    }
    if (watch.childNotifiedAt === undefined && this.deps.notifyChild(decision, watch)) {
      const notified = { ...watch, childNotifiedAt: this.now(), updatedAt: this.now() };
      if (this.store(decision, notified)) watch = notified;
    }
    // Wollipog could not take it out of the queue: a person has to, before it lands.
    const stuck = watch.dequeue && watch.dequeue.attempts >= MERGE_CLOSURE_WATCH.maxDequeueAttempts &&
      watch.dequeue.outcome !== "dequeued" && watch.dequeue.outcome !== "not_queued";
    if (stuck && !watch.report) this.store(decision, { ...watch, report: this.deps.reportOwner(decision, watch, "not_dequeued") });
  }

  private landed(decision: WatchedMerge, read: MergeClosureWatch, closures: PullRequestClosure[], now: number): void {
    const extra = unapprovedClosures(decision.resourceSnapshot, closures);
    if (!extra.length) {
      this.store(decision, { ...read, state: "verified", updatedAt: now });
      return;
    }
    const landed: MergeClosureWatch = { ...read, state: "landed_unapproved", unapprovedClosures: extra, updatedAt: now };
    if (!this.store(decision, landed)) return;
    this.store(decision, { ...landed, report: this.deps.reportOwner(decision, landed, "landed") });
  }

  private unread(decision: WatchedMerge, reason: string, now: number): void {
    const watch = decision.closureWatch!;
    const since = watch.unreadSince ?? now;
    let next: MergeClosureWatch = { ...watch, unreadSince: since, failure: reason, updatedAt: now };
    if (now - since >= MERGE_CLOSURE_WATCH.giveUpAfterMs) {
      next = { ...next, state: "unverified", endReason: "What this merge closes could not be read for a day; it is no longer watched." };
    }
    if (!this.store(decision, next)) return;
    if (!next.report && now - since >= MERGE_CLOSURE_WATCH.unreadReportAfterMs) {
      this.store(decision, { ...next, report: this.deps.reportOwner(decision, next, "unverified") });
    }
  }
}
