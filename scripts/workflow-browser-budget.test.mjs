import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const evidence = JSON.parse(readFileSync(new URL("./fixtures/browser-ci-timings.json", import.meta.url), "utf8"));
const paths = ["Install Playwright Browser", "Install Playwright System Dependencies"];
const reserveSeconds = 180;
// The recorded six-minute timeout took 372 seconds. Round its 12-second overrun up to 15
// for EACH attempt, including a near-bound successful retry. This is a sizing assumption,
// not a promise about GitHub's timeout enforcement; natural-run observation is still required.
const enforcementSecondsPerAttempt = 15;

function browserJob(source) {
  const start = source.indexOf("\n  browser:\n");
  const end = source.indexOf("\n  win32:\n", start);
  assert.ok(start >= 0 && end > start, "browser job must be independently inspectable");
  return source.slice(start, end);
}

function namedStep(job, name) {
  const step = job.split(/^      - name: /m).slice(1).find((value) => value.startsWith(`${name}\n`));
  assert.ok(step, `${name}: missing step`);
  return step;
}

function stepSeconds(step) {
  const bounds = [...step.matchAll(/^        timeout-minutes: (\d+)$/gm)];
  assert.equal(bounds.length, 1, "each install attempt needs one finite deadline");
  const seconds = Number(bounds[0][1]) * 60;
  assert.ok(seconds > 0);
  return seconds;
}

function measuredRemainder(rows) {
  assert.ok(rows.length > 0);
  return Math.max(...rows.map((row) => {
    for (const key of ["queueSeconds", "activeSeconds", "firstInstallSeconds", "retryInstallSeconds",
      "otherSetupSeconds", "suiteSeconds", "productionSeconds", "cleanupSeconds", "nonInstallSeconds"]) {
      assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0, `${key}: invalid phase duration`);
    }
    const remainder = row.otherSetupSeconds + row.suiteSeconds + row.productionSeconds + row.cleanupSeconds;
    assert.equal(remainder, row.nonInstallSeconds, "all non-install phases must be accounted for");
    assert.equal(row.firstInstallSeconds + row.retryInstallSeconds + remainder, row.activeSeconds,
      "active phases must reconcile without charging queue wait");
    return remainder;
  }));
}

function budgetAccounting(source, rows = evidence.samples) {
  const job = browserJob(source);
  const budget = Number(job.match(/^    timeout-minutes: (\d+)$/m)?.[1]) * 60;
  assert.ok(Number.isSafeInteger(budget) && budget > 0, "browser job needs a finite budget");
  const attemptPaths = paths.map((name) => [stepSeconds(namedStep(job, name)), stepSeconds(namedStep(job, `Retry ${name}`))]);
  // Cache hit/miss are mutually exclusive; each active path includes its own first AND retry.
  const install = Math.max(...attemptPaths.map((attempts) => attempts.reduce((sum, value) => sum + value, 0)));
  const remainder = Math.ceil(measuredRemainder(rows) / 10) * 10;
  const enforcement = Math.max(...attemptPaths.map((attempts) => attempts.length)) * enforcementSecondsPerAttempt;
  const required = install + remainder + enforcement + reserveSeconds;
  assert.ok(budget >= required,
    `browser: ${budget}s must cover ${install}s attempts + ${remainder}s measured remainder + ` +
    `${enforcement}s timeout enforcement + ${reserveSeconds}s reserve (needs ${required}s)`);
  return { budget, install, remainder, enforcement, required };
}

function withBudget(minutes) {
  const job = browserJob(workflow);
  return workflow.replace(job, job.replace(/^    timeout-minutes: \d+$/m, `    timeout-minutes: ${minutes}`));
}

function withAttemptBound(name, minutes) {
  const job = browserJob(workflow);
  const step = namedStep(job, name);
  return workflow.replace(job, job.replace(step, step.replace(/^        timeout-minutes: \d+$/m, `        timeout-minutes: ${minutes}`)));
}

function eligible(step, { cacheHit, outcome = "failure", cancelled = false } = {}) {
  let expression = step.match(/^        if: (.+)$/m)?.[1];
  assert.ok(expression);
  expression = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/steps\.([a-z0-9_-]+)\.outputs\.([a-z0-9_-]+)/g, 'steps["$1"].outputs["$2"]')
    .replace(/steps\.([a-z0-9_-]+)\.outcome/g, 'steps["$1"].outcome');
  return vm.runInNewContext(expression, {
    steps: {
      "playwright-cache": { outputs: { "cache-hit": cacheHit } },
      "playwright-browser": { outcome, conclusion: "success" },
      "playwright-system-dependencies": { outcome, conclusion: "success" },
    },
    cancelled: () => cancelled,
  }, { timeout: 1_000 });
}

test("identified browser phases include every full-run shard and reconcile active time separately from queue", () => {
  assert.equal(evidence.units, "seconds");
  const identities = new Set(evidence.samples.map((row) => `${row.runId}/${row.attempt}/${row.shard}`));
  assert.equal(identities.size, evidence.samples.length, "do not count carried-forward successes as fresh retry measurements");
  for (const { runId, attempt } of evidence.completeRunAttempts) {
    assert.deepEqual(evidence.samples.filter((row) => row.runId === runId && row.attempt === attempt)
      .map((row) => row.shard).sort(), [1, 2, 3, 4, 5], `${runId}/${attempt}: missing or duplicated shard`);
  }
  const retry = evidence.samples.filter((row) => row.runId === 37478932815 && row.attempt === 2);
  assert.deepEqual(retry.map((row) => row.shard), [4], "only the genuinely rerun job is a new measurement");
  assert.equal(measuredRemainder(evidence.samples), 1448, "retain the slower historical workload envelope");
  const current = evidence.samples.filter((row) => row.runId === 37489739075);
  assert.equal(current.length, 5, "remeasure all shards after the baseline workload changes");
  assert.ok(current.every((row) => row.headSha === evidence.baselineHead));
  assert.ok(evidence.samples.some((row) => row.shard === 1 && row.productionSeconds > 0));
  assert.ok(evidence.samples.every((row) => row.shard === 1 || row.productionSeconds === 0),
    "non-shard-1 production skips are intentional");
});

