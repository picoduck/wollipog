/**
 * Conductor MCP server ("manager") — the runner executable's `--conductor-mcp` mode.
 *
 * The conductor is a normal claude-code session whose `claude -p` process is given
 * `--mcp-config` pointing here (see conductor.ts). This process speaks newline-delimited
 * JSON-RPC 2.0 over stdio (hand-rolled — minimal-deps policy, no @modelcontextprotocol/sdk;
 * framing idiom shared with jsonrpc.ts) and proxies a CURATED subset of the control-plane
 * REST API via fetch. Safety properties live in the tool table, not the model:
 *  - reads are pre-allowed via --allowedTools; every mutation parks on the CLI's own
 *    stdio permission gate, surfacing as the existing Allow/Reject card in the UI;
 *  - no approve tool (the conductor never resolves permission/guardrail cards);
 *  - self-targeting and conductor-recursion are refused script-side, as is
 *    bypassPermissions for worker sessions;
 *  - REST errors are TOOL results ({isError:true}), never protocol errors, so the model
 *    can relay 409 semantics (runner offline / busy / guardrail-parked) to the user.
 *
 * `--cp-url` and `--self-session-id` ride argv (written into the per-session mcp-config
 * file); MANAGER_TOKEN rides env only so the secret never appears in any process listing.
 */

