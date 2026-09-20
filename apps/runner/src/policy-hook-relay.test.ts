/**
 * Issue #1472: in `provider` mode on native Linux the manager policy hook's credential,
 * acknowledgement, and circuit live in runner memory, and the sidecar relays each event over the
 * session's abstract verdict socket. Nothing in the hook state directory is a credential, and
 * nothing written there decides whether the manager hooks run.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, SessionLaunchSpec } from "@wollipog/protocol";
import {
  applyClaudeHookCapability,
  claudeHookCircuitPath,
  claudeHookReadyPath,
  claudeHookSettingsPath,
  claudeHookTokenPath,
  describeManagedSettings,
  managerHookRelayState,
  markClaudeHookCredentialReady,
  markClaudeHookCredentialRejected,
  prepareClaudeHookArgs,
  provisionClaudeHooks,
  readHookCircuitState,
  removeClaudeHookFiles,
  resetClaudeGuardState,
  writeHookCircuitState,
  type ClaudeHookHost,
} from "./hook-settings.js";
import { ManagedWorktreeGuardSockets } from "./managed-worktree-guard-socket.js";
import { MANAGED_WORKTREE_REFUSAL } from "./managed-worktree-protection.js";
import { requestManagedWorktreeGuardVerdict } from "./managed-worktree-guard.js";
import {
  POLICY_HOOK_FAILURE_LIMIT,
  runPolicyHook,
  servePolicyHookRelay,
} from "./policy-hook.js";
import {
  POLICY_HOOK_RELAY_FLAG,
  POLICY_HOOK_RELAY_KEY_ENV,
  POLICY_HOOK_RELAY_SOCKET_FLAG,
  requestPolicyHookRelay,
} from "./policy-hook-relay.js";

const LINUX = process.platform === "linux";
const SESSION = "sess_relay_1";
const MEMORY_SOCKET = "@wollipog-guard-relay-test-0123456789abcdefghij";
const PROTECTIONS = [{ worktreePath: "/repo-worktrees/s1", repoPath: "/repo" }];

const roots: string[] = [];
const hosts: ManagedWorktreeGuardSockets[] = [];
after(async () => {
  for (const host of hosts) await host.closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-relay-"));
  roots.push(dir);
  return dir;
}

const relayHost = (configDir: string): ClaudeHookHost => ({
  isSea: false,
  execPath: "/usr/bin/node",
  execArgv: ["--import", "tsx"],
  scriptPath: "/repo/apps/runner/src/index.ts",
  configDir,
  managerHookRelay: true,
});

const agent: AgentDefinition = {
  id: "claude-code",
  name: "Claude",
  command: "claude",
  args: [],
  env: {},
  driver: "claude-code",
  context: { kind: "native" },
  capabilities: {
    models: [],
    effortLevels: [],
    slashCommands: [],
    supportsImages: true,
    supportsApprovals: true,
    supportsConversationFork: true,
    permissionModes: ["default", "auto", "acceptEdits", "plan", "bypassPermissions"],
    elicitation: {
      default: ["stdio-control"],
      auto: ["stdio-control"],
      acceptEdits: ["none"],
      plan: ["none"],
      bypassPermissions: ["none"],
    },
  },
};

function spec(): SessionLaunchSpec {
  return {
    sessionId: SESSION,
    workspaceId: null,
    workspacePath: "/repo",
    agentId: "claude-code",
    command: "claude",
    args: [],
    env: {},
    useWorktree: false,
    driver: "claude-code",
    context: { kind: "native" },
    capabilities: applyClaudeHookCapability([agent], true)[0]!.capabilities,
    config: { permissionMode: "acceptEdits" },
  };
}

const config = {
  controlPlaneUrl: "ws://127.0.0.1:4317/runner",
  controlPlaneProtocolVersion: 66,
  enabled: true,
};
const guardVerifies = () => ({ ok: true }) as { ok: true };

/** The pre-spawn provisioning of a relaying runner: worktree set and abstract socket both known. */
function provisionRelayed(dir: string, launch = spec(), registered: string[] = [], messages: string[] = []): SessionLaunchSpec {
  provisionClaudeHooks(launch, {
    ...config,
    managedWorktreeProtections: PROTECTIONS,
    verifyGuardLaunch: guardVerifies,
    managedWorktreeGuardSocket: MEMORY_SOCKET,
    registerCredential: (_sessionId, hash) => registered.push(hash),
  }, (message) => messages.push(message), relayHost(dir));
  return launch;
}

