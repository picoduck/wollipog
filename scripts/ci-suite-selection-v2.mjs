// Advisory prototype of the code-aware `fast-required-v2` selection. It emits its own marker and
// identities, so a v2 record can never join a v1 cohort or certify v1, and vice versa. Nothing in
// CI calls it yet; v1's selector, inventory and shadow job are unchanged.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SUITE_VERSION, FAST_API_FILES, CRITICAL_BROWSER_FILES, ALWAYS, GROUPS } from "./ci-suite-policy.mjs";
import { SUITE_VERSION_V2, POLICY_VERSION_V2, GRAPH_LIMITS, NARROWED_GROUPS, graphPath, buildGraph, selectFilesV2 } from "./ci-suite-policy-v2.mjs";
import { parseDiff, suiteInventory, hash } from "./ci-suite-selection.mjs";

export const SELECTION_MARKER_V2 = "ci-selection-v2 ";
export const REASONS_V2 = ["missing-base", "incomplete-diff", "empty-diff", "renamed-deleted-or-unsupported-status", "unknown-path",
  "security-and-approval", "persistence-and-migration", "runner-execution", "shared-config-test-or-unknown-input", "cross-package-diff",
  "missing-mandatory-inventory", "graph-unavailable", "graph-missing-changed-file"];
export const SELECTION_REASONS_V2 = ["group-always", "imports-change", "opaque-dependency", "unmapped-browser-page"];
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const POLICY_FILES = ["./ci-suite-policy.mjs", "./ci-suite-selection.mjs", "./ci-suite-policy-v2.mjs", "./ci-suite-selection-v2.mjs",
  "../docs/ci-node-profile-2026-10-23.json"];

/** `@wollipog/<name>` export targets from package.json text. Malformed manifests contribute nothing. */
export function workspacePackages(manifests) {
  const packages = {};
  for (const [path, text] of manifests) {
    let manifest;
    try { manifest = JSON.parse(text); } catch { continue; }
    const name = manifest?.name?.match(/^@wollipog\/([\w-]+)$/)?.[1];
    if (!name) continue;
    const dir = path.slice(0, -"package.json".length), exports = {};
    const target = (value) => typeof value === "string" ? value : typeof value?.default === "string" ? value.default : null;
    if (typeof manifest.main === "string") exports["."] = manifest.main;
    if (manifest.exports && typeof manifest.exports === "object") for (const [key, value] of Object.entries(manifest.exports)) if (target(value)) exports[key] = target(value);
    packages[name] = { dir, exports: Object.fromEntries(Object.entries(exports).map(([key, value]) => [key, `${dir}${value.replace(/^\.\//, "")}`])) };
  }
  return packages;
}

/** Graph from tested-tree blobs. Over-bound trees return null, which selects full coverage. */
export function treeGraph(tree, readBlobs) {
  const rows = tree.filter(({ path }) => graphPath(path));
  if (rows.length > GRAPH_LIMITS.files) return null;
  const manifests = tree.filter(({ path }) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path));
  const texts = readBlobs([...rows, ...manifests].map(({ oid }) => oid));
  if (!texts) return null;
  const files = new Map(rows.map(({ path, oid }) => [path, texts.get(oid) ?? null]));
  return buildGraph(files, workspacePackages(manifests.map(({ path, oid }) => [path, texts.get(oid) ?? ""])));
}

export const graphId = (graph) => graph ? hash(JSON.stringify({
  edges: [...graph.edges].map(([from, list]) => [from, [...list].sort()]).sort(([a], [b]) => a.localeCompare(b, "en")),
  opaque: [...graph.opaque].map(([path, scope]) => [path, [...scope].sort()]).sort(([a], [b]) => a.localeCompare(b, "en")) })) : null;

