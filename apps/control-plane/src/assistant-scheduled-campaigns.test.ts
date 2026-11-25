import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { AUTOMATION_TARGET_UNAVAILABLE, DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION, type AutomationSpec, type ControlPlaneToRunner, type RunnerMetadata } from "@wollipog/protocol";
import { nextCronFire } from "@wollipog/protocol/cron-schedule";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { OrchestratorSettings } from "./orchestrator-settings.js";
import { AutomationsService } from "./automations.js";
import { ScheduledCampaignRuntime, automationCampaignError } from "./scheduled-campaigns.js";
import { automationPayloadSchema } from "./assistant-management-schemas.js";
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
  if (schema.not && violation(schema.not as Schema, value, path) === null) return `${path}: must not match ${JSON.stringify(schema.not)}`;
  if (schema.if && schema.then && violation(schema.if as Schema, value, path) === null) {
    const conditional = violation(schema.then as Schema, value, path);
    if (conditional) return conditional;
  }
  if (Array.isArray(schema.oneOf)) {
    const errors = (schema.oneOf as Schema[]).map(option => violation(option, value, path));
    const matches = errors.filter(error => error === null).length;
    // Report the option whose discriminator matched (no `const` mismatch) but that failed deeper down.
    const deeper = errors.find(error => error !== null && !error.startsWith(`${path}:`) && !/: expected "/.test(error));
    if (matches !== 1) return (matches ? null : deeper) ?? `${path}: matches ${matches} oneOf options`;
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
      if (schema.propertyNames && violation(schema.propertyNames as Schema, key, `${path}.${key}`)) return `${path}.${key}: not allowed`;
      const rule = properties[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties as Schema : undefined);
      if (rule) {
        const nested = violation(rule, item, `${path}.${key}`);
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
  db.registerRunner({ ...meta, runnerId: "r2", hostname: "alternate" }, Date.now(), PROTOCOL_VERSION);
  const rate = { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001, cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 };
  db.setUsageRateTable(new Map([["claude-opus-5-5", rate], ["codex-fixture-model", rate]]));
  const hub = new Hub(db);
  const offline = new Set<string>();
  hub.isRunnerOnline = runnerId => !offline.has(runnerId);
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
  return { db, app, call, issued, sent, automations, owner, offline, meta };
}

/** The auto_create payload schema exactly as an Assistant receives it from discovery. */
async function discoveredPayloadSchema(call: (name: string, args?: unknown) => Promise<any>): Promise<Schema> {
  const discovery = await call("assistant_discover", { operations: ["auto_create"] });
  return discovery.operations[0].inputSchema.properties.payload as Schema;
}

const behavior = {
  childHarness: { agentId: "codex-app-server", driver: "codex-app-server", context: { kind: "native" } },
  childModel: "codex-fixture-model", childEffort: "medium", maximumConcurrentChildren: 2,
  followUps: "execute_approved", completion: "stop_and_archive", reviewRoundBudget: 3,
};
// Every call returns an independent object, so one case's mutation never leaks into another.
const payload = (tasks = [
  { key: "maintenance", title: "Maintenance", prompt: "Investigate stale flags." },
  { key: "coverage", title: "Coverage", prompt: "Investigate meaningful coverage gaps." },
]) => structuredClone({
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
    ["boolean orchestrator", withRequest(r => { r.orchestrator = true; }), /request\.orchestrator must be an object of optional behavior, delegation and execution overrides/],
    ["unknown behavior", withRequest(r => { r.orchestrator = { behavior: { childModels: "x" } }; }),
      /request\.orchestrator\.behavior\.childModels is not an accepted Orchestrator override/],
    ["bad decision owner", withRequest(r => { r.orchestrator = { delegation: { decisions: { pr_merge: "anyone" } } }; }),
      /request\.orchestrator\.delegation\.decisions\.pr_merge is not an accepted/],
    ["unknown campaign field", withRequest(r => { (r.campaign as Record<string, unknown>).schedule = "daily"; }), /does not accept schedule/],
    ["uppercase repository", withRequest(r => { (r.campaign as Record<string, unknown>).repository = "Owner/Repo"; }), /repository must be the lowercase/],
    ["bad task", withRequest(r => { (r.campaign as { tasks: unknown[] }).tasks.push({ key: "bad key", title: "Bad", prompt: "Bad" }); }), /tasks\[2\] must have only key/],
    ["duplicate task", withRequest(r => { const c = r.campaign as { tasks: unknown[] }; c.tasks.push(c.tasks[0]); }), /keys must be unique/],
    ["custom with fullControl", withRequest(r => { (r.campaign as Record<string, unknown>).controlMode = "custom"; }), /fullControl applies only to controlMode full_control/],
    ["fullControl session", withRequest(r => { ((r.campaign as Record<string, unknown>).fullControl as Record<string, unknown>).session = {}; }), /fullControl\.session is not accepted/],
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

test("the discovered schema and the save validator accept and refuse the same campaign inputs", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.db.close(); });
  const schema = await discoveredPayloadSchema(f.call);
  type Request = ReturnType<typeof payload>["action"]["request"];
  const variant = (change: (request: Request & Record<string, any>) => void) => {
    const value = payload();
    change(value.action.request as Request & Record<string, any>);
    return value;
  };
  // Each case changes one field of an otherwise valid payload. Discovery must refuse that field and
  // the server must name it, so a regression in either side cannot hide behind another case.
  const refused: Array<[string, ReturnType<typeof payload>, RegExp, RegExp]> = [
    ["undeclared budget key", variant(r => { (r.campaign.fullControl.budget as Record<string, unknown>).maxToolCalls = 5; }),
      /fullControl\.budget\.maxToolCalls: not allowed/, /fullControl\.budget\.maxToolCalls is not accepted/],
    ["undeclared issues key", variant(r => { (r.campaign.fullControl.issues as Record<string, unknown>).epics = [1]; }),
      /fullControl\.issues\.epics: not allowed/, /fullControl\.issues\.epics is not accepted/],
    ["empty child model", variant(r => { r.orchestrator.behavior.childModel = ""; }), /behavior\.childModel:/, /behavior\.childModel is not/],
    ["untrimmed child effort", variant(r => { r.orchestrator.behavior.childEffort = " medium "; }), /behavior\.childEffort:/, /behavior\.childEffort is not/],
    ["overlong child effort", variant(r => { r.orchestrator.behavior.childEffort = "e".repeat(65); }), /behavior\.childEffort: too long/, /behavior\.childEffort is not/],
    ["blank WSL distro", variant(r => { (r.orchestrator.behavior as Record<string, unknown>).childHarness =
      { agentId: "codex-app-server", driver: "codex-app-server", context: { kind: "wsl", distro: " " } }; }),
    /childHarness\.context\.distro:/, /behavior\.childHarness\.context\.distro is not/],
    ["uppercase repository", variant(r => { r.campaign.repository = "Owner/Repo"; }), /campaign\.repository:/, /repository must be the lowercase/],
    ["repository without an owner", variant(r => { r.campaign.repository = "repo"; }), /campaign\.repository:/, /repository must be the lowercase/],
    ["repository with a space", variant(r => { r.campaign.repository = "owner/repo name"; }), /campaign\.repository:/, /repository must be the lowercase/],
    ["host-qualified GitHub repository", variant(r => { r.campaign.repository = "github.com/owner/repo"; }), /campaign\.repository:/, /repository must be the lowercase/],
    ["GitLab host label starting with a hyphen", variant(r => { r.campaign.repository = "-gitlab.example.com/group/project"; }),
      /campaign\.repository:/, /repository must be the lowercase/],
    ["Full Control overrides on a Custom campaign", variant(r => { (r.campaign as Record<string, unknown>).controlMode = "custom"; }),
      /request\.campaign: must not match/, /fullControl applies only to controlMode full_control/],
    ["empty budget key", variant(r => { (r.campaign.fullControl.budget as Record<string, unknown>)[""] = 1; }),
      /fullControl\.budget\.: not allowed/, /fullControl\.budget\."" is not accepted/],
    ["unsafe tool calls", variant(r => { (r.campaign.fullControl.budget as Record<string, unknown>).toolCalls = 2 ** 53; }),
      /budget\.toolCalls: above/, /budget\.toolCalls must be an integer/],
    ["blank task title", variant(r => { r.campaign.tasks[0]!.title = "   "; }), /tasks\[0\]\.title:/, /tasks\[0\] must have/],
    ["empty task prompt", variant(r => { r.campaign.tasks[1]!.prompt = ""; }), /tasks\[1\]\.prompt:/, /tasks\[1\] must have/],
    ["blank objective", variant(r => { (r.campaign.fullControl as Record<string, unknown>).objective = "  "; }),
      /fullControl\.objective:/, /fullControl\.objective is not an accepted/],
    ["negative cost", variant(r => { r.campaign.fullControl.budget.costUsd = -1; }), /budget\.costUsd:/, /budget\.costUsd must be/],
    ["fractional tool calls", variant(r => { (r.campaign.fullControl.budget as Record<string, unknown>).toolCalls = 1.5; }),
      /budget\.toolCalls:/, /budget\.toolCalls must be/],
    ["too many issues", variant(r => { r.campaign.fullControl.issues.maxIssues = 101; }), /issues\.maxIssues:/, /issues\.maxIssues must be/],
    ["repeated closure reason", variant(r => { (r.campaign.fullControl.issues as Record<string, unknown>).closureReasons = ["completed", "completed"]; }),
      /issues\.closureReasons:/, /issues\.closureReasons must/],
    ["unknown decision category", variant(r => { (r.orchestrator.delegation.decisions as Record<string, unknown>).issue_closure = "orchestrator"; }),
      /decisions\.issue_closure: not allowed/, /delegation\.decisions\.issue_closure is not/],
    ["unknown parent control", variant(r => { (r.orchestrator.delegation as Record<string, unknown>).parentControl = "always"; }),
      /delegation\.parentControl:/, /delegation\.parentControl is not/],
  ];
  for (const [label, value, schemaField, serverField] of refused) {
    assert.match(violation(schema, value) ?? "", schemaField, `discovery refuses ${label}`);
    await assert.rejects(f.call("auto_create", { operationId: `refused-${label.replaceAll(" ", "-")}`, payload: value }), serverField, label);
  }
  // Ordering is beyond JSON Schema, so discovery states the rule the server enforces.
  const checkpoints = (((schema.properties as any).action.oneOf[0].properties.request.properties.campaign.properties
    .fullControl.properties.budget.properties.checkpointsUsd) as Schema);
  assert.match(String(checkpoints.description), /Increasing/);
  const descending = variant(r => { (r.campaign.fullControl.budget as Record<string, unknown>).checkpointsUsd = [2, 1]; });
  await assert.rejects(f.call("auto_create", { operationId: "refused-descending", payload: descending }), /checkpointsUsd must be at most 100 increasing/);
  // Launch admits checkpoints within the smaller of the automation's limit and the override, whichever is tighter.
  const aboveOverride = variant(r => { (r.campaign.fullControl.budget as Record<string, unknown>).checkpointsUsd = [16]; });
  await assert.rejects(f.call("auto_create", { operationId: "refused-above-override", payload: aboveOverride }),
    /checkpointsUsd must stay within the effective cost limit of 15/);
  const aboveLimit = variant(r => { Object.assign(r.campaign.fullControl.budget, { costUsd: 30, checkpointsUsd: [25] }); });
  await assert.rejects(f.call("auto_create", { operationId: "refused-above-limit", payload: aboveLimit }),
    /checkpointsUsd must stay within the effective cost limit of 20/);
  assert.equal(f.automations.list().automations.length, 0);
  const accepted: Array<[string, ReturnType<typeof payload>]> = [
    ["checkpoints within both limits", variant(r => { (r.campaign.fullControl.budget as Record<string, unknown>).checkpointsUsd = [5, 15]; })],
    ["GitLab project", variant(r => { r.campaign.repository = "gitlab.example.com/group/project"; })],
    ["inherited parent control", variant(r => { (r.orchestrator.delegation as Record<string, unknown>).parentControl = null; })],
    ["automatic child harness", variant(r => { Object.assign(r.orchestrator.behavior, { childHarness: null, childModel: null, childEffort: null }); })],
    ["automatic reviewer", variant(r => { Object.assign(r.orchestrator.behavior, { reviewHarness: null, reviewModel: null, reviewEffort: null }); })],
  ];
  for (const [label, value] of accepted) {
    assert.equal(violation(schema, value), null, `discovery accepts ${label}`);
    await f.call("auto_create", { operationId: `accepted-${label.replaceAll(" ", "-")}`, payload: value });
  }
  assert.equal(f.automations.list().automations.length, accepted.length);
});

test("a null parent control inherits the owner's saved setting in the effective readback", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.db.close(); });
  f.db.setOrchestratorDefaults(f.owner.userId, { ...DEFAULT_ORCHESTRATOR_DEFAULTS,
    delegation: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.delegation, parentControl: "questions" } });
  const value = payload();
  (value.action.request.orchestrator.delegation as Record<string, unknown>).parentControl = null;
  const created = await f.call("auto_create", { operationId: "inherit", payload: value });
  const read = await f.call("auto_get", { automationId: created.result.automationId });
  assert.equal(read.effectiveCampaign.error, undefined, read.effectiveCampaign.error);
  assert.equal(read.effectiveCampaign.delegation.parentControl, "questions");
});

