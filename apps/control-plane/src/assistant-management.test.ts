import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { AssistantCommandReceipts, assistantRequestDigest } from "./assistant-command-receipts.js";
import { ManagementMutations } from "./assistant-management-command.js";
import { registerAssistantSkills } from "./assistant-skills.js";
import { registerAssistantAutomations } from "./assistant-automations.js";
import { makeSkillsSyncPusher, type SkillsHub } from "./skills-route.js";
import { AutomationsService } from "./automations.js";
import type { SessionsService } from "./sessions.js";
import type { Hub } from "./hub.js";
import type { AutomationSpec } from "@wollipog/protocol";

async function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const issued = db.assistantConnections.create(owner, "Test Assistant", {operations: "all", projects: "all"});
  const operations = createAssistantOperations(db);
  AssistantCommandReceipts.install(db.raw());
  const receipts = new AssistantCommandReceipts(db.raw());
  const mutations = new ManagementMutations(receipts, db.instanceId(), assistantRequestDigest, id => db.assistantConnections.get(id)!);
  const hub = {isRunnerOnline: () => false, sendToRunner: () => true, requestFromRunner: async () => {throw new Error("Offline");}} as SkillsHub;
  registerAssistantSkills(operations, {db, hub, requestHuman: () => owner, requestPrincipal: () => owner,
    pushSkillsSync: makeSkillsSyncPusher({db, hub})}, mutations);
  const automations = new AutomationsService(db, hub as Hub, {} as SessionsService, {info() {}, warn() {}});
  registerAssistantAutomations(operations, db, automations, mutations);
  const app = Fastify();
  registerAssistantRoutes(app, {db, operations, requestHuman: () => owner});
  const call = async (name: string, args: unknown = {}) => {
    const response = await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${issued.token}`},
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args}}});
    const result = response.json().result;
    if (result?.isError) throw new Error(result.content[0].text);
    assert.ok(result, response.body);
    return JSON.parse(result.content[0].text);
  };
  return {db, app, call, issued, owner, receipts, operations};
}
const payload = (name = "assistant-test") => ({name, files: [{path: "SKILL.md", encoding: "utf8", content: `---\nname: ${name}\ndescription: Test skill\n---\nInstructions`}]});

test("real MCP/SQLite skill creation, version edits, conflict fencing, duplicate reconciliation and scoped denial", async t => {
  const f = await fixture();
  t.after(async () => {await f.app.close(); f.db.close();});
  const created = await f.call("skill_create", {operationId: "create-1", payload: payload()});
  const skillId = created.result.skill.id;
  assert.equal(created.receipt.resourceId, skillId);
  assert.equal(f.db.listSkills().length, 1);
  const duplicate = await f.call("skill_create", {payload: payload(), operationId: "create-1"});
  assert.equal(duplicate.receipt.status, "succeeded");
  assert.equal(f.db.listSkills().length, 1);
  await assert.rejects(f.call("skill_create", {operationId: "create-1", payload: payload("other")}), /different arguments/);
  const read = await f.call("skill_get", {skillId});
  const updated = await f.call("skill_update", {skillId, operationId: "update-1", expectedRevision: read.revision, payload: {description: "Changed"}});
  assert.notEqual(updated.result.revision, read.revision);
  await assert.rejects(f.call("skill_update", {skillId, operationId: "stale", expectedRevision: read.revision, payload: {description: "Stale"}}), /revision changed/);
  assert.equal(f.db.getSkill(skillId)?.description, "Changed");
  const version = await f.call("skill_version_add", {skillId, operationId: "version", expectedRevision: updated.result.revision,
    payload: {files: [{...payload().files[0], content: `${payload().files[0]!.content}\nUpdated`}]}});
  assert.ok(version.result.version.id);
  const versions = await f.call("skill_versions", {skillId});
  assert.equal(versions.versions.length, 2);
  f.db.assistantConnections.configure(f.issued.connection.id, {operations: ["skill_get"], projects: "all"});
  await assert.rejects(f.call("skill_update", {skillId}), /excluded/);
  f.db.assistantConnections.configure(f.issued.connection.id, {operations: "all", projects: ["selected"]});
  assert.deepEqual((await f.call("skill_list")).skills, []);
  await assert.rejects(f.call("skill_get", {skillId}), /target project is excluded/);
  assert.ok(!JSON.stringify(f.db.assistantConnections.activity(f.issued.connection.id)).includes(f.issued.token));
});

test("skill assignments report offline targets, fence assignment changes and preserve immutable versions on unassign", async t => {
  const f = await fixture();
  t.after(async () => {await f.app.close(); f.db.close();});
  f.db.registerRunner({runnerId: "offline", hostname: "offline", os: "linux", version: "test", workspaces: [],
    agents: [{id: "agent", name: "Agent", command: "agent", args: [], env: {}, driver: "codex"}]}, 1, 400);
  const created = await f.call("skill_create", {operationId: "create", payload: payload()});
  const skillId = created.result.skill.id;
  const read = await f.call("skill_get", {skillId});
  const assigned = await f.call("skill_assign", {skillId, operationId: "assign", expectedRevision: read.revision,
    payload: {scopeKind: "runner", runnerId: "offline", agentSelector: {kind: "all"}}});
  const state = await f.call("skill_deployments", {skillId});
  assert.equal(state.targets[0].online, false);
  assert.equal(state.targets[0].desired[0].name, "assistant-test");
  await assert.rejects(f.call("skill_version_add", {skillId, operationId: "stale", expectedRevision: read.revision}), /revision changed/);
  await f.call("skill_unassign", {assignmentId: assigned.result.assignment.id, operationId: "unassign", expectedRevision: state.revision});
  assert.equal(f.db.listSkillAssignments(skillId).length, 0);
  assert.equal((await f.call("skill_versions", {skillId})).versions.length, 1);
});

test("automation pause/resume/edit/delete use the real shared service with revisions and durable receipts", async t => {
  const f = await fixture();
  t.after(async () => {await f.app.close(); f.db.close();});
  // An existing unrelated session is the actual database target; no session ancestry is supplied.
  f.db.registerRunner({runnerId: "runner", hostname: "runner", os: "linux", version: "test", agents: [], workspaces: []}, 1, 400);
  f.db.createSession({id: "unrelated", runnerId: "runner", workspaceId: "workspace", agentId: "agent", title: "Unrelated",
    useWorktree: false, driver: "acp", config: {}, now: 1});
  const schedule = f.db.createAutomation({automationId: "auto_test", spec: {name: "Test", cron: "0 9 * * *", timezone: "UTC", enabled: false,
    action: {kind: "prompt_session", sessionId: "unrelated", request: {text: "Run"}}, misfirePolicy: {kind: "skip"}, runnerPolicy: {kind: "wait"},
    concurrencyPolicy: "skip", limits: {maxCostUsd: 1, maxToolCalls: 10}, notifications: {pushEvents: []}} as AutomationSpec,
    nextFireAt: null, actor: {kind: "human", id: f.owner.userId}, now: 1});
  const read = await f.call("auto_get", {automationId: schedule.automationId});
  assert.equal(read.automation.revision, 1);
  const configuration = Object.fromEntries(Object.entries(read.automation).filter(([key]) =>
    ["name", "cron", "timezone", "enabled", "action", "misfirePolicy", "runnerPolicy", "concurrencyPolicy", "limits", "notifications"].includes(key)));
  const created = await f.call("auto_create", {operationId: "create", payload: {...configuration, name: "Created"}});
  assert.equal(created.result.name, "Created");
  const edited = await f.call("auto_update", {operationId: "edit", automationId: created.result.automationId, expectedRevision: 1,
    payload: {...configuration, cron: "30 10 * * *", name: "Edited"}});
  assert.equal(edited.result.cron, "30 10 * * *");
  const enabled = await f.call("auto_enable", {automationId: schedule.automationId, expectedRevision: 1, operationId: "enable"});
  assert.equal(enabled.result.enabled, true);
  await assert.rejects(f.call("auto_pause", {automationId: schedule.automationId, expectedRevision: 1, operationId: "stale"}), /revision changed/);
  const paused = await f.call("auto_pause", {automationId: schedule.automationId, expectedRevision: enabled.result.revision, operationId: "pause"});
  assert.equal(paused.result.enabled, false);
  const replay = await f.call("auto_pause", {automationId: schedule.automationId, expectedRevision: enabled.result.revision, operationId: "pause"});
  assert.equal(replay.receipt.status, "succeeded");
  assert.equal(f.db.getAutomation(schedule.automationId)?.revision, paused.result.revision);
  await f.call("auto_delete", {automationId: schedule.automationId, expectedRevision: paused.result.revision, operationId: "delete"});
  assert.equal(f.db.getAutomation(schedule.automationId), null);
  assert.equal(f.receipts.get(f.issued.connection.id, "delete")?.status, "succeeded");
});

test("destructive confirmation binds current grant, arguments and impact; uncertain outcomes never replay", async t => {
  const f = await fixture();
  t.after(async () => {await f.app.close(); f.db.close();});
  const connection = {...f.issued.connection, grant: {...f.issued.connection.grant, destructiveConfirmation: "confirm" as const}};
  const mutations = new ManagementMutations(f.receipts, f.db.instanceId(), assistantRequestDigest, () => connection);
  let effects = 0;
  let revision = 1;
  const input = {connection, operation: "skill_remove", args: {operationId: "confirm"} as Record<string, unknown>,
    target: {kind: "skill", id: "test"}, impact: () => ({revision}), destructive: true, recheck: async () => {},
    execute: () => {effects++; return {deleted: true};}};
  const preview = await mutations.run(input) as {confirmationId: string; confirmationRequired: boolean};
  assert.equal(preview.confirmationRequired, true);
  assert.equal(effects, 0);
  revision++;
  const changed = await mutations.run({...input, args: {...input.args, confirmationId: preview.confirmationId}}) as typeof preview;
  assert.equal(changed.confirmationRequired, true);
  assert.equal(effects, 0);
  await mutations.run({...input, args: {...input.args, confirmationId: changed.confirmationId}});
  await mutations.run(input);
  assert.equal(effects, 1);
  assert.equal(f.receipts.get(connection.id, "confirm")?.status, "succeeded");
  const uncertain = {...input, destructive: false, args: {operationId: "uncertain"}, execute: () => {effects++; throw new Error("Reply lost");}};
  await assert.rejects(mutations.run(uncertain), /Reply lost/);
  const prior = await mutations.run(uncertain) as {receipt: {status: string}};
  assert.equal(prior.receipt.status, "uncertain");
  assert.equal(effects, 2);
});

test("skill removal keeps version and assignment evidence in the shared deletion history", async t => {
  const f = await fixture();
  t.after(async () => {await f.app.close(); f.db.close();});
  const created = await f.call("skill_create", {operationId: "create", payload: payload()});
  const skillId = created.result.skill.id;
  await f.call("skill_remove", {skillId, operationId: "remove", expectedRevision: created.result.revision});
  assert.equal(f.db.getSkill(skillId), null);
  const row = f.db.raw().prepare("SELECT snapshot_json FROM skill_removal_history WHERE skill_id=?").get(skillId) as {snapshot_json: string};
  const snapshot = JSON.parse(row.snapshot_json);
  assert.equal(snapshot.versions.length, 1);
  assert.equal(snapshot.skill.id, skillId);
});
