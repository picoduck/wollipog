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

function runnerMeta(runnerId: string, temp: string): RunnerMetadata {
  return {
    runnerId, hostname: runnerId, os: "linux", version: "fixture",
    workspaces: [{ id: WORKSPACE, name: "Repository", path: temp },
      ...(runnerId === RUNNER ? [{ id: PEER_WORKSPACE, name: "Colleague Private", path: join(temp, PEER_WORKSPACE) }] : [])],
    agents: [{ id: AGENT, name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
      context: { kind: "native" }, available: true, authStatus: "authenticated",
      capabilities: { models: [{ id: MODEL, default: true }], effortLevels: ["high"], slashCommands: [],
        permissionModes: ["default", "orchestrator"], supportsImages: true, supportsApprovals: true } }],
    runtime: { dataDir: "/fixture/data", worktreeRoot: "/fixture/data/worktrees", maxConcurrentSessions: 8,
      campaignLaunchInspection: { version: 2 }, executionIsolation: { mode: "provider", network: "inherit" } },
  };
}

/** A real control plane with one online synthetic organization runner, and the identities and
 * Machines both scenarios need. */
async function stack(t: TestContext) {
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
    runner: runnerMeta(RUNNER, temp), sessionSnapshots: [] }));
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
    /** POST as a Human, through that Human's paired device. */
    human: (path: string, body: unknown, token = ADMIN_TOKEN) => post({ authorization: `Bearer ${token}` }, path, body),
    /** POST with one session's own credential, exactly as the CLI and MCP tools send it. */
    agent: (sessionId: string, path: string, body: unknown) => post({ authorization: `Bearer ${credentials.get(sessionId)}`,
      [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: sessionId }, path, body),
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
  const live = ControlPlaneDb.open(s.databasePath);
  try {
    assert.deepEqual(live.sessionScope(rootId), { organizationId: org, owner: { kind: "user", userId: admin } },
      "the root stays charged to the authorizing Human");
  } finally { live.close(); }

  // 2. The root's own credential sees what its Human can use, and nothing more.
  assert.deepEqual(await visibleRunners(rootId), ["member-runner", "my-team-runner", RUNNER].sort());
  const capabilities = await tool(rootId, "get_agent_capabilities", { runnerId: RUNNER, agentId: AGENT });
  assert.equal(capabilities.isError, false, capabilities.text);
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
  const lineage = ControlPlaneDb.open(s.databasePath);
  try {
    for (const id of [rootId, childId, grandchildId]) {
      assert.equal(lineage.getSession(id)!.projectId, projectId, `${id} is in the organization Project`);
      assert.deepEqual(lineage.sessionScope(id), { organizationId: org, owner: { kind: "user", userId: admin } },
        `${id} keeps the Human's ownership`);
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
  const scopeCheck = ControlPlaneDb.open(s.databasePath);
  try {
    assert.deepEqual(scopeCheck.sessionScope(customId), { organizationId: org, owner: { kind: "organization", organizationId: org } });
  } finally { scopeCheck.close(); }
  assert.deepEqual(await visibleRunners(customId),
    ["colleague-runner", "member-runner", "my-team-runner", RUNNER, "their-team-runner"].sort());
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
  const scope = ControlPlaneDb.open(s.databasePath);
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
