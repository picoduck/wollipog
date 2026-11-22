import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import {
  ASSISTANT_DECISION_CATEGORIES,
  ASSISTANT_THREAD_CREDENTIAL_TTL_MS,
  ASSISTANT_EVIDENCE_INSPECT,
  ASSISTANT_EVIDENCE_PREPARE,
  ASSISTANT_EVIDENCE_GET,
  ASSISTANT_EVIDENCE_RELAY_ACK,
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  DEFAULT_ASSISTANT_THREAD_LIMITS,
  HUMAN_ONLY_PARENT_CONTROL_POLICY,
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  ciRerunResourceKey,
  releaseDecisionPayloadBytes,
  releaseDecisionResourceKey,
  type ReleaseDecisionSnapshot,
  type AgentDefinition,
  type AssistantDecisionGrant,
  type AssistantThread,
  type CampaignBudgetAuthority,
  type ControlPlaneToRunner,
} from "@wollipog/protocol";
import { AssistantProxies } from "../../runner/src/assistant-proxy.js";
import { runAssistantMcp } from "../../runner/src/assistant-mcp.js";
import { ControlPlaneDb, type NewSessionInput } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { createAssistantThreads } from "./assistant-threads.js";
import { registerAssistantThreadRoutes } from "./assistant-thread-routes.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { assistantCallContext } from "./assistant-connections.js";
import { registerAssistantDecisionOperations, registerAssistantDecisionHistory } from "./assistant-decision-operations.js";
import { fakeScreenRuntime } from "./credential-screen-test-fixture.js";
import type { HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

const claude: AgentDefinition = { id: "claude", name: "Claude", driver: "claude-code", context: { kind: "native" }, command: "claude", args: [], env: {}, available: true,
  capabilities: { models: [{ id: "claude-opus-5-5", displayName: "Opus", default: true },
    { id: "claude-sonnet-4-6", displayName: "Sonnet" }], effortLevels: [], slashCommands: [],
    supportsImages: true, imageToolResults: true, supportsApprovals: true, permissionModes: ["default"] } };

/** The real thread service, `/assistant/mcp` route and runner proxy, joined by an in-memory socket. */
async function harness(protocolVersion = PROTOCOL_VERSION) {
  const db = ControlPlaneDb.open(":memory:"), identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  db.registerRunner({ runnerId: "r", hostname: "fixture", os: "linux", version: "fixture",
    workspaces: [{ id: "w", name: "Home", path: "/fixture/home" }], agents: [claude],
    runtime: { dataDir: "/fixture", worktreeRoot: "/fixture/worktrees", maxConcurrentSessions: 4, campaignLaunchInspection: { version: 3 } },
  }, Date.now(), protocolVersion);
  const hub = new Hub(db), toRunner: ControlPlaneToRunner[] = [];
  hub.isRunnerOnline = () => true;
  hub.sendToRunner = (_id, message) => { toRunner.push(message); return true; };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const threads = createAssistantThreads(db, hub, svc);
  const app = Fastify();
  const operations = createAssistantOperations(db);
  registerAssistantSessionOperations(operations, db, svc);
  registerAssistantDecisionOperations(operations, db, svc);
  // Operations a thread may not call; registered here only to reach the gate.
  for (const name of ["auto_create", "session_role", "session_adopt", "session_fork"]) {
    operations.register({ name, description: "fixture", inputSchema: { type: "object" }, metadata: true,
      resolveTarget: () => ({ kind: "fixture", id: name }), ownerCanAccess: () => true, execute: () => ({ done: true }) });
  }
  const project = db.createProject({ name: "Work" });
  const location = db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w" });
  const requestHuman = (req: import("fastify").FastifyRequest) => req.headers.authorization === "Bearer owner" ? owner : null;
  registerAssistantRoutes(app, { db, operations, requestHuman });
  registerAssistantThreadRoutes(app, { threads, requestHuman });
  registerAssistantDecisionHistory(app, db, requestHuman);
  await app.ready();
  const ownerCall = async (method: "GET" | "POST" | "PUT", url: string, payload?: object) => {
    const response = await app.inject({ method, url, headers: { authorization: "Bearer owner" }, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, body: response.json() as any };
  };
  // The runner's proxy, talking to the real route.
  const proxyFetch = (async (url: URL, init?: RequestInit) => {
    const response = await app.inject({ method: "POST", url: url.pathname, headers: init?.headers as Record<string, string>, payload: String(init?.body) });
    return new Response(response.statusCode === 202 ? null : response.body, { status: response.statusCode });
  }) as unknown as typeof globalThis.fetch;
  let runnerId = "r";
  const proxies: AssistantProxies = new AssistantProxies({
    fetch: proxyFetch,
    ackTimeoutMs: 1_000,
    register: (sessionId, tokenHash) => queueMicrotask(() => {
      const answer = threads.registerCredential(runnerId, sessionId, tokenHash);
      proxies.acknowledge(sessionId, tokenHash, answer.accepted, answer.expiresAt, answer.error);
    }),
  });
  const callTools = async (env: Record<string, string>, ...messages: object[]) => {
    const input = new PassThrough(), output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => { written += String(chunk); });
    const done = runAssistantMcp(env, input, output);
    for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
    input.end();
    await done;
    return written.split("\n").filter(Boolean).map((line) => JSON.parse(line)).sort((a, b) => a.id - b.id);
  };
  const provision = async (sessionId: string) => {
    const relay = await proxies.provision(sessionId, "http://control-plane.invalid");
    return { WOLLIPOG_ASSISTANT_RELAY_ENDPOINT: relay.endpoint, WOLLIPOG_ASSISTANT_RELAY_KEY: relay.relayKey };
  };
  return { app, db, hub, owner, svc, threads, toRunner, ownerCall, proxies, provision, callTools, project, location, operations, setRunner: (id: string) => { runnerId = id; },
    close: async () => { await proxies.closeAll(); await app.close(); db.close(); } };
}

const discover = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "assistant_discover", arguments: {} } };

function decisionSession(h: Awaited<ReturnType<typeof harness>>, id: string, parentSessionId?: string,
  budget?: CampaignBudgetAuthority) {
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [1], revision: 1, authorizedByUserId: h.owner.userId, authorizedAt: 1 };
  policy.issueNumbers = [1];
  const session: NewSessionInput = { id, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: false,
    driver: "claude-code", now: 1, config: {}, projectId: h.project.id, projectLocationId: h.location.id,
    ...(parentSessionId ? { parentSessionId } : { role: "orchestrator",
      orchestratorPolicy: policy,
      parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } },
    }),
  };
  if (budget) {
    h.db.createHumanCampaignLaunch({ ...session, creationActor: "human",
      scope: { organizationId: h.owner.organizationId, owner: { kind: "user", userId: h.owner.userId } },
    }, h.owner, "custom-budget", "a".repeat(64), budget);
  } else h.db.createSession(session);
  h.db.updateSessionStatus(id, "running", 2);
}

function decisionPrompts(h: Awaited<ReturnType<typeof harness>>, sessionId: string): string[] {
  const durable = h.db.raw().prepare("SELECT payload_json FROM session_prompt_commands WHERE session_id=?").all(sessionId) as Array<{ payload_json: string }>;
  return [...durable.map((row) => (JSON.parse(row.payload_json) as { text: string }).text),
    ...h.toRunner.flatMap((message) => message.type === "prompt_session" && message.sessionId === sessionId ? [message.text] : [])];
}

