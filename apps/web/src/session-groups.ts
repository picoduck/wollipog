import { isInboxRunning, type InboxSplit, type InboxSplitKey } from "./inbox.js";

/**
 * How a session group (a Sessions tab) is named and described (#2180): the tab, the All Groups
 * menu and the phone group picker all read these, so a group reads the same everywhere.
 */

/** A group's name, and its machine when another group has the same name. */
export interface SessionGroupLabel {
  name: string;
  /** The machine's display name, set only on a name two or more groups share. */
  machine?: string;
}

/** The tab's tooltip hint: Tab and Shift+Tab move between groups. */
export const SESSION_GROUP_TAB_HINT = "Switch group (Tab / Shift+Tab)";

/** The machine a group's sessions run on: a Project's primary Location, or a legacy workspace's. */
export function sessionGroupRunnerId(split: Pick<InboxSplit, "project">): string | null {
  const project = split.project;
  if (!project) return null;
  return project.kind === "legacy" ? project.runnerId : project.primaryLocation?.runnerId ?? null;
}

/**
 * Each group's label. Two projects with the same name ("Docs Site" on two machines) would read
 * alike, so every group whose name is shared also carries its machine; a unique name stays bare.
 */
export function sessionGroupLabels(
  splits: readonly Pick<InboxSplit, "key" | "name" | "project">[],
  machineName: (runnerId: string) => string,
): Map<InboxSplitKey, SessionGroupLabel> {
  const uses = new Map<string, number>();
  for (const split of splits) uses.set(split.name, (uses.get(split.name) ?? 0) + 1);
  return new Map(splits.map((split) => {
    const runnerId = (uses.get(split.name) ?? 0) > 1 ? sessionGroupRunnerId(split) : null;
    const machine = runnerId === null ? "" : machineName(runnerId).trim();
    return [split.key, machine ? { name: split.name, machine } : { name: split.name }];
  }));
}

/** The label as one string: "Docs Site on Build Server 02". */
export function sessionGroupFullName(label: SessionGroupLabel): string {
  return label.machine ? `${label.name} on ${label.machine}` : label.name;
}

/**
 * The group's counts in sentence case, for its tooltip: "9 sessions: 1 needs you, 1 stalled,
 * 2 running". Zero parts are left out. The Snoozed view counts snoozed sessions and nothing else.
 */
export function sessionGroupSummary(
  split: Pick<InboxSplit, "count" | "blockedCount" | "stalledCount" | "sessions">,
  snoozed = false,
): string {
  const noun = split.count === 1 ? "session" : "sessions";
  const total = `${split.count} ${snoozed ? `snoozed ${noun}` : noun}`;
  if (snoozed) return total;
  const running = split.sessions.filter(isInboxRunning).length;
  const parts = [
    split.blockedCount > 0 ? `${split.blockedCount} ${split.blockedCount === 1 ? "needs" : "need"} you` : "",
    split.stalledCount > 0 ? `${split.stalledCount} stalled` : "",
    running > 0 ? `${running} running` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `${total}: ${parts.join(", ")}` : total;
}

/** A tab's attention counts in words ("2 Blocked, 1 Stalled"), naming only the nonzero ones. */
export function sessionGroupAttentionWords(
  { blockedCount, stalledCount }: Pick<InboxSplit, "blockedCount" | "stalledCount">,
): string {
  return [
    blockedCount > 0 ? `${blockedCount} Blocked` : "",
    stalledCount > 0 ? `${stalledCount} Stalled` : "",
  ].filter(Boolean).join(", ");
}
