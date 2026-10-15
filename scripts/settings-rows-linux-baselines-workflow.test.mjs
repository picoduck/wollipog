import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

// The browser job regenerates and uploads the linux settings-rows baselines when a comparison
// fails (#3215), as settings-rows-win32.yml does for the win32 set.
const WORKFLOW = ".github/workflows/ci.yml";
const text = readFileSync(resolve(process.cwd(), WORKFLOW), "utf8");
const SNAPSHOTS = "apps/web/e2e/settings-rows.spec.ts-snapshots";
const REGENERATE = "Regenerate the Changed linux Settings-Rows Baselines";
const UPLOAD = "Upload the Regenerated linux Settings-Rows Baselines";
const SUMMARY = "Tell the Author How to Commit the linux Baselines";

/** The browser job's text, comments and blank lines dropped. */
function browserJob() {
  const start = text.indexOf("\n  browser:\n");
  const end = text.indexOf("\n  win32:\n", start);
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end)
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"))
    .join("\n");
}

/** A step's lines, from its `- name:` to the next step's. */
function step(name) {
  const found = browserJob().split(/^(?=      - )/m).find((candidate) => candidate.startsWith(`      - name: ${name}\n`));
  assert.ok(found, `${WORKFLOW}: missing step "${name}"`);
  return found;
}

function script(name) {
  const body = step(name).split(/^        run: \|\n/m)[1];
  assert.ok(body, `${name}: needs a run block`);
  return body.split("\n").map((line) => line.slice(10)).join("\n");
}

/** Evaluates a step's `if:` against the given step outcomes and outputs. */
function eligible(name, { cancelled = false, steps = {} } = {}) {
  const expression = step(name).match(/^        if: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.ok(expression, `${name}: needs an if`);
  const translated = expression
    .replace(/steps\.([a-z0-9_-]+)\.outputs\.([a-z0-9_-]+)/g, '(steps["$1"]?.outputs?.["$2"] ?? "")')
    .replace(/steps\.([a-z0-9_-]+)\.outcome/g, '(steps["$1"]?.outcome ?? "")');
  return vm.runInNewContext(translated, { steps, cancelled: () => cancelled }, { timeout: 1_000 });
}

test("the linux baseline steps run only after the suite failed, and none of them can fail the shard", () => {
  const job = browserJob();
  const order = ["Upload Sanitized Synthetic Browser Failure Artifacts", REGENERATE, UPLOAD, SUMMARY,
    "Validate Web Production Build"].map((name) => job.indexOf(`      - name: ${name}\n`));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order,
    "regeneration empties test-results, so it must follow the sanitized upload that reads them");

  for (const name of [REGENERATE, UPLOAD, SUMMARY]) {
    const body = step(name);
    assert.match(body, /^        continue-on-error: true$/m, `${name}: a failure here must not mask or replace the suite's`);
    assert.match(body, /^        timeout-minutes: \d+$/m, `${name}: needs its own deadline inside the job budget`);
    assert.equal(eligible(name, { steps: { "browser-tests": { outcome: "success" } } }), false, `${name}: skipped on success`);
    assert.equal(eligible(name, { cancelled: true, steps: { "browser-tests": { outcome: "failure" } } }), false);
  }
  assert.equal(eligible(REGENERATE, { steps: { "browser-tests": { outcome: "failure" } } }), true);
  assert.doesNotMatch(step("Remote-Instance Browser End-to-End Tests"), /continue-on-error|if:/,
    "the suite step itself decides the shard's result");
});

