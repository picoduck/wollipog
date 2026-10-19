/**
 * How a cross-model review reads in Review's Cross-Model Reviews (#3369; docs/design-system.md
 * §11.2): "Codex Review" or "Claude Review", where it is in its run, its one state badge, and each of
 * its report's findings with their severity and location. Only a valid report votes or has findings;
 * nothing here parses the reviewer's prose.
 */
import type {
  ReviewReportFinding, ReviewSessionView, SessionReviewHarness, SourceLocation,
} from "@wollipog/protocol";
import { normalizeSourcePath } from "@wollipog/protocol";
import type { StatusTone, StatusValue } from "./status-meta.js";

/** The reviewer is the other model family: Codex reviews Claude Code's work, Claude reviews Codex's. */
export function reviewRunTitle(reviewer: SessionReviewHarness): string {
  return reviewer === "codex" ? "Codex Review" : "Claude Review";
}

/** The run's one state: where it is while it runs, then its verdict. */
export function reviewRunState(run: Pick<ReviewSessionView, "state" | "verdict">): StatusValue<"reviewRun"> {
  switch (run.state) {
    case "requested": return "requested";
    case "running": return "running";
    case "cancelled": return "canceled";
    case "failed": return run.verdict && run.verdict.consumed && run.verdict.failureClass !== "timeout" ? "invalid" : "failed";
    case "completed":
      if (!run.verdict) return "unvalidated";
      if (!run.verdict.valid) return "invalid";
      return run.verdict.effectiveVote === "UPVOTE" ? "upvote" : "downvote";
  }
}

const MODE: Readonly<Record<NonNullable<ReviewSessionView["round"]>["mode"], string>> = {
  full: "Full Review",
  delta: "Changes Since Last Round",
  rebase: "Range-Diff After Rewrite",
};

/** "Round 2 · Epoch 1 · Changes Since Last Round", with the attempt once a round is retried; null
 * until the runner has planned it. */
export function reviewRunRound(round: ReviewSessionView["round"]): string | null {
  if (!round) return null;
  return [`Round ${round.round}`, `Epoch ${round.epoch}`, ...(round.attempt > 1 ? [`Attempt ${round.attempt}`] : []), MODE[round.mode]]
    .join(" · ");
}

/**
 * Why a run that ended without a vote did: the contract's first few reasons for an invalid report,
 * otherwise the fixed reason the runner gave. Null for a run that voted or is still going.
 */
export function reviewRunProblem(run: Pick<ReviewSessionView, "state" | "verdict" | "reason">): string | null {
  if (run.state === "requested" || run.state === "running") return null;
  if (run.verdict && !run.verdict.valid && run.verdict.validationErrors.length) {
    const shown = run.verdict.validationErrors.slice(0, 3).join("; ");
    const more = run.verdict.validationErrors.length - 3;
    return sentence(more > 0 ? `${shown}; and ${more} more` : shown);
  }
  return run.state === "completed" || !run.reason ? null : sentence(run.reason);
}

/** The contract's and the runner's reasons are lower-case clauses; shown alone, each is a sentence. */
function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/u.test(text) ? "" : "."}`;
}

/** The report's severity, as one badge: Critical danger, High warning, Medium and Low neutral. */
export const REPORT_SEVERITY: Readonly<Record<ReviewReportFinding["severity"], { label: string; tone: StatusTone }>> = {
  critical: { label: "Critical", tone: "danger" },
  high: { label: "High", tone: "warning" },
  medium: { label: "Medium", tone: "neutral" },
  low: { label: "Low", tone: "neutral" },
};

/** Where a finding points: "CheckoutPage.tsx:54", the full path as its tooltip, opened in Files. */
export function reportFindingLocation(finding: Pick<ReviewReportFinding, "file" | "line">): {
  label: string; title: string; source: SourceLocation | null;
} {
  const base = finding.file.split("/").filter(Boolean).at(-1) ?? finding.file;
  const path = normalizeSourcePath(finding.file);
  const at = finding.line ? `:${finding.line}` : "";
  return {
    label: `${base}${at}`,
    title: `${finding.file}${at}`,
    source: path ? { path, ...(finding.line ? { line: finding.line } : {}) } : null,
  };
}

/** The finding's detail under its title: what goes wrong, the evidence, and how to check it. */
export function reportFindingDetail(finding: Pick<ReviewReportFinding, "scenario" | "evidence" | "verify">): string {
  return `${finding.scenario} Evidence: ${finding.evidence} Verify: ${finding.verify}`;
}
