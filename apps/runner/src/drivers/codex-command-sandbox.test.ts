/**
 * Codex's command sandbox nested in the runner's own bubblewrap boundary (#3843). On a host that
 * restricts unprivileged user namespaces, Codex's workspace sandbox starts a second bubblewrap that
 * cannot create its namespace, so every command fails and escalates. The launch probe runs a
 * trusted system `printf` under the policy the turns will send; these fixtures answer it the way
 * codex-cli 0.165.0 does inside a bwrap session on such a host (measured 2026-10-30).
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionConfig } from "@wollipog/protocol";
import {
  buildCodexTurnParams,
  CodexAppServerDriver,
  CodexCommandSandboxUnavailableError,
  codexCommandSandboxProbe,
} from "./codex-app-server.js";
import {
  CODEX_SANDBOX_PROBE_ENV,
  CODEX_SANDBOX_PROBE_SENTINEL,
  codexSandboxProbeCommand,
  probeExecutableWritable,
  type ProbeFileSystem,
} from "../codex-sandbox-probe-command.js";
import type { SpawnIsolation } from "../spawn.js";

const linuxOnly = process.platform === "linux" ? false : "the launch probe runs on native Linux only";
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));
const PROBE = ["/usr/bin/printf", CODEX_SANDBOX_PROBE_SENTINEL];

/** codex-cli 0.165.0's `command/exec` response when its nested bubblewrap cannot start. */
const NESTED_BWRAP_FAILURE = {
  exitCode: 1,
  stdout: "",
  stderr: "bwrap: No permissions to create new namespace, likely because the kernel does not allow " +
    "non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.\n",
};
/** The same probe when the sandbox starts: the command ran and printed the sentinel. */
const STARTED = { exitCode: 0, stdout: CODEX_SANDBOX_PROBE_SENTINEL, stderr: "" };

