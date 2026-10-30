import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  baselineVersions, combinedExit, decide, detect, EXIT, fingerprint, forced, HARNESSES, harnessById, judgeSuite, markdown, measure,
  newestRelease, paths, recordKey, RECORD_VERSION, sourceFiles, suiteEnv, targetsFor, validRecord,
} from "./harness-assumptions.mjs";
import { CODEX_GUARD_TRUST_VERSION_RANGE } from "../apps/runner/src/codex-managed-worktree-guard.ts";

const workflow = readFileSync(new URL("../.github/workflows/harness-assumptions.yml", import.meta.url), "utf8");
const codex = harnessById("codex");

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "harness-assumptions-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function ciEnv(temp, extra = {}) {
  return { RUNNER_TEMP: temp, PATH: process.env.PATH, GITHUB_OUTPUT: join(temp, "output"), GITHUB_STEP_SUMMARY: join(temp, "summary.md"),
    GITHUB_EVENT_NAME: "schedule", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "picoduck/wollipog", GITHUB_RUN_ID: "1", ...extra };
}
function outputs(temp) {
  if (!existsSync(join(temp, "output"))) return {};
  return Object.fromEntries(readFileSync(join(temp, "output"), "utf8").trim().split("\n").map(l => l.split("=")));
}
function registry(version, { ok = true, status = 200, name = "@openai/codex" } = {}) {
  return async () => ({ ok, status, json: async () => ({ name, version }) });
}
const silent = async () => { throw new Error("offline"); };

test("the workflow matrix lists exactly the registered harnesses", () => {
  const matrix = workflow.match(/^ {8}harness: \[([^\]]*)\]$/m)?.[1].split(",").map(s => s.trim());
  assert.deepEqual(matrix, HARNESSES.map(h => h.id));
  assert.equal(new Set(HARNESSES.map(h => h.id)).size, HARNESSES.length);
  for (const harness of HARNESSES) {
    assert.match(harness.id, /^[a-z][a-z0-9-]*$/);
    for (const field of ["name", "npmPackage", "bin", "binaryEnv", "reportDirArg", "documentation"]) assert.equal(typeof harness[field], "string", `${harness.id}.${field}`);
    assert.ok(Array.isArray(harness.suite) && harness.suite.length > 0);
    assert.ok(harness.timeoutMinutes > 0 && harness.timeoutMinutes * 2 + 30 <= 340, "two targets must fit inside the job timeout");
    assert.ok(existsSync(new URL(`../${harness.documentation}`, import.meta.url)));
    assert.ok(sourceFiles(harness).length > 1);
  }
});

