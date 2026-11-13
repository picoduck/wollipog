import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import fc from "fast-check";
const entrypoint = fileURLToPath(new URL("./pi-inert-control-entrypoint.mjs", import.meta.url));
const helper = fileURLToPath(new URL("./fixtures/pi-inert-control-helper.mjs", import.meta.url));
const canary = "inert-canary-value-3922";
function frame(value: unknown) {
  const payload = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}
async function run(input: Buffer[], extraArgs: string[] = [], keepOpen = false) {
  const home = realpathSync(mkdtempSync(join(process.cwd(), ".pi-inert-entry-")));
  try {
    const child = spawn(process.execPath, ["--no-addons", "--no-global-search-paths", entrypoint,
      realpathSync(process.execPath), helper, home, ...extraArgs], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
    });
    for (const chunk of input) child.stdin.write(chunk);
    if (!keepOpen) child.stdin.end();
    return await done;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const env = { HOME: realpathSync(process.cwd()), PATH: "/usr/bin:/bin", LANG: "C", WOLLIPOG_CANARY: canary };
test("fixed MCP entry strips a fragmented private frame, delivers env privately and forwards only RPC", { timeout: 10_000 }, async () => {
  const privateFrame = frame({ version: 1, env });
  const rpc = Buffer.from('{"id":1,"method":"inspect"}\n{"id":2,"method":"echo","value":"rpc-only"}\n');
  const result = await run([privateFrame.subarray(0, 1), privateFrame.subarray(1, 3),
    privateFrame.subarray(3, 11), Buffer.concat([privateFrame.subarray(11), rpc])]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").map(line => JSON.parse(line)), [
    { id: 1, envDelivered: true, argvSafe: true, loaderSafe: true, fixedArgs: ["--agent-control-mcp"] },
    { id: 2, result: "rpc-only" },
  ]);
  assert.equal(result.stderr, ""); assert.ok(!result.stdout.includes(canary));
});
test("fixed entry refuses truncated/oversized/malformed frames and loader keys without payload disclosure", { timeout: 10_000 }, async () => {
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(262_145);
  const malformed = [Buffer.alloc(0), Buffer.alloc(4), Buffer.from([0, 0]), frame({ version: 1, env }).subarray(0, -1), oversized,
    frame(`{"canary":"${canary}"`), frame({ version: 1, env, argv: [canary] }),
    frame({ version: 2, env }), frame({ version: 1, env: { ...env, NODE_OPTIONS: canary } }),
    frame({ version: 1, env: { ...env, WOLLIPOG_CANARY: `${canary}\0` } }),
    frame({ version: 1, env: { ...env, WOLLIPOG_CANARY: "x".repeat(32_769) } }),
    frame({ version: 1, env: { ...env, ["WOLLIPOG_" + "X".repeat(257)]: canary } }),
    frame({ version: 1, env: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`WOLLIPOG_${index}`, canary])) }),
    frame(`${JSON.stringify({ version: 1, env })} ${canary}`)];
  for (const input of malformed) {
    const result = await run([input]);
    assert.equal(result.code, 125);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Pi inert control entrypoint refused execution.\n");
    assert.ok(!result.stderr.includes(canary));
  }
});
test("fixed entry preserves helper exit and does not wait on an open RPC source after helper exit", { timeout: 10_000 }, async () => {
  const result = await run([frame({ version: 1, env }), Buffer.from('{"method":"exit","code":7}\n')], [], true);
  assert.equal(result.code, 7, result.stderr);
  assert.equal(result.stdout, "");
});

test("RPC roundtrip is independent of byte chunk boundaries across the private-frame boundary", { timeout: 15_000 }, async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string({ maxLength: 256 }), { minLength: 1, maxLength: 8 }),
    fc.array(fc.integer({ min: 1, max: 73 }), { minLength: 1, maxLength: 30 }), async (values, widths) => {
      const bytes = Buffer.concat([frame({ version: 1, env }), Buffer.from(values.map((value, id) =>
        JSON.stringify({ id, method: "echo", value })).join("\n") + "\n")]);
      const chunks: Buffer[] = [];
      for (let offset = 0, index = 0; offset < bytes.length; index++) {
        const end = Math.min(bytes.length, offset + widths[index % widths.length]!);
        chunks.push(bytes.subarray(offset, end)); offset = end;
      }
      const result = await run(chunks);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(result.stdout.trim().split("\n").map(line => JSON.parse(line)), values.map((value, id) => ({ id, result: value })));
    }), { numRuns: 25, examples: [[["🦊é\n\0"], [1]]] });
});