export function makeSelectionV2({ tree, fastFiles, diff, graph, context, policyId }) {
  const inventory = suiteInventory(tree, fastFiles);
  let choice = selectFilesV2({ diff, inventory, graph });
  if ([...fastFiles, ...FAST_API_FILES].some((file) => !inventory.some((row) => row.file === file)) ||
      CRITICAL_BROWSER_FILES.some((file) => !inventory.some((row) => row.file === `apps/web/e2e/${file}`))) {
    choice = { ...choice, mode: "full", reasons: [...choice.reasons, "missing-mandatory-inventory"].sort(), groups: Object.keys(GROUPS).sort(),
      partialGroups: [], selectionReasons: {}, scopedOpaqueDeferred: 0, selectedFiles: inventory.map((row) => row.file) };
  }
  const selected = new Set(choice.selectedFiles);
  const fast = inventory.filter((row) => ["node-fast", "browser-critical"].includes(row.group));
  const contractInputs = tree.filter(({ path }) => /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|playwright[^/]*\.[cm]?[jt]s)$/.test(path) ||
    path.startsWith(".github/workflows/") || /^apps\/web\/e2e\/.+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path) ||
    /^(?:scripts\/(?:ci-|test-|node-test)|docs\/ci-node-profile)/.test(path))
    .map(({ path, oid }) => ({ path, oid })).sort((a, b) => a.path.localeCompare(b.path, "en"));
  const inventoryId = hash(JSON.stringify(inventory.map(({ file, blob, group }) => ({ file, blob, group }))));
  const count = (rows) => Object.fromEntries(Object.keys(GROUPS).map((group) => [group, rows.filter((row) => row.group === group).length]));
  return { version: 2, suiteVersion: SUITE_VERSION_V2, policyVersion: POLICY_VERSION_V2, policyId, inventoryDomain: "node-and-development-chromium",
    suiteId: hash(JSON.stringify({ version: SUITE_VERSION_V2, groups: GROUPS, narrowed: NARROWED_GROUPS, fastFiles, api: FAST_API_FILES,
      critical: CRITICAL_BROWSER_FILES, contractInputs, inventoryId })),
    inventoryId, graphId: graphId(graph), context,
    mode: choice.mode, v1Mode: choice.v1Mode, reasons: choice.reasons, risks: choice.risks, groups: choice.groups,
    partialGroups: choice.partialGroups, selectionReasons: choice.selectionReasons, scopedOpaqueDeferred: choice.scopedOpaqueDeferred,
    inventoryCount: inventory.length, selectedCount: selected.size, fastCount: fast.length,
    fastFileIds: fast.map((row) => row.fileId).sort(),
    selectedFileIds: inventory.filter((row) => selected.has(row.file)).map((row) => row.fileId).sort(),
    deferredFileIds: inventory.filter((row) => !selected.has(row.file)).map((row) => row.fileId).sort(),
    groupCounts: count(inventory), selectedGroupCounts: count(inventory.filter((row) => selected.has(row.file))),
    selectedRuntimeMs: null, runtimeReason: "compute-only-prototype-no-second-suite", certification: "none" };
}

