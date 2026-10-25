import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { MessageChannel, Worker } from "node:worker_threads";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { claudeHookSessionProtectionsPath, refreshClaudeGuardProtections, removeClaudeHookFiles, seedManagedWorktreeGuardMemory } from "./hook-settings.js";
import { ManagedWorktreeGuardSockets } from "./managed-worktree-guard-socket.js";
import { managedWorktreeGuardDecision, managedWorktreeGuardOutcome, requestManagedWorktreeGuardVerdict, writeManagedWorktreeGuardProtections } from "./managed-worktree-guard.js";
import { GuardSocketWorker, createGuardSocketWorker, type GuardSocketWorkerFactory } from "./managed-worktree-guard-worker-client.js";
import { GuardWorkerProtectionList } from "./managed-worktree-guard-worker.js";
import type { ManagedWorktreeProtection } from "./managed-worktree-protection.js";
import { buildSync } from "esbuild";

const hook = (command: string) => JSON.stringify({ tool_name: "Bash", cwd: "/trees/one", tool_input: { command } });

function blockedCall(address: string, home: string, command = "git status") {
  const guard = fileURLToPath(new URL("./managed-worktree-guard.ts", import.meta.url));
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { requestManagedWorktreeGuardVerdict } from ${JSON.stringify(guard)};
    console.log(JSON.stringify(await requestManagedWorktreeGuardVerdict(${JSON.stringify(address)}, ${JSON.stringify(hook(command))}, 500)));
  `], { encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home } });
}

test("a guarded call gets its verdict while the runner main loop is blocked", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-stall-"));
  const host = new ManagedWorktreeGuardSockets(root);
  try {
    writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(root, "s_stall"), []);
    const address = await host.ensure("s_stall");
    const guard = fileURLToPath(new URL("./managed-worktree-guard.ts", import.meta.url));
    // spawnSync blocks THIS event loop until the independent sidecar finishes. Its timeout runs
    // in the child, so it can observe a stalled runner without relying on the stalled timer.
    const started = performance.now();
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { requestManagedWorktreeGuardVerdict } from ${JSON.stringify(guard)};
      const verdict = await requestManagedWorktreeGuardVerdict(${JSON.stringify(address)},
        JSON.stringify({tool_name:'Bash',cwd:'/work',tool_input:{command:'git status'}}), 500);
      if (verdict.exitCode !== 0 || verdict.stdout !== '' || verdict.stderr !== '') process.exit(3);
      console.log('verdict received while parent blocked');
    `], { encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, CLAUDE_CONFIG_DIR: root } });
    assert.equal(result.status, 0, `blocked main loop for ${Math.round(performance.now() - started)}ms: ${result.stderr}`);
    assert.match(result.stdout, /verdict received while parent blocked/u);
  } finally {
    await host.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a synchronous memory refresh reaches the next call while main is blocked, including invalidation", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-fresh-"));
  const host = new ManagedWorktreeGuardSockets(root);
  const session = "s_worker_fresh";
  try {
    seedManagedWorktreeGuardMemory(session, []);
    const address = await host.ensure(session, "abstract");
    for (const protections of [[{ worktreePath: "/trees/one", repoPath: "/repo" }], []]) {
      assert.equal(refreshClaudeGuardProtections(session, protections, root).state, "refreshed");
      // No yield/ack between refresh and the independently timed request.
      const reply = blockedCall(address, root, "git worktree remove /trees/one");
      assert.equal(reply.status, 0, reply.stderr);
      const verdict = JSON.parse(reply.stdout);
      assert.equal(verdict.exitCode, 0);
      assert.equal(verdict.stdout.includes('"permissionDecision":"deny"'), protections.length > 0);
    }
    removeClaudeHookFiles(session, root);
    const invalidated = blockedCall(address, root);
    assert.equal(invalidated.status, 0, invalidated.stderr);
    assert.equal(JSON.parse(invalidated.stdout).exitCode, 2);
  } finally {
    await host.closeAll();
    removeClaudeHookFiles(session, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("path-list updates are read on the next call even while main is blocked", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-file-"));
  const host = new ManagedWorktreeGuardSockets(root);
  try {
    const file = claudeHookSessionProtectionsPath(root, "s_file");
    writeManagedWorktreeGuardProtections(file, []);
    const address = await host.ensure("s_file");
    writeManagedWorktreeGuardProtections(file, [{ worktreePath: "/trees/one", repoPath: "/repo" }]);
    const result = blockedCall(address, root, "git worktree remove /trees/one");
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).stdout, /"permissionDecision":"deny"/u);
    rmSync(file);
    const invalidated = blockedCall(address, root);
    assert.equal(invalidated.status, 0, invalidated.stderr);
    assert.equal(JSON.parse(invalidated.stdout).exitCode, 2);
  } finally { await host.closeAll(); rmSync(root, { recursive: true, force: true }); }
});

