import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEW_SESSION_ONLY_MIN_PROTOCOL, RUNNER_CAPABILITY_MIN_PROTOCOL, REVIEW_JOBS_RETIRED_REASON,
  reviewRetirementPeerRefusal, sanitizedCampaignReviewReason, sanitizedSessionReviewReason } from "./index.js";

test("retirement capability, registration floor and receipt reasons share the migration contract", () => {
  assert.equal(REVIEW_SESSION_ONLY_MIN_PROTOCOL, RUNNER_CAPABILITY_MIN_PROTOCOL.reviewSessionOnly);
  assert.equal(reviewRetirementPeerRefusal(REVIEW_SESSION_ONLY_MIN_PROTOCOL), null);
  assert.match(reviewRetirementPeerRefusal(REVIEW_SESSION_ONLY_MIN_PROTOCOL - 1)!, /requires.*control plane/u);
  assert.equal(sanitizedCampaignReviewReason(REVIEW_JOBS_RETIRED_REASON), REVIEW_JOBS_RETIRED_REASON);
  assert.equal(sanitizedSessionReviewReason(REVIEW_JOBS_RETIRED_REASON), REVIEW_JOBS_RETIRED_REASON);
});
