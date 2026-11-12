import assert from "node:assert/strict";
import {test} from "node:test";
import Fastify from "fastify";
import {DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION} from "@wollipog/protocol";
import {ControlPlaneDb} from "./db.js";
import {Hub} from "./hub.js";
import {SessionsService} from "./sessions.js";
import {OrchestratorSettings, resolveOrchestratorCampaignPolicy} from "./orchestrator-settings.js";
import {registerCampaignStatusRoutes} from "./campaign-status-routes.js";
import {registerCampaignIssueScopeRoutes} from "./campaign-issue-scope-routes.js";
import {createCampaignReviewManagement} from "./campaign-review-management.js";
import {createAssistantOperations, registerAssistantRoutes} from "./assistant-routes.js";
import {registerAssistantSessionOperations} from "./assistant-session-operations.js";
import {ASSISTANT_CAMPAIGN_MANAGEMENT, ASSISTANT_CAMPAIGN_ALIASES, registerAssistantCampaignManagement} from "./assistant-campaign-management.js";
import {sessionHoldReaderFor} from "./session-command-permissions.js";
import {AssistantRefusal} from "./assistant-connections.js";

async function fixture() {
  const db = ControlPlaneDb.open(":memory:"), local = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
  db.registerRunner({runnerId: "runner", hostname: "fixture", os: "linux", version: "fixture", agents: [],
    workspaces: [{id: "repo", name: "Fixture", path: "/fixture"}]}, 1, PROTOCOL_VERSION);
  const project = db.createProject({name: "Granted"}), other = db.createProject({name: "Excluded"});
  const location = db.addProjectLocation(project.id, {runnerId: "runner", workspaceId: "repo"});
  const otherLocation = db.addProjectLocation(other.id, {runnerId: "runner", workspaceId: "repo"});
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  for (const id of ["root", "worker"]) {
    db.createSession({id, runnerId: "runner", workspaceId: "repo", agentId: "fixture", driver: "acp", useWorktree: false,
      title: id, config: {}, now: 1, ...(id === "root" ? {role: "orchestrator", orchestratorPolicy: policy,
        parentControlPolicy: {decisions: {...HUMAN_ONLY_PARENT_CONTROL_POLICY}}} : {parentSessionId: "root"})});
    db.setSessionProject(id, project.id, location.id);
    db.updateSessionStatus(id, "idle", 2);
  }
  const hub = new Hub(db), sent: unknown[] = [];
  hub.isRunnerOnline = () => true;
  hub.sendToRunner = (_id, value) => {sent.push(value); return true;};
  hub.requestFromRunner = async (_id, requestId, message) => {
    if (message.type === "campaign_issue_scope") return {type: "campaign_issue_scope_result", requestId,
      sessionId: message.sessionId, ok: true, repository: "fixture/repository", candidates: []};
    throw new Error("Unexpected fixture runner request");
  };
  const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
  const plan = svc.recordCampaignPlan("root", {items: [{key: "fixture", issue: {repository: "fixture/repository", number: 1}}], planComplete: true});
  assert.ok(plan.ok, plan.error ?? "Plan refused");
  const itemId = plan.data!.items[0]!.workItemId;
  assert.ok(svc.assignCampaignWorkItem("root", {workItemId: itemId, childSessionId: "worker"}).ok);
  const decision = svc.createWorkflowDecision("worker", {requestId: "fixture-question", resourceKey: "fixture-question",
    resourceSnapshot: {category: "implementation_question", kind: "question", question: "Fixture question", options: []}});
  assert.ok(decision.ok, decision.error ?? "Decision refused");
  db.reviewSessions.record({reviewSessionId: "fixture-review", requesterSessionId: "root", runnerId: "runner",
    pullRequest: {repository: "fixture/repository", number: 1}, headSha: "a".repeat(40), reviewer: "codex"}, 10);
  const app = Fastify();
  const status = registerCampaignStatusRoutes(app, {db, requestPrincipal: () => owner});
  const scope = registerCampaignIssueScopeRoutes(app, {db, svc, requestPrincipal: () => owner});
  const settings = new OrchestratorSettings(db);
  const review = createCampaignReviewManagement({db, svc,
    behaviorView: (id, human, access) => svc.campaignBehaviorView(id, (behavior, exactRow) => settings.campaignCapabilities(human, behavior, exactRow, access?.runner)),
    holdReader: principal => target => sessionHoldReaderFor(db, principal, target)});
  review.registerHttp(app, () => owner);
  const operations = createAssistantOperations(db), receipts = registerAssistantSessionOperations(operations, db, svc);
  registerAssistantCampaignManagement(operations, {db, svc, receipts, services: [status, scope, review]});
  registerAssistantRoutes(app, {db, operations, requestHuman: () => owner});
  const issued = db.assistantConnections.create(owner, "Synthetic", {operations: "all", projects: "all"});
  const credential = db.assistantConnections.authenticate(issued.token)!;
  const call = (name: string, args: Record<string, unknown> = {}) => operations.call(credential, name, {sessionId: "root", ...args}) as Promise<any>;
  const mcp = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${issued.token}`},
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: {sessionId: "root", ...args}}}});
    const result = response.json();
    assert.ok(!result.error, JSON.stringify(result));
    return JSON.parse(result.result.content[0].text);
  };
  return {db, owner, project, other, location, otherLocation, hub, svc, app, operations, receipts, issued, call, mcp, itemId,
    occurrenceId: decision.data!.occurrenceId, sent, close: async () => {await app.close(); db.close();}};
}

const finding = {scope: "all_branch", diffHash: "a".repeat(64), filePath: "fixture.ts", side: "right", line: 1,
  body: "Synthetic finding", severity: "minor", required: true};

test("integrated status aliases retain shared projections and their own current operation grants", async () => {
  const h = await fixture();
  try {
    for (const [alias, canonical] of ASSISTANT_CAMPAIGN_ALIASES) {
      h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
      const expected = await h.call(canonical);
      assert.deepEqual(await h.mcp(alias), expected, alias);
      h.db.assistantConnections.configure(h.issued.connection.id, {operations: [alias], projects: [h.project.id]});
      assert.equal((await h.call(alias)).status, expected.status);
      await assert.rejects(h.call(canonical), /excluded/);
      h.db.setSessionProject("worker", h.other.id, h.otherLocation.id);
      await assert.rejects(h.call(alias), /outside/);
      h.db.setSessionProject("worker", h.project.id, h.location.id);
    }
  } finally {await h.close();}
});

test("all 14 read-like operations match the owner HTTP projection through actual MCP", async (t) => {
  t.mock.timers.enable({apis: ["Date"], now: 1_800_000_000_000});
  const h = await fixture();
  try {
    for (const [name, route] of ASSISTANT_CAMPAIGN_MANAGEMENT.filter(([name]) => !["review_find_add", "review_find_set", "review_find_send", "campaign_branch_clean"].includes(name))) {
      const [method, path] = route.split(" ") as ["GET" | "POST", string];
      const args = {itemId: h.itemId, occurrenceId: h.occurrenceId, reviewSessionId: "fixture-review"};
      const url = path.replace(":id", "root").replace(":itemId", h.itemId).replace(":occurrenceId", h.occurrenceId).replace(":reviewSessionId", "fixture-review");
      const http = await h.app.inject({method, url});
      const parameters = Object.fromEntries(Object.entries(args).filter(([key]) => path.includes(":"+key)));
      const assistant = await h.mcp(name, parameters);
      assert.equal(assistant.status, http.statusCode, name);
      assert.deepEqual(assistant.body, http.json(), name);
      if (http.headers["cache-control"]) assert.equal(assistant.headers["cache-control"], http.headers["cache-control"]);
    }
    assert.ok(h.operations.inventory().every(operation => operation.name.length <= 32));
  } finally {await h.close();}
});

test("every operation enforces both current operation and Project grants before any receipt", async () => {
  const h = await fixture();
  try {
    for (const restriction of ["project", "operation"] as const) {
      h.db.assistantConnections.configure(h.issued.connection.id, restriction === "project"
        ? {operations: "all", projects: [h.other.id]} : {operations: ["command_get"], projects: "all"});
      for (const [name] of ASSISTANT_CAMPAIGN_MANAGEMENT) {
        await assert.rejects(h.call(name, {commandId: "denied"}), /excluded/, name);
        assert.equal(h.receipts.get(h.issued.connection.id, "denied"), null);
      }
    }
    h.db.assistantConnections.revoke(h.issued.connection.id);
    await assert.rejects(h.call("campaign_summary"), /revoked/);
  } finally {await h.close();}
});

test("selected Project grants cannot disclose an aggregate after a descendant moves outside them", async () => {
  const h = await fixture();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
    assert.equal((await h.call("campaign_items")).status, 200);
    h.db.setSessionProject("worker", h.other.id, h.otherLocation.id);
    await assert.rejects(h.call("campaign_summary"), /outside/);
    await assert.rejects(h.call("desc_request_list"), /outside/);
    await assert.rejects(h.call("decision_list"), /outside/);
    assert.equal(h.receipts.get(h.issued.connection.id, "denied"), null);
  } finally {await h.close();}
});

test("a duplicate mutation cannot recover its original receipt through a newly granted Project", async () => {
  const h = await fixture();
  try {
    const args = {commandId: "original-project", payload: finding};
    assert.equal((await h.call("review_find_add", args)).receipt.status, "succeeded");
    for (const id of ["root", "worker"]) h.db.setSessionProject(id, h.other.id, h.otherLocation.id);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.other.id]});
    await assert.rejects(h.call("review_find_add", args), /excluded/);
    assert.equal(h.db.listReviewFindings("root").length, 1);
  } finally {await h.close();}
});

test("review mutations share owner validation, attribution and prompt dispatch; receipts never replay", async () => {
  const h = await fixture();
  try {
    const invalidHttp = await h.app.inject({method: "POST", url: "/api/sessions/root/review-findings", payload: {}});
    const invalidAssistant = await h.mcp("review_find_add", {payload: {}, commandId: "invalid"});
    assert.equal(invalidAssistant.status, invalidHttp.statusCode);
    assert.deepEqual(invalidAssistant.body, invalidHttp.json());
    const args = {payload: finding, commandId: "add"}, created = await h.mcp("review_find_add", args);
    assert.equal(created.receipt.status, "succeeded");
    const saved = h.db.listReviewFindings("root")[0]!;
    assert.deepEqual(saved.author, {kind: "human", id: h.owner.userId});
    assert.equal((await h.mcp("review_find_add", args)).receipt.operationId, "add");
    assert.equal(h.db.listReviewFindings("root").length, 1);
    await assert.rejects(h.call("review_find_add", {...args, payload: {...finding, body: "Changed"}}), /different operation or request/);
    const sent = await h.mcp("review_find_send", {commandId: "send", payload: {findings: [{findingId: saved.findingId, expectedUpdatedAt: saved.updatedAt}]}});
    assert.equal(sent.receipt.status, "succeeded");
    const count = h.sent.length;
    await h.mcp("review_find_send", {commandId: "send", payload: {findings: [{findingId: saved.findingId, expectedUpdatedAt: saved.updatedAt}]}});
    assert.equal(h.sent.length, count);
    assert.equal(h.db.listReviewFindings("root")[0]!.status, "sent");
    assert.ok(!JSON.stringify(h.receipts.get(h.issued.connection.id, "add")).includes(finding.body));
    assert.equal((await h.call("command_get", {commandId: "add"})).receipt.status, "succeeded");
  } finally {await h.close();}
});

test("resolve/dismiss confirmations bind finding revision and grant revision before receipt reservation", async () => {
  const h = await fixture();
  try {
    await h.call("review_find_add", {payload: finding, commandId: "add"});
    const saved = h.db.listReviewFindings("root")[0]!;
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "resolve", findingId: saved.findingId, payload: {status: "resolved", expectedUpdatedAt: saved.updatedAt}};
    const preview = await h.call("review_find_set", args);
    assert.equal(preview.confirmationRequired, true);
    assert.equal(h.receipts.get(h.issued.connection.id, "resolve"), null);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    await assert.rejects(h.call("review_find_set", {...args, confirmationId: preview.confirmationId}), /confirmation/);
    const staleFinding = await h.call("review_find_set", args);
    h.db.raw().prepare("UPDATE review_findings SET updated_at=updated_at+1 WHERE finding_id=?").run(saved.findingId);
    await assert.rejects(h.call("review_find_set", {...args, confirmationId: staleFinding.confirmationId}), /confirmation/);
    assert.equal(h.receipts.get(h.issued.connection.id, "resolve"), null);
    const current = {...args, payload: {...args.payload, expectedUpdatedAt: h.db.listReviewFindings("root")[0]!.updatedAt}};
    const fresh = await h.call("review_find_set", current);
    assert.equal((await h.mcp("review_find_set", {...current, confirmationId: fresh.confirmationId})).receipt.status, "succeeded");
    assert.equal(h.db.listReviewFindings("root")[0]!.status, "resolved");
  } finally {await h.close();}
});

test("branch cleanup requires confirmation and cannot manufacture a missing deletion approval", async () => {
  const h = await fixture();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "cleanup"}, preview = await h.call("campaign_branch_clean", args);
    assert.equal(preview.confirmationRequired, true);
    assert.equal(h.receipts.get(h.issued.connection.id, "cleanup"), null);
    const http = await h.app.inject({method: "POST", url: "/api/sessions/root/orchestrator-campaign/cleanup/delete-merged-branches", payload: {}});
    const assistant = await h.mcp("campaign_branch_clean", {...args, confirmationId: preview.confirmationId});
    assert.equal(assistant.status, http.statusCode);
    assert.equal(assistant.status, 409);
    assert.deepEqual(assistant.body, http.json());
    assert.equal(assistant.receipt.status, "failed");
  } finally {await h.close();}
});

test("an asynchronous scope read cannot return a private result after credential rotation", async () => {
  const h = await fixture();
  try {
    h.svc.campaignIssueScope = async () => {
      h.db.assistantConnections.rotate(h.issued.connection.id);
      return {ok: true, status: 200, data: {private: "must never return"}} as any;
    };
    await assert.rejects(h.call("campaign_scope"), /rotated/);
  } finally {await h.close();}
});

test("unexpected post-dispatch failures keep uncertain receipts and do not retry a finding bundle", async () => {
  const h = await fixture();
  try {
    let calls = 0;
    h.svc.bundleReviewFindings = () => {calls++; throw new Error("private transport failure");};
    const args = {commandId: "uncertain", payload: {findings: []}};
    assert.equal((await h.call("review_find_send", args)).receipt.status, "uncertain");
    assert.equal((await h.call("review_find_send", args)).receipt.status, "uncertain");
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(h.receipts.get(h.issued.connection.id, "uncertain")).includes("private transport"));
  } finally {await h.close();}
});

test("known success keeps its receipt but withholds private results after in-flight revocation", async () => {
  const h = await fixture();
  try {
    const original = h.svc.createReviewFinding.bind(h.svc);
    h.svc.createReviewFinding = (...args) => {
      const result = original(...args);
      h.db.assistantConnections.revoke(h.issued.connection.id);
      return result;
    };
    const result = await h.call("review_find_add", {commandId: "revoked", payload: finding});
    assert.equal(result.receipt.status, "succeeded");
    assert.ok(!JSON.stringify(result).includes(finding.body));
    assert.equal(h.db.listReviewFindings("root").length, 1);
  } finally {await h.close();}
});

test("campaign behavior capabilities exclude installations and models outside the Project grant", async () => {
  const h = await fixture();
  try {
    h.db.registerRunner({runnerId: "excluded-runner", hostname: "Excluded Machine", os: "linux", version: "fixture",
      workspaces: [{id: "private-repo", name: "Excluded", path: "/excluded"}],
      agents: [{id: "excluded-agent", name: "Excluded Agent", driver: "acp", command: "fixture", args: [], env: {}, available: true,
        capabilities: {models: [{id: "excluded-only-model"}], effortLevels: ["high"], slashCommands: [], supportsImages: false, supportsApprovals: true}}]}, Date.now(), PROTOCOL_VERSION);
    h.db.addProjectLocation(h.other.id, {runnerId: "excluded-runner", workspaceId: "private-repo"});
    const http = await h.app.inject({method: "GET", url: "/api/sessions/root/orchestrator-campaign/behavior"});
    assert.ok(JSON.stringify(http.json()).includes("excluded-only-model"), "The owner can inspect the excluded Project's installation");
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
    const assistant = await h.mcp("campaign_behavior");
    assert.equal(assistant.body.capabilities.installations, 0);
    assert.ok(!JSON.stringify(assistant).includes("excluded-only-model"));
    assert.ok(!JSON.stringify(assistant).includes("Excluded Machine"));
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
    assert.deepEqual((await h.mcp("campaign_behavior")).body, http.json(), "Full Access keeps the owner capability catalog");
  } finally {await h.close();}
});

test("a known refusal after reservation but before dispatch is failed and recorded as refused", async () => {
  const h = await fixture();
  try {
    const reserve = h.receipts.reserve.bind(h.receipts);
    h.receipts.reserve = (...args) => {
      const result = reserve(...args);
      if (result.created) h.db.assistantConnections.revoke(h.issued.connection.id);
      return result;
    };
    const response = await h.app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${h.issued.token}`},
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "review_find_add",
        arguments: {sessionId: "root", commandId: "refused-before-effect", payload: finding}}}});
    assert.equal(response.json().result.isError, true);
    assert.match(response.json().result.content[0].text, /revoked/);
    assert.equal(h.receipts.get(h.issued.connection.id, "refused-before-effect")?.status, "failed");
    assert.equal(h.db.listReviewFindings("root").length, 0);
    assert.equal(h.db.assistantConnections.activity(h.issued.connection.id)[0]?.outcome, "refused");
  } finally {await h.close();}
});

test("a refusal after a possible partial cleanup remains uncertain rather than becoming failed", async () => {
  const h = await fixture();
  try {
    h.svc.deleteApprovedMergedBranches = async (_id, _access, beforeAction) => {
      await beforeAction?.();
      throw new AssistantRefusal("Fixture refusal after an effect boundary");
    };
    const result = await h.call("campaign_branch_clean", {commandId: "partial-cleanup"});
    assert.equal(result.receipt.status, "uncertain");
  } finally {await h.close();}
});