type Document = { env?: Record<string, string>; hooks?: Record<string, Array<{ hooks: Array<{ command: string; args: string[] }> }>> };

function inlineDocument(args: string[]): Document {
  const value = args[args.indexOf("--settings") + 1]!;
  assert.ok(value.startsWith("{"), `inline, not a path: ${value.slice(0, 40)}`);
  return JSON.parse(value) as Document;
}

function managerHook(document: Document, event = "PostToolUse") {
  return document.hooks?.[event]?.[0]?.hooks[0];
}

function relayKey(args: string[]): string {
  const key = prepareClaudeHookArgs(args).env?.[POLICY_HOOK_RELAY_KEY_ENV];
  assert.ok(key, "the spawn environment carries the relay key");
  return key;
}

function payload(event = "PreToolUse") {
  return JSON.stringify({
    session_id: "provider-uuid",
    hook_event_name: event,
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_input: { command: "git status" },
  });
}

function allow() {
  return { ok: true, status: 200, text: async () => JSON.stringify({ decision: "allow", reason: "ok" }) };
}

/* ------------------------------------------------------------------------------------------------
 * Provisioning: what is, and is not, on disk.
 * ---------------------------------------------------------------------------------------------- */

test("a relayed manager hook writes no credential, acknowledgement, or circuit to disk", () => {
  const dir = temp();
  resetClaudeGuardState();
  const registered: string[] = [];
  const messages: string[] = [];
  const launch = provisionRelayed(dir, spec(), registered, messages);
  const file = claudeHookSettingsPath(dir, SESSION);
  assert.deepEqual(launch.args, ["--settings", file], "the persisted argv still names the path");
  assert.equal(registered.length, 1, "the credential is registered with the control plane");
  for (const path of [claudeHookTokenPath(file), claudeHookReadyPath(file), claudeHookCircuitPath(file)]) {
    assert.equal(existsSync(path), false, `${path} was written`);
  }

  const prepared = prepareClaudeHookArgs(launch.args);
  const key = prepared.env?.[POLICY_HOOK_RELAY_KEY_ENV];
  assert.ok(key, "the spawn gets the relay key in its environment");
  assert.ok(!prepared.args.join("\n").includes(key), "and never in its argv");
  const state = managerHookRelayState(SESSION, key);
  assert.ok(state, "the key opens this session's relay state");
  assert.equal(createHash("sha256").update(state.token).digest("hex"), registered[0], "the credential registered is the one held");
  assert.equal(state.credentialReady(), false, "fenced until the control plane acknowledges it");
  assert.equal(managerHookRelayState(SESSION, `${key}x`), null, "a wrong key opens nothing");
  assert.equal(managerHookRelayState("sess_other", key), null, "and neither does another session");

  // The launched document: every manager hook command relays through the session's socket.
  const inline = inlineDocument(prepared.args);
  for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit"]) {
    const hook = event === "PreToolUse" ? inline.hooks!.PreToolUse![1]!.hooks[0]! : managerHook(inline, event)!;
    assert.ok(hook.args.includes(POLICY_HOOK_RELAY_FLAG), `${event} relays`);
    assert.equal(hook.args[hook.args.indexOf(POLICY_HOOK_RELAY_SOCKET_FLAG) + 1], MEMORY_SOCKET);
  }
  // The document on disk still describes the manager hooks, but carries no socket: launched, its
  // sidecar would find no runner and deny every tool call, and it would touch no file.
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as Document;
  assert.ok(managerHook(onDisk)!.args.includes(POLICY_HOOK_RELAY_FLAG));
  assert.ok(!managerHook(onDisk)!.args.includes(POLICY_HOOK_RELAY_SOCKET_FLAG));
  assert.equal(describeManagedSettings(file)?.manager, true);
  // Nothing the runner writes or logs discloses the credential, the key, or the socket.
  const secrets: string[] = [state.token, key, MEMORY_SOCKET];
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    for (const secret of secrets) assert.ok(!text.includes(secret), `${name} discloses a secret`);
  }
  for (const secret of secrets) assert.ok(!messages.join("\n").includes(secret));
  assert.ok(messages.some((message) => /relayed by the runner/u.test(message)), messages.join("\n"));
});

