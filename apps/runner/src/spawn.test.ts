import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { test } from "node:test";
import { buildBwrapArgs, buildCloudArgs, buildContainerArgs, buildWslArgs, killTree, spawnAgent, terminateDescendantBoundariesAfterPendingKills, trackPendingKill, waitForPendingKills, winQuoteArg, type AgentProcess } from "./spawn.js";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { encodeWindowsJobSpec, materializeWindowsJobLauncher, WINDOWS_JOB_LAUNCHER } from "./windows-job.js";
import { extendOwnedProcessTree, ownsPosixRootProcessGroup, parsePosixProcessTable } from "./posix-process-tree.js";

const windowsJobLauncherPath = materializeWindowsJobLauncher();

const windowsJobIsolation = {
  backend: "windows-job" as const,
  command: "powershell.exe",
  args: [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", windowsJobLauncherPath,
  ],
  network: "inherit" as const,
};

test("Windows Job launcher is materialized once, caches its bridge, and clears both specs", () => {
  assert.equal(materializeWindowsJobLauncher(), windowsJobLauncherPath);
  assert.equal(readFileSync(windowsJobLauncherPath, "utf8"), WINDOWS_JOB_LAUNCHER);
  assert.match(WINDOWS_JOB_LAUNCHER, /if \(Test-Path Env:WOLLIPOG_WINDOWS_JOB_SPEC\) \{ \$Spec = \$env:WOLLIPOG_WINDOWS_JOB_SPEC \}/);
  assert.match(WINDOWS_JOB_LAUNCHER, /else \{ \$Spec = \$env:MAM_WINDOWS_JOB_SPEC \}/);
  assert.doesNotMatch(
    WINDOWS_JOB_LAUNCHER,
    /IsNullOrWhiteSpace\(\$Spec\)\) \{ \$Spec = \$env:MAM_WINDOWS_JOB_SPEC/,
    "an explicitly empty current value must fail closed instead of selecting legacy",
  );
  assert.match(WINDOWS_JOB_LAUNCHER, /\$env:WOLLIPOG_WINDOWS_JOB_SPEC = \$null/);
  assert.match(WINDOWS_JOB_LAUNCHER, /\$env:MAM_WINDOWS_JOB_SPEC = \$null/);
  assert.match(WINDOWS_JOB_LAUNCHER, /WollipogWindowsJob/);
  assert.match(WINDOWS_JOB_LAUNCHER, /OpenProcess/);
  assert.match(WINDOWS_JOB_LAUNCHER, /WaitForMultipleObjects/);
  assert.match(WINDOWS_JOB_LAUNCHER, /Test-Path -LiteralPath \$BridgePath -PathType Leaf/);
  assert.match(WINDOWS_JOB_LAUNCHER, /Add-Type -Path \$BridgePath/);
  assert.match(WINDOWS_JOB_LAUNCHER, /bridge-unavailable/);
  assert.match(WINDOWS_JOB_LAUNCHER, /job-assignment/);
  assert.doesNotMatch(WINDOWS_JOB_LAUNCHER, /MamWindowsJob/);
});

test("Windows Job launcher treats an explicitly empty Wollipog spec as authoritative", {
  skip: process.platform !== "win32",
}, () => {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", windowsJobLauncherPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      WOLLIPOG_WINDOWS_JOB_SPEC: "",
      MAM_WINDOWS_JOB_SPEC: "legacy-would-not-report-missing",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /missing Wollipog Windows Job launch specification/);
});

test("Windows Job launcher classifies malformed specs without echoing them", {
  skip: process.platform !== "win32",
}, () => {
  const secretShapedInput = "not-base64-private-launch-data";
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", windowsJobLauncherPath], {
    encoding: "utf8",
    env: { ...process.env, WOLLIPOG_WINDOWS_JOB_SPEC: secretShapedInput },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /Windows Job isolation failed \(invalid-spec\)/);
  assert.doesNotMatch(output, new RegExp(secretShapedInput));
});

test("Windows Job launcher reuses its compiled bridge across provider starts", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, (t) => {
  const bridgePath = path.join(path.dirname(windowsJobLauncherPath), "WollipogWindowsJob.dll");
  const launch = () => {
    const started = performance.now();
    const result = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", windowsJobLauncherPath,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        WOLLIPOG_WINDOWS_JOB_SPEC: encodeWindowsJobSpec(
          process.execPath,
          ["-e", "process.exit(0)"],
          os.tmpdir(),
          process.pid,
        ),
      },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    return performance.now() - started;
  };

  const firstMs = launch();
  const firstMtime = statSync(bridgePath).mtimeMs;
  const secondMs = launch();
  assert.equal(statSync(bridgePath).mtimeMs, firstMtime, "the second launch loads rather than recompiles the bridge");
  t.diagnostic(`Windows Job launcher startup: first=${firstMs.toFixed(1)}ms cached=${secondMs.toFixed(1)}ms`);
});

