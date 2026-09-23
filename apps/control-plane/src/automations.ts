import { createHash, randomUUID } from "node:crypto";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import type {
  AutomationAction,
  AutomationAuditEvent,
  AutomationExecution,
  AutomationInstallationBindings,
  AutomationNotificationEvent,
  AutomationRunnerTarget,
  AutomationSchedule,
  AutomationSpec,
  AutomationTriggerCredential,
  AutomationTriggerDeliveryMetadata,
  AutomationTriggerDeliveryPolicy,
  AutomationTriggerInvocationView,
  AutomationTriggerInvocationResult,
  AutomationTriggerSessionSelector,
  AutomationTriggerView,
  CreateAutomationTriggerRequest,
  CreateAutomationRequest,
  DurableSessionCommand,
  DurableSessionCommandResultMessage,
  DurableSessionCommandUpdateMessage,
  GovernanceActor,
  UpdateAutomationRequest,
} from "@wollipog/protocol";
import type { AutomationCommandRecord, AutomationTriggerInvocationRecord, ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import {
  capabilityConfigError,
  claudeModelConfigForValidation,
  type PreStagedDeliveryOptions,
  type PreStagedDeliveryPlan,
  type ServiceResult,
  type SessionsService,
} from "./sessions.js";
import { nextCronFire, parseCron, validateTimeZone } from "./automation-schedule.js";
import { automationCommandDigest, AutomationCommandOutbox } from "./automation-command-outbox.js";
import {
  automationTriggerBodySha256,
  newAutomationTriggerSecret,
  parseAutomationTriggerBody,
  verifyAutomationTriggerSignature,
  type AutomationTriggerHeaders,
  type ParsedAutomationTriggerBody,
} from "./automation-trigger-ingress.js";

const MAX_STORED_ACTION_BYTES = 64 * 1024;
const MISFIRE_GRACE_MS = 60_000;
const MAX_MISSED_OCCURRENCES = 10_000;
const COMMAND_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** How long an execution may hold an automation while nothing of its plan has reached a runner.
 * The retention horizon above is a storage bound, not a scheduling one: waiting it out parks a
 * `wait` automation for a month over a single unreachable runner. The automation's own cadence is
 * the honest limit — once the next occurrence is due, this one is a loss. The floor stays well
 * clear of the bounded provider-retry chain, whose last replacement is due four minutes after the
 * refusal that produced it, and the ceiling keeps a daily or weekly automation from parking a dead
 * occurrence for its whole period. */
const MIN_DELIVERY_BOUND_MS = 30 * 60_000;
const MAX_DELIVERY_BOUND_MS = 12 * 60 * 60_000;

function automationDeliveryWindowMs(schedule: AutomationSchedule, scheduledFor: number): number {
  const cadence = nextCronFire(schedule.cron, schedule.timezone, scheduledFor) - scheduledFor;
  return Math.min(MAX_DELIVERY_BOUND_MS, Math.max(MIN_DELIVERY_BOUND_MS, cadence));
}

type Logger = { info: (message: string) => void; warn: (message: string) => void };
type AutomationNotifier = (
  automation: AutomationSchedule,
  execution: AutomationExecution,
  event: AutomationNotificationEvent,
) => void;

function ok<T>(data: T, status = 200): ServiceResult<T> {
  return { ok: true, status, data };
}
function fail<T>(error: string, status = 400): ServiceResult<T> {
  return { ok: false, status, error };
}
function shortId(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "").slice(0, 12);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}
function boundedString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function triggerInvocationView(invocation: AutomationTriggerInvocationRecord): AutomationTriggerInvocationView {
  return {
    invocationId: invocation.invocationId,
    triggerId: invocation.triggerId,
    eventId: invocation.eventId,
    state: invocation.state,
    receivedAt: invocation.receivedAt,
    updatedAt: invocation.updatedAt,
    ...(invocation.executionId ? { executionId: invocation.executionId } : {}),
    ...(invocation.delivery ? { delivery: invocation.delivery } : {}),
  };
}

function automationExecutionView(execution: AutomationExecution): AutomationExecution {
  if (!execution.triggerDelivery) return execution;
  const { specSnapshot: _secretBearingAcceptedSnapshot, ...view } = execution;
  return view;
}

