// Offline v1/v2/v3 selection evaluation over recorded CI history (Refs #3629, #3787). Reads only local
// Git objects and a prepared input file; makes no network calls, executes no tested code, and
// certifies nothing. Modeled durations are labeled as models, not measurements.
//
// Input JSON: { window, samples: [{ pr, mergedAt, mergeCommit, areas, prTestedSha, prRunId,
//   groups: [{ runId, attempt, baseSha, testedSha, conclusion }] }],
//   failures: [{ runId, attempt, event, pr, baseSha, testedSha, job, step, files, flaky, typecheck, infra }],
//   timing: { jobs: { "<event>:<job>": { medianMs } }, steps: { "<event>:<job> :: <step>": { medianMs } },
//     nodeProfile: { slowestFiles: [{ fileId, durationMs }] } } }
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GROUPS, FAST_API_FILES, CRITICAL_BROWSER_FILES, selectGroups } from "./ci-suite-policy.mjs";
import { suiteInventory, hash } from "./ci-suite-selection.mjs";
import { narrow, selectFilesV2 } from "./ci-suite-policy-v2.mjs";
import { gitReader, loadFastFiles, treeGraph } from "./ci-suite-selection-v2.mjs";
import { relaxedClass, selectFilesV3 } from "./ci-suite-policy-v3.mjs";
import { treeGraphV3 } from "./ci-suite-selection-v3.mjs";
import { browserShards } from "../playwright.shards.ts";

const NODE_GROUPS = ["node-fast", "node-web", "node-control-plane", "node-runner", "node-other"];
const BROWSER_GROUPS = ["browser-critical", "browser-remaining"];

/** v1 and v2 file selections for one immutable diff/tree pair. */
export function compare({ reader, fastFiles, base, head, changeHead, event, prHead }) {
  const { diff } = prHead
    // Reconstructed PR diff (no recorded PR merge commit): merge base of main-before-merge and the PR head.
    ? (() => { const diffBase = reader.git(["merge-base", base, prHead]).trim();
      return reader.changes({ base: diffBase, head: prHead, changeHead: prHead, event: "local" }); })()
    : reader.changes({ base, head, changeHead, event });
  return { diff, ...compareSelections({ diff, tree: reader.tree(head), fastFiles, readBlobs: reader.readBlobs }) };
}

/**
 * Both selectors' outcomes for one diff and tested tree, including the missing-mandatory-inventory
 * fallback that `makeSelection`/`makeSelectionV2` apply, so evaluation never reports a narrowing
 * the real selectors would refuse.
 */
export function compareSelections({ diff, tree, fastFiles, readBlobs }) {
  const inventory = suiteInventory(tree, fastFiles), graph = treeGraph(tree, readBlobs), graph3 = treeGraphV3(tree, readBlobs);
  let v1 = selectGroups(diff), v2 = selectFilesV2({ diff, inventory, graph }), v3 = selectFilesV3({ diff, inventory, graph: graph3 });
  const has = (file) => inventory.some((row) => row.file === file);
  if ([...fastFiles, ...FAST_API_FILES].some((file) => !has(file)) || CRITICAL_BROWSER_FILES.some((file) => !has(`apps/web/e2e/${file}`))) {
    const full = (choice) => ({ ...choice, mode: "full", reasons: [...choice.reasons, "missing-mandatory-inventory"].sort(), groups: Object.keys(GROUPS).sort() });
    v1 = full(v1);
    v2 = { ...full(v2), partialGroups: [], selectionReasons: {}, scopedOpaqueDeferred: 0, selectedFiles: inventory.map((row) => row.file) };
    v3 = { ...full(v3), partialGroups: [], selectionReasons: {}, scopedOpaqueDeferred: 0, relaxed: [], relaxedClasses: {},
      v3Reason: "missing-mandatory-inventory", selectedFiles: inventory.map((row) => row.file) };
  }
  const v1Files = new Set(inventory.filter((row) => v1.groups.includes(row.group)).map((row) => row.file)), v2Files = new Set(v2.selectedFiles);
  const v3Files = new Set(v3.selectedFiles);
  if ([...v2Files].some((file) => !v1Files.has(file))) throw new Error("v2 selected outside v1");
  const outside = [...v3Files].filter((file) => !v2Files.has(file));
  // Without a relaxed path v3 must be v2 exactly (property 2), not merely within it.
  if (!diff.entries.some(({ path }) => relaxedClass(path)) && (v3Files.size !== v2Files.size || v3.mode !== v2.mode)) throw new Error(`v3 differs from v2 without a relaxed path (v2 ${v2.mode}, v3 ${v3.mode})`);
  if (outside.length) throw new Error(`v3 selected outside v2: ${outside.slice(0, 3).join(", ")} (v2 ${v2.mode}, v3 ${v3.mode}/${v3.v3Reason}; diff ${diff.entries.map((e) => `${e.status}:${e.path}`).slice(0, 8).join(" ")})`);
  // Counterfactual only: the graph rule with every v1 fallback ignored, to measure its recall.
  const graphOnly = new Set(graph ? narrow({ changed: diff.entries.map((entry) => entry.path), inventory, graph, groups: Object.keys(GROUPS) }).selectedFiles
    : inventory.map((row) => row.file));
  return { inventory, v1, v2, v3, v1Files, v2Files, v3Files, graphOnly, triggers: fallbackTriggers(diff) };
}

