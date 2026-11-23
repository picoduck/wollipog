import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { PROTOCOL_VERSION, type ControlPlaneToRunner, type RunnerMetadata } from "@wollipog/protocol";
import { nextCronFire } from "@wollipog/protocol/cron-schedule";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { OrchestratorSettings } from "./orchestrator-settings.js";
import { AutomationsService } from "./automations.js";
import { ScheduledCampaignRuntime } from "./scheduled-campaigns.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { assistantRequestDigest } from "./assistant-command-receipts.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { ManagementMutations } from "./assistant-management-command.js";
import { registerAssistantAutomations } from "./assistant-automations.js";

/** #4869: a client that follows the advertised automation schema can save a complete scheduled
 * campaign, with explicit overrides, and read back its effective settings without running it. */

type Schema = Record<string, unknown>;

/** The JSON Schema subset the Assistant schemas use. Returns the first violation's path, or null. */
function violation(schema: Schema, value: unknown, path = "payload"): string | null {
  const types = schema.type === undefined ? null : ([] as unknown[]).concat(schema.type);
  if (types) {
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const ok = types.some(type => type === kind || (type === "integer" && Number.isInteger(value)));
    if (!ok) return `${path}: expected ${types.join(" or ")}`;
  }
  if ("const" in schema && schema.const !== value) return `${path}: expected ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path}: not one of ${JSON.stringify(schema.enum)}`;
  if (Array.isArray(schema.oneOf)) {
    const errors = (schema.oneOf as Schema[]).map(option => violation(option, value, path));
    const matches = errors.filter(error => error === null).length;
    // Report the option that matched this level (its discriminator) but failed deeper down.
    if (matches !== 1) return (matches ? null : errors.find(error => !error!.startsWith(`${path}:`))) ?? `${path}: matches ${matches} oneOf options`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path}: below ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path}: above ${schema.maximum}`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `${path}: not above ${schema.exclusiveMinimum}`;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path}: too short`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path}: too long`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return `${path}: does not match ${schema.pattern}`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path}: too few items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path}: too many items`;
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return `${path}: duplicate items`;
    if (schema.items) for (const [index, item] of value.entries()) {
      const nested = violation(schema.items as Schema, item, `${path}[${index}]`);
      if (nested) return nested;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in value)) return `${path}.${key}: required`;
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) {
        const nested = violation(properties[key]!, item, `${path}.${key}`);
        if (nested) return nested;
      } else if (schema.additionalProperties === false) return `${path}.${key}: not allowed`;
    }
  }
  return null;
}

