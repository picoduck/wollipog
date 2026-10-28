import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { GROUPS, FAST_API_FILES, FAST_PROSE_FILES, CRITICAL_BROWSER_FILES, selectGroups } from "./ci-suite-policy.mjs";
import { SUITE_VERSION_V2, POLICY_VERSION_V2, NARROWED_GROUPS, buildGraph, selectFilesV2 } from "./ci-suite-policy-v2.mjs";
import { makeSelectionV2, parseSelectionV2, SELECTION_MARKER_V2, gitReader, treeGraph, loadFastFiles, graphId } from "./ci-suite-selection-v2.mjs";
import { makeSelection, parseSelection, suiteInventory, hash } from "./ci-suite-selection.mjs";

const entry = (path, status = "M") => ({ path, status });
const FAST = ["packages/protocol/src/index.test.ts"];
// A small synthetic repository: file text is graph input only and is never executed.
const SOURCES = {
  "packages/protocol/src/index.ts": "export const protocol = 1;\n",
  "packages/protocol/src/index.test.ts": 'import "./index.js";\n',
  "packages/protocol/package.json": JSON.stringify({ name: "@wollipog/protocol", main: "src/index.ts" }),
  "apps/web/src/components/Timeline.tsx": 'import { protocol } from "@wollipog/protocol";\nexport const Timeline = protocol;\n',
  "apps/web/src/components/Timeline.dom.test.tsx": 'import { Timeline } from "./Timeline.js";\n',
  "apps/web/src/components/Other.tsx": "// See Timeline.dom.test.tsx for coverage notes.\nexport const Other = 1;\n",
  "apps/web/src/components/Other.test.tsx": 'import { Other } from "./Other.js";\n',
  "apps/web/src/scan.test.ts": 'import { readdirSync } from "node:fs";\nreaddirSync("src");\n',
  "apps/web/src/lazy.ts": "export const load = (name) => import(name);\n",
  "apps/web/src/lazy.test.ts": 'import { load } from "./lazy.js";\n',
  "apps/web/src/e2e/timeline-main.tsx": 'import { Timeline } from "../components/Timeline.js";\n',
  "apps/web/src/e2e/other-main.tsx": 'import { Other } from "../components/Other.js";\n',
  "apps/web/timeline-e2e.html": '<script type="module" src="/src/e2e/timeline-main.tsx"></script>\n',
  "apps/web/other-e2e.html": '<script type="module" src="/src/e2e/other-main.tsx"></script>\n',
  "apps/web/vite.config.ts": 'import react from "@vitejs/plugin-react";\nexport default { plugins: [react()] };\n',
  "apps/web/e2e/timeline.spec.ts": 'const PAGE = "/timeline-e2e.html";\n',
  "apps/web/e2e/other.spec.ts": 'test("x", ({ page }) => page.goto("/other-e2e.html"));\n',
  "apps/web/e2e/unmapped.spec.ts": 'test("x", ({ page }) => page.goto(url));\n',
  "apps/control-plane/src/format-label.ts": "export const label = 1;\n",
  "apps/control-plane/src/format-label.test.ts": 'import { label } from "./format-label.js";\n',
  "apps/control-plane/src/server.test.ts": 'import { spawn } from "node:child_process";\nspawn(process.execPath, ["src/index.ts"]);\n',
  "apps/runner/src/worktree.test.ts": 'import { identity } from "../../web/src/worktree-identity.js";\n',
  "apps/web/src/worktree-identity.ts": "export const identity = 1;\n",
  "apps/runner/src/process.test.ts": 'import { execFile } from "node:child_process";\nexecFile("git", ["status"]);\n',
  "apps/runner/src/web-process.test.ts": 'import { execFile } from "node:child_process";\nexecFile(process.execPath, ["../../apps/web/scripts/x.mjs"]);\n',
  "scripts/check.test.mjs": 'import { glob } from "node:fs/promises";\nawait glob("apps/**");\n',
  ...Object.fromEntries([...FAST_API_FILES, ...CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`)].map((path) => [path, "// mandatory\n"])),
};
const tree = Object.keys(SOURCES).map((path) => ({ path, oid: hash(path).slice(0, 40) }));
const texts = new Map(tree.map(({ path, oid }) => [oid, SOURCES[path]]));
const graph = treeGraph(tree, (oids) => new Map(oids.map((oid) => [oid, texts.get(oid)])));
const inventory = suiteInventory(tree, FAST);
const select = (...entries) => selectFilesV2({ diff: { entries }, inventory, graph });
const selected = (result, file) => result.selectedFiles.includes(file);

test("every v1 full or fast outcome passes through v2 unchanged", () => {
  const diffs = [undefined, {}, { entries: [] }, { entries: [entry("docs/a.md")], complete: false }, { entries: [entry("docs/a.md")], baseKnown: false },
    ...["pnpm-lock.yaml", "package.json", "playwright.config.ts", ".github/workflows/ci.yml", "scripts/ci-suite-policy-v2.mjs",
      "scripts/ci-suite-selection-v2.mjs", "docs/ci-node-profile-2026-10-23.json", "packages/protocol/src/index.ts", "apps/web/src/styles.css",
      "apps/web/src/components/Approval.tsx", "apps/control-plane/src/db.ts", "apps/control-plane/src/migrations/001.ts", "apps/runner/src/session-manager.ts",
      "apps/web/e2e/timeline.spec.ts", "apps/web/timeline-e2e.html", "apps/web/vite.config.ts", "unknown/file", "docs/a.md", FAST_PROSE_FILES[0]]
      .map((path) => ({ entries: [entry(path)] })),
    ...["D", "R100", "C100", "T", "U"].map((status) => ({ entries: [entry("apps/web/src/components/Timeline.tsx", status)] })),
    { entries: [entry("apps/web/src/components/Timeline.tsx"), entry("apps/control-plane/src/format-label.ts")] }];
  for (const diff of diffs) {
    const v1 = selectGroups(diff), v2 = selectFilesV2({ diff: diff ?? {}, inventory, graph });
    assert.notEqual(v1.mode, "affected", JSON.stringify(diff));
    assert.equal(v2.mode, v1.mode);
    assert.deepEqual(v2.reasons, v1.reasons);
    assert.deepEqual(v2.groups, v1.groups);
    assert.deepEqual(v2.partialGroups, []);
    assert.deepEqual(v2.selectedFiles, inventory.filter((row) => v1.groups.includes(row.group)).map((row) => row.file));
  }
});

test("v2 never selects outside v1 and adding changes never shrinks it", () => {
  const paths = fc.constantFrom("apps/web/src/components/Timeline.tsx", "apps/web/src/components/Other.tsx", "apps/web/src/lazy.ts",
    "apps/web/src/worktree-identity.ts", "apps/control-plane/src/format-label.ts", "docs/a.md", "apps/runner/src/index.ts", FAST_PROSE_FILES[0]);
  const entries = fc.array(fc.record({ path: paths, status: fc.constantFrom("A", "M", "D") }), { minLength: 1, maxLength: 6 });
  fc.assert(fc.property(entries, entries, (first, added) => {
    const v1 = selectGroups({ entries: first }), before = select(...first), after = select(...first, ...added);
    const v1Files = inventory.filter((row) => v1.groups.includes(row.group)).map((row) => row.file);
    assert.ok(before.selectedFiles.every((file) => v1Files.includes(file)));
    assert.ok(before.selectedFiles.every((file) => after.selectedFiles.includes(file)));
    assert.deepEqual(after, select(...[...first, ...added].reverse()));
  }), { numRuns: 200 });
});

test("an ordinary web change selects importers, opaque tests in scope and mapped pages only", () => {
  const result = select(entry("apps/web/src/components/Timeline.tsx"));
  assert.equal(result.v1Mode, "affected");
  assert.equal(result.mode, "affected");
  assert.deepEqual(result.reasons, []);
  for (const file of ["apps/web/src/components/Timeline.dom.test.tsx", "apps/web/e2e/timeline.spec.ts",
    // Opaque: directory enumeration, computed import, unmapped navigation and unscoped root tooling.
    "apps/web/src/scan.test.ts", "apps/web/src/lazy.test.ts", "apps/web/e2e/unmapped.spec.ts", "scripts/check.test.mjs",
    // A runner test naming the web package by path stays in the opaque scope of a web change.
    "apps/runner/src/web-process.test.ts", ...FAST_API_FILES, ...FAST, ...CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`)]) {
    assert.ok(selected(result, file), file);
  }
  for (const file of ["apps/web/src/components/Other.test.tsx", "apps/web/e2e/other.spec.ts", "apps/control-plane/src/format-label.test.ts",
    "apps/control-plane/src/server.test.ts", "apps/runner/src/process.test.ts", "apps/runner/src/worktree.test.ts"]) {
    assert.ok(!selected(result, file), file);
  }
  assert.deepEqual(result.partialGroups, ["node-web", "node-control-plane", "node-runner", "browser-remaining"]);
  assert.equal(result.scopedOpaqueDeferred, 2);
  // Cross-app relative imports are followed: the runner test imports web worktree identity.
  assert.ok(selected(select(entry("apps/web/src/worktree-identity.ts")), "apps/runner/src/worktree.test.ts"));
});

