import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  type CampaignLaunchPreflight,
  type ControlPlaneToRunner,
  type FullControlLaunchRequest,
  type ProviderAccountDefinition,
  type ResourceScope,
  type RunnerMetadata,
} from "@wollipog/protocol";
import { hashToken } from "../../control-plane/src/auth.js";
import { ControlPlaneDb } from "../../control-plane/src/db.js";
import { executeManagerTool, type McpDeps } from "./session-management-mcp.js";

// #2940: a Full Control root is user-owned, so its campaign allowance and controlled review charge
// the authorizing Human. Its own agent credential is therefore delegated as that user, and on the
// first live run it could not see the organization's runner it was launched on: list_runners was
// empty, get_agent_capabilities could not find the installation and create_session answered 404,
// so the campaign failed before its first child (#3676). This drives the real control plane: an
// organization administrator launches through the Full Control route on an organization runner,
// and the root, its child and that child's child use their own credentials through the real
// Session Management tools. Without the fix this fails at the root's first list_runners.

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER = "org-runner";
const WORKSPACE = "repo";
/** A workspace on the organization runner that belongs to one colleague alone. */
const PEER_WORKSPACE = "colleague-private";
const AGENT = "claude";
const MODEL = "claude-opus-5-5";
const ADMIN_TOKEN = "full-control-admin-device-token";
const OPERATOR_TOKEN = "full-control-operator-device-token";
const RUNNER_TOKEN = `wollipogr_${"f".repeat(43)}`;
const PRICING_URL = "http://127.0.0.1:9/fixture-model-rates.json";
const ARBITRARY_PATH_ERROR = "organization owner or admin permission is required to start a session from an arbitrary host path";

function hermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(RUNNER_|CONTROL_PLANE_|WOLLIPOG_)/u.test(key)) delete env[key];
  }
  return env;
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
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await exited;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await delay(20);
  }
}

function runnerMeta(runnerId: string, temp: string, providerAccounts?: ProviderAccountDefinition[]): RunnerMetadata {
  return {
    runnerId, hostname: runnerId, os: "linux", version: "fixture",
    ...(providerAccounts ? { providerAccounts } : {}),
    workspaces: [{ id: WORKSPACE, name: "Repository", path: temp },
      ...(runnerId === RUNNER ? [{ id: PEER_WORKSPACE, name: "Colleague Private", path: join(temp, PEER_WORKSPACE) }] : [])],
    agents: [{ id: AGENT, name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
      context: { kind: "native" }, available: true, authStatus: "authenticated",
      capabilities: { models: [{ id: MODEL, default: true }], effortLevels: ["high"], slashCommands: [],
        permissionModes: ["default", "orchestrator"], supportsImages: true, supportsApprovals: true } }],
    runtime: { dataDir: "/fixture/data", worktreeRoot: "/fixture/data/worktrees", maxConcurrentSessions: 8,
      campaignLaunchInspection: { version: 3 }, executionIsolation: { mode: "provider", network: "inherit" } },
  };
}

/** A real control plane with one online synthetic organization runner, and the identities and
 * Machines both scenarios need. */
