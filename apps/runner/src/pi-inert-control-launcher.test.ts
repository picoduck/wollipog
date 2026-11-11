import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createPiInertControlLauncher, PI_INERT_CONTROL_RPC_LINE_BYTES, type PiInertControlPolicy } from "./pi-inert-control-launcher.js";
import { spawnAgent, type AgentProcess, type SpawnAgentOptions } from "./spawn.js";
const linux = process.platform !== "linux" ? "UNAVAILABLE: inactive policy prototype is native Linux only" : false;
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".pi-control-launch-")));
  const worktree = join(root, "selected"), home = join(root, "home"), immutable = join(root, "immutable");
  for (const dir of [worktree, home, immutable]) mkdirSync(dir);
  const entry = join(immutable, "control.mjs"), mcp = join(immutable, "mcp.mjs"), commandEntry = join(immutable, "command.mjs");
  copyFileSync(source("./pi-inert-control-entrypoint.mjs"), entry);
  copyFileSync(source("./fixtures/pi-inert-control-helper.mjs"), mcp);
  copyFileSync(source("./pi-command-home-entrypoint.mjs"), commandEntry);
  writeFileSync(join(immutable, "bwrap"), "inert-placeholder");
  const policy: PiInertControlPolicy = {
    commandPolicy: { providerHome: home, immutablePaths: [immutable], installationRoot: immutable,
      version: "0.85.0", configuredArgs: ["--no-extensions"], shell: realpathSync("/bin/sh"),
      nodeRuntime: realpathSync(process.execPath), commandEntrypoint: commandEntry,
      outer: { backend: "bwrap", command: join(immutable, "bwrap"), args: [], network: "inherit", preservesProviderHome: true,
        writableBinds: [{ source: home, target: home }], protectedWorktree: { parent: root, path: worktree, gitWritableRoots: [] } } },
    controlEntrypoint: entry, mcpEntrypoint: mcp,
    mcpEntrypointSha256: createHash("sha256").update(readFileSync(mcp)).digest("hex"), imports: [],
    transportEnvironment: { WOLLIPOG_CANARY: "inert-canary-value-3922" },
  };
  const calls: SpawnAgentOptions[] = [];
  const launcher = () => createPiInertControlLauncher(policy, {
    auditInstallation: () => true, auditRuntime: () => true,
    // Explicit no-kernel transport seam: execute the exact post-bwrap argv. This proves framing
    // and lifetime, NOT namespace protection or actual imported Pi code.
    spawn: options => {
      calls.push(options);
      const boundary = options.args.lastIndexOf("--");
      assert.ok(boundary >= 0);
      return spawnAgent({ ...options, command: options.args[boundary + 1]!, args: options.args.slice(boundary + 2) });
    },
  });
  return { root, home, worktree, immutable, policy, calls, launcher, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const rpc = (method: string, extra = {}) => `${JSON.stringify({ id: 1, method, ...extra })}\n`;
function capture() {
  const output = new PassThrough(), stderr = new PassThrough();
  let text = "", errors = "";
  output.on("data", data => { text += data; }); stderr.on("data", data => { errors += data; });
  return { output, stderr, text: () => text, errors: () => errors };
}
test("fixed launcher captures immutable policy, keeps env out of argv/loader, and forwards RPC through actual entry", { skip: linux, timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    const launcher = f.launcher(), result = capture();
    f.policy.transportEnvironment = { WOLLIPOG_CANARY: "mutated-after-capture" };
    f.policy.commandPolicy.outer.writableBinds!.push({ source: f.root, target: f.root });
    assert.deepEqual(await launcher.run(Readable.from([rpc("inspect")]), result.output, result.stderr), { exitCode: 0 });
    assert.equal(result.errors(), "");
    assert.deepEqual(JSON.parse(result.text()), { id: 1, envDelivered: true, argvSafe: true, loaderSafe: true, fixedArgs: ["--agent-control-mcp"] });
    const call = f.calls[0]!;
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify([call.args, call.env]).includes("inert-canary-value-3922"), false);
    assert.equal(JSON.stringify(call.args).includes("mutated-after-capture"), false);
    assert.deepEqual(call.env, { PATH: "/usr/bin:/bin", LANG: "C" });
    assert.ok(call.args.some((arg, i, args) => arg === "--ro-bind" && args[i + 1] === f.home));
    assert.ok(!call.args.some((arg, i, args) => arg === "--bind" && [f.home, f.root].includes(args[i + 1]!)));
  } finally { f.cleanup(); }
});
test("actual child early exit closes open input; timeout/abort retire descendant trees without retries", { skip: linux, timeout: 15_000 }, async () => {
  const f = fixture();
  try {
    let result = capture();
    const open = new PassThrough(); open.write(rpc("exit", { code: 7 }));
    assert.deepEqual(await f.launcher().run(open, result.output, result.stderr), { exitCode: 7 });
    assert.equal(open.destroyed, true);
    result = capture();
    const hang = new PassThrough(); hang.write(rpc("hang"));
    await assert.rejects(f.launcher().run(hang, result.output, result.stderr, { timeoutMs: 100 }), /timed out/u);
    const controller = new AbortController(), input = new PassThrough();
    result = capture(); input.write(rpc("descendant"));
    const pidReady = new Promise<number>(resolve => result.output.once("data", data => resolve(JSON.parse(String(data)).pid)));
    const pending = f.launcher().run(input, result.output, result.stderr, { signal: controller.signal });
    const pid = await pidReady;
    assert.ok(Number.isInteger(pid)); controller.abort();
    await assert.rejects(pending, /aborted/u);
    assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
    assert.equal(f.calls.length, 3, "one spawn per run; no unsandboxed retry");
  } finally { f.cleanup(); }
});
test("stream size/output failures retire the child and surface fixed errors without private env", { skip: linux, timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    for (const input of ["x".repeat(PI_INERT_CONTROL_RPC_LINE_BYTES + 1), rpc("large", { bytes: PI_INERT_CONTROL_RPC_LINE_BYTES + 1 })]) {
      const result = capture();
      await assert.rejects(f.launcher().run(Readable.from([input]), result.output, result.stderr), error => {
        assert.equal((error as Error).message, "Pi inert control launcher refused execution.");
        return true;
      });
      assert.ok(!result.errors().includes("inert-canary-value-3922"));
    }
    const broken = new PassThrough(); broken.destroy(new Error("inert output failure")); broken.on("error", () => {});
    const result = capture();
    await assert.rejects(f.launcher().run(Readable.from([rpc("inspect")]), broken, result.stderr), /refused/u);
    const delayed = new Writable({ write(_chunk, _encoding, done) { setTimeout(() => done(new Error("inert delayed sink failure")), 60); } });
    await assert.rejects(f.launcher().run(Readable.from([rpc("inspect")]), delayed, capture().stderr), /refused/u);
    const stalled = new Writable({ write() {} });
    await assert.rejects(f.launcher().run(Readable.from([rpc("inspect")]), stalled, capture().stderr, { timeoutMs: 150 }), /timed out/u);
  } finally { f.cleanup(); }
});

