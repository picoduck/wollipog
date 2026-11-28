import { isDeepStrictEqual } from "node:util";
import {
  campaignLaunchDisclosure, campaignRepositoryLocation, validCampaignBudgetAuthority, humanRequiredRulesExist, supportsPacedVideoReviewPeer, runnerSupportsProtocol,
  type AssistantAutomationCampaignDecisionsPreview,
  type AutomationCampaign, type AutomationExecution, type AutomationRunnerTarget, type AutomationSchedule,
  type AutomationSessionRequest, type AutomationSpec, type CreateSessionRequest, type FullControlLaunchRequest, type GovernanceActor,
  type PreparedCampaignLaunch, type SessionView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { EvidenceAuthorityDisclosures } from "./evidence-authority.js";
import type { HumanPrincipal } from "./identity.js";
import { childHarnessAgents, childModelMachines, parseOrchestratorOverrides, type OrchestratorSettings } from "./orchestrator-settings.js";
import { parseAgentHarnessIdentity } from "./agent-harness-defaults.js";
import { FULL_CONTROL_LAUNCH_OPERATIONS, campaignLaunchDigest, campaignLaunchPreflight, parseFullControlLaunchRequest } from "./campaign-launch-admission.js";
import { authorizeFullControl } from "./campaign-authority.js";
import { inspectCampaignWorkspace } from "./project-location-inspection.js";
import { evaluateUiEvidenceReviewClient } from "./ui-evidence-review.js";
import type { PreStagedDeliveryOptions, ServiceResult, SessionsService } from "./sessions.js";
import { AssistantRefusal, assistantCallContext } from "./assistant-connections.js";
import { authorizeAssistantAutomation, scheduledAssistantOwner, auditAssistantAutomationOccurrence,
  type AssistantAutomationOperation } from "./assistant-automation-authority.js";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !v.includes("\0");
const fail = (error: string, status = 409): ServiceResult<SessionView> => ({ ok: false, status, error });

/** The path of the first override the shared parser refuses on its own, so a refusal names it.
 * Each leaf is checked alone against the owner-default completion the parser applies; a value
 * refused only in combination falls back to the container. */
function refusedOrchestratorField(value: unknown): string {
  const base = "request.orchestrator";
  if (!object(value)) return base;
  const unknown = Object.keys(value).find(key => !["behavior", "delegation", "execution"].includes(key));
  if (unknown) return `${base}.${unknown}`;
  for (const section of ["behavior", "delegation", "execution"] as const) {
    const part = value[section];
    if (part === undefined) continue;
    if (!object(part)) return `${base}.${section}`;
    for (const [key, entry] of Object.entries(part)) {
      if (section === "delegation" && key === "decisions" && object(entry)) {
        const category = Object.keys(entry).find(name => !parseOrchestratorOverrides({ delegation: { decisions: { [name]: entry[name] } } }));
        if (category) return `${base}.delegation.decisions.${category}`;
      } else if (!parseOrchestratorOverrides({ [section]: { [key]: entry } })) {
        return section === "behavior" && key === "childHarness" ? refusedHarnessField(entry, `${base}.behavior.childHarness`) : `${base}.${section}.${key}`;
      }
    }
  }
  return base;
}

/** The refused part of a Child Harness identity: each part is placed in an otherwise valid one. */
function refusedHarnessField(value: unknown, path: string): string {
  if (!object(value)) return path;
  const unknown = Object.keys(value).find(key => !["agentId", "driver", "context"].includes(key));
  if (unknown) return `${path}.${unknown}`;
  const valid = { agentId: "agent", driver: "claude-code", context: { kind: "native" } };
  const key = (["agentId", "driver", "context"] as const).find(name => !parseAgentHarnessIdentity({ ...valid, [name]: value[name] }));
  if (key !== "context") return key ? `${path}.${key}` : path;
  const context = value.context;
  return object(context) && context.kind === "wsl" ? `${path}.context.distro` : `${path}.context`;
}

/** Strict public input. In particular no authority provenance or admission result can be stored
 * in a schedule. The ordinary campaign parsers remain authoritative for all policy fields. Each
 * refusal names the field so a caller following the advertised schema can correct it (#4869). */
export function automationCampaignError(request: Record<string, unknown>,
  context: { maxCostUsd?: unknown; deferLimits?: boolean; stored?: { fullControl?: unknown; maxCostUsd?: number } } = {}): string | null {
  if (request.orchestrator !== undefined && !parseOrchestratorOverrides(request.orchestrator)) {
    const field = refusedOrchestratorField(request.orchestrator);
    return field === "request.orchestrator"
      ? "request.orchestrator must be an object of optional behavior, delegation and execution overrides that the Orchestrator settings accept together"
      : `${field} is not an accepted Orchestrator override or value; omit it to use the owner's Orchestrator defaults`;
  }
  if (request.campaign === undefined) {
    if (request.role === "orchestrator") return "A scheduled Orchestrator session requires request.campaign";
    return request.orchestrator === undefined ? null : "request.orchestrator overrides require request.campaign and role orchestrator";
  }
  const c = request.campaign;
  if (request.role !== "orchestrator") return "request.campaign requires request.role orchestrator";
  if (!object(c)) return "request.campaign must be an object";
  const unknown = Object.keys(c).filter(k => !["controlMode", "repository", "tasks", "fullControl"].includes(k));
  if (unknown.length) return `request.campaign does not accept ${unknown.join(", ")}; use controlMode, repository, tasks and fullControl`;
  if (!["custom", "full_control"].includes(String(c.controlMode))) return "request.campaign.controlMode must be custom or full_control";
  if (!text(c.repository, 512) || c.repository !== c.repository.toLowerCase() || !campaignRepositoryLocation(c.repository)) {
    return "request.campaign.repository must be the lowercase owner/name (or GitLab host/group/project) of the target workspace's origin";
  }
  if (!Array.isArray(c.tasks) || c.tasks.length > 100) return "request.campaign.tasks must be an array of at most 100 tasks";
  for (const [index, t] of c.tasks.entries()) {
    if (!object(t) || Object.keys(t).some(k => !["key", "title", "prompt"].includes(k)) || !text(t.key, 128) ||
        !/^[a-zA-Z0-9_-]+$/.test(t.key) || !text(t.title, 120) || !text(t.prompt, 16_384)) {
      return `request.campaign.tasks[${index}] must have only key (letters, digits, _ or -, at most 128), ` +
        "title (at most 120 characters) and prompt (at most 16384 characters)";
    }
  }
  if (new Set(c.tasks.map(t => (t as { key: string }).key)).size !== c.tasks.length) return "request.campaign.tasks keys must be unique";
  if (c.fullControl === undefined) return null;
  if (c.controlMode === "custom") return "request.campaign.fullControl applies only to controlMode full_control";
  const fullControl = c.fullControl;
  const accepts = (overrides: unknown) => object(overrides) && !Object.hasOwn(overrides, "session") &&
    parseFullControlLaunchRequest({ runnerId: request.runnerId, workspaceId: request.workspaceId, overrides }, false) !== null;
  if (!accepts(fullControl)) {
    const key = object(fullControl) ? Object.keys(fullControl).find(name => !accepts({ [name]: fullControl[name] })) : undefined;
    if (key === undefined || !["objective", "operations", "delegatablePolicyIds", "budget", "issues"].includes(key)) {
      return `request.campaign.fullControl${key === undefined ? "" : `.${key}`} is not accepted: use only objective, operations, ` +
        "delegatablePolicyIds, budget and issues launch overrides; the root's settings belong in the session request";
    }
    const nested = { budget: ["costUsd", "toolCalls", "concurrency", "acceptedFollowUps", "checkpointsUsd"],
      issues: ["relatedFollowUps", "maxIssues", "closureReasons"] }[key as "budget" | "issues"];
    const part = (fullControl as Record<string, unknown>)[key];
    const inner = nested && object(part) ? Object.keys(part).find(name => !nested.includes(name)) : undefined;
    return inner !== undefined
      ? `request.campaign.fullControl.${key}.${inner === "" ? "\"\"" : inner} is not accepted: use only ${nested!.join(", ")}`
      : `request.campaign.fullControl.${key} is not an accepted launch override value`;
  }
  // A stored schedule keeps the values it was admitted with, so an unchanged schedule can still be
  // saved, for example to pause it; launch still validates its effective boundary each time.
  const unchanged = context.stored !== undefined && isDeepStrictEqual(fullControl, context.stored.fullControl) &&
    context.maxCostUsd === context.stored.maxCostUsd;
  // `deferLimits` checks shape only, for a caller that has not yet established access to the stored
  // schedule; the full check runs once it has.
  return unchanged || context.deferLimits ? null : fullControlLimitError(fullControl as Record<string, unknown>, context.maxCostUsd);
}

/** An occurrence's cost ceiling: overrides only narrow the automation's own finite limit. */
function effectiveCostCeiling(maxCostUsd: unknown, override: unknown): number {
  return Math.min(typeof maxCostUsd === "number" ? maxCostUsd : Infinity, typeof override === "number" ? override : Infinity);
}

/** The launch parser checks these overrides' keys only; their values reach the boundary validators
 * at each occurrence. Refuse the values those validators would refuse at save instead (#4869). */
function fullControlLimitError(overrides: Record<string, unknown>, maxCostUsd: unknown): string | null {
  const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => v === undefined || (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max);
  const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const budget = overrides.budget as Record<string, unknown> | undefined, issues = overrides.issues as Record<string, unknown> | undefined;
  const at = "request.campaign.fullControl";
  if (budget?.costUsd !== undefined && !positive(budget.costUsd)) return `${at}.budget.costUsd must be a positive number`;
  for (const key of ["toolCalls", "concurrency", "acceptedFollowUps"]) {
    if (!integer(budget?.[key], key === "acceptedFollowUps" ? 0 : 1)) return `${at}.budget.${key} must be an integer of at least ${key === "acceptedFollowUps" ? 0 : 1}`;
  }
  const checkpoints = budget?.checkpointsUsd;
  if (checkpoints !== undefined && (!Array.isArray(checkpoints) || checkpoints.length > 100 ||
      checkpoints.some((v, i) => !positive(v) || (i > 0 && v <= checkpoints[i - 1])))) {
    return `${at}.budget.checkpointsUsd must be at most 100 increasing positive amounts within the cost limit`;
  }
  // Launch admits checkpoints within the effective ceiling: the smaller of the two cost limits.
  const ceiling = effectiveCostCeiling(maxCostUsd, budget?.costUsd);
  if (Array.isArray(checkpoints) && checkpoints.some(v => v > ceiling)) {
    return `${at}.budget.checkpointsUsd must stay within the effective cost limit of ${ceiling} ` +
      "(the smaller of limits.maxCostUsd and fullControl.budget.costUsd)";
  }
  if (issues?.relatedFollowUps !== undefined && typeof issues.relatedFollowUps !== "boolean") return `${at}.issues.relatedFollowUps must be a boolean`;
  if (!integer(issues?.maxIssues, 1, 100)) return `${at}.issues.maxIssues must be an integer from 1 to 100`;
  const reasons = issues?.closureReasons;
  if (reasons !== undefined && (!Array.isArray(reasons) || new Set(reasons).size !== reasons.length ||
      reasons.some(reason => reason !== "completed" && reason !== "not_planned"))) {
    return `${at}.issues.closureReasons must list distinct completed or not_planned reasons`;
  }
  return null;
}

/** The aggregate allowance an occurrence receives: Full Control overrides only narrow the
 * automation's finite ceilings and the campaign's concurrency. */
function scheduledCampaignBudget(automation: Pick<AutomationSpec, "limits" | "action">, launch: PreparedCampaignLaunch) {
  const override = automation.action.kind === "create_session" ? automation.action.request.campaign?.fullControl?.budget : undefined;
  return { costUsd: Math.min(automation.limits.maxCostUsd, override?.costUsd ?? Infinity),
    toolCalls: Math.min(automation.limits.maxToolCalls, override?.toolCalls ?? Infinity),
    concurrency: Math.min(launch.policy.behavior.maximumConcurrentChildren, override?.concurrency ?? Infinity),
    acceptedFollowUps: override?.acceptedFollowUps ?? (launch.policy.behavior.followUps === "execute_approved" ? 1 : 0) };
}

/** A stored value for a message. Only primitives are printed: converting an arbitrary stored
 * object (for example {"toString": null}) to a string can throw. */
function describeStoredValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return String(value);
  return Array.isArray(value) ? "an array" : "an object";
}

