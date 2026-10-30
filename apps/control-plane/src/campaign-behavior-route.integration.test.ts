/** #3580, live on 2026-10-30: a Full Control campaign launched with Codex children could not move to
 * Claude Code children, because nothing changed a running campaign's Child Harness. This drives the
 * real control plane process and HTTP routes, with a synthetic runner, through that change. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, canonicalAgentHarnessIdentity, PROTOCOL_VERSION, WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  type AgentCapabilities, type AgentHarnessIdentity, type CampaignControl, type OrchestratorCampaignBehavior,
  type OrchestratorCampaignBehaviorView, type OrchestratorCampaignProjection, type RunnerMetadata, type SessionView } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { campaignBoundaryCurrent } from "./campaign-authority.js";
import { ControlPlaneDb } from "./db.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "runner-campaign-behavior";
const WORKSPACE_ID = "workspace-campaign-behavior";
const RUNNER_TOKEN = `wollipogr_${"b".repeat(43)}`;
const DEVICE_TOKEN = "device-campaign-behavior";
const AGENT_TOKEN = "agent_campaign_behavior_orchestrator_token";
const REPOSITORY = "picoduck/wollipog";
/** A Custom campaign with Codex children, one already running, and a nested Orchestrator. */
const ROOT = "campaign-behavior-root";
const EXISTING = "campaign-behavior-existing-child";
const NESTED = "campaign-behavior-nested";
/** A current Full Control campaign whose children are fixed to Codex. */
const FULL = "campaign-behavior-full-control";
/** A campaign from before #3247: its fixed Child Harness admits only the exact `codex-agent` row. */
const LEGACY = "campaign-behavior-legacy-exact-row";
/** Another such campaign, which moves to a different harness. */
const LEGACY_SWITCH = "campaign-behavior-legacy-switch";

const CODEX: AgentHarnessIdentity = { agentId: "codex-agent", driver: "codex-app-server", context: { kind: "native" } };
const CLAUDE: AgentHarnessIdentity = { agentId: "claude-agent", driver: "claude-code", context: { kind: "native" } };
/** How the server stores a chosen built-in harness, as it does a saved default. */
const CLAUDE_STORED = canonicalAgentHarnessIdentity(CLAUDE);
const LAUNCHED: OrchestratorCampaignBehavior = { childHarness: CODEX, childModel: "gpt-5.5", childEffort: "high",
  followUps: "recommend_only", completion: "retain" };
const CHANGED: OrchestratorCampaignBehavior = { childHarness: CLAUDE, childModel: "claude-opus-5-5", childEffort: "medium",
  followUps: "execute_approved", completion: "stop_and_archive" };

function capabilities(model: string): AgentCapabilities {
  return { models: [{ id: model, displayName: model, efforts: ["low", "medium", "high"] }], effortLevels: ["low", "medium", "high"],
    slashCommands: [], supportsImages: true, supportsApprovals: true };
}

function runnerMetadata(): RunnerMetadata {
  return { runnerId: RUNNER_ID, hostname: "campaign-behavior-host", os: "linux", version: "integration",
    workspaces: [{ id: WORKSPACE_ID, name: "Wollipog", path: "/workspace" }],
    agents: [
      { id: "claude-agent", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" },
        available: true, capabilities: capabilities("claude-opus-5-5") },
      { id: "codex-agent", name: "Codex", command: "codex", args: ["app-server"], env: {}, driver: "codex-app-server", context: { kind: "native" },
        available: true, capabilities: capabilities("gpt-5.5") },
      // Another row of the same harness, which only it offers gpt-5.4 from (CR-2.1).
      { id: "codex-other", name: "Codex (Other)", command: "codex", args: ["app-server"], env: {}, driver: "codex-app-server", context: { kind: "native" },
        available: true, capabilities: capabilities("gpt-5.4") },
    ] };
}

