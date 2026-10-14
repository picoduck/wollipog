import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DurableSessionCommand, PacedVideoTransportGrant } from "@wollipog/protocol";
import { validReviewerBudgetAdmission, type EvidenceReviewerBudgetAdmission } from "./evidence-review-admission.js";

type StartCommand = Extract<DurableSessionCommand, { type: "start_session" }>;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  !/[\x00-\x1f\x7f]/u.test(value);
const digest = (value: string) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export interface PreparedMediaIdentity {
  rootSessionId: string;
  childSessionId: string;
  admissionId: string;
  requestSha256: string;
}
export interface MaterializedMediaSession {
  sessionId: string;
  runnerId: string;
  command: StartCommand;
  admission: EvidenceReviewerBudgetAdmission;
}
export interface PreparedMediaBinding {
  grant: PacedVideoTransportGrant;
  /** Actual per-Session namespace launch, distinct from the reusable live-validated policy. */
  namespaceLaunchSha256: string;
  namespacePolicySha256: string;
  /** Current original gate, audience, scope, policy, disclosure and evidence authority binding. */
  authoritySha256: string;
}
export type PreparedMediaState = "prepared" | "bound" | "dispatching" | "active" | "uncertain" | "cancelling" | "cancelled";
export interface PreparedMediaRecord extends PreparedMediaIdentity, MaterializedMediaSession {
  /** Transaction-local cancellation claim. Unsent and authenticated runner-fenced proofs are
   * distinct; a bare send/reconcile string never satisfies the concrete release adapter. */
  cancellation?: { kind: "never_enqueued" | "terminal_fenced"; from: "prepared" | "bound" | "dispatching" | "uncertain" };
  commandSha256: string;
  dispatchSha256: string | null;
  state: PreparedMediaState;
  binding: PreparedMediaBinding | null;
}
/** Private server ports, never request JSON or agent-selectable Session creation options.
 * materialize MUST reuse all createSession admission guards, without sendToRunner, and create
 * the actual Session/budget member in the supplied SAME SQLite transaction. Budget generation
 * is obtained after materialization. Absence of this integrated adapter is unsupported readiness. */
export interface PreparedMediaSessionPorts {
  database: DatabaseSync;
  /** Persist any ordinary governance ask before entering the atomic materialization.
   * Real Session-service adapter supplies this; no Session/member/provider is created here. */
  preflightMaterialization?(identity: PreparedMediaIdentity): void;
  materialize(identity: PreparedMediaIdentity): MaterializedMediaSession;
  /** Metadata notification only after this coordinator's actual commit, never during admission. */
  preparedCommitted?(record: PreparedMediaRecord): void;
  currentAdmission(sessionId: string): EvidenceReviewerBudgetAdmission | null;
  /** Actual durable Session/member generation even when current admission is revoked.
   * Cancellation must never release capacity belonging to a replacement generation. */
  currentIdentity(sessionId: string): { rootSessionId: string; runnerId: string; generation: string } | null;
  /** Full current original gate/scope/provider/private destination/namespace/source+frame check.
   * Must also enforce live-child, native/media and aggregate concurrency and current pricing. */
  authorize(record: PreparedMediaRecord, phase: "bind" | "dispatch" | "reconcile"): Promise<boolean>;
  /** Runner must authenticate and durably deduplicate this exact command/generation before
   * provider launch, enforce the media-only namespace/tool registry, and retain usage accounting.
   * This coordinator itself sends at most once: an unknown outcome is reconciliation only. */
  send(record: PreparedMediaRecord): Promise<"accepted" | "never_dispatched" | "unknown">;
  /** Authoritative authenticated runner receipt, not absence from an in-memory process list. */
  reconcile(record: PreparedMediaRecord): Promise<{
    dispatchSha256: string; sessionId: string; runnerId: string; generation: string;
    outcome: "accepted" | "never_dispatched" | "unknown";
  } | null>;
  /** Release only a proven never-dispatched actual Session through the #2936 ledger adapter,
   * atomically with cancellation. No fabricated live usage/checkpoint or in-flight settlement. */
  cancelNeverDispatched(record: PreparedMediaRecord): void;
}

