// Shadow-only `fast-required-v3` candidate (#3787). It emits its own marker and identities, so a v3
// record can never join a v1 or v2 cohort or certify either, and neither of theirs can certify v3.
// Nothing in CI calls it; it gates, skips or reduces nothing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FAST_API_FILES, CRITICAL_BROWSER_FILES, ALWAYS, GROUPS } from "./ci-suite-policy.mjs";
import { GRAPH_LIMITS, NARROWED_GROUPS, graphPath, buildGraph } from "./ci-suite-policy-v2.mjs";
import { SUITE_VERSION_V3, POLICY_VERSION_V3, withDataEdges, selectFilesV3 } from "./ci-suite-policy-v3.mjs";
import { suiteInventory, hash } from "./ci-suite-selection.mjs";
import { REASONS_V2, SELECTION_REASONS_V2, workspacePackages, graphId, gitReader, loadFastFiles } from "./ci-suite-selection-v2.mjs";

export const SELECTION_MARKER_V3 = "ci-selection-v3 ";
export const REASONS_V3 = [...REASONS_V2, "unreferenced-data-or-asset"];
export const RELAXED_CLASSES = ["markdown", "browser-spec-or-fixture", "data-or-asset"];
export const V3_REASONS = ["diff-level-fallback", "no-relaxed-path", "retained-fallback", "graph-unavailable", "graph-missing-changed-file",
  "unreferenced-data-or-asset", "relaxed-low-risk", "missing-mandatory-inventory"];
const POLICY_FILES = ["./ci-suite-policy.mjs", "./ci-suite-selection.mjs", "./ci-suite-policy-v2.mjs", "./ci-suite-selection-v2.mjs",
  "./ci-suite-policy-v3.mjs", "./ci-suite-selection-v3.mjs", "../docs/ci-node-profile-2026-10-23.json"];
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
// Data and Markdown nodes are listed by path only; their bytes are never read.
const dataPath = (path) => !path.split("/").includes("node_modules") && /\.(?:mdx?|json|txt|tsv|csv|png|jpe?g|gif|webp|svg|ico|webm|mp4|woff2?|ttf|webmanifest|html)$/.test(path);

export const loadPolicyIdV3 = () => hash(POLICY_FILES.map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n"));

/** v2's source graph plus data/asset/Markdown nodes and edges. Over-bound trees return null (full). */
export function treeGraphV3(tree, readBlobs) {
  const rows = tree.filter(({ path }) => graphPath(path)), data = tree.filter(({ path }) => dataPath(path)).map(({ path }) => path);
  if (rows.length + data.length > GRAPH_LIMITS.files) return null;
  const manifests = tree.filter(({ path }) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path));
  const texts = readBlobs([...rows, ...manifests].map(({ oid }) => oid));
  if (!texts) return null;
  const files = new Map(rows.map(({ path, oid }) => [path, texts.get(oid) ?? null]));
  const graph = buildGraph(files, workspacePackages(manifests.map(({ path, oid }) => [path, texts.get(oid) ?? ""])));
  return withDataEdges(graph, files, data);
}

export function makeSelectionV3({ tree, fastFiles, diff, graph, context, policyId }) {
  const inventory = suiteInventory(tree, fastFiles);
  let choice = selectFilesV3({ diff, inventory, graph });
  if ([...fastFiles, ...FAST_API_FILES].some((file) => !inventory.some((row) => row.file === file)) ||
      CRITICAL_BROWSER_FILES.some((file) => !inventory.some((row) => row.file === `apps/web/e2e/${file}`))) {
    choice = { ...choice, mode: "full", reasons: [...new Set([...choice.reasons, "missing-mandatory-inventory"])].sort(), groups: Object.keys(GROUPS).sort(),
      partialGroups: [], selectionReasons: {}, scopedOpaqueDeferred: 0, relaxed: [], relaxedClasses: {}, v3Reason: "missing-mandatory-inventory",
      selectedFiles: inventory.map((row) => row.file) };
  }
  const selected = new Set(choice.selectedFiles), fast = inventory.filter((row) => ["node-fast", "browser-critical"].includes(row.group));
  const inventoryId = hash(JSON.stringify(inventory.map(({ file, blob, group }) => ({ file, blob, group }))));
  const count = (rows) => Object.fromEntries(Object.keys(GROUPS).map((group) => [group, rows.filter((row) => row.group === group).length]));
  return { version: 3, suiteVersion: SUITE_VERSION_V3, policyVersion: POLICY_VERSION_V3, policyId, inventoryDomain: "node-and-development-chromium",
    suiteId: hash(JSON.stringify({ version: SUITE_VERSION_V3, groups: GROUPS, narrowed: NARROWED_GROUPS, fastFiles, api: FAST_API_FILES,
      critical: CRITICAL_BROWSER_FILES, inventoryId })),
    inventoryId, graphId: graphId(graph), context,
    mode: choice.mode, v1Mode: choice.v1Mode, v2Mode: choice.v2Mode, v3Reason: choice.v3Reason, reasons: choice.reasons, risks: choice.risks,
    groups: choice.groups, partialGroups: choice.partialGroups, selectionReasons: choice.selectionReasons, scopedOpaqueDeferred: choice.scopedOpaqueDeferred,
    relaxedCount: choice.relaxed.length, relaxedClasses: choice.relaxedClasses,
    inventoryCount: inventory.length, selectedCount: selected.size, fastCount: fast.length,
    fastFileIds: fast.map((row) => row.fileId).sort(),
    selectedFileIds: inventory.filter((row) => selected.has(row.file)).map((row) => row.fileId).sort(),
    deferredFileIds: inventory.filter((row) => !selected.has(row.file)).map((row) => row.fileId).sort(),
    groupCounts: count(inventory), selectedGroupCounts: count(inventory.filter((row) => selected.has(row.file))),
    selectedRuntimeMs: null, runtimeReason: "compute-only-shadow-candidate-no-second-suite", certification: "none" };
}

