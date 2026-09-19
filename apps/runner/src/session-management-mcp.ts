/** Shared session-management tools for the session-scoped CLI and MCP server. */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  isOrchestratorOnlyCapabilities,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  SESSION_WORKTREE_CREATE_CLIENT_TIMEOUT_MS,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  WORKFLOW_DECISION_CHILD_MESSAGE_MAX_CHARS,
  type UiEvidenceReviewDelivery,
} from "@wollipog/protocol";
import { readImageFileForAttach } from "./session-artifact-file.js";
import { VERSION } from "./version.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Response caps: lists are field-mapped and bounded so a busy manager can't eat the
 * calling session's context window (the MVP mitigation for hundreds of sessions). */
const MAX_ITEMS = 100;
const MAX_LINE = 400;
const DEFAULT_MODEL_PAGE_SIZE = 50;

/** Worker sessions an orchestrator creates may use any interactive/fixed mode EXCEPT
 * bypassPermissions (and codex danger-full-access) — the human still sees the create card. */
const WORKER_PERMISSION_MODES = ["default", "auto", "acceptEdits", "plan", "orchestrator"] as const;

/** Default cap on one CP round-trip. Without it, a half-open connection (the documented
 * box-tunnel blip) would stall an ordinary call for undici's ~300s header/body timeouts. */
const CP_TIMEOUT_MS = 30_000;
const MAX_WAIT_SESSION_INTERVAL_MS = 10_000;

export function nextWaitSessionIntervalMs(currentIntervalMs: number): number {
  return Math.min(MAX_WAIT_SESSION_INTERVAL_MS, Math.ceil(currentIntervalMs * 1.5));
}

/** Minimal structural fetch types so tests can inject a stub without faking Response. */
export interface McpFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type McpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<McpFetchResponse>;

export interface McpDeps {
  fetch: McpFetch;
  /** Control-plane HTTP base (no trailing slash), e.g. http://127.0.0.1:4317. */
  cpUrl: string;
  /** The calling session's OWN id — self-targeting mutations are refused. */
  selfSessionId: string;
  /** Active runner credential; paired with selfSessionId so the control plane authenticates this
   * exact live calling session without treating the credential as a general REST credential. */
  token: string;
  /** Session-scoped calls use the exact-session credential header. Device-token CLI calls omit
   * actorHeader entirely. */
  actorHeader?: typeof WOLLIPOG_AGENT_ACTOR_SESSION_HEADER | null;
  orchestrator?: boolean;
  /** Deterministic scheduling hooks for wait-session tests. */
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Deterministic request budgets for timeout tests. */
  requestTimeoutMs?: number;
  /** Request-scoped MCP cancellation. Never persist or share this controller across calls. */
  signal?: AbortSignal;
  /** A caller that already authenticated `/api/compatibility` may pass the exact proven version
   * so shared handlers do not repeat the same round-trip. */
  controlPlaneProtocolVersion?: number;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** The first block is always text, so text-only consumers (the CLI) never see image bytes. */
export interface ToolResult {
  content: [{ type: "text"; text: string }, ...ToolContent[]];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Json;
  handler: (args: Json, deps: McpDeps) => Promise<ToolResult>;
}

function textResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function capArray(v: unknown, limit = MAX_ITEMS): Json[] {
  return Array.isArray(v) ? v.slice(0, limit) : [];
}

function advertisedStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Project one installation's model catalog without exposing runner-local launch configuration.
 * Per-model effort arrays use the same fallback rule as session creation and the UI: a non-empty
 * model list wins, otherwise the harness list applies, otherwise the model has no effort knob. */
function mapAgentModel(model: Json, harnessEfforts: string[]): Json {
  const modelEfforts = advertisedStrings(model?.efforts);
  const efforts = modelEfforts.length ? modelEfforts : harnessEfforts;
  const effortSource = modelEfforts.length ? "model" : harnessEfforts.length ? "harness" : "none";
  return {
    id: model.id,
    ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}),
    ...(typeof model.default === "boolean" ? { default: model.default } : {}),
    hidden: model.hidden === true,
    ...(typeof model.description === "string" ? { description: model.description } : {}),
    ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
    ...(Array.isArray(model.inputModalities)
      ? { inputModalities: advertisedStrings(model.inputModalities) }
      : {}),
    ...(typeof model.defaultEffort === "string" ? { defaultEffort: model.defaultEffort } : {}),
    efforts,
    effortSource,
    configurableEffort: efforts.length > 0,
  };
}

/** One REST round-trip. A non-2xx reply (or network failure) comes back as a message the
 * handler wraps into an isError tool result — the CP's own error text is preserved verbatim
 * so the model can explain WHY (offline / busy / guardrail-parked). */
