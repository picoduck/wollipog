import type {
  PendingApproval,
  PermissionOption,
  ProjectLocationView,
  ProjectView,
  SessionStatus,
  SessionView,
} from "@wollipog/protocol";
import { groupLegacySessionsByWorkspace, workspaceLocationKey } from "./projects.js";
import type { ProjectSessionPreset } from "./project-session-selection.js";

export const INBOX_ALL_SPLIT_KEY = null;
export const INBOX_ALL_SPLIT = INBOX_ALL_SPLIT_KEY;
export const INBOX_NO_PROJECT_SPLIT_KEY = " no-project";
export const INBOX_SPLIT_RATIO_STORAGE_KEY = "wollipog.inbox.split";
export const INBOX_SELECTION_STORAGE_KEY = "wollipog.inbox.selection";
export const INBOX_SPLIT_RATIO_DEFAULT = 0.4;
export const INBOX_DEFAULT_RATIO = INBOX_SPLIT_RATIO_DEFAULT;
export const INBOX_SPLIT_RATIO_RESET = INBOX_SPLIT_RATIO_DEFAULT;
export const INBOX_SPLIT_RATIO_MIN = 0.25;
export const INBOX_SPLIT_RATIO_MAX = 0.75;

export type InboxSplitKey = string | null;

export type InboxProjectDescriptor =
  | {
    kind: "durable";
    project: ProjectView;
    primaryLocation: ProjectLocationView | null;
    /** Exact legacy runner/workspace keys accepted while persisted pins/selections migrate. */
    legacyKeys: string[];
  }
  | {
    kind: "legacy";
    runnerId: string;
    workspaceId: string;
  };

export interface InboxSplit {
  key: InboxSplitKey;
  kind: "all" | "project" | "no_project";
  name: string;
  project: InboxProjectDescriptor | null;
  sessions: SessionView[];
  count: number;
  blockedCount: number;
  stalledCount: number;
}

export interface InboxNewSessionPreset extends ProjectSessionPreset {
  /** Legacy workspace-group display name used only with control planes lacking durable Projects. */
  projectName?: string;
}

/** Preserve the active split as an explicit launch context. All intentionally has no preset,
 * while No Project must remain distinct from an absent selection. */
export function newSessionPresetForInboxSplit(
  split: InboxSplit | null | undefined,
): InboxNewSessionPreset | undefined {
  if (split?.kind === "no_project") return { projectId: null };
  if (split?.project?.kind === "durable") {
    const location = split.project.primaryLocation;
    return {
      projectId: split.project.project.id,
      ...(location ? {
        runnerId: location.runnerId,
        workspaceId: location.workspaceId,
        projectLocationId: location.id,
      } : {}),
    };
  }
  if (split?.project?.kind === "legacy") {
    return {
      runnerId: split.project.runnerId,
      workspaceId: split.project.workspaceId,
      projectName: split.name,
    };
  }
  return undefined;
}

const ACTIVE_STATUSES = new Set<SessionStatus>(["queued", "starting", "running", "input_required"]);

export type InboxDirection = "next" | "previous";
export type InboxApprovalIntent = "approve" | "deny";
export const INBOX_REORDER_SETTLE_MS = 500;