test("a control-plane change selects its opaque tests and leaves unrelated packages deferred", () => {
  const result = select(entry("apps/control-plane/src/format-label.ts"));
  assert.equal(result.mode, "affected");
  for (const file of ["apps/control-plane/src/format-label.test.ts", "apps/control-plane/src/server.test.ts", "scripts/check.test.mjs"]) assert.ok(selected(result, file), file);
  for (const file of ["apps/web/src/components/Timeline.dom.test.tsx", "apps/web/e2e/timeline.spec.ts", "apps/runner/src/process.test.ts"]) assert.ok(!selected(result, file), file);
  // Browser specs keep only the unmapped page; vite/playwright configuration did not change.
  assert.ok(selected(result, "apps/web/e2e/unmapped.spec.ts"));
});

test("graph construction is conservative about uncertain references and inert about mentions", () => {
  const files = new Map(Object.entries({
    "apps/web/src/a.ts": 'import "./missing.js";\n',
    "apps/web/src/b.ts": 'const page = "/index.html"; // see c.test.ts\n',
    "apps/web/src/c.test.ts": 'import "./b.js";\n',
    "apps/web/src/d.ts": "const m = require(name);\n",
    "apps/web/src/e.ts": "const all = import.meta.glob('./*.ts');\n",
    "apps/web/src/f.ts": null,
    "apps/web/src/g.ts": 'const data = "./fixtures/data.json";\n',
    "apps/web/index.html": "<html></html>\n",
    "apps/runner/src/h.ts": 'join(dir, "runner-entry.ts");\n',
    "apps/runner/src/runner-entry.ts": "export {};\n",
  }));
  const g = buildGraph(files);
  for (const path of ["apps/web/src/a.ts", "apps/web/src/d.ts", "apps/web/src/e.ts", "apps/web/src/f.ts"]) assert.ok(g.opaque.has(path), path);
  assert.deepEqual([...g.opaque.get("apps/web/src/a.ts")], ["*"]);
  assert.ok(!g.opaque.has("apps/web/src/g.ts"));
  // Comments naming a test, and built-output page names outside browser specs, create no edge.
  assert.deepEqual([...g.edges.get("apps/web/src/b.ts")], []);
  assert.deepEqual([...g.edges.get("apps/web/src/c.test.ts")], ["apps/web/src/b.ts"]);
  assert.deepEqual([...g.edges.get("apps/runner/src/h.ts")], ["apps/runner/src/runner-entry.ts"]);
  assert.deepEqual(selectFilesV2({ diff: { entries: [entry("apps/web/src/components/Timeline.tsx")] }, inventory, graph: null }).reasons, ["graph-unavailable"]);
  const missing = select(entry("apps/web/src/components/New.tsx", "A"));
  assert.equal(missing.mode, "full");
  assert.deepEqual(missing.reasons, ["graph-missing-changed-file"]);
  assert.deepEqual(missing.selectedFiles, inventory.map((row) => row.file));
});

