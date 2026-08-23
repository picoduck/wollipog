import type {
  AgentCapabilities,
  AutomationAction,
  AutomationNotificationEvent,
  AutomationSchedule,
  AutomationSpec,
  ProjectView,
  SessionConfig,
} from "@wollipog/protocol";
import {
  automationProjectPlacement,
  validateAutomationAlternatePlacement,
} from "./automation-project-placement.js";

export type ActionKind = AutomationAction["kind"];

export interface FormState {
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  actionKind: ActionKind;
  runnerId: string;
  workspaceId: string;
  agentId: string;
  model: string;
  effort: string;
  permissionMode: string;
  useWorktree: boolean;
  prompt: string;
  sessionId: string;
  workflowId: string;
  misfire: "skip" | "fire_once" | "catch_up";
  catchUpRuns: string;
  runnerPolicy: "wait" | "expire" | "alternate";
  expiryMinutes: string;
  fallbackRunnerId: string;
  fallbackWorkspaceId: string;
  fallbackAgentId: string;
  concurrency: AutomationSpec["concurrencyPolicy"];
  maxCostUsd: string;
  maxToolCalls: string;
  pushEvents: AutomationNotificationEvent[];
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function defaults(): FormState {
  return {
    name: "", cron: "0 9 * * 1-5", timezone: localTimezone(), enabled: true,
    actionKind: "create_session", runnerId: "", workspaceId: "", agentId: "",
    model: "", effort: "", permissionMode: "", useWorktree: true, prompt: "",
    sessionId: "", workflowId: "build-review", misfire: "skip", catchUpRuns: "2",
    runnerPolicy: "wait", expiryMinutes: "60", fallbackRunnerId: "", fallbackWorkspaceId: "",
    fallbackAgentId: "", concurrency: "wait", maxCostUsd: "5", maxToolCalls: "50",
    pushEvents: ["failed", "expired"],
  };
}

export function specOf(schedule: AutomationSchedule): AutomationSpec {
  return {
    name: schedule.name, cron: schedule.cron, timezone: schedule.timezone, enabled: schedule.enabled,
    misfirePolicy: schedule.misfirePolicy, runnerPolicy: schedule.runnerPolicy,
    concurrencyPolicy: schedule.concurrencyPolicy, limits: schedule.limits,
    notifications: schedule.notifications, action: schedule.action,
  };
}

export function formFrom(spec: AutomationSpec): FormState {
  const form = defaults();
  form.name = spec.name;
  form.cron = spec.cron;
  form.timezone = spec.timezone;
  form.enabled = spec.enabled;
  form.actionKind = spec.action.kind;
  form.misfire = spec.misfirePolicy.kind;
  form.catchUpRuns = spec.misfirePolicy.kind === "catch_up" ? String(spec.misfirePolicy.maxRuns) : "2";
  form.runnerPolicy = spec.runnerPolicy.kind;
  form.expiryMinutes = spec.runnerPolicy.kind === "expire"
    ? String(spec.runnerPolicy.afterMinutes)
    : spec.runnerPolicy.kind === "alternate" ? String(spec.runnerPolicy.expireAfterMinutes ?? 60) : "60";
  form.concurrency = spec.concurrencyPolicy;
  form.maxCostUsd = String(spec.limits.maxCostUsd);
  form.maxToolCalls = String(spec.limits.maxToolCalls);
  form.pushEvents = spec.notifications.pushEvents;
  if (spec.action.kind === "prompt_session") {
    form.sessionId = spec.action.sessionId;
    form.prompt = spec.action.request.text;
  } else {
    form.runnerId = spec.action.request.runnerId;
    form.workspaceId = spec.action.request.workspaceId;
    form.prompt = spec.action.kind === "workflow_run" ? spec.action.request.task : (spec.action.request.prompt ?? "");
    if (spec.action.kind === "create_session") {
      form.agentId = spec.action.request.agentId;
      // Omitted `useWorktree` means in-place for a create-session action: the control plane's
      // legacy strategy treats a falsy value as `in_place`. Loading it as unchecked therefore
      // preserves the stored behavior rather than silently opting the automation into worktrees.
      form.useWorktree = spec.action.request.useWorktree ?? false;
      form.model = spec.action.request.config?.model ?? "";
      form.effort = spec.action.request.config?.effort ?? "";
      form.permissionMode = spec.action.request.config?.permissionMode ?? "";
    } else {
      form.workflowId = spec.action.request.workflowId;
    }
    if (spec.runnerPolicy.kind === "alternate") {
      const target = spec.runnerPolicy.targets[0];
      if (target) {
        form.fallbackRunnerId = target.runnerId;
        form.fallbackWorkspaceId = target.workspaceId;
        form.fallbackAgentId = target.agentId ?? "";
      }
    }
  }
  return form;
}

/**
 * Session config the form owns outright versus config it merely carries.
 *
 * Model, effort, and permission mode are rendered, so the form is authoritative for them and an
 * empty selection must REMOVE the key rather than fall back to the stored value. The cost and
 * tool-call ceilings have no control, so they survive untouched.
 */
function sessionConfig(form: FormState, base: SessionConfig | undefined): SessionConfig | undefined {
  const config: SessionConfig = {
    ...(base?.costBudgetUsd !== undefined ? { costBudgetUsd: base.costBudgetUsd } : {}),
    ...(base?.maxToolCalls !== undefined ? { maxToolCalls: base.maxToolCalls } : {}),
    ...(form.model ? { model: form.model } : {}),
    ...(form.effort ? { effort: form.effort } : {}),
    ...(form.permissionMode ? { permissionMode: form.permissionMode } : {}),
  };
  return Object.keys(config).length ? config : undefined;
}

/**
 * Model, effort and permission mode are advertised PER AGENT, so a different agent invalidates all
 * three. Carrying them over saves a spec that passes `validateAutomationSpec` — which checks shape
 * only — and is then rejected by `capabilityConfigError` when the session is created, so the
 * automation fails on every scheduled run instead of at the moment the choice was made.
 */
export function withAgent(form: FormState, agentId: string): FormState {
  return { ...form, agentId, model: "", effort: "", permissionMode: "" };
}

/**
 * Effort is advertised per MODEL, falling back to the agent's levels. Switching to a model that
 * does not advertise the selected effort clears it for the same reason as above; permission mode is
 * agent-scoped and survives a model change.
 */
export function withModel(form: FormState, model: string, capabilities: AgentCapabilities | undefined): FormState {
  const selected = model ? capabilities?.models.find((candidate) => candidate.id === model) : undefined;
  const efforts = (selected?.efforts?.length ? selected.efforts : capabilities?.effortLevels) ?? [];
  return { ...form, model, effort: form.effort && efforts.includes(form.effort) ? form.effort : "" };
}

export interface BuildSpecContext {
  projectsSupported: boolean;
  projects: Iterable<ProjectView>;
  /**
   * The exact stored spec being edited, when editing.
   *
   * `PUT /api/automations/:id` replaces the whole spec, so any stored field this form does not
   * render has to be carried across explicitly or it is destroyed by an unrelated edit. Carrying
   * is deliberately per-field rather than a blanket spread: placement is recomputed from the
   * current runner and workspace, and reviving a stale `projectId` would be its own corruption.
   */
  base?: AutomationSpec;
}

export function buildSpec(form: FormState, context: BuildSpecContext): AutomationSpec {
  const projectList = [...context.projects];
  const baseAction = context.base?.action;
  const baseCreate = baseAction?.kind === "create_session" ? baseAction.request : undefined;
  const basePrompt = baseAction?.kind === "prompt_session" ? baseAction.request : undefined;
  const baseWorkflow = baseAction?.kind === "workflow_run" ? baseAction.request : undefined;
  const primaryPlacement = form.actionKind === "prompt_session"
    ? {}
    : automationProjectPlacement(context.projectsSupported, projectList, {
        runnerId: form.runnerId,
        workspaceId: form.workspaceId,
      });
  let action: AutomationAction;
  if (form.actionKind === "prompt_session") {
    action = { kind: "prompt_session", sessionId: form.sessionId, request: {
      text: form.prompt,
      ...(basePrompt?.slashCommand !== undefined ? { slashCommand: basePrompt.slashCommand } : {}),
      ...(basePrompt?.config !== undefined ? { config: basePrompt.config } : {}),
    } };
  } else if (form.actionKind === "workflow_run") {
    // A workflow's pinned version, agent bindings, and orchestrator are meaningful only for the
    // workflow they were authored against. Selecting a different workflow drops them rather than
    // pinning a version of one graph onto another.
    const sameWorkflow = baseWorkflow?.workflowId === form.workflowId;
    action = { kind: "workflow_run", request: {
      runnerId: form.runnerId, workspaceId: form.workspaceId, workflowId: form.workflowId, task: form.prompt,
      ...primaryPlacement,
      ...(sameWorkflow && baseWorkflow?.workflowVersion !== undefined ? { workflowVersion: baseWorkflow.workflowVersion } : {}),
      ...(sameWorkflow && baseWorkflow?.agentBindings !== undefined ? { agentBindings: baseWorkflow.agentBindings } : {}),
      ...(sameWorkflow && baseWorkflow?.orchestratorAgentId !== undefined ? { orchestratorAgentId: baseWorkflow.orchestratorAgentId } : {}),
      ...(baseWorkflow?.title !== undefined ? { title: baseWorkflow.title } : {}),
      // Workflow runs default to worktrees server-side, the opposite of create-session. With no
      // control rendered for them, absence is preserved as absence.
      ...(baseWorkflow?.useWorktree !== undefined ? { useWorktree: baseWorkflow.useWorktree } : {}),
      ...(baseWorkflow?.config !== undefined ? { config: baseWorkflow.config } : {}),
      ...(baseWorkflow?.costBudgetUsd !== undefined ? { costBudgetUsd: baseWorkflow.costBudgetUsd } : {}),
      ...(baseWorkflow?.maxToolCalls !== undefined ? { maxToolCalls: baseWorkflow.maxToolCalls } : {}),
    } };
  } else {
    const config = sessionConfig(form, baseCreate?.config);
    action = { kind: "create_session", request: {
      runnerId: form.runnerId, workspaceId: form.workspaceId, agentId: form.agentId,
      prompt: form.prompt, useWorktree: form.useWorktree, ...primaryPlacement,
      ...(baseCreate?.title !== undefined ? { title: baseCreate.title } : {}),
      ...(config ? { config } : {}),
    } };
  }
  const alternatePlacement = form.runnerPolicy === "alternate"
    ? automationProjectPlacement(context.projectsSupported, projectList, {
        runnerId: form.fallbackRunnerId,
        workspaceId: form.fallbackWorkspaceId,
      })
    : {};
  if (form.runnerPolicy === "alternate") {
    validateAutomationAlternatePlacement(context.projectsSupported, primaryPlacement, alternatePlacement);
  }
  const runnerPolicy: AutomationSpec["runnerPolicy"] = form.runnerPolicy === "wait"
    ? { kind: "wait" }
    : form.runnerPolicy === "expire"
      ? { kind: "expire", afterMinutes: Number(form.expiryMinutes) }
      : {
          kind: "alternate",
          targets: [{
            runnerId: form.fallbackRunnerId, workspaceId: form.fallbackWorkspaceId,
            ...alternatePlacement,
            ...(form.actionKind === "create_session" ? { agentId: form.fallbackAgentId } : {}),
          }],
          expireAfterMinutes: Number(form.expiryMinutes),
        };
  return {
    name: form.name, cron: form.cron, timezone: form.timezone, enabled: form.enabled,
    action,
    misfirePolicy: form.misfire === "catch_up"
      ? { kind: "catch_up", maxRuns: Number(form.catchUpRuns) }
      : { kind: form.misfire },
    runnerPolicy,
    concurrencyPolicy: form.actionKind === "prompt_session" && form.concurrency === "parallel" ? "wait" : form.concurrency,
    limits: { maxCostUsd: Number(form.maxCostUsd), maxToolCalls: Number(form.maxToolCalls) },
    notifications: { pushEvents: form.pushEvents },
  };
}
