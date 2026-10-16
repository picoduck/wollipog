/**
 * The injected Wollipog CLI from inside a provider sandbox with network access off (#3270).
 *
 * Codex's Linux sandbox for every worker mode (codex-cli 0.162.1, codex-rs/linux-sandbox) is
 * bubblewrap with `--unshare-net` plus a seccomp filter that refuses connect() for every socket
 * family. This test builds that same sandbox from real bubblewrap and a cBPF copy of Codex's
 * `NetworkSeccompMode::Restricted` filter, provisions a real provider-mode session against a fake
 * control plane, and runs the real CLI entry inside it, in the workspace-write shape (one writable
 * workspace) and the read-only shape (nothing writable). In the SAME sandbox it shows the boundary
 * is unchanged: TCP to the control plane and to the session's loopback relay, an AF_UNIX connect,
 * and an outbound IP connect are all refused with EPERM. A control run of the same probes outside
 * the sandbox shows each of them otherwise succeeds, so those refusals are the sandbox's doing.
 *
 * The Platform Isolation job runs this on a real kernel and fails if it skips. An opt-in variant
 * runs the same probes under the real `codex sandbox`, wherever a Codex install can start one.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type SessionLaunchSpec } from "@wollipog/protocol";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { AGENT_CONTROL_RELAY_FIFO_ENV, AgentControlFifoRelays, agentControlFifoRelayBase } from "./agent-control-fifo-relay.js";
import { AGENT_CONTROL_RELAY_ENDPOINT_ENV, AgentControlRelaySockets } from "./agent-control-relay.js";
import {
  markAgentControlCredentialReady,
  provisionAgentControl,
  relayAgentControlRequest,
  removeAgentControlFiles,
} from "./agent-control.js";

const SESSION = "s_sandboxed_cli";
const CLI_ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));

/* ---------------------------------------------------------------------------------------------
 * Codex 0.162.1's network-off seccomp filter, as the cBPF program bubblewrap's --seccomp loads.
 * ------------------------------------------------------------------------------------------ */

const ARCHES = {
  x64: {
    audit: 0xc000003e,
    socket: 41, socketpair: 53,
    // connect accept sendto shutdown bind listen getsockname getpeername setsockopt getsockopt
    // accept4 recvmmsg sendmmsg ptrace process_vm_readv process_vm_writev io_uring_{setup,enter,register}
    denied: [42, 43, 44, 48, 49, 50, 51, 52, 54, 55, 288, 299, 307, 101, 310, 311, 425, 426, 427],
  },
  arm64: {
    audit: 0xc00000b7,
    socket: 198, socketpair: 199,
    denied: [203, 202, 206, 210, 200, 201, 204, 205, 208, 209, 242, 243, 269, 117, 270, 271, 425, 426, 427],
  },
} as const;

function codexNetworkOffSeccomp(arch: keyof typeof ARCHES): Buffer {
  const { audit, socket, socketpair, denied } = ARCHES[arch];
  const LD_ABS_W = 0x20, JEQ_K = 0x15, RET_K = 0x06;
  const ALLOW = 0x7fff0000, EPERM = 0x00050000 | 1, KILL = 0x80000000, AF_UNIX = 1;
  const program: Array<[number, number, number, number]> = [
    [LD_ABS_W, 0, 0, 4], // seccomp_data.arch
    [JEQ_K, 1, 0, audit],
    [RET_K, 0, 0, KILL],
    [LD_ABS_W, 0, 0, 0], // seccomp_data.nr
  ];
  const compared = [...denied, socket, socketpair];
  compared.forEach((nr, index) => {
    const remaining = compared.length - index;
    // Denied calls jump to EPERM; socket and socketpair jump to the AF_UNIX check after it.
    program.push([JEQ_K, index < denied.length ? remaining : remaining + 1, 0, nr]);
  });
  program.push(
    [RET_K, 0, 0, ALLOW],
    [RET_K, 0, 0, EPERM],
    [LD_ABS_W, 0, 0, 16], // args[0], the socket domain
    [JEQ_K, 0, 1, AF_UNIX],
    [RET_K, 0, 0, ALLOW],
    [RET_K, 0, 0, EPERM],
  );
  const bytes = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], index) => {
    bytes.writeUInt16LE(code, index * 8);
    bytes.writeUInt8(jt, index * 8 + 2);
    bytes.writeUInt8(jf, index * 8 + 3);
    bytes.writeUInt32LE(k >>> 0, index * 8 + 4);
  });
  return bytes;
}

