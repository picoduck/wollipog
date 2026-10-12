import type { VideoPreparationFailureCode } from "./video-evidence-preparation.js";

/** Recovery is advice/request state, never permission to edit recordings or consume model budget. */
export type EvidenceRecoveryPlan =
  | { action: "retry"; delayMs: number; nextAttempt: number; reason: string }
  | { action: "split" | "recapture"; nextAttempt: number; reason: string;
      preserve: "all_source_frames_native_timing"; requiresNewArtifact: true }
  | { action: "human"; reason: string };

/** One initial capture plus at most two replacements, and two bounded busy retries. In Custom
 * mode the established human fallback is preserved. No plan silently samples or reduces resolution. */
export function planEvidenceRecovery(mode: "custom" | "full_control", code: VideoPreparationFailureCode,
  attempt: number): EvidenceRecoveryPlan {
  if (mode !== "full_control") return { action: "human", reason: "Custom mode retains human evidence recovery." };
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= 2) {
    return { action: "human", reason: "The bounded evidence recovery attempts are exhausted." };
  }
  if (code === "decoder_busy") return { action: "retry", delayMs: attempt === 0 ? 100 : 200,
    nextAttempt: attempt + 1, reason: "Retry the bounded decoder queue; keep the same immutable source." };
  if (code === "decoder_unavailable" || code === "integrity") return {
    action: "human", reason: code === "integrity" ? "The trusted evidence derivation cannot verify complete coverage."
      : "An isolated trusted decoder is unavailable.",
  };
  const split = ["source_limit", "split_capture", "decode_limit"].includes(code);
  return { action: split ? "split" : "recapture", nextAttempt: attempt + 1,
    preserve: "all_source_frames_native_timing", requiresNewArtifact: true,
    reason: code === "recapture_frame_size"
      ? "A native PNG exceeds 2 MiB. Recapture simpler content at readable native dimensions; duration splitting cannot repair a single oversized frame."
      : split ? "Capture ordered adjacent scenarios within source, duration and conversion limits; every original temporal interval must remain represented."
        : "Recapture within the disclosed silent readable profile with explicit original frame timing. Do not sample frames, strip audio or change playback speed.",
  };
}