export const loadFastFiles = () => JSON.parse(readFileSync(new URL("../docs/ci-node-profile-2026-10-23.json", import.meta.url), "utf8")).fastFiles;
export const loadPolicyId = () => hash(POLICY_FILES.map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n"));

/** Read-only Git object access shared by the CLI and offline evaluation. Nothing is checked out or executed. */
export function gitReader(cwd = process.cwd()) {
  const git = (args, options = {}) => execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options,
  });
  // Same immutable diff construction as v1: PR merge base to PR head, or the whole merge group.
  const changes = ({ base, head, changeHead = head, event }) => {
    let diffBase = base, baseKnown = false;
    try {
      if (event === "pull_request") diffBase = git(["merge-base", base, changeHead]).trim();
      else if (changeHead !== head) throw new Error("Mismatched group head");
      git(["merge-base", "--is-ancestor", diffBase, changeHead]);
      if (event === "pull_request") {
        git(["merge-base", "--is-ancestor", base, head]);
        git(["merge-base", "--is-ancestor", changeHead, head]);
      }
      baseKnown = true;
      return { diffBase, diff: { entries: parseDiff(git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "--no-renames", "-z", diffBase, changeHead], { maxBuffer: 1024 * 1024 })) } };
    } catch { return { diffBase, diff: { entries: [], baseKnown, complete: false } }; }
  };
  const tree = (head) => git(["ls-tree", "-r", "-z", "--full-tree", head]).split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/);
    return match ? { path: match[3], oid: match[2] } : { path: "", oid: "" };
  });
  const readBlobs = (oids) => {
    const unique = [...new Set(oids)];
    let output;
    try { output = execFileSync("git", ["cat-file", "--batch"], { cwd, input: unique.join("\n") + "\n", timeout: 120_000,
      maxBuffer: GRAPH_LIMITS.bytes + unique.length * 64, stdio: ["pipe", "pipe", "pipe"] }); } catch { return null; }
    const texts = new Map();
    let offset = 0;
    for (const oid of unique) {
      const end = output.indexOf(10, offset);
      const [got, type, size] = output.subarray(offset, end).toString("utf8").split(" ");
      if (got !== oid || type !== "blob") return null;
      const length = Number(size);
      texts.set(oid, length > GRAPH_LIMITS.fileBytes ? null : output.subarray(end + 1, end + 1 + length).toString("utf8"));
      offset = end + 1 + length + 1;
    }
    return texts;
  };
  return { git, changes, tree, readBlobs };
}

export function gitSelectionV2({ base, head, changeHead = head, event = "local", runId = null, attempt = null, cwd = process.cwd() }) {
  if (!sha(head) || !sha(base) || !sha(changeHead)) throw new Error("Expected immutable base and head SHAs");
  const reader = gitReader(cwd), fastFiles = loadFastFiles(), policyId = loadPolicyId();
  const { diffBase, diff } = reader.changes({ base, head, changeHead, event });
  const tree = reader.tree(head), graph = treeGraph(tree, reader.readBlobs);
  const context = { baseSha: base, diffBaseSha: diffBase, changeHeadSha: changeHead, testedSha: head, trustedPolicySha: reader.git(["rev-parse", "HEAD"]).trim(),
    event, diffKind: event === "merge_group" ? "combined-merge-group" : event === "pull_request" ? "pr-merge-base" : "base-to-head",
    runId, attempt };
  return { selection: makeSelectionV2({ tree, fastFiles, diff, graph, context, policyId }), inventory: suiteInventory(tree, fastFiles), diff };
}

