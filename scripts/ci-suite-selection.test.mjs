import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { glob } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fc from "fast-check";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { GROUPS, ALWAYS, FAST_API_FILES, FAST_PROSE_FILES, CRITICAL_BROWSER_FILES, selectGroups, nodeGroup } from "./ci-suite-policy.mjs";
import { makeSelection, parseDiff, parseSelection, SELECTION_MARKER, suiteInventory, hash } from "./ci-suite-selection.mjs";
import { suiteCommands, localSelection } from "./test-suites.mjs";

const entry = (path, status = "M") => ({ path, status });
const choose = (...entries) => selectGroups({ entries });
export const syntheticTree = [...FAST_API_FILES, ...CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`),
  "packages/protocol/src/index.test.ts", "apps/web/src/ui.test.tsx", "apps/runner/src/process.test.ts",
  "apps/control-plane/src/db.test.ts", "scripts/check.test.mjs", "apps/web/e2e/ordinary.spec.ts"]
  .map((path) => ({ path, oid: "a".repeat(40) }));
export function syntheticSelection(overrides = {}) {
  return makeSelection({ tree: syntheticTree, fastFiles: ["packages/protocol/src/index.test.ts"],
    diff: { entries: [entry(FAST_PROSE_FILES[0])] }, policyId: hash("synthetic-policy"),
    context: { baseSha: "a".repeat(40), diffBaseSha: "a".repeat(40), changeHeadSha: "b".repeat(40),
      testedSha: "b".repeat(40), trustedPolicySha: "a".repeat(40), event: "merge_group", diffKind: "combined-merge-group", runId: "101", attempt: 1 },
    ...overrides });
}

test("all uncertain and high-risk inputs explicitly fall back to the complete contract", () => {
  const diffs = [undefined, {}, { entries: {} }, { entries: [] }, { entries: [entry("docs/a.md")], complete: false },
    { entries: [entry("docs/a.md")], baseKnown: false },
    ...["pnpm-lock.yaml", "package.json", "playwright.config.ts", ".github/workflows/ci.yml", "scripts/ci-suite-policy.mjs",
      "docs/ci-node-profile-2026-10-23.json", "packages/protocol/src/index.ts", "apps/web/src/styles.css",
      "apps/web/src/components/Approval.tsx", "apps/control-plane/src/db.ts", "apps/control-plane/src/migrations/001.ts",
      "apps/runner/src/session-manager.ts", "unknown/file", "../docs/a.md", "docs//a.md", "docs/private name.md"].map((path) => ({ entries: [entry(path)] })),
    ...["D", "R100", "C100", "T", "U"].map((status) => ({ entries: [entry("docs/a.md", status)] })),
    { entries: [entry("apps/web/src/a.ts"), entry("apps/control-plane/src/b.ts")] }];
  for (const diff of diffs) {
    const result = selectGroups(diff);
    assert.equal(result.mode, "full", JSON.stringify(diff));
    assert.deepEqual(result.groups, Object.keys(GROUPS).sort());
    assert.ok(result.reasons.length);
  }
});

test("docs and package dependency closure retain mandatory journeys, API and production coverage", () => {
  const docs = choose(entry(FAST_PROSE_FILES[0]));
  assert.equal(docs.mode, "fast");
  for (const group of [...ALWAYS, "node-fast", "browser-critical"]) assert.ok(docs.groups.includes(group));
  const web = choose(entry("apps/web/src/components/Timeline.tsx", "A"));
  assert.equal(web.mode, "affected");
  for (const group of ["node-web", "node-other", "browser-remaining", "production", "webkit", "windows-baselines"]) assert.ok(web.groups.includes(group));
  const backend = choose(entry("apps/control-plane/src/format-label.ts"));
  for (const group of ["node-control-plane", "node-runner", "node-other", "browser-remaining"]) assert.ok(backend.groups.includes(group));
  for (const file of FAST_API_FILES) assert.equal(nodeGroup(file, []), "node-fast");
});

test("adding changes never shrinks an already complete nonempty selection", () => {
  const paths = fc.constantFrom(FAST_PROSE_FILES[0], "docs/a.md", "apps/web/src/components/A.tsx", "apps/control-plane/src/format.ts",
    "packages/protocol/src/a.ts", "pnpm-lock.yaml", "apps/runner/src/index.ts", "unknown");
  const entries = fc.array(fc.record({ path: paths, status: fc.constantFrom("A", "M", "D", "T") }), { minLength: 1, maxLength: 12 });
  fc.assert(fc.property(entries, entries, (first, added) => {
    const before = selectGroups({ entries: first }), after = selectGroups({ entries: [...first, ...added] });
    assert.ok(before.groups.every((group) => after.groups.includes(group)));
    assert.deepEqual(after, selectGroups({ entries: [...first, ...added].reverse() }));
  }), { numRuns: 200 });
});

test("NUL diffs reject truncation and retain deletion rather than losing it", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff("M\0docs/a.md\0D\0apps/web/src/a.ts\0"), [entry("docs/a.md"), entry("apps/web/src/a.ts", "D")]);
  for (const text of ["M\0docs/a", "M\0", "M\0".repeat(5001)]) assert.throws(() => parseDiff(text));
});

test("inventory partitions every newly discovered file and versions changed contracts", () => {
  const original = syntheticSelection();
  const tree = [...syntheticTree, { path: "apps/web/e2e/new.test.ts", oid: "c".repeat(40) },
    { path: "apps/runner/src/new.test.ts", oid: "c".repeat(40) }];
  const added = syntheticSelection({ tree });
  assert.equal(added.inventoryCount, original.inventoryCount + 2);
  assert.equal(added.inventoryCount, added.selectedCount + added.deferredFileIds.length);
  assert.notEqual(added.inventoryId, original.inventoryId);
  assert.notEqual(added.suiteId, original.suiteId);
  const config = syntheticSelection({ tree: [...tree, { path: "playwright.config.ts", oid: "d".repeat(40) }] });
  assert.notEqual(config.suiteId, added.suiteId);
  const productionOnly = { path: "apps/web/e2e/inbox-lazy.spec.ts", oid: "c".repeat(40) };
  const before = syntheticSelection({ tree: [...tree, productionOnly] });
  const after = syntheticSelection({ tree: [...tree, { ...productionOnly, oid: "d".repeat(40) }] });
  assert.notEqual(after.suiteId, before.suiteId, "production-only tests are part of the suite contract");
  const missing = syntheticSelection({ tree: syntheticTree.slice(1) });
  assert.equal(missing.mode, "full");
  assert.equal(missing.deferredFileIds.length, 0);
  assert.equal(suiteInventory(tree, []).length, tree.length);
});

test("unknown Markdown and documentation consumed by tests require full coverage", () => {
  for (const path of ["README.md", "CONTRIBUTING.md", "docs/new-prose.md", "docs/icon-system.md", "docs/RELEASING.md",
    "docs/worktree-setup.md", "docs/synthetic-browser-failure-artifacts.md", "docs/vite-8-compatibility.md"])
    assert.equal(choose(entry(path)).mode, "full", path);
});

test("local selected execution falls back to full for a dirty or different checkout", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "suite-workspace-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(cwd, "scripts")); writeFileSync(join(cwd, "scripts/fixture.test.mjs"), "// fixture\n");
  git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  const clean = localSelection({ base, head: base, cwd });
  assert.match(clean.suiteId, /^[a-f0-9]{64}$/);
  writeFileSync(join(cwd, "untracked.md"), "unknown workspace input\n");
  const dirty = localSelection({ base, head: base, cwd });
  assert.equal(dirty.suiteId, null); assert.equal(dirty.mode, "full");
  assert.ok(dirty.reasons.includes("workspace-diff-uncertain"));
  assert.deepEqual(dirty.groups, Object.keys(GROUPS).sort());
  git("add", "."); git("commit", "-qm", "different checkout");
  assert.equal(localSelection({ base, head: base, cwd }).suiteId, null);
});

test("selection inventory agrees with the independent full Node discovery globs", async () => {
  const discovered = new Set();
  for (const pattern of ["apps/**/src/**/*.test.ts", "apps/**/src/**/*.test.tsx", "apps/**/scripts/**/*.test.mjs",
    "packages/**/src/**/*.test.ts", "packages/**/src/**/*.test.tsx", "scripts/**/*.test.mjs"])
    for await (const file of glob(pattern, { exclude: (name) => name === "node_modules" })) discovered.add(file.replaceAll("\\", "/"));
  const files = [...discovered].sort();
  assert.ok(files.length > 1000);
  const inventory = suiteInventory(files.map((path) => ({ path, oid: "a".repeat(40) })), []);
  assert.deepEqual(inventory.map((row) => row.file).sort(), files);
});

test("safe selection projection rejects suppression, contradictory counts and arbitrary fields", () => {
  const plan = syntheticSelection();
  assert.deepEqual(parseSelection(SELECTION_MARKER + JSON.stringify(plan)), plan);
  const safe = parseSelection(SELECTION_MARKER + JSON.stringify({ ...plan, privateInput: "PRIVATE_SENTINEL" }));
  assert.ok(!JSON.stringify(safe).includes("PRIVATE_SENTINEL"));
  for (const change of [{ selectedCount: 0 }, { groups: [] }, { reasons: ["private-sentinel"] },
    { version: 2 }, { mode: "full" }, { selectedFileIds: [...plan.selectedFileIds, plan.selectedFileIds[0]] }])
    assert.equal(parseSelection(SELECTION_MARKER + JSON.stringify({ ...plan, ...change })), null);
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    const result = parseSelection(SELECTION_MARKER + JSON.stringify(value));
    if (result) assert.deepEqual(parseSelection(SELECTION_MARKER + JSON.stringify(result)), result);
  }), { numRuns: 200 });
});

test("historical regression exercises cover recorded symptoms without rerunning flaky tests", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/ci-suite-regressions.json", import.meta.url)));
  for (const row of fixture.cases) {
    const selection = choose(entry(row.path));
    if (row.expectedMode) assert.equal(selection.mode, row.expectedMode, `issue ${row.issue}`);
    if (row.expectedGroup) {
      assert.ok(selection.groups.includes(row.expectedGroup), `issue ${row.issue}`);
      const group = row.regressionFile.startsWith("apps/web/e2e/") ? "browser-remaining" : nodeGroup(row.regressionFile, []);
      assert.equal(group, row.expectedGroup);
      assert.ok(readFileSync(new URL(`../${row.regressionFile}`, import.meta.url)).length);
    }
  }
});

test("stable full command retains dynamic Node, Chromium, WebKit and production commands", () => {
  const full = suiteCommands("full", { ci: true });
  assert.equal(full.find((row) => row.nodeCoverage)?.nodeCoverage, "full");
  for (const name of ["typecheck", "test:e2e", "test:e2e:production", "test:e2e:webkit"]) assert.ok(full.some(({ command }) => command.includes(name)));
  const fast = suiteCommands("fast");
  assert.deepEqual(fast.find(({ command }) => command.includes("test:e2e")).command.slice(2), CRITICAL_BROWSER_FILES);
});

test("suite command execution preserves argv, CI semantics and the first failed command", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "suite-command-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const trace = join(cwd, "trace.jsonl"), pnpm = join(cwd, "pnpm.cjs");
  const fixture = `require('node:fs').appendFileSync(process.env.SUITE_TRACE, JSON.stringify({ argv: process.argv.slice(2), ci: process.env.CI, synthetic: process.env.SYNTHETIC_ARTIFACT_FAILURE }) + '\\n'); if (process.env.SUITE_FAIL === 'yes') process.exit(7);`;
  writeFileSync(pnpm, fixture);
  mkdirSync(join(cwd, "scripts"));
  writeFileSync(join(cwd, "scripts/test-suites.mjs"), `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.SUITE_TRACE, JSON.stringify({ argv: process.argv.slice(2), ci: process.env.CI, synthetic: process.env.SYNTHETIC_ARTIFACT_FAILURE }) + '\\n');`);
  const command = [fileURLToPath(new URL("./test-suites.mjs", import.meta.url)), "--suite=fast", "--ci"];
  const env = { ...process.env, npm_execpath: pnpm, SUITE_TRACE: trace, SYNTHETIC_ARTIFACT_FAILURE: "true", CI: "" };
  execFileSync(process.execPath, command, { cwd, env, encoding: "utf8", timeout: 10_000 });
  const observed = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(observed.length, 8);
  assert.ok(observed.every((row) => row.ci === "true" && row.synthetic === "false"));
  assert.deepEqual(observed[0].argv, ["typecheck"]);
  assert.ok(observed[1].argv.includes("--node-only"));
  writeFileSync(trace, "");
  assert.throws(() => execFileSync(process.execPath, command, { cwd, env: { ...env, SUITE_FAIL: "yes" },
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(readFileSync(trace, "utf8").trim().split("\n").length, 1);
});

test("trusted base selector ignores a malicious head policy and combines both group changes", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "suite-selection-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, data = "// fixture\n") => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), data); };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  for (const file of ["ci-suite-policy.mjs", "ci-suite-selection.mjs", "ci-timing.mjs"]) {
    write(`scripts/${file}`); copyFileSync(new URL(file, import.meta.url), join(cwd, "scripts", file));
  }
  write("docs/ci-node-profile-2026-10-23.json", JSON.stringify({ fastFiles: ["packages/protocol/src/index.test.ts"] }));
  for (const { path } of syntheticTree) write(path);
  write("apps/web/src/a.ts"); write("apps/control-plane/src/b.ts");
  git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  write("apps/web/src/a.ts", "// first PR\n"); git("add", "."); git("commit", "-qm", "first group member");
  write("apps/control-plane/src/b.ts", "// second PR\n"); git("add", "."); git("commit", "-qm", "second group member");
  const combined = git("rev-parse", "HEAD");
  write("scripts/ci-suite-policy.mjs", "throw new Error('HEAD POLICY EXECUTED');\n");
  git("add", "."); git("commit", "-qm", "hostile policy"); const head = git("rev-parse", "HEAD");
  git("checkout", "-q", base);
  const run = (target, baseSha = base) => parseSelection(execFileSync(process.execPath,
    ["scripts/ci-suite-selection.mjs", "--base", baseSha, "--head", target], { cwd, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, GITHUB_EVENT_NAME: "merge_group", GITHUB_RUN_ID: "101", GITHUB_RUN_ATTEMPT: "1" } }).trim());
  const result = run(head);
  assert.equal(result.context.trustedPolicySha, base);
  assert.equal(result.mode, "full");
  assert.ok(result.reasons.includes("shared-config-test-or-unknown-input"));
  assert.ok(run(combined).reasons.includes("cross-package-diff"));
  assert.ok(run(combined, "c".repeat(40)).reasons.includes("missing-base"));
  git("branch", "change", head);
  write("docs/unrelated.md", "Unrelated base update\n"); git("add", "."); git("commit", "-qm", "new base");
  const newBase = git("rev-parse", "HEAD");
  git("merge", "--no-ff", "--no-edit", "change"); const testedMerge = git("rev-parse", "HEAD");
  git("checkout", "-q", newBase);
  const pr = parseSelection(execFileSync(process.execPath, ["scripts/ci-suite-selection.mjs", "--base", newBase,
    "--head", testedMerge, "--change-head", head], { cwd, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_RUN_ID: "101", GITHUB_RUN_ATTEMPT: "1" } }).trim());
  assert.equal(pr.context.diffKind, "pr-merge-base");
  assert.equal(pr.context.diffBaseSha, base);
  assert.equal(pr.context.testedSha, testedMerge);
  assert.equal(pr.context.trustedPolicySha, newBase);
});