test("spawn/pipe failures and missing retirement proof cannot leak payload, hang streams or retry", { skip: linux, timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    for (const mode of ["synchronous", "spawn-error", "pipe-error", "unproven"] as const) {
      let launches = 0, kills = 0;
      const launcher = createPiInertControlLauncher(f.policy, {
        auditInstallation: () => true, auditRuntime: () => true, prove: async () => mode !== "unproven",
        kill: async () => { kills++; },
        spawn: () => {
          launches++;
          if (mode === "synchronous") throw new Error("inert-canary-value-3922");
          const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
          queueMicrotask(() => {
            if (mode === "spawn-error") child.emit("error", new Error("inert-canary-value-3922"));
            else if (mode === "pipe-error") child.stdin.destroy(new Error("inert-canary-value-3922"));
            else { child.stdout.end(); child.stderr.end(); child.emit("close", 0); }
          });
          return child as unknown as AgentProcess;
        },
      });
      const result = capture(), input = Readable.from([rpc("inspect")]);
      await assert.rejects(launcher.run(input, result.output, result.stderr), error => {
        assert.ok(!(error as Error).message.includes("inert-canary-value-3922"));
        assert.match((error as Error).message, mode === "unproven" ? /could not prove/u : /refused/u); return true;
      });
      assert.equal(launches, 1); assert.equal(kills, ["spawn-error", "pipe-error"].includes(mode) ? 1 : 0);
      input.destroy();
    }
  } finally { f.cleanup(); }
});
test("mutable/modified code, unsafe loader env, aliases and invalid policies fail before spawning", { skip: linux }, () => {
  const f = fixture();
  try {
    for (const mutate of [
      (p: PiInertControlPolicy) => { p.mcpEntrypoint = join(f.home, "injected.mjs"); },
      (p: PiInertControlPolicy) => { p.mcpEntrypointSha256 = "0".repeat(64); },
      (p: PiInertControlPolicy) => { p.transportEnvironment = { NODE_OPTIONS: "inert-canary-value-3922" }; },
      (p: PiInertControlPolicy) => { p.transportEnvironment = { WOLLIPOG_INVALID: "nul\0" }; },
      (p: PiInertControlPolicy) => { p.imports = [{ path: p.mcpEntrypoint, sha256: p.mcpEntrypointSha256 }]; },
    ]) {
      const policy = structuredClone(f.policy); mutate(policy);
      assert.throws(() => createPiInertControlLauncher(policy, { auditInstallation: () => true, auditRuntime: () => true,
        spawn: () => { assert.fail("invalid policy spawned"); } }), /refused/u);
    }
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});
