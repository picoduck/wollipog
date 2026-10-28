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
function evaluate(value, event, variable, mode = "", cancelled = false, draft = false, action = "synchronize", gate = "", gateMode = "") {
  const context = { github: { event_name: event, event: { action, pull_request: { draft } } },
    vars: { CI_PR_SUITE_ROUTING: variable, CI_MERGE_GROUP_GATE: gate },
    needs: { suite_plan: { outputs: { mode } }, merge_group_gate: { outputs: { mode: gateMode } } },
    cancelled: () => cancelled, fromJSON: JSON.parse,
    ghaEqual: (a, b) => typeof a === "string" && typeof b === "string" ? a.toUpperCase() === b.toUpperCase() : a == b };
  // GitHub's documented ==/!= ignore string case. JS's native equality concealed a real
  // activation-contract bug. This fixture models only the workflow's actual operands.
  value = value.replace(/([A-Za-z_][\w.]*)\s*(==|!=)\s*('[^']*')/g,
    (_, left, op, right) => `${op === "!=" ? "!" : ""}ghaEqual(${left}, ${right})`);
  return vm.runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), context, { timeout: 1000 });
}
const fast = expression(job("checks"), "PR_FAST");
const groupFast = expression(job("checks"), "GROUP_FAST");
const gateEnabled = expression(job("check"), "GATE_ENABLED");
const gateAdmission = expression(job("merge_group_gate"), "if");
const matrix = expression(job("browser"), "shard");
const enabled = expression(job("check"), "ROUTING_ENABLED");
const admission = expression(job("suite_plan"), "if");
const states = ["success", "failure", "cancelled", "skipped", "", "unexpected"];
const variables = ["", "false", "disabled", "Enabled", "ENABLED", "true", "enabled ", "enabled"];