test("the workflow is scheduled outside 00:00-02:00 UTC, single-flight, read-only and secret-free", () => {
  const crons = [...workflow.matchAll(/cron: "([^"]+)"/g)].map(m => m[1]);
  assert.equal(crons.length, 1);
  for (const cron of crons) {
    const hours = cron.split(" ")[1];
    assert.match(hours, /^\d+$/, "a single fixed hour keeps the window check exact");
    assert.ok(Number(hours) >= 2 && Number(hours) <= 23, `${cron} must avoid 00:00-02:00 UTC`);
  }
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.match(workflow, /^permissions:\n {2}contents: read\n\n/m);
  assert.equal(workflow.match(/permissions:/g).length, 1, "no job widens the permissions");
  assert.match(workflow, /^concurrency:\n {2}group: harness-assumption-probes\n {2}cancel-in-progress: false$/m);
  assert.doesNotMatch(workflow, /secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  for (const use of workflow.match(/uses: \S+/g)) assert.match(use, /@[0-9a-f]{40}$/, `${use} must be pinned`);
  // Dispatch input only reaches the driver through the environment, never interpolated into a script.
  assert.match(workflow, /DISPATCH_HARNESS: \$\{\{ inputs\.harness \}\}/);
  assert.doesNotMatch(workflow, /run: .*inputs\./);
});

test("the workflow publishes every outcome and records only a matched measurement", () => {
  const step = name => workflow.split(/\n(?= {6}- )/).find(s => s.includes(name));
  assert.match(step("Upload Report"), /if: always\(\)/);
  assert.match(step("Upload Report"), /if-no-files-found: error/);
  assert.match(step("Save Measurement Record"), /if: steps\.measure\.outcome == 'success' && steps\.measure\.outputs\.exit == '0'/);
  assert.doesNotMatch(step("Restore Measurement Record"), /restore-keys/, "only the exact key may count as measured");
  assert.doesNotMatch(workflow, /continue-on-error/);
  for (const name of ["Setup pnpm", "Install Dependencies", "Measure Assumptions"]) assert.match(step(name), /if: steps\.decide\.outputs\.measure == 'true'/);
  assert.ok(workflow.indexOf("Detect Releases") < workflow.indexOf("Install Dependencies"), "detection needs no dependency install");
});

test("no harness ever runs a probe that needs real credentials or a real model", () => {
  const text = JSON.stringify(HARNESSES.map(h => ({ ...h, baselines: [] }))) + workflow + readFileSync(new URL("./harness-assumptions-prepare-codex.sh", import.meta.url), "utf8");
  assert.doesNotMatch(text, /inference-transport|ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CONFIG_DIR|\.codex\b|\.claude\b/);
  const env = suiteEnv(codex, "/opt/codex", "/tmp/home", { PATH: "/bin", GITHUB_TOKEN: "x", ACTIONS_RUNTIME_TOKEN: "x", OPENAI_API_KEY: "x", CODEX_ASSUMPTION_ACKNOWLEDGED_UNAVAILABLE: "escalation", HOME: "/home/runner", RUNNER_TEMP: "/r" });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "CODEX_BIN", "HOME", "LANG", "PATH", "TMPDIR"]);
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.CODEX_BIN, "/opt/codex");
});

test("the Codex lower bound is read from CODEX_GUARD_TRUST_VERSION_RANGE and measured with the newest release", () => {
  const [lower] = baselineVersions(codex);
  assert.equal(lower.version, CODEX_GUARD_TRUST_VERSION_RANGE.match(/^>=(\S+) /)[1]);
  assert.deepEqual(targetsFor("0.166.0", [lower]).map(t => t.version), ["0.166.0", lower.version]);
  assert.deepEqual(targetsFor(lower.version, [lower]), [{ label: `newest release; ${lower.label}`, version: lower.version }]);
});

test("a baseline that cannot be read throws instead of silently measuring less", (t) => {
  const root = scratch(t);
  mkdirSync(join(root, "apps/runner/src"), { recursive: true });
  writeFileSync(join(root, "apps/runner/src/codex-managed-worktree-guard.ts"), 'export const CODEX_GUARD_TRUST_VERSION_RANGE = "*";\n');
  assert.throws(() => baselineVersions(codex, root), /Could not read/);
});

test("release detection accepts only a stable version of the expected package", async () => {
  assert.equal(await newestRelease(codex, { fetchImpl: registry("0.166.0") }), "0.166.0");
  for (const fetchImpl of [registry("0.167.0-alpha.1"), registry("latest"), registry("0.166.0", { name: "@evil/codex" }), registry("0.166.0", { ok: false, status: 503 }), silent]) {
    await assert.rejects(newestRelease(codex, { fetchImpl, attempts: 2, delayMs: 1 }), /Could not read the newest @openai\/codex release/);
  }
});

test("detection that cannot reach npm is could not run with a published report, never no new release", async (t) => {
  const temp = scratch(t);
  const env = ciEnv(temp);
  assert.equal(await detect(codex, { env, fetchImpl: silent, delayMs: 1 }), EXIT.couldNotRun);
  const report = JSON.parse(readFileSync(join(paths(codex, temp).reportDir, "latest.json"), "utf8"));
  assert.equal(report.exitCode, EXIT.couldNotRun);
  assert.equal(report.measured, false);
  assert.match(report.reason, /Release detection could not run/);
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /could not run/);
  assert.equal(outputs(temp).key, undefined, "no cache key means nothing can be restored as measured");
  assert.ok(!existsSync(paths(codex, temp).statePath));
});