async function cpFetch(
  deps: McpDeps,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = deps.requestTimeoutMs ?? CP_TIMEOUT_MS,
): Promise<{ ok: true; data: Json } | { ok: false; message: string; status?: number }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (deps.token) headers["authorization"] = `Bearer ${deps.token}`;
  const actorHeader = deps.actorHeader === undefined ? WOLLIPOG_AGENT_ACTOR_SESSION_HEADER : deps.actorHeader;
  if (actorHeader && deps.selfSessionId) headers[actorHeader] = deps.selfSessionId;
  let res: McpFetchResponse;
  try {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    res = await deps.fetch(`${deps.cpUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Bound the round-trip; the catch below maps the TimeoutError into an isError tool
      // result like any other network failure, so the model can relay "CP unreachable".
      signal: deps.signal ? AbortSignal.any([deps.signal, timeoutSignal]) : timeoutSignal,
    });
  } catch (err) {
    if (deps.signal?.aborted) return { ok: false, message: method === "GET"
      ? "request cancelled"
      : "request cancelled; the control plane may already have applied it — inspect current state before retrying" };
    return { ok: false, message: `control plane request failed: ${(err as Error)?.message ?? String(err)}` };
  }
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    /* body unreadable — fall through with what we have */
  }
  let data: Json = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* non-JSON body (proxy error page etc.) — surface the raw text below */
  }
  if (!res.ok) {
    const detail = typeof data?.error === "string" ? data.error : truncate(raw, MAX_LINE);
    return { ok: false, message: `HTTP ${res.status}: ${detail}`, status: res.status };
  }
  return { ok: true, data };
}

async function cancellableSleep(deps: McpDeps, milliseconds: number): Promise<boolean> {
  const sleep = deps.sleep ?? ((duration: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, duration)));
  const signal = deps.signal;
  if (!signal) {
    await sleep(milliseconds);
    return true;
  }
  if (signal.aborted) return false;
  let onAbort!: () => void;
  const cancelled = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([sleep(milliseconds).then(() => true), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function explicitEffortCompatibilityError(deps: McpDeps): Promise<ToolResult | null> {
  const required = RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControlReasoningEffort;
  if (Number.isInteger(deps.controlPlaneProtocolVersion)) {
    return deps.controlPlaneProtocolVersion! >= required
      ? null
      : errorResult(
          `Reasoning effort selection requires control plane protocol v${required}; connected control plane reports v${deps.controlPlaneProtocolVersion}. Update Wollipog or omit effort to preserve default resolution.`,
        );
  }
  const result = await cpFetch(deps, "GET", "/api/compatibility");
  if (!result.ok) {
    return errorResult(
      `Reasoning effort selection requires control plane protocol v${required}, but compatibility could not be verified: ${result.message}`,
    );
  }
  const actual = result.data?.protocolVersion;
  if (!Number.isInteger(actual) || actual < required) {
    return errorResult(
      `Reasoning effort selection requires control plane protocol v${required}; connected control plane reports v${String(actual ?? "unknown")}. Update Wollipog or omit effort to preserve default resolution.`,
    );
  }
  return null;
}

async function worktreeRetirementCompatibilityError(deps: McpDeps): Promise<ToolResult | null> {
  const required = RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRetirement;
  let actual = deps.controlPlaneProtocolVersion;
  if (!Number.isInteger(actual)) {
    const result = await cpFetch(deps, "GET", "/api/compatibility");
    if (!result.ok) {
      return errorResult(
        `Managed worktree retirement requires control plane protocol v${required}, but compatibility could not be verified: ${result.message}`,
      );
    }
    actual = result.data?.protocolVersion;
  }
  return Number.isInteger(actual) && actual! >= required
    ? null
    : errorResult(
        `Managed worktree retirement requires control plane protocol v${required}; connected control plane reports v${String(actual ?? "unknown")}. Update Wollipog before discarding a runner-owned worktree.`,
      );
}

async function workflowDecisionActionCompatibilityError(deps: McpDeps): Promise<ToolResult | null> {
  const required = RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionActionAdmission;
  let actual = deps.controlPlaneProtocolVersion;
  if (!Number.isInteger(actual)) {
    const result = await cpFetch(deps, "GET", "/api/compatibility");
    if (!result.ok) {
      return errorResult(
        `PR merge action admission requires control plane protocol v${required}, but compatibility could not be verified: ${result.message}`,
      );
    }
    actual = result.data?.protocolVersion;
  }
  return Number.isInteger(actual) && actual! >= required
    ? null
    : errorResult(
        `PR merge action admission requires control plane protocol v${required}; connected control plane reports v${String(actual ?? "unknown")}. Update Wollipog before consuming this approval.`,
      );
}

/** A pre-v166 control plane drops an unknown childMessage and still resolves the decision, so the
 * resolver would believe the child was told. Refuse before the resolution instead. */
async function workflowDecisionChildMessageCompatibilityError(deps: McpDeps): Promise<ToolResult | null> {
  const required = RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionChildMessage;
  let actual = deps.controlPlaneProtocolVersion;
  if (!Number.isInteger(actual)) {
    const result = await cpFetch(deps, "GET", "/api/compatibility");
    if (!result.ok) {
      return errorResult(
        `A child-facing decision message requires control plane protocol v${required}, but compatibility could not be verified: ${result.message}`,
      );
    }
    actual = result.data?.protocolVersion;
  }
  return Number.isInteger(actual) && actual! >= required
    ? null
    : errorResult(
        `A child-facing decision message requires control plane protocol v${required}; connected control plane reports v${String(actual ?? "unknown")}. Resolve without childMessage and send it with prompt_session, or update Wollipog.`,
      );
}

/** An 8 MiB image is about 10.7 MiB of base64. The ordinary RPC deadline would fail a valid upload
 * on a tunnelled or slow link, so an attach gets its own. */
const ARTIFACT_UPLOAD_TIMEOUT_MS = 180_000;

/** A pre-v169 control plane has no session-scoped attach route. Refuse by name instead of letting
 * the upload 404, and never fall back to the base64 tool argument this tool exists to replace. */
async function sessionArtifactFileAttachCompatibilityError(deps: McpDeps): Promise<ToolResult | null> {
  const required = RUNNER_CAPABILITY_MIN_PROTOCOL.sessionArtifactFileAttach;
  let actual = deps.controlPlaneProtocolVersion;
  if (!Number.isInteger(actual)) {
    const result = await cpFetch(deps, "GET", "/api/compatibility");
    if (!result.ok) {
      return errorResult(
        `Attaching a file requires control plane protocol v${required}, but compatibility could not be verified: ${result.message}`,
      );
    }
    actual = result.data?.protocolVersion;
  }
  return Number.isInteger(actual) && actual! >= required
    ? null
    : errorResult(
        `Attaching a file requires control plane protocol v${required}; connected control plane reports v${String(actual ?? "unknown")}. Update the Wollipog control plane, then attach again.`,
      );
}

async function workflowDecisionReconciliationCompatibilityError(deps: McpDeps): Promise<ToolResult | null> {
  const required = RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionActionReconciliation;
  let actual = deps.controlPlaneProtocolVersion;
  if (!Number.isInteger(actual)) {
    const result = await cpFetch(deps, "GET", "/api/compatibility");
    if (!result.ok) {
      return errorResult(
        `PR merge reconciliation requires control plane protocol v${required}, but compatibility could not be verified: ${result.message}`,
      );
    }
    actual = result.data?.protocolVersion;
  }
  return Number.isInteger(actual) && actual! >= required
    ? null
    : errorResult(
        `PR merge reconciliation requires control plane protocol v${required}; connected control plane reports v${String(actual ?? "unknown")}. Update Wollipog before reconciling this approval.`,
      );
}

/** Keep the exact invocation alive while its CP-owned child approval is pending, including
 * run fan-out. Retrying maintains the durable approval's abandonment fence. */
async function createWithSpawnApproval(deps: McpDeps, path: string, body: unknown) {
  let result = await cpFetch(deps, "POST", path, body);
  while (!result.ok && result.status === 428) {
    if (!await cancellableSleep(deps, 1_000)) return { ok: false as const, message: "request cancelled" };
    result = await cpFetch(deps, "POST", path, body);
  }
  return result;
}

async function resolveDescendantRequestTool(
  args: Json,
  deps: McpDeps,
  action: "answer" | "dismiss" | "approve" | "deny",
): Promise<ToolResult> {
  if (!deps.selfSessionId) return errorResult("this tool requires a session identity");
  if (typeof args?.sessionId !== "string" || !args.sessionId ||
      typeof args?.occurrenceId !== "string" || !args.occurrenceId) {
    return errorResult("sessionId and occurrenceId are required");
  }
  let resolution: Json;
  if (action === "answer") {
    if (!args.answers || typeof args.answers !== "object" || Array.isArray(args.answers)) {
      return errorResult("answers must be an object keyed by the exact question ids");
    }
    resolution = { action, answers: args.answers };
  } else if (action === "dismiss") {
    resolution = { action };
  } else {
    if (typeof args.optionId !== "string" || !args.optionId) return errorResult("optionId is required");
    resolution = { action, optionId: args.optionId };
  }
  const r = await cpFetch(
    deps,
    "POST",
    `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/descendant-requests/resolve`,
    { sessionId: args.sessionId, occurrenceId: args.occurrenceId, resolution },
  );
  if (!r.ok) return errorResult(r.message);
  return textResult({ session: mapSession(r.data) });
}

/** Report how the control plane admitted a prompt. A control plane that predates the delivery
 * report says nothing, and that is surfaced as `unknown` rather than guessed: telling the sender
 * "delivered" when the message is in fact parked behind a running turn is the failure this exists
 * to end (issue #1406). */
function promptDelivery(s: Json): Json {
  const report = s?.promptDelivery;
  if (!report || typeof report !== "object") {
    return {
      lane: "unknown",
      detail: "This control plane does not report prompt delivery; the message may be queued behind a running turn.",
    };
  }
  return {
    lane: report.lane ?? "unknown",
    ...(report.admittedFrom ? { admittedFrom: report.admittedFrom } : {}),
    ...(report.detail ? { detail: report.detail } : {}),
  };
}

/** Field-map a SessionView to the compact shape every session-returning tool shares. */
function mapSession(s: Json): Json {
  return {
    id: s?.id,
    title: s?.title,
    status: s?.status,
    runnerId: s?.runnerId,
    workspaceId: s?.workspaceId ?? null,
    agentId: s?.agentId ?? null,
    runId: s?.runId ?? null,
    parentSessionId: s?.parentSessionId ?? null,
    maxChildSessions: s?.maxChildSessions ?? null,
    liveChildCapacity: s?.liveChildCapacity ?? null,
    parentControl: s?.parentControl ?? "off",
    ...(s?.orchestratorPolicy ? { orchestratorPolicy: s.orchestratorPolicy } : {}),
    ...(s?.orchestratorCampaign ? { orchestratorCampaign: s.orchestratorCampaign } : {}),
    costUsd: s?.costUsd,
    costBudgetUsd: s?.costBudgetUsd ?? null,
    costCheckpointsUsd: s?.costCheckpointsUsd ?? null,
    costCheckpointApprovedUsd: s?.costCheckpointApprovedUsd ?? null,
    maxToolCalls: s?.maxToolCalls ?? null,
    toolCallCount: s?.toolCallCount,
    // Title only — the options/requestId belong to the human's card, not the calling session.
    pendingApproval: s?.pendingApproval?.title ?? null,
    updatedAt: s?.updatedAt,
    archived: s?.archived ?? false,
    archiveStatus: s?.archiveStatus,
  };
}

function worktreeTarget(args: Json, deps: McpDeps): string | ToolResult {
  const sessionId = typeof args?.sessionId === "string" && args.sessionId ? args.sessionId : deps.selfSessionId;
  if (!sessionId) return errorResult("sessionId is required");
  // The control plane owns the effective Orchestrator execution policy. It rejects self-targeting
  // for Strict Project Isolation and admits it only for an authenticated non-strict session.
  if (!deps.orchestrator && deps.actorHeader === WOLLIPOG_AGENT_ACTOR_SESSION_HEADER && sessionId !== deps.selfSessionId) {
    return errorResult("refusing: a session credential may manage only its own worktrees");
  }
  return sessionId;
}

function mapWorktreeResult(data: Json): Json {
  const item = data?.worktree;
  return {
    worktree: item == null ? null : {
      id: item.id,
      path: item.path,
      branch: item.branch,
      baseRef: item.baseRef ?? null,
      baseCommit: item.baseCommit ?? null,
      source: item.source,
      pullRequest: item.pullRequest ?? null,
    },
    session: data?.session == null ? null : mapSession(data.session),
    // Attach under platform isolation: null when the runner does not report it. `writableNow:
    // false` means the path is readable but not writable until this session relaunches, which a
    // worktree switch schedules on its own — so the agent waits rather than treating a write
    // denial as a broken attach.
    isolation: data?.isolation == null ? null : {
      writableNow: data.isolation.writableNow === true,
      writableAtNextLaunch: data.isolation.writableAtNextLaunch === true,
    },
    retirement: data?.retirement == null ? null : {
      status: data.retirement.status,
      reason: data.retirement.reason ?? null,
    },
  };
}

/** Render one timeline event as a single capped line: "(seq) kind: text…". */
function renderEventLine(ev: Json): string {
  const p = ev?.payload ?? {};
  const { kind, ...rest } = p;
  const detail =
    typeof p.text === "string" ? p.text
    : typeof p.message === "string" ? p.message
    : typeof p.title === "string" ? p.title
    : JSON.stringify(rest);
  const oneLine = String(detail).replace(/\s+/g, " ").trim();
  return truncate(`(${ev?.seq}) ${kind ?? "event"}: ${oneLine}`, MAX_LINE);
}

function mapWorkflowNode(node: Json, includePrompt = false): Json {
  const prompt = typeof node?.prompt === "string" ? node.prompt : undefined;
  return {
    nodeId: node?.nodeId,
    kind: node?.kind,
    role: node?.role,
    ...(node?.agentId !== undefined ? { agentId: node.agentId } : {}),
    ...(node?.policyId !== undefined ? { policyId: node.policyId } : {}),
    ...(prompt !== undefined
      ? includePrompt
        ? { prompt }
        : { promptPreview: truncate(prompt, MAX_LINE), promptTruncated: prompt.length > MAX_LINE }
      : {}),
    inputs: capArray(node?.inputs, 16),
    outputs: capArray(node?.outputs, 16),
    retry: node?.retry,
    timeoutMs: node?.timeoutMs,
    ...(node?.stopCondition !== undefined ? { stopCondition: node.stopCondition } : {}),
  };
}

function mapWorkflowDefinition(definition: Json, includeGraph = false): Json {
  return {
    workflowId: definition?.workflowId,
    version: definition?.version,
    name: definition?.name,
    description: definition?.description ?? null,
    source: definition?.source,
    maxTransitions: definition?.maxTransitions,
    createdBy: definition?.createdBy,
    createdAt: definition?.createdAt,
    ...(includeGraph
      ? { nodes: capArray(definition?.nodes, 64).map((node) => mapWorkflowNode(node)), edges: capArray(definition?.edges, 256) }
      : { nodes: capArray(definition?.nodes).map((node) => ({ nodeId: node?.nodeId, kind: node?.kind, role: node?.role, agentId: node?.agentId, policyId: node?.policyId })) }),
  };
}

function mapGovernancePolicy(policy: Json): Json {
  return {
    policyId: policy?.policyId,
    name: policy?.name,
    effect: policy?.effect,
    priority: policy?.priority,
    enabled: policy?.enabled,
    scope: policy?.scope,
    conditions: policy?.conditions ?? null,
    askTimeout: policy?.askTimeout ?? null,
    builtin: policy?.builtin ?? false,
    createdAt: policy?.createdAt,
    updatedAt: policy?.updatedAt,
  };
}

function mapWorkflowInstance(instance: Json, includeDetail = false): Json {
  return {
    instanceId: instance?.instanceId,
    workflowId: instance?.workflowId,
    workflowVersion: instance?.workflowVersion,
    runId: instance?.runId,
    status: instance?.status,
    transitionCount: instance?.transitionCount,
    nodeStates: capArray(instance?.nodeStates),
    createdBy: instance?.createdBy,
    createdAt: instance?.createdAt,
    updatedAt: instance?.updatedAt,
    completedAt: instance?.completedAt ?? null,
    ...(includeDetail
      ? {
          definition: mapWorkflowDefinition(instance?.definition, true),
          attempts: capArray(instance?.attempts),
          events: capArray(instance?.events),
          attemptsTruncated: instance?.attemptsTruncated ?? false,
          eventsTruncated: instance?.eventsTruncated ?? false,
        }
      : {}),
  };
}

const WORKFLOW_SPEC_PROPERTIES: Json = {
  name: { type: "string" },
  description: { type: "string" },
  maxTransitions: { type: "integer", minimum: 1, maximum: 1000 },
  nodes: { type: "array", minItems: 1, maxItems: 64, items: { type: "object" } },
  edges: { type: "array", maxItems: 256, items: { type: "object" } },
};