export function isInboxActiveStatus(status: SessionStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isInboxBlocked(session: Pick<SessionView, "status" | "pendingApproval">): boolean {
  return session.status === "input_required" || session.pendingApproval !== null;
}

export function isInboxRunning(session: Pick<SessionView, "status">): boolean {
  return session.status === "queued" || session.status === "starting" || session.status === "running";
}

/** Stable card ordering: pinned first, then latest event, with deterministic fallbacks. */
export function sortInboxSessions(
  sessions: Iterable<SessionView>,
  pinnedSessions: ReadonlySet<string> = new Set(),
): SessionView[] {
  return [...sessions].sort((left, right) => {
    const leftPinned = pinnedSessions.has(left.id);
    const rightPinned = pinnedSessions.has(right.id);
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    const leftActivity = left.lastEventAt ?? Number.NEGATIVE_INFINITY;
    const rightActivity = right.lastEventAt ?? Number.NEGATIVE_INFINITY;
    if (leftActivity !== rightActivity) return rightActivity - leftActivity;
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    return left.id.localeCompare(right.id);
  });
}

function inboxSplit(
  key: InboxSplitKey,
  kind: InboxSplit["kind"],
  name: string,
  sessions: SessionView[],
  stalledSessionIds: ReadonlySet<string>,
  project: InboxProjectDescriptor | null = null,
  count = sessions.length,
): InboxSplit {
  return {
    key,
    kind,
    name,
    project,
    sessions,
    count,
    blockedCount: sessions.reduce((count, session) => count + Number(isInboxBlocked(session)), 0),
    stalledCount: sessions.reduce((count, session) => count + Number(stalledSessionIds.has(session.id)), 0),
  };
}

export function durableInboxProjectKey(projectId: string): string {
  return `project:${projectId}`;
}

/** Resolve exact legacy runner/workspace pins into durable Project IDs. Unknown keys are kept for
 * older/offline instances; resolved Location keys are removed so moving that Location later cannot
 * accidentally pin its destination Project. */
export function migrateInboxProjectPins(
  pinnedProjects: ReadonlySet<string>,
  projects: Iterable<ProjectView>,
): Set<string> {
  const migrated = new Set(pinnedProjects);
  for (const project of projects) {
    const legacyKeys = project.locations.map((location) => workspaceLocationKey(location.runnerId, location.workspaceId));
    if (!legacyKeys.some((key) => migrated.has(key))) continue;
    for (const key of legacyKeys) migrated.delete(key);
    migrated.add(durableInboxProjectKey(project.id));
  }
  return migrated;
}

function preferredProjectLocation(project: ProjectView): ProjectLocationView | null {
  const available = project.locations.filter((location) => location.availability === "available");
  return available.find((location) => location.isDefault) ??
    (available.length === 1 ? available[0]! : null);
}

function durableProjectPinned(project: ProjectView, pinnedProjects: ReadonlySet<string>): boolean {
  return pinnedProjects.has(durableInboxProjectKey(project.id)) || project.locations.some((location) =>
    pinnedProjects.has(workspaceLocationKey(location.runnerId, location.workspaceId)));
}

/** All first, pinned-project-aware Project groups next, and No Project last. Archived rows stay out.
 * Against a legacy control plane, retain the former exact runner/workspace grouping unchanged. */
export function deriveInboxSplits(
  sessions: Iterable<SessionView>,
  pinnedProjects: ReadonlySet<string> = new Set(),
  pinnedSessions: ReadonlySet<string> = new Set(),
  stalledSessionIds: ReadonlySet<string> = new Set(),
  projects: Iterable<ProjectView> = [],
  projectsSupported = false,
): InboxSplit[] {
  const visible = [...sessions].filter((session) => !session.archived);
  const all = inboxSplit(
    INBOX_ALL_SPLIT_KEY,
    "all",
    "All",
    sortInboxSessions(visible, pinnedSessions),
    stalledSessionIds,
  );
  if (!projectsSupported) {
    const groups = groupLegacySessionsByWorkspace(visible, pinnedProjects, pinnedSessions).map((group) => {
      const first = group.sessions[0]!;
      const descriptor: InboxProjectDescriptor | null = group.id === null ? null : {
        kind: "legacy",
        runnerId: first.runnerId,
        workspaceId: group.id,
      };
      return inboxSplit(
        group.key,
        group.id === null ? "no_project" : "project",
        group.name,
        sortInboxSessions(group.sessions, pinnedSessions),
        stalledSessionIds,
        descriptor,
      );
    });
    return [all, ...groups];
  }

  const visibleProjects = [...projects].filter((project) => !project.hidden).sort((left, right) => {
    const leftPinned = durableProjectPinned(left, pinnedProjects);
    const rightPinned = durableProjectPinned(right, pinnedProjects);
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    const byName = left.name.localeCompare(right.name);
    return byName || left.id.localeCompare(right.id);
  });
  const projectSplits = visibleProjects.map((project) => inboxSplit(
    durableInboxProjectKey(project.id),
    "project",
    project.name,
    sortInboxSessions(visible.filter((session) => session.projectId === project.id), pinnedSessions),
    stalledSessionIds,
    {
      kind: "durable",
      project,
      primaryLocation: preferredProjectLocation(project),
      legacyKeys: project.locations.map((location) => workspaceLocationKey(location.runnerId, location.workspaceId)),
    },
    project.unarchivedSessionCount,
  ));
  const noProjectSessions = sortInboxSessions(
    visible.filter((session) => session.projectId == null),
    pinnedSessions,
  );
  const noProject = [inboxSplit(
      INBOX_NO_PROJECT_SPLIT_KEY,
      "no_project",
      "No Project",
      noProjectSessions,
      stalledSessionIds,
    )];
  return [all, ...projectSplits, ...noProject];
}

export const buildInboxSplits = deriveInboxSplits;

export function inboxProjectName(
  session: Pick<SessionView, "projectId" | "workspaceId" | "workspaceName">,
  projects?: ReadonlyMap<string, ProjectView>,
): string {
  if (projects) return session.projectId ? projects.get(session.projectId)?.name ?? "Unknown Project" : "No Project";
  return session.workspaceId === null ? "Chats" : session.workspaceName ?? session.workspaceId;
}

export function inboxSplitByKey(
  splits: readonly InboxSplit[],
  requestedKey: InboxSplitKey | null | undefined,
): InboxSplit | null {
  return splits.find((split) => split.key === requestedKey) ??
    splits.find((split) => split.project?.kind === "durable" && split.project.legacyKeys.includes(requestedKey ?? "")) ??
    splits.find((split) => split.key === INBOX_ALL_SPLIT_KEY) ??
    splits[0] ??
    null;
}

/** Keep a valid remembered row, otherwise repair selection to the first row in split order. */
export function repairInboxSelection(split: InboxSplit | null, requestedSessionId: string | null | undefined): string | null {
  if (!split || split.sessions.length === 0) return null;
  return split.sessions.some((session) => session.id === requestedSessionId)
    ? requestedSessionId!
    : split.sessions[0]!.id;
}

/** Do not clear a persisted choice while the initial socket snapshot is still in flight. */
export function repairInboxSelectionAfterSnapshot(
  snapshotLoaded: boolean,
  split: InboxSplit | null,
  requestedSessionId: string | null | undefined,
): string | null {
  return snapshotLoaded ? repairInboxSelection(split, requestedSessionId) : requestedSessionId ?? null;
}

/** Move through only the rows currently displayed by search/filtering, clamping at each end. */
export function inboxSelectionAfterMove(
  displayedIds: readonly string[],
  currentId: string | null | undefined,
  direction: InboxDirection,
): string | null {
  if (displayedIds.length === 0) return null;
  const currentIndex = currentId == null ? -1 : displayedIds.indexOf(currentId);
  if (currentIndex < 0) return direction === "previous" ? displayedIds.at(-1)! : displayedIds[0]!;
  const delta = direction === "next" ? 1 : -1;
  const nextIndex = Math.min(displayedIds.length - 1, Math.max(0, currentIndex + delta));
  return displayedIds[nextIndex]!;
}

/** Select the row that slides into the removed row's slot, or the new last row at list end. */
export function inboxSelectionAfterRemoval(
  displayedIds: readonly string[],
  removedId: string,
): string | null {
  const removedIndex = displayedIds.indexOf(removedId);
  if (removedIndex < 0) return displayedIds[0] ?? null;
  if (displayedIds.length <= 1) return null;
  return displayedIds[removedIndex + 1] ?? displayedIds[removedIndex - 1] ?? null;
}

export interface InboxArchiveSelection {
  apply: boolean;
  sessionId: string | null;
}

/** Advance only when the archived row still owns selection after its async request settles. */
export function inboxSelectionAfterArchive(
  displayedIds: readonly string[],
  archivedId: string,
  selectionAtRequest: string | null,
  currentSelection: string | null,
): InboxArchiveSelection {
  if (selectionAtRequest !== archivedId || currentSelection !== selectionAtRequest) {
    return { apply: false, sessionId: currentSelection };
  }
  return { apply: true, sessionId: inboxSelectionAfterRemoval(displayedIds, archivedId) };
}

/** Cycle split tabs in either direction, wrapping at the ends. */
export function nextInboxSplitKey(
  splitKeys: readonly InboxSplitKey[],
  currentKey: InboxSplitKey,
  direction: InboxDirection,
): InboxSplitKey {
  if (splitKeys.length === 0) return currentKey;
  const currentIndex = splitKeys.indexOf(currentKey);
  if (currentIndex < 0) return direction === "previous" ? splitKeys.at(-1)! : splitKeys[0]!;
  const delta = direction === "next" ? 1 : -1;
  return splitKeys[(currentIndex + delta + splitKeys.length) % splitKeys.length]!;
}

/**
 * Accumulate arrivals in observed order. Missing ids remain as tombstones until lease release so a
 * removed selected row can still repair against the slot the user was actually seeing.
 */
export function extendInboxHeldOrder(
  currentIds: readonly string[],
  nextIds: readonly string[],
): string[] {
  const extended = [...currentIds];
  const extendedSet = new Set(extended);
  for (const id of nextIds) {
    if (!extendedSet.has(id)) {
      extended.push(id);
      extendedSet.add(id);
    }
  }
  return extended;
}

/**
 * Project the latest Inbox membership through a held visual order. Existing rows retain their
 * relative positions, removed rows disappear immediately, and genuinely new rows append.
 */
export function reconcileInboxOrder(
  currentIds: readonly string[],
  nextIds: readonly string[],
): string[] {
  const nextSet = new Set(nextIds);
  const projected = currentIds.filter((id) => nextSet.has(id));
  const projectedSet = new Set(projected);
  for (const id of nextIds) {
    if (!projectedSet.has(id)) {
      projected.push(id);
      projectedSet.add(id);
    }
  }
  return projected;
}

/** Keep current row objects live while applying an interaction-held id order. */
export function reconcileInboxItems<T>(
  currentIds: readonly string[],
  nextItems: readonly T[],
  getId: (item: T) => string,
): T[] {
  const itemById = new Map(nextItems.map((item) => [getId(item), item]));
  return reconcileInboxOrder(currentIds, [...itemById.keys()])
    .map((id) => itemById.get(id))
    .filter((item): item is T => item !== undefined);
}

/**
 * Repair a vanished selection against the order the user was actually seeing. The row occupying
 * the removed row slot wins, falling back to the preceding row at the end of the list.
 */
export function repairInboxSelectionForHeldOrder(
  snapshotLoaded: boolean,
  nextIds: readonly string[],
  heldIds: readonly string[] | null,
  selectedId: string | null,
): string | null {
  if (!snapshotLoaded) return selectedId;
  if (selectedId && nextIds.includes(selectedId)) return selectedId;
  if (nextIds.length === 0) return null;
  if (!heldIds) return nextIds[0]!;
  const nextSet = new Set(nextIds);
  const survivors = heldIds.filter((id) => nextSet.has(id));
  if (survivors.length === 0) return nextIds[0]!;
  const priorVisibleSet = new Set(nextIds);
  if (selectedId) priorVisibleSet.add(selectedId);
  const priorVisibleIds = heldIds.filter((id) => priorVisibleSet.has(id));
  const removedIndex = selectedId ? priorVisibleIds.indexOf(selectedId) : -1;
  if (removedIndex < 0) return survivors[0]!;
  return survivors[Math.min(removedIndex, survivors.length - 1)]!;
}

/**
 * Resolve a single-letter triage intent only from semantic option kinds. Never infer intent from
 * provider-authored labels or ids, never pick among multiple matching choices, and never treat a
 * structured question as a binary approval.
 */
export function approvalOptionForIntent(
  approval: PendingApproval | null | undefined,
  intent: InboxApprovalIntent,
): PermissionOption | null {
  if (!approval || approval.kind === "question") return null;
  const kind = intent === "approve" ? "allow_once" : "reject_once";
  const matches = approval.options.filter((option) => option.kind === kind);
  return matches.length === 1 ? matches[0]! : null;
}

export function clampInboxSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return INBOX_SPLIT_RATIO_DEFAULT;
  return Math.min(INBOX_SPLIT_RATIO_MAX, Math.max(INBOX_SPLIT_RATIO_MIN, ratio));
}

export const clampInboxRatio = clampInboxSplitRatio;

export function parseInboxSplitRatio(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === "") return INBOX_SPLIT_RATIO_DEFAULT;
  return clampInboxSplitRatio(Number(raw));
}

export function serializeInboxSplitRatio(ratio: number): string {
  return String(clampInboxSplitRatio(ratio));
}

/**
 * Whether the Inbox list should restore its saved scroll position for a surface change.
 *
 * The owning effect is keyed on the surface session id, so it re-runs on EVERY selection change,
 * not just when the expanded view opens or closes. Restoring unconditionally overwrote the scroll
 * that keyboard navigation had just performed — in a later animation frame — which is why walking
 * the list with J/K left the highlighted row off-screen once it passed the first screenful.
 *
 * Restore only when collapsing back FROM the expanded view; that is the single case where the list
 * was unmounted and genuinely needs its position back.
 */
export function shouldRestoreInboxScroll(
  previous: { expanded: boolean } | null,
  expanded: boolean,
): boolean {
  return !expanded && previous?.expanded === true;
}
