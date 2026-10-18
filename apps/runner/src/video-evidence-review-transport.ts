import { createHash } from "node:crypto";
import { PACED_VIDEO_REVIEW_BATCH_LIMITS, type PacedVideoReviewDelivery, type PacedVideoReviewBatchDelivery, type PacedVideoTransportGrant } from "@wollipog/protocol";
import type { ToolResult } from "./session-management-mcp.js";

export interface VideoReviewTransport {
  /** Server/runner-owned grant. No caller-selected source, review, Session, URL or filesystem. */
  grant: PacedVideoTransportGrant;
  request(action: "frame" | "frames" | "acknowledge" | "acknowledge-frames" | "verdict", body: Record<string, unknown>): Promise<unknown>;
  now(): number;
}
const failure = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function validGrant(grant: PacedVideoTransportGrant, now: number): boolean {
  return Boolean(grant && typeof grant === "object" && Array.isArray(grant.frames) && Number.isSafeInteger(now) && grant.expiresAt > now &&
    (grant.operatorValidation === undefined || grant.operatorValidation && Object.keys(grant.operatorValidation).length === 2 &&
      typeof grant.operatorValidation.permitId === "string" && grant.operatorValidation.permitId.length > 0 &&
      grant.operatorValidation.permitId.length <= 256 && digest(grant.operatorValidation.scopeSha256)) &&
    grant.frames.length > 0 && grant.frames.length <= 900 &&
    [grant.sourceSha256, grant.manifestSha256, grant.bindingSha256, grant.criteriaSha256, grant.deliveryPlanSha256].every(digest) &&
    grant.frames.every((frame, index) => frame.index === index && digest(frame.sha256) &&
      Number.isSafeInteger(frame.sizeBytes) && frame.sizeBytes > 0 && frame.sizeBytes <= 2 * 1024 * 1024 &&
      Number.isSafeInteger(frame.ptsUs) && frame.ptsUs >= 0 && Number.isSafeInteger(frame.durationUs) && frame.durationUs > 0));
}
function verifiedDelivery(candidate: unknown, grant: PacedVideoTransportGrant, index: number): candidate is PacedVideoReviewDelivery {
  const delivery = candidate as PacedVideoReviewDelivery;
  const frame = grant.frames[index]!;
    const receipt = delivery?.receipt;
    const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
    if (!exact(delivery, ["receipt", "mimeType", "sizeBytes", "data"]) ||
      !exact(receipt, ["receiptId", "occurrenceId", "reviewerSessionId", "childSessionId", "policyRevision",
        "evidenceId", "artifactId", "sha256", "deliveredAt", "deliveryOrder", "videoFrame", "bindingSha256", "criteriaSha256",
        "deliveryPlanSha256", "windowIndex",
        ...(grant.operatorValidation ? ["operatorValidation"] : [])]) ||
      JSON.stringify(receipt.operatorValidation) !== JSON.stringify(grant.operatorValidation) ||
      !exact(receipt.videoFrame, ["sourceArtifactId", "sourceSha256", "manifestSha256", "profile", "index", "ptsMs", "ptsUs", "durationUs"]) ||
      !Number.isSafeInteger(receipt.deliveredAt) || receipt.deliveredAt <= 0 || receipt.deliveredAt >= grant.expiresAt) return false;
    const temporal = receipt?.videoFrame;
    if (!receipt || !temporal || delivery.mimeType !== "image/png" || delivery.sizeBytes !== frame.sizeBytes ||
      typeof delivery.data !== "string" || delivery.data.length > Math.ceil(frame.sizeBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(delivery.data) ||
      receipt.reviewerSessionId !== grant.reviewerSessionId || receipt.childSessionId !== grant.childSessionId ||
      receipt.occurrenceId !== grant.occurrenceId || receipt.policyRevision !== grant.policyRevision ||
      receipt.bindingSha256 !== grant.bindingSha256 || receipt.criteriaSha256 !== grant.criteriaSha256 ||
      receipt.deliveryPlanSha256 !== grant.deliveryPlanSha256 || !Number.isSafeInteger(receipt.windowIndex) || receipt.windowIndex < 0 ||
      receipt.artifactId !== grant.reviewId + ":frame:" + index ||
      receipt.evidenceId !== grant.sourceEvidenceId ||
      !receipt.receiptId || receipt.receiptId.length > 256 || receipt.sha256 !== frame.sha256 ||
      !Number.isSafeInteger(receipt.deliveryOrder) || receipt.deliveryOrder <= 0 ||
      temporal.profile !== "paced-silent-complete-frames-v1" || temporal.index !== index ||
      temporal.sourceArtifactId !== grant.sourceArtifactId || temporal.sourceSha256 !== grant.sourceSha256 ||
      temporal.manifestSha256 !== grant.manifestSha256 || temporal.ptsUs !== frame.ptsUs ||
      temporal.ptsMs !== frame.ptsUs / 1000 || temporal.durationUs !== frame.durationUs) {
      return false;
    }
    const bytes = Buffer.from(delivery.data, "base64");
    if (bytes.length !== frame.sizeBytes || bytes.toString("base64") !== delivery.data ||
      createHash("sha256").update(bytes).digest("hex") !== frame.sha256) {
      return false;
    }
    return true;
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
  try {
    const delivery = await deps.request("frame", { reviewId: grant.reviewId, index }) as PacedVideoReviewDelivery;
    if (!verifiedDelivery(delivery, grant, Number(index))) return failure("Delivered media does not match this exact temporal review grant.");
    const receipt = delivery.receipt;
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
      operatorValidation?: PacedVideoTransportGrant["operatorValidation"];
    };
    if (!result?.verdictId || result.reviewId !== deps.grant.reviewId ||
      result.reviewerSessionId !== deps.grant.reviewerSessionId || result.bindingSha256 !== deps.grant.bindingSha256 ||
      JSON.stringify(result.operatorValidation) !== JSON.stringify(deps.grant.operatorValidation) ||
      !["accept", "reject"].includes(result.outcome ?? "")) return failure("The verdict response does not match this exact review.");
    return { content: [{ type: "text", text: JSON.stringify({ verdictId: result.verdictId, reviewId: result.reviewId,
      outcome: result.outcome, typedDecisionResolved: false,
      ...(result.operatorValidation ? { operatorValidation: result.operatorValidation, productionProof: false } : {}) }) }] };
  } catch { return failure("The criterion verdict was not confirmed; reconcile its durable record before retrying."); }
}

