import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

test("lock-race cleanup preserves source-mapped lcov reporting", () => {
  const output = mkdtempSync(join(tmpdir(), "wollipog-lock-coverage-"));
  const tapPath = join(output, "race.tap");
  const lcovPath = join(output, "race.lcov");
  const env = { ...process.env };
  // This is a separate test runner, with its own coverage files and reporting lifecycle.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --enable-source-maps`;
  try {
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--test", "--experimental-test-coverage",
      "--test-name-pattern=^(of two processes taking a free lock, exactly one wins|cleanup lets a published child finish before removing its files)$",
      "--test-reporter=tap", `--test-reporter-destination=${tapPath}`,
      "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`,
      "apps/runner/src/session-store-lock.test.ts",
    ], { cwd: REPO_ROOT, env, encoding: "utf8" });
    assert.ifError(child.error);
    const tap = readFileSync(tapPath, "utf8");
    assert.equal(child.status, 0, `${child.stderr}\n${tap}`);
    assert.match(tap, /^# pass 2$/m, "the two-process race and post-publication cleanup must run");
    assert.match(tap, /^# fail 0$/m);
    assert.doesNotMatch(tap, /Could not report code coverage|ERR_SOURCE_MAP_MISSING_SOURCE/);
    const lcov = readFileSync(lcovPath, "utf8");
    const store = lcov.split("end_of_record").find((record) => /^SF:.*[/\\]session-store\.ts$/m.test(record));
    assert.ok(store, "lcov must contain the original TypeScript store source");
    assert.match(store, /^DA:\d+,[1-9]\d*$/m, "store coverage must contain executed lines");
    assert.match(lcov, /^SF:.*[/\\]session-store-lock-child\.mjs$/m, "child coverage must remain included");
  } finally {
    rmSync(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