function bwrap(network: "inherit" | "deny", extra: Partial<Extract<SpawnIsolation, { backend: "bwrap" }>> = {}): SpawnIsolation {
  return { backend: "bwrap", command: "/usr/bin/bwrap", args: [], network, ...extra };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function driverWith(options: {
  isolation?: SpawnIsolation; config?: SessionConfig; probe: (params: any) => unknown;
  probeCommand?: string[] | null;
}) {
  const stderr: string[] = [];
  const sandboxEvents = () => stderr.map((line) => JSON.parse(line)).filter((event) => event.event.startsWith("codex_command_sandbox"));
  const probes: any[] = [];
  const turns: any[] = [];
  const driver = new CodexAppServerDriver({
    command: "codex", args: [], cwd: "/repo", env: {},
    config: options.config ?? {}, context: { kind: "native" },
    ...(options.isolation ? { isolation: options.isolation } : {}),
  }, { onEvent() {}, onStderr: (line) => stderr.push(line), onExit() {} }, undefined, {
    sandboxProbeCommand: () => options.probeCommand === undefined ? PROBE : options.probeCommand,
  }) as any;
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
  return { driver, sandboxEvents: () => sandboxEvents().map((event) => event.event), events: sandboxEvents, probes, turns, firstTurn };
}

test("inside the runner's bwrap boundary, a nested sandbox that cannot start hands commands to that boundary", { skip: linuxOnly }, async () => {
  for (const network of ["inherit", "deny"] as const) {
    const h = driverWith({ isolation: bwrap(network), probe: () => NESTED_BWRAP_FAILURE });
    const turn = await h.firstTurn();
    // The probe used exactly the policy the turn would otherwise have sent, a trusted absolute
    // command, and an environment with a fixed PATH and no loader overrides.
    assert.deepEqual(h.probes.map((probe) => [probe.command, probe.sandboxPolicy, probe.env]),
      [[PROBE, { type: "workspaceWrite" }, CODEX_SANDBOX_PROBE_ENV]]);
    assert.deepEqual(turn.sandboxPolicy,
      { type: "externalSandbox", networkAccess: network === "deny" ? "restricted" : "enabled" });
    // The approval policy and reviewer are untouched: escalations still reach their owners.
    assert.equal(turn.approvalPolicy, "on-request");
    assert.equal(turn.approvalsReviewer, "auto_review");
    assert.deepEqual(h.sandboxEvents(), ["codex_command_sandbox_outer_boundary"]);
  }
});

test("a nested sandbox that starts keeps Codex's own workspace sandbox", { skip: linuxOnly }, async () => {
  const h = driverWith({ isolation: bwrap("inherit"), probe: () => STARTED });
  assert.deepEqual((await h.firstTurn()).sandboxPolicy, { type: "workspaceWrite" });
  assert.deepEqual(h.sandboxEvents(), []);
});

test("output a started command prints cannot pass for a sandbox that never started (CR-1.1)", { skip: linuxOnly }, async () => {
  for (const response of [
    // A program that ran, printed the sentinel, and then imitated bubblewrap's refusal.
    { exitCode: 1, stdout: CODEX_SANDBOX_PROBE_SENTINEL, stderr: NESTED_BWRAP_FAILURE.stderr },
    // The refusal text quoted inside another message rather than as bubblewrap's own line.
    { exitCode: 1, stdout: "", stderr: "error: bwrap: No permissions to create new namespace\n" },
    // A clean exit without the sentinel proves nothing either way.
    { exitCode: 0, stdout: "", stderr: "" },
  ]) {
    const h = driverWith({ isolation: bwrap("inherit"), probe: () => response });
    assert.deepEqual((await h.firstTurn()).sandboxPolicy, { type: "workspaceWrite" }, JSON.stringify(response));
    assert.equal(h.sandboxEvents().includes("codex_command_sandbox_outer_boundary"), false);
  }
});

test("without a trusted probe command, or with one the boundary makes writable, nothing changes", { skip: linuxOnly }, async () => {
  const cases: Array<[{ probeCommand: string[] | null; isolation?: SpawnIsolation }, string[][]]> = [
    [{ probeCommand: null }, []],
    [{ probeCommand: ["/repo/bin/printf", CODEX_SANDBOX_PROBE_SENTINEL] },
      [["codex_command_sandbox_probe_inconclusive", "probe_command_writable"]]],
    [{ probeCommand: PROBE, isolation: bwrap("inherit", { writableBinds: [{ source: "/usr/bin", target: "/usr/bin" }] }) },
      [["codex_command_sandbox_probe_inconclusive", "probe_command_writable"]]],
  ];
  for (const [options, events] of cases) {
    const h = driverWith({ isolation: bwrap("inherit"), ...options, probe: () => NESTED_BWRAP_FAILURE });
    assert.deepEqual((await h.firstTurn()).sandboxPolicy, { type: "workspaceWrite" });
    assert.deepEqual(h.probes, [], "the probe does not run");
    assert.deepEqual(h.events().map((event) => [event.event, event.reason]), events);
  }
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

test("the probe command is a root-owned system printf, never one found on PATH (CR-1.1)", { skip: linuxOnly }, () => {
  // A session-writable directory first on PATH holding fake `true` and `printf` that imitate
  // bubblewrap's refusal changes nothing: the command is resolved by absolute path.
  const fake = mkdtempSync(join(tmpdir(), "wollipog-fake-probe-"));
  const path = process.env.PATH;
  try {
    for (const name of ["true", "printf"]) {
      writeFileSync(join(fake, name), "#!/bin/sh\necho 'bwrap: No permissions to create new namespace' >&2\nexit 1\n");
      chmodSync(join(fake, name), 0o755);
    }
    process.env.PATH = `${fake}:${path}`;
    const command = codexSandboxProbeCommand();
    if (command) {
      assert.ok(command[0] === "/usr/bin/printf" || command[0] === "/bin/printf", String(command[0]));
      assert.deepEqual(command.slice(1), [CODEX_SANDBOX_PROBE_SENTINEL]);
    }
  } finally {
    process.env.PATH = path;
    rmSync(fake, { recursive: true, force: true });
  }
  type Overrides = Record<string, Partial<{ uid: number; mode: number; file: boolean }>>;
  const fs = (overrides: Overrides, real = (p: string) => p): ProbeFileSystem => ({
    realpath: real,
    stat: (p) => {
      const entry = { uid: 0, mode: p === "/usr/bin/printf" || p === "/bin/printf" ? 0o755 : 0o755, file: p.endsWith("printf"), ...overrides[p] };
      return { isFile: () => entry.file, isDirectory: () => !entry.file, uid: entry.uid, mode: entry.mode };
    },
  });
  assert.deepEqual(codexSandboxProbeCommand(fs({})), ["/usr/bin/printf", CODEX_SANDBOX_PROBE_SENTINEL]);
  // Not root-owned, group-writable, under a writable directory, or resolving outside /usr and /bin.
  const bads: Overrides[] = [{ "/usr/bin/printf": { uid: 1000 } }, { "/usr/bin/printf": { mode: 0o775 } }, { "/usr/bin": { mode: 0o777 } }];
  for (const bad of bads) {
    assert.deepEqual(codexSandboxProbeCommand(fs({ ...bad, "/bin/printf": { uid: 1000 } })), null, JSON.stringify(bad));
  }
  assert.equal(codexSandboxProbeCommand(fs({}, () => "/home/u/printf")), null);
  assert.equal(probeExecutableWritable("/usr/bin/printf", ["/repo", "/usr"]), true);
  assert.equal(probeExecutableWritable("/usr/bin/printf", ["/repo", "/usr/bin/printf"]), true);
  assert.equal(probeExecutableWritable("/usr/bin/printf", ["/repo", "/usr/binx"]), false);
});

test("the probe reads a failure only when the command never started and bubblewrap refused", () => {
  assert.deepEqual(codexCommandSandboxProbe(STARTED), { outcome: "started" });
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