test("a circuit written into the hook state directory does not touch a relayed manager hook", () => {
  const dir = temp();
  resetClaudeGuardState();
  const launch = provisionRelayed(dir);
  const file = claudeHookSettingsPath(dir, SESSION);
  const before = prepareClaudeHookArgs(launch.args);
  assert.ok(managerHook(inlineDocument(before.args)), "the manager hooks are in the launched document");

  // The issue's reproduction: the provider writes the circuit, with and without a timestamp.
  for (const planted of [
    { consecutiveFailures: 3, open: true, openedAt: Date.now() },
    { consecutiveFailures: 3, open: true },
    { consecutiveFailures: 3, open: true, credentialRejected: true },
  ]) {
    writeHookCircuitState(claudeHookCircuitPath(file), planted);
    const prepared = prepareClaudeHookArgs(launch.args);
    assert.equal(prepared.circuitOpen, false);
    assert.equal(prepared.circuitReprobePending, false);
    assert.deepEqual(prepared.args, before.args, "the same document, manager hooks included");
    assert.deepEqual(prepared.env, before.env);
    // Re-provisioning (the next spawn, a restart, a TUI) is not sent down the circuit-open path.
    const messages: string[] = [];
    provisionRelayed(dir, launch, [], messages);
    assert.ok(!messages.some((message) => /circuit is open/u.test(message)), messages.join("\n"));
    assert.deepEqual(prepareClaudeHookArgs(launch.args).args, before.args);
  }
  // Removing every file does not remove them either.
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true });
  assert.deepEqual(prepareClaudeHookArgs(launch.args).args, before.args);

  // The runner's OWN circuit is what selects the guard-only document, exactly as the file did.
  const state = managerHookRelayState(SESSION, relayKey(launch.args))!;
  state.circuit.write({ consecutiveFailures: 3, open: true, openedAt: Date.now() });
  const held = prepareClaudeHookArgs(launch.args);
  assert.equal(held.circuitOpen, true);
  assert.equal(held.guardActive, true, "the guard survives an open circuit");
  assert.equal(managerHook(inlineDocument(held.args)), undefined);
  assert.equal(held.env, undefined, "a spawn without the relayed hooks is not handed the key");
  assert.equal(existsSync(claudeHookCircuitPath(file)), false, "and the runner wrote no circuit file for it");
});

test("a credential rejection and its recovery leave no file behind either", () => {
  const dir = temp();
  resetClaudeGuardState();
  const registered: string[] = [];
  const launch = provisionRelayed(dir, spec(), registered);
  const file = claudeHookSettingsPath(dir, SESSION);
  const key = relayKey(launch.args);

  markClaudeHookCredentialReady(dir, SESSION, "0".repeat(64));
  assert.equal(managerHookRelayState(SESSION, key)!.credentialReady(), false, "an acknowledgement of another hash readies nothing");
  markClaudeHookCredentialReady(dir, SESSION, registered[0]!);
  assert.equal(managerHookRelayState(SESSION, key)!.credentialReady(), true);
  assert.equal(existsSync(claudeHookReadyPath(file)), false);

  const rejected = markClaudeHookCredentialRejected(dir, SESSION);
  assert.equal(rejected.credentialRejected, true);
  const state = managerHookRelayState(SESSION, key)!;
  assert.equal(state.credentialReady(), false);
  assert.equal(state.circuit.read().open, true);
  assert.equal(prepareClaudeHookArgs(launch.args).circuitOpen, true);
  assert.equal(existsSync(claudeHookCircuitPath(file)), false);

  // A rejected credential is re-registered at the next provisioning (the same one), and the
  // positive acknowledgement closes the circuit again.
  provisionRelayed(dir, launch, registered);
  assert.deepEqual(registered, [registered[0], registered[0]]);
  markClaudeHookCredentialReady(dir, SESSION, registered[0]!);
  assert.equal(managerHookRelayState(SESSION, key)!.circuit.read().open, false);
  assert.equal(prepareClaudeHookArgs(launch.args).circuitOpen, false);
  assert.equal(readdirSync(dir).some((name) => /\.(token|ready|circuit\.json|circuit\.lock)$/u.test(name)), false);

  removeClaudeHookFiles(SESSION, dir);
  assert.equal(managerHookRelayState(SESSION, key), null);
});

