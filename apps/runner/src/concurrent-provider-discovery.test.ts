import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAgents } from "./discovery/discover.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { providerHomeLeaseTarget, type ProviderHomeLeaseRequest } from "./provider-home-lease.js";
import { ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";
import { ProviderLoginSupervisor } from "./provider-login.js";
import type { RunnerProviderAccount } from "./config.js";
import { managedProviderProfileRoot } from "./provider-profile-home.js";
import { writeProviderProfileMarker } from "./provider-profile.js";
import { providerAccountEnvironment, providerForDriver } from "./provider-accounts.js";
import type { SessionMeta } from "./session-store.js";
import { runnerHarnessReadiness } from "../../control-plane/src/host-admin-route.js";
import { mergeInstallationAndAccountReadiness } from "./provider-readiness.js";

test("native installation admission failures stay blocking through account projection and updater facts", { skip: process.platform === "win32" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-typed-installation-admission-"));
  const executable = join(root, "codex");
  writeFileSync(executable, `#!${process.execPath}\nthrow new Error('installation admission must refuse before a provider starts');\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath ?? "/usr/bin:/bin"}`;
  t.after(() => { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); });
  for (const error of [new ProviderHomeLeaseError("foreign_owner"), new ProviderHomeLeaseError("unavailable"), new Error("unverified admission")]) {
    const discovered = await discoverAgents({ authorize: async () => { throw error; } });
    const agent = discovered.find((candidate) => candidate.installation?.path === executable && candidate.driver === "codex-app-server");
    assert.ok(agent?.providerReadiness);
    assert.equal(agent.providerReadiness.installationAdmission, "blocked");
    const projected = { ...agent, providerReadiness: mergeInstallationAndAccountReadiness(agent.providerReadiness,
      { checkedAt: Date.now(), installation: "compatible", authentication: "authenticated", reason: "ready" }) };
    assert.equal(runnerHarnessReadiness({ connectedAt: 1, agents: [projected] }).agents[0]!.ownershipBlocked, true);
  }
});

// The discovery regression uses a deterministic ownership backend. The native journal and
// worker have separate integration suites; no credential or actual provider process is used.
const owners = new Map<string, string>();
const references = new Map<string, number>();

function runner(root: string, owner: string, home: string, launches?: Record<string, string>[]) {
  const manager = new SessionManager(() => {}, () => {}, new SessionStore(join(root, "sessions")), owner,
    undefined, ((_driver: unknown, options: { env: Record<string, string> }) => {
      if (!launches) throw new Error("no real provider starts");
      launches.push(options.env);
      return { pid: launches.length, initialize: async () => {}, newSession: async () => {}, prompt: async () => "end_turn",
        cancel() {}, dispose() {}, setConfig: async () => {}, resolvePermission: () => false, agentSessionId: () => "fixture-thread" };
    }) as never, root, 4,
    undefined, undefined, undefined, { mode: "provider", network: "inherit" }, async () => undefined,
    undefined, undefined, async () => {}, undefined, [], undefined, undefined, undefined, undefined,
    undefined, owner.repeat(64));
  (manager as unknown as { runnerEnvironment: NodeJS.ProcessEnv }).runnerEnvironment = { HOME: home };
  (manager as unknown as { prepareLaunch: (meta: SessionMeta) => void }).prepareLaunch = (meta) => {
    meta.env = { HOME: home, ...meta.env };
  };
  const acquire = (directory: string) => {
    if (owners.has(directory) && owners.get(directory) !== owner) throw new ProviderHomeLeaseError("foreign_owner");
    const first = !owners.has(directory);
    owners.set(directory, owner);
    references.set(directory, (references.get(directory) ?? 0) + 1);
    return first;
  };
  const release = (directory: string) => {
    const remaining = (references.get(directory) ?? 1) - 1;
    if (remaining) references.set(directory, remaining);
    else { owners.delete(directory); references.delete(directory); }
    return remaining === 0;
  };
  (manager as unknown as { providerHomeLeases: unknown }).providerHomeLeases = {
    acquireHome: async (directory: string) => acquire(directory),
    releaseHome: async (directory: string) => release(directory),
    acquireReference: async (request: ProviderHomeLeaseRequest) => {
      const target = providerHomeLeaseTarget(request)!;
      return { first: acquire(target.home), release: async () => release(target.home), retain: async () => {} };
    },
    stopAcquisitions() {}, close: async () => { for (const [home, current] of owners) if (current === owner) { owners.delete(home); references.delete(home); } return true; },
  };
  return manager;
}

test("a signed-in launch HOME keeps its auth and Pi models separate from empty installation probes", {
  skip: process.platform === "win32", timeout: 60_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-launch-home-discovery-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(home, ".claude", "commands"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), "{}");
  writeFileSync(join(home, ".pi", "agent", "auth.json"), "{}");
  writeFileSync(join(home, ".claude", "commands", "review.md"), "fixture command");
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  const manager = runner(join(root, "runner"), "e", home);
  const originalPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = originalPath;
    manager.shutdownAll(); await manager.releaseProviderHomeLeasesAfterShutdown(true);
    rmSync(root, { recursive: true, force: true });
  });
  const codex = join(root, "codex");
  writeFileSync(codex, `#!${process.execPath}
console.log(process.argv[2]==='--version'?'0.155.1':'Usage: codex app-server stdio:// generate-json-schema');
`, { mode: 0o700 });
  const claude = join(root, "claude");
  writeFileSync(claude, `#!${process.execPath}
if(process.argv[2]==='--version') console.log('2.1.277');
else if(process.argv[2]==='auth') console.log(JSON.stringify({loggedIn:require('node:fs').existsSync(require('node:path').join(process.env.CLAUDE_CONFIG_DIR||require('node:path').join(process.env.HOME,'.claude'),'.credentials.json'))}));
else console.log('--input-format <format> stream-json\\n--output-format <format> stream-json\\n--permission-mode <mode> (choices: "acceptEdits", "plan")');
`, { mode: 0o700 });
  const pi = join(root, "pi");
  writeFileSync(pi, `#!${process.execPath}
if(process.argv[2]==='--version') console.log('1.4.0');
else {
const home=process.env.PI_CODING_AGENT_DIR||require('node:path').join(process.env.HOME,'.pi','agent');
process.env.WOLLIPOG_FAKE_PI_SCENARIO=require('node:fs').existsSync(require('node:path').join(home,'auth.json'))?'normal':'no-models';
import(${JSON.stringify(new URL("./drivers/fixtures/fake-pi-rpc.mjs", import.meta.url).href)});
}
`, { mode: 0o700 });
  process.env.PATH = `${root}:${originalPath ?? "/usr/bin:/bin"}`;
  const options = {
    authorize: (agent: import("@wollipog/protocol").AgentDefinition, env: Record<string, string>) => {
      if (![codex, claude, pi].some((path) => agent.command === path || agent.args?.includes(path))) throw new Error("fixture only");
      return manager.prepareDiscoveryProbe(agent, env);
    },
    authorizeLaunchHome: (agent: import("@wollipog/protocol").AgentDefinition, env: Record<string, string>) =>
      manager.prepareDiscoveryProbe({ ...agent, source: "config" }, { ...env, HOME: home }),
  };
  const agents = await discoverAgents(options);
  assert.equal(agents.find((agent) => agent.installation?.path === codex)?.authStatus, "authenticated");
  const discoveredPi = agents.find((agent) => agent.installation?.path === pi);
  assert.equal(discoveredPi?.available, true);
  assert.equal(discoveredPi?.capabilities?.models.length, 2);
  const discoveredClaude = agents.find((agent) => agent.installation?.path === claude);
  assert.equal(discoveredClaude?.authStatus, "authenticated");
  assert.ok(discoveredClaude?.capabilities?.slashCommands.some((command) => command.name === "review"));
});

