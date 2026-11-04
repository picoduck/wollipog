import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiff, hash } from "./ci-suite-selection-v1-1.mjs";
import { browserSelection, PR_BROWSER_POLICY, CRITICAL_BROWSER_FILES } from "./ci-pr-browser-policy.mjs";

export const BROWSER_SELECTION_MARKER = "ci-pr-browser-v1 ";
const policyId = hash(["./ci-pr-browser-policy.mjs", "./ci-pr-browser-route.mjs", "../playwright.pr.config.ts"]
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n"));

/** Independent metadata domain: never interpreted as a historical v1/v1.1 suite selection. */
export function browserEvidence(route, env = process.env) {
  if (!route.context || !route.selectedFileIds) return null;
  const { base, tested, head, diffBase } = route.context;
  return parseBrowserEvidence(BROWSER_SELECTION_MARKER + JSON.stringify({
    version: 1, policy: route.policy, policyId, mode: route.mode,
    inventoryCount: route.inventoryCount, inventoryId: route.inventoryId,
    selectedCount: route.selectedFileIds.length, selectedFileIds: route.selectedFileIds,
    context: { baseSha: base, testedSha: tested, changeHeadSha: head, diffBaseSha: diffBase,
      trustedPolicySha: base, event: "pull_request", runId: env.GITHUB_RUN_ID,
      attempt: Number(env.GITHUB_RUN_ATTEMPT) }, certification: "none",
  }));
}

export function parseBrowserEvidence(line) {
  if (typeof line !== "string" || line.length > 768000) return null;
  const index = line.indexOf(BROWSER_SELECTION_MARKER);
  if (index < 0) return null;
  let row;
  try { row = JSON.parse(line.slice(index + BROWSER_SELECTION_MARKER.length)); } catch { return null; }
  const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
  const count = (value) => Number.isInteger(value) && value > 0 && value <= 5000;
  const context = row?.context;
  if (row?.version !== 1 || row.policy !== PR_BROWSER_POLICY || !digest(row.policyId) || !digest(row.inventoryId) ||
      !["fast", "full"].includes(row.mode) || !count(row.inventoryCount) || !count(row.selectedCount) ||
      row.selectedCount > row.inventoryCount || !Array.isArray(row.selectedFileIds) ||
      row.selectedFileIds.length !== row.selectedCount || !row.selectedFileIds.every(digest) ||
      new Set(row.selectedFileIds).size !== row.selectedCount ||
      CRITICAL_BROWSER_FILES.some((file) => !row.selectedFileIds.includes(hash(`apps/web/e2e/${file}`))) ||
      row.mode === "full" && row.selectedCount !== row.inventoryCount || row.certification !== "none" ||
      !context || ![context.baseSha, context.testedSha, context.changeHeadSha, context.diffBaseSha, context.trustedPolicySha].every(sha) ||
      context.baseSha !== context.trustedPolicySha || context.event !== "pull_request" ||
      typeof context.runId !== "string" || !/^[1-9][0-9]*$/.test(context.runId) ||
      !Number.isSafeInteger(context.attempt) || context.attempt < 1) return null;
  const { baseSha, testedSha, changeHeadSha, diffBaseSha, trustedPolicySha, event, runId, attempt } = context;
  return { version: 1, policy: PR_BROWSER_POLICY, policyId: row.policyId, mode: row.mode,
    inventoryCount: row.inventoryCount, inventoryId: row.inventoryId,
    selectedCount: row.selectedCount, selectedFileIds: row.selectedFileIds,
    context: { baseSha, testedSha, changeHeadSha, diffBaseSha, trustedPolicySha, event, runId, attempt }, certification: "none" };
}

// Execute from immutable PR base. Tested revisions are Git objects, never imported.
export function computeBrowserRoute({ env = process.env, cwd = process.cwd() } = {}) {
  const full = (reason) => ({ policy: PR_BROWSER_POLICY, mode: "full", reason, files: [] });
  if (env.GITHUB_EVENT_NAME !== "pull_request") return full("non-pr-full");
  if (env.ROUTING_SWITCH !== "enabled") return full("routing-disabled");
  try {
    const { BASE_SHA: base, TESTED_SHA: tested, CHANGE_HEAD_SHA: head } = env;
    if (![base, tested, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ""))) return full("immutable-context-unavailable");
    const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30000,
      maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (git(["rev-parse", "HEAD"]).trim() !== base) return full("untrusted-checkout");
    git(["merge-base", "--is-ancestor", base, tested]);
    git(["merge-base", "--is-ancestor", head, tested]);
    const diffBase = git(["merge-base", base, head]).trim();
    const entries = parseDiff(git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", diffBase, head]));
    const workflow = ".github/workflows/ci.yml";
    if (git(["rev-parse", `${base}:${workflow}`]).trim() !== git(["rev-parse", `${tested}:${workflow}`]).trim())
      return full("workflow-changed-or-unavailable");
    const paths = git(["ls-tree", "-r", "--name-only", "-z", tested, "--", "apps/web/e2e/"]).split("\0").filter(Boolean);
    const inventory = paths.filter((path) => /^apps\/web\/e2e\/.+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path) && path !== "apps/web/e2e/inbox-lazy.spec.ts");
    const choice = browserSelection({ entries, inventory });
    return { ...choice, inventoryCount: inventory.length, inventoryId: hash(JSON.stringify([...inventory].sort())),
      selectedFileIds: (choice.mode === "fast" ? choice.files : inventory).map(hash).sort(),
      context: { base, tested, head, diffBase } };
  } catch { return full("selection-unavailable"); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const route = computeBrowserRoute();
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=${route.mode}\nfiles=${JSON.stringify(route.files)}\npolicy=${route.policy}\n`);
  const evidence = browserEvidence(route);
  if (evidence) console.log(BROWSER_SELECTION_MARKER + JSON.stringify(evidence));
  console.log(JSON.stringify({ policy: route.policy, mode: route.mode, reason: route.reason }));
}