function validMaterialized(identity: PreparedMediaIdentity, value: MaterializedMediaSession): boolean {
  const a = value.admission;
  return id(value.sessionId) && id(value.runnerId) &&
    value.sessionId !== identity.rootSessionId && value.sessionId !== identity.childSessionId &&
    value.command.type === "start_session" && value.command.spec.sessionId === value.sessionId &&
    typeof a?.worker?.model === "string" && Boolean(a.worker.model) &&
    validReviewerBudgetAdmission(a, { rootSessionId: identity.rootSessionId, reviewerSessionId: value.sessionId,
      reviewerDriver: value.command.spec.driver ?? "acp", reviewerModelId: a.worker.model,
      boundaryRevision: a.authorityRevision, workerAdmissionSha256: a.allocationDigest }) &&
    value.command.spec.config?.model === a.worker.model &&
    (value.command.spec.config?.effort ?? null) === a.worker.effort &&
    (a.allocation.costUsd === undefined || value.command.spec.config?.costBudgetUsd !== undefined &&
      value.command.spec.config.costBudgetUsd > 0 && value.command.spec.config.costBudgetUsd <= a.allocation.costUsd) &&
    (a.allocation.toolCalls === undefined || value.command.spec.config?.maxToolCalls !== undefined &&
      value.command.spec.config.maxToolCalls > 0 && value.command.spec.config.maxToolCalls <= a.allocation.toolCalls);
}
function validBinding(record: PreparedMediaRecord, binding: PreparedMediaBinding, now: number): boolean {
  const g = binding.grant;
  return [binding.namespaceLaunchSha256, binding.namespacePolicySha256, binding.authoritySha256,
    g.sourceSha256, g.manifestSha256, g.bindingSha256, g.criteriaSha256].every(digest) &&
    [g.reviewId, g.occurrenceId, g.sourceEvidenceId, g.sourceArtifactId].every(id) &&
    g.reviewerSessionId === record.sessionId && g.childSessionId === record.childSessionId &&
    Number.isSafeInteger(g.policyRevision) && g.policyRevision === record.admission.authorityRevision &&
    Number.isSafeInteger(g.expiresAt) && g.expiresAt > now && g.expiresAt <= now + 60 * 60 * 1000 &&
    Array.isArray(g.frames) && g.frames.length > 0 && g.frames.length <= 900 &&
    g.frames.every((f, index) => f.index === index && Number.isSafeInteger(f.ptsUs) &&
      f.ptsUs >= 0 && (index === 0 || f.ptsUs === g.frames[index - 1]!.ptsUs + g.frames[index - 1]!.durationUs) &&
      Number.isSafeInteger(f.durationUs) && f.durationUs >= 33_000 && digest(f.sha256) &&
      Number.isSafeInteger(f.sizeBytes) && f.sizeBytes > 0 && f.sizeBytes <= 2 * 1024 * 1024) &&
    g.frames.reduce((sum, f) => sum + f.sizeBytes, 0) <= 128 * 1024 * 1024 &&
    g.frames.at(-1)!.ptsUs + g.frames.at(-1)!.durationUs <= 30_000_000;
}

/** Owned lifecycle ledger. It is deliberately NOT wired to automation delivery or public
 * createSession APIs. Production wiring is held for actual prerequisite integration and proof. */