const GOVERNANCE_POLICY_PROPERTIES: Json = {
  policyId: { type: "string" },
  name: { type: "string" },
  effect: { type: "string", enum: ["allow", "deny", "ask"] },
  priority: { type: "integer", minimum: -100000, maximum: 100000 },
  enabled: { type: "boolean" },
  askTimeout: { type: "integer", minimum: 1, maximum: 2_000_000 },
  scope: {
    type: "object",
    minProperties: 1,
    properties: Object.fromEntries(
      ["organizationId", "runnerId", "workspaceId", "agentId", "toolName", "path", "network", "branch"]
        .map((key) => [key, { type: "string" }]),
    ),
    additionalProperties: false,
  },
  conditions: {
    type: "object",
    properties: {
      statuses: {
        type: "array",
        minItems: 1,
        items: { type: "string", enum: ["queued", "starting", "running", "input_required", "idle", "completed", "failed", "stopped"] },
      },
      minCostUsd: { type: "number", minimum: 0 },
      maxCostUsd: { type: "number", minimum: 0 },
      minToolCalls: { type: "integer", minimum: 0 },
      maxToolCalls: { type: "integer", minimum: 0 },
      escalated: { type: "boolean" },
    },
    additionalProperties: false,
  },
};

const WORKFLOW_DECISION_RESOURCE_SCHEMA: Json = {
  oneOf: [
    {
      type: "object",
      properties: {
        category: { const: "implementation_question" },
        question: { type: "string" },
        options: { type: "array", minItems: 2, maxItems: 12, items: {
          type: "object",
          properties: { optionId: { type: "string" }, label: { type: "string" }, description: { type: "string" } },
          required: ["optionId", "label"], additionalProperties: false,
        } },
        recommendedOptionId: { type: "string" },
      },
      required: ["category", "question", "options"], additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        category: { const: "pr_merge" }, repository: { type: "string" }, pullRequest: { type: "integer", minimum: 1 },
        headSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
        reviewResult: { type: "string", enum: ["merge", "merge_with_acknowledged_risk"] },
        requiredChecks: { type: "object", properties: {
          headSha: { type: "string", pattern: "^[0-9a-f]{40}$" }, status: { const: "passed" },
          checkedAt: { type: "integer", minimum: 1 },
          checks: { type: "array", minItems: 1, items: { type: "object", properties: {
            name: { type: "string" }, state: { const: "passed" }, url: { type: "string" },
          }, required: ["name", "state"], additionalProperties: false } },
        }, required: ["headSha", "status", "checkedAt", "checks"], additionalProperties: false },
      },
      required: ["category", "repository", "pullRequest", "headSha", "reviewResult", "requiredChecks"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        category: { const: "merged_branch_deletion" }, repository: { type: "string" }, branch: { type: "string" },
        merged: { const: true }, mergeCommitSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
        dependentPullRequests: { type: "object", properties: {
          checkedAt: { type: "integer", minimum: 1 }, open: { type: "array", maxItems: 0 },
        }, required: ["checkedAt", "open"], additionalProperties: false },
      },
      required: ["category", "repository", "branch", "merged", "mergeCommitSha", "dependentPullRequests"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        category: { const: "follow_up_issue_publication" }, repository: { type: "string" },
        sanitizedTitle: { type: "string" }, sanitizedBody: { type: "string" },
        labels: { type: "array", maxItems: 32, items: { type: "string" } },
      },
      required: ["category", "repository", "sanitizedTitle", "sanitizedBody", "labels"], additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        category: { const: "ui_evidence_approval" },
        evidence: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", properties: {
          evidenceId: { type: "string" }, uri: { type: "string" },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          artifactId: { type: "string", description: "Screenshot Session artifact of this session holding the exact bytes. Required for an Orchestrator to review the item; without it the decision goes to a human." },
          mediaType: { type: "string", description: "Exact media type of the artifact, such as image/png. Video and unknown types go to a human." },
        }, required: ["evidenceId", "uri", "sha256"], additionalProperties: false } },
      },
      required: ["category", "evidence"], additionalProperties: false,
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Tool table (tool ids as claude sees them: mcp__manager__<name>)             */
/* -------------------------------------------------------------------------- */

const ORCHESTRATOR_TOOLS = new Set(["list_runners", "get_agent_capabilities", "list_sessions", "get_session", "get_session_events",
  "get_campaign", "record_campaign_follow_up", "verify_campaign_child",
  "list_descendant_requests", "answer_descendant_question", "dismiss_descendant_question", "resolve_descendant_approval",
  "resolve_descendant_workflow_decision", "review_descendant_ui_evidence", "request_workflow_decision", "get_workflow_decision", "consume_workflow_decision",
  "reconcile_workflow_decision",
  "wait_session", "list_governance_policies", "get_governance_policy", "create_session", "prompt_session",
  "stop_session", "restart_session", "archive_session", "set_guardrails", "create_worktree", "attach_worktree",
  "select_worktree", "discard_worktree"]);
const PARENT_CONTROL_TOOLS = new Set([
  "get_campaign", "record_campaign_follow_up", "verify_campaign_child",
  "list_descendant_requests", "answer_descendant_question", "dismiss_descendant_question",
  "resolve_descendant_approval", "resolve_descendant_workflow_decision", "review_descendant_ui_evidence",
]);