test("the owner grants and revokes exact typed resolution, and Assistant calls never grant themselves access", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", { title: "Release Assistant" })).body.thread as AssistantThread;
    assert.deepEqual(thread.decisionDelegation, { revision: 0, grant: null });
    const path = `/api/assistant-threads/${thread.id}/delegation`;
    const env = await h.provision(thread.sessionId);
    decisionSession(h, "root");
    decisionSession(h, "child", "root");
    const snapshot = { category: "merged_branch_deletion" as const, repository: "picoduck/wollipog", branch: "agent/test",
      merged: true as const, mergeCommitSha: "a".repeat(40), dependentPullRequests: { checkedAt: 20, open: [] } };
    const asked = h.svc.createWorkflowDecision("child", { requestId: "request", resourceKey: "branch", resourceSnapshot: snapshot });
    assert.ok(asked.ok && asked.data, asked.error ?? "request created");
    const { occurrenceId, resourceDigest } = asked.data;
    const call = async (name: string, args: object) => {
      const [response] = await h.callTools(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return response.result;
    };
    const resolution = { sessionId: "child", occurrenceId, resourceDigest, outcome: "approve", reason: "The branch has merged." };
    const refuse = async (pattern: RegExp, args = resolution) => {
      const result = await call("assistant_decision_resolve", args);
      assert.equal(result.isError, true, result.content[0].text);
      assert.match(result.content[0].text, pattern);
      assert.equal(h.db.workflowDecisionByOccurrence(occurrenceId)?.status, "pending");
    };
    await refuse(/no decision delegation grant/u);
    const grant: AssistantDecisionGrant = { categories: ["merged_branch_deletion", "ui_evidence_approval"],
      projects: [h.project.id], campaigns: ["root"], expiresAt: null };
    const deniedOwnerRoute = await h.app.inject({ method: "PUT", url: path, payload: { revision: 0, grant } });
    assert.equal(deniedOwnerRoute.statusCode, 403);
    for (const category of ["policy_ask", "tool_approval", "authentication", "persistent_permissions", "owner_decision", "campaign_issue_scope",
      "automation_creation", "location_switch", "campaign_repository_addition", "all"]) {
      const invalid = await h.ownerCall("PUT", path, { revision: 0, grant: { ...grant, categories: [category] } });
      assert.equal(invalid.status, 400, category);
      assert.match(invalid.body.error, /no typed Assistant resolution path/u);
    }
    const setGrant = async (revision: number, next: AssistantDecisionGrant | null) => {
      const saved = await h.ownerCall("PUT", path, { revision, grant: next });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.thread.decisionDelegation.revision, revision + 1);
      assert.deepEqual(saved.body.thread.decisionDelegation.grant, next);
    };
    // A Delegate All grant saved against a previous catalog has no wildcard authority.
    // Simulate a newly supported merged-branch deletion and an unaccepted evidence disclosure.
    const previousCategories = (Object.keys(ASSISTANT_DECISION_CATEGORIES) as AssistantDecisionGrant["categories"])
      .filter((category) => category !== "merged_branch_deletion" && category !== "ui_evidence_review");
    await setGrant(0, { ...grant, selectionMode: "all", categories: previousCategories });
    await refuse(/outside the thread's decision delegation grant/u);
    await setGrant(1, { ...grant, campaigns: ["different-root"] });
    await refuse(/campaign is outside/u);
    await setGrant(2, { ...grant, projects: ["different-project"] });
    await refuse(/project is outside/u);
    assert.equal((await h.ownerCall("PUT", path, { revision: 3, grant: { ...grant, expiresAt: 1 } })).status, 400);
    await setGrant(3, grant);
    h.db.raw().prepare("UPDATE assistant_threads SET decision_grant=json_set(decision_grant,'$.expiresAt',1) WHERE id=?").run(thread.id);
    await refuse(/grant has expired/u);
    await setGrant(4, grant);
    await refuse(/snapshot changed/u, { ...resolution, resourceDigest: "b".repeat(64) });
    assert.equal((await h.ownerCall("PUT", path, { revision: 4, grant: null })).status, 409, "stale settings cannot overwrite the current grant");
    const listed = await call("assistant_decisions_list", { sessionId: "child" });
    assert.deepEqual(JSON.parse(listed.content[0].text).decisions.map((item: { occurrenceId: string }) => item.occurrenceId), [occurrenceId]);
    const read = await call("assistant_decision_get", { sessionId: "child", occurrenceId });
    assert.equal(JSON.parse(read.content[0].text).decision.resourceDigest, resourceDigest);
    h.svc.onSessionStatus("child", "idle");
    const approved = await call("assistant_decision_resolve", resolution);
    assert.equal(approved.isError, undefined, approved.content[0].text);
    const recorded = h.db.workflowDecisionByOccurrence(occurrenceId)!;
    assert.equal(recorded.status, "approved");
    assert.equal(recorded.assistantDelegation?.threadId, thread.id);
    assert.equal(recorded.assistantDelegation?.threadTitle, "Release Assistant");
    assert.equal(recorded.assistantDelegation?.reason, resolution.reason);
    assert.equal(recorded.assistantDelegation?.grantRevision, 5);
    assert.ok(decisionPrompts(h, "child").some((prompt) => prompt.includes(`Assistant thread "Release Assistant" ("${thread.id}") under your owner's delegation`)));
    const delegatedPrompt = h.db.raw().prepare(
      "SELECT payload_json FROM session_prompt_commands WHERE session_id=? AND json_extract(payload_json, '$.promptOrigin.kind')='delegation_notice'",
    ).get("child") as { payload_json: string } | undefined;
    assert.ok(delegatedPrompt, "delegation provenance persists with the durable prompt");
    const audit = h.db.listGovernanceAudit("child").find((entry) => entry.requestId === occurrenceId && entry.outcome === "allowed");
    assert.equal(audit?.actor.kind, "agent");
    assert.equal(audit?.workflowDecision?.assistantDelegation?.threadId, thread.id);
    assert.ok(audit?.workflowDecision?.rationaleDigest);
    const repeated = await call("assistant_decision_resolve", resolution);
    assert.match(repeated.content[0].text, /stale or already resolved/u);
    await setGrant(5, null);
    const revoked = await call("assistant_decision_resolve", resolution);
    assert.match(revoked.content[0].text, /no decision delegation grant/u);
    const badConsume = await h.svc.consumeWorkflowDecision("child", occurrenceId, {
      resourceSnapshot: { ...snapshot, mergeCommitSha: "b".repeat(40) },
    });
    assert.equal(badConsume.status, 409);
    assert.equal(h.db.workflowDecisionByOccurrence(occurrenceId)?.status, "revoked");
    const history = await h.ownerCall("GET", `/api/assistant-decision-history?threadId=${thread.id}&campaignId=root`);
    assert.equal(history.status, 200);
    assert.equal(history.body.total, 1);
    assert.deepEqual(history.body.outcomeCounts, { approved: 1, denied: 0, answered: 0 });
    assert.equal(history.body.entries[0].subject, snapshot.branch);
    assert.deepEqual(history.body.entries.map((item: { delegation: unknown }) => item.delegation), [recorded.assistantDelegation]);
    const otherOwnerHistory = h.db.assistantDecisionHistory({ ...h.owner, userId: "other-owner" }, { threadId: thread.id });
    assert.deepEqual(otherOwnerHistory, { entries: [], total: 0, outcomeCounts: { approved: 0, denied: 0, answered: 0 } });
    await setGrant(6, grant);
    const evidence = h.svc.createWorkflowDecision("child", { requestId: "evidence", resourceKey: "screenshots",
      resourceSnapshot: { category: "ui_evidence_approval", evidence: [{ evidenceId: "preview",
        uri: "https://evidence.example/preview.png", sha256: "b".repeat(64) }] } });
    assert.ok(evidence.ok && evidence.data, evidence.error ?? "evidence requested");
    const evidenceResolution = { ...resolution, occurrenceId: evidence.data.occurrenceId,
      resourceDigest: evidence.data.resourceDigest, reason: "The supplied evidence could not be verified." };
    const evidenceApproval = await call("assistant_decision_resolve", evidenceResolution);
    assert.match(evidenceApproval.content[0].text, /outside the thread's decision delegation grant/u);
    assert.equal(h.db.workflowDecisionByOccurrence(evidence.data.occurrenceId)?.status, "pending");
    const evidenceDenial = await call("assistant_decision_resolve", { ...evidenceResolution, outcome: "deny" });
    assert.equal(evidenceDenial.isError, undefined, evidenceDenial.content[0].text);
    assert.equal(h.db.workflowDecisionByOccurrence(evidence.data.occurrenceId)?.assistantDelegation?.outcome, "denied");
    const filtered = await h.ownerCall("GET", `/api/assistant-decision-history?threadId=${thread.id}&campaignId=root&outcome=denied`);
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.body.outcomeCounts, { approved: 1, denied: 1, answered: 0 });
    assert.equal(filtered.body.total, 2);
    assert.deepEqual(filtered.body.entries.map((item: { occurrenceId: string }) => item.occurrenceId), [evidence.data.occurrenceId]);
    const invalid = await h.ownerCall("GET", `/api/assistant-decision-history?threadId=${thread.id}&outcome=pending`);
    assert.equal(invalid.status, 400);
    const outside = h.db.assistantConnections.create(h.owner, "Outside Assistant", { operations: "all", projects: "all" });
    assert.equal(h.operations.list(outside.connection).some((op) => op.name === "assistant_decision_resolve"), false);
    await assert.rejects(h.operations.call(h.db.assistantConnections.authenticate(outside.token)!, "assistant_decision_resolve", resolution), /requires an explicit grant/u);
  } finally { await h.close(); }
});

test("Assistant screenshot approval requires exact relay-acknowledged deliveries under the current grant", async () => {
  const h = await harness();
  try {
    const fixture = await assistantUiEvidenceFixture(h);
    const { call, setGrant, decision, thread, images, resolution } = fixture;
    const prepare = await call(ASSISTANT_EVIDENCE_PREPARE, { ...fixture.coordinates, brief: "Check both screenshots." });
    assert.match(prepare.content[0].text, /needs a campaign allowance/u);
    const inspect = (evidenceId: string) => call(ASSISTANT_EVIDENCE_INSPECT, { ...fixture.coordinates, evidenceId });
    const approve = () => call("assistant_decision_resolve", resolution);
    const expectPending = () => assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)?.status, "pending");
    const refused = await approve();
    assert.match(refused.content[0].text, /"desktop", "phone"/u);
    expectPending();
    const desktop = await inspect("desktop");
    assert.deepEqual(desktop.content[1], { type: "image", mimeType: "image/png", data: images[0]!.data });
    const receipt = h.db.validUiEvidenceReviewReceipts(decision.occurrenceId, thread.sessionId, Date.now());
    assert.equal(receipt.length, 1);
    assert.equal(receipt[0]?.sha256, images[0]?.sha256);
    assert.match((await approve()).content[0].text, /receipts for "phone"/u);
    expectPending();
    // Even re-saving identical categories advances the grant revision and invalidates old proof.
    await setGrant(1);
    const phone = await inspect("phone");
    assert.equal(phone.isError, undefined, phone.content[0].text);
    assert.match((await approve()).content[0].text, /receipts for "desktop"/u);
    const forged = await call(ASSISTANT_EVIDENCE_RELAY_ACK, {}, ASSISTANT_EVIDENCE_RELAY_ACK);
    assert.match(forged.error.message, /private to the Wollipog runner/u);
    expectPending();
    await inspect("desktop");
    h.svc.onSessionStatus("evidence-child", "idle");
    const approved = await approve();
    assert.equal(approved.isError, undefined, approved.content[0].text);
    assertEvidenceResolution(h, fixture, 2);
    assert.deepEqual(h.db.validUiEvidenceReviewReceipts(decision.occurrenceId, thread.sessionId, Date.now()), []);
  } finally { await h.close(); }
});

