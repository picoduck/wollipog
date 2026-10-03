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
function cumulativeModels(record: EvidenceRecord, edge: "start" | "end"): Record<string, number> {
  return (edge === "start" ? record.startByModelUsd : record.endByModelUsd) ?? { [record.model]: edge === "start" ? record.startUsd : record.endUsd };
}
function parseEvidence(value: unknown): Evidence {
  const input = object(value, ["sessionId", "eventEpoch", "historyEpoch", "importAuthorized", "sourceSha256", "records"]);
  if (input.importAuthorized !== true) throw new Error("explicit accounting-only import authorization is required");
  if (!Array.isArray(input.records) || input.records.length === 0 || input.records.length > 200) throw new Error("evidence must contain 1–200 records");
  const records = input.records.map((raw): EvidenceRecord => {
    const record = object(raw, ["eventId", "conversation", "process", "boundary", "startUsd", "endUsd", "model", "scope", "attribution", "startByModelUsd", "endByModelUsd"]);
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
    if ((record.startByModelUsd === undefined) !== (record.endByModelUsd === undefined)) throw new Error("both per-model checkpoints are required");
    return { eventId: integer(record.eventId), conversation: hash(record.conversation), process: hash(record.process),
      boundary: record.boundary as EvidenceRecord["boundary"], startUsd: usd(record.startUsd), endUsd: usd(record.endUsd),
      model: modelId(record.model), scope: "query-tree", ...(attribution ? { attribution } : {}),
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

function plan(db: ControlPlaneDb, principal: HumanPrincipal, evidence: Evidence) {
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
    const originalMicro = Math.round(originalUsd * 1_000_000);
    const proposedMicro = Math.round((record.endUsd - record.startUsd) * 1_000_000);
    const row: PlannedRow = { eventId: record.eventId, timestamp: Number(event.ts), model: record.model,
      originalUsd, proposedUsd: proposedMicro / 1_000_000, originalMicro, proposedMicro, byModelMicro: {}, status: "correctable" };
    const unresolved = (reason: string) => { row.status = "unresolved"; row.reason ??= reason; };
    if (Number(event.seq) <= priorSeq) throw new Error("accounting evidence must follow original event order");
    const previousSeq = priorSeq;
    priorSeq = Number(event.seq);
    const start = Math.round(record.startUsd * 1_000_000), end = Math.round(record.endUsd * 1_000_000);
    const previousEnd = prior ? Math.round(prior.endUsd * 1_000_000) : null;
    if (end < start) unresolved("cumulative counter decreased without a reset");
    if (record.boundary === "origin" || record.boundary === "reset") {
      if (start !== 0 || conversations.has(record.conversation) || processes.has(record.process)) unresolved("fresh origin/reset does not establish a new zero baseline");
    } else if (!prior || previousEnd !== start ||
        (record.boundary !== "fork" && prior.conversation !== record.conversation) ||
        (record.boundary === "continue" ? prior.process !== record.process : processes.has(record.process)) ||
        (record.boundary === "fork" && conversations.has(record.conversation))) {
      unresolved("resume/fork/process boundary is not established by contiguous checkpoints");
    }
    const beforeModels = cumulativeModels(record, "start"), afterModels = cumulativeModels(record, "end");
    if (Math.round(Object.values(beforeModels).reduce((a, b) => a + b, 0) * 1_000_000) !== start ||
        Math.round(Object.values(afterModels).reduce((a, b) => a + b, 0) * 1_000_000) !== end) unresolved("per-model checkpoints do not cover the complete query tree");
    for (const model of new Set([...Object.keys(beforeModels), ...Object.keys(afterModels)])) {
      const difference = Math.round(((afterModels[model] ?? 0) - (beforeModels[model] ?? 0)) * 1_000_000);
      if (difference < 0) unresolved("per-model counter decreased without a reset");
      if (difference > 0) row.byModelMicro[model] = difference;
    }
    if (!Object.keys(row.byModelMicro).length) row.byModelMicro[record.model] = 0;
    // Preserve a priced-zero provenance for the old token attribution when the verified
    // query-tree cost belongs entirely to other models. Tokens are deliberately not rewritten.
    row.byModelMicro[record.model] ??= 0;
    if (prior && !["origin", "reset"].includes(record.boundary)) {
      const previousModels = cumulativeModels(prior, "end");
      if ([...new Set([...Object.keys(previousModels), ...Object.keys(beforeModels)])].some((model) =>
        Math.round((previousModels[model] ?? 0) * 1_000_000) !== Math.round((beforeModels[model] ?? 0) * 1_000_000))) unresolved("per-model prefix boundary is not established");
    }
    // A missing intervening charge makes the cumulative-prefix claim ambiguous. Non-accounting
    // events are harmless; independently billed usage must be included in the evidence chain.
    if (prior) {
      const gap = sql.prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id=? AND kind='token_usage' AND seq>? AND seq<? AND (json_extract(payload,'$.parentToolUseId') IS NULL OR json_extract(payload,'$.independentUsage')=1)").get(evidence.sessionId, previousSeq, Number(event.seq));
      if (Number(gap?.n) > 0) unresolved("intervening accounting records are missing");
    }
    conversations.add(record.conversation); processes.add(record.process);
    const expectedOriginal = record.boundary === "continue" ? proposedMicro : end;
    if (originalMicro !== expectedOriginal || payload.model !== record.model || payload.parentToolUseId || payload.independentUsage || payload.accountingIncomplete) unresolved("original query-tree/model cost is not established");
    if (payload.costIsEstimate || payload.claudeUsageCheckpoint) unresolved("record already uses the corrected accounting version");
    if (event.runner_seq == null || Number(event.runner_seq) > Number(state?.covered_through_seq)) unresolved("event has no accepted replay coverage");
    if (sql.prepare("SELECT 1 FROM usage_cost_reconciled_events WHERE event_id=?").get(record.eventId)) unresolved("event is already reconciled");
    // Avoid inventing sub-micro attribution discarded by older ledgers. Exact receipts for that
    // precision require a future evidence schema; these records remain visibly unresolved.
    if ([originalUsd, record.startUsd, record.endUsd, ...Object.values(beforeModels), ...Object.values(afterModels)].some((amount) => Math.abs(amount * 1_000_000 - Math.round(amount * 1_000_000)) > 0.000001)) unresolved("sub-micro accounting attribution is unavailable");
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
    if ((db.getRunner(String(session.runner_id))?.protocolVersion ?? 0) < 198) unresolved("runner upgrade is required for revision-aware cost synchronization");
    const model = sql.prepare("SELECT cost_microusd, provider_reported_records FROM usage_session_models WHERE session_id=? AND model=?").get(evidence.sessionId, record.model);
    if (!model || Number(model.cost_microusd) < originalMicro || Number(model.provider_reported_records) < 1) unresolved("per-model ledger lacks the original priced contribution");
    dependencies.push(event, receipt ?? null, model ?? null);
    if (prior && rows[rows.length - 1]?.status === "unresolved" && !["origin", "reset"].includes(record.boundary)) unresolved("previous boundary remains unresolved");
    if (Object.values(row.byModelMicro).reduce((a, b) => a + b, 0) !== proposedMicro) unresolved("per-model delta does not match the query-tree delta");
    rows.push(row); prior = record;
  }
  const originalMicro = rows.reduce((sum, r) => sum + r.originalMicro, 0);
  const proposedMicro = rows.reduce((sum, r) => sum + (r.status === "correctable" ? r.proposedMicro : r.originalMicro), 0);
  const digest = createHash("sha256").update(JSON.stringify({ evidence, rows, dependencies })).digest("hex");
  const remaining = Number(sql.prepare("SELECT COUNT(*) AS n FROM session_events e WHERE session_id=? AND kind='token_usage' AND json_type(payload,'$.costUsd') IN ('real','integer') AND json_extract(payload,'$.costIsEstimate') IS NULL AND json_extract(payload,'$.parentToolUseId') IS NULL AND NOT EXISTS (SELECT 1 FROM usage_cost_reconciled_events r WHERE r.event_id=e.id)").get(evidence.sessionId)?.n ?? 0);
  return { digest, sessionId: evidence.sessionId, originalUsd: originalMicro / 1_000_000, proposedUsd: proposedMicro / 1_000_000,
    sessionOriginalUsd: Number(session.cost_usd), sessionProposedUsd: Number(session.cost_usd) + (proposedMicro - originalMicro) / 1_000_000,
    unresolvedRecords: Math.max(0, remaining - rows.filter((r) => r.status === "correctable").length),
    deltaUsd: (proposedMicro - originalMicro) / 1_000_000, sourceSha256: evidence.sourceSha256,
    runnerEffect: "Revision-aware cumulative cost synchronization; tokens, replay coverage, checkpoint approvals, and existing approval cards are preserved. No automatic resume.", rows };
}

export function previewClaudeReconciliation(db: ControlPlaneDb, principal: HumanPrincipal, input: unknown) {
  const evidence = parseEvidence(input);
  const sql = db.raw();
  sql.exec("BEGIN");
  let preview: ReturnType<typeof plan>;
  try { preview = plan(db, principal, evidence); sql.exec("COMMIT"); }
  catch (error) { sql.exec("ROLLBACK"); throw error; }
  return { ...preview, rows: preview.rows.map(({ originalMicro: _a, proposedMicro: _b, table: _c, attribution: _d, byModelMicro, ...row }) =>
    ({ ...row, proposedByModelUsd: Object.fromEntries(Object.entries(byModelMicro).map(([model, amount]) => [model, amount / 1_000_000])) })) };
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
    const rows = preview.rows.filter((r) => r.status === "correctable");
    if (!rows.length) throw new Error("no provably correctable records");
    let delta = 0;
    for (const row of rows) {
      const change = row.proposedMicro - row.originalMicro;
      delta += change;
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
    const state = sql.prepare("UPDATE usage_session_state SET cost_microusd=cost_microusd+?, provider_reported_records=provider_reported_records-?, model_priced_records=model_priced_records+?, revision=revision+1 WHERE session_id=? AND cost_microusd+?>=0 AND provider_reported_records>=?").run(delta, rows.length, rows.reduce((n, r) => n + Object.keys(r.byModelMicro).length, 0), evidence.sessionId, delta, rows.length);
    if (Number(state.changes) !== 1) throw new Error("session ledger lacks the original contributions");
    db.applyHistoricalCostCorrectionInTransaction(evidence.sessionId, delta);
    const revision = Number(sql.prepare("SELECT COALESCE(MAX(revision),0)+1 AS n FROM usage_cost_reconciliations WHERE session_id=?").get(evidence.sessionId)?.n);
    const result = { applied: true, sessionId: evidence.sessionId, revision, costUsd: db.sessionCostUsd(evidence.sessionId) };
    sql.prepare("INSERT INTO usage_cost_reconciliations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(approvedDigest, principal.organizationId, evidence.sessionId, revision, delta, principal.actorId, evidence.sourceSha256, JSON.stringify(evidence), JSON.stringify(result), Date.now());
    for (const row of rows) sql.prepare("INSERT INTO usage_cost_reconciled_events VALUES (?, ?)").run(row.eventId, approvedDigest);
    sql.exec("COMMIT");
    return result;
  } catch (error) { sql.exec("ROLLBACK"); throw error; }
}

export function reconciliationRevision(db: ControlPlaneDb, sessionId: string): number {
  return Number(db.raw().prepare("SELECT COALESCE(MAX(revision),0) AS n FROM usage_cost_reconciliations WHERE session_id=?").get(sessionId)?.n ?? 0);
}

export function reconciliationDeltaUsd(db: ControlPlaneDb, sessionId: string): number {
  return Number(db.raw().prepare("SELECT COALESCE(SUM(delta_microusd),0) AS delta FROM usage_cost_reconciliations WHERE session_id=?").get(sessionId)?.delta ?? 0) / 1_000_000;
}

/** Old snapshots retain their raw baseline until the runner acknowledges a correction revision. */
export function normalizeReconciledSnapshot(db: ControlPlaneDb, snapshot: SessionSnapshot): SessionSnapshot {
  const revision = reconciliationRevision(db, snapshot.id);
  if (!revision) return snapshot;
  const session = db.getSession(snapshot.id);
  if (session && (db.getRunner(session.runnerId)?.protocolVersion ?? 0) < 198) {
    throw new Error("reconciled costs require a revision-aware runner; upgrade before synchronizing this session");
  }
  const acknowledged = snapshot.costReconciliationRevision ?? 0;
  if (!Number.isSafeInteger(acknowledged) || acknowledged < 0 || acknowledged > revision) throw new Error("invalid cost reconciliation revision");
  const adjustment = Number(db.raw().prepare("SELECT COALESCE(SUM(delta_microusd),0) AS delta FROM usage_cost_reconciliations WHERE session_id=? AND revision>?").get(snapshot.id, acknowledged)?.delta ?? 0);
  return { ...snapshot, costUsd: Math.max(0, (snapshot.costUsd * 1_000_000 + adjustment) / 1_000_000), costReconciliationRevision: revision };
}
