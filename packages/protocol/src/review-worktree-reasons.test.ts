import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizedReviewSessionReason, sanitizedSessionReviewReason } from "./index.js";

test("both review routes preserve actionable automatic-worktree refusals and redact unknown details", () => {
  for (const sanitize of [sanitizedReviewSessionReason, sanitizedSessionReviewReason]) {
    for (const reason of [
      "resume this session once so the runner can verify its automatic worktree before requesting a review",
      "the automatic worktree is no longer registered on this session's expected branch; restore it before requesting a review",
    ]) assert.equal(sanitize(reason), reason);
    assert.equal(sanitize("cannot open /private/path"), "the review could not be completed; see the runner log");
  }
});
