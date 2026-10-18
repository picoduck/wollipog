import { createHash } from "node:crypto";
import { isTerminal, mediaActiveStopIdentityBody, mediaReviewerAttestationBody, pacedVideoReviewWindowPlan, PACED_VIDEO_REVIEW_MIN_PROTOCOL, PACED_VIDEO_REVIEW_WINDOW_LIMITS,
  supportsPacedVideoReviewPeer, type ClaudeMediaReviewerAttestation, type CreateSessionRequest, type MediaActiveStopIdentity,
  type MediaActiveStopRequest, type MediaNeverDispatchedFence, type MediaReviewDispatchReceipt, type MediaReviewFinished,
  type SessionView, type VideoReviewerInstallationGap, type WorkflowDecisionView } from "@wollipog/protocol";
import { RUNNER_REPORTED_STOP, sessionStopRestorable, type ControlPlaneDb } from "./db.js";
import { EvidenceReviewBudgetProvenance } from "./evidence-review-budget-provenance.js";
import type { EvidenceReviewService, EvidenceReviewServiceAdapter, ResolvedVideoReviewRequest } from "./evidence-review-service.js";
import { validVideoLiveProof, type EvidenceReviewerTarget, type ReviewerAdmissionContext } from "./evidence-review-worker.js";
import type { AgentPrincipal, AuthPrincipal } from "./identity.js";
import type { PreparedMediaActiveStopPorts } from "./prepared-media-active-stops.js";
import { PreparedMediaReservationRelease } from "./prepared-media-reservation-release.js";
import type { PreparedMediaSessionRuntime, PreparedMediaSubject } from "./prepared-media-session-runtime.js";
import { PreparedMediaSessions, type MaterializedMediaSession, type PreparedMediaBinding, type PreparedMediaIdentity,
  type PreparedMediaRecord } from "./prepared-media-sessions.js";
import { videoReviewBindingDigest, type VideoReviewBinding, type VideoReviewCriterion, type VideoReviewRecord,
  type VideoReviewRuntimeAccess, type VideoReviewStore, type VideoReviewVerdict } from "./video-evidence-runtime.js";
import type { VideoLiveValidationRegistry } from "./video-live-validation.js";
import type { WorkflowVideoEvidenceAccess } from "./workflow-video-evidence-approvals.js";

const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

/** The certification reviewer (#1321): Claude Opus 5.5 at high effort, the measured cost basis.
 * A live validation proof certifies exactly this model, effort and runner attestation. */
export const VIDEO_REVIEWER_MODEL = "claude-opus-5-5";
export const VIDEO_REVIEWER_EFFORT = "high";
/** Per-review ceilings, bounded again by the campaign allocation. Planning estimate from the
 * operator probe: a 1280x720 frame is about 1196 image tokens at the $4/MTok input list price,
 * resent within each window of at most 60 frames, so a 900-frame review fits in $10. */
export const VIDEO_REVIEW_CEILINGS = Object.freeze({ costBudgetUsd: 10, maxToolCalls: 120 });
/** A busy host requeues a fresh identity after each backoff: at most three requeues, and none
 * later than 20 minutes after the first busy refusal. Nothing is reserved while queued. */
export const VIDEO_REVIEW_BUSY_BACKOFF_MS = Object.freeze([30_000, 120_000, 480_000]);
export const VIDEO_REVIEW_BUSY_LIMIT_MS = 20 * 60_000;
/** Server-pinned criteria. Neither the child nor the owner supplies them, so the reviewer judges
 * every capture by the same unbiased standard and the owner decides from its observations. */
export const VIDEO_REVIEW_CRITERIA: readonly VideoReviewCriterion[] = Object.freeze([
  { criterionId: "visual_defects", description: "Every frame is free of transient visual defects: flashes, flicker, blank or " +
    "partially rendered frames, overlapping or clipped elements, layout jumps and error states. Cite each defect's exact frame index." },
  { criterionId: "coherent_flow", description: "The recording proceeds coherently from frame to frame: each visible state change " +
    "follows from the previous state, with no unexplained jumps, stalls or reversions. Cite the frames of any break." },
]);

type ReviewState = "preparing" | "dispatched" | "queued" | "finished" | "refused";
export type VideoReviewRefusalCode = "not_authorized" | "custom_fallback" | "mixed_peer" | "live_validation" |
  "reviewer_unavailable" | "allowance" | "preparation" | "reviewer_busy_exhausted" | "reviewer_lost";
interface ReviewRow {
  occurrenceId: string; evidenceId: string; rootSessionId: string; childSessionId: string;
  attempt: number; state: ReviewState; reason: string | null; reviewId: string | null; reviewIds: string[];
  reviewerSessionId: string | null; firstBusyAt: number | null; nextAttemptAt: number | null;
  /** Busy-host requeues so far for this original subject; a new attempt never resets it. */
  busyRequeues: number;
  finished: MediaReviewFinished | null; updatedAt: number;
}

/** The SessionsService surface this composition uses. Each method re-reads current records. */
export interface DelegatedVideoSessions {
  delegatedVideoGate(occurrenceId: string, statuses: readonly WorkflowDecisionView["status"][]):
    { root: SessionView; child: SessionView; decision: WorkflowDecisionView } | null;
  sessionPacedVideoPeer(sessionId: string): boolean;
  preflightPreparedMediaSession(identity: PreparedMediaIdentity, subject: PreparedMediaSubject): { ok: boolean; error?: string };
  materializePreparedMediaSession(identity: PreparedMediaIdentity, subject: PreparedMediaSubject):
    { ok: boolean; data?: MaterializedMediaSession; error?: string };
  publishPreparedMediaSession(record: PreparedMediaRecord): void;
  campaignBudgetWorkerPreflight(campaignId: string, worker: { kind: "managed"; sessionId: string }):
    { ok: boolean; data?: import("./evidence-review-admission.js").EvidenceReviewerBudgetAdmission };
  onMediaReviewNeverDispatched(runnerId: string, receipt: MediaNeverDispatchedFence): boolean;
  /** The single lifecycle authority for a dispatched reviewer; see SessionsService. */
  dedicatedMediaReviewerOpen(sessionId: string): boolean;
  /** The ordinary Stop, which for an active media reviewer is the dedicated owning-runner Stop. */
  stop(sessionId: string): { ok: boolean };
}
export interface DelegatedVideoHub {
  sendToRunner(runnerId: string, message: import("@wollipog/protocol").ControlPlaneToRunner): boolean;
  isRunnerOnline(runnerId: string): boolean;
  sessionChangedById(sessionId: string): void;
}

/** Durable per-subject ledger: one row per original (occurrence, evidence) across every attempt,
 * so a busy-host cap is never reset by the fresh identities its requeues create. */
