// Offline v1-versus-v2 selection evaluation over recorded CI history (Refs #3629). Reads only local
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
  const inventory = suiteInventory(tree, fastFiles), graph = treeGraph(tree, readBlobs);
  let v1 = selectGroups(diff), v2 = selectFilesV2({ diff, inventory, graph });
  const has = (file) => inventory.some((row) => row.file === file);
  if ([...fastFiles, ...FAST_API_FILES].some((file) => !has(file)) || CRITICAL_BROWSER_FILES.some((file) => !has(`apps/web/e2e/${file}`))) {
    const full = (choice) => ({ ...choice, mode: "full", reasons: [...choice.reasons, "missing-mandatory-inventory"].sort(), groups: Object.keys(GROUPS).sort() });
    v1 = full(v1);
    v2 = { ...full(v2), partialGroups: [], selectionReasons: {}, scopedOpaqueDeferred: 0, selectedFiles: inventory.map((row) => row.file) };
  }
  const v1Files = new Set(inventory.filter((row) => v1.groups.includes(row.group)).map((row) => row.file)), v2Files = new Set(v2.selectedFiles);
  if ([...v2Files].some((file) => !v1Files.has(file))) throw new Error("v2 selected outside v1");
  // Counterfactual only: the graph rule with every v1 fallback ignored, to measure its recall.
  const graphOnly = new Set(graph ? narrow({ changed: diff.entries.map((entry) => entry.path), inventory, graph, groups: Object.keys(GROUPS) }).selectedFiles
    : inventory.map((row) => row.file));
  return { inventory, v1, v2, v1Files, v2Files, graphOnly, triggers: fallbackTriggers(diff) };
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
  return { modelV1: m1, modelV2: m2, modelGraphOnly: mg,
    modeledBrowser: { v1: browserMinutes(m1, all, calibration), v2: browserMinutes(m2, all, calibration), graphOnly: browserMinutes(mg, all, calibration) } };
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
      ...modelRow({ result, browserProfile, nodeProfile, calibration }), result };
  };
  const prRows = [], groupRows = [], failureRows = [];
  for (const sample of input.samples) {
    // A pull_request run records the PR head, not GitHub's test merge commit. The PR diff is
    // merge-base(main before merge, PR head)..PR head; the tested tree is the squash result.
    const prHead = sample.prTestedSha ?? sample.prHead;
    prRows.push(row("pr", { pr: sample.pr, mergedAt: sample.mergedAt, areas: sample.areas, testedSha: sample.mergeCommit, prHead,
      diffSource: sample.prTestedSha ? "last-ci-tested-pr-head" : "final-pr-head-no-ci-run" },
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
    const verdict = (files) => failure.infra.length ? "infrastructure-exclusion"
      : failure.typecheck.length && !failure.files.length ? "always-selected-typecheck"
      : /WebKit/.test(failure.job) ? "always-selected-webkit"
      : !failure.files.length ? "no-test-identity"
      : containment ? (files === "v1" ? r.result.v1.groups : r.result.v2.groups).includes("linux-containment") ? "selected" : "missed"
      : failure.files.every((file) => (files === "v1" ? r.result.v1Files : r.result.v2Files).has(file)) ? "selected" : "missed";
    failureRows.push({ ...r, files: failure.files, flaky: failure.flaky, infra: failure.infra, v1Verdict: verdict("v1"), v2Verdict: verdict("v2"),
      v2MissedFiles: containment || failure.infra.length ? [] : failure.files.filter((file) => !r.result.v2Files.has(file)),
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
