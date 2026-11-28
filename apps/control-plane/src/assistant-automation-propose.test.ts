import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import {
  ASSISTANT_OWNER_CONFIRMATION_TTL_MS,
  PROTOCOL_VERSION,
  type AgentDefinition,
  type AssistantOwnerConfirmation,
  type AssistantThread,
  type AutomationSpec,
  type ControlPlaneToRunner,
  type WollipogPromptOrigin,
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { AutomationsService } from "./automations.js";
import { OrchestratorSettings } from "./orchestrator-settings.js";
import { ScheduledCampaignRuntime } from "./scheduled-campaigns.js";
import { scheduledAssistantOwner } from "./assistant-automation-authority.js";
import { registerAssistantAutomations } from "./assistant-automations.js";
import { registerAssistantAutomationPropose } from "./assistant-automation-propose.js";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";
import { assistantRequestDigest } from "./assistant-command-receipts.js";
import { ManagementMutations } from "./assistant-management-command.js";
import { ASSISTANT_DISCOVERY_MAX_BYTES, createAssistantOperations } from "./assistant-routes.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { createAssistantOwnerConfirmationService, createAssistantThreads } from "./assistant-threads.js";
import { registerAssistantThreadRoutes } from "./assistant-thread-routes.js";
import type { HumanPrincipal } from "./identity.js";

const claude: AgentDefinition = {
  id: "claude", name: "Claude", driver: "claude-code", context: { kind: "native" },
  command: "claude", args: [], env: {}, available: true,
  installation: { id: "claude-native-1", path: "/usr/local/bin/claude", via: "path" },
  capabilities: {
    models: [{ id: "claude-opus-5-5", displayName: "Opus", default: true, efforts: ["medium", "high"] },
      { id: "claude-sonnet-4-6", displayName: "Sonnet", efforts: ["medium", "high"] }],
    effortLevels: ["medium", "high"],
    slashCommands: [], supportsImages: true, imageToolResults: true,
    supportsApprovals: true, orchestratorAdditive: true, permissionModes: ["default", "read-only", "orchestrator"],
  },
};

async function harness() {
  let clock = Date.UTC(2026, 10, 28, 8, 0, 0);
  const now = () => clock;
  const advance = (ms: number) => { clock += ms; };

  const db = ControlPlaneDb.open(":memory:");
  const rate = { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001, cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 };
  db.setUsageRateTable(new Map([["claude-opus-5-5", rate], ["claude-sonnet-4-6", rate]]));
  const identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  db.registerRunner({
    runnerId: "r-primary", hostname: "primary-host", os: "linux", version: "fixture",
    workspaces: [
      { id: "w-main", name: "Main Repo", path: "/srv/main-repo" },
      { id: "w-other", name: "Other Repo", path: "/srv/other-repo" },
    ],
    agents: [claude],
    runtime: { dataDir: "/fixture", worktreeRoot: "/fixture/worktrees", maxConcurrentSessions: 4, campaignLaunchInspection: { version: 3 } },
  }, now(), PROTOCOL_VERSION);

  const projectA = db.createProject({ name: "Core Platform" });
  const locationA = db.addProjectLocation(projectA.id, { runnerId: "r-primary", workspaceId: "w-main" });
  const projectB = db.createProject({ name: "Billing Service" });
  const locationB = db.addProjectLocation(projectB.id, { runnerId: "r-primary", workspaceId: "w-other" });

  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  const sent: ControlPlaneToRunner[] = [];
  hub.sendToRunner = (_id, message) => { sent.push(message); return true; };

  const logger = { info() {}, warn() {}, error() {} };
  const svc = new SessionsService(db, hub, logger);
  const orchestratorSettings = new OrchestratorSettings(db);
  const scheduledCampaigns = new ScheduledCampaignRuntime(db, hub, svc, orchestratorSettings);
  const automations = new AutomationsService(db, hub, svc, logger, undefined, scheduledCampaigns);

  const threads = createAssistantThreads(db, hub, svc);
  const operations = createAssistantOperations(db);
  const receipts = registerAssistantSessionOperations(operations, db, svc);
  const managementMutations = new ManagementMutations(
    receipts, db.instanceId(), assistantRequestDigest,
    (id) => db.assistantConnections.get(id)!,
    (id) => db.assistantConnections.destructiveConfirmation(id),
    new AssistantCommandConfirmations(db.raw(), db.assistantOwnerConfirmations),
  );
  registerAssistantAutomations(operations, db, automations, managementMutations);
  registerAssistantAutomationPropose(operations, { db, campaigns: scheduledCampaigns, receipts, now });

  const told: Array<{ sessionId: string; text: string; origin: WollipogPromptOrigin }> = [];
  const confirmations = createAssistantOwnerConfirmationService(db, {
    promptWollipogNotice: (sessionId, text, origin) => {
      const result = svc.promptWollipogNotice(sessionId, text, origin);
      if (result.ok) told.push({ sessionId, text, origin });
      return result;
    },
  }, operations);
  // Keep confirmation service clock synced with test clock.
  (confirmations as unknown as { deps: { now: () => number } }).deps.now = now;

  let requester: HumanPrincipal | null = owner;
  const app = Fastify();
  registerAssistantThreadRoutes(app, { threads, confirmations, requestHuman: () => requester });
  await app.ready();

  const ownerCall = async (method: "GET" | "POST" | "PUT", url: string, payload?: object) => {
    const response = await app.inject({ method, url, ...(payload !== undefined ? { payload } : {}) });
    return { status: response.statusCode, body: response.json() as any };
  };

  const thread = (await ownerCall("POST", "/api/assistant-threads")).body.thread as AssistantThread;
  const token = `wollipoga_${randomBytes(32).toString("base64url")}`;
  assert.equal(threads.registerCredential("r-primary", thread.sessionId, hashToken(token)).accepted, true);
  db.updateSessionStatus(thread.sessionId, "idle", now());
  const credential = db.assistantConnections.authenticate(token)!;
  const call = (name: string, args: Record<string, unknown> = {}) => operations.call(credential, name, args) as Promise<any>;

  const outsideIssued = db.assistantConnections.create(owner, "Outside Assistant", { operations: "all", projects: "all" });
  const outsideCred = db.assistantConnections.authenticate(outsideIssued.token)!;
  const outsideCall = (name: string, args: Record<string, unknown> = {}) => operations.call(outsideCred, name, args) as Promise<any>;

  const pending = () => db.assistantOwnerConfirmations.pendingForThread(thread.id, now());

  const standaloneSpec = (overrides: Partial<AutomationSpec> = {}): AutomationSpec => ({
    name: "Weekly Read-Only Review",
    cron: "0 9 * * 1",
    timezone: "UTC",
    enabled: true,
    misfirePolicy: { kind: "skip" },
    runnerPolicy: { kind: "wait" },
    concurrencyPolicy: "skip",
    limits: { maxCostUsd: 3, maxToolCalls: 40 },
    notifications: { pushEvents: ["succeeded", "failed"] },
    action: {
      kind: "create_session",
      request: {
        runnerId: "r-primary",
        workspaceId: "w-main",
        projectId: projectA.id,
        projectLocationId: locationA.id,
        agentId: "claude",
        useWorktree: true,
        config: { model: "claude-sonnet-4-6", effort: "high", permissionMode: "read-only" },
        prompt: "Review repository health without making edits.",
      },
    },
    ...overrides,
  });

  const campaignSpec = (controlMode: "custom" | "full_control" = "full_control"): AutomationSpec => ({
    name: "Nightly Maintenance Campaign",
    cron: "0 2 * * *",
    timezone: "UTC",
    enabled: true,
    misfirePolicy: { kind: "skip" },
    runnerPolicy: { kind: "wait" },
    concurrencyPolicy: "wait",
    limits: { maxCostUsd: 12, maxToolCalls: 120 },
    notifications: { pushEvents: ["succeeded", "failed"] },
    action: {
      kind: "create_session",
      request: {
        runnerId: "r-primary",
        workspaceId: "w-main",
        projectId: projectA.id,
        projectLocationId: locationA.id,
        agentId: "claude",
        role: "orchestrator",
        useWorktree: false,
        prompt: "Coordinate nightly read-only checks.",
        orchestrator: {
          delegation: {
            parentControl: "questions",
            decisions: { pr_merge: "human", implementation_question: "orchestrator" },
          },
        },
        campaign: {
          controlMode,
          repository: "picoduck/wollipog",
          tasks: [
            { key: "dead-code", title: "Dead Code Sweep", prompt: "Report unused exports without editing." },
            { key: "flaky-tests", title: "Flaky Tests Check", prompt: "Summarize recent intermittent failures." },
          ],
          ...(controlMode === "full_control" ? {
            fullControl: {
              objective: "Keep the main repository healthy.",
              operations: ["implementation_question", "follow_up_issue_publication"],
              budget: { costUsd: 10, toolCalls: 100, concurrency: 2, acceptedFollowUps: 1 },
              issues: { relatedFollowUps: false, maxIssues: 5, closureReasons: ["completed"] },
            },
          } : {}),
        },
      },
    },
  });

  return {
    db, owner, hub, svc, automations, orchestratorSettings, scheduledCampaigns, threads, operations,
    receipts, confirmations, thread, call, outsideCall, outsideIssued, ownerCall, pending, sent, told,
    projectA, locationA, projectB, locationB, now, advance, standaloneSpec, campaignSpec,
    setRequester: (principal: HumanPrincipal | null) => { requester = principal; },
    close: async () => { await app.close(); db.close(); },
  };
}

const strings = (value: unknown): string[] => typeof value === "string" ? [value]
  : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

test("AC1: thread discovery exposes auto_propose and omits thread-excluded automation mutations", async () => {
  const h = await harness();
  try {
    // Collect all operations returned by paged discovery for the built-in thread.
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.call("assistant_discover", cursor ? { cursor } : {});
      const escapedBytes = Buffer.byteLength(JSON.stringify(JSON.stringify(page))) - 2;
      assert.ok(escapedBytes <= ASSISTANT_DISCOVERY_MAX_BYTES, `page exceeded byte limit: ${escapedBytes}`);
      names.push(...page.operations.map((op: { name: string }) => op.name));
      cursor = page.nextCursor;
    } while (cursor);

    assert.ok(names.includes("auto_propose"), "built-in thread discovers auto_propose");
    assert.ok(names.includes("auto_list") && names.includes("auto_get"), "read tools remain discoverable");
    for (const excluded of ["auto_create", "auto_update", "auto_enable", "auto_test", "session_role", "session_adopt", "session_fork"]) {
      assert.equal(names.includes(excluded), false, `thread discovery must omit ${excluded}`);
    }

    // Schema discovery fits within Codex's tool-result byte bound.
    const schemaResult = await h.call("assistant_discover", { operations: ["auto_propose"] });
    const schemaBytes = Buffer.byteLength(JSON.stringify(JSON.stringify(schemaResult))) - 2;
    assert.ok(schemaBytes <= ASSISTANT_DISCOVERY_MAX_BYTES, `auto_propose schema exceeded byte limit: ${schemaBytes}`);
    assert.equal(schemaResult.operations[0].name, "auto_propose");
    assert.deepEqual(schemaResult.operations[0].inputSchema.required, ["commandId", "payload"]);

    // Guide names auto_propose for built-in threads.
    const skill = await h.call("assistant_discover", { skill: true });
    assert.match(skill.skill.content, /auto_propose/);

    // Calling auto_create directly is still refused, pointing to auto_propose.
    await assert.rejects(
      h.call("auto_create", { operationId: "direct-1", payload: h.standaloneSpec() }),
      /cannot call auto_create.*auto_propose/u,
    );

    // External Assistant connections still discover auto_create and cannot see or call auto_propose.
    const outsideNames = h.operations.list(h.outsideIssued.connection).map((op) => op.name);
    assert.ok(outsideNames.includes("auto_create"));
    assert.equal(outsideNames.includes("auto_propose"), false);
    await assert.rejects(
      h.outsideCall("auto_propose", { commandId: "outside-1", payload: h.standaloneSpec() }),
      /requires an explicit grant to a Wollipog Assistant thread/u,
    );
  } finally {
    await h.close();
  }
});

