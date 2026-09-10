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
export const INBOX_NO_PROJECT_SPLIT_KEY = " no-project";
export const INBOX_SPLIT_RATIO_STORAGE_KEY = "wollipog.inbox.split";
export const INBOX_SELECTION_STORAGE_KEY = "wollipog.inbox.selection";
export const INBOX_SPLIT_RATIO_DEFAULT = 0.4;
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
  return session.status === "input_required" || session.pendingApproval != null;
}

export function isInboxRunning(session: Pick<SessionView, "status">): boolean {
  return session.status === "running";
}

export const INBOX_COLLAPSED_THREADS_KEY = "wollipog.inbox.collapsedThreads";

/**
 * How much a card wants the reader now. A session waiting on a decision that has also stalled has
 * waited longest; one merely waiting comes next; a running one is worth watching; the rest are
 * settled. The list orders by this before recency, so the family of an orchestrator whose child is
 * blocked rises with that child instead of sinking under whatever ran most recently.
 */
export function inboxUrgency(
  session: Pick<SessionView, "id" | "status" | "pendingApproval">,
  stalledSessionIds: ReadonlySet<string> = new Set(),
): number {
  if (isInboxBlocked(session)) return stalledSessionIds.has(session.id) ? 3 : 2;
  return isInboxActiveStatus(session.status) ? 1 : 0;
}

interface InboxOrderKey {
  pinned: boolean;
  urgency: number;
  lastEventAt: number;
  updatedAt: number;
  id: string;
}

function compareInboxOrderKeys(left: InboxOrderKey, right: InboxOrderKey): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (left.urgency !== right.urgency) return right.urgency - left.urgency;
  if (left.lastEventAt !== right.lastEventAt) return right.lastEventAt - left.lastEventAt;
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  return left.id.localeCompare(right.id);
}

function sessionOrderKey(
  session: SessionView,
  pinnedSessions: ReadonlySet<string>,
  stalledSessionIds: ReadonlySet<string>,
): InboxOrderKey {
  return {
    pinned: pinnedSessions.has(session.id),
    urgency: inboxUrgency(session, stalledSessionIds),
    lastEventAt: session.lastEventAt ?? Number.NEGATIVE_INFINITY,
    updatedAt: session.updatedAt,
    id: session.id,
  };
}

/** A family's key is its strongest member on every axis, so the whole thread sits where its most
 * urgent, most recent member would sit alone; the parent's id keeps the tiebreak deterministic. */
function familyOrderKey(own: InboxOrderKey, members: InboxOrderKey[]): InboxOrderKey {
  return members.reduce((key, member) => ({
    pinned: key.pinned || member.pinned,
    urgency: Math.max(key.urgency, member.urgency),
    lastEventAt: Math.max(key.lastEventAt, member.lastEventAt),
    updatedAt: Math.max(key.updatedAt, member.updatedAt),
    id: key.id,
  }), own);
}

/** Children present in `sessions` keyed by parent id; a child whose parent is absent has no entry
 * here and orders as a top-level session. A session can never be its own ancestor, but the input
 * is a network projection, so the walk below still guards against a cycle. */
function inboxChildrenByParent(sessions: readonly SessionView[]): Map<string, SessionView[]> {
  const present = new Set(sessions.map((session) => session.id));
  const children = new Map<string, SessionView[]>();
  for (const session of sessions) {
    const parentId = session.parentSessionId;
    if (!parentId || !present.has(parentId) || parentId === session.id) continue;
    const siblings = children.get(parentId);
    if (siblings) siblings.push(session);
    else children.set(parentId, [session]);
  }
  return children;
}

/**
 * Stable card ordering: pinned first, then urgency, then latest event, with deterministic
 * fallbacks. A session whose parent is also in the list never orders on its own: the parent and
 * every descendant travel as one family, placed by the family's strongest member, with the parent
 * first and each generation ordered among itself by the same rule (#896).
 */
export function sortInboxSessions(
  sessions: Iterable<SessionView>,
  pinnedSessions: ReadonlySet<string> = new Set(),
  stalledSessionIds: ReadonlySet<string> = new Set(),
): SessionView[] {
  const all = [...sessions];
  const childrenByParent = inboxChildrenByParent(all);
  const ownKeys = new Map(all.map((session) => [session.id, sessionOrderKey(session, pinnedSessions, stalledSessionIds)]));
  const familyKeys = new Map<string, InboxOrderKey>();
  const familyKey = (session: SessionView, trail: Set<string>): InboxOrderKey => {
    const cached = familyKeys.get(session.id);
    if (cached) return cached;
    const own = ownKeys.get(session.id)!;
    const next = new Set(trail).add(session.id);
    const members = (childrenByParent.get(session.id) ?? [])
      .filter((child) => !next.has(child.id))
      .map((child) => familyKey(child, next));
    const key = familyOrderKey(own, members);
    familyKeys.set(session.id, key);
    return key;
  };
  const ordered: SessionView[] = [];
  const emit = (session: SessionView, trail: Set<string>) => {
    ordered.push(session);
    const next = new Set(trail).add(session.id);
    const children = (childrenByParent.get(session.id) ?? [])
      .filter((child) => !next.has(child.id))
      .sort((left, right) => compareInboxOrderKeys(familyKey(left, next), familyKey(right, next)));
    for (const child of children) emit(child, next);
  };
  const present = new Set(all.map((session) => session.id));
  const roots = all.filter((session) =>
    !session.parentSessionId || !present.has(session.parentSessionId) || session.parentSessionId === session.id);
  roots.sort((left, right) => compareInboxOrderKeys(familyKey(left, new Set()), familyKey(right, new Set())));
  for (const root of roots) emit(root, new Set());
  return ordered;
}