function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const capabilities = { models: [{ id: "claude-opus-5-5", default: true, efforts: ["high", "medium"] }],
    effortLevels: ["high", "medium"], permissionModes: ["default", "orchestrator"],
    slashCommands: [], supportsImages: true, supportsApprovals: true, orchestratorAdditive: true };
  const meta: RunnerMetadata = { runnerId: "r", hostname: "fixture", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repository", path: "/fixture/repo" }],
    agents: [{ id: "parent", name: "Parent", command: "claude", args: [], env: {}, available: true,
      driver: "claude-code", context: { kind: "native" }, capabilities },
    { id: "child", name: "Child", command: "codex", args: [], env: {}, available: true,
      driver: "codex-app-server", context: { kind: "native" }, capabilities: { ...capabilities,
        models: [{ id: "codex-fixture-model", default: true, efforts: ["high", "medium"] }],
        permissionModes: ["auto-review"] } }],
    runtime: { dataDir: "/fixture/data", worktreeRoot: "/fixture/worktrees", maxConcurrentSessions: 4,
      campaignLaunchInspection: { version: 3 }, executionIsolation: { mode: "provider", network: "inherit" } } };
  db.registerRunner(meta, Date.now(), PROTOCOL_VERSION);
  const rate = { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001, cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 };
  db.setUsageRateTable(new Map([["claude-opus-5-5", rate], ["codex-fixture-model", rate]]));
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  const sent: ControlPlaneToRunner[] = [];
  hub.sendToRunner = (_runnerId, message) => { sent.push(message); return true; };
  const sessions = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const runtime = new ScheduledCampaignRuntime(db, hub, sessions, new OrchestratorSettings(db));
  const automations = new AutomationsService(db, hub, sessions, { info() {}, warn() {} }, undefined, runtime);
  const issued = db.assistantConnections.create(owner, "Scheduling Assistant", { operations: "all", projects: "all" });
  const operations = createAssistantOperations(db);
  const receipts = registerAssistantSessionOperations(operations, db, sessions);
  const mutations = new ManagementMutations(receipts, db.instanceId(), assistantRequestDigest, id => db.assistantConnections.get(id)!,
    id => db.assistantConnections.destructiveConfirmation(id));
  registerAssistantAutomations(operations, db, automations, mutations);
  const app = Fastify();
  registerAssistantRoutes(app, { db, operations, requestHuman: () => owner });
  const call = async (name: string, args: unknown = {}) => {
    const response = await app.inject({ method: "POST", url: "/assistant/mcp", headers: { authorization: `Bearer ${issued.token}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    const result = response.json().result;
    assert.ok(result, response.body);
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  return { db, app, call, issued, sent, automations };
}

const behavior = {
  childHarness: { agentId: "codex-app-server", driver: "codex-app-server", context: { kind: "native" } },
  childModel: "codex-fixture-model", childEffort: "medium", maximumConcurrentChildren: 2,
  followUps: "execute_approved", completion: "stop_and_archive", reviewRoundBudget: 3,
};
const payload = (tasks = [
  { key: "maintenance", title: "Maintenance", prompt: "Investigate stale flags." },
  { key: "coverage", title: "Coverage", prompt: "Investigate meaningful coverage gaps." },
]) => ({
  name: "Daily Campaign", cron: "0 9 * * *", timezone: "America/Chicago", enabled: true,
  misfirePolicy: { kind: "skip" }, runnerPolicy: { kind: "wait" }, concurrencyPolicy: "wait",
  limits: { maxCostUsd: 20, maxToolCalls: 200 }, notifications: { pushEvents: ["failed"] },
  action: { kind: "create_session", request: { runnerId: "r", workspaceId: "w", projectId: null, projectLocationId: null,
    agentId: "parent", role: "orchestrator", prompt: "Review the daily findings.", useWorktree: false,
    config: { model: "claude-opus-5-5", effort: "high", permissionMode: "orchestrator" },
    orchestrator: { behavior, delegation: { parentControl: "questions_and_approvals", decisions: { pr_merge: "orchestrator" } },
      execution: { integrationIsolation: true } },
    campaign: { controlMode: "full_control", repository: "owner/repo", tasks,
      fullControl: { issues: { maxIssues: 10 }, budget: { acceptedFollowUps: 3, costUsd: 15 } } } } },
});

test("an Assistant discovers, saves, updates and reads back a multi-task campaign schedule without running it", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.db.close(); });

  const discovery = await f.call("assistant_discover", { operations: ["auto_create", "auto_update"] });
  const operations = new Map<string, { inputSchema: Schema }>(discovery.operations.map((o: { name: string; inputSchema: Schema }) => [o.name, o]));
  // Each schema fits discovery on its own; one that does not fit beside the first is listed as remaining.
  for (const name of discovery.remaining ?? []) {
    const rest = await f.call("assistant_discover", { operations: [name] });
    operations.set(name, rest.operations[0]);
  }
  const schemaOf = (name: string) => (operations.get(name)!.inputSchema.properties as Record<string, Schema>).payload!;
  const create = schemaOf("auto_create");
  const requestSchema = ((create.properties as Record<string, Schema>).action!.oneOf as Schema[])
    .find(option => ((option.properties as Record<string, Schema>).kind!.const === "create_session"))!;
  const fields = ((requestSchema.properties as Record<string, Schema>).request!.properties) as Record<string, Schema>;
  assert.equal(fields.orchestrator!.type, "object");
  assert.deepEqual(Object.keys(fields.orchestrator!.properties as object), ["behavior", "delegation", "execution"]);
  const advertisedBehavior = Object.keys((fields.orchestrator!.properties as Record<string, Schema>).behavior!.properties as object);
  for (const key of ["childHarness", "childModel", "childEffort", "maximumConcurrentChildren", "followUps", "completion",
    "reviewHarness", "reviewModel", "reviewEffort", "reviewRoundBudget"]) assert.ok(advertisedBehavior.includes(key), key);
  assert.deepEqual(Object.keys(fields.campaign!.properties as object), ["controlMode", "repository", "tasks", "fullControl"]);
  assert.deepEqual(schemaOf("auto_update"), create);

  // The complete configuration conforms to the advertised schema; the shape the issue reported does not.
  assert.equal(violation(create, payload()), null);
  const legacy = payload();
  (legacy.action.request as Record<string, unknown>).orchestrator = true;
  assert.match(violation(create, legacy) ?? "", /orchestrator: expected object/);
  assert.match(violation(create, { ...payload(), action: { ...payload().action, request: { ...payload().action.request,
    campaign: { ...payload().action.request.campaign, extra: 1 } } } }) ?? "", /campaign\.extra: not allowed/);

  const before = Date.now();
  const created = await f.call("auto_create", { operationId: "create-campaign", payload: payload() });
  const automationId = created.result.automationId as string;
  assert.ok(automationId);
  const read = await f.call("auto_get", { automationId });
  assert.deepEqual(read.automation.action, payload().action);
  assert.equal(read.automation.enabled, true);
  assert.equal(read.automation.cron, "0 9 * * *");
  assert.equal(read.automation.timezone, "America/Chicago");
  const next = read.automation.nextFireAt as number;
  assert.ok(next > before);
  assert.equal(next, nextCronFire("0 9 * * *", "America/Chicago", next - 60_000));
  assert.deepEqual(read.impact.targets.map((target: { kind: string; id: string }) => [target.kind, target.id]), [["workspace", "r/w"]]);
  assert.deepEqual(read.executions, []);
  const effective = read.effectiveCampaign;
  assert.equal(effective.error, undefined, effective.error);
  assert.equal(effective.controlMode, "full_control");
  assert.equal(effective.repository, "owner/repo");
  assert.deepEqual(effective.tasks, [{ key: "maintenance", title: "Maintenance" }, { key: "coverage", title: "Coverage" }]);
  assert.deepEqual(effective.root, { runnerId: "r", workspaceId: "w", agentId: "parent", model: "claude-opus-5-5", effort: "high" });
  assert.equal(effective.behavior.childHarness.driver, "codex-app-server");
  assert.equal(effective.behavior.childModel, "codex-fixture-model");
  assert.equal(effective.behavior.childEffort, "medium");
  assert.equal(effective.behavior.maximumConcurrentChildren, 2);
  assert.equal(effective.behavior.followUps, "execute_approved");
  assert.equal(effective.behavior.completion, "stop_and_archive");
  assert.equal(effective.behavior.reviewRoundBudget, 3);
  assert.equal(effective.delegation.parentControl, "questions_and_approvals");
  assert.equal(effective.delegation.decisions.pr_merge, "orchestrator");
  assert.equal(effective.delegation.decisions.merged_branch_deletion, "human", "an omitted category keeps the saved default");
  assert.equal(effective.execution.integrationIsolation, true);
  assert.deepEqual(effective.budget, { costUsd: 15, toolCalls: 200, concurrency: 2, acceptedFollowUps: 3 });

  const tasks = [...payload().action.request.campaign.tasks, { key: "security", title: "Security", prompt: "Review dependency advisories." }];
  const updated = await f.call("auto_update", { operationId: "update-campaign", automationId, expectedRevision: read.automation.revision,
    payload: { ...payload(tasks), enabled: false } });
  assert.equal(updated.result.revision, read.automation.revision + 1);
  const reread = await f.call("auto_get", { automationId });
  assert.equal(reread.automation.enabled, false);
  assert.equal(reread.automation.nextFireAt, undefined, "a paused schedule has no next occurrence");
  assert.deepEqual(reread.automation.action.request.campaign.tasks, tasks);
  assert.deepEqual(reread.effectiveCampaign.tasks.map((task: { key: string }) => task.key), ["maintenance", "coverage", "security"]);

  // Nothing ran: no execution, no repository inspection and no session launch.
  assert.deepEqual(reread.executions, []);
  assert.equal(f.automations.get(automationId).data!.executions.length, 0);
  assert.deepEqual(f.sent.map(message => message.type), [], "saving and reading back sends the runner nothing");
});

test("Assistant campaign schedules refuse invalid fields, missing limits and missing authority with actionable errors", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.db.close(); });
  const withRequest = (change: (request: Record<string, unknown>) => void) => {
    const value = payload();
    change(value.action.request as Record<string, unknown>);
    return value;
  };
  const refusals: Array<[string, unknown, RegExp]> = [
    ["boolean orchestrator", withRequest(r => { r.orchestrator = true; }), /request\.orchestrator must be an object of behavior, delegation and execution/],
    ["unknown behavior", withRequest(r => { r.orchestrator = { behavior: { childModels: "x" } }; }), /request\.orchestrator must be an object/],
    ["unknown campaign field", withRequest(r => { (r.campaign as Record<string, unknown>).schedule = "daily"; }), /does not accept schedule/],
    ["uppercase repository", withRequest(r => { (r.campaign as Record<string, unknown>).repository = "Owner/Repo"; }), /repository must be the lowercase/],
    ["bad task", withRequest(r => { (r.campaign as { tasks: unknown[] }).tasks.push({ key: "bad key", title: "Bad", prompt: "Bad" }); }), /tasks\[2\] must have only key/],
    ["duplicate task", withRequest(r => { const c = r.campaign as { tasks: unknown[] }; c.tasks.push(c.tasks[0]); }), /keys must be unique/],
    ["custom with fullControl", withRequest(r => { (r.campaign as Record<string, unknown>).controlMode = "custom"; }), /fullControl applies only to controlMode full_control/],
    ["fullControl session", withRequest(r => { ((r.campaign as Record<string, unknown>).fullControl as Record<string, unknown>).session = {}; }), /fullControl accepts only objective/],
    ["campaign without role", withRequest(r => { delete r.role; }), /requires request\.role orchestrator/],
    ["missing limits", (() => { const value: Record<string, unknown> = payload(); delete value.limits; return value; })(), /finite positive cost and tool ceilings/],
  ];
  for (const [label, value, expected] of refusals) {
    await assert.rejects(f.call("auto_create", { operationId: `invalid-${label.replaceAll(" ", "-")}`, payload: value }), expected, label);
  }
  f.db.assistantConnections.configure(f.issued.connection.id, { operations: ["auto_get"], projects: "all" });
  await assert.rejects(f.call("auto_create", { operationId: "excluded", payload: payload() }), /excluded/);
  f.db.assistantConnections.configure(f.issued.connection.id, { operations: "all", projects: [] });
  await assert.rejects(f.call("auto_create", { operationId: "projects", payload: payload() }), /outside the selected projects|excluded/);
  assert.equal(f.automations.list().automations.length, 0);
});
