/** Why one Project Location could not be verified (#4117, #4138). Each reason is a fixed,
 * non-sensitive sentence: no local path, origin URL or command output ever reaches it. */
export const PROJECT_LOCATION_INSPECTION_FAILURES = {
  runner_offline: "The Location's machine is offline.",
  runner_too_old: "The Location's runner is too old to verify it; update the runner.",
  unknown_location: "The Location is not an active Location of this Project.",
  path_missing: "The Location's folder is missing or unavailable on its machine.",
  not_repository: "The Location's folder is not a git repository with a valid HEAD.",
  unsupported_origin: "The Location's repository origin is unsupported; a github.com or GitLab origin is required.",
  read_failed: "The Location could not be read on its machine.",
} as const;
export type ProjectLocationInspectionFailure = keyof typeof PROJECT_LOCATION_INSPECTION_FAILURES;

/** One Project Location a runner verified in its own resolved path. The Location id, not its name
 * or path, is the identity; `repository` is the forge repository its origin names. */
export interface VerifiedProjectLocation {
  locationId: string;
  projectId: string;
  runnerId: string;
  workspaceId: string;
  repository: string;
  /** Runner digest of the inspected path, repository and HEAD. */
  digest: string;
  verifiedAt: number;
}

export type ProjectLocationInspection =
  | { ok: true; location: VerifiedProjectLocation }
  | { ok: false; locationId: string; failure: ProjectLocationInspectionFailure; reason: string };
