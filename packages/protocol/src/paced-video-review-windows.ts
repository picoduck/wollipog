import type { PacedVideoTransportGrant } from "./paced-video-review.js";
import type { MediaActiveStopIdentity } from "./media-active-stop.js";
import type { MediaDispatchFenceIdentity } from "./media-dispatch-fence.js";
import type { StartSessionMessage } from "./index.js";

/** Fresh-context delivery windows (#1321). One Claude Code conversation resends its whole base64
 * history on every request, so the 32 MB API request cap binds long before the context window.
 * Each window is a separate provider conversation; every frame stays model-visible exactly where
 * the plan places it, and the runner carries every prior window's validated structured notes. */
export const PACED_VIDEO_REVIEW_WINDOW_LIMITS = Object.freeze({
  revision: 1 as const,
  frames: 60,
  base64Bytes: 24 * 1024 * 1024,
  overlapFrames: 1,
  notesChars: 6_000,
  maxWindows: 32,
  /** A window whose notes are missing or invalid is rerun once; it is never truncated. */
  notesAttempts: 2,
});
export type PacedVideoReviewWindowLimits = typeof PACED_VIDEO_REVIEW_WINDOW_LIMITS;
export interface PacedVideoReviewWindow { index: number; firstIndex: number; endIndex: number; final: boolean }
export interface PacedVideoReviewWindowPlan {
  limits: PacedVideoReviewWindowLimits;
  frameCount: number;
  windows: PacedVideoReviewWindow[];
}

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
/** Deterministic from the immutable grant alone, so the runner and the control plane derive the
 * identical plan and both can bind its digest. Throws rather than returning a partial plan. */
export function pacedVideoReviewWindowPlan(frames: PacedVideoTransportGrant["frames"]): PacedVideoReviewWindowPlan {
  const limits = PACED_VIDEO_REVIEW_WINDOW_LIMITS;
  if (!Array.isArray(frames) || !frames.length || frames.length > 900 || frames.some((frame, index) =>
    !frame || frame.index !== index || !Number.isSafeInteger(frame.sizeBytes) || frame.sizeBytes <= 0 ||
    base64Length(frame.sizeBytes) > limits.base64Bytes)) throw new Error("A complete bounded frame manifest is required.");
  const windows: PacedVideoReviewWindow[] = [];
  let first = 0;
  for (;;) {
    let end = first, bytes = 0;
    while (end < frames.length && end - first < limits.frames) {
      const size = base64Length(frames[end]!.sizeBytes);
      if (end > first && bytes + size > limits.base64Bytes) break;
      bytes += size; end++;
    }
    windows.push({ index: windows.length, firstIndex: first, endIndex: end, final: end === frames.length });
    if (windows.length > limits.maxWindows) throw new Error("The capture needs more delivery windows than the reviewed profile allows.");
    if (end === frames.length) break;
    // The overlap frame repeats the last frame of the previous window so a transition at the
    // boundary is seen from both sides. A one-frame window cannot overlap and still progress.
    first = end - limits.overlapFrames > first ? end - limits.overlapFrames : end;
  }
  return { limits, frameCount: frames.length, windows };
}
/** Stable serialization for the plan digest (hashed by Node consumers; this module stays pure). */
export function pacedVideoReviewWindowPlanBody(plan: PacedVideoReviewWindowPlan): string {
  return JSON.stringify({ limits: { ...plan.limits }, frameCount: plan.frameCount,
    windows: plan.windows.map(({ index, firstIndex, endIndex, final }) => ({ index, firstIndex, endIndex, final })) });
}

/** Structured notes a non-final window must end with. Every frame of the window is covered by an
 * observation range, and every transient names its exact index and native presentation time. */
export interface PacedVideoReviewWindowNotes {
  window: { firstIndex: number; endIndex: number };
  observations: Array<{ fromIndex: number; toIndex: number; description: string }>;
  transients: Array<{ index: number; ptsUs: number; description: string }>;
  defects: Array<{ criterionId: string; frameIndices: number[]; description: string }>;
}
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const prose = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 1_000;
const integer = (value: unknown): value is number => Number.isSafeInteger(value);

