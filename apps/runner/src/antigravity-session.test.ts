import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import type { AcpRuntimeCapabilities, AgentCapabilities, AgentDefinition, AntigravitySetupView, SessionConfig, SessionEventPayload } from "@wollipog/protocol";
import { negotiateAcpInitialize } from "./acp-contract.js";
import { acpCompatibilityFailure, compatibleAcpNegotiation, redactAccountIdentifiers } from "./acp-compatibility.js";
import {
  ANTIGRAVITY_AGENT_ID,
  ANTIGRAVITY_UNAVAILABLE,
  antigravityAgentDefinition,
  antigravitySessionLaunch,
  withAntigravityAgent,
  withoutAntigravityAgent,
} from "./antigravity-session.js";
import { effectiveAcpCompatibility } from "./session-manager.js";
import { AntigravitySetupSupervisor, antigravityCredentialContext } from "./antigravity-setup.js";
import { AcpDriver } from "./drivers/acp-driver.js";
import type { DriverOptions } from "./drivers/driver.js";

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

function calls(): Array<{ method: string; clientInfo?: { name?: string } | null; outcome?: unknown }> {
  const path = join(state, "calls.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

interface Observed {
  events: SessionEventPayload[];
  stderr: string[];
  auth: string[];
  acp: AcpRuntimeCapabilities[];
  state: Array<{ capabilities: AgentCapabilities; config: SessionConfig }>;
}

/** An Antigravity session driver launched exactly as the runner launches one. */
function launchDriver(
  view: AntigravitySetupView,
  isolation: { mode: "provider" | "bwrap" },
  cwd: string,
  resumeId?: string,
  overrides: { layeredEnv?: Record<string, string>; deadlines?: { handshakeMs: number; sessionMs: number }; config?: SessionConfig } = {},
): { driver: AcpDriver; seen: Observed } {
  const context = antigravityCredentialContext();
  const launch = antigravitySessionLaunch(view, context, isolation);
  const seen: Observed = { events: [], stderr: [], auth: [], acp: [], state: [] };
  const options: DriverOptions = {
    command: launch.command!,
    args: launch.args,
    // A layer the session manager adds after launch preparation (an approved worktree setup).
    env: { ...launch.env, ...overrides.layeredEnv },
    scrubInheritedEnv: launch.scrubInheritedEnv,
    acpCompatibility: { ...launch.acpCompatibility, ...(overrides.deadlines ? { deadlines: overrides.deadlines } : {}) },
    cwd,
    config: overrides.config ?? {},
    context: { kind: "native" },
    ...(resumeId ? { resumeId } : {}),
  };
  const driver = new AcpDriver(options, {
    onEvent: (event: SessionEventPayload) => seen.events.push(event),
    onStderr: (text: string) => seen.stderr.push(text),
    onExit: () => {},
    onAuthStatus: (status: string) => seen.auth.push(status),
    onAcpCapabilities: (capabilities: AcpRuntimeCapabilities) => seen.acp.push(capabilities),
    onAcpSessionState: (update: { capabilities: AgentCapabilities; config: SessionConfig }) => seen.state.push(update),
  } as never);
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
  assert.equal(antigravitySessionLaunch(setup({}), managed, PROVIDER).env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
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

test("a session streams replies, advertises agy's models, efforts and modes, and keeps its account out of the transcript", async () => {
  signIn();
  const cwd = mkdtempSync(join(root, "worktree-"));
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd);
  await driver.initialize();
  await driver.newSession(cwd);
  const presented = seen.state.at(-1)!;
  assert.deepEqual(presented.capabilities.models.map((model) => model.id), ["fixture-pro", "fixture-flash"]);
  assert.deepEqual(presented.capabilities.effortLevels, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(presented.capabilities.permissionModes, ["default", "accept-edits", "auto", "plan"]);
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
  const { driver, seen } = launchDriver(setup({ executable: { path: agy } }), PROVIDER, cwd);
  await driver.initialize();
  await driver.newSession(cwd);
  const marker = join(cwd, "fixture-command-ran");
  const permission = (from: number) => waitFor(() => seen.events.slice(from).find((event) => event.kind === "permission_request") as
    Extract<SessionEventPayload, { kind: "permission_request" }> | undefined);

  let from = seen.events.length;
  const denied = driver.prompt("Please run the command.");
  const request = await permission(from);
  assert.equal(request.title, "touch fixture-command-ran", "the card names the command being approved");
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
});

test("account identifiers are redacted from agent text", () => {
  assert.equal(redactAccountIdentifiers("signed in as first.last+tag@sub.example.co.uk now"), "signed in as [account] now");
  assert.equal(acpCompatibilityFailure(undefined, "turn", "x"), undefined, "other agents keep the shared wording");
  const long = acpCompatibilityFailure({ profile: "antigravity", resumable: true }, "turn", `${"word ".repeat(100)}end`)!;
  assert.ok(long.endsWith("…"), "a cut provider message says it was cut");
  assert.ok(long.length <= "Google Antigravity could not complete this turn: ".length + 300);
});
