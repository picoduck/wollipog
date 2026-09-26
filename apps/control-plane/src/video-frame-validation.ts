/** A control-plane operator may select one existing Orchestrator Session for live validation.
 * No setting in a Session, runner, or agent request can enable this candidate. */
export function videoFrameValidationSessionId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^s_[0-9a-f]{12}$/u.test(raw)) {
    throw new Error(
      "CONTROL_PLANE_VIDEO_FRAME_REVIEW_VALIDATION_SESSION_ID must be one exact Session ID",
    );
  }
  return raw;
}