async function stack(t: TestContext, providerAccounts?: ProviderAccountDefinition[]) {
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const temp = mkdtempSync(join(tmpdir(), "wollipog-full-control-runner-access-"));
  mkdirSync(join(temp, PEER_WORKSPACE));
  const databasePath = join(temp, "control-plane.db");
  const now = Date.now();
  // Campaign members need a priced model; the source is unroutable, so no real pricing is fetched.
  writeFileSync(join(temp, "usage-model-rates.json"), JSON.stringify({ version: 1, source: PRICING_URL, fetchedAt: now,
    document: { [MODEL]: { input_cost_per_token: 0.000004, output_cost_per_token: 0.00002 } } }));

  const seed = ControlPlaneDb.open(databasePath);
  const local = seed.localIdentityContext();
  const org = local.organizationId;
  const admin = "usr_campaign_admin";
  const operator = "usr_operator";
  const colleague = "usr_colleague";
  const otherOrg = "org_elsewhere";
  let projectId = "";
  try {
    seed.createIdentityMember({ userId: admin, displayName: "Campaign Admin", organizationId: org, role: "admin", now });
    seed.createIdentityMember({ userId: operator, displayName: "Operator", organizationId: org, role: "operator", now });
    seed.createIdentityMember({ userId: colleague, displayName: "Colleague", organizationId: org, role: "operator", now });
    seed.createIdentityTeam({ teamId: "team_mine", organizationId: org, name: "Mine", memberUserIds: [admin], now });
    seed.createIdentityTeam({ teamId: "team_theirs", organizationId: org, name: "Theirs", memberUserIds: [colleague], now });
    seed.raw().prepare("INSERT INTO identity_organizations (organization_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(otherOrg, "Elsewhere", now, now);
    seed.createDevice({ id: "admin-device", name: "Admin", tokenHash: hashToken(ADMIN_TOKEN), userId: admin, organizationId: org, now });
    seed.createDevice({ id: "operator-device", name: "Operator", tokenHash: hashToken(OPERATOR_TOKEN), userId: operator, organizationId: org, now });
    seed.registerRunner(runnerMeta(RUNNER, temp), now, PROTOCOL_VERSION);
    seed.issueRunnerCredential({ credentialId: `rcred_${"fullcontrol".padEnd(32, "0")}`, runnerId: RUNNER, organizationId: org,
      ownerKind: "organization", ownerId: org, label: "Organization Runner", tokenHash: hashToken(RUNNER_TOKEN),
      createdByUserId: local.userId, now, expiresAt: now + 600_000 });
    assert.equal(seed.setResourceScope({ resource: "workspace", runnerId: RUNNER, resourceId: PEER_WORKSPACE,
      scope: { organizationId: org, owner: { kind: "user", userId: colleague } }, now }), true);
    // Machines the administrator can use, and Machines nobody delegated as that user may see.
    const scoped: Array<[string, ResourceScope]> = [
      ["member-runner", { organizationId: org, owner: { kind: "user", userId: admin } }],
      ["my-team-runner", { organizationId: org, owner: { kind: "team", teamId: "team_mine" } }],
      ["colleague-runner", { organizationId: org, owner: { kind: "user", userId: colleague } }],
      ["their-team-runner", { organizationId: org, owner: { kind: "team", teamId: "team_theirs" } }],
      ["elsewhere-runner", { organizationId: otherOrg, owner: { kind: "organization", organizationId: otherOrg } }],
    ];
    for (const [runnerId, scope] of scoped) seed.registerRunner(runnerMeta(runnerId, temp), now, PROTOCOL_VERSION, scope);
    // The registered workspace is the one Location of an organization Project, as on the live run.
    const location = seed.findProjectLocation(RUNNER, WORKSPACE);
    assert.ok(location, "the organization workspace has a Project Location");
    assert.deepEqual(seed.projectScope(location.projectId), { organizationId: org, owner: { kind: "organization", organizationId: org } });
    projectId = location.projectId;
  } finally { seed.close(); }

  let output = "";
  const controlPlane = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT,
    env: { ...hermeticEnv(), CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port), CONTROL_PLANE_DB: databasePath,
      CONTROL_PLANE_USAGE_PRICING_URL: PRICING_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-32_768); };
  controlPlane.stdout?.on("data", capture); controlPlane.stderr?.on("data", capture);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await stopChild(controlPlane);
    rmSync(temp, { recursive: true, force: true });
  });
  let healthy = false;
  for (let attempt = 0; attempt < 400 && !healthy; attempt++) {
    if (controlPlane.exitCode !== null) assert.fail(output);
    try { healthy = (await fetch(`${base}/healthz`)).ok; } catch { /* starting */ }
    if (!healthy) await delay(50);
  }
  assert.ok(healthy, output);

  // The synthetic organization runner: it answers the launch inspection, and for every session the
  // control plane starts it reports the session running and binds that session's own credential.
  const started: Array<Extract<ControlPlaneToRunner, { type: "start_session" }>> = [];
  const credentials = new Map<string, string>();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/runner`);
  sockets.push(socket);
  let registered!: () => void;
  const ready = new Promise<void>((done) => { registered = done; });
  const bound = new Set<string>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ControlPlaneToRunner | { type: "registered" } |
      { type: "agent_control_credential_registered"; sessionId: string; accepted: boolean };
    if (message.type === "registered") registered();
    if (message.type === "campaign_launch_inspect") {
      socket.send(JSON.stringify({ type: "campaign_launch_inspection_result", requestId: message.requestId,
        workspaceId: message.workspaceId, ok: true, repository: "owner/repo", issueNumbers: message.issueNumbers, digest: "d".repeat(64) }));
    }
    if (message.type === "start_session") {
      started.push(message);
      const sessionId = message.spec.sessionId;
      const token = `agent-token-${sessionId}`;
      credentials.set(sessionId, token);
      socket.send(JSON.stringify({ type: "session_status", sessionId, status: "running",
        ...(message.spec.controlPlaneLaunchId ? { controlPlaneLaunchId: message.spec.controlPlaneLaunchId } : {}) }));
      socket.send(JSON.stringify({ type: "agent_control_credential", sessionId, tokenHash: hashToken(token) }));
    }
    if (message.type === "agent_control_credential_registered") {
      assert.equal(message.accepted, true, `credential for ${message.sessionId} accepted`);
      bound.add(message.sessionId);
    }
  });
  await new Promise<void>((done, reject) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener("error", () => reject(new Error("runner socket failed")), { once: true });
  });
  socket.send(JSON.stringify({ type: "register", token: RUNNER_TOKEN, protocolVersion: PROTOCOL_VERSION,
    runner: runnerMeta(RUNNER, temp, providerAccounts), sessionSnapshots: [] }));
  await ready;

  const post = async (authorization: Record<string, string>, path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST",
      headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
  /** The real Session Management tools, called with one session's own runner-minted credential. */
  const tool = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
    const deps: McpDeps = { fetch: (url, init) => fetch(url, init), cpUrl: base, selfSessionId: sessionId,
      token: credentials.get(sessionId)!, orchestrator: started.some((m) => m.spec.sessionId === sessionId && m.spec.orchestrator !== undefined) };
    const result = await executeManagerTool(name, args, deps);
    const text = result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
    return { isError: result.isError === true, text, json: result.isError ? null : JSON.parse(text) as Record<string, unknown> };
  };
  return {
    base, databasePath, org, admin, operator, projectId, peerPath: join(temp, PEER_WORKSPACE), started, credentials,
    /** The runner started this session and the control plane accepted its own credential. */
    running: (sessionId: string, what: string) => waitFor(() => bound.has(sessionId), what),
    /** Send one frame as the synthetic organization runner. */
    fromRunner: (message: unknown) => socket.send(JSON.stringify(message)),
    /** POST as a Human, through that Human's paired device. */
    human: (path: string, body: unknown, token = ADMIN_TOKEN) => post({ authorization: `Bearer ${token}` }, path, body),
    /** POST with one session's own credential, exactly as the CLI and MCP tools send it. */
    agent: (sessionId: string, path: string, body: unknown) => post({ authorization: `Bearer ${credentials.get(sessionId)}`,
      [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: sessionId }, path, body),
    /** GET the raw route, with one session's own credential or as the administrator. */
    get: async (path: string, sessionId?: string) => {
      const response = await fetch(`${base}${path}`, { headers: sessionId
        ? { authorization: `Bearer ${credentials.get(sessionId)}`, [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: sessionId }
        : { authorization: `Bearer ${ADMIN_TOKEN}` } });
      return { status: response.status, text: await response.text() };
    },
    savePriorityOrder: async (priorityAccountIds: string[]) => {
      const response = await fetch(`${base}/api/runners/${RUNNER}/provider-account-policies/claude`, { method: "PUT",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "priority", priorityAccountIds, expectedRevision: 0 }) });
      assert.equal(response.status, 200, await response.clone().text());
    },
    tool,
    visible: async (sessionId: string) => {
      const listed = await tool(sessionId, "list_runners");
      assert.equal(listed.isError, false, listed.text);
      return listed.json!.runners as Array<{ runnerId: string; workspaces: Array<{ id: string }> }>;
    },
  };
}

test("a Full Control root and its descendants reach the organization runner their Human can use, and nothing else (#2940)", {
  timeout: 120_000,
}, async (t) => {
  const s = await stack(t);
  const { org, admin, projectId, running, human, tool } = s;
  const visibleRunners = async (sessionId: string) => (await s.visible(sessionId)).map((runner) => runner.runnerId).sort();

  // 1. The administrator launches Full Control on the organization runner through the real launch route.
  const launch: FullControlLaunchRequest = { runnerId: RUNNER, workspaceId: WORKSPACE, issueNumbers: [12],
    task: "Deliver issue 12", overrides: { session: { agentId: AGENT, config: { model: MODEL, permissionMode: "orchestrator" },
      orchestrator: { behavior: { childModel: MODEL,
        childHarness: { agentId: AGENT, driver: "claude-code", context: { kind: "native" } } } } } } };
  const checked = await human("/api/full-control-campaigns/preflight", launch);
  assert.equal(checked.status, 200, JSON.stringify(checked.json));
  const preflight = checked.json.preflight as CampaignLaunchPreflight;
  assert.equal(preflight.ready, true, JSON.stringify(preflight.summary.blockers));
  const admitted = await human("/api/full-control-campaigns", { ...launch, requestId: "launch-2940", preflightDigest: preflight.digest });
  assert.equal(admitted.status, 201, JSON.stringify(admitted.json));
  const rootId = admitted.json.id as string;
  await running(rootId, "the root starts");
  const live = ControlPlaneDb.attach(s.databasePath, { readOnly: true });
  try {
    assert.deepEqual(live.sessionScope(rootId), { organizationId: org, owner: { kind: "user", userId: admin } },
      "the root stays charged to the authorizing Human");
  } finally { live.close(); }

  // 2. The root's own credential sees what its Human can use, and nothing more.
  assert.deepEqual(await visibleRunners(rootId), ["member-runner", "my-team-runner", RUNNER].sort());
  const capabilities = await tool(rootId, "get_agent_capabilities", { runnerId: RUNNER, agentId: AGENT });
  assert.equal(capabilities.isError, false, capabilities.text);
  // An agent's credential reaches the account listing over the real route, in references only (#4353).
  const accounts = await tool(rootId, "get_provider_account_selection", { runnerId: RUNNER, agentId: AGENT });
  assert.equal(accounts.isError, false, accounts.text);
  assert.ok(Array.isArray(accounts.json!.accounts), accounts.text);
  assert.match((await tool(rootId, "get_provider_account_selection", { runnerId: "colleague-runner", agentId: AGENT })).text, /runner not found/u);
  // The campaign's fixed child harness and model resolve on that runner too (only online Machines count).
  const campaign = await tool(rootId, "get_campaign");
  assert.equal(campaign.isError, false, campaign.text);
  const projection = campaign.json!.campaign as { childHarnessAgents?: Array<{ runnerId: string; agentId: string | null }>;
    childModelMachines?: Array<{ runnerId: string; supported: boolean }> };
  assert.deepEqual(projection.childHarnessAgents?.map(({ runnerId, agentId }) => ({ runnerId, agentId })),
    [{ runnerId: RUNNER, agentId: AGENT }]);
  assert.deepEqual(projection.childModelMachines?.map(({ runnerId, supported }) => ({ runnerId, supported })),
    [{ runnerId: RUNNER, supported: true }]);
  for (const hidden of ["colleague-runner", "their-team-runner", "elsewhere-runner"]) {
    const refused = await tool(rootId, "get_agent_capabilities", { runnerId: hidden, agentId: AGENT });
    assert.equal(refused.isError, true, hidden);
    assert.match(refused.text, /not found or not visible to this session/u, hidden);
    const launched = await tool(rootId, "create_session", { runnerId: hidden, workspaceId: WORKSPACE, agentId: AGENT,
      prompt: "Never launched", useWorktree: false });
    assert.equal(launched.isError, true, hidden);
    assert.match(launched.text, /HTTP 404: runner not found/u, hidden);
  }

  // 3. The root launches its child on the same runner; the child launches its own child there too.
  const childCreated = await tool(rootId, "create_session", { runnerId: RUNNER, workspaceId: WORKSPACE, agentId: AGENT,
    prompt: "Implement issue 12", useWorktree: false });
  assert.equal(childCreated.isError, false, childCreated.text);
  const childId = (childCreated.json!.session as { id: string }).id;
  await running(childId, "the child starts");
  assert.deepEqual(await visibleRunners(childId), ["member-runner", "my-team-runner", RUNNER].sort());
  // A worker's own spawn still asks its Human, and only after runner admission: the first attempt
  // parks that approval instead of answering 404. Once approved, the identical call launches (the
  // approval fingerprints the exact request, so the body is built in the tool's own key order).
  const grandchild = { runnerId: RUNNER, agentId: AGENT, workspaceId: WORKSPACE, prompt: "Check one file", useWorktree: false };
  const asked = await s.agent(childId, "/api/sessions", grandchild);
  const parked = String(asked.json.error);
  assert.equal(asked.status, 428, parked);
  const spawnRequestId = /\(request (spawn_[0-9a-f]+)\)/u.exec(parked)?.[1];
  assert.ok(spawnRequestId, parked);
  const approved = await human(`/api/sessions/${childId}/approve`, { requestId: spawnRequestId, optionId: "allow" });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const grandchildCreated = await tool(childId, "create_session", grandchild);
  assert.equal(grandchildCreated.isError, false, grandchildCreated.text);
  const grandchildId = (grandchildCreated.json!.session as { id: string }).id;
  await running(grandchildId, "the grandchild starts");
  const refusedGrandchild = await tool(childId, "create_session", { runnerId: "colleague-runner", workspaceId: WORKSPACE,
    agentId: AGENT, prompt: "Never launched", useWorktree: false });
  assert.match(refusedGrandchild.text, /HTTP 404: runner not found/u);
  const lineage = ControlPlaneDb.attach(s.databasePath);
  try {
    // #3676: the allowance every member's spend and review is admitted against is the root's, which
    // the administrator authorized; reaching the organization runner never moves a charge elsewhere.
    const control = lineage.getSession(rootId)!.orchestratorPolicy?.control;
    assert.equal(control?.mode === "full_control" ? control.boundary.authorizedByUserId : null, admin);
    for (const id of [rootId, childId, grandchildId]) {
      assert.equal(lineage.getSession(id)!.projectId, projectId, `${id} is in the organization Project`);
      assert.deepEqual(lineage.sessionScope(id), { organizationId: org, owner: { kind: "user", userId: admin } },
        `${id} keeps the Human's ownership`);
      assert.equal(lineage.campaignBudgets.governingRoot(id), rootId, `${id} is charged to the root's allowance`);
    }
  } finally { lineage.close(); }

  // 4. Session visibility is unchanged: the user-delegated root still reads only sessions its Human
  // owns, never an organization-owned session in the same Project.
  const custom = await human("/api/sessions", { runnerId: RUNNER, workspaceId: WORKSPACE, agentId: AGENT, role: "orchestrator",
    useWorktree: false, config: { model: MODEL, permissionMode: "orchestrator" } });
  assert.equal(custom.status, 201, JSON.stringify(custom.json));
  const customId = custom.json.id as string;
  await running(customId, "the Custom root starts");
  const inspected = await tool(rootId, "get_session", { sessionId: customId });
  assert.equal(inspected.isError, true, "the Full Control root cannot read an organization session it did not create");

  // 5. A Custom root in the organization Project is delegated organization-wide, exactly as before.
  const scopeCheck = ControlPlaneDb.attach(s.databasePath, { readOnly: true });
  try {
    assert.deepEqual(scopeCheck.sessionScope(customId), { organizationId: org, owner: { kind: "organization", organizationId: org } });
  } finally { scopeCheck.close(); }
  assert.deepEqual(await visibleRunners(customId),
    ["colleague-runner", "member-runner", "my-team-runner", RUNNER, "their-team-runner"].sort());
});

