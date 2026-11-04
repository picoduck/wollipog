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
  resolveTrustedExecutable,
  type ProbeFileSystem,
} from "../codex-sandbox-probe-command.js";
import type { SpawnIsolation } from "../spawn.js";

const linuxOnly = process.platform === "linux" ? false : "the launch probe runs on native Linux only";
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));
const PROBE = ["/usr/bin/printf", CODEX_SANDBOX_PROBE_SENTINEL];
const PROBE_COMMAND = { argv: PROBE, visited: ["/", "/usr", "/usr/bin", "/usr/bin/printf"] };

/** codex-cli 0.165.0's `command/exec` response when its nested bubblewrap cannot start. */
const NESTED_BWRAP_FAILURE = {
  exitCode: 1,
  stdout: "",
  stderr: "bwrap: No permissions to create new namespace, likely because the kernel does not allow " +
    "non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.\n",
};
/** The same probe when the sandbox starts: the command ran and printed the sentinel. */
const STARTED = { exitCode: 0, stdout: CODEX_SANDBOX_PROBE_SENTINEL, stderr: "" };

type FakeEntry = { type: "dir" | "file" | "link"; uid?: number; mode?: number; target?: string };
/** A file system in the probe's trust model: entries are root's and 0755 unless stated, links
 * 0777 as on Linux. Anything not listed does not exist. */
function fakeFs(entries: Record<string, FakeEntry>): ProbeFileSystem {
  const base: Record<string, FakeEntry> = { "/": { type: "dir" }, "/usr": { type: "dir" }, "/usr/bin": { type: "dir" }, ...entries };
  const lookup = (path: string) => {
    const entry = base[path];
    if (!entry) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    return entry;
  };
  return {
    lstat: (path) => {
      const entry = lookup(path);
      return { isFile: () => entry.type === "file", isDirectory: () => entry.type === "dir",
        isSymbolicLink: () => entry.type === "link", uid: entry.uid ?? 0, mode: entry.mode ?? (entry.type === "link" ? 0o777 : 0o755) };
    },
    readlink: (path) => {
      const entry = lookup(path);
      if (entry.type !== "link") throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      return entry.target!;
    },
  };
}
const PRINTF = { "/usr/bin/printf": { type: "file" } } as const;
/** `/usr/bin/printf -> /bin/busybox` with merged-usr `/bin -> usr/bin`, as on BusyBox systems. */
const BUSYBOX = {
  "/bin": { type: "link", target: "usr/bin" }, "/usr/bin/busybox": { type: "file" },
  "/usr/bin/printf": { type: "link", target: "/bin/busybox" },
} as const;

function bwrap(network: "inherit" | "deny", extra: Partial<Extract<SpawnIsolation, { backend: "bwrap" }>> = {}): SpawnIsolation {
  return { backend: "bwrap", command: "/usr/bin/bwrap", args: [], network, ...extra };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function driverWith(options: {
  isolation?: SpawnIsolation; config?: SessionConfig; probe: (params: any) => unknown;
  probeCommand?: { argv: string[]; visited: string[] } | null;
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
    sandboxProbeCommand: () => options.probeCommand === undefined ? PROBE_COMMAND : options.probeCommand,
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
    // The refusal beside other diagnostic output is not the probe's only failure.
    { exitCode: 1, stdout: "", stderr: `something else failed first\n${NESTED_BWRAP_FAILURE.stderr}` },
    { exitCode: 1, stdout: "", stderr: `${NESTED_BWRAP_FAILURE.stderr}bwrap: execvp printf: No such file\n` },
    // A clean exit without the sentinel proves nothing either way.
    { exitCode: 0, stdout: "", stderr: "" },
  ]) {
    const h = driverWith({ isolation: bwrap("inherit"), probe: () => response });
    assert.deepEqual((await h.firstTurn()).sandboxPolicy, { type: "workspaceWrite" }, JSON.stringify(response));
    assert.equal(h.sandboxEvents().includes("codex_command_sandbox_outer_boundary"), false);
  }
});