test("a second runner discovers native Claude, Codex and Pi while the first holds the OS-user HOME", {
  skip: process.platform === "win32", timeout: 60_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-concurrent-discovery-"));
  const shared = join(root, "shared"), calls = join(root, "calls"), executable = join(root, "codex");
  mkdirSync(shared);
  writeFileSync(join(shared, "credentials"), "other-runner-fixture-secret");
  const firstLaunches: Record<string, string>[] = [];
  const first = runner(join(root, "first"), "a", shared, firstLaunches);
  const second = runner(join(root, "second"), "b", shared);
  const originalPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = originalPath;
    first.shutdownAll(); second.shutdownAll();
    await first.releaseProviderHomeLeasesAfterShutdown(true);
    await second.releaseProviderHomeLeasesAfterShutdown(true);
    rmSync(root, { recursive: true, force: true });
    owners.clear();
    references.clear();
  });
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,codex:process.env.CODEX_HOME})+'\\n');
if(process.argv[2]==='--version') console.log('0.155.1');
else console.log('Usage: codex app-server stdio:// generate-json-schema');
`, { mode: 0o700 });
  const claude = join(root, "claude"), pi = join(root, "pi");
  writeFileSync(claude, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({home:process.env.HOME,codex:process.env.CODEX_HOME})+'\\n');
if(process.argv[2]==='--version') console.log('2.1.277');
else if(process.argv[2]==='auth') console.log(JSON.stringify({loggedIn:require('node:fs').existsSync(require('node:path').join(process.env.CLAUDE_CONFIG_DIR||require('node:path').join(process.env.HOME,'.claude'),'.credentials.json'))}));
else console.log('--input-format <format> stream-json\\n--output-format <format> stream-json\\n--permission-mode <mode> (choices: "acceptEdits", "plan")');
`, { mode: 0o700 });
  const piFixture = new URL("./drivers/fixtures/fake-pi-rpc.mjs", import.meta.url).href;
  writeFileSync(pi, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({home:process.env.HOME,codex:process.env.CODEX_HOME})+'\\n');