function seed(database: string): void {
  const db = ControlPlaneDb.open(database);
  try {
    const now = Date.now();
    const identity = db.localIdentityContext();
    const scope = { organizationId: identity.organizationId, owner: { kind: "user" as const, userId: identity.userId } };
    db.registerRunner(runnerMetadata(), now, PROTOCOL_VERSION);
    db.issueRunnerCredential({ credentialId: `rcred_${"behavior".padEnd(32, "0")}`, runnerId: RUNNER_ID, organizationId: identity.organizationId,
      ownerKind: "organization", ownerId: identity.organizationId, label: "Campaign behavior route fixture",
      tokenHash: hashToken(RUNNER_TOKEN), createdByUserId: identity.userId, now, expiresAt: now + 120_000 });
    db.createDevice({ id: "device-campaign-behavior", name: "Owner Browser", tokenHash: hashToken(DEVICE_TOKEN), userId: identity.userId,
      organizationId: identity.organizationId, now });
    const launched = () => resolveOrchestratorCampaignPolicy({ ...DEFAULT_ORCHESTRATOR_DEFAULTS,
      behavior: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.behavior, ...structuredClone(LAUNCHED) } }, "user_default");
    const orchestrator = (id: string, policy: ReturnType<typeof launched>, parentSessionId?: string) => {
      db.createSession({ id, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "claude-agent", title: id, useWorktree: false,
        driver: "claude-code", config: { permissionMode: "orchestrator" }, role: "orchestrator", orchestratorPolicy: policy,
        creationActor: parentSessionId ? "agent" : "human", ...(parentSessionId ? { parentSessionId } : {}),
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } }, scope, now });
      db.updateSessionStatus(id, "running", now + 1);
    };
    orchestrator(ROOT, launched());
    assert.equal(db.setAgentControlCredential(ROOT, RUNNER_ID, hashToken(AGENT_TOKEN), now + 2), true);
    db.createSession({ id: EXISTING, parentSessionId: ROOT, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "codex-agent",
      title: EXISTING, useWorktree: false, driver: "codex-app-server", config: { model: "gpt-5.5", effort: "high" }, creationActor: "agent", scope, now });
    db.updateSessionStatus(EXISTING, "idle", now + 1);
    const nested = launched();
    for (const key of Object.keys(nested.sources.behavior) as Array<keyof typeof nested.sources.behavior>) nested.sources.behavior[key] = "active_campaign";
    orchestrator(NESTED, nested, ROOT);

    const full = launched();
    full.issueScope = { repository: REPOSITORY, issueNumbers: [3580], revision: 1, authorizedByUserId: identity.userId, authorizedAt: now };
    full.issueNumbers = [3580];
    const budgetAuthority = { version: 1 as const, concurrency: 3, acceptedFollowUps: 0, accounting: "managed_workers_only" as const, unpriced: "stop" as const };
    full.control = { mode: "full_control", boundary: { version: 1, revision: 1, issueScopeRevision: 1, repository: REPOSITORY,
      objective: "Deliver #3580", authorizedByUserId: identity.userId, authorizedAt: now,
      operations: ["implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval",
        "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"], delegatablePolicyIds: [],
      issueAuthority: { epics: [3580], relatedFollowUps: false, maxIssues: 1, closureReasons: ["completed"] }, budgetAuthority } };
    orchestrator(FULL, full);
    for (const id of [LEGACY, LEGACY_SWITCH]) {
      const legacy = launched();
      delete legacy.childHarnessMatch;
      orchestrator(id, legacy);
    }
    db.raw().prepare("UPDATE sessions SET parent_control_policy_revision=1 WHERE id=?").run(FULL);
    db.campaignBudgets.authorize(FULL, budgetAuthority);
    db.updateSessionStatus(FULL, "idle", now + 2);
  } finally { db.close(); }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((done) => child.once("exit", () => done())), delay(3_000)]);
}

