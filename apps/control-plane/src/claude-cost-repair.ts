import { createHash } from "node:crypto";
import type { CostCorrectionRunnerState, PricedSessionCostMessage } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import { correctionFrame, reconciliationCoordinate, reconciliationObservation, latestReconciliationRepair, sameAccountingUsd } from "./claude-cost-reconciliation.js";

function authorize(db: ControlPlaneDb, principal: HumanPrincipal, sessionId: string) {
  if (principal.kind !== "human" || !["owner", "admin"].includes(principal.role) || !db.canAccessSession(principal, sessionId)) {
    throw new Error("organization owner or admin permission for this session is required");
  }
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("invalid accounting repair fields");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid repair coordinate");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid repair digest");
  return value;
}
function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new Error("invalid repair amount");
  return value;
}

/** A trusted accounting export is independent evidence, not an authorization supplied by a snapshot. */
export function exportClaudeRepairCheckpoint(db: ControlPlaneDb, principal: HumanPrincipal, sessionId: string) {
  authorize(db, principal, sessionId);
  const session = db.getSession(sessionId)!;
  const ledger = db.raw().prepare(`SELECT revision, cost_microusd AS costMicrousd, cost_remainder_picousd AS remainderPicousd,
    covered_through_seq AS coveredThroughSeq, input_tokens AS tokensIn, output_tokens AS tokensOut,
    runner_history_epoch AS historyEpoch FROM usage_session_state WHERE session_id=?`).get(sessionId);
  if (session.driver !== "claude-code" || !ledger) throw new Error("authoritative accounting checkpoint unavailable");
  const seq = Number(db.raw().prepare("SELECT COALESCE(MAX(runner_seq),0) AS seq FROM session_events WHERE session_id=?").get(sessionId)?.seq);
  return { sessionId, eventEpoch: session.eventEpoch, historyEpoch: Number(ledger.historyEpoch),
    correction: reconciliationCoordinate(db, sessionId), ledger: { revision: Number(ledger.revision), costMicrousd: Number(ledger.costMicrousd), remainderPicousd: Number(ledger.remainderPicousd),
      coveredThroughSeq: Number(ledger.coveredThroughSeq), tokensIn: Number(ledger.tokensIn), tokensOut: Number(ledger.tokensOut), historyEpoch: Number(ledger.historyEpoch), seq } };
}

function parseEvidence(value: unknown) {
  const input = fields(value, ["sessionId", "eventEpoch", "historyEpoch", "sourceSha256", "importAuthorized", "correction", "ledger", "runner"]);
  if (typeof input.sessionId !== "string" || !/^[\w.:-]{1,128}$/.test(input.sessionId) || input.importAuthorized !== true) throw new Error("explicit accounting-only repair import is required");
  const correction = fields(input.correction, ["revision", "identity", "deltaUsd"]);
  const ledger = fields(input.ledger, ["revision", "costMicrousd", "remainderPicousd", "coveredThroughSeq", "tokensIn", "tokensOut", "historyEpoch", "seq"]);
  const runner = fields(input.runner, ["revision", "identity", "deltaUsd", "repairId", "costUsd", "tokensIn", "tokensOut", "historyEpoch", "seq"]);
  const remainder = amount(ledger.remainderPicousd);
  if (!Number.isSafeInteger(remainder) || remainder < -500_000 || remainder >= 500_000) throw new Error("invalid checkpoint remainder");
  return { sessionId: input.sessionId, eventEpoch: integer(input.eventEpoch), historyEpoch: integer(input.historyEpoch),
    sourceSha256: hash(input.sourceSha256), importAuthorized: true as const,
    correction: { revision: integer(correction.revision), identity: correction.identity === undefined ? undefined : hash(correction.identity), deltaUsd: amount(correction.deltaUsd) },
    ledger: { revision: integer(ledger.revision), costMicrousd: integer(ledger.costMicrousd), remainderPicousd: remainder,
      coveredThroughSeq: integer(ledger.coveredThroughSeq), tokensIn: integer(ledger.tokensIn), tokensOut: integer(ledger.tokensOut), historyEpoch: integer(ledger.historyEpoch), seq: integer(ledger.seq) },
    runner: { revision: integer(runner.revision), identity: runner.identity === undefined ? undefined : hash(runner.identity), deltaUsd: amount(runner.deltaUsd),
      repairId: runner.repairId === undefined ? undefined : hash(runner.repairId), costUsd: amount(runner.costUsd), tokensIn: integer(runner.tokensIn), tokensOut: integer(runner.tokensOut), historyEpoch: integer(runner.historyEpoch), seq: integer(runner.seq) } };
}
type RepairEvidence = ReturnType<typeof parseEvidence>;
function plan(db: ControlPlaneDb, principal: HumanPrincipal, input: RepairEvidence) {
  const checkpoint = exportClaudeRepairCheckpoint(db, principal, input.sessionId);
  const session = db.getSession(input.sessionId)!;
  const observation = reconciliationObservation(db, input.sessionId);
  const previous = latestReconciliationRepair(db, input.sessionId);
  const unresolved: string[] = [];
  const digest = createHash("sha256").update(JSON.stringify({ input, checkpoint, observation, previous })).digest("hex");
  if ((db.getRunner(session.runnerId)?.protocolVersion ?? 0) < 210) unresolved.push("runner upgrade is required for identity-aware repair");
  if (input.eventEpoch !== checkpoint.eventEpoch || input.historyEpoch !== checkpoint.historyEpoch ||
      JSON.stringify(input.ledger) !== JSON.stringify(checkpoint.ledger) ||
      JSON.stringify(input.correction) !== JSON.stringify(checkpoint.correction)) unresolved.push("verified accounting checkpoint differs from the retained ledger");
  if (input.runner.historyEpoch !== checkpoint.historyEpoch || input.runner.seq !== checkpoint.ledger.seq ||
      !sameAccountingUsd(input.runner.costUsd, db.sessionCostUsd(input.sessionId)) || input.runner.tokensIn !== checkpoint.ledger.tokensIn || input.runner.tokensOut !== checkpoint.ledger.tokensOut ||
      input.runner.deltaUsd !== checkpoint.correction.deltaUsd) unresolved.push("runner baseline is not established by the verified accounting checkpoint; recover missing corrections or usage first");
  if (input.runner.revision !== observation.revision) unresolved.push("runner revision differs from the durable observation");
  if (observation.coordinate) {
    const observed = JSON.parse(String(observation.coordinate));
    if (input.runner.revision !== observed.revision || input.runner.identity !== observed.identity || input.runner.deltaUsd !== observed.deltaUsd) unresolved.push("runner coordinate differs from the durable observation");
  }
  if (previous && input.runner.repairId !== previous.digest) unresolved.push("runner repair generation is not current");
  return { digest, sessionId: input.sessionId, historyEpoch: input.historyEpoch, observation,
    currentRevision: observation.revision, proposedCorrection: checkpoint.correction,
    costUsd: db.sessionCostUsd(input.sessionId), unresolved, repairable: unresolved.length === 0,
    runnerEffect: "Compare and swap metadata only; preserve cost, tokens and approvals. Remain fenced until identity-aware acknowledgement. No automatic resume." };
}