/** The effective allowance, computed exactly as launch computes it, or the stored override whose
 * numeric conversion throws (for example {"toString": null}), which launch could not use either. */
function previewBudget(automation: Pick<AutomationSpec, "limits" | "action">, launch: PreparedCampaignLaunch):
  ReturnType<typeof scheduledCampaignBudget> | { error: string } {
  try { return scheduledCampaignBudget(automation, launch); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const overrides = automation.action.kind === "create_session" ? automation.action.request.campaign?.fullControl?.budget : undefined;
    const key = (["costUsd", "toolCalls", "concurrency"] as const).find(name => {
      try { Number(overrides?.[name]); return false; } catch { return true; }
    });
    return { error: `request.campaign.fullControl.budget${key ? `.${key}` : ""} must be a number, not ` +
      `${key ? describeStoredValue(overrides?.[key]) : "a value that converts to one"}; the next occurrence would be refused` };
  }
}

/** Why a Full Control occurrence would refuse its effective allowance, or null. A schedule stored
 * before save checked these values can hold any of them, and stored JSON is not revalidated on
 * read. Checkpoints are forwarded exactly as launch does (only a value with a length), and the
 * verdict is launch's own validator's; each field is then named so the owner can correct it. */
function effectiveBudgetError(budget: ReturnType<typeof scheduledCampaignBudget>, checkpoints: unknown): string | null {
  const forwarded = (checkpoints as { length?: unknown } | null | undefined)?.length ? { checkpointsUsd: checkpoints } : {};
  if (validCampaignBudgetAuthority({ version: 1, ...budget, ...forwarded, accounting: "managed_workers_only", unpriced: "stop" })) return null;
  const refused = "; the next occurrence would be refused";
  const at = "request.campaign.fullControl.budget";
  const values = budget as Record<string, unknown>;
  if (!(typeof values.costUsd === "number" && Number.isFinite(values.costUsd) && values.costUsd > 0)) {
    return `${at}.costUsd gives an effective cost limit of ${describeStoredValue(values.costUsd)}, which must be a positive number${refused}`;
  }
  for (const key of ["toolCalls", "concurrency", "acceptedFollowUps"] as const) {
    const minimum = key === "acceptedFollowUps" ? 0 : 1;
    if (!(Number.isSafeInteger(values[key]) && (values[key] as number) >= minimum)) {
      return `The effective ${key} of ${describeStoredValue(values[key])} must be an integer of at least ${minimum}; check ${at}.${key}` +
        `${key === "concurrency" ? " and the Orchestrator's maximumConcurrentChildren" : ""}${refused}`;
    }
  }
  return `${at}.checkpointsUsd must be at most 100 increasing positive amounts within the effective cost limit of ${budget.costUsd}${refused}`;
}