test("Docker and Podman argv emit exact dual labels for rollback and mount only the worktree", () => {
  for (const runtime of ["docker", "podman"] as const) {
    const args = buildContainerArgs(
      { command: "C:\\host\\codex.cmd", args: ["--host-config", "--json"], cwd: "C:\\worktrees\\session-1", containerAgentLaunch: true },
      {
        backend: "container", command: runtime, args: [],
        image: `example/agent@sha256:${"b".repeat(64)}`, network: "deny", templateId: "tools",
        runnerKey: "runnerkey", containerName: "wollipog-session",
        hostAgentCommand: "C:\\host\\codex.cmd", hostAgentArgs: ["--host-config"],
        agentCommand: "codex", agentArgs: ["app-server"],
      },
    );
    assert.deepEqual(args, [
      "run", "--rm", "--interactive", "--init", "--name", "wollipog-session",
      "--label", "com.wollipog.runner=runnerkey",
      "--label", "com.wollipog.template=tools",
      "--label", "com.misko-agent-manager.runner=runnerkey",
      "--label", "com.misko-agent-manager.template=tools", "--sig-proxy=true",
      "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
      "--tmpfs", "/tmp:rw,nosuid,nodev",
      "--mount", "type=bind,src=C:\\worktrees\\session-1,dst=/workspace", "--workdir", "/workspace",
      `example/agent@sha256:${"b".repeat(64)}`, "codex", "app-server", "--json",
    ]);
  }
  assert.throws(() => buildContainerArgs({ command: "agent", args: [], cwd: "C:\\bad,path" }, {
    backend: "container", command: "docker", args: [], image: `x@sha256:${"c".repeat(64)}`,
    network: "bridge", templateId: "x", runnerKey: "runnerkey", containerName: "wollipog-x",
    hostAgentCommand: "agent", hostAgentArgs: [], agentCommand: "agent", agentArgs: [],
  }), /mount character/);
  assert.deepEqual(buildContainerArgs(
    { command: "C:\\host-tools\\git.exe", args: ["status"], cwd: "C:\\worktrees\\session-1" },
    {
      backend: "container", command: "docker", args: [], image: `x@sha256:${"c".repeat(64)}`,
      network: "bridge", templateId: "x", runnerKey: "runnerkey", containerName: "wollipog-x",
      hostAgentCommand: "agent", hostAgentArgs: [], agentCommand: "agent", agentArgs: ["host-only"],
    },
  ).slice(-3), [`x@sha256:${"c".repeat(64)}`, "git", "status"]);
  assert.throws(() => buildContainerArgs(
    { command: "agent", args: ["--unexpected"], cwd: "C:\\worktrees\\session-1", containerAgentLaunch: true },
    {
      backend: "container", command: "docker", args: [], image: `x@sha256:${"c".repeat(64)}`,
      network: "bridge", templateId: "x", runnerKey: "runnerkey", containerName: "wollipog-x",
      hostAgentCommand: "agent", hostAgentArgs: ["--configured"], agentCommand: "agent", agentArgs: [],
    },
  ), /arguments do not match/);
});