test("the effective readback follows the schedule's launch authority and the scheduler's target, not the reader", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.db.close(); });
  const value = { ...payload(), runnerPolicy: { kind: "alternate", targets: [{ runnerId: "r2", workspaceId: "w", projectId: null, projectLocationId: null, agentId: "parent" }] } };
  const created = await f.call("auto_create", { operationId: "alternate", payload: value });
  const automationId = created.result.automationId as string;
  assert.equal((await f.call("auto_get", { automationId })).effectiveCampaign.root.runnerId, "r");
  // With the primary offline the scheduler picks the alternate, and so does the readback.
  f.offline.add("r");
  const alternate = await f.call("auto_get", { automationId });
  assert.equal(alternate.effectiveCampaign.error, undefined, alternate.effectiveCampaign.error);
  assert.equal(alternate.effectiveCampaign.root.runnerId, "r2");
  f.offline.add("r2");
  assert.equal((await f.call("auto_get", { automationId })).effectiveCampaign.error, AUTOMATION_TARGET_UNAVAILABLE);
  f.offline.clear();
  // The settings come from the launch owner's own defaults, so another reader gets no settings.
  const otherReader = f.automations.campaignPreview(f.db.getAutomation(automationId)!, { ...f.owner, userId: "u_other_reader" });
  assert.deepEqual(otherReader, { error: "The effective settings come from the schedule owner's own Orchestrator defaults and are shown only to that owner" });
  // The creating connection keeps read access but loses the operation that authorized the
  // schedule: the schedule still reads, while the next occurrence, and so the preview, is refused.
  f.db.assistantConnections.configure(f.issued.connection.id, { operations: ["auto_get"], projects: "all" });
  const narrowed = await f.call("auto_get", { automationId });
  assert.equal(narrowed.automation.automationId, automationId);
  assert.match(narrowed.effectiveCampaign.error, /^assistant_/);
  assert.equal(narrowed.effectiveCampaign.behavior, undefined);
  assert.deepEqual(f.sent.map(message => message.type), [], "previews send the runner nothing");
  assert.equal(f.automations.get(automationId).data!.executions.length, 0);
});

