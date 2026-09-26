import { runnerCapabilityRequirement, runnerSupportsProtocol, type SessionView } from "@wollipog/protocol";

/** Whether a surface can offer Stop Job for this session's background jobs (#1780), and if not, why. */
export type BackgroundJobStopAvailability = { available: true } | { available: false; reason: string };

/**
 * Stop Job ends one managed background job through the runner, without ending the session. Only a
 * Claude Code session has managed jobs to stop. `null` means the action does not apply at all, so
 * no control is shown; an older or offline runner shows it as unavailable with the reason.
 */
export function backgroundJobStopAvailability(
  session: Pick<SessionView, "driver" | "backgroundWorkTracking">,
  runnerProtocolVersion: number | null | undefined,
  runnerOnline: boolean,
): BackgroundJobStopAvailability | null {
  if (session.driver !== "claude-code" || session.backgroundWorkTracking === "untracked") return null;
  if (!runnerSupportsProtocol(runnerProtocolVersion, "backgroundJobStop")) {
    return { available: false, reason: runnerCapabilityRequirement(runnerProtocolVersion, "backgroundJobStop", "Stop Job") };
  }
  if (!runnerOnline) return { available: false, reason: "The runner is offline." };
  return { available: true };
}