test("container launches exclude explicit and inherited product-prefixed values from the runtime client", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-container-env-"));
  const script = path.join(root, "runtime-probe.js");
  await fs.writeFile(script, "process.stdout.write(JSON.stringify({explicit:process.env.WOLLIPOG_CONTAINER_EXPLICIT??null,current:process.env.WOLLIPOG_PLAIN??null,legacy:process.env.MAM_PLAIN??null}));", "utf8");
  const oldCurrent = process.env.WOLLIPOG_PLAIN;
  const oldLegacy = process.env.MAM_PLAIN;
  process.env.WOLLIPOG_PLAIN = "current-daemon-value";
  process.env.MAM_PLAIN = "legacy-daemon-value";
  try {
    const child = spawnAgent({
      command: "agent", args: [], cwd: root,
      env: { WOLLIPOG_CONTAINER_EXPLICIT: "configured-secret" },
      containerAgentLaunch: true,
      isolation: {
        backend: "container", command: process.execPath, args: [script],
        image: `x@sha256:${"d".repeat(64)}`, network: "deny", templateId: "x",
        runnerKey: "runnerkey", containerName: "wollipog-x", hostAgentCommand: "agent",
        hostAgentArgs: [], agentCommand: "agent", agentArgs: [],
      },
    });
    assert.equal(child.posixBoundary, undefined, "the native runtime client keeps its remote lifecycle boundary");
    child.stdin.end();
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => (out += text));
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    assert.equal(child.closeObserved, true);
    assert.deepEqual(JSON.parse(out), { explicit: null, current: null, legacy: null });
  } finally {
    if (oldCurrent === undefined) delete process.env.WOLLIPOG_PLAIN;
    else process.env.WOLLIPOG_PLAIN = oldCurrent;
    if (oldLegacy === undefined) delete process.env.MAM_PLAIN;
    else process.env.MAM_PLAIN = oldLegacy;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloud argv uses the accepted handoff and keeps provider and helper commands distinct", () => {
  const isolation = {
    backend: "cloud" as const,
    command: "cloud-proxy",
    args: ["--profile", "team"],
    env: {},
    targetId: "metered-tools",
    handoffId: "handoff-1",
    sessionId: "session-1",
    hostAgentCommand: "C:\\host\\codex.cmd",
    hostAgentArgs: ["--host-only"],
    agentCommand: "codex",
    agentArgs: ["app-server"],
  };
  assert.deepEqual(buildCloudArgs({
    command: "C:\\host\\codex.cmd", args: ["--host-only", "--json"], cloudAgentLaunch: true,
  }, isolation), [
    "--profile", "team", "connect", "--protocol", "1", "--target", "metered-tools",
    "--handoff", "handoff-1", "--session", "session-1", "--", "codex", "app-server", "--json",
  ]);
  assert.deepEqual(buildCloudArgs({ command: "C:\\tools\\git.exe", args: ["status"] }, isolation).slice(-3), ["--", "git", "status"]);
  assert.throws(() => buildCloudArgs({
    command: "C:\\host\\codex.cmd", args: ["--wrong"], cloudAgentLaunch: true,
  }, isolation), /arguments do not match/);
});

