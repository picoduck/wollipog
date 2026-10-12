import { createHash } from "node:crypto";
import type { PacedVideoReviewDelivery, PacedVideoTransportGrant } from "@wollipog/protocol";
import type { ToolResult } from "./session-management-mcp.js";

export interface VideoReviewTransport {
  /** Server/runner-owned grant. No caller-selected source, review, Session, URL or filesystem. */
  grant: PacedVideoTransportGrant;
  request(action: "frame" | "acknowledge" | "verdict", body: Record<string, unknown>): Promise<unknown>;
  now(): number;
}
const failure = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function validGrant(grant: PacedVideoTransportGrant, now: number): boolean {
  return Boolean(grant && typeof grant === "object" && Array.isArray(grant.frames) && Number.isSafeInteger(now) && grant.expiresAt > now &&
    grant.frames.length > 0 && grant.frames.length <= 900 &&
    [grant.sourceSha256, grant.manifestSha256, grant.bindingSha256, grant.criteriaSha256].every(digest) &&
    grant.frames.every((frame, index) => frame.index === index && digest(frame.sha256) &&
      Number.isSafeInteger(frame.sizeBytes) && frame.sizeBytes > 0 && frame.sizeBytes <= 2 * 1024 * 1024 &&
      Number.isSafeInteger(frame.ptsUs) && frame.ptsUs >= 0 && Number.isSafeInteger(frame.durationUs) && frame.durationUs > 0));
}
/** The same digest-verified native frame handed to the model is acknowledged through this
 * exact Session's authenticated transport. Unit transport tests are not live model proof. */
export async function reviewVideoEvidenceFrame(args: unknown, deps: VideoReviewTransport): Promise<ToolResult> {
  const grant = deps.grant;
  if (!validGrant(grant, deps.now())) return failure("This exact video review grant is expired or unavailable.");
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1 ||
      !Object.hasOwn(args, "index")) return failure("Only a source-frame index is accepted.");
  const index = (args as { index: unknown }).index;
  if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= grant.frames.length) return failure("The source-frame index is outside this grant.");
  const frame = grant.frames[Number(index)]!;
  try {
    const delivery = await deps.request("frame", { reviewId: grant.reviewId, index }) as PacedVideoReviewDelivery;
    const receipt = delivery?.receipt;
    const temporal = receipt?.videoFrame;
    if (!receipt || !temporal || delivery.mimeType !== "image/png" || delivery.sizeBytes !== frame.sizeBytes ||
      typeof delivery.data !== "string" || delivery.data.length > Math.ceil(frame.sizeBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(delivery.data) ||
      receipt.reviewerSessionId !== grant.reviewerSessionId || receipt.childSessionId !== grant.childSessionId ||
      receipt.occurrenceId !== grant.occurrenceId || receipt.policyRevision !== grant.policyRevision ||
      receipt.bindingSha256 !== grant.bindingSha256 || receipt.criteriaSha256 !== grant.criteriaSha256 ||
      receipt.artifactId !== grant.reviewId + ":frame:" + index ||
      receipt.evidenceId !== grant.sourceArtifactId + ":frame:" + index ||
      !receipt.receiptId || receipt.receiptId.length > 256 || receipt.sha256 !== frame.sha256 ||
      !Number.isSafeInteger(receipt.deliveryOrder) || receipt.deliveryOrder <= 0 ||
      temporal.profile !== "paced-silent-complete-frames-v1" || temporal.index !== index ||
      temporal.sourceArtifactId !== grant.sourceArtifactId || temporal.sourceSha256 !== grant.sourceSha256 ||
      temporal.manifestSha256 !== grant.manifestSha256 || temporal.ptsUs !== frame.ptsUs ||
      temporal.ptsMs !== frame.ptsUs / 1000 || temporal.durationUs !== frame.durationUs) {
      return failure("Delivered media does not match this exact temporal review grant.");
    }
    const bytes = Buffer.from(delivery.data, "base64");
    if (bytes.length !== frame.sizeBytes || bytes.toString("base64") !== delivery.data ||
      createHash("sha256").update(bytes).digest("hex") !== frame.sha256) {
      return failure("Delivered native frame bytes do not match the pinned source derivation.");
    }
    if (!validGrant(grant, deps.now())) return failure("The exact grant expired before verified handoff.");
    const acknowledged = await deps.request("acknowledge", { reviewId: grant.reviewId,
      receiptId: receipt.receiptId, sha256: receipt.sha256 }) as { acknowledged?: boolean };
    if (acknowledged?.acknowledged !== true) return failure("Frame handoff was not acknowledged; the image is withheld.");
    return { content: [
      { type: "text", text: JSON.stringify({ receipt, mimeType: delivery.mimeType, sizeBytes: delivery.sizeBytes,
        frameCount: grant.frames.length, qualityVerdictRecorded: false }) },
      { type: "image", data: delivery.data, mimeType: delivery.mimeType },
    ] };
  } catch {
    // HTTP bodies, tokens, network details and returned pixels must not enter ordinary errors.
    return failure("The exact media handoff is unavailable; reconcile before retrying this frame.");
  }
}
/** A worker verdict is quality provenance only; the authorized owner still resolves/consumes
 * the existing typed gate. This helper cannot choose another review or submit an approval. */
export async function submitVideoEvidenceVerdict(report: unknown, deps: VideoReviewTransport): Promise<ToolResult> {
  if (!validGrant(deps.grant, deps.now()) || !report || typeof report !== "object" || Array.isArray(report) ||
    Object.keys(report).length !== 3 || Object.keys(report).some((key) => !["outcome", "criteria", "rationale"].includes(key))) {
    return failure("A current grant and bounded criterion verdict are required.");
  }
  try {
    const result = await deps.request("verdict", { reviewId: deps.grant.reviewId, report }) as {
      verdictId?: string; reviewId?: string; reviewerSessionId?: string; bindingSha256?: string; outcome?: string;
    };
    if (!result?.verdictId || result.reviewId !== deps.grant.reviewId ||
      result.reviewerSessionId !== deps.grant.reviewerSessionId || result.bindingSha256 !== deps.grant.bindingSha256 ||
      !["accept", "reject"].includes(result.outcome ?? "")) return failure("The verdict response does not match this exact review.");
    return { content: [{ type: "text", text: JSON.stringify({ verdictId: result.verdictId, reviewId: result.reviewId,
      outcome: result.outcome, typedDecisionResolved: false }) }] };
  } catch { return failure("The criterion verdict was not confirmed; reconcile its durable record before retrying."); }
}
