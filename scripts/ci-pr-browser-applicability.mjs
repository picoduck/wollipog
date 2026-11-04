import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { browserSelection, PR_BROWSER_POLICY } from "./ci-pr-browser-policy.mjs";
import { parseDiff, hash } from "./ci-suite-selection-v1-1.mjs";

// Read-only replay, not runtime certification or a prediction of the GitHub scheduler.
export function applicability({ ref = "origin/main", count = 100, cwd = process.cwd() } = {}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 500) throw new Error("Expected 1–500 PR commits");
  const git = (args, maxBuffer = 8 * 1024 * 1024) => execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 30000, maxBuffer, stdio: ["ignore", "pipe", "pipe"],
  });
  const mainSha = git(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  const history = git(["log", "--first-parent", "--max-count=5000", "--format=%H%x09%cI%x09%s", mainSha]).trim().split("\n");
  const samples = [], reasons = {}, triggers = {}, seenPrs = new Set();
  let skippedNonPrCommits = 0, skippedDuplicatePrCommits = 0;
  for (const line of history) {
    const match = line.match(/^([a-f0-9]{40})\t([^\t]+)\t(.*)$/);
    const pr = match?.[3].match(/\(#([1-9][0-9]*)\)$/)?.[1];
    if (!pr) { skippedNonPrCommits++; continue; }
    if (seenPrs.has(pr)) { skippedDuplicatePrCommits++; continue; }
    seenPrs.add(pr);
    const sha = match[1], committedAt = new Date(match[2]).toISOString();
    const entries = parseDiff(git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", `${sha}^`, sha], 1024 * 1024));
    const inventory = git(["ls-tree", "-r", "--name-only", "-z", sha, "--", "apps/web/e2e/"])
      .split("\0").filter((path) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path) && path !== "apps/web/e2e/inbox-lazy.spec.ts");
    const choice = browserSelection({ entries, inventory });
    reasons[choice.reason] = (reasons[choice.reason] ?? 0) + 1;
    if (choice.mode === "full") {
      const overlapping = new Set(entries.map((entry) => browserSelection({ entries: [entry], inventory }))
        .filter((row) => row.mode === "full").map((row) => row.reason));
      for (const item of overlapping) triggers[item] = (triggers[item] ?? 0) + 1;
    }
    samples.push({ pullRequest: Number(pr), commitSha: sha, committedAt, changedPaths: entries.length,
      mode: choice.mode, reason: choice.reason, selectedBrowserFiles: choice.mode === "fast" ? choice.files.length : inventory.length,
      inventoryBrowserFiles: inventory.length });
    if (samples.length === count) break;
  }
  if (samples.length !== count) throw new Error("Insufficient standard squash-PR identities in bounded history");
  const dates = samples.map((row) => Date.parse(row.committedAt));
  const reduced = samples.filter((row) => row.mode === "fast").length;
  return { version: 1, repository: "picoduck/wollipog", policy: PR_BROWSER_POLICY,
    policySourceSha256: hash(readFileSync(new URL("./ci-pr-browser-policy.mjs", import.meta.url), "utf8")),
    sourceHead: git(["rev-parse", "HEAD"]).trim(), pinnedMainSha: mainSha,
    method: "Most recent unique standard squash PR suffixes (#N) on first-parent main history; keep newest commit per PR identity and replay parent-to-commit name-status diff against that commit's browser inventory",
    certification: "none", limitations: ["No runtime/latency prediction", "PR suffix is a Git-history convention, not a fresh forge lookup", "Commit timestamps are not merge landing times", "Trigger categories overlap and do not sum to the sample count"],
    commitClockWindow: { since: new Date(Math.min(...dates)).toISOString(), until: new Date(Math.max(...dates) + 1000).toISOString() },
    sampleCount: count, skippedNonPrCommits, skippedDuplicatePrCommits, reduced, full: count - reduced,
    reasons, overlappingFullTriggerReasons: triggers, samples };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { ref: { type: "string" }, count: { type: "string" } } });
  console.log(JSON.stringify(applicability({ ref: values.ref, count: Number(values.count ?? 100) }), null, 2));
}