test("AC2 & AC3: standalone automation approval saves exact owner-authorized schedule once and supports readback without a test run", async () => {
  const h = await harness();
  try {
    const spec = h.standaloneSpec();
    const proposal = await h.call("auto_propose", { commandId: "review-1", payload: spec });
    assert.equal(proposal.ownerConfirmationRequired, true);
    assert.equal(proposal.confirmationId, undefined);
    assert.equal(proposal.enabled, true);
    assert.ok(proposal.nextFireAt > h.now());
    assert.equal(h.db.listAutomations().length, 0, "proposing must not create a schedule");

    const [card] = h.pending();
    assert.ok(card);
    assert.equal(card.title, "Create Automation");
    assert.equal(card.operation, "auto_propose");
    assert.ok(card.automation);
    assert.equal(card.automation.snapshot.spec.name, "Weekly Read-Only Review");
    assert.equal(card.automation.snapshot.spec.enabled, true);
    assert.equal(card.automation.snapshot.spec.limits.maxCostUsd, 3);
    assert.equal(card.automation.snapshot.spec.limits.maxToolCalls, 40);
    assert.equal(card.automation.targetDisplay?.projectName, "Core Platform");
    assert.equal(card.automation.targetDisplay?.runnerName, "primary-host");
    assert.equal(card.automation.targetDisplay?.workspaceName, "Main Repo");
    assert.equal(card.automation.targetDisplay?.workspacePath, "/srv/main-repo");
    assert.ok(!strings(proposal).includes(card.id), "confirmation id must never leak to the thread");

    // Forged confirmationId from the assistant cannot self-approve.
    for (const forged of [card.id, "owner-approved", card.automation.digest]) {
      await assert.rejects(
        h.call("auto_propose", { commandId: "review-1", payload: spec, confirmationId: forged }),
        /Only the owner can approve this automation/u,
      );
    }
    assert.equal(h.db.listAutomations().length, 0);

    // Legacy /approve endpoint and wrong digest refuse.
    const legacy = await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${card.id}/approve`);
    assert.equal(legacy.status, 409);
    const wrongDigest = await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${card.id}/approve-automation`, {
      digest: "f".repeat(64),
    });
    assert.equal(wrongDigest.status, 409);
    assert.equal(h.db.listAutomations().length, 0);

    // Non-owner is refused.
    h.setRequester({ ...h.owner, role: "admin" });
    const nonOwner = await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${card.id}/approve-automation`, {
      digest: card.automation.digest,
    });
    assert.equal(nonOwner.status, 403);
    h.setRequester(h.owner);

    // Owner approves with exact digest; concurrent repeat creates exactly one schedule.
    const [first, second] = await Promise.all([
      h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${card.id}/approve-automation`, {
        digest: card.automation.digest,
      }),
      h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${card.id}/approve-automation`, {
        digest: card.automation.digest,
      }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.confirmation.status, "executed");
    assert.equal(first.body.confirmation.outcome.receiptStatus, "succeeded");
    const automationId = first.body.confirmation.outcome.automationId as string;
    assert.match(automationId, /^auto_/u);
    assert.equal(second.body.confirmation.outcome.automationId, automationId);
    assert.equal(h.db.listAutomations().length, 1);

    // Thread receives outcome notice with Automation ID.
    assert.equal(h.told.length, 1);
    assert.match(h.told[0]!.text, new RegExp(`Automation ID: ${automationId}`));

    // Assistant verifies receipt and exact saved schedule + next occurrence without firing a test run.
    const receipt = await h.call("command_get", { commandId: "review-1" });
    assert.equal(receipt.receipt.status, "succeeded");
    assert.equal(receipt.receipt.resourceId, automationId);

    const readback = await h.call("auto_get", { automationId });
    assert.equal(readback.automation.automationId, automationId);
    assert.equal(readback.automation.name, "Weekly Read-Only Review");
    assert.equal(readback.automation.enabled, true);
    assert.ok(readback.automation.nextFireAt > h.now());
    assert.deepEqual(readback.automation.limits, { maxCostUsd: 3, maxToolCalls: 40 });
    assert.deepEqual(readback.executions, [], "no test run was fired");

    // Saved as owner-authorized human schedule, with no assistant_automation_authority binding.
    assert.equal(h.db.automationSoleHumanAuthor(automationId, true), h.owner.userId);
    assert.equal(scheduledAssistantOwner(h.db, readback.automation), null);
    assert.equal(
      (h.db.raw().prepare("SELECT COUNT(*) AS n FROM assistant_automation_authority WHERE automation_id=?").get(automationId) as { n: number }).n,
      0,
    );

    // Retrying auto_propose with same commandId after approval reconciles receipt, no duplicate.
    const retry = await h.call("auto_propose", { commandId: "review-1", payload: spec });
    assert.equal(retry.receipt.status, "succeeded");
    assert.equal(retry.receipt.resourceId, automationId);
    assert.equal(retry.automation.automationId, automationId);
    assert.equal(h.db.listAutomations().length, 1);

    // Reusing the same commandId with different arguments refuses.
    await assert.rejects(
      h.call("auto_propose", { commandId: "review-1", payload: h.standaloneSpec({ name: "Different Name" }) }),
      /already belongs to another request/u,
    );
  } finally {
    await h.close();
  }
});

test("AC2, AC3 & AC5: scheduled Orchestrator campaign works even when thread launches are paused and runs after thread closes", async () => {
  const h = await harness();
  try {
    // Pause thread launches and set tiny thread budget to prove schedule is independent of thread limits.
    h.threads.setLimits(h.owner, h.thread.id, { costUsd: 1, launchedSessions: 0, launchPaused: true });

    const spec = h.campaignSpec("full_control");
    const proposal = await h.call("auto_propose", { commandId: "campaign-auto-1", payload: spec });
    assert.equal(proposal.ownerConfirmationRequired, true);
    assert.ok(proposal.campaignDecisions);
    assert.equal(proposal.campaignDecisions.controlMode, "full_control");
    assert.equal(proposal.campaignDecisions.parentControl, "questions");
    assert.equal(proposal.campaignDecisions.decisions.pr_merge, "human");
    assert.equal(proposal.campaignDecisions.decisions.implementation_question, "orchestrator");
    assert.deepEqual(proposal.campaignDecisions.fullControlOperations, ["implementation_question", "follow_up_issue_publication"]);
    assert.equal(proposal.campaignDecisions.budget.costUsd, 10);

    const [card] = h.pending();
    assert.ok(card?.automation?.campaignDecisions);
    assert.equal(card.automation.snapshot.spec.action.kind, "create_session");
    assert.equal(card.automation.snapshot.spec.action.request.campaign?.tasks.length, 2);

    const approved = await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${card.id}/approve-automation`, {
      digest: card.automation.digest,
    });
    assert.equal(approved.status, 200);
    const automationId = approved.body.confirmation.outcome.automationId as string;

    // Thread can verify effectiveCampaign via auto_get without firing a test run.
    const readback = await h.call("auto_get", { automationId });
    assert.equal(readback.automation.automationId, automationId);
    assert.equal(readback.effectiveCampaign.controlMode, "full_control");
    assert.equal(readback.effectiveCampaign.repository, "picoduck/wollipog");
    assert.equal(readback.effectiveCampaign.tasks.length, 2);
    assert.equal(readback.effectiveCampaign.delegation.decisions.pr_merge, "human");
    assert.equal(readback.effectiveCampaign.budget.costUsd, 10);
    assert.deepEqual(readback.executions, []);

    // Close / archive the originating Assistant thread (which revokes its Assistant connection).
    h.threads.archive(h.owner, h.thread.id);
    assert.equal(h.db.assistantConnections.get(h.thread.connectionId!)?.revoked, true);

    // Schedule remains owner-authorized and runnable after thread closure.
    const saved = h.db.getAutomation(automationId)!;
    assert.equal(h.db.automationSoleHumanAuthor(automationId, true), h.owner.userId);
    assert.equal(scheduledAssistantOwner(h.db, saved), null);
    const previewAfterClose = h.automations.campaignPreview(saved, h.owner);
    assert.ok(previewAfterClose && !("error" in previewAfterClose));
    assert.equal(previewAfterClose.budget.costUsd, 10);

    // If owner is later suspended, schedule authority is revoked (subject to owner's current authority).
    h.db.raw().prepare("UPDATE identity_users SET status='suspended' WHERE user_id=?").run(h.owner.userId);
    const previewSuspended = h.automations.campaignPreview(saved, h.owner);
    assert.ok(previewSuspended && "error" in previewSuspended);
  } finally {
    await h.close();
  }
});