async function startControlPlane(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), "wollipog-campaign-behavior-"));
  const database = join(temp, "control-plane.db");
  const port = await reservePort();
  seed(database);
  let logs = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port), CONTROL_PLANE_DB: database,
      CONTROL_PLANE_LOCAL_TOKEN_FILE: join(temp, "local-device.token") },
  });
  const capture = (chunk: unknown) => { logs = (logs + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let runner: WebSocket | null = null;
  t.after(async () => { runner?.close(); await stopChild(child); rmSync(temp, { recursive: true, force: true }); });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* Startup races are expected. */ }
    if (Date.now() > deadline) throw new Error(`control plane did not become healthy:\n${logs}`);
    await delay(50);
  }
  runner = new WebSocket(`ws://127.0.0.1:${port}/runner`);
  const messages: Array<Record<string, unknown>> = [];
  runner.addEventListener("message", (event) => {
    if (typeof event.data === "string") messages.push(JSON.parse(event.data) as Record<string, unknown>);
  });
  await new Promise<void>((done, reject) => {
    runner!.addEventListener("open", () => done(), { once: true });
    runner!.addEventListener("error", () => reject(new Error("runner websocket failed to open")), { once: true });
  });
  const snapshot = (id: string, status: "running" | "idle", agentId = "claude-agent", driver: "claude-code" | "codex-app-server" = "claude-code",
    config: Record<string, string> = { permissionMode: "orchestrator" }) => ({ id, workspaceId: WORKSPACE_ID, agentId, title: id, status,
    driver, useWorktree: false, worktreePath: null, config, preview: null, pendingApproval: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, seq: 0, historyEpoch: 0, createdAt: 1, updatedAt: 1 });
  runner.send(JSON.stringify({ type: "register", token: RUNNER_TOKEN, protocolVersion: PROTOCOL_VERSION, runner: runnerMetadata(),
    sessionSnapshots: [snapshot(ROOT, "running"), snapshot(NESTED, "running"), snapshot(FULL, "idle"), snapshot(LEGACY, "running"), snapshot(LEGACY_SWITCH, "running"),
      snapshot(EXISTING, "idle", "codex-agent", "codex-app-server", { model: "gpt-5.5", effort: "high" })] }));
  for (let waited = 0; !messages.some((message) => message.type === "registered"); waited += 25) {
    if (waited > 10_000) throw new Error(`runner was not registered:\n${logs}`);
    await delay(25);
  }
  const call = (token: string, agent: boolean) => async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(agent ? { [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: ROOT } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* Not every refusal has a body. */ }
    return { status: response.status, json, text };
  };
  const next = async (predicate: (message: Record<string, unknown>) => boolean, what: string) => {
    for (let waited = 0; ; waited += 25) {
      const found = messages.find(predicate);
      if (found) return found;
      if (waited > 10_000) throw new Error(`timed out waiting for ${what}:\n${logs}`);
      await delay(25);
    }
  };
  return { database, human: call(DEVICE_TOKEN, false), orchestrator: call(AGENT_TOKEN, true), messages, next,
    send: (message: unknown) => runner!.send(JSON.stringify(message)), logs: () => logs };
}

function session(database: string, id: string): SessionView {
  const db = ControlPlaneDb.open(database);
  try { return db.getSession(id)!; } finally { db.close(); }
}

function expectOk(response: { status: number; text: string }, what: string, logs: () => string): void {
  assert.ok(response.status < 300, `${what}: ${response.status} ${response.text}\n${logs()}`);
}

