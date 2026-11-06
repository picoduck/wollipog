import { randomUUID } from "node:crypto";
import {
  PROJECT_LOCATION_INSPECTION_FAILURES, campaignRepositoryLocation, runnerSupportsProtocol, validCampaignIssueFacts,
  type CampaignIssueFacts, type CampaignLaunchInspectionFailure, type CampaignLaunchInspectionMessage, type CampaignLaunchInspectionResult, type ProjectLocationInspection, type ProjectLocationView,
  type ProjectLocationInspectionFailure, type RunnerProtocolCapability, type RunnerView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { RunnerRequestTimeoutError, type Hub } from "./hub.js";

export const CAMPAIGN_LAUNCH_INSPECTION_TIMEOUT_MS = 60_000;
/** Runners that inspect an authorized Location path and return closed failure codes (#4090). */
export const PROJECT_LOCATION_INSPECTION_MIN_VERSION = 3;
/** Runners that also inspect a follow-up publication in a Location's repository (#4119). */
export const LOCATION_PUBLICATION_INSPECTION_MIN_VERSION = 4;

/** Ask the runner to inspect the workspace origin and issues. Expiry or cancellation of the caller
 * drops the pending request (so a late result is discarded, never admitted) and, on a version-2
 * runner, stops that one inspection. Older runners stay bounded by their per-command timeouts. */
export async function inspectCampaignWorkspace(hub: Hub, runner: RunnerView, workspaceId: string, issueNumbers: number[],
  signal: AbortSignal, timeoutMs = CAMPAIGN_LAUNCH_INSPECTION_TIMEOUT_MS, workspacePath?: string, facts = false,
  publication?: NonNullable<CampaignLaunchInspectionMessage["publication"]>, epic?: number): Promise<CampaignLaunchInspectionResult | undefined> {
  const version = runner.runtime?.campaignLaunchInspection?.version ?? 0;
  if (version < (publication ? LOCATION_PUBLICATION_INSPECTION_MIN_VERSION : PROJECT_LOCATION_INSPECTION_MIN_VERSION) ||
      !workspacePath || signal.aborted) return undefined;
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
      ...(facts ? { facts: true as const } : {}), ...(publication ? { publication } : {}), ...(epic !== undefined ? { epic } : {}),
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
  options: { projectId?: string; signal?: AbortSignal; timeoutMs?: number; now?: () => number;
    /** A runner below this protocol capability is too old for what the caller will use it for. */
    requireProtocol?: RunnerProtocolCapability;
    /** Issues the runner must also read in the Location's repository (#4118); any it cannot read
     * as an issue there fails the inspection. */
    issueNumbers?: readonly number[];
    /** Also return those issues' facts (#4118), with a pull request reported rather than failing.
     * A runner too old to report them fails as `runner_too_old`. */
    facts?: boolean;
    /** Resolve this epic's members in the Location's repository (#4118), with no `issueNumbers`.
     * A member anywhere else fails the inspection, and so does a runner too old to read one. */
    epic?: number } = {},
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
  if ((runner.runtime?.campaignLaunchInspection?.version ?? 0) < PROJECT_LOCATION_INSPECTION_MIN_VERSION ||
      (options.requireProtocol && !runnerSupportsProtocol(runner.protocolVersion, options.requireProtocol)) ||
      (options.facts && !runnerSupportsProtocol(runner.protocolVersion, "repositoryQualifiedProposals")) ||
      (options.epic !== undefined && !runnerSupportsProtocol(runner.protocolVersion, "repositoryQualifiedEpics"))) return fail("runner_too_old");
  const workspacePath = db.getWorkspacePath(location.runnerId, location.workspaceId);
  if (!workspacePath) return fail("path_missing");
  const issueNumbers = [...options.issueNumbers ?? []].sort((a, b) => a - b);
  const result = await inspectCampaignWorkspace(hub, runner, location.workspaceId, issueNumbers,
    options.signal ?? new AbortController().signal, options.timeoutMs, workspacePath, options.facts, undefined, options.epic);
  // Runner frames are not validated on the wire: only an exact success for this workspace verifies.
  if (result?.ok !== true || result.cancelled !== undefined || result.workspaceId !== location.workspaceId ||
      JSON.stringify(result.issueNumbers ?? []) !== JSON.stringify(issueNumbers) ||
      campaignRepositoryLocation(result.repository) === null || typeof result.digest !== "string" || !/^[a-f0-9]{64}$/.test(result.digest)) {
    const failure = result?.ok === false && typeof result.failure === "string" && Object.hasOwn(RUNNER_FAILURES, result.failure)
      ? RUNNER_FAILURES[result.failure] : undefined;
    return fail(failure ?? "read_failed");
  }
  // Facts out of their bounds, or missing a requested number, verify nothing.
  const issueFacts = options.facts ? issueNumbers.map((n) => result.issueFacts?.find((fact) => validCampaignIssueFacts(fact) && fact.number === n)) : [];
  if (issueFacts.some((fact) => !fact)) return fail("read_failed");
  // An epic's members count only in this Location's repository: one anywhere else verifies nothing.
  const repository = result.repository!.toLowerCase();
  if (options.epic !== undefined && (!Array.isArray(result.candidates) || result.candidates.some((candidate) => !candidate?.issue ||
      typeof candidate.issue.repository !== "string" || candidate.issue.repository.toLowerCase() !== repository ||
      !Number.isSafeInteger(candidate.issue.number) || candidate.issue.number < 1 || typeof candidate.title !== "string"))) return fail("read_failed");
  // The answer describes the path that was inspected; a Location removed, moved to another Project
  // or repointed meanwhile is not the Location the caller asked about.
  const current = active();
  if (!current) return fail("unknown_location");
  if (current.projectId !== location.projectId || current.runnerId !== location.runnerId || current.workspaceId !== location.workspaceId ||
      db.getWorkspacePath(location.runnerId, location.workspaceId) !== workspacePath) return fail("read_failed");
  return { ok: true, location: {
    locationId, projectId: current.projectId, runnerId: current.runnerId, workspaceId: current.workspaceId,
    repository, digest: result.digest, verifiedAt: (options.now ?? Date.now)(),
  }, ...(options.facts ? { issueFacts: issueFacts as CampaignIssueFacts[] } : {}),
    ...(options.epic !== undefined ? { candidates: result.candidates! } : {}) };
}

/** Check a follow-up's payload in a boundary repository other than the root's own (#4119), through
 * the first of its entry's Locations that is active in the root's Project and whose runner is online
 * and inspects publications. That runner reads the Location's own path with its own forge login.
 * Only an exact success for that Location and repository is returned; null otherwise. */
async function inspectPublicationAtLocation(
  dependencies: { db: ControlPlaneDb; hub: Hub },
  root: { projectId?: string | null },
  entry: { repository: string; locationIds: readonly string[] },
  publication: NonNullable<CampaignLaunchInspectionMessage["publication"]>,
  issueNumbers: number[],
  timeoutMs: number,
): Promise<CampaignLaunchInspectionResult | null> {
  const { db, hub } = dependencies;
  const inProject = (candidate: ProjectLocationView | null): candidate is ProjectLocationView => Boolean(candidate) &&
    candidate!.availability !== "runner_removed" && Boolean(root.projectId) && candidate!.projectId === root.projectId;
  const location = entry.locationIds.map((id) => db.getProjectLocation(id)).find((candidate) => inProject(candidate) &&
    hub.isRunnerOnline(candidate.runnerId) &&
    (db.getRunner(candidate.runnerId)?.runtime?.campaignLaunchInspection?.version ?? 0) >= LOCATION_PUBLICATION_INSPECTION_MIN_VERSION);
  const runner = location ? db.getRunner(location.runnerId) : undefined;
  const workspacePath = location ? db.getWorkspacePath(location.runnerId, location.workspaceId) : undefined;
  if (!location || !runner || !workspacePath) return null;
  const result = await inspectCampaignWorkspace(hub, runner, location.workspaceId, issueNumbers, new AbortController().signal, timeoutMs,
    workspacePath, false, publication);
  // Runner frames are not validated on the wire.
  if (result?.ok !== true || result.cancelled !== undefined || result.workspaceId !== location.workspaceId ||
      typeof result.repository !== "string" || result.repository.toLowerCase() !== entry.repository.toLowerCase() ||
      JSON.stringify(result.issueNumbers ?? []) !== JSON.stringify(issueNumbers)) return null;
  // The answer describes the path that was inspected; a Location removed, moved to another Project
  // or repointed meanwhile is not the Location the campaign's boundary lists.
  const current = db.getProjectLocation(location.id);
  return inProject(current) && current.runnerId === location.runnerId && current.workspaceId === location.workspaceId &&
    db.getWorkspacePath(location.runnerId, location.workspaceId) === workspacePath ? result : null;
}

/** Content screening and the duplicate search by subject before a follow-up is published in that
 * repository, as the root's publication inspection does: its payload's digest, or null. */
export async function inspectBoundaryPublication(
  dependencies: { db: ControlPlaneDb; hub: Hub },
  root: { projectId?: string | null },
  entry: { repository: string; locationIds: readonly string[] },
  publication: NonNullable<CampaignLaunchInspectionMessage["publication"]>,
  timeoutMs = CAMPAIGN_LAUNCH_INSPECTION_TIMEOUT_MS,
): Promise<string | null> {
  const result = await inspectPublicationAtLocation(dependencies, root, entry, publication, [], timeoutMs);
  return result?.duplicateSearch === "subject" && typeof result.publicationDigest === "string" && /^[a-f0-9]{64}$/.test(result.publicationDigest)
    ? result.publicationDigest : null;
}

/** Whether an issue of that repository was published with exactly this payload, before it joins the
 * campaign's scope: a v4 runner reads its title, body and labels, and refuses any difference. */
export async function verifyBoundaryPublishedIssue(
  dependencies: { db: ControlPlaneDb; hub: Hub },
  root: { projectId?: string | null },
  entry: { repository: string; locationIds: readonly string[] },
  publication: NonNullable<CampaignLaunchInspectionMessage["publication"]>,
  issue: number,
  timeoutMs = CAMPAIGN_LAUNCH_INSPECTION_TIMEOUT_MS,
): Promise<boolean> {
  return Boolean(await inspectPublicationAtLocation(dependencies, root, entry, publication, [issue], timeoutMs));
}
