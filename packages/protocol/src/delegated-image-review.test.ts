import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DELEGATED_IMAGE_REVIEW_DEFECT_MAX_CHARS,
  DELEGATED_IMAGE_REVIEW_MAX_DEFECTS,
  DELEGATED_IMAGE_REVIEW_SUMMARY_MAX_CHARS,
  delegatedImageReviewReportError,
} from "./delegated-image-review.js";

const ids = ["light", "dark"];
const pass = (evidenceId: string) => ({ evidenceId, outcome: "pass", defects: [] });
const fail = (evidenceId: string, defects = ["The label is clipped."]) => ({ evidenceId, outcome: "fail", defects });

test("a delegated image review report covers every evidence item exactly once with a consistent recommendation", () => {
  assert.equal(delegatedImageReviewReportError({ recommendation: "approve", summary: "All good.", items: ids.map(pass) }, ids), null);
  assert.equal(delegatedImageReviewReportError({ recommendation: "deny", summary: "Dark is clipped.",
    items: [pass("light"), fail("dark")] }, ids), null);

  for (const [report, reason] of [
    [null, /object/u],
    [{ recommendation: "approve", summary: "x", items: ids.map(pass), extra: true }, /exactly/u],
    [{ recommendation: "maybe", summary: "x", items: ids.map(pass) }, /approve or deny/u],
    [{ recommendation: "approve", summary: " ", items: ids.map(pass) }, /summary/u],
    [{ recommendation: "approve", summary: "x".repeat(DELEGATED_IMAGE_REVIEW_SUMMARY_MAX_CHARS + 1), items: ids.map(pass) }, /summary/u],
    [{ recommendation: "approve", summary: "x", items: [pass("light")] }, /each of the 2/u],
    [{ recommendation: "approve", summary: "x", items: [pass("light"), pass("light")] }, /exactly once/u],
    [{ recommendation: "approve", summary: "x", items: [pass("light"), pass("other")] }, /exactly once/u],
    [{ recommendation: "approve", summary: "x", items: [pass("light"), { ...pass("dark"), note: "y" }] }, /exactly evidenceId/u],
    [{ recommendation: "approve", summary: "x", items: [pass("light"), { ...pass("dark"), outcome: "ok" }] }, /pass or fail/u],
    [{ recommendation: "deny", summary: "x", items: [pass("light"), fail("dark", [])] }, /name the defects/u],
    [{ recommendation: "approve", summary: "x", items: [pass("light"), { ...pass("dark"), defects: ["nit"] }] }, /cannot list defects/u],
    [{ recommendation: "deny", summary: "x", items: [pass("light"),
      fail("dark", Array.from({ length: DELEGATED_IMAGE_REVIEW_MAX_DEFECTS + 1 }, () => "d"))] }, /defects must be/u],
    [{ recommendation: "deny", summary: "x", items: [pass("light"),
      fail("dark", ["d".repeat(DELEGATED_IMAGE_REVIEW_DEFECT_MAX_CHARS + 1)])] }, /defects must be/u],
    [{ recommendation: "deny", summary: "x", items: [pass("light"), fail("dark", ["bad\u0000byte"])] }, /defects must be/u],
    [{ recommendation: "approve", summary: "x", items: [pass("light"), fail("dark")] }, /every item to pass/u],
    [{ recommendation: "deny", summary: "x", items: ids.map(pass) }, /at least one failed/u],
  ] as const) {
    assert.match(delegatedImageReviewReportError(report, ids) ?? "", reason, JSON.stringify(report)?.slice(0, 120));
  }
});
