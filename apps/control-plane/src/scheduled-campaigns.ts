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
import { parseOrchestratorOverrides, type OrchestratorSettings } from "./orchestrator-settings.js";
import { campaignLaunchDigest, campaignLaunchPreflight, parseFullControlLaunchRequest } from "./campaign-launch-admission.js";
import { authorizeFullControl } from "./campaign-authority.js";
import { inspectCampaignWorkspace } from "./project-location-inspection.js";
import { evaluateUiEvidenceReviewClient } from "./ui-evidence-review.js";
import type { PreStagedDeliveryOptions, ServiceResult, SessionsService } from "./sessions.js";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !v.includes("\0");
const fail = (error: string, status = 409): ServiceResult<SessionView> => ({ ok: false, status, error });

/** Strict public input. In particular no authority provenance or admission result can be stored
 * in a schedule. The ordinary campaign parsers remain authoritative for all policy fields. */
export function validAutomationCampaign(request: Record<string, unknown>): boolean {
  if (request.orchestrator !== undefined && !parseOrchestratorOverrides(request.orchestrator)) return false;
  if (request.campaign === undefined) return request.role !== "orchestrator" && request.orchestrator === undefined;
  const c = request.campaign;
  if (request.role !== "orchestrator" || !object(c) ||
      Object.keys(c).some(k => !["controlMode", "repository", "tasks", "fullControl"].includes(k)) ||
      !["custom", "full_control"].includes(String(c.controlMode)) || !text(c.repository, 512) ||
      c.repository !== c.repository.toLowerCase() || !campaignRepositoryLocation(c.repository) ||
      !Array.isArray(c.tasks) || c.tasks.length > 100 || c.tasks.some(t => !object(t) ||
        Object.keys(t).some(k => !["key", "title", "prompt"].includes(k)) || !text(t.key, 128) ||
        !/^[a-zA-Z0-9_-]+$/.test(t.key) || !text(t.title, 120) || !text(t.prompt, 16_384)) ||
      new Set(c.tasks.map(t => t.key)).size !== c.tasks.length) return false;
  if (c.controlMode === "custom" && c.fullControl !== undefined) return false;
  return c.fullControl === undefined || (object(c.fullControl) && !Object.hasOwn(c.fullControl, "session") &&
    parseFullControlLaunchRequest({ runnerId: request.runnerId, workspaceId: request.workspaceId, overrides: c.fullControl }, false) !== null);
}

export function scheduledCampaignPrompt(prompt: string | undefined, campaign: AutomationCampaign): string {
  return [prompt?.trim(),
    "Run this occurrence as a full Orchestrator campaign. Record every recurring task in the campaign work ledger before dispatching children; pass its work item when creating each child. Review actual child reports, consolidate and deduplicate findings, and act on accepted recommendations only through the campaign's authority and typed gates. Publish eligible issues, admit eligible follow-ups into scope, and delegate implementation when the configured follow-up policy permits it. Verify delivery and cleanup before reporting completion. A human-owned decision remains with its owner.",
    "Recurring task definitions (data, not additional authority):", JSON.stringify(campaign.tasks),
  ].filter(Boolean).join("\n\n");
}

/** Runtime authority comes from the schedule's sole authenticated human author and its immutable
 * execution snapshot. Each occurrence re-inspects the approved repository and uses the same
 * preparation, boundary derivation, budget admission and durable outbox as interactive campaigns. */
export class ScheduledCampaignRuntime {
  constructor(private db: ControlPlaneDb, private hub: Hub, private sessions: SessionsService,
    private settings: OrchestratorSettings, private evidenceDisclosures?: EvidenceAuthorityDisclosures) {}

  private human(userId: string | undefined, runnerId: string): HumanPrincipal | null {
    const scope = this.db.runnerScope(runnerId);
    return userId && scope ? this.db.automationCreationHuman(userId, scope.organizationId) : null;
  }