test("off switches preserve full work; case-variant plan admission cannot change non-PR coverage", () => {
  assert.equal(evaluate("${{ vars.CI_PR_SUITE_ROUTING == 'enabled' }}", "pull_request", "Enabled"), true,
    "the expression model must reproduce GitHub's case-insensitive equality");
  for (const event of ["pull_request", "merge_group", "push", "workflow_dispatch", "workflow_call"]) {
    for (const variable of variables) for (const mode of ["", "full", "fast", "unknown"]) {
      const active = event === "pull_request" && variable.toLowerCase() === "enabled";
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
  assert.equal(expression(job("browser"), "GROUP_FAST"), groupFast);
  assert.ok(admission.startsWith("github.event_name == 'pull_request' && vars.CI_PR_SUITE_ROUTING == 'enabled'"));
  assert.ok(enabled.includes("github.event_name == 'pull_request' && vars.CI_PR_SUITE_ROUTING == 'enabled'"));
});

test("every gate and routing variable, mode and event keeps full coverage unless exactly one admitted fast path applies", () => {
  for (const event of ["pull_request", "merge_group", "push", "workflow_dispatch", "workflow_call"]) {
    for (const gate of variables) for (const gateMode of ["", "full", "fast", "unknown"]) {
      for (const variable of ["", "Enabled", "enabled"]) for (const mode of ["", "full", "fast"]) {
        const prActive = event === "pull_request" && variable.toLowerCase() === "enabled";
        const gateActive = event === "merge_group" && gate.toLowerCase() === "enabled";
        const args = [event, variable, mode, false, false, "synchronize", gate, gateMode];
        assert.equal(evaluate(gateAdmission, ...args), gateActive, `${event}/${gate}`);
        assert.equal(evaluate(gateEnabled, ...args), String(gateActive));
        assert.equal(evaluate(groupFast, ...args), String(gateActive && gateMode === "fast"));
        // The PR path is unaffected by any merge-group gate value or output.
        assert.equal(evaluate(fast, ...args), String(prActive && mode === "fast"));
        assert.equal(evaluate(admission, ...args), prActive);
        assert.deepEqual(Array.from(evaluate(matrix, ...args)),
          (prActive && mode === "fast") || (gateActive && gateMode === "fast") ? [1] : [1, 2, 3, 4, 5], `${event}/${gate}/${gateMode}`);
        for (const id of ["checks", "browser", "win32", "webkit", "check"]) {
          assert.equal(evaluate(expression(job(id), "if"), ...args), true, `${event}/${gate}/${id}`);
        }
      }
    }
  }
  assert.ok(gateAdmission.startsWith("github.event_name == 'merge_group' && vars.CI_MERGE_GROUP_GATE == 'enabled'"));
});

test("the actual aggregate requires an active plan's success and unambiguous output", () => {
  const shell = shellOf(job("check"), "Require Every Job to Have Succeeded");
  for (const variable of variables) for (const plan of states) for (const mode of ["", "full", "fast", "affected", "unknown"]) {
    const run = spawnSync("bash", ["-c", shell], { encoding: "utf8", timeout: 1000, env: {
      GATE_ENABLED: "false", GATE_RESULT: "skipped", GATE_MODE: "",
      ROUTING_SWITCH: variable, ROUTING_ENABLED: String(variable.toLowerCase() === "enabled"), PLAN_RESULT: plan, PLAN_MODE: mode,
      CHECKS_RESULT: "success", BROWSER_RESULT: "success", WIN32_RESULT: "success", WEBKIT_RESULT: "success",
    } });
    assert.ifError(run.error);
    const pass = variable.toLowerCase() === "enabled" ? plan === "success" && (mode === "full" || variable === "enabled" && mode === "fast")
      : plan === "skipped" && mode === "";
    assert.equal(run.status, pass ? 0 : 1, `${variable}/${plan}/${mode}`);
  }
  for (const mode of ["full", "fast"]) for (const key of ["CHECKS_RESULT", "BROWSER_RESULT", "WIN32_RESULT", "WEBKIT_RESULT"]) {
    for (const result of states.filter((state) => state !== "success")) {
      const run = spawnSync("bash", ["-c", shell], { encoding: "utf8", timeout: 1000, env: {
        GATE_ENABLED: "false", GATE_RESULT: "skipped", GATE_MODE: "",
        ROUTING_SWITCH: "enabled", ROUTING_ENABLED: "true", PLAN_RESULT: "success", PLAN_MODE: mode,
        CHECKS_RESULT: "success", BROWSER_RESULT: "success", WIN32_RESULT: "success", WEBKIT_RESULT: "success", [key]: result,
      } });
      assert.ifError(run.error);
      assert.equal(run.status, 1, `${mode}/${key}/${result}`);
    }
  }
});

test("the actual aggregate requires an admitted gate's success and unambiguous output, and rejects stray gate output", () => {
  const shell = shellOf(job("check"), "Require Every Job to Have Succeeded");
  const work = { CHECKS_RESULT: "success", BROWSER_RESULT: "success", WIN32_RESULT: "success", WEBKIT_RESULT: "success",
    ROUTING_SWITCH: "", ROUTING_ENABLED: "false", PLAN_RESULT: "skipped", PLAN_MODE: "" };
  for (const gate of variables) for (const admitted of [true, false]) for (const result of states) {
    for (const mode of ["", "full", "fast", "affected", "unknown"]) {
      const run = spawnSync("bash", ["-c", shell], { encoding: "utf8", timeout: 1000, env: {
        ...work, GATE_SWITCH: gate, GATE_ENABLED: String(admitted), GATE_RESULT: result, GATE_MODE: mode,
      } });
      assert.ifError(run.error);
      const pass = admitted ? result === "success" && (mode === "full" || gate === "enabled" && mode === "fast")
        : result === "skipped" && mode === "";
      assert.equal(run.status, pass ? 0 : 1, `${gate}/${admitted}/${result}/${mode}`);
    }
  }
  for (const mode of ["full", "fast"]) for (const key of ["CHECKS_RESULT", "BROWSER_RESULT", "WIN32_RESULT", "WEBKIT_RESULT"]) {
    for (const result of states.filter((state) => state !== "success")) {
      const run = spawnSync("bash", ["-c", shell], { encoding: "utf8", timeout: 1000, env: {
        ...work, GATE_SWITCH: "enabled", GATE_ENABLED: "true", GATE_RESULT: "success", GATE_MODE: mode, [key]: result,
      } });
      assert.ifError(run.error);
      assert.equal(run.status, 1, `${mode}/${key}/${result}`);
    }
  }
});

test("the actual gate shell checks exact casing before invoking Git or the gate", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "ci-gate-switch-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const shell = shellOf(job("merge_group_gate"), "Compute Trusted Merge Group Gate");
  for (const fetches of [true, false]) for (const raw of variables) {
    const stub = `git() { echo "git-called"; return ${fetches ? 0 : 1}; }; node() { echo "node-called"; echo mode=fast >> "$GITHUB_OUTPUT"; };\n`;
    const output = join(cwd, "output");
    writeFileSync(output, "");
    const run = spawnSync("bash", ["-e", "-c", stub + shell], { encoding: "utf8", timeout: 1000, cwd: process.cwd(),
      env: { GATE_SWITCH: raw, GITHUB_OUTPUT: output, TESTED_SHA: "fixture" } });
    assert.ifError(run.error);
    assert.equal(run.status, 0);
    assert.equal(readFileSync(output, "utf8"), raw === "enabled" && fetches ? "mode=fast\n" : "mode=full\n");
    assert.equal(run.stdout.includes("git-called"), raw === "enabled");
    assert.equal(run.stdout.includes("node-called"), raw === "enabled" && fetches);
  }
  const gate = job("merge_group_gate");
  assert.match(gate, /ref: refs\/heads\/main\n[\s\S]*persist-credentials: false/);
  assert.doesNotMatch(gate, /continue-on-error|pnpm install|pull_request_target|permissions:|: write/);
  assert.match(gate, /- name: Record Full Merge Group Coverage\n        if: steps.plan.outputs.mode != 'fast'\n/);
  assert.match(gate, /- name: Record Reduced Merge Group Coverage\n        if: steps.plan.outputs.mode == 'fast'\n/);
});

test("the actual plan shell checks exact casing before invoking Git or the selector", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "ci-plan-switch-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const shell = shellOf(job("suite_plan"), "Compute Trusted PR Route");
  const stub = 'git() { echo "git-called"; }; node() { echo "node-called"; echo mode=fast >> "$GITHUB_OUTPUT"; };\n';
  for (const raw of variables) {
    const output = join(cwd, "output");
    writeFileSync(output, "");
    const run = spawnSync("bash", ["-e", "-c", stub + shell], { encoding: "utf8", timeout: 1000,
      env: { ROUTING_SWITCH: raw, GITHUB_OUTPUT: output, TESTED_SHA: "fixture", CHANGE_HEAD_SHA: "fixture" } });
    assert.ifError(run.error);
    assert.equal(run.status, 0);
    assert.equal(readFileSync(output, "utf8"), raw === "enabled" ? "mode=fast\n" : "mode=full\n");
    assert.equal(run.stdout.includes("git-called"), raw === "enabled");
    assert.equal(run.stdout.includes("node-called"), raw === "enabled");
  }
});

