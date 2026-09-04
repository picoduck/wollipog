import { posix, win32 } from "node:path";

/**
 * Phase 8a/8b: the CP-side guardrail engine. Pure functions over a session's flattened guardrail
 * fields — no DB, no hub — so every decision is unit-testable directly.
 *
 * The CP still owns durable card selection and precedence. Protocol-v47 runners additionally
 * cancel at the first normalized threshold event and settle idle; pre-v47 runners retain the
 * original between-turn behavior.
 */

import {
  isTerminal,
  type GovernancePolicy,
  type GovernancePolicyEffect,
  type GovernanceScope,
  type PendingApproval,
  type PolicyHookEvaluationRequest,
  type PolicyDecision,
  type PolicyRule,
  type SessionStatus,
} from "@wollipog/protocol";

/** The session state a policy evaluation reads. */
export interface PolicyInput {
  status: SessionStatus;
  costUsd: number;
  toolCallCount: number;
  /** Tokens are recorded but none of them could be priced, so `costUsd` says nothing (v105). */
  unpriced?: boolean;
}

/** The guardrail fields a session carries, as the rule builder reads them (v105 adds the soft
 * checkpoints, the unpriced acknowledgement, and the owner's daily allowance). */
export interface GuardrailFields {
  costBudgetUsd?: number | null;
  maxToolCalls?: number | null;
  costCheckpointsUsd?: number[] | null;
  costCheckpointApprovedUsd?: number | null;
  costUnpricedAcknowledged?: boolean;
  dailyBudget?: { budgetUsd: number; spentUsd: number } | null;
}

export interface ApprovalPolicyInput {
  scope: GovernanceScope;
  status: SessionStatus;
  costUsd: number;
  toolCallCount: number;
  escalated: boolean;
}

export interface ApprovalPolicyDecision {
  effect: GovernancePolicyEffect;
  policy: GovernancePolicy | null;
  matchedPolicyIds: string[];
}

export interface HookApprovalPolicyDecision extends Omit<ApprovalPolicyDecision, "effect"> {
  effect: GovernancePolicyEffect | "defer";
}

export type ParsedPolicyHookRequest =
  | { ok: true; value: PolicyHookEvaluationRequest }
  | { ok: false; error: string };

/** Validate the content-minimized hook envelope before it can influence policy selectors. */
export function parsePolicyHookRequest(input: unknown): ParsedPolicyHookRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "policy hook request must be an object" };
  }
  const raw = input as Record<string, unknown>;
  const keys = new Set([
    "hookEventName",
    "providerSessionId",
    "permissionMode",
    "toolUseId",
    "context",
    "transportRecoveredFrom",
    "approvalRequestId",
  ]);
  if (Object.keys(raw).some((key) => !keys.has(key))) {
    return { ok: false, error: "policy hook request contains unsupported fields" };
  }
  if (!["PreToolUse", "PostToolUse", "UserPromptSubmit"].includes(String(raw.hookEventName))) {
    return { ok: false, error: "policy hook event is unsupported" };
  }
  if (typeof raw.providerSessionId !== "string" || !raw.providerSessionId || raw.providerSessionId.length > 256) {
    return { ok: false, error: "providerSessionId must be a bounded non-empty string" };
  }
  for (const [key, limit] of [
    ["permissionMode", 64],
    ["toolUseId", 512],
    ["approvalRequestId", 128],
  ] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "string" || !value || value.length > limit)) {
      return { ok: false, error: `${key} must be a bounded non-empty string` };
    }
  }
  if (raw.transportRecoveredFrom !== undefined &&
      (!Number.isSafeInteger(raw.transportRecoveredFrom) || (raw.transportRecoveredFrom as number) < 0)) {
    return { ok: false, error: "transportRecoveredFrom must be a non-negative safe integer" };
  }
  let context: PolicyHookEvaluationRequest["context"];
  if (raw.context !== undefined) {
    if (!raw.context || typeof raw.context !== "object" || Array.isArray(raw.context)) {
      return { ok: false, error: "policy hook context must be an object" };
    }
    const source = raw.context as Record<string, unknown>;
    const contextKeys = new Set(["toolName", "path", "network", "branch"]);
    if (Object.keys(source).some((key) => !contextKeys.has(key))) {
      return { ok: false, error: "policy hook context contains unsupported fields" };
    }
    context = {};
    for (const key of contextKeys) {
      const value = source[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) {
        return { ok: false, error: `policy hook context ${key} is invalid` };
      }
      context[key as keyof typeof context] = value;
    }
  }
  return {
    ok: true,
    value: {
      hookEventName: raw.hookEventName as PolicyHookEvaluationRequest["hookEventName"],
      providerSessionId: raw.providerSessionId,
      ...(typeof raw.permissionMode === "string" ? { permissionMode: raw.permissionMode } : {}),
      ...(typeof raw.toolUseId === "string" ? { toolUseId: raw.toolUseId } : {}),
      ...(typeof raw.approvalRequestId === "string"
        ? { approvalRequestId: raw.approvalRequestId }
        : {}),
      ...(context ? { context } : {}),
      ...(typeof raw.transportRecoveredFrom === "number"
        ? { transportRecoveredFrom: raw.transportRecoveredFrom }
        : {}),
    },
  };
}