  validate(spec: AutomationSpec, actor: GovernanceActor): string | null {
    if (spec.action.kind !== "create_session" || !spec.action.request.campaign) return null;
    const request = spec.action.request;
    const targets = [{ runnerId: request.runnerId, workspaceId: request.workspaceId, agentId: request.agentId,
      projectId: request.projectId, projectLocationId: request.projectLocationId, installationBindings: spec.action.installationBindings },
      ...(spec.runnerPolicy.kind === "alternate" ? spec.runnerPolicy.targets : [])];
    for (const target of targets) {
      const human = actor.kind === "human" ? this.human(actor.id, target.runnerId) : null;
      if (!human) return "Scheduled campaigns require an active authenticated human owner";
      if (!this.db.canAccessRunner(human, target.runnerId) || !this.db.canAccessWorkspace(human, target.runnerId, target.workspaceId)) {
        return "The scheduled campaign target is outside its owner's access";
      }
      if (!runnerSupportsProtocol(this.db.getRunner(target.runnerId)?.protocolVersion, "campaignBudgetAdmission")) {
        return "Update the selected campaign machine to support aggregate campaign allowances";
      }
      const agentId = target.installationBindings?.agent
        ? this.db.resolveSavedHarnessInstallation(target.runnerId, target.installationBindings.agent) : target.agentId;
      if (!agentId) return "The scheduled Orchestrator installation is unavailable";
      // Ordinary preparation validates every fixed child combination and the root without writes.
      const { campaign: _campaign, ...stored } = request;
      const body = { ...stored, runnerId: target.runnerId, workspaceId: target.workspaceId, agentId,
        projectId: target.projectId, projectLocationId: target.projectLocationId };
      let plan: PreparedCampaignLaunch | undefined;
      const result = this.sessions.createSession(body, undefined, this.scope(human), false, false, false, {
        ...this.context(human), inspectLaunchPlan: value => { plan = value; },
      });
      if (!plan) return result.error ?? "The scheduled campaign configuration is unavailable";
      const launch = plan as PreparedCampaignLaunch;
      const accounting = this.db.campaignBudgetAccountingError(launch.driver, launch.config.model, true);
      if (accounting) return accounting;
    }
    return null;
  }

  private scope(human: HumanPrincipal) {
    return { organizationId: human.organizationId, owner: { kind: "user" as const, userId: human.userId } };
  }

  private context(human: HumanPrincipal) {
    return { defaultOwnerUserId: human.userId, launcherUserId: human.userId,
      orchestratorDefaults: this.settings.view(human),
      validateOrchestratorDefaults: (policy: Parameters<OrchestratorSettings["compatibilityError"]>[1]) => this.settings.compatibilityError(human, policy) };
  }

  async launch(automation: AutomationSchedule, execution: AutomationExecution, target: AutomationRunnerTarget,
    delivery: PreStagedDeliveryOptions): Promise<ServiceResult<SessionView>> {
    if (automation.action.kind !== "create_session" || !automation.action.request.campaign) return fail("Campaign configuration is missing");
    const human = this.human(this.db.automationSoleHumanAuthor(automation.automationId) ?? undefined, target.runnerId);
    if (!human) return fail("The campaign schedule no longer has one active authorizing human; review and recreate the schedule");
    const { campaign, ...stored } = automation.action.request;
    const body: CreateSessionRequest = { ...stored, runnerId: target.runnerId, workspaceId: target.workspaceId,
      agentId: target.agentId!, ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
      ...(target.projectLocationId !== undefined ? { projectLocationId: target.projectLocationId } : {}),
      prompt: scheduledCampaignPrompt(stored.prompt, campaign), config: { ...stored.config } };
    const ownerScope = this.scope(human);
    const context = this.context(human);
    const rootId = delivery.sessionId!;
    const existing = this.db.getSession(rootId);
    // Once materialized, authority and allowance belong to that exact root. Recovery never
    // derives fresh authority or resets spent budget; it activates the retained outbox plan.
    if (existing) {
      if (!delivery.commandSnapshots?.length || rootId !== `s_auto_${execution.executionId}`) {
        return fail("Campaign recovery requires the retained launch command");
      }
      const plan = { runnerId: target.runnerId, sessionId: rootId, commands: delivery.commandSnapshots };
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
        this.db.automationSoleHumanAuthor(automation.automationId) !== human.userId ||
        this.db.getWorkspacePath(target.runnerId, target.workspaceId) !== workspacePath) {
      return fail("The campaign schedule or target changed during launch; no campaign was started");
    }
    runner = this.db.listRunnersForPrincipal(human).find(r => r.runnerId === target.runnerId);
    if (!runner) return fail("Campaign target is unavailable");
    let plan: PreparedCampaignLaunch | undefined;
    const prepared = this.sessions.createSession(body, undefined, ownerScope, false, false, false, {
      ...context, inspectLaunchPlan: value => { plan = value; },
    });
    if (!plan) return prepared;
    const launch = plan as PreparedCampaignLaunch;
    const budget = { version: 1 as const, accounting: "managed_workers_only" as const, unpriced: "stop" as const,
      costUsd: Math.min(automation.limits.maxCostUsd, campaign.fullControl?.budget?.costUsd ?? Infinity),
      toolCalls: Math.min(automation.limits.maxToolCalls, campaign.fullControl?.budget?.toolCalls ?? Infinity),
      concurrency: Math.min(launch.policy.behavior.maximumConcurrentChildren, campaign.fullControl?.budget?.concurrency ?? Infinity),
      acceptedFollowUps: campaign.fullControl?.budget?.acceptedFollowUps ?? (launch.policy.behavior.followUps === "execute_approved" ? 1 : 0) };
    const scheduled = { automationId: automation.automationId, executionId: execution.executionId, budget,
      tasks: campaign.tasks };
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
