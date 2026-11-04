import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Disabled by default. This runs only from a trusted current-main checkout and never imports the
// merge group's code. Every failed or unavailable precondition selects today's full validation.
export const GATE_VARIABLE = "CI_MERGE_GROUP_GATE";
export const GATE_ENABLED = "enabled";
export const ROLLBACK_VALUE = "disabled";
export const REQUIRED_CONTEXT = "Typecheck, Test & Sidecar Bundle";
// #3633's future enforced context. Its presence, issuer-pinned in an active main ruleset next to
// the unchanged full context and the merge queue, is the only accepted proof of enforcement.
export const ADMISSION_CONTEXT = "Regression Admission";
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = (n) => Number.isSafeInteger(n) && n > 0;

/** Pure: active branch rules from GET /repos/{repo}/rules/branches/main. Dry run is never enforcement. */
export function admissionEnforcement(rules) {
  if (!Array.isArray(rules) || rules.length > 100) return { active: false, reason: "admission-rules-unavailable" };
  if (!rules.some((rule) => rule?.type === "merge_queue")) return { active: false, reason: "merge-queue-not-required" };
  const checks = rules.filter((rule) => rule?.type === "required_status_checks")
    .flatMap((rule) => Array.isArray(rule.parameters?.required_status_checks) ? rule.parameters.required_status_checks : []);
  if (!checks.some((check) => check?.context === REQUIRED_CONTEXT)) return { active: false, reason: "full-context-not-required" };
  const admission = checks.filter((check) => check?.context === ADMISSION_CONTEXT);
  if (!admission.length) return { active: false, reason: "admission-context-not-required" };
  // Any app may otherwise write the context; only an approved, pinned issuer counts.
  if (!admission.every((check) => positive(check.integration_id))) return { active: false, reason: "admission-issuer-unpinned" };
  return { active: true, reason: null };
}

/**
 * Pure gate decision for a proposed configuration. Only the exact lowercase enabled value on a
 * merge group, active admission enforcement, an unchanged trusted workflow and an exact trusted
 * fast selection of the combined group may reduce work. Everything else is `full`.
 */
export function gateDecision({ gate, event, trustedMainSha, testedSha, workflowMatches, selection, enforcement } = {}) {
  const reasons = [];
  if (gate !== GATE_ENABLED) reasons.push("gate-disabled");
  if (event !== "merge_group") reasons.push("non-merge-group-full");
  if (enforcement?.active !== true) reasons.push(enforcement?.reason ?? "admission-rules-unavailable");
  if (workflowMatches !== true) reasons.push("workflow-changed-or-unavailable");
  const context = selection?.context;
  if (!SHA.test(trustedMainSha ?? "") || !SHA.test(testedSha ?? "") || context?.event !== "merge_group" ||
      context.diffKind !== "combined-merge-group" || context.baseSha !== trustedMainSha ||
      context.diffBaseSha !== trustedMainSha || context.trustedPolicySha !== trustedMainSha ||
      context.testedSha !== testedSha || context.changeHeadSha !== testedSha) reasons.push("selection-context-unavailable");
  else if (selection.mode !== "fast") reasons.push("full-or-affected-closure");
  else if (!Array.isArray(selection.reasons) || selection.reasons.length || !Array.isArray(selection.risks) ||
    selection.risks.some((risk) => risk !== "ordinary")) reasons.push("uncertain-risk");
  return reasons.length ? { mode: "full", reasons } : { mode: "fast", reasons: [] };
}

/** Live adapter: one ruleset read and local Git objects. Any error is an explicit full decision. */
export async function computeMergeGroupGate({ env = process.env, cwd = process.cwd(), api } = {}) {
  // Exact raw value first: case variants and unknown values do no Git or API work.
  if (env.GATE_SWITCH !== GATE_ENABLED) return { mode: "full", reasons: ["gate-disabled"] };
  if (env.GITHUB_EVENT_NAME !== "merge_group") return { mode: "full", reasons: ["non-merge-group-full"] };
  try {
    const { gitSelection, parseSelection, SELECTION_MARKER } = await import("./ci-suite-selection.mjs");
    const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000,
      maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
    const repository = env.GITHUB_REPOSITORY, tested = env.TESTED_SHA;
    const trustedMainSha = git(["rev-parse", "HEAD"]);
    if (!REPOSITORY.test(repository ?? "") || !SHA.test(tested ?? "") || tested !== env.GITHUB_SHA)
      return { mode: "full", reasons: ["integration-unavailable"] };
    if (!api) {
      const { githubApi, budgetApi } = await import("./main-ci-health.mjs");
      api = budgetApi(githubApi(env.GITHUB_TOKEN), { limit: 1, reserve: 0 });
    }
    const enforcement = admissionEnforcement(await api(`/repos/${repository}/rules/branches/main?per_page=100`));
    const workflow = ".github/workflows/ci.yml";
    const workflowMatches = git(["rev-parse", `${trustedMainSha}:${workflow}`]) === git(["rev-parse", `${tested}:${workflow}`]);
    // The combined diff from trusted main includes every queued change ahead of main in the group.
    const { selection } = gitSelection({ base: trustedMainSha, head: tested, changeHead: tested, event: "merge_group",
      runId: env.GITHUB_RUN_ID ?? null, attempt: Number(env.GITHUB_RUN_ATTEMPT) || null, cwd });
    const checked = parseSelection(SELECTION_MARKER + JSON.stringify(selection));
    return { ...gateDecision({ gate: env.GATE_SWITCH, event: env.GITHUB_EVENT_NAME, trustedMainSha, testedSha: tested,
      workflowMatches, selection: checked, enforcement }), selection: checked };
  } catch {
    // Never echo exceptions, API bodies or author-controlled text into workflow outputs.
    return { mode: "full", reasons: ["gate-unavailable"] };
  }
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  if (argv[0] === "evaluate") {
    // Offline operator evaluation of a proposed configuration. It reads one local JSON file only.
    const { values } = parseArgs({ args: argv.slice(1), options: { config: { type: "string" } } });
    const config = JSON.parse(readFileSync(values.config, "utf8"));
    // Enforcement is always derived from the supplied rules fixture, never asserted directly.
    const enforcement = admissionEnforcement(config.rules);
    log(JSON.stringify({ ...gateDecision({ ...config, enforcement }), enforcement }));
    return 0;
  }
  const { mode, reasons, selection } = await computeMergeGroupGate({ env });
  if (selection) log("ci-selection-v1 " + JSON.stringify(selection));
  log(JSON.stringify({ mode, reasons }));
  appendFileSync(env.GITHUB_OUTPUT, `mode=${mode}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
