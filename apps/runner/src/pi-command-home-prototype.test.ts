import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createPiCommandHomePrototype, installPiCommandHomePrototype, piCommandHomePrototypeEligible, verifyPiCommandHomePrototypeInstallation,
  type PiCommandHomePrototypePolicy } from "./pi-command-home-prototype.js";
import type { AgentProcess, SpawnAgentOptions } from "./spawn.js";

const linux = process.platform === "linux" ? false : "prototype is native Linux only";
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".pi-command-prototype-")));
  const worktree = join(root, "worktree"), home = join(root, "provider"), immutable = join(root, "immutable");
  for (const path of [worktree, home, immutable]) mkdirSync(path);
  for (const name of ["bwrap", "shell", "env", "hook.mjs"]) writeFileSync(join(immutable, name), "inert");
  writeFileSync(join(home, "auth.json"), "synthetic-only");
  const policy: PiCommandHomePrototypePolicy = { providerHome: home, immutablePaths: [immutable],
    installationRoot: immutable, version: "0.85.0", configuredArgs: ["--no-extensions"],
    shell: join(immutable, "shell"), envCommand: join(immutable, "env"),
    outer: { backend: "bwrap", command: join(immutable, "bwrap"), args: [], network: "inherit",
      preservesProviderHome: true, writableBinds: [{ source: home, target: home }],
      protectedWorktree: { parent: root, path: worktree, gitWritableRoots: [] } } };
  return { root, worktree, home, immutable, policy, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("prototype requires exact source contract and already isolated extension selection without altering flags", () => {
  assert.equal(piCommandHomePrototypeEligible("0.85.0", ["--no-extensions"], "linux"), true);
  for (const args of [[], ["--no-extensions", "--extension", "other.mjs"], ["--no-extensions", "--tools", "bash"]]) {
    const before = [...args];
    assert.equal(piCommandHomePrototypeEligible("0.85.0", args, "linux"), false);
    assert.deepEqual(args, before);
  }
  assert.equal(piCommandHomePrototypeEligible("0.85.1", ["--no-extensions"], "linux"), false);
  assert.equal(piCommandHomePrototypeEligible("0.85.0", ["--no-extensions"], "darwin"), false);
  const f = fixture();
  try { assert.equal(verifyPiCommandHomePrototypeInstallation(f.immutable), false); }
  finally { f.cleanup(); }
});

test("pinned extension seam routes model and RPC/user bash through operations and refuses reload/provenance bypass", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let tool: { name: string; execute(...args: unknown[]): Promise<unknown> } | undefined;
  let active = ["read", "bash", "edit", "write"];
  let bashSource = "/immutable/runner-extension.mjs";
  const calls: string[] = [];
  const operations = Object.freeze({ async exec(command: string) { calls.push(command); return { exitCode: 0 }; } });
  const pi = { on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
    registerTool(value: typeof tool) { tool = value; },
    getActiveTools: () => active,
    getAllTools: () => [
      { name: "bash", sourceInfo: { path: bashSource, source: "cli" } },
      ...["read", "edit", "write"].map(name => ({ name, sourceInfo: { path: `<builtin:${name}>`, source: "builtin" } })),
    ] };
  installPiCommandHomePrototype(pi, { createBashTool: (_cwd, options) => ({ name: "bash",
    async execute(command) { return options.operations.exec(String(command), "/fixture", { onData() {} }); } }) },
  operations, "/fixture", bashSource);
  await assert.rejects(tool!.execute("before-ready"), /could not prove/);
  handlers.get("session_start")!();
  await tool!.execute("model-command");
  const userRoute = handlers.get("user_bash")!() as { operations: typeof operations };
  assert.equal(userRoute.operations, operations);
  await userRoute.operations.exec("rpc-command");
  assert.deepEqual(calls, ["model-command", "rpc-command"]);
  bashSource = "/mutable/model-override.mjs";
  assert.deepEqual(handlers.get("tool_call")!(), { block: true,
    reason: "Pi command-home prototype could not prove its immutable execution boundary." });
  await assert.rejects(tool!.execute("bypass"), /could not prove/);
  const refusedRoute = handlers.get("user_bash")!() as { operations: typeof operations };
  assert.ok(refusedRoute.operations, "never return undefined and trigger the local RPC fallback");
  await assert.rejects(refusedRoute.operations.exec("bypass"), /could not prove/);
  bashSource = "/immutable/runner-extension.mjs";
  handlers.get("session_shutdown")!();
  await assert.rejects(tool!.execute("reload-gap"), /could not prove/);
  active = [...active, "powershell"];
  handlers.get("session_start")!();
  await assert.rejects(tool!.execute("uncovered-executable"), /could not prove/);
  assert.deepEqual(calls, ["model-command", "rpc-command"]);
});