test("a person changes a running campaign's Child Harness, Model, Effort, Follow-Ups and Completion through the real routes", { timeout: 60_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const path = `/api/sessions/${ROOT}/orchestrator-campaign/behavior`;

  // No agent can read or change it, the Orchestrator included.
  for (const response of [await cp.orchestrator(path), await cp.orchestrator(path, { expectedRevision: 0, behavior: CHANGED })]) {
    assert.ok(response.status === 401 || response.status === 403, `${response.status} ${response.text}`);
  }
  // The form reads the campaign's values with what the person's machines offer for them.
  const view = await cp.human(path);
  expectOk(view, "behavior view", cp.logs);
  const form = view.json as unknown as OrchestratorCampaignBehaviorView;
  assert.equal(form.revision, 0);
  assert.deepEqual(form.behavior, LAUNCHED);
  assert.equal(form.sources.childHarness, "user_default");
  assert.deepEqual(form.capabilities.harnesses?.map((harness) => harness.driver).sort(), ["claude-code", "codex-app-server"]);

  // A stale revision, a nested Orchestrator and a combination no machine offers are refused.
  const stale = await cp.human(path, { expectedRevision: 1, behavior: CHANGED });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, "Campaign behavior changed; refresh and try again.");
  const nested = await cp.human(`/api/sessions/${NESTED}/orchestrator-campaign/behavior`, { expectedRevision: 0, behavior: CHANGED });
  assert.equal(nested.status, 409, nested.text);
  assert.match(String(nested.json.error), /inherits its campaign's behavior/);
  const unoffered = await cp.human(path, { expectedRevision: 0, behavior: { ...CHANGED, childModel: "gpt-5.5" } });
  assert.equal(unoffered.status, 409, unoffered.text);
  const malformed = await cp.human(path, { expectedRevision: 0, behavior: { ...CHANGED, maximumConcurrentChildren: 9 } });
  assert.equal(malformed.status, 400, malformed.text);
  assert.equal(session(cp.database, ROOT).orchestratorPolicy!.behaviorRevision, undefined, "nothing changed");

  const decisionRevision = session(cp.database, ROOT).parentControlPolicy!.revision;
  const changed = await cp.human(path, { expectedRevision: 0, behavior: CHANGED });
  expectOk(changed, "change", cp.logs);
  const root = session(cp.database, ROOT);
  const policy = root.orchestratorPolicy!;
  assert.deepEqual({ childHarness: policy.behavior.childHarness, childModel: policy.behavior.childModel, childEffort: policy.behavior.childEffort,
    followUps: policy.behavior.followUps, completion: policy.behavior.completion }, { ...CHANGED, childHarness: CLAUDE_STORED });
  for (const key of ["childHarness", "childModel", "childEffort", "followUps", "completion"] as const) {
    assert.equal(policy.sources.behavior[key], "active_campaign", key);
  }
  assert.equal(policy.sources.behavior.maximumConcurrentChildren, "user_default", "an unchanged value keeps its source");
  assert.equal(policy.behaviorRevision, 1);
  assert.equal(root.parentControlPolicy!.revision, decisionRevision, "the decision-owner revision is a separate one");
  // The same request again is now stale.
  assert.equal((await cp.human(path, { expectedRevision: 0, behavior: CHANGED })).status, 409);

  // The nested Orchestrator inherits the new values.
  const inherited = session(cp.database, NESTED).orchestratorPolicy!;
  assert.deepEqual(inherited.behavior.childHarness, CLAUDE_STORED);
  assert.equal(inherited.behavior.childModel, "claude-opus-5-5");
  assert.equal(inherited.behaviorRevision, 1);

  // get_campaign reports them, with their source.
  const campaign = await cp.orchestrator(`/api/sessions/${ROOT}/orchestrator-campaign`);
  expectOk(campaign, "get_campaign", cp.logs);
  const projected = (campaign.json as unknown as OrchestratorCampaignProjection).behavior!;
  assert.deepEqual({ ...projected, revision: undefined, sources: undefined }, { ...CHANGED, childHarness: CLAUDE_STORED, revision: undefined, sources: undefined });
  assert.equal(projected.revision, 1);
  assert.equal(projected.sources.childHarness, "active_campaign");

  // create_session admits the new fixed values and refuses the old ones.
  const create = (body: Record<string, unknown>) => cp.orchestrator("/api/sessions",
    { runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, useWorktree: false, ...body });
  const oldHarness = await create({ agentId: "codex-agent", prompt: "Implement the next slice" });
  assert.equal(oldHarness.status, 409, oldHarness.text);
  assert.match(String(oldHarness.json.error), /child harness is fixed by campaign policy/);
  const oldModel = await create({ agentId: "claude-agent", prompt: "Implement the next slice", config: { model: "gpt-5.5" } });
  assert.equal(oldModel.status, 409, oldModel.text);
  assert.equal(oldModel.json.error, "child model is fixed by campaign policy at claude-opus-5-5");
  const oldEffort = await create({ agentId: "claude-agent", prompt: "Implement the next slice", config: { effort: "high" } });
  assert.equal(oldEffort.status, 409, oldEffort.text);
  assert.equal(oldEffort.json.error, "child effort is fixed by campaign policy at medium");
  const created = await create({ agentId: "claude-agent", prompt: "Implement the next slice" });
  assert.equal(created.status, 201, `${created.text}\n${cp.logs()}`);
  const child = created.json as unknown as SessionView;
  assert.equal(child.agentId, "claude-agent");
  assert.equal(child.model, "claude-opus-5-5");
  assert.equal(child.effort, "medium");
  // The server-derived policy block of its assignment names the new values.
  const launch = await cp.next((message) => message.type === "start_session" &&
    (message.spec as { sessionId?: string } | undefined)?.sessionId === child.id, "the new child's launch");
  assert.match(JSON.stringify(launch), /Child Model claude-opus-5-5; Child Effort medium; Follow-Ups execute_approved; Completion stop_and_archive/);

  // The existing child keeps its launched configuration, and can still restate it, but not pick another.
  const existing = session(cp.database, EXISTING);
  assert.equal(existing.agentId, "codex-agent");
  assert.equal(existing.model, "gpt-5.5");
  assert.equal(existing.effort, "high");
  expectOk(await cp.human(`/api/sessions/${EXISTING}/prompt`, { text: "Carry on", config: { model: "gpt-5.5", effort: "high" } }),
    "the existing child's own model", cp.logs);
  const switched = await cp.human(`/api/sessions/${EXISTING}/prompt`, { text: "Carry on", config: { model: "gpt-5.4" } });
  assert.equal(switched.status, 409, switched.text);
  assert.match(String(switched.json.error), /child model is fixed by campaign policy at claude-opus-5-5/);
});