test("the record key changes with each target version and with the probe set", () => {
  const targets = [{ version: "0.166.0" }, { version: "0.155.1" }];
  const key = recordKey(codex, targets, "a");
  assert.match(key, new RegExp(`^harness-assumptions-v${RECORD_VERSION}-codex-0\\.166\\.0_0\\.155\\.1-[0-9a-f]{24}$`));
  assert.notEqual(recordKey(codex, [{ version: "0.167.0" }, targets[1]], "a"), key);
  assert.notEqual(recordKey(codex, [targets[0], { version: "0.156.0" }], "a"), key);
  assert.notEqual(recordKey(codex, targets, "b"), key);
  assert.match(fingerprint(codex), /^[0-9a-f]{64}$/);
  assert.ok(sourceFiles(codex).includes("scripts/harness-assumptions.mjs"));
  assert.ok(sourceFiles(codex).includes("apps/runner/scripts/codex-escalation-probe.ts"));
});

test("a dispatch forces only the requested harness and rejects an unknown one", () => {
  assert.equal(forced(codex, "schedule", "codex"), false);
  assert.equal(forced(codex, "workflow_dispatch", "all"), true);
  assert.equal(forced(codex, "workflow_dispatch", ""), true);
  assert.equal(forced(codex, "workflow_dispatch", "codex"), true);
  assert.throws(() => forced(codex, "workflow_dispatch", "codx"), /Unknown harness/);
});

async function detected(t, extra = {}) {
  const temp = scratch(t);
  const env = ciEnv(temp, extra);
  assert.equal(await detect(codex, { env, fetchImpl: registry("0.166.0") }), EXIT.matched);
  return { temp, env, state: JSON.parse(readFileSync(paths(codex, temp).statePath, "utf8")) };
}
function writeRecord(temp, record) {
  const dir = paths(codex, temp).recordDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "record.json"), typeof record === "string" ? record : JSON.stringify(record));
}
function matchedRecord(state) {
  return { recordVersion: RECORD_VERSION, harness: "codex", key: state.key, sourceHash: state.sourceHash, targets: state.targets, exitCode: 0, completedAt: "2026-10-29T09:00:00.000Z", runUrl: "https://github.com/picoduck/wollipog/actions/runs/0" };
}

test("only an exact matched record skips the suite; a lost, unreadable or mismatched record measures", async (t) => {
  const { temp, env, state } = await detected(t);
  assert.equal(outputs(temp).key, state.key);
  assert.equal(decide(codex, { env }), EXIT.matched);
  assert.equal(outputs(temp).measure, "true", "no record measures");
  for (const bad of ["{not json", { ...matchedRecord(state), exitCode: 1 }, { ...matchedRecord(state), key: "other" }, { ...matchedRecord(state), sourceHash: "other" },
    { ...matchedRecord(state), targets: [state.targets[0]] }, { ...matchedRecord(state), recordVersion: RECORD_VERSION + 1 }, { ...matchedRecord(state), completedAt: "never" }]) {
    writeRecord(temp, bad);
    rmSync(join(temp, "output"));
    assert.equal(decide(codex, { env }), EXIT.matched);
    assert.equal(outputs(temp).measure, "true", `record ${JSON.stringify(bad)} must measure`);
    assert.ok(!validRecord(typeof bad === "string" ? null : bad, state));
  }
  writeRecord(temp, matchedRecord(state));
  rmSync(join(temp, "output"));
  assert.equal(decide(codex, { env }), EXIT.matched);
  assert.equal(outputs(temp).measure, "false");
  const report = JSON.parse(readFileSync(join(paths(codex, temp).reportDir, "latest.json"), "utf8"));
  assert.equal(report.measured, false, "a skip is reported as not measured, never as a fresh pass");
  assert.match(readFileSync(join(paths(codex, temp).reportDir, "latest.md"), "utf8"), /no new release[\s\S]*no suite ran today[\s\S]*Last matched measurement: 2026-10-29/);
});