/** Accepts the whole final message as JSON, or one fenced ```json block and nothing else. */
export function parsePacedVideoReviewWindowNotes(text: unknown): unknown {
  if (typeof text !== "string" || text.length > PACED_VIDEO_REVIEW_WINDOW_LIMITS.notesChars + 64) return null;
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\n([\s\S]*)\n```$/u.exec(trimmed);
  try { return JSON.parse(fenced ? fenced[1]! : trimmed); } catch { return null; }
}
export function validPacedVideoReviewWindowNotes(value: unknown, window: PacedVideoReviewWindow,
  frames: PacedVideoTransportGrant["frames"]): value is PacedVideoReviewWindowNotes {
  if (!exact(value, ["window", "observations", "transients", "defects"]) ||
    JSON.stringify(value).length > PACED_VIDEO_REVIEW_WINDOW_LIMITS.notesChars ||
    !exact(value.window, ["firstIndex", "endIndex"]) ||
    value.window.firstIndex !== window.firstIndex || value.window.endIndex !== window.endIndex) return false;
  const inWindow = (index: unknown) => integer(index) && index >= window.firstIndex && index < window.endIndex;
  const observations = value.observations, transients = value.transients, defects = value.defects;
  if (!Array.isArray(observations) || !observations.length || observations.length > 60 ||
    !Array.isArray(transients) || transients.length > 60 || !Array.isArray(defects) || defects.length > 32) return false;
  // Contiguous, ordered and complete: the notes must account for every frame in the window.
  let next = window.firstIndex;
  for (const observation of observations) {
    if (!exact(observation, ["fromIndex", "toIndex", "description"]) || observation.fromIndex !== next ||
      !inWindow(observation.toIndex) || (observation.toIndex as number) < next || !prose(observation.description)) return false;
    next = (observation.toIndex as number) + 1;
  }
  if (next !== window.endIndex) return false;
  return transients.every((transient) => exact(transient, ["index", "ptsUs", "description"]) && inWindow(transient.index) &&
      transient.ptsUs === frames[transient.index as number]!.ptsUs && prose(transient.description)) &&
    defects.every((defect) => exact(defect, ["criterionId", "frameIndices", "description"]) &&
      typeof defect.criterionId === "string" && defect.criterionId.length > 0 && defect.criterionId.length <= 256 &&
      !/[\x00-\x1f\x7f]/u.test(defect.criterionId) && Array.isArray(defect.frameIndices) && defect.frameIndices.length > 0 &&
      defect.frameIndices.length <= 60 && new Set(defect.frameIndices).size === defect.frameIndices.length &&
      defect.frameIndices.every(inWindow) && prose(defect.description));
}

/** Runner-attested installed reviewer. Claude Code only: Codex cannot prove a media-only tool
 * allowlist and keeps its specific refusal. Attestation is not live validation or admission. */
export interface ClaudeMediaReviewerAttestation {
  profile: "claude-code-media-only-v1";
  harness: "claude-code";
  agentId: string;
  cliVersion: string;
  executableSha256: string;
  /** Stable namespace policy (runtime roots, network files, relay, executable, tool set). */
  namespacePolicySha256: string;
  tools: readonly ["review_video_evidence_frame", "submit_video_evidence_verdict"];
  /** A runner-local key provisioned for this reviewer only; never the operator's own login. */
  credential: "dedicated_api_key";
  windowLimitsRevision: PacedVideoReviewWindowLimits["revision"];
}

/** Dedicated media dispatch. Generic start/restart keeps refusing `mediaReviewPurpose`. */
export interface MediaReviewDispatch {
  identity: MediaActiveStopIdentity;
  /** The exact prepared command whose JSON digest is `identity.commandSha256`. */
  command: StartSessionMessage;
  grant: PacedVideoTransportGrant;
  /** sha256 of `pacedVideoReviewWindowPlanBody(pacedVideoReviewWindowPlan(grant.frames))`. */
  deliveryPlanSha256: string;
  /** sha256 of the exact runner attestation the control plane admitted. */
  attestationSha256: string;
}
export interface MediaReviewDispatchReceipt extends MediaDispatchFenceIdentity {
  outcome: "accepted" | "unknown";
  deliveryPlanSha256: string;
  namespaceLaunchSha256?: string;
  receiptSha256: string;
}
export interface MediaReviewFinished extends MediaDispatchFenceIdentity {
  /** `completed` means every window ran and the verdict tool confirmed; never typed approval. */
  outcome: "completed" | "failed";
  reason?: string;
  deliveryPlanSha256: string;
  windowsCompleted: number;
  verdictConfirmed: boolean;
  toolCalls: number;
  /** Provider-reported list price summed over windows; absent when any window was unpriced. */
  costUsd?: number;
  priced: boolean;
  receiptSha256: string;
}
