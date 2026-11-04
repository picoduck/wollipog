import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { CRITICAL_BROWSER_FILES, browserSelection, validateBrowserFiles } from "./ci-pr-browser-policy.mjs";
import { computeBrowserRoute } from "./ci-pr-browser-route.mjs";

const critical = CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`);
const inventory = [...critical, "apps/web/e2e/ordinary.spec.ts", "apps/web/e2e/new.test.ts"];
const entry = (path, status = "M") => ({ path, status });
const select = (entries, extra = {}) => browserSelection({ entries, inventory, ...extra });

test("ordinary implementation selects critical journeys and every added/changed browser file", () => {
  assert.deepEqual(CRITICAL_BROWSER_FILES, ["authentication-recovery.spec.ts", "new-session-choices.spec.ts",
    "request-surfaces.spec.ts", "issue-closure.spec.ts", "conversation-handoff.spec.ts",
    "automation-triggers.spec.ts", "command-inbox-projects.spec.ts"], "review manifest changes with the policy version");
  for (const path of ["apps/web/src/components/Timeline.tsx", "apps/control-plane/src/format-label.ts",
    "apps/web/src/store.ts", "apps/control-plane/src/auth.ts", "apps/control-plane/src/sessions.ts",
    "apps/control-plane/src/hub.ts", "apps/control-plane/src/db/migrations.ts", "apps/runner/src/display.ts",
    "apps/runner/src/provider-home.ts", "apps/web/src/main.tsx", "apps/web/src/components/Timeline.test.tsx",
    "packages/protocol/src/index.test.ts", "scripts/ordinary.test.mjs", "docs/ci-suite-evidence-2026-10-23.md",
    "apps/web/src/styles.css", "apps/web/public/icon.svg", "README.md"])
    for (const status of ["A", "M", "D"])
      assert.deepEqual(select([entry(path, status)]).files, [...critical].sort(), `${status} ${path}`);
  const entries = [entry("apps/web/src/components/Timeline.tsx"), entry(inventory.at(-1), "A"), entry(inventory.at(-2))];
  const result = select(entries);
  assert.equal(result.mode, "fast");
  assert.equal(result.policy, "pr-browser-critical-v2");
  assert.deepEqual(result.files, [...inventory].sort());
  assert.deepEqual(select(entries.reverse()), result);
  assert.deepEqual(validateBrowserFiles(JSON.stringify(result.files), inventory), result.files);
});

test("shared fixtures, browser/routing infrastructure, toolchain and unknown inputs force full", () => {
  for (const path of ["apps/web/e2e/page-state.ts", "apps/web/e2e/fixtures/live-database.ts",
    "apps/web/e2e/fixtures/shared.spec.ts", "apps/web/e2e/helpers/shared.spec.ts",
    "playwright.config.ts", "playwright.pr.config.ts", "playwright.shards.ts", "scripts/ci-pr-browser-policy.mjs",
    ".github/workflows/ci.yml", "scripts/ci-pr-browser-route.test.mjs", "scripts/ci-suite-policy-v1-1.mjs",
    "scripts/browser-shards.test.mjs", "package.json", "apps/web/package.json", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "devbox.json", ".nvmrc", "apps/runner/tsconfig.json",
    "apps/web/src/e2e/fixture.ts", "packages/protocol/src/index.ts", "packages/test-support/src/x.test.ts",
    "apps/web/src/test-utils/browser.test.ts", "apps/web/e2e/missing.spec.ts",
    "apps/control-plane/src/remote-access-test-fixture.ts", "apps/control-plane/src/video-live-validation-test-fixture.ts",
    "apps/runner/src/ordinary-fixture.ts", "apps/web/src/test-support.ts",
    "../apps/web/e2e/x.spec.ts", "apps/web/e2e//x.spec.ts", "apps/web/e2e/x.spec.ts\nmode=fast"])
    assert.equal(select([entry(path)]).mode, "full", path);
  for (const status of ["D", "R100", "C100", "T", "U", ""])
    assert.equal(select([entry(inventory.at(-1), status)]).mode, "full", status);
  for (const extra of [{ complete: false }, { baseKnown: false }, { inventory: [] }, { inventory: inventory.slice(1) }, { inventory: [...inventory, inventory[0]] }])
    assert.equal(select([entry(inventory.at(-1))], extra).mode, "full");
  for (const entries of [undefined, [], {}, [null]]) assert.equal(select(entries).mode, "full");
});

test("execution refuses empty, suppressed, duplicated, malformed or unknown plan paths", () => {
  for (const value of ["", "null", "{}", "[]", JSON.stringify(critical.slice(1)), JSON.stringify([...critical, critical[0]]),
    JSON.stringify([...critical, "apps/web/e2e/missing.spec.ts"]), JSON.stringify([...critical, "../outside.spec.ts"])])
    assert.throws(() => validateBrowserFiles(value, inventory));
});

test("off switches and every non-PR event cannot select reduced coverage", () => {
  for (const event of ["merge_group", "push", "workflow_call", "workflow_dispatch"])
    assert.equal(computeBrowserRoute({ cwd: "/unavailable", env: { GITHUB_EVENT_NAME: event, ROUTING_SWITCH: "enabled" } }).mode, "full");
  for (const value of [undefined, "", "disabled", "Enabled", "enabled "])
    assert.equal(computeBrowserRoute({ cwd: "/unavailable", env: { GITHUB_EVENT_NAME: "pull_request", ROUTING_SWITCH: value } }).mode, "full");
});

test("immutable Git-object route selects changed specs without executing head policy and fails closed", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pr-browser-policy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (path, text = "fixture\n") => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text); };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  for (const file of [...inventory, ".github/workflows/ci.yml", "apps/web/src/ordinary.ts", "scripts/ci-pr-browser-policy.mjs"]) put(file);
  git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  const route = (edit, overrides = {}) => {
    git("checkout", "-q", "--detach", base); edit(); git("add", "-A"); git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD"); git("checkout", "-q", "--detach", base);
    return computeBrowserRoute({ cwd, env: { GITHUB_EVENT_NAME: "pull_request", ROUTING_SWITCH: "enabled",
      BASE_SHA: base, TESTED_SHA: head, CHANGE_HEAD_SHA: head, ...overrides } });
  };
  const result = route(() => put(inventory.at(-1), "changed test\n"));
  assert.equal(result.mode, "fast");
  assert.ok(result.files.includes(inventory.at(-1)));
  assert.equal(result.context.base, base);
  assert.equal(route(() => put("apps/web/src/ordinary.ts", "changed source\n")).mode, "fast");
  assert.equal(route(() => put("scripts/ci-pr-browser-policy.mjs", 'throw Error("head executed");')).mode, "full");
  assert.equal(route(() => put(".github/workflows/ci.yml", "hostile workflow\n")).mode, "full");
  assert.equal(route(() => rmSync(join(cwd, inventory[0]))).mode, "full");
  assert.equal(route(() => put(inventory.at(-1), "changed test\n"), { BASE_SHA: "f".repeat(40) }).mode, "full");
});