test("without a trusted probe command, or with one whose path crosses a writable root, nothing changes", { skip: linuxOnly }, async () => {
  const writable = [["codex_command_sandbox_probe_inconclusive", "probe_command_writable"]];
  const cases: Array<[{ probeCommand: { argv: string[]; visited: string[] } | null; isolation?: SpawnIsolation }, string[][]]> = [
    [{ probeCommand: null }, []],
    [{ probeCommand: { argv: ["/repo/bin/printf", CODEX_SANDBOX_PROBE_SENTINEL], visited: ["/", "/repo", "/repo/bin", "/repo/bin/printf"] } }, writable],
    [{ probeCommand: PROBE_COMMAND, isolation: bwrap("inherit", { writableBinds: [{ source: "/usr/bin", target: "/usr/bin" }] }) }, writable],
    // CR-3.1: an intermediate hop under a root the boundary makes writable, even though both
    // endpoints are system paths.
    [{ probeCommand: { argv: PROBE, visited: ["/", "/usr", "/usr/bin", "/usr/bin/printf", "/repo", "/repo/probe-link", "/usr/lib", "/usr/lib/trusted-printf"] } }, writable],
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

test("a printf symlinked to a BusyBox-style multicall binary probes a healthy sandbox as healthy (CR-2.1)", { skip: linuxOnly }, async () => {
  const command = codexSandboxProbeCommand(fakeFs(BUSYBOX));
  // The validated link runs by its own name, so the multicall binary still selects `printf`.
  assert.deepEqual(command?.argv, ["/usr/bin/printf", CODEX_SANDBOX_PROBE_SENTINEL]);
  assert.deepEqual(command?.visited, ["/", "/usr", "/usr/bin", "/usr/bin/printf", "/bin", "/usr", "/usr/bin", "/usr/bin/busybox"]);
  /** Answers as a multicall binary does: the applet is the name it was invoked by. */
  const multicall = (params: any) => params.command[0].endsWith("/printf")
    ? { exitCode: 0, stdout: params.command[1], stderr: "" }
    : { exitCode: 1, stdout: "", stderr: `${params.command[1]}: applet not found\n` };
  for (const isolation of [undefined, bwrap("inherit")]) {
    const h = driverWith({ ...(isolation ? { isolation } : {}), probeCommand: command, probe: multicall });
    assert.deepEqual((await h.firstTurn()).sandboxPolicy, { type: "workspaceWrite" }, "no refusal, no fallback");
    assert.deepEqual(h.sandboxEvents(), []);
  }
  // Had the canonical target run instead, the probe would fail without a namespace denial; that
  // keeps today's policy, inside a boundary or not, and never refuses the launch.
  for (const isolation of [undefined, bwrap("inherit")]) {
    const h = driverWith({ ...(isolation ? { isolation } : {}),
      probeCommand: { argv: ["/usr/bin/busybox", CODEX_SANDBOX_PROBE_SENTINEL], visited: ["/", "/usr", "/usr/bin", "/usr/bin/busybox"] },
      probe: multicall });
    assert.deepEqual((await h.firstTurn()).sandboxPolicy, { type: "workspaceWrite" });
    assert.deepEqual(h.sandboxEvents(), ["codex_command_sandbox_unavailable"]);
  }
});
/* eslint-enable @typescript-eslint/no-explicit-any */

test("the probe command is resolved by absolute path, never from PATH (CR-1.1)", { skip: linuxOnly }, () => {
  // A session-writable directory first on PATH holding fake `true` and `printf` that imitate
  // bubblewrap's refusal changes nothing: the command is a fixed absolute candidate.
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
      assert.ok(command.argv[0] === "/usr/bin/printf" || command.argv[0] === "/bin/printf", String(command.argv[0]));
      assert.deepEqual(command.argv.slice(1), [CODEX_SANDBOX_PROBE_SENTINEL]);
      assert.equal(command.visited.some((visited) => visited.startsWith(fake)), false);
    }
  } finally {
    process.env.PATH = path;
    rmSync(fake, { recursive: true, force: true });
  }
});

test("the whole resolution of the probe path is validated, hop by hop (CR-3.1)", () => {
  const resolve = (entries: Record<string, FakeEntry>, path = "/usr/bin/printf") =>
    resolveTrustedExecutable(path, fakeFs(entries));
  assert.deepEqual(resolve(PRINTF), { target: "/usr/bin/printf", visited: ["/", "/usr", "/usr/bin", "/usr/bin/printf"] });
  // Merged /usr: `/bin -> usr/bin`.
  assert.equal(resolve({ ...PRINTF, "/bin": { type: "link", target: "usr/bin" } }, "/bin/printf")?.target, "/usr/bin/printf");
  assert.equal(resolve(BUSYBOX)?.target, "/usr/bin/busybox");

  const trustedFinal = { "/usr/lib": { type: "dir" }, "/usr/lib/trusted-printf": { type: "file" } } as const;
  const rejected: Array<[string, Record<string, FakeEntry>, string?]> = [
    // A link through a session-writable directory, even when both endpoints are trusted.
    ["intermediate link in a writable directory", { ...trustedFinal, "/repo": { type: "dir", uid: 1000 },
      "/repo/probe-link": { type: "link", target: "/usr/lib/trusted-printf" },
      "/usr/bin/printf": { type: "link", target: "/repo/probe-link" } }],
    ["intermediate link in a world-writable directory", { ...trustedFinal, "/repo": { type: "dir", mode: 0o1777 },
      "/repo/probe-link": { type: "link", target: "/usr/lib/trusted-printf" },
      "/usr/bin/printf": { type: "link", target: "/repo/probe-link" } }],
    // An intermediate DIRECTORY symlink, owned by someone else or leading somewhere writable.
    ["intermediate directory link not owned by root", { ...trustedFinal, "/usr/libx": { type: "link", uid: 1000, target: "/usr/lib" },
      "/usr/bin/printf": { type: "link", target: "/usr/libx/trusted-printf" } }],
    ["intermediate directory link into a writable directory", { "/home": { type: "dir" }, "/home/u": { type: "dir", uid: 1000 },
      "/home/u/printf": { type: "file", uid: 0 }, "/usr/lib": { type: "link", target: "/home/u" },
      "/usr/bin/printf": { type: "link", target: "/usr/lib/printf" } }],
    // A relative link that climbs out of the trusted tree.
    ["relative link escaping upwards", { "/home": { type: "dir" }, "/home/u": { type: "dir", uid: 1000 },
      "/home/u/printf": { type: "file" }, "/usr/bin/printf": { type: "link", target: "../../../../home/u/printf" } }],
    ["link not owned by root", { "/usr/bin/real": { type: "file" }, "/usr/bin/printf": { type: "link", uid: 1000, target: "real" } }],
    ["group-writable file", { "/usr/bin/printf": { type: "file", mode: 0o775 } }],
    ["file not owned by root", { "/usr/bin/printf": { type: "file", uid: 1000 } }],
    ["not executable", { "/usr/bin/printf": { type: "file", mode: 0o644 } }],
    ["final file outside /usr and /bin", { "/opt": { type: "dir" }, "/opt/printf": { type: "file" },
      "/usr/bin/printf": { type: "link", target: "/opt/printf" } }],
    ["writable /usr/bin", { ...PRINTF, "/usr/bin": { type: "dir", mode: 0o777 } }],
    ["link loop", { "/usr/bin/a": { type: "link", target: "b" }, "/usr/bin/b": { type: "link", target: "a" },
      "/usr/bin/printf": { type: "link", target: "a" } }],
    ["dangling link", { "/usr/bin/printf": { type: "link", target: "/usr/bin/missing" } }],
    ["final entry a directory", { "/usr/bin/printf": { type: "dir" } }],
    ["relative candidate", PRINTF, "usr/bin/printf"],
    // Mounted afresh inside the boundary, and /proc/self names another process there.
    ["hop through /proc", { "/proc": { type: "dir" }, "/proc/self": { type: "link", target: "1" }, "/proc/1": { type: "dir" },
      "/proc/1/exe": { type: "file" }, "/usr/bin/printf": { type: "link", target: "/proc/self/exe" } }],
    ["hop through /tmp", { "/tmp": { type: "dir" }, "/tmp/printf": { type: "file" },
      "/usr/bin/printf": { type: "link", target: "/tmp/printf" } }],
  ];
  for (const [name, entries, path] of rejected) assert.equal(resolve(entries, path), null, name);

  // A root-owned intermediate hop the outer boundary makes writable passes the resolver, and its
  // visited path is what the driver checks against the boundary's writable roots.
  const throughRepo = resolve({ ...trustedFinal, "/repo": { type: "dir" },
    "/repo/probe-link": { type: "link", target: "/usr/lib/trusted-printf" },
    "/usr/bin/printf": { type: "link", target: "/repo/probe-link" } });
  assert.ok(throughRepo?.visited.includes("/repo/probe-link"));
  assert.equal(throughRepo!.visited.some((path) => probeExecutableWritable(path, ["/repo"])), true);
  assert.equal(probeExecutableWritable("/usr/bin/printf", ["/repo", "/usr/binx"]), false);
  assert.equal(probeExecutableWritable("/usr/bin/printf", ["/usr"]), true);
});

test("the probe reads a failure only when the command never started and bubblewrap refused", () => {
  assert.deepEqual(codexCommandSandboxProbe(STARTED), { outcome: "started" });
  assert.deepEqual(codexCommandSandboxProbe({ thread: { id: "x" } }), { outcome: "inconclusive" });
  const denied = codexCommandSandboxProbe(NESTED_BWRAP_FAILURE);
  assert.equal(denied.outcome === "failed" && denied.namespaceDenied, true);
  // The Codex CLI's own WARNING notice before the refusal, as `codex sandbox` prints (measured).
  const warned = codexCommandSandboxProbe({ ...NESTED_BWRAP_FAILURE,
    stderr: `WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)\n${NESTED_BWRAP_FAILURE.stderr}` });
  assert.equal(warned.outcome === "failed" && warned.namespaceDenied, true);
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
