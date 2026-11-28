import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import type { AcpRuntimeCapabilities, AgentCapabilities, AgentDefinition, AntigravitySetupView, SessionConfig, SessionEventPayload } from "@wollipog/protocol";
import { campaignContainedOperation } from "@wollipog/protocol";
import { negotiateAcpInitialize } from "./acp-contract.js";
import { resolveAcpSessionContext } from "./acp-session-context.js";
import {
  AcpLaunchRefusedError,
  acpCompatibilityFailure,
  compatibleAcpEnvironment,
  compatibleAcpNegotiation,
  redactAccountIdentifiers,
  type AcpCompatibility,
} from "./acp-compatibility.js";
import {
  ANTIGRAVITY_AGENT_ID,
  ANTIGRAVITY_UNAVAILABLE,
  antigravityAgentDefinition,
  antigravitySessionLaunch,
  antigravitySessionEnvironment,
  antigravitySignOutSuperseded,
  withAntigravityAgent,
  withoutAntigravityAgent,
} from "./antigravity-session.js";
import { effectiveAcpCompatibility } from "./session-manager.js";
import { AntigravitySetupSupervisor, antigravityCredentialContext } from "./antigravity-setup.js";
import { AcpDriver } from "./drivers/acp-driver.js";
import type { DriverOptions } from "./drivers/driver.js";
import { spawnAgent } from "./spawn.js";
import { campaignOperationEvidence } from "./campaign-operation-evidence.js";

// Google's CLI is the credential-free fixture fixtures/antigravity/fake-agy.mjs, which models the
// ACP behavior observed from real agy 1.5.14 (see DRIVERS.md §4.3).
const FIXTURE = fileURLToPath(new URL("./fixtures/antigravity/fake-agy.mjs", import.meta.url));
const ACCOUNT = "fixture-user@example.com";

let root: string;
let state: string;
let agy: string;
const cleanup: Array<() => void> = [];

