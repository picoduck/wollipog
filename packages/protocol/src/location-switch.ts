import type { WorkflowDecisionOption } from "./index.js";

/** Where a repository mismatch was noticed (#4138): before implementation, or by a repository-bound
 * operation that refused the session's current repository. */
export type LocationSwitchTrigger = "early" | "worktree_attach" | "review";
export const LOCATION_SWITCH_TRIGGERS: readonly LocationSwitchTrigger[] = ["early", "worktree_attach", "review"];

/** What a person can choose on a Location switch card. `stay` is the card's denial. */
export type LocationSwitchAction = "switch" | "new_session";

/** How a session may recover from a repository mismatch (#4138):
 * - `offer`: a regular session asks its person to approve a Location switch or a new session;
 * - `orchestrator`: an Orchestrator stays in its Location and dispatches children instead;
 * - `report_to_parent`: a child keeps its assigned repository and reports to its parent. */
export type LocationSwitchRole = "offer" | "orchestrator" | "report_to_parent";

/** The role split, from the two facts every caller has: the session's role and whether it has a parent. */
export function locationSwitchRole(session: { role: "normal" | "orchestrator"; parentSessionId?: string | null }): LocationSwitchRole {
  if (session.role === "orchestrator") return "orchestrator";
  return session.parentSessionId ? "report_to_parent" : "offer";
}

/** Fixed guidance for each role. The refusals and the mismatch hints use the same sentences, so a
 * session hears one consistent instruction wherever it meets the mismatch. */
export const LOCATION_SWITCH_GUIDANCE = {
  offer: "This task belongs to another repository. Call request_location_switch (or `wollipog location-switch request`) " +
    "with that repository, so your person can approve continuing in one of its Project Locations.",
  orchestrator: "Orchestrators do not switch Locations. Stay in this Location and dispatch a child session to a Location " +
    "of that repository under the campaign's policy.",
  report_to_parent: "This session keeps the repository it was assigned. Report the repository mismatch to the session " +
    "that started you (your Orchestrator) so it can reassign the work; do not switch Locations.",
} as const satisfies Record<LocationSwitchRole, string>;

/** Refusals a repository-bound operation gives when the session is in the wrong repository. */
const REPOSITORY_MISMATCH_REFUSALS: Record<Exclude<LocationSwitchTrigger, "early">, readonly RegExp[]> = {
  worktree_attach: [
    /worktree path is not registered by the repository it was matched against/u,
    /registered worktree belongs to a different repository than the session/u,
    /worktree path matched none of the runner's configured Project Locations/u,
  ],
  review: [
    /the pull request is not this session's open, same-repository pull request/u,
    /the review must cover the session's own native managed worktree/u,
  ],
};

/** `error` with the role's recovery appended when it is a repository mismatch refusal, else
 * unchanged. Recovery is offered where the mismatch is discovered, not only before implementation. */
export function withRepositoryMismatchGuidance(role: LocationSwitchRole, trigger: Exclude<LocationSwitchTrigger, "early">, error: string): string {
  if (!REPOSITORY_MISMATCH_REFUSALS[trigger].some((pattern) => pattern.test(error))) return error;
  const guidance = role === "offer"
    ? `If the task belongs to another repository, call request_location_switch (or \`wollipog location-switch request\`) ` +
      `with that repository and trigger "${trigger}", so your person can approve continuing in one of its Project Locations ` +
      "without repeating the work."
    : LOCATION_SWITCH_GUIDANCE[role];
  return `${error}. ${guidance}`;
}

export const LOCATION_SWITCH_LIMITS ={ repository: 300, reason: 1000, handoff: 8000, requestId: 256 } as const;

/** A Location as the card shows it. Names, machines and paths are display facts; the id is identity. */
export interface LocationSwitchPlace {
  /** Null for a session started outside any Project Location. */
  locationId: string | null;
  name: string;
  runnerId: string;
  machineName: string;
  workspaceId: string;
  path: string;
  /** The forge repository the Location verified as, when it could be verified. */
  repository?: string;
}

/** A verified Location of the target repository in the session's Project. */
export interface LocationSwitchCandidate extends LocationSwitchPlace {
  locationId: string;
  repository: string;
  sameRunner: boolean;
  /** What this Location supports, in the card's order. Empty only alongside `unavailableReason`. */
  actions: LocationSwitchAction[];
  /** Why this matching Location offers no action, such as the agent missing on its machine. */
  unavailableReason?: string;
}

/** A Project Location that could not be considered, with a fixed, non-sensitive reason. */
export interface LocationSwitchUnavailable {
  locationId: string;
  name: string;
  machineName: string;
  reason: string;
}

export interface LocationSwitchRequest {
  requestId: string;
  /** The repository the task belongs to: GitHub `owner/name`, or a GitLab `host/group/project`. */
  repository: string;
  /** Why the task belongs there, in a sentence the person reads on the card. */
  reason: string;
  /** The task, written for whoever continues it: shown on the card and sent to a new session. */
  handoff: string;
  trigger?: LocationSwitchTrigger;
}

export interface LocationSwitchSnapshot {
  category: "location_switch";
  repository: string;
  reason: string;
  handoff: string;
  trigger: LocationSwitchTrigger;
  projectId: string;
  projectName: string;
  current: LocationSwitchPlace;
  candidates: LocationSwitchCandidate[];
  unavailable: LocationSwitchUnavailable[];
  /** One option per offered action and Location: `<action>:<locationId>`. Denial is Stay Here. */
  options: WorkflowDecisionOption[];
  /** Binds the inspected Locations, the requester's agent and settings; never a credential. */
  targetDigest: string;
  expiresAt: number;
}

export interface LocationSwitchResult {
  action: LocationSwitchAction;
  locationId: string;
  /** The session that continues the task. */
  sessionId: string;
  navigationPath: string;
  completedAt: number;
}

export const locationSwitchOptionId = (action: LocationSwitchAction, locationId: string): string => `${action}:${locationId}`;

/** The action and Location an option names, or null for anything else (including Stay Here). */
export function parseLocationSwitchOption(optionId: string | undefined | null): { action: LocationSwitchAction; locationId: string } | null {
  const match = typeof optionId === "string" ? /^(switch|new_session):(.+)$/u.exec(optionId) : null;
  return match ? { action: match[1] as LocationSwitchAction, locationId: match[2]! } : null;
}

/** A repository named by a request, canonicalised for comparison: forge repositories compare
 * case-insensitively. Null when it is not a plausible `owner/name` or `host/group/project`. */
export function normalizeLocationSwitchRepository(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\.git$/iu, "").replace(/^https?:\/\/(www\.)?github\.com\//iu, "");
  if (!trimmed || trimmed.length > LOCATION_SWITCH_LIMITS.repository) return null;
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){1,8}$/u.test(trimmed) || trimmed.split("/").some((part) => /^\.+$/u.test(part))) return null;
  return trimmed;
}

export const sameLocationSwitchRepository = (a: string | undefined, b: string | undefined): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