test("a dispatch measures even with a matched record; an unknown dispatch harness is could not run", async (t) => {
  const { temp, env, state } = await detected(t, { GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_HARNESS: "codex" });
  writeRecord(temp, matchedRecord(state));
  assert.equal(decide(codex, { env }), EXIT.matched);
  assert.equal(outputs(temp).measure, "true");
  rmSync(join(temp, "output"));
  assert.equal(decide(codex, { env: { ...env, DISPATCH_HARNESS: "codx" } }), EXIT.couldNotRun);
  assert.equal(outputs(temp).measure, undefined);
});

test("decide without detection state is could not run", (t) => {
  const temp = scratch(t);
  assert.equal(decide(codex, { env: ciEnv(temp) }), EXIT.couldNotRun);
  assert.equal(outputs(temp).measure, undefined);
});

const target = { label: "newest release", version: "0.166.0" };
function suiteReport(statuses, extra = {}) {
  const results = statuses.map((status, i) => ({ probe: `p${i}`, status }));
  const exitCode = statuses.includes("changed") ? 1 : statuses.includes("could not run") ? 2 : 0;
  return { version: "0.166.0", complete: true, exitCode, results, ...extra };
}

test("suite judgement never turns a missing, partial or inconsistent report into a pass", () => {
  assert.equal(judgeSuite(target, { code: 0 }, suiteReport(["unchanged", "optional drift"])).status, "matched");
  assert.equal(judgeSuite(target, { code: 1 }, suiteReport(["changed", "could not run"])).status, "changed");
  assert.equal(judgeSuite(target, { code: 2 }, suiteReport(["unchanged", "could not run"])).status, "could not run");
  const falsePasses = {
    "no report": [{ code: 0 }, null],
    "incomplete report": [{ code: 0 }, suiteReport(["unchanged"], { complete: false })],
    "other version": [{ code: 0 }, suiteReport(["unchanged"], { version: "0.165.0" })],
    "missing version": [{ code: 0 }, suiteReport(["unchanged"], { version: null })],
    "no results": [{ code: 0 }, suiteReport([])],
    "exit 0 with changed results": [{ code: 0 }, { ...suiteReport(["changed"]), exitCode: 0 }],
    "exit 0 with could-not-run results": [{ code: 0 }, { ...suiteReport(["could not run"]), exitCode: 0 }],
    "report exit disagrees": [{ code: 0 }, { ...suiteReport(["unchanged"]), exitCode: 2 }],
    "operator acknowledgement": [{ code: 0 }, suiteReport(["unchanged", "acknowledged unavailable"])],
    "unknown status": [{ code: 0 }, suiteReport(["fine"])],
    "timeout": [{ code: 0, timedOut: true, timeoutMinutes: 150 }, suiteReport(["unchanged"])],
    "spawn failure": [{ code: null, error: "ENOENT" }, null],
    "signal": [{ code: null, signal: "SIGKILL" }, suiteReport(["unchanged"])],
    "exit outside contract": [{ code: 3 }, suiteReport(["unchanged"])],
    "exit 1 without changes": [{ code: 1 }, { ...suiteReport(["unchanged"]), exitCode: 1 }],
  };
  for (const [name, [execution, report]] of Object.entries(falsePasses)) {
    const judged = judgeSuite(target, execution, report);
    assert.equal(judged.exitCode, EXIT.couldNotRun, name);
    assert.equal(judged.status, "could not run", name);
    assert.ok(judged.reason, name);
  }
});

test("combined exit: changed wins, any could not run or failed preparation fails, nothing measured is not a pass", () => {
  const t = code => ({ exitCode: code });
  assert.equal(combinedExit([t(0), t(0)]), 0);
  assert.equal(combinedExit([t(0), t(1), t(2)]), 1);
  assert.equal(combinedExit([t(0), t(2)]), 2);
  assert.equal(combinedExit([t(0), {}]), 2, "an unmeasured target is could not run");
  assert.equal(combinedExit([]), 2);
  assert.equal(combinedExit([t(0)], { status: "failed" }), 2);
  assert.equal(combinedExit([t(1)], { status: "failed" }), 1);
});