test("cloud launches expose only adapter references, not provider or inherited product-prefixed values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-cloud-env-"));
  const script = path.join(root, "proxy-probe.js");
  await fs.writeFile(script, "process.stdout.write(JSON.stringify({adapter:process.env.CLOUD_ADAPTER_TOKEN??null,provider:process.env.OPENAI_API_KEY??null,current:process.env.WOLLIPOG_PLAIN??null,legacy:process.env.MAM_PLAIN??null,args:process.argv.slice(2)}));", "utf8");
  const oldCurrent = process.env.WOLLIPOG_PLAIN;
  const oldLegacy = process.env.MAM_PLAIN;
  process.env.WOLLIPOG_PLAIN = "current-daemon-value";
  process.env.MAM_PLAIN = "legacy-daemon-value";
  try {
    const child = spawnAgent({
      command: "codex", args: ["--host-only"], cwd: root,
      env: { OPENAI_API_KEY: "provider-secret" }, cloudAgentLaunch: true,
      isolation: {
        backend: "cloud", command: process.execPath, args: [script], env: { CLOUD_ADAPTER_TOKEN: "adapter-secret" },
        targetId: "metered-tools", handoffId: "handoff-1", sessionId: "session-1",
        hostAgentCommand: "codex", hostAgentArgs: ["--host-only"], agentCommand: "codex", agentArgs: ["app-server"],
      },
    });
    child.stdin.end();
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => (out += text));
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    const observed = JSON.parse(out) as { adapter: string | null; provider: string | null; current: string | null; legacy: string | null; args: string[] };
    assert.equal(observed.adapter, "adapter-secret");
    assert.equal(observed.provider, null);
    assert.equal(observed.current, null);
    assert.equal(observed.legacy, null);
    assert.deepEqual(observed.args.slice(-2), ["codex", "app-server"]);
  } finally {
    if (oldCurrent === undefined) delete process.env.WOLLIPOG_PLAIN;
    else process.env.WOLLIPOG_PLAIN = oldCurrent;
    if (oldLegacy === undefined) delete process.env.MAM_PLAIN;
    else process.env.MAM_PLAIN = oldLegacy;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("winQuoteArg leaves simple args untouched", () => {
  assert.equal(winQuoteArg("exec"), "exec");
  assert.equal(winQuoteArg("--json"), "--json");
  assert.equal(winQuoteArg("gpt-5-codex"), "gpt-5-codex");
  assert.equal(winQuoteArg("@scope/pkg"), "@scope/pkg");
});

test("winQuoteArg quotes args containing spaces", () => {
  assert.equal(winQuoteArg("C:\\Program Files\\x"), '"C:\\Program Files\\x"');
});

test("winQuoteArg quotes cmd metacharacters", () => {
  assert.equal(winQuoteArg("a&b"), '"a&b"');
  assert.equal(winQuoteArg("a|b"), '"a|b"');
  assert.equal(winQuoteArg("a>b"), '"a>b"');
});

test("winQuoteArg doubles embedded quotes", () => {
  assert.equal(winQuoteArg('say "hi"'), '"say ""hi"""');
});

test("winQuoteArg encodes the empty string as a literal empty arg", () => {
  assert.equal(winQuoteArg(""), '""');
});

test("winQuoteArg throws on CR/LF (must go via stdin, not argv)", () => {
  assert.throws(() => winQuoteArg("line1\nline2"), /CR\/LF/);
  assert.throws(() => winQuoteArg("a\rb"), /CR\/LF/);
});

test("buildBwrapArgs makes the host read-only, worktree/tmp writable, and network optionally absent", () => {
  const base = { command: "/usr/bin/agent", args: ["--flag", "value with spaces"], cwd: "/work/tree" };
  const denied = buildBwrapArgs(base, {
    backend: "bwrap", command: "/usr/bin/bwrap", args: [], network: "deny",
  });
  assert.deepEqual(denied, [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net",
    "--ro-bind", "/", "/", "--dev", "/dev", "--dir", "/dev/shm", "--proc", "/proc", "--tmpfs", "/tmp",
    "--bind", "/work/tree", "/work/tree", "--chdir", "/work/tree", "--",
    "/usr/bin/agent", "--flag", "value with spaces",
  ]);
  const inherited = buildBwrapArgs(base, {
    backend: "bwrap", command: "/usr/bin/bwrap", args: ["--prefix"], network: "inherit",
  });
  assert.equal(inherited.includes("--unshare-net"), false);
  assert.equal(inherited[0], "--prefix");

  const state = buildBwrapArgs(base, {
    backend: "bwrap", command: "/usr/bin/bwrap", args: [], network: "inherit",
    writableBinds: [{ source: "/state/codex", target: "/home/me/.codex/sessions" }],
  });
  const stateIndex = state.indexOf("/state/codex");
  const cwdIndex = state.indexOf("/work/tree");
  assert.ok(stateIndex > 0 && stateIndex < cwdIndex, "state exception is mounted before the exact cwd overlay");
  assert.deepEqual(state.slice(stateIndex - 1, stateIndex + 2), ["--bind", "/state/codex", "/home/me/.codex/sessions"]);
});

test("spawnAgent scrubs inherited env keys but explicit env still wins", async () => {
  process.env.WOLLIPOG_TEST_SCRUB_A = "leaked-from-daemon";
  process.env.WOLLIPOG_TEST_SCRUB_B = "leaked-from-daemon";
  // A script FILE (not `-e`) so the probe survives Windows shell:true cmd.exe quoting.
  const script = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-spawn-test-")), "probe.js");
  await fs.writeFile(
    script,
    "process.stdout.write(JSON.stringify({a: process.env.WOLLIPOG_TEST_SCRUB_A ?? null, b: process.env.WOLLIPOG_TEST_SCRUB_B ?? null}));",
    "utf8",
  );
  try {
    const child = spawnAgent({
      command: process.execPath,
      args: [script],
      cwd: process.cwd(),
      env: { WOLLIPOG_TEST_SCRUB_B: "explicit-config" },
      scrubInheritedEnv: ["WOLLIPOG_TEST_SCRUB_A", "WOLLIPOG_TEST_SCRUB_B"],
    });
    child.stdin.end();
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (t: string) => (out += t));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (t: string) => (err += t));
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    assert.deepEqual(JSON.parse(out), { a: null, b: "explicit-config" }, `stderr: ${err}`);
  } finally {
    delete process.env.WOLLIPOG_TEST_SCRUB_A;
    delete process.env.WOLLIPOG_TEST_SCRUB_B;
    await fs.rm(path.dirname(script), { recursive: true, force: true });
  }
});