test("the pre-authorization provisioning of a relaying runner keeps the credential in memory too", () => {
  const dir = temp();
  resetClaudeGuardState();
  const registered: string[] = [];
  const launch = spec();
  const file = claudeHookSettingsPath(dir, SESSION);
  // Before the first launch: no worktree set and no socket yet.
  provisionClaudeHooks(launch, {
    ...config,
    registerCredential: (_sessionId, hash) => registered.push(hash),
  }, () => {}, relayHost(dir));
  assert.equal(existsSync(claudeHookTokenPath(file)), false, "no credential on the way to a relayed launch");
  assert.equal(registered.length, 1);
  // Nothing is launchable from memory yet (no socket to relay through), and the pre-spawn
  // provisioning reuses the same credential rather than minting a second one.
  provisionRelayed(dir, launch, registered);
  assert.deepEqual(registered, [registered[0], registered[0]]);
  assert.ok(managerHook(inlineDocument(prepareClaudeHookArgs(launch.args).args)));

  // A launch whose socket could never be established keeps the file form, as its guard does: the
  // credential then goes to disk, where the sandbox-less file form always kept it.
  resetClaudeGuardState();
  const fileForm = spec();
  provisionClaudeHooks(fileForm, {
    ...config,
    managedWorktreeProtections: PROTECTIONS,
    verifyGuardLaunch: guardVerifies,
    registerCredential: (_sessionId, hash) => registered.push(hash),
  }, () => {}, relayHost(dir));
  assert.equal(existsSync(claudeHookTokenPath(file)), true);
  assert.equal(managerHookRelayState(SESSION, "any"), null);
  assert.ok(!managerHook(JSON.parse(readFileSync(file, "utf8")) as Document)!.args.includes(POLICY_HOOK_RELAY_FLAG));
  assert.equal(prepareClaudeHookArgs(fileForm.args).env, undefined);
});

test("a runner that does not relay is unchanged: the file form, byte for byte", () => {
  const dir = temp();
  resetClaudeGuardState();
  const launch = spec();
  provisionClaudeHooks(launch, {
    ...config,
    managedWorktreeProtections: PROTECTIONS,
    verifyGuardLaunch: guardVerifies,
    managedWorktreeGuardSocket: MEMORY_SOCKET,
  }, () => {}, { ...relayHost(dir), managerHookRelay: undefined });
  const file = claudeHookSettingsPath(dir, SESSION);
  assert.equal(existsSync(claudeHookTokenPath(file)), true);
  const prepared = prepareClaudeHookArgs(launch.args);
  assert.equal(prepared.env, undefined);
  const hook = managerHook(inlineDocument(prepared.args))!;
  assert.ok(!hook.args.includes(POLICY_HOOK_RELAY_FLAG));
  assert.equal(managerHookRelayState(SESSION, "any"), null);
  // Its circuit is still the file, as before.
  writeHookCircuitState(claudeHookCircuitPath(file), { consecutiveFailures: 3, open: true, openedAt: Date.now() });
  assert.equal(prepareClaudeHookArgs(launch.args).circuitOpen, true);
});

/* ------------------------------------------------------------------------------------------------
 * The sidecar and the runner's evaluation.
 * ---------------------------------------------------------------------------------------------- */

