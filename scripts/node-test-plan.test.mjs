import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { discoverNodeTests, nodeTestInventory, planNodeTests, profile, NODE_TEST_GLOBS } from "./node-test-plan.mjs";
import { parseTiming } from "./ci-timing.mjs";

test("partition union equals independent root discovery with no overlap or lost new files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "node-test-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const examples = [
    "apps/new/src/deep/new.test.ts", "apps/new/src/new.test.tsx", "apps/new/scripts/deep/new.test.mjs",
    "packages/new/src/deep/new.test.ts", "packages/new/src/new.test.tsx", "scripts/deep/new.test.mjs",
    profile.fastFiles[0],
  ];
  for (const file of [...examples, "apps/new/e2e/new.spec.ts", "scripts/fixture.mjs"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  assert.deepEqual(await discoverNodeTests(root), examples.sort());
  const files = await discoverNodeTests();
  const rootCommand = JSON.parse(readFileSync("package.json", "utf8")).scripts.test;
  assert.deepEqual([...rootCommand.matchAll(/"([^"]+\.test\.[^"]+)"/g)].map(m => m[1]), NODE_TEST_GLOBS);
  const fast = planNodeTests(files, "fast"), remaining = planNodeTests(files, "remaining");
  assert.deepEqual([...fast, ...remaining].sort(), files);
  assert.equal(new Set([...fast, ...remaining]).size, files.length);
  assert.deepEqual(planNodeTests([...files, ...files]).sort(), files);
  for (const file of examples.filter(file => !profile.fastFiles.includes(file))) {
    assert.ok(planNodeTests([file], "remaining").includes(file));
    assert.deepEqual(nodeTestInventory([file]), [{ file, full: true, partition: "remaining" }]);
  }
  assert.throws(() => planNodeTests(files, "typo"), /Unknown Node suite/);
});

test("the largest measured costs run first without changing membership or worker count", async () => {
  const files = await discoverNodeTests();
  const ordered = planNodeTests(files);
  assert.deepEqual(ordered.slice(0, profile.slowestFiles.length), profile.slowestFiles.map(row => row.file));
  assert.deepEqual(ordered.sort(), files);
  assert.equal(new Set(profile.fastFiles).size, profile.fastFiles.length);
  for (const file of profile.fastFiles) assert.ok(files.includes(file), `stale fast-file entry: ${file}`);
});

const runner = resolve("scripts/test-node.mjs");
function fixture(t, source) {
  const root = mkdtempSync(join(tmpdir(), "node-test-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "fixture.test.mjs");
  writeFileSync(file, source);
  return file;
}
function childArgs(files, options = {}) {
  const entry = join(dirname(files[0]), "entry.mjs");
  // An eval entry is inherited by Node's file workers and would recurse. Use a
  // real entry file, just as the public command does.
  writeFileSync(entry, `delete process.env.NODE_TEST_CONTEXT; const {runNodeTests}=await import(${JSON.stringify(runner)}); await runNodeTests(${JSON.stringify(files)},${JSON.stringify({ concurrency: 1, timeout: 2000, ci: true, ...options })});`);
  return [entry];
}

test("the native runner preserves assertion failures, process isolation and a single safe summary", (t) => {
  const first = fixture(t, 'import {test} from "node:test"; test("first",()=>{ globalThis.privateFixture=true; });');
  const second = fixture(t, 'import {test} from "node:test"; import assert from "node:assert/strict"; test("isolated",()=>assert.equal(globalThis.privateFixture,undefined)); test("failure",()=>assert.fail("expected failure"));');
  const result = spawnSync(process.execPath, childArgs([first, second]), { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1, result.stderr);
  const summaries = result.stdout.split("\n").map(parseTiming).filter(Boolean);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].count, 3);
  assert.equal(summaries[0].failed, 1);
});

test("a hung async test is bounded and fails the complete command", (t) => {
  const file = fixture(t, 'import {test} from "node:test"; test("hang",async(t)=>{ const handle=setInterval(()=>{},100); t.after(()=>clearInterval(handle)); await new Promise(()=>{}); });');
  const result = spawnSync(process.execPath, childArgs([file], { timeout: 200 }), { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /timed out/);
});

test("SIGTERM aborts native file workers and keeps an interrupted exit code", { timeout: 15_000 }, async (t) => {
  const file = fixture(t, 'import {test} from "node:test"; import {writeFileSync} from "node:fs"; test("running",async()=>{ writeFileSync(import.meta.filename+".pid",String(process.pid)); await new Promise(()=>setInterval(()=>{},100)); });');
  const child = spawn(process.execPath, childArgs([file], { timeout: 10_000 }), { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  const deadline = Date.now() + 5000;
  let worker;
  while (!worker && Date.now() < deadline) {
    try { worker = Number(readFileSync(file + ".pid", "utf8")); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(worker, "worker must start before interrupting");
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 143);
  assert.throws(() => process.kill(worker, 0), { code: "ESRCH" });
});