/** The conductor may orchestrate broad changes, but no stored rule may silently auto-approve its
 * requests. Keeping this invariant as ordinary policy data makes precedence inspectable/testable. */
export function conductorSafetyPolicy(now = 0): GovernancePolicy {
  return {
    policyId: "builtin:conductor-human-gate",
    name: "Conductor actions require review",
    effect: "ask",
    priority: 1_000_000,
    enabled: true,
    builtin: true,
    scope: { agentId: "conductor" },
    createdAt: now,
    updatedAt: now,
  };
}

const EFFECT_ORDER: Record<GovernancePolicyEffect, number> = { deny: 3, ask: 2, allow: 1 };

/** Highest priority wins; at equal priority fail closed (deny > ask > allow), then stable id. */
export function evaluateApprovalPolicies(
  input: ApprovalPolicyInput,
  policies: GovernancePolicy[],
): ApprovalPolicyDecision {
  const matched = policies
    .filter((policy) => policy.enabled && policyMatches(policy, input))
    .sort((a, b) => b.priority - a.priority || EFFECT_ORDER[b.effect] - EFFECT_ORDER[a.effect] || a.policyId.localeCompare(b.policyId));
  return {
    effect: matched[0]?.effect ?? "ask",
    policy: matched[0] ?? null,
    matchedPolicyIds: matched.map((policy) => policy.policyId),
  };
}

/** No matching manager policy must preserve the provider's own permission system. A matched ask
 * remains explicit for Phase 4 to pause and resolve. */
export function evaluateHookApprovalPolicies(
  input: ApprovalPolicyInput,
  policies: GovernancePolicy[],
): HookApprovalPolicyDecision {
  const decision = evaluateApprovalPolicies(input, policies);
  return decision.policy ? decision : { ...decision, effect: "defer" };
}

export function policyMatches(policy: GovernancePolicy, input: ApprovalPolicyInput): boolean {
  const selectors = policy.scope;
  for (const key of ["organizationId", "runnerId", "workspaceId", "agentId", "toolName", "path", "network", "branch"] as const) {
    const pattern = selectors[key];
    if (pattern === undefined) continue;
    const matches = key === "path"
      ? pathPatternMatches(input.scope.path, pattern)
      : key === "network"
        ? networkPatternMatches(input.scope.network, pattern)
        : scopePatternMatches(input.scope[key], pattern);
    if (!matches) return false;
  }
  const c = policy.conditions;
  if (!c) return true;
  if (c.statuses?.length && !c.statuses.includes(input.status)) return false;
  if (c.minCostUsd !== undefined && input.costUsd < c.minCostUsd) return false;
  if (c.maxCostUsd !== undefined && input.costUsd > c.maxCostUsd) return false;
  if (c.minToolCalls !== undefined && input.toolCallCount < c.minToolCalls) return false;
  if (c.maxToolCalls !== undefined && input.toolCallCount > c.maxToolCalls) return false;
  if (c.escalated !== undefined && input.escalated !== c.escalated) return false;
  return true;
}

/** Exact matching unless the selector contains `*`; missing input never matches a populated rule. */
export function scopePatternMatches(value: string | undefined, pattern: string): boolean {
  if (value === undefined) return false;
  if (!pattern.includes("*")) return value === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function wildcardRegex(pattern: string, star: string): RegExp {
  const placeholder = "\u0000";
  const escaped = pattern
    .replace(/\*\*/g, placeholder)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, star)
    .replaceAll(placeholder, ".*");
  return new RegExp(`^${escaped}$`, "u");
}

function windowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.includes("\\");
}