test("spawnAgent always scrubs runner-only conductor and hook policy environment", async () => {
  const keys = [
    "WOLLIPOG_CLAUDE_HOOKS",
    "MAM_CLAUDE_HOOKS",
    "WOLLIPOG_POLICY_HOOK_CP_URL",
    "MAM_POLICY_HOOK_CP_URL",
    "WOLLIPOG_POLICY_HOOK_SESSION_ID",
    "MAM_POLICY_HOOK_SESSION_ID",
    "WOLLIPOG_POLICY_HOOK_SETTINGS_FILE",
    "MAM_POLICY_HOOK_SETTINGS_FILE",
    "WOLLIPOG_POLICY_HOOK_CIRCUIT_FILE",
    "MAM_POLICY_HOOK_CIRCUIT_FILE",
    "WOLLIPOG_POLICY_HOOK_READY_FILE",
    "MAM_POLICY_HOOK_READY_FILE",
    "WOLLIPOG_POLICY_HOOK_ASK_CAPABLE",
    "MAM_POLICY_HOOK_ASK_CAPABLE",
    "WOLLIPOG_WINDOWS_JOB_SPEC",
    "MAM_WINDOWS_JOB_SPEC",
    "MANAGER_TOKEN_FILE",
  ];
  for (const key of keys) process.env[key] = "runner-only";
  const script = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-spawn-conductor-")), "probe.js");
  await fs.writeFile(
    script,
    `process.stdout.write(JSON.stringify(${JSON.stringify(keys)}.map((key) => process.env[key] ?? null)));`,
    "utf8",
  );
  try {
    const child = spawnAgent({
      command: process.execPath,
      args: [script],
      cwd: process.cwd(),
      env: Object.fromEntries(keys.map((key) => [key, "configured-runner-only"])),
    });
    child.stdin.end();
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => (out += text));
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    assert.deepEqual(JSON.parse(out), keys.map(() => null));
  } finally {
    for (const key of keys) delete process.env[key];
    await fs.rm(path.dirname(script), { recursive: true, force: true });
  }
});

test("spawnAgent env scrub is case-insensitive on Windows", { skip: process.platform !== "win32" }, async () => {
  process.env.Wollipog_Test_Scrub_Case = "leaked-mixed-case";
  const script = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-spawn-case-")), "probe.js");
  await fs.writeFile(
    script,
    "process.stdout.write(JSON.stringify({v: process.env.Wollipog_Test_Scrub_Case ?? process.env.WOLLIPOG_TEST_SCRUB_CASE ?? null}));",
    "utf8",
  );
  try {
    const child = spawnAgent({
      command: process.execPath,
      args: [script],
      cwd: process.cwd(),
      scrubInheritedEnv: ["WOLLIPOG_TEST_SCRUB_CASE"], // different case than the exported var
    });
    child.stdin.end();
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (t: string) => (out += t));
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    assert.deepEqual(JSON.parse(out), { v: null });
  } finally {
    delete process.env.Wollipog_Test_Scrub_Case;
    await fs.rm(path.dirname(script), { recursive: true, force: true });
  }
});