/** Re-project allowlisted v2 metadata. A v1 record, or any record failing v2 invariants, is null. */
export function parseSelectionV2(line) {
  if (typeof line !== "string" || line.length > 768_000) return null;
  const index = line.indexOf(SELECTION_MARKER_V2);
  if (index < 0) return null;
  let row;
  try { row = JSON.parse(line.slice(index + SELECTION_MARKER_V2.length)); } catch { return null; }
  const count = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 5000;
  const ids = (list) => Array.isArray(list) && list.length <= 5000 && list.every(digest) && new Set(list).size === list.length;
  const groups = Object.keys(GROUPS);
  const counts = (value) => value && typeof value === "object" && Object.keys(value).length === groups.length && groups.every((group) => count(value[group]));
  if (row?.version !== 2 || row.suiteVersion !== SUITE_VERSION_V2 || row.suiteVersion === SUITE_VERSION || row.policyVersion !== POLICY_VERSION_V2 ||
      row.inventoryDomain !== "node-and-development-chromium" || ![row.policyId, row.suiteId, row.inventoryId].every(digest) ||
      !(row.graphId === null || digest(row.graphId)) || !["fast", "affected", "full"].includes(row.mode) || !["fast", "affected", "full"].includes(row.v1Mode) ||
      // v2 only narrows v1 `affected`; any other v1 outcome is copied, and narrowing never becomes `fast`.
      (row.v1Mode !== "affected" && row.mode !== row.v1Mode) || (row.v1Mode === "affected" && row.mode === "fast") ||
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
      groups.some((group) => row.selectedGroupCounts[group] > row.groupCounts[group] ||
        (!row.groups.includes(group) && row.selectedGroupCounts[group]) ||
        (row.groups.includes(group) && !row.partialGroups.includes(group) && row.selectedGroupCounts[group] !== row.groupCounts[group])) ||
      row.groupCounts["node-fast"] + row.groupCounts["browser-critical"] !== row.fastCount ||
      !count(row.scopedOpaqueDeferred) || (row.mode !== "affected" && row.scopedOpaqueDeferred) || !row.selectionReasons || typeof row.selectionReasons !== "object" ||
      Object.entries(row.selectionReasons).some(([key, value]) => !SELECTION_REASONS_V2.includes(key) || !count(value)) ||
      !Array.isArray(row.reasons) || row.reasons.length > 20 || row.reasons.some((reason) => !REASONS_V2.includes(reason)) ||
      !Array.isArray(row.risks) || row.risks.length > 4 || row.risks.some((risk) => !["ordinary", "security-and-approval", "persistence-and-migration", "runner-execution"].includes(risk)) ||
      ![row.context?.baseSha, row.context?.diffBaseSha, row.context?.changeHeadSha, row.context?.testedSha, row.context?.trustedPolicySha].every(sha) ||
      !["pull_request", "merge_group", "push", "local"].includes(row.context.event) ||
      !["combined-merge-group", "pr-merge-base", "base-to-head"].includes(row.context.diffKind) ||
      !(row.context.runId === null || (typeof row.context.runId === "string" && /^[1-9][0-9]*$/.test(row.context.runId))) ||
      !(row.context.attempt === null || (Number.isSafeInteger(row.context.attempt) && row.context.attempt > 0)) ||
      row.certification !== "none" || row.selectedRuntimeMs !== null) return null;
  const { baseSha, diffBaseSha, changeHeadSha, testedSha, trustedPolicySha, event, diffKind, runId, attempt } = row.context;
  return { version: 2, suiteVersion: SUITE_VERSION_V2, policyVersion: POLICY_VERSION_V2, policyId: row.policyId, suiteId: row.suiteId,
    inventoryId: row.inventoryId, graphId: row.graphId, inventoryDomain: "node-and-development-chromium", mode: row.mode, v1Mode: row.v1Mode,
    reasons: row.reasons, risks: row.risks, groups: row.groups, partialGroups: row.partialGroups, selectionReasons: row.selectionReasons, scopedOpaqueDeferred: row.scopedOpaqueDeferred,
    inventoryCount: row.inventoryCount, selectedCount: row.selectedCount, fastCount: row.fastCount, fastFileIds: row.fastFileIds,
    selectedFileIds: row.selectedFileIds, deferredFileIds: row.deferredFileIds, groupCounts: row.groupCounts, selectedGroupCounts: row.selectedGroupCounts,
    context: { baseSha, diffBaseSha, changeHeadSha, testedSha, trustedPolicySha, event, diffKind, runId, attempt },
    selectedRuntimeMs: null, runtimeReason: "compute-only-prototype-no-second-suite", certification: "none" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { base: { type: "string" }, head: { type: "string" }, "change-head": { type: "string" }, files: { type: "boolean" } } });
    const { selection, inventory } = gitSelectionV2({ base: values.base, head: values.head, changeHead: values["change-head"] ?? values.head,
      event: process.env.GITHUB_EVENT_NAME ?? "local", runId: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : null });
    if (values.files) {
      // Local review aid: human-readable paths stay out of the shadow marker.
      const selected = new Set(selection.selectedFileIds);
      console.log(JSON.stringify(inventory.map(({ file, group, fileId }) => ({ file, group, selected: selected.has(fileId) })), null, 2));
    } else console.log(SELECTION_MARKER_V2 + JSON.stringify(selection));
  } catch {
    console.error("Suite selection v2 unavailable; full coverage required.");
    process.exitCode = 1;
  }
}