test("dev-server configuration reached from a change selects every browser spec", () => {
  const files = new Map(Object.entries({ ...SOURCES, "apps/web/vite.config.ts": 'import { floor } from "./src/js-floor.js";\n', "apps/web/src/js-floor.ts": "export const floor = 1;\n" }));
  const local = buildGraph(files, { protocol: { dir: "packages/protocol/", exports: { ".": "packages/protocol/src/index.ts" } } });
  const result = selectFilesV2({ diff: { entries: [entry("apps/web/src/js-floor.ts")] }, inventory, graph: local });
  for (const row of inventory.filter((row) => row.group === "browser-remaining")) assert.ok(result.selectedFiles.includes(row.file), row.file);
});

test("v2 records carry separate identities and never parse as v1, nor v1 as v2", () => {
  const context = { baseSha: "a".repeat(40), diffBaseSha: "a".repeat(40), changeHeadSha: "b".repeat(40), testedSha: "b".repeat(40),
    trustedPolicySha: "a".repeat(40), event: "pull_request", diffKind: "pr-merge-base", runId: "101", attempt: 1 };
  const diff = { entries: [entry("apps/web/src/components/Timeline.tsx")] };
  const v2 = makeSelectionV2({ tree, fastFiles: FAST, diff, graph, context, policyId: hash("v2-policy") });
  const v1 = makeSelection({ tree, fastFiles: FAST, diff, context, policyId: hash("v2-policy") });
  assert.equal(v2.suiteVersion, SUITE_VERSION_V2);
  assert.equal(v2.policyVersion, POLICY_VERSION_V2);
  assert.notEqual(v2.suiteId, v1.suiteId);
  assert.equal(v2.inventoryId, v1.inventoryId);
  assert.equal(v2.graphId, graphId(graph));
  assert.ok(v2.selectedCount < v1.selectedCount);
  const parsed = parseSelectionV2(`${SELECTION_MARKER_V2}${JSON.stringify(v2)}`);
  assert.equal(parsed.mode, "affected");
  assert.equal(parsed.selectedCount, v2.selectedCount);
  assert.equal(parseSelection(`ci-selection-v1 ${JSON.stringify(v2)}`), null);
  assert.ok(parseSelection(`ci-selection-v1 ${JSON.stringify(v1)}`));
  assert.equal(parseSelectionV2(`${SELECTION_MARKER_V2}${JSON.stringify(v1)}`), null);
  assert.equal(parseSelectionV2(`ci-selection-v1 ${JSON.stringify(v2)}`), null);
  const tamper = (patch) => parseSelectionV2(`${SELECTION_MARKER_V2}${JSON.stringify({ ...v2, ...patch })}`);
  for (const patch of [{ v1Mode: "full" }, { mode: "fast" }, { suiteVersion: "fast-required-v1" }, { policyVersion: 1 }, { certification: "ready" },
    { selectedRuntimeMs: 1 }, { partialGroups: ["webkit"] }, { reasons: ["author-approved"] }, { selectionReasons: { label: 1 } },
    { selectedGroupCounts: { ...v2.selectedGroupCounts, "node-web": v2.groupCounts["node-web"] } }, { scopedOpaqueDeferred: -1 }]) {
    assert.equal(tamper(patch), null, JSON.stringify(patch));
  }
  const fullRecord = makeSelectionV2({ tree, fastFiles: FAST, diff: { entries: [entry("pnpm-lock.yaml")] }, graph, context, policyId: hash("v2-policy") });
  assert.equal(parseSelectionV2(`${SELECTION_MARKER_V2}${JSON.stringify(fullRecord)}`).deferredFileIds.length, 0);
  const incomplete = makeSelectionV2({ tree: tree.filter(({ path }) => path !== FAST_API_FILES[0]), fastFiles: FAST, diff, graph, context, policyId: hash("v2-policy") });
  assert.equal(incomplete.mode, "full");
  assert.ok(incomplete.reasons.includes("missing-mandatory-inventory"));
  assert.ok(NARROWED_GROUPS.every((group) => Object.hasOwn(GROUPS, group)));
});