test("an agent's credential reads account selection in references only, over the raw routes (#4353)", {
  timeout: 120_000,
}, async (t) => {
  const s = await stack(t, [
    { id: "first-person-example-com-1234", label: "first.person@example.com", provider: "claude", authStatus: "unauthenticated", billing: "subscription" },
    { id: "second-person-example-com-5678", label: "second.person@example.com", provider: "claude", authStatus: "unauthenticated", billing: "subscription" },
  ]);
  const launch: FullControlLaunchRequest = { runnerId: RUNNER, workspaceId: WORKSPACE, issueNumbers: [12],
    task: "Deliver issue 12", overrides: { session: { agentId: AGENT, config: { model: MODEL, permissionMode: "orchestrator" },
      orchestrator: { behavior: { childModel: MODEL,
        childHarness: { agentId: AGENT, driver: "claude-code", context: { kind: "native" } } } } } } };
  const checked = await s.human("/api/full-control-campaigns/preflight", launch);
  const preflight = checked.json.preflight as CampaignLaunchPreflight;
  const admitted = await s.human("/api/full-control-campaigns", { ...launch, requestId: "launch-4353", preflightDigest: preflight.digest });
  assert.equal(admitted.status, 201, JSON.stringify(admitted.json));
  const rootId = admitted.json.id as string;
  await s.running(rootId, "the root starts");
  await s.savePriorityOrder(["first-person-example-com-1234", "second-person-example-com-5678"]);

  const assertNamesNoAccount = (text: string) => {
    for (const personal of ["first-person", "second-person", "first.person", "second.person", "example.com"]) {
      assert.ok(!text.includes(personal), text);
    }
  };
  // The inventory itself narrows for that credential, on the raw route and not only in a tool's output.
  const inventoryAsAgent = await s.get("/api/runners", rootId);
  assert.equal(inventoryAsAgent.status, 200, inventoryAsAgent.text);
  assertNamesNoAccount(inventoryAsAgent.text);
  type Listed = { runners: Array<{ runnerId: string; providerAccounts?: unknown; providerAccountDefaults?: unknown; providerLogins?: unknown;
    agents: Array<{ id: string; available?: boolean; defaultProviderAccountId?: unknown; providerAccountReadiness?: unknown; capabilities?: unknown }> }> };
  const narrowed = (JSON.parse(inventoryAsAgent.text) as Listed).runners.find((runner) => runner.runnerId === RUNNER)!;
  assert.equal(narrowed.providerAccounts, undefined);
  assert.equal(narrowed.providerAccountDefaults, undefined);
  assert.equal(narrowed.providerLogins, undefined);
  const narrowedAgent = narrowed.agents.find((agent) => agent.id === AGENT)!;
  assert.equal(narrowedAgent.defaultProviderAccountId, undefined);
  assert.equal(narrowedAgent.providerAccountReadiness, undefined);
  assert.ok(narrowedAgent.capabilities, "what the agent tools read stays");
  const inventoryAsPerson = await s.get("/api/runners");
  const full = (JSON.parse(inventoryAsPerson.text) as Listed).runners.find((runner) => runner.runnerId === RUNNER)!;
  assert.deepEqual((full.providerAccounts as Array<{ id: string }>).map((account) => account.id),
    ["first-person-example-com-1234", "second-person-example-com-5678"], "a person reads the route as before");
  assert.ok(full.providerAccountDefaults, "including the saved policy");
  // Existing tools keep working from that narrowed reply, and get_campaign's Child Model check doesn't read it.
  assert.equal((await s.tool(rootId, "list_runners")).isError, false);
  const capabilities = await s.tool(rootId, "get_agent_capabilities", { runnerId: RUNNER, agentId: AGENT });
  assert.equal(capabilities.isError, false, capabilities.text);
  assertNamesNoAccount(capabilities.text);

  const path = `/api/runners/${RUNNER}/provider-account-selection?agentId=${AGENT}`;
  const asAgent = await s.get(path, rootId);
  assert.equal(asAgent.status, 200, asAgent.text);
  assertNamesNoAccount(asAgent.text);
  const preview = JSON.parse(asAgent.text) as { candidates?: unknown; accountId?: unknown; refusal?: string; choices?: Array<{ accountRef: string }> };
  assert.equal(preview.candidates, undefined);
  assert.equal(preview.accountId, undefined);
  assert.equal(preview.refusal, "no_eligible_account", "the reasons still reach it");
  assert.equal(preview.choices?.length, 2, "and so does what it could name");
  assert.ok(preview.choices?.every((choice) => /^acct:[0-9a-f]{16}$/u.test(choice.accountRef)));

  // A launch's refusal says what to do, with the same narrowing.
  const refused = await s.agent(rootId, "/api/sessions", { runnerId: RUNNER, workspaceId: WORKSPACE, agentId: AGENT, prompt: "Never launched", useWorktree: false });
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  assert.equal(refused.json.code, "PROVIDER_ACCOUNT_CHOICE_REQUIRED");
  assertNamesNoAccount(JSON.stringify(refused.json));
  const selection = refused.json.providerAccountSelection as { candidates?: unknown; refusal?: string; actions?: string[] };
  assert.equal(selection.candidates, undefined);
  assert.equal(selection.refusal, "no_eligible_account");
  assert.ok(selection.actions?.includes("choose_account"));

  // A person who can read the Machine's accounts keeps the whole answer.
  const asPerson = await s.get(path);
  assert.equal(asPerson.status, 200, asPerson.text);
  assert.deepEqual((JSON.parse(asPerson.text) as { candidates: Array<{ accountId: string }> }).candidates.map((candidate) => candidate.accountId),
    ["first-person-example-com-1234", "second-person-example-com-5678"]);
  const personRefused = await s.human("/api/sessions", { runnerId: RUNNER, workspaceId: WORKSPACE, agentId: AGENT, useWorktree: false });
  assert.equal((personRefused.json.providerAccountSelection as { candidates: unknown[] }).candidates.length, 2);
});