export class PreparedMediaSessions {
  constructor(private readonly db: DatabaseSync, private readonly ports: PreparedMediaSessionPorts,
    private readonly now: () => number = Date.now) {
    if (ports.database !== db) throw new Error("Media Session admission must share its atomic database.");
    db.exec("CREATE TABLE IF NOT EXISTS prepared_media_sessions (" +
      "root_id TEXT NOT NULL, admission_id TEXT NOT NULL, request_sha256 TEXT NOT NULL," +
      "state TEXT NOT NULL, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL," +
      "PRIMARY KEY(root_id,admission_id));");
  }
  private transaction<T>(action: () => T): T {
    this.db.exec("SAVEPOINT media_session_admission");
    try {
      const value = action();
      this.db.exec("RELEASE media_session_admission");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK TO media_session_admission");
      this.db.exec("RELEASE media_session_admission");
      throw error;
    }
  }
  private save(record: PreparedMediaRecord): void {
    const payload = JSON.stringify(record);
    if (payload.length > 512 * 1024) throw new Error("Prepared media command exceeds its metadata bound.");
    this.db.prepare("INSERT INTO prepared_media_sessions(root_id,admission_id,request_sha256,state,payload,payload_sha256) VALUES (?,?,?,?,?,?) ON CONFLICT(root_id,admission_id)" +
      " DO UPDATE SET state=excluded.state,payload=excluded.payload,payload_sha256=excluded.payload_sha256")
      .run(record.rootSessionId, record.admissionId, record.requestSha256, record.state, payload, sha(record));
  }
  get(identity: PreparedMediaIdentity): PreparedMediaRecord | null {
    const row = this.db.prepare("SELECT * FROM prepared_media_sessions WHERE root_id=? AND admission_id=?")
      .get(identity.rootSessionId, identity.admissionId) as {
        request_sha256: string; state: string; payload: string; payload_sha256: string;
      } | undefined;
    if (!row) return null;
    if (row.request_sha256 !== identity.requestSha256) throw new Error("Media admission cannot be rebound.");
    const record = JSON.parse(row.payload) as PreparedMediaRecord;
    if (sha(record) !== row.payload_sha256 || record.state !== row.state ||
      record.rootSessionId !== identity.rootSessionId || record.admissionId !== identity.admissionId ||
      record.childSessionId !== identity.childSessionId || record.requestSha256 !== identity.requestSha256 ||
      record.commandSha256 !== sha(record.command) ||
      (record.binding === null ? record.dispatchSha256 !== null :
        record.dispatchSha256 !== sha({ command: record.command, admission: record.admission, binding: record.binding })) ||
      !validMaterialized(identity, record)) {
      throw new Error("Prepared media provenance is invalid; reconcile without replay.");
    }
    return record;
  }
  prepare(identity: PreparedMediaIdentity): PreparedMediaRecord {
    if (this.db.isTransaction) throw new Error("Media preparation must own its commit boundary.");
    if (![identity.rootSessionId, identity.childSessionId, identity.admissionId].every(id) ||
      identity.rootSessionId === identity.childSessionId || !digest(identity.requestSha256)) {
      throw new Error("Exact campaign and child media identity is required.");
    }
    if (!this.get(identity)) this.ports.preflightMaterialization?.(identity);
    let created = false;
    const prepared = this.transaction(() => {
      const existing = this.get(identity);
      if (existing) return existing;
      const materialized = this.ports.materialize(identity);
      if (!validMaterialized(identity, materialized)) throw new Error("Actual managed media Session admission is required.");
      const record: PreparedMediaRecord = { ...identity, ...materialized,
        commandSha256: sha(materialized.command), dispatchSha256: null, state: "prepared", binding: null };
      this.save(record);
      created = true;
      return this.get(identity)!;
    });
    if (created) this.ports.preparedCommitted?.(structuredClone(prepared));
    return prepared;
  }
  private sameGeneration(record: PreparedMediaRecord): boolean {
    const actual = this.ports.currentIdentity(record.sessionId);
    return Boolean(actual && actual.rootSessionId === record.rootSessionId && actual.runnerId === record.runnerId &&
      actual.generation === record.admission.dispatch.generation);
  }
  private current(record: PreparedMediaRecord): boolean {
    const admission = this.ports.currentAdmission(record.sessionId);
    // Never silently update a generation, allocation, worker model/effort or authority snapshot.
    return this.sameGeneration(record) && admission !== null && sha(admission) === sha(record.admission);
  }
  async bind(identity: PreparedMediaIdentity, binding: PreparedMediaBinding): Promise<PreparedMediaRecord> {
    const record = this.get(identity);
    if (!record) throw new Error("Media Session has not been prepared.");
    const copy = structuredClone(binding);
    if (record.state === "bound" && sha(record.binding) === sha(copy)) return record;
    if (record.state !== "prepared" || !validBinding(record, copy, this.now()) || !this.current(record)) {
      throw new Error("Media grant must bind the current never-dispatched Session.");
    }
    record.binding = copy;
    if (!await this.ports.authorize(structuredClone(record), "bind") || !this.current(record) ||
      !validBinding(record, copy, this.now())) throw new Error("Current media authority or source integrity denied.");
    return this.transaction(() => {
      const latest = this.get(identity)!;
      if (latest.state !== "prepared") throw new Error("Concurrent media binding changed the Session.");
      record.dispatchSha256 = sha({ command: record.command, admission: record.admission, binding: record.binding });
      record.state = "bound";
      this.save(record);
      return this.get(identity)!;
    });
  }
  async dispatch(identity: PreparedMediaIdentity): Promise<PreparedMediaRecord> {
    let record = this.get(identity);
    if (!record?.binding) throw new Error("No complete immutable media grant.");
    if (record.state !== "bound") return this.reconcile(identity);
    if (!this.current(record) || !validBinding(record, record.binding, this.now()) ||
      !await this.ports.authorize(structuredClone(record), "dispatch") ||
      !this.current(record) || !validBinding(record, record.binding, this.now())) {
      throw new Error("Current media dispatch authority denied.");
    }
    const claim = this.transaction(() => {
      const current = this.get(identity)!;
      if (current.state !== "bound") return { record: current, claimed: false };
      current.state = "dispatching"; this.save(current); return { record: current, claimed: true };
    });
    if (!claim.claimed) return this.reconcile(identity);
    let outcome: "accepted" | "never_dispatched" | "unknown";
    try { outcome = await this.ports.send(structuredClone(claim.record)); }
    catch { outcome = "unknown"; }
    return this.settle(identity, outcome);
  }
  private settle(identity: PreparedMediaIdentity, outcome: "accepted" | "never_dispatched" | "unknown"): PreparedMediaRecord {
    return this.transaction(() => {
      const record = this.get(identity)!;
      if (record.state !== "dispatching" && record.state !== "uncertain") return record;
      if (outcome === "never_dispatched" && !this.sameGeneration(record)) {
        record.state = "uncertain";
      } else if (outcome === "never_dispatched") {
        record.cancellation = { kind: "terminal_fenced", from: record.state };
        record.state = "cancelling"; this.save(record);
        this.ports.cancelNeverDispatched(structuredClone(record)); record.state = "cancelled";
      } else record.state = outcome === "accepted" ? "active" : "uncertain";
      this.save(record); return this.get(identity)!;
    });
  }
  async reconcile(identity: PreparedMediaIdentity): Promise<PreparedMediaRecord> {
    const record = this.get(identity);
    if (!record) throw new Error("Unknown prepared media Session.");
    if (!["dispatching", "uncertain"].includes(record.state)) return record;
    const receipt = await this.ports.reconcile(structuredClone(record));
    if (!receipt || receipt.sessionId !== record.sessionId || receipt.runnerId !== record.runnerId ||
      receipt.dispatchSha256 !== record.dispatchSha256 || receipt.generation !== record.admission.dispatch.generation) return record;
    // Never-dispatched cancellation is safe even after revocation. Accepted is historical launch
    // status only, never an access grant; current media endpoints independently enforce authority.
    if (receipt.outcome === "accepted" && !await this.ports.authorize(structuredClone(record), "reconcile")) return record;
    return this.settle(identity, receipt.outcome);
  }
  cancelPrepared(identity: PreparedMediaIdentity): PreparedMediaRecord {
    return this.transaction(() => {
      const record = this.get(identity);
      if (!record || !["prepared", "bound"].includes(record.state)) {
        throw new Error("Unknown or possibly dispatched capacity cannot be released.");
      }
      if (!this.sameGeneration(record)) throw new Error("Replacement generation capacity cannot be released.");
      record.cancellation = { kind: "never_enqueued", from: record.state as "prepared" | "bound" };
      record.state = "cancelling"; this.save(record);
      this.ports.cancelNeverDispatched(structuredClone(record));
      record.state = "cancelled"; this.save(record); return this.get(identity)!;
    });
  }
}
