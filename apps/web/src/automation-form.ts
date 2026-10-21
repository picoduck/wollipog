import type {
  AgentCapabilities,
  AutomationAction,
  AutomationNotificationEvent,
  AutomationSchedule,
  AutomationSpec,
  ProjectView,
  RunnerView,
  SessionConfig,
} from "@wollipog/protocol";
import { nextCronFire, parseCron, validateTimeZone } from "@wollipog/protocol/cron-schedule";
import { agentDisplayName } from "./agent-presentation.js";
import { resolvedInstallationAgentId } from "./automation-installations.js";
import {
  automationProjectPlacement,
  validateAutomationAlternatePlacement,
} from "./automation-project-placement.js";
import { formatCalendarTime, formatCost, titleCaseLabel } from "./format.js";
import { timeZoneDisplayName } from "./reminder-schedule.js";

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
    },
      ...(sameWorkflow && sameRunner && baseAction?.kind === "workflow_run" &&
          baseAction.installationBindings ? { installationBindings: baseAction.installationBindings } : {}),
    };
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
    },
      ...(baseAction?.kind === "create_session" && baseCreate?.runnerId === form.runnerId &&
          baseCreate.agentId === form.agentId && baseAction.installationBindings
        ? { installationBindings: baseAction.installationBindings } : {}),
    };
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
    ? baseAlternateTargets.slice(1)
      .filter((target) => target.runnerId !== form.fallbackRunnerId)
      .map((target) => {
        const { projectId: _projectId, projectLocationId: _projectLocationId, ...targetWithoutPlacement } = target;
        const currentPlacement = automationProjectPlacement(context.projectsSupported, projectList, target);
        if (context.projectsSupported &&
            ((target.projectId ?? null) !== (currentPlacement.projectId ?? null) ||
              (target.projectLocationId ?? null) !== (currentPlacement.projectLocationId ?? null))) {
          throw new Error(
            `Carried alternate target ${target.runnerId} no longer matches its exact Project Location.`,
          );
        }
        validateAutomationAlternatePlacement(context.projectsSupported, primaryPlacement, currentPlacement);
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
            ...(baseFirstAlternate?.runnerId === form.fallbackRunnerId &&
                (form.actionKind === "workflow_run" || baseFirstAlternate.agentId === form.fallbackAgentId) &&
                baseFirstAlternate.installationBindings
              ? { installationBindings: baseFirstAlternate.installationBindings } : {}),
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

/* ========================================================================== */
/* The automation in words (#2968): its schedule, its action and its policies */
/* ========================================================================== */

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "1st", "2nd", "3rd", "11th", "22nd". */
function ordinal(day: number): string {
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${suffix}`;
}

function cronNumber(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/** Whether a month field names a quarter: `*` + `/3`, `1-12/3`, or four months three apart. */
function quarterly(field: string): boolean {
  if (field === "*/3" || field === "1-12/3") return true;
  const months = field.split(",").map((part) => cronNumber(part, 1, 12));
  if (months.length !== 4 || months.some((month) => month === null)) return false;
  const sorted = (months as number[]).slice().sort((a, b) => a - b);
  return sorted.every((month, index) => index === 0 || month - sorted[index - 1]! === 3);
}

/** A wall-clock time of day as the viewer writes it ("9:00 AM"), independent of any time zone. */
function wallClock(hour: number, minute: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    .format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
}

/**
 * A cron schedule in words (#2968): every hour, every day, weekdays, weekends, one weekday, a day
 * of the month, and a day of every third month, in sentence case. Null for anything else.
 */
export function scheduleWords(cron: string, locale?: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [string, string, string, string, string];
  const minute = cronNumber(minuteField, 0, 59);
  if (minute === null) return null;
  if (hourField === "*" && dayField === "*" && monthField === "*" && weekdayField === "*") {
    return minute === 0 ? "Every hour" : `Every hour at :${String(minute).padStart(2, "0")}`;
  }
  const hour = cronNumber(hourField, 0, 23);
  if (hour === null) return null;
  const at = `at ${wallClock(hour, minute, locale)}`;
  if (dayField === "*" && monthField === "*") {
    if (weekdayField === "*") return `Every day ${at}`;
    if (weekdayField === "1-5") return `Weekdays ${at}`;
    if (weekdayField === "0,6" || weekdayField === "6,0") return `Weekends ${at}`;
    const weekday = cronNumber(weekdayField, 0, 7);
    return weekday === null ? null : `Every ${WEEKDAY_NAMES[weekday % 7]} ${at}`;
  }
  const day = cronNumber(dayField, 1, 31);
  if (day === null || weekdayField !== "*") return null;
  if (monthField === "*") return `Monthly on the ${ordinal(day)} ${at}`;
  return quarterly(monthField) ? `Quarterly on the ${ordinal(day)} ${at}` : null;
}

/**
 * The first run of `cron` in `timezone` after `now`: the scheduler's own `nextCronFire` (#2971), so
 * every valid expression gets the run the control plane will make, daylight-saving gaps and
 * repeats included. Null for an invalid expression or zone, or one that never runs.
 */
export function nextScheduleRun(cron: string, timezone: string, now: number): number | null {
  try {
    return nextCronFire(cron, timezone, now);
  } catch {
    return null;
  }
}

export interface ScheduleDescription {
  /** The schedule in words ("Weekdays at 9:00 AM"), or the cron text itself when unrecognized. */
  label: string;
  /** Its next run in words, in the viewer's time zone ("Tomorrow, 9:00 AM"); null when it has none. */
  nextLabel: string | null;
}

/**
 * A cron schedule in words (#2968), `scheduleWords()`'s, with the cron text standing in for an
 * expression they do not cover. The words are the automation's own wall clock in its own time zone;
 * the next run is in the viewer's. The list (#2969), the page and the editor (#2971) use the same
 * words.
 */
export function describeSchedule(
  cron: string,
  timezone: string,
  now = Date.now(),
  options: { viewerTimeZone?: string; locale?: string } = {},
): ScheduleDescription {
  const next = nextScheduleRun(cron, timezone, now);
  return {
    label: scheduleWords(cron, options.locale) ?? cron.trim(),
    nextLabel: next === null ? null : formatCalendarTime(next, now, options.viewerTimeZone, options.locale),
  };
}

/**
 * The Schedule field's Examples menu (#2971), in its order. Each item's label is its expression's
 * preview words in Title Case, so choosing one previews exactly what the item said.
 */
const SCHEDULE_EXAMPLE_EXPRESSIONS = ["0 * * * *", "0 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 9 1 * *", "0 9 1 */3 *"] as const;

export function scheduleExamples(locale?: string): { cron: string; label: string }[] {
  return SCHEDULE_EXAMPLE_EXPRESSIONS.map((cron) => ({ cron, label: titleCaseLabel(scheduleWords(cron, locale)!) }));
}

/** The five fields in order, with the values each takes. */
const CRON_FIELDS = [
  { name: "minute", range: "0–59" },
  { name: "hour", range: "0–23" },
  { name: "day of month", range: "1–31" },
  { name: "month", range: "1–12" },
  { name: "weekday", range: "0–7, where 0 and 7 are Sunday" },
] as const;

export const SCHEDULE_FIVE_FIELDS_ERROR = "Use five fields: minute, hour, day of month, month, weekday.";
export const SCHEDULE_NEVER_RUNS_ERROR = "This schedule never runs. Choose a day of month that each chosen month has.";

/**
 * Why the scheduler would refuse `cron` (§8.5), in one sentence, or null when it accepts it. The
 * check is the scheduler's `parseCron` (#2971); a refused field is named with the values it takes.
 * An enabled automation must also run within five years, as the control plane requires on save.
 */
export function scheduleError(cron: string, options: { timezone: string; enabled: boolean; now: number }): string | null {
  try {
    parseCron(cron);
  } catch {
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== CRON_FIELDS.length || fields[0] === "") return SCHEDULE_FIVE_FIELDS_ERROR;
    // The first field that is refused on its own, with every other field a wildcard.
    const refused = CRON_FIELDS.findIndex((_, index) => {
      try {
        parseCron(fields.map((field, other) => (other === index ? field : "*")).join(" "));
        return false;
      } catch {
        return true;
      }
    });
    if (refused < 0) return SCHEDULE_FIVE_FIELDS_ERROR;
    const field = CRON_FIELDS[refused]!;
    return `Use ${field.range} for the ${field.name}, or a range, list or step of them.`;
  }
  if (!options.enabled || !validTimeZone(options.timezone)) return null;
  return nextScheduleRun(cron, options.timezone, options.now) === null ? SCHEDULE_NEVER_RUNS_ERROR : null;
}

/** Whether the scheduler accepts `timezone`, by its own check. */
export function validTimeZone(timezone: string): boolean {
  try {
    validateTimeZone(timezone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The line under the Schedule field (#2971): "Weekdays at 9:00 AM · Next Mon, 9:00 AM", its words
 * and its next run in the automation's zone, which is named when it is not the viewer's. "Custom
 * schedule" stands in for words a valid expression has none of, and "Paused" for the next run of
 * an automation that is not enabled. Null while the expression is invalid.
 */
export function schedulePreview(cron: string, options: {
  timezone: string;
  enabled: boolean;
  now: number;
  viewerTimeZone?: string;
  locale?: string;
}): string | null {
  try {
    parseCron(cron);
  } catch {
    return null;
  }
  const words = scheduleWords(cron, options.locale) ?? "Custom schedule";
  if (!options.enabled) return `${words} · Paused`;
  const next = nextScheduleRun(cron, options.timezone, options.now);
  if (next === null) return words;
  const zone = options.viewerTimeZone === options.timezone ? "" : ` (${timeZoneDisplayName(options.timezone, options.now)})`;
  return `${words} · Next ${formatCalendarTime(next, options.now, options.timezone, options.locale)}${zone}`;
}

/** One Time Zone choice (#2971): "New York (UTC−4)", over its IANA name. */
export interface TimeZoneChoice {
  value: string;
  label: string;
  description: string;
}

/** The zones this browser knows, or none when it cannot list them. */
function browserTimeZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

/** `timeZone`'s offset from UTC at `instant` as "UTC−4", "UTC+5:30" or "UTC"; null for an unknown zone. */
export function utcOffsetLabel(timeZone: string, instant: number): string | null {
  let parts: Record<string, number>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(new Date(instant)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  } catch {
    return null;
  }
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
  const minutes = Math.round((wall - Math.floor(instant / 60_000) * 60_000) / 60_000);
  if (minutes === 0) return "UTC";
  const size = Math.abs(minutes);
  const rest = size % 60;
  return `UTC${minutes < 0 ? "−" : "+"}${Math.floor(size / 60)}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

/** A zone's city, as its IANA name's last part reads ("America/New_York" → "New York"). */
function zoneCity(timeZone: string): string {
  return (timeZone.split("/").at(-1) ?? timeZone).replace(/_/g, " ");
}

/**
 * The Time Zone field's choices (#2971): every zone the browser lists, labelled by city and current
 * offset, with the IANA name as the second line, in alphabetical order. UTC and the stored zone are
 * always among them, so a zone this browser does not list (or an alias) stays chosen, and a browser
 * with no list still offers the stored zone and UTC.
 */
export function timeZoneChoices(stored: string, now: number, zones: readonly string[] = browserTimeZones()): TimeZoneChoice[] {
  const values = new Set(zones);
  values.add("UTC");
  if (stored.trim()) values.add(stored);
  return [...values].map((value) => {
    const offset = utcOffsetLabel(value, now);
    const city = value === "UTC" ? "UTC" : zoneCity(value);
    return { value, label: offset && value !== "UTC" ? `${city} (${offset})` : city, description: value };
  }).sort((a, b) => a.label.localeCompare(b.label, "en") || a.value.localeCompare(b.value, "en"));
}

/** What `actionSentence` names things by. Each lookup answers undefined for what it doesn't know. */
export interface ActionNames {
  runners: ReadonlyMap<string, RunnerView>;
  /** A machine's label, as the editor's Machine field shows it. */
  machineLabel: (runnerId: string) => string | undefined;
  sessionTitle: (sessionId: string) => string | undefined;
  workflowName: (workflowId: string) => string | undefined;
}

/**
 * What an automation does, in one sentence with display names and no ids (#2968): "Starts Claude
 * Code in acme-storefront on Build Server.", "Runs the Build and Review workflow in acme-storefront
 * on Build Server.", "Prompts “Nightly triage”.". The prompt or task is shown under it.
 */
export function actionSentence(action: AutomationAction, names: ActionNames): string {
  if (action.kind === "prompt_session") {
    const title = names.sessionTitle(action.sessionId);
    return title ? `Prompts “${title}”.` : "Prompts a session that isn't loaded.";
  }
  const runner = names.runners.get(action.request.runnerId);
  const folder = runner?.workspaces.find((workspace) => workspace.id === action.request.workspaceId)?.name;
  const machine = names.machineLabel(action.request.runnerId) ?? "a machine that isn't connected";
  const where = `in ${folder ?? "a folder that isn't available"} on ${machine}`;
  if (action.kind === "workflow_run") {
    const workflow = names.workflowName(action.request.workflowId);
    return `Runs ${workflow ? `the ${workflow} workflow` : "a workflow that isn't available"} ${where}.`;
  }
  // The agent the scheduler starts: a saved installation's agent wherever discovery now lists it
  // (its id can change or be reused), else the stored agent id (resolveSavedTarget, automations.ts).
  const saved = action.installationBindings?.agent;
  if (saved && !resolvedInstallationAgentId(runner, saved)) {
    return `Starts an agent whose saved installation isn't available ${where}.`;
  }
  const agentId = saved ? resolvedInstallationAgentId(runner, saved)! : action.request.agentId;
  const agent = runner?.agents.find((candidate) => candidate.id === agentId);
  return `Starts ${agent ? agentDisplayName(agent, runner!.agents) : "an agent that isn't on this machine"} ${where}.`;
}

/** The prompt or task an action sends. */
export function actionText(action: AutomationAction): string {
  if (action.kind === "prompt_session") return action.request.text;
  return action.kind === "workflow_run" ? action.request.task : (action.request.prompt ?? "");
}

function joinWords(words: readonly string[], conjunction: "and" | "or"): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} ${conjunction} ${words[words.length - 1]}`;
}

function minutes(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "minute" : "minutes"}`;
}

const NOTIFICATION_WORDS: Record<AutomationNotificationEvent, string> = {
  started: "starts", succeeded: "succeeds", failed: "fails", expired: "expires",
};

/**
 * Each policy's answer in plain words, for the automation page's Rules and Limits (#2968). They
 * say what the control plane does: an alternate machine is used as soon as the primary is offline,
 * and its time limit is when the run gives up if none is online.
 */
export const policyCopy = {
  missed(policy: AutomationSpec["misfirePolicy"]): string {
    if (policy.kind === "skip") return "Skip it";
    if (policy.kind === "fire_once") return "Run it once";
    return `Catch up, at most ${policy.maxRuns} ${policy.maxRuns === 1 ? "run" : "runs"}`;
  },
  offline(policy: AutomationSpec["runnerPolicy"], machineLabel: (runnerId: string) => string | undefined): string {
    if (policy.kind === "wait") return "Wait until it's back";
    if (policy.kind === "expire") return `Give up after ${minutes(policy.afterMinutes)}`;
    const machines = [...new Set(policy.targets.map((target) => machineLabel(target.runnerId) ?? "a machine that isn't connected"))];
    const none = policy.targets.length > 1 ? "none is online" : "neither is online";
    return `Use ${joinWords(machines, "or")} instead; ${policy.expireAfterMinutes === undefined
      ? `wait if ${none}`
      : `give up after ${minutes(policy.expireAfterMinutes)} if ${none}`}`;
  },
  concurrency(policy: AutomationSpec["concurrencyPolicy"]): string {
    if (policy === "wait") return "Wait for it to finish";
    return policy === "skip" ? "Skip this run" : "Run both at once";
  },
  cost(limits: AutomationSpec["limits"]): string {
    return `${formatCost(limits.maxCostUsd) || "$0.00"} per run`;
  },
  toolCalls(limits: AutomationSpec["limits"]): string {
    return `${limits.maxToolCalls.toLocaleString()} ${limits.maxToolCalls === 1 ? "tool call" : "tool calls"} per run`;
  },
  notifications(routing: AutomationSpec["notifications"]): string {
    const words = (Object.keys(NOTIFICATION_WORDS) as AutomationNotificationEvent[])
      .filter((event) => routing.pushEvents.includes(event)).map((event) => NOTIFICATION_WORDS[event]);
    return words.length ? `When a run ${joinWords(words, "or")}` : "Off";
  },
};