before(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-session-test-"));
  agy = join(root, "agy");
  writeFileSync(agy, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`);
  chmodSync(agy, 0o755);
});

after(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  rmSync(root, { recursive: true, force: true });
  for (const name of ["FAKE_AGY_STATE", "FAKE_AGY_MODE", "GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT"]) delete process.env[name];
});

beforeEach(() => {
  state = mkdtempSync(join(root, "state-"));
  process.env.FAKE_AGY_STATE = state;
  delete process.env.FAKE_AGY_MODE;
});

function signIn(): void {
  writeFileSync(join(state, "signed-in"), "fixture");
}

function setup(overrides: Partial<AntigravitySetupView>): AntigravitySetupView {
  return { version: 1, status: "ready", checkedAt: 1, credentialStore: "shared_os_keyring",
    executable: { path: "/opt/agy/bin/agy", version: "1.5.14" }, models: [{ id: "fixture-pro", name: "Fixture Pro" }], ...overrides };
}

const PROVIDER = { mode: "provider", network: "inherit" } as const;
const BWRAP = { mode: "bwrap", network: "inherit" } as const;

function calls(): Array<{ method: string; clientInfo?: { name?: string } | null; outcome?: unknown;
  mcpServerNames?: string[]; fullPermissions?: boolean; activeMode?: string; promptTexts?: string[];
  clientCapabilities?: { elicitation?: unknown }; result?: unknown; error?: { code: number } }> {
  const path = join(state, "calls.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

test("Antigravity advertises form elicitation and receives schema values in the original turn", { timeout: 15_000 }, async () => {
  signIn();
  const { driver, seen } = launchDriver(setup({ executable: { path: agy, version: "1.5.14" } }), PROVIDER, root);
  await driver.initialize();
  await driver.newSession(root);
  assert.deepEqual(calls().find(({ method }) => method === "initialize")?.clientCapabilities?.elicitation, { form: {} });

  const turn = driver.prompt("Ask fixture question form");
  const request = await waitFor(() => seen.events.find((event) => event.kind === "question_request"));
  assert.equal(request.requestSource, "provider_elicitation");
  assert.deepEqual(request.questions.map(({ id, options, allowOther, multiSelect, required }) => ({
    id, labels: options.map(({ label }) => label), allowOther, multiSelect, required,
  })), [
    { id: "q1", labels: ["Red", "Blue"], allowOther: undefined, multiSelect: undefined, required: false },
    { id: "q1_other", labels: [], allowOther: true, multiSelect: undefined, required: false },
    { id: "q2", labels: ["Gold", "Silver"], allowOther: undefined, multiSelect: true, required: true },
  ]);
  assert.equal(driver.answerQuestion(request.requestId, { q1: "Unlisted", q2: ["Silver"] }, "submit"), false);
  assert.equal(driver.answerQuestion(request.requestId, { q1_other: "Purple" }, "submit"), false);
  assert.equal(driver.answerQuestion(request.requestId, {
    q1: "Blue", q1_other: "Purple", q2: ["Gold", "Silver"],
  }, "submit"), true);
  assert.equal(await turn, "end_turn");
  assert.deepEqual(calls().find(({ method }) => method === "elicitation_response")?.result, {
    action: "accept", content: { q1: "2", q1_other: "Purple", q2: ["G", "S"] },
  });
  assert.equal(calls().filter(({ method }) => method === "session/prompt").length, 1);
  assert.ok(seen.events.some((event) =>
    event.kind === "agent_message" && event.text === "Question answers received by Antigravity."));
  assert.equal(driver.answerQuestion(request.requestId, {}, "dismiss"), false);
});

test("a provider-initiated Antigravity form holds the turn open until answered", { timeout: 15_000 }, async () => {
  signIn();
  const { driver, seen } = launchDriver(setup({ executable: { path: agy, version: "1.5.14" } }), PROVIDER, root,
    undefined, { providerTurnSettleMs: 20 });
  await driver.initialize();
  await driver.newSession(root);
  assert.equal(await driver.prompt("Schedule fixture question"), "end_turn");
  const request = await waitFor(() => seen.events.find((event) => event.kind === "question_request"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(seen.providerTurns, [["started", "acp-provider:1"]]);

  assert.equal(driver.answerQuestion(request.requestId, { q1: "Red", q2: ["Gold"] }, "submit"), true);
  await waitFor(() => seen.providerTurns.find(([state]) => state === "settled"));
  assert.deepEqual(seen.providerTurns, [["started", "acp-provider:1"], ["settled", "acp-provider:1"]]);
  assert.deepEqual(calls().find(({ method }) => method === "elicitation_response")?.result, {
    action: "accept", content: { q1: "1", q2: ["G"] },
  });
});

test("generic ACP sessions neither advertise nor handle elicitation", { timeout: 15_000 }, async () => {
  signIn();
  const events: SessionEventPayload[] = [];
  const driver = new AcpDriver({ command: agy, args: ["acp"], cwd: root, env: {}, config: {}, context: { kind: "native" } }, {
    onEvent: (event) => events.push(event),
    onStderr: () => {},
    onExit: () => {},
  });
  try {
    await driver.initialize();
    await driver.newSession(root);
    assert.equal(calls().find(({ method }) => method === "initialize")?.clientCapabilities?.elicitation, undefined);
    // This fixture mode bypasses capability negotiation to exercise the RPC handler boundary.
    assert.equal(await driver.prompt("Ask fixture question url"), "end_turn");
    assert.equal(calls().find(({ method }) => method === "elicitation_response")?.error?.code, -32601);
    assert.ok(!events.some(({ kind }) => kind === "question_request"));
    const turn = driver.prompt(`Fixture permission ${JSON.stringify({
      name: "read_file", kind: "read", input: { path: join(root, "source.ts") },
    })}`);
    const request = await waitFor(() => events.find((event) => event.kind === "permission_request"));
    assert.equal(request.requestSource, undefined);
    assert.equal(request.context, undefined);
    driver.resolvePermission(request.requestId, "deny");
    assert.equal(await turn, "end_turn");
  } finally {
    driver.dispose();
  }
});

test("disposing Antigravity leaves the durable question available for restart recovery", { timeout: 15_000 }, async () => {
  signIn();
  const { driver, seen } = launchDriver(setup({ executable: { path: agy, version: "1.5.14" } }), PROVIDER, root);
  await driver.initialize();
  await driver.newSession(root);
  const turn = driver.prompt("Ask fixture question form");
  const request = await waitFor(() => seen.events.find((event) => event.kind === "question_request"));
  const rejected = assert.rejects(turn, (error: unknown) =>
    typeof error === "object" && error !== null && "message" in error && error.message === "client disposed");
  driver.dispose();
  await rejected;
  assert.ok(!seen.events.some(({ kind }) => kind === "question_resolved"));
  assert.equal(driver.answerQuestion(request.requestId, {}, "dismiss"), false);
});

for (const action of ["dismiss", "interrupt", "close"] as const) {
  test(`Antigravity settles an open form on ${action}`, { timeout: 15_000 }, async () => {
    signIn();
    const { driver, seen } = launchDriver(setup({ executable: { path: agy, version: "1.5.14" } }), PROVIDER, root);
    await driver.initialize();
    await driver.newSession(root);
    const turn = driver.prompt("Ask fixture question form");
    const request = await waitFor(() => seen.events.find((event) => event.kind === "question_request"));
    if (action === "dismiss") {
      assert.equal(driver.answerQuestion(request.requestId, {}, "dismiss"), true);
    } else if (action === "interrupt") {
      driver.cancel();
    } else {
      assert.equal(await driver.close(), true);
    }
    assert.equal(await turn, action === "dismiss" ? "end_turn" : "cancelled");
    assert.deepEqual(calls().find(({ method }) => method === "elicitation_response")?.result, {
      action: action === "dismiss" ? "decline" : "cancel",
    });
    if (action !== "dismiss") {
      assert.ok(seen.events.some((event) =>
        event.kind === "question_resolved" && event.requestId === request.requestId && !event.answered));
    }
    assert.equal(driver.answerQuestion(request.requestId, {}, "dismiss"), false);
  });
}

for (const scenario of ["unsupported", "url", "foreign"] as const) {
  test(`Antigravity drops a ${scenario} elicitation without opening a card`, { timeout: 15_000 }, async () => {
    signIn();
    const { driver, seen } = launchDriver(setup({ executable: { path: agy, version: "1.5.14" } }), PROVIDER, root);
    await driver.initialize();
    await driver.newSession(root);
    assert.equal(await driver.prompt(`Ask fixture question ${scenario}`), scenario === "foreign" ? "cancelled" : "end_turn");
    assert.deepEqual(calls().find(({ method }) => method === "elicitation_response")?.result, {
      action: scenario === "foreign" ? "cancel" : "decline",
    });
    assert.ok(!seen.events.some(({ kind }) => kind === "question_request"));
    assert.equal(seen.events.some((event) =>
      event.kind === "error" && event.nonFatal && event.message.includes("could not display the form")), scenario !== "foreign");
  });
}

interface Observed {
  events: SessionEventPayload[];
  stderr: string[];
  auth: string[];
  acp: AcpRuntimeCapabilities[];
  state: Array<{ capabilities: AgentCapabilities; config: SessionConfig }>;
  handoffDelivered: number;
  providerTurns: Array<["started" | "settled", string]>;
}

/** An Antigravity session driver launched exactly as the runner launches one. */
function launchDriver(
  view: AntigravitySetupView,
  isolation: { mode: "provider" | "bwrap" },
  cwd: string,
  resumeId?: string,
  overrides: { layeredEnv?: Record<string, string>; deadlines?: { handshakeMs: number; sessionMs: number }; config?: SessionConfig;
    campaignOperationAttestation?: true;
    resolveLaunch?: AcpCompatibility["resolveLaunch"]; sessionContext?: DriverOptions["acpSessionContext"];
    fixtureIsolation?: DriverOptions["isolation"];
    appArmorFix?: (executable: string | undefined) => string | undefined; handoff?: string;
    handoffRecordFails?: boolean; providerTurnSettleMs?: number;
    onEvent?: (event: SessionEventPayload) => void } = {},
): { driver: AcpDriver; seen: Observed } {
  const context = antigravityCredentialContext();
  const launch = antigravitySessionLaunch(view, context, isolation);
  const seen: Observed = { events: [], stderr: [], auth: [], acp: [], state: [], handoffDelivered: 0, providerTurns: [] };
  const options: DriverOptions = {
    command: launch.command!,
    args: launch.args,
    // A layer the session manager adds after launch preparation (an approved worktree setup).
    env: { ...launch.env, ...overrides.layeredEnv },
    scrubInheritedEnv: launch.scrubInheritedEnv,
    acpCompatibility: { ...launch.acpCompatibility, ...(overrides.deadlines ? { deadlines: overrides.deadlines } : {}),
      ...(overrides.campaignOperationAttestation ? { campaignOperationAttestation: true as const } : {}),
      ...(overrides.resolveLaunch ? { resolveLaunch: overrides.resolveLaunch } : {}) },
    cwd,
    config: overrides.config ?? {},
    acpSessionContext: overrides.sessionContext,
    ...(overrides.handoff ? { acpConversationHandoff: overrides.handoff } : {}),
    context: { kind: "native" },
    isolation: overrides.fixtureIsolation,
    ...(resumeId ? { resumeId } : {}),
  };
  const driver = new AcpDriver(options, {
    onEvent: (event: SessionEventPayload) => {
      seen.events.push(event);
      overrides.onEvent?.(event);
    },
    onStderr: (text: string) => seen.stderr.push(text),
    onExit: () => {},
    onProviderInitiatedTurn: (state: "started" | "settled", id: string) => seen.providerTurns.push([state, id]),
    onAuthStatus: (status: string) => seen.auth.push(status),
    onAcpCapabilities: (capabilities: AcpRuntimeCapabilities) => seen.acp.push(capabilities),
    onAcpSessionState: (update: { capabilities: AgentCapabilities; config: SessionConfig }) => seen.state.push(update),
    onConversationHandoffDelivered: () => {
      seen.handoffDelivered += 1;
      if (overrides.handoffRecordFails) throw new Error("EIO: metadata write failed");
    },
  } as never, {
    // Tests never read the real host's AppArmor setting.
    antigravityAppArmorFix: overrides.appArmorFix ?? (() => undefined),
    ...(overrides.providerTurnSettleMs === undefined ? {} : {
      providerTurnSettleMs: overrides.providerTurnSettleMs,
      providerTurnResponseSettleMs: overrides.providerTurnSettleMs,
    }),
    ...(overrides.fixtureIsolation ? { spawn: (opts) => spawnAgent({ ...opts, isolation: undefined }) } : {}),
  });
  cleanup.push(() => driver.dispose());
  return { driver, seen };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function serialized(seen: Observed): string {
  return JSON.stringify(seen);
}

test("New Session gets a row only for a found runtime, and only a ready setup makes it choosable", () => {
  const context = antigravityCredentialContext({ HOME: "/home/fixture" });
  assert.equal(antigravityAgentDefinition(setup({ status: "missing_runtime", executable: undefined }), context, PROVIDER), null);
  assert.equal(antigravityAgentDefinition(setup({ status: "unsupported", failure: "unsupported_platform" }), context, PROVIDER), null);
  assert.equal(antigravityAgentDefinition(setup({ status: "checking" }), context, PROVIDER), null);

  const ready = antigravityAgentDefinition(setup({}), context, PROVIDER)!;
  assert.equal(ready.id, ANTIGRAVITY_AGENT_ID);
  assert.equal(ready.name, "Google Antigravity");
  assert.equal(ready.available, true);
  assert.equal(ready.authStatus, "authenticated");
  assert.equal(ready.driver, "acp");
  assert.equal(ready.command, "/opt/agy/bin/agy", "the executable the setup resolved");
  assert.deepEqual(ready.args, ["acp"]);
  assert.deepEqual(ready.capabilities?.models, [{ id: "fixture-pro", displayName: "Fixture Pro" }]);
  assert.equal(ready.unavailableReason, undefined);

  const signedOut = antigravityAgentDefinition(setup({ status: "sign_in_required", models: undefined }), context, PROVIDER)!;
  assert.equal(signedOut.available, false);
  assert.equal(signedOut.authStatus, "unauthenticated");
  assert.equal(signedOut.unavailableReason, undefined, "New Session words a sign-in problem itself");

  const failed = antigravityAgentDefinition(setup({ status: "verification_failed", failure: "handshake_failed", models: undefined }), context, PROVIDER)!;
  assert.equal(failed.available, false);
  assert.equal(failed.unavailableReason, ANTIGRAVITY_UNAVAILABLE.checkFailed);
  assert.deepEqual(failed.capabilities?.models, []);

  const denied = antigravityAgentDefinition(setup({}), context, { mode: "bwrap", network: "deny" })!;
  assert.equal(denied.available, false, "a session without network access cannot reach Google");
  assert.equal(denied.unavailableReason, ANTIGRAVITY_UNAVAILABLE.networkDenied);
  assert.equal(antigravityAgentDefinition(setup({}), context, BWRAP)!.available, true,
    "bwrap with network keeps sessions available; only resume is withheld");
});

test("the Antigravity row replaces its previous self, never a configured agent, and keeps Gemini CLI's identity", () => {
  const gemini: AgentDefinition = { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], env: {}, source: "registry" };
  const row = antigravityAgentDefinition(setup({}), antigravityCredentialContext({}), PROVIDER)!;
  const stale = { ...row, available: false };
  const merged = withAntigravityAgent([gemini, stale], row, new Set());
  assert.deepEqual(merged.map((agent) => [agent.id, agent.available]), [["gemini", undefined], [ANTIGRAVITY_AGENT_ID, true]]);
  assert.deepEqual(merged[0], gemini, "an existing Gemini CLI entry is untouched");
  assert.deepEqual(withAntigravityAgent([gemini, stale], null, new Set()).map((agent) => agent.id), ["gemini"]);
  const configured = { ...row, name: "Operator Antigravity", command: "/usr/local/bin/agy-wrapper" };
  assert.deepEqual(withAntigravityAgent([configured], row, new Set([ANTIGRAVITY_AGENT_ID])), [configured]);
});

test("a launch uses the setup's executable and exact credential context, and resume only where agy can persist", () => {
  const context = antigravityCredentialContext({ GEMINI_API_KEY: "k", GOOGLE_CLOUD_PROJECT: "p", HOME: "/home/fixture" });
  const provider = antigravitySessionLaunch(setup({}), context, PROVIDER);
  assert.equal(provider.command, "/opt/agy/bin/agy");
  assert.deepEqual(provider.args, ["acp"]);
  assert.deepEqual(provider.env, context.env);
  assert.deepEqual(provider.scrubInheritedEnv, context.scrubInheritedEnv);
  assert.ok(provider.scrubInheritedEnv.includes("GEMINI_API_KEY") && provider.scrubInheritedEnv.includes("GOOGLE_CLOUD_PROJECT"));
  assert.equal(provider.acpCompatibility.profile, "antigravity");
  assert.equal(provider.acpCompatibility.resumable, true);
  assert.deepEqual(provider.acpCompatibility.withheldEnvironment, {
    names: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_GENAI_USE_VERTEXAI"],
    prefixes: ["GOOGLE_CLOUD_"],
  });
  assert.equal(antigravitySessionLaunch(setup({}), context, BWRAP).acpCompatibility.resumable, false);
  assert.deepEqual(antigravitySessionLaunch(setup({}), context, { mode: "seatbelt" }).acpCompatibility.resumable, false);
  assert.equal(antigravitySessionLaunch(setup({ status: "missing_runtime", executable: undefined }), context, PROVIDER).command, undefined);
  // The managed copy (#4780) launches with its self-updater off, from its own credential context.
  const managed = antigravityCredentialContext({ HOME: "/home/fixture" }, { managed: true });
  const managedLaunch = antigravitySessionLaunch(setup({}), managed, PROVIDER);
  assert.equal(managedLaunch.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  // A worktree setup layer added after preparation cannot turn the managed copy's updater back on.
  assert.deepEqual(compatibleAcpEnvironment({ AGY_CLI_DISABLE_AUTO_UPDATE: "false", FIXTURE_SETUP_VAR: "kept" },
    managedLaunch.acpCompatibility), { AGY_CLI_DISABLE_AUTO_UPDATE: "true", FIXTURE_SETUP_VAR: "kept" });
  // A session's sign-out stands until a check that finished after it confirms the sign-in.
  // Judged by when access was observed: a check that probed before the report but published after
  // it (its release lookup was slower) does not clear the report.
  assert.equal(antigravitySignOutSuperseded({ status: "ready" }, 100, 200), false, "observed before the sign-out");
  assert.equal(antigravitySignOutSuperseded({ status: "ready" }, 300, 200), true);
  assert.equal(antigravitySignOutSuperseded({ status: "ready" }, undefined, 200), false);
  assert.equal(antigravitySignOutSuperseded({ status: "sign_in_required" }, 300, 200), false);
  assert.equal(antigravitySignOutSuperseded({ status: "ready" }, 100, undefined), true);
  assert.equal(antigravitySessionLaunch(setup({}), context, PROVIDER).env.AGY_CLI_DISABLE_AUTO_UPDATE, undefined);
});

test("real agy 1.5.14 initialize: the profile withholds sign-in, sign-out, load and listing, and resume outside provider isolation", async () => {
  const frame = JSON.parse(await readFile(new URL("./fixtures/acp/antigravity-1.5.14.initialize.json", import.meta.url), "utf8"));
  const negotiated = negotiateAcpInitialize(frame.result);
  assert.deepEqual(negotiated.agentInfo, { name: "Antigravity ACP Server", title: null, version: "1.5.14" });
  assert.equal(negotiated.stable.loadSession, true);
  assert.equal(negotiated.stable.sessionResume, true);
  assert.equal(negotiated.stable.sessionClose, true);
  assert.equal(negotiated.stable.sessionList, true);
  assert.equal(negotiated.stable.logout, true);
  assert.equal(negotiated.stable.promptImage, true);
  assert.deepEqual(negotiated.authMethods.map((method) => method.id), ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"]);

  const provider = compatibleAcpNegotiation(negotiated, { profile: "antigravity", resumable: true });
  assert.deepEqual(provider.authMethods, [], "an API key or ADC method would change the session's account or billing");
  assert.equal(provider.stable.logout, false, "sign-out would sign every session on the runner out");
  assert.equal(provider.stable.loadSession, false, "agy loads an unknown id as an empty session");
  assert.equal(provider.stable.sessionList, false);
  assert.equal(provider.stable.sessionResume, true);
  assert.equal(provider.stable.sessionClose, true);
  assert.equal(compatibleAcpNegotiation(negotiated, { profile: "antigravity", resumable: false }).stable.sessionResume, false);
  assert.equal(compatibleAcpNegotiation(negotiated), negotiated, "other agents keep every advertised feature");
});

test("setup, readiness check and session share one executable and credential context", async () => {
  signIn();
  process.env.GEMINI_API_KEY = "fixture-ambient-key";
  process.env.GOOGLE_CLOUD_PROJECT = "fixture-project";
  try {
    const supervisor = new AntigravitySetupSupervisor({ dataDir: mkdtempSync(join(root, "data-")), platform: "linux",
      resolveExecutable: async () => agy, onUpdate: () => {} });
    cleanup.push(() => supervisor.shutdown());
    const view = await supervisor.check();
    assert.equal(view.status, "ready");
    const row = antigravityAgentDefinition(view, supervisor.credentialContext(), PROVIDER)!;
    assert.equal(row.command, agy);

    const cwd = mkdtempSync(join(root, "worktree-"));
    const { driver } = launchDriver(view, PROVIDER, cwd);
    await driver.initialize();
    await driver.newSession(cwd);
    const environments = readFileSync(join(state, "environments.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(environments.map((entry) => entry.label), ["version", "acp", "acp"], "version check, access check, session");
    for (const entry of environments) assert.deepEqual(entry.present, [], `${entry.label} saw no ambient credential`);
    assert.equal(new Set(environments.map((entry) => entry.home)).size, 1, "one HOME, so one keyring sign-in");
    const initialize = calls().filter((call) => call.method === "initialize");
    assert.deepEqual(initialize.map((call) => call.clientInfo?.name), ["wollipog", "wollipog"], "Wollipog's own ACP client identity");
  } finally {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  }
});

test("Antigravity applies the saved effort after switching to its saved startup model", async () => {
  signIn();
  process.env.FAKE_AGY_MODE = "model_specific_efforts";
  const cwd = mkdtempSync(join(root, "worktree-"));
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined,
    { config: { model: "fixture-flash", effort: "adaptive" } });
  await driver.initialize();
  await driver.newSession(cwd);
  assert.equal(seen.state.at(-1)?.config.model, "fixture-flash");
  assert.equal(seen.state.at(-1)?.config.effort, "adaptive");
  assert.deepEqual(seen.state.at(-1)?.capabilities.effortLevels, ["quick", "adaptive"]);
});

test("Antigravity starts and resumes with stdio MCP when configured remote transports are unsupported", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const view = setup({ executable: { path: agy } });
  const sessionContext = resolveAcpSessionContext({
    runner: [
      { type: "http", name: "remote-docs", url: "https://docs.example/mcp",
        headers: { Authorization: { fromEnv: "UNSET_ANTIGRAVITY_TEST_MCP_TOKEN" } } },
      { type: "stdio", name: "local-tools", command: process.execPath },
    ],
    workspace: [{ type: "sse", name: "activity", url: "https://activity.example/events" }],
  });
  const first = launchDriver(view, PROVIDER, cwd, undefined, { sessionContext });
  await first.driver.initialize();
  const sessionId = await first.driver.newSession(cwd);
  assert.match(sessionId, /^fixture-session-/);
  assert.equal(await first.driver.prompt("Say hello."), "end_turn");
  first.driver.dispose();

  const resumed = launchDriver(view, PROVIDER, cwd, sessionId, { sessionContext });
  await resumed.driver.initialize();
  assert.equal(await resumed.driver.newSession(cwd), sessionId);
  const sessionCalls = calls().filter((call) => call.method === "session/new" || call.method === "session/resume");
  assert.deepEqual(sessionCalls.map((call) => call.mcpServerNames), [["local-tools"], ["local-tools"]]);
  for (const seen of [first.seen, resumed.seen]) {
    const notice = seen.stderr.find((line) => line.includes("MCP"));
    assert.match(notice ?? "", /remote-docs \(HTTP\).*activity \(SSE\)/);
    assert.doesNotMatch(notice ?? "", /https:|UNSET_ANTIGRAVITY_TEST_MCP_TOKEN/);
  }
});

test("a session streams replies, advertises agy's models, efforts and modes, and keeps its account out of the transcript", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd);
  await driver.initialize();
  await driver.newSession(cwd);
  const presented = seen.state.at(-1)!;
  assert.deepEqual(presented.capabilities.models.map((model) => model.id), ["fixture-pro", "fixture-flash"]);
  assert.deepEqual(presented.capabilities.effortLevels, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(presented.capabilities.permissionModes,
    ["default", "accept-edits", "auto", "plan", "antigravity-full-permissions"]);
  assert.deepEqual(presented.config, { model: "fixture-pro", effort: "high", permissionMode: "default" });
  assert.deepEqual(seen.acp.at(-1), { logout: false, loadSession: false, sessionList: false, sessionDelete: false,
    sessionResume: true, sessionClose: true });

  assert.equal(await driver.prompt("Say hello."), "end_turn");
  assert.deepEqual(seen.events.filter((event) => event.kind === "agent_message").map((event) => (event as { text: string }).text),
    ["Fixture ", "reply."]);
  assert.ok(seen.events.some((event) => event.kind === "agent_thought"));
  assert.ok(seen.events.some((event) => event.kind === "agent_response_completed"));
  assert.equal(await driver.prompt("Say it again."), "end_turn", "a follow-up runs in the same session");
  assert.deepEqual(seen.stderr, [], "agy's stderr log names the account and is never mirrored");
  assert.equal(serialized(seen).includes(ACCOUNT), false);
});

test("a denied command never runs, an allowed one does, and Stop settles a pending approval", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined,
    { config: { permissionMode: "auto" } });
  await driver.initialize();
  await driver.newSession(cwd);
  const marker = join(cwd, "fixture-command-ran");
  const permission = (from: number) => waitFor(() => seen.events.slice(from).find((event) => event.kind === "permission_request") as
    Extract<SessionEventPayload, { kind: "permission_request" }> | undefined);

  let from = seen.events.length;
  const denied = driver.prompt("Please run the command.");
  const request = await permission(from);
  assert.equal(calls().find((call) => call.method === "session/prompt")?.activeMode, "auto");
  assert.equal(calls().find((call) => call.method === "initialize")?.fullPermissions, false);
  assert.equal(request.title, "touch fixture-command-ran", "the card names the command being approved");
  assert.equal(request.requestSource, undefined, "ordinary Antigravity keeps its original governance scope");
  assert.equal(request.context, undefined);
  assert.deepEqual(request.options.map((option) => [option.optionId, option.kind]), [["allow", "allow_once"], ["deny", "reject_once"]]);
  assert.ok(seen.events.slice(from).some((event) => event.kind === "tool_call"), "the tool call is shown before the card");
  assert.equal(driver.resolvePermission(request.requestId, "deny"), true);
  assert.equal(await denied, "end_turn");
  assert.equal(existsSync(marker), false, "deny prevents the command");

  from = seen.events.length;
  const allowed = driver.prompt("Please run the command.");
  driver.resolvePermission((await permission(from)).requestId, "allow");
  assert.equal(await allowed, "end_turn");
  assert.equal(existsSync(marker), true);
  rmSync(marker);

  from = seen.events.length;
  const stopped = driver.prompt("Please run the command.");
  const pending = await permission(from);
  driver.cancel();
  assert.equal(await stopped, "cancelled", "Stop settles the turn");
  assert.equal(driver.resolvePermission(pending.requestId, "allow"), false, "and its approval: a late Allow does nothing");
  assert.equal(existsSync(marker), false);
  assert.deepEqual(calls().filter((call) => call.method === "permission_response").at(-1)?.outcome, { outcome: "cancelled" },
    "the agent is told the approval was cancelled");

  const waiting = driver.prompt("Please wait.");
  await waitFor(() => calls().some((call) => call.method === "session/prompt") ? true : undefined);
  driver.cancel();
  assert.equal(await waiting, "cancelled");
});

test("opted-in Antigravity attests only bounded effects from the ACP permission tool call", {
  skip: process.platform === "win32", timeout: 15_000,
}, async () => {
  signIn();
  const cwd = realpathSync.native(mkdtempSync(join(root, "attestation-")));
  const inside = join(cwd, "source.ts");
  const outside = join(root, "outside.ts");
  const link = join(cwd, "outside-link.ts");
  const missing = join(cwd, "new.ts");
  writeFileSync(inside, "fixture");
  writeFileSync(outside, "fixture");
  symlinkSync(outside, link);
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined,
    { campaignOperationAttestation: true });
  await driver.initialize();
  await driver.newSession(cwd);

  async function requestPermission(name: string, kind: string, input: unknown, permissionTool?: object) {
    const from = seen.events.length;
    const turn = driver.prompt(`Fixture permission ${JSON.stringify({
      name, kind, input, permissionTool, title: "Read source.ts",
    })}`);
    const request = await waitFor(() => seen.events.slice(from).find((event) => event.kind === "permission_request"));
    assert.equal(request.requestSource, "provider_tool");
    assert.equal(request.context?.toolName, name);
    assert.equal(driver.resolvePermission(request.requestId, "deny"), true);
    assert.equal(await turn, "end_turn");
    return { ...request, kind: "permission" as const };
  }
  for (const [name, kind, input, target] of [
    ["read_file", "read", { path: inside }, inside],
    ["view_file", "read", { TargetFile: inside, StartLine: 1 }, inside],
    ["write_file", "edit", { file_path: missing, content: "fixture" }, missing],
    ["write_to_file", "edit", { TargetFile: missing, CodeContent: "fixture" }, missing],
    ["replace_file_content", "edit", { target_file: inside, TargetContent: "fixture", ReplacementContent: "edited" }, inside],
    ["multi_replace_file_content", "edit", { TargetFile: inside, ReplacementChunks: [] }, inside],
  ] as const) {
    const request = await requestPermission(name, kind, input);
    assert.equal(request.context?.operation?.filesystem?.targets[0]?.resolvedPath, target, name);
    assert.equal(campaignContainedOperation(request, cwd), true, name);
  }
  const command = { kind: "command", input: "cat source.ts", cwd } as const;
  const run = await requestPermission("run_command", "execute", { CommandLine: command.input, Cwd: cwd });
  assert.deepEqual(run.context?.operation, campaignOperationEvidence("Bash", command, cwd));
  assert.equal(campaignContainedOperation(run, cwd), true);

  for (const target of [outside, link]) {
    const request = await requestPermission("read_file", "read", { path: target });
    assert.equal(request.context?.operation?.filesystem?.targets[0]?.resolvedPath, outside);
    assert.equal(campaignContainedOperation(request, cwd), false, target);
  }
  for (const [name, kind, input, permissionTool] of [
    ["unknown_tool", "read", { path: inside }, undefined],
    ["read_file", "read", { path: inside, TargetFile: outside }, undefined],
    ["read_file", "read", { path: inside, destination: outside }, undefined],
    ["read_file", "read", { path: "source.ts" }, undefined],
    ["write_file", "read", { path: inside }, undefined],
    ["read_file", "read", { path: inside }, { rawInput: null }],
    ["read_file", "read", { path: inside }, { locations: [{ path: outside }] }],
    ["run_command", "execute", { CommandLine: command.input, Cwd: 1 }, undefined],
    ["run_command", "execute", { CommandLine: command.input, Cwd: cwd, Extra: true }, undefined],
  ] as const) {
    const request = await requestPermission(name, kind, input, permissionTool);
    assert.equal(request.context?.operation, undefined, name);
  }
  const absentCwd = await requestPermission("run_command", "execute", { CommandLine: `cat ${inside}` });
  assert.equal(absentCwd.context?.operation?.filesystem, undefined);
});

test("Antigravity tool IDs deduplicate updates within a conversation and differ across conversations", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const view = setup({ executable: { path: agy } });
  const command = async (resumeId?: string) => {
    const { driver, seen } = launchDriver(view, PROVIDER, cwd, resumeId);
    await driver.initialize();
    const conversation = await driver.newSession(cwd);
    const turn = driver.prompt("Please run the command.");
    const request = await waitFor(() => seen.events.find((event) => event.kind === "permission_request"));
    assert.equal(driver.resolvePermission(request.requestId, "deny"), true);
    assert.equal(await turn, "end_turn");
    const tool = seen.events.find((event) => event.kind === "tool_call");
    const updates = seen.events.filter((event) => event.kind === "tool_call_update");
    assert.ok(tool && updates.length > 0);
    assert.ok(updates.every((event) => event.toolCallId === tool.toolCallId));
    assert.equal(await driver.close(), true);
    return { conversation, toolCallId: tool.toolCallId };
  };

  const first = await command();
  assert.deepEqual(await command(first.conversation), first, "the same ACP identity stays stable on resume");
  const fresh = await command();
  assert.notEqual(first.toolCallId, fresh.toolCallId, "the fixture reuses its raw ID in the new conversation");
});

test("Antigravity cancels a permission arriving after the tool event trips cancellation", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined, {
    onEvent: (event) => {
      if (event.kind === "tool_call") driver.cancel();
    },
  });
  await driver.initialize();
  await driver.newSession(cwd);
  assert.equal(await driver.prompt("Please run the command."), "cancelled");
  assert.ok(!seen.events.some((event) => event.kind === "permission_request"));
  assert.equal(existsSync(join(cwd, "fixture-command-ran")), false);
});

test("Auto Mode is restored on resume and falls back visibly when Antigravity withholds it", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const view = setup({ executable: { path: agy } });
  const config = { permissionMode: "auto" };
  const first = launchDriver(view, PROVIDER, cwd, undefined, { config });
  await first.driver.initialize();
  const id = await first.driver.newSession(cwd);
  assert.equal(first.seen.state.at(-1)?.config.permissionMode, "auto");
  assert.equal(first.seen.state.at(-1)?.capabilities.agentPermissionModes?.find((mode) => mode.id === "auto")?.name, "Auto Mode");
  first.driver.dispose();

  const resumed = launchDriver(view, PROVIDER, cwd, id, { config });
  await resumed.driver.initialize();
  assert.equal(await resumed.driver.newSession(cwd), id);
  await resumed.driver.prompt("Say hello.");
  assert.equal(calls().filter((call) => call.method === "session/prompt").at(-1)?.activeMode, "auto");
  resumed.driver.dispose();

  process.env.FAKE_AGY_MODE = "auto_unavailable";
  const fallback = launchDriver(view, PROVIDER, cwd, id, { config });
  await fallback.driver.initialize();
  assert.equal(await fallback.driver.newSession(cwd), id);
  assert.equal(fallback.seen.state.at(-1)?.config.permissionMode, "default");
  assert.ok(fallback.seen.state.at(-1)?.capabilities.permissionModes?.includes("antigravity-full-permissions"),
    "Full Permissions Mode stays available where Auto is not");
  const warning = fallback.seen.events.find((event) => event.kind === "error" && event.nonFatal &&
    event.source === "antigravity_auto_mode_fallback");
  assert.match(warning?.kind === "error" ? warning.message : "",
    /does not offer Auto Mode on this machine.*Default mode.*Full Permissions Mode/u);
  assert.equal(calls().filter((call) => call.method === "initialize").at(-1)?.fullPermissions, false);
  const prompt = fallback.driver.prompt("Please run the command.");
  const request = await waitFor(() => fallback.seen.events.find((event) => event.kind === "permission_request"));
  fallback.driver.resolvePermission(request.requestId, "deny");
  assert.equal(await prompt, "end_turn");
  assert.equal(existsSync(join(cwd, "fixture-command-ran")), false);
});

test("where AppArmor withholds Auto, the warning carries the exact host command for the agy this session launched", async () => {
  signIn();
  process.env.FAKE_AGY_MODE = "auto_unavailable";
  const cwd = mkdtempSync(join(root, "worktree-"));
  const asked: Array<string | undefined> = [];
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined, {
    config: { permissionMode: "auto" },
    appArmorFix: (executable) => { asked.push(executable); return `fix ${executable}`; },
  });
  await driver.initialize();
  await driver.newSession(cwd);
  assert.deepEqual(asked, [realpathSync.native(agy)], "the command names the executable the kernel runs");
  const warning = seen.events.find((event) => event.kind === "error" && event.source === "antigravity_auto_mode_fallback");
  assert.ok(warning?.kind === "error");
  assert.equal(warning.fixCommand, `fix ${realpathSync.native(agy)}`);
  assert.match(warning.message, /AppArmor blocks the user namespaces.*run the command below.*start a new Antigravity session.*Full Permissions Mode/u);
});

test("a denied native Auto sandbox switches to interactive Default mode without replaying the command", async () => {
  signIn();
  process.env.FAKE_AGY_MODE = "auto_sandbox_denied";
  const cwd = mkdtempSync(join(root, "worktree-"));
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), BWRAP, cwd, undefined, {
    config: { permissionMode: "auto" }, layeredEnv: { FAKE_AGY_EXECUTABLE: agy },
    fixtureIsolation: { backend: "bwrap", command: "bwrap", args: [], network: "inherit",
      antigravityTerminalHelper: join(root, "bin") },
  });
  const marker = join(cwd, "fixture-command-ran");
  await driver.initialize();
  await driver.newSession(cwd);
  assert.equal(seen.state.at(-1)?.config.permissionMode, "auto");
  assert.equal(await driver.prompt("Please run the command."), "end_turn");
  assert.equal(seen.state.at(-1)?.config.permissionMode, "default");
  assert.ok(!seen.state.at(-1)?.capabilities.permissionModes?.includes("auto"));
  assert.ok(seen.events.some((event) => event.kind === "error" && event.source === "antigravity_auto_mode_fallback"));
  assert.deepEqual(calls().filter((call) => call.method === "session/prompt").map((call) => call.activeMode), ["auto"]);
  assert.equal(existsSync(marker), false);

  for (const decision of ["deny", "allow"] as const) {
    const from = seen.events.length;
    const turn = driver.prompt("Please run the command.");
    const request = await waitFor(() => seen.events.slice(from).find((event) => event.kind === "permission_request"));
    assert.equal(driver.resolvePermission(request.requestId, decision), true);
    assert.equal(await turn, "end_turn");
    assert.equal(existsSync(marker), decision === "allow");
  }
});

for (const nativeMode of ["auto_unavailable", "auto_sandbox_denied", "auto_unavailable,allow_always_only"]) {
  test(`managed-worktree Auto keeps bounded permissions when agy reports ${nativeMode}`, { timeout: 15_000 }, async () => {
    signIn();
    process.env.FAKE_AGY_MODE = `${nativeMode},worktree_auto_fixture`;
    const cwd = realpathSync.native(mkdtempSync(join(root, "worktree-")));
    writeFileSync(join(cwd, "tracked.txt"), "base\n");
    const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), BWRAP, cwd, undefined, {
      config: { permissionMode: "auto" }, layeredEnv: { FAKE_AGY_EXECUTABLE: agy },
      fixtureIsolation: { backend: "bwrap", command: "bwrap", args: [], network: "inherit",
        antigravityTerminalHelper: join(root, "bin"),
        protectedWorktree: { parent: dirname(cwd), path: cwd, gitWritableRoots: [] } },
    });
    await driver.initialize();
    await driver.newSession(cwd);
    if (nativeMode === "auto_sandbox_denied") {
      await driver.prompt("Please run the command.");
      assert.equal(existsSync(join(cwd, "fixture-command-ran")), false, "do not replay a failed Auto command");
    }
    assert.equal(seen.state.at(-1)?.config.permissionMode, "auto");
    const notice = seen.events.find((e) => e.kind === "error" && e.source === "antigravity_worktree_auto");
    assert.match(notice?.kind === "error" ? notice.message : "",
      /terminal sandbox could not start.*still need approval/);

    const read = driver.prompt("fixture worktree read");
    if (nativeMode.includes("allow_always_only")) {
      const request = await waitFor(() => seen.events.find((event) => event.kind === "permission_request"));
      assert.equal(request.options[0]?.kind, "allow_always");
      driver.resolvePermission(request.requestId, "deny");
      assert.equal(await read, "end_turn");
      return;
    }
    assert.equal(await read, "end_turn");
    assert.equal(await driver.prompt("fixture worktree edit"), "end_turn");
    assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "edited after relaunch\n");
    assert.ok(!seen.events.some(({ kind }) => kind === "permission_request"));

    const push = driver.prompt("fixture worktree push");
    const request = await waitFor(() => seen.events.find((event) => event.kind === "permission_request"));
    assert.equal(request.title, "git push --dry-run");
    driver.resolvePermission(request.requestId, "deny");
    assert.equal(await push, "end_turn");

    await driver.setConfig({ permissionMode: "default" });
    assert.equal(seen.state.at(-1)?.config.permissionMode, "default");
    const from = seen.events.length;
    const inDefault = driver.prompt("fixture worktree read");
    driver.resolvePermission((await waitFor(() => seen.events.slice(from)
      .find((event) => event.kind === "permission_request"))).requestId, "deny");
    assert.equal(await inDefault, "end_turn");
    await driver.setConfig({ permissionMode: "auto" });
    assert.equal(seen.state.at(-1)?.config.permissionMode, "auto");
    assert.equal(await driver.prompt("fixture worktree read"), "end_turn");
  });
}

test("Full Permissions Mode is a live mode: agy stays in Default and Wollipog approves its requests", async () => {
  signIn();
  // Real agy 1.5.14 withholds Auto where its terminal sandbox is unavailable; Full Permissions must not need it.
  process.env.FAKE_AGY_MODE = "auto_unavailable";
  const cwd = mkdtempSync(join(root, "worktree-"));
  const marker = join(cwd, "fixture-command-ran");
  const view = setup({ executable: { path: agy } });
  const full = "antigravity-full-permissions";
  const first = launchDriver(view, PROVIDER, cwd, undefined, { config: { permissionMode: full } });
  await first.driver.initialize();
  const id = await first.driver.newSession(cwd);
  assert.equal(first.seen.state.at(-1)?.config.permissionMode, full);
  assert.deepEqual(first.seen.state.at(-1)?.capabilities.permissionModes, ["default", "accept-edits", "plan", full],
    "the composer offers agy's live modes and Full Permissions Mode together");
  assert.equal(first.seen.state.at(-1)?.capabilities.agentPermissionModes?.at(-1)?.name, "Full Permissions Mode");
  assert.equal(await first.driver.prompt("Please run the command."), "end_turn");
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  assert.equal(first.seen.events.some((event) => event.kind === "permission_request"), false);
  assert.deepEqual(calls().filter((call) => call.method === "permission_response").at(-1)?.outcome,
    { outcome: "selected", optionId: "allow" }, "Wollipog answered agy's approval request");
  assert.equal(calls().find((call) => call.method === "session/prompt")?.activeMode, "default");
  assert.equal(calls().find((call) => call.method === "initialize")?.fullPermissions, false, "no launch flag");

  // Leaving Full Permissions between turns restores agy's own approvals in the same process.
  await first.driver.setConfig({ permissionMode: "default" });
  assert.equal(first.seen.state.at(-1)?.config.permissionMode, "default");
  let from = first.seen.events.length;
  const asked = first.driver.prompt("Please run the command.");
  const request = await waitFor(() => first.seen.events.slice(from).find((event) => event.kind === "permission_request"));
  first.driver.resolvePermission(request.requestId, "deny");
  assert.equal(await asked, "end_turn");
  assert.equal(existsSync(marker), false);

  // And entering it from agy's Accept Edits mode returns agy to Default first.
  await first.driver.setConfig({ permissionMode: "accept-edits" });
  await first.driver.setConfig({ permissionMode: full });
  assert.equal(first.seen.state.at(-1)?.config.permissionMode, full);
  from = first.seen.events.length;
  assert.equal(await first.driver.prompt("Please run the command."), "end_turn");
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  assert.equal(first.seen.events.slice(from).some((event) => event.kind === "permission_request"), false);
  assert.equal(calls().filter((call) => call.method === "session/prompt").at(-1)?.activeMode, "default");
  first.driver.dispose();

  const resumed = launchDriver(view, PROVIDER, cwd, id, { config: { permissionMode: full } });
  await resumed.driver.initialize();
  assert.equal(await resumed.driver.newSession(cwd), id);
  assert.equal(resumed.seen.state.at(-1)?.config.permissionMode, full);
  assert.equal(await resumed.driver.prompt("Please run the command."), "end_turn");
  assert.equal(existsSync(marker), true);
  assert.equal(resumed.seen.events.some((event) => event.kind === "permission_request"), false);
  assert.ok(calls().filter((call) => call.method === "initialize").every((call) => call.fullPermissions === false));
});

test("a fresh conversation's handoff rides once, ahead of its first prompt", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const handoff = "[Wollipog] This session moved. Conversation so far:\nuser: remember HERON-42";
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined, { handoff });
  await driver.initialize();
  await driver.newSession(cwd);
  await driver.prompt("What was the code word?");
  assert.equal(seen.handoffDelivered, 1, "reported once the agent accepted the prompt carrying it");
  await driver.prompt("Say hello.");
  const prompts = calls().filter((call) => call.method === "session/prompt").map((call) => call.promptTexts ?? []);
  assert.equal(prompts[0]?.[0], handoff, "the conversation so far comes first, before the message it answers");
  assert.equal(prompts[0]?.[1], "What was the code word?");
  assert.ok(!prompts[1]?.some((text) => text.includes("Conversation so far")), "never repeated");
  assert.equal(seen.handoffDelivered, 1);
});

test("a failure recording the delivered handoff never fails the accepted turn or re-sends the seed", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const handoff = "[Wollipog] Conversation so far:\nuser: remember HERON-42";
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined,
    { handoff, handoffRecordFails: true });
  await driver.initialize();
  await driver.newSession(cwd);
  assert.equal(await driver.prompt("What was the code word?"), "end_turn", "the agent accepted it");
  assert.ok(seen.stderr.some((text) => text.includes("could not record the delivered conversation handoff")));
  await driver.prompt("Say hello.");
  const prompts = calls().filter((call) => call.method === "session/prompt").map((call) => call.promptTexts ?? []);
  assert.equal(prompts[0]?.[0], handoff);
  assert.ok(!prompts[1]?.some((text) => text === handoff), "the accepted seed is never sent again");
  assert.equal(seen.handoffDelivered, 1);
});

test("resume reuses the provider conversation under provider isolation and never falls back to session/load", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const first = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd);
  await first.driver.initialize();
  const sessionId = await first.driver.newSession(cwd);
  await first.driver.prompt("Say hello.");
  first.driver.dispose();

  const resumed = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, sessionId);
  await resumed.driver.initialize();
  assert.equal(await resumed.driver.newSession(cwd), sessionId);
  assert.equal(resumed.seen.events.some((event) => event.kind === "agent_message"), false, "nothing is replayed into the transcript");
  resumed.driver.dispose();

  // agy could not persist this conversation (or never had it). session/load would "succeed" with
  // an empty session; resume fails, and the user sees why.
  const missing = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, "fixture-session-unknown");
  await missing.driver.initialize();
  await assert.rejects(missing.driver.newSession(cwd), { message: acpCompatibilityFailure({ profile: "antigravity", resumable: true }, "resume") });
  assert.equal(calls().some((call) => call.method === "session/load"), false, "session/load is never called");
});

test("under bwrap or Seatbelt the session advertises no resume, so a restart refuses instead of starting fresh", async () => {
  signIn();
  process.env.FAKE_AGY_MODE = "no_persist";
  const cwd = mkdtempSync(join(root, "worktree-"));
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), BWRAP, cwd);
  await driver.initialize();
  await driver.newSession(cwd);
  assert.equal(seen.acp.at(-1)?.sessionResume, false);
  assert.equal(seen.acp.at(-1)?.loadSession, false);
  assert.equal(await driver.prompt("Say hello."), "end_turn", "turns still work with agy's state read-only");
});

test("installation, sign-in and turn failures each say what failed", async () => {
  const cwd = mkdtempSync(join(root, "worktree-"));
  // Installation: the executable is gone.
  const gone = launchDriver(setup({ executable: { path: join(root, "missing-agy") } }), PROVIDER, cwd);
  await assert.rejects(gone.driver.initialize(), { message: "Google Antigravity could not be started on this machine. Check its setup in Connections." });

  // Sign-in: no sign-in marker. No ACP auth method is offered from the session.
  const signedOut = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd);
  await signedOut.driver.initialize();
  await assert.rejects(signedOut.driver.newSession(cwd), { message: "Google Antigravity needs sign-in on this machine. Sign in from Connections, then try again." });
  assert.deepEqual(signedOut.seen.auth, ["unauthenticated"]);
  assert.equal(signedOut.seen.events.some((event) => event.kind === "permission_request"), false, "no in-session sign-in card");

  // Sign-in lost mid-session.
  signIn();
  process.env.FAKE_AGY_MODE = "prompt_auth";
  const expired = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd);
  await expired.driver.initialize();
  await expired.driver.newSession(cwd);
  await assert.rejects(expired.driver.prompt("Say hello."), /needs sign-in on this machine/u);
  assert.deepEqual(expired.seen.auth, ["unauthenticated"]);

  // Turn: the provider rejected the prompt; its account name never reaches the status.
  process.env.FAKE_AGY_MODE = "prompt_error";
  const turn = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd);
  await turn.driver.initialize();
  await turn.driver.newSession(cwd);
  await assert.rejects(turn.driver.prompt("Say hello."), (error: Error) => {
    assert.equal(error.message, "Google Antigravity could not complete this turn: Quota exhausted for [account]; try again later");
    return true;
  });
  assert.equal(serialized(turn.seen).includes(ACCOUNT), false);
});

test("credential selectors a later layer adds never reach agy, while other approved variables do", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  assert.equal(process.env.GOOGLE_CLOUD_LOCATION, undefined, "absent from the inherited environment");
  const { driver } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined, {
    layeredEnv: { AGY_ADC_AUTH: "true", GOOGLE_CLOUD_LOCATION: "us-central1", GEMINI_API_KEY: "layered-key",
      FIXTURE_SETUP_VAR: "kept" },
  });
  await driver.initialize();
  const entry = readFileSync(join(state, "environments.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.deepEqual(entry.present, []);
  assert.equal(entry.setupVariable, "kept");
});

test("a launch that never answers fails with its Antigravity error instead of hanging", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const deadlines = { handshakeMs: 300, sessionMs: 300 };
  process.env.FAKE_AGY_MODE = "handshake_hang";
  const silent = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined, { deadlines });
  await assert.rejects(silent.driver.initialize(), /could not be started on this machine/u);

  process.env.FAKE_AGY_MODE = "session_hang";
  const unopened = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined, { deadlines });
  await unopened.driver.initialize();
  await assert.rejects(unopened.driver.newSession(cwd), /could not be started on this machine/u);

  process.env.FAKE_AGY_MODE = "resume_hang";
  const unresumed = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, "fixture-session-1", { deadlines });
  await unresumed.driver.initialize();
  await assert.rejects(unresumed.driver.newSession(cwd), /could not resume this conversation/u);
  assert.deepEqual(antigravitySessionLaunch(setup({}), antigravityCredentialContext({}), PROVIDER).acpCompatibility.deadlines,
    { handshakeMs: 20_000, sessionMs: 60_000 });
});

test("an unanswered initial settings update settles the launch on the agent's own values instead of hanging", async () => {
  signIn();
  process.env.FAKE_AGY_MODE = "config_hang";
  const cwd = mkdtempSync(join(root, "worktree-"));
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined, {
    deadlines: { handshakeMs: 2_000, sessionMs: 300 }, config: { model: "fixture-flash" },
  });
  await driver.initialize();
  const started = Date.now();
  // The shared restore keeps the agent-reported values when an update fails; the deadline makes an
  // unanswered one fail.
  assert.ok(await driver.newSession(cwd));
  assert.ok(Date.now() - started < 5_000, "bounded by the session deadline");
  assert.equal(seen.state.at(-1)?.config.model, "fixture-pro", "the agent's live model, not the unconfirmed request");
});

test("agy is never offered, and never given, client-side file writes outside its sandbox", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const gitLink = join(cwd, ".git");
  writeFileSync(gitLink, "gitdir: /repo/.git/worktrees/s1\n");
  const { driver } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd);
  await driver.initialize();
  await driver.newSession(cwd);
  const initialize = calls().find((call) => call.method === "initialize") as { clientCapabilities?: { fs?: { writeTextFile?: boolean } } };
  assert.equal(initialize.clientCapabilities?.fs?.writeTextFile, false);
  assert.equal(await driver.prompt("Make a client write."), "end_turn");
  const response = calls().find((call) => call.method === "fs/write_text_file response") as { error?: string | null };
  assert.ok(response?.error, "the write request is refused");
  assert.equal(readFileSync(gitLink, "utf8"), "gitdir: /repo/.git/worktrees/s1\n", "the registration file is untouched");
});

test("the client spawns what the setup resolves at that moment, or refuses without spawning anything", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  // Prepared against an executable an update has since removed; the spawn asks again.
  const prepared = setup({ executable: { path: join(root, "pruned-generation", "agy") } });
  const resolved = launchDriver(prepared, PROVIDER, cwd, undefined,
    { resolveLaunch: () => ({ command: agy, pinnedEnvironment: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } }) });
  await resolved.driver.initialize();
  await resolved.driver.newSession(cwd);
  const environments = readFileSync(join(state, "environments.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(environments.at(-1).autoUpdateDisabled, "true", "the resolved copy's pinned values apply");

  const before = calls().length;
  assert.throws(() => launchDriver(prepared, PROVIDER, cwd, undefined, { resolveLaunch: () => null }), (error: Error) => {
    assert.ok(error instanceof AcpLaunchRefusedError);
    assert.equal(error.message, "Google Antigravity could not be started on this machine. Check its setup in Connections.");
    return true;
  });
  assert.equal(calls().length, before, "nothing was spawned");
});

test("a PATH copy resolved at the spawn of a launch prepared for the managed copy keeps its own updater setting", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const managed = antigravityCredentialContext({}, { managed: true });
  // The New Session row and the managed context both carry the updater pin; preparation stores none.
  const prepared = antigravitySessionEnvironment({ AGY_CLI_DISABLE_AUTO_UPDATE: "true", FIXTURE_KEPT: "1", GEMINI_API_KEY: "x" },
    managed.scrubInheritedEnv, managed);
  assert.deepEqual(prepared, { FIXTURE_KEPT: "1" });
  const launchWith = () => {
    const launch = antigravitySessionLaunch(setup({ executable: { path: agy, source: "managed" } }), managed, PROVIDER);
    const driver = new AcpDriver({
      command: launch.command!, args: launch.args, env: prepared, scrubInheritedEnv: launch.scrubInheritedEnv,
      // Between preparation and the spawn, a check verified the PATH copy instead.
      acpCompatibility: { ...launch.acpCompatibility, resolveLaunch: () => ({ command: agy, pinnedEnvironment: {} }) },
      cwd, config: {}, context: { kind: "native" },
    }, { onEvent: () => {}, onStderr: () => {}, onExit: () => {} } as never);
    cleanup.push(() => driver.dispose());
    return driver;
  };
  const updaterSetting = async () => {
    const driver = launchWith();
    await driver.initialize();
    await driver.newSession(cwd);
    const environments = readFileSync(join(state, "environments.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return environments.at(-1).autoUpdateDisabled;
  };
  delete process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
  assert.equal(await updaterSetting(), null, "absent: the PATH copy updates itself as it would anywhere");
  process.env.AGY_CLI_DISABLE_AUTO_UPDATE = "false";
  try {
    assert.equal(await updaterSetting(), "false", "an explicit setting from the runner's environment is kept");
  } finally {
    delete process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
  }
});

test("a launch keeps its resolved executable only until its agent answers the handshake", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  let releases = 0;
  const answered = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined,
    { resolveLaunch: () => ({ command: agy, release: () => { releases++; } }) });
  assert.equal(releases, 0, "held from the spawn");
  await answered.driver.initialize();
  assert.equal(releases, 1, "released once the agent answered");
  answered.driver.dispose();
  assert.equal(releases, 1, "released only once");

  let abandoned = 0;
  const disposed = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd, undefined,
    { resolveLaunch: () => ({ command: agy, release: () => { abandoned++; } }) });
  disposed.driver.dispose();
  assert.equal(abandoned, 1, "a launch disposed before its handshake releases it too");
});

test("external session discovery and adoption never probe the setup-derived Antigravity agent", () => {
  const gemini = { id: "gemini" };
  const antigravity = { id: ANTIGRAVITY_AGENT_ID };
  assert.deepEqual(withoutAntigravityAgent([gemini, antigravity], new Set()), [gemini]);
  assert.deepEqual(withoutAntigravityAgent([antigravity], new Set()), [], "even when it is the selected agent");
  assert.deepEqual(withoutAntigravityAgent([gemini, antigravity], new Set([ANTIGRAVITY_AGENT_ID])), [gemini, antigravity],
    "an operator-configured agent with the id keeps the existing discovery path");
});

test("the effective sandbox, not the configured mode, decides whether resume is offered", () => {
  const profile = { profile: "antigravity" as const, resumable: true };
  assert.deepEqual(effectiveAcpCompatibility(profile, undefined), { acpCompatibility: profile });
  assert.deepEqual(effectiveAcpCompatibility(profile, { backend: "bwrap" } as never), { acpCompatibility: { ...profile, resumable: false } });
  assert.deepEqual(effectiveAcpCompatibility(undefined, { backend: "bwrap" } as never), {});
  // A managed worktree on a provider-isolation runner preserves agy's state directory, so the
  // conversation it started in place resumes there (#4779's follow-up).
  assert.deepEqual(effectiveAcpCompatibility(profile, { backend: "bwrap", preservesProviderHome: true } as never),
    { acpCompatibility: profile });
  assert.deepEqual(effectiveAcpCompatibility({ ...profile, resumable: false }, { backend: "bwrap", preservesProviderHome: true } as never),
    { acpCompatibility: { ...profile, resumable: false } }, "a runner configured for bwrap never offers it");
});

test("account identifiers are redacted from agent text", () => {
  assert.equal(redactAccountIdentifiers("signed in as first.last+tag@sub.example.co.uk now"), "signed in as [account] now");
  assert.equal(acpCompatibilityFailure(undefined, "turn", "x"), undefined, "other agents keep the shared wording");
  const long = acpCompatibilityFailure({ profile: "antigravity", resumable: true }, "turn", `${"word ".repeat(100)}end`)!;
  assert.ok(long.endsWith("…"), "a cut provider message says it was cut");
  assert.ok(long.length <= "Google Antigravity could not complete this turn: ".length + 300);
});