test("macOS Seatbelt permits worktree writes and denies writes outside its profile", { skip: process.platform !== "darwin" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-seatbelt-"));
  const worktree = path.join(root, "worktree");
  const dataDir = path.join(root, "data");
  const script = path.join(root, "probe.js");
  const allowed = path.join(worktree, "allowed.txt");
  const denied = path.join(os.homedir(), `.wollipog-seatbelt-denied-${process.pid}`);
  await fs.mkdir(worktree);
  await fs.mkdir(dataDir);
  await fs.rm(denied, { force: true });
  await fs.writeFile(script, `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(allowed)}, "allowed");
    try { fs.writeFileSync(${JSON.stringify(denied)}, "denied"); process.stdout.write("ESCAPED"); }
    catch { process.stdout.write("DENIED"); }
  `, "utf8");
  try {
    const isolation = await resolveExecutionIsolation(
      { mode: "seatbelt", network: "inherit" },
      { kind: "native" },
      {},
      { driver: "acp", dataDir, env: {}, sessionId: "seatbelt-live", cwd: worktree },
    );
    const child = spawnAgent({
      command: process.execPath, args: [script], cwd: worktree, windowsShell: false, isolation,
    });
    child.stdin.end();
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => (out += text));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => (err += text));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, err);
    assert.equal(out, "DENIED");
    assert.equal(await fs.readFile(allowed, "utf8"), "allowed");
    await assert.rejects(() => fs.stat(denied), /ENOENT/);
  } finally {
    await fs.rm(denied, { force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("macOS Seatbelt network denial blocks even loopback sockets", { skip: process.platform !== "darwin" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-seatbelt-net-"));
  const worktree = path.join(root, "worktree");
  const dataDir = path.join(root, "data");
  const script = path.join(root, "probe.js");
  await fs.mkdir(worktree);
  await fs.mkdir(dataDir);
  const server = net.createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await fs.writeFile(script, `
    const socket = require("node:net").connect(${address.port}, "127.0.0.1");
    socket.on("connect", () => { process.stdout.write("ESCAPED"); socket.destroy(); });
    socket.on("error", () => process.stdout.write("DENIED"));
    setTimeout(() => { if (!socket.destroyed) { process.stdout.write("DENIED"); socket.destroy(); } }, 1000);
  `, "utf8");
  try {
    const isolation = await resolveExecutionIsolation(
      { mode: "seatbelt", network: "deny" },
      { kind: "native" },
      {},
      { driver: "acp", dataDir, env: {}, sessionId: "seatbelt-network", cwd: worktree },
    );
    const child = spawnAgent({
      command: process.execPath, args: [script], cwd: worktree, windowsShell: false, isolation,
    });
    child.stdin.end();
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => (out += text));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => (err += text));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, err);
    assert.equal(out, "DENIED");
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows Job launcher preserves pipes, argv, and child exit status", { skip: process.platform !== "win32" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-job-stdio-"));
  const script = path.join(dir, "probe.js");
  await fs.writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(7);", "utf8");
  try {
    const child = spawnAgent({
      command: process.execPath,
      args: [script, "two words", 'quote\"value', "trailing\\"],
      cwd: dir,
      isolation: windowsJobIsolation,
    });
    child.stdin.end();
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => (out += text));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => (err += text));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 7, err);
    assert.deepEqual(JSON.parse(out), ["two words", 'quote\"value', "trailing\\"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Windows Job launcher preserves cmd-shim argument boundaries", { skip: process.platform !== "win32" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog job shim "));
  const script = path.join(dir, "probe.js");
  const shim = path.join(dir, "agent shim.cmd");
  await fs.writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");
  await fs.writeFile(shim, `@echo off\r\n"${process.execPath}" "%~dp0probe.js" %*\r\n`, "utf8");
  const priorComSpec = process.env.ComSpec;
  delete process.env.ComSpec;
  try {
    const child = spawnAgent({
      command: shim,
      args: ["two words", "simple"],
      cwd: dir,
      isolation: windowsJobIsolation,
    });
    child.stdin.end();
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => (out += text));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => (err += text));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, err);
    assert.deepEqual(JSON.parse(out), ["two words", "simple"]);
  } finally {
    if (priorComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = priorComSpec;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("closing a Windows Job launcher reaps its descendant tree", { skip: process.platform !== "win32" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-job-reap-"));
  const marker = path.join(dir, "orphan.txt");
  const childScript = path.join(dir, "child.js");
  const parentScript = path.join(dir, "parent.js");
  await fs.writeFile(childScript, `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 1800);`, "utf8");
  await fs.writeFile(parentScript, `require("node:child_process").spawn(process.execPath, [${JSON.stringify(childScript)}], {stdio:"ignore"}); process.stdout.write("READY\\n"); setInterval(()=>{},1000);`, "utf8");
  try {
    const child = spawnAgent({
      command: process.execPath,
      args: [parentScript],
      cwd: dir,
      windowsShell: false,
    });
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.stdout.on("data", (text: string) => { if (text.includes("READY")) resolve(); });
    });
    killTree(child);
    await waitForPendingKills(5_000);
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    await assert.rejects(() => fs.stat(marker), /ENOENT/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("POSIX ownership snapshots exclude unrelated and PID-reused processes", () => {
  const table = parsePosixProcessTable([
    " 100 1 Ss Thu Aug 27 00:00:00 2026",
    " 101 100 S Thu Aug 27 00:00:01 2026",
    " 102 101 S Thu Aug 27 00:00:02 2026",
    " 200 1 S Thu Aug 27 00:00:03 2026",
  ].join("\n"));
  const root = table.get(100)!;
  const owned = new Map([[root.pid, root]]);
  assert.equal(extendOwnedProcessTree(owned, table), 2);
  assert.deepEqual([...owned.keys()].sort(), [100, 101, 102]);

  const reused = parsePosixProcessTable([
    " 100 1 Ss Thu Aug 27 00:01:00 2026",
    " 201 100 S Thu Aug 27 00:01:01 2026",
  ].join("\n"));
  assert.equal(extendOwnedProcessTree(owned, reused), 0, "a reused root PID cannot capture a foreign child");
  assert.equal(ownsPosixRootProcessGroup(root.pid, owned, reused), false,
    "a reused root PID cannot authorize a negative-PID group signal");
  assert.equal(owned.has(200), false);
  assert.equal(owned.has(201), false);
});

test("normal provider exit preserves owned background work until session disposal", {
  skip: process.platform === "win32",
  timeout: 15_000,
}, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-retained-provider-"));
  const ready = path.join(dir, "ready.json");
  const escapedScript = path.join(dir, "escaped.cjs");
  const providerScript = path.join(dir, "provider.cjs");
  let escapedPid: number | undefined;
  t.after(async () => {
    if (escapedPid) {
      try { process.kill(escapedPid, "SIGKILL"); } catch { /* already reaped */ }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(escapedScript, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid }));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  await fs.writeFile(providerScript, [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, [${JSON.stringify(escapedScript)}], { detached: true, stdio: "ignore" }).unref();`,
    "process.exit(0);",
  ].join("\n"), "utf8");

  const owner = {};
  const child = spawnAgent({
    command: process.execPath,
    args: [providerScript],
    cwd: dir,
    windowsShell: false,
    descendantOwner: owner,
  });
  child.stdin.end();
  for (let attempt = 0; attempt < 100 && !escapedPid; attempt++) {
    try { escapedPid = (JSON.parse(await fs.readFile(ready, "utf8")) as { pid: number }).pid; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.ok(escapedPid, "background process became ready");
  if (!child.closeObserved) {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
  }
  assert.doesNotThrow(() => process.kill(escapedPid!, 0), "normal provider exit preserves background work");

  let finishGracefulStop!: () => void;
  trackPendingKill(new Promise<void>((resolve) => { finishGracefulStop = resolve; }));
  terminateDescendantBoundariesAfterPendingKills();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotThrow(
    () => process.kill(escapedPid!, 0),
    "global retained cleanup waits for an in-flight graceful provider stop",
  );
  finishGracefulStop();
  assert.equal(await waitForPendingKills(8_000), true);
  assert.throws(() => process.kill(escapedPid!, 0), /ESRCH/, "session disposal reaps retained work");
});

test("session disposal reaps a grandchild that creates a new POSIX session and its descendant", {
  skip: process.platform === "win32",
  timeout: 15_000,
}, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-escaped-provider-"));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const ready = path.join(dir, "ready.json");
  const leafScript = path.join(dir, "leaf.cjs");
  const escapedScript = path.join(dir, "escaped.cjs");
  const providerScript = path.join(dir, "provider.cjs");
  await fs.writeFile(leafScript, "setInterval(() => {}, 1000);\n", "utf8");
  await fs.writeFile(escapedScript, [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    `const leaf = spawn(process.execPath, [${JSON.stringify(leafScript)}], { stdio: "ignore" });`,
    `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ escaped: process.pid, leaf: leaf.pid }));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  await fs.writeFile(providerScript, [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, [${JSON.stringify(escapedScript)}], { detached: true, stdio: "ignore" }).unref();`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");

  const child = spawnAgent({ command: process.execPath, args: [providerScript], cwd: dir, windowsShell: false });
  child.stdin.end();
  let pids: { escaped: number; leaf: number } | undefined;
  for (let attempt = 0; attempt < 100 && !pids; attempt++) {
    try { pids = JSON.parse(await fs.readFile(ready, "utf8")) as typeof pids; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.ok(pids, "escaped provider fixture became ready");
  killTree(child);
  assert.equal(await waitForPendingKills(8_000), true);
  for (const pid of [pids.escaped, pids.leaf]) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `owned pid ${pid} was reaped`);
  }
});

test("termination rescans the exact marker for a helper forked by a SIGTERM handler", {
  skip: process.platform === "win32",
  timeout: 15_000,
}, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-term-handler-escape-"));
  const ready = path.join(dir, "ready.json");
  const providerReady = path.join(dir, "provider-ready");
  const helperScript = path.join(dir, "helper.cjs");
  const providerScript = path.join(dir, "provider.cjs");
  let helperPid: number | undefined;
  t.after(async () => {
    if (helperPid) {
      try { process.kill(helperPid, "SIGKILL"); } catch { /* already reaped */ }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(helperScript, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid }));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  await fs.writeFile(providerScript, [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    "let stopping = false;",
    'process.on("SIGTERM", () => {',
    "  if (stopping) return;",
    "  stopping = true;",
    `  spawn(process.execPath, [${JSON.stringify(helperScript)}], { detached: true, stdio: "ignore" }).unref();`,
    "  process.exit(0);",
    "});",
    `fs.writeFileSync(${JSON.stringify(providerReady)}, "ready");`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");

  const child = spawnAgent({
    command: process.execPath,
    args: [providerScript],
    cwd: dir,
    windowsShell: false,
    descendantOwner: {},
  });
  child.stdin.end();
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.access(providerReady); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  await fs.access(providerReady);
  killTree(child);
  for (let attempt = 0; attempt < 100 && !helperPid; attempt++) {
    try { helperPid = (JSON.parse(await fs.readFile(ready, "utf8")) as { pid: number }).pid; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.ok(helperPid, "SIGTERM handler forked its detached helper");
  assert.equal(await waitForPendingKills(8_000), true);
  assert.throws(() => process.kill(helperPid!, 0), /ESRCH/, "final marker rescan reaps the helper");
});

test("buildWslArgs scrubs names in-distro and never places agent env values in argv", () => {
  const args = buildWslArgs("Ubuntu", "/home/me/repo", "/tmp/x.pgid", {
    command: "claude",
    args: ["-p", "--verbose"],
    cwd: "/home/me/repo",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-123", HTTP_PROXY: "http://p:8080" },
    context: { kind: "wsl", distro: "Ubuntu" },
    scrubInheritedEnv: ["ANTHROPIC_API_KEY"],
  });
  // Riding --exec: env prefix must come after the positional wrapper params (sh, pidfile).
  const i = args.indexOf("/tmp/x.pgid");
  assert.ok(i > 0);
  assert.deepEqual(args.slice(i + 1), [
    "env",
    "-u",
    "ANTHROPIC_API_KEY",
    "claude",
    "-p",
    "--verbose",
  ]);
  assert.equal(args.join(" ").includes("tok-123"), false);
  assert.equal(args.join(" ").includes("http://p:8080"), false);
});

test("buildWslArgs without env/scrub launches the bare command (no env wrapper)", () => {
  const args = buildWslArgs("Ubuntu", "/home/me/repo", "/tmp/x.pgid", {
    command: "codex",
    args: ["exec"],
    cwd: "/home/me/repo",
    context: { kind: "wsl", distro: "Ubuntu" },
  });
  const i = args.indexOf("/tmp/x.pgid");
  assert.deepEqual(args.slice(i + 1), ["codex", "exec"]);
});

test("waitForPendingKills drains kill work registered by an earlier pending operation", async () => {
  let releaseFirst!: () => void;
  let secondFinished = false;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  trackPendingKill(first.then(() => {
    trackPendingKill(new Promise<void>((resolve) => {
      setTimeout(() => {
        secondFinished = true;
        resolve();
      }, 10);
    }));
  }));

  const waiting = waitForPendingKills(1_000);
  releaseFirst();
  assert.equal(await waiting, true);
  assert.equal(secondFinished, true);
});

test("waitForPendingKills reports a deadline with process trees still pending", async () => {
  let release!: () => void;
  trackPendingKill(new Promise<void>((resolve) => { release = resolve; }));
  assert.equal(await waitForPendingKills(5), false);
  release();
  assert.equal(await waitForPendingKills(1_000), true, "later shutdown tests see a drained registry");
});

test("waitForPendingKills consumes an incomplete result instead of poisoning later drains", async () => {
  trackPendingKill(Promise.resolve(false));
  assert.equal(await waitForPendingKills(1_000), false);
  trackPendingKill(Promise.resolve());
  assert.equal(await waitForPendingKills(1_000), true);
});

test("POSIX kill completion waits for close after SIGKILL delivery", {
  skip: process.platform === "win32",
}, async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 2_147_483_647,
    kill: (signal?: NodeJS.Signals | number) => { signals.push(signal); return true; },
  }) as unknown as AgentProcess;
  killTree(child);
  child.emit("exit", 0, null);
  assert.equal(await waitForPendingKills(3_000), false,
    "signal delivery and the exit event are not proof that Node closed process resources");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close", 0, null);
  assert.equal(await waitForPendingKills(1_000), true);
});

test("POSIX kill completion settles when close was already observed", {
  skip: process.platform === "win32",
}, async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 2_147_483_647,
    closeObserved: true,
    exitCode: 0,
    signalCode: null,
    kill: (signal?: NodeJS.Signals | number) => { signals.push(signal); return true; },
  }) as unknown as AgentProcess;
  killTree(child);
  assert.equal(await waitForPendingKills(1_000), true,
    "a close event observed before cleanup cannot leave a permanent pending kill");
  assert.deepEqual(signals, [], "an already-closed PID is not safe to signal after possible reuse");
});

test("bubblewrap remains the in-distro executable for an isolated WSL launch", () => {
  const isolated = buildBwrapArgs(
    { command: "/usr/bin/agent", args: ["--prompt", "two words"], cwd: "/home/me/repo" },
    { backend: "bwrap", command: "/usr/bin/bwrap", args: [], network: "deny" },
  );
  const args = buildWslArgs("Ubuntu", "/home/me/repo", "/tmp/x.pgid", {
    command: "/usr/bin/bwrap", args: isolated, cwd: "/home/me/repo", context: { kind: "wsl", distro: "Ubuntu" },
  });
  assert.ok(args.includes("/usr/bin/bwrap"));
  assert.ok(args.includes("--unshare-net"));
  assert.deepEqual(args.slice(-3), ["/usr/bin/agent", "--prompt", "two words"]); // original argv boundaries survive
});
