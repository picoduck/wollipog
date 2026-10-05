import { createHash } from "node:crypto";
import type { SessionSnapshot } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";

export const CLAUDE_RECONCILIATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_cost_receipts (
  event_id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  attribution_json TEXT NOT NULL,
  cost_microusd INTEGER NOT NULL,
  provider_reported_records INTEGER NOT NULL,
  FOREIGN KEY(event_id) REFERENCES session_events(id) ON DELETE CASCADE,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_usage_cost_receipts_session ON usage_cost_receipts(session_id);
CREATE TABLE IF NOT EXISTS usage_cost_reconciliations (
  digest TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  delta_microusd INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, revision),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS usage_cost_reconciliation_observations (
  session_id TEXT PRIMARY KEY,
  acknowledged_revision INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS usage_cost_reconciliation_precision (
  digest TEXT PRIMARY KEY,
  delta_remainder_picousd INTEGER NOT NULL,
  FOREIGN KEY(digest) REFERENCES usage_cost_reconciliations(digest) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS usage_cost_reconciliation_recoveries (
  digest TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_usage_cost_receipts_retention
  ON usage_cost_receipts(json_extract(attribution_json,'$.organizationId'), json_extract(attribution_json,'$.bucketTs'));
CREATE TABLE IF NOT EXISTS usage_cost_reconciled_events (
  event_id INTEGER PRIMARY KEY,
  digest TEXT NOT NULL,
  FOREIGN KEY(digest) REFERENCES usage_cost_reconciliations(digest) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES session_events(id) ON DELETE CASCADE
);
`;

interface Attribution {
  organizationId: string; ownerKind: string; ownerId: string; runnerId: string;
  workspaceId: string; agentId: string; driver: string; model: string; bucketTs: number;
  granularity?: "hour" | "day" | "pruned";
}
interface EvidenceRecord {
  eventId: number; conversation: string; process: string;
  boundary: "origin" | "continue" | "resume" | "reset" | "fork";
  startUsd: number; endUsd: number; model: string; scope: "query-tree";
  startByModelUsd?: Record<string, number>; endByModelUsd?: Record<string, number>;
  /** Accounting-only receipt from a trusted export, never inferred from current settings. */
  attribution?: Attribution;
  rounding?: { originalMicro: number; beforePicousd: number; afterPicousd: number };
}
interface Evidence {
  sessionId: string; eventEpoch: number; historyEpoch: number; importAuthorized: true;
  sourceSha256: string; records: EvidenceRecord[];
}
interface Row {
  eventId: number; timestamp: number; model: string; originalUsd: number; proposedUsd: number;
  status: "correctable" | "unresolved"; reason?: string;
}
interface PlannedRow extends Row {
  originalMicro: number; proposedMicro: number; table?: "usage_hourly" | "usage_daily";
  attribution?: Attribution;
  byModelMicro: Record<string, number>;
  originalPico: string; proposedPico: string; byModelPico: Record<string, string>;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) throw new Error("invalid accounting-only evidence fields");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128 || !/^[\w.:-]+$/.test(value)) throw new Error("invalid accounting identifier");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid accounting evidence digest");
  return value;
}
function modelId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128 || !/^[\w./:\[\]-]+$/.test(value)) throw new Error("invalid accounting model");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid accounting coordinate");
  return value;
}
function usd(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error("invalid accounting amount");
  return value;
}
function modelCosts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 20) throw new Error("invalid per-model accounting evidence");
  return Object.fromEntries(Object.entries(value).map(([model, amount]) => [modelId(model), usd(amount)]));
}
const PICO_PER_MICRO = 1_000_000n;

/** Match ingestion's micro-USD + pico-USD decomposition without unsafe large integers. */
function picoUsd(amount: number): bigint {
  const scaled = amount * 1_000_000;
  const whole = Math.floor(scaled);
  return BigInt(whole) * PICO_PER_MICRO + BigInt(Math.round((scaled - whole) * 1_000_000));
}
function roundMicro(pico: bigint): number {
  const shifted = pico + 500_000n;
  const rounded = shifted >= 0n ? shifted / PICO_PER_MICRO : (shifted - 999_999n) / PICO_PER_MICRO;
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) throw new Error("accounting amount exceeds safe ledger precision");
  return value;
}
function remainder(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -500_000 || value >= 500_000) {
    throw new Error("invalid original rounding remainder");
  }
  return value;
}

function cumulativeModels(record: EvidenceRecord, edge: "start" | "end"): Record<string, number> {
  return (edge === "start" ? record.startByModelUsd : record.endByModelUsd) ?? { [record.model]: edge === "start" ? record.startUsd : record.endUsd };
}
function parseEvidence(value: unknown): Evidence {
  const input = object(value, ["sessionId", "eventEpoch", "historyEpoch", "importAuthorized", "sourceSha256", "records"]);
  if (input.importAuthorized !== true) throw new Error("explicit accounting-only import authorization is required");
  if (!Array.isArray(input.records) || input.records.length === 0 || input.records.length > 200) throw new Error("evidence must contain 1–200 records");
  const records = input.records.map((raw): EvidenceRecord => {
    const record = object(raw, ["eventId", "conversation", "process", "boundary", "startUsd", "endUsd", "model", "scope", "attribution", "startByModelUsd", "endByModelUsd", "rounding"]);
    if (!["origin", "continue", "resume", "reset", "fork"].includes(String(record.boundary)) || record.scope !== "query-tree") throw new Error("invalid accounting boundary or scope");
    let attribution: Attribution | undefined;
    if (record.attribution !== undefined) {
      const a = object(record.attribution, ["organizationId", "ownerKind", "ownerId", "runnerId", "workspaceId", "agentId", "driver", "model", "bucketTs", "granularity"]);
      if (!["organization", "user", "team"].includes(String(a.ownerKind)) || a.driver !== "claude-code") throw new Error("invalid accounting attribution");
      if (a.granularity !== undefined && !["hour", "day", "pruned"].includes(String(a.granularity))) throw new Error("invalid retained accounting attribution");
      attribution = { organizationId: id(a.organizationId), ownerKind: String(a.ownerKind), ownerId: id(a.ownerId),
        runnerId: id(a.runnerId), workspaceId: a.workspaceId === "" ? "" : id(a.workspaceId),
        agentId: a.agentId === "" ? "" : id(a.agentId), driver: "claude-code", model: modelId(a.model), bucketTs: integer(a.bucketTs),
        ...(a.granularity ? { granularity: a.granularity as Attribution["granularity"] } : {}) };
    }
    let rounding: EvidenceRecord["rounding"];
    if (record.rounding !== undefined) {
      const r = object(record.rounding, ["originalMicro", "beforePicousd", "afterPicousd"]);
      rounding = { originalMicro: integer(r.originalMicro), beforePicousd: remainder(r.beforePicousd), afterPicousd: remainder(r.afterPicousd) };
    }
    if ((record.startByModelUsd === undefined) !== (record.endByModelUsd === undefined)) throw new Error("both per-model checkpoints are required");
    return { eventId: integer(record.eventId), conversation: hash(record.conversation), process: hash(record.process),
      boundary: record.boundary as EvidenceRecord["boundary"], startUsd: usd(record.startUsd), endUsd: usd(record.endUsd),
      model: modelId(record.model), scope: "query-tree", ...(attribution ? { attribution } : {}), ...(rounding ? { rounding } : {}),
      ...(record.startByModelUsd === undefined ? {} : { startByModelUsd: modelCosts(record.startByModelUsd), endByModelUsd: modelCosts(record.endByModelUsd) }) };
  });
  if (new Set(records.map((r) => r.eventId)).size !== records.length) throw new Error("duplicate evidence event");
  return { sessionId: id(input.sessionId), eventEpoch: integer(input.eventEpoch), historyEpoch: integer(input.historyEpoch),
    sourceSha256: hash(input.sourceSha256), importAuthorized: true, records };
}

function authorize(db: ControlPlaneDb, principal: HumanPrincipal, sessionId: string): void {
  if (principal.kind !== "human" || !["owner", "admin"].includes(principal.role) || !db.canAccessSession(principal, sessionId)) {
    throw new Error("organization owner or admin permission for this session is required");
  }
}

function bucketKey(a: Attribution, daily: boolean): Array<string | number> {
  return [daily ? Math.floor(a.bucketTs / 86_400_000) * 86_400_000 : a.bucketTs,
    a.organizationId, a.ownerKind, a.ownerId, a.runnerId, a.workspaceId, a.agentId, a.driver, a.model];
}
const BUCKET_WHERE = "bucket_ts=? AND organization_id=? AND owner_kind=? AND owner_id=? AND runner_id=? AND workspace_id=? AND agent_id=? AND driver=? AND model=?";

function plan(db: ControlPlaneDb, principal: HumanPrincipal, evidence: Evidence, recovering = false) {
  authorize(db, principal, evidence.sessionId);
  const sql = db.raw();
  const session = sql.prepare("SELECT event_epoch, driver, cost_usd, status, runner_id FROM sessions WHERE id=?").get(evidence.sessionId)!;
  const state = sql.prepare("SELECT * FROM usage_session_state WHERE session_id=?").get(evidence.sessionId);
  if (session.driver !== "claude-code" || session.event_epoch !== evidence.eventEpoch || state?.runner_history_epoch !== evidence.historyEpoch) throw new Error("accounting history scope changed or is unavailable");
  const rows: PlannedRow[] = [];
  const dependencies: unknown[] = [session, state];
  let prior: EvidenceRecord | undefined;
  let priorSeq = 0;
  const conversations = new Set<string>();
  const processes = new Set<string>();
  for (const record of evidence.records) {
    const event = sql.prepare("SELECT id, seq, runner_seq, ts, payload FROM session_events WHERE id=? AND session_id=? AND kind='token_usage'").get(record.eventId, evidence.sessionId);
    if (!event) throw new Error("accounting event is unavailable in this session");
    const payload = JSON.parse(String(event.payload)) as Record<string, unknown>;
    const originalUsd = typeof payload.costUsd === "number" ? payload.costUsd : 0;
    const originalPico = picoUsd(originalUsd);
    const proposedPico = picoUsd(record.endUsd) - picoUsd(record.startUsd);
    const originalMicro = record.rounding?.originalMicro ?? roundMicro(originalPico);
    const proposedMicro = roundMicro(proposedPico);
    const row: PlannedRow = { eventId: record.eventId, timestamp: Number(event.ts), model: record.model,
      originalUsd, proposedUsd: Number(proposedPico) / 1e12, originalMicro, proposedMicro,
      originalPico: String(originalPico), proposedPico: String(proposedPico), byModelMicro: {}, byModelPico: {}, status: "correctable" };
    const unresolved = (reason: string) => { row.status = "unresolved"; row.reason ??= reason; };
    if (Number(event.seq) <= priorSeq) throw new Error("accounting evidence must follow original event order");
    const previousSeq = priorSeq;
    priorSeq = Number(event.seq);
    const start = picoUsd(record.startUsd), end = picoUsd(record.endUsd);
    const previousEnd = prior ? picoUsd(prior.endUsd) : null;
    if (end < start) unresolved("cumulative counter decreased without a reset");
    if (record.boundary === "origin" || record.boundary === "reset") {
      if (start !== 0n || conversations.has(record.conversation) || processes.has(record.process)) unresolved("fresh origin/reset does not establish a new zero baseline");
    } else if (!prior || previousEnd !== start ||
        (record.boundary !== "fork" && prior.conversation !== record.conversation) ||
        (record.boundary === "continue" ? prior.process !== record.process : processes.has(record.process)) ||
        (record.boundary === "fork" && conversations.has(record.conversation))) {
      unresolved("resume/fork/process boundary is not established by contiguous checkpoints");
    }
    const beforeModels = cumulativeModels(record, "start"), afterModels = cumulativeModels(record, "end");
    if (Object.values(beforeModels).reduce((a, b) => a + picoUsd(b), 0n) !== start ||
        Object.values(afterModels).reduce((a, b) => a + picoUsd(b), 0n) !== end) unresolved("per-model checkpoints do not cover the complete query tree");
    for (const model of new Set([...Object.keys(beforeModels), ...Object.keys(afterModels)])) {
      const difference = picoUsd(afterModels[model] ?? 0) - picoUsd(beforeModels[model] ?? 0);
      if (difference < 0n) unresolved("per-model counter decreased without a reset");
      if (difference > 0n) {
        Object.defineProperty(row.byModelPico, model, { value: String(difference), enumerable: true, configurable: true, writable: true });
        Object.defineProperty(row.byModelMicro, model, { value: roundMicro(difference), enumerable: true, configurable: true, writable: true });
      }
    }
    if (!Object.keys(row.byModelMicro).length) row.byModelMicro[record.model] = 0;
    // Preserve a priced-zero provenance for the old token attribution when the verified
    // query-tree cost belongs entirely to other models. Tokens are deliberately not rewritten.
    if (!Object.hasOwn(row.byModelMicro, record.model)) Object.defineProperty(row.byModelMicro, record.model, { value: 0, enumerable: true, configurable: true, writable: true });
    if (!Object.hasOwn(row.byModelPico, record.model)) Object.defineProperty(row.byModelPico, record.model, { value: "0", enumerable: true, configurable: true, writable: true });
    if (prior && !["origin", "reset"].includes(record.boundary)) {
      const previousModels = cumulativeModels(prior, "end");
      if ([...new Set([...Object.keys(previousModels), ...Object.keys(beforeModels)])].some((model) =>
        picoUsd(previousModels[model] ?? 0) !== picoUsd(beforeModels[model] ?? 0))) unresolved("per-model prefix boundary is not established");
    }
    // A missing intervening charge makes the cumulative-prefix claim ambiguous. Non-accounting
    // events are harmless; independently billed usage must be included in the evidence chain.
    if (prior) {
      const gap = sql.prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id=? AND kind='token_usage' AND seq>? AND seq<? AND (json_extract(payload,'$.parentToolUseId') IS NULL OR json_extract(payload,'$.independentUsage')=1)").get(evidence.sessionId, previousSeq, Number(event.seq));
      if (Number(gap?.n) > 0) unresolved("intervening accounting records are missing");
    }
    conversations.add(record.conversation); processes.add(record.process);
    const expectedOriginal = record.boundary === "continue" ? proposedPico : end;
    if (originalPico !== expectedOriginal || payload.model !== record.model || payload.parentToolUseId || payload.independentUsage || payload.accountingIncomplete) unresolved("original query-tree/model cost is not established");
    if (payload.costIsEstimate || payload.claudeUsageCheckpoint) unresolved("record already uses the corrected accounting version");
    if (event.runner_seq == null || Number(event.runner_seq) > Number(state?.covered_through_seq)) unresolved("event has no accepted replay coverage");
    if (sql.prepare("SELECT 1 FROM usage_cost_reconciled_events WHERE event_id=?").get(record.eventId)) unresolved("event is already reconciled");
    const fractional = [originalPico, start, end, ...Object.values(beforeModels).map(picoUsd), ...Object.values(afterModels).map(picoUsd)]
      .some((amount) => amount % PICO_PER_MICRO !== 0n);
    if (fractional && !record.rounding) unresolved("sub-micro accounting attribution requires original rounding proof");
    if (record.rounding) {
      const combined = originalPico + BigInt(record.rounding.beforePicousd);
      if (roundMicro(combined) !== originalMicro || combined - BigInt(originalMicro) * PICO_PER_MICRO !== BigInt(record.rounding.afterPicousd)) {
        unresolved("original rounding proof does not match the event contribution");
      }
      if (prior?.rounding && prior.rounding.afterPicousd !== record.rounding.beforePicousd) unresolved("original rounding checkpoints are not contiguous");
    }
    const receipt = sql.prepare("SELECT attribution_json, cost_microusd, provider_reported_records FROM usage_cost_receipts WHERE event_id=? AND session_id=?").get(record.eventId, evidence.sessionId);
    const attribution = receipt ? JSON.parse(String(receipt.attribution_json)) as Attribution : record.attribution;
    if (!attribution || attribution.organizationId !== principal.organizationId || attribution.model !== record.model || attribution.driver !== "claude-code" || attribution.bucketTs !== Math.floor(Number(event.ts) / 3_600_000) * 3_600_000 ||
        (receipt && (receipt.cost_microusd !== originalMicro || receipt.provider_reported_records !== 1))) unresolved("original observation attribution requires a trusted accounting receipt");
    if (attribution) {
      row.attribution = attribution;
      const hour = sql.prepare(`SELECT cost_microusd, provider_reported_records FROM usage_hourly WHERE ${BUCKET_WHERE}`).get(...bucketKey(attribution, false));
      const day = sql.prepare(`SELECT cost_microusd, provider_reported_records FROM usage_daily WHERE ${BUCKET_WHERE}`).get(...bucketKey(attribution, true));
      dependencies.push(hour ?? null, day ?? null);
      if (attribution.granularity === "pruned") unresolved("original aggregate contribution is no longer retained");
      else if (hour && day && !attribution.granularity) unresolved("observation exists in both retained granularities; attribution is ambiguous");
      else if (hour || day) {
        row.table = attribution.granularity === "day" ? "usage_daily" : attribution.granularity === "hour" ? "usage_hourly" : hour ? "usage_hourly" : "usage_daily";
        const bucket = row.table === "usage_hourly" ? hour : day;
        if (!bucket) unresolved("original retained contribution is unavailable");
        else
        if (Number(bucket.cost_microusd) < originalMicro || Number(bucket.provider_reported_records) < 1) unresolved("retained bucket lacks the original priced contribution");
      } else unresolved("original aggregate contribution is no longer retained");
    }
    if (!recovering && observedReconciliationRevision(db, evidence.sessionId) > reconciliationRevision(db, evidence.sessionId)) unresolved("missing correction revision requires verified restore recovery");
    if ((db.getRunner(String(session.runner_id))?.protocolVersion ?? 0) < 199) unresolved("runner upgrade is required for revision-aware cost synchronization");
    const model = sql.prepare("SELECT cost_microusd, provider_reported_records FROM usage_session_models WHERE session_id=? AND model=?").get(evidence.sessionId, record.model);
    if (!model || Number(model.cost_microusd) < originalMicro || Number(model.provider_reported_records) < 1) unresolved("per-model ledger lacks the original priced contribution");
    dependencies.push(event, receipt ?? null, model ?? null);
    if (prior && rows[rows.length - 1]?.status === "unresolved" && !["origin", "reset"].includes(record.boundary)) unresolved("previous boundary remains unresolved");
    if (Object.values(row.byModelPico).reduce((a, b) => a + BigInt(b), 0n) !== proposedPico) unresolved("per-model delta does not match the query-tree delta");
    rows.push(row); prior = record;
  }
  let correctable = rows.filter((r) => r.status === "correctable");
  let deltaPico = correctable.reduce((sum, row) => sum + BigInt(row.proposedPico) - BigInt(row.originalPico), 0n);
  const currentRemainder = Number(state?.cost_remainder_picousd ?? 0);
  let deltaMicro = roundMicro(BigInt(currentRemainder) + deltaPico);
  const originalAllocated = correctable.reduce((sum, row) => sum + row.originalMicro, 0);
  const targetAllocated = originalAllocated + deltaMicro;
  if (targetAllocated < 0 || Number(state?.cost_microusd ?? 0) + deltaMicro < 0 || deltaPico > 0n || (targetAllocated > 0 && correctable.every((row) => row.proposedPico === "0"))) {
    for (const row of correctable) { row.status = "unresolved"; row.reason = "fractional correction lacks a retained nonnegative contribution"; }
    correctable = []; deltaPico = 0n; deltaMicro = 0;
  } else {
    // Preserve every unrelated integer contribution. Allocate the net carry only among corrected
    // rows, in evidence/model order, with residual units settled from the last affected model.
    const allocations = correctable.flatMap((row) => Object.keys(row.byModelMicro).map((model) => ({ row, model })));
    let balance = targetAllocated - allocations.reduce((sum, { row, model }) => sum + row.byModelMicro[model]!, 0);
    const positiveAllocations = allocations.filter(({ row, model }) => BigInt(row.byModelPico[model]!) > 0n);
    if (balance > 0 && positiveAllocations.length) { const last = positiveAllocations[positiveAllocations.length - 1]!; last.row.byModelMicro[last.model]! += balance; balance = 0; }
    for (let i = allocations.length - 1; balance < 0 && i >= 0; i--) {
      const { row, model } = allocations[i]!;
      const release = Math.min(row.byModelMicro[model]!, -balance);
      row.byModelMicro[model]! -= release; balance += release;
    }
    if (balance !== 0) throw new Error("fractional correction cannot allocate its retained contribution");
    for (const row of correctable) row.proposedMicro = Object.values(row.byModelMicro).reduce((sum, amount) => sum + amount, 0);
  }
  const proposedRemainder = Number(BigInt(currentRemainder) + deltaPico - BigInt(deltaMicro) * PICO_PER_MICRO);
  const deltaRemainderPicousd = proposedRemainder - currentRemainder;
  for (const row of rows) {
    if (row.attribution && row.table) for (const model of Object.keys(row.byModelMicro)) {
      dependencies.push(sql.prepare(`SELECT * FROM ${row.table} WHERE ${BUCKET_WHERE}`).get(...bucketKey({ ...row.attribution, model }, row.table === "usage_daily")) ?? null,
        sql.prepare("SELECT * FROM usage_session_models WHERE session_id=? AND model=?").get(evidence.sessionId, model) ?? null);
    }
  }
  const originalUsd = rows.reduce((sum, r) => sum + r.originalUsd, 0);
  const proposedUsd = rows.reduce((sum, r) => sum + (r.status === "correctable" ? r.proposedUsd : r.originalUsd), 0);
  const digest = createHash("sha256").update(JSON.stringify({ evidence, rows, dependencies })).digest("hex");
  const remaining = Number(sql.prepare("SELECT COUNT(*) AS n FROM session_events e WHERE session_id=? AND kind='token_usage' AND json_type(payload,'$.costUsd') IN ('real','integer') AND json_extract(payload,'$.costIsEstimate') IS NULL AND json_extract(payload,'$.parentToolUseId') IS NULL AND NOT EXISTS (SELECT 1 FROM usage_cost_reconciled_events r WHERE r.event_id=e.id)").get(evidence.sessionId)?.n ?? 0);
  return { digest, sessionId: evidence.sessionId, originalUsd, proposedUsd,
    sessionOriginalUsd: Number(session.cost_usd), sessionProposedUsd: Number(session.cost_usd) + Number(deltaPico) / 1e12,
    sessionOriginalRemainderPicousd: currentRemainder, sessionProposedRemainderPicousd: proposedRemainder,
    deltaMicrousd: deltaMicro, deltaRemainderPicousd,
    unresolvedRecords: Math.max(0, remaining - correctable.length),
    deltaUsd: Number(deltaPico) / 1e12, sourceSha256: evidence.sourceSha256,
    allocationPolicy: "Unrelated integer contributions stay fixed; carry is settled within corrected rows in evidence/model order, from the last affected model.",
    runnerEffect: "Revision-aware cumulative cost synchronization; tokens, replay coverage, checkpoint approvals, and existing approval cards are preserved. No automatic resume.", rows };

}

export function previewClaudeReconciliation(db: ControlPlaneDb, principal: HumanPrincipal, input: unknown) {
  const evidence = parseEvidence(input);
  const sql = db.raw();
  sql.exec("BEGIN");
  let preview: ReturnType<typeof plan>;
  try { preview = plan(db, principal, evidence); sql.exec("COMMIT"); }
  catch (error) { sql.exec("ROLLBACK"); throw error; }
  return { ...preview, rows: preview.rows.map(({ originalMicro, proposedMicro, table: _c, attribution: _d, byModelMicro, originalPico: _e, proposedPico: _f, byModelPico: _g, ...row }) =>
    ({ ...row, originalLedgerUsd: originalMicro / 1e6, proposedLedgerUsd: proposedMicro / 1e6, proposedByModelUsd: Object.fromEntries(Object.entries(byModelMicro).map(([model, amount]) => [model, amount / 1_000_000])) })) };
}

export function applyClaudeReconciliation(db: ControlPlaneDb, principal: HumanPrincipal, input: unknown, approvedDigest: string) {
  const evidence = parseEvidence(input);
  authorize(db, principal, evidence.sessionId);
  hash(approvedDigest);
  const sql = db.raw();
  sql.exec("BEGIN IMMEDIATE");
  try {
    const previous = sql.prepare("SELECT evidence_json, result_json FROM usage_cost_reconciliations WHERE digest=? AND organization_id=? AND session_id=?").get(approvedDigest, principal.organizationId, evidence.sessionId);
    if (previous) {
      if (previous.evidence_json !== JSON.stringify(evidence)) throw new Error("reconciliation retry evidence changed");
      sql.exec("COMMIT");
      return { ...JSON.parse(String(previous.result_json)), applied: false } as { applied: boolean; sessionId: string; revision: number; costUsd: number };
    }
    const preview = plan(db, principal, evidence);
    if (preview.digest !== approvedDigest) throw new Error("reconciliation preview changed; review a fresh preview");
    const result = commitPlan(db, principal, evidence, preview, approvedDigest);
    sql.exec("COMMIT");
    return result;
  } catch (error) { sql.exec("ROLLBACK"); throw error; }
}

function commitPlan(db: ControlPlaneDb, principal: HumanPrincipal, evidence: Evidence, preview: ReturnType<typeof plan>, approvedDigest: string,
  imported?: { deltaMicrousd: number; deltaRemainderPicousd: number; beforeLedger: LedgerCheckpoint }) {
  const sql = db.raw();
  const before = sql.prepare("SELECT revision, cost_microusd, cost_remainder_picousd, covered_through_seq FROM usage_session_state WHERE session_id=?").get(evidence.sessionId)!;
  const beforeLedger: LedgerCheckpoint = imported?.beforeLedger ?? { revision: Number(before.revision), costMicrousd: Number(before.cost_microusd),
    remainderPicousd: Number(before.cost_remainder_picousd), coveredThroughSeq: Number(before.covered_through_seq),
    eventSeq: Number(sql.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM session_events WHERE session_id=?").get(evidence.sessionId)?.seq) };
  const rows = preview.rows.filter((r) => r.status === "correctable");
  if (!rows.length) throw new Error("no provably correctable records");
  const delta = preview.deltaMicrousd;
  for (const row of rows) {
    const update = "cost_microusd=cost_microusd-?, provider_reported_records=provider_reported_records-1";
    const guard = " AND cost_microusd>=? AND provider_reported_records>=1";
    const bucket = sql.prepare(`UPDATE ${row.table!} SET ${update} WHERE ${BUCKET_WHERE}${guard}`).run(row.originalMicro, ...bucketKey(row.attribution!, row.table === "usage_daily"), row.originalMicro);
    const model = sql.prepare(`UPDATE usage_session_models SET ${update} WHERE session_id=? AND model=?${guard}`).run(row.originalMicro, evidence.sessionId, row.model, row.originalMicro);
    if (Number(bucket.changes) !== 1 || Number(model.changes) !== 1) throw new Error("original contribution changed during reconciliation");
    for (const [modelId, cost] of Object.entries(row.byModelMicro)) {
      const key = bucketKey({ ...row.attribution!, model: modelId }, row.table === "usage_daily");
      sql.prepare(`INSERT INTO ${row.table!} (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model, cost_microusd, model_priced_records)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model)
        DO UPDATE SET cost_microusd=cost_microusd+excluded.cost_microusd, model_priced_records=model_priced_records+1`).run(...key, cost);
      sql.prepare(`INSERT INTO usage_session_models (session_id, model, driver, cost_microusd, model_priced_records, updated_at)
        VALUES (?, ?, 'claude-code', ?, 1, ?)
        ON CONFLICT(session_id, model) DO UPDATE SET cost_microusd=cost_microusd+excluded.cost_microusd, model_priced_records=model_priced_records+1`).run(evidence.sessionId, modelId, cost, Date.now());
    }
  }
  const state = sql.prepare("UPDATE usage_session_state SET cost_microusd=cost_microusd+?, cost_remainder_picousd=?, provider_reported_records=provider_reported_records-?, model_priced_records=model_priced_records+?, revision=revision+1 WHERE session_id=? AND cost_microusd+?>=0 AND provider_reported_records>=?").run(delta, preview.sessionProposedRemainderPicousd, rows.length, rows.reduce((n, r) => n + Object.keys(r.byModelMicro).length, 0), evidence.sessionId, delta, rows.length);
  if (Number(state.changes) !== 1) throw new Error("session ledger lacks the original contributions");
  db.applyHistoricalCostCorrectionInTransaction(evidence.sessionId, preview.deltaUsd * 1e6);
  const revision = Number(sql.prepare("SELECT COALESCE(MAX(revision),0)+1 AS n FROM usage_cost_reconciliations WHERE session_id=?").get(evidence.sessionId)?.n);
  const result = { applied: true, sessionId: evidence.sessionId, revision, costUsd: db.sessionCostUsd(evidence.sessionId), beforeLedger,
    correction: { deltaMicrousd: delta, deltaRemainderPicousd: preview.deltaRemainderPicousd, allocationPolicy: preview.allocationPolicy,
      rows: rows.map((row) => ({ eventId: row.eventId, originalUsd: row.originalUsd, proposedUsd: row.proposedUsd,
        originalLedgerUsd: row.originalMicro / 1e6, proposedLedgerUsd: row.proposedMicro / 1e6, proposedByModelUsd: Object.fromEntries(Object.entries(row.byModelMicro).map(([model, cost]) => [model, cost / 1e6])) })) } };
  sql.prepare("INSERT INTO usage_cost_reconciliations (digest, organization_id, session_id, revision, delta_microusd, actor_id, source_sha256, evidence_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(approvedDigest, principal.organizationId, evidence.sessionId, revision, imported?.deltaMicrousd ?? delta, principal.actorId, evidence.sourceSha256, JSON.stringify(evidence), JSON.stringify(result), Date.now());
  for (const row of rows) sql.prepare("INSERT INTO usage_cost_reconciled_events VALUES (?, ?)").run(row.eventId, approvedDigest);
  sql.prepare("INSERT INTO usage_cost_reconciliation_precision VALUES (?, ?)").run(approvedDigest, imported?.deltaRemainderPicousd ?? preview.deltaRemainderPicousd);
  return result;
}

export function reconciliationRevision(db: ControlPlaneDb, sessionId: string): number {
  return Number(db.raw().prepare("SELECT COALESCE(MAX(revision),0) AS n FROM usage_cost_reconciliations WHERE session_id=?").get(sessionId)?.n ?? 0);
}

export function reconciliationDeltaUsd(db: ControlPlaneDb, sessionId: string): number {
  const sum = db.raw().prepare(`SELECT COALESCE(SUM(r.delta_microusd),0) AS delta, COALESCE(SUM(p.delta_remainder_picousd),0) AS remainder
    FROM usage_cost_reconciliations r LEFT JOIN usage_cost_reconciliation_precision p ON p.digest=r.digest WHERE r.session_id=?`).get(sessionId);
  return Number(sum?.delta ?? 0) / 1e6 + Number(sum?.remainder ?? 0) / 1e12;
}

/** Durable high-water mark for an authenticated owning runner's acknowledgement. */
export function observedReconciliationRevision(db: ControlPlaneDb, sessionId: string): number {
  return Number(db.raw().prepare("SELECT acknowledged_revision FROM usage_cost_reconciliation_observations WHERE session_id=?").get(sessionId)?.acknowledged_revision ?? 0);
}

export function observeReconciliationRevision(db: ControlPlaneDb, sessionId: string, acknowledged: number): void {
  if (!Number.isSafeInteger(acknowledged) || acknowledged <= 0) return;
  db.raw().prepare(`INSERT INTO usage_cost_reconciliation_observations VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET acknowledged_revision=MAX(acknowledged_revision, excluded.acknowledged_revision)`).run(sessionId, acknowledged);
}

/** Old snapshots retain their raw baseline until the runner acknowledges a correction revision. */
export function normalizeReconciledSnapshot(db: ControlPlaneDb, snapshot: SessionSnapshot): SessionSnapshot {
  const revision = reconciliationRevision(db, snapshot.id);
  const acknowledged = snapshot.costReconciliationRevision ?? 0;
  if (!Number.isSafeInteger(acknowledged) || acknowledged < 0 || Math.max(acknowledged, observedReconciliationRevision(db, snapshot.id)) > revision) throw new Error("invalid cost reconciliation revision");
  if (!revision) return snapshot;
  const session = db.getSession(snapshot.id);
  if (session && (db.getRunner(session.runnerId)?.protocolVersion ?? 0) < 199) {
    throw new Error("reconciled costs require a revision-aware runner; upgrade before synchronizing this session");
  }

  const sum = db.raw().prepare(`SELECT COALESCE(SUM(r.delta_microusd),0) AS delta, COALESCE(SUM(p.delta_remainder_picousd),0) AS remainder
    FROM usage_cost_reconciliations r LEFT JOIN usage_cost_reconciliation_precision p ON p.digest=r.digest
    WHERE r.session_id=? AND r.revision>?`).get(snapshot.id, acknowledged);
  const adjusted = picoUsd(snapshot.costUsd) + BigInt(Number(sum?.delta ?? 0)) * PICO_PER_MICRO + BigInt(Number(sum?.remainder ?? 0));
  return { ...snapshot, costUsd: Number(adjusted > 0n ? adjusted : 0n) / 1e12, costReconciliationRevision: revision };
}

interface LedgerCheckpoint {
  revision: number; costMicrousd: number; remainderPicousd: number; coveredThroughSeq: number; eventSeq: number;
}
function ledgerCheckpoint(value: unknown): LedgerCheckpoint {
  const row = object(value, ["revision", "costMicrousd", "remainderPicousd", "coveredThroughSeq", "eventSeq"]);
  return { revision: integer(row.revision), costMicrousd: integer(row.costMicrousd), remainderPicousd: remainder(row.remainderPicousd),
    coveredThroughSeq: integer(row.coveredThroughSeq), eventSeq: integer(row.eventSeq) };
}

interface RecoveryRevision {
  revision: number; digest: string; deltaMicrousd: number; deltaRemainderPicousd: number;
  eventIds: number[]; evidence: Evidence; beforeLedger: LedgerCheckpoint;
}
interface RecoveryEvidence {
  sessionId: string; eventEpoch: number; historyEpoch: number; targetRevision: number;
  importAuthorized: true; sourceSha256: string; revisions: RecoveryRevision[];
}

function signedInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("invalid correction amount");
  return value;
}

function parseRecovery(input: unknown): RecoveryEvidence {
  const value = object(input, ["sessionId", "eventEpoch", "historyEpoch", "targetRevision", "importAuthorized", "sourceSha256", "revisions"]);
  if (value.importAuthorized !== true) throw new Error("explicit accounting-only import authorization is required");
  const sessionId = id(value.sessionId), eventEpoch = integer(value.eventEpoch), historyEpoch = integer(value.historyEpoch);
  if (!Array.isArray(value.revisions) || !value.revisions.length || value.revisions.length > 20) throw new Error("recovery requires 1–20 contiguous revisions");
  let recordCount = 0;
  const revisions = value.revisions.map((input, index): RecoveryRevision => {
    const row = object(input, ["revision", "digest", "deltaMicrousd", "deltaRemainderPicousd", "eventIds", "evidence", "beforeLedger"]);
    const revision = integer(row.revision);
    if (revision !== index + 1) throw new Error("complete correction revision chain is required");
    const evidence = parseEvidence(row.evidence);
    if (evidence.sessionId !== sessionId || evidence.eventEpoch !== eventEpoch || evidence.historyEpoch !== historyEpoch) throw new Error("correction history scope does not match recovery");
    recordCount += evidence.records.length;
    if (recordCount > 1_000) throw new Error("recovery exceeds 1,000 accounting records");
    if (!Array.isArray(row.eventIds) || !row.eventIds.length || row.eventIds.length > 200) throw new Error("original corrected event identities are required");
    const eventIds = row.eventIds.map(integer);
    if (new Set(eventIds).size !== eventIds.length || eventIds.some((eventId) => !evidence.records.some((r) => r.eventId === eventId))) throw new Error("invalid corrected event identities");
    const deltaMicrousd = signedInteger(row.deltaMicrousd);
    const deltaRemainderPicousd = row.deltaRemainderPicousd === undefined ? 0 : signedInteger(row.deltaRemainderPicousd);
    if (Math.abs(deltaRemainderPicousd) >= 1_000_000 || BigInt(deltaMicrousd) * PICO_PER_MICRO + BigInt(deltaRemainderPicousd) > 0n) throw new Error("invalid original correction delta");
    return { revision, digest: hash(row.digest), deltaMicrousd, deltaRemainderPicousd, eventIds, evidence, beforeLedger: ledgerCheckpoint(row.beforeLedger) };
  });
  if (new Set(revisions.map((r) => r.digest)).size !== revisions.length || integer(value.targetRevision) !== revisions.length) throw new Error("invalid recovery target revision");
  return { sessionId, eventEpoch, historyEpoch, targetRevision: revisions.length,
    importAuthorized: true, sourceSha256: hash(value.sourceSha256), revisions };
}

/** Export only accounting receipts. The operator verifies the export and authorizes its import. */
export function exportClaudeReconciliations(db: ControlPlaneDb, principal: HumanPrincipal, sessionId: string) {
  authorize(db, principal, sessionId);
  const sql = db.raw();
  const session = db.getSession(sessionId)!;
  const state = sql.prepare("SELECT runner_history_epoch FROM usage_session_state WHERE session_id=?").get(sessionId);
  const rows = sql.prepare(`SELECT r.revision, r.digest, r.delta_microusd, r.evidence_json, r.result_json,
    COALESCE(p.delta_remainder_picousd,0) AS delta_remainder_picousd FROM usage_cost_reconciliations r
    LEFT JOIN usage_cost_reconciliation_precision p ON p.digest=r.digest WHERE r.session_id=? ORDER BY r.revision LIMIT 21`).all(sessionId);
  if (!rows.length || rows.length > 20 || rows.some((row, i) => row.revision !== i + 1)) throw new Error("complete bounded correction chain is unavailable");
  const revisions = rows.map((row) => ({ revision: Number(row.revision), digest: String(row.digest),
    deltaMicrousd: Number(row.delta_microusd), deltaRemainderPicousd: Number(row.delta_remainder_picousd),
    evidence: parseEvidence(JSON.parse(String(row.evidence_json))),
    beforeLedger: ledgerCheckpoint(JSON.parse(String(row.result_json)).beforeLedger),
    eventIds: sql.prepare("SELECT event_id FROM usage_cost_reconciled_events WHERE digest=? ORDER BY event_id").all(row.digest!).map((r) => Number(r.event_id)) }));
  // Deleted/pruned event identities cannot be silently exported as a complete recoverable chain.
  if (revisions.some((r) => !r.eventIds.length)) throw new Error("original corrected event identities are unavailable");
  if (revisions.reduce((sum, row) => sum + row.evidence.records.length, 0) > 1_000) throw new Error("accounting export exceeds the bounded recovery limit");
  return { sessionId, eventEpoch: session.eventEpoch, historyEpoch: Number(state?.runner_history_epoch), targetRevision: revisions.length, revisions };
}

function checkedRecoveryPlan(db: ControlPlaneDb, principal: HumanPrincipal, row: RecoveryRevision) {
  const sql = db.raw();
  const state = sql.prepare("SELECT * FROM usage_session_state WHERE session_id=?").get(row.evidence.sessionId)!;
  const checkpoint = row.beforeLedger;
  const maxSeq = Number(sql.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM session_events WHERE session_id=?").get(row.evidence.sessionId)?.seq);
  if (maxSeq < checkpoint.eventSeq) throw new Error("restored event history does not cover the verified checkpoint");
  const suffix = sql.prepare(`SELECT e.payload, e.runner_seq, e.seq, c.cost_microusd FROM session_events e
    LEFT JOIN usage_cost_receipts c ON c.event_id=e.id WHERE e.session_id=? AND e.seq>? AND e.kind='token_usage' ORDER BY e.seq LIMIT 1001`).all(row.evidence.sessionId, checkpoint.eventSeq);
  if (suffix.length > 1000) throw new Error("post-checkpoint accounting suffix exceeds recovery limit");
  let expectedPico = BigInt(checkpoint.costMicrousd) * PICO_PER_MICRO + BigInt(checkpoint.remainderPicousd);
  let expectedRevision = checkpoint.revision, expectedCoverage = checkpoint.coveredThroughSeq;
  for (const event of suffix) {
    const payload = JSON.parse(String(event.payload));
    if (payload.parentToolUseId && !payload.independentUsage) continue;
    if (event.runner_seq == null || Number(event.runner_seq) <= expectedCoverage || event.cost_microusd == null ||
        typeof payload.costUsd !== "number" || payload.costIsEstimate || payload.accountingIncomplete) {
      throw new Error("post-checkpoint usage lacks an authoritative accepted contribution");
    }
    expectedPico += picoUsd(payload.costUsd);
    expectedRevision++; expectedCoverage = Number(event.runner_seq);
  }
  const actualPico = BigInt(Number(state.cost_microusd)) * PICO_PER_MICRO + BigInt(Number(state.cost_remainder_picousd));
  if (actualPico !== expectedPico || Number(state.revision) !== expectedRevision || Number(state.covered_through_seq) < expectedCoverage) {
    throw new Error("restored ledger conflicts with the verified pre-correction checkpoint");
  }
  const preview = plan(db, principal, row.evidence, true);
  const ids = preview.rows.filter((r) => r.status === "correctable").map((r) => r.eventId).sort((a, b) => a - b);
  if (JSON.stringify(ids) !== JSON.stringify([...row.eventIds].sort((a, b) => a - b))) throw new Error("original corrected contributions are incomplete or changed");
  const actual = BigInt(preview.deltaMicrousd) * PICO_PER_MICRO + BigInt(preview.deltaRemainderPicousd);
  const expected = BigInt(row.deltaMicrousd) * PICO_PER_MICRO + BigInt(row.deltaRemainderPicousd);
  if (actual !== expected) throw new Error("verified correction delta conflicts with retained evidence");
  return preview;
}

function recoverPlan(db: ControlPlaneDb, principal: HumanPrincipal, input: RecoveryEvidence) {
  authorize(db, principal, input.sessionId);
  const sql = db.raw();
  const session = db.getSession(input.sessionId)!;
  const state = sql.prepare("SELECT * FROM usage_session_state WHERE session_id=?").get(input.sessionId);
  if (session.driver !== "claude-code" || session.eventEpoch !== input.eventEpoch || state?.runner_history_epoch !== input.historyEpoch) throw new Error("recovery history scope changed or is unavailable");
  const stored = sql.prepare(`SELECT r.*, COALESCE(p.delta_remainder_picousd,0) AS delta_remainder_picousd
    FROM usage_cost_reconciliations r LEFT JOIN usage_cost_reconciliation_precision p ON p.digest=r.digest WHERE r.session_id=? ORDER BY r.revision`).all(input.sessionId);
  if (stored.length > input.targetRevision) throw new Error("recovery target is older than the current ledger");
  for (let i = 0; i < stored.length; i++) {
    const local = stored[i]!, source = input.revisions[i]!;
    const ids = sql.prepare("SELECT event_id FROM usage_cost_reconciled_events WHERE digest=? ORDER BY event_id").all(local.digest!).map((r) => Number(r.event_id));
    if (local.revision !== source.revision || local.digest !== source.digest || local.organization_id !== principal.organizationId ||
        local.delta_microusd !== source.deltaMicrousd || local.delta_remainder_picousd !== source.deltaRemainderPicousd ||
        local.evidence_json !== JSON.stringify(source.evidence) || (JSON.parse(String(local.result_json)).beforeLedger !== undefined && JSON.stringify(ledgerCheckpoint(JSON.parse(String(local.result_json)).beforeLedger)) !== JSON.stringify(source.beforeLedger)) || JSON.stringify(ids) !== JSON.stringify([...source.eventIds].sort((a, b) => a - b))) {
      throw new Error("restored correction prefix conflicts with the verified export");
    }
  }
  // Pin pristine dependencies before simulation: temporary audit timestamps must not affect the
  // approval digest. Even unresolved plans retain event, receipt, model and bucket dependencies.
  const fingerprints = input.revisions.slice(stored.length).map((row) => {
    try { return plan(db, principal, row.evidence).digest; }
    catch (error) { return error instanceof Error ? error.message : "unavailable accounting evidence"; }
  });
  const runnerAcknowledgedRevision = observedReconciliationRevision(db, input.sessionId);
  const digest = createHash("sha256").update(JSON.stringify({ input, session, state, stored, fingerprints, runnerAcknowledgedRevision })).digest("hex");
  const unresolved: Array<{ revision: number; reason: string }> = [];
  const recoveredRevisions: number[] = [];
  if (runnerAcknowledgedRevision > input.targetRevision) unresolved.push({ revision: runnerAcknowledgedRevision, reason: "verified export does not cover the runner's acknowledged revision" });
  let proposedCostUsd = db.sessionCostUsd(input.sessionId);
  sql.exec("SAVEPOINT correction_recovery_preview");
  try {
    for (const row of unresolved.length ? [] : input.revisions.slice(stored.length)) {
      try {
        const preview = checkedRecoveryPlan(db, principal, row);
        const result = commitPlan(db, principal, row.evidence, preview, row.digest, row);
        if (result.revision !== row.revision) throw new Error("correction revision sequence changed");
        recoveredRevisions.push(row.revision);
        proposedCostUsd = result.costUsd;
      } catch (error) {
        unresolved.push({ revision: row.revision, reason: error instanceof Error ? error.message : "unavailable accounting evidence" });
        break;
      }
    }
  } finally { sql.exec("ROLLBACK TO correction_recovery_preview; RELEASE correction_recovery_preview"); }
  return { digest, sessionId: input.sessionId, databaseRevision: stored.length, runnerAcknowledgedRevision, targetRevision: input.targetRevision,
    originalCostUsd: db.sessionCostUsd(input.sessionId), proposedCostUsd, recoveredRevisions, unresolved,
    recoverable: unresolved.length === 0, sourceSha256: input.sourceSha256,
    runnerEffect: "Restore the verified correction identity; preserve subsequent usage and require normal revision-aware acknowledgement. No automatic resume." };
}

export function previewClaudeReconciliationRecovery(db: ControlPlaneDb, principal: HumanPrincipal, value: unknown) {
  const input = parseRecovery(value);
  const sql = db.raw();
  sql.exec("BEGIN");
  try { const preview = recoverPlan(db, principal, input); sql.exec("ROLLBACK"); return preview; }
  catch (error) { sql.exec("ROLLBACK"); throw error; }
}

export function applyClaudeReconciliationRecovery(db: ControlPlaneDb, principal: HumanPrincipal, value: unknown, approvedDigest: string) {
  const input = parseRecovery(value);
  authorize(db, principal, input.sessionId);
  hash(approvedDigest);
  const sql = db.raw();
  sql.exec("BEGIN IMMEDIATE");
  try {
    const prior = sql.prepare("SELECT evidence_json, result_json FROM usage_cost_reconciliation_recoveries WHERE digest=? AND session_id=? AND organization_id=?").get(approvedDigest, input.sessionId, principal.organizationId);
    if (prior) {
      if (prior.evidence_json !== JSON.stringify(input)) throw new Error("recovery retry evidence changed");
      sql.exec("COMMIT");
      return { ...JSON.parse(String(prior.result_json)), applied: false } as { applied: boolean; sessionId: string; revision: number; costUsd: number };
    }
    const preview = recoverPlan(db, principal, input);
    if (preview.digest !== approvedDigest || !preview.recoverable) throw new Error("recovery preview changed or contains unresolved evidence");
    for (const row of input.revisions.slice(preview.databaseRevision)) {
      const result = commitPlan(db, principal, row.evidence, checkedRecoveryPlan(db, principal, row), row.digest, row);
      if (result.revision !== row.revision) throw new Error("correction revision sequence changed");
    }
    const result = { applied: true, sessionId: input.sessionId, revision: reconciliationRevision(db, input.sessionId), costUsd: db.sessionCostUsd(input.sessionId),
      databaseRevision: preview.databaseRevision, recoveredRevisions: preview.recoveredRevisions };
    sql.prepare("INSERT INTO usage_cost_reconciliation_recoveries VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(approvedDigest, input.sessionId, principal.organizationId,
      principal.actorId, input.sourceSha256, JSON.stringify(input), JSON.stringify(result), Date.now());
    sql.exec("COMMIT");
    return result;
  } catch (error) { sql.exec("ROLLBACK"); throw error; }
}
