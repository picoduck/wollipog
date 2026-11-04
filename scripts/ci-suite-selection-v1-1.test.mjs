import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { readFileSync } from "node:fs";
import { FAST_PROSE_FILES, verifyProseReferences, selectGroups } from "./ci-suite-policy-v1-1.mjs";
import { makeSelection, parseSelection, SELECTION_MARKER, hash } from "./ci-suite-selection-v1-1.mjs";
import { makeSelection as legacySelection, parseSelection as legacyParse } from "./ci-suite-selection.mjs";
import { FAST_API_FILES, CRITICAL_BROWSER_FILES } from "./ci-suite-policy.mjs";
import { cohortKey } from "./ci-suite-shadow-report.mjs";

const evidence = "docs/ci-suite-evidence-2026-10-23.md";
const input = {
  tree: [...FAST_API_FILES, ...CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`),
    "scripts/fast-gate-readiness-report.test.mjs", "apps/web/e2e/other.spec.ts"].map((path) => ({ path, oid: "a".repeat(40) })),
  fastFiles: [], diff: { entries: [{ path: evidence, status: "M" }] }, policyId: hash("policy"),
  context: { baseSha: "a".repeat(40), diffBaseSha: "a".repeat(40), changeHeadSha: "b".repeat(40),
    testedSha: "b".repeat(40), trustedPolicySha: "a".repeat(40), event: "pull_request", diffKind: "pr-merge-base", runId: "1", attempt: 1 },
};

test("evidence document now selects full including its readiness consumer", () => {
  const plan = makeSelection(input);
  assert.equal(selectGroups(input.diff).mode, "full");
  assert.equal(plan.mode, "full");
  assert.equal(plan.deferredFileIds.length, 0);
  assert.ok(plan.selectedFileIds.includes(hash("scripts/fast-gate-readiness-report.test.mjs")));
  assert.deepEqual(parseSelection(SELECTION_MARKER + JSON.stringify(plan)), plan);
});

test("new v1 identity cannot certify historical v1 records or join their cohort", () => {
  const original = legacySelection(input), corrected = makeSelection(input);
  assert.equal(original.mode, "fast");
  assert.equal(original.suiteVersion, "fast-required-v1");
  assert.equal(corrected.suiteVersion, "fast-required-v1.1");
  assert.notEqual(original.suiteId, corrected.suiteId);
  assert.equal(parseSelection(SELECTION_MARKER + JSON.stringify(original)), null);
  assert.equal(legacyParse(SELECTION_MARKER + JSON.stringify(corrected)), null);
  assert.deepEqual(legacyParse(SELECTION_MARKER + JSON.stringify(original)), original);
  const dated = (row) => ({ ...row, createdAt: "2026-11-04T00:00:00Z" });
  assert.notEqual(cohortKey(dated(original)).cohortKey, cohortKey(dated(corrected)).cohortKey);
});

test("prose guard catches direct tests, indirect selector references, basename reads and unavailable input", () => {
  const prose = "docs/guide.md";
  const check = (path, source) => verifyProseReferences({ proseFiles: [prose], tree: [{ path: prose }, { path }], readBlob: () => source });
  assert.equal(check("scripts/check.test.mjs", `readFileSync("${prose}")`), false);
  assert.equal(check("scripts/selector.json", JSON.stringify({ edges: [prose] })), false);
  assert.equal(check("scripts/helper.ts", 'join("docs", "guide.md")'), false);
  assert.equal(check("docs/graph.md", `[input](${prose})`), false);
  assert.equal(check("scripts/helper.ts", null), false);
  assert.equal(check("scripts/helper.ts", "unrelated code"), true);
  assert.equal(verifyProseReferences({ proseFiles: [prose], tree: [], readBlob: () => "" }), false);
  assert.equal(verifyProseReferences({ proseFiles: [prose], tree: [{ path: prose }, { path: "scripts/test.mjs" }], readBlob: () => { throw Error(); } }), false);
});

test("committed prose allowlist has no reference in the tracked test/selector inputs", () => {
  assert.deepEqual(FAST_PROSE_FILES, []);
  const tree = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", timeout: 10000 }).split("\0").filter(Boolean).map((path) => ({ path }));
  assert.equal(verifyProseReferences({ tree, readBlob: ({ path }) => readFileSync(path, "utf8") }), true);
});


test("selection integration cannot ignore a newly introduced prose consumer", () => {
  const prose = "docs/guide.md";
  // Exercise the real exported allowlist, restoring the frozen production value afterward.
  FAST_PROSE_FILES.push(prose);
  try {
    const plan = makeSelection({ ...input,
      tree: [...input.tree, { path: prose, oid: "b".repeat(40) }],
      diff: { entries: [{ path: prose, status: "M" }] },
      readBlob: () => `readFileSync("${prose}")`,
    });
    assert.equal(plan.mode, "full");
    assert.ok(plan.reasons.includes("prose-reference-or-unavailable"));
    assert.equal(plan.deferredFileIds.length, 0);
    // Default/unavailable readers also force full, rather than trusting a declaration.
    assert.ok(makeSelection({ ...input, tree: [...input.tree, { path: prose }],
      diff: { entries: [{ path: prose, status: "M" }] } }).reasons.includes("prose-reference-or-unavailable"));
  } finally { FAST_PROSE_FILES.pop(); }
});

test("an accidental self-declared prose allowlist stays full in this retired identity", () => {
  const prose = "docs/guide.md";
  assert.equal(verifyProseReferences({ proseFiles: [prose],
    tree: [{ path: prose }, { path: "scripts/ci-suite-policy-v1-1.mjs" }],
    readBlob: () => `export const FAST_PROSE_FILES = ["${prose}"];`,
  }), false);
});