test("browser budget covers either bounded install path, measured remainder, enforcement and three minutes spare", () => {
  const result = budgetAccounting(workflow);
  assert.deepEqual(result, { budget: 2400, install: 720, remainder: 1450, enforcement: 30, required: 2380 });
  const timedOut = evidence.samples.find((row) => row.firstAttemptTimedOut);
  assert.ok(timedOut);
  assert.ok(timedOut.firstInstallSeconds - 360 <= enforcementSecondsPerAttempt,
    "the sizing assumption must cover the observed enforcement overrun");
  for (const row of evidence.samples) {
    assert.ok(result.budget - result.install - result.enforcement - row.nonInstallSeconds >= reserveSeconds,
      `run ${row.runId} shard ${row.shard}: near-bound recovered setup must leave the full remaining workload its reserve`);
  }
});

test("lost margin is detected for reduced job budgets or longer first and retry limits on either path", () => {
  for (const minutes of [25, 30, 35, 39]) {
    assert.throws(() => budgetAccounting(withBudget(minutes)), /must cover/, `${minutes}m is insufficient`);
  }
  for (const name of paths.flatMap((name) => [name, `Retry ${name}`])) {
    assert.throws(() => budgetAccounting(withAttemptBound(name, 7)), /must cover/, `${name}: lost reserve`);
  }
  const original = evidence.samples.find((row) => row.firstAttemptTimedOut);
  assert.ok(original.activeSeconds > 25 * 60, "replay the observed recovered install and passing suite against the old limit");
  assert.ok(original.activeSeconds + reserveSeconds <= budgetAccounting(workflow).budget);
});

test("omitting production or cleanup fails accounting while queue wait cannot consume the active budget", () => {
  for (const phase of ["productionSeconds", "cleanupSeconds"]) {
    const rows = structuredClone(evidence.samples);
    rows.find((row) => row[phase] > 0)[phase] = 0;
    assert.throws(() => budgetAccounting(workflow, rows), /must be accounted for/);
  }
  const queued = evidence.samples.map((row) => ({ ...row, queueSeconds: 86_400 }));
  assert.deepEqual(budgetAccounting(workflow, queued), budgetAccounting(workflow));
});

test("install paths are exclusive and timeout outcome retries even when continue-on-error reports success", () => {
  const job = browserJob(workflow);
  for (const cacheHit of ["true", "false", undefined]) {
    const active = paths.filter((name) => eligible(namedStep(job, name), { cacheHit }));
    assert.deepEqual(active, [cacheHit === "true" ? paths[1] : paths[0]]);
  }
  for (const name of paths) {
    const retry = namedStep(job, `Retry ${name}`);
    assert.equal(eligible(retry, { outcome: "failure" }), true);
    assert.equal(eligible(retry, { outcome: "success" }), false);
    assert.equal(eligible(retry, { outcome: "failure", cancelled: true }), false);
  }
});

test("inert retry shells clean up before installing and propagate second-install or repair failure", {
  skip: process.platform === "win32" && "these retry shells run in the Ubuntu browser job",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-budget-recovery-"));
  const calls = join(dir, "calls.txt");
  try {
    const stubs = {
      pkill: 'printf "pkill %s\\n" "$*" >> "$BROWSER_BUDGET_CALLS"\nexit 1\n',
      sudo: 'printf "sudo %s\\n" "$*" >> "$BROWSER_BUDGET_CALLS"\ncase "$1" in\n  pkill) exit 1 ;;\n  dpkg) exit "$BROWSER_BUDGET_DPKG_STATUS" ;;\n  *) exit 99 ;;\nesac\n',
      pnpm: 'printf "pnpm %s\\n" "$*" >> "$BROWSER_BUDGET_CALLS"\nexit "$BROWSER_BUDGET_PNPM_STATUS"\n',
    };
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(dir, name), `#!/bin/bash\n${body}`, { mode: 0o755 });
    }
    for (const name of paths) {
      const retry = namedStep(browserJob(workflow), `Retry ${name}`);
      const script = retry.match(/^        run: \|\n((?:          .*\n?)+)/m)?.[1]
        .split("\n").map((line) => line.slice(10)).join("\n");
      assert.ok(script);
      for (const [installStatus, repairStatus] of [[0, 0], [23, 0], [0, 31]]) {
        writeFileSync(calls, "");
        const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
          cwd: dir,
          env: { PATH: `${dir}${delimiter}${process.env.PATH}`, BROWSER_BUDGET_CALLS: calls,
            BROWSER_BUDGET_PNPM_STATUS: String(installStatus), BROWSER_BUDGET_DPKG_STATUS: String(repairStatus) },
          encoding: "utf8",
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, repairStatus || installStatus, result.stderr);
        const log = readFileSync(calls, "utf8").trim().split("\n");
        assert.deepEqual(log.slice(0, 3), ["pkill -KILL -f playwright[^ ]* install",
          "sudo pkill -KILL -x apt-get|dpkg", "sudo dpkg --configure -a"]);
        assert.equal(log.length, repairStatus ? 3 : 4, "failed repair must not proceed to install");
        if (!repairStatus) {
          assert.equal(log[3], name === paths[0]
            ? "pnpm exec playwright install --with-deps chromium" : "pnpm exec playwright install-deps chromium");
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