test("a schedule stored before the save-time limit checks can still be paused unchanged", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.db.close(); });
  // Earlier releases checked only these overrides' keys, so such a value can already be stored;
  // launch clamps it to the automation's own ceiling.
  const stored = payload();
  (stored.action.request.campaign.fullControl.budget as Record<string, unknown>).toolCalls = 2 ** 53;
  const schedule = f.db.createAutomation({ automationId: "auto_legacy_limits", spec: stored as unknown as AutomationSpec,
    nextFireAt: Date.now() + 60_000, actor: { kind: "human", id: f.owner.userId }, now: Date.now() });
  const paused = await f.call("auto_pause", { operationId: "pause-legacy", automationId: schedule.automationId, expectedRevision: schedule.revision });
  assert.equal(paused.result.enabled, false);
  const read = await f.call("auto_get", { automationId: schedule.automationId });
  assert.equal(read.automation.enabled, false);
  assert.equal(read.automation.nextFireAt, undefined);
  // A replacement through the Assistant that keeps the stored overrides, such as a rename, saves.
  const renamed = await f.call("auto_update", { operationId: "rename-legacy", automationId: schedule.automationId,
    expectedRevision: read.automation.revision, payload: { ...stored, name: "Renamed Campaign", enabled: false } });
  assert.equal(renamed.result.name, "Renamed Campaign");
  // Changing the stored overrides, or the cost limit they are checked against, is a new
  // configuration and gets the save-time check.
  const changed = payload();
  (changed.action.request.campaign.fullControl.budget as Record<string, unknown>).toolCalls = 2 ** 53 + 2;
  await assert.rejects(f.call("auto_update", { operationId: "edit-legacy", automationId: schedule.automationId,
    expectedRevision: renamed.result.revision, payload: { ...changed, enabled: false } }), /budget\.toolCalls must be an integer/);
  await assert.rejects(f.call("auto_update", { operationId: "limit-legacy", automationId: schedule.automationId,
    expectedRevision: renamed.result.revision, payload: { ...stored, enabled: false, limits: { maxCostUsd: 10, maxToolCalls: 200 } } }),
  /budget\.toolCalls must be an integer/);
});