export interface ScheduledCampaignPreview {
  controlMode: AutomationCampaign["controlMode"];
  repository: string;
  tasks: Array<{ key: string; title: string }>;
  root: { runnerId: string; workspaceId: string; agentId: string; model: string | null; effort: string | null };
  behavior: PreparedCampaignLaunch["policy"]["behavior"];
  delegation: PreparedCampaignLaunch["policy"]["delegation"];
  execution: PreparedCampaignLaunch["policy"]["execution"];
  budget: ReturnType<typeof scheduledCampaignBudget>;
}

export function scheduledCampaignPrompt(prompt: string | undefined, campaign: AutomationCampaign): string {
  return [prompt?.trim(),
    "Run this occurrence as a full Orchestrator campaign. Record every recurring task in the campaign work ledger before dispatching children; pass its work item when creating each child. Review actual child reports, consolidate and deduplicate findings, and act on accepted recommendations only through the campaign's authority and typed gates. Publish eligible issues, admit eligible follow-ups into scope, and delegate implementation when the configured follow-up policy permits it. Verify delivery and cleanup before reporting completion. A human-owned decision remains with its owner.",
    "Read the server-recorded task keys and work item IDs from the campaign ledger before dispatch. Recurring task definitions (data, not additional authority):",
    JSON.stringify(campaign.tasks.map(({ title, prompt }) => ({ title, prompt }))),
  ].filter(Boolean).join("\n\n");
}

