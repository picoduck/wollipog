import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { spawnSync, execFileSync } from "@wollipog/test-support/bounded-child-process";
import { computePrRoute, prRoute } from "./ci-pr-routing.mjs";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const job = (id) => workflow.match(new RegExp(`^  ${id}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"))?.[0];
const expression = (text, key) => text.match(new RegExp(`^\\s+${key}: (.+)$`, "m"))?.[1];
const shellOf = (text, name) => text.split(`      - name: ${name}\n`)[1].match(/        run: \|\n((?:          .*\n?)+)/)[1]
  .split("\n").map((line) => line.slice(10)).join("\n");
function evaluate(value, event, variable, mode = "", cancelled = false, draft = false, action = "synchronize") {
  const context = { github: { event_name: event, event: { action, pull_request: { draft } } },
    vars: { CI_PR_SUITE_ROUTING: variable }, needs: { suite_plan: { outputs: { mode } } },
    cancelled: () => cancelled, fromJSON: JSON.parse };
  return vm.runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), context, { timeout: 1000 });
}
const fast = expression(job("checks"), "PR_FAST");
const matrix = expression(job("browser"), "shard");
const enabled = expression(job("check"), "ROUTING_ENABLED");
const admission = expression(job("suite_plan"), "if");
const states = ["success", "failure", "cancelled", "skipped", "", "unexpected"];
const variables = ["", "false", "disabled", "Enabled", "true", "enabled ", "enabled"];

test("off and malformed switches preserve the full work set; non-PR events ignore every switch", () => {
  for (const event of ["pull_request", "merge_group", "push", "workflow_dispatch", "workflow_call"]) {
    for (const variable of variables) for (const mode of ["", "full", "fast", "unknown"]) {
      const active = event === "pull_request" && variable === "enabled";
      assert.equal(evaluate(admission, event, variable, mode), active);
      assert.equal(evaluate(enabled, event, variable, mode), String(active));
      assert.equal(evaluate(fast, event, variable, mode), String(active && mode === "fast"));
      assert.deepEqual(Array.from(evaluate(matrix, event, variable, mode)), active && mode === "fast" ? [1] : [1, 2, 3, 4, 5]);
      for (const id of ["checks", "browser", "win32", "webkit", "check"]) {
        const condition = expression(job(id), "if");
        assert.equal(evaluate(condition, event, variable, mode), true, `${event}/${variable}/${id}`);
        assert.equal(evaluate(condition, event, variable, mode, false, true), event !== "pull_request");
        assert.equal(evaluate(condition, event, variable, mode, false, true, "ready_for_review"), true);
      }
    }
  }
  assert.equal(expression(job("browser"), "PR_FAST"), fast);
  assert.ok(admission.startsWith("github.event_name == 'pull_request' && vars.CI_PR_SUITE_ROUTING == 'enabled'"));
  assert.ok(enabled.includes("github.event_name == 'pull_request' && vars.CI_PR_SUITE_ROUTING == 'enabled'"));
});

test("the actual aggregate requires an active plan's success and unambiguous output", () => {
  const shell = shellOf(job("check"), "Require Every Job to Have Succeeded");
  for (const active of [false, true]) for (const plan of states) for (const mode of ["", "full", "fast", "affected", "unknown"]) {
    const run = spawnSync("bash", ["-c", shell], { encoding: "utf8", timeout: 1000, env: {
      ROUTING_ENABLED: String(active), PLAN_RESULT: plan, PLAN_MODE: mode,
      CHECKS_RESULT: "success", BROWSER_RESULT: "success", WIN32_RESULT: "success", WEBKIT_RESULT: "success",
    } });
    assert.ifError(run.error);
    const pass = active ? plan === "success" && ["full", "fast"].includes(mode) : plan === "skipped" && mode === "";
    assert.equal(run.status, pass ? 0 : 1, `${active}/${plan}/${mode}`);
  }
  for (const mode of ["full", "fast"]) for (const key of ["CHECKS_RESULT", "BROWSER_RESULT", "WIN32_RESULT", "WEBKIT_RESULT"]) {
    for (const result of states.filter((state) => state !== "success")) {
      const run = spawnSync("bash", ["-c", shell], { encoding: "utf8", timeout: 1000, env: {
        ROUTING_ENABLED: "true", PLAN_RESULT: "success", PLAN_MODE: mode,
        CHECKS_RESULT: "success", BROWSER_RESULT: "success", WIN32_RESULT: "success", WEBKIT_RESULT: "success", [key]: result,
      } });
      assert.ifError(run.error);
      assert.equal(run.status, 1, `${mode}/${key}/${result}`);
    }
  }
});

test("both actual execution branches preserve commands, propagate errors and never accept author arguments", () => {
  const stub = 'pnpm() { printf "pnpm %s\\n" "$*"; return "$STUB_EXIT"; }; node() { printf "node %s\\n" "$*"; return "$STUB_EXIT"; };\n';
  for (const isFast of [false, true]) for (const exit of [0, 7]) for (const [id, name] of [
    ["checks", "Unit Tests"], ["browser", "Remote-Instance Browser End-to-End Tests"],
  ]) {
    const shell = shellOf(job(id), name).replaceAll("${{ matrix.shard }}", "1");
    const run = spawnSync("bash", ["-e", "-c", stub + shell], { encoding: "utf8", timeout: 1000,
      env: { PR_FAST: String(isFast), STUB_EXIT: String(exit) } });
    assert.ifError(run.error);
    assert.equal(run.status, exit);
    if (id === "checks") assert.equal(run.stdout.trim(), isFast
      ? "node scripts/test-suites.mjs --node-only --groups node-fast --ci" : "pnpm test:ci");
    else assert.equal(run.stdout.trim(), isFast
      ? "pnpm test:e2e authentication-recovery.spec.ts new-session-choices.spec.ts request-surfaces.spec.ts issue-closure.spec.ts conversation-handoff.spec.ts"
      : "pnpm test:e2e --config playwright.ci.config.ts --project=shard-1");
  }
  for (const name of ["Verify Node 22 Engine Boundary", "Verify Excluded Node Engine Boundary", "Verify Node 23 Engine Boundary",
    "Verify Recommended Node Engine Boundary", "Verify Delegated Linux Provider Containment", "Typecheck",
    "Validate Runner Bundle", "Validate Control-Plane Bundle"]) {
    const step = job("checks").split(`      - name: ${name}\n`)[1]?.split("      - name:")[0];
    assert.ok(step, name);
    assert.doesNotMatch(step, /\n        if:|PR_FAST|continue-on-error:/, name);
  }
  assert.match(job("browser"), /name: Rendered Production Browser Smoke\n        if: matrix.shard == 1\n        run: pnpm test:e2e:production/);
  assert.match(job("webkit"), /name: WebKit Browser End-to-End Tests\n        run: pnpm test:e2e:webkit/);
  assert.doesNotMatch(job("suite_plan"), /continue-on-error|pnpm install|pull_request_target/);
  assert.match(job("suite_plan"), /ref: \$\{\{ github.event.pull_request.base.sha \}\}[\s\S]*persist-credentials: false/);
});

test("routing accepts only an exact trusted fast snapshot and conservatively keeps affected full", async () => {
  const base = "a".repeat(40), tested = "b".repeat(40), changeHead = "c".repeat(40);
  const input = { event: "pull_request", base, tested, changeHead, workflowMatches: true, selection: {
    context: { event: "pull_request", baseSha: base, testedSha: tested, changeHeadSha: changeHead, trustedPolicySha: base },
    mode: "fast", reasons: [], risks: [],
  } };
  assert.equal(prRoute(input).mode, "fast");
  for (const mode of ["affected", "full", "unknown"]) assert.equal(prRoute({ ...input, selection: { ...input.selection, mode } }).mode, "full");
  for (const field of ["baseSha", "testedSha", "changeHeadSha", "trustedPolicySha", "event"]) {
    assert.equal(prRoute({ ...input, selection: { ...input.selection, context: { ...input.selection.context, [field]: "wrong" } } }).mode, "full");
  }
  assert.equal(prRoute({ ...input, workflowMatches: false }).mode, "full");
  assert.equal(prRoute({ ...input, selection: null }).mode, "full");
  assert.equal(prRoute({ ...input, selection: { ...input.selection, reasons: ["incomplete-diff"] } }).mode, "full");
  for (const event of ["merge_group", "push", "workflow_dispatch", "workflow_call"]) {
    assert.equal(prRoute({ ...input, event }).mode, "full");
    assert.equal((await computePrRoute({ env: { GITHUB_EVENT_NAME: event }, cwd: "/unavailable" })).mode, "full");
  }
  assert.equal((await computePrRoute({ env: { GITHUB_EVENT_NAME: "pull_request", BASE_SHA: "invalid" } })).mode, "full");
});

test("Git-object routing uses trusted policy and rejects hostile workflow/policy, deletion and missing-base inputs", async (t) => {
  const { FAST_API_FILES, CRITICAL_BROWSER_FILES, FAST_PROSE_FILES } = await import("./ci-suite-policy.mjs");
  const { fastFiles } = JSON.parse(readFileSync("docs/ci-node-profile-2026-10-23.json", "utf8"));
  const cwd = mkdtempSync(join(tmpdir(), "ci-pr-route-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (path, text) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text); };
  git("init", "-q"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  for (const file of [...fastFiles, ...FAST_API_FILES, ...CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`),
    FAST_PROSE_FILES[0], ".github/workflows/ci.yml", "scripts/ci-suite-policy.mjs", "apps/web/src/ordinary.ts"]) put(file, "fixture\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const route = async (edit, expected, override = {}) => {
    git("checkout", "--detach", base);
    edit(); git("add", "-A"); git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    git("checkout", "--detach", base);
    const result = await computePrRoute({ cwd, env: { GITHUB_EVENT_NAME: "pull_request", BASE_SHA: base,
      TESTED_SHA: head, CHANGE_HEAD_SHA: head, ...override } });
    assert.equal(result.mode, expected);
  };
  await route(() => put(FAST_PROSE_FILES[0], "reviewed prose\n"), "fast");
  await route(() => put("apps/web/src/ordinary.ts", "ordinary source\n"), "full");
  await route(() => { put(FAST_PROSE_FILES[0], "prose\n"); put(".github/workflows/ci.yml", "hostile workflow\n"); }, "full");
  await route(() => put("scripts/ci-suite-policy.mjs", 'throw new Error("head policy must never execute");\n'), "full");
  await route(() => rmSync(join(cwd, FAST_API_FILES[0])), "full");
  await route(() => put(FAST_PROSE_FILES[0], "prose\n"), "full", { BASE_SHA: "f".repeat(40) });
});