test("a relayed sidecar reads no file and fails closed without the runner", async () => {
  const dir = temp();
  const circuitFile = join(dir, "planted.circuit.json");
  const tokenFile = join(dir, "planted.token");
  writeFileSync(tokenFile, "wollipogh_planted", "utf8");
  // A launch that relays names files in its env block as before; the sidecar must not open them.
  const env = {
    MANAGER_TOKEN_FILE: tokenFile,
    WOLLIPOG_POLICY_HOOK_CIRCUIT_FILE: circuitFile,
    WOLLIPOG_POLICY_HOOK_CP_URL: "http://127.0.0.1:1",
    WOLLIPOG_POLICY_HOOK_SESSION_ID: SESSION,
    WOLLIPOG_POLICY_HOOK_READY_FILE: join(dir, "planted.ready"),
    [POLICY_HOOK_RELAY_KEY_ENV]: "key",
  };
  const argv = ["runner", "--policy-hook", "--hook-event", "PreToolUse", POLICY_HOOK_RELAY_FLAG, POLICY_HOOK_RELAY_SOCKET_FLAG, "@wollipog-guard-nobody-listens-here"];
  let fetched = false;
  const deps = { readStdin: async () => payload(), fetch: async () => { fetched = true; return allow(); } };
  const denied = await runPolicyHook(argv, env, deps);
  assert.equal(JSON.parse(denied.output).hookSpecificOutput.permissionDecision, "deny");
  const post = await runPolicyHook(argv.map((arg) => arg === "PreToolUse" ? "PostToolUse" : arg), env, deps);
  assert.deepEqual(JSON.parse(post.output), { suppressOutput: true });
  // No socket named, or no key: the same, still without a file.
  const unconfigured = await runPolicyHook(argv.slice(0, 5), env, deps);
  assert.equal(JSON.parse(unconfigured.output).hookSpecificOutput.permissionDecision, "deny");
  const keyless = await runPolicyHook(argv, { ...env, [POLICY_HOOK_RELAY_KEY_ENV]: undefined }, deps);
  assert.equal(JSON.parse(keyless.output).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(fetched, false);
  assert.equal(existsSync(circuitFile), false, "the sidecar keeps no circuit of its own");
  assert.equal(existsSync(join(dir, "planted.circuit.lock")), false);
});

test("the runner evaluates a relayed event with its own credential and moves only its own circuit", async () => {
  const dir = temp();
  resetClaudeGuardState();
  const registered: string[] = [];
  const launch = provisionRelayed(dir, spec(), registered);
  const file = claudeHookSettingsPath(dir, SESSION);
  const key = relayKey(launch.args);
  const state = managerHookRelayState(SESSION, key)!;
  const signal = new AbortController().signal;

  // A wrong key: the fail-closed response, no control-plane call, no circuit movement.
  let calls: Array<{ url: string; authorization: string; body: unknown }> = [];
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, authorization: init.headers.authorization!, body: JSON.parse(init.body) });
    return allow();
  };
  const refused = await servePolicyHookRelay(SESSION, { key: `${key}x`, event: "PreToolUse", input: payload() }, signal, { fetch });
  assert.equal(JSON.parse(refused).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(JSON.parse(await servePolicyHookRelay(SESSION, { key: "", event: "PostToolUse", input: payload("PostToolUse") }, signal, { fetch })), { suppressOutput: true });
  assert.equal(calls.length, 0);
  assert.deepEqual(state.circuit.read(), { consecutiveFailures: 0, open: false });

  // The right key before the acknowledgement: fenced, exactly as the file form is.
  const fenced = await servePolicyHookRelay(SESSION, { key, event: "PreToolUse", input: payload() }, signal, { fetch });
  assert.equal(JSON.parse(fenced).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(calls.length, 0);
  assert.equal(state.circuit.read().consecutiveFailures, 1);

  markClaudeHookCredentialReady(dir, SESSION, registered[0]!);
  const allowed = await servePolicyHookRelay(SESSION, { key, event: "PreToolUse", input: payload() }, signal, { fetch });
  assert.equal(JSON.parse(allowed).hookSpecificOutput.permissionDecision, "allow");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `http://127.0.0.1:4317/api/sessions/${SESSION}/policy-hook`);
  assert.equal(calls[0]!.authorization, `Bearer ${state.token}`);
  assert.deepEqual(calls[0]!.body, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-uuid",
    toolUseId: "tool-1",
    context: { toolName: "Bash" },
  });
  assert.equal(state.circuit.read().consecutiveFailures, 0);

  // Transport failures open the runner's circuit; the next event defers, and no file appears.
  calls = [];
  const failing = async () => { throw new Error("connection refused"); };
  for (let attempt = 0; attempt < POLICY_HOOK_FAILURE_LIMIT; attempt++) {
    const denied = await servePolicyHookRelay(SESSION, { key, event: "PreToolUse", input: payload() }, signal, { fetch: failing, now: () => 1_000 + attempt });
    assert.equal(JSON.parse(denied).hookSpecificOutput.permissionDecision, "deny");
  }
  assert.equal(state.circuit.read().open, true);
  const deferred = await servePolicyHookRelay(SESSION, { key, event: "PreToolUse", input: payload() }, signal, { fetch, now: () => 1_010 });
  assert.deepEqual(JSON.parse(deferred), { suppressOutput: true });
  assert.equal(calls.length, 0);
  assert.equal(prepareClaudeHookArgs(launch.args, 1_010).circuitOpen, true, "the next spawn sees the runner's circuit");
  assert.equal(existsSync(claudeHookCircuitPath(file)), false);
  assert.deepEqual(readHookCircuitState(claudeHookCircuitPath(file)), { consecutiveFailures: 0, open: false });
});

