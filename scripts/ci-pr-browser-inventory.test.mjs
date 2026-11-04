import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { CRITICAL_BROWSER_FILES } from "./ci-pr-browser-policy.mjs";

const files = [...CRITICAL_BROWSER_FILES, "remote-instances.spec.ts"].map((file) => `apps/web/e2e/${file}`);
const list = (config) => JSON.parse(execFileSync(process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", "--config", config, "--list", "--reporter=json"], {
    encoding: "utf8", timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PR_BROWSER_FILES: JSON.stringify(files), CI: "", SYNTHETIC_ARTIFACT_FAILURE: "false", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }));
const identities = (suite) => [
  ...(suite.specs ?? []).flatMap((spec) => spec.tests.map((item) => ({
    file: spec.file, key: JSON.stringify([spec.file, spec.line, spec.column, spec.title, item.expectedStatus]),
  }))),
  ...(suite.suites ?? []).flatMap(identities),
];

test("PR config retains every selected file's tests and serial fixtures with no incidental matches", async () => {
  const full = list("playwright.config.ts"), selected = list("playwright.pr.config.ts");
  const expected = identities(full).filter(({ file }) => files.includes(`apps/web/e2e/${file}`));
  const actual = identities(selected);
  assert.ok(expected.length > files.length);
  assert.deepEqual(actual.map(({ key }) => key).sort(), expected.map(({ key }) => key).sort());
  assert.deepEqual([...new Set(actual.map(({ file }) => `apps/web/e2e/${file}`))].sort(), [...files].sort());
  assert.equal(selected.config.workers, 1);
  assert.equal(selected.config.projects.length, 1);
  const prior = process.env.PR_BROWSER_FILES;
  process.env.PR_BROWSER_FILES = JSON.stringify(files);
  try {
    const { default: config } = await import("../playwright.pr.config.ts");
    assert.equal(config.fullyParallel, false);
    assert.equal(config.workers, 1);
  } finally {
    if (prior === undefined) delete process.env.PR_BROWSER_FILES;
    else process.env.PR_BROWSER_FILES = prior;
  }
});