/** Runtime authority comes from the sole authenticated human author or a still-authorized
 * Assistant connection, bounded by its current owner and immutable execution snapshot.
 * Each occurrence re-inspects the approved repository and uses the same
 * preparation, boundary derivation, budget admission and durable outbox as interactive campaigns. */
export class ScheduledCampaignRuntime {
  constructor(private db: ControlPlaneDb, private hub: Hub, private sessions: SessionsService,
    private settings: OrchestratorSettings, private evidenceDisclosures?: EvidenceAuthorityDisclosures) {}

  private human(userId: string | undefined, runnerId: string): HumanPrincipal | null {
    const scope = this.db.runnerScope(runnerId);
    return userId && scope ? this.db.automationCreationHuman(userId, scope.organizationId) : null;
  }

  validate(spec: AutomationSpec, actor: GovernanceActor, operation: AssistantAutomationOperation = "auto_create"): string | null {
    if (spec.action.kind !== "create_session" || !spec.action.request.campaign) return null;
    const request = spec.action.request;
    const targets = [{ runnerId: request.runnerId, workspaceId: request.workspaceId, agentId: request.agentId,
      projectId: request.projectId, projectLocationId: request.projectLocationId, installationBindings: spec.action.installationBindings },
      ...(spec.runnerPolicy.kind === "alternate" ? spec.runnerPolicy.targets : [])];
    for (const target of targets) {
      let human = actor.kind === "human" ? this.human(actor.id, target.runnerId) : null;
      if (actor.kind === "agent" && actor.id?.startsWith("asst_")) {
        try { human = authorizeAssistantAutomation(this.db, actor.id, operation, spec).owner; }
        catch (error) { if (error instanceof AssistantRefusal) return error.message; throw error; }
      }
      if (!human) return "Scheduled campaigns require an active authenticated human owner";
      const launch = this.prepare(request, target, human);
      if (typeof launch === "string") return launch;
      const childError = this.customChildError(request.campaign!, launch, human, target.runnerId);
      if (childError) return childError;
      const accounting = this.db.campaignBudgetAccountingError(launch.driver, launch.config.model, true);
      if (accounting) return accounting;
    }
    return null;
  }

