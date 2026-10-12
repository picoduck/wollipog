import type { McpTool } from "./session-management-mcp.js";
import { reviewVideoEvidenceFrames, submitVideoEvidenceVerdict, type VideoReviewTransport } from "./video-evidence-review-transport.js";
import { mediaOnlyToolSet } from "./evidence-review-namespace.js";

/** Created only by the managed media Session adapter from its exact server/runner grant.
 * The actual provider must additionally have strict MCP config, disabled generic tools and the
 * narrowed namespace. Listing two tools alone is never an isolation or live-validation proof. */
export function scopedVideoReviewTools(deps: {
  transport: VideoReviewTransport;
  actualSessionId: string;
  /** Current actual Session/admission, provider tool-image capability and enforced namespace.
   * Caller is the trusted runner, never model input or a code-review job receipt. */
  current(): boolean;
}): McpTool[] {
  const allowed = () => {
    try { return deps.actualSessionId === deps.transport.grant.reviewerSessionId && deps.current(); }
    catch { return false; }
  };
  const refused = () => ({ content: [{ type: "text" as const, text: "The exact managed media Session grant is unavailable." }] as [{ type: "text"; text: string }], isError: true });
  const tools: McpTool[] = [
    {
      name: "review_video_evidence_frame",
      description: "Inspect the next complete consecutive native video-frame window for this exact grant. Every image has its source timestamp and receipt. Continue at nextIndex until frameCount; these receipts alone are not a quality verdict.",
      inputSchema: { type: "object", properties: { index: { type: "integer", minimum: 0, maximum: 899 } },
        required: ["index"], additionalProperties: false },
      handler: async (args) => allowed() ? reviewVideoEvidenceFrames(args, deps.transport) : refused(),
    },
    {
      name: "submit_video_evidence_verdict",
      description: "Record pass/fail/blocked observations for every pinned criterion after inspecting every source frame. This records the actual worker's quality verdict; the authorized owner separately resolves the original typed UI gate.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["report"], properties: {
          report: { type: "object", additionalProperties: false, required: ["outcome", "criteria", "rationale"], properties: {
            outcome: { type: "string", enum: ["accept", "reject"] }, rationale: { type: "string", minLength: 1, maxLength: 8000 },
            criteria: { type: "array", minItems: 1, maxItems: 64, items: {
              type: "object", additionalProperties: false, required: ["criterionId", "outcome", "observedFrameIndices", "observation"],
              properties: { criterionId: { type: "string", minLength: 1, maxLength: 256 },
                outcome: { type: "string", enum: ["pass", "fail", "blocked"] },
                observedFrameIndices: { type: "array", minItems: 1, maxItems: 900, uniqueItems: true,
                  items: { type: "integer", minimum: 0, maximum: 899 } },
                observation: { type: "string", minLength: 1, maxLength: 4000 } },
            } },
          } },
        },
      },
      handler: async (args) => !allowed() ? refused() : args && typeof args === "object" &&
        Object.keys(args).length === 1 && Object.hasOwn(args, "report")
        ? submitVideoEvidenceVerdict(args.report, deps.transport) : refused(),
    },
  ];
  if (!mediaOnlyToolSet(tools.map((tool) => tool.name))) throw new Error("Media MCP registry is broader than the allowed namespace.");
  return tools;
}

/** Enforce the allowlist at dispatch as well as discovery; hiding extra names alone is insufficient. */
export function findScopedVideoReviewTool(tools: readonly McpTool[], name: string): McpTool | null {
  if (!mediaOnlyToolSet(tools.map((tool) => tool.name))) return null;
  return tools.find((tool) => tool.name === name) ?? null;
}
