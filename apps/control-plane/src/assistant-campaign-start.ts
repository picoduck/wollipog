import {
  builtInAgentHarnessName, runnerSupportsProtocol, validOrchestratorCampaignBudgetDefault,
  type AssistantOwnerConfirmation, type AssistantOwnerConfirmationDetail, type CampaignBudgetAuthority,
  type CreateSessionRequest, type OrchestratorCampaignBudgetDefault, type PreparedCampaignLaunch,
} from "@wollipog/protocol";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";
import { assistantRequestDigest, type AssistantCommandReceipts } from "./assistant-command-receipts.js";
import { AssistantRefusal, assistantCallContext, type AssistantConnection, type AssistantOperations } from "./assistant-connections.js";
import {
  ASSISTANT_CAMPAIGN_START, assistantCampaignLaunchId, type CampaignConfirmationPreview, type OwnerConfirmationBinding,
} from "./assistant-owner-confirmations.js";
import { parseFullControlLaunchRequest, campaignLaunchDigest } from "./campaign-launch-admission.js";
import { prepareFullControlLaunch, type FullControlLaunchDependencies } from "./full-control-launch-route.js";
import type { HumanPrincipal } from "./identity.js";
import { resolveSessionCreationOwnership } from "./session-creation-route.js";

const string = { type: "string" };
const properties = { commandId: string, locationId: string, agentId: string,
  mode: { type: "string", enum: ["custom", "full_control"] }, prompt: { type: "string", maxLength: 4000 },
  model: string, effort: string, childAgentId: string, childModel: string, childEffort: string,
  issueNumbers: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 100, uniqueItems: true },
};
const required = ["commandId", "locationId", "agentId", "mode", "prompt"] as const;
type CampaignArgs = Record<string, unknown> & {
  commandId: string; locationId: string; agentId: string; mode: "custom" | "full_control"; prompt: string;
  model?: string; effort?: string; childAgentId?: string; childModel?: string; childEffort?: string; issueNumbers?: number[];
};

function parseArgs(value: unknown): CampaignArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("Supply the campaign launch arguments.");
  const args = value as CampaignArgs;
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key) && key !== "confirmationId") ||
      required.some(key => typeof args[key] !== "string" || !args[key].trim()) ||
      (args.mode !== "custom" && args.mode !== "full_control") ||
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(args.commandId) ||
      args.prompt.length > 4000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\p{Cf}]/u.test(args.prompt) ||
      Object.keys(properties).filter(key => key !== "prompt" && key !== "issueNumbers").some(key =>
        args[key] !== undefined && (typeof args[key] !== "string" || !(args[key] as string).trim() ||
          (args[key] as string).length > 256 || /[\p{Cc}\p{Cf}]/u.test(args[key] as string))) ||
      (args.issueNumbers !== undefined && (args.mode !== "full_control" || !Array.isArray(args.issueNumbers) || args.issueNumbers.length > 100 ||
        args.issueNumbers.some(n => !Number.isSafeInteger(n) || n < 1) || new Set(args.issueNumbers).size !== args.issueNumbers.length))) {
    throw new AssistantRefusal("Specify a Location, Orchestrator agent, first message and Custom or Full Control mode. Only Full Control accepts explicit issue numbers. The owner sets budgets and authority.");
  }
  return { ...args, prompt: args.prompt.trim() };
}

