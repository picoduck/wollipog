import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { PROTOCOL_VERSION, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { registerAssistantSessionOperations, type AssistantSessionCommandHooks } from "./assistant-session-operations.js";
import { assistantRequestDigest } from "./assistant-command-receipts.js";

function harness(hooks: AssistantSessionCommandHooks = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext(), owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
  const metadata: RunnerMetadata = {runnerId: "local", hostname: "local", os: "linux", version: "test", agents: [{id: "agent", name: "Agent", command: "agent", args: [], env: {PRIVATE_FIXTURE: "secret-fixture"},
    driver: "acp", available: true, capabilities: {models: [{id: "fixture", default: true}], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true}}],
    workspaces: [{id: "repo", name: "Repo", path: "/fixture/repo"}]};
  for (const runnerId of ["local", "ssh-fixture"]) db.registerRunner({...metadata, runnerId}, Date.now(), PROTOCOL_VERSION);
  const projects = [db.createProject({name: "First"}), db.createProject({name: "Second"})];
  const locations = projects.map((p, i) => db.addProjectLocation(p.id, {runnerId: i === 0 ? "local" : "ssh-fixture", workspaceId: "repo"}));
  for (const [i, location] of locations.entries()) {
    db.createSession({id: `unrelated-${i}`, runnerId: location.runnerId, workspaceId: "repo", agentId: "agent", title: "Existing", driver: "acp", useWorktree: false, config: {}, now: Date.now()});
    db.setSessionProject(`unrelated-${i}`, location.projectId, location.id);
    db.updateSessionStatus(`unrelated-${i}`, "idle", Date.now());
  }
  const hub = new Hub(db);
  let online = true;
  const sent: unknown[] = [];
  hub.isRunnerOnline = () => online;
  hub.sendToRunner = (_id, message) => {sent.push(message); return online;};
  const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
  const operations = createAssistantOperations(db), receipts = registerAssistantSessionOperations(operations, db, svc, hooks);
  const issued = db.assistantConnections.create(owner, "Fixture Assistant", {operations: "all", projects: "all"});
  const credential = db.assistantConnections.authenticate(issued.token)!;
  const call = (name: string, args: unknown = {}) => operations.call(credential, name, args) as Promise<any>;
  return {db, owner, projects, locations, svc, operations, receipts, issued, call, sent, offline: () => {online = false;}, close: () => {db.close();}};
}

test("Full Access discovers multiple projects, local/SSH capabilities and unrelated sessions without secrets or ancestry", async () => {
  const h = harness();
  try {
    assert.ok(h.projects.every(p => (h.db.listProjects()).some(actual => actual.id === p.id)));
    assert.ok((await h.call("project_list")).projects.length >= 2);
    const runners = await h.call("runner_list");
    assert.equal(runners.runners.length, 2);
    assert.ok(!JSON.stringify(runners).includes("secret-fixture"));
    assert.ok(!JSON.stringify(runners).includes("PRIVATE_FIXTURE"));
    assert.equal((await h.call("session_list")).sessions.length, 2);
    assert.equal((await h.call("session_get", {sessionId: "unrelated-1"})).session.status, "idle");
    assert.equal(h.db.getSession("unrelated-1")?.parentSessionId, null);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.projects[0]!.id]});
    assert.equal((await h.call("project_list")).projects.length, 1);
    assert.equal((await h.call("runner_list")).runners.length, 1);
    assert.equal((await h.call("session_list")).sessions.length, 1);
    await assert.rejects(h.call("session_get", {sessionId: "unrelated-1"}), /project is excluded/);
  } finally {h.close();}
});

test("work-origin association commits with reservation and duplicate events cannot duplicate service commands", async () => {
  let failAssociation = true;
  const h = harness({associateCommand(args, receipt) {
    h.db.raw().prepare("INSERT INTO fixture_origins VALUES (?,?)").run(String(args.workOriginId), receipt.operationId);
    if (failAssociation) throw new Error("fixture rollback");
  }});
  try {
    h.db.raw().exec("CREATE TABLE fixture_origins (origin_id TEXT PRIMARY KEY, command_id TEXT UNIQUE)");
    let calls = 0;
    h.svc.promptFromUser = (_owner, sessionId) => {calls++; return {ok: true, status: 200, data: h.db.getSession(sessionId)!};};
    const args = {commandId: "event-command", workOriginId: "event-origin", sessionId: "unrelated-0", text: "Follow up"};
    await assert.rejects(h.call("session_prompt", args), /fixture rollback/);
    assert.equal(h.receipts.get(h.issued.connection.id, args.commandId), null);
    assert.equal(h.db.raw().prepare("SELECT * FROM fixture_origins").all().length, 0);
    assert.equal(calls, 0);
    failAssociation = false;
    await h.call("session_prompt", args);
    await h.call("session_prompt", args);
    assert.equal(calls, 1);
    assert.equal(h.db.raw().prepare("SELECT * FROM fixture_origins").all().length, 1);
  } finally {h.close();}
});