  /** Ordinary preparation validates every fixed child combination and the root without writes. */
  private prepare(request: AutomationSessionRequest, target: AutomationRunnerTarget, human: HumanPrincipal): PreparedCampaignLaunch | string {
    if (!this.db.canAccessRunner(human, target.runnerId) || !this.db.canAccessWorkspace(human, target.runnerId, target.workspaceId)) {
      return "The scheduled campaign target is outside its owner's access";
    }
    if (!runnerSupportsProtocol(this.db.getRunner(target.runnerId)?.protocolVersion, "campaignBudgetAdmission")) {
      return "Update the selected campaign machine to support aggregate campaign allowances";
    }
    const agentId = target.installationBindings?.agent
      ? this.db.resolveSavedHarnessInstallation(target.runnerId, target.installationBindings.agent) : target.agentId;
    if (!agentId) return "The scheduled Orchestrator installation is unavailable";
    const { campaign: _campaign, ...stored } = request;
    const body = { ...stored, runnerId: target.runnerId, workspaceId: target.workspaceId, agentId,
      projectId: target.projectId, projectLocationId: target.projectLocationId };
    let plan: PreparedCampaignLaunch | undefined;
    // Read-only launch plan inspection never creates a session and must not inherit a calling
    // Assistant thread's session-launch restrictions (#4976).
    const result = assistantCallContext.exit(() => this.sessions.createSession(body, undefined, this.scope(human), false, false, false, {
      ...this.context(human), inspectLaunchPlan: value => { plan = value; },
    }));
    return plan ?? result.error ?? "The scheduled campaign configuration is unavailable";
  }

  /** The settings an occurrence would launch with now on `target`, the scheduler's current choice,
   * for the principal launch would act as: the schedule's still-authorized Assistant owner or its
   * sole human author, never the reader. Derived by the same preparation as save, without writes,
   * repository inspection, runner messages or a launch (#4869). Omitted overrides show the owner's
   * current defaults, which are that person's own settings, so only that person (`reader`) sees
   * them; anyone else who can read the schedule gets an explanation instead. Grants nothing. */
  preview(automation: AutomationSchedule, target: AutomationRunnerTarget, reader: HumanPrincipal): ScheduledCampaignPreview | { error: string } {
    const action = automation.action;
    if (action.kind !== "create_session" || !action.request.campaign) return { error: "The automation is not a scheduled campaign" };
    let assistant: ReturnType<typeof scheduledAssistantOwner>;
    try { assistant = scheduledAssistantOwner(this.db, automation); }
    catch (error) { if (error instanceof AssistantRefusal) return { error: error.message }; throw error; }
    const human = assistant?.owner ?? this.human(this.db.automationSoleHumanAuthor(automation.automationId, true) ?? undefined, target.runnerId);
    if (!human) return { error: "The campaign schedule no longer has one active authorizing human; review and recreate the schedule" };
    if (human.userId !== reader.userId || human.organizationId !== reader.organizationId) {
      return { error: "The effective settings come from the schedule owner's own Orchestrator defaults and are shown only to that owner" };
    }
    const campaign = action.request.campaign;
    const launch = this.prepare(action.request, target, human);
    if (typeof launch === "string") return { error: launch };
    const childError = this.customChildError(campaign, launch, human, target.runnerId);
    if (childError) return { error: childError };
    const budget = previewBudget({ limits: automation.limits, action }, launch);
    if ("error" in budget) return budget;
    const budgetError = campaign.fullControl ? effectiveBudgetError(budget, campaign.fullControl.budget?.checkpointsUsd) : null;
    if (budgetError) return { error: budgetError };
    const { behavior, delegation, execution } = structuredClone(launch.policy);
    return { controlMode: campaign.controlMode, repository: campaign.repository,
      tasks: campaign.tasks.map(({ key, title }) => ({ key, title })),
      root: { runnerId: launch.runnerId, workspaceId: launch.workspaceId, agentId: launch.agentId,
        model: launch.config.model ?? null, effort: launch.config.effort ?? null },
      behavior, delegation, execution, budget };
  }