test("both actual execution branches preserve commands, propagate errors and never accept author arguments", () => {
  const stub = 'pnpm() { printf "pnpm %s\\n" "$*"; return "$STUB_EXIT"; }; node() { printf "node %s\\n" "$*"; return "$STUB_EXIT"; };\n';
  for (const isFast of [false, true]) for (const raw of ["enabled", "Enabled", "ENABLED", ""]) for (const exit of [0, 7]) for (const [id, name] of [
    ["checks", "Unit Tests"], ["browser", "Remote-Instance Browser End-to-End Tests"],
  ]) for (const path of ["pr", "group"]) {
    const shell = shellOf(job(id), name).replaceAll("${{ matrix.shard }}", "1");
    const env = path === "pr" ? { ROUTING_SWITCH: raw, PR_FAST: String(isFast), GATE_SWITCH: "", GROUP_FAST: "false" }
      : { ROUTING_SWITCH: "", PR_FAST: "false", GATE_SWITCH: raw, GROUP_FAST: String(isFast) };
    const run = spawnSync("bash", ["-e", "-c", stub + shell], { encoding: "utf8", timeout: 1000,
      env: { ...env, STUB_EXIT: String(exit) } });
    assert.ifError(run.error);
    assert.equal(run.status, exit);
    if (id === "checks") assert.equal(run.stdout.trim(), isFast && raw === "enabled"
      ? "node scripts/test-suites.mjs --node-only --groups node-fast --ci" : "pnpm test:ci");
    else assert.equal(run.stdout.trim(), isFast && raw === "enabled"
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