test("operations capture narrows actual bwrap argv, isolates loader env and freezes policy without shell prefixing", { skip: linux }, async () => {
  const f = fixture();
  const calls: SpawnAgentOptions[] = [];
  try {
    const before = structuredClone(f.policy.outer);
    const backend = createPiCommandHomePrototype(f.policy, { auditInstallation: () => true, prove: async () => true,
      spawn: options => {
        calls.push(options);
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        queueMicrotask(() => { child.stdout.emit("data", Buffer.from("inert-output")); child.emit("close", 7); });
        return child as unknown as AgentProcess;
      } });
    f.policy.shell = "/untrusted-later-shell";
    f.policy.outer.writableBinds!.push({ source: f.root, target: f.root });
    const output: string[] = [];
    const command = "printf '%s' '$HOME; $(literal)'";
    assert.deepEqual(await backend.exec(command, f.worktree, { onData: data => output.push(data.toString()),
      env: { HOME: f.home, LD_PRELOAD: "synthetic-untrusted-loader", NODE_OPTIONS: "synthetic-untrusted-node" } }), { exitCode: 7 });
    assert.deepEqual(output, ["inert-output"]);
    assert.equal(calls.length, 1);
    const captured = calls[0]!;
    assert.deepEqual(captured.env, { PATH: "/usr/bin:/bin", LANG: "C" });
    assert.equal(captured.windowsShell, false);
    assert.equal(captured.args.at(-1), command);
    const executionBoundary = captured.args.lastIndexOf("--");
    assert.ok(executionBoundary > captured.args.indexOf("--ro-bind", captured.args.indexOf(f.home)));
    assert.equal(captured.args.indexOf("LD_PRELOAD=synthetic-untrusted-loader") > executionBoundary, true);
    assert.equal(captured.args.includes("/untrusted-later-shell"), false);
    assert.equal(captured.args.some((value, index, array) => value === "--bind" && array[index + 1] === f.home), false);
    assert.equal(captured.args.some((value, index, array) => value === "--bind" && array[index + 1] === f.root), false);
    assert.ok(captured.args.some((value, index, array) => value === "--ro-bind" && array[index + 1] === f.home));
    assert.equal(before.writableBinds?.length, 1);
  } finally { f.cleanup(); }
});

test("prototype refuses aliases, overlapping grants, mutable dependencies and wrong cwd before spawning", { skip: linux }, async () => {
  const f = fixture();
  const deps = { auditInstallation: () => true, spawn: () => { assert.fail("refused prototype spawned"); } };
  try {
    for (const mutate of [
      (p: PiCommandHomePrototypePolicy) => { p.outer.writableBinds!.push({ source: f.home, target: f.worktree }); },
      (p: PiCommandHomePrototypePolicy) => { p.outer.writableBinds!.push({ source: f.root, target: f.root }); },
      (p: PiCommandHomePrototypePolicy) => { p.immutablePaths = [f.worktree]; },
      (p: PiCommandHomePrototypePolicy) => { p.version = "0.86.0"; },
    ]) {
      const policy = structuredClone(f.policy); mutate(policy);
      assert.throws(() => createPiCommandHomePrototype(policy, deps), /could not prove/);
    }
    const backend = createPiCommandHomePrototype(f.policy, deps);
    await assert.rejects(backend.exec("inert", f.home, { onData() {} }), /could not prove/);
    symlinkSync(f.worktree, join(f.home, "alias"));
    assert.throws(() => createPiCommandHomePrototype(f.policy, deps), /could not prove/);
  } finally { f.cleanup(); }
});

test("sandbox failure and cancellation never retry outside the child boundary", { skip: linux }, async () => {
  const f = fixture();
  try {
    for (const cancelled of [false, true]) {
      let spawns = 0, kills = 0;
      const controller = new AbortController();
      let child: AgentProcess;
      const backend = createPiCommandHomePrototype(f.policy, { auditInstallation: () => true,
        prove: async () => !cancelled,
        kill: () => { kills++; queueMicrotask(() => child.emit("close", null)); },
        spawn: () => {
          spawns++;
          child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as AgentProcess;
          queueMicrotask(() => cancelled ? controller.abort() : child.emit("close", 1));
          return child;
        } });
      const operation = backend.exec("inert", f.worktree, { onData() {}, signal: controller.signal });
      if (cancelled) await assert.rejects(operation, /command-tree exit/);
      else assert.deepEqual(await operation, { exitCode: 1 });
      assert.equal(spawns, 1); assert.equal(kills, cancelled ? 1 : 0);
    }
  } finally { f.cleanup(); }
});
