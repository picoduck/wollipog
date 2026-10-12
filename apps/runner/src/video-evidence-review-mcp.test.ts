import assert from "node:assert/strict";
import { test } from "node:test";
import type { PacedVideoTransportGrant } from "@wollipog/protocol";
import { scopedVideoReviewTools, findScopedVideoReviewTool } from "./video-evidence-review-mcp.js";
import type { VideoReviewTransport } from "./video-evidence-review-transport.js";

/** Registry/credential guard tests only; no actual Session, model or image handoff. */
test("media MCP discovery and dispatch exclude generic files, management, uploads and code-review jobs", () => {
  const transport: VideoReviewTransport = {
    grant: { reviewerSessionId: "actual-media-session" } as PacedVideoTransportGrant,
    request: async () => { throw new Error("No transport should be called."); }, now: () => 1_000,
  };
  const tools = scopedVideoReviewTools({ transport, actualSessionId: "actual-media-session", current: () => false });
  assert.deepEqual(tools.map((tool) => tool.name), ["review_video_evidence_frame", "submit_video_evidence_verdict"]);
  for (const name of ["Read", "Bash", "get_session", "attach_session_artifact", "run_campaign_review_job", "fetch_url"]) {
    assert.equal(findScopedVideoReviewTool(tools, name), null);
  }
  assert.equal(findScopedVideoReviewTool([...tools, { ...tools[0]!, name: "Read" }], tools[0]!.name), null);
});
test("changed current admission and a code-job identity cannot borrow the actual media Session's tool grant", async () => {
  let requests = 0;
  const transport: VideoReviewTransport = {
    grant: { reviewerSessionId: "media-session" } as PacedVideoTransportGrant,
    request: async () => { requests++; throw new Error("No actual model or media."); }, now: () => 1_000,
  };
  for (const [actualSessionId, current] of [["media-session", false], ["review_code_job", true], ["implementer", true]] as const) {
    const tools = scopedVideoReviewTools({ transport, actualSessionId, current: () => current });
    for (const tool of tools) {
      const result = await tool.handler({ index: 0, report: { outcome: "accept" } }, {} as never);
      assert.equal(result.isError, true);
    }
  }
  assert.equal(requests, 0);
});