test("AC5: standalone approved schedule fires and runs with its own limits after originating thread closes", async () => {
  const h = await harness();
  try {
    const spec = h.standaloneSpec({ enabled: true, limits: { maxCostUsd: 4, maxToolCalls: 25 } });
    await h.call("auto_propose", { commandId: "standalone-run-1", payload: spec });
    const [card] = h.pending();
    const approved = await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${card!.id}/approve-automation`, {
      digest: card!.automation!.digest,
    });
    const automationId = approved.body.confirmation.outcome.automationId as string;

    // Archive originating thread -> revokes thread's Assistant connection.
    h.threads.archive(h.owner, h.thread.id);
    assert.equal(h.db.assistantConnections.get(h.thread.connectionId!)?.revoked, true);

    // Advance clock to nextFireAt and run scheduler tick.
    const saved = h.db.getAutomation(automationId)!;
    assert.ok(saved.nextFireAt);
    h.automations.tick(saved.nextFireAt);

    const executions = h.db.listAutomationExecutions(automationId);
    assert.equal(executions.length, 1);
    assert.ok(executions[0]!.sessionId, "automation dispatched a session after thread closed");
    const launched = h.db.getSession(executions[0]!.sessionId!)!;
    assert.equal(launched.costBudgetUsd, 4);
    assert.equal(launched.maxToolCalls, 25);
  } finally {
    await h.close();
  }
});

test("AC4: declined, expired, materially changed, and out-of-scope requests create no schedule", async () => {
  const h = await harness();
  try {
    // 1. Declined proposal creates no schedule, and retrying same commandId is refused.
    await h.call("auto_propose", { commandId: "declined-1", payload: h.standaloneSpec() });
    const [declinedCard] = h.pending();
    const denied = await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${declinedCard!.id}/deny`);
    assert.equal(denied.status, 200);
    assert.equal(denied.body.confirmation.status, "denied");
    assert.equal(h.db.listAutomations().length, 0);
    await assert.rejects(
      h.call("auto_propose", { commandId: "declined-1", payload: h.standaloneSpec() }),
      /denied automation proposal/u,
    );

    // 2. Duplicate pending call with identical payload returns existing card; different payload refuses.
    await h.call("auto_propose", { commandId: "dup-pending", payload: h.standaloneSpec() });
    await h.call("auto_propose", { commandId: "dup-pending", payload: h.standaloneSpec() });
    assert.equal(h.pending().length, 1);
    await assert.rejects(
      h.call("auto_propose", { commandId: "dup-pending", payload: h.standaloneSpec({ name: "Changed" }) }),
      /different automation proposal/u,
    );

    // 3. Expired proposal creates no schedule.
    h.advance(ASSISTANT_OWNER_CONFIRMATION_TTL_MS + 1_000);
    const expiredCard = h.db.assistantOwnerConfirmations.get(h.db.raw().prepare("SELECT id FROM assistant_owner_confirmations WHERE command_id='dup-pending'").get()!.id as string)!;
    const expiredRes = await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${expiredCard.id}/approve-automation`, {
      digest: expiredCard.automation!.digest,
    });
    assert.equal(expiredRes.status, 200);
    assert.equal(expiredRes.body.confirmation.status, "expired");
    assert.equal(h.db.listAutomations().length, 0);

    // 4. Materially changed campaign delegated decisions before approval refuses.
    await h.call("auto_propose", { commandId: "drift-decisions", payload: h.campaignSpec("custom") });
    const [driftCard] = h.pending();
    const currentDefaults = h.orchestratorSettings.view(h.owner).defaults;
    h.orchestratorSettings.update(h.owner, {
      defaults: {
        behavior: currentDefaults.behavior,
        execution: currentDefaults.execution,
        delegation: {
          ...currentDefaults.delegation,
          decisions: { ...currentDefaults.delegation.decisions, follow_up_issue_publication: "orchestrator" },
        },
      },
    });
    const driftRes = await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${driftCard!.id}/approve-automation`, {
      digest: driftCard!.automation!.digest,
    });
    assert.equal(driftRes.status, 200);
    assert.equal(driftRes.body.confirmation.status, "refused");
    assert.equal(h.db.listAutomations().length, 0);

    // 5. Materially changed workspace path before approval refuses.
    await h.call("auto_propose", { commandId: "drift-workspace", payload: h.standaloneSpec() });
    const [wsCard] = h.pending();
    h.db.registerRunner({
      runnerId: "r-primary", hostname: "primary-host", os: "linux", version: "fixture",
      workspaces: [
        { id: "w-main", name: "Main Repo", path: "/srv/relocated-repo" },
        { id: "w-other", name: "Other Repo", path: "/srv/other-repo" },
      ],
      agents: [claude],
      runtime: { dataDir: "/fixture", worktreeRoot: "/fixture/worktrees", maxConcurrentSessions: 4, campaignLaunchInspection: { version: 3 } },
    }, h.now(), PROTOCOL_VERSION);
    const wsRes = await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/${wsCard!.id}/approve-automation`, {
      digest: wsCard!.automation!.digest,
    });
    assert.equal(wsRes.status, 200);
    assert.equal(wsRes.body.confirmation.status, "refused");
    assert.equal(h.db.listAutomations().length, 0);

    // 6. Selected-project connection grant refuses out-of-scope target.
    h.db.assistantConnections.configure(h.thread.connectionId!, {
      operations: "all", projects: [h.projectA.id], destructiveConfirmation: "confirm",
    });
    await assert.rejects(
      h.call("auto_propose", {
        commandId: "out-of-scope",
        payload: h.standaloneSpec({
          action: {
            kind: "create_session",
            request: {
              runnerId: "r-primary", workspaceId: "w-other",
              projectId: h.projectB.id, projectLocationId: h.locationB.id,
              agentId: "claude", useWorktree: true, prompt: "Out of scope.",
            },
          },
        }),
      }),
      /target project is excluded|outside the selected projects/u,
    );
    assert.equal(h.db.listAutomations().length, 0);
  } finally {
    await h.close();
  }
});

test("AC3 & AC4: paused schedule stays paused and restart recovery finishes an interrupted approval once", async () => {
  const h = await harness();
  try {
    await h.call("auto_propose", { commandId: "paused-1", payload: h.standaloneSpec({ enabled: false }) });
    const [card] = h.pending();
    // Simulate approval recorded right before a control-plane crash.
    assert.equal(h.db.assistantOwnerConfirmations.approve(card!.id, h.owner, h.now()), true);
    assert.equal(h.db.listAutomations().length, 0);

    // On restart, resumeInterrupted executes it once and notifies the thread.
    await h.confirmations.resumeInterrupted();
    assert.equal(h.db.listAutomations().length, 1);
    const settled = h.db.assistantOwnerConfirmations.get(card!.id)!;
    assert.equal(settled.status, "executed");
    const automationId = settled.outcome?.automationId!;
    assert.ok(automationId);
    const saved = h.db.getAutomation(automationId)!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.nextFireAt ?? null, null);

    // Running resumeInterrupted again does nothing.
    await h.confirmations.resumeInterrupted();
    assert.equal(h.db.listAutomations().length, 1);
  } finally {
    await h.close();
  }
});