/** Bounded consecutive multi-image handoff. Every image is independently verified and the
 * complete window is atomically acknowledged before any image leaves this handler. */
export async function reviewVideoEvidenceFrames(args: unknown, deps: VideoReviewTransport): Promise<ToolResult> {
  const grant = deps.grant;
  if (!validGrant(grant, deps.now()) || !args || typeof args !== "object" || Array.isArray(args) ||
    Object.keys(args).length !== 1 || !Object.hasOwn(args, "index")) return failure("A current exact grant and source-frame index are required.");
  const first = (args as { index: number }).index;
  if (!Number.isSafeInteger(first) || first < 0 || first >= grant.frames.length) return failure("The source-frame index is outside this grant.");
  try {
    const batch = await deps.request("frames", { reviewId: grant.reviewId, index: first }) as PacedVideoReviewBatchDelivery;
    if (!batch || typeof batch !== "object" || Object.keys(batch).length !== 3 ||
      Object.keys(batch).some((key) => !["deliveries", "nextIndex", "frameCount"].includes(key)) ||
      !Array.isArray(batch.deliveries) || !batch.deliveries.length || batch.deliveries.length > PACED_VIDEO_REVIEW_BATCH_LIMITS.frames ||
      batch.nextIndex !== first + batch.deliveries.length || batch.nextIndex > grant.frames.length ||
      batch.frameCount !== grant.frames.length) return failure("A complete consecutive bounded frame window is required.");
    let responseBytes = 4096, order = 0;
    for (const [offset, delivery] of batch.deliveries.entries()) {
      if (!verifiedDelivery(delivery, grant, first + offset) || delivery.receipt.deliveryOrder <= order) {
        return failure("The frame window has changed identity, pixels, timing or order; every image is withheld.");
      }
      order = delivery.receipt.deliveryOrder;
      responseBytes += Buffer.byteLength(JSON.stringify(delivery)) + 1;
      if (responseBytes > PACED_VIDEO_REVIEW_BATCH_LIMITS.responseBytes) return failure("The image response exceeds its disclosed bounded transport profile.");
    }
    if (!validGrant(grant, deps.now())) return failure("The exact grant expired before verified batch handoff.");
    const acknowledged = await deps.request("acknowledge-frames", { reviewId: grant.reviewId,
      receipts: batch.deliveries.map((d) => ({ receiptId: d.receipt.receiptId, sha256: d.receipt.sha256 })) }) as { acknowledged?: boolean };
    if (acknowledged?.acknowledged !== true) return failure("The entire frame window was not acknowledged; every image is withheld.");
    const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify({
      firstIndex: first, nextIndex: batch.nextIndex, frameCount: batch.frameCount,
      manifestSha256: grant.manifestSha256, criteriaSha256: grant.criteriaSha256, qualityVerdictRecorded: false,
    }) }];
    for (const delivery of batch.deliveries) {
      content.push({ type: "text", text: JSON.stringify({ receipt: delivery.receipt, sizeBytes: delivery.sizeBytes }) });
      content.push({ type: "image", data: delivery.data, mimeType: delivery.mimeType });
    }
    return { content };
  } catch { return failure("The exact batch handoff is unavailable; reconcile before retrying this source window."); }
}