test("an agent's credential reads sessions with their account named only by reference, over the raw routes (#4508)", {
  timeout: 120_000,
}, async (t) => {
  const s = await stack(t, [
    { id: "first-person-example-com-1234", label: "first.person@example.com", provider: "claude", authStatus: "authenticated", billing: "subscription" },
    { id: "second-person-example-com-5678", label: "second.person@example.com", provider: "claude", authStatus: "authenticated", billing: "subscription" },
  ]);
  const launch: FullControlLaunchRequest = { runnerId: RUNNER, workspaceId: WORKSPACE, issueNumbers: [12],
    task: "Deliver issue 12", overrides: { session: { agentId: AGENT, config: { model: MODEL, permissionMode: "orchestrator" },
      orchestrator: { behavior: { childModel: MODEL,
        childHarness: { agentId: AGENT, driver: "claude-code", context: { kind: "native" } } } } } } };
  const checked = await s.human("/api/full-control-campaigns/preflight", launch);
  const preflight = checked.json.preflight as CampaignLaunchPreflight;
  const admitted = await s.human("/api/full-control-campaigns", { ...launch, requestId: "launch-4508", preflightDigest: preflight.digest });
  assert.equal(admitted.status, 201, JSON.stringify(admitted.json));
  const rootId = admitted.json.id as string;
  await s.running(rootId, "the root starts");
  const assertNamesNoAccount = (text: string) => {
    for (const personal of ["first-person", "second-person", "first.person", "second.person", "example.com"]) {
      assert.ok(!text.includes(personal), text);
    }
  };

  // The root names the second account by its reference and launches a child on it.
  const selection = await s.get(`/api/runners/${RUNNER}/provider-account-selection?agentId=${AGENT}`, rootId);
  const choices = (JSON.parse(selection.text) as { choices: Array<{ accountRef: string; canName: boolean }> }).choices;
  assert.equal(choices.length, 2, selection.text);
  const accountRef = choices[1]!.accountRef;
  assert.equal(choices[1]!.canName, true, selection.text);
  const created = await s.tool(rootId, "create_session", { runnerId: RUNNER, workspaceId: WORKSPACE, agentId: AGENT,
    prompt: "Implement issue 12", useWorktree: false, providerAccountId: accountRef });
  assert.equal(created.isError, false, created.text);
  assertNamesNoAccount(created.text);
  const childId = (created.json!.session as { id: string }).id;
  await s.running(childId, "the child starts");
  const start = s.started.find((message) => message.spec.sessionId === childId)!;
  assert.equal(start.spec.providerAccountId, "second-person-example-com-5678", "the runner still gets the real account");
  // The runner reports a usage-limit switch to the first account, as an event naming both.
  s.fromRunner({ type: "session_event", sessionId: childId, payload: { kind: "provider_account_switched",
    providerAccountId: "first-person-example-com-1234", providerAccountLabel: "first.person@example.com", automatic: true } });
  let events = "";
  for (let attempt = 0; attempt < 100 && !events.includes("provider_account_switched"); attempt++) {
    events = (await s.get(`/api/sessions/${childId}/events?after=0`)).text;
    if (!events.includes("provider_account_switched")) await delay(20);
  }
  assert.match(events, /first\.person@example\.com/u, "a person reads the event as before");

  // Every raw session read with the root's own credential names the account only by reference.
  type Row = { id: string; providerAccountId?: string; providerAccountLabel?: string; providerAccountRef?: string };
  const listed = await s.get("/api/sessions", rootId);
  assert.equal(listed.status, 200, listed.text);
  assertNamesNoAccount(listed.text);
  const listedChild = (JSON.parse(listed.text) as { sessions: Row[] }).sessions.find((row) => row.id === childId)!;
  assert.equal(listedChild.providerAccountId, undefined);
  assert.equal(listedChild.providerAccountLabel, undefined);
  assert.equal(listedChild.providerAccountRef, accountRef, "the reference is the one the root named");
  const detail = await s.get(`/api/sessions/${childId}`, rootId);
  assert.equal(detail.status, 200, detail.text);
  assertNamesNoAccount(detail.text);
  assert.equal((JSON.parse(detail.text) as { session: Row }).session.providerAccountRef, accountRef);
  const agentEvents = await s.get(`/api/sessions/${childId}/events?after=0`, rootId);
  assert.equal(agentEvents.status, 200, agentEvents.text);
  assert.match(agentEvents.text, /provider_account_switched/u, "the event itself still reaches the agent");
  assertNamesNoAccount(agentEvents.text);

  // The tools keep working, and get_session gives the reference.
  const got = await s.tool(rootId, "get_session", { sessionId: childId });
  assert.equal(got.isError, false, got.text);
  assertNamesNoAccount(got.text);
  assert.equal((got.json!.session as Row).providerAccountRef, accountRef);
  const tools = await s.tool(rootId, "list_sessions");
  assert.equal(tools.isError, false, tools.text);
  assertNamesNoAccount(tools.text);
  assertNamesNoAccount((await s.tool(rootId, "get_session_events", { sessionId: childId, after: 0 })).text);

  // A person's reads keep both fields, whichever audience read first.
  const asPerson = JSON.parse((await s.get("/api/sessions")).text) as { sessions: Row[] };
  const personChild = asPerson.sessions.find((row) => row.id === childId)!;
  assert.equal(personChild.providerAccountId, "second-person-example-com-5678");
  assert.equal(personChild.providerAccountLabel, "second.person@example.com");
  assert.equal(personChild.providerAccountRef, undefined);
  const personDetail = JSON.parse((await s.get(`/api/sessions/${childId}`)).text) as { session: Row };
  assert.equal(personDetail.session.providerAccountLabel, "second.person@example.com");
  assertNamesNoAccount((await s.get("/api/sessions", rootId)).text);
});