test("existing session lifecycle shares the service and command identities survive response loss", async () => {
  const h = harness();
  try {
    const args = {sessionId: "unrelated-1", commandId: "archive-1"};
    h.db.updateSessionStatus(args.sessionId, "completed", Date.now());
    const result = await h.call("session_archive", args);
    assert.equal(result.receipt.status, "succeeded");
    assert.equal(h.db.getSession(args.sessionId)?.archived, true);
    const duplicate = await h.call("session_archive", args);
    assert.deepEqual(duplicate.receipt, result.receipt);
    assert.deepEqual((await h.call("command_get", {commandId: "archive-1"})).receipt, result.receipt);
    await assert.rejects(h.call("session_archive", {...args, sessionId: "unrelated-0"}), /different operation or request/);
    await assert.rejects(h.call("session_stop", args), /different operation or request/);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: ["command_get"], projects: "all"});
    await assert.rejects(h.call("command_get", {commandId: "archive-1"}), /session_archive is excluded/);
    h.db.assistantConnections.revoke(h.issued.connection.id);
    await assert.rejects(h.call("session_list"), /revoked/);
  } finally {h.close();}
});

test("launch uses the same runner protocol path for local and SSH Locations; duplicate launches never dispatch", async () => {
  const h = harness();
  try {
    for (const [i, location] of h.locations.entries()) {
      const args = {commandId: `launch:${i}`, locationId: location.id, agentId: "agent", useWorktree: false};
      const result = await h.call("session_launch", args);
      assert.equal(result.receipt.status, "succeeded", JSON.stringify(result));
      const s = h.db.getSession(result.sessionId)!;
      assert.equal(s.runnerId, location.runnerId);
      assert.equal(s.projectId, location.projectId);
      assert.equal(s.parentSessionId, null);
      const count = h.sent.length;
      await h.call("session_launch", args);
      assert.equal(h.sent.length, count);
    }
  } finally {h.close();}
});

test("uncertain service exceptions remain reconcilable and disconnected runner refusals preserve cause", async () => {
  const h = harness();
  try {
    let attempts = 0;
    h.svc.promptFromUser = () => {attempts++; throw new Error("secret internal fixture");};
    const args = {sessionId: "unrelated-0", commandId: "uncertain", text: "hello"};
    assert.equal((await h.call("session_prompt", args)).receipt.status, "uncertain");
    assert.equal((await h.call("session_prompt", args)).receipt.status, "uncertain");
    assert.equal(attempts, 1);
    assert.equal((await h.call("command_get", {commandId: "uncertain"})).receipt.status, "uncertain");
    h.offline();
    const launch = await h.call("session_launch", {commandId: "offline", locationId: h.locations[1]!.id, agentId: "agent"});
    assert.equal(launch.receipt.status, "failed", JSON.stringify(launch));
    assert.match(launch.error, /offline|connected|online/i);
  } finally {h.close();}
});

test("real Fastify MCP exposes short management names and uses identical grants regardless of client address", async () => {
  const h = harness(), app = Fastify();
  try {
    registerAssistantRoutes(app, {db: h.db, operations: h.operations, requestHuman: () => null});
    const invoke = (remoteAddress: string) => app.inject({method: "POST", url: "/assistant/mcp", remoteAddress,
      headers: {authorization: `Bearer ${h.issued.token}`}, payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "session_list", arguments: {}}}});
    assert.deepEqual((await invoke("127.0.0.1")).json(), (await invoke("198.51.100.5")).json());
    const names = h.operations.list(h.issued.connection).map(o => o.name);
    assert.ok(names.includes("session_launch"));
    assert.ok(names.every(n => n.length <= 32));
  } finally {await app.close(); h.close();}
});