test("the effective readback reports stored checkpoints that the next occurrence would refuse", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.db.close(); });
  // Stored JSON is not revalidated on read, so a wrong type must not break the read either. The
  // readback forwards checkpoints as launch does: null and [] are omitted, anything else with a
  // length must be increasing positive amounts within the effective ceiling.
  const cases: Array<[string, unknown, boolean]> = [["auto_legacy_checkpoints", [16], false], ["auto_legacy_checkpoint_type", "16", false],
    ["auto_legacy_checkpoint_order", [2, 1], false], ["auto_legacy_checkpoint_null", null, true], ["auto_legacy_checkpoint_empty", [], true]];
  for (const [automationId, checkpointsUsd, launches] of cases) {
    const stored = payload();
    (stored.action.request.campaign.fullControl.budget as Record<string, unknown>).checkpointsUsd = checkpointsUsd;
    f.db.createAutomation({ automationId, spec: stored as unknown as AutomationSpec,
      nextFireAt: Date.now() + 60_000, actor: { kind: "human", id: f.owner.userId }, now: Date.now() });
    const read = await f.call("auto_get", { automationId });
    assert.equal(read.automation.automationId, automationId);
    if (launches) assert.equal(read.effectiveCampaign.error, undefined, `${automationId}: ${read.effectiveCampaign.error}`);
    else assert.match(read.effectiveCampaign.error, /checkpointsUsd must be at most 100 increasing positive amounts within the effective cost limit of 15/, automationId);
  }
  // Another invalid stored budget value cannot hide the refusal; the readback names that field.
  const combined = payload();
  Object.assign(combined.action.request.campaign.fullControl.budget, { checkpointsUsd: [16], acceptedFollowUps: -1 });
  f.db.createAutomation({ automationId: "auto_legacy_combined", spec: combined as unknown as AutomationSpec,
    nextFireAt: Date.now() + 60_000, actor: { kind: "human", id: f.owner.userId }, now: Date.now() });
  const read = await f.call("auto_get", { automationId: "auto_legacy_combined" });
  assert.match(read.effectiveCampaign.error, /effective acceptedFollowUps of -1 must be an integer of at least 0/);
  assert.equal(read.effectiveCampaign.behavior, undefined);
  // Stored values that cannot be printed or converted still read back with the field named, and
  // a value launch coerces to a valid number keeps launch's verdict.
  const unconvertible = JSON.parse("{\"toString\":null}");
  const stored: Array<[string, Record<string, unknown>, RegExp | null]> = [
    ["auto_legacy_follow_ups_object", { acceptedFollowUps: unconvertible }, /effective acceptedFollowUps of an object must be an integer/],
    ["auto_legacy_cost_object", { costUsd: unconvertible }, /budget\.costUsd must be a number, not an object/],
    ["auto_legacy_tool_calls_array", { toolCalls: [5] }, null],
  ];
  for (const [automationId, budget, expected] of stored) {
    const value = payload();
    Object.assign(value.action.request.campaign.fullControl.budget, budget);
    f.db.createAutomation({ automationId, spec: value as unknown as AutomationSpec,
      nextFireAt: Date.now() + 60_000, actor: { kind: "human", id: f.owner.userId }, now: Date.now() });
    const readback = await f.call("auto_get", { automationId });
    assert.equal(readback.automation.automationId, automationId);
    if (expected) assert.match(readback.effectiveCampaign.error, expected, automationId);
    else assert.equal(readback.effectiveCampaign.budget.toolCalls, 5, readback.effectiveCampaign.error);
  }
  assert.deepEqual(f.sent.map(message => message.type), []);
});