test("a user-delegated agent cannot launch into a workspace or host path its Human cannot (#2940 review CR-1.1)", {
  timeout: 120_000,
}, async (t) => {
  const s = await stack(t);
  // An operator's own Custom Orchestrator with no Project is owned by, and delegated as, the operator.
  const created = await s.human("/api/sessions", { runnerId: RUNNER, workspaceId: WORKSPACE, agentId: AGENT, role: "orchestrator",
    projectId: null, useWorktree: false, config: { model: MODEL, permissionMode: "orchestrator" } }, OPERATOR_TOKEN);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const orchestratorId = created.json.id as string;
  await s.running(orchestratorId, "the operator's Orchestrator starts");
  const scope = ControlPlaneDb.attach(s.databasePath, { readOnly: true });
  try {
    assert.deepEqual(scope.sessionScope(orchestratorId), { organizationId: s.org, owner: { kind: "user", userId: s.operator } });
  } finally { scope.close(); }
  const listed = (await s.visible(orchestratorId)).find((runner) => runner.runnerId === RUNNER)!;
  assert.deepEqual(listed.workspaces.map((workspace) => workspace.id), [WORKSPACE], "the colleague's workspace stays hidden");

  const launches = s.started.length;
  const attempts: Array<[label: string, body: Record<string, unknown>, status: number, error: string]> = [
    ["the colleague's directory as an arbitrary path",
      { runnerId: RUNNER, agentId: AGENT, workspacePath: s.peerPath, projectId: null, useWorktree: false }, 403, ARBITRARY_PATH_ERROR],
    ["the colleague's registered workspace",
      { runnerId: RUNNER, agentId: AGENT, workspaceId: PEER_WORKSPACE, projectId: null, useWorktree: false }, 404, "workspace not found"],
    // Creation trims the path, so a blank one would launch the named workspace without its check.
    ["a blank path beside the colleague's workspace",
      { runnerId: RUNNER, agentId: AGENT, workspaceId: PEER_WORKSPACE, workspacePath: "  ", projectId: null, useWorktree: false }, 404, "workspace not found"],
  ];
  for (const [label, body, status, error] of attempts) {
    for (const [who, attempt] of [
      ["agent", () => s.agent(orchestratorId, "/api/sessions", body)],
      ["human", () => s.human("/api/sessions", body, OPERATOR_TOKEN)],
    ] as const) {
      const refused = await attempt();
      assert.equal(refused.status, status, `${who}: ${label}: ${JSON.stringify(refused.json)}`);
      assert.equal(refused.json.error, error, `${who}: ${label}`);
    }
  }
  await delay(200);
  assert.equal(s.started.length, launches, "no refused attempt reached the runner");

  // An administrator may name an arbitrary host path, and so may an agent delegated as one.
  const adminCreated = await s.human("/api/sessions", { runnerId: RUNNER, workspaceId: WORKSPACE, agentId: AGENT, role: "orchestrator",
    projectId: null, useWorktree: false, config: { model: MODEL, permissionMode: "orchestrator" } });
  assert.equal(adminCreated.status, 201, JSON.stringify(adminCreated.json));
  const adminOrchestratorId = adminCreated.json.id as string;
  await s.running(adminOrchestratorId, "the administrator's Orchestrator starts");
  const adminChild = await s.agent(adminOrchestratorId, "/api/sessions",
    { runnerId: RUNNER, agentId: AGENT, workspacePath: s.peerPath, projectId: null, useWorktree: false });
  assert.equal(adminChild.status, 201, JSON.stringify(adminChild.json));
  await waitFor(() => s.started.some((message) => message.spec.sessionId === adminChild.json.id), "the administrator's child starts");
});
