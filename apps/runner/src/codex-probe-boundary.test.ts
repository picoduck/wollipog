import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { codexProbeFixture as fixture } from "../test-support/codex-probe.js";
import { captureLiveProcess, waitForOriginalProcessToStop } from "../test-support/posix-process.js";
import { readCodexHookInventory } from "./codex-managed-worktree-guard.js";
import { provenCodexPermissionProfile, readCodexSandboxProjection, runCodexProbe } from "./codex-permission-profile.js";
import { readCodexMcpInventory } from "./orchestrator-preset.js";
import { ProviderProcessLedger } from "./spawn.js";
import { CodexAppServerDriver } from "./drivers/codex-app-server.js";
import { run } from "./discovery/resolve.js";
import { provisionAgentControl } from "./agent-control.js";
import { PROTOCOL_VERSION } from "@wollipog/protocol";

const posix = { skip: process.platform === "win32", timeout: 25_000 };

test("tracked discovery preserves an explicitly replaced probe environment", posix, async (t) => {
  const h = fixture(t);
  const result = await run(process.execPath, ["-e", "console.log(JSON.stringify({ path: process.env.PATH ?? null, explicit: process.env.PROBE_EXPLICIT }))"], {
    env: { HOME: h.dir, CODEX_HOME: h.dir, PROBE_EXPLICIT: "present" }, replaceEnv: true, trackDescendants: true,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { path: null, explicit: "present" });
  assert.equal(result.provenProcessTreeExit, true);
});

test("ordinary Agent Control provisioning reports both native MCP inventory trees", posix, async (t) => {
  const h = fixture(t);
  const proofs: Promise<boolean>[] = [];
  const spec = { sessionId: "codex-probe-test", driver: "codex-app-server" as const,
    context: { kind: "native" as const }, command: h.launch.command, args: h.launch.args,
    env: h.launch.env as Record<string, string>, repoPath: h.dir };
  await provisionAgentControl(spec, {
    controlPlaneUrl: "ws://127.0.0.1:1/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION,
    onProcess: proof => proofs.push(proof),
  }, () => {}, { isSea: true, execPath: process.execPath, execArgv: [], configDir: h.dir,
    readCodexMcpInventory });
  assert.deepEqual(await Promise.all(proofs), [true, true], "both the original and candidate inventories are covered");
});

for (const silent of [true, false]) {
  test(`Codex discovery probes end detached descendants after ${silent ? "timeout" : "exit"}`, posix, async (t) => {
    const h = fixture(t, silent);
    const work = run(h.launch.command, h.launch.args, {
      timeoutMs: 1_500, env: h.launch.env as Record<string, string>, trackDescendants: true,
    });
    const helper = await h.helper();
    const result = await work;
    assert.equal(result.provenProcessTreeExit, true);
    assert.equal(result.code, silent ? 1 : 7);
    assert.equal(result.timedOut, silent ? true : undefined);
    assert.equal(await waitForOriginalProcessToStop(helper), undefined);
  });
}


for (const kind of ["mcp", "projection", "hooks", "command"] as const) {
  for (const silent of [false, true]) {
    test(`${kind} probe ends a detached helper and proves its tree after ${silent ? "timeout" : "completion"}`, posix, async (t) => {
      const h = fixture(t, silent);
      const proofs: Promise<boolean>[] = [];
      const launch = { ...h.launch, onProcess: (proof: Promise<boolean>) => proofs.push(proof) };
      const work = kind === "mcp" ? readCodexMcpInventory(launch, h.dir)
        : kind === "projection" ? readCodexSandboxProjection(launch, undefined, 1_500)
        : kind === "hooks" ? readCodexHookInventory({ ...launch, args: [h.script, "app-server"] }, undefined, 1_500)
        : runCodexProbe(launch.command, launch.args, { ...launch, timeoutMs: 1_500 });
      // Register rejection handling before waiting for the helper (MCP/hook timeouts reject).
      const outcome = work.then(value => ({ value }), error => ({ error }));
      const helper = await h.helper();
      const result = await outcome;
      assert.deepEqual(await Promise.all(proofs), [true]);
      assert.equal(await waitForOriginalProcessToStop(helper), undefined, "the detached helper is gone");
      if (silent && (kind === "mcp" || kind === "hooks")) {
        assert.ok("error" in result);
        assert.match(result.error.message, /timed out/);
      } else if (kind === "mcp") assert.deepEqual(result, { value: "[]\n" });
      else if (kind === "hooks") assert.deepEqual(result, { value: [] });
      else if (kind === "projection") assert.equal((result as { value: { ok: boolean } }).value.ok, !silent);
      else {
        const command = (result as { value: Awaited<ReturnType<typeof runCodexProbe>> }).value;
        assert.equal(command.status, silent ? null : 7);
        if (silent) assert.match(command.error!.message, /timed out after 1500ms/);
        else { assert.equal(command.stdout, "probe output\n"); assert.equal(command.stderr, "probe diagnostic\n"); }
      }
    });
  }
}

test("an injected real probe without a boundary cannot prove its detached helper gone", posix, async (t) => {
  const h = fixture(t);
  const ledger = new ProviderProcessLedger();
  const work = ledger.observe((observer) => readCodexHookInventory({
    ...h.launch, args: [h.script, "app-server"], ...observer,
  }, spawn));
  const helper = await h.helper();
  assert.deepEqual(await work, []);
  assert.equal(await ledger.prove({ terminate: true }), false, "the consumer must retain its reference");
  assert.ok(await captureLiveProcess(helper.pid), "root cleanup did not prove the detached helper gone");
});

test("cached permission profile verdicts carry their original tree proof to every consumer", posix, async (t) => {
  const h = fixture(t);
  const first: Promise<boolean>[] = [];
  const second: Promise<boolean>[] = [];
  const launch = { ...h.launch, legacy: { kind: "implicit" as const }, base: ":workspace" as const, hookStateDir: h.dir };
  // The real projection runs, then an injected deny result leaves the aggregate unproven.
  const deps = { verifyDeny: async () => ({ ok: true as const }) };
  const a = provenCodexPermissionProfile({ ...launch, onProcess: proof => first.push(proof) }, deps);
  const b = provenCodexPermissionProfile({ ...launch, onProcess: proof => second.push(proof) }, deps);
  assert.deepEqual(await a, { ok: true });
  assert.deepEqual(await b, { ok: true });
  assert.equal(first[0], second[0], "both consumers observe the original proof, including while in flight");
  assert.deepEqual(await Promise.all(first), [false]);
});

test("the Codex app-server driver's proof includes its real MCP inventory and provider trees", posix, async (t) => {
  const h = fixture(t);
  const driver = new CodexAppServerDriver({
    command: h.launch.command, args: h.launch.args, cwd: h.dir,
    env: h.launch.env as Record<string, string>, context: { kind: "native" },
    config: {}, review: true,
  }, { onEvent() {}, onStderr() {}, onExit() {} });
  t.after(async () => { driver.dispose(); await driver.proveProcessTreeExit({ terminate: true }); });
  const initializing = driver.initialize();
  const probeHelper = await h.helper();
  await initializing;
  assert.equal(await waitForOriginalProcessToStop(probeHelper), undefined, "MCP probe helper ended before provider launch");
  const providerHelper = await h.helper();
  assert.notEqual(providerHelper.pid, probeHelper.pid);
  driver.dispose();
  assert.equal(await driver.proveProcessTreeExit({ terminate: true }), true,
    "the session can release its HOME only after both the probe and provider trees are proven gone");
  assert.equal(await waitForOriginalProcessToStop(providerHelper), undefined);
});