const label = (value: string) => value.split("_").map(word =>
  word === "pr" || word === "ui" ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
const fact = (label: string, value: string): AssistantOwnerConfirmationDetail => ({ label, value });
const harnessName = (driver: Parameters<typeof builtInAgentHarnessName>[0], id: string) =>
  `${builtInAgentHarnessName(driver) ?? driver} (${id})`;
function planFacts(plan: PreparedCampaignLaunch, budget: CampaignBudgetAuthority): AssistantOwnerConfirmationDetail[] {
  const { behavior, execution } = plan.policy;
  const child = behavior.childHarness;
  return [
    fact("Campaign Budget", `${budget.costUsd === undefined ? "Budget required" : `$${budget.costUsd} USD · ${budget.toolCalls} tool calls`}`),
    fact("Orchestrator Harness", harnessName(plan.driver, plan.agentId)),
    fact("Orchestrator Model", plan.config.model ?? "Automatic"),
    fact("Orchestrator Effort", plan.config.effort ?? "Automatic"),
    fact("Child Harness", child ? harnessName(child.driver, child.agentId) : "Automatic"),
    fact("Child Model", behavior.childModel ?? "Automatic"),
    fact("Child Effort", behavior.childEffort ?? "Automatic"),
    fact("Concurrent Children", String(budget.concurrency)),
    fact("Follow-Ups", `${label(behavior.followUps)} · ${budget.acceptedFollowUps} accepted follow-ups`),
    fact("Completion", label(behavior.completion)),
    fact("Provider Permissions", plan.config.permissionMode === undefined ? "Harness Default" : label(plan.config.permissionMode)),
    fact("Isolation", `Strict Project Isolation ${execution.strictProjectIsolation ? "on" : "off"} · Integration Isolation ${execution.integrationIsolation ? "on" : "off"}`),
  ];
}

/** Registers one owner-confirmed launch. The returned function only refreshes a pending card;
 * it cannot approve it or create work. */
export function registerAssistantCampaignStart(operations: AssistantOperations, dependencies: FullControlLaunchDependencies,
  receipts: AssistantCommandReceipts) {
  const { db, sessions, settings } = dependencies;
  const store = db.assistantOwnerConfirmations;
  const confirmations = new AssistantCommandConfirmations(db.raw(), store);
  const locationFor = (args: CampaignArgs) => {
    const location = db.getProjectLocation(args.locationId);
    if (!location) throw new AssistantRefusal("Select a current Project Location from project_list.");
    return location;
  };
  const resolveTarget = (value: unknown) => {
    const location = locationFor(parseArgs(value));
    return { kind: "project", id: location.projectId, projectId: location.projectId };
  };
  const prepare = async (args: CampaignArgs, owner: HumanPrincipal, connection: AssistantConnection,
    budgetOverride?: OrchestratorCampaignBudgetDefault) => {
    if (!connection.threadId) throw new AssistantRefusal("Only a Wollipog Assistant thread can request this owner confirmation.");
    const location = locationFor(args);
    const runner = db.getRunner(location.runnerId);
    if (!runner || !db.canAccessRunner(owner, runner.runnerId) || !db.canAccessWorkspace(owner, runner.runnerId, location.workspaceId)) {
      throw new AssistantRefusal("The owner cannot access this Location's Machine and workspace.");
    }
    if (!runnerSupportsProtocol(runner.protocolVersion, "assistantCampaignLaunch")) {
      throw new AssistantRefusal("This Location's runner does not support Assistant campaign launches. Upgrade it or start the campaign from New Session.");
    }
    const selectedChild = args.childAgentId === undefined ? undefined : runner.agents.find(agent => agent.id === args.childAgentId && agent.available);
    if (args.childAgentId !== undefined && !selectedChild?.driver) throw new AssistantRefusal("Choose an available child agent on the selected Machine.");
    const placement = { runnerId: runner.runnerId, workspaceId: location.workspaceId, projectId: location.projectId, projectLocationId: location.id };
    const session = { agentId: args.agentId,
      config: { model: args.model, effort: args.effort },
      orchestrator: { behavior: {
        ...(selectedChild?.driver ? { childHarness: { agentId: selectedChild.id, driver: selectedChild.driver, context: selectedChild.context ?? { kind: "native" as const } } } : {}),
        ...(args.childModel !== undefined ? { childModel: args.childModel } : {}),
        ...(args.childEffort !== undefined ? { childEffort: args.childEffort } : {}),
      } },
    };
    const locationLabel = `${location.name} · ${runner.displayName || runner.hostname}`;
    const heading = fact("Campaign Mode", args.mode === "custom" ? "Custom" : "Full Control");
    const settingsView = settings.view(owner);
    const budgetDefault = budgetOverride ?? settingsView.defaults.campaignBudget ?? null;
    const wrap = (snapshot: unknown, facts: AssistantOwnerConfirmationDetail[]) => {
      const digest = campaignLaunchDigest({ placement, path: location.path, locationLabel, snapshot });
      const preview: CampaignConfirmationPreview = { facts: [heading, ...facts], budget: budgetDefault,
        ...(budgetOverride ? { budgetOverride } : {}) };
      return { digest, preview, location, locationLabel };
    };
    if (args.mode === "full_control") {
      const input = parseFullControlLaunchRequest({ ...placement, task: args.prompt,
        ...(args.issueNumbers ? { issueNumbers: args.issueNumbers } : {}),
        overrides: { session, ...(budgetOverride ? { budget: budgetOverride } : {}) },
      }, false);
      if (!input) throw new AssistantRefusal("The Full Control launch settings are invalid.");
      const prepared = await prepareFullControlLaunch(dependencies, owner, input, new AbortController().signal);
      if (!prepared.preflight) throw new AssistantRefusal(prepared.error);
      const { preflight } = prepared;
      const proposal = preflight.advanced.proposal;
      if (!preflight.ready || !proposal) {
        throw new AssistantRefusal(preflight.summary.blockers.map(blocker => blocker.reason).join(" ") || "The Full Control launch is blocked.");
      }
      const { summary } = preflight;
      const finalBudget = summary.budget.costUsd !== null && summary.budget.toolCalls !== null
        ? { costUsd: summary.budget.costUsd, toolCalls: summary.budget.toolCalls } : null;
      const plan = wrap(preflight.digest, [
        ...planFacts(preflight.advanced.plan, proposal.budgetAuthority!),
        fact("Repository Scope", summary.repositories?.map(repo => `${repo.repository} (${repo.locations.map(loc => loc.name).join(", ")})`).join("\n")
          ?? proposal.repository),
        fact("Initial Issues", proposal.issueNumbers.length ? proposal.issueNumbers.map(n => `#${n}`).join(", ") : "None"),
        fact("Issue Authority", `Up to ${summary.followUps.maxIssues} issues. Related follow-ups ${summary.followUps.relatedFollowUps ? "allowed" : "require owner admission"}. Closure reasons: ${summary.followUps.closureReasons.map(label).join(", ")}.`),
        fact("Delegated Operations", proposal.operations.map(label).join(", ")),
        ...(summary.excludedLocations?.length ? [fact("Excluded Locations", summary.excludedLocations.map(loc => `${loc.name}: ${loc.reason}`).join("\n"))] : []),
        ...(summary.limitedLocations?.length ? [fact("Limited Locations", summary.limitedLocations.map(loc => `${loc.name}: ${loc.reason}`).join("\n"))] : []),
        fact("Review", summary.review.statement),
        fact("Evidence", [summary.evidence.statement, summary.evidence.provider?.retentionDisclosure].filter(Boolean).join("\n")),
        fact("Human-Required Gates", summary.humanRequired.map(item => `${item.exception}: ${item.reason}`).join("\n")),
      ]);
      plan.preview.budget = finalBudget;
      return { ...plan, launch: prepared.launch };
    }
    const request: CreateSessionRequest = { ...placement, ...session, role: "orchestrator", prompt: args.prompt };
    const ownership = resolveSessionCreationOwnership(db, owner, request);
    if (!ownership.ok) throw new AssistantRefusal(ownership.error);
    const scope = { organizationId: owner.organizationId, owner: { kind: "user" as const, userId: owner.userId } };
    const context = { defaultOwnerUserId: owner.userId, orchestratorDefaults: settingsView,
      validateOrchestratorDefaults: (policy: PreparedCampaignLaunch["policy"]) => settings.compatibilityError(owner, policy) };
    let plan: PreparedCampaignLaunch | undefined;
    const inspected = sessions.createSession(ownership.body, undefined, scope, false, false, false,
      { ...context, inspectLaunchPlan: (value) => { plan = value; } });
    if (!plan) throw new AssistantRefusal(inspected.error ?? "The Custom launch could not be prepared.");
    const { behavior, delegation } = plan.policy;
    const budget: CampaignBudgetAuthority = { version: 1, accounting: "managed_workers_only", unpriced: "stop",
      concurrency: behavior.maximumConcurrentChildren, acceptedFollowUps: behavior.followUps === "execute_approved" ? 1 : 0,
      ...(budgetDefault ?? {}) };
    const accountingError = db.campaignBudgetAccountingError(plan.driver, plan.config.model, budget.costUsd !== undefined);
    if (accountingError) throw new AssistantRefusal(accountingError);
    const proposal = wrap({ plan, budget, runnerGeneration: runner.connectedAt, workspace: db.getWorkspacePath(runner.runnerId, location.workspaceId) }, [
      ...planFacts(plan, budget),
      fact("Issue Scope", "The first message goes through normal Custom campaign issue admission. Scope changes still require the owner's approval."),
      fact("Parent Control", label(delegation.parentControl)),
      fact("Decision Owners", Object.entries(delegation.decisions).map(([key, owner]) => `${label(key)}: ${label(owner)}`).join("\n")),
    ]);
    return { ...proposal, launch: (requestId: string) => sessions.createSession(ownership.body, undefined, scope, false, false, false, {
      ...context, humanCampaignLaunch: { principal: owner, requestId, digest: proposal.digest, customBudget: budget },
    }) };
  };

  const bindingFor = (connection: AssistantConnection, args: CampaignArgs, digest: string): OwnerConfirmationBinding => ({
    connectionId: connection.id, grantRevision: connection.revision, operation: ASSISTANT_CAMPAIGN_START,
    argumentsDigest: assistantRequestDigest(args), targetDigest: digest,
  });
  operations.register({
    name: ASSISTANT_CAMPAIGN_START, destructive: true,
    description: "Ask the thread owner to start one independent Orchestrator campaign. Supply a Project Location, first message and Custom or Full Control mode, with optional model settings. Only the owner can approve. Read command_get for the launched Session.",
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    resolveTarget, ownerCanAccess: (owner, target) => target.kind === "session"
      ? db.canAccessSession(owner, target.id)
      : target.kind === "receipt" || (target.kind === "project" && db.canAccessProject(owner, target.id)),
    execute: async (value, context) => {
      const { confirmationId, ...args } = parseArgs(value);
      if (!context.connection.threadId) throw new AssistantRefusal("Only a Wollipog Assistant thread can request this owner confirmation.");
      const approvedId = assistantCallContext.getStore()?.ownerConfirmationId;
      if (confirmationId !== undefined && !approvedId) throw new AssistantRefusal("Only the owner can approve this campaign in Wollipog. Nothing ran.");
      const stored = approvedId ? store.command(approvedId) : null;
      const target = resolveTarget(args);
      const prior = receipts.get(context.connection.id, args.commandId);
      const argumentsDigest = assistantRequestDigest(args);
      if (prior) {
        if (prior.operation !== ASSISTANT_CAMPAIGN_START || prior.argumentsDigest !== argumentsDigest) {
          throw new AssistantRefusal("This command ID already belongs to another request. Read command_get before retrying.");
        }
        return { recovery: "This campaign command was already reserved. Read command_get for its result." };
      }
      const owner = await context.recheck();
      const revision = db.assistantConnections.get(context.connection.id)!.revision;
      // Preparation uses the ordinary Human launch validation. It never creates a session.
      const proposed = await assistantCallContext.exit(() => prepare(args, owner, context.connection, stored?.campaign?.budgetOverride));
      await context.recheck();
      const live = db.assistantConnections.get(context.connection.id)!;
      const currentLocation = locationFor(args);
      if (revision !== live.revision || target.id !== currentLocation.projectId ||
          campaignLaunchDigest(currentLocation) !== campaignLaunchDigest(proposed.location)) {
        throw new AssistantRefusal("The Location or Assistant grant changed. Ask for a new campaign confirmation.");
      }
      const thread = db.assistantThreads.forConnection(live.id);
      if (!thread) throw new AssistantRefusal("The Assistant thread is no longer active.");
      const limitRefusal = sessions.assistantThreadLaunchLimitRefusal(thread.id, thread.launch_limit);
      if (limitRefusal) throw new AssistantRefusal(limitRefusal);
      const binding = bindingFor(live, args, proposed.digest);
      if (!approvedId) {
        return confirmations.preview(binding, { commandId: args.commandId, args, target,
          campaign: proposed.preview, targetLabel: proposed.locationLabel }, { operation: ASSISTANT_CAMPAIGN_START });
      }
      if (!proposed.preview.budget) throw new AssistantRefusal("The owner must set a campaign budget before starting it.");
      const reserved = receipts.reserve({ controlPlaneId: db.instanceId(), connectionId: live.id, operationId: args.commandId,
        operation: ASSISTANT_CAMPAIGN_START, argumentsDigest, grantRevision: live.revision, target },
      () => confirmations.consume(String(confirmationId), binding));
      if (!reserved.created) return { receipt: reserved.receipt };
      // Only this branch runs outside the thread's budget context, after the exact approval and
      // receipt were consumed atomically. The committed root has no parent in the thread tree.
      const result = assistantCallContext.exit(() => proposed.launch(assistantCampaignLaunchId(approvedId)));
      const retainedId = db.humanCampaignLaunchIdentity(owner.userId, assistantCampaignLaunchId(approvedId))?.sessionId;
      const receipt = receipts.settle(live.id, args.commandId, result.ok ? "succeeded" : retainedId ? "uncertain" : "failed", retainedId);
      return result.ok ? { receipt, sessionId: result.data?.id } : { receipt, error: result.error };
    },
  });

  return async (owner: HumanPrincipal, threadId: string, id: string, expectedDigest: string,
    budget: OrchestratorCampaignBudgetDefault): Promise<AssistantOwnerConfirmation | null> => {
    const command = store.command(id), current = store.get(id);
    if (command?.ownerUserId !== owner.userId || command.organizationId !== owner.organizationId || command.threadId !== threadId ||
        command.operation !== ASSISTANT_CAMPAIGN_START || current?.status !== "pending" || current.campaign?.digest !== expectedDigest) return null;
    if (!validOrchestratorCampaignBudgetDefault(budget)) throw new AssistantRefusal("Enter a positive cost budget and a positive whole number of tool calls.");
    const args = parseArgs(command.args);
    const connection = db.assistantConnections.get(command.connectionId);
    if (!connection) return null;
    operations.authorize(connection.id, ASSISTANT_CAMPAIGN_START, resolveTarget(args));
    const proposed = await prepare(args, owner, connection, budget);
    operations.authorize(connection.id, ASSISTANT_CAMPAIGN_START, resolveTarget(args));
    if (db.assistantConnections.get(connection.id)?.revision !== connection.revision ||
        campaignLaunchDigest(locationFor(args)) !== campaignLaunchDigest(proposed.location) ||
        current.target.id !== proposed.location.projectId) return null;
    return store.reviseCampaign(id, expectedDigest, bindingFor(connection, args, proposed.digest), proposed.preview, proposed.locationLabel);
  };
}