test("worker verdicts match the shared in-process judge across the refusal corpus", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-parity-"));
  const protections: ManagedWorktreeProtection[] = [{ worktreePath: "/trees/one", repoPath: "/repo", pinnedBranch: "agent/s_one" }];
  const host = new ManagedWorktreeGuardSockets(root, () => protections);
  const environment = { HOME: "/provider", HELD: "/trees/one", PATH: "/usr/bin:/bin" };
  const commands = [
    "git status", "git diff", "git worktree remove /trees/one", "git worktree remove '$HELD'", 'git worktree remove "$HELD"',
    "git worktree prune", "git worktree move /trees/one /trees/new", "git worktree lock /trees/one",
    "git worktree unlock /trees/one", "git -C /repo worktree remove /trees/one", "git worktree remove /trees/other",
    "git switch other", "git switch agent/s_one", "git checkout --detach", "git checkout -- src/file",
    "git branch -m new", "git branch --show-current", "git reset --hard", "rm -rf /trees/one", "rm /trees/one/.git",
    "echo okay && git worktree remove /trees/one", "env X=1 git worktree remove /trees/one",
    "sh -c 'git worktree remove /trees/one'", "git worktree remove $(echo /trees/one)",
    `cat ${root}/state`, `rm -rf ${root}`, "echo ${broken", "printf hello", "git gc", "git clean -fd",
  ];
  const inputs = commands.map(hook);
  for (const tool_name of ["Edit", "Write", "Read", "Grep", "Glob"]) {
    for (const path of ["/trees/one/.git", "/trees/one/src/app.ts", `${root}/state`]) {
      inputs.push(JSON.stringify({ tool_name, cwd: "/trees/one", tool_input: { file_path: path, path } }));
    }
  }
  for (const file of ["src/app.ts", "/trees/one/.git", `${root}/state`]) {
    inputs.push(JSON.stringify({ tool_name: "apply_patch", cwd: "/trees/one", tool_input: { command: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch` } }));
  }
  inputs.push("{", "[]", "{}", JSON.stringify({tool_name:"Bash",cwd:"/trees/one",tool_input:{}}),
    JSON.stringify({ tool_name: "apply_patch", cwd: "/trees/one", tool_input: { command: "broken patch" } }));
  try {
    writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(root, "s_parity"), protections);
    const addresses = [await host.ensure("s_parity")];
    if (process.platform === "linux") addresses.push(await host.ensure("s_memory", "abstract"));
    let refused = 0;
    for (const input of inputs) {
      const expected = managedWorktreeGuardOutcome(managedWorktreeGuardDecision(input, () => protections, root, environment));
      if (expected.exitCode === 2 || expected.stdout.includes('"permissionDecision":"deny"')) refused++;
      for (const address of addresses) {
        assert.deepEqual(await requestManagedWorktreeGuardVerdict(address, input, 5000, environment), expected, input);
      }
    }
    assert.ok(refused >= 20, `${refused} refusal cases must exercise the corpus`);
  } finally { await host.closeAll(); rmSync(root, { recursive: true, force: true }); }
});

test("list versions drain queued updates synchronously and refuse unknown, racing or malformed versions", () => {
  const channel = new MessageChannel();
  const expected = new Int32Array(new SharedArrayBuffer(4));
  const list = new GuardWorkerProtectionList(expected, channel.port2);
  try {
    Atomics.store(expected, 0, 1);
    channel.port1.postMessage({ version: 1, protections: [] });
    assert.deepEqual(list.read(), []);
    Atomics.store(expected, 0, 2);
    assert.throws(() => list.verify(), /changed/u);
    assert.throws(() => list.read(), /unknown.*version/u);
    channel.port1.postMessage({ version: 2, protections: null });
    assert.throws(() => list.read(), /holds no protected/u);
    Atomics.store(expected, 0, 3);
    channel.port1.postMessage({ version: 99, protections: [] });
    assert.throws(() => list.read(), /unknown.*version/u);
    channel.port1.postMessage({ version: 3, protections: [{ worktreePath: "" }] });
    assert.throws(() => list.read(), /missing a path/u);
  } finally { channel.port1.close(); channel.port2.close(); }
});

test("startup error, exit, timeout and malformed worker replies never provision a guard", async () => {
  const options = { address: "/unused", guardStateDirectory: "/unused", platform: process.platform };
  const factories: GuardSocketWorkerFactory[] = [
    () => { throw new Error("startup failure"); },
    () => new Worker("throw new Error('worker crash')", { eval: true }),
    () => new Worker("", { eval: true }),
    () => new Worker("setInterval(()=>{},1000)", { eval: true }),
    () => new Worker("require('node:worker_threads').parentPort.postMessage({kind:'ready',address:'/other'})", { eval: true }),
  ];
  for (const factory of factories) {
    await assert.rejects(GuardSocketWorker.listen(options, () => [], () => () => {}, async () => "", factory, 100));
  }
});

test("a crashed worker closes its socket and drops its self-test proof", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-crash-"));
  let worker: Worker | undefined;
  const host = new ManagedWorktreeGuardSockets(root, () => [], process.platform, async () => "", (data, transfers) => {
    worker = createGuardSocketWorker(data, transfers);
    return worker;
  });
  try {
    writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(root, "s_crash"), []);
    const address = await host.ensure("s_crash");
    host.markProven("s_crash", address);
    assert.equal(host.isProven("s_crash", address), true);
    await worker!.terminate();
    assert.equal(host.isProven("s_crash", address), false);
    await assert.rejects(requestManagedWorktreeGuardVerdict(address, hook("git status"), 500));
  } finally { await host.closeAll(); rmSync(root, { recursive: true, force: true }); }
});

test("a stalled verdict worker times out into refusal independently of main", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-timeout-"));
  let worker: Worker | undefined;
  const loader = createRequire(import.meta.url).resolve("tsx/cjs");
  const entry = fileURLToPath(new URL("./managed-worktree-guard-worker.ts", import.meta.url));
  const host = new ManagedWorktreeGuardSockets(root, () => [], process.platform, async () => "", (data, transferList) => {
    worker = new Worker(`require('node:worker_threads').parentPort.on('message',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));require(${JSON.stringify(loader)});require(${JSON.stringify(entry)});`,
      { eval: true, execArgv: [], workerData: data, transferList });
    return worker;
  });
  try {
    writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(root, "s_stuck"), []);
    const address = await host.ensure("s_stuck");
    worker!.postMessage({ stall: true });
    const result = blockedCall(address, root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not answer in time/u);
  } finally { await host.closeAll(); rmSync(root, { recursive: true, force: true }); }
});

test("an unknown published version refuses through the real worker socket", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-version-"));
  let version: Int32Array | undefined;
  const host = new ManagedWorktreeGuardSockets(root, () => [], "linux", async () => "", (data, transfers) => {
    version = new Int32Array(data.version);
    return createGuardSocketWorker(data, transfers);
  });
  try {
    const address = await host.ensure("s_version", "abstract");
    Atomics.add(version!, 0, 1); // Simulate a lost update: the old empty list must not allow.
    const reply = blockedCall(address, root);
    assert.equal(reply.status, 0, reply.stderr);
    const verdict = JSON.parse(reply.stdout);
    assert.equal(verdict.exitCode, 2);
    assert.match(verdict.stderr, /unknown guard protection list version/u);
  } finally { await host.closeAll(); rmSync(root, { recursive: true, force: true }); }
});

test("separate account config roots and same-named sessions never share sockets or lists", { skip: process.platform === "win32" }, async () => {
  const roots = [mkdtempSync(join(tmpdir(), "wg-acct-")), mkdtempSync(join(tmpdir(), "wg-acct-"))];
  const hosts = roots.map(root => new ManagedWorktreeGuardSockets(root));
  try {
    for (let i = 0; i < roots.length; i++) {
      writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(roots[i]!, "s_same"),
        [{ worktreePath: `/trees/account${i}`, repoPath: `/repo/account${i}` }]);
    }
    const addresses = await Promise.all(hosts.map(host => host.ensure("s_same")));
    assert.notEqual(addresses[0], addresses[1]);
    for (let i = 0; i < addresses.length; i++) {
      for (let j = 0; j < addresses.length; j++) {
        const verdict = await requestManagedWorktreeGuardVerdict(addresses[i]!, hook(`git worktree remove /trees/account${j}`));
        assert.equal(verdict.stdout.includes('"permissionDecision":"deny"'), i === j);
      }
    }
    await hosts[0]!.closeAll();
    assert.equal((await requestManagedWorktreeGuardVerdict(addresses[1]!, hook("git status"))).exitCode, 0);
  } finally { await Promise.all(hosts.map(host => host.closeAll())); for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});

test("the standalone CJS worker bundle serves the same guard without source loaders", { skip: process.platform === "win32" }, async () => {
  const code = buildSync({
    entryPoints: [fileURLToPath(new URL("./managed-worktree-guard-worker.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", target: "node24", write: false,
  }).outputFiles[0]!.text;
  const root = mkdtempSync(join(tmpdir(), "wg-bundle-"));
  const host = new ManagedWorktreeGuardSockets(root, () => [], process.platform, async () => "", (workerData, transferList) =>
    new Worker(code, { eval: true, execArgv: [], workerData, transferList }));
  try {
    writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(root, "s_bundle"), []);
    const address = await host.ensure("s_bundle");
    const verdict = await requestManagedWorktreeGuardVerdict(address, hook(`cat ${root}/state`));
    assert.match(verdict.stdout, /"permissionDecision":"deny"/u);
    assert.equal(blockedCall(address, root).status, 0);
    await assert.rejects(GuardSocketWorker.listen({
      address: join(root, "missing", "sock"), guardStateDirectory: root, platform: process.platform,
      protectionsFile: join(root, "unused"),
    }, () => [], () => () => {}, async () => "", (workerData, transferList) =>
      new Worker(code, { eval: true, execArgv: [], workerData, transferList })), /worker failed/u);
  } finally { await host.closeAll(); rmSync(root, { recursive: true, force: true }); }
});

test("an empty optional branch pin keeps the file and memory verdicts identical", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-empty-pin-"));
  const protections = [{ worktreePath: "/trees/one", repoPath: "/repo", pinnedBranch: "" }];
  const host = new ManagedWorktreeGuardSockets(root, () => protections);
  try {
    writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(root, "s_empty"), protections);
    const file = await host.ensure("s_empty");
    const memory = await host.ensure("s_memory", "abstract");
    const input = hook("git status");
    const expected = managedWorktreeGuardOutcome(managedWorktreeGuardDecision(input, () => protections, root));
    assert.equal(expected.exitCode, 0);
    assert.deepEqual(await requestManagedWorktreeGuardVerdict(file, input), expected);
    assert.deepEqual(await requestManagedWorktreeGuardVerdict(memory, input), expected);
  } finally { await host.closeAll(); rmSync(root, { recursive: true, force: true }); }
});

test("a transient accept error preserves the listening worker", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wg-accept-"));
  const loader = createRequire(import.meta.url).resolve("tsx/cjs");
  const entry = fileURLToPath(new URL("./managed-worktree-guard-worker.ts", import.meta.url));
  const host = new ManagedWorktreeGuardSockets(root, () => [], process.platform, async () => "", (workerData, transferList) =>
    new Worker(`
      const net = require('node:net'); const original = net.createServer;
      net.createServer = (...args) => {
        const server = original(...args);
        server.once('listening', () => queueMicrotask(() => server.emit('error', Object.assign(new Error('transient accept error'), {code:'EMFILE'}))));
        return server;
      };
      require('node:module').syncBuiltinESMExports();
      require(${JSON.stringify(loader)}); require(${JSON.stringify(entry)});
    `, { eval: true, execArgv: [], workerData, transferList }));
  try {
    writeManagedWorktreeGuardProtections(claudeHookSessionProtectionsPath(root, "s_accept"), []);
    const address = await host.ensure("s_accept");
    assert.equal((await requestManagedWorktreeGuardVerdict(address, hook("git status"))).exitCode, 0);
  } finally { await host.closeAll(); rmSync(root, { recursive: true, force: true }); }
});