const NAMESPACE_FLAGS = ["--new-session", "--die-with-parent", "--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-net"];

function bubblewrapUnavailable(): string | false {
  if (process.platform !== "linux") return "the Codex network sandbox is Linux-specific";
  if (!(process.arch in ARCHES)) return `no seccomp syscall table for ${process.arch}`;
  const smoke = spawnSync("bwrap", [...NAMESPACE_FLAGS, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  if (smoke.error) return `bubblewrap is not available (${smoke.error.message})`;
  if (smoke.status !== 0) return `bubblewrap cannot create a sandbox here: ${smoke.stderr.trim()}`;
  return false;
}
const SKIP_BWRAP = bubblewrapUnavailable();

const CODEX = process.env.CODEX_BIN || "codex";
function codexSandboxUnavailable(profileArgs: string[]): string | false {
  if (process.platform !== "linux") return "the Codex network sandbox is Linux-specific";
  const smoke = spawnSync(CODEX, ["sandbox", ...profileArgs, "--", "/bin/true"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, env: codexEnvironment() });
  if (smoke.error) return `codex is not installed (${smoke.error.message})`;
  if (smoke.status !== 0) return `codex cannot start this sandbox here: ${smoke.stderr.trim().split("\n").at(-1)}`;
  return false;
}

/** Runs inside the sandbox: plain JavaScript, so nothing in it needs the repository loader. */
const PROBE = fileURLToPath(new URL("./fixtures/sandboxed-cli-probe.mjs", import.meta.url));

interface ProbeResult {
  cli: { status: number | null; stdout: string; stderr: string };
  cliOverLoopbackRelay: { status: number | null; stdout: string; stderr: string };
  controlPlane: string;
  loopbackRelay: string;
  unixSocket: string;
  outbound: string;
  fifoDirectoryWrite: string;
  workspaceWrite: string;
}

/* ---------------------------------------------------------------------------------------------
 * One real provider-mode session against a fake control plane, shared by every case.
 * ------------------------------------------------------------------------------------------ */

let root = "";
let workspace = "";
let unixSocketPath = "";
let controlPlane: Server | undefined;
let unixServer: NetServer | undefined;
let controlPlanePort = 0;
let relayPort = 0;
let fifoDirectory = "";
let launch: SessionLaunchSpec;
const registeredHashes: string[] = [];
const controlPlaneSaw: Array<{ path: string; bearerHash: string; actor: string }> = [];
const loopbackRelays = new AgentControlRelaySockets(relayAgentControlRequest);
let fifoRelays: AgentControlFifoRelays | undefined;

before(async () => {
  if (process.platform !== "linux") return;
  root = mkdtempSync(join(tmpdir(), "wollipog-sandbox-cli-"));
  workspace = join(root, "workspace");
  mkdirSync(workspace);
  controlPlane = createServer((request, response) => {
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
    controlPlaneSaw.push({
      path: request.url ?? "",
      bearerHash: createHash("sha256").update(bearer).digest("hex"),
      actor: String(request.headers["x-wollipog-agent-session"] ?? ""),
    });
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/api/compatibility"
      ? JSON.stringify({ protocolVersion: PROTOCOL_VERSION })
      : JSON.stringify({ sessions: [] }));
  });
  controlPlanePort = await new Promise<number>((resolve) => {
    controlPlane!.listen(0, "127.0.0.1", () => resolve((controlPlane!.address() as { port: number }).port));
  });
  unixSocketPath = join(root, "host.sock");
  unixServer = createNetServer((socket) => socket.end());
  await new Promise<void>((resolve) => unixServer!.listen(unixSocketPath, () => resolve()));

  const configDir = join(root, "agent-control");
  fifoRelays = new AgentControlFifoRelays(agentControlFifoRelayBase(configDir), relayAgentControlRequest);
  const providerRelayEndpoint = await loopbackRelays.ensure(SESSION);
  relayPort = Number(new URL(providerRelayEndpoint).port);
  fifoDirectory = await fifoRelays.ensure(SESSION);
  launch = {
    sessionId: SESSION, workspaceId: "ws", workspacePath: workspace, agentId: "codex", command: "codex",
    args: [], env: {}, useWorktree: false, driver: "codex-app-server", context: { kind: "native" },
  };
  await provisionAgentControl(launch, {
    controlPlaneUrl: `ws://127.0.0.1:${controlPlanePort}/runner`,
    controlPlaneProtocolVersion: PROTOCOL_VERSION,
    executionIsolationMode: "provider",
    providerRelayEndpoint,
    providerRelayFifo: fifoDirectory,
    registerCredential: (_sessionId, hash) => registeredHashes.push(hash),
  }, () => {}, {
    isSea: false, execPath: process.execPath, execArgv: ["--import", "tsx"], scriptPath: CLI_ENTRY,
    configDir, platform: "linux",
  });
  markAgentControlCredentialReady(configDir, SESSION, registeredHashes[0]!);
  assert.equal(launch.env[AGENT_CONTROL_RELAY_FIFO_ENV], fifoDirectory);
  assert.equal(launch.env[AGENT_CONTROL_RELAY_ENDPOINT_ENV], providerRelayEndpoint);
});

after(async () => {
  await fifoRelays?.closeAll();
  await loopbackRelays.closeAll();
  await new Promise<void>((resolve) => (controlPlane ? controlPlane.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) => (unixServer ? unixServer.close(() => resolve()) : resolve()));
  if (root) {
    removeAgentControlFiles(SESSION, join(root, "agent-control"));
    // The FIFO relay base is 0300 and cannot be listed; open each directory before removing it.
    const relax = (directory: string) => {
      try { chmodSync(directory, 0o700); } catch { return; }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) relax(join(directory, entry.name));
      }
    };
    relax(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function sessionEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // A read-only sandbox has no writable temporary directory for the development loader's cache.
    TSX_DISABLE_CACHE: "1",
    ...launch.env,
  };
}

function codexEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) };
}

