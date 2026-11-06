import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { browserFiles, browserProfile, browserShards, BROWSER_SHARD_COUNT } from "../playwright.shards.ts";
import base from "../playwright.config.ts";
import ci from "../playwright.ci.config.ts";
import productionConfig from "../playwright.production.config.ts";
import webkitConfig from "../playwright.webkit.config.ts";
import { REQUIRED } from "./main-rolling-validation.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = read("../.github/workflows/ci.yml");

function inventory(config) {
  return JSON.parse(execFileSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test",
    "--config", config, "--list", "--reporter=json"], {
    cwd: new URL("../", import.meta.url), timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: "", SYNTHETIC_ARTIFACT_FAILURE: "false", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

function identities(report) {
  const rows = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const item of spec.tests) rows.push({
        key: JSON.stringify([spec.file, spec.line, spec.column, spec.title, item.expectedStatus]),
        file: spec.file, project: item.projectName, title: spec.title,
      });
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  visit(report);
  return rows;
}

test("duration grouping covers live and newly added files exactly once and accounts for production", () => {
  const files = browserFiles();
  const groups = browserShards(files);
  assert.equal(groups.length, BROWSER_SHARD_COUNT);
  assert.deepEqual(groups.flatMap((group) => group.files).sort(), files);
  assert.ok(groups.every((group) => group.files.length > 0));
  const added = [...files, "new-unprofiled.test.ts"];
  assert.deepEqual(browserShards(added).flatMap((group) => group.files).sort(), added.sort());
  assert.deepEqual(browserShards([...files].reverse()), groups, "input order cannot change assignments");
  assert.equal(groups.reduce((sum, group) => sum + group.durationMs, 0),
    browserProfile.productionDurationMs + files.reduce((sum, file) =>
      sum + (browserProfile.files[file] ?? browserProfile.fallbackDurationMs), 0));
  assert.ok(browserProfile.fallbackDurationMs > 0 && browserProfile.productionDurationMs > 0);
  assert.ok(Object.values(browserProfile.files).every((value) => Number.isFinite(value) && value >= 0));
});

test("profile weights reconcile the safe reporter projection and measured phase residual", () => {
  const profile = JSON.parse(read("./fixtures/browser-shard-profile.json"));
  const measured = new Map();
  const jobs = new Set();
  const runFiles = new Set();
  for (const source of profile.sources) {
    const run = profile.sourceRuns.find((run) => run.runId === source.runId && run.attempt === source.attempt);
    assert.ok(run, "every source must bind to one identified attempt");
    assert.equal(source.context.testedSha, run.testedSha);
    assert.equal(source.context.attempt, source.attempt);
    assert.equal(source.context.runId, String(source.runId));
    assert.ok(!jobs.has(source.jobId), "copied jobs cannot become fresh measurements");
    jobs.add(source.jobId);
    assert.equal(source.failed, 0);
    assert.equal(source.retryOnly, 0);
    for (const row of source.slowestFiles) {
      const identity = `${source.runId}/${source.attempt}/${row.fileId}`;
      assert.ok(!runFiles.has(identity), "each whole file occurs once per attempt");
      runFiles.add(identity);
      measured.set(row.fileId, [...(measured.get(row.fileId) ?? []), row.durationMs]);
    }
  }
  for (const run of profile.sourceRuns) assert.deepEqual(profile.sources
    .filter((source) => source.runId === run.runId && source.attempt === run.attempt)
    .map((source) => source.shard).sort((a, b) => a - b), Array.from({ length: run.shardCount }, (_, i) => i + 1));
  assert.equal(measured.size, Object.keys(profile.files).length);
  for (const [file, duration] of Object.entries(profile.files)) {
    const id = createHash("sha256").update(`apps/web/e2e/${file}`).digest("hex");
    const observations = measured.get(id);
    assert.equal(Math.ceil(observations.reduce((sum, value) => sum + value, 0) / observations.length), duration);
  }
  const residual = profile.sources.reduce((sum, source) => sum + source.suiteSeconds * 1000, 0) / profile.sourceRuns.length
    - Object.values(profile.files).reduce((sum, duration) => sum + duration, 0);
  assert.equal(profile.fallbackDurationMs,
    Math.ceil(residual / (profile.inventoryFiles - measured.size)));
});

test("all ten CI projects cover every configured development test once with intact file fixtures", () => {
  const full = identities(inventory("playwright.config.ts"));
  const report = inventory("playwright.ci.config.ts");
  const grouped = identities(report);
  assert.ok(full.length > 0);
  assert.deepEqual(grouped.map((row) => row.key).sort(), full.map((row) => row.key).sort());
  const scheduledProjects = workflow.match(/^  browser:\n[\s\S]*?^        shard: .*?\|\| '\[([^\]]+)\]'/m)?.[1]
    .split(",").map((id) => `shard-${id.trim()}`);
  assert.deepEqual(report.config.projects.map((project) => project.name), scheduledProjects,
    "every configured project must have exactly one scheduled browser matrix job");
  assert.deepEqual(REQUIRED.filter((name) => name.includes("/ Browser End-to-End Tests ("))
    .map((name) => `shard-${name.match(/\((\d+)\)$/)[1]}`), scheduledProjects,
    "rolling certification must require the entire workflow inventory");
  for (const file of new Set(grouped.map((row) => row.file))) {
    assert.equal(new Set(grouped.filter((row) => row.file === file).map((row) => row.project)).size, 1, file);
  }
  for (const config of [base, ci, productionConfig, webkitConfig]) {
    assert.equal(config.fullyParallel, false);
    assert.equal(config.workers, 1);
    assert.equal(config.webServer.reuseExistingServer, false);
    assert.match(config.webServer.command, /--strictPort/);
  }
  assert.match(workflow, /shard: .*?\|\| '\[1, 2, 3, 4, 5, 6, 7, 8, 9, 10\]'/);
  assert.match(workflow, /pnpm test:e2e --config playwright\.ci\.config\.ts --project=shard-\$\{\{ matrix\.shard \}\}/);
});

test("production, WebKit and conditional Windows retain their complete configured inventories", () => {
  const development = identities(inventory("playwright.config.ts"));
  const production = identities(inventory("playwright.production.config.ts"));
  const webkit = identities(inventory("playwright.webkit.config.ts"));
  assert.ok(production.length > 0 && webkit.length > 0);
  assert.ok(production.every((row) => row.title.includes("@production")));
  const devKeys = new Set(development.map((row) => row.key));
  assert.ok(production.every((row) => row.file === "inbox-lazy.spec.ts" || devKeys.has(row.key)));
  assert.ok(webkit.every((row) => devKeys.has(row.key)));
  assert.match(workflow, /name: Rendered Production Browser Smoke\n        if: matrix.shard == 1\n        run: pnpm test:e2e:production/);
  assert.match(workflow, /name: WebKit Browser End-to-End Tests\n        run: pnpm test:e2e:webkit/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/settings-rows-win32.yml/);
  const windows = read("../.github/workflows/settings-rows-win32.yml");
  assert.match(windows, /if: needs.scope.outputs.affected == 'true'/);
  assert.match(windows, /run: pnpm exec playwright test settings-rows\n/);
  assert.doesNotMatch(windows, /playwright.ci.config|--shard|--project/);
  for (const path of ["../playwright.config.ts", "../playwright.production.config.ts"]) {
    const config = read(path);
    assert.match(config, /failOnFlakyTests: Boolean\(process.env.CI\)/);
    assert.match(config, /workers: 1/);
    assert.match(config, /fullyParallel: false/);
    assert.match(config, /reuseExistingServer: false/);
    assert.match(config, /--strictPort/);
  }
});
