import assert from "node:assert/strict";
import {test} from "node:test";
import Fastify from "fastify";
import {MAX_PROMPT_IMAGE_BYTES, PROTOCOL_VERSION} from "@wollipog/protocol";
import {ControlPlaneDb} from "./db.js";
import {Hub} from "./hub.js";
import {SessionsService} from "./sessions.js";
import {createAssistantOperations, registerAssistantRoutes} from "./assistant-routes.js";
import {registerAssistantSessionOperations} from "./assistant-session-operations.js";
import {ASSISTANT_RESIDUAL_MANAGEMENT, registerAssistantCampaignManagement} from "./assistant-campaign-management.js";
import {createSessionGitManagement} from "./session-git-management.js";
import {AssistantPromptImages} from "./assistant-prompt-images.js";
import {registerPromptImageRoutes} from "./prompt-image-route.js";
import {registerCampaignStatusRoutes} from "./campaign-status-routes.js";
import {registerCampaignIssueScopeRoutes} from "./campaign-issue-scope-routes.js";
import {createCampaignReviewManagement} from "./campaign-review-management.js";
import {sessionHoldReaderFor} from "./session-command-permissions.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
async function fixture() {
  const db = ControlPlaneDb.open(":memory:"), local = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
  db.registerRunner({runnerId: "runner", hostname: "fixture", os: "linux", version: "fixture", agents: [],
    workspaces: [{id: "repo", name: "Fixture", path: "/fixture"}]}, 1, PROTOCOL_VERSION);
  const project = db.createProject({name: "Granted"}), other = db.createProject({name: "Excluded"});
  const location = db.addProjectLocation(project.id, {runnerId: "runner", workspaceId: "repo"});
  const excluded = db.addProjectLocation(other.id, {runnerId: "runner", workspaceId: "repo"});
  for (const id of ["target", "source"]) {
    db.createSession({id, runnerId: "runner", workspaceId: "repo", agentId: "fixture", driver: "acp", useWorktree: true, title: id, config: {}, now: 1});
    db.setSessionProject(id, project.id, location.id);
    db.updateSessionStatus(id, "idle", 2);
    db.raw().prepare("UPDATE sessions SET worktree_path=? WHERE id=?").run("/fixture/managed-"+id, id);
  }
  const hub = new Hub(db), dispatched: any[] = [];
  hub.isRunnerOnline = () => true;
  hub.requestFromRunner = async (_id, requestId, message) => {
    dispatched.push(message);
    return {type: "git_result", requestId, ok: true, data: {status: {}, diff: {}, fixture: true}} as any;
  };
  const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}}), app = Fastify();
  const operations = createAssistantOperations(db), receipts = registerAssistantSessionOperations(operations, db, svc);
  const git = createSessionGitManagement({db, svc, hub, runnerCapabilityError: () => null, outboundEvents: {recordChecksFromSummary() {return true;}}});
  git.registerHttp(app, () => owner);
  registerPromptImageRoutes(app, {db, service: svc, requestPrincipal: () => owner, actor: () => ({kind: "human", id: owner.userId})});
  const images = new AssistantPromptImages(db, svc);
  const status = registerCampaignStatusRoutes(app, {db, requestPrincipal: () => owner});
  const scope = registerCampaignIssueScopeRoutes(app, {db, svc, requestPrincipal: () => owner});
  const review = createCampaignReviewManagement({db, svc, behaviorView: () => ({ok: false, status: 404}),
    holdReader: principal => target => sessionHoldReaderFor(db, principal, target)});
  registerAssistantCampaignManagement(operations, {db, svc, receipts, images, services: [status, scope, review, git, images.management]});
  images.registerHttp(app, operations);
  registerAssistantRoutes(app, {db, operations, requestHuman: () => owner});
  const issued = db.assistantConnections.create(owner, "Synthetic", {operations: "all", projects: "all"});
  const credential = db.assistantConnections.authenticate(issued.token)!;
  const call = (name: string, args: Record<string, unknown> = {}) => operations.call(credential, name, {sessionId: "target", ...args}) as Promise<any>;
  const mcp = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${issued.token}`},
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: {sessionId: "target", ...args}}}});
    const result = response.json().result;
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const upload = (id: string, bytes = png, headers: Record<string, string> = {}) => app.inject({method: "POST",
    url: `/assistant/sessions/target/prompt-images/${id}`, payload: bytes,
    headers: {authorization: `Bearer ${issued.token}`, "content-type": "image/png", ...headers}});
  return {db, owner, hub, svc, app, project, other, location, excluded, issued, operations, receipts, dispatched, call, mcp, upload,
    close: async () => {await app.close(); db.close();}};
}

test("residual owner HTTP and MCP share bounded governance audit and all eleven Git parser actions", async () => {
  const h = await fixture();
  try {
    for (const query of ["", "?limit=1", "?limit=501"]) {
      const http = await h.app.inject({url: "/api/sessions/target/governance-audit"+query});
      const result = await h.mcp("governance_audit", query ? {query: {limit: query.slice(7)}} : {});
      assert.equal(result.status, http.statusCode); assert.deepEqual(result.body, http.json());
    }
    const payloads = [
      {action: "status"}, {action: "summary"}, {action: "diff", scope: "uncommitted"},
      {action: "request_diff", requestUrl: "https://github.com/fixture/repo/pull/1"},
      {action: "commit", message: "Fixture"}, {action: "open_pr", title: "Fixture"},
      {action: "stage_hunk", direction: "stage", filePath: "file.ts", hunkIndex: 0, diffHash: "a".repeat(64)},
      {action: "stage_lines", direction: "unstage", filePath: "file.ts", hunkIndex: 0, lineIndices: [0], diffHash: "a".repeat(64)},
      {action: "discard_file", filePath: "file.ts", diffHash: "a".repeat(64)},
      {action: "github_review_sync"}, {action: "forge_review_sync"},
    ];
    for (const payload of payloads) {
      const http = await h.app.inject({method: "POST", url: "/api/sessions/target/git", payload});
      const result = await h.mcp("session_git", {payload, commandId: payload.action});
      assert.equal(result.status, http.statusCode, payload.action); assert.deepEqual(result.body, http.json(), payload.action);
      if (!["status", "summary", "diff", "request_diff"].includes(payload.action)) assert.ok(result.receipt);
    }
    await assert.rejects(h.call("session_git", {payload: {action: "pod_reconcile"}}), /unknown git action/);
    assert.equal(h.dispatched.length, 22);
    assert.ok(h.dispatched.every(message => message.worktreePath === "/fixture/managed-target"));
    assert.ok(h.operations.inventory().every(tool => tool.name.length <= 32));
  } finally {await h.close();}
});

test("all residual tools intersect current owner, operation and Project access before effects or receipts", async () => {
  const h = await fixture();
  try {
    for (const grant of [{operations: ["command_get"], projects: "all" as const}, {operations: "all" as const, projects: [h.other.id]}]) {
      h.db.assistantConnections.configure(h.issued.connection.id, grant);
      for (const [tool] of ASSISTANT_RESIDUAL_MANAGEMENT) await assert.rejects(h.call(tool, {commandId: "denied"}), /excluded/);
      assert.equal((await h.upload("denied", Buffer.alloc(MAX_PROMPT_IMAGE_BYTES+1))).statusCode, 403, "authorize before image parser");
      assert.equal(h.receipts.get(h.issued.connection.id, "denied"), null);
    }
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
    h.db.canAccessSession = () => false;
    for (const [tool] of ASSISTANT_RESIDUAL_MANAGEMENT) await assert.rejects(h.call(tool), /access|owner/i);
    assert.equal(h.dispatched.length, 0);
  } finally {await h.close();}
});

test("Git mutations reconcile receipts, stale failures and timeouts, and discard binds confirmation to the diff", async () => {
  const h = await fixture();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "discard", payload: {action: "discard_file", filePath: "file.ts", diffHash: "a".repeat(64)}};
    const preview = await h.call("session_git", args);
    assert.ok(preview.confirmationRequired); assert.equal(h.dispatched.length, 0);
    await assert.rejects(h.call("session_git", {...args, payload: {...args.payload, diffHash: "b".repeat(64)}, confirmationId: preview.confirmationId}), /confirmation/);
    const applied = await h.call("session_git", {...args, confirmationId: preview.confirmationId});
    assert.equal(applied.receipt.status, "succeeded");
    assert.equal((await h.call("session_git", args)).receipt.status, "succeeded"); assert.equal(h.dispatched.length, 1);
    h.hub.requestFromRunner = async (_id, requestId) => ({type: "git_result", requestId, ok: false, code: "GIT_STALE", error: "stale"});
    const stale = await h.call("session_git", {commandId: "stage", payload: {action: "stage_hunk", filePath: "file.ts", hunkIndex: 0, direction: "stage", diffHash: "a".repeat(64)}});
    assert.equal(stale.status, 409); assert.equal(stale.receipt.status, "failed");
    h.hub.requestFromRunner = async () => {throw Error("timeout");};
    const timeout = await h.call("session_git", {commandId: "commit", payload: {action: "commit", message: "Fixture"}});
    assert.equal(timeout.status, 504); assert.equal(timeout.receipt.status, "uncertain");
    h.db.updateSessionStatus("target", "running", 3);
    const busy = await h.call("session_git", {commandId: "busy", payload: {action: "commit", message: "Fixture"}});
    assert.equal(busy.status, 409); assert.equal(busy.receipt.status, "failed");
  } finally {await h.close();}
});

test("Git withholds post-dispatch results after revocation without replaying a possible effect", async () => {
  const h = await fixture();
  try {
    h.hub.requestFromRunner = async (_id, requestId) => {
      h.db.assistantConnections.revoke(h.issued.connection.id);
      return {type: "git_result", requestId, ok: true, data: {private: "withhold"}} as any;
    };
    const result = await h.call("session_git", {commandId: "race", payload: {action: "commit", message: "Fixture"}});
    assert.equal(result.receipt.status, "uncertain"); assert.equal(result.body, undefined);
    await assert.rejects(h.call("session_git", {commandId: "race", payload: {action: "commit", message: "Fixture"}}), /revoked/);
  } finally {await h.close();}
});

test("binary uploads and opaque MCP references share image validation/storage and content-bound receipts", async () => {
  const h = await fixture();
  try {
    const owner = await h.app.inject({method: "POST", url: "/api/sessions/target/prompt-images", headers: {"content-type": "image/png"}, payload: png});
    assert.equal(owner.statusCode, 201);
    const binary = await h.upload("upload"); assert.equal(binary.statusCode, 200);
    assert.equal(binary.json().receipt.status, "succeeded"); assert.deepEqual(binary.json().body, owner.json());
    assert.equal(binary.headers["cache-control"], "private, no-store");
    const repeated = await h.upload("upload"); assert.equal(repeated.json().receipt.resourceId, owner.json().artifactId);
    assert.equal((await h.upload("upload", Buffer.concat([png, Buffer.from([4])]))).statusCode, 403);
    const source = h.svc.createPromptImageArtifact("source", "image/png", png); assert.ok(source.ok);
    const reused = await h.mcp("prompt_image_add", {commandId: "copy", sourceArtifactId: source.data!.artifactId});
    assert.equal(reused.receipt.status, "succeeded"); assert.deepEqual(reused.body, owner.json());
    const malformed = await h.upload("bad", Buffer.from("not a png"));
    assert.equal(malformed.json().status, 400); assert.equal(malformed.json().receipt.status, "failed");
    assert.equal(JSON.stringify(h.receipts.get(h.issued.connection.id, "upload")).includes("iVBOR"), false);
    await assert.rejects(h.call("prompt_image_add", {commandId: "path", path: "/private/file.png"}), /Unknown/);
    await assert.rejects(h.call("prompt_image_add", {commandId: "bytes", data: "iVBOR"}), /Unknown/);
    assert.equal((await h.upload("origin", png, {origin: "https://other.invalid"})).statusCode, 403);
    assert.equal(h.receipts.get(h.issued.connection.id, "origin"), null);
  } finally {await h.close();}
});

test("opaque image sources require their own current ownership and Project grant", async () => {
  const h = await fixture();
  try {
    const source = h.svc.createPromptImageArtifact("source", "image/png", png); assert.ok(source.ok);
    h.db.setSessionProject("source", h.other.id, h.excluded.id);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
    await assert.rejects(h.call("prompt_image_add", {commandId: "excluded", sourceArtifactId: source.data!.artifactId}), /excluded/);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
    const canAccess = h.db.canAccessSession.bind(h.db);
    h.db.canAccessSession = (principal, id) => id !== "source" && canAccess(principal, id);
    await assert.rejects(h.call("prompt_image_add", {commandId: "owner-denied", sourceArtifactId: source.data!.artifactId}), /access|owner/i);
    assert.equal(h.receipts.get(h.issued.connection.id, "excluded"), null);
    assert.equal(h.receipts.get(h.issued.connection.id, "owner-denied"), null);
  } finally {await h.close();}
});