test("a relayed payload beyond the sidecar's own bound is refused before it is parsed", async () => {
  const dir = temp();
  resetClaudeGuardState();
  const registered: string[] = [];
  const launch = provisionRelayed(dir, spec(), registered);
  markClaudeHookCredentialReady(dir, SESSION, registered[0]!);
  const key = relayKey(launch.args);
  let fetched = false;
  const output = await servePolicyHookRelay(SESSION, { key, event: "PreToolUse", input: "x".repeat(128 * 1024 + 1) }, new AbortController().signal, {
    fetch: async () => { fetched = true; return allow(); },
  });
  assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(fetched, false);
  assert.deepEqual(managerHookRelayState(SESSION, key)!.circuit.read(), { consecutiveFailures: 0, open: false });
});

test("a relayed ask whose sidecar went away stops polling on its behalf", async () => {
  const dir = temp();
  resetClaudeGuardState();
  const registered: string[] = [];
  const launch = provisionRelayed(dir, spec(), registered);
  markClaudeHookCredentialReady(dir, SESSION, registered[0]!);
  const key = relayKey(launch.args);
  const abort = new AbortController();
  let polls = 0;
  const fetch = async () => {
    polls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ decision: "ask", approvalRequestId: "apr_1", retryAfterMs: 50 }) };
  };
  const output = await servePolicyHookRelay(SESSION, { key, event: "PreToolUse", input: payload() }, abort.signal, {
    fetch,
    sleep: async () => { abort.abort(); },
  });
  assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(polls, 1, "no poll after the caller is gone");
  assert.equal(managerHookRelayState(SESSION, key)!.circuit.read().open, false, "an abandoned ask is not a transport failure");
});

/* ------------------------------------------------------------------------------------------------
 * The socket: one abstract socket per session carries both the guard's verdicts and the relay.
 * ---------------------------------------------------------------------------------------------- */

test("an abstract socket relays a manager hook event for its own session, and still judges the guard", { skip: !LINUX }, async () => {
  const dir = temp();
  const served: Array<{ sessionId: string; key: string; event: string }> = [];
  const host = new ManagedWorktreeGuardSockets(
    join(dir, "hooks"),
    () => [{ worktreePath: "/trees/one", repoPath: "/repo" }],
    "linux",
    async (sessionId, request, signal) => {
      served.push({ sessionId, key: request.key, event: request.event });
      if (request.input === "park") {
        await new Promise<void>((resolvePromise) => signal.addEventListener("abort", () => resolvePromise(), { once: true }));
        return "abandoned";
      }
      return `answer for ${sessionId}`;
    },
  );
  hosts.push(host);
  const address = await host.ensure("s_relay", "abstract");
  assert.equal(await requestPolicyHookRelay(address, { key: "k", event: "PostToolUse", input: "{}" }), "answer for s_relay");
  assert.deepEqual(served, [{ sessionId: "s_relay", key: "k", event: "PostToolUse" }]);
  // The guard's own verdict request on the same socket is judged as before.
  const remove = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/work", tool_input: { command: "git worktree remove /trees/one" } });
  assert.ok((await requestManagedWorktreeGuardVerdict(address, remove)).stdout.includes(MANAGED_WORKTREE_REFUSAL));
  // A malformed relay request is closed without an answer, never relayed.
  await assert.rejects(requestPolicyHookRelay(address, { key: "k", event: "Nope" as "PreToolUse", input: "{}" }), /without an answer/u);
  assert.equal(served.length, 1);
  // A caller that disconnects while parked aborts the evaluation on the runner's side.
  const parked = requestPolicyHookRelay(address, { key: "k", event: "PreToolUse", input: "park" });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  await host.close("s_relay");
  await assert.rejects(parked);
  assert.equal(served.length, 2);
});

