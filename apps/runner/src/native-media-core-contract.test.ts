import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { scopedVideoReviewTools } from "./video-evidence-review-mcp.js";
import type { PacedVideoTransportGrant } from "@wollipog/protocol";

test("native companion tool schemas exactly match the guarded temporal transport contract", () => {
  const tools = scopedVideoReviewTools({ actualSessionId: "synthetic", current: () => false,
    transport: { grant: { reviewerSessionId: "synthetic" } as PacedVideoTransportGrant, now: () => 1,
      request: async () => { assert.fail("No model, SDK or frame delivery in schema tests"); } } });
  const native = JSON.parse(readFileSync(new URL("../native-media-core/scoped-tools.json", import.meta.url), "utf8"));
  assert.deepEqual(native, tools.map(({ name, description, inputSchema }) => ({
    type: "function", name, description, inputSchema, deferLoading: false,
  })));
});
