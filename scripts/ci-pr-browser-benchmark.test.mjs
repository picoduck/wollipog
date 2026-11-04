import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { CRITICAL_BROWSER_FILES, validateBrowserFiles } from "./ci-pr-browser-policy.mjs";

test("benchmark preparation rejects non-dispatch execution and emits only validated critical-file data", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pr-browser-benchmark-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const output = join(cwd, "env");
  const inventory = CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`);
  for (const event of ["pull_request", "merge_group", "push", "workflow_call", "workflow_dispatch"]) {
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, ["scripts/ci-pr-browser-benchmark.mjs"], {
      env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_ENV: output },
      encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    if (event === "workflow_dispatch") {
      assert.equal(result.status, 0);
      const value = readFileSync(output, "utf8").trim().slice("BENCHMARK_BROWSER_FILES=".length);
      assert.deepEqual(validateBrowserFiles(value, inventory), inventory);
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(output, "utf8"), "");
    }
  }
});
