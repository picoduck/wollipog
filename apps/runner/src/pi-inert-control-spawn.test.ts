import assert from "node:assert/strict";
import { test } from "node:test";
import { piInertControlSpawnAdapter } from "./pi-inert-control-spawn.js";

test("fixed child seam refuses command/argv/env/descriptor overrides and captures selection before mutation", async () => {
  let calls = 0;
  const captured = { command: "/inert/node", args: ["/inert/mcp.mjs", "--agent-control-mcp"], environment: { WOLLIPOG_CANARY: "private-inert" } };
  const originalArgs = [...captured.args], originalEnv = { ...captured.environment };
  const adapter = piInertControlSpawnAdapter({ async run(input, output, errors) {
    calls++; input.destroy(); output.end(); errors.end(); return { exitCode: 7 };
  } }, captured);
  captured.args.push("--untrusted-override"); captured.environment.WOLLIPOG_CANARY = "mutated";
  const options = { env: originalEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
  for (const invoke of [
    () => adapter.spawn("/model/selected-executable", originalArgs, options),
    () => adapter.spawn("/inert/node", [...originalArgs, "--eval", "inert"], options),
    () => adapter.spawn("/inert/node", originalArgs, { ...options, env: { ...originalEnv, NODE_OPTIONS: "private-inert" } }),
    () => adapter.spawn("/inert/node", originalArgs, { ...options, stdio: ["pipe", "pipe", "pipe", "pipe"] }),
    () => adapter.spawn("/inert/node", originalArgs, { ...options, windowsHide: false }),
  ]) assert.throws(invoke, error => {
    assert.equal((error as Error).message, "Pi inert control child selection refused."); return true;
  });
  assert.equal(calls, 0);
  const child = adapter.spawn("/inert/node", originalArgs, options);
  assert.equal(await new Promise(resolve => child.once("close", resolve)), 7);
  assert.equal(calls, 1); assert.equal(child.stdin.destroyed, true); assert.equal(child.kill(), false);
});

test("pre-start cancellation closes owned streams and never surfaces launcher exception values", async () => {
  const adapter = piInertControlSpawnAdapter({ async run(_input, _output, _errors, options) {
    assert.equal(options?.signal?.aborted, true); throw new Error("private-inert-exception");
  } }, { command: "/inert/node", args: [], environment: {} });
  const child = adapter.spawn("/inert/node", [], { env: {}, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const errors: string[] = []; child.on("error", error => errors.push(error.message));
  const done = new Promise(resolve => child.once("close", resolve));
  child.kill(); assert.equal(await done, null);
  assert.deepEqual(errors, ["Pi inert control child failed."]);
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
});