class ReviewLedger {
  constructor(private readonly db: ControlPlaneDb) {
    db.raw().exec("CREATE TABLE IF NOT EXISTS delegated_video_reviews (" +
      "occurrence_id TEXT NOT NULL REFERENCES workflow_decisions(occurrence_id) ON DELETE CASCADE," +
      "evidence_id TEXT NOT NULL, record TEXT NOT NULL, review_id TEXT, reviewer_session_id TEXT," +
      "PRIMARY KEY(occurrence_id, evidence_id));" +
      "CREATE INDEX IF NOT EXISTS delegated_video_reviews_reviewer ON delegated_video_reviews(reviewer_session_id);" +
      // Authenticated runner launch outcomes, read back by the coordinator's reconcile port.
      "CREATE TABLE IF NOT EXISTS delegated_video_dispatch_outcomes (session_id TEXT NOT NULL,generation TEXT NOT NULL," +
      "outcome TEXT NOT NULL CHECK(outcome IN ('accepted','never_dispatched')),reason TEXT,observed_at INTEGER NOT NULL," +
      "PRIMARY KEY(session_id,generation));" +
      // The reviewer's final accounting, committed with its terminal status. Until a row exists the
      // reviewer stays eligible for readback, whatever its Session status says.
      "CREATE TABLE IF NOT EXISTS delegated_video_dispositions (session_id TEXT NOT NULL,generation TEXT NOT NULL," +
      "disposition TEXT NOT NULL CHECK(disposition IN ('settled','retained_unpriced','retained_unknown')),recorded_at INTEGER NOT NULL," +
      "PRIMARY KEY(session_id,generation));");
  }
  get(occurrenceId: string, evidenceId: string): ReviewRow | null {
    const row = this.db.raw().prepare("SELECT record FROM delegated_video_reviews WHERE occurrence_id=? AND evidence_id=?")
      .get(occurrenceId, evidenceId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as ReviewRow : null;
  }
  byReviewer(sessionId: string): ReviewRow | null {
    const row = this.db.raw().prepare("SELECT record FROM delegated_video_reviews WHERE reviewer_session_id=?")
      .get(sessionId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as ReviewRow : null;
  }
  /** Any attempt's review id finds the subject, so an owner polling an earlier id sees the latest. */
  byReview(reviewId: string): ReviewRow | null {
    const row = this.db.raw().prepare("SELECT d.record FROM delegated_video_reviews d, json_each(json_extract(d.record,'$.reviewIds')) r " +
      "WHERE r.value=?").get(reviewId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as ReviewRow : null;
  }
  unfinished(): ReviewRow[] {
    return (this.db.raw().prepare("SELECT record FROM delegated_video_reviews WHERE json_extract(record,'$.state')='dispatched'").all() as
      Array<{ record: string }>).map((row) => JSON.parse(row.record) as ReviewRow);
  }
  queued(): ReviewRow[] {
    return (this.db.raw().prepare("SELECT record FROM delegated_video_reviews WHERE json_extract(record,'$.state')='queued'").all() as
      Array<{ record: string }>).map((row) => JSON.parse(row.record) as ReviewRow);
  }
  save(row: ReviewRow): void {
    this.db.raw().prepare("INSERT INTO delegated_video_reviews(occurrence_id,evidence_id,record,review_id,reviewer_session_id) VALUES (?,?,?,?,?) " +
      "ON CONFLICT(occurrence_id,evidence_id) DO UPDATE SET record=excluded.record,review_id=excluded.review_id,reviewer_session_id=excluded.reviewer_session_id")
      .run(row.occurrenceId, row.evidenceId, JSON.stringify(row), row.reviewId, row.reviewerSessionId);
  }
}

const identityFor = (row: Pick<ReviewRow, "rootSessionId" | "childSessionId" | "occurrenceId" | "evidenceId" | "attempt">,
  resourceDigest: string): PreparedMediaIdentity => ({
  rootSessionId: row.rootSessionId, childSessionId: row.childSessionId,
  admissionId: `video_review_${sha(`${row.occurrenceId}\0${row.evidenceId}`).slice(0, 32)}_${row.attempt}`,
  requestSha256: sha({ occurrenceId: row.occurrenceId, evidenceId: row.evidenceId, resourceDigest, attempt: row.attempt }),
});
const identityOf = (record: PreparedMediaIdentity): PreparedMediaIdentity => ({ rootSessionId: record.rootSessionId,
  childSessionId: record.childSessionId, admissionId: record.admissionId, requestSha256: record.requestSha256 });
const videoItem = (decision: WorkflowDecisionView, evidenceId: string) => decision.resourceSnapshot.category === "ui_evidence_approval"
  ? decision.resourceSnapshot.evidence.find((item) => item.evidenceId === evidenceId &&
    (item.mediaType === "video/webm" || item.mediaType === "video/mp4") && item.artifactId) ?? null : null;
const validAttestation = (value: ClaudeMediaReviewerAttestation | undefined): value is ClaudeMediaReviewerAttestation =>
  Boolean(value && value.profile === "claude-code-media-only-v1" && value.harness === "claude-code" &&
    value.credential === "dedicated_api_key" && value.windowLimitsRevision === PACED_VIDEO_REVIEW_WINDOW_LIMITS.revision &&
    JSON.stringify(value.tools) === JSON.stringify(["review_video_evidence_frame", "submit_video_evidence_verdict"]) &&
    /^[a-f0-9]{64}$/u.test(value.namespacePolicySha256) && /^[a-f0-9]{64}$/u.test(value.executableSha256));
export const mediaReviewerAttestationSha256 = (attestation: ClaudeMediaReviewerAttestation) => sha(mediaReviewerAttestationBody(attestation));

/** Installations on one runner that can host the certified media-only reviewer: a Claude Code
 * agent declaring the paced contract, a valid runner attestation and the certified model. */
export function mediaReviewerInstallations(db: ControlPlaneDb, runnerId?: string) {
  return db.listRunners().filter((runner) => runnerId === undefined || runner.runnerId === runnerId).flatMap((runner) =>
    runner.agents.filter((agent) => agent.driver === "claude-code" &&
      supportsPacedVideoReviewPeer(runner.protocolVersion, agent.capabilities?.pacedVideoReviewContract) &&
      validAttestation(agent.capabilities?.mediaReviewerAttestation) && agent.capabilities.mediaReviewerAttestation.agentId === agent.id &&
      (agent.capabilities.models ?? []).some((model) => model.id === VIDEO_REVIEWER_MODEL) &&
      (agent.capabilities.effortLevels ?? []).includes(VIDEO_REVIEWER_EFFORT))
      .map((agent) => ({ runnerId: runner.runnerId, protocolVersion: runner.protocolVersion!, agentId: agent.id,
        contract: agent.capabilities!.pacedVideoReviewContract, attestation: agent.capabilities!.mediaReviewerAttestation! })));
}

const GAP_REASONS: Record<VideoReviewerInstallationGap, string> = {
  no_claude_code_agent: "This machine has no native Claude Code agent, the only harness that can host the media-only reviewer.",
  runner_protocol: "This machine's Wollipog is too old to advertise the paced video review contract; update it.",
  no_attestation: "Its Claude Code agent has no media-only reviewer attestation. Install the pinned Claude Code CLI, provision the dedicated reviewer API key and restart the runner.",
  reviewer_model: `Its Claude Code agent does not offer ${VIDEO_REVIEWER_MODEL} at ${VIDEO_REVIEWER_EFFORT} effort.`,
};

/** Every native Claude Code agent on every registered runner, with the first reason it cannot
 * host the media-only reviewer, in the same order `mediaReviewerInstallations` checks. */
export function mediaReviewerInstallationGaps(db: ControlPlaneDb) {
  return db.listRunners().flatMap((runner) => {
    const agents = runner.agents.filter((agent) => agent.driver === "claude-code" && (agent.context?.kind ?? "native") === "native");
    const row = (agentId: string | null, code: VideoReviewerInstallationGap | null) => ({ runnerId: runner.runnerId,
      machineName: runner.displayName ?? runner.hostname, agentId, gap: code ? { code, reason: GAP_REASONS[code] } : null });
    if (!agents.length) return [row(null, "no_claude_code_agent")];
    return agents.map((agent) => {
      const capabilities = agent.capabilities;
      if (!runner.protocolVersion || runner.protocolVersion < PACED_VIDEO_REVIEW_MIN_PROTOCOL) return row(agent.id, "runner_protocol");
      if (!supportsPacedVideoReviewPeer(runner.protocolVersion, capabilities?.pacedVideoReviewContract) ||
        !validAttestation(capabilities?.mediaReviewerAttestation) || capabilities.mediaReviewerAttestation.agentId !== agent.id) {
        return row(agent.id, "no_attestation");
      }
      if (!(capabilities.models ?? []).some((model) => model.id === VIDEO_REVIEWER_MODEL) ||
        !(capabilities.effortLevels ?? []).includes(VIDEO_REVIEWER_EFFORT)) return row(agent.id, "reviewer_model");
      return row(agent.id, null);
    });
  });
}

/** The reviewer target for a campaign root: an attested installation on the root's own runner (a
 * managed worker must share it), under a provider the Human evidence authority disclosed. A proof
 * certifies one exact installation, so one with a current proof is preferred; otherwise the first
 * candidate is returned so admission can name the missing proof. */
export function rootReviewerTarget(db: ControlPlaneDb, root: SessionView,
  proven: (target: EvidenceReviewerTarget) => boolean = () => false, agentId?: string): EvidenceReviewerTarget | null {
  const control = root.orchestratorPolicy?.control;
  const authority = control?.mode === "full_control" ? control.boundary.evidenceAuthority : undefined;
  const provider = authority?.providers.find((p) => p.reviewers.some((r) => r.driver === "claude-code" && r.modelId === VIDEO_REVIEWER_MODEL));
  if (!provider) return null;
  const targets = mediaReviewerInstallations(db, root.runnerId).filter((installation) => agentId === undefined ||
    installation.agentId === agentId).map((installation) => installationReviewerTarget(installation, provider.providerId));
  return targets.find(proven) ?? targets[0] ?? null;
}

/** The exact reviewer target an attested installation presents under one disclosed provider. */
export function installationReviewerTarget(installation: ReturnType<typeof mediaReviewerInstallations>[number],
  providerId: string): EvidenceReviewerTarget {
  return { agentId: installation.agentId, driver: "claude-code", modelId: VIDEO_REVIEWER_MODEL, effort: VIDEO_REVIEWER_EFFORT,
    providerId, runnerId: installation.runnerId, runnerProtocolVersion: installation.protocolVersion,
    pacedVideoReviewContract: installation.contract, capabilitiesSha256: mediaReviewerAttestationSha256(installation.attestation),
    auditedAllFrameDelivery: true, reviewerNamespaceSha256: installation.attestation.namespacePolicySha256, mediaOnlyNamespaceVerified: true };
}

const reviewerPrompt = (criteria: readonly VideoReviewCriterion[]) => [
  "Review a silent screen recording that a child Session attached as UI evidence. Judge it against each pinned criterion:",
  ...criteria.map((c) => `- ${c.criterionId}: ${c.description}`),
  "A criterion passes only when every frame you inspected supports it. Your verdict informs the controlling Orchestrator; it is not an approval.",
].join("\n");

/** Composes the delegated video review adapters (#1321). Constructed before SessionsService; the
 * Session-dependent ports fail closed until `attach` supplies the service and the runner hub. */
export class DelegatedVideoReviews {
  private readonly ledger: ReviewLedger;
  private attached: { sessions: DelegatedVideoSessions; hub: DelegatedVideoHub } | null = null;
  private service: EvidenceReviewService | null = null;
  readonly prepared: PreparedMediaSessions;
  private readonly budgetProvenance: EvidenceReviewBudgetProvenance;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Subjects with an attempt running in this process; a `preparing` row without one is stale. */
  private readonly inFlight = new Set<string>();
  private readonly lastReadback = new Map<string, number>();

  constructor(private readonly db: ControlPlaneDb, private readonly store: VideoReviewStore,
    private readonly liveValidation: VideoLiveValidationRegistry,
    private readonly log: (event: string, fields: Record<string, unknown>) => void = () => {},
    private readonly clock: () => number = Date.now,
    private readonly schedule: (run: () => void, ms: number) => ReturnType<typeof setTimeout> =
      (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; }) {
    this.ledger = new ReviewLedger(db);
    this.prepared = new PreparedMediaSessions(db.raw(), this.preparedPorts(), clock);
    this.budgetProvenance = new EvidenceReviewBudgetProvenance({
      preflight: (rootSessionId, sessionId) => this.attached?.sessions.campaignBudgetWorkerPreflight(rootSessionId,
        { kind: "managed", sessionId }).data ?? null,
      completedAttestation: (sessionId) => db.campaignBudgets.completedAttestation(sessionId),
      verdict: (binding) => {
        const row = this.ledger.byReviewer(binding.reviewerSessionId);
        return row?.reviewId ? store.getVerdict(row.reviewId) : null;
      },
      worker: (sessionId) => {
        const session = db.getSession(sessionId), dispatch = db.campaignBudgets.dispatch(sessionId);
        return session && dispatch ? { rootSessionId: dispatch.rootSessionId, driver: session.driver,
          model: session.resolvedModel ?? session.model ?? null, effort: session.effort ?? null, generation: dispatch.generation,
          normalCompletion: session.status === "completed" } : null;
      },
      currentOwnerActionAllowed: (binding) => this.db.campaignBudgets.view(binding.rootSessionId)?.state === "active",
    });
  }

  private proven(target: EvidenceReviewerTarget): boolean {
    return validVideoLiveProof(this.liveValidation.current(target), target, this.clock());
  }
  private target(root: SessionView): EvidenceReviewerTarget | null {
    return rootReviewerTarget(this.db, root, (target) => this.proven(target));
  }

  /** Called once SessionsService and the hub exist. Resumes queued busy-host retries. */
  attach(sessions: DelegatedVideoSessions, hub: DelegatedVideoHub, service: EvidenceReviewService): void {
    this.attached = { sessions, hub };
    this.service = service;
    for (const row of this.ledger.queued()) this.scheduleRetry(row);
    this.readback();
  }

  /** An unsent reviewer whose subject was deleted (the original decision cascades away) has no
   * owner left to release it. Its command never left this control plane, so its reservation is
   * released through the same never-enqueued path a Stop uses. Sent reviewers wait for readback. */
  releaseOrphanedUnsent(): number {
    let released = 0;
    const rows = this.db.raw().prepare("SELECT payload FROM prepared_media_sessions WHERE state IN ('prepared','bound')").all() as
      Array<{ payload: string }>;
    for (const { payload } of rows) {
      const identity = identityOf(JSON.parse(payload) as PreparedMediaIdentity);
      const sessionId = (JSON.parse(payload) as PreparedMediaRecord).sessionId;
      if (this.ledger.byReviewer(sessionId)) continue;
      if (this.cancelUnsent(identity)) released++;
    }
    return released;
  }

  /** Ask the owning runner for the durable outcome of every dispatched reviewer that still holds a
   * reservation. The list comes from the reviewers' own verified prepared records, never the subject
   * ledger, so a reviewer orphaned by a deleted child or root is recovered too. The runner answers
   * from its fences and never relaunches: never-dispatched releases, finished settles, `accepted`
   * means running and `unknown` means it died without a result. A running orphan, or a reviewer
   * whose review was revoked, can produce nothing usable, so it also gets the dedicated Stop.
   * Called when a runner registers and on attach; owner polling reads back one review a minute. */
  readback(runnerId?: string): number {
    if (!this.attached) return 0;
    this.releaseOrphanedUnsent();
    this.reconcileSubjects();
    let sent = 0;
    for (const record of this.outstanding(runnerId)) {
      this.lastReadback.set(record.sessionId, this.clock());
      if (this.sendReadback(record)) sent++;
      this.stopIfOrphaned(record);
    }
    return sent;
  }

  /** The reviewer's committed final accounting, if any. */
  private disposition(record: PreparedMediaRecord): string | null {
    return (this.db.raw().prepare("SELECT disposition FROM delegated_video_dispositions WHERE session_id=? AND generation=?")
      .get(record.sessionId, record.admission.dispatch.generation) as { disposition: string } | undefined)?.disposition ?? null;
  }

  /** Dispatched reviewers, from their own verified records, that still hold a reservation and have
   * no committed final accounting. Session status is not consulted: a terminal status written by any
   * path never hides a reviewer whose result has not been accounted. */
  private outstanding(runnerId?: string): PreparedMediaRecord[] {
    const rows = this.db.raw().prepare("SELECT payload FROM prepared_media_sessions WHERE state IN ('dispatching','uncertain','active')")
      .all() as Array<{ payload: string }>;
    return rows.flatMap(({ payload }) => {
      let record: PreparedMediaRecord | null;
      try { record = this.prepared.get(identityOf(JSON.parse(payload) as PreparedMediaIdentity)); } catch { record = null; }
      return record?.dispatchSha256 && (runnerId === undefined || record.runnerId === runnerId) &&
        this.db.campaignBudgets.active(record.sessionId) && !this.disposition(record) ? [record] : [];
    });
  }

  /** One SQLite transaction for a terminal transition: status, accounting, disposition and ledger
   * commit together or not at all. Notifications and logs run only after the commit. */
  private atomically<T>(work: () => T): T {
    const sql = this.db.raw();
    sql.exec("SAVEPOINT delegated_video_review_transition");
    try { const value = work(); sql.exec("RELEASE delegated_video_review_transition"); return value; }
    catch (error) { sql.exec("ROLLBACK TO delegated_video_review_transition; RELEASE delegated_video_review_transition"); throw error; }
  }

  /** An orphan has no subject row. A detached reviewer's review is gone or no longer pending, or its
   * subject no longer resolves to a current binding (ownership, policy, proof or audience changed). */
  private orphaned(record: PreparedMediaRecord): boolean {
    const row = this.ledger.byReviewer(record.sessionId);
    if (!row) return true;
    if (row.state === "finished") return false;
    const review = row.reviewId ? this.store.getReview(row.reviewId) : null;
    if (!review || review.status !== "pending") return true;
    try { return this.currentBinding(row, ["pending"]) === null; } catch { return true; }
  }
  private stopIfOrphaned(record: PreparedMediaRecord): void {
    const session = this.db.getSession(record.sessionId);
    if (record.state !== "active" || !session || isTerminal(session.status) || !this.orphaned(record)) return;
    try { this.attached?.sessions.stop(record.sessionId); } catch { /* The next registration retries. */ }
  }

  private readbackIfStale(row: ReviewRow): void {
    const record = row.reviewerSessionId ? this.recordForSession(row.reviewerSessionId) : null;
    if (!record?.dispatchSha256 || !["dispatching", "uncertain", "active"].includes(record.state) ||
      this.clock() - (this.lastReadback.get(record.sessionId) ?? 0) < 60_000) return;
    this.lastReadback.set(record.sessionId, this.clock());
    this.sendReadback(record);
  }
  private sendReadback(record: PreparedMediaRecord): boolean {
    try {
      return this.attached!.hub.sendToRunner(record.runnerId, { type: "media_review_readback", identity: mediaActiveStopIdentityBody({
        rootSessionId: record.rootSessionId, childSessionId: record.childSessionId, sessionId: record.sessionId, runnerId: record.runnerId,
        generation: record.admission.dispatch.generation, commandSha256: record.commandSha256, dispatchSha256: record.dispatchSha256! }) });
    } catch { return false; }
  }
  get ready(): boolean { return this.attached !== null && this.service !== null; }

  // ---- Server resolver: configuration and authority come from current records, never JSON ----

  private subjectFor(identity: PreparedMediaIdentity): ReviewRow | null {
    const row = this.db.raw().prepare("SELECT record FROM delegated_video_reviews WHERE json_extract(record,'$.rootSessionId')=? " +
      "AND json_extract(record,'$.childSessionId')=?").all(identity.rootSessionId, identity.childSessionId) as Array<{ record: string }>;
    for (const { record } of row) {
      const candidate = JSON.parse(record) as ReviewRow;
      const decision = this.db.workflowDecisionByOccurrence(candidate.occurrenceId);
      if (decision && identityFor(candidate, decision.resourceDigest).admissionId === identity.admissionId) return candidate;
    }
    return null;
  }

  readonly runtimeResolver: PreparedMediaSessionRuntime = {
    resolve: (identity, subject) => {
      const gate = this.attached?.sessions.delegatedVideoGate(subject.occurrenceId, ["pending"]);
      if (!gate || gate.root.id !== identity.rootSessionId || gate.child.id !== identity.childSessionId ||
        !videoItem(gate.decision, subject.evidenceId)) return null;
      const target = this.target(gate.root);
      const context = this.admissionContext(gate.root, gate.child);
      if (!target || !context || !gate.root.workspaceId) return null;
      const request: CreateSessionRequest = { runnerId: gate.root.runnerId, workspaceId: gate.root.workspaceId, agentId: target.agentId,
        title: "Video Evidence Review", prompt: reviewerPrompt(VIDEO_REVIEW_CRITERIA),
        config: { model: VIDEO_REVIEWER_MODEL, effort: VIDEO_REVIEWER_EFFORT, ...VIDEO_REVIEW_CEILINGS } };
      return { request, context, target, liveProof: this.liveValidation.current(target) };
    },
  };

  private admissionContext(root: SessionView, child: SessionView): ReviewerAdmissionContext | null {
    const control = root.orchestratorPolicy?.control, scope = root.orchestratorPolicy?.issueScope;
    if (control?.mode !== "full_control" || !control.boundary.evidenceAuthority || !scope) return null;
    const assignment = this.db.campaignWorkLedger.currentAssignment(child.id);
    const item = assignment && assignment.campaignSessionId === root.id ? this.db.raw()
      .prepare("SELECT issue_repository,issue_number FROM campaign_work_items WHERE id=?").get(assignment.workItemId) as
      { issue_repository: string | null; issue_number: number | null } | undefined : undefined;
    const issue = item?.issue_number ?? (scope.issueNumbers.length === 1 ? scope.issueNumbers[0]! : null);
    const audience = this.db.sessionScope(root.id);
    const controllerRunner = this.db.getRunner(root.runnerId), childRunner = this.db.getRunner(child.runnerId);
    if (issue === null || !audience || !controllerRunner?.protocolVersion || !childRunner?.protocolVersion) return null;
    const authority = control.boundary.evidenceAuthority;
    const contract = (runner: typeof controllerRunner, agentId: string | null | undefined) =>
      runner.agents.find((agent) => agent.id === agentId)?.capabilities?.pacedVideoReviewContract;
    return { mode: "full_control", rootSessionId: root.id, childSessionId: child.id, repository: scope.repository, issue,
      issueScopeRevision: scope.revision, policyRevision: control.boundary.revision, boundary: control.boundary,
      evidenceAuthority: authority, uiEvidenceOwner: "orchestrator", taskEvidenceVerified: scope.issueNumbers.includes(issue),
      destinationConfigurationId: authority.destination.configurationId, organizationId: authority.destination.organizationId,
      audienceSha256: sha(audience), controllerProtocolVersion: controllerRunner.protocolVersion,
      childProtocolVersion: childRunner.protocolVersion,
      controllerPacedVideoReviewContract: contract(controllerRunner, root.agentId),
      childPacedVideoReviewContract: contract(childRunner, child.agentId),
      // SessionsService rechecks the boundary, disclosures and scope against these at materialization.
      boundaryCurrent: true, scopeCurrent: scope.issueNumbers.includes(issue), destinationPrivateVerified: true };
  }

  /** Every field recomputed from current records. The runtime compares it with the stored binding,
   * so any changed authority, reviewer, attestation, audience or source revokes the review. */
  private currentBinding(row: ReviewRow, statuses: readonly WorkflowDecisionView["status"][],
    reviewer: "unsent" | "live" | "historical" = "unsent"): VideoReviewBinding | null {
    const gate = this.attached?.sessions.delegatedVideoGate(row.occurrenceId, statuses);
    const item = gate ? videoItem(gate.decision, row.evidenceId) : null;
    const control = gate?.root.orchestratorPolicy?.control;
    if (!gate || !item || control?.mode !== "full_control" || !control.boundary.evidenceAuthority || !row.reviewerSessionId ||
      gate.root.id !== row.rootSessionId || gate.child.id !== row.childSessionId) return null;
    const record = this.prepared.get(identityFor(row, gate.decision.resourceDigest));
    // The review's own installation, which must still hold a current proof: revoking or expiring it
    // ends media access, verdicts and provenance even while another installation stays certified.
    const target = record ? rootReviewerTarget(this.db, gate.root, () => false, record.command.spec.agentId ?? undefined) : null;
    const audience = this.db.sessionScope(gate.root.id);
    if (!record || record.sessionId !== row.reviewerSessionId || !target || !this.proven(target) || !audience) return null;
    // Media and verdicts need an open, live reviewer: Stop, archive or any terminal status ends them.
    const session = this.db.getSession(record.sessionId);
    if (reviewer === "live" && (!session || isTerminal(session.status) || !this.attached!.sessions.dedicatedMediaReviewerOpen(record.sessionId))) return null;
    return { rootSessionId: gate.root.id, childSessionId: gate.child.id, occurrenceId: gate.decision.occurrenceId,
      resourceDigest: gate.decision.resourceDigest, policyRevision: gate.decision.policyRevision,
      boundaryRevision: control.boundary.revision, evidenceAuthorityRevision: control.boundary.evidenceAuthority.revision,
      reviewerSessionId: record.sessionId, reviewerDriver: record.admission.worker.driver,
      reviewerModelId: record.admission.worker.model ?? "", providerId: target.providerId, audienceSha256: sha(audience),
      capabilitiesSha256: target.capabilitiesSha256, sourceEvidenceId: item.evidenceId, sourceArtifactId: item.artifactId!,
      sourceSha256: item.sha256, workerAdmissionSha256: record.admission.allocationDigest,
      criteriaSha256: sha(VIDEO_REVIEW_CRITERIA) };
  }

  readonly runtimeAccess: VideoReviewRuntimeAccess = {
    currentBinding: (binding, phase) => {
      const row = this.ledger.byReviewer(binding.reviewerSessionId);
      return row && row.occurrenceId === binding.occurrenceId
        ? this.currentBinding(row, phase === "resolve" ? ["pending", "approved"] : ["pending"],
          phase === "resolve" ? "historical" : phase === "derive" ? "unsent" : "live") : null;
    },
    normalCompletion: (binding) => this.budgetProvenance.normalCompletion(binding),
    workerAdmission: (binding, phase) => phase === "active" ? this.budgetProvenance.active(binding) : this.budgetProvenance.historical(binding),
    readSource: (artifactId) => { try { return this.db.readWorkflowArtifactBytes(artifactId); } catch { return null; } },
  };

  readonly serviceAdapter: EvidenceReviewServiceAdapter = {
    resolvePending: (rootSessionId, request) => {
      const row = this.ledger.get(request.occurrenceId, request.evidenceId);
      if (!row || row.rootSessionId !== rootSessionId || row.childSessionId !== request.childSessionId) return null;
      const binding = this.currentBinding(row, ["pending"]);
      const gate = this.attached?.sessions.delegatedVideoGate(request.occurrenceId, ["pending"]);
      const item = gate ? videoItem(gate.decision, request.evidenceId) : null;
      const target = gate ? this.target(gate.root) : null;
      const source = item?.artifactId ? this.db.workflowArtifactExportPreflight(item.artifactId)?.artifact : null;
      if (!binding || !item || !target) return null;
      return { binding, criteria: structuredClone([...VIDEO_REVIEW_CRITERIA]), target, mediaType: item.mediaType as "video/webm" | "video/mp4",
        mode: "full_control", sourceGrantVerified: Boolean(source && source.sessionId === row.childSessionId && source.kind === "video" &&
          source.sha256 === item.sha256 && source.mimeType === item.mediaType) } satisfies ResolvedVideoReviewRequest;
    },
    currentOwner: (binding) => {
      const gate = this.attached?.sessions.delegatedVideoGate(binding.occurrenceId, ["pending", "approved"]);
      return Boolean(gate && gate.root.id === binding.rootSessionId && gate.child.id === binding.childSessionId);
    },
    liveProof: (target) => this.liveValidation.current(target),
    reviewerProtocol: (sessionId) => {
      const session = this.db.getSession(sessionId);
      return session ? this.db.getRunner(session.runnerId)?.protocolVersion ?? null : null;
    },
    peerContract: (sessionId) => {
      const session = this.db.getSession(sessionId);
      return session && this.attached?.sessions.sessionPacedVideoPeer(sessionId)
        ? this.db.getRunner(session.runnerId)?.agents.find((agent) => agent.id === session.agentId)?.capabilities?.pacedVideoReviewContract
        : undefined;
    },
    audit: (event) => this.log("video_evidence_review", { ...event }),
  };

  readonly gateAccess: WorkflowVideoEvidenceAccess = {
    available: (controller) => this.ready && this.readyFor(controller),
    campaignReadiness: (controller) => {
      if (!this.ready) return { available: false, reason: "Wollipog's video review service is not attached yet." };
      const target = this.target(controller);
      if (!target) return { available: false, reason: `this campaign's evidence envelope names no attested ${VIDEO_REVIEWER_MODEL} media-only reviewer on the Orchestrator's machine.` };
      return validVideoLiveProof(this.liveValidation.current(target), target, this.clock()) ? { available: true }
        : { available: false, reason: "no current live proof certifies the media-only reviewer on the Orchestrator's machine." };
    },
    decisionCurrent: (decision, phase) => {
      const gate = this.attached?.sessions.delegatedVideoGate(decision.occurrenceId, [phase === "resolve" ? "pending" : "approved"]);
      return Boolean(gate && gate.decision.status === decision.status && gate.decision.resourceDigest === decision.resourceDigest &&
        gate.decision.policyRevision === decision.policyRevision && gate.decision.resolvedAt === decision.resolvedAt &&
        gate.root.id === decision.controllingSessionId && gate.child.id === decision.sessionId);
    },
    linkedReview: (decision, evidenceId) => {
      const row = this.ledger.get(decision.occurrenceId, evidenceId);
      return row?.reviewId && row.rootSessionId === decision.controllingSessionId ? this.store.getReview(row.reviewId) : null;
    },
  };

  /** A certified reviewer can run for this controller now: a target on its runner with a current
   * Human-inspected live proof. Admission still rechecks everything at preparation. */
  private readyFor(controller: SessionView): boolean {
    const target = this.target(controller);
    return Boolean(target && validVideoLiveProof(this.liveValidation.current(target), target, this.clock()));
  }

  readonly activeStopPorts: PreparedMediaActiveStopPorts = {
    current: (identity) => {
      const record = this.recordForSession(identity.sessionId);
      return Boolean(this.attached && record && record.state === "active" && record.runnerId === identity.runnerId &&
        this.attached.hub.isRunnerOnline(record.runnerId) && this.attached.sessions.sessionPacedVideoPeer(identity.sessionId));
    },
    send: (request: MediaActiveStopRequest) => {
      if (!this.attached?.hub.sendToRunner(request.runnerId, { type: "media_review_stop", request })) throw new Error("Owning runner is offline.");
    },
  };

  /** The reviewer's own verified prepared record. It outlives the original decision and subject
   * row, so deleting the child or root never strands a reservation the runner may still settle. */
  private recordForSession(sessionId: string): PreparedMediaRecord | null {
    try {
      const row = this.db.raw().prepare("SELECT payload FROM prepared_media_sessions WHERE json_extract(payload,'$.sessionId')=?")
        .get(sessionId) as { payload: string } | undefined;
      return row ? this.prepared.get(identityOf(JSON.parse(row.payload) as PreparedMediaIdentity)) : null;
    } catch { return null; }
  }

  // ---- PreparedMediaSessions ports ----

  private preparedPorts(): import("./prepared-media-sessions.js").PreparedMediaSessionPorts {
    const subject = (identity: PreparedMediaIdentity): PreparedMediaSubject => {
      const row = this.subjectFor(identity);
      if (!row) throw new Error("No delegated video review subject owns this media admission.");
      return { occurrenceId: row.occurrenceId, evidenceId: row.evidenceId };
    };
    const sessions = () => {
      if (!this.attached) throw new Error("Delegated video review is not attached to Sessions.");
      return this.attached.sessions;
    };
    return {
      database: this.db.raw(),
      preflightMaterialization: (identity) => {
        const result = sessions().preflightPreparedMediaSession(identity, subject(identity));
        if (!result.ok) throw new Error(result.error ?? "Media Session governance preflight refused.");
      },
      materialize: (identity) => {
        const result = sessions().materializePreparedMediaSession(identity, subject(identity));
        if (!result.ok || !result.data) throw new Error(result.error ?? "Media Session materialization refused.");
        return result.data;
      },
      preparedCommitted: (record) => sessions().publishPreparedMediaSession(record),
      currentAdmission: (sessionId) => {
        const root = this.db.campaignBudgets.root(sessionId);
        return root ? sessions().campaignBudgetWorkerPreflight(root, { kind: "managed", sessionId }).data ?? null : null;
      },
      currentIdentity: (sessionId) => {
        const session = this.db.getSession(sessionId), dispatch = this.db.campaignBudgets.dispatch(sessionId);
        return session && dispatch ? { rootSessionId: dispatch.rootSessionId, runnerId: session.runnerId, generation: dispatch.generation } : null;
      },
      authorize: async (record, phase) => this.authorize(record, phase),
      send: async (record) => this.send(record),
      reconcile: async (record) => this.reconcileReceipt(record),
      cancelNeverDispatched: (record) => new PreparedMediaReservationRelease(this.db.raw(), this.db.campaignBudgets).release(record),
    };
  }

  /** Current gate, owner, certified reviewer and live proof, and a grant naming the exact current
   * pending review this attempt derived. Reconcile needs only the gate: launch status is history. */
  private authorize(record: PreparedMediaRecord, phase: "bind" | "dispatch" | "reconcile"): boolean {
    // An authenticated accepted receipt records that the exact command launched. That is history,
    // not access, so it holds even after the subject is revoked or deleted; the reviewer can then
    // be stopped as an orphan. Media access stays independently gated by `currentBinding`.
    if (phase === "reconcile") return true;
    const row = this.subjectFor(record);
    if (!row || row.reviewerSessionId !== record.sessionId) return false;
    const binding = this.currentBinding(row, ["pending"]);
    if (!binding) return false;
    const review = row.reviewId ? this.store.getReview(row.reviewId) : null;
    const gate = this.attached!.sessions.delegatedVideoGate(row.occurrenceId, ["pending"])!;
    const target = this.target(gate.root);
    const grant = record.binding?.grant;
    return Boolean(review && review.status === "pending" && grant && target &&
      validVideoLiveProof(this.liveValidation.current(target), target, this.clock()) &&
      videoReviewBindingDigest(review.binding) === videoReviewBindingDigest(binding) &&
      grant.reviewId === review.reviewId && grant.bindingSha256 === videoReviewBindingDigest(review.binding) &&
      grant.deliveryPlanSha256 === review.deliveryPlanSha256 && grant.manifestSha256 === review.manifestSha256 &&
      grant.criteriaSha256 === review.criteriaSha256 && JSON.stringify(grant.frames) === JSON.stringify(review.manifest.frames));
  }

  /** Sends at most once; the outcome arrives later as an authenticated runner receipt. */
  private send(record: PreparedMediaRecord): "unknown" {
    const row = this.subjectFor(record), review = row?.reviewId ? this.store.getReview(row.reviewId) : null;
    if (!this.attached || !record.binding || !record.dispatchSha256 || !review) return "unknown";
    const identity: MediaActiveStopIdentity = mediaActiveStopIdentityBody({ rootSessionId: record.rootSessionId,
      childSessionId: record.childSessionId, sessionId: record.sessionId, runnerId: record.runnerId,
      generation: record.admission.dispatch.generation, commandSha256: record.commandSha256, dispatchSha256: record.dispatchSha256 });
    this.attached.hub.sendToRunner(record.runnerId, { type: "media_review_dispatch", dispatch: { identity,
      command: record.command, grant: record.binding.grant, deliveryPlanSha256: record.binding.grant.deliveryPlanSha256,
      attestationSha256: review.binding.capabilitiesSha256 } });
    return "unknown";
  }

  private reconcileReceipt(record: PreparedMediaRecord) {
    const row = this.db.raw().prepare("SELECT outcome FROM delegated_video_dispatch_outcomes WHERE session_id=? AND generation=?")
      .get(record.sessionId, record.admission.dispatch.generation) as { outcome: "accepted" | "never_dispatched" } | undefined;
    return row && record.dispatchSha256 ? { dispatchSha256: record.dispatchSha256, sessionId: record.sessionId, runnerId: record.runnerId,
      generation: record.admission.dispatch.generation, outcome: row.outcome } : null;
  }
  /** Persisted with the time it was first observed, before anything acts on it. A replay keeps the
   * original row, so recovery after a crash or restart sees the original observation time. */
  private recordOutcome(record: PreparedMediaRecord, outcome: "accepted" | "never_dispatched", reason: "host_busy" | null = null): void {
    this.db.raw().prepare("INSERT OR IGNORE INTO delegated_video_dispatch_outcomes VALUES (?,?,?,?,?)")
      .run(record.sessionId, record.admission.dispatch.generation, outcome, reason, this.clock());
  }
  private cancelledOutcome(record: PreparedMediaRecord): { reason: "host_busy" | null; observedAt: number } {
    const row = this.db.raw().prepare("SELECT reason,observed_at FROM delegated_video_dispatch_outcomes WHERE session_id=? AND generation=? " +
      "AND outcome='never_dispatched'").get(record.sessionId, record.admission.dispatch.generation) as
      { reason: string | null; observed_at: number } | undefined;
    return { reason: row?.reason === "host_busy" ? "host_busy" : null, observedAt: row?.observed_at ?? this.clock() };
  }

  /** A subject still `dispatched` whose reviewer command was cancelled (its release committed, but
   * the requeue or refusal did not, for example after a crash) is settled from the durable outcome
   * and its persisted reason, exactly as `onNeverDispatched` would have settled it. */
  private reconcileSubjects(): void {
    for (const row of this.ledger.unfinished()) {
      const record = row.reviewerSessionId ? this.recordForSession(row.reviewerSessionId) : null;
      if (record?.state === "cancelled") { const outcome = this.cancelledOutcome(record); this.settleCancelled(row, outcome.reason, outcome.observedAt); }
    }
  }

  // ---- Owner preparation ----

  private refuse(code: VideoReviewRefusalCode, reason: string) { return { ok: false as const, code, reason }; }

  async prepare(principal: AuthPrincipal, request: { childSessionId: string; occurrenceId: string; evidenceId: string }) {
    const rootId = principal.kind === "agent" ? principal.credentialSessionId : undefined;
    if (!rootId || principal.kind !== "agent" || principal.orchestrator !== true || !this.attached || !this.service) {
      return this.refuse("not_authorized", "Only the controlling Orchestrator can prepare delegated video review.");
    }
    const root = this.db.getSession(rootId);
    if (root?.orchestratorPolicy?.control?.mode === "custom") {
      return this.refuse("custom_fallback", "Custom control keeps video evidence with the Human.");
    }
    const notOwned = this.refuse("not_authorized", "This Orchestrator does not own a pending video evidence decision with that evidence.");
    const decision = this.db.workflowDecisionByOccurrence(request.occurrenceId);
    if (!decision || decision.controllingSessionId !== rootId || decision.sessionId !== request.childSessionId ||
      decision.status !== "pending" || !videoItem(decision, request.evidenceId)) return notOwned;
    // A mixed peer makes the gate Human-owned, so name that reason before the ownership check.
    if (!this.attached.sessions.sessionPacedVideoPeer(rootId) || !this.attached.sessions.sessionPacedVideoPeer(request.childSessionId)) {
      return this.refuse("mixed_peer", "The controller or child installation does not declare the paced video review contract.");
    }
    const gate = this.attached.sessions.delegatedVideoGate(request.occurrenceId, ["pending"]);
    if (!gate || gate.root.id !== rootId || gate.child.id !== request.childSessionId) return notOwned;
    this.reconcileSubjects();
    const existing = this.recoverStale(this.ledger.get(request.occurrenceId, request.evidenceId));
    if (existing && existing.state !== "refused") return this.status(existing);
    if (existing?.reason === "reviewer_busy_exhausted") return this.status(existing); // The cap is never reset.
    const blocked = this.admissionRefusal(gate.root, gate.child);
    if (blocked) return blocked;
    const row: ReviewRow = { occurrenceId: request.occurrenceId, evidenceId: request.evidenceId, rootSessionId: rootId,
      childSessionId: request.childSessionId, attempt: existing ? existing.attempt + 1 : 0, state: "preparing", reason: null,
      reviewId: null, reviewIds: existing?.reviewIds ?? [], reviewerSessionId: null, firstBusyAt: existing?.firstBusyAt ?? null,
      nextAttemptAt: null, busyRequeues: existing?.busyRequeues ?? 0, finished: null, updatedAt: this.clock() };
    this.ledger.save(row);
    return this.attempt(row);
  }

  private admissionRefusal(root: SessionView, child: SessionView) {
    if (!this.attached!.sessions.sessionPacedVideoPeer(root.id) || !this.attached!.sessions.sessionPacedVideoPeer(child.id)) {
      return this.refuse("mixed_peer", "The controller or child installation does not declare the paced video review contract.");
    }
    const target = this.target(root);
    if (!target) return this.refuse("reviewer_unavailable", "The controller's runner has no attested media-only Claude Code reviewer for the certified model.");
    if (!validVideoLiveProof(this.liveValidation.current(target), target, this.clock())) {
      return this.refuse("live_validation", "No current Human-inspected live validation proof covers this reviewer.");
    }
    return null;
  }

  /** A `preparing` row with no attempt running here was interrupted, by a restart for example. An
   * unsent reservation is released; a possibly dispatched one is kept and awaits its runner. */
  private recoverStale(row: ReviewRow | null): ReviewRow | null {
    if (!row || row.state !== "preparing" || this.inFlight.has(`${row.occurrenceId}\0${row.evidenceId}`)) return row;
    const decision = this.db.workflowDecisionByOccurrence(row.occurrenceId);
    const identity = decision ? identityFor(row, decision.resourceDigest) : null;
    let state: PreparedMediaRecord["state"] | undefined;
    try { state = identity ? this.prepared.get(identity)?.state : undefined; } catch { state = "uncertain"; }
    if (state === "dispatching" || state === "uncertain" || state === "active") {
      row.state = "dispatched"; row.updatedAt = this.clock(); this.ledger.save(row);
      return row;
    }
    if (identity && this.cancelUnsent(identity) && row.reviewId) this.store.settle(row.reviewId, "revoked");
    this.settleRefusal(row, this.refuse("preparation", "An interrupted preparation was released."));
    return row;
  }

  /** One attempt under a fresh identity: materialize, derive, bind and dispatch. Every step
   * re-resolves current authority; a refusal before dispatch releases the unsent reservation. */
  private async attempt(row: ReviewRow) {
    const key = `${row.occurrenceId}\0${row.evidenceId}`;
    this.inFlight.add(key);
    try { return await this.attemptOnce(row); } finally { this.inFlight.delete(key); }
  }

  private async attemptOnce(row: ReviewRow) {
    const decision = this.db.workflowDecisionByOccurrence(row.occurrenceId);
    if (!decision) return this.settleRefusal(row, this.refuse("not_authorized", "The original decision no longer exists."));
    const identity = identityFor(row, decision.resourceDigest);
    let record: PreparedMediaRecord;
    try { record = this.prepared.prepare(identity); }
    catch (error) { return this.settleRefusal(row, this.refuse("allowance", `No reviewer was admitted: ${(error as Error).message}`)); }
    row.reviewerSessionId = record.sessionId; this.ledger.save(row);
    const principal = this.ownerPrincipal(row.rootSessionId);
    let derived: Awaited<ReturnType<EvidenceReviewService["prepare"]>>;
    try {
      derived = principal ? await this.service!.prepare(principal, { childSessionId: row.childSessionId,
        occurrenceId: row.occurrenceId, evidenceId: row.evidenceId }) : { ok: false, code: "not_authorized" };
    } catch (error) { derived = { ok: false, code: "preparation" }; this.log("video_evidence_review_derive_failed", { message: (error as Error).message }); }
    if (!derived.ok) {
      this.cancelUnsent(identity);
      const code = derived.code === "live_validation" || derived.code === "mixed_peer" || derived.code === "custom_fallback" ||
        derived.code === "not_authorized" ? derived.code : "preparation";
      return this.settleRefusal(row, { ...this.refuse(code, "Video review preparation was refused."),
        ...(derived.recovery ? { recovery: derived.recovery } : {}) });
    }
    const review = derived.review;
    row.reviewId = review.reviewId; row.reviewIds = [...row.reviewIds, review.reviewId]; this.ledger.save(row);
    try {
      await this.prepared.bind(identity, this.grantBinding(record, review));
      await this.prepared.dispatch(identity);
    } catch (error) {
      if (this.cancelUnsent(identity)) this.store.settle(review.reviewId, "revoked");
      return this.settleRefusal(row, this.refuse("reviewer_unavailable", `The reviewer was not dispatched: ${(error as Error).message}`));
    }
    row.state = "dispatched"; row.reason = null; row.updatedAt = this.clock(); this.ledger.save(row);
    return this.status(row);
  }

  private cancelUnsent(identity: PreparedMediaIdentity): boolean {
    try {
      const state = this.prepared.get(identity)?.state;
      if (state !== "prepared" && state !== "bound") return false;
      this.prepared.cancelPrepared(identity);
      return true;
    } catch { return false; }
  }

  private settleRefusal<T extends { ok: false; code: VideoReviewRefusalCode; reason: string }>(row: ReviewRow, refusal: T): T {
    row.state = "refused"; row.reason = refusal.code; row.updatedAt = this.clock(); this.ledger.save(row);
    return refusal;
  }

  /** The server acts for the original owner, after rechecking that owner, never for a caller. */
  private ownerPrincipal(rootSessionId: string): AgentPrincipal | null {
    const scope = this.db.sessionScope(rootSessionId);
    return scope ? { kind: "agent", actorId: rootSessionId, credentialSessionId: rootSessionId, orchestrator: true,
      organizationId: scope.organizationId, delegatedScope: scope } : null;
  }

  private grantBinding(record: PreparedMediaRecord, review: VideoReviewRecord): PreparedMediaBinding {
    const gate = this.attached!.sessions.delegatedVideoGate(review.binding.occurrenceId, ["pending"])!;
    const target = this.target(gate.root)!;
    const control = gate.root.orchestratorPolicy!.control as Extract<NonNullable<SessionView["orchestratorPolicy"]>["control"], { mode: "full_control" }>;
    return {
      grant: { reviewId: review.reviewId, reviewerSessionId: record.sessionId, childSessionId: record.childSessionId,
        occurrenceId: review.binding.occurrenceId, policyRevision: review.binding.policyRevision,
        sourceEvidenceId: review.binding.sourceEvidenceId, sourceArtifactId: review.binding.sourceArtifactId,
        sourceSha256: review.binding.sourceSha256, manifestSha256: review.manifestSha256,
        bindingSha256: videoReviewBindingDigest(review.binding), criteriaSha256: review.criteriaSha256,
        deliveryPlanSha256: review.deliveryPlanSha256, expiresAt: review.expiresAt, frames: structuredClone(review.manifest.frames) },
      // The server's launch identity for this Session; the runner reports its actual launch digest.
      namespaceLaunchSha256: sha({ namespacePolicySha256: target.reviewerNamespaceSha256, sessionId: record.sessionId,
        generation: record.admission.dispatch.generation }),
      namespacePolicySha256: target.reviewerNamespaceSha256,
      authoritySha256: sha({ resourceDigest: gate.decision.resourceDigest, policyRevision: gate.decision.policyRevision,
        boundaryRevision: control.boundary.revision, evidenceAuthorityRevision: control.boundary.evidenceAuthority!.revision,
        audienceSha256: review.binding.audienceSha256 }),
    };
  }

  /** Owner-facing state, never media bytes or the reviewer's credential. */
  private status(row: ReviewRow) {
    if (row.state === "refused") return this.refuse((row.reason ?? "preparation") as VideoReviewRefusalCode,
      row.reason === "reviewer_busy_exhausted" ? "The reviewer host stayed busy through every bounded retry; video evidence stays with the Human."
        : "Video review preparation was refused.");
    if (row.state === "queued") return { ok: true as const, status: "pending" as const, reason: "host_busy" as const,
      nextAttemptAt: row.nextAttemptAt, attempt: row.attempt };
    const review = row.reviewId ? this.store.getReview(row.reviewId) : null;
    const plan = review ? pacedVideoReviewWindowPlan(review.manifest.frames) : null;
    return { ok: true as const, status: row.state === "preparing" ? "preparing" as const : row.state === "finished" ? "finished" as const : "dispatched" as const,
      reviewId: row.reviewId, reviewerSessionId: row.reviewerSessionId, frameCount: review?.manifest.frames.length ?? null,
      windows: plan?.windows.map((w) => ({ firstIndex: w.firstIndex, endIndex: w.endIndex })) ?? [],
      reviewer: { driver: "claude-code", model: VIDEO_REVIEWER_MODEL, effort: VIDEO_REVIEWER_EFFORT },
      ceilings: { ...VIDEO_REVIEW_CEILINGS } };
  }

  /** Verdict and server-verifiable provenance once the reviewer finished and its priced usage
   * settled; a pending, withheld or failed state otherwise. Never resolves the decision. */
  provenance(principal: AuthPrincipal, reviewId: string) {
    const rootId = principal.kind === "agent" ? principal.credentialSessionId : undefined;
    this.reconcileSubjects();
    const row = this.ledger.byReview(reviewId);
    const gate = row ? this.attached?.sessions.delegatedVideoGate(row.occurrenceId, ["pending", "approved"]) : null;
    if (!rootId || principal.kind !== "agent" || principal.orchestrator !== true || !row || row.rootSessionId !== rootId ||
      !this.service || !gate || gate.root.id !== rootId || gate.child.id !== row.childSessionId) {
      return { ok: false as const, code: "not_authorized" as const };
    }
    if (row.state !== "finished") {
      if (row.state === "dispatched") this.readbackIfStale(row);
      const current = this.status(row);
      return row.state === "refused" ? current : { ...current, status: "pending" as const,
        reason: row.state === "queued" ? "host_busy" as const : "reviewing" as const };
    }
    const finished = row.finished!;
    if (finished.outcome !== "completed" || !finished.verdictConfirmed) {
      return { ok: true as const, status: "failed" as const, reviewId: row.reviewId, reason: finished.reason ?? "The reviewer did not confirm a verdict." };
    }
    if (!finished.priced) return { ok: true as const, status: "withheld" as const, reviewId: row.reviewId, reason: "unpriced_usage" as const };
    let verdict: VideoReviewVerdict;
    try { verdict = this.service.ownerObservation(principal, row.reviewId!); }
    catch { return { ok: true as const, status: "withheld" as const, reviewId: row.reviewId, reason: "provenance_unavailable" as const }; }
    const usage = this.db.campaignBudgets.completedAttestation(verdict.reviewerSessionId);
    return { ok: true as const, status: "complete" as const, typedDecisionResolved: false,
      verdict: { verdictId: verdict.verdictId, reviewId: verdict.reviewId, outcome: verdict.outcome, criteria: verdict.criteria,
        rationale: verdict.rationale, recordedAt: verdict.recordedAt },
      deliveryPlanSha256: verdict.deliveryPlanSha256, receiptCount: verdict.receiptIds.length,
      receiptSetSha256: sha(verdict.receiptIds),
      reviewer: { sessionId: verdict.reviewerSessionId, driver: verdict.workerAdmission.worker.driver,
        model: verdict.workerAdmission.worker.model, effort: verdict.workerAdmission.worker.effort },
      usage: usage?.actual ?? null,
      // A rejection is the owner's evidence for denying the decision; it can never approve it.
      ...(verdict.outcome === "accept" ? { resolveWith: { evidenceId: row.evidenceId, reviewId: verdict.reviewId,
        verdictId: verdict.verdictId, reviewerSessionId: verdict.reviewerSessionId } } : {}) };
  }

  // ---- Authenticated runner ingress ----

  private recordFor(runnerId: string, fence: { sessionId: string; runnerId: string; generation: string; rootSessionId: string;
    commandSha256: string; dispatchSha256: string }): { row: ReviewRow | null; record: PreparedMediaRecord } | null {
    const row = this.ledger.byReviewer(fence.sessionId), record = this.recordForSession(fence.sessionId);
    return record && runnerId === fence.runnerId && record.runnerId === runnerId && record.rootSessionId === fence.rootSessionId &&
      record.admission.dispatch.generation === fence.generation && record.commandSha256 === fence.commandSha256 &&
      record.dispatchSha256 === fence.dispatchSha256 ? { row, record } : null;
  }

  async onDispatchReceipt(runnerId: string, receipt: MediaReviewDispatchReceipt): Promise<boolean> {
    try {
      const { receiptSha256, ...body } = receipt;
      const found = this.recordFor(runnerId, receipt);
      if (!found || receiptSha256 !== sha(body) || !["accepted", "unknown"].includes(receipt.outcome) ||
        receipt.deliveryPlanSha256 !== found.record.binding?.grant.deliveryPlanSha256 && receipt.deliveryPlanSha256 !== "") return false;
      if (receipt.outcome === "unknown") return this.lost(found.record, found.row);
      this.recordOutcome(found.record, "accepted");
      const settled = await this.prepared.reconcile(identityOf(found.record));
      if (settled.state === "active") {
        this.projectStatus(found.record.sessionId, "running");
        this.stopIfOrphaned(settled);
      }
      return settled.state === "active";
    } catch { return false; }
  }

  /** The owning runner claimed this command but holds no result and is not running it: the
   * reviewer died with an earlier runner process. Its usage is unknown, so it is accounted exactly
   * once as such: the Session ends stopped, campaign accounting stops, the reservation is retained
   * (never refunded) and the review is revoked. It is never read back, restored or relaunched. */
  private lost(record: PreparedMediaRecord, row: ReviewRow | null): boolean {
    if (!this.db.campaignBudgets.active(record.sessionId)) return false;
    if (this.disposition(record)) return true; // Already accounted; a repeated answer changes nothing.
    const changed = this.atomically(() => {
      const ended = this.writeTerminalStatus(record.sessionId, "stopped");
      this.db.campaignBudgets.stop(record.rootSessionId, "accounting_unavailable",
        "A media reviewer ended without a usage result; its reservation is retained.");
      if (row && row.state !== "finished" && row.state !== "refused") {
        if (row.reviewId) this.store.settle(row.reviewId, "revoked");
        this.settleRefusal(row, this.refuse("reviewer_lost", "The reviewer ended without a result; its usage is unknown and retained."));
      }
      this.recordDisposition(record, "retained_unknown");
      return ended;
    });
    if (changed) this.attached?.hub.sessionChangedById(record.sessionId);
    this.log("video_evidence_review_lost", { sessionId: record.sessionId, occurrenceId: row?.occurrenceId });
    return true;
  }

  private recordDisposition(record: PreparedMediaRecord, disposition: "settled" | "retained_unpriced" | "retained_unknown"): void {
    this.db.raw().prepare("INSERT OR IGNORE INTO delegated_video_dispositions VALUES (?,?,?,?)")
      .run(record.sessionId, record.admission.dispatch.generation, disposition, this.clock());
  }

  /** The fence is recorded by SessionsService on the authenticated channel; the release and any
   * busy-host requeue follow here. Only the runner's structured `host_busy` is retried. */
  async onNeverDispatched(runnerId: string, receipt: MediaNeverDispatchedFence, reason?: "host_busy"): Promise<boolean> {
    if (!this.attached?.sessions.onMediaReviewNeverDispatched(runnerId, receipt)) return false;
    const found = this.recordFor(runnerId, receipt);
    if (!found) return true;
    // The outcome and its reason are durable before the release, so the subject's settlement below
    // can always be re-derived (`reconcileSubjects`) if this process stops in between.
    this.recordOutcome(found.record, "never_dispatched", reason === "host_busy" ? "host_busy" : null);
    const settled = await this.prepared.reconcile(identityOf(found.record));
    if (settled.state !== "cancelled") return true;
    if (found.row?.state === "dispatched") {
      const outcome = this.cancelledOutcome(found.record);
      this.settleCancelled(found.row, outcome.reason, outcome.observedAt);
    }
    return true;
  }

  /** A cancelled dispatch's subject: a busy host requeues within its bounds; anything else refuses.
   * The busy deadline is anchored to the first busy observation (`observedAt`, persisted with the
   * outcome); no requeue, restart, readback or recovery ever moves it. */
  private settleCancelled(row: ReviewRow, reason: "host_busy" | null, observedAt: number): void {
    if (row.reviewId) this.store.settle(row.reviewId, "revoked");
    const now = this.clock();
    if (reason === "host_busy") {
      row.firstBusyAt ??= observedAt;
      const delay = VIDEO_REVIEW_BUSY_BACKOFF_MS[row.busyRequeues ?? 0];
      if (delay !== undefined && now + delay - row.firstBusyAt <= VIDEO_REVIEW_BUSY_LIMIT_MS) {
        row.state = "queued"; row.reason = "host_busy"; row.nextAttemptAt = now + delay; row.attempt += 1;
        row.busyRequeues = (row.busyRequeues ?? 0) + 1;
        row.reviewerSessionId = null; row.updatedAt = now; this.ledger.save(row);
        this.log("video_evidence_review_requeued", { occurrenceId: row.occurrenceId, attempt: row.attempt, nextAttemptAt: row.nextAttemptAt });
        this.scheduleRetry(row);
        return;
      }
      this.settleRefusal(row, this.refuse("reviewer_busy_exhausted", "The reviewer host stayed busy."));
      return;
    }
    this.settleRefusal(row, this.refuse("reviewer_unavailable", "The runner refused to dispatch the reviewer."));
  }

  private scheduleRetry(row: ReviewRow): void {
    const key = `${row.occurrenceId}\0${row.evidenceId}`;
    if (this.timers.has(key)) return;
    this.timers.set(key, this.schedule(() => { this.timers.delete(key); void this.retry(row.occurrenceId, row.evidenceId); },
      Math.max(0, (row.nextAttemptAt ?? 0) - this.clock())));
  }

  /** A queued retry re-checks every admission precondition before reserving anything. */
  async retry(occurrenceId: string, evidenceId: string) {
    const row = this.ledger.get(occurrenceId, evidenceId);
    if (!row || row.state !== "queued" || !this.attached) return null;
    if ((row.nextAttemptAt ?? 0) > this.clock()) { this.scheduleRetry(row); return null; }
    // A suspended or restarted process can run a retry late; the deadline still holds.
    if (row.firstBusyAt !== null && this.clock() - row.firstBusyAt > VIDEO_REVIEW_BUSY_LIMIT_MS) {
      return this.settleRefusal(row, this.refuse("reviewer_busy_exhausted", "The reviewer host stayed busy past the retry deadline."));
    }
    const gate = this.attached.sessions.delegatedVideoGate(occurrenceId, ["pending"]);
    if (!gate || gate.root.id !== row.rootSessionId || gate.child.id !== row.childSessionId) {
      return this.settleRefusal(row, this.refuse("not_authorized", "The original decision is no longer pending for this owner."));
    }
    const blocked = this.admissionRefusal(gate.root, gate.child);
    if (blocked) return this.settleRefusal(row, blocked);
    row.state = "preparing"; row.reason = null; row.updatedAt = this.clock(); this.ledger.save(row);
    return this.attempt(row);
  }

  /** Final usage and lifecycle. Priced usage settles once; unpriced retains the reservation. */
  async onFinished(runnerId: string, result: MediaReviewFinished): Promise<boolean> {
    try {
      const { receiptSha256, ...body } = result;
      const found = this.recordFor(runnerId, result);
      if (!found || receiptSha256 !== sha(body) || result.deliveryPlanSha256 !== found.record.binding?.grant.deliveryPlanSha256 ||
        !Number.isSafeInteger(result.toolCalls) || result.toolCalls < 0 || result.priced !== (typeof result.costUsd === "number")) return false;
      const { row, record } = found;
      if (row?.finished) return JSON.stringify(row.finished) === JSON.stringify(result);
      if (this.disposition(record)) return true; // Already accounted, for example after the subject was deleted.
      // A finished reviewer was dispatched, whatever earlier receipt was lost.
      this.recordOutcome(record, "accepted");
      await this.prepared.reconcile(identityOf(record));
      const usage = result.priced ? { priced: true as const, costUsd: result.costUsd!, toolCalls: result.toolCalls }
        : { priced: false as const, toolCalls: result.toolCalls };
      const changed = this.atomically(() => {
        if (result.priced) this.db.raw().prepare("UPDATE sessions SET cost_usd=MAX(cost_usd,?),usage_peak_cost_usd=MAX(usage_peak_cost_usd,?)," +
          "usage_peak_tool_calls=MAX(usage_peak_tool_calls,?) WHERE id=?").run(result.costUsd!, result.costUsd!, result.toolCalls, record.sessionId);
        const ended = this.writeTerminalStatus(record.sessionId, result.outcome === "completed" && result.verdictConfirmed ? "completed" : "failed");
        this.db.campaignBudgets.settleMediaReview(record.sessionId, { rootSessionId: record.rootSessionId,
          generation: record.admission.dispatch.generation }, usage);
        this.recordDisposition(record, result.priced ? "settled" : "retained_unpriced");
        if (row) { row.finished = structuredClone(result); row.state = "finished"; row.updatedAt = this.clock(); this.ledger.save(row); }
        return ended;
      });
      if (changed) this.attached?.hub.sessionChangedById(record.sessionId);
      this.log("video_evidence_review_finished", { occurrenceId: row?.occurrenceId, reviewId: row?.reviewId, outcome: result.outcome,
        priced: result.priced, windowsCompleted: result.windowsCompleted });
      return true;
    } catch { return false; }
  }

  /** Only an open reviewer follows its runner's report, a provisional stop only while it is still
   * unconfirmed. A Stopped reviewer that still reports its end becomes stopped, never completed, so
   * it yields no provenance; nothing restores a Stopped, archived or finished reviewer. */
  private projectStatus(sessionId: string, status: "running"): void {
    if (this.writeStatus(sessionId, status)) this.attached?.hub.sessionChangedById(sessionId);
  }
  /** A terminal end: the runner's report for an open reviewer, otherwise a confirmed stop for one
   * still live or only provisionally stopped. Returns whether the Session changed. */
  private writeTerminalStatus(sessionId: string, status: "completed" | "failed" | "stopped"): boolean {
    const session = this.db.getSession(sessionId);
    if (!session || session.status === "completed" || session.status === "failed") return false;
    if (status !== "stopped" && this.writeStatus(sessionId, status)) return true;
    const stop = session.status === "stopped" ? this.db.sessionStopProvenance(sessionId) : null;
    if (isTerminal(session.status) && !(stop && sessionStopRestorable(stop))) return false;
    this.db.updateSessionStatus(sessionId, "stopped", this.clock(), RUNNER_REPORTED_STOP);
    return true;
  }
  private writeStatus(sessionId: string, status: "running" | "completed" | "failed"): boolean {
    const session = this.db.getSession(sessionId);
    if (!session || session.status === status || session.status === "completed" || session.status === "failed" ||
      !this.attached?.sessions.dedicatedMediaReviewerOpen(sessionId)) return false;
    this.db.updateSessionStatus(sessionId, status, this.clock());
    return true;
  }

  /** Stop pending timers (tests and shutdown). Queued rows stay durable and resume on attach. */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
