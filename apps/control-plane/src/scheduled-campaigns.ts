import {
  campaignLaunchDisclosure, campaignRepositoryLocation, humanRequiredRulesExist, supportsPacedVideoReviewPeer, runnerSupportsProtocol,
  type AutomationCampaign, type AutomationExecution, type AutomationRunnerTarget, type AutomationSchedule,
  type AutomationSpec, type CreateSessionRequest, type FullControlLaunchRequest, type GovernanceActor,
  type PreparedCampaignLaunch, type SessionView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { EvidenceAuthorityDisclosures } from "./evidence-authority.js";
import type { HumanPrincipal } from "./identity.js";
import { childHarnessAgents, childModelMachines, parseOrchestratorOverrides, type OrchestratorSettings } from "./orchestrator-settings.js";
import { campaignLaunchDigest, campaignLaunchPreflight, parseFullControlLaunchRequest } from "./campaign-launch-admission.js";
import { authorizeFullControl } from "./campaign-authority.js";
import { inspectCampaignWorkspace } from "./project-location-inspection.js";
import { evaluateUiEvidenceReviewClient } from "./ui-evidence-review.js";
import type { PreStagedDeliveryOptions, ServiceResult, SessionsService } from "./sessions.js";
import { AssistantRefusal } from "./assistant-connections.js";
import { authorizeAssistantAutomation, scheduledAssistantOwner, auditAssistantAutomationOccurrence,
  type AssistantAutomationOperation } from "./assistant-automation-authority.js";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !v.includes("\0");
const fail = (error: string, status = 409): ServiceResult<SessionView> => ({ ok: false, status, error });

/** Strict public input. In particular no authority provenance or admission result can be stored
 * in a schedule. The ordinary campaign parsers remain authoritative for all policy fields. Each
 * refusal names the field so a caller following the advertised schema can correct it (#4869). */
export function automationCampaignError(request: Record<string, unknown>): string | null {
  if (request.orchestrator !== undefined && !parseOrchestratorOverrides(request.orchestrator)) {
    return "request.orchestrator must be an object of behavior, delegation and execution overrides with supported keys and values " +
      "(for example behavior.followUps recommend_only or execute_approved, behavior.maximumConcurrentChildren 0 to 64, " +
      "delegation.decisions human or orchestrator per category); omit a field to use the owner's Orchestrator defaults";
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
  if (!object(c.fullControl) || Object.hasOwn(c.fullControl, "session") ||
      parseFullControlLaunchRequest({ runnerId: request.runnerId, workspaceId: request.workspaceId, overrides: c.fullControl }, false) === null) {
    return "request.campaign.fullControl accepts only objective, operations, delegatablePolicyIds, budget and issues launch overrides; " +
      "the root's settings belong in the session request";
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
      const launch = this.prepare(spec, target, human);
      if (typeof launch === "string") return launch;
      const childError = this.customChildError(request.campaign!, launch, human, target.runnerId);
      if (childError) return childError;
      const accounting = this.db.campaignBudgetAccountingError(launch.driver, launch.config.model, true);
      if (accounting) return accounting;
    }
    return null;
  }

  /** Ordinary preparation validates every fixed child combination and the root without writes. */
  private prepare(spec: AutomationSpec, target: AutomationRunnerTarget, human: HumanPrincipal): PreparedCampaignLaunch | string {
    if (spec.action.kind !== "create_session") return "The scheduled campaign configuration is unavailable";
    if (!this.db.canAccessRunner(human, target.runnerId) || !this.db.canAccessWorkspace(human, target.runnerId, target.workspaceId)) {
      return "The scheduled campaign target is outside its owner's access";
    }
    if (!runnerSupportsProtocol(this.db.getRunner(target.runnerId)?.protocolVersion, "campaignBudgetAdmission")) {
      return "Update the selected campaign machine to support aggregate campaign allowances";
    }
    const agentId = target.installationBindings?.agent
      ? this.db.resolveSavedHarnessInstallation(target.runnerId, target.installationBindings.agent) : target.agentId;
    if (!agentId) return "The scheduled Orchestrator installation is unavailable";
    const { campaign: _campaign, ...stored } = spec.action.request;
    const body = { ...stored, runnerId: target.runnerId, workspaceId: target.workspaceId, agentId,
      projectId: target.projectId, projectLocationId: target.projectLocationId };
    let plan: PreparedCampaignLaunch | undefined;
    const result = this.sessions.createSession(body, undefined, this.scope(human), false, false, false, {
      ...this.context(human), inspectLaunchPlan: value => { plan = value; },
    });
    return plan ?? result.error ?? "The scheduled campaign configuration is unavailable";
  }

  /** The settings the next occurrence of the primary target would launch with, derived by the same
   * preparation as save and launch, without writes, repository inspection or a launch (#4869). It
   * reads the owner's current defaults, so omitted overrides show what applies now. Grants nothing. */
  preview(spec: AutomationSpec, human: HumanPrincipal): ScheduledCampaignPreview | { error: string } {
    if (spec.action.kind !== "create_session" || !spec.action.request.campaign) return { error: "The automation is not a scheduled campaign" };
    const request = spec.action.request, campaign = request.campaign!;
    const launch = this.prepare(spec, { runnerId: request.runnerId, workspaceId: request.workspaceId, agentId: request.agentId,
      projectId: request.projectId, projectLocationId: request.projectLocationId, installationBindings: spec.action.installationBindings }, human);
    if (typeof launch === "string") return { error: launch };
    const { behavior, delegation, execution } = structuredClone(launch.policy);
    return { controlMode: campaign.controlMode, repository: campaign.repository,
      tasks: campaign.tasks.map(({ key, title }) => ({ key, title })),
      root: { runnerId: launch.runnerId, workspaceId: launch.workspaceId, agentId: launch.agentId,
        model: launch.config.model ?? null, effort: launch.config.effort ?? null },
      behavior, delegation, execution, budget: scheduledCampaignBudget(spec, launch) };
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
    const request: FullControlLaunchRequest = { runnerId: target.runnerId, workspaceId: target.workspaceId,
      task: (campaign.fullControl?.objective ?? stored.prompt?.trim() ?? automation.name).slice(0, 4000),
      overrides: { ...campaign.fullControl, budget: { ...campaign.fullControl?.budget, ...budget } } };
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