if(process.argv[2]==='--version') console.log('1.4.0');
else { process.env.WOLLIPOG_FAKE_PI_SCENARIO='no-models'; import(${JSON.stringify(piFixture)}); }
`, { mode: 0o700 });
  process.env.PATH = `${root}:${originalPath ?? "/usr/bin:/bin"}`;
  assert.equal(await first.start({ sessionId: "first-session", workspaceId: "fixture", workspacePath: root,
    agentId: "first", command: "fixture-first", args: [], env: { HOME: shared }, useWorktree: false,
    driver: "claude-code", context: { kind: "native" } }), true);
  assert.equal(firstLaunches.length, 1);
  assert.deepEqual([...owners.keys()], [shared]);
  const configured = { id: "configured-codex", name: "Configured Codex", command: executable, args: [],
    driver: "codex-app-server" as const, source: "config" as const, env: {} };
  const admission = await second.prepareDiscoveryProbe(configured, {});
  assert.ok(admission.env?.CODEX_HOME?.startsWith(join(root, "second")),
    "a configured native row without an explicit HOME also isolates its model probes");
  await admission.settle([]);
  await assert.rejects(second.prepareDiscoveryProbe(configured, { HOME: shared }),
    (error: unknown) => error instanceof ProviderHomeLeaseError && error.code === "foreign_owner",
    "an explicit configured HOME keeps its intended ownership checks");
  let selectedAccount: RunnerProviderAccount | undefined;
  const discover = () => discoverAgents({ authorizeLaunchHome: (agent, env) => second.prepareDiscoveryProbe(agent,
    { ...env, ...(selectedAccount && providerForDriver(agent.driver ?? "acp") === selectedAccount.provider
      ? providerAccountEnvironment({ provider: selectedAccount.provider, credentialHome: selectedAccount.directory }) : {}) }, { useLaunchHome: true }), authorize: (agent, env) => {
    if (![executable, claude, pi].some((path) => agent.command === path || agent.args?.includes(path))) throw new Error("fixture installation only");
    return second.prepareDiscoveryProbe(agent, env);
  } });
  const agents = await discover();
  const codex = agents.find((agent) => agent.installation?.path === executable && agent.driver === "codex-app-server");
  assert.ok(codex);
  assert.equal(codex.available, false, "the uninspected launch account is not launch-ready");
  assert.equal(codex.codexAppServer?.status, "supported", "contention must not erase the installation's capability proof");
  assert.doesNotMatch(codex.unavailableReason ?? "", /ownership blocked discovery/);
  assert.equal(codex.authStatus, "unknown", "an uninspected launch HOME cannot be labeled signed in or signed out");
  const discoveredClaude = agents.find((agent) => agent.installation?.path === claude);
  assert.equal(discoveredClaude?.available, false);
  assert.equal(discoveredClaude?.authStatus, "unknown");
  assert.equal(discoveredClaude?.claudeCode?.streamJsonInput, true);
  const discoveredPi = agents.find((agent) => agent.installation?.path === pi);
  assert.equal(discoveredPi?.available, false);
  assert.equal(discoveredPi?.capabilities?.modelSource, "live");
  assert.deepEqual(discoveredPi?.capabilities?.models, [], "empty installation state must not invent authenticated Pi models");
  assert.equal(discoveredPi?.authStatus, "unknown");
  const executions = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(executions.length >= 2);
  for (const execution of executions) {
    assert.notEqual(execution.home, shared);
    assert.ok(execution.home.startsWith(join(root, "second")));
    assert.ok(execution.codex.startsWith(execution.home));
  }
  assert.equal(owners.get(shared), "a", "discovery cannot disturb the live owner");

  // Exercise supported Add Account using a processless sign-in fixture. No actual sign-in or
  // credential transfer occurs: the profile begins empty, then the fixture confirms success.
  const accounts: RunnerProviderAccount[] = [];
  const configPath = join(root, "second.config.json");
  writeFileSync(configPath, JSON.stringify({ runnerId: "second", providerAccounts: [] }), { mode: 0o600 });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let added!: (account: RunnerProviderAccount) => void;
  const accountAdded = new Promise<RunnerProviderAccount>((resolve) => { added = resolve; });
  const grant = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
  const supervisor = new ProviderLoginSupervisor({
    dataDir: join(root, "second"), configPath, accounts, agents: () => agents, resolveEnv: () => ({ HOME: shared }),
    acquireLease: (directory, provider) => second.acquireProviderLoginHome(directory, provider),
    releaseLease: (directory) => second.releaseProviderHomeAfterLogin(directory),
    onUpdate() {}, onAccountAdded: (account) => { added(account); },
    spawn: ((options: { env: Record<string, string> }) => {
      assert.notEqual(options.env.CLAUDE_CONFIG_DIR, shared);
      return child;
    }) as never,
    kill: (async () => true) as never, probe: async (login) => { writeFileSync(join(login.directory, ".credentials.json"), "{}"); return true; }, identify: async () => undefined,
    writeAccounts: (path, next) => { writeFileSync(path, JSON.stringify({ runnerId: "second", providerAccounts: next })); },
    profiles: { root: managedProviderProfileRoot(shared), create: async (home, provider, profileId, grantId) => {
      writeProviderProfileMarker(home, { version: 1, kind: "wollipog-provider-profile", provider, profileId,
        createdAt: new Date().toISOString(), grants: [{ controlPlaneInstanceId: "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", grantId, grantedAt: new Date().toISOString() }] });
    }, settle: async () => {} },
  });
  t.after(() => supervisor.shutdown());
  await supervisor.startAccount({ provider: "claude", label: "Isolated", profileGrantId: grant });
  child.emit("close", 0);
  const account = await accountAdded;
  selectedAccount = account;
  assert.ok(account.profileId);
  assert.ok(account.directory.startsWith(managedProviderProfileRoot(shared)));
  assert.equal(readFileSync(join(shared, "credentials"), "utf8"), "other-runner-fixture-secret");
  assert.equal(owners.get(shared), "a");
  const readyClaude = (await discover()).find((agent) => agent.installation?.path === claude);
  assert.equal(readyClaude?.available, true, "setup makes the selected profile launch-ready despite the busy OS-user HOME");
  assert.equal(readyClaude?.authStatus, "authenticated");

  const launches: Record<string, string>[] = [];
  const replacement = runner(join(root, "replacement"), "c", shared, launches);
  t.after(async () => { replacement.shutdownAll(); await replacement.releaseProviderHomeLeasesAfterShutdown(true); });
  const internals = replacement as unknown as { resolveProviderAccount: () => unknown; prepareLaunch: (meta: SessionMeta) => void; store: SessionStore };
  internals.resolveProviderAccount = () => ({ id: account.id, label: account.label, provider: account.provider,
    credentialHome: account.directory, profileId: account.profileId });
  internals.prepareLaunch = (meta) => {
    meta.env = { HOME: shared, ...providerAccountEnvironment({ provider: account.provider, credentialHome: meta.providerCredentialHome! }) };
  };
  const launch = { sessionId: "isolated-session", workspaceId: "fixture", workspacePath: root,
    agentId: readyClaude!.id, command: claude, args: [], env: {}, useWorktree: false,
    driver: "claude-code" as const, context: { kind: "native" as const }, providerAccountId: account.id };
  assert.equal(await replacement.start(launch), true);
  assert.equal(launches[0]?.CLAUDE_CONFIG_DIR, account.directory);
  assert.equal(internals.store.readMeta(launch.sessionId)?.providerProfileId, account.profileId);
  assert.equal(owners.get(shared), "a", "the new profile's session leaves the first runner running");
  await assert.rejects(second.acquireProviderLoginHome(shared, "claude"),
    (error: unknown) => error instanceof ProviderHomeLeaseError && error.code === "foreign_owner",
    "explicit shared-HOME use still refuses a competing owner");

  replacement.shutdownAll();
  await replacement.releaseProviderHomeLeasesAfterShutdown(true);
  const saved = JSON.parse(readFileSync(configPath, "utf8")).providerAccounts as RunnerProviderAccount[];
  assert.deepEqual(saved, accounts, "setup persists the isolated profile selection");
  const reconnected = runner(join(root, "replacement"), "d", shared, launches);
  t.after(async () => { reconnected.shutdownAll(); await reconnected.releaseProviderHomeLeasesAfterShutdown(true); });
  const restored = reconnected as unknown as typeof internals;
  restored.resolveProviderAccount = () => ({ id: account.id, label: account.label, provider: account.provider,
    credentialHome: join(root, "new-selection"), profileId: "7f1c2d3e-4a5b-4c6d-8e7f-001122334455" });
  restored.prepareLaunch = internals.prepareLaunch;
  assert.equal(await reconnected.start(launch), true);
  assert.equal(launches.at(-1)?.CLAUDE_CONFIG_DIR, account.directory, "reconnect uses the session's recorded HOME despite later selection changes");
  assert.equal(restored.store.readMeta(launch.sessionId)?.providerProfileId, account.profileId);
  assert.equal(owners.get(shared), "a");
  assert.equal(readFileSync(join(shared, "credentials"), "utf8"), "other-runner-fixture-secret");
  assert.equal((first as unknown as { store: SessionStore }).store.readMeta("first-session")?.status, "idle",
    "the original provider session survives discovery, setup, launch and reconnect");
});
