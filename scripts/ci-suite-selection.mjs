import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { identity as hash } from "./ci-timing.mjs";
import { SUITE_VERSION, POLICY_VERSION, FAST_API_FILES, CRITICAL_BROWSER_FILES, ALWAYS, GROUPS, nodeGroup, selectGroups } from "./ci-suite-policy.mjs";

export const SELECTION_MARKER = "ci-selection-v1 ";
export { hash };
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nodeFile = (file) => !file.split("/").includes("node_modules") &&
  /^(?:apps\/(?:[^/]+\/)*src\/.*\.test\.(?:ts|tsx)|apps\/(?:[^/]+\/)*scripts\/.*\.test\.mjs|packages\/(?:[^/]+\/)*src\/.*\.test\.(?:ts|tsx)|scripts\/.*\.test\.mjs)$/.test(file);
const browserFile = (file) => /^apps\/web\/e2e\/.+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file) && file !== "apps/web/e2e/inbox-lazy.spec.ts";

export function parseDiff(output) {
  if (output === "") return [];
  if (!output.endsWith("\0") || output.length > 1024 * 1024) throw new Error("Incomplete diff");
  const fields = output.slice(0, -1).split("\0");
  if (fields.length % 2 || fields.length > 10_000) throw new Error("Incomplete diff");
  return Array.from({ length: fields.length / 2 }, (_, index) => ({ status: fields[2 * index], path: fields[2 * index + 1] }));
}

export function suiteInventory(tree, fastFiles) {
  const inventory = tree.filter(({ path }) => nodeFile(path) || browserFile(path)).map(({ path, oid }) => ({
    file: path, blob: oid, fileId: hash(path),
    group: nodeFile(path) ? nodeGroup(path, fastFiles)
      : CRITICAL_BROWSER_FILES.includes(path.slice("apps/web/e2e/".length)) ? "browser-critical" : "browser-remaining",
  })).sort((a, b) => a.file.localeCompare(b.file, "en"));
  if (!inventory.length || inventory.length > 5000) throw new Error("Missing or oversized inventory");
  return inventory;
}

export function makeSelection({ tree, fastFiles, diff, context, policyId }) {
  const choice = selectGroups(diff), inventory = suiteInventory(tree, fastFiles);
  // Missing mandatory files is a broken contract, never a smaller fast suite.
  if ([...fastFiles, ...FAST_API_FILES].some((file) => !inventory.some((row) => row.file === file)) ||
      CRITICAL_BROWSER_FILES.some((file) => !inventory.some((row) => row.file === `apps/web/e2e/${file}`))) {
    choice.mode = "full";
    choice.reasons.push("missing-mandatory-inventory");
    choice.groups = Object.keys(GROUPS).sort();
  }
  const selected = inventory.filter((row) => choice.groups.includes(row.group));
  const contractInputs = tree.filter(({ path }) => /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|playwright[^/]*\.[cm]?[jt]s)$/.test(path) ||
    path.startsWith(".github/workflows/") || /^(?:scripts\/(?:ci-|test-|node-test)|docs\/ci-node-profile)/.test(path))
    .map(({ path, oid }) => ({ path, oid })).sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { version: 1, suiteVersion: SUITE_VERSION, policyVersion: POLICY_VERSION, policyId, inventoryDomain: "node-and-development-chromium",
    suiteId: hash(JSON.stringify({ version: SUITE_VERSION, groups: GROUPS, fastFiles, api: FAST_API_FILES, critical: CRITICAL_BROWSER_FILES, contractInputs })),
    inventoryId: hash(JSON.stringify(inventory.map(({ file, blob, group }) => ({ file, blob, group })))),
    context, ...choice,
    inventoryCount: inventory.length, selectedCount: selected.length,
    selectedFileIds: selected.map((row) => row.fileId).sort(),
    deferredFileIds: inventory.filter((row) => !choice.groups.includes(row.group)).map((row) => row.fileId).sort(),
    groupCounts: Object.fromEntries(Object.keys(GROUPS).map((group) => [group, inventory.filter((row) => row.group === group).length])),
    selectedRuntimeMs: null, runtimeReason: "compute-only-shadow-no-second-suite", certification: "none" };
}

export function gitSelection({ base, head, changeHead = head, event = "local", runId = null, attempt = null, cwd = process.cwd() }) {
  const git = (args, maxBuffer = 8 * 1024 * 1024) => execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer, stdio: ["ignore", "pipe", "pipe"],
  });
  if (!sha(head) || !sha(base) || !sha(changeHead)) throw new Error("Expected immutable base and head SHAs");
  const fastFiles = JSON.parse(readFileSync(new URL("../docs/ci-node-profile-2026-10-23.json", import.meta.url), "utf8")).fastFiles;
  const policyId = hash(["./ci-suite-policy.mjs", "./ci-suite-selection.mjs", "../docs/ci-node-profile-2026-10-23.json"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n"));
  let diffBase = base, diff;
  try {
    if (event === "pull_request") diffBase = git(["merge-base", base, changeHead]).trim();
    // Merge-group base-to-head includes ALL changes in the group. Never select the last PR.
    git(["merge-base", "--is-ancestor", diffBase, changeHead]);
    diff = { entries: parseDiff(git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "--no-renames", "-z", diffBase, changeHead], 1024 * 1024)) };
  } catch { diff = { entries: [], baseKnown: false, complete: false }; }
  const tree = git(["ls-tree", "-r", "-z", "--full-tree", head]).split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/);
    return match ? { path: match[3], oid: match[2] } : { path: "", oid: "" };
  });
  const context = { baseSha: base, diffBaseSha: diffBase, changeHeadSha: changeHead, testedSha: head, trustedPolicySha: git(["rev-parse", "HEAD"]).trim(),
    event, diffKind: event === "merge_group" ? "combined-merge-group" : event === "pull_request" ? "pr-merge-base" : "base-to-head",
    runId, attempt };
  return { selection: makeSelection({ tree, fastFiles, diff, context, policyId }), inventory: suiteInventory(tree, fastFiles) };
}