test("historical regression exercises keep their regression files on the current tree", () => {
  const cwd = new URL("..", import.meta.url).pathname;
  const reader = gitReader(cwd), head = reader.git(["rev-parse", "HEAD"]).trim();
  const real = reader.tree(head), realInventory = suiteInventory(real, loadFastFiles()), realGraph = treeGraph(real, reader.readBlobs);
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/ci-suite-regressions.json", import.meta.url), "utf8"));
  assert.deepEqual(fixture.cases.map((item) => item.issue), [3617, 3517, 2601, 2452]);
  // The fixture's paths are representative. #3517's never existed, so v2 cannot place it in the
  // graph and must fall back to full; the replay uses the file #3751 actually changed for #3517.
  const replayed = { 3517: "apps/web/src/components/SessionDetail.tsx" };
  for (const item of fixture.cases) {
    const stale = !item.expectedMode && !realGraph.edges.has(item.path);
    if (stale) assert.deepEqual(selectFilesV2({ diff: { entries: [entry(item.path)] }, inventory: realInventory, graph: realGraph }).reasons, ["graph-missing-changed-file"]);
    const path = stale ? replayed[item.issue] : item.path;
    assert.ok(path, `${item.issue} needs a current replay path`);
    const result = selectFilesV2({ diff: { entries: [entry(path)] }, inventory: realInventory, graph: realGraph });
    if (item.expectedMode) { assert.equal(result.mode, item.expectedMode); continue; }
    assert.equal(result.mode, "affected", path);
    assert.ok(result.selectedFiles.includes(item.regressionFile), `${item.issue}: ${item.regressionFile}`);
    assert.ok(result.selectedFiles.length < realInventory.length, `${item.issue} should defer unrelated files`);
  }
});