/** The dot a child contributes to its parent's family chip. */
export type InboxThreadChildState = "blocked" | "stalled" | "running" | "done" | "idle";

export interface InboxThreadChild {
  id: string;
  title: string;
  state: InboxThreadChildState;
}

/** What a parent card says about its thread, whether or not the thread is expanded. */
export interface InboxThreadChildren {
  count: number;
  /** Children with a pending request. */
  waiting: number;
  children: InboxThreadChild[];
}

/** A row's place in its thread. Depth is visual: a grandchild indents like a child (#896). */
export interface InboxThreadPosition {
  depth: number;
  parentId: string | null;
  /** The last visible member of its parent's thread, which is where the spine ends. */
  last: boolean;
  /** Present on a parent row, expanded or collapsed. */
  children: InboxThreadChildren | null;
  collapsed: boolean;
}

export function inboxThreadChildState(
  session: Pick<SessionView, "status" | "pendingApproval">,
  stalled: boolean,
): InboxThreadChildState {
  if (isInboxBlocked(session)) return stalled ? "stalled" : "blocked";
  if (isInboxActiveStatus(session.status)) return "running";
  if (session.status === "completed") return "done";
  return "idle";
}

/** The compact rollup on the family chip. The count always leads; what follows is the one fact
 * that matters most about the children right now. */
export function inboxThreadChildrenLabel(children: InboxThreadChildren): string {
  const parts = [`${children.count} ${children.count === 1 ? "Child" : "Children"}`];
  const running = children.children.filter((child) => child.state === "running").length;
  const done = children.children.filter((child) => child.state === "done").length;
  if (children.waiting > 0) parts.push(`${children.waiting} Awaiting Input`);
  else if (running > 0) parts.push(`${running} Running`);
  else if (done === children.count) parts.push(`${done} Completed`);
  return parts.join(" · ");
}

/**
 * Thread an ordered, filtered list of rows: each parent is followed by its descendants, indented
 * one level, and a collapsed parent's descendants leave the list entirely rather than hiding
 * inside a taller row, so every row stays one card (#896). The input order is preserved for
 * everything else, which is what lets a held browsing order survive threading unchanged.
 */
export function threadInboxRows<T extends { session: SessionView }>(
  rows: readonly T[],
  collapsedParents: ReadonlySet<string>,
  stalledSessionIds: ReadonlySet<string> = new Set(),
): Array<T & { thread: InboxThreadPosition }> {
  const sessions = rows.map((row) => row.session);
  const childrenByParent = inboxChildrenByParent(sessions);
  const rowById = new Map(rows.map((row) => [row.session.id, row]));
  const present = new Set(sessions.map((session) => session.id));
  const out: Array<T & { thread: InboxThreadPosition }> = [];
  const emit = (row: T, depth: number, parentId: string | null, last: boolean, trail: Set<string>) => {
    const next = new Set(trail).add(row.session.id);
    const children = (childrenByParent.get(row.session.id) ?? []).filter((child) => !next.has(child.id));
    const summary: InboxThreadChildren | null = children.length === 0 ? null : {
      count: children.length,
      waiting: children.filter((child) => isInboxBlocked(child)).length,
      children: children.map((child) => ({
        id: child.id,
        title: child.title,
        state: inboxThreadChildState(child, stalledSessionIds.has(child.id)),
      })),
    };
    const collapsed = summary !== null && collapsedParents.has(row.session.id);
    out.push({ ...row, thread: { depth, parentId, last, children: summary, collapsed } });
    if (collapsed) return;
    children.forEach((child, index) => {
      emit(rowById.get(child.id)!, Math.min(depth + 1, 1), row.session.id, index === children.length - 1, next);
    });
  };
  for (const row of rows) {
    const parentId = row.session.parentSessionId;
    if (parentId && present.has(parentId) && parentId !== row.session.id) continue;
    emit(row, 0, null, false, new Set());
  }
  return out;
}

/** Parents in a threaded list, in list order. */
export function inboxThreadParents<T extends { session: SessionView; thread: InboxThreadPosition }>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => row.thread.children !== null);
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
    sortInboxSessions(visible, pinnedSessions, stalledSessionIds),
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
        sortInboxSessions(group.sessions, pinnedSessions, stalledSessionIds),
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
    sortInboxSessions(visible.filter((session) => session.projectId === project.id), pinnedSessions, stalledSessionIds),
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
    stalledSessionIds,
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
 * Accumulate arrivals in observed order, keeping only ids the Inbox still holds. A vanished
 * selection is retained through `keepId` so a removed selected row can still repair against the
 * slot the user was actually seeing.
 */
export function extendInboxHeldOrder(
  currentIds: readonly string[],
  nextIds: readonly string[],
  keepId: string | null = null,
): string[] {
  const nextSet = new Set(nextIds);
  // Rows that have left the Inbox are dropped: a desktop lease can live for a whole working day,
  // and retaining every departed id would grow the held order without bound. `keepId` holds the
  // one exception — a selection that just vanished, which repairInboxSelectionForHeldOrder still
  // needs in place to resolve the row that took its slot.
  const extended = currentIds.filter((id) => nextSet.has(id) || id === keepId);
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
  selectionCleared = false,
): string | null {
  if (!snapshotLoaded) return selectedId;
  if (selectedId === null && selectionCleared) return null;
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