test("follow-up reservation is persisted before service entry; concurrent duplicates execute once and revoked grants never dispatch", async () => {
  const h = harness();
  try {
    let dispatched = 0;
    h.svc.promptFromUser = (_owner, sessionId) => {
      assert.equal(h.receipts.get(h.issued.connection.id, "prompt:1")?.status, "accepted");
      dispatched++;
      return {ok: true, status: 200, data: h.db.getSession(sessionId)!};
    };
    const args = {commandId: "prompt:1", sessionId: "unrelated-1", text: "Follow up"};
    await Promise.all([h.call("session_prompt", args), h.call("session_prompt", args)]);
    assert.equal(dispatched, 1);
    const pending = h.call("session_prompt", {...args, commandId: "revoked"});
    h.db.assistantConnections.revoke(h.issued.connection.id);
    await assert.rejects(pending, /revoked/);
    assert.equal(dispatched, 1);
  } finally {h.close();}
});

test("authorized result pages exclude nested tools, and moved sources revoke receipt access", async () => {
  const h = harness();
  try {
    h.db.appendEvent("unrelated-0", {kind: "agent_message", text: "Final fixture report", final: true}, Date.now());
    h.db.appendEvent("unrelated-0", {kind: "agent_message", text: "Nested private tool output", parentToolUseId: "tool", final: true}, Date.now());
    h.db.appendEvent("unrelated-0", {kind: "agent_response_completed"}, Date.now());
    const messages = await h.call("session_messages", {sessionId: "unrelated-0"});
    assert.ok(JSON.stringify(messages).includes("Final fixture report"));
    assert.ok(!JSON.stringify(messages).includes("Nested private tool output"));
    const result = await h.call("session_stop", {commandId: "move", sessionId: "unrelated-0"});
    assert.equal(result.receipt.target.projectId, h.projects[0]!.id);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.projects[0]!.id]});
    const movedLocation = h.db.addProjectLocation(h.projects[1]!.id, {runnerId: "local", workspaceId: "repo"});
    h.db.setSessionProject("unrelated-0", h.projects[1]!.id, movedLocation.id);
    await assert.rejects(h.call("command_get", {commandId: "move"}), /project is excluded/);
    await assert.rejects(h.call("session_messages", {sessionId: "unrelated-0"}), /project is excluded/);
  } finally {h.close();}
});

test("real session follow-up and restart service paths retain runner commands and receipts", async () => {
  const h = harness();
  try {
    const args = {commandId: "real-prompt", sessionId: "unrelated-1", text: "Fixture follow-up"};
    const result = await h.call("session_prompt", args);
    assert.equal(result.receipt.status, "succeeded", JSON.stringify(result));
    assert.equal(result.receipt.resourceId, "unrelated-1");
    const sent = h.sent.length;
    await h.call("session_prompt", args);
    assert.equal(h.sent.length, sent);
    h.db.updateSessionStatus("unrelated-0", "completed", Date.now());
    const restart = await h.call("session_restart", {commandId: "real-restart", sessionId: "unrelated-0"});
    assert.equal(restart.receipt.status, "succeeded", JSON.stringify(restart));
    assert.ok(h.sent.length > sent);
  } finally {h.close();}
});

test("unsupported runner reports concrete operation, protocol requirement and upgrade recovery", async () => {
  const h = harness();
  try {
    const runner = h.db.getRunner("ssh-fixture")!;
    h.db.registerRunner({...runner, workspaces: [{id: "repo", name: "Repo", path: "/fixture/repo"}]}, Date.now(), 1);
    const result = await h.call("session_launch", {commandId: "unsupported", locationId: h.locations[1]!.id, agentId: "agent", providerAccountId: "fixture-account"});
    assert.equal(result.receipt.status, "failed", JSON.stringify(result));
    assert.match(result.error, /account|protocol|upgrad/i);
    assert.ok(result.capabilityRequirement, JSON.stringify(result));
  } finally {h.close();}
});

