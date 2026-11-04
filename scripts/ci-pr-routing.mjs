import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This is run from the immutable PR base checkout, never imported from the tested revision.
// Only the reviewed prose fast selection reduces work. Today's affected closure stays full,
// including engine boundaries, delegated containment and Windows routing on every event.
export function prRoute({ event, selection, base, tested, changeHead, workflowMatches }) {
  const full = (reason) => ({ mode: "full", reason });
  if (event !== "pull_request") return full("non-pr-full");
  if (!workflowMatches) return full("workflow-changed-or-unavailable");
  if (!selection || selection.context?.event !== event || selection.context.baseSha !== base ||
      selection.context.testedSha !== tested || selection.context.changeHeadSha !== changeHead ||
      selection.context.trustedPolicySha !== base) return full("selection-context-unavailable");
  if (selection.mode !== "fast") return full("full-or-affected-closure");
  if (selection.reasons.length || selection.risks.some((risk) => risk !== "ordinary")) return full("uncertain-risk");
  return { mode: "fast", reason: "trusted-prose-fast" };
}

export async function computePrRoute({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") return { mode: "full", reason: "non-pr-full" };
  try {
    const { gitSelection, parseSelection, SELECTION_MARKER } = await import("./ci-suite-selection.mjs");
    const { BASE_SHA: base, TESTED_SHA: tested, CHANGE_HEAD_SHA: changeHead } = env;
    const { selection } = gitSelection({ base, head: tested, changeHead, event: env.GITHUB_EVENT_NAME,
      runId: env.GITHUB_RUN_ID ?? null, attempt: Number(env.GITHUB_RUN_ATTEMPT) || null, cwd });
    const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000,
      maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
    // Establish the base workflow definition for reduced work. Workflow changes select full;
    // no PR code is executed to make this decision. Existing workflow-edit review remains required.
    const workflow = ".github/workflows/ci.yml";
    const workflowMatches = git(["rev-parse", `${base}:${workflow}`]) === git(["rev-parse", `${tested}:${workflow}`]);
    const checked = parseSelection(SELECTION_MARKER + JSON.stringify(selection));
    const route = prRoute({ event: env.GITHUB_EVENT_NAME, selection: checked, base, tested, changeHead, workflowMatches });
    return { ...route, selection: checked };
  } catch {
    // Never echo exceptions, diff paths or author-controlled text into workflow outputs.
    return { mode: "full", reason: "selection-unavailable" };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { mode, reason, selection } = await computePrRoute();
  if (selection) console.log("ci-selection-v1 " + JSON.stringify(selection));
  console.log(JSON.stringify({ mode, reason }));
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
}
