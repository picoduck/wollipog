import type { ProjectLocationAvailability, ProjectView, RunnerView } from "@wollipog/protocol";
import { isLaunchableProjectLocation } from "./project-session-selection.js";
import type { LocationMachineName } from "./project-management.js";

/* --- The Projects Overview (#2958, docs/design-system.md §6.1) --- */

/** Get Started stays while there are fewer projects than this (§6.1). */
export const PROJECTS_GET_STARTED_BELOW = 3;
/** Most Active lists at most this many projects. */
export const PROJECTS_MOST_ACTIVE_LIMIT = 5;

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

function nameList(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The overview's count line: "9 projects on 2 machines, with 32 sessions. 2 are running now." The
 * machines are the ones the projects' locations are on; sessions are the unarchived ones, and running
 * the ones in flight, as each project's own detail counts them.
 */
export function projectsOverviewSummary(projects: readonly ProjectView[]): string {
  const machines = new Set(projects.flatMap((project) => project.locations.map((location) => location.runnerId))).size;
  const sessions = projects.reduce((total, project) => total + project.unarchivedSessionCount, 0);
  const running = projects.reduce((total, project) => total + project.activeSessionCount, 0);
  const where = machines > 0 ? ` on ${plural(machines, "machine")}` : "";
  const now = running === 0 ? "" : ` ${running} ${running === 1 ? "is" : "are"} running now.`;
  return `${plural(projects.length, "project")}${where}, with ${plural(sessions, "session")}.${now}`;
}

/** One Needs Attention row: what keeps a project from starting sessions, or makes it hard to tell apart. */
export type ProjectsOverviewAttentionItem =
  /** Every location is unreachable; `status` is the badge the list's row shows for it. */
  | { kind: "unavailable"; project: ProjectView; status: ProjectLocationAvailability; reason: string }
  | { kind: "no-locations"; project: ProjectView; reason: string }
  /** More than one project has this name, ignoring case. `projects` is in list order, and `target` is
   * the one Rename… opens: the first one the person may rename, else the first. */
  | { kind: "duplicate-name"; name: string; projects: ProjectView[]; target: ProjectView; reason: string };

/**
 * Needs Attention, in the list's order within each kind: projects whose every location is out of
 * reach, then projects with no locations, then names shared by more than one project. A project
 * can start sessions when one of its locations can host one, as New Session decides
 * (`projectNewSessionBlocker`).
 */
export function projectsOverviewAttention(
  projects: readonly ProjectView[],
  runners: ReadonlyMap<string, RunnerView>,
  machineName: LocationMachineName,
): ProjectsOverviewAttentionItem[] {
  const ordered = [...projects].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const unavailable: ProjectsOverviewAttentionItem[] = [];
  const empty: ProjectsOverviewAttentionItem[] = [];
  for (const project of ordered) {
    if (project.locations.length === 0) {
      empty.push({ kind: "no-locations", project, reason: "No locations yet, so it can't start sessions." });
      continue;
    }
    if (project.locations.some((location) => isLaunchableProjectLocation(location, runners))) continue;
    const offline = project.locations.filter((location) =>
      location.availability === "runner_offline" || runners.get(location.runnerId)?.status !== "online");
    const names = [...new Set(offline.map(machineName))];
    const reason = names.length === 0
      ? "None of its folders can be reached, so this project can't start sessions."
      : `${nameList(names)} ${names.length === 1 ? "is" : "are"} offline, so this project can't start sessions.`;
    const shown = project.locations.find((location) => location.isDefault) ?? project.locations[0]!;
    // A location the server still calls available is out of reach because its machine is offline, or
    // because the machine no longer lists its folder.
    const status = shown.availability !== "available" ? shown.availability
      : runners.get(shown.runnerId)?.status !== "online" ? "runner_offline" : "workspace_missing";
    unavailable.push({ kind: "unavailable", project, status, reason });
  }
  const byName = new Map<string, ProjectView[]>();
  for (const project of ordered) {
    const key = project.name.trim().toLocaleLowerCase();
    byName.set(key, [...byName.get(key) ?? [], project]);
  }
  const duplicates: ProjectsOverviewAttentionItem[] = [...byName.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      kind: "duplicate-name",
      name: group[0]!.name,
      projects: group,
      target: group.find((project) => project.canManage !== false) ?? group[0]!,
      reason: "Rename one so they're easy to tell apart in lists and pickers.",
    }));
  return [...unavailable, ...empty, ...duplicates];
}

/** Most Active: the projects with the most unarchived sessions, most first, at most five. A project
 * with no sessions is not active. */
export function projectsMostActive(projects: readonly ProjectView[]): ProjectView[] {
  return projects
    .filter((project) => project.unarchivedSessionCount > 0)
    .sort((left, right) => right.unarchivedSessionCount - left.unarchivedSessionCount ||
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, PROJECTS_MOST_ACTIVE_LIMIT);
}

/** A Most Active row's count: "12 sessions, 2 running", or "12 sessions" while none is running. */
export function projectActivitySummary(project: ProjectView): string {
  const running = project.activeSessionCount;
  return `${plural(project.unarchivedSessionCount, "session")}${running > 0 ? `, ${running} running` : ""}`;
}