export function gitSelectionV3({ base, head, changeHead = head, event = "local", runId = null, attempt = null, cwd = process.cwd() }) {
  if (!sha(head) || !sha(base) || !sha(changeHead)) throw new Error("Expected immutable base and head SHAs");
  const reader = gitReader(cwd), fastFiles = loadFastFiles(), policyId = loadPolicyIdV3();
  const { diffBase, diff } = reader.changes({ base, head, changeHead, event });
  const tree = reader.tree(head), graph = treeGraphV3(tree, reader.readBlobs);
  const context = { baseSha: base, diffBaseSha: diffBase, changeHeadSha: changeHead, testedSha: head, trustedPolicySha: reader.git(["rev-parse", "HEAD"]).trim(),
    event, diffKind: event === "merge_group" ? "combined-merge-group" : event === "pull_request" ? "pr-merge-base" : "base-to-head", runId, attempt };
  return { selection: makeSelectionV3({ tree, fastFiles, diff, graph, context, policyId }), inventory: suiteInventory(tree, fastFiles), diff };
}

/** Re-project allowlisted v3 metadata. v1, v2 or any record failing v3 invariants is null. */
export function parseSelectionV3(line) {
  if (typeof line !== "string" || line.length > 768_000) return null;
  const index = line.indexOf(SELECTION_MARKER_V3);
  if (index < 0) return null;
  let row;
  try { row = JSON.parse(line.slice(index + SELECTION_MARKER_V3.length)); } catch { return null; }
  const count = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 5000;
  const ids = (list) => Array.isArray(list) && list.length <= 5000 && list.every(digest) && new Set(list).size === list.length;
  const groups = Object.keys(GROUPS), modes = ["fast", "affected", "full"];
  const counts = (value) => value && typeof value === "object" && Object.keys(value).length === groups.length && groups.every((group) => count(value[group]));
  const classes = row?.relaxedClasses;
  if (row?.version !== 3 || row.suiteVersion !== SUITE_VERSION_V3 || row.policyVersion !== POLICY_VERSION_V3 ||
      row.inventoryDomain !== "node-and-development-chromium" || ![row.policyId, row.suiteId, row.inventoryId].every(digest) ||
      !(row.graphId === null || digest(row.graphId)) || ![row.mode, row.v1Mode, row.v2Mode].every((mode) => modes.includes(mode)) ||
      !V3_REASONS.includes(row.v3Reason) ||
      // v3 narrows only by relaxing low-risk paths; otherwise it is v2's outcome. It never becomes `fast` by narrowing.
      (row.v3Reason === "relaxed-low-risk" ? row.mode !== "affected" || !row.relaxedCount : row.relaxedCount !== 0 || (row.mode !== row.v2Mode && row.mode !== "full")) ||
      !count(row.relaxedCount) || !classes || typeof classes !== "object" || Object.entries(classes).some(([key, value]) => !RELAXED_CLASSES.includes(key) || !count(value) || !value) ||
      Object.values(classes).reduce((sum, value) => sum + value, 0) !== row.relaxedCount ||
      !count(row.inventoryCount) || !row.inventoryCount || !count(row.selectedCount) || !row.selectedCount || !count(row.fastCount) || !row.fastCount ||
      !ids(row.selectedFileIds) || !ids(row.deferredFileIds) || !ids(row.fastFileIds) || row.fastCount !== row.fastFileIds.length ||
      row.selectedCount !== row.selectedFileIds.length || row.inventoryCount !== row.selectedCount + row.deferredFileIds.length ||
      row.fastFileIds.some((id) => !row.selectedFileIds.includes(id)) || row.selectedFileIds.some((id) => row.deferredFileIds.includes(id)) ||
      !Array.isArray(row.groups) || row.groups.some((group) => !groups.includes(group)) || new Set(row.groups).size !== row.groups.length ||
      [...ALWAYS, "node-fast", "browser-critical"].some((group) => !row.groups.includes(group)) ||
      !Array.isArray(row.partialGroups) || row.partialGroups.some((group) => !NARROWED_GROUPS.includes(group) || !row.groups.includes(group)) ||
      (row.mode !== "affected" && row.partialGroups.length) || (row.mode === "full" && (groups.some((group) => !row.groups.includes(group)) || row.deferredFileIds.length)) ||
      !counts(row.groupCounts) || !counts(row.selectedGroupCounts) ||
      groups.reduce((sum, group) => sum + row.groupCounts[group], 0) !== row.inventoryCount ||
      groups.reduce((sum, group) => sum + row.selectedGroupCounts[group], 0) !== row.selectedCount ||
      groups.some((group) => row.selectedGroupCounts[group] > row.groupCounts[group] || (!row.groups.includes(group) && row.selectedGroupCounts[group]) ||
        (row.groups.includes(group) && !row.partialGroups.includes(group) && row.selectedGroupCounts[group] !== row.groupCounts[group])) ||
      row.groupCounts["node-fast"] + row.groupCounts["browser-critical"] !== row.fastCount ||
      !count(row.scopedOpaqueDeferred) || (row.mode !== "affected" && row.scopedOpaqueDeferred) ||
      !row.selectionReasons || typeof row.selectionReasons !== "object" ||
      Object.entries(row.selectionReasons).some(([key, value]) => !SELECTION_REASONS_V2.includes(key) || !count(value)) ||
      !Array.isArray(row.reasons) || row.reasons.length > 20 || row.reasons.some((reason) => !REASONS_V3.includes(reason)) ||
      !Array.isArray(row.risks) || row.risks.length > 4 || row.risks.some((risk) => !["ordinary", "security-and-approval", "persistence-and-migration", "runner-execution"].includes(risk)) ||
      ![row.context?.baseSha, row.context?.diffBaseSha, row.context?.changeHeadSha, row.context?.testedSha, row.context?.trustedPolicySha].every(sha) ||
      !["pull_request", "merge_group", "push", "local"].includes(row.context.event) ||
      !["combined-merge-group", "pr-merge-base", "base-to-head"].includes(row.context.diffKind) ||
      !(row.context.runId === null || (typeof row.context.runId === "string" && /^[1-9][0-9]*$/.test(row.context.runId))) ||
      !(row.context.attempt === null || (Number.isSafeInteger(row.context.attempt) && row.context.attempt > 0)) ||
      row.certification !== "none" || row.selectedRuntimeMs !== null) return null;
  const { baseSha, diffBaseSha, changeHeadSha, testedSha, trustedPolicySha, event, diffKind, runId, attempt } = row.context;
  const pick = ["policyId", "suiteId", "inventoryId", "graphId", "mode", "v1Mode", "v2Mode", "v3Reason", "reasons", "risks", "groups", "partialGroups",
    "selectionReasons", "scopedOpaqueDeferred", "relaxedCount", "relaxedClasses", "inventoryCount", "selectedCount", "fastCount", "fastFileIds",
    "selectedFileIds", "deferredFileIds", "groupCounts", "selectedGroupCounts"];
  return { version: 3, suiteVersion: SUITE_VERSION_V3, policyVersion: POLICY_VERSION_V3, inventoryDomain: "node-and-development-chromium",
    ...Object.fromEntries(pick.map((key) => [key, row[key]])),
    context: { baseSha, diffBaseSha, changeHeadSha, testedSha, trustedPolicySha, event, diffKind, runId, attempt },
    selectedRuntimeMs: null, runtimeReason: "compute-only-shadow-candidate-no-second-suite", certification: "none" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { base: { type: "string" }, head: { type: "string" }, "change-head": { type: "string" }, files: { type: "boolean" } } });
    const { selection, inventory } = gitSelectionV3({ base: values.base, head: values.head, changeHead: values["change-head"] ?? values.head,
      event: process.env.GITHUB_EVENT_NAME ?? "local", runId: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : null });
    if (values.files) {
      // Local review aid: human-readable paths stay out of the shadow marker.
      const selected = new Set(selection.selectedFileIds);
      console.log(JSON.stringify(inventory.map(({ file, group, fileId }) => ({ file, group, selected: selected.has(fileId) })), null, 2));
    } else console.log(SELECTION_MARKER_V3 + JSON.stringify(selection));
  } catch {
    console.error("Suite selection v3 unavailable; full coverage required.");
    process.exitCode = 1;
  }
}