function normalizedPath(value: string): string | null {
  if (!value || value.includes("\0")) return null;
  const windows = windowsPath(value);
  const normalized = (windows ? win32.normalize(value) : posix.normalize(value)).replaceAll("\\", "/");
  return windows ? normalized.toLowerCase() : normalized;
}

/** Path wildcards are segment-aware: `*` cannot cross `/`; `**` is explicit recursion. */
export function pathPatternMatches(value: string | undefined, pattern: string): boolean {
  if (value === undefined) return false;
  const normalizedValue = normalizedPath(value);
  const normalizedPattern = normalizedPath(pattern);
  if (!normalizedValue || !normalizedPattern) return false;
  return wildcardRegex(normalizedPattern, "[^/]*").test(normalizedValue);
}

function hostPatternMatches(host: string, pattern: string): boolean {
  return wildcardRegex(pattern.toLowerCase(), "[^.:/]*").test(host.toLowerCase());
}

/** URL selectors match parsed scheme/host/path components, so userinfo cannot spoof the host. A
 * host-only selector (for example `*.example.com`) matches only the parsed hostname/port. */
export function networkPatternMatches(value: string | undefined, pattern: string): boolean {
  if (value === undefined) return false;
  if (value === "requested" || pattern === "requested") return value === pattern;
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // Host-only provider context remains useful, but never treat a slash/userinfo-bearing string
    // as a host because `api.example.com@evil.com/x` would become ambiguous.
    if (/[/@\s]/.test(value)) return false;
  }
  if (url?.username || url?.password) return false;
  if (!pattern.includes("://")) {
    const host = url ? url.host : value;
    return hostPatternMatches(host, pattern);
  }
  if (!url || /[?#@\s]/.test(pattern)) return false;
  const split = pattern.match(/^([^:]+):\/\/([^/]+)(\/.*)?$/);
  if (!split) return false;
  const [, schemePattern, hostPattern, pathPattern = "/"] = split;
  return scopePatternMatches(url.protocol.slice(0, -1), schemePattern!)
    && hostPatternMatches(url.host, hostPattern!)
    && pathPatternMatches(url.pathname, pathPattern);
}

export function validateGovernancePolicy(policy: Omit<GovernancePolicy, "createdAt" | "updatedAt">): string | null {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return "policy must be an object";
  const topKeys = new Set([
    "policyId",
    "name",
    "effect",
    "priority",
    "enabled",
    "scope",
    "conditions",
    "askTimeout",
  ]);
  if (Object.keys(policy).some((key) => !topKeys.has(key))) return "policy contains unsupported fields";
  if (typeof policy.policyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(policy.policyId) || policy.policyId.startsWith("builtin:")) {
    return "policyId must be a non-builtin identifier of at most 128 characters";
  }
  if (typeof policy.name !== "string" || !policy.name.trim() || policy.name.length > 160) return "name must be between 1 and 160 characters";
  if (!(["allow", "deny", "ask"] as unknown[]).includes(policy.effect)) return "effect must be allow, deny, or ask";
  if (!Number.isInteger(policy.priority) || policy.priority < -100_000 || policy.priority > 100_000) {
    return "priority must be an integer between -100000 and 100000";
  }
  if (typeof policy.enabled !== "boolean") return "stored policies must have a boolean enabled flag";
  if (policy.askTimeout !== undefined &&
      (!Number.isSafeInteger(policy.askTimeout) || policy.askTimeout < 1 || policy.askTimeout > 2_000_000)) {
    return "askTimeout must be an integer between 1 and 2000000 seconds";
  }
  if (policy.effect !== "ask" && policy.askTimeout !== undefined) {
    return "askTimeout is only valid for ask policies";
  }
  if (!policy.scope || typeof policy.scope !== "object" || Array.isArray(policy.scope)) return "scope must be an object";
  const scopeKeys = new Set(["organizationId", "runnerId", "workspaceId", "agentId", "toolName", "path", "network", "branch"]);
  if (Object.keys(policy.scope).some((key) => !scopeKeys.has(key))) return "scope contains unsupported fields";
  const scopeValues = Object.values(policy.scope);
  if (!scopeValues.length || scopeValues.some((value) => typeof value !== "string" || !value || value.length > 1024)) {
    return "scope must contain at least one non-empty bounded selector";
  }
  const narrowingScope = [policy.scope.runnerId, policy.scope.workspaceId, policy.scope.agentId, policy.scope.toolName, policy.scope.path, policy.scope.network, policy.scope.branch];
  if (policy.effect === "allow" && narrowingScope.every((value) => value === undefined)) {
    return "allow policies require a selector narrower than organization";
  }
  if (policy.scope.path) {
    const segments = policy.scope.path.replaceAll("\\", "/").split("/");
    if ((!posix.isAbsolute(policy.scope.path) && !win32.isAbsolute(policy.scope.path)) || segments.includes("..")) {
      return "path selectors must be absolute and cannot contain '..' segments";
    }
  }
  if (policy.scope.network && policy.scope.network !== "requested") {
    const network = policy.scope.network;
    const urlPattern = network.includes("://");
    if (/[?@#\s]/.test(network) || (!urlPattern && network.includes("/"))) {
      return "network selectors must be host patterns or credential-free URL patterns";
    }
  }
  const c = policy.conditions;
  if (!c) return null;
  if (typeof c !== "object" || Array.isArray(c)) return "conditions must be an object";
  const conditionKeys = new Set(["statuses", "minCostUsd", "maxCostUsd", "minToolCalls", "maxToolCalls", "escalated"]);
  if (Object.keys(c).some((key) => !conditionKeys.has(key))) return "conditions contains unsupported fields";
  if (c.statuses !== undefined && (!Array.isArray(c.statuses) || !c.statuses.length || c.statuses.some((status) => !(["queued", "starting", "running", "input_required", "idle", "completed", "failed", "stopped"] as unknown[]).includes(status)))) {
    return "conditions.statuses contains an invalid session status";
  }
  for (const value of [c.minCostUsd, c.maxCostUsd, c.minToolCalls, c.maxToolCalls]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return "numeric conditions must be finite and non-negative";
  }
  if (c.minToolCalls !== undefined && !Number.isInteger(c.minToolCalls)) return "tool-call conditions must be integers";
  if (c.maxToolCalls !== undefined && !Number.isInteger(c.maxToolCalls)) return "tool-call conditions must be integers";
  if (c.minCostUsd !== undefined && c.maxCostUsd !== undefined && c.minCostUsd > c.maxCostUsd) return "minimum cost exceeds maximum cost";
  if (c.minToolCalls !== undefined && c.maxToolCalls !== undefined && c.minToolCalls > c.maxToolCalls) return "minimum tool calls exceeds maximum tool calls";
  if (c.escalated !== undefined && typeof c.escalated !== "boolean") return "conditions.escalated must be boolean";
  if (policy.effect === "allow" && c.escalated !== undefined) {
    return "allow policies cannot depend on runner-asserted escalation state";
  }
  return null;
}

/**
 * Build the rule list from a session's flattened guardrail fields. The fixed order here IS the
 * precedence order when several rules trip at once: the organization's daily allowance first (it
 * outranks anything the session set for itself), then the unpriced fail-closed check (a budget
 * that cannot see spend is no budget), then the next soft checkpoint, then the hard budget, then
 * the tool-call limit.
 */
export function rulesFromSession(s: GuardrailFields): PolicyRule[] {
  const rules: PolicyRule[] = [];
  if (s.dailyBudget && s.dailyBudget.budgetUsd > 0) {
    rules.push({ kind: "daily_budget", budgetUsd: s.dailyBudget.budgetUsd, spentUsd: s.dailyBudget.spentUsd });
  }
  const hasBudget = s.costBudgetUsd != null && s.costBudgetUsd > 0;
  const checkpoints = (s.costCheckpointsUsd ?? []).filter((usd) => Number.isFinite(usd) && usd > 0).sort((a, b) => a - b);
  if ((hasBudget || checkpoints.length > 0) && !s.costUnpricedAcknowledged) rules.push({ kind: "cost_unpriced" });
  const approved = s.costCheckpointApprovedUsd ?? 0;
  // Only the next unapproved checkpoint is a rule: approving it advances `approved`, and the one
  // after it becomes the rule on the next evaluation.
  const next = checkpoints.find((usd) => usd > approved && (!hasBudget || usd < s.costBudgetUsd!));
  if (next != null) rules.push({ kind: "cost_checkpoint", checkpointUsd: next });
  if (hasBudget) rules.push({ kind: "cost_budget", budgetUsd: s.costBudgetUsd! });
  if (s.maxToolCalls != null && s.maxToolCalls > 0) rules.push({ kind: "max_tool_calls", maxCalls: s.maxToolCalls });
  return rules;
}

/** Validate and normalize a checkpoint list from user input: finite, positive, ascending, unique,
 * at most eight. Returns null when nothing usable remains. */
export function normalizeCostCheckpoints(input: unknown): number[] | null {
  if (!Array.isArray(input)) return null;
  const values = [...new Set(input
    .map((value) => (typeof value === "string" ? Number(value) : value))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .map((value) => Math.round(value * 100) / 100)
    // Positivity is checked AFTER cent rounding: 0.001 would otherwise persist as a $0 checkpoint
    // that looks configured and never gates.
    .filter((value) => value >= 0.01))].sort((a, b) => a - b);
  return values.length > 0 ? values.slice(0, 8) : null;
}

/**
 * Cost-budget decision. Returns "ask" once accumulated cost reaches the budget, else "ok". No
 * budget (null/≤0) or an already-ended session ⇒ "ok".
 */
export function budgetDecision(
  costUsd: number,
  budgetUsd: number | null | undefined,
  status: SessionStatus,
): "ok" | "ask" {
  if (budgetUsd == null || budgetUsd <= 0) return "ok";
  if (isTerminal(status)) return "ok";
  return costUsd >= budgetUsd ? "ask" : "ok";
}

/** Evaluate every rule against the session state. Terminal sessions never ask (nothing to park). */
export function evaluatePolicies(input: PolicyInput, rules: PolicyRule[]): PolicyDecision[] {
  return rules.map((rule) => {
    if (isTerminal(input.status)) return { rule, decision: "ok" };
    if (rule.kind === "cost_budget") {
      if (input.costUsd >= rule.budgetUsd) {
        return {
          rule,
          decision: "ask",
          title: `Cost budget reached — $${input.costUsd.toFixed(2)} of $${rule.budgetUsd.toFixed(2)}. Continue?`,
        };
      }
      return { rule, decision: "ok" };
    }
    if (rule.kind === "cost_checkpoint") {
      if (input.costUsd >= rule.checkpointUsd) {
        return {
          rule,
          decision: "ask",
          title: `Cost checkpoint — $${input.costUsd.toFixed(2)} of $${rule.checkpointUsd.toFixed(2)}. Continue?`,
        };
      }
      return { rule, decision: "ok" };
    }
    if (rule.kind === "cost_unpriced") {
      if (input.unpriced) {
        return {
          rule,
          decision: "ask",
          title: "Usage cannot be priced — this model has no rate, so the cost budget cannot be enforced. Continue without it?",
        };
      }
      return { rule, decision: "ok" };
    }
    if (rule.kind === "daily_budget") {
      if (rule.spentUsd >= rule.budgetUsd) {
        return {
          rule,
          decision: "ask",
          title: `Daily budget reached — $${rule.spentUsd.toFixed(2)} of $${rule.budgetUsd.toFixed(2)} today across your sessions. New turns pause until the day rolls over or an owner or admin raises it.`,
        };
      }
      return { rule, decision: "ok" };
    }
    // max_tool_calls
    if (input.toolCallCount >= rule.maxCalls) {
      return {
        rule,
        decision: "ask",
        title: `Tool-call limit reached — ${input.toolCallCount} of ${rule.maxCalls} tool calls. Continue?`,
      };
    }
    return { rule, decision: "ok" };
  });
}

/**
 * The single ask that wins the (one) PendingApproval slot: first in rule order. Remaining asks are
 * SERIALIZED — approve-continue clears the raising rule and re-runs the gate, so the next tripped
 * rule parks immediately with its own card.
 */
export function firstAsk(decisions: PolicyDecision[]): PolicyDecision | null {
  return decisions.find((d) => d.decision === "ask") ?? null;
}

/** The approval card for an ask — same shape/options the shipped Phase 7 cost gate used. */
export function approvalForDecision(d: PolicyDecision, sessionId: string, now: number): PendingApproval {
  const prefix = d.rule.kind.replaceAll("_", "-");
  return {
    requestId: `${prefix}:${sessionId}:${now}`,
    kind: d.rule.kind,
    title: d.title ?? "Guardrail reached. Continue?",
    options: [
      // For daily_budget, Continue re-checks the allowance rather than overriding it: the card
      // clears only once the day rolled over or an owner or admin raised the budget.
      { optionId: "continue", name: d.rule.kind === "daily_budget" ? "Check Again" : "Continue", kind: "allow_once" },
      { optionId: "cancel", name: "Stop", kind: "reject_once" },
    ],
  };
}
