import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_JOBS_RETIRED_REASON, type CampaignReviewJobUpdate, type SessionReviewJobUpdate } from "@wollipog/protocol";

type Receipt = CampaignReviewJobUpdate | SessionReviewJobUpdate;
type HistoricalJob = { phase: string; command: { jobId: string; nonce: string }; update?: Receipt };
const DRAIN = "Finish or cancel unfinished legacy reviews with the prior runner before upgrading; preserve their receipts and usage. Then use review sessions. No legacy controller was launched.";

/** Read-only migration fence. A launch intent or unavailable usage is never treated as zero,
 * and a new runner never adopts or relaunches a retired controller. */
function settled(path: string, kind: "bridge" | "campaign"): HistoricalJob {
  let state: HistoricalJob;
  try { state = JSON.parse(readFileSync(path, "utf8")) as HistoricalJob; }
  catch { throw new Error(`A legacy review record could not be verified. ${DRAIN}`); }
  const allowed = kind === "bridge" ? ["completed", "failed", "not_launched"] : ["completed", "not_launched"];
  if (!state || typeof state !== "object" || state.phase !== "finished" || !state.command || !state.update ||
      typeof state.command.jobId !== "string" || typeof state.command.nonce !== "string" || !state.command.nonce ||
      state.update.type !== (kind === "bridge" ? "session_review_job_update" : "campaign_review_job_update") ||
      !allowed.includes(state.update.state) ||
      state.update.jobId !== state.command.jobId || state.update.nonce !== state.command.nonce) {
    throw new Error(`A legacy review has unfinished work or unsettled usage. ${DRAIN}`);
  }
  if (state.update.type === "campaign_review_job_update" &&
      (typeof state.update.costUsd !== "number" || !Number.isFinite(state.update.costUsd) || state.update.costUsd < 0 ||
       !Number.isSafeInteger(state.update.toolCalls) || state.update.toolCalls < 0 ||
       !/^[0-9a-f]{64}$/u.test(state.update.receiptSha256 ?? "") ||
       state.update.state === "not_launched" && (state.update.costUsd !== 0 || state.update.toolCalls !== 0 || state.update.attemptConsumed !== false))) {
    throw new Error(`A legacy review has no verified final usage receipt. ${DRAIN}`);
  }
  return state;
}

export function assertLegacyReviewsDrained(dataDir: string): void {
  const bridge = join(dataDir, "session-review-jobs", "jobs");
  if (existsSync(bridge)) for (const name of readdirSync(bridge)) {
    if (/^srj_[A-Za-z0-9_-]{8,64}\.json$/u.test(name)) settled(join(bridge, name), "bridge");
  }
  const campaign = join(dataDir, "campaign-review-jobs");
  if (existsSync(campaign)) for (const name of readdirSync(campaign)) {
    if (/^review_[a-f0-9-]{36}$/u.test(name)) settled(join(campaign, name, "state.json"), "campaign");
  }
}

/** Compatibility tombstone only: replay a settled receipt verbatim. A missing record cannot
 * prove that a prior runner never launched, so retain unknown usage. No subprocess or writes. */
export function retiredReviewReceipt(dataDir: string, kind: "bridge" | "campaign", jobId: string, nonce: string): Receipt {
  const valid = kind === "bridge" ? /^srj_[A-Za-z0-9_-]{8,64}$/u.test(jobId) : /^review_[a-f0-9-]{36}$/u.test(jobId);
  if (!valid || typeof nonce !== "string" || !nonce || nonce.length > 256) throw new Error("Invalid retired review identity");
  const path = kind === "bridge" ? join(dataDir, "session-review-jobs", "jobs", `${jobId}.json`)
    : join(dataDir, "campaign-review-jobs", jobId, "state.json");
  if (existsSync(path)) {
    const state = settled(path, kind);
    if (state.command.jobId !== jobId || state.command.nonce !== nonce) throw new Error("Retired review receipt identity mismatch");
    return state.update!;
  }
  return kind === "bridge"
    ? { type: "session_review_job_update", jobId, nonce, state: "failed", reason: REVIEW_JOBS_RETIRED_REASON }
    : { type: "campaign_review_job_update", jobId, nonce, state: "accounting_unavailable", toolCalls: 0,
        reason: REVIEW_JOBS_RETIRED_REASON };
}
