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
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { createAssistantOwnerConfirmationService, createAssistantThreads } from "./assistant-threads.js";
import { registerAssistantThreadRoutes } from "./assistant-thread-routes.js";
import { createAssistantOperations } from "./assistant-routes.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { ownerConfirmationTitle } from "./assistant-owner-confirmations.js";
import type { HumanPrincipal } from "./identity.js";

const claude: AgentDefinition = { id: "claude", name: "Claude", driver: "claude-code", context: { kind: "native" }, command: "claude", args: [], env: {}, available: true,
  capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["default"] } };

/** The real thread service, operations, receipts and owner routes. The assistant calls its tools
 * with its thread credential exactly as `/assistant/mcp` would. */
async function harness() {
  const db = ControlPlaneDb.open(":memory:"), identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  db.registerRunner({ runnerId: "r", hostname: "fixture", os: "linux", version: "fixture",
    workspaces: [{ id: "w", name: "Home", path: "/fixture/home" }], agents: [claude] }, Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sendToRunner = () => true;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const threads = createAssistantThreads(db, hub, svc);
  const operations = createAssistantOperations(db);
  const receipts = registerAssistantSessionOperations(operations, db, svc);
  // Every archive the operation performs, so a test can count executions.
  const archived: string[] = [];
  const setArchived = svc.setArchived.bind(svc);
  let archiveFault: Error | null = null;
  svc.setArchived = (sessionId, value, ...rest) => {
    if (sessionId !== thread?.sessionId) archived.push(sessionId);
    if (archiveFault) throw archiveFault;
    return setArchived(sessionId, value, ...rest);
  };
  const told: Array<{ sessionId: string; text: string }> = [];
  const confirmations = createAssistantOwnerConfirmationService(db, {
    prompt: (sessionId: string, text: string) => { told.push({ sessionId, text }); return { ok: true, status: 202 }; },
  } as unknown as Pick<SessionsService, "prompt">, operations);
  let requester: HumanPrincipal = owner;
  const app = Fastify();
  registerAssistantThreadRoutes(app, { threads, confirmations, requestHuman: () => requester });
  await app.ready();
  const ownerCall = async (method: "GET" | "POST", url: string) => {
    const response = await app.inject({ method, url });
    return { status: response.statusCode, body: response.json() as any };
  };

  let thread: AssistantThread | undefined;
  thread = (await ownerCall("POST", "/api/assistant-threads")).body.thread as AssistantThread;
  // The thread's proxy binds a credential it minted; the assistant's calls carry it.
  const token = `wollipoga_${randomBytes(32).toString("base64url")}`;
  assert.equal(threads.registerCredential("r", thread.sessionId, hashToken(token)).accepted, true);
  const credential = db.assistantConnections.authenticate(token)!;
  const call = (name: string, args: Record<string, unknown>) => operations.call(credential, name, args) as Promise<any>;

  for (const id of ["target-1", "target-2"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "claude", title: `Prototype ${id}`, driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
    db.updateSessionStatus(id, "completed", Date.now());
  }
  const pending = () => db.assistantOwnerConfirmations.pendingForThread(thread!.id);
  return { db, owner, svc, threads, operations, receipts, confirmations, thread, call, ownerCall, archived, told, pending,
    connectionId: thread.connectionId!,
    setRequester: (principal: HumanPrincipal) => { requester = principal; },
    faultArchive: (error: Error | null) => { archiveFault = error; },
    close: async () => { await app.close(); db.close(); } };
}

const approveUrl = (thread: AssistantThread, confirmation: { id: string }) => `/api/assistant-threads/${thread.id}/confirmations/${confirmation.id}/approve`;
const denyUrl = (thread: AssistantThread, confirmation: { id: string }) => `/api/assistant-threads/${thread.id}/confirmations/${confirmation.id}/deny`;
/** Every string anywhere in a value: whatever an assistant received and could send back. */
const strings = (value: unknown): string[] => typeof value === "string" ? [value]
  : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

test("a thread's destructive command waits for its owner, and nothing the assistant can send completes it", async () => {
  const h = await harness();
  try {
    const args = { commandId: "archive-1", sessionId: "target-1" };
    const answer = await h.call("session_archive", args);
    assert.equal(answer.ownerConfirmationRequired, true);
    assert.equal(answer.confirmationRequired, undefined);
    assert.equal(answer.confirmationId, undefined);
    assert.match(answer.recovery, /owner was asked to approve/);
    assert.deepEqual(h.archived, []);
    assert.equal(h.receipts.get(h.connectionId, args.commandId), null);

    // The owner sees one bound request, in the thread, and the thread needs them.
    const [request] = h.pending();
    assert.ok(request);
    assert.equal(request.title, "Archive Session");
    assert.deepEqual(request.target, { kind: "session", id: "target-1", label: "Prototype target-1" });
    assert.deepEqual(request.arguments, [{ label: "sessionId", value: "target-1" }]);
    assert.ok(request.impact.some((line) => line.label === "Status" && line.value === "completed"));
    assert.ok(!strings(answer).includes(request.id), "the request id never reaches the assistant");
    const view = (await h.ownerCall("GET", `/api/assistant-threads/${h.thread.id}`)).body.thread as AssistantThread;
    assert.equal(view.status, "needs_you");
    assert.deepEqual(view.confirmations?.map((item) => item.id), [request.id]);

    // Asking again for the same command returns the same request.
    await h.call("session_archive", args);
    assert.equal(h.pending().length, 1);

    // Resubmitting any value it received, the owner-facing id, or the marker the approved run uses
    // is refused, runs nothing and spends nothing.
    for (const confirmationId of [...new Set([...strings(answer), request.id, "owner-approved", "anything"])]) {
      await assert.rejects(h.call("session_archive", { ...args, confirmationId }), /only after your owner approves/);
    }
    assert.deepEqual(h.archived, []);
    assert.equal(h.receipts.get(h.connectionId, args.commandId), null);
    assert.equal(h.pending()[0]?.status, "pending");

    // Nor can the thread switch confirmation off for itself, even as its owner.
    assert.throws(() => h.db.assistantConnections.configure(h.connectionId, { operations: "all", projects: "all", destructiveConfirmation: "none" }), /always asks its owner/);
  } finally { await h.close(); }
});

test("Approve Once runs the bound command exactly once, across repeated and concurrent approvals and resubmissions", async () => {
  const h = await harness();
  try {
    const args = { commandId: "archive-1", sessionId: "target-1" };
    await h.call("session_archive", args);
    const [request] = h.pending();
    const [first, second] = await Promise.all([h.ownerCall("POST", approveUrl(h.thread, request!)), h.ownerCall("POST", approveUrl(h.thread, request!))]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    for (const response of [first, second]) {
      assert.equal(response.body.confirmation.status, "executed");
      assert.equal(response.body.confirmation.outcome.receiptStatus, "succeeded");
      assert.equal(response.body.thread.status === "needs_you", false);
    }
    assert.deepEqual(h.archived, ["target-1"]);
    assert.equal(h.db.getSession("target-1")?.archived, true);
    assert.equal(h.receipts.get(h.connectionId, args.commandId)?.status, "succeeded");

    // A later retry of Approve, or the assistant sending the same command again, runs nothing.
    assert.equal((await h.ownerCall("POST", approveUrl(h.thread, request!))).body.confirmation.status, "executed");
    const resent = await h.call("session_archive", args);
    assert.equal(resent.receipt.status, "succeeded");
    await h.confirmations.resumeInterrupted();
    assert.deepEqual(h.archived, ["target-1"]);
    assert.deepEqual(h.pending(), []);

    // The assistant was told once, in its own conversation, and the request id was not in it.
    assert.equal(h.told.length, 1);
    assert.equal(h.told[0]!.sessionId, h.thread.sessionId);
    assert.match(h.told[0]!.text, /^\[Wollipog Owner Confirmation\] Your owner approved "Archive Session".*ran it once; its receipt reads succeeded/);
    assert.ok(!h.told[0]!.text.includes(request!.id));
    // The approved run is audited against the thread's own connection.
    assert.equal(h.db.assistantConnections.activity(h.connectionId)[0]?.outcome, "succeeded");
  } finally { await h.close(); }
});

test("an approval interrupted before its run finishes once after a restart, and one interrupted after it never reruns", async () => {
  const h = await harness();
  try {
    await h.call("session_archive", { commandId: "archive-1", sessionId: "target-1" });
    const [before] = h.pending();
    // The approval was recorded, then the process died before the command ran.
    assert.equal(h.db.assistantOwnerConfirmations.approve(before!.id, h.owner), true);
    await h.confirmations.resumeInterrupted();
    await h.confirmations.resumeInterrupted();
    assert.deepEqual(h.archived, ["target-1"]);
    assert.equal(h.db.assistantOwnerConfirmations.get(before!.id)?.status, "executed");

    // The command's effect is uncertain once its reservation committed: Approve never reruns it.
    await h.call("session_archive", { commandId: "archive-2", sessionId: "target-2" });
    const [after] = h.pending();
    h.faultArchive(new Error("socket reset with private detail"));
    const uncertain = (await h.ownerCall("POST", approveUrl(h.thread, after!))).body.confirmation as AssistantOwnerConfirmation;
    h.faultArchive(null);
    assert.equal(uncertain.status, "executed");
    assert.equal(uncertain.outcome?.receiptStatus, "uncertain");
    assert.equal((await h.ownerCall("POST", approveUrl(h.thread, after!))).body.confirmation.status, "executed");
    await h.confirmations.resumeInterrupted();
    assert.deepEqual(h.archived, ["target-1", "target-2"]);
    assert.ok(!JSON.stringify(uncertain).includes("private detail"));
  } finally { await h.close(); }
});

test("Deny and expiry refuse the command, tell the assistant, and a later Approve runs nothing", async () => {
  const h = await harness();
  try {
    await h.call("session_archive", { commandId: "archive-1", sessionId: "target-1" });
    const [denied] = h.pending();
    const answer = await h.ownerCall("POST", denyUrl(h.thread, denied!));
    assert.equal(answer.body.confirmation.status, "denied");
    assert.equal(answer.body.thread.status === "needs_you", false);
    assert.equal((await h.ownerCall("POST", approveUrl(h.thread, denied!))).body.confirmation.status, "denied");
    assert.match(h.told.at(-1)!.text, /Your owner denied "Archive Session".*Nothing ran/);

    await h.call("session_archive", { commandId: "archive-2", sessionId: "target-2" });
    const [expiring] = h.pending();
    assert.ok(expiring!.expiresAt - expiring!.createdAt === ASSISTANT_OWNER_CONFIRMATION_TTL_MS);
    h.db.raw().prepare("UPDATE assistant_owner_confirmations SET expires_at=? WHERE id=?").run(Date.now() - 1, expiring!.id);
    // An Approve that arrives after the deadline expires it instead of running it.
    assert.equal((await h.ownerCall("POST", approveUrl(h.thread, expiring!))).body.confirmation.status, "expired");
    h.confirmations.expireDue();
    assert.match(h.told.at(-1)!.text, /expired before your owner answered\. Nothing ran/);
    assert.equal(h.told.length, 2);

    // The timer path expires an unanswered request on its own.
    await h.call("session_archive", { commandId: "archive-3", sessionId: "target-2" });
    const [unanswered] = h.pending();
    h.db.raw().prepare("UPDATE assistant_owner_confirmations SET expires_at=? WHERE id=?").run(Date.now() - 1, unanswered!.id);
    h.confirmations.expireDue();
    assert.equal(h.db.assistantOwnerConfirmations.get(unanswered!.id)?.status, "expired");
    assert.equal(h.told.length, 3);
    assert.deepEqual(h.archived, []);
  } finally { await h.close(); }
});

test("a changed grant or target between request and approval refuses the approval", async () => {
  const h = await harness();
  try {
    await h.call("session_archive", { commandId: "archive-1", sessionId: "target-1" });
    const [grant] = h.pending();
    // The owner narrows the thread's grant: its revision changes, and with it the binding.
    h.db.assistantConnections.configure(h.connectionId, { operations: "all", projects: "all", destructiveConfirmation: "confirm" });
    const refused = (await h.ownerCall("POST", approveUrl(h.thread, grant!))).body.confirmation as AssistantOwnerConfirmation;
    assert.equal(refused.status, "refused");
    assert.match(refused.outcome?.reason ?? "", /target, arguments or the thread's grant changed/);
    assert.match(h.told.at(-1)!.text, /was refused, so nothing ran/);

    await h.call("session_archive", { commandId: "archive-2", sessionId: "target-2" });
    const [target] = h.pending();
    // The target moves into a Project after the request.
    const project = h.db.createProject({ name: "Work" });
    const location = h.db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w" });
    h.db.setSessionProject("target-2", project.id, location.id);
    assert.equal((await h.ownerCall("POST", approveUrl(h.thread, target!))).body.confirmation.status, "refused");
    assert.deepEqual(h.archived, []);
    assert.equal(h.receipts.get(h.connectionId, "archive-2"), null);
  } finally { await h.close(); }
});

test("only the thread's owner can answer, and ending the thread refuses what it asked", async () => {
  const h = await harness();
  try {
    await h.call("session_archive", { commandId: "archive-1", sessionId: "target-1" });
    const [request] = h.pending();
    h.setRequester({ ...h.owner, userId: "someone-else" });
    assert.equal((await h.ownerCall("POST", approveUrl(h.thread, request!))).status, 404);
    assert.equal((await h.ownerCall("POST", denyUrl(h.thread, request!))).status, 404);
    h.setRequester(h.owner);
    assert.equal((await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/confirmations/aoc_missing/approve`)).status, 404);

    assert.equal((await h.ownerCall("POST", `/api/assistant-threads/${h.thread.id}/archive`)).status, 200);
    assert.equal(h.db.assistantOwnerConfirmations.get(request!.id)?.status, "refused");
    assert.equal((await h.ownerCall("POST", approveUrl(h.thread, request!))).body.confirmation.status, "refused");
    assert.deepEqual(h.archived, []);
  } finally { await h.close(); }
});

test("an external Assistant connection keeps its preview-and-confirm behavior", async () => {
  const h = await harness();
  try {
    const issued = h.db.assistantConnections.create(h.owner, "Outside Assistant", { operations: "all", projects: "all", destructiveConfirmation: "confirm" });
    const credential = h.db.assistantConnections.authenticate(issued.token)!;
    const call = (args: Record<string, unknown>) => h.operations.call(credential, "session_archive", args) as Promise<any>;
    const args = { commandId: "external-archive", sessionId: "target-1" };
    const preview = await call(args);
    assert.equal(preview.confirmationRequired, true);
    assert.equal(typeof preview.confirmationId, "string");
    assert.match(preview.recovery, /repeat the same command ID and arguments with confirmationId/);
    assert.deepEqual(h.pending(), []);
    assert.equal((await call({ ...args, confirmationId: preview.confirmationId })).receipt.status, "succeeded");
    assert.deepEqual(h.archived, ["target-1"]);
  } finally { await h.close(); }
});

test("the owner sees every argument the approved run uses, whole and by its exact name", async () => {
  const h = await harness();
  try {
    // Arguments the operation's schema would refuse still never reach the owner shortened: the
    // request records exactly what runs, and refuses what it could not show.
    const binding = { connectionId: h.connectionId, grantRevision: 1, operation: "session_stop", argumentsDigest: "d", targetDigest: "t" };
    const long = "x".repeat(4_000);
    const args = { commandId: "c", sessionId: "target-1", session_id: "decoy", note: long, nested: { a: [1, 2] } };
    const shown = h.db.assistantOwnerConfirmations.request(binding, { commandId: "c", args, target: { kind: "session", id: "target-1" } }, "Prototype");
    assert.deepEqual(shown.arguments, [
      { label: "sessionId", value: "target-1" },
      { label: "session_id", value: "decoy" },
      { label: "note", value: long },
      { label: "nested", value: "{\"a\":[1,2]}" },
    ]);
    assert.throws(() => h.db.assistantOwnerConfirmations.request({ ...binding, argumentsDigest: "big" },
      { commandId: "c2", args: { note: "y".repeat(17 * 1024) }, target: { kind: "session", id: "target-1" } }, "Prototype"), /too large to show/);
  } finally { await h.close(); }
});

test("operation titles read as Title Case actions", () => {
  assert.equal(ownerConfirmationTitle("session_archive"), "Archive Session");
  assert.equal(ownerConfirmationTitle("session_stop"), "Stop Session");
  assert.equal(ownerConfirmationTitle("auto_delete"), "Delete Automation");
  assert.equal(ownerConfirmationTitle("queue_cancel"), "Cancel Queued Prompt");
  assert.equal(ownerConfirmationTitle("session_git"), "Discard File Changes");
});