test("changing a Full Control campaign's Child Harness keeps its boundary, so it stays promptable and restartable", { timeout: 60_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const before = session(cp.database, FULL);
  const boundary = structuredClone((before.orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>).boundary);
  assert.equal(campaignBoundaryCurrent(before), true);

  expectOk(await cp.human(`/api/sessions/${FULL}/orchestrator-campaign/behavior`, { expectedRevision: 0, behavior: CHANGED }), "change", cp.logs);
  const after = session(cp.database, FULL);
  assert.deepEqual(after.orchestratorPolicy!.behavior.childHarness, CLAUDE_STORED);
  assert.deepEqual((after.orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>).boundary, boundary,
    "the boundary, and the follow-up and issue limits it authorized, are unchanged");
  assert.equal(after.parentControlPolicy!.revision, before.parentControlPolicy!.revision);
  assert.equal(campaignBoundaryCurrent(after), true, "no stale-boundary lockout");

  expectOk(await cp.human(`/api/sessions/${FULL}/prompt`, { text: "Continue with Claude Code children" }), "prompt", cp.logs);
  expectOk(await cp.human(`/api/sessions/${FULL}/stop`, {}), "stop", cp.logs);
  const stop = await cp.next((message) => message.type === "stop_session" && message.sessionId === FULL, "the stop");
  cp.send({ type: "stop_session_result", sessionId: FULL, operationId: stop.operationId, deliveryAttemptId: stop.deliveryAttemptId, accepted: true });
  for (let waited = 0; session(cp.database, FULL).status !== "stopped"; waited += 25) {
    assert.ok(waited < 10_000, "the stop settles");
    await delay(25);
  }
  expectOk(await cp.human(`/api/sessions/${FULL}/restart`, {}), "restart", cp.logs);
  await cp.next((message) => message.type === "start_session" && JSON.stringify(message).includes(FULL), "the restart's launch");
  expectOk(await cp.human(`/api/sessions/${FULL}/prompt`, { text: "Resume" }), "prompt after restart", cp.logs);
  assert.equal(campaignBoundaryCurrent(session(cp.database, FULL)), true);
});

test("an exact-row campaign that keeps its harness is offered and validated only against the row it keeps (CR-2.1, CR-3.1)", { timeout: 60_000 }, async (t) => {
  const cp = await startControlPlane(t);
  const path = `/api/sessions/${LEGACY}/orchestrator-campaign/behavior`;
  // The form gets the full catalog for Automatic and other harnesses, and the kept row's own entry for
  // a change that keeps the harness.
  const view = await cp.human(path);
  expectOk(view, "behavior view", cp.logs);
  const form = view.json as unknown as OrchestratorCampaignBehaviorView;
  const codex = form.capabilities.harnesses!.find((harness) => harness.driver === "codex-app-server")!;
  assert.deepEqual(codex.models.map((model) => model.id).sort(), ["gpt-5.4", "gpt-5.5"]);
  assert.equal(form.retainedRow?.driver, "codex-app-server");
  assert.deepEqual(form.retainedRow?.models.map((model) => model.id), ["gpt-5.5"]);
  // A model only the other row offers is refused: no child could be created with it.
  const refused = await cp.human(path, { expectedRevision: 0, behavior: { ...LAUNCHED, childModel: "gpt-5.4" } });
  assert.equal(refused.status, 409, refused.text);
  const unchanged = session(cp.database, LEGACY).orchestratorPolicy!;
  assert.equal(unchanged.behavior.childModel, "gpt-5.5");
  assert.equal(unchanged.behaviorRevision, undefined);
  assert.equal("childHarnessMatch" in unchanged, false);
  // Automatic admits every row again, so the same model is admitted without a fixed harness (CR-3.1).
  const automatic = await cp.human(path, { expectedRevision: 0, behavior: { ...LAUNCHED, childHarness: null, childModel: "gpt-5.4" } });
  expectOk(automatic, "Automatic harness with the other row's model", cp.logs);
  assert.equal(session(cp.database, LEGACY).orchestratorPolicy!.behavior.childHarness, null);
  // Another harness is validated against its own full catalog.
  const switched = await cp.human(`/api/sessions/${LEGACY_SWITCH}/orchestrator-campaign/behavior`,
    { expectedRevision: 0, behavior: { ...CHANGED, followUps: LAUNCHED.followUps, completion: LAUNCHED.completion } });
  expectOk(switched, "another harness", cp.logs);
  assert.equal(session(cp.database, LEGACY_SWITCH).orchestratorPolicy!.childHarnessMatch, "harness");
  // A harness-matched campaign may use the other row, so there the same model is admitted.
  const root = await cp.human(`/api/sessions/${ROOT}/orchestrator-campaign/behavior`,
    { expectedRevision: 0, behavior: { ...LAUNCHED, childModel: "gpt-5.4" } });
  expectOk(root, "harness-matched change", cp.logs);
});