/**
 * Modeled browser minutes for one selection: the selected share of profile weight scales the
 * observed five-shard test-step total; ceil(5 x share) shards each pay the observed per-job
 * overhead (job minus test step). `calibration` holds observed medians; null means unmeasured.
 */
export function browserMinutes(selected, full, calibration) {
  if (!calibration || !full.browserSerialMs) return null;
  const share = selected.browserSerialMs / full.browserSerialMs;
  const shards = Math.max(1, Math.min(5, Math.ceil(share * 5 - 1e-9)));
  const overhead = calibration.jobMs - calibration.stepMs, testing = share * 5 * calibration.stepMs;
  return { share, shards, runnerMs: shards * overhead + testing, wallMs: overhead + testing / shards };
}

/** Which changed-path classes force v1 (and therefore v2) to full. */
export function fallbackTriggers(diff) {
  const classes = new Set(), packages = new Set();
  for (const entry of diff.entries ?? []) {
    const reasons = selectGroups({ entries: [entry] }).reasons;
    const pkg = entry.path.match(/^apps\/(web|control-plane|runner)\/src\//)?.[1];
    if (pkg && /\.[cm]?[jt]sx?$/.test(entry.path)) packages.add(pkg);
    if (!reasons.length) continue;
    const path = entry.path;
    classes.add(entry.status !== "A" && entry.status !== "M" ? "renamed-or-deleted"
      : reasons.includes("runner-execution") ? "runner-source"
      : reasons.includes("security-and-approval") ? "security-or-approval-path"
      : reasons.includes("persistence-and-migration") ? "persistence-path"
      : /^docs\/.+\.md$|^[^/]+\.md$|^(?:apps|packages)\/[^/]+\/[^/]+\.md$/.test(path) ? "markdown"
      : /^apps\/web\/e2e\//.test(path) ? "browser-spec-or-fixture"
      : /\.css$/.test(path) ? "stylesheet"
      : /^packages\//.test(path) ? "shared-package"
      : /^scripts\/|^\.github\//.test(path) ? "ci-or-root-tooling"
      : /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json)$|playwright/.test(path) ? "manifest-or-config"
      : /(?:^|\/)(?:shared|fixtures|test-support|test-utils)\/|^apps\/[^/]+\/src\/(?:index|main|App)\./.test(path) ? "shared-source-or-fixture"
      : "other-unknown");
  }
  if (packages.size > 1) classes.add("cross-package");
  return [...classes].sort();
}