function fakeExec(temp, plan) {
  const calls = [];
  return { calls, exec: async (argv, options) => {
    calls.push({ argv, options });
    if (argv[0] === "bash") return { code: plan.prepare ?? 0, tail: plan.prepare ? "bwrap: setting up uid map: Permission denied\n" : "" };
    if (argv[0] === "npm") {
      const prefix = argv[argv.indexOf("--prefix") + 1];
      const version = argv.at(-1).split("@").at(-1);
      if (plan.install?.[version] === false) return { code: 1, tail: "" };
      mkdirSync(join(prefix, "node_modules/@openai/codex"), { recursive: true });
      mkdirSync(join(prefix, "node_modules/.bin"), { recursive: true });
      writeFileSync(join(prefix, "node_modules/@openai/codex/package.json"), JSON.stringify({ version: plan.installedVersion ?? version }));
      writeFileSync(join(prefix, "node_modules/.bin/codex"), "");
      return { code: 0, tail: "" };
    }
    const reportDir = argv.at(-1);
    const version = reportDir.split("/").at(-1);
    const outcome = plan.suite?.[version] ?? { code: 0, statuses: ["unchanged"] };
    if (outcome.statuses) {
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, "latest.json"), JSON.stringify({ ...suiteReport(outcome.statuses, { version }), ...outcome.report }));
      writeFileSync(join(reportDir, "latest.md"), `# Codex Assumption Report\n\nMeasured CLI: ${version}\n`);
    }
    assert.ok(existsSync(options.env.HOME), "the suite receives a throwaway HOME");
    plan.homes = [...(plan.homes ?? []), options.env.HOME];
    return { code: outcome.code, tail: "" };
  } };
}

async function measured(t, plan) {
  const { temp, env } = await detected(t);
  rmSync(join(temp, "output"));
  assert.equal(decide(codex, { env }), EXIT.matched);
  const fake = fakeExec(temp, plan);
  const exit = await measure(codex, { env, exec: fake.exec });
  const location = paths(codex, temp);
  return { exit, temp, fake, env, report: JSON.parse(readFileSync(join(location.reportDir, "latest.json"), "utf8")),
    md: readFileSync(join(location.reportDir, "latest.md"), "utf8"), recordPath: join(location.recordDir, "record.json") };
}