function run(command: string, args: string[], seccomp?: Buffer): Promise<ProbeResult> {
  // Files, not pipes: Node's pipes are socketpairs, which Node inside the filter cannot write to.
  const id = process.hrtime.bigint();
  const stdoutPath = join(root, `probe-${id}.out`);
  const stderrPath = join(root, `probe-${id}.err`);
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let seccompFd: number | undefined;
  if (seccomp) {
    const file = join(root, `seccomp-${id}.bpf`);
    writeFileSync(file, seccomp);
    seccompFd = openSync(file, "r");
  }
  return new Promise<ProbeResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: { ...sessionEnvironment(), ...(command === CODEX ? codexEnvironment() : {}) },
      stdio: ["ignore", stdoutFd, stderrFd, ...(seccompFd === undefined ? [] : [seccompFd])],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const stdout = readFileSync(stdoutPath, "utf8");
      const stderr = readFileSync(stderrPath, "utf8");
      try {
        resolve(JSON.parse(stdout.slice(stdout.indexOf("{"))) as ProbeResult);
      } catch {
        reject(new Error(`the probe did not report (exit ${code}): ${stdout}\n${stderr}`));
      }
    });
  }).finally(() => {
    for (const fd of [stdoutFd, stderrFd, seccompFd]) if (fd !== undefined) closeSync(fd);
  });
}

function probeArgs(): string[] {
  return [PROBE, String(controlPlanePort), String(relayPort), unixSocketPath, fifoDirectory];
}

function bubblewrap(shape: "workspace-write" | "read-only"): Promise<ProbeResult> {
  return run("bwrap", [
    ...NAMESPACE_FLAGS,
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
    ...(shape === "workspace-write" ? ["--bind", workspace, workspace] : []),
    "--chdir", workspace,
    "--seccomp", "3",
    "--", process.execPath, ...probeArgs(),
  ], codexNetworkOffSeccomp(process.arch as keyof typeof ARCHES));
}

function cleanProbeFiles(): void {
  rmSync(join(workspace, "probe-file"), { force: true });
  chmodSync(fifoDirectory, 0o700);
  rmSync(join(fifoDirectory, "probe-file"), { force: true });
  chmodSync(fifoDirectory, 0o300);
}

function assertCliSucceeded(result: ProbeResult, where: string): void {
  assert.equal(result.cli.status, 0, `${where}: ${result.cli.stdout}${result.cli.stderr}`);
  assert.deepEqual(JSON.parse(result.cli.stdout), { sessions: [] }, where);
}

function assertNoNetworkOrLoopback(result: ProbeResult, where: string): void {
  // EPERM is the seccomp filter's answer; a network namespace alone would refuse differently, and
  // nothing but the filter refuses a Unix socket the read-only mount still shows.
  assert.equal(result.controlPlane, "EPERM", `${where}: TCP to the control plane on 127.0.0.1`);
  assert.equal(result.loopbackRelay, "EPERM", `${where}: TCP to the session's loopback relay`);
  assert.equal(result.unixSocket, "EPERM", `${where}: AF_UNIX connect to a host socket`);
  assert.equal(result.outbound, "EPERM", `${where}: outbound IP`);
  // Without the FIFO channel the CLI meets exactly the failure #3270 reported, now with its cause.
  assert.equal(result.cliOverLoopbackRelay.status, 1, where);
  const { error } = JSON.parse(result.cliOverLoopbackRelay.stdout) as { error: string };
  assert.match(error, /^control plane compatibility check failed: connect EPERM 127\.0\.0\.1:\d+/u, where);
  assert.match(error, /sandbox blocks network and loopback connections.*use the wollipog MCP tools/u, where);
}

