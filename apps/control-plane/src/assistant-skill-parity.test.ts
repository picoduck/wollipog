import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { assistantRequestDigest } from "./assistant-command-receipts.js";
import { ManagementMutations } from "./assistant-management-command.js";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";
import { ASSISTANT_SKILL_PARITY, registerAssistantSkillParity, skillLibraryRevision } from "./assistant-skill-parity.js";
import { registerAssistantTriggerParity } from "./assistant-trigger-parity.js";
import { createExtendedSkillsManagement } from "./skill-extended-management.js";
import { registerSkillRoutes, type SkillsRouteDeps, type SkillsSyncPusher } from "./skills-route.js";
import { validateSkillPayload } from "./skills.js";
import { AutomationsService } from "./automations.js";
import type { SessionsService } from "./sessions.js";
import type { Hub } from "./hub.js";
import type { AutomationSpec, ControlPlaneToRunner } from "@wollipog/protocol";
import {builtInSkills, seedBuiltInSkills} from "./built-in-skills.js";

function payload(name = "alpha", content = "Original") {
  const result = validateSkillPayload({name, files: [{path: "SKILL.md", encoding: "utf8", content: `---\nname: ${name}\n---\n${content}`} ]});
  if (!result.ok) throw new Error(result.error);
  return result;
}
function fixture(t: TestContext) {
  const db = ControlPlaneDb.open(":memory:"), app = Fastify();
  const identity = db.localIdentityContext(), owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const issued = db.assistantConnections.create(owner, "Parity", {operations: "all", projects: "all"});
  const operations = createAssistantOperations(db);
  const receipts = registerAssistantSessionOperations(operations, db, {} as SessionsService);
  const mutations = new ManagementMutations(receipts, db.instanceId(), assistantRequestDigest,
    id => db.assistantConnections.get(id)!, id => db.assistantConnections.destructiveConfirmation(id), new AssistantCommandConfirmations(db.raw()));
  db.registerRunner({runnerId: "machine", hostname: "Fixture", os: "linux", version: "test", workspaces: [], agents: [
    {id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex"},
  ]}, 1, 400);
  const state = {online: true, calls: [] as ControlPlaneToRunner[], syncs: 0, beforeRead: async () => {}, beforeSyncReply: async () => {}, failSync: false};
  const candidate = {id: "candidate", name: "alpha", sourceDirectory: ".codex/skills", generation: "one"};
  const push = ((_runnerId: string) => {}) as SkillsSyncPusher;
  push.request = async (runnerId, requestId) => {
    state.syncs++;
    if (state.failSync) throw new Error("private transport diagnostic");
    await state.beforeSyncReply();
    return {type: "skills_state", runnerId, requestId, deployed: [], unmanaged: [], drift: [], keptAside: []};
  };
  const deps: SkillsRouteDeps = {db, requestHuman: () => owner, requestPrincipal: () => owner, pushSkillsSync: push,
    builtInSkills: builtInSkills([{name: "release-guide", files: payload("release-guide").files}], "test-release"),
    hub: {isRunnerOnline: () => state.online, sendToRunner: () => true, requestFromRunner: async (runnerId, requestId, message) => {
      state.calls.push(message);
      if (message.type === "skill_snapshot") {
        if (message.operation === "list") return {type: "skill_snapshot_result", runnerId, requestId, candidates: [candidate]};
        await state.beforeRead();
        const content = payload();
        return {type: "skill_snapshot_result", runnerId, requestId, snapshot: {candidate, files: content.files, digest: content.digest}};
      }
      if (message.type === "skill_adoption_recovery") return {type: "skill_adoption_recovery_result", runnerId, requestId,
        status: "listed", operations: [], truncated: false};
      if (message.type === "skill_adoption") return {type: "skill_adoption_result", runnerId, requestId, status: "adopted",
        operationId: "00000000-0000-4000-8000-000000000001", backupDirectory: ".codex/skills/.wollipog-adoption-00000000-0000-4000-8000-000000000001"};
      if (message.type === "skill_kept_aside") return message.operation === "read"
        ? {type: "skill_kept_aside_result", runnerId, requestId, status: "read", files: payload().files,
          observedDigest: payload().digest, observedFingerprint: "9".repeat(64)}
        : {type: "skill_kept_aside_result", runnerId, requestId, status: "discarded"};
      if (message.type === "skill_drift") {
        if (message.operation === "read") return {type: "skill_drift_result", runnerId, requestId, status: "read", files: payload().files, observedDigest: payload().digest};
        return {type: "skill_drift_result", runnerId, requestId, status: "restored"};
      }
      throw new Error("Unexpected runner operation");
    }}};
  const service = createExtendedSkillsManagement(deps, {discoverGit: async source => [{...payload(), source,
    path: "skills/alpha", commit: "a".repeat(40), executablePaths: []}]});
  registerSkillRoutes(app, {...deps, extendedManagement: service});
  registerAssistantSkillParity(operations, deps, service, mutations);
  const automations = new AutomationsService(db, deps.hub as Hub, {} as SessionsService, {info() {}, warn() {}});
  registerAssistantTriggerParity(operations, db, automations, mutations);
  registerAssistantRoutes(app, {db, operations, requestHuman: () => owner});
  t.after(async () => {await app.close(); db.close();});
  const call = async (name: string, args: unknown = {}) => {
    const response = await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${issued.token}`},
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args}}});
    if (response.json().error) throw new Error(response.json().error.message);
    const result = response.json().result;
    if (result?.isError) throw new Error(result.content[0].text);
    assert.ok(result, response.body);
    return JSON.parse(result.content[0].text);
  };
  return {db, app, owner, issued, operations, receipts, call, state, deps, automations, service, revision: () => skillLibraryRevision(deps)};
}

test("MCP groups/assignments share owner services, conflict fences, offline impact and durable reconciliation", async t => {
  const f = fixture(t);
  f.state.online = false;
  const created = await f.call("skill_group_create", {commandId: "group", payload: {name: "Common"}});
  const groupId = created.result.data.group.id;
  const skill = f.db.createSkill({...payload(), groupId, scope: {organizationId: f.owner.organizationId,
    owner: {kind: "organization", organizationId: f.owner.organizationId}}});
  const revision = f.revision();
  const added = await f.call("skill_group_assign", {groupId, commandId: "assign", expectedRevision: revision,
    payload: {scopeKind: "runner", runnerId: "machine", agentSelector: {kind: "all"}}});
  assert.equal(added.impact.targets[0].online, false);
  assert.equal(added.impact.skills[0].id, skill.id);
  const assignmentId = added.result.data.assignment.id;
  const read = await f.call("skill_group_assignments", {groupId});
  assert.equal(read.data.assignments[0].id, assignmentId);
  await assert.rejects(f.call("skill_group_assignment_edit", {groupId, assignmentId, commandId: "stale", expectedRevision: revision,
    payload: {enabled: false}}), /revision changed/);
  const updated = await f.call("skill_group_assignment_edit", {groupId, assignmentId, commandId: "edit", expectedRevision: read.revision,
    payload: {enabled: false}});
  const ownerRead = await f.app.inject({method: "GET", url: `/api/skill-groups/${groupId}/assignments`});
  assert.equal(ownerRead.json().assignments[0].enabled, false);
  await f.call("skill_group_unassign", {groupId, assignmentId, commandId: "unassign", expectedRevision: updated.result.revision});
  const removed = await f.call("skill_group_remove", {groupId, commandId: "remove", expectedRevision: f.revision()});
  assert.equal(removed.receipt.status, "succeeded");
  assert.equal((await f.call("command_get", {commandId: "remove"})).receipt.status, "succeeded");
  assert.equal(f.db.getSkill(skill.id)?.groupId, null);
  assert.equal(f.db.listSkillVersions(skill.id).versions.length, 1);
});

test("group removals require owner-selected confirmation bound to current affected scope", async t => {
  const f = fixture(t);
  const group = (await f.call("skill_group_create", {commandId: "create", payload: {name: "Group"}})).result.data.group;
  f.db.assistantConnections.configure(f.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
  const args = {groupId: group.id, commandId: "remove", expectedRevision: f.revision()};
  const preview = await f.call("skill_group_remove", args);
  assert.equal(preview.confirmationRequired, true);
  assert.equal(f.receipts.get(f.issued.connection.id, "remove"), null);
  f.db.createSkill({...payload(), groupId: group.id});
  await assert.rejects(f.call("skill_group_remove", {...args, confirmationId: preview.confirmationId}), /revision changed/);
  const current = {...args, expectedRevision: f.revision()};
  const next = await f.call("skill_group_remove", current);
  assert.notEqual(next.confirmationId, preview.confirmationId);
  assert.equal((await f.call("skill_group_remove", {...current, confirmationId: next.confirmationId})).receipt.status, "succeeded");
});

test("every parity operation refuses selected-project grants before dispatching Machine I/O", async t => {
  const f = fixture(t);
  f.db.assistantConnections.configure(f.issued.connection.id, {operations: "all", projects: ["allowed"]});
  for (const [name] of ASSISTANT_SKILL_PARITY) await assert.rejects(f.call(name, {runnerId: "machine", skillId: "missing", groupId: "missing",
    previewId: "missing", assignmentId: "missing", recoveryId: "missing", commandId: `deny-${name}`, expectedRevision: "old", payload: {}}), /project is excluded/);
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.syncs, 0);
});

test("sync uses shared service; an uncertain response is never redispatched on retry", async t => {
  const f = fixture(t);
  const read = await f.call("skill_machine_state", {runnerId: "machine"});
  assert.deepEqual(read.data.desired, []);
  f.state.failSync = true;
  const args = {runnerId: "machine", commandId: "sync", expectedRevision: read.revision};
  await assert.rejects(f.call("skill_sync", args), /operation failed/);
  const receipt = await f.call("command_get", {commandId: "sync"});
  assert.equal(receipt.receipt.status, "uncertain");
  assert.equal((await f.call("skill_sync", args)).receipt.status, "uncertain");
  assert.equal(f.state.syncs, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /private transport diagnostic/);
});

test("Machine previews are shared across owner/Assistant paths; import preserves immutable content", async t => {
  const f = fixture(t);
  const discovery = (await f.app.inject({method: "POST", url: "/api/runners/machine/skill-snapshots"})).json();
  const preview = await f.call("skill_machine_preview", {previewId: discovery.discoveryId, commandId: "preview", payload: {candidateId: "candidate"}});
  assert.equal(preview.result.data.digest, payload().digest);
  const imported = await f.call("skill_machine_import", {previewId: discovery.discoveryId, commandId: "import", expectedRevision: preview.result.revision,
    payload: {previewId: preview.result.data.previewId}});
  const skill = imported.result.data.skill;
  assert.equal(f.db.getSkillVersion(skill.latestVersion.id)?.digest, payload().digest);
  assert.equal(f.db.listSkillVersions(skill.id).versions.length, 1);
  assert.equal((await f.call("skill_machine_import", {previewId: discovery.discoveryId, commandId: "import", expectedRevision: preview.result.revision,
    payload: {previewId: preview.result.data.previewId}})).receipt.status, "succeeded");
  const recovery = await f.call("skill_recovery_list", {runnerId: "machine"});
  assert.deepEqual(recovery.data.operations, []);
});

test("revocation or conflicting edits during Machine inspection prevent subsequent admission", async t => {
  const f = fixture(t);
  const discovered = await f.call("skill_machine_discover", {runnerId: "machine", commandId: "discover"});
  const previewId = discovered.result.data.discoveryId;
  f.state.beforeRead = async () => {f.db.assistantConnections.revoke(f.issued.connection.id);};
  await assert.rejects(f.call("skill_machine_preview", {previewId, commandId: "preview", payload: {candidateId: "candidate"}}), /operation failed|revoked/);
  assert.equal(f.db.listSkills().length, 0);
  assert.equal(f.state.calls.filter(c => c.type === "skill_adoption").length, 0);
});

test("same-timestamp owner changes and reverts advance the persistent Library revision", async t => {
  const f = fixture(t);
  const group = f.db.createSkillGroup("Group", 1, {organizationId: f.owner.organizationId, owner: {kind: "organization", organizationId: f.owner.organizationId}});
  const old = f.revision();
  const assignment = f.db.createSkillGroupAssignment({groupId: group.id, scopeKind: "instance", runnerId: null, agentSelector: {kind: "all"}, invocation: "agent", enabled: true});
  f.db.deleteSkillGroupAssignment(group.id, assignment.id);
  assert.notEqual(f.revision(), old);
  await assert.rejects(f.call("skill_group_remove", {groupId: group.id, commandId: "stale", expectedRevision: old}), /revision changed/);
});

test("trigger metadata hides credentials; owner rotation fences removal, confirmation and retries", async t => {
  const f = fixture(t);
  f.db.createSession({id: "target", runnerId: "machine", workspaceId: "workspace", agentId: "codex", title: "Target",
    useWorktree: false, driver: "codex", config: {}, now: 1});
  const schedule = f.db.createAutomation({automationId: "automation", spec: {name: "Test", cron: "0 9 * * *", timezone: "UTC", enabled: false,
    action: {kind: "prompt_session", sessionId: "target", request: {text: "Run"}}, misfirePolicy: {kind: "skip"}, runnerPolicy: {kind: "wait"},
    concurrencyPolicy: "skip", limits: {maxCostUsd: 1, maxToolCalls: 10}, notifications: {pushEvents: []}} as AutomationSpec,
    nextFireAt: null, actor: {kind: "human", id: f.owner.userId}, now: 1});
  const created = f.automations.createTrigger(schedule.automationId, {kind: "webhook", name: "Incoming"}, {kind: "human", id: f.owner.userId}, 1);
  assert.ok(created.ok);
  const trigger = created.data!.trigger;
  const read = await f.call("auto_triggers", {automationId: schedule.automationId});
  assert.equal(read.triggers[0].triggerId, trigger.triggerId);
  assert.ok(!JSON.stringify(read).includes(created.data!.secret));
  f.automations.rotateTrigger(schedule.automationId, trigger.triggerId, {kind: "human", id: f.owner.userId}, 1);
  const args = {automationId: schedule.automationId, triggerId: trigger.triggerId, commandId: "remove-trigger", expectedRevision: read.revision};
  await assert.rejects(f.call("auto_trigger_remove", args), /revision changed/);
  args.expectedRevision = (await f.call("auto_triggers", {automationId: schedule.automationId})).revision;
  f.db.assistantConnections.configure(f.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
  const preview = await f.call("auto_trigger_remove", args);
  assert.equal(preview.confirmationRequired, true);
  assert.equal(preview.impact.triggers[0].triggerId, trigger.triggerId);
  await assert.rejects(f.call("auto_trigger_remove", {...args, confirmationId: "wrong"}), /confirmation/);
  assert.equal(f.receipts.get(f.issued.connection.id, args.commandId), null, "failed confirmation rolls back reservation");
  assert.equal((await f.call("auto_trigger_remove", {...args, confirmationId: preview.confirmationId})).receipt.status, "succeeded");
  assert.equal(f.db.listAutomationTriggers(schedule.automationId).length, 0);
  assert.equal((await f.call("auto_trigger_remove", args)).receipt.status, "succeeded");
  assert.ok(!f.operations.list(f.issued.connection).some(op => /trigger_(create|rotate)/.test(op.name)));
});

test("adoption checks live library revision after source inspection before any destructive dispatch", async t => {
  const f = fixture(t);
  const discovery = await f.call("skill_machine_discover", {runnerId: "machine", commandId: "discover"});
  const previewId = discovery.result.data.discoveryId;
  const reviewed = await f.call("skill_machine_preview", {previewId, commandId: "review", payload: {candidateId: "candidate"}});
  const imported = await f.call("skill_machine_import", {previewId, commandId: "import", expectedRevision: reviewed.result.revision,
    payload: {previewId: reviewed.result.data.previewId}});
  const skill = imported.result.data.skill;
  f.db.createSkillAssignment({skillId: skill.id, scopeKind: "runner", runnerId: "machine", agentSelector: {kind: "agent", agentId: "codex"}});
  const preview = await f.call("skill_machine_preview", {previewId, commandId: "review-again", payload: {candidateId: "candidate"}});
  const ready = await f.call("skill_adoption_preflight", {previewId, commandId: "preflight", payload: {previewId: preview.result.data.previewId}});
  assert.equal(ready.result.data.status, "prerequisites_met");
  assert.ok(ready.result.data.adoptionToken);
  f.state.beforeRead = async () => {f.db.createSkillGroup("Intervening Owner Edit", 2);};
  await assert.rejects(f.call("skill_machine_adopt", {previewId, commandId: "adopt", expectedRevision: ready.result.revision,
    payload: {previewId: preview.result.data.previewId, adoptionToken: ready.result.data.adoptionToken, confirmation: "explicit"}}), /operation failed/);
  assert.equal(f.state.calls.filter(c => c.type === "skill_adoption").length, 0);
  assert.equal(f.receipts.get(f.issued.connection.id, "adopt")?.status, "uncertain");
  f.state.beforeRead = async () => {};
  const fresh = await f.call("skill_adoption_preflight", {previewId, commandId: "fresh-preflight", payload: {previewId: preview.result.data.previewId}});
  const adopted = await f.call("skill_machine_adopt", {previewId, commandId: "fresh-adopt", expectedRevision: fresh.result.revision,
    payload: {previewId: preview.result.data.previewId, adoptionToken: fresh.result.data.adoptionToken, confirmation: "explicit"}});
  assert.equal(adopted.result.data.status, "adopted");
  assert.equal(f.state.calls.filter(c => c.type === "skill_adoption").length, 1);
  assert.equal((await f.call("command_get", {commandId: "fresh-adopt"})).receipt.status, "succeeded");
});

test("current owner ceiling prevents Machine access even under an all-operations grant", async t => {
  const f = fixture(t);
  const access = f.db.canAccessRunner.bind(f.db);
  f.db.canAccessRunner = () => false;
  await assert.rejects(f.call("skill_machine_discover", {runnerId: "machine", commandId: "denied"}), /granting owner cannot access/);
  assert.equal(f.state.calls.length, 0);
  f.db.canAccessRunner = access;
  f.db.assistantConnections.configure(f.issued.connection.id, {operations: ["skill_groups"], projects: "all"});
  await assert.rejects(f.call("skill_sync", {runnerId: "machine", commandId: "sync", expectedRevision: f.revision()}), /excluded/);
  assert.equal(f.state.syncs, 0);
});

test("drift preview/import and restore invoke the shared observation-fenced workflow", async t => {
  const f = fixture(t);
  const skill = f.db.createSkill(payload("alpha", "Library"));
  const version = skill.latestVersion!;
  f.db.createSkillAssignment({skillId: skill.id, scopeKind: "runner", runnerId: "machine", agentSelector: {kind: "agent", agentId: "codex"}});
  const drift = {name: "alpha", digest: version.digest, variant: "agent" as const, observedDigest: payload().digest, held: true};
  f.db.setRunnerSkillState("machine", {deployed: [], unmanaged: [], drift: [drift]}, 2);
  const preview = await f.call("skill_drift_preview", {runnerId: "machine", commandId: "drift-preview", payload: drift});
  assert.equal(preview.result.data.files[0].content, payload().files[0]!.content);
  const imported = await f.call("skill_drift_import", {previewId: preview.result.data.previewId, commandId: "drift-import",
    expectedRevision: preview.result.revision, payload: {acceptUpdate: true}});
  assert.equal(imported.result.data.version.digest, payload().digest);
  assert.equal(f.db.listSkillVersions(skill.id).versions.length, 2);
  assert.equal(f.db.getSkillVersion(version.id)?.digest, version.digest);
  f.db.setRunnerSkillState("machine", {deployed: [], unmanaged: [], drift: [drift]}, 3);
  const restored = await f.call("skill_drift_restore", {runnerId: "machine", commandId: "restore", expectedRevision: f.revision(),
    payload: {...drift, confirmation: "explicit"}});
  assert.equal(restored.result.data.status, "restored");
});

test("built-in review, apply and recommendation reuse owner services without discarding prior versions", async t => {
  const f = fixture(t);
  const skill = f.db.createSkill(payload("release-guide", "Older"));
  seedBuiltInSkills(f.db, f.deps.builtInSkills!, 1);
  const reviewed = await f.call("skill_builtin_get", {skillId: skill.id});
  assert.equal(reviewed.data.kind, "adopt");
  const applied = await f.call("skill_builtin_apply", {skillId: skill.id, commandId: "builtin", expectedRevision: reviewed.revision,
    payload: {digest: reviewed.data.digest, expectedLatestVersionId: reviewed.data.expectedLatestVersionId, accepted: true}});
  assert.equal(applied.result.data.skill.latestVersion.digest, payload("release-guide").digest);
  assert.equal(f.db.listSkillVersions(skill.id).versions.length, 2);
  const dismissed = await f.call("skill_recommendation", {skillId: skill.id, commandId: "dismiss", expectedRevision: applied.result.revision,
    payload: {dismissed: true}});
  assert.equal(dismissed.result.data.skill.recommendation.dismissed, true);
  assert.equal(f.db.skillRecommendationDismissals(f.owner.userId).has(skill.id), true);
});

test("Git review/import uses the shared snapshot, immutable provenance and retry receipts", async t => {
  const f = fixture(t);
  const preview = await f.call("skill_git_preview", {commandId: "git-preview", payload: {url: "team/repository"}});
  const previewId = preview.result.data.previewId;
  assert.equal(f.db.listSkills().length, 0);
  const imported = await f.call("skill_git_import", {commandId: "git-import", expectedRevision: preview.result.revision,
    payload: {previewId, path: "skills/alpha"}});
  const skill = imported.result.data.skill;
  assert.equal(f.db.getSkillVersion(skill.latestVersion.id)?.gitSource?.commit, "a".repeat(40));
  assert.equal((await f.call("skill_git_import", {commandId: "git-import", expectedRevision: preview.result.revision,
    payload: {previewId, path: "skills/alpha"}})).receipt.status, "succeeded");
  assert.equal(f.db.listSkills().length, 1);
});

test("orphaned-copy preview/import reads the owner snapshot and preserves imported version evidence", async t => {
  const f = fixture(t);
  const id = "00000000-0000-4000-8000-000000000002";
  f.db.setRunnerSkillState("machine", {deployed: [], unmanaged: [], keptAside: [{id, name: "alpha", digest: "a".repeat(64),
    variant: "agent", keptAsideAt: 1, observedDigest: payload().digest, observedFingerprint: "9".repeat(64)}]}, 2);
  const preview = await f.call("skill_orphan_preview", {runnerId: "machine", commandId: "orphan-preview", payload: {kind: "kept_aside", id}});
  const imported = await f.call("skill_orphan_import", {previewId: preview.result.data.previewId, commandId: "orphan-import",
    expectedRevision: preview.result.revision, payload: {}});
  assert.equal(imported.result.data.skill.latestVersion.digest, payload().digest);
  assert.equal(f.db.listSkillVersions(imported.result.data.skill.id).versions.length, 1);
  assert.ok(f.state.calls.some(c => c.type === "skill_kept_aside" && c.operation === "discard"));
});

test("committed drift/orphan effects keep uncertain receipts after post-effect access loss", async t => {
  for (const operation of ["skill_drift_import", "skill_orphan_import", "skill_drift_restore"] as const) {
    await t.test(operation, async t => {
      const f = fixture(t);
      const skill = f.db.createSkill(payload("alpha", "Library"));
      const drift = {name: "alpha", digest: skill.latestVersion!.digest, variant: "agent" as const, observedDigest: payload().digest, held: true};
      let args: Record<string, unknown>;
      if (operation === "skill_orphan_import") {
        const id = "00000000-0000-4000-8000-000000000003";
        f.db.setRunnerSkillState("machine", {deployed: [], unmanaged: [], keptAside: [{id, name: "alpha", digest: skill.latestVersion!.digest,
          variant: "agent", keptAsideAt: 1, observedDigest: payload().digest, observedFingerprint: "9".repeat(64)}]}, 2);
        const preview = await f.call("skill_orphan_preview", {runnerId: "machine", commandId: "preview", payload: {kind: "kept_aside", id}});
        args = {previewId: preview.result.data.previewId, commandId: "late", expectedRevision: preview.result.revision, payload: {acceptUpdate: true}};
      } else {
        f.db.createSkillAssignment({skillId: skill.id, scopeKind: "runner", runnerId: "machine", agentSelector: {kind: "agent", agentId: "codex"}});
        f.db.setRunnerSkillState("machine", {deployed: [], unmanaged: [], drift: [drift]}, 2);
        if (operation === "skill_drift_import") {
          const preview = await f.call("skill_drift_preview", {runnerId: "machine", commandId: "preview", payload: drift});
          args = {previewId: preview.result.data.previewId, commandId: "late", expectedRevision: preview.result.revision, payload: {acceptUpdate: true}};
        } else args = {runnerId: "machine", commandId: "late", expectedRevision: f.revision(), payload: {...drift, confirmation: "explicit"}};
      }
      f.state.beforeSyncReply = async () => {
        // This callback runs only after the import committed / restore was acknowledged.
        if (operation === "skill_orphan_import") f.db.canAccessSkill = () => false;
        else f.db.assistantConnections.configure(f.issued.connection.id, {operations: ["skill_groups"], projects: "all"});
      };
      await assert.rejects(f.call(operation, args), /operation failed/);
      assert.equal(f.receipts.get(f.issued.connection.id, "late")?.status, "uncertain");
      assert.equal(f.db.listSkillVersions(skill.id).versions.length, operation === "skill_drift_restore" ? 1 : 2);
      if (operation === "skill_drift_restore") assert.ok(f.state.calls.some(c => c.type === "skill_drift" && c.operation === "restore"));
      else assert.equal(f.db.getSkill(skill.id)?.latestVersion?.digest, payload().digest);
      if (operation === "skill_drift_import") {
        f.db.assistantConnections.configure(f.issued.connection.id, {operations: "all", projects: "all"});
        const syncs = f.state.syncs;
        assert.equal((await f.call(operation, args)).receipt.status, "uncertain");
        assert.equal(f.state.syncs, syncs);
        assert.equal(f.db.listSkillVersions(skill.id).versions.length, 2);
      }
    });
  }
});

test("an import fence refusal retains its revision remedy and failed receipt before any write", async t => {
  const f = fixture(t);
  const preview = await f.call("skill_git_preview", {commandId: "preview", payload: {url: "team/repository"}});
  const key = "POST /api/skill-git/import", handler = f.service.handlers.get(key)!;
  f.service.handlers.set(key, async (req, reply) => handler(Object.create(req, {beforeEffect: {value: () => {
    f.db.createSkillGroup("Intervening Owner Edit", 2);
    req.beforeEffect?.();
  }}}), reply));
  await assert.rejects(f.call("skill_git_import", {commandId: "import", expectedRevision: preview.result.revision,
    payload: {previewId: preview.result.data.previewId, path: "skills/alpha"}}), /Skill Library revision changed.*Read the current resource/);
  assert.equal(f.receipts.get(f.issued.connection.id, "import")?.status, "failed");
  assert.equal(f.db.listSkills().length, 0);
  assert.equal(f.state.calls.length, 0);
});
