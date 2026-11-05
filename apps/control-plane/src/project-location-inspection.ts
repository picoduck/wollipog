import { randomUUID } from "node:crypto";
import {
  PROJECT_LOCATION_INSPECTION_FAILURES, campaignRepositoryLocation,
  type CampaignLaunchInspectionFailure, type CampaignLaunchInspectionResult, type ProjectLocationInspection,
  type ProjectLocationInspectionFailure, type RunnerView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { RunnerRequestTimeoutError, type Hub } from "./hub.js";

export const CAMPAIGN_LAUNCH_INSPECTION_TIMEOUT_MS = 60_000;
/** Runners that inspect an authorized Location path and return closed failure codes (#4090). */
export const PROJECT_LOCATION_INSPECTION_MIN_VERSION = 3;

/** Ask the runner to inspect the workspace origin and issues. Expiry or cancellation of the caller
 * drops the pending request (so a late result is discarded, never admitted) and, on a version-2
 * runner, stops that one inspection. Older runners stay bounded by their per-command timeouts. */
export async function inspectCampaignWorkspace(hub: Hub, runner: RunnerView, workspaceId: string, issueNumbers: number[],
  signal: AbortSignal, timeoutMs = CAMPAIGN_LAUNCH_INSPECTION_TIMEOUT_MS, workspacePath?: string): Promise<CampaignLaunchInspectionResult | undefined> {
  const version = runner.runtime?.campaignLaunchInspection?.version ?? 0;
  if (version < PROJECT_LOCATION_INSPECTION_MIN_VERSION || !workspacePath || signal.aborted) return undefined;
  const requestId = `campaign_launch_${randomUUID()}`;
  const stopRunner = () => {
    if (version >= 2) hub.sendToRunner(runner.runnerId, { type: "campaign_launch_inspect_cancel", requestId });
  };
  const onAbort = () => {
    if (hub.cancelRunnerRequest(runner.runnerId, requestId, new Error("campaign launch inspection was cancelled"))) stopRunner();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await hub.requestFromRunner(runner.runnerId, requestId, {
      type: "campaign_launch_inspect", requestId, workspaceId, workspacePath, issueNumbers,
    }, timeoutMs);
    if (signal.aborted || result.type !== "campaign_launch_inspection_result" || result.requestId !== requestId) return undefined;
    return result;
  } catch (error) {
    if (error instanceof RunnerRequestTimeoutError) stopRunner();
    // No credential-bearing runner error escapes the preflight.
    return undefined;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const RUNNER_FAILURES: Partial<Record<CampaignLaunchInspectionFailure, ProjectLocationInspectionFailure>> = {
  unknown_location: "unknown_location",
  missing_path: "path_missing",
  not_repository: "not_repository",
  unsupported_origin: "unsupported_origin",
};

/** Verify one Project Location by its id (#4117, #4138): the runner inspects the Location's own
 * resolved path, from the same authorized source as session creation and #4090's launch
 * inspection, and reports the forge repository it belongs to. Callers authorize access to the
 * Project; `projectId`, when given, also requires the Location to belong to it. Every failure is a
 * closed, non-sensitive reason; a runner error, a timeout or a cancelled caller reads as
 * `read_failed`, and a Location that changes while it is inspected is never verified. */
export async function inspectProjectLocation(
  dependencies: { db: ControlPlaneDb; hub: Hub },
  locationId: string,
  options: { projectId?: string; signal?: AbortSignal; timeoutMs?: number; now?: () => number } = {},
): Promise<ProjectLocationInspection> {
  const { db, hub } = dependencies;
  const fail = (failure: ProjectLocationInspectionFailure): ProjectLocationInspection =>
    ({ ok: false, locationId, failure, reason: PROJECT_LOCATION_INSPECTION_FAILURES[failure] });
  const active = () => {
    const location = db.getProjectLocation(locationId);
    // A detached Location's runner was removed; it is not an active Location of its Project.
    return location && location.availability !== "runner_removed" &&
      (options.projectId === undefined || location.projectId === options.projectId) ? location : null;
  };
  const location = active();
  if (!location) return fail("unknown_location");
  const runner = db.getRunner(location.runnerId);
  if (!runner || !hub.isRunnerOnline(location.runnerId)) return fail("runner_offline");
  if ((runner.runtime?.campaignLaunchInspection?.version ?? 0) < PROJECT_LOCATION_INSPECTION_MIN_VERSION) return fail("runner_too_old");
  const workspacePath = db.getWorkspacePath(location.runnerId, location.workspaceId);
  if (!workspacePath) return fail("path_missing");
  const result = await inspectCampaignWorkspace(hub, runner, location.workspaceId, [],
    options.signal ?? new AbortController().signal, options.timeoutMs, workspacePath);
  // Runner frames are not validated on the wire: only an exact success for this workspace verifies.
  if (result?.ok !== true || result.cancelled !== undefined || result.workspaceId !== location.workspaceId ||
      campaignRepositoryLocation(result.repository) === null || typeof result.digest !== "string" || !/^[a-f0-9]{64}$/.test(result.digest)) {
    const failure = result?.ok === false && typeof result.failure === "string" && Object.hasOwn(RUNNER_FAILURES, result.failure)
      ? RUNNER_FAILURES[result.failure] : undefined;
    return fail(failure ?? "read_failed");
  }
  // The answer describes the path that was inspected; a Location removed, moved to another Project
  // or repointed meanwhile is not the Location the caller asked about.
  const current = active();
  if (!current) return fail("unknown_location");
  if (current.projectId !== location.projectId || current.runnerId !== location.runnerId || current.workspaceId !== location.workspaceId ||
      db.getWorkspacePath(location.runnerId, location.workspaceId) !== workspacePath) return fail("read_failed");
  return { ok: true, location: {
    locationId, projectId: current.projectId, runnerId: current.runnerId, workspaceId: current.workspaceId,
    repository: result.repository!.toLowerCase(), digest: result.digest, verifiedAt: (options.now ?? Date.now)(),
  } };
}