test("only regenerated linux images are uploaded, at their repository paths, for a bounded time", () => {
  const upload = step(UPLOAD);
  assert.match(upload, /^        uses: actions\/upload-artifact@[0-9a-f]{40} # v\S+$/m);
  assert.match(upload, /^          name: settings-rows-linux-baselines$/m);
  assert.match(upload, /^          path: \$\{\{ steps\.linux-baselines\.outputs\.staging \}\}$/m);
  assert.match(upload, /^          overwrite: true$/m, "a re-run job is the same run, so its upload must replace the earlier one");
  assert.match(upload, /^          if-no-files-found: error$/m);
  assert.match(upload, /^          include-hidden-files: false$/m);
  assert.match(upload, /^          retention-days: 14$/m);

  const failed = { outcome: "failure" };
  assert.equal(eligible(UPLOAD, { steps: { "browser-tests": failed, "linux-baselines": { outputs: { count: "2" } } } }), true);
  for (const count of ["", "0"]) {
    assert.equal(eligible(UPLOAD, { steps: { "browser-tests": failed, "linux-baselines": { outputs: { count } } } }), false);
  }

  const summary = (outcome, state) => eligible(SUMMARY, {
    steps: { "browser-tests": failed, "linux-baselines": { outcome, outputs: { state } } },
  });
  assert.equal(summary("skipped", ""), false);
  assert.equal(summary("success", "unaffected"), false, "a shard without the spec says nothing about it");
  assert.equal(summary("success", "regenerated"), true);
  assert.equal(summary("failure", ""), true, "a regeneration that timed out still says so");
});

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function write(root, file, content) {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function files(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

/** A Playwright JSON report whose given spec files hold one test each with the given status. */
function report(entries) {
  return JSON.stringify({
    suites: entries.map(([file, status]) => ({
      title: file,
      file,
      specs: [],
      suites: [{ title: "describe", file, specs: [{ title: "t", file, tests: [{ status }] }] }],
    })),
  });
}

/**
 * Runs the regeneration step in a checkout with committed linux and win32 baselines. The `pnpm`
 * stub stands in for Playwright's `--update-snapshots=changed`: it rewrites a linux baseline, adds
 * a new one, and also touches a win32 image, a source file and a stray image outside the spec's
 * snapshots, none of which may reach the artifact.
 */
function regenerate(t, { reportText, pnpmStatus = 0 }) {
  const root = mkdtempSync(join(tmpdir(), "settings-rows-linux-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const temp = join(root, "temp");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(temp);
  mkdirSync(bin);
  git(repo, "init", "-q", "-b", "main");
  for (const name of ["chevron-dark", "settings-rows-light", "switch-on-dark"]) {
    write(repo, `${SNAPSHOTS}/${name}-linux.png`, `${name} linux`);
    write(repo, `${SNAPSHOTS}/${name}-win32.png`, `${name} win32`);
  }
  write(repo, "apps/web/src/SettingsRows.tsx", "source");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");

  const calls = join(root, "calls.txt");
  writeFileSync(join(bin, "pnpm"), [
    "#!/bin/bash",
    'printf "%s\\n" "$*" >> "$STUB_CALLS"',
    `printf changed > '${SNAPSHOTS}/chevron-dark-linux.png'`,
    `printf new > '${SNAPSHOTS}/colour-schemes-dark-linux.png'`,
    `printf changed > '${SNAPSHOTS}/chevron-dark-win32.png'`,
    "printf changed > apps/web/src/SettingsRows.tsx",
    "mkdir -p apps/web/e2e/other.spec.ts-snapshots && printf new > apps/web/e2e/other.spec.ts-snapshots/x-linux.png",
    `exit ${pnpmStatus}`,
    "",
  ].join("\n"), { mode: 0o755 });

  const reportPath = join(temp, "report.json");
  if (reportText !== undefined) writeFileSync(reportPath, reportText);
  const output = join(temp, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script(REGENERATE)], {
    cwd: repo,
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: temp,
      REPORT: reportPath,
      STUB_CALLS: calls,
    },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  return {
    outputs,
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    staged: files(join(temp, "settings-rows-linux-baselines")),
    staging: join(temp, "settings-rows-linux-baselines"),
  };
}

const EXPECTED = [`${SNAPSHOTS}/chevron-dark-linux.png`, `${SNAPSHOTS}/colour-schemes-dark-linux.png`];

for (const status of ["unexpected", "flaky"]) {
  test(`a settings-rows test reported ${status} regenerates exactly the changed linux baselines`, (t) => {
    const run = regenerate(t, { reportText: report([["other.spec.ts", "expected"], ["settings-rows.spec.ts", status]]) });
    assert.deepEqual(run.calls, ["exec playwright test settings-rows --update-snapshots=changed"]);
    assert.deepEqual(run.staged, EXPECTED, "only settings-rows linux renders, laid out at their repository paths");
    assert.equal(readFileSync(join(run.staging, EXPECTED[0]), "utf8"), "changed");
    assert.equal(run.outputs.state, "regenerated");
    assert.equal(run.outputs.count, "2");
    assert.equal(run.outputs.staging, run.staging);
    assert.deepEqual(readFileSync(run.outputs.list, "utf8").trim().split("\n"), EXPECTED);
  });
}

test("a shard whose settings-rows tests passed does not regenerate", (t) => {
  const run = regenerate(t, { reportText: report([["other.spec.ts", "unexpected"], ["settings-rows.spec.ts", "expected"]]) });
  assert.deepEqual(run.calls, []);
  assert.deepEqual(run.staged, []);
  assert.deepEqual(run.outputs, { state: "unaffected" });
});

test("a missing or unreadable report regenerates rather than skips", (t) => {
  for (const reportText of [undefined, "{ not json"]) {
    const run = regenerate(t, { reportText });
    assert.equal(run.calls.length, 1);
    assert.deepEqual(run.staged, EXPECTED);
  }
});

test("a regeneration run that itself fails still collects what it wrote", (t) => {
  const run = regenerate(t, { reportText: report([["settings-rows.spec.ts", "unexpected"]]), pnpmStatus: 1 });
  assert.deepEqual(run.staged, EXPECTED);
  assert.equal(run.outputs.count, "2");
});

/** Runs the summary step and returns what it printed and appended to the job summary. */
function summarise(t, env) {
  const root = mkdtempSync(join(tmpdir(), "settings-rows-linux-summary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const summary = join(root, "summary.md");
  writeFileSync(summary, "");
  const list = join(root, "list.txt");
  writeFileSync(list, EXPECTED.join("\n") + "\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script(SUMMARY)], {
    env: {
      PATH: process.env.PATH,
      GITHUB_STEP_SUMMARY: summary,
      REPOSITORY: "owner/repo",
      RUN_ID: "123",
      LIST: list,
      COUNT: "2",
      REGENERATE: "success",
      UPLOAD: "success",
      ...env,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, summary: readFileSync(summary, "utf8") };
}

test("the job summary gives the download command only when the images were uploaded", (t) => {
  const stale = summarise(t, {});
  assert.match(stale.summary, /^## The linux Settings-Rows Baselines Are Stale$/m);
  assert.match(stale.summary,
    /^gh run download 123 --repo owner\/repo --name settings-rows-linux-baselines --dir \.$/m);
  assert.match(stale.summary, /^git add apps\/web\/e2e\/settings-rows\.spec\.ts-snapshots$/m);
  for (const file of EXPECTED) assert.ok(stale.summary.includes(`- \`${file}\``));
  assert.match(stale.stdout, /^::error title=Stale linux Baselines::2 linux settings-rows baselines differ/m);

  for (const [env, heading] of [
    [{ UPLOAD: "failure" }, "The Regenerated linux Settings-Rows Baselines Were Not Uploaded"],
    [{ COUNT: "0", LIST: "/nonexistent", UPLOAD: "" }, "The linux Settings-Rows Comparison Failed Without a Baseline Difference"],
    [{ REGENERATE: "failure", COUNT: "", LIST: "", UPLOAD: "" }, "The linux Settings-Rows Baselines Could Not Be Regenerated"],
  ]) {
    const result = summarise(t, env);
    assert.match(result.summary, new RegExp(`^## ${heading}$`, "m"));
    assert.doesNotMatch(result.summary, /gh run download/);
    assert.doesNotMatch(result.stdout, /::error/);
  }
});
