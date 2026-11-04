/** Owner/admin view of delegated video review for Settings (#1321). Read-only: it reports which
 * machine can host the media-only reviewer and the state of its Human-recorded live proof. */

/** Why a machine cannot host the media-only video reviewer, checked in this order. */
export type VideoReviewerInstallationGap =
  | "no_claude_code_agent" | "runner_protocol" | "no_attestation" | "reviewer_model";

/** The live proof state of one attested installation: the newest proof for its exact attestation. */
export type VideoReviewerProofState =
  | { state: "certified"; proofId: string; validatedAt: number; expiresAt: number }
  | { state: "expired"; proofId: string; expiresAt: number }
  | { state: "revoked"; proofId: string }
  | { state: "missing" };

export interface VideoReviewerMachineStatus {
  runnerId: string;
  /** The Machine's display name, falling back to its hostname. */
  machineName: string;
  /** The native Claude Code agent this row describes; null when the machine has none. */
  agentId: string | null;
  /** Null when the agent is an attested media-only reviewer installation. */
  gap: { code: VideoReviewerInstallationGap; reason: string } | null;
  /** Present only for an attested installation. */
  proof: VideoReviewerProofState | null;
}

export interface VideoReviewSettingsStatus {
  /** Whether delegated video review can run on this control plane now, and why not. */
  readiness: { available: true } | { available: false; code: string; reason: string };
  /** The only reviewer a proof can certify. */
  reviewer: { driver: "claude-code"; model: string; effort: string };
  /** Recording formats the reviewer accepts when attached as private Session artifacts. */
  mediaTypes: Array<"video/mp4" | "video/webm">;
  machines: VideoReviewerMachineStatus[];
}