test("a fully matched measurement covers both targets, publishes the summary and writes the record", async (t) => {
  const plan = {};
  const { exit, temp, fake, env, report, md, recordPath } = await measured(t, plan);
  assert.equal(exit, EXIT.matched);
  assert.deepEqual(report.targets.map(t => [t.version, t.status]), [["0.166.0", "matched"], [baselineVersions(codex)[0].version, "matched"]]);
  assert.equal(report.preparation.status, "ok");
  assert.equal(outputs(temp).exit, "0");
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /# Codex Assumption Probes: matched/);
  assert.match(md, /## 0\.166\.0 Suite Report[\s\S]*### Codex Assumption Report/);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.ok(validRecord(record, JSON.parse(readFileSync(paths(codex, temp).statePath, "utf8"))));
  assert.ok(plan.homes.every(home => !existsSync(home)), "throwaway homes are removed");
  const suiteCalls = fake.calls.filter(c => c.argv[0] === "node");
  assert.deepEqual(suiteCalls[0].argv.slice(0, 4), ["node", "--import", "tsx", "scripts/codex-assumptions.mjs"]);
  assert.ok(fake.calls.filter(c => c.argv[0] === "npm").every(c => c.argv.includes("--ignore-scripts")));
});

test("changed, could-not-run, failed preparation and failed installs fail the run and never write a record", async (t) => {
  const lower = baselineVersions(codex)[0].version;
  const cases = [
    [{ suite: { "0.166.0": { code: 1, statuses: ["changed"] } } }, EXIT.changed],
    [{ suite: { [lower]: { code: 2, statuses: ["could not run"] } } }, EXIT.couldNotRun],
    [{ suite: { [lower]: { code: 0 } } }, EXIT.couldNotRun],
    [{ prepare: 1 }, EXIT.couldNotRun],
    [{ install: { "0.166.0": false } }, EXIT.couldNotRun],
    [{ installedVersion: "0.165.0" }, EXIT.couldNotRun],
    [{ suite: { "0.166.0": { code: 0, statuses: ["unchanged"], report: { version: "0.165.0" } } } }, EXIT.couldNotRun],
  ];
  for (const [plan, expected] of cases) {
    const { exit, report, recordPath, temp } = await measured(t, plan);
    assert.equal(exit, expected, JSON.stringify(plan));
    assert.equal(report.exitCode, expected);
    assert.equal(outputs(temp).exit, String(expected));
    assert.ok(!existsSync(recordPath), `${JSON.stringify(plan)} must not record a measurement`);
  }
  const { md, report } = await measured(t, { prepare: 1 });
  assert.match(md, /Preparation: \*\*failed\*\*\. Escalation probe needs bubblewrap user namespaces[\s\S]*exited 1[\s\S]*Permission denied/);
  assert.equal(report.preparation.status, "failed");
});

test("measure clears a previous record and report before running", async (t) => {
  const { temp, env, state } = await detected(t);
  writeRecord(temp, matchedRecord(state));
  rmSync(join(temp, "output"));
  mkdirSync(join(paths(codex, temp).reportDir), { recursive: true });
  writeFileSync(join(paths(codex, temp).reportDir, "stale.md"), "old green");
  writeFileSync(join(temp, "harness-assumption-state", "codex.json"), JSON.stringify({ ...state, why: "manual dispatch" }));
  const exit = await measure(codex, { env, exec: fakeExec(temp, { suite: { "0.166.0": { code: 2 } } }).exec });
  assert.equal(exit, EXIT.couldNotRun);
  assert.ok(!existsSync(join(paths(codex, temp).recordDir, "record.json")));
  assert.ok(!existsSync(join(paths(codex, temp).reportDir, "stale.md")));
});

test("markdown labels a skip as not measured and truncates oversized reports", () => {
  const skip = markdown({ name: "Codex", harness: "codex", npmPackage: "@openai/codex", exitCode: 0, measured: false, completedAt: "now", reason: "already measured" });
  assert.match(skip, /^# Codex Assumption Probes: no new release$/m);
  assert.match(skip, /\*\*Not measured:\*\* already measured/);
  const large = markdown({ name: "Codex", harness: "codex", npmPackage: "@openai/codex", exitCode: 1, measured: true, completedAt: "now", targets: [target] }, { "0.166.0": "x".repeat(1_000_000) });
  assert.ok(large.length < 1_000_000);
  assert.match(large, /Truncated/);
  assert.match(markdown({ name: "Codex", exitCode: 7, completedAt: "now" }), /: could not run$/m);
});

test("documentation states the shared contract and that a new harness adds its probe set", () => {
  const doc = readFileSync(new URL("../docs/harness-assumption-probes.md", import.meta.url), "utf8");
  for (const phrase of ["**Exit 0, matched**", "**Exit 1, changed**", "**Exit 2, could not run**", "`latest.json`", "`latest.md`", "job summary",
    "Supporting a new harness includes adding its probe set", "never treats an unreachable registry as \"no new release\""]) assert.ok(doc.includes(phrase), phrase);
  assert.match(readFileSync(new URL("../CONTRIBUTING.md", import.meta.url), "utf8"), /Supporting a new harness includes adding its probe set/);
  const codexDoc = readFileSync(new URL("../docs/codex-assumption-probes.md", import.meta.url), "utf8");
  assert.doesNotMatch(codexDoc, /must not run the real probe suite/);
  assert.match(codexDoc, /## Optional Local Timer/);
  assert.match(codexDoc, /## Hosted Measurement/);
});