import type { Readable, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { WOLLIPOG_CONDUCTOR_ACTOR_SESSION_HEADER } from "@wollipog/protocol";
import { VERSION } from "./version.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Response caps: lists are field-mapped and bounded so a busy manager can't eat the
 * conductor's context window (the MVP mitigation for hundreds of sessions). */
const MAX_ITEMS = 100;
const MAX_LINE = 400;

/** Worker sessions the conductor creates may use any interactive/fixed mode EXCEPT
 * bypassPermissions (and codex danger-full-access) — the human still sees the create card. */
const WORKER_PERMISSION_MODES = ["default", "auto", "acceptEdits", "plan"] as const;

/** The conductor's own agent id — a contract constant shared with the runner's agent
 * synthesis + provisioning and the control plane's permissionMode clamp. */
const CONDUCTOR_AGENT_ID = "conductor";

/** Cap on one CP round-trip. Without it, a half-open connection (the documented box-tunnel
 * blip) would stall a call for undici's ~300s default header/body timeouts. */
const CP_TIMEOUT_MS = 30_000;

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
  /** The conductor's OWN session id — self-targeting mutations are refused. */
  selfSessionId: string;
  /** Active runner credential; paired with selfSessionId so the control plane authenticates this
   * exact live conductor without treating the credential as a general REST credential. */
  token: string;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface McpTool {
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

/** One REST round-trip. A non-2xx reply (or network failure) comes back as a message the
 * handler wraps into an isError tool result — the CP's own error text is preserved verbatim
 * so the model can explain WHY (offline / busy / guardrail-parked). */
async function cpFetch(
  deps: McpDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: Json } | { ok: false; message: string }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (deps.token) headers["authorization"] = `Bearer ${deps.token}`;
  headers[WOLLIPOG_CONDUCTOR_ACTOR_SESSION_HEADER] = deps.selfSessionId;
  let res: McpFetchResponse;
  try {
    res = await deps.fetch(`${deps.cpUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Bound the round-trip; the catch below maps the TimeoutError into an isError tool
      // result like any other network failure, so the model can relay "CP unreachable".
      signal: AbortSignal.timeout(CP_TIMEOUT_MS),
    });
  } catch (err) {
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
    return { ok: false, message: `HTTP ${res.status}: ${detail}` };
  }
  return { ok: true, data };
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
    costUsd: s?.costUsd,
    costBudgetUsd: s?.costBudgetUsd ?? null,
    maxToolCalls: s?.maxToolCalls ?? null,
    toolCallCount: s?.toolCallCount,
    // Title only — the options/requestId belong to the human's card, not the conductor.
    pendingApproval: s?.pendingApproval?.title ?? null,
    updatedAt: s?.updatedAt,
    archived: s?.archived ?? false,
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

/* -------------------------------------------------------------------------- */
/* Tool table (tool ids as claude sees them: mcp__manager__<name>)             */
/* -------------------------------------------------------------------------- */

export const TOOLS: McpTool[] = [
  /* ------------------------------- READS --------------------------------- */
  {
    name: "list_runners",
    description: "List runner machines with their agents and workspaces (source of runnerId/agentId/workspaceId).",
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
    name: "list_sessions",
    description: "List sessions with status, title, cost, budget, tool-call count, and any pending approval.",
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
    description: "Create or replace one validated non-built-in governance policy. The user must approve.",
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
    description: "Delete one exact non-built-in governance policy. The user must approve.",
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
    description: "Create a validated custom workflow definition at immutable version 1. The user must approve.",
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
    description: "Create the next immutable version of an existing custom workflow definition. The user must approve.",
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
    description: "Create a role-bound workflow run whose workers wait for exact node dispatch. The user must approve.",
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
      if (args.agentBindings && Object.values(args.agentBindings).includes(CONDUCTOR_AGENT_ID)) {
        return errorResult("refusing: workflow workers must not use the conductor agent");
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
      const r = await cpFetch(deps, "POST", "/api/workflow-runs", body);
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
    description: "Dispatch one ready workflow agent node with a caller-stable idempotency key. The user must approve.",
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
    name: "create_workflow_artifact",
    description: "Publish an immutable, attributed workflow artifact for a run or worker session. The user must approve.",
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
    description: "Complete an awaiting workflow attempt with exact artifact-contract bindings. The user must approve.",
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
    description: "Resolve a waiting human workflow gate; named policy decisions remain non-bypassable. The user must approve.",
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
    name: "create_session",
    description:
      "Start a new agent session on a runner, optionally with the initial task prompt and guardrails. The user must approve.",
    inputSchema: {
      type: "object",
      properties: {
        runnerId: { type: "string" },
        agentId: { type: "string" },
        prompt: { type: "string", description: "Initial task for the agent" },
        workspaceId: { type: "string" },
        workspacePath: { type: "string", description: "Ad-hoc absolute directory instead of workspaceId" },
        title: { type: "string" },
        useWorktree: { type: "boolean" },
        model: { type: "string" },
        permissionMode: { type: "string", enum: [...WORKER_PERMISSION_MODES] },
        costBudgetUsd: { type: "number" },
        maxToolCalls: { type: "number" },
      },
      required: ["runnerId", "agentId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.runnerId !== "string" || typeof args?.agentId !== "string") {
        return errorResult("runnerId and agentId are required");
      }
      if (args.agentId === CONDUCTOR_AGENT_ID) {
        return errorResult("refusing to start another conductor (a conductor must not spawn conductors)");
      }
      if (!args.workspaceId && !args.workspacePath) {
        return errorResult("workspaceId or workspacePath is required — pick one from list_runners");
      }
      if (args.permissionMode !== undefined && !WORKER_PERMISSION_MODES.includes(args.permissionMode)) {
        return errorResult(
          `permissionMode must be one of ${WORKER_PERMISSION_MODES.join(", ")} — bypassPermissions is never allowed`,
        );
      }
      const config: Json = {};
      if (typeof args.model === "string") config.model = args.model;
      if (typeof args.permissionMode === "string") config.permissionMode = args.permissionMode;
      const body: Json = { runnerId: args.runnerId, agentId: args.agentId };
      if (typeof args.workspaceId === "string") body.workspaceId = args.workspaceId;
      if (typeof args.workspacePath === "string") body.workspacePath = args.workspacePath;
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.prompt === "string") body.prompt = args.prompt;
      if (typeof args.useWorktree === "boolean") body.useWorktree = args.useWorktree;
      if (Object.keys(config).length) body.config = config;

      const created = await cpFetch(deps, "POST", "/api/sessions", body);
      if (!created.ok) return errorResult(created.message);
      const view = created.data;
      // Budgets can't ride create (the CP persists only model/effort/permissionMode there) —
      // arm them with a follow-up config write under this SAME gated tool call.
      const guardrails: Json = {};
      if (typeof args.costBudgetUsd === "number") guardrails.costBudgetUsd = args.costBudgetUsd;
      if (typeof args.maxToolCalls === "number") guardrails.maxToolCalls = args.maxToolCalls;
      if (Object.keys(guardrails).length) {
        const armed = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(view?.id)}/config`, guardrails);
        if (!armed.ok) {
          return errorResult(`session ${view?.id} was created, but arming its guardrails failed — ${armed.message}`);
        }
        return textResult({ session: mapSession(armed.data) });
      }
      return textResult({ session: mapSession(view) });
    },
  },
  {
    name: "prompt_session",
    description: "Send a message/task to an existing session. The user must approve.",
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
        return errorResult("refusing: that is my own session (the conductor never prompts itself)");
      }
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(args.sessionId)}/prompt`, {
        text: args.text,
      });
      if (!r.ok) return errorResult(r.message);
      return textResult({ session: mapSession(r.data) });
    },
  },
  {
    name: "stop_session",
    description: "Stop a session's agent process. The user must approve.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.sessionId !== "string" || !args.sessionId) return errorResult("sessionId is required");
      if (args.sessionId === deps.selfSessionId) {
        return errorResult("refusing: that is my own session (the conductor never stops itself)");
      }
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(args.sessionId)}/stop`);
      if (!r.ok) return errorResult(r.message);
      return textResult({ session: mapSession(r.data) });
    },
  },
  {
    name: "set_guardrails",
    description: "Set or clear a session's cost budget (USD) and/or tool-call limit; 0 clears. The user must approve.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        costBudgetUsd: { type: "number" },
        maxToolCalls: { type: "number" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args, deps) => {
      if (typeof args?.sessionId !== "string" || !args.sessionId) return errorResult("sessionId is required");
      if (args.sessionId === deps.selfSessionId) {
        return errorResult("refusing: that is my own session (the conductor never reconfigures itself)");
      }
      // ONLY guardrail keys ever ride this call — never model/effort/permissionMode.
      const body: Json = {};
      if (typeof args.costBudgetUsd === "number") body.costBudgetUsd = args.costBudgetUsd;
      if (typeof args.maxToolCalls === "number") body.maxToolCalls = args.maxToolCalls;
      if (!Object.keys(body).length) {
        return errorResult("at least one of costBudgetUsd or maxToolCalls is required (0 clears a limit)");
      }
      const r = await cpFetch(deps, "POST", `/api/sessions/${encodeURIComponent(args.sessionId)}/config`, body);
      if (!r.ok) return errorResult(r.message);
      return textResult({ session: mapSession(r.data) });
    },
  },
  {
    name: "create_run",
    description:
      "Start a multi-agent run: the same task fanned out to several agents in isolated worktrees. The user must approve.",
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
      if (args.agentIds.includes(CONDUCTOR_AGENT_ID)) {
        return errorResult("refusing: a run must not include the conductor agent");
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
      const r = await cpFetch(deps, "POST", "/api/runs", body);
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
        ? reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
        : null;
    case "tools/call": {
      if (!isRequest) return null;
      const name = m.params?.name;
      if (typeof name !== "string") return rpcError(-32602, "tools/call requires params.name");
      const tool = TOOLS.find((t) => t.name === name);
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

/**
 * Newline-delimited JSON-RPC over a stream pair. Non-JSON lines are skipped (same rule as
 * jsonrpc.ts — stdout noise must not kill the server). Requests dispatch CONCURRENTLY:
 * JSON-RPC correlates responses by id (out-of-order completion is legal) and each response
 * is one atomic newline-terminated write(), so frames can't interleave. Serializing here
 * would head-of-line block every tool — even ping and the pre-allowed reads — behind one
 * stalled CP request, bricking the whole server for the duration of a tunnel blip.
 */
export function serveConductorMcp(input: Readable, output: Writable, deps: McpDeps): void {
  let buffer = "";
  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // skip non-JSON noise
    }
    void dispatch(msg, deps)
      .then((res) => {
        if (res) output.write(JSON.stringify(res) + "\n");
      })
      .catch((err) => {
        // dispatch never rejects by design; belt so a bad frame can't become an unhandled rejection.
        console.error(`[conductor-mcp] dispatch failed: ${(err as Error)?.message ?? String(err)}`);
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
}

/** `--flag value` / `--flag=value` (the mcp-config file writes the former). */
function argValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === flag) return argv[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

/** Entry for the `--conductor-mcp` mode (dispatched by cli.ts). */
export function runConductorMcp(argv: string[], env: NodeJS.ProcessEnv): void {
  const cpUrl = argValue(argv, "--cp-url");
  const selfSessionId = argValue(argv, "--self-session-id");
  if (!cpUrl || !selfSessionId) {
    // stderr only — stdout is the JSON-RPC channel.
    console.error("[conductor-mcp] --cp-url and --self-session-id are required");
    process.exit(1);
  }
  let token = env.MANAGER_TOKEN ?? "";
  if (env.MANAGER_TOKEN_FILE) {
    try {
      token = readFileSync(env.MANAGER_TOKEN_FILE, "utf8").trim();
    } catch (error) {
      console.error(`[conductor-mcp] could not read MANAGER_TOKEN_FILE: ${(error as Error).message}`);
      process.exit(1);
    }
  }
  const deps: McpDeps = {
    fetch: globalThis.fetch,
    cpUrl: cpUrl.replace(/\/+$/, ""),
    selfSessionId,
    token,
  };
  serveConductorMcp(process.stdin, process.stdout, deps);
  // The claude CLI owns our lifetime: stdin EOF means the session process is gone.
  process.stdin.on("end", () => process.exit(0));
  console.error(`[conductor-mcp] serving ${TOOLS.length} manager tools for session ${selfSessionId} -> ${deps.cpUrl}`);
}