/** Re-project allowlisted metadata. Never retain filenames, test diagnostics, branches or inputs. */
export function parseSelection(line) {
  if (typeof line !== "string" || line.length > 768_000) return null;
  const index = line.indexOf(SELECTION_MARKER);
  if (index < 0) return null;
  let row;
  try { row = JSON.parse(line.slice(index + SELECTION_MARKER.length)); } catch { return null; }
  const count = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 5000;
  const ids = (list) => Array.isArray(list) && list.length <= 5000 && list.every(digest) && new Set(list).size === list.length;
  const knownReasons = ["missing-base", "incomplete-diff", "empty-diff", "renamed-deleted-or-unsupported-status", "unknown-path",
    "security-and-approval", "persistence-and-migration", "runner-execution", "shared-config-test-or-unknown-input", "cross-package-diff", "missing-mandatory-inventory"];
  if (row?.version !== 1 || row.suiteVersion !== SUITE_VERSION || row.policyVersion !== POLICY_VERSION || row.inventoryDomain !== "node-and-development-chromium" ||
      ![row.policyId, row.suiteId, row.inventoryId].every(digest) || !["fast", "affected", "full"].includes(row.mode) ||
      !count(row.inventoryCount) || !row.inventoryCount || !count(row.selectedCount) || !row.selectedCount || !ids(row.selectedFileIds) || !ids(row.deferredFileIds) ||
      row.selectedCount !== row.selectedFileIds.length || row.inventoryCount !== row.selectedCount + row.deferredFileIds.length ||
      row.selectedFileIds.some((id) => row.deferredFileIds.includes(id)) ||
      !Array.isArray(row.groups) || row.groups.length > Object.keys(GROUPS).length || row.groups.some((group) => !Object.hasOwn(GROUPS, group)) ||
      [...ALWAYS, "node-fast", "browser-critical"].some((group) => !row.groups.includes(group)) ||
      (row.mode === "full" && (Object.keys(GROUPS).some((group) => !row.groups.includes(group)) || row.deferredFileIds.length)) ||
      !Array.isArray(row.reasons) || row.reasons.length > 20 || row.reasons.some((reason) => !knownReasons.includes(reason)) ||
      !Array.isArray(row.risks) || row.risks.length > 4 || row.risks.some((risk) => !["ordinary", "security-and-approval", "persistence-and-migration", "runner-execution"].includes(risk)) ||
      !row.groupCounts || Object.keys(row.groupCounts).length !== Object.keys(GROUPS).length ||
      Object.keys(GROUPS).some((group) => !count(row.groupCounts[group])) ||
      Object.values(row.groupCounts).reduce((sum, count) => sum + count, 0) !== row.inventoryCount ||
      row.groups.reduce((sum, group) => sum + row.groupCounts[group], 0) !== row.selectedCount ||
      ![row.context?.baseSha, row.context?.diffBaseSha, row.context?.changeHeadSha, row.context?.testedSha, row.context?.trustedPolicySha].every(sha) ||
      !["pull_request", "merge_group", "push", "local"].includes(row.context.event) ||
      !["combined-merge-group", "pr-merge-base", "base-to-head"].includes(row.context.diffKind) ||
      !(row.context.runId === null || (typeof row.context.runId === "string" && /^[1-9][0-9]*$/.test(row.context.runId))) ||
      !(row.context.attempt === null || (Number.isSafeInteger(row.context.attempt) && row.context.attempt > 0)) ||
      row.certification !== "none" || row.selectedRuntimeMs !== null) return null;
  const { version, suiteVersion, policyVersion, policyId, suiteId, inventoryId, mode, reasons, risks, groups,
    inventoryCount, selectedCount, selectedFileIds, deferredFileIds, groupCounts } = row;
  const { baseSha, diffBaseSha, changeHeadSha, testedSha, trustedPolicySha, event, diffKind, runId, attempt } = row.context;
  return { version, suiteVersion, policyVersion, policyId, suiteId, inventoryId, inventoryDomain: "node-and-development-chromium", mode, reasons, risks, groups,
    inventoryCount, selectedCount, selectedFileIds, deferredFileIds, groupCounts,
    context: { baseSha, diffBaseSha, changeHeadSha, testedSha, trustedPolicySha, event, diffKind, runId, attempt },
    selectedRuntimeMs: null, runtimeReason: "compute-only-shadow-no-second-suite", certification: "none" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { base: { type: "string" }, head: { type: "string" }, "change-head": { type: "string" }, inventory: { type: "boolean" } } });
    const { selection, inventory } = gitSelection({ base: values.base, head: values.head, changeHead: values["change-head"] ?? values.head,
      event: process.env.GITHUB_EVENT_NAME ?? "local", runId: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : null });
    console.log(values.inventory ? JSON.stringify(inventory, null, 2) : SELECTION_MARKER + JSON.stringify(selection));
  } catch {
    console.error("Suite selection unavailable; full coverage required.");
    process.exitCode = 1;
  }
}