test("the trusted base selector reads head files as text and never executes head policy", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "suite-selection-v2-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, data) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), data); };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  for (const file of ["ci-suite-policy.mjs", "ci-suite-selection.mjs", "ci-suite-policy-v2.mjs", "ci-suite-selection-v2.mjs", "ci-timing.mjs"]) {
    write(`scripts/${file}`, ""); copyFileSync(new URL(file, import.meta.url), join(cwd, "scripts", file));
  }
  write("docs/ci-node-profile-2026-10-23.json", JSON.stringify({ fastFiles: FAST }));
  for (const [path, text] of Object.entries(SOURCES)) write(path, text);
  git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  write("apps/web/src/components/Timeline.tsx", `${SOURCES["apps/web/src/components/Timeline.tsx"]}// change\n`);
  git("add", "."); git("commit", "-qm", "web change"); const web = git("rev-parse", "HEAD");
  write("scripts/ci-suite-policy-v2.mjs", "throw new Error('HEAD POLICY EXECUTED');\n");
  write("apps/web/src/components/Other.tsx", "throw new Error('HEAD SOURCE EXECUTED');\n");
  git("add", "."); git("commit", "-qm", "hostile head"); const hostile = git("rev-parse", "HEAD");
  git("checkout", "-q", base);
  const run = (head) => parseSelectionV2(execFileSync(process.execPath, ["scripts/ci-suite-selection-v2.mjs", "--base", base, "--head", head],
    { cwd, encoding: "utf8", timeout: 20_000, env: { ...process.env, GITHUB_EVENT_NAME: "merge_group", GITHUB_RUN_ID: "101", GITHUB_RUN_ATTEMPT: "1" } }).trim());
  const narrowed = run(web);
  assert.equal(narrowed.mode, "affected");
  assert.equal(narrowed.context.trustedPolicySha, base);
  assert.ok(narrowed.selectedCount < narrowed.inventoryCount);
  const refused = run(hostile);
  assert.equal(refused.mode, "full");
  assert.ok(refused.reasons.includes("shared-config-test-or-unknown-input"));
});

test("offline evaluation classifies fallback triggers and models only selected browser weight", async () => {
  const { fallbackTriggers, model } = await import("./ci-suite-v2-evaluate.mjs");
  assert.deepEqual(fallbackTriggers({ entries: [entry("docs/a.md"), entry("apps/web/e2e/x.spec.ts"), entry("apps/web/src/a.css"),
    entry("apps/runner/src/a.ts"), entry("apps/web/src/b.ts", "D"), entry("apps/web/src/c.ts"), entry("apps/control-plane/src/d.ts")] }),
  ["browser-spec-or-fixture", "cross-package", "markdown", "renamed-or-deleted", "runner-source", "stylesheet"]);
  assert.deepEqual(fallbackTriggers({ entries: [entry("apps/web/src/components/Timeline.tsx")] }), []);
  const profile = { fallbackDurationMs: 1000, productionDurationMs: 0, files: { "timeline.spec.ts": 9000 } };
  const rows = model({ inventory, selected: new Set(["apps/web/e2e/timeline.spec.ts"]), browserProfile: profile, nodeProfile: { slowestFiles: [], totalMs: 0 } });
  assert.equal(rows.browserFiles, 1);
  assert.equal(rows.browserSerialMs, 9000);
  assert.equal(rows.browserNonemptyShards, 1);
});
