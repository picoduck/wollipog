/**
 * Codex's command sandbox nested in the runner's own bubblewrap boundary (#3843). On a host that
 * restricts unprivileged user namespaces, Codex's workspace sandbox starts a second bubblewrap that
 * cannot create its namespace, so every command fails and escalates. The launch probe runs `true`
 * under the policy the turns will send; these fixtures answer it the way codex-cli 0.165.0 does
 * inside a bwrap session on such a host (measured 2026-10-30).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionConfig } from "@wollipog/protocol";
import {
  buildCodexTurnParams,
  CodexAppServerDriver,
  CodexCommandSandboxUnavailableError,
  codexCommandSandboxProbe,
} from "./codex-app-server.js";
import type { SpawnIsolation } from "../spawn.js";

const linuxOnly = process.platform === "linux" ? false : "the launch probe runs on native Linux only";
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

/** codex-cli 0.165.0's `command/exec` response when its nested bubblewrap cannot start. */
const NESTED_BWRAP_FAILURE = {
  exitCode: 1,
  stdout: "",
  stderr: "bwrap: No permissions to create new namespace, likely because the kernel does not allow " +
    "non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.\n",
};

function bwrap(network: "inherit" | "deny"): SpawnIsolation {
  return { backend: "bwrap", command: "/usr/bin/bwrap", args: [], network };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function driverWith(options: { isolation?: SpawnIsolation; config?: SessionConfig; probe: (params: any) => unknown }) {
  const stderr: string[] = [];
  const sandboxEvents = () => stderr.map((line) => JSON.parse(line).event as string).filter((event) => event.startsWith("codex_command_sandbox"));
  const probes: any[] = [];
  const turns: any[] = [];
  const driver = new CodexAppServerDriver({
    command: "codex", args: [], cwd: "/repo", env: {},
    config: options.config ?? {}, context: { kind: "native" },
    ...(options.isolation ? { isolation: options.isolation } : {}),
  }, { onEvent() {}, onStderr: (line) => stderr.push(line), onExit() {} }) as any;
  driver.peer = {
    request: async (method: string, params: any) => {
      if (method === "command/exec") {
        probes.push(params);
        return options.probe(params);
      }
      if (method === "turn/start") {
        turns.push(params);
        return { turn: { id: `turn-${turns.length}` } };
      }
      return { thread: { id: "thread-1" } };
    },
  };
  const firstTurn = async () => {
    await driver.newSession("/repo");
    const turn = driver.prompt("go");
    await nextTask();
    driver.settleTurn("end_turn");
    await turn;
    return turns[0];
  };
  return { driver, sandboxEvents, probes, turns, firstTurn };
}

test("inside the runner's bwrap boundary, a nested sandbox that cannot start hands commands to that boundary", { skip: linuxOnly }, async () => {
  for (const network of ["inherit", "deny"] as const) {
    const h = driverWith({ isolation: bwrap(network), probe: () => NESTED_BWRAP_FAILURE });
    const turn = await h.firstTurn();
    // The probe used exactly the policy the turn would otherwise have sent.
    assert.deepEqual(h.probes.map((probe) => [probe.command, probe.sandboxPolicy]),
      [[["true"], { type: "workspaceWrite" }]]);
    assert.deepEqual(turn.sandboxPolicy,
      { type: "externalSandbox", networkAccess: network === "deny" ? "restricted" : "enabled" });
    // The approval policy and reviewer are untouched: escalations still reach their owners.
    assert.equal(turn.approvalPolicy, "on-request");
    assert.equal(turn.approvalsReviewer, "auto_review");
    assert.deepEqual(h.sandboxEvents(), ["codex_command_sandbox_outer_boundary"]);
  }
});

test("a nested sandbox that starts keeps Codex's own workspace sandbox", { skip: linuxOnly }, async () => {
  const h = driverWith({ isolation: bwrap("inherit"), probe: () => ({ exitCode: 0, stdout: "", stderr: "" }) });
  assert.deepEqual((await h.firstTurn()).sandboxPolicy, { type: "workspaceWrite" });
  assert.deepEqual(h.sandboxEvents(), []);
});

test("inside the boundary, a sandbox failure other than a namespace denial keeps Codex's policy", { skip: linuxOnly }, async () => {
  const h = driverWith({ isolation: bwrap("inherit"), probe: () => ({ exitCode: 1, stdout: "", stderr: "seccomp: unexpected\n" }) });
  assert.deepEqual((await h.firstTurn()).sandboxPolicy, { type: "workspaceWrite" });
  assert.deepEqual(h.sandboxEvents(), ["codex_command_sandbox_unavailable"]);
});

test("without a runner boundary, a sandbox that cannot start fails the launch with a typed reason", { skip: linuxOnly }, async () => {
  const h = driverWith({ probe: () => NESTED_BWRAP_FAILURE });
  await assert.rejects(h.driver.newSession("/repo"), (error: unknown) => {
    assert.ok(error instanceof CodexCommandSandboxUnavailableError);
    assert.equal(error.launchFailure, "codex_sandbox_unavailable");
    assert.match(error.message, /does not let unprivileged processes create user namespaces/);
    // Provider stderr can carry paths; the reason is a fixed sentence.
    assert.doesNotMatch(error.message, /deb\.li|README/);
    return true;
  });
  assert.deepEqual(h.turns, []);
});

test("an App Server that cannot answer the probe keeps today's behavior", { skip: linuxOnly }, async () => {
  const h = driverWith({ isolation: bwrap("inherit"), probe: () => { throw Object.assign(new Error("method not found"), { code: -32601 }); } });
  assert.deepEqual((await h.firstTurn()).sandboxPolicy, { type: "workspaceWrite" });
  assert.deepEqual(h.sandboxEvents(), []);
});

test("a session with no sandbox of Codex's own is not probed", { skip: linuxOnly }, async () => {
  const h = driverWith({ config: { permissionMode: "danger-full-access" }, probe: () => NESTED_BWRAP_FAILURE });
  assert.deepEqual((await h.firstTurn()).sandboxPolicy, { type: "dangerFullAccess" });
  assert.deepEqual(h.probes, []);
});
/* eslint-enable @typescript-eslint/no-explicit-any */

test("the probe treats only a non-zero exit as a failed sandbox, and names a namespace denial", () => {
  assert.deepEqual(codexCommandSandboxProbe({ exitCode: 0, stdout: "", stderr: "" }), { outcome: "started" });
  assert.deepEqual(codexCommandSandboxProbe({ thread: { id: "x" } }), { outcome: "inconclusive" });
  const denied = codexCommandSandboxProbe(NESTED_BWRAP_FAILURE);
  assert.equal(denied.outcome === "failed" && denied.namespaceDenied, true);
  const other = codexCommandSandboxProbe({ exitCode: 101, stderr: "panicked at linux-sandbox" });
  assert.deepEqual(other, { outcome: "failed", namespaceDenied: false,
    reason: "Codex's command sandbox could not run a command here (exit 101)" });
});

test("the outer boundary replaces only a workspace-write policy", () => {
  const outer = { network: "inherit" as const };
  const params = (permissionMode: string, profile: ":workspace" | ":read-only" | null = null) =>
    buildCodexTurnParams({ permissionMode } as SessionConfig, "t", "/repo", [], undefined, [], profile, false, [], [], outer);
  const external = { type: "externalSandbox", networkAccess: "enabled" };
  for (const mode of ["auto-review", "on-request", "untrusted", "on-failure", "workspace-write"]) {
    assert.deepEqual(params(mode).sandboxPolicy, external, mode);
  }
  // A launch profile cannot express the outer boundary, so the turn states it.
  assert.deepEqual(params("auto-review", ":workspace").sandboxPolicy, external);
  assert.deepEqual(params("orchestrator").sandboxPolicy, external);
  // The boundary would let a read-only turn write, so read-only keeps its own policy.
  assert.deepEqual(params("read-only").sandboxPolicy, { type: "readOnly" });
  assert.equal(params("read-only", ":read-only").sandboxPolicy, undefined);
  assert.deepEqual(params("danger-full-access").sandboxPolicy, { type: "dangerFullAccess" });
  // Without an outer boundary nothing changes.
  assert.deepEqual(buildCodexTurnParams({ permissionMode: "auto-review" } as SessionConfig, "t", "/repo", []).sandboxPolicy,
    { type: "workspaceWrite" });
});