test("a path socket does not relay: a relay request there gets no answer", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wgs-r-"));
  roots.push(root);
  const host = new ManagedWorktreeGuardSockets(join(root, "h"), () => [], "linux", async () => "must not be reached");
  hosts.push(host);
  const address = await host.ensure("s_path");
  await assert.rejects(requestPolicyHookRelay(address, { key: "k", event: "PreToolUse", input: "{}" }), /without an answer/u);
});

test("a parked sidecar that is killed ends the runner's evaluation for it (review CR-1.1)", { skip: !LINUX }, async () => {
  // Measured on Linux: a peer that has already sent FIN and then dies produces no further event on
  // the server, so the relay request is newline-framed and the sidecar keeps its side open.
  const dir = temp();
  let parked: () => void = () => {};
  const isParked = new Promise<void>((resolvePromise) => { parked = resolvePromise; });
  let abandoned: () => void = () => {};
  const isAbandoned = new Promise<void>((resolvePromise) => { abandoned = resolvePromise; });
  const host = new ManagedWorktreeGuardSockets(join(dir, "hooks"), () => [], "linux", async (_sessionId, _request, signal) => {
    parked();
    await new Promise<void>((resolvePromise) => signal.addEventListener("abort", () => resolvePromise(), { once: true }));
    abandoned();
    return "nobody is listening";
  });
  hosts.push(host);
  const address = await host.ensure("s_killed", "abstract");
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", cli, "--policy-hook", "--hook-event", "PreToolUse", POLICY_HOOK_RELAY_FLAG, POLICY_HOOK_RELAY_SOCKET_FLAG, address], {
    env: { ...process.env, [POLICY_HOOK_RELAY_KEY_ENV]: "the-key" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(payload());
  await isParked;
  child.kill("SIGKILL");
  await isAbandoned;
});

test("the real sidecar relays through the real socket and prints exactly the runner's answer", { skip: !LINUX }, async () => {
  const dir = temp();
  const host = new ManagedWorktreeGuardSockets(
    join(dir, "hooks"),
    () => [],
    "linux",
    async (_sessionId, request) => JSON.stringify({ echo: request }),
  );
  hosts.push(host);
  const address = await host.ensure("s_cli", "abstract");
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const run = (env: Record<string, string>, extraArgs: string[] = []) => new Promise<{ code: number | null; stdout: string }>((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, "--policy-hook", "--hook-event", "PreToolUse", POLICY_HOOK_RELAY_FLAG, ...extraArgs], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("close", (code) => resolvePromise({ code, stdout }));
    child.stdin.end(payload());
  });
  const relayed = await run({ [POLICY_HOOK_RELAY_KEY_ENV]: "the-key" }, [POLICY_HOOK_RELAY_SOCKET_FLAG, address]);
  assert.equal(relayed.code, 0);
  assert.deepEqual(JSON.parse(relayed.stdout), { echo: { key: "the-key", event: "PreToolUse", input: payload() } });
  // Without the key the sidecar does not even connect, and denies.
  const keyless = await run({}, [POLICY_HOOK_RELAY_SOCKET_FLAG, address]);
  assert.equal(JSON.parse(keyless.stdout).hookSpecificOutput.permissionDecision, "deny");
  await host.close("s_cli");
  const gone = await run({ [POLICY_HOOK_RELAY_KEY_ENV]: "the-key" }, [POLICY_HOOK_RELAY_SOCKET_FLAG, address]);
  assert.equal(JSON.parse(gone.stdout).hookSpecificOutput.permissionDecision, "deny");
});