export const TOOLS: McpTool[] = [
  /* ------------------------------- READS --------------------------------- */
  {
    name: "list_runners",
    description: "List runner machines with their agents and workspaces (source of runnerId/agentId/workspaceId). Use get_agent_capabilities before choosing a child model or effort.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, deps) => {
      const r = await cpFetch(deps, "GET", "/api/runners");
      if (!r.ok) return errorResult(r.message);
      const runners = capArray(r.data?.runners).map((run) => ({
        runnerId: run?.runnerId,
        hostname: run?.hostname,
        os: run?.os,
        status: run?.status,
        agents: capArray(run?.agents).map((a) => ({
          id: a?.id,
          name: a?.name,
          driver: a?.driver ?? "acp",
          context: a?.context ?? { kind: "native" },
          available: a?.available ?? null,
          authStatus: a?.authStatus ?? null,
        })),
        workspaces: capArray(run?.workspaces).map((w) => ({ id: w?.id, name: w?.name, path: w?.path })),
      }));
      return textResult({ runners });
    },
  },
  {
    name: "get_agent_capabilities",
    description:
      "Read the advertised model and reasoning-effort capabilities for one visible runner and agent installation without launching a child. Hidden models are excluded by default; exact modelId lookup remains available for persisted hidden selections. Results are bounded and creation revalidates every selected pair.",
    inputSchema: {
      type: "object",
      properties: {
        runnerId: { type: "string" },
        agentId: { type: "string" },
        offset: { type: "integer", minimum: 0, description: "Zero-based model offset; defaults to 0" },
        limit: { type: "integer", minimum: 1, maximum: MAX_ITEMS, description: `Models per page; defaults to ${DEFAULT_MODEL_PAGE_SIZE}` },
        includeHidden: { type: "boolean", description: "Include hidden models in paginated results" },
        modelId: { type: "string", description: "Return one exact model, including a hidden persisted model" },
      },
      required: ["runnerId", "agentId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.runnerId !== "string" || !args.runnerId ||
          typeof args?.agentId !== "string" || !args.agentId) {
        return errorResult("runnerId and agentId are required");
      }
      if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) {
        return errorResult("offset must be a non-negative integer");
      }
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_ITEMS)) {
        return errorResult(`limit must be an integer from 1 to ${MAX_ITEMS}`);
      }
      if (args.modelId !== undefined && (typeof args.modelId !== "string" || !args.modelId)) {
        return errorResult("modelId must be a non-empty string");
      }
      if (args.modelId !== undefined &&
          (args.offset !== undefined || args.limit !== undefined || args.includeHidden === true)) {
        return errorResult("modelId cannot be combined with offset, limit, or includeHidden");
      }
      const r = await cpFetch(deps, "GET", "/api/runners");
      if (!r.ok) return errorResult(r.message);
      // This is a targeted lookup, so search the complete authorized response before bounding the
      // model projection. Applying list_runners' display cap here would make later installations
      // unreachable even when the caller already knows their exact ids.
      const runners = Array.isArray(r.data?.runners) ? r.data.runners : [];
      const runner = runners.find((candidate: Json) => candidate?.runnerId === args.runnerId);
      const agents = Array.isArray(runner?.agents) ? runner.agents : [];
      const agent = agents.find((candidate: Json) => candidate?.id === args.agentId);
      if (!runner || !agent) return errorResult("runner or agent installation not found or not visible to this session");

      const capabilities = agent.capabilities;
      const agentView = {
        runnerId: runner.runnerId,
        agentId: agent.id,
        name: agent.name,
        driver: agent.driver ?? "acp",
        context: agent.context ?? { kind: "native" },
        available: agent.available ?? null,
        authStatus: agent.authStatus ?? null,
      };
      const discoveryUnavailable = !capabilities || typeof capabilities !== "object" ||
        isOrchestratorOnlyCapabilities(capabilities);
      if (discoveryUnavailable) {
        return textResult({
          agent: agentView,
          discovery: {
            status: "unavailable",
            reason: capabilities && typeof capabilities === "object" ? "session_negotiated" : "not_advertised",
            modelSource: null,
          },
          harnessEfforts: [],
          models: [],
          page: { offset: 0, limit: args.limit ?? DEFAULT_MODEL_PAGE_SIZE, returned: 0, total: 0, nextOffset: null, truncated: false },
        });
      }

      const harnessEfforts = advertisedStrings(capabilities.effortLevels);
      const allModels = Array.isArray(capabilities.models)
        ? capabilities.models.filter((model: Json) => typeof model?.id === "string" && model.id)
        : [];
      const modelId = typeof args.modelId === "string" ? args.modelId : undefined;
      if (modelId) {
        const model = allModels.find((candidate: Json) => candidate.id === modelId);
        if (!model) return errorResult("modelId is not advertised by the selected runner and agent installation");
        return textResult({
          agent: agentView,
          discovery: { status: "available", modelSource: capabilities.modelSource ?? null },
          harnessEfforts,
          models: [mapAgentModel(model, harnessEfforts)],
          page: { offset: 0, limit: 1, returned: 1, total: 1, nextOffset: null, truncated: false, targeted: true },
        });
      }

      const includeHidden = args.includeHidden === true;
      const visibleModels = includeHidden ? allModels : allModels.filter((model: Json) => model.hidden !== true);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? DEFAULT_MODEL_PAGE_SIZE;
      const models = visibleModels.slice(offset, offset + limit).map((model: Json) => mapAgentModel(model, harnessEfforts));
      const nextOffset = offset + models.length < visibleModels.length ? offset + models.length : null;
      return textResult({
        agent: agentView,
        discovery: { status: "available", modelSource: capabilities.modelSource ?? null },
        harnessEfforts,
        models,
        hiddenModelsExcluded: includeHidden ? 0 : allModels.length - visibleModels.length,
        page: {
          offset,
          limit,
          returned: models.length,
          total: visibleModels.length,
          nextOffset,
          truncated: nextOffset !== null,
        },
      });
    },
  },
  {
    name: "list_sessions",
    description: "List sessions with status, title, guardrails, live-child capacity, and any pending approval.",
    inputSchema: {
      type: "object",
      properties: { archived: { type: "boolean", description: "Include archived sessions" } },
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      const r = await cpFetch(deps, "GET", `/api/sessions${args?.archived === true ? "?archived=true" : ""}`);
      if (!r.ok) return errorResult(r.message);
      return textResult({ sessions: capArray(r.data?.sessions).map(mapSession) });
    },
  },
  {
    name: "get_session",
    description: "Get one session's full metadata by id.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.sessionId !== "string" || !args.sessionId) return errorResult("sessionId is required");
      const r = await cpFetch(deps, "GET", `/api/sessions/${encodeURIComponent(args.sessionId)}`);
      if (!r.ok) return errorResult(r.message);
      const s = r.data?.session;
      // Funnel through mapSession like every other session-returning tool — the raw view
      // carries pendingApproval.requestId + options (the credential a tool could one day
      // replay against /approve) and an uncapped preview. "Full metadata" means the
      // whitelisted extras below, not the wire-verbatim row.
      return textResult({
        session:
          s == null
            ? null
            : {
                ...mapSession(s),
                workspaceName: s.workspaceName ?? null,
                agentName: s.agentName ?? null,
                driver: s.driver,
                model: s.model ?? null,
                effort: s.effort ?? null,
                permissionMode: s.permissionMode ?? null,
                useWorktree: s.useWorktree ?? false,
                worktreePath: s.worktreePath ?? null,
                createdAt: s.createdAt,
                lastEventAt: s.lastEventAt ?? null,
                messageCount: s.messageCount,
                tokensIn: s.tokensIn,
                tokensOut: s.tokensOut,
                preview: typeof s.preview === "string" ? truncate(s.preview, MAX_LINE) : null,
              },
      });
    },
  },
  {
    name: "get_campaign",
    description: "Read this Orchestrator's effective campaign behavior, current typed-decision owners and policy revision, applicable limits, follow-up counts, child completion state, and credential-free compatibility information.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, deps) => {
      if (!deps.selfSessionId || !deps.orchestrator) return errorResult("this tool requires an Orchestrator session identity");
      const r = await cpFetch(
        deps,
        "GET",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/orchestrator-campaign`,
      );
      return r.ok ? textResult({ campaign: r.data }) : errorResult(r.message);
    },
  },
  {
    name: "record_campaign_follow_up",
    description: "Record and deduplicate one child recommendation before any follow-up execution. The disposition either stops or says typed gates are still required; it never grants blanket execution approval.",
    inputSchema: {
      type: "object",
      properties: {
        originSessionId: { type: "string" },
        repository: { type: "string" },
        title: { type: "string" },
        recommendationKey: { type: "string" },
      },
      required: ["originSessionId", "repository", "title"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (!deps.selfSessionId || !deps.orchestrator) return errorResult("this tool requires an Orchestrator session identity");
      const r = await cpFetch(
        deps,
        "POST",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/orchestrator-campaign/follow-ups`,
        {
          originSessionId: args?.originSessionId,
          repository: args?.repository,
          title: args?.title,
          ...(typeof args?.recommendationKey === "string" ? { recommendationKey: args.recommendationKey } : {}),
        },
      );
      return r.ok ? textResult({ followUp: r.data }) : errorResult(r.message);
    },
  },
  {
    name: "verify_campaign_child",
    description: "Verify one campaign child's exact completed report after all reported follow-ups are recorded. Retain leaves it inspectable; Stop and Archive starts the existing durable stop/archive lifecycle. Campaign status becomes verified complete only after required worktree cleanup is also observed.",
    inputSchema: {
      type: "object",
      properties: {
        childSessionId: { type: "string" },
        reportEventSeq: { type: "integer", minimum: 1 },
        followUpsAccounted: { const: true },
      },
      required: ["childSessionId", "reportEventSeq", "followUpsAccounted"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (!deps.selfSessionId || !deps.orchestrator) return errorResult("this tool requires an Orchestrator session identity");
      const r = await cpFetch(
        deps,
        "POST",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/orchestrator-campaign/verify-child`,
        {
          childSessionId: args?.childSessionId,
          reportEventSeq: args?.reportEventSeq,
          followUpsAccounted: args?.followUpsAccounted,
        },
      );
      return r.ok ? textResult(r.data) : errorResult(r.message);
    },
  },
  {
    name: "list_descendant_requests",
    description: "List exact unresolved descendant questions and approvals currently assigned to this Orchestrator. Human-owned requests remain visible only in the parent campaign UI.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, deps) => {
      if (!deps.selfSessionId) return errorResult("this tool requires a session identity");
      const r = await cpFetch(
        deps,
        "GET",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/descendant-requests`,
      );
      if (!r.ok) return errorResult(r.message);
      const requests = Array.isArray(r.data?.requests) ? r.data.requests : [];
      const limit = 128;
      return textResult({
        requests: requests.slice(0, limit),
        truncated: requests.length > limit,
        limit,
      });
    },
  },
  {
    name: "answer_descendant_question",
    description: "Answer one exact descendant structured-question occurrence. Parent Control must allow Questions.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        occurrenceId: { type: "string" },
        answers: { type: "object", additionalProperties: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } },
      },
      required: ["sessionId", "occurrenceId", "answers"],
      additionalProperties: false,
    },
    handler: async (args, deps) => resolveDescendantRequestTool(args, deps, "answer"),
  },
  {
    name: "dismiss_descendant_question",
    description: "Dismiss one exact descendant structured-question occurrence. Parent Control must allow Questions.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, occurrenceId: { type: "string" } },
      required: ["sessionId", "occurrenceId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => resolveDescendantRequestTool(args, deps, "dismiss"),
  },
  {
    name: "resolve_descendant_approval",
    description: "Approve or deny one exact eligible descendant approval occurrence. Parent Control must allow Questions and Approvals.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        occurrenceId: { type: "string" },
        decision: { type: "string", enum: ["approve", "deny"] },
        optionId: { type: "string", description: "Exact allow-once or reject-once option id from list_descendant_requests" },
      },
      required: ["sessionId", "occurrenceId", "decision", "optionId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      const decision = args?.decision;
      if (decision !== "approve" && decision !== "deny") return errorResult("decision must be approve or deny");
      return resolveDescendantRequestTool(args, deps, decision);
    },
  },
  {
    name: "resolve_descendant_workflow_decision",
    description: "Resolve one exact typed descendant workflow decision. The server rechecks category authority, controlling ancestry, audience, policy revision, and evidence coverage.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        occurrenceId: { type: "string" },
        outcome: { type: "string", enum: ["approve", "deny"] },
        selectedOptionId: { type: "string", description: "Required approved option for implementation questions only" },
        evidenceReviewed: { type: "array", items: { type: "string" }, description: "Every evidence id actually inspected; required for UI evidence approval" },
        rationale: { type: "string", description: "Audit-only: never retained or shown to the child; only its digest is recorded" },
        childMessage: {
          type: "string",
          minLength: 1,
          maxLength: WORKFLOW_DECISION_CHILD_MESSAGE_MAX_CHARS,
          description: "Optional message for the child: shown in its get_workflow_decision view and delivered as the prompt that resumes it. Say what to change after a denial.",
        },
      },
      required: ["sessionId", "occurrenceId", "outcome"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (!deps.selfSessionId) return errorResult("this tool requires a session identity");
      if (typeof args?.sessionId !== "string" || !args.sessionId ||
          typeof args?.occurrenceId !== "string" || !args.occurrenceId ||
          (args?.outcome !== "approve" && args?.outcome !== "deny")) {
        return errorResult("sessionId, occurrenceId, and an approve or deny outcome are required");
      }
      if (args?.childMessage !== undefined) {
        if (typeof args.childMessage !== "string") return errorResult("childMessage must be a string");
        const compatibilityError = await workflowDecisionChildMessageCompatibilityError(deps);
        if (compatibilityError) return compatibilityError;
      }
      const r = await cpFetch(
        deps,
        "POST",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/descendant-requests/resolve`,
        {
          sessionId: args.sessionId,
          occurrenceId: args.occurrenceId,
          resolution: {
            action: "resolve_workflow_decision",
            outcome: args.outcome,
            ...(typeof args.selectedOptionId === "string" ? { selectedOptionId: args.selectedOptionId } : {}),
            ...(Array.isArray(args.evidenceReviewed) ? { evidenceReviewed: args.evidenceReviewed } : {}),
            ...(typeof args.rationale === "string" ? { rationale: args.rationale } : {}),
            ...(typeof args.childMessage === "string" ? { childMessage: args.childMessage } : {}),
          },
        },
      );
      return r.ok ? textResult({ decision: r.data }) : errorResult(r.message);
    },
  },
  {
    name: "review_descendant_ui_evidence",
    description: "Inspect one evidence image of an exact pending descendant ui_evidence_approval decision that this Orchestrator owns. Returns the digest-verified image and makes the server record a review receipt. Approval requires a current receipt for every evidence item, so call this once per evidenceId, actually look at each image, and only then resolve the decision.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        occurrenceId: { type: "string" },
        evidenceId: { type: "string" },
      },
      required: ["sessionId", "occurrenceId", "evidenceId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (!deps.selfSessionId) return errorResult("this tool requires a session identity");
      if (typeof args?.sessionId !== "string" || !args.sessionId ||
          typeof args?.occurrenceId !== "string" || !args.occurrenceId ||
          typeof args?.evidenceId !== "string" || !args.evidenceId) {
        return errorResult("sessionId, occurrenceId, and evidenceId are required");
      }
      const r = await cpFetch(
        deps,
        "POST",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/descendant-requests/review-ui-evidence`,
        { sessionId: args.sessionId, occurrenceId: args.occurrenceId, evidenceId: args.evidenceId },
      );
      if (!r.ok) return errorResult(r.message);
      const delivery = r.data as UiEvidenceReviewDelivery;
      // Recompute the digest over the bytes this process is about to hand to the model. The
      // receipt names what the server sent; this proves the same bytes arrived.
      const bytes = Buffer.from(delivery.data, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== delivery.receipt.sha256 ||
          bytes.byteLength !== delivery.sizeBytes) {
        return errorResult("delivered evidence does not match the digest bound to this workflow decision; do not approve it");
      }
      // The receipt counts only once this runner confirms the verified handoff. If that fails the
      // image is withheld too, so the model never holds evidence without a receipt or the reverse.
      const acknowledged = await cpFetch(
        deps,
        "POST",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/descendant-requests/review-ui-evidence/acknowledge`,
        { receiptId: delivery.receipt.receiptId, sha256: delivery.receipt.sha256 },
      );
      if (!acknowledged.ok) return errorResult(`evidence review could not be recorded: ${acknowledged.message}`);
      return {
        content: [
          { type: "text", text: JSON.stringify({ receipt: delivery.receipt, mimeType: delivery.mimeType, sizeBytes: delivery.sizeBytes }) },
          { type: "image", data: delivery.data, mimeType: delivery.mimeType },
        ],
      };
    },
  },
  {
    name: "request_workflow_decision",
    description: "Create an explicit typed workflow gate bound to this session, its controlling Orchestrator, the current human-owned policy revision, and an exact resource snapshot. Generic questions and approvals cannot satisfy this gate.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Caller-owned idempotency key" },
        resourceKey: { type: "string", description: "Stable action target; a new occurrence supersedes older unconsumed occurrences" },
        resourceSnapshot: WORKFLOW_DECISION_RESOURCE_SCHEMA,
      },
      required: ["requestId", "resourceKey", "resourceSnapshot"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (!deps.selfSessionId) return errorResult("this tool requires a session identity");
      const r = await cpFetch(
        deps,
        "POST",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/workflow-decisions`,
        { requestId: args?.requestId, resourceKey: args?.resourceKey, resourceSnapshot: args?.resourceSnapshot },
      );
      return r.ok ? textResult({ decision: r.data }) : errorResult(r.message);
    },
  },
  {
    name: "get_workflow_decision",
    description: "Read the authoritative state of one exact workflow decision occurrence.",
    inputSchema: {
      type: "object",
      properties: { occurrenceId: { type: "string" } },
      required: ["occurrenceId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (!deps.selfSessionId || typeof args?.occurrenceId !== "string" || !args.occurrenceId) {
        return errorResult("occurrenceId and a session identity are required");
      }
      const r = await cpFetch(
        deps,
        "GET",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/workflow-decisions/${encodeURIComponent(args.occurrenceId)}`,
      );
      return r.ok ? textResult({ decision: r.data }) : errorResult(r.message);
    },
  },
  {
    name: "consume_workflow_decision",
    description: "Immediately before the approved external action begins, consume its one-shot authorization using the exact current resource snapshot. PR merge approvals instead arm one canonical enqueue command pinned with --match-head-commit and are consumed when its matching runner permission is delivered, or, when no permission prompt occurs (Claude Code in auto or Full Access), by reconcile_workflow_decision after the PR reads MERGED. Revoked, changed, replayed, stale, or superseded grants fail closed.",
    inputSchema: {
      type: "object",
      properties: {
        occurrenceId: { type: "string" },
        resourceSnapshot: WORKFLOW_DECISION_RESOURCE_SCHEMA,
        action: {
          type: "object",
          properties: {
            kind: { const: "pr_merge_enqueue" },
            command: { type: "string", minLength: 1, maxLength: 2000 },
          },
          required: ["kind", "command"],
          additionalProperties: false,
        },
      },
      required: ["occurrenceId", "resourceSnapshot"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (!deps.selfSessionId || typeof args?.occurrenceId !== "string" || !args.occurrenceId) {
        return errorResult("occurrenceId and a session identity are required");
      }
      if (args?.resourceSnapshot?.category === "pr_merge") {
        if (args?.action?.kind !== "pr_merge_enqueue" || typeof args.action.command !== "string") {
          return errorResult("PR merge decisions require an exact pr_merge_enqueue action");
        }
        const compatibilityError = await workflowDecisionActionCompatibilityError(deps);
        if (compatibilityError) return compatibilityError;
      }
      const r = await cpFetch(
        deps,
        "POST",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/workflow-decisions/${encodeURIComponent(args.occurrenceId)}/consume`,
        { resourceSnapshot: args?.resourceSnapshot, ...(args?.action ? { action: args.action } : {}) },
      );
      return r.ok ? textResult({ decision: r.data }) : errorResult(r.message);
    },
  },
  {
    name: "reconcile_workflow_decision",
    description: "Reconcile an already-successful canonical PR merge action without executing it again. For a Codex App Server child the runner must prove one exact successful provider-history command and the forge must report the approved head as merged. A Claude Code child produces no command receipt, so call this once the PR reads MERGED; the forge's merged approved head is its proof. Stale, mismatched, replayed, unavailable, and mixed-version evidence fails closed.",
    inputSchema: {
      type: "object",
      properties: {
        occurrenceId: { type: "string" },
        resourceSnapshot: WORKFLOW_DECISION_RESOURCE_SCHEMA,
      },
      required: ["occurrenceId", "resourceSnapshot"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (!deps.selfSessionId || typeof args?.occurrenceId !== "string" || !args.occurrenceId) {
        return errorResult("occurrenceId and a session identity are required");
      }
      if (args?.resourceSnapshot?.category !== "pr_merge") {
        return errorResult("only PR merge decisions support action reconciliation");
      }
      const compatibilityError = await workflowDecisionReconciliationCompatibilityError(deps);
      if (compatibilityError) return compatibilityError;
      const r = await cpFetch(
        deps,
        "POST",
        `/api/sessions/${encodeURIComponent(deps.selfSessionId)}/workflow-decisions/${encodeURIComponent(args.occurrenceId)}/reconcile`,
        { resourceSnapshot: args.resourceSnapshot },
      );
      return r.ok ? textResult({ decision: r.data }) : errorResult(r.message);
    },
  },
  {
    name: "get_session_events",
    description: "Read a session's recent timeline events (tail; use after/limit to page).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        after: { type: "number", description: "Only events with seq greater than this" },
        limit: { type: "number", minimum: 1, maximum: 100, description: "Max events, default 30" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.sessionId !== "string" || !args.sessionId) return errorResult("sessionId is required");
      const after = typeof args.after === "number" && args.after > 0 ? Math.floor(args.after) : 0;
      const limit = Math.min(100, Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : 30));
      const r = await cpFetch(deps, "GET", `/api/sessions/${encodeURIComponent(args.sessionId)}/events?after=${after}`);
      if (!r.ok) return errorResult(r.message);
      const events: Json[] = Array.isArray(r.data?.events) ? r.data.events : [];
      // The tail is what matters ("what just happened?"); lastSeq feeds the next page's `after`.
      const tail = events.slice(-limit);
      const last = events[events.length - 1];
      return textResult({
        lines: tail.map(renderEventLine),
        lastSeq: typeof last?.seq === "number" ? last.seq : after,
      });
    },
  },
  {
    name: "wait_session",
    description: "Wait until a session reaches one of the requested states, then return its metadata.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        states: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: ["queued", "starting", "running", "input_required", "idle", "completed", "failed", "stopped"] },
        },
        timeoutMs: { type: "integer", minimum: 1, maximum: 3_600_000 },
        intervalMs: {
          type: "integer",
          minimum: 50,
          maximum: MAX_WAIT_SESSION_INTERVAL_MS,
          description: "Initial polling interval; successful nonterminal reads back off to 10 seconds.",
        },
      },
      required: ["sessionId", "states"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.sessionId !== "string" || !args.sessionId) return errorResult("sessionId is required");
      if (!Array.isArray(args.states) || args.states.length === 0 ||
          args.states.some((state: unknown) => typeof state !== "string")) {
        return errorResult("states must be a non-empty array of session states");
      }
      const wanted = new Set<string>(args.states);
      const timeoutMs = Math.min(3_600_000, Math.max(1, Number.isFinite(args.timeoutMs) ? Math.floor(args.timeoutMs) : 60_000));
      let intervalMs = Math.min(MAX_WAIT_SESSION_INTERVAL_MS,
        Math.max(50, Number.isFinite(args.intervalMs) ? Math.floor(args.intervalMs) : 500));
      const now = deps.now ?? Date.now;
      const deadline = now() + timeoutMs;
      do {
        const r = await cpFetch(deps, "GET", `/api/sessions/${encodeURIComponent(args.sessionId)}`);
        if (!r.ok) return errorResult(r.message);
        const session = r.data?.session;
        if (typeof session?.status === "string" && wanted.has(session.status)) {
          return textResult({ session: mapSession(session), reached: session.status });
        }
        const remaining = deadline - now();
        if (remaining <= 0) break;
        if (!await cancellableSleep(deps, Math.min(intervalMs, remaining))) {
          return errorResult("request cancelled");
        }
        intervalMs = nextWaitSessionIntervalMs(intervalMs);
      } while (now() <= deadline);
      return errorResult(`timed out waiting for session ${args.sessionId} to reach ${[...wanted].join(", ")}`);
    },
  },
  {
    name: "list_runs",
    description: "List multi-agent runs and their member session ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, deps) => {
      const r = await cpFetch(deps, "GET", "/api/runs");
      if (!r.ok) return errorResult(r.message);
      const runs = capArray(r.data?.runs).map((run) => ({
        id: run?.id,
        title: run?.title,
        prompt: truncate(String(run?.prompt ?? ""), MAX_LINE),
        workspaceId: run?.workspaceId ?? null,
        sessionIds: capArray(run?.sessionIds),
        createdAt: run?.createdAt,
        updatedAt: run?.updatedAt,
      }));
      return textResult({ runs });
    },
  },
  {
    name: "list_governance_policies",
    description: "List stored and built-in governance policies with their exact scopes and conditions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, deps) => {
      const r = await cpFetch(deps, "GET", "/api/governance/policies");
      if (!r.ok) return errorResult(r.message);
      const policies = Array.isArray(r.data?.policies) ? r.data.policies : [];
      return textResult({
        policies: capArray(policies).map(mapGovernancePolicy),
        truncated: policies.length > MAX_ITEMS,
      });
    },
  },
  {
    name: "get_governance_policy",
    description: "Inspect one governance policy by its exact id.",
    inputSchema: {
      type: "object",
      properties: { policyId: { type: "string" } },
      required: ["policyId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.policyId !== "string" || !args.policyId) return errorResult("policyId is required");
      const r = await cpFetch(deps, "GET", "/api/governance/policies");
      if (!r.ok) return errorResult(r.message);
      const policies = Array.isArray(r.data?.policies) ? r.data.policies : [];
      const policy = policies.find((candidate: Json) => candidate?.policyId === args.policyId);
      if (!policy) return errorResult(`governance policy '${args.policyId}' was not found`);
      return textResult({ policy: mapGovernancePolicy(policy) });
    },
  },
  {
    name: "list_workflows",
    description: "List the latest immutable workflow definitions and their graph roles.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      const limit = Math.min(100, Math.max(1, typeof args?.limit === "number" ? Math.floor(args.limit) : 100));
      const r = await cpFetch(deps, "GET", `/api/workflows?limit=${limit}`);
      if (!r.ok) return errorResult(r.message);
      return textResult({ workflows: capArray(r.data).map((definition) => mapWorkflowDefinition(definition)) });
    },
  },
  {
    name: "get_workflow",
    description: "Inspect one workflow definition with exact topology and contracts plus bounded prompt previews.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string" }, version: { type: "integer", minimum: 1 } },
      required: ["workflowId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.workflowId !== "string" || !args.workflowId) return errorResult("workflowId is required");
      const query = typeof args.version === "number" ? `?version=${Math.floor(args.version)}` : "";
      const r = await cpFetch(deps, "GET", `/api/workflows/${encodeURIComponent(args.workflowId)}${query}`);
      if (!r.ok) return errorResult(r.message);
      return textResult({ workflow: mapWorkflowDefinition(r.data, true) });
    },
  },
  {
    name: "get_workflow_node",
    description: "Inspect one exact workflow node, including its complete validated prompt and artifact contracts.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string" },
        version: { type: "integer", minimum: 1 },
        nodeId: { type: "string" },
      },
      required: ["workflowId", "nodeId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.workflowId !== "string" || !args.workflowId || typeof args?.nodeId !== "string" || !args.nodeId) {
        return errorResult("workflowId and nodeId are required");
      }
      const query = typeof args.version === "number" ? `?version=${Math.floor(args.version)}` : "";
      const r = await cpFetch(deps, "GET", `/api/workflows/${encodeURIComponent(args.workflowId)}${query}`);
      if (!r.ok) return errorResult(r.message);
      const node = capArray(r.data?.nodes, 64).find((candidate) => candidate?.nodeId === args.nodeId);
      if (!node) return errorResult(`workflow node '${args.nodeId}' was not found`);
      return textResult({ node: mapWorkflowNode(node, true) });
    },
  },
  {
    name: "list_workflow_instances",
    description: "List workflow instances, optionally restricted to one run, with node status summaries.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      const query = new URLSearchParams();
      if (typeof args?.runId === "string" && args.runId) query.set("runId", args.runId);
      query.set("limit", String(Math.min(100, Math.max(1, typeof args?.limit === "number" ? Math.floor(args.limit) : 100))));
      const r = await cpFetch(deps, "GET", `/api/workflow-instances?${query.toString()}`);
      if (!r.ok) return errorResult(r.message);
      return textResult({ instances: capArray(r.data).map((instance) => mapWorkflowInstance(instance)) });
    },
  },
  {
    name: "get_workflow_instance",
    description: "Inspect one workflow instance with its graph, attempts, events, and exact ready or waiting nodes.",
    inputSchema: {
      type: "object",
      properties: { instanceId: { type: "string" } },
      required: ["instanceId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.instanceId !== "string" || !args.instanceId) return errorResult("instanceId is required");
      const r = await cpFetch(deps, "GET", `/api/workflow-instances/${encodeURIComponent(args.instanceId)}`);
      if (!r.ok) return errorResult(r.message);
      return textResult({ instance: mapWorkflowInstance(r.data, true) });
    },
  },

  /* ---------------- MUTATIONS (each call parks on a human card) ----------- */
  {
    name: "upsert_governance_policy",
    description: "Create or replace one validated non-built-in governance policy. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: GOVERNANCE_POLICY_PROPERTIES,
      required: ["policyId", "name", "effect", "priority", "enabled", "scope"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.policyId !== "string" || !args.policyId) return errorResult("policyId is required");
      const body: Json = {};
      for (const key of ["policyId", "name", "effect", "priority", "enabled", "scope", "conditions", "askTimeout"]) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      const r = await cpFetch(deps, "PUT", `/api/governance/policies/${encodeURIComponent(args.policyId)}`, body);
      if (!r.ok) return errorResult(r.message);
      return textResult({ policy: mapGovernancePolicy(r.data) });
    },
  },
  {
    name: "delete_governance_policy",
    description: "Delete one exact non-built-in governance policy. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: { policyId: { type: "string" } },
      required: ["policyId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.policyId !== "string" || !args.policyId) return errorResult("policyId is required");
      const r = await cpFetch(deps, "DELETE", `/api/governance/policies/${encodeURIComponent(args.policyId)}`);
      if (!r.ok) return errorResult(r.message);
      return textResult({ deleted: true, policyId: args.policyId });
    },
  },
  {
    name: "create_workflow_definition",
    description: "Create a validated custom workflow definition at immutable version 1. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: WORKFLOW_SPEC_PROPERTIES,
      required: ["name", "maxTransitions", "nodes", "edges"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      const body = {
        name: args?.name,
        ...(args?.description !== undefined ? { description: args.description } : {}),
        maxTransitions: args?.maxTransitions,
        nodes: args?.nodes,
        edges: args?.edges,
      };
      const r = await cpFetch(deps, "POST", "/api/workflows", body);
      if (!r.ok) return errorResult(r.message);
      return textResult({ workflow: mapWorkflowDefinition(r.data, true) });
    },
  },
  {
    name: "create_workflow_version",
    description: "Create the next immutable version of an existing custom workflow definition. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string" }, ...WORKFLOW_SPEC_PROPERTIES },
      required: ["workflowId", "name", "maxTransitions", "nodes", "edges"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.workflowId !== "string" || !args.workflowId) return errorResult("workflowId is required");
      const body = {
        name: args.name,
        ...(args.description !== undefined ? { description: args.description } : {}),
        maxTransitions: args.maxTransitions,
        nodes: args.nodes,
        edges: args.edges,
      };
      const r = await cpFetch(deps, "POST", `/api/workflows/${encodeURIComponent(args.workflowId)}/versions`, body);
      if (!r.ok) return errorResult(r.message);
      return textResult({ workflow: mapWorkflowDefinition(r.data, true) });
    },
  },
  {
    name: "create_workflow_run",
    description: "Create a role-bound workflow run whose workers wait for exact node dispatch. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        runnerId: { type: "string" },
        workspaceId: { type: "string" },
        workflowId: { type: "string" },
        workflowVersion: { type: "integer", minimum: 1 },
        task: { type: "string" },
        title: { type: "string" },
        useWorktree: { type: "boolean" },
        agentBindings: { type: "object", additionalProperties: { type: "string" } },
        costBudgetUsd: { type: "number", minimum: 0 },
        maxToolCalls: { type: "number", minimum: 0 },
      },
      required: ["runnerId", "workspaceId", "workflowId", "task"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.runnerId !== "string" || typeof args?.workspaceId !== "string" ||
          typeof args?.workflowId !== "string" || typeof args?.task !== "string" || !args.task.trim()) {
        return errorResult("runnerId, workspaceId, workflowId, and a non-empty task are required");
      }
      const body: Json = {
        runnerId: args.runnerId,
        workspaceId: args.workspaceId,
        workflowId: args.workflowId,
        task: args.task,
      };
      for (const key of ["workflowVersion", "title", "useWorktree", "agentBindings", "costBudgetUsd", "maxToolCalls"]) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      const r = await createWithSpawnApproval(deps, "/api/workflow-runs", body);
      if (!r.ok) return errorResult(r.message);
      return textResult({
        run: { id: r.data?.run?.id, title: r.data?.run?.title, sessionIds: capArray(r.data?.run?.sessionIds) },
        sessions: capArray(r.data?.sessions).map(mapSession),
        instance: mapWorkflowInstance(r.data?.instance, true),
      });
    },
  },
  {
    name: "dispatch_workflow_node",
    description: "Dispatch one ready workflow agent node with a caller-stable idempotency key. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: { instanceId: { type: "string" }, nodeId: { type: "string" }, dispatchKey: { type: "string" } },
      required: ["instanceId", "nodeId", "dispatchKey"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (![args?.instanceId, args?.nodeId, args?.dispatchKey].every((value) => typeof value === "string" && value)) {
        return errorResult("instanceId, nodeId, and dispatchKey are required");
      }
      const r = await cpFetch(
        deps,
        "POST",
        `/api/workflow-instances/${encodeURIComponent(args.instanceId)}/nodes/${encodeURIComponent(args.nodeId)}/dispatch`,
        { dispatchKey: args.dispatchKey },
      );
      if (!r.ok) return errorResult(r.message);
      return textResult(r.data);
    },
  },
  {
    name: "attach_session_artifact",
    description: "Attach an image file from disk to your own session as a screenshot artifact. Pass the file's absolute path; the file is read on the runner host and uploaded directly, so its bytes never enter your context. Returns only the artifactId, mediaType, sizeBytes, and sha256 — cite exactly those in a ui_evidence_approval evidence item to make it reviewable by an Orchestrator. Use this instead of create_workflow_artifact for any image: never base64 an image into a tool argument. PNG, JPEG, GIF, or WebP, up to 8 MiB. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of a regular image file on the runner host" },
        name: { type: "string", description: "Display name; defaults to the file name" },
        sessionId: { type: "string", description: "Only for a paired-device caller. A session credential always attaches to its own session." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.path !== "string" || !args.path) return errorResult("path is required");
      if (args.name !== undefined && (typeof args.name !== "string" || !args.name.trim())) {
        return errorResult("name must be a non-empty string");
      }
      const sessionId = typeof args?.sessionId === "string" && args.sessionId ? args.sessionId : deps.selfSessionId;
      if (!sessionId) return errorResult("sessionId is required");
      // The control plane enforces this too; refusing here keeps a session credential from reading
      // and uploading a file for a request that can only be rejected.
      if (deps.actorHeader !== null && deps.selfSessionId && sessionId !== deps.selfSessionId) {
        return errorResult("refusing: a session credential may attach artifacts only to its own session");
      }
      const incompatible = await sessionArtifactFileAttachCompatibilityError(deps);
      if (incompatible) return incompatible;
      const file = await readImageFileForAttach(args.path);
      if (!file.ok) return errorResult(file.error);
      const r = await cpFetch(
        deps,
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/screenshots`,
        {
          name: typeof args.name === "string" ? args.name.trim() : basename(args.path),
          mimeType: file.mediaType,
          data: file.bytes.toString("base64"),
        },
        deps.requestTimeoutMs ?? ARTIFACT_UPLOAD_TIMEOUT_MS,
      );
      // The route answers a repeat of the same file with the artifact it already made, so whenever
      // the outcome cannot be known the honest instruction is to attach again, not to guess.
      const unknownOutcome = (detail: string) => errorResult(
        `${detail}. The upload's outcome is unknown. Attach the same file again: if it was stored, the same artifact is returned rather than a duplicate.`,
      );
      // No HTTP status means the request died in transit or timed out, possibly after the control
      // plane committed it.
      if (!r.ok) return r.status === undefined ? unknownOutcome(r.message) : errorResult(r.message);
      // A success status whose body was cut off or is not an artifact is the same situation one step
      // later: committed, but the id never arrived. It is not evidence that the wrong bytes were stored.
      if (typeof r.data?.artifactId !== "string" || typeof r.data?.sha256 !== "string" ||
          typeof r.data?.sizeBytes !== "number") {
        return unknownOutcome("the control plane accepted the upload but its answer did not arrive intact");
      }
      // The digest an agent cites must be the digest of what was stored. If the control plane's
      // differs from the file's, the upload was altered in transit; say so instead of returning an
      // id that would later fail review as a digest mismatch.
      if (r.data?.sha256 !== file.sha256 || r.data?.sizeBytes !== file.sizeBytes) {
        return errorResult("the control plane stored different bytes than the file holds; do not cite this artifact");
      }
      return textResult({
        artifact: {
          artifactId: r.data.artifactId,
          sessionId: r.data.sessionId,
          kind: r.data.kind,
          name: r.data.name,
          mediaType: r.data.mimeType,
          sizeBytes: r.data.sizeBytes,
          sha256: r.data.sha256,
        },
      });
    },
  },
  {
    name: "create_workflow_artifact",
    description: "Publish an immutable, attributed workflow artifact for a run or worker session. For an image file use attach_session_artifact instead, which reads the file from disk. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        sessionId: { type: "string" },
        kind: { type: "string", enum: ["html_preview", "patch", "review_report", "screenshot", "test_log", "verdict"] },
        name: { type: "string" },
        mimeType: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64", "json"] },
        data: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["kind", "name", "mimeType", "encoding", "data"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (!args?.runId && !args?.sessionId) return errorResult("runId or sessionId is required");
      const body: Json = {};
      for (const key of ["runId", "sessionId", "kind", "name", "mimeType", "encoding", "data", "metadata"]) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      const path = args.kind === "screenshot" ? "/api/artifacts/screenshots" : "/api/artifacts";
      const r = await cpFetch(deps, "POST", path, body);
      if (!r.ok) return errorResult(r.message);
      return textResult({ artifact: { ...r.data, data: undefined } });
    },
  },
  {
    name: "complete_workflow_attempt",
    description: "Complete an awaiting workflow attempt with exact artifact-contract bindings. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        attemptId: { type: "string" },
        outcome: { type: "string", enum: ["success", "failure", "accepted", "changes_requested", "rejected"] },
        outputs: { type: "object", additionalProperties: { type: "string" } },
        error: { type: "string" },
      },
      required: ["attemptId", "outcome"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.attemptId !== "string" || !args.attemptId || typeof args?.outcome !== "string") {
        return errorResult("attemptId and outcome are required");
      }
      const body: Json = { outcome: args.outcome };
      if (args.outputs !== undefined) body.outputs = args.outputs;
      if (args.error !== undefined) body.error = args.error;
      const r = await cpFetch(deps, "POST", `/api/workflow-attempts/${encodeURIComponent(args.attemptId)}/complete`, body);
      if (!r.ok) return errorResult(r.message);
      return textResult({ instance: mapWorkflowInstance(r.data, true) });
    },
  },
  {
    name: "resolve_workflow_gate",
    description: "Resolve a waiting human workflow gate; named policy decisions remain non-bypassable. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
        nodeId: { type: "string" },
        outcome: { type: "string", enum: ["success", "failure"] },
      },
      required: ["instanceId", "nodeId", "outcome"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (![args?.instanceId, args?.nodeId, args?.outcome].every((value) => typeof value === "string" && value)) {
        return errorResult("instanceId, nodeId, and outcome are required");
      }
      const r = await cpFetch(
        deps,
        "POST",
        `/api/workflow-instances/${encodeURIComponent(args.instanceId)}/nodes/${encodeURIComponent(args.nodeId)}/resolve`,
        { outcome: args.outcome },
      );
      if (!r.ok) return errorResult(r.message);
      return textResult({ instance: mapWorkflowInstance(r.data, true) });
    },
  },
  {
    name: "create_worktree",
    description: "Create and select a session worktree at an exact branch and optional base ref. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Defaults to the calling session" },
        branch: { type: "string" },
        baseRef: { type: "string", description: "Defaults to the fetched remote default branch" },
      },
      required: ["branch"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.branch !== "string" || !args.branch) return errorResult("branch is required");
      const sessionId = worktreeTarget(args, deps);
      if (typeof sessionId !== "string") return sessionId;
      // Additive opt-in: old control planes ignore this field and preserve their synchronous path;
      // v113 control planes acknowledge and let this client poll without one absolute HTTP wait.
      const body: Json = { branch: args.branch, progress: true };
      if (typeof args.baseRef === "string") body.baseRef = args.baseRef;
      const path = `/api/sessions/${encodeURIComponent(sessionId)}/worktrees`;
      let result = await cpFetch(deps, "POST", path, body, SESSION_WORKTREE_CREATE_CLIENT_TIMEOUT_MS);
      while (result.ok && result.data?.operation?.status === "in_progress") {
        if (!await cancellableSleep(deps, 1_000)) {
          return errorResult(
            "request cancelled after the control plane acknowledged the worktree operation; " +
            "it may still complete — inspect current state before retrying",
          );
        }
        // Repeating the exact coordinates joins the existing v113 operation. Against an older
        // control plane the first response remains the complete legacy result and never loops.
        result = await cpFetch(deps, "POST", path, body, SESSION_WORKTREE_CREATE_CLIENT_TIMEOUT_MS);
      }
      if (!result.ok) return errorResult(result.message);
      if (result.data?.operation?.status === "failed") {
        return errorResult(result.data.operation.error ?? "worktree operation failed");
      }
      return textResult(mapWorktreeResult(result.data));
    },
  },
  {
    name: "attach_worktree",
    description: "Attach and select an existing worktree for a session. The path may live anywhere, including beside the checkout at ../<repo>-worktrees/<slug>, as long as the session repository registers it in `git worktree list`. Under platform isolation the result reports whether a live provider process can already write there, or whether that takes effect at the session's next launch. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Defaults to the calling session" },
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.path !== "string" || !args.path) return errorResult("path is required");
      const sessionId = worktreeTarget(args, deps);
      if (typeof sessionId !== "string") return sessionId;
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/worktrees/attach`, { path: args.path });
      if (!r.ok) return errorResult(r.message);
      return textResult(mapWorktreeResult(r.data));
    },
  },
  {
    name: "select_worktree",
    description: "Select one of a session's attached worktrees for future turns. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Defaults to the calling session" },
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.path !== "string" || !args.path) return errorResult("path is required");
      const sessionId = worktreeTarget(args, deps);
      if (typeof sessionId !== "string") return sessionId;
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/worktrees/select`, { path: args.path });
      if (!r.ok) return errorResult(r.message);
      return textResult(mapWorktreeResult(r.data));
    },
  },
  {
    name: "discard_worktree",
    description: "Permanently retire a runner-owned worktree and branch only when they are clean and fully pushed. Always use this instead of `git worktree remove` for a session-linked path: when a provider still owns the path, it durably defers retirement until provider exit, then applies the managed safety checks and clears the selection and inventory together. A `deferred` retirement needs no follow-up — it replays on its own; a runner too old to record one answers with an explicit refusal that names the recovery step instead. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Defaults to the calling session" },
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.path !== "string" || !args.path) return errorResult("path is required");
      const sessionId = worktreeTarget(args, deps);
      if (typeof sessionId !== "string") return sessionId;
      const compatibilityError = await worktreeRetirementCompatibilityError(deps);
      if (compatibilityError) return compatibilityError;
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/worktrees/discard`, { path: args.path });
      if (!r.ok) return errorResult(r.message);
      return textResult(mapWorktreeResult(r.data));
    },
  },
  {
    name: "create_session",
    description:
      "Start a child session with an optional model and reasoning effort applied before its initial task. Unsupported model/effort pairs fail before launch; omitting effort preserves saved/default resolution. It gets its own worktree unless you pass useWorktree: false, so its branch, diff, checkpoints, review, and PR state are visible. Omitted cost and tool-call limits remain unlimited unless Project defaults, a finite parent ceiling, or governance policy supplies them; explicit 0 opts out when the parent is unbounded. The result reports the effective model, effort, and each guardrail as a value or null (none). Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        runnerId: { type: "string" },
        agentId: { type: "string" },
        prompt: { type: "string", description: "Initial task for the agent" },
        workspaceId: { type: "string" },
        workspacePath: { type: "string", description: "Ad-hoc absolute directory instead of workspaceId" },
        title: { type: "string" },
        useWorktree: { type: "boolean", description: "Defaults to true; pass false to run the child in place in the workspace directory" },
        model: { type: "string" },
        effort: { type: "string", minLength: 1, description: "Reasoning effort supported by the selected model and agent installation" },
        permissionMode: { type: "string", enum: [...WORKER_PERMISSION_MODES] },
        costBudgetUsd: { type: "number" },
        maxToolCalls: { type: "number" },
        maxChildSessions: { type: "integer", minimum: 0, maximum: 64 },
      },
      required: ["runnerId", "agentId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.runnerId !== "string" || typeof args?.agentId !== "string") {
        return errorResult("runnerId and agentId are required");
      }
      if (!args.workspaceId && !args.workspacePath) {
        return errorResult("workspaceId or workspacePath is required — pick one from list_runners");
      }
      if (args.effort !== undefined && (typeof args.effort !== "string" || !args.effort.trim())) {
        return errorResult("effort must be a non-empty reasoning effort supported by the selected model and agent installation");
      }
      if (args.permissionMode !== undefined && !WORKER_PERMISSION_MODES.includes(args.permissionMode)) {
        return errorResult(
          `permissionMode must be one of ${WORKER_PERMISSION_MODES.join(", ")} — bypassPermissions is never allowed`,
        );
      }
      if (typeof args.effort === "string") {
        const compatibilityError = await explicitEffortCompatibilityError(deps);
        if (compatibilityError) return compatibilityError;
      }
      const config: Json = {};
      if (typeof args.model === "string") config.model = args.model;
      if (typeof args.effort === "string") config.effort = args.effort;
      if (typeof args.permissionMode === "string") config.permissionMode = args.permissionMode;
      if (typeof args.costBudgetUsd === "number") config.costBudgetUsd = args.costBudgetUsd;
      if (typeof args.maxToolCalls === "number") config.maxToolCalls = args.maxToolCalls;
      if (typeof args.maxChildSessions === "number") config.maxChildSessions = args.maxChildSessions;
      const body: Json = { runnerId: args.runnerId, agentId: args.agentId };
      if (typeof args.workspaceId === "string") body.workspaceId = args.workspaceId;
      if (typeof args.workspacePath === "string") body.workspacePath = args.workspacePath;
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.prompt === "string") body.prompt = args.prompt;
      // A child that starts in the primary checkout has no branch, so diff, checkpoint, review,
      // and PR surfaces are blind to it. An agent asks for a worktree by default; only an explicit
      // `useWorktree: false` keeps the in-place behavior. Human/UI-created sessions are unaffected
      // — they post their own explicit value to the same route.
      body.useWorktree = args.useWorktree !== false;
      if (Object.keys(config).length) body.config = config;

      const created = await createWithSpawnApproval(deps, "/api/sessions", body);
      if (!created.ok) return errorResult(created.message);
      const view = created.data;
      return textResult({
        session: {
          ...mapSession(view),
          model: view?.model ?? null,
          effort: view?.effort ?? null,
        },
      });
    },
  },
  {
    name: "prompt_session",
    description: "Send a message/task to a descendant session. The result reports whether the message was delivered immediately or queued behind work already running — a queued message is not lost, but a session inside a long tool call will not see it until that turn ends. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, text: { type: "string" } },
      required: ["sessionId", "text"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.sessionId !== "string" || typeof args?.text !== "string" || !args.text.trim()) {
        return errorResult("sessionId and a non-empty text are required");
      }
      if (args.sessionId === deps.selfSessionId) {
        return errorResult("refusing: that is my own session (an agent cannot prompt itself)");
      }
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(args.sessionId)}/prompt`, {
        text: args.text,
      });
      if (!r.ok) return errorResult(r.message);
      return textResult({ session: mapSession(r.data), delivery: promptDelivery(r.data) });
    },
  },
  {
    name: "stop_session",
    description: "Stop a descendant session's agent process. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.sessionId !== "string" || !args.sessionId) return errorResult("sessionId is required");
      if (args.sessionId === deps.selfSessionId) {
        return errorResult("refusing: that is my own session (an agent cannot stop itself)");
      }
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(args.sessionId)}/stop`);
      if (!r.ok) return errorResult(r.message);
      return textResult({ session: mapSession(r.data) });
    },
  },
  {
    name: "restart_session",
    description: "Restart a stopped descendant session, subject to its parent's available live-child slots. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.sessionId !== "string" || !args.sessionId) return errorResult("sessionId is required");
      if (args.sessionId === deps.selfSessionId) {
        return errorResult("refusing: that is my own session (an agent cannot restart itself)");
      }
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(args.sessionId)}/restart`);
      if (!r.ok) return errorResult(r.message);
      return textResult({ session: mapSession(r.data) });
    },
  },
  {
    name: "archive_session",
    description: "Archive a descendant session without deleting its history. Existing stop-before-archive and visibility checks apply.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.sessionId !== "string" || !args.sessionId) return errorResult("sessionId is required");
      if (args.sessionId === deps.selfSessionId) return errorResult("refusing: an agent cannot archive its own session");
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(args.sessionId)}/archive`, { archived: true });
      if (!r.ok) return errorResult(r.message);
      return textResult({ session: mapSession(r.data) });
    },
  },
  {
    name: "set_guardrails",
    description: "Set or clear a descendant's cost budget (USD) and/or tool-call limit (0 clears), or set a descendant's or this session's concurrent live-child limit from 0 through 64. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        costBudgetUsd: { type: "number" },
        maxToolCalls: { type: "number" },
        maxChildSessions: { type: "integer", minimum: 0, maximum: 64 },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.sessionId !== "string" || !args.sessionId) return errorResult("sessionId is required");
      if (args.sessionId === deps.selfSessionId &&
          (typeof args.maxChildSessions !== "number" ||
            typeof args.costBudgetUsd === "number" || typeof args.maxToolCalls === "number")) {
        return errorResult("refusing: an agent may change only its own maxChildSessions");
      }
      // ONLY guardrail keys ever ride this call — never model/effort/permissionMode.
      const body: Json = {};
      if (typeof args.costBudgetUsd === "number") body.costBudgetUsd = args.costBudgetUsd;
      if (typeof args.maxToolCalls === "number") body.maxToolCalls = args.maxToolCalls;
      if (typeof args.maxChildSessions === "number") body.maxChildSessions = args.maxChildSessions;
      if (!Object.keys(body).length) {
        return errorResult("at least one of costBudgetUsd, maxToolCalls, or maxChildSessions is required (0 clears a cost/tool limit)");
      }
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(args.sessionId)}/config`, body);
      if (!r.ok) return errorResult(r.message);
      return textResult({ session: mapSession(r.data) });
    },
  },
  {
    name: "create_run",
    description:
      "Start a multi-agent run: the same task fanned out to several agents in isolated worktrees. Subject to session permissions and governance policies.",
    inputSchema: {
      type: "object",
      properties: {
        runnerId: { type: "string" },
        workspaceId: { type: "string" },
        agentIds: { type: "array", items: { type: "string" }, minItems: 1 },
        task: { type: "string" },
        title: { type: "string" },
        costBudgetUsd: { type: "number" },
        maxToolCalls: { type: "number" },
      },
      required: ["runnerId", "workspaceId", "agentIds", "task"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (
        typeof args?.runnerId !== "string" ||
        typeof args?.workspaceId !== "string" ||
        !Array.isArray(args?.agentIds) ||
        args.agentIds.length === 0 ||
        typeof args?.task !== "string" ||
        !args.task.trim()
      ) {
        return errorResult("runnerId, workspaceId, agentIds (non-empty), and task are required");
      }
      const body: Json = {
        runnerId: args.runnerId,
        workspaceId: args.workspaceId,
        agentIds: args.agentIds,
        task: args.task,
      };
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.costBudgetUsd === "number") body.costBudgetUsd = args.costBudgetUsd;
      if (typeof args.maxToolCalls === "number") body.maxToolCalls = args.maxToolCalls;
      const r = await createWithSpawnApproval(deps, "/api/runs", body);
      if (!r.ok) return errorResult(r.message);
      return textResult({
        run: { id: r.data?.run?.id, title: r.data?.run?.title, sessionIds: capArray(r.data?.run?.sessionIds) },
        sessions: capArray(r.data?.sessions).map(mapSession),
      });
    },
  },
];