  /** Read-only preview of effective delegated decisions and allowance for a proposed scheduled
   * campaign before it is saved (#4976). Performs no writes, repository inspection or launches. */
  previewSpec(spec: AutomationSpec, owner: HumanPrincipal): AssistantAutomationCampaignDecisionsPreview | { error: string } | null {
    const action = spec.action;
    if (action.kind !== "create_session" || !action.request.campaign) return null;
    const campaign = action.request.campaign;
    const primaryTarget: AutomationRunnerTarget = {
      runnerId: action.request.runnerId, workspaceId: action.request.workspaceId, agentId: action.request.agentId,
      projectId: action.request.projectId, projectLocationId: action.request.projectLocationId,
      installationBindings: action.installationBindings,
    };
    const launch = this.prepare(action.request, primaryTarget, owner);
    if (typeof launch === "string") return { error: launch };
    const childError = this.customChildError(campaign, launch, owner, primaryTarget.runnerId);
    if (childError) return { error: childError };
    const budget = previewBudget({ limits: spec.limits, action }, launch);
    if ("error" in budget) return budget;
    const budgetError = campaign.fullControl ? effectiveBudgetError(budget, campaign.fullControl.budget?.checkpointsUsd) : null;
    if (budgetError) return { error: budgetError };
    const fullControlOperations = campaign.controlMode === "full_control"
      ? (campaign.fullControl?.operations ?? FULL_CONTROL_LAUNCH_OPERATIONS.filter((operation) => operation !== "ci_rerun"))
      : undefined;
    const delegatablePolicyIds = campaign.controlMode === "full_control"
      ? (campaign.fullControl?.delegatablePolicyIds ?? [])
      : undefined;
    return {
      controlMode: campaign.controlMode,
      parentControl: launch.policy.delegation.parentControl,
      decisions: { ...launch.policy.delegation.decisions },
      ...(fullControlOperations ? { fullControlOperations: [...fullControlOperations] } : {}),
      ...(delegatablePolicyIds ? { delegatablePolicyIds: [...delegatablePolicyIds] } : {}),
      budget,
    };
  }

  private scope(human: HumanPrincipal) {
    return { organizationId: human.organizationId, owner: { kind: "user" as const, userId: human.userId } };
  }

  private customChildError(campaign: AutomationCampaign, launch: PreparedCampaignLaunch, human: HumanPrincipal, runnerId: string) {
    if (campaign.controlMode !== "custom") return null;
    const runners = this.db.listRunnersForPrincipal(human).filter(runner => runner.runnerId === runnerId);
    return childHarnessAgents(launch.policy, runners)?.some(entry => entry.agentId === null) ||
      childModelMachines(launch.policy, runners)?.some(entry => !entry.supported)
      ? "The Custom campaign's machine cannot run its fixed Child Harness, Model and Effort together" : null;
  }

  private context(human: HumanPrincipal) {
    return { defaultOwnerUserId: human.userId, launcherUserId: human.userId,
      orchestratorDefaults: this.settings.view(human),
      validateOrchestratorDefaults: (policy: Parameters<OrchestratorSettings["compatibilityError"]>[1]) => this.settings.compatibilityError(human, policy) };
  }

