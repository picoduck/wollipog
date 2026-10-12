import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";

test("synthetic sanitizer regression suite", { skip: process.platform === "win32" && "the sanitizer runs in Ubuntu browser CI" }, () => {
  const result = spawnSync("python3", ["-B", "scripts/fixtures/browser-failure-artifact-tests.py"], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const config = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
const step = (name) => workflow.split(/^      - name: /m).slice(1).find((text) => text.startsWith(`${name}\n`));
const sanitize = step("Sanitize Synthetic Browser Failure Artifacts");
const upload = step("Upload Sanitized Synthetic Browser Failure Artifacts");

function eligible(text, browser, sanitizer = "success", retained = "true", cancelled = false) {
  const expression = text.match(/^        if: \$\{\{ (.*) \}\}$/m)[1]
    .replaceAll("steps.browser-tests", "steps.browser").replaceAll("steps.sanitize-browser-artifacts", "steps.sanitizer");
  return vm.runInNewContext(expression, {
    steps: { browser: { outcome: browser }, sanitizer: { outcome: sanitizer, outputs: { retained } } },
    cancelled: () => cancelled,
  }, { timeout: 1000 });
}

test("only successful sanitization of an exact failing shard can publish", () => {
  for (const status of ["success", "failure", "skipped", "cancelled"]) {
    assert.equal(eligible(sanitize, status), status === "failure");
    assert.equal(eligible(upload, status), status === "failure");
  }
  assert.equal(eligible(upload, "failure", "failure"), false);
  assert.equal(eligible(upload, "failure", "success", "false"), false);
  assert.equal(eligible(upload, "failure", "success", "true", true), false);
  assert.match(upload, /retention-days: 3\n/);
  assert.match(upload, /if-no-files-found: error\n/);
  assert.match(upload, /include-hidden-files: false\n/);
  assert.match(upload, /name: synthetic-browser-failure-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-shard-\$\{\{ matrix.shard \}\}/);
  const paths = upload.match(/          path: \|\n((?:            .*\n)+)/)[1].trim().split("\n").map((line) => line.trim());
  assert.deepEqual(paths, ["manifest.json", "synthetic-failure-*/trace.zip", "synthetic-failure-*/error-context.md"]
    .map((path) => `\${{ runner.temp }}/sanitized-synthetic-browser/${path}`));
});

test("capture/upload faults preserve original shard failure, retries and required aggregation", () => {
  const browser = step("Remote-Instance Browser End-to-End Tests");
  assert.doesNotMatch(browser, /continue-on-error:|if:/);
  for (const text of [sanitize, upload]) {
    assert.match(text, /continue-on-error: true\n/);
    assert.match(text, /timeout-minutes: 1\n/);
  }
  // The aggregator consumes the browser JOB result, never the diagnostic step's conclusion.
  assert.match(workflow, /BROWSER_RESULT: \$\{\{ needs.browser.result \}\}/);
  assert.match(config, /retries: process.env.CI \? 2 : 0/);
  assert.match(config, /failOnFlakyTests: Boolean\(process.env.CI\)/);
  assert.match(browser, /github.event_name == 'workflow_dispatch' && inputs.synthetic_failure_artifacts/);
  assert.match(workflow, /type: boolean\n        default: false/);
});