/** Modeled durations from recorded profiles. Never a measurement of a reduced run. */
export function model({ inventory, selected, browserProfile, nodeProfile }) {
  const browser = inventory.filter((row) => BROWSER_GROUPS.includes(row.group));
  const chosen = browser.filter((row) => selected.has(row.file)).map((row) => row.file.slice("apps/web/e2e/".length));
  const weight = (file) => browserProfile.files[file] ?? browserProfile.fallbackDurationMs;
  const shards = browserShards(chosen, browserProfile);
  const node = inventory.filter((row) => NODE_GROUPS.includes(row.group));
  const known = new Map(nodeProfile.slowestFiles.map((row) => [row.fileId, row.durationMs]));
  const knownTotal = [...known.values()].reduce((sum, ms) => sum + ms, 0);
  const unknown = node.filter((row) => !known.has(hash(row.file))).length;
  // Residual node time is spread evenly over files outside the recorded slowest list.
  const residual = nodeProfile.totalMs > knownTotal && unknown ? (nodeProfile.totalMs - knownTotal) / unknown : 0;
  const nodeMs = (rows) => rows.reduce((sum, row) => sum + (known.get(hash(row.file)) ?? residual), 0);
  return {
    browserFiles: chosen.length, browserSerialMs: chosen.reduce((sum, file) => sum + weight(file), 0),
    browserShardMaxMs: Math.max(...shards.map((shard) => shard.durationMs)),
    browserNonemptyShards: shards.filter((shard) => shard.files.length).length,
    nodeFiles: node.filter((row) => selected.has(row.file)).length, nodeSummedMs: nodeMs(node.filter((row) => selected.has(row.file))),
  };
}

/** Per-selection models; browser minutes always use the complete inventory as the denominator. */
export function modelRow({ result, browserProfile, nodeProfile, calibration }) {
  const of = (selected) => model({ inventory: result.inventory, selected, browserProfile, nodeProfile });
  const m1 = of(result.v1Files), m2 = of(result.v2Files), mg = of(result.graphOnly), all = of(new Set(result.inventory.map((row) => row.file)));
  const m3 = result.v3Files ? of(result.v3Files) : null;
  return { modelV1: m1, modelV2: m2, modelGraphOnly: mg, ...(m3 ? { modelV3: m3 } : {}),
    modeledBrowser: { v1: browserMinutes(m1, all, calibration), v2: browserMinutes(m2, all, calibration), graphOnly: browserMinutes(mg, all, calibration),
      ...(m3 ? { v3: browserMinutes(m3, all, calibration) } : {}) } };
}

