import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { GROUPS, FAST_API_FILES, FAST_PROSE_FILES, CRITICAL_BROWSER_FILES, selectGroups } from "./ci-suite-policy.mjs";
import { narrow, selectFilesV2 } from "./ci-suite-policy-v2.mjs";
import { SUITE_VERSION_V3, POLICY_VERSION_V3, relaxedClass, selectFilesV3 } from "./ci-suite-policy-v3.mjs";
import { makeSelectionV3, parseSelectionV3, SELECTION_MARKER_V3, treeGraphV3, loadPolicyIdV3 } from "./ci-suite-selection-v3.mjs";
import { makeSelectionV2, parseSelectionV2, SELECTION_MARKER_V2, gitReader, loadFastFiles, treeGraph } from "./ci-suite-selection-v2.mjs";
import { makeSelection, parseSelection, suiteInventory, hash } from "./ci-suite-selection.mjs";

const entry = (path, status = "M") => ({ path, status });
const FAST = ["packages/protocol/src/index.test.ts"];
// Synthetic repository text: graph input only, never executed.
const SOURCES = {
  "packages/protocol/src/index.ts": "export const protocol = 1;\n",
  "packages/protocol/src/index.test.ts": 'import "./index.js";\n',
  "packages/protocol/package.json": JSON.stringify({ name: "@wollipog/protocol", main: "src/index.ts" }),
  "apps/web/src/components/Timeline.tsx": 'import copy from "../copy/en.json";\nexport const Timeline = copy;\n',
  "apps/web/src/components/Timeline.dom.test.tsx": 'import { Timeline } from "./Timeline.js";\n',
  "apps/web/src/components/Other.tsx": "export const Other = 1;\n",
  "apps/web/src/components/Other.test.tsx": 'import { Other } from "./Other.js";\n',
  "apps/web/src/guide.test.ts": 'import { readFileSync } from "node:fs";\nreadFileSync(new URL("../../../docs/guide.md", import.meta.url));\n',
  "apps/web/src/scan.test.ts": 'import { readdirSync } from "node:fs";\nreaddirSync("src");\n',
  "apps/web/src/e2e/timeline-main.tsx": 'import { Timeline } from "../components/Timeline.js";\n',
  "apps/web/src/e2e/other-main.tsx": 'import { Other } from "../components/Other.js";\n',
  "apps/web/timeline-e2e.html": '<script type="module" src="/src/e2e/timeline-main.tsx"></script>\n',
  "apps/web/other-e2e.html": '<script type="module" src="/src/e2e/other-main.tsx"></script>\n',
  "apps/web/vite.config.ts": 'import react from "@vitejs/plugin-react";\nexport default { plugins: [react()] };\n',
  "apps/web/e2e/timeline.spec.ts": 'import { prompt } from "./helpers.js";\nconst PAGE = "/timeline-e2e.html";\n',
  "apps/web/e2e/other.spec.ts": 'test("x", ({ page }) => page.goto("/other-e2e.html"));\nexpect(page).toHaveScreenshot("row.png");\n',
  "apps/web/e2e/helpers.ts": 'export const prompt = readJson("./fixtures/prompt.json");\n',
  "apps/control-plane/src/format-label.ts": "export const label = 1;\n",
  "apps/control-plane/src/format-label.test.ts": 'import { label } from "./format-label.js";\n',
  // Names a built page; it must not become a dependency on the web app (only browser specs navigate).
  "apps/control-plane/src/static.test.ts": 'serve("/timeline-e2e.html");\n',
  "apps/control-plane/src/server.test.ts": 'import { spawn } from "node:child_process";\nspawn(process.execPath, ["src/index.ts"]);\n',
  "apps/runner/src/process.test.ts": 'import { execFile } from "node:child_process";\nexecFile("git", ["status"]);\n',
  "scripts/check.test.mjs": 'import { glob } from "node:fs/promises";\nawait glob("apps/**");\n',
  ...Object.fromEntries([...FAST_API_FILES, ...CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`)].map((path) => [path, "// mandatory\n"])),
};
const DATA = ["apps/web/src/copy/en.json", "apps/web/src/copy/unused.json", "apps/web/e2e/fixtures/prompt.json",
  "apps/web/e2e/other.spec.ts-snapshots/row-chromium-linux.png", "docs/guide.md", "docs/notes.md", FAST_PROSE_FILES[0],
  "apps/web/public/icons/unused.svg", "scripts/fixtures/profile.json", "package.json", "docs/security-review.md"];
const tree = [...Object.keys(SOURCES), ...DATA].map((path) => ({ path, oid: hash(path).slice(0, 40) }));
const texts = new Map(Object.entries(SOURCES).map(([path, text]) => [hash(path).slice(0, 40), text]));
const read = (oids) => new Map(oids.map((oid) => [oid, texts.get(oid) ?? ""]));
const graph = treeGraphV3(tree, read);
const inventory = suiteInventory(tree, FAST);
const v3 = (...entries) => selectFilesV3({ diff: { entries }, inventory, graph });
// v2 is evaluated on its own graph, so data edges added by v3 can never leak into a v2 comparison.
const graph2 = treeGraph(tree, read);
const v2 = (...entries) => selectFilesV2({ diff: { entries }, inventory, graph: graph2 });
const v1Files = (diff) => { const groups = selectGroups(diff).groups; return inventory.filter((row) => groups.includes(row.group)).map((row) => row.file); };
const has = (result, file) => result.selectedFiles.includes(file);
const POOL = ["apps/web/src/components/Timeline.tsx", "apps/web/src/components/Other.tsx", "apps/control-plane/src/format-label.ts",
  "apps/runner/src/index.ts", "packages/protocol/src/index.ts", "apps/web/e2e/timeline.spec.ts", "apps/web/e2e/helpers.ts", ...DATA,
  "apps/web/src/styles.css", ".github/workflows/ci.yml", "pnpm-lock.yaml", "scripts/ci-suite-policy-v3.mjs", "apps/web/e2e/approval-flow.spec.ts"];
const diffs = fc.array(fc.record({ path: fc.constantFrom(...POOL), status: fc.constantFrom("A", "M", "M", "M", "D") }), { minLength: 1, maxLength: 5 });

test("candidate is a subset of v2, v2 of v1, and equals v2 without a relaxed path", () => {
  fc.assert(fc.property(diffs, (entries) => {
    const three = v3(...entries), two = v2(...entries), one = v1Files({ entries });
    assert.ok(two.selectedFiles.every((file) => one.includes(file)), "v2 within v1");
    assert.ok(three.selectedFiles.every((file) => two.selectedFiles.includes(file)), "v3 within v2");
    if (!entries.some(({ path }) => relaxedClass(path))) {
      assert.deepEqual(three.selectedFiles, two.selectedFiles);
      assert.equal(three.mode, two.mode);
    }
    assert.deepEqual(three, v3(...[...entries].reverse()));
  }), { numRuns: 1000 });
});

test("candidate keeps every graph-selected file and every always-selected group", () => {
  const always = inventory.filter((row) => ["node-fast", "browser-critical"].includes(row.group)).map((row) => row.file);
  fc.assert(fc.property(diffs, (entries) => {
    const three = v3(...entries);
    assert.ok(always.every((file) => has(three, file)));
    // v1's reviewed prose allowlist (`fast`) is inherited from v2 unchanged; see the evaluation report.
    if (selectGroups({ entries }).mode === "fast") return;
    const graphOnly = narrow({ changed: entries.map(({ path }) => path), inventory, graph, groups: Object.keys(GROUPS) }).selectedFiles;
    assert.ok(graphOnly.every((file) => has(three, file)), JSON.stringify(entries));
  }), { numRuns: 1000 });
});

test("every non-relaxed v1 fallback still forces the complete contract", () => {
  const all = inventory.map((row) => row.file);
  for (const entries of [
    [entry("apps/web/e2e/timeline.spec.ts", "D")], [entry("docs/guide.md", "R100")], [entry("docs/security-review.md")],
    [entry("apps/web/e2e/approval-flow.spec.ts")], [entry("scripts/fixtures/profile.json")], [entry("package.json")],
    [entry("apps/web/src/styles.css"), entry("docs/guide.md")], [entry(".github/workflows/ci.yml"), entry("docs/guide.md")],
    [entry("apps/runner/src/index.ts"), entry("apps/web/e2e/timeline.spec.ts")], [entry("packages/protocol/src/index.ts"), entry("docs/guide.md")],
    [entry("apps/web/src/components/Timeline.tsx"), entry("apps/control-plane/src/format-label.ts"), entry("docs/guide.md")],
    [entry("apps/web/src/copy/unused.json")], [entry("apps/web/public/icons/unused.svg")], [entry(".agents/skills/x.md")], [entry("skills/x/SKILL.md")],
  ]) {
    const result = v3(...entries);
    assert.equal(result.mode, "full", JSON.stringify(entries));
    assert.deepEqual(result.selectedFiles, all, JSON.stringify(entries));
  }
  assert.deepEqual(v3(entry("apps/web/src/copy/unused.json")).reasons.includes("unreferenced-data-or-asset"), true);
  assert.deepEqual(selectFilesV3({ diff: { entries: [entry("docs/guide.md")] }, inventory, graph: null }).reasons.includes("graph-unavailable"), true);
  for (const diff of [{ entries: [] }, { entries: [entry("docs/guide.md")], complete: false }, { entries: [entry("docs/guide.md")], baseKnown: false }]) {
    assert.equal(selectFilesV3({ diff, inventory, graph }).mode, "full");
  }
});

test("relaxed Markdown, browser specs, fixtures and referenced data select only their consumers", () => {
  const spec = v3(entry("apps/web/e2e/timeline.spec.ts"));
  assert.equal(spec.mode, "affected");
  assert.deepEqual(spec.relaxedClasses, { "browser-spec-or-fixture": 1 });
  assert.ok(has(spec, "apps/web/e2e/timeline.spec.ts") && !has(spec, "apps/web/e2e/other.spec.ts"));
  assert.ok(!has(spec, "apps/web/src/components/Timeline.dom.test.tsx"));
  assert.ok(has(v3(entry("apps/web/e2e/helpers.ts")), "apps/web/e2e/timeline.spec.ts"));
  const fixture = v3(entry("apps/web/e2e/fixtures/prompt.json"));
  assert.ok(has(fixture, "apps/web/e2e/timeline.spec.ts") && !has(fixture, "apps/web/e2e/other.spec.ts"));
  const snapshot = v3(entry("apps/web/e2e/other.spec.ts-snapshots/row-chromium-linux.png"));
  assert.ok(has(snapshot, "apps/web/e2e/other.spec.ts") && !has(snapshot, "apps/web/e2e/timeline.spec.ts"));
  const copy = v3(entry("apps/web/src/copy/en.json"));
  for (const file of ["apps/web/src/components/Timeline.dom.test.tsx", "apps/web/e2e/timeline.spec.ts", "apps/web/src/scan.test.ts"]) assert.ok(has(copy, file), file);
  assert.ok(!has(copy, "apps/web/src/components/Other.test.tsx") && !has(copy, "apps/control-plane/src/server.test.ts"));
  // Root Markdown has no package, so every opaque test in every package is in scope for it.
  const guide = v3(entry("docs/guide.md"));
  for (const file of ["apps/web/src/guide.test.ts", "apps/web/src/scan.test.ts", "apps/control-plane/src/server.test.ts",
    "apps/runner/src/process.test.ts", "scripts/check.test.mjs"]) assert.ok(has(guide, file), file);
  assert.ok(!has(guide, "apps/web/src/components/Timeline.dom.test.tsx") && !has(guide, "apps/web/e2e/timeline.spec.ts"));
  const notes = v3(entry("docs/notes.md"));
  assert.equal(notes.mode, "affected");
  assert.ok(!has(notes, "apps/web/src/guide.test.ts"));
  // A relaxed path beside an ordinary app change keeps the app change's v1 closure narrowed by the graph.
  const mixed = v3(entry("apps/web/src/components/Other.tsx"), entry("docs/notes.md"));
  assert.ok(has(mixed, "apps/web/src/components/Other.test.tsx") && has(mixed, "apps/web/e2e/other.spec.ts"));
  // Found by the property test: the prose file is a v3 graph node but not a v2 one, so v2 falls
  // back to full beside an app change, and v3 (no relaxed path) must inherit exactly that.
  const proseWithApp = [entry(FAST_PROSE_FILES[0], "A"), entry("apps/web/src/components/Timeline.tsx", "A")];
  assert.equal(v2(...proseWithApp).mode, "full");
  assert.deepEqual(v3(...proseWithApp).selectedFiles, v2(...proseWithApp).selectedFiles);
  // v1's reviewed prose file is not relaxed: it keeps v2's `fast` outcome.
  assert.deepEqual(v3(entry(FAST_PROSE_FILES[0])).selectedFiles, v2(entry(FAST_PROSE_FILES[0])).selectedFiles);
  assert.equal(relaxedClass(FAST_PROSE_FILES[0]), null);
});

test("v3 records are separately versioned and no other version's parser accepts them", () => {
  const context = { baseSha: "a".repeat(40), diffBaseSha: "a".repeat(40), changeHeadSha: "b".repeat(40), testedSha: "b".repeat(40),
    trustedPolicySha: "a".repeat(40), event: "pull_request", diffKind: "pr-merge-base", runId: "101", attempt: 1 };
  const diff = { entries: [entry("apps/web/e2e/timeline.spec.ts")] }, policyId = hash("p");
  const three = makeSelectionV3({ tree, fastFiles: FAST, diff, graph, context, policyId });
  const two = makeSelectionV2({ tree, fastFiles: FAST, diff, graph, context, policyId });
  const one = makeSelection({ tree, fastFiles: FAST, diff, context, policyId });
  assert.equal(three.suiteVersion, SUITE_VERSION_V3);
  assert.equal(three.policyVersion, POLICY_VERSION_V3);
  assert.ok(three.suiteId !== two.suiteId && three.suiteId !== one.suiteId);
  assert.equal(three.mode, "affected");
  assert.equal(two.mode, "full");
  const line = `${SELECTION_MARKER_V3}${JSON.stringify(three)}`;
  assert.equal(parseSelectionV3(line).selectedCount, three.selectedCount);
  for (const marker of ["ci-selection-v1 ", SELECTION_MARKER_V2]) {
    assert.equal(parseSelection(`${marker}${JSON.stringify(three)}`), null);
    assert.equal(parseSelectionV2(`${marker}${JSON.stringify(three)}`), null);
  }
  assert.equal(parseSelectionV3(`${SELECTION_MARKER_V3}${JSON.stringify(two)}`), null);
  assert.equal(parseSelectionV3(`${SELECTION_MARKER_V3}${JSON.stringify(one)}`), null);
  const tamper = (patch) => parseSelectionV3(`${SELECTION_MARKER_V3}${JSON.stringify({ ...three, ...patch })}`);
  for (const patch of [{ suiteVersion: "fast-required-v2" }, { policyVersion: 2 }, { mode: "fast" }, { relaxedCount: 0 }, { relaxedClasses: { label: 1 } },
    { v3Reason: "author-approved" }, { certification: "ready" }, { reasons: ["skip-requested"] }, { selectedRuntimeMs: 1 }]) {
    assert.equal(tamper(patch), null, JSON.stringify(patch));
  }
  const kept = makeSelectionV3({ tree, fastFiles: FAST, diff: { entries: [entry("pnpm-lock.yaml")] }, graph, context, policyId });
  assert.equal(parseSelectionV3(`${SELECTION_MARKER_V3}${JSON.stringify(kept)}`).mode, "full");
  const missing = makeSelectionV3({ tree: tree.filter(({ path }) => path !== FAST_API_FILES[0]), fastFiles: FAST, diff, graph, context, policyId });
  assert.equal(missing.mode, "full");
  assert.ok(missing.reasons.includes("missing-mandatory-inventory"));
});

test("on the current tree a snapshot or spec change selects its own spec and defers unrelated journeys", () => {
  const cwd = new URL("..", import.meta.url).pathname, reader = gitReader(cwd), real = reader.tree(reader.git(["rev-parse", "HEAD"]).trim());
  const realGraph = treeGraphV3(real, reader.readBlobs), realInventory = suiteInventory(real, loadFastFiles());
  const snapshot = real.find(({ path }) => path.startsWith("apps/web/e2e/settings-rows.spec.ts-snapshots/"))?.path;
  assert.ok(snapshot, "settings-rows snapshots exist");
  for (const path of [snapshot, "apps/web/e2e/settings-rows.spec.ts"]) {
    const result = selectFilesV3({ diff: { entries: [entry(path)] }, inventory: realInventory, graph: realGraph });
    assert.equal(result.mode, "affected", path);
    assert.ok(result.selectedFiles.includes("apps/web/e2e/settings-rows.spec.ts"), path);
    assert.ok(result.selectedFiles.length < realInventory.length / 2, `${path} should defer unrelated files`);
  }
  assert.ok(loadPolicyIdV3().length === 64);
});

test("the trusted base selector reads head files as text and never executes head policy", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "suite-selection-v3-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, data) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), data); };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  for (const file of ["ci-suite-policy.mjs", "ci-suite-selection.mjs", "ci-suite-policy-v2.mjs", "ci-suite-selection-v2.mjs",
    "ci-suite-policy-v3.mjs", "ci-suite-selection-v3.mjs", "ci-timing.mjs"]) {
    write(`scripts/${file}`, ""); copyFileSync(new URL(file, import.meta.url), join(cwd, "scripts", file));
  }
  write("docs/ci-node-profile-2026-10-23.json", JSON.stringify({ fastFiles: FAST }));
  for (const [path, text] of Object.entries(SOURCES)) write(path, text);
  write("apps/web/e2e/fixtures/prompt.json", "{}\n");
  git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  write("apps/web/e2e/timeline.spec.ts", `${SOURCES["apps/web/e2e/timeline.spec.ts"]}// change\n`);
  git("add", "."); git("commit", "-qm", "spec change"); const spec = git("rev-parse", "HEAD");
  write("scripts/ci-suite-policy-v3.mjs", "throw new Error('HEAD POLICY EXECUTED');\n");
  write("apps/web/e2e/helpers.ts", "throw new Error('HEAD SOURCE EXECUTED');\n");
  git("add", "."); git("commit", "-qm", "hostile head"); const hostile = git("rev-parse", "HEAD");
  git("checkout", "-q", base);
  const run = (head) => parseSelectionV3(execFileSync(process.execPath, ["scripts/ci-suite-selection-v3.mjs", "--base", base, "--head", head],
    { cwd, encoding: "utf8", timeout: 20_000, env: { ...process.env, GITHUB_EVENT_NAME: "merge_group", GITHUB_RUN_ID: "101", GITHUB_RUN_ATTEMPT: "1" } }).trim());
  const narrowed = run(spec);
  assert.equal(narrowed.mode, "affected");
  assert.equal(narrowed.v2Mode, "full");
  assert.equal(narrowed.context.trustedPolicySha, base);
  assert.ok(narrowed.selectedCount < narrowed.inventoryCount);
  const refused = run(hostile);
  assert.equal(refused.mode, "full");
  assert.equal(refused.v3Reason, "retained-fallback");
});