test("an Assistant update outside the connection's grant gets the same refusal whatever the stored values", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.db.close(); });
  const stored = payload();
  (stored.action.request.campaign.fullControl.budget as Record<string, unknown>).toolCalls = 2 ** 53;
  const schedule = f.db.createAutomation({ automationId: "auto_outside_grant", spec: stored as unknown as AutomationSpec,
    nextFireAt: Date.now() + 60_000, actor: { kind: "human", id: f.owner.userId }, now: Date.now() });
  f.db.assistantConnections.configure(f.issued.connection.id, { operations: "all", projects: [] });
  const changed = payload();
  (changed.action.request.campaign.fullControl.budget as Record<string, unknown>).toolCalls = 2 ** 53 + 2;
  const refusal = async (value: unknown, operationId: string) => {
    try { await f.call("auto_update", { operationId, automationId: schedule.automationId, expectedRevision: schedule.revision, payload: value }); }
    catch (error) { return (error as Error).message; }
    assert.fail("an update outside the grant must be refused");
  };
  const matching = await refusal(stored, "matching"), differing = await refusal(changed, "differing");
  assert.equal(matching, differing, "the refusal cannot reveal whether the submission matches the stored schedule");
  assert.doesNotMatch(matching!, /toolCalls/);
});

test("an Assistant without auto_update gets the operation refusal whatever state the stored target is in", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.db.close(); });
  const project = f.db.createProject({ name: "Stored Placement" });
  f.db.createSession({ id: "present", runnerId: "r", workspaceId: "w", agentId: "parent", title: "Present", useWorktree: false,
    driver: "claude-code", config: {}, projectId: project.id, now: 1 });
  const promptSchedule = (automationId: string, sessionId: string) => f.db.createAutomation({ automationId, nextFireAt: null,
    spec: { name: automationId, cron: "0 9 * * *", timezone: "UTC", enabled: false, action: { kind: "prompt_session", sessionId, request: { text: "Run" } },
      misfirePolicy: { kind: "skip" }, runnerPolicy: { kind: "wait" }, concurrencyPolicy: "skip", limits: { maxCostUsd: 1, maxToolCalls: 10 },
      notifications: { pushEvents: [] } } as AutomationSpec, actor: { kind: "human", id: f.owner.userId }, now: 1 });
  const resolvable = promptSchedule("auto_resolvable", "present"), unavailable = promptSchedule("auto_unavailable", "missing");
  f.db.assistantConnections.configure(f.issued.connection.id, { operations: ["auto_get"], projects: "all" });
  const refusal = async (automationId: string) => {
    try { await f.call("auto_update", { operationId: `update-${automationId}`, automationId, expectedRevision: 1, payload: payload() }); }
    catch (error) { return (error as Error).message; }
    assert.fail("an excluded operation must be refused");
  };
  const first = await refusal(resolvable.automationId), second = await refusal(unavailable.automationId);
  assert.match(first!, /Operation auto_update is excluded/);
  assert.equal(second, first, "the refusal cannot reveal the stored target's state");
  // A refused call records its target in the connection's activity, so that record cannot carry
  // the stored schedule's project placement either.
  const refusedUpdates = f.db.assistantConnections.activity(f.issued.connection.id)
    .filter(entry => entry.operation === "auto_update" && entry.outcome === "refused");
  assert.equal(refusedUpdates.length, 2);
  for (const entry of refusedUpdates) assert.doesNotMatch(entry.target_json, new RegExp(project.id));
});

