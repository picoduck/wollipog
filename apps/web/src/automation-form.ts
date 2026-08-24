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

/**
 * The client-side mirror of the control plane's `capabilityConfigError`.
 *
 * An alternate target runs the primary's stored config on ITS OWN agent — `automations.ts` spreads
 * `config` and overrides only `agentId` — so a config the alternate cannot honour is rejected on
 * the one run the alternate exists to rescue.
 *
 * An earlier attempt intersected the two agents' catalogs and offered only the overlap. Review
 * found three defects in that approach and it is not salvageable by patching: a shared model with
 * disjoint efforts yields an empty `efforts` array, which the protocol reads as "unspecified" and
 * silently widens; every capability transition needs its own revalidation hook and one was always
 * missed; and a Claude/Codex pair overlaps in NOTHING, so the pickers vanished with no explanation
 * — against this codebase's rule that a setting which could exist is disabled and explained, never
 * hidden. Validating the finished spec instead is one rule, checked on one path, that no
 * transition can slip past.
 *
 * The `.length` guard applies to MODELS ONLY, exactly as the server does it. Adding one to efforts
 * or permission modes would make this client accept a value the server rejects, which is the only
 * divergence direction that can actually break a run.
 *
 * KNOWN DIVERGENCE, in the safe direction: the server applies `claudeModelConfigForValidation`, so
 * it treats `opus` and `opus[1m]` as one family; this compares ids exactly. That can only refuse a
 * save the server would have accepted, and needs two Claude agents whose catalogs disagree on alias
 * form.
 */
