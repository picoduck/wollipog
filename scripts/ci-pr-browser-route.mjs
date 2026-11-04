import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiff } from "./ci-suite-selection-v1-1.mjs";
import { browserSelection, PR_BROWSER_POLICY } from "./ci-pr-browser-policy.mjs";

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
    return { ...browserSelection({ entries, inventory }), context: { base, tested, head, diffBase } };
  } catch { return full("selection-unavailable"); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const route = computeBrowserRoute();
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=${route.mode}\nfiles=${JSON.stringify(route.files)}\npolicy=${route.policy}\n`);
  console.log(JSON.stringify(route));
}