test("the effective readback pins a legacy plain agent id the way dispatch does, without saving the pin", async t => {
  const f = fixture();
  t.after(async () => { await f.app.close(); f.db.close(); });
  const created = await f.call("auto_create", { operationId: "legacy-agent", payload: payload() });
  const automationId = created.result.automationId as string;
  const before = await f.call("auto_get", { automationId });
  assert.equal(before.automation.action.installationBindings, undefined);
  // The saved plain id now advertises exactly one installation, which dispatch pins before choosing a target.
  const [parent, child] = f.meta.agents;
  f.db.updateRunnerAgents("r", [{ ...parent!, installation: { id: "system", path: "/usr/bin/claude", via: "path" } }, child!], Date.now());
  assert.ok(f.db.selectHarnessInstallation("r", "parent", "system"));
  const read = await f.call("auto_get", { automationId });
  assert.equal(read.effectiveCampaign.error, undefined, read.effectiveCampaign.error);
  assert.equal(read.effectiveCampaign.root.runnerId, "r");
  assert.equal(read.effectiveCampaign.root.agentId, "parent");
  assert.equal(read.automation.revision, before.automation.revision, "the preview saves nothing");
  assert.equal(read.automation.action.installationBindings, undefined);
  assert.deepEqual(f.sent.map(message => message.type), []);
});