test("Assistant evidence approval fails closed on older runners and on a provider model change", async () => {
  const old = await harness(RUNNER_CAPABILITY_MIN_PROTOCOL.assistantEvidenceReview - 1);
  try {
    const thread = (await old.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    assert.equal(thread.evidenceReview?.available, false);
    const refused = await old.ownerCall("PUT", `/api/assistant-threads/${thread.id}/delegation`, { revision: 0,
      grant: { categories: ["ui_evidence_review"], projects: "all", campaigns: "all", expiresAt: null,
        evidenceDisclosureDigest: "a".repeat(64) } });
    assert.equal(refused.status, 409);
    // The old relay sends a normal tools/call RPC. The current control plane withholds bytes.
    const fixtureCredential = `wollipoga_${"s".repeat(43)}`;
    assert.ok(old.threads.registerCredential("r", thread.sessionId, createHash("sha256").update(fixtureCredential).digest("hex")).accepted);
    const response = await old.app.inject({ method: "POST", url: "/assistant/mcp", headers: { authorization: `Bearer ${fixtureCredential}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: ASSISTANT_EVIDENCE_INSPECT, arguments: {} } } });
    const result = response.json().result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /requires a compatible Wollipog runner/u);
    assert.ok(result.content.every((item: { type: string }) => item.type === "text"));
  } finally { await old.close(); }
  const h = await harness();
  try {
    const { call, coordinates, resolution, thread, decision } = await assistantUiEvidenceFixture(h);
    for (const evidenceId of ["desktop", "phone"]) {
      assert.equal((await call(ASSISTANT_EVIDENCE_INSPECT, { ...coordinates, evidenceId })).content[1].type, "image");
    }
    h.db.updateSessionConfig(thread.sessionId, { model: "claude-sonnet-4-6" }, Date.now());
    const refused = await call("assistant_decision_resolve", resolution);
    assert.match(refused.content[0].text, /provider, model or account changed/u);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)?.status, "pending");
  } finally { await h.close(); }
});

test("Assistant approval leaves external and video evidence with the owner", async () => {
  const h = await harness();
  try {
    const { call, resolution } = await assistantUiEvidenceFixture(h);
    const video = h.svc.attachSessionVideo("evidence-child", { name: "preview.webm", mimeType: "video/webm",
      data: Buffer.concat([Buffer.from("1a45dfa387428284", "hex"), Buffer.from("webm"), Buffer.alloc(8)]).toString("base64"),
    }, { kind: "agent", id: "evidence-child" });
    assert.ok(video.ok && video.data, video.error ?? "video attachment refused");
    const asked = h.svc.createWorkflowDecision("evidence-child", { requestId: "unsupported", resourceKey: "media",
      resourceSnapshot: { category: "ui_evidence_approval", evidence: [
        { evidenceId: "external", uri: "https://evidence.example/preview.png", sha256: "a".repeat(64) },
        { evidenceId: "video", mediaType: "video/webm", artifactId: video.data.artifactId, sha256: video.data.sha256 },
      ] } });
    assert.ok(asked.ok && asked.data, asked.error ?? "media decision refused");
    const args = { ...resolution, occurrenceId: asked.data.occurrenceId, resourceDigest: asked.data.resourceDigest };
    const refused = await call("assistant_decision_resolve", args);
    assert.match(refused.content[0].text, /cannot inspect evidence "external", "video"/u);
    assert.equal(h.db.workflowDecisionByOccurrence(args.occurrenceId)?.status, "pending");
  } finally { await h.close(); }
});

const assistantEvidenceBudget: CampaignBudgetAuthority = {
  version: 1, accounting: "managed_workers_only", unpriced: "stop", concurrency: 2, acceptedFollowUps: 0, toolCalls: 100,
};

test("Assistant verdict approval uses a restricted campaign-accounted reviewer and exact receipt set", async () => {
  const h = await harness();
  try {
    const fixture = await assistantUiEvidenceFixture(h, assistantEvidenceBudget);
    const { call, coordinates, resolution, decision, thread, images } = fixture;
    const prepare = () => call(ASSISTANT_EVIDENCE_PREPARE, { ...coordinates, brief: "Confirm that all actions fit the two viewports." });
    const prepared = await prepare();
    assert.equal(prepared.isError, undefined, prepared.content[0].text);
    const { reviewId, reviewerSessionId } = JSON.parse(prepared.content[0].text).review;
    const reviewer = h.db.getSession(reviewerSessionId)!;
    assert.equal(reviewer.parentSessionId, "evidence-root");
    assert.equal(reviewer.model, "claude-opus-5-5");
    assert.equal(reviewer.maxChildSessions, 0);
    assert.ok(h.db.campaignBudgets.allocation(reviewerSessionId));
    h.db.updateSessionStatus(reviewerSessionId, "running", Date.now());
    const get = () => call(ASSISTANT_EVIDENCE_GET, { ...coordinates, reviewId });
    assert.equal(JSON.parse((await get()).content[0].text).review.delegatedImageReview, undefined);
    const verdict = { recommendation: "approve", summary: "Both viewports fit.", items: images.map((image) =>
      ({ evidenceId: image.evidenceId, outcome: "pass", defects: [] })) };
    assert.match(h.svc.submitDelegatedImageVerdict(reviewerSessionId, verdict, () => true).error!, /"desktop", "phone"/u);
    for (const image of images) {
      const delivered = h.svc.reviewDelegatedImageEvidence(reviewerSessionId, image.evidenceId, () => true);
      assert.ok(delivered.ok && delivered.data, delivered.error ?? "image delivery refused");
      assert.equal(delivered.data.data, image.data);
      assert.ok(h.svc.acknowledgeDelegatedImageEvidence(reviewerSessionId, delivered.data.receipt.receiptId,
        image.sha256, () => true).ok);
    }
    assert.ok(h.svc.submitDelegatedImageVerdict(reviewerSessionId, verdict, () => true).ok);
    const reference = JSON.parse((await get()).content[0].text).review.delegatedImageReview;
    assert.equal(reference.reviewId, reviewId);
    assert.match((await call("assistant_decision_resolve", resolution)).content[0].text, /"desktop", "phone"/u);
    const invalid = await call("assistant_decision_resolve", { ...resolution,
      delegatedImageReview: { ...reference, verdictId: "other" } });
    assert.match(invalid.content[0].text, /does not identify an actual reviewer verdict/u);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)?.status, "pending");
    assert.equal(h.db.validUiEvidenceReviewReceipts(decision.occurrenceId, thread.sessionId, Date.now()).length, 0);
    h.svc.onSessionStatus("evidence-child", "idle");
    const approved = await call("assistant_decision_resolve", { ...resolution, delegatedImageReview: reference });
    assert.equal(approved.isError, undefined, approved.content[0].text);
    assertEvidenceResolution(h, fixture, 1);
    assert.equal(h.db.delegatedImageReviews.get(reviewId)?.state, "consumed");
  } finally { await h.close(); }
});

test("a replaced Assistant grant ends the managed review and keeps the reviewer slot until Stop is confirmed", async () => {
  const h = await harness();
  try {
    const { call, coordinates, setGrant, decision } = await assistantUiEvidenceFixture(h, assistantEvidenceBudget);
    const prepare = () => call(ASSISTANT_EVIDENCE_PREPARE, { ...coordinates, brief: "Confirm that both viewports fit." });
    const prepared = await prepare();
    assert.equal(prepared.isError, undefined, prepared.content[0].text);
    const { reviewId, reviewerSessionId } = JSON.parse(prepared.content[0].text).review;
    h.db.updateSessionStatus(reviewerSessionId, "running", Date.now());
    await setGrant(1);
    const refused = h.svc.reviewDelegatedImageEvidence(reviewerSessionId, "desktop", () => true);
    assert.match(refused.error!, /assistant_authority_changed/u);
    assert.ok(h.db.sessionStopIntent(reviewerSessionId));
    assert.equal(h.db.delegatedImageReviews.get(reviewId)?.state, "ended");
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)?.status, "pending");
    assert.match((await prepare()).content[0].text, /already has one active image reviewer/u);
  } finally { await h.close(); }
});

async function assistantUiEvidenceFixture(h: Awaited<ReturnType<typeof harness>>, budget?: CampaignBudgetAuthority) {
  const thread = (await h.ownerCall("POST", "/api/assistant-threads", { title: "Evidence Assistant" })).body.thread as AssistantThread;
  const env = await h.provision(thread.sessionId);
  const evidenceReview = thread.evidenceReview;
  assert.ok(evidenceReview?.available);
  decisionSession(h, "evidence-root", undefined, budget);
  decisionSession(h, "evidence-child", "evidence-root");
  const images = ["desktop", "phone"].map((evidenceId) => {
    const data = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(evidenceId)]).toString("base64");
    const artifact = h.svc.createArtifact({ sessionId: "evidence-child", kind: "screenshot", name: `${evidenceId}.png`,
      mimeType: "image/png", encoding: "base64", data }, { kind: "agent", id: "evidence-child" });
    assert.ok(artifact.ok && artifact.data, artifact.error ?? "screenshot creation refused");
    return { evidenceId, artifactId: artifact.data.artifactId, sha256: artifact.data.sha256, mediaType: "image/png", data };
  });
  const asked = h.svc.createWorkflowDecision("evidence-child", { requestId: "evidence", resourceKey: "screenshots",
    resourceSnapshot: { category: "ui_evidence_approval", evidence: images.map(({ data: _data, ...item }) => item) } });
  assert.ok(asked.ok && asked.data, asked.error ?? "evidence decision refused");
  const decision = asked.data;
  const coordinates = { sessionId: "evidence-child", occurrenceId: decision.occurrenceId, resourceDigest: decision.resourceDigest };
  const call = async (name: string, args: object, method = "tools/call") => {
    const [response] = await h.callTools(env, { jsonrpc: "2.0", id: 1, method, params: { name, arguments: args } });
    return response.result ?? response;
  };
  const grant: AssistantDecisionGrant = { categories: ["ui_evidence_review"], projects: "all", campaigns: "all", expiresAt: null };
  const path = `/api/assistant-threads/${thread.id}/delegation`;
  assert.equal((await h.ownerCall("PUT", path, { revision: 0, grant })).status, 409, "the owner must confirm the disclosure");
  const setGrant = async (revision: number) => {
    const saved = await h.ownerCall("PUT", path, { revision, grant: { ...grant, evidenceDisclosureDigest: evidenceReview.disclosureDigest } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  };
  await setGrant(0);
  return { thread, images, decision, coordinates, call, setGrant,
    resolution: { ...coordinates, outcome: "approve", reason: "The screenshots meet the criteria." } };
}

function assertEvidenceResolution(h: Awaited<ReturnType<typeof harness>>,
  { thread, decision }: Awaited<ReturnType<typeof assistantUiEvidenceFixture>>, grantRevision: number) {
  const recorded = h.db.workflowDecisionByOccurrence(decision.occurrenceId)!;
  assert.equal(recorded.status, "approved");
  assert.equal(recorded.assistantDelegation?.threadId, thread.id);
  assert.equal(recorded.assistantDelegation?.grantRevision, grantRevision);
  assert.ok(decisionPrompts(h, decision.sessionId).some((prompt) => prompt.includes("Evidence Assistant")));
  const history = h.db.assistantDecisionHistory(h.owner, { campaignId: "evidence-root", threadId: thread.id });
  assert.deepEqual(history.entries.map((item) => item.delegation), [recorded.assistantDelegation]);
}

test("an explicit Assistant grant approves an exact CI rerun and only the requester can execute it once", async () => {
  const h = await harness();
  try {
    decisionSession(h, "root");
    decisionSession(h, "child", "root");
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", { title: "CI Assistant" })).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const snapshot = { category: "ci_rerun" as const, repository: "picoduck/wollipog", runId: 123,
      attempt: 2, headSha: "a".repeat(40) };
    const calls: Array<Extract<ControlPlaneToRunner, { type: "forge_decision_action" }>> = [];
    let result: "rerun_requested" | "refused" | "uncertain" = "rerun_requested";
    h.hub.requestFromRunner = async (_runnerId, requestId, frame) => {
      if (frame.type === "campaign_launch_inspect") {
        return { type: "campaign_launch_inspection_result", requestId, workspaceId: frame.workspaceId,
          ok: true, repository: snapshot.repository, issueNumbers: [], digest: "0".repeat(64) };
      }
      assert.equal(frame.type, "forge_decision_action");
      if (frame.action.kind === "ci_rerun_inspect_job") {
        return { type: "forge_decision_action_result", requestId, sessionId: frame.sessionId, occurrenceId: frame.occurrenceId,
          outcome: "ci_job_inspected", jobName: "Build and Bundle" };
      }
      calls.push(frame);
      return { type: "forge_decision_action_result", requestId, sessionId: frame.sessionId, occurrenceId: frame.occurrenceId,
        outcome: result, ...(result === "refused" ? { refusal: { reason: "ci_target_mismatch",
          summary: "The approved attempt changed." } } : {}) };
    };
    const request = async (sessionId: string, runId: number, requestId: string, jobId?: number) => {
      const resourceSnapshot = { ...snapshot, runId, ...(jobId === undefined ? {} : { jobId }) };
      const asked = await h.svc.createWorkflowDecisionWithVideo(sessionId, { requestId,
        resourceKey: ciRerunResourceKey(resourceSnapshot), resourceSnapshot });
      assert.ok(asked.ok && asked.data, asked.error ?? "request created");
      assert.equal(asked.data.authority, "human");
      return asked.data;
    };
    const decide = async (decision: Awaited<ReturnType<typeof request>>, resourceDigest = decision.resourceDigest) => {
      const [response] = await h.callTools(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "assistant_decision_resolve", arguments: { sessionId: decision.sessionId, occurrenceId: decision.occurrenceId,
          resourceDigest, outcome: "approve", reason: "Approved the exact CI target." },
      } });
      return response.result;
    };
    const run = await request("child", 123, "rerun");
    const execute = (decision: typeof run, sessionId = decision.sessionId, resourceDigest = decision.resourceDigest) =>
      h.svc.executeWorkflowDecision(sessionId, decision.occurrenceId, { resourceDigest });
    assert.equal((await execute(run)).ok, false);
    assert.match((await decide(run)).content[0].text, /no decision delegation grant/u);
    const grant = await h.ownerCall("PUT", `/api/assistant-threads/${thread.id}/delegation`, { revision: 0,
      grant: { categories: ["ci_rerun"], projects: [h.project.id], campaigns: ["root"], expiresAt: null } });
    assert.equal(grant.status, 200, JSON.stringify(grant.body));
    assert.match((await decide(run, "0".repeat(64))).content[0].text, /snapshot changed/u);
    const approved = await decide(run);
    assert.equal(approved.isError, undefined, approved.content[0].text);
    assert.equal((await execute(run, "root")).status, 404);
    assert.equal((await execute(run, "child", "0".repeat(64))).status, 409);
    assert.equal((await h.svc.consumeWorkflowDecision("child", run.occurrenceId, { resourceSnapshot: snapshot })).status, 403);
    assert.equal(calls.length, 0);
    const performed = await execute(run);
    assert.equal(performed.data?.status, "consumed", performed.error ?? "request executed");
    assert.equal(performed.data?.forgeAction?.outcome, "rerun_requested");
    assert.deepEqual(calls[0]?.action, { kind: "ci_rerun", repository: snapshot.repository, runId: 123, attempt: 2, headSha: snapshot.headSha });
    assert.equal((await execute(run)).status, 409);
    const history = await h.ownerCall("GET", `/api/assistant-decision-history?threadId=${thread.id}&campaignId=root`);
    assert.equal(history.body.entries[0]?.category, "ci_rerun");
    assert.equal(history.body.entries[0]?.subject, "picoduck/wollipog · Run 123 · Attempt 2");
    assert.equal(history.body.entries[0]?.delegation?.threadId, thread.id);

    result = "refused";
    const stale = await request("child", 124, "stale-target");
    assert.equal((await decide(stale)).isError, undefined);
    assert.equal((await execute(stale)).data?.status, "revoked");
    assert.equal((await execute(stale)).status, 409);

    result = "uncertain";
    const uncertain = await request("child", 125, "uncertain-target", 200);
    assert.equal((await decide(uncertain)).isError, undefined);
    assert.equal((await execute(uncertain)).data?.forgeAction?.outcome, "uncertain");
    assert.equal((await execute(uncertain)).status, 409);
    decisionSession(h, "other", "root");
    const duplicate = await request("other", 125, "same-attempt-different-job", 201);
    assert.equal((await decide(duplicate)).isError, undefined);
    assert.equal((await execute(duplicate)).status, 409);
    assert.equal(calls.length, 3);
    const jobHistory = await h.ownerCall("GET", `/api/assistant-decision-history?threadId=${thread.id}&campaignId=root`);
    assert.equal(jobHistory.body.entries[0]?.subject, "picoduck/wollipog · Run 125 · Attempt 2 · Build and Bundle");
  } finally { await h.close(); }
});

const releaseDecisionTarget = { repository: "picoduck/wollipog", tag: "v1.2.3", commitSha: "a".repeat(40), releasePayloadDigest: "" };
const releaseSnapshots: ReleaseDecisionSnapshot[] = [
  { ...releaseDecisionTarget, category: "release_tag" },
  { ...releaseDecisionTarget, category: "release_publish", releaseId: 200, releasePayload: {
    name: "Wollipog v1.2.3", body: "Release notes.", draft: { name: null, body: null, targetCommitish: "main" },
    previousStable: null, assets: [],
  } },
].map((snapshot) => {
  const target = snapshot as ReleaseDecisionSnapshot;
  return { ...target, releasePayloadDigest: createHash("sha256").update(releaseDecisionPayloadBytes(target)).digest("hex") };
});

test("release approval is owner-held and an Assistant grant only covers its exact release action", async () => {
  const h = await harness();
  try {
    decisionSession(h, "root");
    decisionSession(h, "child", "root");
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", { title: "Release Assistant" })).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const calls: Array<Extract<ControlPlaneToRunner, { type: "forge_decision_action" }>> = [];
    h.hub.requestFromRunner = async (_runnerId, requestId, frame) => {
      if (frame.type === "campaign_launch_inspect") {
        return { type: "campaign_launch_inspection_result", requestId, workspaceId: frame.workspaceId,
          ok: true, repository: releaseDecisionTarget.repository, issueNumbers: [], digest: "0".repeat(64) };
      }
      assert.equal(frame.type, "forge_decision_action");
      calls.push(frame);
      return { type: "forge_decision_action_result", requestId, sessionId: frame.sessionId, occurrenceId: frame.occurrenceId,
        outcome: frame.action.kind === "release_tag" ? "release_tagged" : "release_published" };
    };
    const request = async (resourceSnapshot: ReleaseDecisionSnapshot) => {
      const asked = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: resourceSnapshot.category,
        resourceKey: releaseDecisionResourceKey(resourceSnapshot), resourceSnapshot });
      assert.ok(asked.ok && asked.data, asked.error ?? "request created");
      assert.equal(asked.data.authority, "human");
      return asked.data;
    };
    const resolve = async (decision: Awaited<ReturnType<typeof request>>, digest = decision.resourceDigest) => {
      const [response] = await h.callTools(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "assistant_decision_resolve", arguments: { sessionId: "child", occurrenceId: decision.occurrenceId,
          resourceDigest: digest, outcome: "approve", reason: "Approved the exact release target and payload." },
      } });
      return response.result;
    };
    const tag = await request(releaseSnapshots[0]!);
    const publish = await request(releaseSnapshots[1]!);
    const execute = (decision: typeof tag, session = "child") =>
      h.svc.executeWorkflowDecision(session, decision.occurrenceId, { resourceDigest: decision.resourceDigest });
    assert.equal((await execute(tag)).status, 409);
    assert.match((await resolve(tag)).content[0].text, /no decision delegation grant/u);
    const grant = async (revision: number, categories: AssistantDecisionGrant["categories"]) => {
      const saved = await h.ownerCall("PUT", `/api/assistant-threads/${thread.id}/delegation`, { revision,
        grant: { categories, projects: [h.project.id], campaigns: ["root"], expiresAt: null } });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
    };
    await grant(0, ["release_tag"]);
    assert.match((await resolve(publish)).content[0].text, /outside the thread's decision delegation grant/u);
    assert.match((await resolve(tag, "0".repeat(64))).content[0].text, /snapshot changed/u);
    assert.equal((await resolve(tag)).isError, undefined);
    assert.equal((await execute(tag, "root")).status, 404);
    assert.equal((await h.svc.consumeWorkflowDecision("child", tag.occurrenceId, { resourceSnapshot: tag.resourceSnapshot })).status, 403);
    assert.equal((await execute(tag)).data?.status, "consumed");
    assert.equal((await execute(tag)).status, 409);
    await grant(1, ["release_publish"]);
    assert.equal((await resolve(publish)).isError, undefined);
    assert.equal((await execute(publish)).data?.forgeAction?.outcome, "release_published");
    assert.deepEqual(calls.map(({ action }) => action), releaseSnapshots.map(({ category, ...snapshot }) => ({ kind: category, ...snapshot })));
    const history = await h.ownerCall("GET", `/api/assistant-decision-history?threadId=${thread.id}&campaignId=root`);
    assert.deepEqual(history.body.entries.map((entry: { subject: string }) => entry.subject),
      ["picoduck/wollipog · v1.2.3", "picoduck/wollipog · v1.2.3"]);
    assert.equal(history.body.entries[0]?.delegation.threadId, thread.id);
  } finally { await h.close(); }
});

test("older runners refuse typed release requests before contacting GitHub", async () => {
  const h = await harness(RUNNER_CAPABILITY_MIN_PROTOCOL.typedReleaseDecisions - 1);
  try {
    decisionSession(h, "root");
    decisionSession(h, "child", "root");
    h.hub.requestFromRunner = async () => { throw new Error("an older runner must not be asked"); };
    for (const snapshot of releaseSnapshots) {
      const result = await h.svc.createWorkflowDecisionWithVideo("child", {
        requestId: snapshot.category, resourceKey: releaseDecisionResourceKey(snapshot), resourceSnapshot: snapshot,
      });
      assert.match(result.error ?? "", /typed release decisions/u);
    }
    assert.deepEqual(h.db.pendingWorkflowDecisionsForSession("child"), []);
  } finally { await h.close(); }
});

test("older runners keep CI reruns outside typed decision delegation", async () => {
  const h = await harness(RUNNER_CAPABILITY_MIN_PROTOCOL.typedCiRerun - 1);
  try {
    decisionSession(h, "root");
    decisionSession(h, "child", "root");
    const resourceSnapshot = { category: "ci_rerun" as const, repository: "picoduck/wollipog",
      runId: 123, attempt: 2, headSha: "a".repeat(40) };
    h.hub.requestFromRunner = async () => { throw new Error("an older runner must not be asked"); };
    const refused = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "rerun",
      resourceKey: ciRerunResourceKey(resourceSnapshot), resourceSnapshot });
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? "", /typed CI reruns/u);
    assert.deepEqual(h.db.pendingWorkflowDecisionsForSession("child"), []);
  } finally { await h.close(); }
});

test("a delegated Owner Question returns an option or free text and credential classification and Owner Approvals stay human", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    decisionSession(h, "root");
    h.hub.requestFromRunner = async (_runner, requestId, message) => {
      if (message.type !== "campaign_issue_scope" || message.operation !== "synchronize") throw new Error("Unexpected fixture command.");
      return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true,
        repository: "picoduck/wollipog", revision: message.scope.revision };
    };
    h.svc.setDecisionRuntime(fakeScreenRuntime(h.db, (request) =>
      JSON.stringify(request).includes("Uncertain question") ? { verdict: "uncertain" } : { verdict: "discusses" }).runtime);
    const enabled = h.svc.setCampaignControl("root", {
      mode: "full_control", objective: "Implement #1", operations: ["question"], delegatablePolicyIds: [],
    }, 1, h.owner);
    assert.ok(enabled.ok, enabled.error ?? "Full Control enabled");
    const saved = await h.ownerCall("PUT", `/api/assistant-threads/${thread.id}/delegation`, { revision: 0,
      grant: { categories: ["owner_question"], projects: [h.project.id], campaigns: ["root"], expiresAt: null } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const ask = async (requestId: string, options: Array<{ optionId: string; label: string }>, kind: "question" | "approval" = "question") => {
      const result = await h.svc.createOwnerDecision("root", {
        requestId, resourceKey: requestId, kind, question: requestId, options,
      });
      assert.ok(result.ok && result.data, result.error ?? "question created");
      return result.data;
    };
    const resolve = async (decision: Awaited<ReturnType<typeof ask>>, fields: object = {}) => {
      const [response] = await h.callTools(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "assistant_decision_resolve", arguments: { sessionId: "root", occurrenceId: decision.occurrenceId,
          resourceDigest: decision.resourceDigest, outcome: "approve", reason: "This is consistent with the plan.", ...fields },
      } });
      return response.result;
    };
    const options = [{ optionId: "green", label: "Green" }, { optionId: "blue", label: "Blue" }];
    const optionQuestion = await ask("Which queue should we use?", options);
    const option = await resolve(optionQuestion, { selectedOptionId: "green", answer: "Proceed after the required checks." });
    assert.equal(option.isError, undefined, option.content[0].text);
    assert.equal(h.db.workflowDecisionByOccurrence(optionQuestion.occurrenceId)?.selectedOptionId, "green");
    const freeQuestion = await ask("What should the summary cover?", []);
    const text = await resolve(freeQuestion, { answer: "Mention the test result." });
    assert.equal(text.isError, undefined, text.content[0].text);
    const recorded = h.db.workflowDecisionByOccurrence(freeQuestion.occurrenceId)!;
    assert.equal(recorded.childMessage, "Mention the test result.");
    assert.equal(recorded.assistantDelegation?.outcome, "answered");
    assert.ok(decisionPrompts(h, "root").some((prompt) => prompt.includes("Mention the test result.") && prompt.includes(thread.id)));
    const uncertain = await ask("Uncertain question", options);
    assert.match((await resolve(uncertain, { selectedOptionId: "green" })).content[0].text, /direct human response/u);
    assert.equal(h.db.workflowDecisionByOccurrence(uncertain.occurrenceId)?.status, "pending");
    const ownerApproval = await ask("Authorize the operation?", options, "approval");
    assert.match((await resolve(ownerApproval, { selectedOptionId: "green" })).content[0].text, /no supported typed Assistant resolution path/u);
    assert.equal(h.db.workflowDecisionByOccurrence(ownerApproval.occurrenceId)?.status, "pending");
    const reports = [
      { requestId: "issue_closure_recovery_fixture", resourceKey: "issue_closure_recovery:fixture", trustedIssueClosureRecovery: true },
      { requestId: "merge_closure_fixture", resourceKey: "merge_closure:fixture", trustedMergeClosureReport: true },
    ];
    for (const { requestId, resourceKey, ...origin } of reports) {
      const report = h.svc.createWorkflowDecision("root", { requestId, resourceKey, resourceSnapshot: {
        category: "owner_decision", kind: "question", question: "Inspect the forge before acknowledging the report.",
        options: [{ optionId: "acknowledge", label: "Acknowledge Outcome" }],
      } }, () => true, { trustedOwnerDecision: true, ...origin });
      assert.ok(report.ok && report.data, report.error ?? "report created");
      assert.match((await resolve(report.data, { selectedOptionId: "acknowledge" })).content[0].text, /direct human response/u);
      assert.match((await resolve(report.data, { outcome: "deny" })).content[0].text, /direct human response/u);
      assert.equal(h.db.workflowDecisionByOccurrence(report.data.occurrenceId)?.status, "pending");
    }
  } finally { await h.close(); }
});

test("a thread's session calls its granted tools, authorized live and audited against its own connection", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    assert.match(thread.connectionId ?? "", /^asst_/);
    // Listed in the owner's Assistant connections, attributed to the thread, with no credential.
    const listed = (await h.ownerCall("GET", "/api/assistant-connections")).body.connections as Array<Record<string, unknown>>;
    const connection = listed.find((candidate) => candidate.id === thread.connectionId)!;
    assert.equal(connection.threadId, thread.id);
    assert.deepEqual(connection.grant, { operations: "all", projects: "all", destructiveConfirmation: "confirm" });
    assert.ok(!JSON.stringify(listed).match(/wollipoga_|token_hash|tokenHash/u));
    // The owner cannot rotate it out from under its proxy.
    assert.equal((await h.ownerCall("POST", `/api/assistant-connections/${thread.connectionId}/rotate`)).status, 400);

    const env = await h.provision(thread.sessionId);
    const [listedTools, discovered] = await h.callTools(env, { jsonrpc: "2.0", id: 1, method: "tools/list" }, discover);
    assert.ok(listedTools.result.tools.some((tool: { name: string }) => tool.name === "assistant_discover"));
    const result = JSON.parse(discovered.result.content[0].text);
    assert.equal(result.connection.id, thread.connectionId);
    assert.equal(result.connection.threadId, thread.id);
    // Outside assistants read the same guide the thread's session was launched with.
    assert.equal(result.skill.name, "wollipog");
    assert.match(result.skill.content, /explicit Decision Delegation grant/u);
    assert.match(result.skill.content, /Generic permissions and confirmations stay with the owner/u);
    const activity = h.db.assistantConnections.activity(thread.connectionId!);
    assert.deepEqual(activity.map((row) => [row.operation, row.outcome]), [["assistant_discover", "succeeded"]]);

    // The grant is read live: excluding the operation refuses the next call and audits it.
    h.db.assistantConnections.configure(thread.connectionId!, { operations: [], projects: "all" });
    const [refused] = await h.callTools(env, discover);
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /excluded/);
    assert.deepEqual(h.db.assistantConnections.activity(thread.connectionId!).map((row) => row.outcome), ["refused", "succeeded"]);
  } finally { await h.close(); }
});

test("only the thread's runner may bind a credential, and an expired one is refused", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    assert.deepEqual(h.threads.registerCredential("other-runner", thread.sessionId, "a".repeat(64)).accepted, false);
    assert.deepEqual(h.threads.registerCredential("r", "s_not_a_thread", "a".repeat(64)).accepted, false);
    const bound = h.threads.registerCredential("r", thread.sessionId, "b".repeat(64));
    assert.equal(bound.accepted, true);
    assert.ok(bound.expiresAt! > Date.now() && bound.expiresAt! <= Date.now() + ASSISTANT_THREAD_CREDENTIAL_TTL_MS);

    const env = await h.provision(thread.sessionId);
    assert.equal((await h.callTools(env, discover))[0].result.isError, undefined);
    // Expire the bound credential: the control plane refuses it, and the proxy binds a fresh one.
    const expiredHash = (h.db.raw().prepare("SELECT token_hash FROM assistant_connections WHERE id=?").get(thread.connectionId) as { token_hash: string }).token_hash;
    h.db.raw().prepare("UPDATE assistant_connections SET expires_at=? WHERE id=?").run(Date.now() - 1, thread.connectionId);
    assert.equal(h.db.assistantConnections.authenticate(null), null);
    const [recovered] = await h.callTools(env, discover);
    assert.equal(recovered.result.isError, undefined);
    const current = h.db.raw().prepare("SELECT token_hash, expires_at FROM assistant_connections WHERE id=?").get(thread.connectionId) as { token_hash: string; expires_at: number };
    assert.notEqual(current.token_hash, expiredHash);
    assert.ok(current.expires_at > Date.now());
    // A refusal of the replacement reaches the assistant: the connection is revoked meanwhile.
    h.db.raw().prepare("UPDATE assistant_connections SET expires_at=? WHERE id=?").run(Date.now() - 1, thread.connectionId);
    h.db.raw().prepare("UPDATE assistant_connections SET revoked=1 WHERE id=?").run(thread.connectionId);
    const [refused] = await h.callTools(env, discover);
    assert.match(refused.error.message, /revoked/);
  } finally { await h.close(); }
});

test("archiving or deleting a thread revokes its credential, stops the proxy and refuses later calls", async () => {
  const h = await harness();
  try {
    const archived = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(archived.sessionId);
    assert.equal((await h.callTools(env, discover))[0].result.isError, undefined);
    const grant = await h.ownerCall("PUT", `/api/assistant-threads/${archived.id}/delegation`, { revision: 0,
      grant: { categories: ["owner_question"], projects: "all", campaigns: "all", expiresAt: null } });
    assert.equal(grant.status, 200);
    const before = h.toRunner.length;
    assert.ok(h.svc.setArchived(archived.sessionId, true).ok, "archiving the backing session also archives the thread");
    assert.deepEqual(h.threads.get(h.owner, archived.id).decisionDelegation, { revision: 2, grant: null });
    assert.ok(h.svc.setArchived(archived.sessionId, false).ok);
    assert.deepEqual(h.threads.get(h.owner, archived.id).decisionDelegation, { revision: 2, grant: null });
    assert.equal(h.db.assistantConnections.get(archived.connectionId!)!.revoked, true);
    assert.ok(h.toRunner.slice(before).some((message) => message.type === "assistant_credential_revoked" && message.sessionId === archived.sessionId));
    // Even before the runner acts on the message, the control plane refuses the old credential and any new one.
    const [refused] = await h.callTools(env, discover);
    assert.match(refused.error.message, /archived|revoked/);
    await h.proxies.revoke(archived.sessionId);
    const [closed] = await h.callTools(env, discover);
    assert.match(closed.error.message, /proxy is unavailable/);

    const deleted = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const deletedEnv = await h.provision(deleted.sessionId);
    assert.equal((await h.callTools(deletedEnv, discover))[0].result.isError, undefined);
    assert.equal(h.svc.delete(deleted.sessionId).ok, true);
    assert.equal(h.db.assistantConnections.get(deleted.connectionId!)!.revoked, true);
    assert.equal((await h.ownerCall("GET", `/api/assistant-threads/${deleted.id}`)).body.thread.status, "archived");
    assert.ok((await h.callTools(deletedEnv, discover))[0].error);

    // The owner revoking the connection directly also tells the runner.
    const third = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const mark = h.toRunner.length;
    assert.equal((await h.ownerCall("POST", `/api/assistant-connections/${third.connectionId}/revoke`)).status, 200);
    assert.ok(h.toRunner.slice(mark).some((message) => message.type === "assistant_credential_revoked" && message.sessionId === third.sessionId));
  } finally { await h.close(); }
});

test("a runner without the proxy cannot start a thread", async () => {
  const h = await harness(RUNNER_CAPABILITY_MIN_PROTOCOL.assistantRole - 1);
  try {
    const refused = await h.ownerCall("POST", "/api/assistant-threads", {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.requiredRunnerProtocolVersion, RUNNER_CAPABILITY_MIN_PROTOCOL.assistantRole);
    assert.deepEqual(h.db.assistantConnections.list(h.owner as HumanPrincipal), [], "no connection is left behind");
  } finally { await h.close(); }
});

const launch = (id: number, locationId: string) => ({ jsonrpc: "2.0", id, method: "tools/call",
  params: { name: "session_launch", arguments: { commandId: `launch-${id}`, locationId, agentId: "claude", prompt: "Summarize the open pull requests" } } });
const resultOf = (reply: { result: { content: Array<{ text: string }> } }) => JSON.parse(reply.result.content[0]!.text);

test("a thread launches sessions within its limits and the assistant hears why it is stopped", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    // The assistant's own session is capped at the thread budget and carries the shared skill.
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
    const start = h.toRunner.find((message) => message.type === "start_session" && message.spec.sessionId === thread.sessionId);
    assert.ok(start?.type === "start_session" && start.spec.assistant?.guide?.includes("## Discover First"));

    const env = await h.provision(thread.sessionId);
    const first = resultOf((await h.callTools(env, launch(1, h.location.id)))[0]);
    assert.equal(first.receipt.status, "succeeded", JSON.stringify(first));
    const launched = h.db.getSession(first.sessionId)!;
    assert.equal(launched.costBudgetUsd, DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd, "a launch is capped at what the thread has left");
    assert.equal(first.threadBudget.costBudgetUsd, 25);
    assert.match(first.threadBudget.explanation, /\$25\.00 cost cap.*thread's budget/);
    let view = (await h.ownerCall("GET", `/api/assistant-threads/${thread.id}`)).body.thread as AssistantThread;
    assert.deepEqual(view.launchedSessionIds, [first.sessionId]);
    assert.deepEqual(view.usage?.launchedSessions, { used: 1, limit: DEFAULT_ASSISTANT_THREAD_LIMITS.launchedSessions });

    // Reaching the launch limit stops further launches with a clear message, and creates nothing.
    for (let index = 1; index < DEFAULT_ASSISTANT_THREAD_LIMITS.launchedSessions; index++) h.db.assistantThreads.recordLaunch(thread.id, `s_prior_${index}`, Date.now());
    const sessionsBefore = h.db.listSessions({ includeArchived: true }).length;
    const refused = resultOf((await h.callTools(env, launch(2, h.location.id)))[0]);
    assert.equal(refused.receipt.status, "failed");
    assert.match(refused.error, /has launched 10 of the 10 sessions it may launch/);
    assert.equal(h.db.listSessions({ includeArchived: true }).length, sessionsBefore);

    // Spend and committed budgets stop launches too.
    const spender = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const spenderEnv = await h.provision(spender.sessionId);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=? WHERE id=?").run(DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd - 8, spender.sessionId);
    // A zero or negative requested budget still gets a cap, never "no budget".
    const zero = { ...launch(3, h.location.id) };
    zero.params.arguments = { ...zero.params.arguments, config: { costBudgetUsd: 0 } } as typeof zero.params.arguments;
    const capped = resultOf((await h.callTools(spenderEnv, zero))[0]);
    assert.equal(h.db.getSession(capped.sessionId)!.costBudgetUsd, 8);
    assert.equal(capped.threadBudget.costBudgetUsd, 8);
    // The cap is taken from the backing assistant's own allowance, so the two caps sum to the budget.
    assert.equal(h.db.getSession(spender.sessionId)!.costBudgetUsd, DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd - 8);
    // That cap is held: nothing is left for another launch even before the first one spends.
    const committed = resultOf((await h.callTools(spenderEnv, launch(4, h.location.id)))[0]);
    assert.match(committed.error, /has spent or committed its whole \$25 budget/);
    // A launched session's own children count against the thread's spend.
    h.db.createSession({ id: "s_grandchild", parentSessionId: capped.sessionId, runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "Child", driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
    h.db.raw().prepare("UPDATE sessions SET cost_usd=? WHERE id=?").run(3, "s_grandchild");
    view = (await h.ownerCall("GET", `/api/assistant-threads/${spender.id}`)).body.thread as AssistantThread;
    assert.deepEqual(view.usage?.costUsd, { used: 20, limit: DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd });
  } finally { await h.close(); }
});

test("the owner can raise exhausted thread limits, but cannot lower the budget past commitments", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const edit = `/api/assistant-threads/${thread.id}/limits`;
    const env = await h.provision(thread.sessionId);
    const run = async (id: number) => resultOf((await h.callTools(env, launch(id, h.location.id)))[0]);
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: 10, launchedSessions: 1 })).status, 200);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=1.13 WHERE id=?").run(thread.sessionId);
    const first = await run(51);
    assert.equal(first.threadBudget.costBudgetUsd, 8.87);
    assert.equal(h.db.getSession(first.sessionId)!.costBudgetUsd, 8.87);
    assert.match((await run(52)).error, /1 of the 1 sessions/);
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: 10, launchedSessions: null })).status, 200);
    assert.match((await run(53)).error, /whole \$10 budget/);
    const tooLow = await h.ownerCall("PUT", edit, { costUsd: 9.99, launchedSessions: 0 });
    assert.equal(tooLow.status, 409);
    assert.match(tooLow.body.error, /already spent or committed \$10\.00/);
    assert.equal(h.threads.get(h.owner, thread.id).usage!.launchedSessions.limit, null, "a refused budget leaves both limits intact");
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: 14, launchedSessions: null })).status, 200);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 5.13);
    const next = await run(54);
    assert.equal(next.threadBudget.costBudgetUsd, 4);
    assert.equal(h.db.getSession(next.sessionId)!.costBudgetUsd, 4);
    assert.deepEqual(h.threads.get(h.owner, thread.id).usage, {
      costUsd: { used: 1.13, limit: 14 }, launchedSessions: { used: 2, limit: null },
    });
  } finally { await h.close(); }
});

test("pausing thread launches preserves the limit and blocks launch until the owner resumes", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const edit = `/api/assistant-threads/${thread.id}/limits`;
    const env = await h.provision(thread.sessionId);
    const run = async (id: number) => resultOf((await h.callTools(env, launch(id, h.location.id)))[0]);

    const paused = await h.ownerCall("PUT", edit, { costUsd: null, launchedSessions: 1, launchPaused: true });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.thread.launchPaused, true);
    assert.deepEqual(paused.body.thread.usage.launchedSessions, { used: 0, limit: 1 });
    assert.match(paused.body.thread.launchLimitRefusal, /paused new launches/);
    assert.match((await run(55)).error, /paused new launches/);

    const legacyEdit = await h.ownerCall("PUT", edit, { costUsd: null, launchedSessions: 1 });
    assert.equal(legacyEdit.body.thread.launchPaused, true);
    assert.match((await run(56)).error, /paused new launches/);

    const resumed = await h.ownerCall("PUT", edit, { costUsd: null, launchedSessions: 1, launchPaused: false });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.thread.launchPaused, false);
    assert.equal(resumed.body.thread.launchLimitRefusal, undefined);
    assert.deepEqual(resumed.body.thread.usage.launchedSessions, { used: 0, limit: 1 });
    assert.ok((await run(57)).sessionId);
    assert.match((await run(58)).error, /1 of the 1 sessions/);

    const pausedUnlimited = await h.ownerCall("PUT", edit, { costUsd: null, launchedSessions: null, launchPaused: true });
    assert.equal(pausedUnlimited.status, 200);
    assert.equal(pausedUnlimited.body.thread.usage.launchedSessions.limit, null);
    assert.match((await run(59)).error, /paused new launches/);
  } finally { await h.close(); }
});

test("removing a thread budget removes implicit caps and keeps explicitly requested caps", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const edit = `/api/assistant-threads/${thread.id}/limits`;
    const env = await h.provision(thread.sessionId);
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: null, launchedSessions: 2 })).status, 200);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, null);
    assert.ok(h.toRunner.some((message) => message.type === "rearm_governance" &&
      message.sessionId === thread.sessionId && message.config.costBudgetUsd === null));
    const unbounded = resultOf((await h.callTools(env, launch(61, h.location.id)))[0]);
    assert.equal(unbounded.threadBudget.costBudgetUsd, null);
    assert.match(unbounded.threadBudget.explanation, /thread has no budget and none was requested/);
    assert.equal(h.db.getSession(unbounded.sessionId)!.costBudgetUsd, null);
    const explicit = launch(62, h.location.id);
    Object.assign(explicit.params.arguments, { config: { costBudgetUsd: 7.50 } });
    const capped = resultOf((await h.callTools(env, explicit))[0]);
    assert.equal(h.db.getSession(capped.sessionId)!.costBudgetUsd, 7.50);
    assert.equal(capped.threadBudget, undefined);
    assert.match(resultOf((await h.callTools(env, launch(63, h.location.id)))[0]).error, /2 of the 2 sessions/);

    const refused = await h.ownerCall("PUT", edit, { costUsd: 20, launchedSessions: null });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /work launched without a cost cap/);
    // A root capped later can still have descendants launched before it acquired that cap.
    assert.equal(h.svc.setConfig(unbounded.sessionId, { costBudgetUsd: 5 }).ok, true);
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: 20, launchedSessions: null })).status, 409);
    h.db.deleteSession(unbounded.sessionId);
    // A capped launch might predate allowance persistence. Its current cap is still proof.
    h.db.raw().prepare("UPDATE assistant_thread_members SET allowance_usd=NULL WHERE session_id=?").run(capped.sessionId);
    const restored = await h.ownerCall("PUT", edit, { costUsd: 20, launchedSessions: null });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 12.50);
    assert.equal(restored.body.thread.usage.launchedSessions.used, 2, "deletion does not refund a launch");
  } finally { await h.close(); }
});

test("raising an exhausted $25 Assistant guardrail updates the thread budget and allows the next launch", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const run = async (id: number) => resultOf((await h.callTools(env, launch(id, h.location.id)))[0]);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=5 WHERE id=?").run(thread.sessionId);
    assert.equal((await run(110)).threadBudget.costBudgetUsd, 20);
    assert.match((await run(111)).error, /whole \$25 budget/);
    const actor = { kind: "human" as const, id: h.owner.userId };
    assert.equal(h.svc.setConfig(thread.sessionId, { costBudgetUsd: 250 }, { kind: "agent", id: "child" }).status, 403);
    const refused = h.svc.setConfig(thread.sessionId, { costBudgetUsd: 24.99, maxToolCalls: 7 }, actor);
    assert.equal(refused.status, 409);
    assert.match(refused.error!, /already spent or committed \$25\.00/);
    assert.equal(h.db.getSession(thread.sessionId)?.maxToolCalls, null);
    assert.equal(h.threads.get(h.owner, thread.id).usage?.costUsd.limit, 25);
    const raised = h.svc.setConfig(thread.sessionId, { costBudgetUsd: 250 }, actor);
    assert.equal(raised.ok, true, raised.error ?? "");
    assert.equal(raised.data?.assistantThreadBudget?.limitUsd, 250);
    const next = await run(112);
    assert.equal(next.receipt.status, "succeeded", JSON.stringify(next));
    assert.equal(next.threadBudget.costBudgetUsd, 225);
    assert.equal(h.threads.get(h.owner, thread.id).usage?.costUsd.limit, 250);
  } finally { await h.close(); }
});

test("clearing the backing Assistant's guardrail removes the thread budget across later launches", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const run = async (id: number) => resultOf((await h.callTools(env, launch(id, h.location.id)))[0]);
    assert.equal((await run(113)).threadBudget.costBudgetUsd, 25);
    assert.match((await run(114)).error, /whole \$25 budget/);
    const cleared = h.svc.setConfig(thread.sessionId, { costBudgetUsd: 0 }, { kind: "human", id: h.owner.userId });
    assert.equal(cleared.ok, true, cleared.error ?? "");
    assert.equal((await run(115)).threadBudget.costBudgetUsd, null);
    assert.equal(h.db.getSession(thread.sessionId)?.costBudgetUsd, null);
    assert.equal(h.threads.get(h.owner, thread.id).usage?.costUsd.limit, null);
  } finally { await h.close(); }
});

test("a launch distinguishes a rounded requested cap from a cap applied by the thread budget", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const request = launch(64, h.location.id);
    Object.assign(request.params.arguments, { config: { costBudgetUsd: 7.505 } });
    const launched = resultOf((await h.callTools(env, request))[0]);
    assert.equal(h.db.getSession(launched.sessionId)!.costBudgetUsd, 7.50);
    assert.match(launched.threadBudget.explanation, /requested cost cap was rounded down to \$7\.50/);
  } finally { await h.close(); }
});

test("a thread cannot launch or create an Orchestrator, whose children it could not count", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const orchestrator = { ...launch(5, h.location.id) };
    orchestrator.params.arguments = { ...orchestrator.params.arguments, config: { permissionMode: "orchestrator" } } as typeof orchestrator.params.arguments;
    const refused = resultOf((await h.callTools(env, orchestrator))[0]);
    assert.match(refused.error, /cannot start an Orchestrator/);
    assert.deepEqual(((await h.ownerCall("GET", `/api/assistant-threads/${thread.id}`)).body.thread as AssistantThread).launchedSessionIds, []);
  } finally { await h.close(); }
});

test("a thread cannot schedule work or use owner-only session operations", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const [scheduled] = await h.callTools(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "auto_create", arguments: {} } });
    assert.equal(scheduled.result.isError, true);
    assert.match(scheduled.result.content[0].text, /cannot call auto_create/);
    const issued = h.db.assistantConnections.create(h.owner, "Outside Assistant", { operations: "all", projects: "all" });
    for (const name of ["session_role", "session_adopt", "session_fork"]) {
      assert.throws(() => h.operations.authorize(thread.connectionId!, name, { kind: "fixture", id: name }), /Wollipog Assistant thread cannot call/u, name);
      assert.doesNotThrow(() => h.operations.authorize(issued.connection.id, name, { kind: "fixture", id: name }), name);
    }
    // The same operation is fine for an owner-issued connection.
    assert.equal(h.db.assistantConnections.get(issued.connection.id)!.threadId, undefined);
  } finally { await h.close(); }
});

test("launched caps come out of the assistant's own allowance, and deleting a session refunds nothing", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=1 WHERE id=?").run(thread.sessionId);
    const worker = resultOf((await h.callTools(env, launch(11, h.location.id)))[0]);
    // $1 spent leaves $24 for the worker, and the assistant may now spend only up to $1 in all.
    assert.equal(h.db.getSession(worker.sessionId)!.costBudgetUsd, 24);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 1);
    assert.match(resultOf((await h.callTools(env, launch(12, h.location.id)))[0]).error, /whole \$25 budget/);

    // The worker spends $10 through a child of its own, then both are deleted: the spend stays.
    h.db.createSession({ id: "s_worker_child", parentSessionId: worker.sessionId, runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "Child", driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
    h.db.raw().prepare("UPDATE sessions SET cost_usd=? WHERE id=?").run(6, worker.sessionId);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=? WHERE id=?").run(4, "s_worker_child");
    const spent = () => ((h.db.assistantThreads.costs(thread.id)));
    assert.equal(spent().spentUsd, 11);
    assert.equal(h.svc.delete(worker.sessionId).ok, true);
    assert.equal(spent().spentUsd, 11, "the deleted worker's spend is kept");
    assert.equal(h.svc.delete("s_worker_child").ok, true);
    assert.equal(spent().spentUsd, 11, "a deleted descendant's spend is kept, even after its parent was deleted first");
    const view = (await h.ownerCall("GET", `/api/assistant-threads/${thread.id}`)).body.thread as AssistantThread;
    assert.deepEqual(view.usage?.costUsd, { used: 11, limit: DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd });
    // Deletion freed none of the budget: what the worker spent is still held.
    assert.ok(h.db.assistantThreads.costs(thread.id).launchedHeldUsd >= 10);
  } finally { await h.close(); }
});

const launchWith = (id: number, locationId: string, extra: Record<string, unknown>) => {
  const message = launch(id, locationId);
  message.params.arguments = { ...message.params.arguments, ...extra } as typeof message.params.arguments;
  return message;
};

test("a refused launch reserves nothing, and an unspent deleted launch gives its cap back", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const refused = resultOf((await h.callTools(env, launchWith(21, h.location.id, { agentId: "no-such-agent" })))[0]);
    assert.equal(refused.receipt.status, "failed");
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd, "the backing allowance is untouched");
    const worker = resultOf((await h.callTools(env, launchWith(22, h.location.id, { config: { costBudgetUsd: 10 } })))[0]);
    assert.equal(h.db.getSession(worker.sessionId)!.costBudgetUsd, 10, "the corrected launch gets its full request");
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 15);
    // Deleting the worker before it spent anything releases its cap at the next admission.
    assert.equal(h.svc.delete(worker.sessionId).ok, true);
    const next = resultOf((await h.callTools(env, launch(23, h.location.id)))[0]);
    assert.equal(h.db.getSession(next.sessionId)!.costBudgetUsd, DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 0.01, "the new launch holds the rest; the assistant keeps nothing extra");
  } finally { await h.close(); }
});

test("a deleted descendant's spend stays inside its tree's commitment", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const worker = resultOf((await h.callTools(env, launchWith(31, h.location.id, { config: { costBudgetUsd: 10 } })))[0]);
    h.db.createSession({ id: "s_tree_child", parentSessionId: worker.sessionId, runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "Child", driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
    h.db.raw().prepare("UPDATE sessions SET cost_usd=5 WHERE id=?").run("s_tree_child");
    assert.deepEqual(h.db.assistantThreads.costs(thread.id), { spentUsd: 5, backingSpentUsd: 0, launchedHeldUsd: 10 });
    assert.equal(h.svc.delete("s_tree_child").ok, true);
    assert.deepEqual(h.db.assistantThreads.costs(thread.id), { spentUsd: 5, backingSpentUsd: 0, launchedHeldUsd: 10 });
    const other = resultOf((await h.callTools(env, launch(32, h.location.id)))[0]);
    assert.equal(h.db.getSession(other.sessionId)!.costBudgetUsd, 15, "the other $15 is still available");
  } finally { await h.close(); }
});

test("removing a worker's Machine keeps the thread's spend", async () => {
  const h = await harness();
  try {
    h.db.registerRunner({ runnerId: "r2", hostname: "second", os: "linux", version: "fixture",
      workspaces: [{ id: "w2", name: "Other", path: "/fixture/other" }], agents: [claude] }, Date.now(), PROTOCOL_VERSION);
    const project = h.db.createProject({ name: "Elsewhere" });
    const remote = h.db.addProjectLocation(project.id, { runnerId: "r2", workspaceId: "w2" });
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const worker = resultOf((await h.callTools(env, launch(41, remote.id)))[0]);
    assert.equal(h.db.getSession(worker.sessionId)!.runnerId, "r2");
    h.db.raw().prepare("UPDATE sessions SET cost_usd=7 WHERE id=?").run(worker.sessionId);
    assert.ok(h.db.deleteRunner("r2"));
    assert.equal(h.db.getSession(worker.sessionId), null);
    assert.equal(h.db.assistantThreads.costs(thread.id).spentUsd, 7);
  } finally { await h.close(); }
});

test("a deleted root holds its cap while its tree lives, and released reserves respect the new budget", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const worker = resultOf((await h.callTools(env, launchWith(51, h.location.id, { config: { costBudgetUsd: 10 } })))[0]);
    h.db.createSession({ id: "s_live_child", parentSessionId: worker.sessionId, runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "Child", driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
    assert.equal(h.svc.delete(worker.sessionId).ok, true);
    assert.equal(h.db.assistantThreads.costs(thread.id).launchedHeldUsd, 10, "the child still runs under the deleted root's cap");
    assert.equal(h.svc.delete("s_live_child").ok, true);
    assert.equal(h.db.assistantThreads.costs(thread.id).launchedHeldUsd, 0, "with no member left, only spend is held");

    assert.equal(h.svc.setConfig(thread.sessionId, { costBudgetUsd: 12 }, { kind: "human", id: h.owner.userId }).ok, true);
    const small = resultOf((await h.callTools(env, launchWith(52, h.location.id, { config: { costBudgetUsd: 5 } })))[0]);
    assert.equal(h.db.getSession(small.sessionId)!.costBudgetUsd, 5);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 7, "the new $12 thread budget leaves $7 for the backing session");
    assert.equal(h.svc.delete(small.sessionId).ok, true);
    const next = resultOf((await h.callTools(env, launchWith(53, h.location.id, { config: { costBudgetUsd: 1 } })))[0]);
    assert.equal(next.receipt.status, "succeeded");
    assert.ok(h.db.getSession(thread.sessionId)!.costBudgetUsd! <= 12, "the owner's ceiling still holds after rebalancing");
  } finally { await h.close(); }
});

test("the owner's $10 budget survives a launch, its deletion and an invalid launch", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    assert.equal(h.svc.setConfig(thread.sessionId, { costBudgetUsd: 10 }, { kind: "human", id: h.owner.userId }).ok, true);
    const first = resultOf((await h.callTools(env, launchWith(61, h.location.id, { config: { costBudgetUsd: 10 } })))[0]);
    const second = resultOf((await h.callTools(env, launchWith(62, h.location.id, { config: { costBudgetUsd: 10 } })))[0]);
    assert.match(second.error, /whole \$10 budget/);
    assert.equal(h.svc.delete(first.sessionId).ok, true);
    const invalid = resultOf((await h.callTools(env, launchWith(63, h.location.id, { agentId: "no-such-agent" })))[0]);
    assert.equal(invalid.receipt.status, "failed");
    assert.ok(h.db.getSession(thread.sessionId)!.costBudgetUsd! <= 10, "the owner's ceiling is never exceeded");
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 10, "and the unspent launches' caps come back up to it");
  } finally { await h.close(); }
});

/** A thread with one launched worker, and agent-created children allowed without an approval card. */
async function treeHarness(workerConfig: Record<string, unknown>) {
  const h = await harness();
  const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
  const env = await h.provision(thread.sessionId);
  const worker = resultOf((await h.callTools(env, launchWith(71, h.location.id, { config: workerConfig })))[0]).sessionId as string;
  h.db.updateSessionStatus(worker, "running", Date.now());
  assert.ok(h.svc.upsertGovernancePolicy({ policyId: "allow-child-spawn", name: "Allow Child Sessions", effect: "allow", priority: 100,
    enabled: true, scope: { toolName: "wollipog.create_session" } }).ok);
  const spawn = (parentSessionId: string, config?: Record<string, unknown>) => {
    const created = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", ...(config ? { config } : {}) },
      undefined, undefined, false, false, false, { parentSessionId });
    if (created.ok) h.db.updateSessionStatus(created.data!.id, "running", Date.now());
    return created;
  };
  const cap = (id: string) => h.db.getSession(id)!.costBudgetUsd!;
  // Every cap in the thread: its backing assistant's and every member of every launched tree's.
  const capsTotal = () => {
    const members = h.db.raw().prepare("SELECT session_id FROM assistant_thread_members WHERE thread_id=?").all(thread.id) as Array<{ session_id: string }>;
    return Math.round((cap(thread.sessionId) + members.reduce((sum, member) => sum + cap(member.session_id), 0)) * 100) / 100;
  };
  return { ...h, thread, env, worker, spawn, cap, capsTotal };
}

test("#4671: a launched worker's children are carved out of its own cap, so the thread's caps total its budget", async () => {
  // Before #4671: backing $15 + worker $10 + two $5 children = $35 of caps under a $25 thread.
  const h = await treeHarness({ costBudgetUsd: 10, maxChildSessions: 2 });
  try {
    assert.equal(h.cap(h.thread.sessionId), 15);
    const first = h.spawn(h.worker), second = h.spawn(h.worker);
    assert.ok(first.ok && second.ok, first.error ?? second.error ?? "");
    // Each default child takes one share, and the worker keeps one for its own spending.
    assert.equal(first.data!.costBudgetUsd, 3.33);
    assert.equal(second.data!.costBudgetUsd, 3.33);
    assert.equal(h.cap(h.worker), 3.34);
    assert.equal(h.capsTotal(), DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
    assert.equal(h.db.assistantThreads.costs(h.thread.id).launchedHeldUsd, 10, "the tree still holds its whole launched cap");

    // Another launch must not reclaim what the carved worker gave its children.
    const another = resultOf((await h.callTools(h.env, launchWith(72, h.location.id, { config: { costBudgetUsd: 1 } })))[0]);
    assert.equal(another.receipt.status, "succeeded", JSON.stringify(another));
    assert.equal(h.cap(h.thread.sessionId), 14);
    assert.equal(h.db.assistantThreads.costs(h.thread.id).launchedHeldUsd, 11);
    assert.equal(h.capsTotal(), DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);

    // Deleting the carved worker while its children run keeps their part held too.
    assert.equal(h.svc.delete(h.worker).ok, true);
    assert.equal(h.db.assistantThreads.costs(h.thread.id).launchedHeldUsd, 11);
    const after = resultOf((await h.callTools(h.env, launchWith(73, h.location.id, {})))[0]);
    assert.equal(after.receipt.status, "succeeded", JSON.stringify(after));
    assert.equal(h.cap(after.sessionId), 14, "only the backing assistant's unheld $14 is launched");
    assert.equal(h.cap(h.thread.sessionId), 0.01);
  } finally { await h.close(); }
});

test("#4671: children created anywhere in a thread's tree never take the caps above its budget", async () => {
  const h = await treeHarness({ costBudgetUsd: 10 });
  try {
    // Three generations below the worker, each session creating a default child and a $2 request.
    const created: string[] = [];
    let generation = [h.worker];
    for (let depth = 0; depth < 3; depth++) {
      const next: string[] = [];
      for (const parent of generation) {
        for (const config of [{ maxChildSessions: 2 }, { costBudgetUsd: 2, maxChildSessions: 2 }]) {
          const child = h.spawn(parent, config);
          assert.ok(child.ok, child.error ?? "");
          created.push(child.data!.id);
          next.push(child.data!.id);
          assert.ok(h.capsTotal() <= DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd + 1e-9, `caps total ${h.capsTotal()} after ${created.length} children`);
        }
      }
      generation = next;
    }
    assert.equal(created.length, 14);
    // Every creation moved cents from its creator to the child, so nothing was lost or added.
    assert.equal(h.capsTotal(), DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
    for (const id of created) assert.ok(h.cap(id) >= 0.01, "every child is capped");
  } finally { await h.close(); }
});

test("#4671: a fully reserved creator is refused clearly, and a finished child's unspent cap comes back", async () => {
  const h = await treeHarness({ costBudgetUsd: 10, maxChildSessions: 2 });
  try {
    const child = h.spawn(h.worker, { costBudgetUsd: 3 });
    assert.ok(child.ok, child.error ?? "");
    assert.equal(h.cap(h.worker), 7);
    // The worker spends what it kept: nothing is left to share with another child.
    h.db.addSessionUsage(h.worker, { costUsd: 7 }, Date.now());
    const refused = h.spawn(h.worker);
    assert.equal(refused.status, 409);
    assert.match(refused.error ?? "", /insufficient remaining budget to create a child: \$0\.00 of its \$10\.00 cost budget/);
    assert.match(refused.error ?? "", /Wollipog Assistant thread, whose budget its whole session tree shares/);
    assert.equal(h.capsTotal(), DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd, "the refusal reserved nothing");

    // The child finishes having spent $1: its unspent $2 returns to the worker at the next creation.
    h.db.addSessionUsage(child.data!.id, { costUsd: 1 }, Date.now());
    h.svc.onSessionStatus(child.data!.id, "completed");
    const next = h.spawn(h.worker);
    assert.ok(next.ok, next.error ?? "");
    assert.equal(next.data!.costBudgetUsd, 0.66, "($10 - $7 spent - $1 charged) shared with the worker");
    assert.equal(h.cap(h.worker), 8.34, "$10 less the finished child's $1 and the new child's $0.66");
  } finally { await h.close(); }
});

test("#4671: restarting a finished child takes its unspent cap back out of its creator's", async () => {
  const h = await treeHarness({ costBudgetUsd: 10, maxChildSessions: 2 });
  try {
    const child = h.spawn(h.worker, { costBudgetUsd: 3 });
    assert.ok(child.ok, child.error ?? "");
    h.db.addSessionUsage(child.data!.id, { costUsd: 1 }, Date.now());
    h.svc.onSessionStatus(child.data!.id, "stopped");
    // While the worker has spent most of what it kept, it cannot cover the child's unspent $2.
    h.db.addSessionUsage(h.worker, { costUsd: 7.5 }, Date.now());
    const refused = h.svc.restart(child.data!.id);
    assert.equal(refused.status, 409);
    assert.match(refused.error ?? "", /restarting this child re-reserves \$2\.00/);
    assert.equal(h.cap(h.worker), 9, "the refusal only settled the finished child's $1");

    const other = await treeHarness({ costBudgetUsd: 10, maxChildSessions: 2 });
    try {
      const finished = other.spawn(other.worker, { costBudgetUsd: 3 });
      assert.ok(finished.ok, finished.error ?? "");
      other.db.addSessionUsage(finished.data!.id, { costUsd: 1 }, Date.now());
      other.svc.onSessionStatus(finished.data!.id, "stopped");
      const restarted = other.svc.restart(finished.data!.id);
      assert.ok(restarted.ok, restarted.error ?? "");
      assert.equal(other.cap(other.worker), 7, "the restarted child holds its $3 again");
      assert.equal(other.capsTotal(), DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
    } finally { await other.close(); }
  } finally { await h.close(); }
});

test("#4671: the owner's lower cap on a worker is kept, and agents cannot raise a tree member's cap", async () => {
  const h = await treeHarness({ costBudgetUsd: 10 });
  try {
    assert.ok(h.svc.setConfig(h.worker, { costBudgetUsd: 6 }).ok);
    const child = h.spawn(h.worker, { costBudgetUsd: 1 });
    assert.ok(child.ok, child.error ?? "");
    assert.equal(h.cap(h.worker), 6, "$10 - $1 = $9 would exceed the owner's $6");
    const agent = { kind: "agent" as const, id: h.worker };
    const raised = h.svc.setConfig(child.data!.id, { costBudgetUsd: 50 }, agent);
    assert.equal(raised.status, 403);
    assert.match(raised.error ?? "", /An agent may only lower its cost budget/);
    assert.equal(h.svc.setConfig(child.data!.id, { costBudgetUsd: 0 }, agent).status, 403, "nor clear it");
    assert.ok(h.svc.setConfig(child.data!.id, { costBudgetUsd: 0.5 }, agent).ok, "lowering is allowed");
  } finally { await h.close(); }
});