export function evaluate(input, { cwd = process.cwd(), browserProfile, fastFiles = loadFastFiles() } = {}) {
  const reader = gitReader(cwd);
  const nodeProfile = { ...input.timing.nodeProfile, totalMs: input.timing.nodeProfile.totalMs ?? 0 };
  // Observed medians for PR browser shards (job and its test step); absent timing stays unmeasured.
  const job = input.timing.jobs?.["pull_request:Browser End-to-End Tests (#)"]?.medianMs;
  const step = input.timing.steps?.["pull_request:Browser End-to-End Tests (#) :: Remote-Instance Browser End-to-End Tests"]?.medianMs;
  const calibration = Number.isFinite(job) && Number.isFinite(step) && job >= step ? { jobMs: job, stepMs: step } : null;
  const row = (kind, meta, args) => {
    const result = compare({ reader, fastFiles, ...args });
    return { kind, ...meta, changed: result.diff.entries.length, v1Mode: result.v1.mode, v1Reasons: result.v1.reasons, v2Mode: result.v2.mode,
      v2Reasons: result.v2.reasons, inventory: result.inventory.length, v1Selected: result.v1Files.size, v2Selected: result.v2Files.size,
      scopedOpaqueDeferred: result.v2.scopedOpaqueDeferred, v2SelectionReasons: result.v2.selectionReasons, triggers: result.triggers, graphOnlySelected: result.graphOnly.size,
      v3Mode: result.v3.mode, v3Reason: result.v3.v3Reason, v3Reasons: result.v3.reasons, v3Selected: result.v3Files.size,
      v3RelaxedClasses: result.v3.relaxedClasses, v3ScopedOpaqueDeferred: result.v3.scopedOpaqueDeferred,
      ...modelRow({ result, browserProfile, nodeProfile, calibration }), result };
  };
  const prRows = [], groupRows = [], failureRows = [];
  for (const sample of input.samples) {
    // A pull_request run records the PR head, not GitHub's test merge commit. The PR diff is
    // merge-base(main before merge, PR head)..PR head; the tested tree is the squash result.
    // A tested head found by branch name can belong to another PR that reused the branch; only the
    // PR's own final head or one of its ancestors is accepted.
    const ownLineage = (sha) => { try { reader.git(["merge-base", "--is-ancestor", sha, sample.prHead]); return true; } catch { return false; } };
    const tested = sample.prTestedSha && (!sample.prHead || ownLineage(sample.prTestedSha)) ? sample.prTestedSha : null;
    const prHead = tested ?? sample.prHead;
    prRows.push(row("pr", { pr: sample.pr, mergedAt: sample.mergedAt, areas: sample.areas, testedSha: sample.mergeCommit, prHead,
      diffSource: tested ? "last-ci-tested-pr-head" : sample.prTestedSha ? "final-pr-head-foreign-tested-head" : "final-pr-head-no-ci-run" },
    { base: `${sample.mergeCommit}^1`, head: sample.mergeCommit, prHead }));
    for (const group of sample.groups) groupRows.push(row("merge_group", { pr: sample.pr, runId: group.runId, attempt: group.attempt, conclusion: group.conclusion,
      testedSha: group.testedSha }, { base: group.baseSha, head: group.testedSha, changeHead: group.testedSha, event: "merge_group" }));
  }
  for (const failure of input.failures) {
    // PR failure: the recorded SHA is the PR head; its fork point from main gives the PR diff and the
    // PR head's tree approximates the tested merge tree (test inventory and import graph).
    const args = failure.event === "merge_group" ? { base: failure.baseSha, head: failure.testedSha, changeHead: failure.testedSha, event: "merge_group" }
      : { base: input.mainSha, head: failure.testedSha, prHead: failure.testedSha };
    const r = row("failure", { runId: failure.runId, attempt: failure.attempt, event: failure.event, pr: failure.pr, job: failure.job, step: failure.step,
      testedSha: failure.testedSha }, args);
    const containment = /Containment/.test(failure.step);
    const pick = (version) => ({ v1: [r.result.v1.groups, r.result.v1Files], v2: [r.result.v2.groups, r.result.v2Files], v3: [r.result.v3.groups, r.result.v3Files] })[version];
    const verdict = (version) => failure.infra.length ? "infrastructure-exclusion"
      : failure.typecheck.length && !failure.files.length ? "always-selected-typecheck"
      : /WebKit/.test(failure.job) ? "always-selected-webkit"
      : !failure.files.length ? "no-test-identity"
      : containment ? pick(version)[0].includes("linux-containment") ? "selected" : "missed"
      : failure.files.every((file) => pick(version)[1].has(file)) ? "selected" : "missed";
    failureRows.push({ ...r, files: failure.files, flaky: failure.flaky, infra: failure.infra, v1Verdict: verdict("v1"), v2Verdict: verdict("v2"), v3Verdict: verdict("v3"),
      v2MissedFiles: containment || failure.infra.length ? [] : failure.files.filter((file) => !r.result.v2Files.has(file)),
      v3MissedFiles: containment || failure.infra.length ? [] : failure.files.filter((file) => !r.result.v3Files.has(file)),
      graphOnlyMissedFiles: containment || failure.infra.length ? [] : failure.files.filter((file) => !r.result.graphOnly.has(file)) });
  }
  const strip = (rows) => rows.map(({ result, ...rest }) => rest);
  return { prRows: strip(prRows), groupRows: strip(groupRows), failureRows: strip(failureRows) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { input: { type: "string" } } });
  const input = JSON.parse(readFileSync(values.input, "utf8"));
  const browserProfile = JSON.parse(readFileSync(new URL("./fixtures/browser-shard-profile.json", import.meta.url), "utf8"));
  console.log(JSON.stringify(evaluate(input, { browserProfile }), null, 1));
}
