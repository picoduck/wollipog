import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fc from "fast-check";
import nodeReporter from "./ci-node-timing-reporter.mjs";
import BrowserReporter from "./ci-browser-timing-reporter.mjs";
import { parseTiming, TimingSummary, TIMING_MARKER } from "./ci-timing.mjs";

test("arbitrary JSON logs either reject or retain only the safe schema", () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    const result = parseTiming(TIMING_MARKER + JSON.stringify(value));
    if (result !== null) {
      assert.deepEqual(parseTiming(TIMING_MARKER + JSON.stringify(result)), result);
      assert.ok(["node", "browser"].includes(result.suite));
      assert.ok(result.slowestTests.length <= 20);
    }
  }), { numRuns: 200 });
});

test("projections preserve durations and cannot retain generated test inputs", () => {
  fc.assert(fc.property(fc.array(fc.record({
    name: fc.string(), durationMs: fc.integer({ min: 0, max: 1_000_000 }),
    state: fc.constantFrom("passing", "failing", "cancelled", "skipped", "unmeasured"), retry: fc.integer({ min: 0, max: 2 }),
  }), { maxLength: 60 }), (rows) => {
    const summary = new TimingSummary("browser");
    for (const row of rows) summary.add({ ...row, file: process.cwd() + "/synthetic.spec.ts" });
    const result = parseTiming(TIMING_MARKER + JSON.stringify({ ...summary.result(), privateInput: "PRIVATE_SENTINEL" }));
    assert.ok(result);
    assert.equal(result.count, rows.length);
    assert.equal(result.slowestFiles[0]?.durationMs ?? 0, rows.reduce((sum, row) => sum + row.durationMs, 0));
    assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"));
    for (const row of result.slowestTests) {
      assert.match(row.fileId, /^[a-f0-9]{64}$/);
      assert.match(row.testId, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(result.slowestTests.map((row) => row.durationMs), rows.map((row) => row.durationMs).sort((a, b) => b - a).slice(0, 20));
  }), { numRuns: 100 });
});

test("cancelled Node and interrupted browser tests remain distinct from failures", async () => {
  async function* events() {
    for (const failureType of ["cancelledByParent", "testTimeoutFailure", "testAborted", "testCodeFailure"]) {
      yield { type: "test:fail", data: { file: process.cwd() + "/synthetic.test.ts", name: failureType,
        details: { type: "test", duration_ms: 1, error: { failureType, message: "PRIVATE_SENTINEL" } } } };
    }
  }
  const lines = [];
  for await (const line of nodeReporter(events())) lines.push(line);
  const node = parseTiming(lines[0]);
  assert.equal(node.cancelled, 3);
  assert.equal(node.failed, 1);
  assert.ok(!lines[0].includes("PRIVATE_SENTINEL"));
  const browser = new BrowserReporter();
  const item = { location: { file: process.cwd() + "/synthetic.spec.ts" }, titlePath: () => ["synthetic"], expectedStatus: "passed" };
  for (const status of ["interrupted", "failed", "timedOut", "unknown"]) browser.onTestEnd(item, { duration: 1, status, retry: 0 });
  const result = browser.summary.result();
  assert.equal(result.cancelled, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.unmeasured, 1);
});

test("reporter adapters emit only completed synthetic event projections", async () => {
  async function* events() {
    yield { type: "test:stdout", data: { message: "PRIVATE_SENTINEL" } };
    yield { type: "test:fail", data: { file: process.cwd() + "/synthetic.test.ts", name: "PRIVATE_SENTINEL", line: 1, column: 1,
      details: { type: "test", duration_ms: 3, error: new Error("PRIVATE_SENTINEL") } } };
  }
  const lines = [];
  for await (const line of nodeReporter(events())) lines.push(line);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("PRIVATE_SENTINEL"));
  assert.equal(parseTiming(lines[0]).failed, 1);
  const browser = new BrowserReporter();
  const item = { location: { file: process.cwd() + "/synthetic.spec.ts" }, titlePath: () => ["PRIVATE_SENTINEL"], expectedStatus: "passed" };
  browser.onTestEnd(item, { duration: 5, status: "failed", retry: 0, error: "PRIVATE_SENTINEL" });
  browser.onTestEnd(item, { duration: 6, status: "passed", retry: 1 });
  assert.equal(browser.summary.result().retryOnly, 1);
  assert.equal(browser.summary.result().failed, 1);
  assert.ok(!JSON.stringify(browser.summary.result()).includes("PRIVATE_SENTINEL"));
});

test("CI Node command preserves ordinary test inventory and timeout", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  const diagnostic = scripts["test:ci"].replace(/ --test-reporter(?:-destination)?=[^ ]+/g, "");
  assert.equal(diagnostic, scripts.test);
  assert.match(readFileSync(".github/workflows/ci.yml", "utf8"), /name: Unit Tests\n\s+run: pnpm test:ci/);
});
