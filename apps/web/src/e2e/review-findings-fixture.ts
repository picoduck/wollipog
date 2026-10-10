/**
 * Review findings held in memory for the Review harnesses (#2851): the reads, creates and status
 * changes the panel sends, answered as the control plane would, so adding, resolving and reopening a
 * finding round-trips in the browser.
 *
 * {@link checkoutFindings} seeds two findings on the file-section fixture's checkout file
 * (`diff-sections-fixture.ts`): an open one on the new `useMemo(` line and a resolved one on the
 * `Intl.NumberFormat` line. Their author id is a raw user id, which nothing on screen may print.
 */
import type {
  CreateReviewFindingRequest,
  ReviewFinding,
  ReviewFindingsResponse,
  UpdateReviewFindingRequest,
} from "@wollipog/protocol";
import { CHECKOUT_PATH } from "./diff-sections-fixture.js";

const MINUTE = 60_000;

export function checkoutFindings(sessionId: string, diffHash: string, now = Date.now()): ReviewFinding[] {
  const base = {
    sessionId, scope: "uncommitted" as const, diffHash, filePath: CHECKOUT_PATH, side: "right" as const,
    source: "local" as const, author: { kind: "human" as const, id: "usr_7c1e9a42b3" },
  };
  return [
    {
      ...base, findingId: "rf_checkout_memo", line: 19, anchorText: "  const total = useMemo(",
      body: "Memoizing on the whole discounts array recomputes the total on every keystroke in the coupon field. Key it on the discount ids instead.",
      severity: "major", required: true, status: "open", createdAt: now - 12 * MINUTE, updatedAt: now - 12 * MINUTE,
    },
    {
      ...base, findingId: "rf_checkout_locale", line: 84,
      anchorText: "  return new Intl.NumberFormat(undefined, { style: \"currency\", currency }).format(total);",
      body: "Pass the shopper's locale, so the total matches the receipt.\nIntl falls back to the server's otherwise.",
      severity: "minor", required: false, status: "resolved", createdAt: now - 40 * MINUTE, updatedAt: now - 5 * MINUTE,
    },
  ];
}

export function inMemoryReviewFindings(seed: ReviewFinding[]) {
  const findings = structuredClone(seed);
  let next = 1;
  const respond = (): ReviewFindingsResponse => {
    const open = findings.filter((finding) => finding.status === "open" || finding.status === "sent");
    const requiredUnresolved = open.filter((finding) => finding.required).length;
    return {
      findings: structuredClone(findings),
      summary: {
        total: findings.length,
        unresolved: open.length,
        requiredUnresolved,
        sent: findings.filter((finding) => finding.status === "sent").length,
        resolved: findings.filter((finding) => finding.status === "resolved").length,
        dismissed: findings.filter((finding) => finding.status === "dismissed").length,
        completion: requiredUnresolved > 0 ? "blocked" : open.length > 0 ? "in_review" : "complete",
      },
    };
  };
  return {
    reviewFindings: async () => respond(),
    createReviewFinding: async (sessionId: string, body: CreateReviewFindingRequest) => {
      const now = Date.now();
      findings.push({
        ...body, findingId: `rf_created_${next++}`, sessionId, status: "open", source: "local",
        author: { kind: "human", id: "usr_7c1e9a42b3" }, createdAt: now, updatedAt: now,
      });
      return respond();
    },
    updateReviewFinding: async (_sessionId: string, findingId: string, body: UpdateReviewFindingRequest) => {
      const finding = findings.find((candidate) => candidate.findingId === findingId);
      if (finding) Object.assign(finding, { status: body.status, updatedAt: Date.now() });
      return respond();
    },
  };
}
