import type { InboxSplit } from "./inbox.js";
import { destination } from "./navigation.js";
import type { ReminderInboxMode } from "./session-reminders.js";

/**
 * The one state that replaces the Sessions list and preview when the group shows no rows (#2220,
 * docs/design-system.md §6.1, §12.1). Each situation names its own next step; none is a success
 * mark or a count line. Offline, loading and no matches come first and are decided by InboxView.
 */
export type SessionsSituation =
  /** No sessions anywhere: the first thing a new user sees. */
  | { kind: "first-run" }
  | { kind: "project-empty"; project: string }
  | { kind: "no-location"; project: string }
  /** Every Location is on a machine that is offline; `machines` are their display names, once each,
   * and `locations` counts the Locations, which can share a machine. */
  | { kind: "location-offline"; project: string; machines: string[]; locations: number }
  /** Locations exist, but none can start a session and not every one is merely offline. */
  | { kind: "location-unavailable"; project: string }
  | { kind: "no-project" }
  /** The Snoozed filter is on and the group has none. `group` reads in a sentence. */
  | { kind: "snoozed"; group: string }
  /** The group's every session is snoozed, so its active list is empty but the group is not. */
  | { kind: "all-snoozed"; group: string };

/** A group's name inside a sentence: All is every session, so it reads as the page. */
export function sessionsGroupPhrase(split: Pick<InboxSplit, "kind" | "name"> | null): string {
  return !split || split.kind === "all" ? destination("inbox").name : split.name;
}

/**
 * Which situation an empty group is in. `split` is the active group as the current reminder mode
 * shows it, and `snoozedInGroup` counts the group's snoozed sessions.
 */
export function sessionsSituation({
  split,
  mode,
  snoozedInGroup,
  machineName,
}: {
  split: Pick<InboxSplit, "kind" | "name" | "project"> | null;
  mode: ReminderInboxMode;
  snoozedInGroup: number;
  machineName: (runnerId: string) => string;
}): SessionsSituation {
  const group = sessionsGroupPhrase(split);
  if (mode === "snoozed") return { kind: "snoozed", group };
  if (snoozedInGroup > 0) return { kind: "all-snoozed", group };
  if (!split || split.kind === "all") return { kind: "first-run" };
  if (split.kind === "no_project") return { kind: "no-project" };
  const project = split.name;
  if (split.project?.kind !== "durable") return { kind: "project-empty", project };
  const locations = split.project.project.locations;
  if (locations.length === 0) return { kind: "no-location", project };
  if (locations.some((location) => location.availability === "available")) return { kind: "project-empty", project };
  if (locations.every((location) => location.availability === "runner_offline")) {
    const machines = [...new Set(locations.map((location) => machineName(location.runnerId).trim() || location.runnerId))];
    return { kind: "location-offline", project, machines, locations: locations.length };
  }
  return { kind: "location-unavailable", project };
}

/** Whether the situation's own actions include New Session, which the page header then hides (§12.1). */
export function sessionsSituationOffersNewSession(situation: SessionsSituation): boolean {
  return situation.kind === "first-run" || situation.kind === "project-empty" || situation.kind === "no-project";
}

const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** The situation's sentence, in sentence case (§12.1). */
export function sessionsSituationMessage(situation: SessionsSituation): string {
  switch (situation.kind) {
    case "first-run":
      return "Pick a project and describe the task. An agent starts on one of your machines and tells you when it needs a decision.";
    case "project-empty":
      return `Start a session to put an agent to work in ${situation.project}.`;
    case "no-location":
      return `Sessions run in a folder on one of your machines. Add one to ${situation.project} to start sessions here.`;
    case "location-offline": {
      const [only] = situation.machines;
      if (situation.machines.length === 1) {
        const where = situation.locations === 1 ? "only location is" : "locations are all";
        return `This project's ${where} on ${only}, which is offline. Sessions can start here when it reconnects.`;
      }
      return `This project's locations are on ${LIST.format(situation.machines)}, which are offline. Sessions can start here when one reconnects.`;
    }
    case "location-unavailable":
      return `${situation.project}'s locations can't start sessions right now: their machines are offline or removed, or their folders are missing. Manage its locations to start sessions here.`;
    case "no-project":
      return "Sessions you start without choosing a project collect here.";
    case "snoozed":
      return `Snooze a session to hide it from ${situation.group} until a time you choose. Its work keeps running while it's away.`;
    case "all-snoozed":
      return situation.group === destination("inbox").name
        ? "Every session is snoozed. Each one comes back at the time you chose."
        : `Every session in ${situation.group} is snoozed. Each one comes back at the time you chose.`;
  }
}

/** The situation's Title Case title. */
export function sessionsSituationTitle(situation: SessionsSituation): string {
  switch (situation.kind) {
    case "first-run":
    case "project-empty":
      return `No ${destination("inbox").name} Yet`;
    case "no-location":
      return "No Location Yet";
    case "location-offline":
      return "Location Offline";
    case "location-unavailable":
      return "No Location Available";
    case "no-project":
      return "No Sessions Without a Project";
    case "snoozed":
      return "No Snoozed Sessions";
    case "all-snoozed":
      return "No Active Sessions";
  }
}

/** Skeleton rows stand in for 3 to 6 rows (§12.3), as many as are coming when that is known. */
export const SESSIONS_SKELETON_MIN_ROWS = 3;
export const SESSIONS_SKELETON_MAX_ROWS = 6;

export function sessionsSkeletonRows(count: number | null): number {
  return Math.min(SESSIONS_SKELETON_MAX_ROWS, Math.max(SESSIONS_SKELETON_MIN_ROWS, count ?? SESSIONS_SKELETON_MAX_ROWS));
}

/** The status line over skeleton rows (§12.3): "Loading 8 sessions…", or without a count when none is known. */
export function sessionsLoadingMessage(count: number | null): string {
  if (count === null) return "Loading sessions…";
  return `Loading ${count} ${count === 1 ? "session" : "sessions"}…`;
}

/**
 * How many sessions a group is still waiting for: its durable count says it has sessions, and none
 * has arrived yet (#2220). A Snoozed view counts only what it holds, and a search filters what has
 * arrived, so neither waits.
 */
export function sessionsSyncingCount(
  split: Pick<InboxSplit, "count" | "sessions"> | null,
  mode: ReminderInboxMode,
  query: string,
): number | null {
  if (!split || mode !== "ordinary" || query !== "") return null;
  return split.sessions.length === 0 && split.count > 0 ? split.count : null;
}