const DELIVERY_PARAMETER_REFERENCE = /\{\{delivery\.parameters\.([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;
const DELIVERY_REFERENCE = /\{\{delivery\.[^{}]+\}\}/g;
const DELIVERY_TEMPLATE_REFERENCE = /\{\{delivery\.(prompt|parameters\.([A-Za-z][A-Za-z0-9_]{0,63}))\}\}/g;
const DELIVERY_PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DELIVERY_SELECTORS = ["session_id", "branch", "pull_request"] as const;

function actionPrompt(action: AutomationAction): string {
  if (action.kind === "create_session") return action.request.prompt ?? "";
  if (action.kind === "prompt_session") return action.request.text ?? "";
  return action.request.task;
}

function validateTriggerDeliveryPolicy(
  value: unknown,
  action: AutomationAction,
): ServiceResult<AutomationTriggerDeliveryPolicy | undefined> {
  if (value === undefined) return ok(undefined);
  if (!object(value) || !keysOnly(value, ["allowPrompt", "parameterNames", "missingReferences", "sessionSelectors"]) ||
      typeof value.allowPrompt !== "boolean" || !Array.isArray(value.parameterNames) ||
      value.parameterNames.length > 16 || new Set(value.parameterNames).size !== value.parameterNames.length ||
      value.parameterNames.some((name) => typeof name !== "string" || !DELIVERY_PARAMETER_NAME.test(name)) ||
      !["reject", "use_stored"].includes(String(value.missingReferences)) ||
      (value.sessionSelectors !== undefined && (!Array.isArray(value.sessionSelectors) ||
        value.sessionSelectors.length > DELIVERY_SELECTORS.length ||
        new Set(value.sessionSelectors).size !== value.sessionSelectors.length ||
        value.sessionSelectors.some((selector) => !DELIVERY_SELECTORS.includes(selector as AutomationTriggerSessionSelector))))) {
    return fail("automation trigger delivery policy is malformed");
  }
  const policy = value as unknown as AutomationTriggerDeliveryPolicy;
  if (!policy.allowPrompt && !policy.parameterNames.length && !policy.sessionSelectors?.length) {
    return fail("automation trigger delivery policy must allow at least one delivery field");
  }
  if (action.kind === "workflow_run") {
    return fail("automation trigger delivery fields are available only for session actions");
  }
  if (policy.sessionSelectors?.length && action.kind !== "prompt_session") {
    return fail("session selectors are available only for prompt-session automations");
  }
  const template = actionPrompt(action);
  const parameterReferences = [...template.matchAll(DELIVERY_PARAMETER_REFERENCE)].map((match) => match[1]!);
  const unknownReferences = template.match(DELIVERY_REFERENCE)?.filter((reference) =>
    reference !== "{{delivery.prompt}}" && !/^\{\{delivery\.parameters\.[A-Za-z][A-Za-z0-9_]{0,63}\}\}$/.test(reference)) ?? [];
  if (unknownReferences.length) return fail(`unsupported delivery template reference ${unknownReferences[0]}`);
  if (template.includes("{{delivery.prompt}}") && !policy.allowPrompt) {
    return fail("the automation prompt references delivery.prompt but the trigger does not allow prompt");
  }
  const allowedParameters = new Set(policy.parameterNames);
  const unavailable = parameterReferences.find((name) => !allowedParameters.has(name));
  if (unavailable) {
    return fail(`the automation prompt references delivery parameter '${unavailable}' outside the trigger allowlist`);
  }
  return ok(policy);
}

function validateTarget(value: unknown, kind: AutomationAction["kind"]): value is AutomationRunnerTarget {
  if (!object(value) || !keysOnly(value, [
    "runnerId", "workspaceId", "projectId", "projectLocationId", "agentId", "agentBindings", "orchestratorAgentId", "installationBindings",
  ]) || !boundedString(value.runnerId) || !boundedString(value.workspaceId) || !validProjectAssignment(value)) return false;
  if (kind === "create_session" && !boundedString(value.agentId)) return false;
  if (kind === "workflow_run" && value.agentId !== undefined) return false;
  if (value.agentBindings !== undefined && (!object(value.agentBindings) ||
      Object.keys(value.agentBindings).length > 32 ||
      Object.entries(value.agentBindings).some(([key, entry]) => !boundedString(key) || !boundedString(entry)))) return false;
  return (value.orchestratorAgentId === undefined || boundedString(value.orchestratorAgentId)) &&
    validInstallationBindings(value.installationBindings);
}

function validInstallationBindings(value: unknown): value is AutomationInstallationBindings | undefined {
  return value === undefined || (object(value) && Object.keys(value).length <= 34 &&
    Object.entries(value).every(([key, entry]) =>
      (key === "agent" || key === "orchestrator" || /^role:[^\x00-\x1f\x7f]{1,256}$/.test(key)) &&
      object(entry) && keysOnly(entry, ["driver", "context", "installationId"]) &&
      ["acp", "claude-code", "codex", "codex-app-server", "pi"].includes(String(entry.driver)) &&
      boundedString(entry.installationId) && object(entry.context) &&
      (entry.context.kind === "native" && keysOnly(entry.context, ["kind"]) ||
        entry.context.kind === "wsl" && keysOnly(entry.context, ["kind", "distro"]) &&
        boundedString(entry.context.distro))));
}

function validProjectAssignment(value: Record<string, unknown>): boolean {
  const explicit = value.projectId !== undefined || value.projectLocationId !== undefined;
  if (!explicit) return true;
  if (value.projectId === null) return value.projectLocationId == null;
  return boundedString(value.projectId) && boundedString(value.projectLocationId);
}

function validConfig(value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value) || !keysOnly(value, ["model", "effort", "permissionMode", "costBudgetUsd", "maxToolCalls", "costCheckpointsUsd"])) return false;
  if (value.costCheckpointsUsd !== undefined && (!Array.isArray(value.costCheckpointsUsd) ||
      !value.costCheckpointsUsd.every((usd) => Number.isFinite(usd) && Number(usd) > 0))) return false;
  for (const key of ["model", "effort", "permissionMode"] as const) {
    if (value[key] !== undefined && !boundedString(value[key])) return false;
  }
  return (value.costBudgetUsd === undefined || (Number.isFinite(value.costBudgetUsd) && Number(value.costBudgetUsd) > 0)) &&
    (value.maxToolCalls === undefined || (Number.isInteger(value.maxToolCalls) && Number(value.maxToolCalls) > 0));
}

function optionalString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function validBindings(value: unknown): boolean {
  return value === undefined || (object(value) && Object.keys(value).length <= 32 &&
    Object.entries(value).every(([key, entry]) => boundedString(key) && boundedString(entry)));
}

function validateAction(value: unknown): string | null {
  if (!object(value) || !boundedString(value.kind, 32)) return "automation action is malformed";
  if (value.kind === "create_session") {
    if (!keysOnly(value, ["kind", "request", "installationBindings"]) || !object(value.request) ||
        !validInstallationBindings(value.installationBindings)) return "create-session action is malformed";
    const request = value.request;
    if (!keysOnly(request, [
      "runnerId", "workspaceId", "projectId", "projectLocationId", "agentId", "title", "prompt", "useWorktree", "config",
    ]) ||
        !boundedString(request.runnerId) || !boundedString(request.workspaceId) || !boundedString(request.agentId) ||
        !validProjectAssignment(request) ||
        !optionalString(request.title, 120) || !optionalString(request.prompt, 65_536) ||
        (request.useWorktree !== undefined && typeof request.useWorktree !== "boolean") || !validConfig(request.config)) {
      return "create-session action requires a secret-free runner/workspace/agent request, an exact Project assignment when supplied, and cannot persist images or ACP context";
    }
  } else if (value.kind === "prompt_session") {
    if (!keysOnly(value, ["kind", "sessionId", "request"]) || !boundedString(value.sessionId) || !object(value.request) ||
        !keysOnly(value.request, ["text", "slashCommand", "config"]) ||
        !optionalString(value.request.text, 65_536) || !optionalString(value.request.slashCommand, 256) ||
        !validConfig(value.request.config) ||
        (!(typeof value.request.text === "string" && value.request.text.trim()) &&
          !(typeof value.request.slashCommand === "string" && value.request.slashCommand.trim()))) {
      return "prompt-session action requires a target and text or slash command, and cannot persist images";
    }
  } else if (value.kind === "workflow_run") {
    if (!keysOnly(value, ["kind", "request", "installationBindings"]) || !object(value.request) ||
        !validInstallationBindings(value.installationBindings)) return "workflow-run action is malformed";
    const request = value.request;
    if (!keysOnly(request, ["runnerId", "workspaceId", "projectId", "projectLocationId", "workflowId", "workflowVersion", "task", "title",
      "useWorktree", "config", "costBudgetUsd", "maxToolCalls", "agentBindings", "orchestratorAgentId"]) ||
        !boundedString(request.runnerId) || !boundedString(request.workspaceId) || !boundedString(request.workflowId) ||
        !validProjectAssignment(request) ||
        !boundedString(request.task, 65_536) || !optionalString(request.title, 120) ||
        (request.workflowVersion !== undefined && (!Number.isInteger(request.workflowVersion) || Number(request.workflowVersion) < 1)) ||
        (request.useWorktree !== undefined && typeof request.useWorktree !== "boolean") || !validConfig(request.config) ||
        !validBindings(request.agentBindings) ||
        (request.orchestratorAgentId !== undefined && !boundedString(request.orchestratorAgentId)) ||
        (request.costBudgetUsd !== undefined && (!Number.isFinite(request.costBudgetUsd) || Number(request.costBudgetUsd) <= 0)) ||
        (request.maxToolCalls !== undefined && (!Number.isInteger(request.maxToolCalls) || Number(request.maxToolCalls) < 1))) {
      return "workflow-run action requires a secret-free runner, workspace, workflow, task, and exact Project assignment when supplied";
    }
  } else {
    return "automation action kind is unsupported";
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_STORED_ACTION_BYTES) {
    return `automation action exceeds ${MAX_STORED_ACTION_BYTES} bytes`;
  }
  return null;
}

export function validateAutomationSpec(value: unknown): ServiceResult<AutomationSpec> {
  if (!object(value) || !keysOnly(value, [
    "name", "cron", "timezone", "enabled", "misfirePolicy", "runnerPolicy", "concurrencyPolicy",
    "limits", "notifications", "action",
  ])) return fail("automation request is malformed");
  if (!boundedString(value.name, 120) || typeof value.cron !== "string" || typeof value.timezone !== "string" ||
      typeof value.enabled !== "boolean") return fail("automation name, cron, timezone, and enabled state are required");
  try {
    parseCron(value.cron);
    validateTimeZone(value.timezone);
  } catch (error) {
    return fail((error as Error).message);
  }
  const actionError = validateAction(value.action);
  if (actionError) return fail(actionError);
  if (!object(value.misfirePolicy) || !keysOnly(value.misfirePolicy, ["kind", "maxRuns"]) ||
      !["skip", "fire_once", "catch_up"].includes(String(value.misfirePolicy.kind)) ||
      (value.misfirePolicy.kind === "catch_up" &&
        (!Number.isInteger(value.misfirePolicy.maxRuns) || Number(value.misfirePolicy.maxRuns) < 1 || Number(value.misfirePolicy.maxRuns) > 10)) ||
      (value.misfirePolicy.kind !== "catch_up" && value.misfirePolicy.maxRuns !== undefined)) {
    return fail("misfire policy is malformed");
  }
  if (!object(value.limits) || !keysOnly(value.limits, ["maxCostUsd", "maxToolCalls"]) ||
      !Number.isFinite(value.limits.maxCostUsd) || Number(value.limits.maxCostUsd) <= 0 || Number(value.limits.maxCostUsd) > 10_000 ||
      !Number.isInteger(value.limits.maxToolCalls) || Number(value.limits.maxToolCalls) < 1 || Number(value.limits.maxToolCalls) > 100_000) {
    return fail("automation requires finite positive cost and tool ceilings");
  }
  if (!object(value.notifications) || !keysOnly(value.notifications, ["pushEvents"]) ||
      !Array.isArray(value.notifications.pushEvents) || value.notifications.pushEvents.length > 4 ||
      new Set(value.notifications.pushEvents).size !== value.notifications.pushEvents.length ||
      value.notifications.pushEvents.some((event) => !["started", "succeeded", "failed", "expired"].includes(String(event)))) {
    return fail("automation notification routing is malformed");
  }
  if (!["wait", "skip", "parallel"].includes(String(value.concurrencyPolicy))) {
    return fail("automation concurrency policy is malformed");
  }
  const action = value.action as AutomationAction;
  if (action.kind === "prompt_session" && value.concurrencyPolicy === "parallel") {
    return fail("prompt-session automations cannot run in parallel");
  }
  if (!object(value.runnerPolicy) || !boundedString(value.runnerPolicy.kind, 16) ||
      !["wait", "expire", "alternate"].includes(value.runnerPolicy.kind)) return fail("runner policy is malformed");
  if (value.runnerPolicy.kind === "wait") {
    if (!keysOnly(value.runnerPolicy, ["kind"])) return fail("wait runner policy is malformed");
  } else if (value.runnerPolicy.kind === "expire") {
    if (!keysOnly(value.runnerPolicy, ["kind", "afterMinutes"]) || !Number.isInteger(value.runnerPolicy.afterMinutes) ||
        Number(value.runnerPolicy.afterMinutes) < 1 || Number(value.runnerPolicy.afterMinutes) > 43_200) {
      return fail("expire runner policy requires 1-43200 minutes");
    }
  } else {
    if (!keysOnly(value.runnerPolicy, ["kind", "targets", "expireAfterMinutes"]) ||
        !Array.isArray(value.runnerPolicy.targets) || value.runnerPolicy.targets.length < 1 || value.runnerPolicy.targets.length > 8 ||
        value.runnerPolicy.targets.some((target) => !validateTarget(target, action.kind)) ||
        new Set(value.runnerPolicy.targets.map((target) => (target as AutomationRunnerTarget).runnerId)).size !== value.runnerPolicy.targets.length ||
        (value.runnerPolicy.expireAfterMinutes !== undefined && (!Number.isInteger(value.runnerPolicy.expireAfterMinutes) ||
          Number(value.runnerPolicy.expireAfterMinutes) < 1 || Number(value.runnerPolicy.expireAfterMinutes) > 43_200))) {
      return fail("alternate runner policy requires unique explicit compatible targets and an optional bounded expiry");
    }
    if (action.kind === "prompt_session") return fail("prompt-session automations cannot move provider state to an alternate runner");
    if (value.runnerPolicy.targets.some((target) =>
      action.request.projectId === undefined
        ? target.projectId !== undefined || target.projectLocationId !== undefined
        : target.projectId !== action.request.projectId ||
          (action.request.projectId === null && target.projectLocationId != null))) {
      return fail("alternate runner targets must preserve the action's Project identity");
    }
  }
  return ok(value as unknown as AutomationSpec);
}

function automationCapabilityError(
  db: ControlPlaneDb,
  sessions: SessionsService,
  spec: AutomationSpec,
): string | null {
  if (spec.action.kind === "create_session") {
    const request = spec.action.request;
    const config = request.config;
    if (!config) return null;
    const targets = [
      { runnerId: request.runnerId, workspaceId: request.workspaceId, agentId: request.agentId,
        installationBindings: spec.action.installationBindings },
      ...(spec.runnerPolicy.kind === "alternate" ? spec.runnerPolicy.targets : []),
    ];
    for (const target of targets) {
      const agentId = target.installationBindings?.agent
        ? db.resolveSavedHarnessInstallation(target.runnerId, target.installationBindings.agent)
        : target.agentId;
      if (!agentId) continue; // Shape validation requires this for create-session targets.
      const agent = db.getRunner(target.runnerId)?.agents.find((candidate) => candidate.id === agentId);
      if (!agent) continue;
      const validationConfig = claudeModelConfigForValidation(config, agent.capabilities, agent.driver ?? "acp");
      const error = capabilityConfigError(validationConfig, agent.capabilities);
      if (error) {
        const identity = `${target.runnerId}/${target.workspaceId}/${agentId}`;
        return `automation target ${JSON.stringify(identity)} cannot honor config: ${error}`;
      }
    }
    return null;
  }
  if (spec.action.kind !== "workflow_run") return null;
  const request = spec.action.request;
  const primary: AutomationRunnerTarget = {
    runnerId: request.runnerId,
    workspaceId: request.workspaceId,
    ...(request.agentBindings ? { agentBindings: request.agentBindings } : {}),
    ...(request.orchestratorAgentId ? { orchestratorAgentId: request.orchestratorAgentId } : {}),
    ...(spec.action.installationBindings ? { installationBindings: spec.action.installationBindings } : {}),
  };
  const targets = spec.runnerPolicy.kind === "alternate"
    ? [primary, ...spec.runnerPolicy.targets]
    : [primary];
  for (const target of targets) {
    const agentBindings = { ...(request.agentBindings ?? {}), ...(target.agentBindings ?? {}) };
    const definition = db.getWorkflowDefinition(request.workflowId, request.workflowVersion);
    let unavailableBinding = false;
    for (const node of definition?.nodes ?? []) {
      if (node.kind !== "agent") continue;
      const saved = target.installationBindings?.[`role:${node.agentId!}`];
      if (!saved) continue;
      const resolved = db.resolveSavedHarnessInstallation(target.runnerId, saved);
      if (!resolved) { unavailableBinding = true; break; }
      agentBindings[node.agentId!] = resolved;
    }
    if (unavailableBinding) continue;
    const orchestrator = target.installationBindings?.orchestrator
      ? db.resolveSavedHarnessInstallation(target.runnerId, target.installationBindings.orchestrator)
      : target.orchestratorAgentId ?? request.orchestratorAgentId;
    if (target.installationBindings?.orchestrator && !orchestrator) continue;
    const error = sessions.workflowRunCapabilityError({
      ...request,
      runnerId: target.runnerId,
      workspaceId: target.workspaceId,
      ...(Object.keys(agentBindings).length ? { agentBindings } : {}),
      ...(orchestrator ? { orchestratorAgentId: orchestrator } : {}),
    });
    if (error) {
      const identity = `${target.runnerId}/${target.workspaceId}`;
      return `automation target ${JSON.stringify(identity)} cannot honor workflow config: ${error}`;
    }
  }
  return null;
}

/** Upgrade plain ids when their current exact installation is known. An unresolved old id stays
 * unchanged and the launch gate refuses it; guessing from a same-name candidate would retarget it. */
function pinAutomationSpec(db: ControlPlaneDb, spec: AutomationSpec, previous?: AutomationSchedule): AutomationSpec {
  if (spec.action.kind === "prompt_session") return spec;
  const pin = (runnerId: string, ids: Record<string, string>, existing?: AutomationInstallationBindings,
    old?: { runnerId: string; ids: Record<string, string>; bindings?: AutomationInstallationBindings }) => {
    const bindings = { ...existing };
    for (const [key, agentId] of Object.entries(ids)) {
      if (old && (old.runnerId !== runnerId || old.ids[key] !== agentId)) delete bindings[key];
      if (bindings[key]) continue;
      if (old?.runnerId === runnerId && old.ids[key] === agentId) {
        // Omitted metadata comes from older clients and preserves the pin. An explicit empty map
        // means the operator reselected the same plain id after rediscovery; capture its current
        // installation (or leave a config-authored agent unbound).
        if (existing === undefined) {
          if (old.bindings?.[key]) bindings[key] = old.bindings[key];
        } else {
          const selected = db.savedHarnessInstallation(runnerId, agentId);
          if (selected) bindings[key] = selected;
        }
        continue;
      }
      const saved = db.savedHarnessInstallation(runnerId, agentId);
      if (saved) bindings[key] = saved;
    }
    return Object.keys(bindings).length ? bindings : undefined;
  };
  if (spec.action.kind === "create_session") {
    const action = spec.action;
    const oldAction = previous?.action.kind === "create_session" ? previous.action : undefined;
    const primary = pin(action.request.runnerId, { agent: action.request.agentId }, action.installationBindings,
      oldAction ? { runnerId: oldAction.request.runnerId, ids: { agent: oldAction.request.agentId },
        bindings: oldAction.installationBindings } : undefined);
    return {
      ...spec,
      action: { ...action, ...(primary ? { installationBindings: primary } : {}) },
      runnerPolicy: spec.runnerPolicy.kind !== "alternate" ? spec.runnerPolicy : {
        ...spec.runnerPolicy,
        targets: spec.runnerPolicy.targets.map((target, index) => {
          const oldTarget = previous?.runnerPolicy.kind === "alternate" ? previous.runnerPolicy.targets[index] : undefined;
          const bindings = pin(target.runnerId, { agent: target.agentId! }, target.installationBindings,
            oldTarget ? { runnerId: oldTarget.runnerId, ids: { agent: oldTarget.agentId! },
              bindings: oldTarget.installationBindings } : undefined);
          return { ...target, ...(bindings ? { installationBindings: bindings } : {}) };
        }),
      },
    };
  }
  const action = spec.action;
  const oldAction = previous?.action.kind === "workflow_run" &&
    previous.action.request.workflowId === action.request.workflowId &&
    previous.action.request.workflowVersion === action.request.workflowVersion
    ? previous.action : undefined;
  const definition = db.getWorkflowDefinition(action.request.workflowId, action.request.workflowVersion);
  if (!definition) return spec;
  const ids = (bindings: Record<string, string>, orchestrator?: string) => ({
    ...Object.fromEntries(definition.nodes.filter((node) => node.kind === "agent")
      .map((node) => [`role:${node.agentId!}`, bindings[node.agentId!] ?? node.agentId!])),
    ...(orchestrator ? { orchestrator } : {}),
  });
  const primary = pin(action.request.runnerId,
    ids(action.request.agentBindings ?? {}, action.request.orchestratorAgentId),
    previous && !oldAction ? undefined : action.installationBindings,
    oldAction ? { runnerId: oldAction.request.runnerId,
      ids: ids(oldAction.request.agentBindings ?? {}, oldAction.request.orchestratorAgentId),
      bindings: oldAction.installationBindings } : undefined);
  return {
    ...spec,
    action: { ...action, ...(primary ? { installationBindings: primary } : {}) },
    runnerPolicy: spec.runnerPolicy.kind !== "alternate" ? spec.runnerPolicy : {
      ...spec.runnerPolicy,
      targets: spec.runnerPolicy.targets.map((target, index) => {
        const oldTarget = previous?.runnerPolicy.kind === "alternate" ? previous.runnerPolicy.targets[index] : undefined;
        const bindings = pin(target.runnerId,
          ids({ ...(action.request.agentBindings ?? {}), ...(target.agentBindings ?? {}) },
            target.orchestratorAgentId ?? action.request.orchestratorAgentId),
          previous && !oldAction ? undefined : target.installationBindings,
          oldTarget && oldAction ? { runnerId: oldTarget.runnerId,
            ids: ids({ ...(oldAction.request.agentBindings ?? {}), ...(oldTarget.agentBindings ?? {}) },
              oldTarget.orchestratorAgentId ?? oldAction.request.orchestratorAgentId),
            bindings: oldTarget.installationBindings } : undefined);
        return { ...target, ...(bindings ? { installationBindings: bindings } : {}) };
      }),
    },
  };
}

interface DuePlan {
  occurrences: number[];
  future: number;
  overflow: number;
}

function duePlan(schedule: AutomationSchedule, now: number): DuePlan {
  const first = schedule.nextFireAt!;
  const occurrences: number[] = [first];
  let cursor = first;
  let overflow = 0;
  while (occurrences.length < MAX_MISSED_OCCURRENCES) {
    const next = nextCronFire(schedule.cron, schedule.timezone, cursor);
    if (next > now) return { occurrences, future: next, overflow };
    occurrences.push(next);
    cursor = next;
  }
  // Do not enumerate an unbounded minute-by-minute backlog after a long outage. The retained
  // window is still large enough for bounded catch-up; older overflow is summarized and skipped.
  return { occurrences, future: nextCronFire(schedule.cron, schedule.timezone, now), overflow: 1 };
}

export class AutomationsService {
  readonly commandOutbox: AutomationCommandOutbox;

  constructor(
    private readonly db: ControlPlaneDb,
    private readonly hub: Hub,
    private readonly sessions: SessionsService,
    private readonly log: Logger,
    private readonly notify?: AutomationNotifier,
  ) {
    this.commandOutbox = new AutomationCommandOutbox(
      db,
      hub,
      log,
      (executionId, now) => this.reconcileExecution(executionId, now),
    );
  }

  recover(now = Date.now()): number {
    const failed = this.db.failInterruptedAutomationExecutions(now);
    this.expireUndeliverableExecutions(now);
    this.resumeReceiptedExecutions(now);
    this.processPendingTriggerInvocations(now);
    this.commandOutbox.recover(now);
    this.reconcileRunning(now);
    return failed;
  }

  onDurableCommandReceipt(
    runnerId: string,
    message: DurableSessionCommandResultMessage | DurableSessionCommandUpdateMessage,
    now = Date.now(),
  ): boolean {
    return this.commandOutbox.receipt(runnerId, message, now);
  }

  list(): { automations: AutomationSchedule[] } {
    return { automations: this.db.listAutomations() };
  }

  get(automationId: string): ServiceResult<{
    automation: AutomationSchedule;
    executions: AutomationExecution[];
    events: AutomationAuditEvent[];
  }> {
    const automation = this.db.getAutomation(automationId);
    if (!automation) return fail("automation not found", 404);
    return ok({
      automation,
      executions: this.db.listAutomationExecutions(automationId).map(automationExecutionView),
      events: this.db.listAutomationEvents(automationId),
    });
  }

  create(input: CreateAutomationRequest, actor: GovernanceActor, now = Date.now()): ServiceResult<AutomationSchedule> {
    const parsed = validateAutomationSpec(input);
    if (!parsed.ok) return fail(parsed.error ?? "automation request is malformed", parsed.status);
    const spec = pinAutomationSpec(this.db, parsed.data!);
    const capabilityError = automationCapabilityError(this.db, this.sessions, spec);
    if (capabilityError) return fail(capabilityError, 409);
    let nextFireAt: number | null = null;
    try {
      nextFireAt = spec.enabled ? nextCronFire(spec.cron, spec.timezone, now) : null;
    } catch (error) {
      return fail((error as Error).message);
    }
    return ok(this.db.createAutomation({ automationId: shortId("auto_"), spec, nextFireAt, actor, now }), 201);
  }

  update(
    automationId: string,
    input: UpdateAutomationRequest,
    actor: GovernanceActor,
    now = Date.now(),
  ): ServiceResult<AutomationSchedule> {
    const previous = this.db.getAutomation(automationId);
    if (!previous) return fail("automation not found", 404);
    const parsed = validateAutomationSpec(input);
    if (!parsed.ok) return fail(parsed.error ?? "automation request is malformed", parsed.status);
    const spec = pinAutomationSpec(this.db, parsed.data!, previous);
    // Always allow disabling so capability drift cannot trap a failing automation in the enabled state.
    const capabilityError = spec.enabled ? automationCapabilityError(this.db, this.sessions, spec) : null;
    if (capabilityError) return fail(capabilityError, 409);
    let nextFireAt: number | null = null;
    try {
      nextFireAt = spec.enabled ? nextCronFire(spec.cron, spec.timezone, now) : null;
    } catch (error) {
      return fail((error as Error).message);
    }
    return ok(this.db.updateAutomation({ automationId, spec, nextFireAt, actor, now })!);
  }

  delete(automationId: string, actor: GovernanceActor, now = Date.now()): ServiceResult<{ deleted: true }> {
    if (!this.db.deleteAutomation(automationId, actor, now)) return fail("automation not found", 404);
    return ok({ deleted: true });
  }

  triggers(automationId: string): ServiceResult<{ triggers: AutomationTriggerView[] }> {
    if (!this.db.getAutomation(automationId)) return fail("automation not found", 404);
    return ok({ triggers: this.db.listAutomationTriggers(automationId) });
  }

  createTrigger(
    automationId: string,
    input: CreateAutomationTriggerRequest,
    actor: GovernanceActor,
    now = Date.now(),
  ): ServiceResult<AutomationTriggerCredential> {
    if (!object(input) || !keysOnly(input, ["kind", "name", "deliveryPolicy"]) ||
        !["webhook", "chatops"].includes(String(input.kind)) || !boundedString(input.name, 80) ||
        /[\u0000-\u001f\u007f]/.test(input.name)) return fail("automation trigger is malformed");
    const automation = this.db.getAutomation(automationId);
    if (!automation) return fail("automation not found", 404);
    const parsedPolicy = validateTriggerDeliveryPolicy(input.deliveryPolicy, automation.action);
    if (!parsedPolicy.ok) return fail(parsedPolicy.error ?? "automation trigger delivery policy is malformed", parsedPolicy.status);
    const secret = newAutomationTriggerSecret();
    const trigger = this.db.createAutomationTrigger({
      triggerId: shortId("atr_"), automationId, kind: input.kind, name: input.name.trim(), secret,
      ...(parsedPolicy.data ? { deliveryPolicy: parsedPolicy.data } : {}), actor, now,
    });
    return trigger ? ok({ trigger, secret }, 201) : fail("automation not found", 404);
  }

  rotateTrigger(
    automationId: string,
    triggerId: string,
    actor: GovernanceActor,
    now = Date.now(),
  ): ServiceResult<AutomationTriggerCredential> {
    const secret = newAutomationTriggerSecret();
    const trigger = this.db.rotateAutomationTrigger({ triggerId, automationId, secret, actor, now });
    return trigger ? ok({ trigger, secret }) : fail("automation trigger not found", 404);
  }

  deleteTrigger(
    automationId: string,
    triggerId: string,
    actor: GovernanceActor,
    now = Date.now(),
  ): ServiceResult<{ deleted: true }> {
    return this.db.deleteAutomationTrigger({ triggerId, automationId, actor, now })
      ? ok({ deleted: true }) : fail("automation trigger not found", 404);
  }

  receiveTrigger(
    triggerId: string,
    headers: AutomationTriggerHeaders,
    rawBody: Buffer,
    now = Date.now(),
  ): ServiceResult<AutomationTriggerInvocationResult> {
    const trigger = this.db.getAutomationTriggerRecord(triggerId);
    if (!trigger || !verifyAutomationTriggerSignature(trigger.secret, triggerId, headers, rawBody, now)) {
      return fail("invalid automation trigger signature", 401);
    }
    const body = parseAutomationTriggerBody(trigger.kind, rawBody, trigger.deliveryPolicy);
    if (!body) return fail("automation trigger body is malformed");
    const bodySha256 = automationTriggerBodySha256(rawBody);
    const existing = this.db.getAutomationTriggerInvocationByEvent(triggerId, body.eventId);
    if (existing) {
      if (existing.bodySha256 !== bodySha256) {
        return fail("automation trigger event id was reused with different content", 409);
      }
      const invocation = existing.state === "pending" ? this.processTriggerInvocation(existing, now) : existing;
      return ok({ invocation: triggerInvocationView(invocation), duplicate: true },
        invocation.state === "pending" ? 202 : 200);
    }
    let recorded: ReturnType<ControlPlaneDb["recordAutomationTriggerInvocation"]> = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = this.db.getAutomation(trigger.automationId);
      if (!current) return fail("invalid automation trigger signature", 401);
      const materialized = this.materializeTriggerDelivery(trigger, body, current);
      if (!materialized.ok) return fail(materialized.error ?? "automation trigger delivery is invalid", materialized.status);
      recorded = this.db.recordAutomationTriggerInvocation({
        invocationId: shortId("ati_"), triggerId, eventId: body.eventId, bodySha256,
        ...(body.senderHash ? { senderHash: body.senderHash } : {}),
        expectedAutomationRevision: current.revision,
        specSnapshot: materialized.data!.spec,
        ...(materialized.data!.delivery ? { delivery: materialized.data!.delivery } : {}),
        ...(materialized.data!.acceptedParameters
          ? { acceptedParameters: materialized.data!.acceptedParameters }
          : {}),
        now,
      });
      if (!recorded?.stale) break;
    }
    if (!recorded) return fail("invalid automation trigger signature", 401);
    if (recorded.stale) return fail("automation changed while accepting the trigger delivery", 409);
    if (recorded.unavailable) return fail("automation trigger is unavailable", 409);
    if (recorded.retired) return fail("automation trigger event id is retired", 409);
    if (recorded.limited) return fail("automation trigger rate or pending limit exceeded", 429);
    if (recorded.conflict) return fail("automation trigger event id was reused with different content", 409);
    const stored = recorded.invocation!;
    const invocation = stored.state === "pending" ? this.processTriggerInvocation(stored, now) : stored;
    return ok({ invocation: triggerInvocationView(invocation), duplicate: recorded.duplicate },
      invocation.state === "pending" ? 202 : 200);
  }

  private materializeTriggerDelivery(
    trigger: AutomationTriggerView,
    body: ParsedAutomationTriggerBody,
    schedule: AutomationSchedule,
  ): ServiceResult<{
    spec: AutomationSpec;
    delivery?: AutomationTriggerDeliveryMetadata;
    acceptedParameters?: Record<string, string>;
  }> {
    const { automationId: _automationId, revision: _revision, nextFireAt: _nextFireAt,
      lastFiredAt: _lastFiredAt, createdBy: _createdBy, createdAt: _createdAt,
      updatedAt: _updatedAt, ...storedSpec } = schedule;
    const policy = trigger.deliveryPolicy;
    if (!policy) return ok({ spec: storedSpec });
    const currentPolicy = validateTriggerDeliveryPolicy(policy, storedSpec.action);
    if (!currentPolicy.ok) {
      return fail(`automation no longer satisfies its trigger delivery policy: ${currentPolicy.error}`, 409);
    }

    const template = actionPrompt(storedSpec.action);
    const referencesPrompt = template.includes("{{delivery.prompt}}");
    if (referencesPrompt && body.prompt === undefined && policy.missingReferences === "reject") {
      return fail("automation trigger delivery omitted referenced prompt");
    }
    let missingParameter: string | undefined;
    let prompt = template.replace(DELIVERY_TEMPLATE_REFERENCE, (_reference, kind: string, name?: string) => {
      if (kind === "prompt") return body.prompt ?? "";
      const value = name ? body.parameters?.[name] : undefined;
      if (value === undefined && name && policy.missingReferences === "reject") missingParameter ??= name;
      return value ?? "";
    });
    if (missingParameter) return fail(`automation trigger delivery omitted referenced parameter '${missingParameter}'`);
    if (body.prompt !== undefined && !referencesPrompt) prompt = `${prompt}${prompt ? "\n\n" : ""}${body.prompt}`;

    let action = storedSpec.action;
    if (body.target) {
      if (action.kind !== "prompt_session") return fail("automation trigger target override is incompatible", 400);
      const selected = this.resolveTriggerSession(body.target);
      if (!selected.ok) return fail(selected.error ?? "automation trigger target is unavailable", selected.status);
      action = { ...action, sessionId: selected.data!.sessionId };
    }

    const context = {
      triggerId: trigger.triggerId,
      eventId: body.eventId,
      parameters: body.parameters ?? {},
      ...(body.target ? { targetSelector: body.target.selector } : {}),
    };
    const contextJson = JSON.stringify(context).replace(/</g, () => "\\u003c");
    const materializedPrompt = `<automation-trigger-delivery>\n${contextJson}\n</automation-trigger-delivery>` +
      `${prompt ? `\n\n${prompt}` : ""}`;
    if (action.kind === "create_session") {
      action = { ...action, request: { ...action.request, prompt: materializedPrompt } };
    } else if (action.kind === "prompt_session") {
      action = { ...action, request: { ...action.request, text: materializedPrompt } };
    } else {
      action = { ...action, request: { ...action.request, task: materializedPrompt } };
    }

    const fields: AutomationTriggerDeliveryMetadata["fields"] = [
      ...(body.prompt === undefined ? [] : ["prompt" as const]),
      ...(body.parameters === undefined ? [] : ["parameters" as const]),
      ...(body.target === undefined ? [] : ["target" as const]),
    ];
    const delivery: AutomationTriggerDeliveryMetadata = {
      fields,
      ...(body.prompt === undefined ? {} : {
        promptSha256: createHash("sha256").update(body.prompt, "utf8").digest("hex"),
      }),
      parameterNames: Object.keys(body.parameters ?? {}).sort(),
      ...(body.target ? { targetSelector: body.target.selector } : {}),
    };
    return ok({
      spec: { ...storedSpec, action },
      delivery,
      ...(body.parameters ? { acceptedParameters: { ...body.parameters } } : {}),
    });
  }

  private resolveTriggerSession(
    target: NonNullable<ParsedAutomationTriggerBody["target"]>,
  ): ServiceResult<{ sessionId: string }> {
    const normalizedPullRequest = (value: string) => value.replace(/\/$/, "");
    const owners = this.db.listSessions().filter((session) => {
      if (target.selector === "session_id") return session.id === target.value;
      const worktrees = session.worktrees ?? [];
      if (target.selector === "branch") return worktrees.some((worktree) => worktree.branch === target.value);
      return worktrees.some((worktree) => worktree.pullRequest &&
        normalizedPullRequest(worktree.pullRequest.url) === normalizedPullRequest(target.value));
    });
    const idle = owners.filter((session) => session.status === "idle");
    if (idle.length === 0) return fail("no idle session owns the requested trigger target", 409);
    if (idle.length > 1) return fail("more than one idle session owns the requested trigger target", 409);
    return ok({ sessionId: idle[0]!.id });
  }

  tick(now = Date.now()): number {
    this.db.compactAutomationTriggerInvocations(now);
    this.expireUndeliverableExecutions(now);
    this.resumeReceiptedExecutions(now);
    this.processPendingTriggerInvocations(now);
    this.commandOutbox.flush(now);
    try {
      this.reconcileRunning(now);
    } catch (error) {
      this.log.warn(`automation reconciliation failed: ${(error as Error).message}`);
    }
    let claimed = 0;
    for (const automation of this.db.dueAutomations(now)) {
      try {
        claimed += this.processDue(automation, now);
      } catch (error) {
        this.log.warn(`automation '${automation.automationId}' tick failed: ${(error as Error).message}`);
      }
    }
    this.commandOutbox.flush(now);
    return claimed;
  }

  private reconcileRunning(now: number): void {
    for (const candidate of this.db.activeAutomationExecutions()) {
      this.reconcileExecution(candidate.executionId, now);
      const execution = this.db.getAutomationExecution(candidate.executionId);
      if (!execution) continue;
      if (execution.status !== "running") continue;
      // A retrying execution has no outcome yet. Its session sits idle from the attempt the
      // provider refused, and idle is the success signal below — reading it would settle the
      // execution before the replacement finishes, or even before it is delivered. The wait covers
      // every non-terminal replacement state, because a runner sends its accepted and started
      // receipts before the relaunched session leaves idle. It is scoped to executions that
      // actually carry a superseded command so no ordinary execution's settlement is delayed.
      if (this.retryInFlight(execution.executionId)) continue;
      const automation = this.db.getAutomation(execution.automationId);
      let terminal: "succeeded" | "failed" | null = null;
      let error: string | undefined;
      if (execution.workflowInstanceId) {
        const instance = this.db.getWorkflowInstance(execution.workflowInstanceId);
        if (!instance) {
          terminal = "failed";
          error = "workflow instance no longer exists";
        } else if (instance.status === "succeeded") terminal = "succeeded";
        else if (instance.status === "failed" || instance.status === "stopped") {
          terminal = "failed";
          error = `workflow instance ${instance.status}`;
        }
      } else if (execution.sessionId &&
          !(execution.deliveryMode === "receipted_v53" && execution.actionKind === "prompt_session")) {
        const session = this.db.getSession(execution.sessionId);
        if (!session) {
          terminal = "failed";
          error = "target session no longer exists";
        } else if (session.status === "idle" || session.status === "completed") terminal = "succeeded";
        else if (session.status === "failed" || session.status === "stopped") {
          terminal = "failed";
          error = `target session ${session.status}`;
        }
      }
      if (!terminal) continue;
      const settled = this.db.settleAutomationExecution({
        executionId: execution.executionId, status: terminal,
        actor: { kind: "system", id: `automation:${execution.automationId}` }, error, now,
      });
      if (automation && settled) this.emit({ ...automation, ...(settled.specSnapshot ?? {}) }, settled, terminal);
    }
  }

  /** True while a replacement issued for a transiently refused launch has not yet terminalized. */
  private retryInFlight(executionId: string): boolean {
    const commands = this.db.listAutomationCommands(executionId);
    return commands.some((command) => command.supersededBy !== undefined) &&
      commands.some((command) => !["completed", "rejected", "uncertain"].includes(command.state));
  }

  /** True once nothing of the execution's plan has reached its runner before every active
   * command's persisted delivery deadline. A command the runner acknowledged means the work is
   * under way and only its own receipts may end it. A null deadline belongs to a pre-migration row
   * and deliberately remains deliverable. */
  private undeliverable(commands: AutomationCommandRecord[], now: number): boolean {
    if (commands.some((command) => ["accepted", "started", "completed"].includes(command.state))) return false;
    const active = commands.filter((command) => ["staged", "pending", "sent"].includes(command.state));
    return active.length > 0 && active.every((command) =>
      command.deliveryDeadlineAt !== undefined && command.deliveryDeadlineAt <= now);
  }

  /**
   * Write off executions whose plan never reached a runner, before the outbox can transmit any of
   * it. Ordering is the whole point: the outbox marks a command `sent` and writes it to the runner
   * in the same step, so expiring afterwards would hand a launch to the runner and simultaneously
   * release the `wait` policy for the next occurrence — two live sessions for an automation whose
   * policy exists to prevent exactly that. Deciding here, before any flush, makes the two mutually
   * exclusive: an expired command is terminal and no longer due, and a command the flush sends is
   * one this sweep has already judged still deliverable.
   */
  private expireUndeliverableExecutions(now: number): void {
    for (const candidate of this.db.activeAutomationExecutions()) {
      if (candidate.deliveryMode !== "receipted_v53") continue;
      const commands = this.db.listAutomationCommands(candidate.executionId);
      if (!commands.length) continue;
      if (!this.undeliverable(commands, now)) continue;
      this.db.expireUndeliveredAutomationCommands(candidate.executionId, now);
      this.reconcileExecution(candidate.executionId, now);
    }
  }

  private reconcileExecution(executionId: string, now: number): void {
    const execution = this.db.getAutomationExecution(executionId);
    if (!execution || execution.deliveryMode !== "receipted_v53" ||
        !["dispatching", "running"].includes(execution.status)) return;
    const commands = this.db.listAutomationCommands(executionId);
    if (!commands.length) return;
    const schedule = this.executionSchedule(execution);
    // A superseded command was replaced by a live retry; the replacement carries the verdict.
    const failed = commands.find((command) =>
      (command.state === "rejected" || command.state === "uncertain") && command.supersededBy === undefined);
    if (failed) {
      if (execution.actionKind === "workflow_run") {
        this.db.terminalizeAutomationExecutionCommands(
          executionId,
          failed.commandId,
          `workflow sibling '${failed.commandId}' became ${failed.state}`,
          now,
        );
        for (const command of commands) {
          if (command.commandId === failed.commandId || ["completed", "rejected", "uncertain"].includes(command.state)) continue;
          this.hub.sendToRunner(command.runnerId, { type: "cancel_session", sessionId: command.sessionId });
        }
        if (execution.workflowInstanceId) {
          const instance = this.db.getWorkflowInstance(execution.workflowInstanceId);
          if (instance && !["succeeded", "failed", "stopped"].includes(instance.status)) {
            this.db.finishWorkflowInstance({
              instanceId: execution.workflowInstanceId,
              status: "failed",
              error: failed.lastError ?? `workflow launch command '${failed.commandId}' became ${failed.state}`,
              actor: { kind: "system", id: "automation-outbox" },
              now,
            });
          }
        }
      } else if (execution.actionKind === "create_session" && execution.sessionId && failed.state === "rejected") {
        this.db.updateSessionStatus(execution.sessionId, "stopped", now);
        this.hub.sessionChangedById(execution.sessionId);
      }
      const settled = this.db.settleAutomationExecution({
        executionId,
        status: "failed",
        actor: { kind: "system", id: `automation:${execution.automationId}` },
        error: failed.lastError ?? `runner command '${failed.commandId}' became ${failed.state}`,
        now,
      });
      if (settled && schedule) this.emit(schedule, settled, "failed");
      return;
    }

    let current = execution;
    if (current.status === "dispatching" &&
        commands.some((command) => command.state === "started" || command.state === "completed")) {
      const running = this.db.settleAutomationExecution({
        executionId,
        status: "running",
        actor: { kind: "system", id: `automation:${execution.automationId}` },
        now,
      });
      if (running) {
        current = running;
        if (schedule) this.emit(schedule, running, "started");
      }
    }
    if (current.actionKind === "prompt_session" && commands.every((command) => command.state === "completed")) {
      const session = current.sessionId ? this.db.getSession(current.sessionId) : null;
      const promptError = !session ? "target session no longer exists"
        : session.status === "failed" || session.status === "stopped" ? `target session ${session.status}` : undefined;
      if (session && !promptError && session.status !== "idle" && session.status !== "completed") return;
      const settled = this.db.settleAutomationExecution({
        executionId,
        status: promptError ? "failed" : "succeeded",
        actor: { kind: "system", id: `automation:${execution.automationId}` },
        error: promptError,
        now,
      });
      if (settled && schedule) this.emit(schedule, settled, promptError ? "failed" : "succeeded");
    }
  }

  /** Re-enter only the preparation/materialization portion. Deterministic resource ids and an
   * idempotent staged plan make this safe after a crash at any point before activation. */
  private resumeReceiptedExecutions(now: number): void {
    for (const execution of this.db.activeAutomationExecutions()) {
      if (execution.deliveryMode !== "receipted_v53" || execution.status !== "dispatching") continue;
      const commands = this.db.listAutomationCommands(execution.executionId);
      if (commands.length && commands.every((command) => command.state !== "staged")) continue;
      const automation = this.executionSchedule(execution);
      if (!automation) continue;
      const target = execution.runnerId
        ? (this.storedDeliveryTarget(execution) ?? (commands.length ? this.stagedTarget(automation, commands) : this.resolveTarget(automation)))
        : this.resolveTarget(automation);
      if (!target.ok) continue;
      let commandSnapshots: DurableSessionCommand[] | undefined;
      if (commands.length) {
        try {
          commandSnapshots = commands.map((record) => {
            const command = JSON.parse(record.payloadJson) as DurableSessionCommand;
            const sessionId = command.type === "start_session" ? command.spec.sessionId : command.sessionId;
            if (automationCommandDigest(command) !== record.payloadSha256 || sessionId !== record.sessionId) {
              throw new Error("staged command payload failed its durable identity check");
            }
            return command;
          });
        } catch {
          this.log.warn(`automation '${execution.automationId}' recovery deferred: staged command payload is malformed or corrupt`);
          continue;
        }
      }
      try {
        this.execute(automation, execution, target.data!.target, now, commandSnapshots);
      } catch (error) {
        this.log.warn(`automation '${execution.automationId}' recovery deferred: ${(error as Error).message}`);
      }
    }
  }

  private storedDeliveryTarget(execution: AutomationExecution): ServiceResult<{ target: AutomationRunnerTarget }> | null {
    const raw = this.db.getAutomationDeliveryPlan(execution.executionId);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as { target?: AutomationRunnerTarget };
      const target = value.target;
      if (!target || target.runnerId !== execution.runnerId) return null;
      if (!this.hub.isRunnerOnline(target.runnerId) ||
          !runnerSupportsProtocol(this.db.getRunner(target.runnerId)?.protocolVersion, "automationCommandReceipts")) {
        return fail(`staged runner '${target.runnerId}' is unavailable`, 409);
      }
      return ok({ target });
    } catch {
      return null;
    }
  }

  private stagedTarget(
    automation: AutomationSchedule,
    commands: AutomationCommandRecord[],
  ): ServiceResult<{ target: AutomationRunnerTarget }> {
    const runnerId = commands[0]?.runnerId;
    if (!runnerId || commands.some((command) => command.runnerId !== runnerId)) {
      return fail("staged automation commands disagree on their runner", 409);
    }
    if (!this.hub.isRunnerOnline(runnerId) ||
        !runnerSupportsProtocol(this.db.getRunner(runnerId)?.protocolVersion, "automationCommandReceipts")) {
      return fail(`staged runner '${runnerId}' is unavailable`, 409);
    }
    if (automation.action.kind === "prompt_session") {
      const session = this.db.getSession(automation.action.sessionId);
      return session && session.runnerId === runnerId
        ? ok({ target: { runnerId, workspaceId: session.workspaceId ?? "" } })
        : fail("staged prompt target no longer belongs to its runner", 409);
    }
    let parsed: Array<Extract<DurableSessionCommand, { type: "start_session" }>>;
    try {
      parsed = commands.map((command) => JSON.parse(command.payloadJson)) as typeof parsed;
    } catch {
      return fail("staged automation command payload is malformed", 409);
    }
    const first = parsed[0]?.spec;
    if (!first || parsed.some((command) => command.type !== "start_session")) {
      return fail("staged automation launch plan is malformed", 409);
    }
    if (automation.action.kind === "create_session") {
      return ok({ target: {
        runnerId,
        workspaceId: first.workspaceId ?? automation.action.request.workspaceId,
        agentId: first.agentId,
      } });
    }
    const definition = this.db.getWorkflowDefinition(
      automation.action.request.workflowId,
      automation.action.request.workflowVersion,
    );
    if (!definition) return fail("staged workflow definition no longer exists", 409);
    const roles = [...new Set(definition.nodes.filter((node) => node.kind === "agent").map((node) => node.agentId!))];
    if (parsed.length < roles.length) return fail("staged workflow launch plan is incomplete", 409);
    const agentBindings = Object.fromEntries(roles.map((role, index) => [role, parsed[index]!.spec.agentId]));
    const orchestratorAgentId = parsed[roles.length]?.spec.agentId;
    return ok({ target: {
      runnerId,
      workspaceId: first.workspaceId ?? automation.action.request.workspaceId,
      ...(Object.keys(agentBindings).length ? { agentBindings } : {}),
      ...(orchestratorAgentId ? { orchestratorAgentId } : {}),
    } });
  }

  private executionSchedule(execution: AutomationExecution): AutomationSchedule | null {
    const current = this.db.getAutomation(execution.automationId);
    if (current) return { ...current, ...(execution.specSnapshot ?? {}) };
    if (!execution.specSnapshot) return null;
    return {
      ...execution.specSnapshot,
      automationId: execution.automationId,
      revision: execution.automationRevision,
      createdBy: execution.actor,
      createdAt: execution.createdAt,
      updatedAt: execution.createdAt,
    };
  }

  private processDue(automation: AutomationSchedule, now: number): number {
    if (automation.nextFireAt === undefined) return 0;
    const plan = duePlan(automation, now);
    const overdue = now - automation.nextFireAt >= MISFIRE_GRACE_MS;
    if (overdue && automation.misfirePolicy.kind === "skip") {
      return this.claimTerminal(automation, automation.nextFireAt, plan.future, "skipped",
        `misfire policy skipped ${plan.overflow ? "at least " : ""}${plan.occurrences.length + plan.overflow} overdue occurrence(s)`, now, "misfire_skipped") ? 1 : 0;
    }
    if (overdue && automation.misfirePolicy.kind === "fire_once") {
      return this.dispatch(automation, automation.nextFireAt, automation.nextFireAt, plan.future, now) ? 1 : 0;
    }
    const selected = overdue && automation.misfirePolicy.kind === "catch_up"
      ? plan.occurrences.slice(0, automation.misfirePolicy.maxRuns)
      : [automation.nextFireAt];
    let expected = automation.nextFireAt;
    let count = 0;
    for (let index = 0; index < selected.length; index += 1) {
      const scheduledFor = selected[index]!;
      const next = index + 1 < selected.length
        ? selected[index + 1]!
        : selected.length < plan.occurrences.length
          ? plan.occurrences[selected.length]!
          : (overdue ? plan.future : nextCronFire(automation.cron, automation.timezone, scheduledFor));
      if (!this.dispatch(automation, expected, scheduledFor, next, now)) break;
      expected = next;
      count += 1;
      if (automation.concurrencyPolicy !== "parallel") break;
    }
    return count;
  }

  private dispatch(
    automation: AutomationSchedule,
    expectedNextFireAt: number,
    scheduledFor: number,
    nextFireAt: number,
    now: number,
  ): boolean {
    const active = this.db.activeAutomationExecution(automation.automationId);
    if (active && automation.concurrencyPolicy === "wait") return false;
    if (active && automation.concurrencyPolicy === "skip") {
      return this.claimTerminal(automation, expectedNextFireAt, nextFireAt, "skipped",
        `execution '${active.executionId}' is still active`, now, "concurrency_skipped", scheduledFor);
    }
    const target = this.resolveTarget(automation);
    if (!target.ok) {
      const expiry = automation.runnerPolicy.kind === "expire"
        ? automation.runnerPolicy.afterMinutes
        : automation.runnerPolicy.kind === "alternate" ? automation.runnerPolicy.expireAfterMinutes : undefined;
      if (expiry !== undefined && now - expectedNextFireAt >= expiry * 60_000) {
        const claimed = this.claimTerminal(automation, expectedNextFireAt, nextFireAt, "expired", target.error!, now,
          "execution_status_changed", scheduledFor);
        if (claimed) {
          const execution = this.db.listAutomationExecutions(automation.automationId, 1)[0]!;
          this.emit(automation, execution, "expired");
        }
        return claimed;
      }
      return false;
    }
    const execution = this.db.claimAutomationExecution({
      executionId: shortId("axe_"), automationId: automation.automationId, expectedNextFireAt,
      scheduledFor, nextFireAt, actionKind: automation.action.kind, status: "dispatching",
      deliveryMode: "receipted_v53",
      actor: { kind: "system", id: `automation:${automation.automationId}` }, now,
    });
    if (!execution) return false;
    this.deliverExecution(automation, execution, target.data!.target, now);
    return true;
  }

  private deliverExecution(
    automation: AutomationSchedule,
    execution: AutomationExecution,
    target: AutomationRunnerTarget,
    now: number,
  ): void {
    try {
      this.execute(automation, execution, target, now);
    } catch (error) {
      this.log.warn(`automation '${automation.automationId}' dispatch threw: ${(error as Error).message}`);
      if (this.db.listAutomationCommands(execution.executionId).length) {
        // The exact plan is already durable. Leave it dispatching so deterministic preparation
        // can resume; terminalizing here would strand a staged command after a transient CP fault.
        return;
      }
      const failed = this.db.settleAutomationExecution({
        executionId: execution.executionId,
        status: "failed",
        actor: { kind: "system", id: `automation:${automation.automationId}` },
        error: "automation delivery preparation failed before activation; no unreceipted command was replayed",
        now,
      });
      if (failed) this.emit(automation, failed, "failed");
    }
  }

  private processPendingTriggerInvocations(now: number): void {
    for (const invocation of this.db.pendingAutomationTriggerInvocations()) {
      try {
        this.processTriggerInvocation(invocation, now);
      } catch (error) {
        this.log.warn(`automation trigger '${invocation.triggerId}' recovery failed: ${(error as Error).message}`);
      }
    }
  }

  private processTriggerInvocation(
    invocation: AutomationTriggerInvocationRecord,
    now: number,
  ): AutomationTriggerInvocationRecord {
    const trigger = this.db.getAutomationTriggerRecord(invocation.triggerId);
    const current = trigger ? this.db.getAutomation(trigger.automationId) : null;
    const automation = this.db.automationScheduleForTriggerInvocation(invocation.invocationId);
    if (!trigger || !current || !current.enabled || !automation) {
      return this.db.settleAutomationTriggerInvocation(invocation.invocationId, "rejected", now) ?? invocation;
    }
    const actor: GovernanceActor = {
      kind: "policy",
      id: `${trigger.kind}:${trigger.triggerId}${invocation.senderHash ? `:${invocation.senderHash.slice(0, 16)}` : ""}`,
    };
    const active = this.db.activeAutomationExecution(automation.automationId);
    if (active && automation.concurrencyPolicy === "wait") return invocation;
    if (active && automation.concurrencyPolicy === "skip") {
      this.db.claimAutomationTriggerExecution({
        invocationId: invocation.invocationId, executionId: shortId("axe_"), status: "skipped", actor,
        error: `execution '${active.executionId}' is still active`, now,
      });
      return this.db.getAutomationTriggerInvocation(invocation.invocationId) ?? invocation;
    }
    const target = this.resolveTarget(automation);
    if (!target.ok) {
      const expiry = automation.runnerPolicy.kind === "expire"
        ? automation.runnerPolicy.afterMinutes
        : automation.runnerPolicy.kind === "alternate" ? automation.runnerPolicy.expireAfterMinutes : undefined;
      if (expiry === undefined || now - invocation.receivedAt < expiry * 60_000) return invocation;
      const execution = this.db.claimAutomationTriggerExecution({
        invocationId: invocation.invocationId, executionId: shortId("axe_"), status: "expired", actor,
        error: target.error, now,
      });
      if (execution) this.emit(automation, execution, "expired");
      return this.db.getAutomationTriggerInvocation(invocation.invocationId) ?? invocation;
    }
    const execution = this.db.claimAutomationTriggerExecution({
      invocationId: invocation.invocationId, executionId: shortId("axe_"), status: "dispatching", actor, now,
    });
    if (execution) this.deliverExecution(automation, execution, target.data!.target, now);
    return this.db.getAutomationTriggerInvocation(invocation.invocationId) ?? invocation;
  }

  private claimTerminal(
    automation: AutomationSchedule,
    expectedNextFireAt: number,
    nextFireAt: number,
    status: "skipped" | "expired",
    error: string,
    now: number,
    eventKind: "misfire_skipped" | "concurrency_skipped" | "execution_status_changed",
    scheduledFor = expectedNextFireAt,
  ): boolean {
    return Boolean(this.db.claimAutomationExecution({
      executionId: shortId("axe_"), automationId: automation.automationId, expectedNextFireAt,
      scheduledFor, nextFireAt, actionKind: automation.action.kind, status,
      actor: { kind: "system", id: `automation:${automation.automationId}` }, error, eventKind,
      eventDetail: { status, error, scheduledFor }, now,
    }));
  }

  private resolveTarget(automation: AutomationSchedule): ServiceResult<{ target: AutomationRunnerTarget }> {
    if (automation.action.kind === "prompt_session") {
      const session = this.db.getSession(automation.action.sessionId);
      if (!session) return fail("target session no longer exists", 404);
      if (session.status !== "idle") return fail(`target session is ${session.status}; waiting for idle`, 409);
      if (!this.hub.isRunnerOnline(session.runnerId)) return fail(`runner '${session.runnerId}' is offline`, 409);
      if (!runnerSupportsProtocol(this.db.getRunner(session.runnerId)?.protocolVersion, "automationCommandReceipts")) {
        return fail(`runner '${session.runnerId}' must be upgraded before it can accept durable automation commands`, 409);
      }
      return ok({ target: { runnerId: session.runnerId, workspaceId: session.workspaceId ?? "" } });
    }
    let primary: AutomationRunnerTarget;
    if (automation.action.kind === "create_session") {
      const request = automation.action.request;
      primary = {
        runnerId: request.runnerId,
        workspaceId: request.workspaceId,
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
        ...(request.projectLocationId !== undefined ? { projectLocationId: request.projectLocationId } : {}),
        agentId: request.agentId,
        ...(automation.action.installationBindings
          ? { installationBindings: automation.action.installationBindings } : {}),
      };
    } else {
      const request = automation.action.request;
      primary = {
        runnerId: request.runnerId, workspaceId: request.workspaceId,
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
        ...(request.projectLocationId !== undefined ? { projectLocationId: request.projectLocationId } : {}),
        ...(request.agentBindings ? { agentBindings: request.agentBindings } : {}),
        ...(request.orchestratorAgentId ? { orchestratorAgentId: request.orchestratorAgentId } : {}),
        ...(automation.action.installationBindings
          ? { installationBindings: automation.action.installationBindings } : {}),
      };
    }
    const candidates = automation.runnerPolicy.kind === "alternate"
      ? [primary, ...automation.runnerPolicy.targets]
      : [primary];
    for (const target of candidates) {
      if (!this.hub.isRunnerOnline(target.runnerId)) continue;
      if (!runnerSupportsProtocol(this.db.getRunner(target.runnerId)?.protocolVersion, "automationCommandReceipts")) continue;
      if (!this.db.getWorkspacePath(target.runnerId, target.workspaceId)) continue;
      if (!this.projectTargetCompatible(target)) continue;
      const resolved = this.resolveSavedTarget(automation, target);
      if (!resolved) continue;
      if (automation.action.kind === "create_session" && !this.db.getAgentLaunch(resolved.runnerId, resolved.agentId!)) continue;
      if (automation.action.kind === "workflow_run" && !this.workflowTargetCompatible(automation, resolved)) continue;
      return ok({ target: resolved });
    }
    return fail("No configured automation target is available. Check its saved Agent Harness installation in Machine Settings, then edit the automation to select an available target.", 409);
  }

  private resolveSavedTarget(
    automation: AutomationSchedule,
    target: AutomationRunnerTarget,
  ): AutomationRunnerTarget | null {
    const saved = target.installationBindings;
    if (automation.action.kind === "create_session") {
      if (!saved?.agent && this.db.getRunner(target.runnerId)?.agents.some((agent) =>
        agent.id === target.agentId && agent.installation)) return null;
      const agentId = saved?.agent
        ? this.db.resolveSavedHarnessInstallation(target.runnerId, saved.agent)
        : target.agentId;
      return agentId ? { ...target, agentId } : null;
    }
    if (automation.action.kind !== "workflow_run") return target;
    const request = automation.action.request;
    const definition = this.db.getWorkflowDefinition(request.workflowId, request.workflowVersion);
    if (!definition) return target;
    const bindings = { ...(request.agentBindings ?? {}), ...(target.agentBindings ?? {}) };
    for (const role of new Set(definition.nodes.filter((node) => node.kind === "agent")
      .map((node) => node.agentId!))) {
      const reference = saved?.[`role:${role}`];
      if (!reference) {
        const agentId = bindings[role] ?? role;
        if (this.db.getRunner(target.runnerId)?.agents.some((agent) =>
          agent.id === agentId && agent.installation)) return null;
        continue;
      }
      const agentId = this.db.resolveSavedHarnessInstallation(target.runnerId, reference);
      if (!agentId) return null;
      bindings[role] = agentId;
    }
    const orchestrator = saved?.orchestrator
      ? this.db.resolveSavedHarnessInstallation(target.runnerId, saved.orchestrator)
      : target.orchestratorAgentId ?? request.orchestratorAgentId;
    if (!saved?.orchestrator && orchestrator && this.db.getRunner(target.runnerId)?.agents.some((agent) =>
      agent.id === orchestrator && agent.installation)) return null;
    if (saved?.orchestrator && !orchestrator) return null;
    return { ...target, agentBindings: bindings,
      ...(orchestrator ? { orchestratorAgentId: orchestrator } : {}) };
  }

  private projectTargetCompatible(target: AutomationRunnerTarget): boolean {
    const explicit = target.projectId !== undefined || target.projectLocationId !== undefined;
    if (!explicit) return true;
    if (target.projectId === null) return target.projectLocationId == null;
    if (!target.projectId || !target.projectLocationId) return false;
    const location = this.db.projectLocation(target.projectLocationId);
    return Boolean(location && location.projectId === target.projectId &&
      location.runnerId === target.runnerId && location.workspaceId === target.workspaceId &&
      location.availability !== "runner_removed");
  }

  private workflowTargetCompatible(
    automation: AutomationSchedule,
    target: AutomationRunnerTarget,
  ): boolean {
    if (automation.action.kind !== "workflow_run") return false;
    const request = automation.action.request;
    const definition = this.db.getWorkflowDefinition(request.workflowId, request.workflowVersion);
    // Definition lookup is runner-independent; let the action service return the authoritative
    // not-found error instead of misreporting every online runner as incompatible.
    if (!definition) return true;
    const bindings = { ...(request.agentBindings ?? {}), ...(target.agentBindings ?? {}) };
    const roles = new Set(definition.nodes
      .filter((node) => node.kind === "agent")
      .map((node) => node.agentId!));
    for (const roleId of roles) {
      if (!this.db.getAgentLaunch(target.runnerId, bindings[roleId] ?? roleId)) return false;
    }
    const orchestrator = target.orchestratorAgentId ?? request.orchestratorAgentId;
    return !orchestrator || Boolean(this.db.getAgentLaunch(target.runnerId, orchestrator));
  }

  private deliveryOptions(
    automation: AutomationSchedule,
    execution: AutomationExecution,
    ids: Pick<PreStagedDeliveryOptions,
      "sessionId" | "runId" | "workflowInstanceId" | "memberSessionIds" | "memberSessionId">,
    now: number,
    target: AutomationRunnerTarget,
    commandSnapshots?: DurableSessionCommand[],
  ): PreStagedDeliveryOptions {
    const persistedCommands = commandSnapshots ? this.db.listAutomationCommands(execution.executionId) : [];
    let deliveryDeadlineAt: number | undefined;
    if (!commandSnapshots) {
      try {
        deliveryDeadlineAt = now + automationDeliveryWindowMs(automation, execution.scheduledFor);
      } catch (error) {
        // A schedule accepted by an older build may no longer parse after an upgrade. Preserve the
        // existing delivery behavior while still giving every new command a finite durable bound.
        deliveryDeadlineAt = now + MAX_DELIVERY_BOUND_MS;
        this.log.warn(
          `automation '${automation.automationId}' delivery bound defaulted to its maximum: ${(error as Error).message}`,
        );
      }
    }
    const stage = (plan: PreStagedDeliveryPlan): void => {
      const commands = plan.commands.map((command, ordinal) => {
        if (command.type === "answer_recovered_question") {
          throw new Error("automation delivery plans cannot contain recovered question answers");
        }
        const sessionId = command.type === "start_session" ? command.spec.sessionId : command.sessionId;
        const persistedDeadline = persistedCommands.find((candidate) => candidate.ordinal === ordinal)
          ?.deliveryDeadlineAt ?? null;
        return {
          commandId: `ac_${execution.executionId}_${String(ordinal).padStart(3, "0")}`,
          ordinal,
          runnerId: plan.runnerId,
          sessionId,
          kind: command.type,
          payloadJson: JSON.stringify(command),
          payloadSha256: automationCommandDigest(command),
          expiresAt: execution.createdAt + COMMAND_RETENTION_MS,
          deliveryDeadlineAt: commandSnapshots ? persistedDeadline : deliveryDeadlineAt!,
        };
      });
      this.db.stageAutomationDeliveryPlan({
        executionId: execution.executionId,
        runnerId: plan.runnerId,
        ...(plan.sessionId ? { sessionId: plan.sessionId } : {}),
        ...(plan.runId ? { runId: plan.runId } : {}),
        ...(plan.workflowInstanceId ? { workflowInstanceId: plan.workflowInstanceId } : {}),
        planJson: JSON.stringify({
          target,
          resources: {
            runnerId: plan.runnerId,
            ...(plan.sessionId ? { sessionId: plan.sessionId } : {}),
            ...(plan.runId ? { runId: plan.runId } : {}),
            ...(plan.workflowInstanceId ? { workflowInstanceId: plan.workflowInstanceId } : {}),
          },
        }),
        commands,
        now,
      });
    };
    const automationOrigin = this.db.automationOriginForExecution(execution.executionId);
    return {
      ...ids,
      ...(automationOrigin ? { automationOrigin } : {}),
      ...(commandSnapshots ? { commandSnapshots } : {}),
      stage,
      activate: (plan) => {
        this.db.activateAutomationCommands(execution.executionId, now);
        this.commandOutbox.flush(now, plan.runnerId);
      },
    };
  }

  private execute(
    automation: AutomationSchedule,
    execution: AutomationExecution,
    target: AutomationRunnerTarget,
    now: number,
    commandSnapshots?: DurableSessionCommand[],
  ): void {
    let result: ServiceResult<unknown>;
    let controlPlaneWorkflow: { runId: string; workflowInstanceId: string; status: string } | undefined;
    if (automation.action.kind === "create_session") {
      const request = automation.action.request;
      const created = this.sessions.createSession({
        ...request, runnerId: target.runnerId, workspaceId: target.workspaceId, agentId: target.agentId!,
        ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
        ...(target.projectLocationId !== undefined ? { projectLocationId: target.projectLocationId } : {}),
        config: {
          ...(request.config ?? {}), costBudgetUsd: automation.limits.maxCostUsd,
          maxToolCalls: automation.limits.maxToolCalls,
        },
      }, this.deliveryOptions(automation, execution, { sessionId: `s_auto_${execution.executionId}` }, now, target, commandSnapshots));
      result = created;
    } else if (automation.action.kind === "prompt_session") {
      const session = this.db.getSession(automation.action.sessionId)!;
      const request = automation.action.request;
      const costBudgetUsd = Math.min(...[
        session.costUsd + automation.limits.maxCostUsd,
        session.costBudgetUsd,
        request.config?.costBudgetUsd,
      ].filter((value): value is number => value !== undefined && value !== null));
      const maxToolCalls = Math.min(...[
        (session.toolCallCount ?? 0) + automation.limits.maxToolCalls,
        session.maxToolCalls,
        request.config?.maxToolCalls,
      ].filter((value): value is number => value !== undefined && value !== null));
      if (costBudgetUsd <= session.costUsd || maxToolCalls <= (session.toolCallCount ?? 0)) {
        result = fail("the target session has already exhausted a stricter guardrail", 409);
      } else {
        result = this.sessions.prompt(
          session.id, request.text, [], request.slashCommand,
          { ...(request.config ?? {}), costBudgetUsd, maxToolCalls },
          this.deliveryOptions(automation, execution, {}, now, target, commandSnapshots),
        );
      }
    } else {
      const request = automation.action.request;
      const agentBindings = { ...(request.agentBindings ?? {}), ...(target.agentBindings ?? {}) };
      const launched = this.sessions.createWorkflowRun({
        ...request, runnerId: target.runnerId, workspaceId: target.workspaceId,
        ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
        ...(target.projectLocationId !== undefined ? { projectLocationId: target.projectLocationId } : {}),
        ...(Object.keys(agentBindings).length ? { agentBindings } : {}),
        ...(target.orchestratorAgentId ? { orchestratorAgentId: target.orchestratorAgentId } : {}),
        costBudgetUsd: automation.limits.maxCostUsd, maxToolCalls: automation.limits.maxToolCalls,
      }, { kind: "system", id: `automation:${automation.automationId}` }, this.deliveryOptions(automation, execution, {
        runId: `r_auto_${execution.executionId}`,
        workflowInstanceId: `wfi_auto_${execution.executionId}`,
        memberSessionId: (index) => `s_auto_${execution.executionId}_${String(index).padStart(3, "0")}`,
      }, now, target, commandSnapshots));
      result = launched;
      if (launched.data) {
        controlPlaneWorkflow = {
          runId: launched.data.run.id,
          workflowInstanceId: launched.data.instance.instanceId,
          status: launched.data.instance.status,
        };
      }
    }
    if (!result.ok) {
      const staged = this.db.listAutomationCommands(execution.executionId);
      if (staged.length) {
        const error = (result.error ?? "automation resource materialization failed").slice(0, 1_000);
        for (const command of staged) this.db.rejectAutomationCommand(command.commandId, error, now);
        this.reconcileExecution(execution.executionId, now);
        return;
      }
      const failed = this.db.settleAutomationExecution({
        executionId: execution.executionId, status: "failed",
        actor: { kind: "system", id: `automation:${automation.automationId}` },
        error: result.error ?? "automation action failed", now,
      });
      if (failed) this.emit(automation, failed, "failed");
      return;
    }
    if (controlPlaneWorkflow && this.db.listAutomationCommands(execution.executionId).length === 0) {
      const terminal = controlPlaneWorkflow.status === "succeeded" ? "succeeded"
        : controlPlaneWorkflow.status === "failed" || controlPlaneWorkflow.status === "stopped" ? "failed" : "running";
      const settled = this.db.settleAutomationExecution({
        executionId: execution.executionId,
        status: terminal,
        actor: { kind: "system", id: `automation:${automation.automationId}` },
        runnerId: target.runnerId,
        runId: controlPlaneWorkflow.runId,
        workflowInstanceId: controlPlaneWorkflow.workflowInstanceId,
        ...(terminal === "failed" ? { error: `workflow instance ${controlPlaneWorkflow.status}` } : {}),
        now,
      });
      if (settled) this.emit(automation, settled, terminal === "running" ? "started" : terminal);
    }
  }

  private emit(
    automation: AutomationSchedule,
    execution: AutomationExecution,
    event: AutomationNotificationEvent,
  ): void {
    if (!automation.notifications.pushEvents.includes(event)) return;
    try {
      this.notify?.(automation, execution, event);
    } catch (error) {
      this.log.warn(`automation notification failed: ${(error as Error).message}`);
    }
  }
}