export function previewClaudeAcknowledgementRepair(db: ControlPlaneDb, principal: HumanPrincipal, value: unknown) {
  const input = parseEvidence(value), sql = db.raw();
  sql.exec("BEGIN");
  try { const result = plan(db, principal, input); sql.exec("ROLLBACK"); return result; }
  catch (error) { sql.exec("ROLLBACK"); throw error; }
}

export function applyClaudeAcknowledgementRepair(db: ControlPlaneDb, principal: HumanPrincipal, value: unknown, approvedDigest: string) {
  const input = parseEvidence(value), sql = db.raw();
  authorize(db, principal, input.sessionId); hash(approvedDigest);
  sql.exec("BEGIN IMMEDIATE");
  try {
    const prior = sql.prepare("SELECT * FROM usage_cost_reconciliation_repairs WHERE digest=? AND session_id=? AND organization_id=?").get(approvedDigest, input.sessionId, principal.organizationId);
    if (prior) {
      if (prior.evidence_json !== JSON.stringify(input) || latestReconciliationRepair(db, input.sessionId)?.digest !== approvedDigest) throw new Error("repair retry is superseded or changed");
      sql.exec("COMMIT");
      return { ...JSON.parse(String(prior.result_json)), applied: false, confirmed: !!prior.confirmed } as ReturnType<typeof plan> & { applied: boolean; confirmed: boolean };
    }
    const preview = plan(db, principal, input);
    if (preview.digest !== approvedDigest || !preview.repairable) throw new Error("repair preview changed or contains unresolved evidence");
    const result = { ...preview, applied: true, confirmed: false };
    sql.prepare("INSERT INTO usage_cost_reconciliation_repairs (digest,session_id,organization_id,actor_id,source_sha256,evidence_json,result_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(approvedDigest, input.sessionId, principal.organizationId, principal.actorId, input.sourceSha256, JSON.stringify(input), JSON.stringify(result), Date.now());
    sql.exec("COMMIT"); return result;
  } catch (error) { sql.exec("ROLLBACK"); throw error; }
}

/** Resend only the latest approved intent; the owning runner compares its complete current state. */
export function acknowledgementRepairFrame(db: ControlPlaneDb, sessionId: string): PricedSessionCostMessage | null {
  const repair = latestReconciliationRepair(db, sessionId);
  if (!repair || repair.confirmed) return null;
  const input = JSON.parse(String(repair.evidence_json)) as RepairEvidence;
  const intent = JSON.parse(String(repair.result_json));
  if (JSON.stringify(reconciliationObservation(db, sessionId)) !== JSON.stringify(intent.observation)) return null;
  const target = reconciliationCoordinate(db, sessionId);
  if (JSON.stringify(target) !== JSON.stringify(intent.proposedCorrection) || db.sessionCostUsd(sessionId) !== intent.costUsd) return null;
  return { ...correctionFrame(db, sessionId, target.revision), costUsd: input.runner.costUsd, costReconciliationRepair: { id: String(repair.digest), expected: input.runner as CostCorrectionRunnerState } };
}