test("the advertised repository pattern accepts exactly the repositories the save validator accepts", () => {
  const request = (automationPayloadSchema.properties as any).action.oneOf[0].properties.request.properties;
  const pattern = new RegExp(request.campaign.properties.repository.pattern as string, "u");
  const saves = (repository: string) => automationCampaignError({ runnerId: "r", workspaceId: "w", role: "orchestrator",
    campaign: { controlMode: "custom", repository, tasks: [] } }) === null;
  const named = ["owner/repo", "o.w-n_er/re.po", "github.com/repo", "repo", "owner/repo name", "Owner/Repo", "owner/repo/extra",
    "github.com/owner/repo", "www.github.com/owner/repo", "github.com:443/owner/repo", "gitlab.example.com/group/project",
    "-gitlab.example.com/group/project", "gitlab-.example.com/group/project", "gitlab.example.com:8443/group/project",
    "gitlab.example.com:0/group/project", "gitlab.example.com:65536/group/project", "gitlab.example.com:080/group/project",
    "gitlab.example.com/group/project.git", "gitlab.example.com/group/x.atom/project", "gitlab.example.com/.group/project",
    "gitlab.example.com/group", "localhost/group/project", "gitlab.example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v",
    "gitlab.example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w", `${"a".repeat(64)}.example.com/group/project`];
  // A seeded generator over the characters these rules care about, so the comparison is repeatable.
  let seed = 4869;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const alphabet = "ab0-_./:Ag9";
  const generated = Array.from({ length: 4000 }, () => Array.from({ length: 1 + Math.floor(random() * 24) },
    () => alphabet[Math.floor(random() * alphabet.length)]).join(""));
  for (const repository of [...named, ...generated]) {
    assert.equal(pattern.test(repository), saves(repository), `pattern and save agree on ${JSON.stringify(repository)}`);
  }
});