test("control: outside any sandbox every probe connects, so the refusals below are the sandbox's", { skip: process.platform !== "linux" }, async () => {
  const result = await run(process.execPath, probeArgs());
  try {
    assertCliSucceeded(result, "unsandboxed");
    assert.equal(result.cliOverLoopbackRelay.status, 0, "the loopback relay itself works outside a sandbox");
    assert.equal(result.controlPlane, "connected");
    assert.equal(result.loopbackRelay, "connected");
    assert.equal(result.unixSocket, "connected");
    assert.notEqual(result.outbound, "EPERM", "outside the sandbox nothing refuses an outbound socket");
    assert.equal(result.fifoDirectoryWrite, "written", "the runner's owner can write there; the sandbox below cannot");
    assert.equal(result.workspaceWrite, "written");
  } finally {
    cleanProbeFiles();
  }
});

for (const shape of ["workspace-write", "read-only"] as const) {
  test(`the CLI works from a ${shape} sandbox with network access off, which still reaches nothing else`, { skip: SKIP_BWRAP }, async () => {
    controlPlaneSaw.length = 0;
    const result = await bubblewrap(shape);
    try {
      assertCliSucceeded(result, shape);
      assertNoNetworkOrLoopback(result, shape);
      // The FIFO channel is not a writable root: its directory stays read-only like the rest.
      assert.equal(result.fifoDirectoryWrite, "EROFS", `${shape}: a file in the FIFO channel directory`);
      assert.equal(result.workspaceWrite, shape === "workspace-write" ? "written" : "EROFS", `${shape}: the workspace`);
      // The control plane saw the runner's memory-held bearer and this session as the actor.
      const fromCli = controlPlaneSaw.filter((request) => request.bearerHash === registeredHashes[0]);
      assert.ok(fromCli.some((request) => request.path === "/api/compatibility"), shape);
      assert.ok(fromCli.every((request) => request.actor === SESSION), shape);
      chmodSync(fifoDirectory, 0o700);
      assert.deepEqual(readdirSync(fifoDirectory), ["doorbell"], `${shape}: no per-request FIFO is left behind`);
      chmodSync(fifoDirectory, 0o300);
    } finally {
      cleanProbeFiles();
    }
  });
}

/* ---------------------------------------------------------------------------------------------
 * Opt-in: the same probes under the real `codex sandbox`, where a Codex install can start one.
 * ------------------------------------------------------------------------------------------ */

const CODEX_PROFILES = {
  // The profiles Codex itself selects for workspace-write and read-only worker turns.
  ":workspace": ["-P", ":workspace"],
  ":read-only": ["-P", ":read-only"],
  // Full write with network off applies Codex's seccomp filter without bubblewrap, so this one
  // measures the real filter even from inside another sandbox that refuses nested namespaces.
  "network-off seccomp only": [
    "-c", 'permissions.wollipog_network_off.filesystem={":root"="write"}',
    "-c", "permissions.wollipog_network_off.network.enabled=false",
    "-P", "wollipog_network_off",
  ],
} as const;

for (const [name, profile] of Object.entries(CODEX_PROFILES)) {
  const skip = process.platform !== "linux" ? "Linux only" : codexSandboxUnavailable([...profile]);
  test(`real codex sandbox (${name}): the CLI works and no socket reaches out`, { skip }, async () => {
    controlPlaneSaw.length = 0;
    const result = await run(CODEX, ["sandbox", "-C", workspace, ...profile, "--", process.execPath, ...probeArgs()]);
    try {
      assertCliSucceeded(result, name);
      assertNoNetworkOrLoopback(result, name);
      if (name !== "network-off seccomp only") assert.equal(result.fifoDirectoryWrite, "EROFS", name);
      assert.ok(controlPlaneSaw.some((request) => request.path === "/api/compatibility" &&
        request.bearerHash === registeredHashes[0] && request.actor === SESSION), name);
    } finally {
      cleanProbeFiles();
      assert.equal(existsSync(fifoDirectory), true);
    }
  });
}