test("trusted work origins reserve atomically and launch reaches server-only NewSessionInput with resolved project", async () => {
  let expectedDigest = "", reservations = 0, associations = 0;
  const h = harness({authenticatedOrigin(receipt) {
    return receipt.argumentsDigest === expectedDigest ? {requesterId: "authenticated-fixture", workId: "work-fixture", bindingId: "binding-fixture"} : null;
  }});
  try {
    const store = {
      reserveOrigin(connectionId: string, input: {commandId: string; requesterId: string; projectId?: string}) {
        assert.equal(h.db.raw().isTransaction, true);
        assert.equal(connectionId, h.issued.connection.id);
        assert.equal(input.requesterId, "authenticated-fixture");
        assert.equal(input.projectId, h.locations[1]!.projectId);
        reservations++;
      },
      attachAcceptedOrigin() {associations++;},
    };
    Object.assign(h.db, {assistantWork: store});
    const args = {commandId: "origin-launch", locationId: h.locations[1]!.id, agentId: "agent", useWorktree: false, workOriginId: "work-fixture"};
    expectedDigest = assistantRequestDigest(args);
    const create = h.db.createSession.bind(h.db);
    let launchInput: unknown;
    h.db.createSession = input => {launchInput = input; return create(input);};
    const result = await h.call("session_launch", args);
    assert.equal(result.receipt.status, "succeeded", JSON.stringify(result));
    assert.deepEqual((launchInput as {assistantWorkOrigin: unknown}).assistantWorkOrigin,
      {connectionId: h.issued.connection.id, commandId: args.commandId});
    assert.equal((launchInput as {projectId: string}).projectId, h.locations[1]!.projectId);
    assert.equal(reservations, 1);
    assert.equal(associations, 0, "launch attachment belongs inside #4467's db.createSession transaction");
    await h.call("session_launch", args);
    assert.equal(reservations, 1);
    await assert.rejects(h.call("session_launch", {...args, commandId: "spoofed", requesterId: "model-claim"}), /authenticated requester envelope/);
    assert.equal(h.receipts.get(h.issued.connection.id, "spoofed"), null);
  } finally {h.close();}
});

test("authenticated origins fail closed without work extension and follow-ups attach before dispatch", async () => {
  const h = harness({authenticatedOrigin: () => ({requesterId: "authenticated-fixture", workId: "work-fixture", bindingId: "binding-fixture"})});
  try {
    const args = {commandId: "origin-prompt", sessionId: "unrelated-1", text: "Fixture follow-up"};
    await assert.rejects(h.call("session_prompt", args), /work tracking is unavailable/);
    assert.equal(h.receipts.get(h.issued.connection.id, args.commandId), null);
    const order: string[] = [];
    Object.assign(h.db, {assistantWork: {
      reserveOrigin() {assert.equal(h.db.raw().isTransaction, true); order.push("reserve");},
      attachAcceptedOrigin(origin: unknown, sessionId: string) {
        assert.equal(h.db.raw().isTransaction, true);
        assert.deepEqual(origin, {connectionId: h.issued.connection.id, commandId: args.commandId});
        assert.equal(sessionId, args.sessionId);
        order.push("attach");
      },
    }});
    h.svc.promptFromUser = (_owner, sessionId) => {order.push("dispatch"); return {ok: true, status: 200, data: h.db.getSession(sessionId)!};};
    await h.call("session_prompt", args);
    assert.deepEqual(order, ["reserve", "attach", "dispatch"]);
    await h.call("session_prompt", args);
    assert.deepEqual(order, ["reserve", "attach", "dispatch"]);
  } finally {h.close();}
});

test("owner-selected destructive confirmation previews without effects, rejects stale grants, and deduplicates confirmed retries", async () => {
  const h = harness();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "confirmed-archive", sessionId: "unrelated-0"};
    h.db.updateSessionStatus(args.sessionId, "completed", Date.now());
    const preview = await h.call("session_archive", args);
    assert.equal(preview.confirmationRequired, true);
    assert.equal(h.receipts.get(h.issued.connection.id, args.commandId), null);
    assert.equal(h.db.getSession(args.sessionId)?.archived, false);
    await assert.rejects(h.call("session_stop", {...args, confirmationId: preview.confirmationId}), /confirmation/);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
    assert.equal(h.db.assistantConnections.destructiveConfirmation(h.issued.connection.id), "confirm");
    await assert.rejects(h.call("session_archive", {...args, confirmationId: preview.confirmationId}), /confirmation/);
    assert.equal(h.receipts.get(h.issued.connection.id, args.commandId), null);
    const fresh = await h.call("session_archive", args);
    const result = await h.call("session_archive", {...args, confirmationId: fresh.confirmationId});
    assert.equal(result.receipt.status, "succeeded");
    assert.equal(h.db.getSession(args.sessionId)?.archived, true);
    assert.deepEqual((await h.call("session_archive", {...args, confirmationId: fresh.confirmationId})).receipt, result.receipt);
    assert.deepEqual((await h.call("session_archive", args)).receipt, result.receipt);
    const stop = await h.call("session_stop", {commandId: "confirmed-stop", sessionId: "unrelated-1"});
    assert.equal(stop.confirmationRequired, true);
  } finally {h.close();}
});