export function alternateConfigError(
  config: SessionConfig | undefined,
  capabilities: AgentCapabilities | undefined,
): string | null {
  if (!config || !capabilities) return null;
  const models = capabilities.models ?? [];
  if (config.model && models.length && !models.some((model) => model.id === config.model)) {
    return `The alternate agent does not support the model ${config.model}.`;
  }
  if (config.effort) {
    const selected = config.model ? models.find((model) => model.id === config.model) : undefined;
    const efforts = (selected?.efforts?.length ? selected.efforts : capabilities.effortLevels) ?? [];
    if (!efforts.includes(config.effort)) {
      return `The alternate agent does not support ${config.effort} effort for this model.`;
    }
  }
  const permissionModes = capabilities.permissionModes ?? [];
  if (config.permissionMode && !permissionModes.includes(config.permissionMode)) {
    return `The alternate agent does not support the ${config.permissionMode} permission mode.`;
  }
  return null;
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
  /** Capabilities of the explicit alternate's agent, when one is configured. */
  alternateCapabilities?: AgentCapabilities;
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
      // Config is validated against the TARGET session's agent by `capabilityConfigError` on the
      // prompt path, so carrying it to a different session fails every fire. `slashCommand` has no
      // such gate and is left alone.
      ...(basePrompt?.config !== undefined && baseAction?.kind === "prompt_session" &&
          baseAction.sessionId === form.sessionId ? { config: basePrompt.config } : {}),
    } };
  } else if (form.actionKind === "workflow_run") {
    // A workflow's pinned version, agent bindings, and orchestrator are meaningful only for the
    // workflow they were authored against. Selecting a different workflow drops them rather than
    // pinning a version of one graph onto another.
    const sameWorkflow = baseWorkflow?.workflowId === form.workflowId;
    // Bindings name CONCRETE agent ids on one runner and config must be honourable by that
    // runner's agents, so a Machine change invalidates both even when the workflow is unchanged.
    const sameRunner = baseWorkflow?.runnerId === form.runnerId;
    action = { kind: "workflow_run", request: {
      runnerId: form.runnerId, workspaceId: form.workspaceId, workflowId: form.workflowId, task: form.prompt,
      ...primaryPlacement,
      ...(sameWorkflow && baseWorkflow?.workflowVersion !== undefined ? { workflowVersion: baseWorkflow.workflowVersion } : {}),
      ...(sameWorkflow && sameRunner && baseWorkflow?.agentBindings !== undefined ? { agentBindings: baseWorkflow.agentBindings } : {}),
      ...(sameWorkflow && sameRunner && baseWorkflow?.orchestratorAgentId !== undefined ? { orchestratorAgentId: baseWorkflow.orchestratorAgentId } : {}),
      ...(baseWorkflow?.title !== undefined ? { title: baseWorkflow.title } : {}),
      // Workflow runs default to worktrees server-side, the opposite of create-session. With no
      // control rendered for them, absence is preserved as absence.
      ...(baseWorkflow?.useWorktree !== undefined ? { useWorktree: baseWorkflow.useWorktree } : {}),
      ...(sameRunner && form.runnerPolicy !== "alternate" && baseWorkflow?.config !== undefined
        ? { config: baseWorkflow.config }
        : {}),
      ...(baseWorkflow?.costBudgetUsd !== undefined ? { costBudgetUsd: baseWorkflow.costBudgetUsd } : {}),
      ...(baseWorkflow?.maxToolCalls !== undefined ? { maxToolCalls: baseWorkflow.maxToolCalls } : {}),
    } };
  } else {
    const config = sessionConfig(form, baseCreate?.config);
    action = { kind: "create_session", request: {
      runnerId: form.runnerId, workspaceId: form.workspaceId, agentId: form.agentId,
      prompt: form.prompt, ...primaryPlacement,
      // A stored request may legitimately omit `useWorktree`; `formFrom` loads that as unchecked,
      // so an untouched control must round-trip as absence rather than durably rewriting the field.
      ...(baseCreate !== undefined && baseCreate.useWorktree === undefined && form.useWorktree === false
        ? {}
        : { useWorktree: form.useWorktree }),
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
  const baseAlternateTargets = context.base?.runnerPolicy.kind === "alternate" &&
      context.base.action.kind === form.actionKind
    ? context.base.runnerPolicy.targets
    : [];
  const baseFirstAlternate = baseAlternateTargets[0];
  const sameWorkflow = baseWorkflow?.workflowId === form.workflowId;
  // The form renders only the first target. Later targets are carried wholesale, except graph-bound
  // workflow identities when the selected workflow changes; those agent ids belong to the old
  // graph. The first workflow target follows the same rule below for its unrendered fields.
  const carriedAlternateTargets = form.runnerPolicy === "alternate"
    ? baseAlternateTargets.slice(1).map((target) => {
        const { projectId: _projectId, projectLocationId: _projectLocationId, ...targetWithoutPlacement } = target;
        const currentPlacement = automationProjectPlacement(context.projectsSupported, projectList, target);
        validateAutomationAlternatePlacement(context.projectsSupported, primaryPlacement, currentPlacement);
        if (context.projectsSupported &&
            ((target.projectId ?? null) !== (currentPlacement.projectId ?? null) ||
              (target.projectLocationId ?? null) !== (currentPlacement.projectLocationId ?? null))) {
          throw new Error(
            `Carried alternate target ${target.runnerId} no longer matches its exact Project Location.`,
          );
        }
        return form.actionKind === "workflow_run" && !sameWorkflow
          ? { runnerId: target.runnerId, workspaceId: target.workspaceId, ...currentPlacement }
          : context.projectsSupported
            ? { ...target, ...currentPlacement }
            : targetWithoutPlacement;
      })
    : [];
  if (form.runnerPolicy === "alternate") {
    validateAutomationAlternatePlacement(context.projectsSupported, primaryPlacement, alternatePlacement);
    if (action.kind === "create_session") {
      const configError = alternateConfigError(action.request.config, context.alternateCapabilities);
      if (configError) throw new Error(configError);
    }
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
            ...(form.actionKind === "workflow_run" && sameWorkflow &&
                baseFirstAlternate?.runnerId === form.fallbackRunnerId
              ? {
                  ...(baseFirstAlternate.agentBindings !== undefined
                    ? { agentBindings: baseFirstAlternate.agentBindings } : {}),
                  ...(baseFirstAlternate.orchestratorAgentId !== undefined
                    ? { orchestratorAgentId: baseFirstAlternate.orchestratorAgentId } : {}),
                }
              : {}),
          }, ...carriedAlternateTargets],
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
