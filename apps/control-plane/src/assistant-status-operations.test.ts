import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { OwnerManagement } from "./owner-management.js";
import type { AuthPrincipal } from "./identity.js";
import { createAssistantOperations } from "./assistant-routes.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { registerAssistantStatusOperations } from "./assistant-status-operations.js";

function faultFixture() {
  const db = ControlPlaneDb.open(":memory:"), local = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
  db.registerRunner({runnerId: "r", hostname: "fixture", os: "linux", version: "test", agents: [], workspaces: []}, Date.now());
  const project = db.createProject({name: "Fixture"});
  db.createSession({id: "s", runnerId: "r", workspaceId: null, agentId: null, title: "Fixture", driver: "codex-app-server", useWorktree: false, config: {}, now: Date.now()});
  db.setSessionProject("s", project.id, null);
  const hub = new Hub(db), svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
  const operations = createAssistantOperations(db), receipts = registerAssistantSessionOperations(operations, db, svc);
  const status = new OwnerManagement<AuthPrincipal>();
  registerAssistantStatusOperations(operations, {db, hub, svc, receipts, status, campaign: new OwnerManagement<AuthPrincipal>(), scope: new OwnerManagement<AuthPrincipal>()});
  const issued = db.assistantConnections.create(owner, "Fixture", {operations: "all", projects: "all"});
  const credential = db.assistantConnections.authenticate(issued.token)!;
  const call = (name: string, args: unknown) => operations.call(credential, name, args) as Promise<any>;
  return {db, status, receipts, issued, call};
}

test("production owner and Assistant status paths preserve receipts, revisions, confirmations and current grants", {timeout: 30_000}, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url)), "--verify-status"],
    {encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024});
  assert.equal(child.status, 0, "Status acceptance failed in an isolated control plane; raw fixture logs withheld.");
  const line = child.stdout.split("\n").find(line => line.startsWith("STATUS_ACCEPTANCE "));
  assert.ok(line, "The production status acceptance assertions did not finish.");
  assert.equal(JSON.parse(line.slice("STATUS_ACCEPTANCE ".length)).realRunner, false);
});

test("an asynchronous status read cannot return private content after its project grant narrows", async () => {
  const h = faultFixture();
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => {enter = resolve;});
  const finished = new Promise<void>(resolve => {finish = resolve;});
  h.status.define("GET", "/api/sessions/:id/events", async () => {enter(); await finished; return {privateFixtureText: "must be withheld"};});
  try {
    const pending = h.call("session_events", {sessionId: "s"});
    await entered;
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: []});
    finish();
    await assert.rejects(pending, /excluded/);
  } finally {finish(); h.db.close();}
});

test("a lost acknowledgement response is uncertain, never redispatched, and still checks current authority", async () => {
  const h = faultFixture();
  let attempts = 0;
  h.status.define("POST", "/api/sessions/:id/result/acknowledge", () => {attempts++; throw new Error("private fixture failure");});
  try {
    const args = {sessionId: "s", commandId: "once", payload: {revision: "fixture:1"}};
    const first = await h.call("result_ack", args);
    assert.equal(first.receipt.status, "uncertain");
    assert.ok(!JSON.stringify(first).includes("private fixture failure"));
    assert.equal((await h.call("result_ack", args)).receipt.status, "uncertain");
    assert.equal(attempts, 1);
    await assert.rejects(h.call("result_ack", {...args, payload: {revision: "fixture:2"}}), /different|digest|arguments/i);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: ["command_get"], projects: "all"});
    await assert.rejects(h.call("result_ack", args), /excluded/);
    await assert.rejects(h.call("command_get", {commandId: "once"}), /excluded/);
    assert.equal(attempts, 1);
  } finally {h.db.close();}
});