/* -------------------------------------------------------------------------- */
/* JSON-RPC dispatch + newline framing                                        */
/* -------------------------------------------------------------------------- */

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Json;
}

/**
 * Handle one parsed JSON-RPC message; returns the response object, or null for
 * notifications (and noise). Pure over `deps` — the unit tests drive this directly.
 */
export async function dispatch(msg: unknown, deps: McpDeps): Promise<Json | null> {
  const m = msg as RpcMessage;
  if (!m || typeof m !== "object" || typeof m.method !== "string") return null;
  const id = m.id;
  const isRequest = id !== undefined && id !== null;
  const reply = (result: Json): Json => ({ jsonrpc: "2.0", id, result });
  const rpcError = (code: number, message: string): Json => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (m.method) {
    case "initialize":
      return isRequest
        ? reply({
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "wollipog-manager", version: VERSION },
          })
        : null;
    case "notifications/initialized":
      return null; // notification — no reply
    case "ping":
      return isRequest ? reply({}) : null;
    case "tools/list":
      return isRequest
        ? reply({ tools: TOOLS.filter((tool) => deps.orchestrator
          ? ORCHESTRATOR_TOOLS.has(tool.name)
          : !PARENT_CONTROL_TOOLS.has(tool.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
        : null;
    case "tools/call": {
      if (!isRequest) return null;
      const name = m.params?.name;
      if (typeof name !== "string") return rpcError(-32602, "tools/call requires params.name");
      const tool = TOOLS.find((t) => t.name === name);
      if (deps.orchestrator && !ORCHESTRATOR_TOOLS.has(name)) return reply(errorResult("the orchestrator preset does not allow this tool"));
      if (!deps.orchestrator && PARENT_CONTROL_TOOLS.has(name)) return reply(errorResult("this tool requires the orchestrator preset"));
      // Unknown tool → an isError TOOL result (not a protocol error) so the model can
      // recover in-conversation instead of the client tearing the turn down.
      if (!tool) return reply(errorResult(`unknown tool '${name}'`));
      try {
        return reply(await tool.handler(m.params?.arguments ?? {}, deps));
      } catch (err) {
        // A handler bug must never leave the request unanswered (claude would hang the turn).
        return reply(errorResult(`tool '${name}' failed: ${(err as Error)?.message ?? String(err)}`));
      }
    }
    default:
      return isRequest ? rpcError(-32601, "method not found") : null;
  }
}

/** Direct programmatic access for the CLI. It deliberately executes the exact MCP tool table so
 * schemas, response projection, self-targeting checks, and REST routes cannot drift. */
export async function executeManagerTool(name: string, args: Json, deps: McpDeps): Promise<ToolResult> {
  if (deps.orchestrator && !ORCHESTRATOR_TOOLS.has(name)) return errorResult("the orchestrator preset does not allow this tool");
  if (!deps.orchestrator && PARENT_CONTROL_TOOLS.has(name)) return errorResult("this tool requires the orchestrator preset");
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return errorResult(`unknown tool '${name}'`);
  try {
    return await tool.handler(args ?? {}, deps);
  } catch (error) {
    return errorResult(`tool '${name}' failed: ${(error as Error)?.message ?? String(error)}`);
  }
}

/**
 * Newline-delimited JSON-RPC over a stream pair. Non-JSON lines are skipped (same rule as
 * jsonrpc.ts — stdout noise must not kill the server). Requests dispatch CONCURRENTLY:
 * JSON-RPC correlates responses by id (out-of-order completion is legal) and each response
 * is one atomic newline-terminated write(), so frames can't interleave. Serializing here
 * would head-of-line block every tool — even ping and the pre-allowed reads — behind one
 * stalled CP request, bricking the whole server for the duration of a tunnel blip.
 */
export function serveSessionManagementMcp(input: Readable, output: Writable, deps: McpDeps): void {
  let buffer = "";
  const pending = new Map<string, AbortController>();
  const requestKey = (id: number | string): string => `${typeof id}:${String(id)}`;
  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // skip non-JSON noise
    }
    const rpc = msg as RpcMessage;
    if (rpc?.method === "notifications/cancelled") {
      const requestId = rpc.params?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        pending.get(requestKey(requestId))?.abort();
      }
      return;
    }
    const id = rpc?.id;
    const controller = (typeof id === "string" || typeof id === "number") && rpc.method === "tools/call"
      ? new AbortController()
      : undefined;
    const key = controller ? requestKey(id as string | number) : undefined;
    if (controller && key) {
      pending.get(key)?.abort();
      pending.set(key, controller);
    }
    void dispatch(msg, controller ? { ...deps, signal: controller.signal } : deps)
      .then((res) => {
        if (res) output.write(JSON.stringify(res) + "\n");
      })
      .catch((err) => {
        // dispatch never rejects by design; belt so a bad frame can't become an unhandled rejection.
        console.error(`[session-management-mcp] dispatch failed: ${(err as Error)?.message ?? String(err)}`);
      })
      .finally(() => {
        if (controller && key && pending.get(key) === controller) pending.delete(key);
      });
  };
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  });
  input.on("end", () => {
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  });
}