  async launch(automation: AutomationSchedule, execution: AutomationExecution, target: AutomationRunnerTarget,
    delivery: PreStagedDeliveryOptions): Promise<ServiceResult<SessionView>> {
    if (automation.action.kind !== "create_session" || !automation.action.request.campaign) return fail("Campaign configuration is missing");
    const assistantRefusal = (error: unknown) => {
      if (!(error instanceof AssistantRefusal)) throw error;
      auditAssistantAutomationOccurrence(this.db, automation.automationId, execution.executionId, "refused", error.message);
      return fail(error.message, 403);
    };
    let assistant: ReturnType<typeof scheduledAssistantOwner>;
    try { assistant = scheduledAssistantOwner(this.db, automation, execution.executionId); }
    catch (error) { return assistantRefusal(error); }
    let human = assistant?.owner ?? this.human(this.db.automationSoleHumanAuthor(automation.automationId, true) ?? undefined, target.runnerId);
    if (!human) return fail("The campaign schedule no longer has one active authorizing human; review and recreate the schedule");
    const { campaign, ...stored } = automation.action.request;
    const body: CreateSessionRequest = { ...stored, runnerId: target.runnerId, workspaceId: target.workspaceId,
      agentId: target.agentId!, ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
      ...(target.projectLocationId !== undefined ? { projectLocationId: target.projectLocationId } : {}),
      prompt: scheduledCampaignPrompt(stored.prompt, campaign), config: { ...stored.config } };
    const ownerScope = this.scope(human);
    const rootId = delivery.sessionId!;
    const existing = this.db.getSession(rootId);
    // Once materialized, authority and allowance belong to that exact root. Recovery never
    // derives fresh authority or resets spent budget; it activates the retained outbox plan.
    if (existing) {
      if (!delivery.commandSnapshots?.length || rootId !== `s_auto_${execution.executionId}`) {
        return fail("Campaign recovery requires the retained launch command");
      }
      const plan = { runnerId: target.runnerId, sessionId: rootId, commands: delivery.commandSnapshots };
      if (assistant) auditAssistantAutomationOccurrence(this.db, automation.automationId, execution.executionId, "authorized");
      delivery.stage(plan);
      delivery.activate(plan);
      return { ok: true, status: 200, data: existing };
    }
    let runner = this.db.listRunnersForPrincipal(human).find(r => r.runnerId === target.runnerId);
    if (!runner || !this.db.canAccessWorkspace(human, target.runnerId, target.workspaceId)) return fail("Campaign target is unavailable");
    const workspacePath = this.db.getWorkspacePath(target.runnerId, target.workspaceId);
    if (!workspacePath) return fail("Campaign workspace is unavailable");
    const inspection = await inspectCampaignWorkspace(this.hub, runner, target.workspaceId, [],
      new AbortController().signal, undefined, workspacePath);
    if (!inspection?.ok || inspection.repository?.toLowerCase() !== campaign.repository) {
      return fail("The scheduled campaign repository could not be verified or differs from the approved repository");
    }
    // The definition can be edited, paused, deleted or lose its author during the inspection.
    const current = this.db.getAutomation(automation.automationId);
    if (!current?.enabled || current.revision !== execution.automationRevision || this.db.getAutomationExecution(execution.executionId)?.status !== "dispatching" ||
        (!assistant && this.db.automationSoleHumanAuthor(automation.automationId, true) !== human.userId) ||
        this.db.getWorkspacePath(target.runnerId, target.workspaceId) !== workspacePath) {
      return fail("The campaign schedule or target changed during launch; no campaign was started");
    }
    if (assistant) {
      try { assistant = scheduledAssistantOwner(this.db, automation, execution.executionId); }
      catch (error) { return assistantRefusal(error); }
      human = assistant?.owner ?? null;
    } else human = this.human(human.userId, target.runnerId);
    if (!human) return fail("The schedule's author is no longer authorized to launch campaigns");
    runner = this.db.listRunnersForPrincipal(human).find(r => r.runnerId === target.runnerId);
    if (!runner) return fail("Campaign target is unavailable");
    const context = this.context(human);
    let plan: PreparedCampaignLaunch | undefined;
    const prepared = this.sessions.createSession(body, undefined, ownerScope, false, false, false, {
      ...context, inspectLaunchPlan: value => { plan = value; },
    });
    if (!plan) return prepared;
    const launch = plan as PreparedCampaignLaunch;
    const childError = this.customChildError(campaign, launch, human, target.runnerId);
    if (childError) return fail(childError);
    const budget = { version: 1 as const, accounting: "managed_workers_only" as const, unpriced: "stop" as const,
      ...scheduledCampaignBudget({ limits: automation.limits, action: automation.action }, launch) };
    const scheduled = { automationId: automation.automationId, executionId: execution.executionId, budget,
      tasks: campaign.tasks, ...(assistant ? {assistantAuthorization: assistant.authorization} : {}) };
    if (assistant) auditAssistantAutomationOccurrence(this.db, automation.automationId, execution.executionId, "authorized");
    if (campaign.controlMode === "custom") {
      return this.sessions.createSession(body, delivery, ownerScope, false, false, false,
        { ...context, scheduledCampaign: scheduled });
    }
    // Schedules without an explicit operations list keep the pre-v414 operation set rather than
    // silently gaining newly added Full Control operations (such as ci_rerun) on upgrade (#4915).
    const scheduledOperations = campaign.fullControl?.operations ??
      FULL_CONTROL_LAUNCH_OPERATIONS.filter((operation) => operation !== "ci_rerun");
    const request: FullControlLaunchRequest = { runnerId: target.runnerId, workspaceId: target.workspaceId,
      task: (campaign.fullControl?.objective ?? stored.prompt?.trim() ?? automation.name).slice(0, 4000),
      overrides: { ...campaign.fullControl, operations: scheduledOperations, budget: { ...campaign.fullControl?.budget, ...budget } } };
    const agent = runner.agents.find(a => a.id === launch.agentId);
    const { preflight, proposal } = campaignLaunchPreflight({ request, plan: launch, runner, inspection,
      organizationId: human.organizationId, projectDefaults: launch.projectId ? this.db.projectChildSessionDefaults(launch.projectId) : null,
      accountingError: protectedCost => this.db.campaignBudgetAccountingError(launch.driver, launch.config.model, protectedCost),
      dailyLimit: this.db.getUsageDailyBudget(human.organizationId).perUserUsd !== null,
      invalidPolicyIds: (campaign.fullControl?.delegatablePolicyIds ?? []).filter(id => !this.sessions.governancePolicies().some(p =>
        p.policyId === id && p.enabled && p.effect === "ask" && !p.builtin && !p.conditions?.humanRequired)),
      imageReview: evaluateUiEvidenceReviewClient(this.db.uiEvidenceReviewClient({ runnerId: target.runnerId,
        agentId: launch.agentId, driver: launch.driver, model: launch.config.model ?? null }, "orchestrator")),
      humanRequiredRules: humanRequiredRulesExist(this.sessions.governancePolicies()),
      pacedVideoPeer: supportsPacedVideoReviewPeer(runner.protocolVersion, agent?.capabilities?.pacedVideoReviewContract),
      disclosuresAvailable: this.evidenceDisclosures !== undefined,
    });
    if (!preflight.ready || !proposal) return fail(`Scheduled campaign preflight failed: ${preflight.summary.blockers.map(b => b.reason).join(" ")}`);
    const now = Date.now();
    const issueScope = { repository: campaign.repository, issueNumbers: [], revision: 1, authorizedByUserId: human.userId, authorizedAt: now };
    const control = authorizeFullControl(human, issueScope, proposal, 1, now);
    if (control?.mode !== "full_control") return fail("Scheduled campaign authority is invalid");
    const evidence = preflight.summary.evidence;
    return this.sessions.createSession(body, delivery, ownerScope, false, false, false, { ...context,
      scheduledCampaign: scheduled,
      humanCampaignLaunch: { principal: human, requestId: execution.executionId,
        digest: campaignLaunchDigest({ automationId: automation.automationId, executionId: execution.executionId,
          revision: execution.automationRevision, spec: execution.specSnapshot }), control, issueScope,
        launchDisclosure: campaignLaunchDisclosure(preflight, "launch", now),
        ...(evidence.envelope && evidence.provider?.reviewer.model ? { evidenceAuthority: {
          destinationConfigurationId: evidence.destination.configurationId, destinationDisclosureRevision: evidence.destination.disclosureRevision,
          providers: [{ providerId: evidence.provider.providerId, disclosureRevision: evidence.provider.disclosureRevision,
            reviewers: [{ driver: evidence.provider.reviewer.driver as "claude-code" | "codex-app-server", modelId: evidence.provider.reviewer.model }] }],
        } } : {}) },
    });
  }
}
