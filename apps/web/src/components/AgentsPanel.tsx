import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pendingRequests, type ChildSessionAttentionOwner,
  type ChildSessionRegistryEntry, type ChildSessionRegistryPage, type PendingApproval, type PodView, type RunView, type SessionView,
  type WorkflowInstanceView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { deriveSubagentLifecycle, IncrementalSubagentProjector, type SubagentDescriptor } from "../subagents.js";
import { useLiveSession, useStoreActions, useStoreSelector } from "../store.js";
import { useTimelineClock } from "../timeline-clock.js";
import type { TimelineItem } from "../timeline.js";
import { isCurrentWorker, pendingRequestsByOwner, subagentStatusContext, workerRoster, type WorkerGroup,
  type WorkerMemberMetadata, type WorkerRow } from "../worker-roster.js";
import { attentionAskers, attentionSentence, attentionTitle, memberAttentionAskers, memberSessions, offlineAttentionSentence,
  type AttentionAsker } from "../worker-attention.js";
import { runnerDisplay } from "../runners.js";
import { WorkerDetail } from "./WorkerDetail.js";
import { WorkerRowItem } from "./WorkerRowItem.js";
import { useDelayedFlag, type BackgroundWorkPanelProps } from "./BackgroundWorkPanel.js";
import { JobDetail } from "./JobDetail.js";
import { SessionQuestionBanner } from "./SessionApproval.js";
import { RequestCard } from "./requests/RequestCard.js";
import { PanelPageTitle, usePanelPages } from "./PanelPages.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";
import { BusyButton } from "./ui/BusyButton.js";
import { BotIcon } from "./Icons.js";
import { ListFoot } from "./ListFoot.js";
import { Notice } from "./Notice.js";
import { PanelNoticeSlot } from "./PanelNoticeSlot.js";
import { PANEL_NOTICE_RANK, revealSessionNotice, type SessionNoticeEntry } from "./SessionNoticeSlot.js";
import { State } from "./State.js";

const PAGE_SIZE = 50;
const REGISTRY_AUTO_RETRY_LIMIT = 2;
/**
 * Transcript progress alone is weak evidence that the child roster moved: a streaming turn bumps
 * `lastEventAt`/`messageCount` on every event, and refreshing on each one re-read every loaded page
 * about once a second for the whole turn (#1207). It is not *no* evidence either — a child whose
 * tool row sits outside the loaded window changes its durable lifecycle without anything observable
 * in `items` — so progress keeps driving refreshes, at this bounded idle cadence instead.
 */
const REGISTRY_IDLE_REFRESH_MS = 15_000;
/** Roster-affecting evidence refreshes promptly, coalesced to at most one refresh per second. */
const REGISTRY_ACTIVE_REFRESH_MS = 1_000;
/**
 * The page-selection rules decide what a refresh may skip, and each rests on a predicate about the
 * control plane — that a settled child stays settled, that a loaded transcript row is current. Every
 * Nth idle-cadence refresh sweeps every loaded page regardless (N = 4, about once a minute at the
 * 15 s idle tick), so a predicate that is ever wrong costs bounded staleness, never a permanently
 * stale row (#1290). The backstop is a count, not a timer: it arms nothing, so nothing outlives the
 * panel, and a rejected sweep is simply retried at the next Nth idle refresh. Active-tier refreshes
 * neither count nor sweep, so roster changes keep their targeted cost.
 */
export const REGISTRY_SWEEP_EVERY_IDLE_REFRESHES = 4;
type RegistryRetry = { generation: string; after: number; attempt: number };

export function mergeDurableAgents(
  durableAgents: readonly SubagentDescriptor[],
  loadedAgents: readonly SubagentDescriptor[],
  unresolvedOwnerIds: ReadonlySet<string> = new Set(),
): SubagentDescriptor[] {
  const safeDurable = durableAgents.filter((agent) => !unresolvedOwnerIds.has(agent.id));
  const safeLoaded = loadedAgents.filter((agent) => !unresolvedOwnerIds.has(agent.id));
  const loaded = new Map(safeLoaded.map((agent) => [agent.id, agent]));
  return safeDurable.map((durable) => {
    const live = loaded.get(durable.id);
    if (!live) return durable;
    const durableAt = durable.lastActivityAt ?? durable.completedAt ?? durable.startedAt ?? 0;
    const liveAt = live.lastActivityAt ?? live.completedAt ?? live.startedAt ?? 0;
    const terminal = (value: SubagentDescriptor["lifecycle"]) =>
      value === "completed" || value === "failed" || value === "interrupted";
    const durableIsTerminal = terminal(durable.lifecycle);
    const liveIsTerminal = terminal(live.lifecycle);
    const liveIsNewer = durableIsTerminal === liveIsTerminal
      ? liveAt > durableAt
      : liveIsTerminal;
    const state = liveIsNewer ? live : durable;
    return { ...live, ...durable,
      title: durable.title === "Subagent" ? live.title : durable.title,
      role: durable.role ?? live.role,
      lifecycle: state.lifecycle,
      toolStatus: state.toolStatus,
      availability: state.availability,
      lastActivityAt: Math.max(durable.lastActivityAt ?? 0, live.lastActivityAt ?? 0),
      completedAt: state.completedAt,
      toolCount: Math.max(durable.toolCount ?? 0, live.toolCount ?? 0),
      latestTool: state.latestTool,
      directUsage: live.directUsage,
      inclusiveUsage: live.inclusiveUsage };
  });
}

/** One refreshed page, with the `after` cursor it was requested at. */
export type RefreshedRegistryPage = {
  after: number;
  children: readonly ChildSessionRegistryEntry[];
  truncated: boolean;
};

/**
 * Fold refreshed pages into the registry the panel already holds, leaving the pages this refresh
 * had no reason to re-read untouched. A page answers for the whole `sourceSeq` range it covers — up
 * to its last entry when truncated, and to the end of the registry when not — so a child the control
 * plane has stopped identifying is dropped rather than kept alive by a page nobody re-read (#1289).
 *
 * Pages apply in the order they were read, each replacing its own range, so where two responses
 * overlap the later one wins: a child the control plane dropped between the two requests is not
 * revived by the earlier response that still listed it.
 */
export function mergeRefreshedRegistryPages(
  existing: readonly ChildSessionRegistryEntry[],
  fetched: readonly RefreshedRegistryPage[],
): ChildSessionRegistryEntry[] {
  let merged: readonly ChildSessionRegistryEntry[] = existing;
  for (const page of fetched) {
    const through = page.truncated ? page.children.at(-1)?.sourceSeq ?? page.after : Number.POSITIVE_INFINITY;
    const byId = new Map(merged
      .filter((child) => child.sourceSeq <= page.after || child.sourceSeq > through)
      .map((child) => [child.toolCallId, child]));
    for (const child of page.children) byId.set(child.toolCallId, child);
    merged = [...byId.values()];
  }
  return [...merged].sort((a, b) => a.sourceSeq - b.sourceSeq);
}

/**
 * The durable child-session registry's agents as subagent descriptors, the form the transcript
 * projection uses, so `mergeDurableAgents` can join them. Shared with the Session Tools list (#2844).
 */
export function durableAgentDescriptors(
  registry: readonly ChildSessionRegistryEntry[],
  sessionStatus: SessionView["status"],
  runnerOnline: boolean,
): SubagentDescriptor[] {
  const byId = new Map(registry.map((child) => [child.toolCallId, child]));
  const childIds = new Map<string, string[]>();
  for (const child of registry) if (child.parentToolUseId && byId.has(child.parentToolUseId)) {
    childIds.set(child.parentToolUseId, [...(childIds.get(child.parentToolUseId) ?? []), child.toolCallId]);
  }
  const depth = (child: ChildSessionRegistryEntry): number => {
    let value = 0;
    let parent = child.parentToolUseId;
    const seen = new Set([child.toolCallId]);
    while (parent && byId.has(parent) && !seen.has(parent)) { seen.add(parent); value += 1; parent = byId.get(parent)?.parentToolUseId; }
    return value;
  };
  return registry.map((child) => ({
    id: child.toolCallId,
    ...(child.parentToolUseId && byId.has(child.parentToolUseId) ? { parentId: child.parentToolUseId } : {}),
    childIds: childIds.get(child.toolCallId) ?? [],
    title: child.name,
    ...(child.role ? { role: child.role } : {}),
    depth: depth(child),
    sourceIndex: child.sourceSeq,
    lifecycle: deriveSubagentLifecycle(child.status, sessionStatus, runnerOnline, child.lifecycle),
    toolStatus: child.status,
    availability: runnerOnline ? "live" : "recorded",
    startedAt: child.startedAt,
    lastActivityAt: child.lastActivityAt,
    ...(child.completedAt == null ? {} : { completedAt: child.completedAt }),
    toolCount: child.toolCount,
    ...(child.latestTool ? { latestTool: child.latestTool } : {}),
  }));
}

export function mergeCompactAttentionOwners(
  registryOwners: readonly ChildSessionAttentionOwner[],
  sessionOwners: readonly ChildSessionAttentionOwner[],
): ChildSessionAttentionOwner[] {
  const key = (owner: ChildSessionAttentionOwner) => JSON.stringify([owner.requestId, owner.toolCallId]);
  const byRequest = new Map(registryOwners.map((owner) => [key(owner), owner]));
  for (const owner of sessionOwners) {
    const ownerKey = key(owner);
    const current = byRequest.get(ownerKey);
    if (!current) byRequest.set(ownerKey, owner);
    else if (!current.resolved || !owner.resolved) {
      byRequest.set(ownerKey, { requestId: owner.requestId, toolCallId: owner.toolCallId, resolved: false });
    }
  }
  return [...byRequest.values()];
}

export function shouldOpenPrimaryRequestInSession(
  request: SessionView["pendingApproval"] | undefined,
  hasOpenHandler: boolean,
): boolean {
  // The session's own requests, questions included, are all on its request dock (#2179, #2205); a
  // worker's, a question too, is answered here.
  return Boolean(hasOpenHandler && request && !request.ownerToolUseId);
}

export function childRegistryProgressKey(
  session: Pick<SessionView, "messageCount" | "lastEventAt" | "status" | "pendingApproval">,
): string {
  return JSON.stringify([session.messageCount, session.lastEventAt, session.status,
    pendingRequests(session.pendingApproval).map((request) => request.requestId)]);
}

/**
 * The observable evidence that the child roster itself may have moved: a new or re-stated subagent
 * tool call, a child lifecycle transition, a request appearing or resolving, and the parent's own
 * status. Deliberately excludes per-call counters such as `toolCount` and `lastActivityAt`, which
 * the loaded projection already renders without consulting the registry.
 *
 * `statementCount` is the re-statement half of "new or re-stated": `TimelineBuilder` folds an
 * identical repeated `tool_call` into the row it already has, leaving `toolStatus` and `lifecycle`
 * equal while the control plane counts one more observation and may stop identifying the child at
 * all (#1289). It saturates at `MAX_TRACKED_TOOL_CALL_STATEMENTS`, so unlike `lastActivityAt` it
 * cannot move more than twice per child over a session — a bounded signal, not a per-event one.
 */
export function childRegistryRosterKey(
  session: Pick<SessionView, "status" | "pendingApproval" | "attentionOwners">,
  agents: readonly Pick<SubagentDescriptor, "id" | "toolStatus" | "lifecycle" | "statementCount">[],
): string {
  return JSON.stringify([
    session.status,
    pendingRequests(session.pendingApproval).map((request) => request.requestId),
    (session.attentionOwners ?? []).map((owner) => [owner.toolCallId, owner.resolved]),
    agents.map((agent) => [agent.id, agent.toolStatus, agent.lifecycle, agent.statementCount ?? 1]),
  ]);
}

/**
 * The same per-child evidence `childRegistryRosterKey` folds into its string, kept addressable so a
 * refresh can tell *which* child moved rather than only that something did (#1290). The key itself
 * stays the one value the cadence compares, so its format is unaffected.
 */
export function childRegistryAgentFingerprints(
  agents: readonly Pick<SubagentDescriptor, "id" | "toolStatus" | "lifecycle" | "statementCount">[],
): Map<string, string> {
  return new Map(agents.map((agent) =>
    [agent.id, JSON.stringify([agent.toolStatus, agent.lifecycle, agent.statementCount ?? 1])]));
}

/** The children whose own evidence moved between two refreshes, arrivals and departures included. */
export function changedRosterIds(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): Set<string> {
  const changed = new Set<string>();
  for (const [id, fingerprint] of next) if (previous.get(id) !== fingerprint) changed.add(id);
  for (const id of previous.keys()) if (!next.has(id)) changed.add(id);
  return changed;
}

/**
 * The control plane stamps `completedAt` exactly when it judges a child terminal, so a settled entry
 * is readable here without a second copy of its status vocabulary. A control plane that omits the
 * field reads as unsettled, which costs a re-read rather than a stale row.
 */
function isSettledRegistryEntry(child: ChildSessionRegistryEntry): boolean {
  return child.completedAt != null;
}

/**
 * How a refresh walks the registry: every loaded page chained from the control plane's own cursors,
 * or only the pages chosen for it.
 */
export type RegistryRefreshPlan =
  | { kind: "sweep"; pageCount: number }
  | { kind: "targeted"; pages: { after: number; through: number }[] };

/**
 * The pages a refresh actually has to re-read (#1290). Re-reading all `ceil(n / PAGE_SIZE)` loaded
 * pages for one child's change is the cost this removes: a page is worth a request only on
 * evidence that its own contents moved.
 *
 * - It holds a child whose roster fingerprint changed since the last refresh — the targeted case,
 *   and the one the 1 s active cadence fires on.
 * - It holds a child that is neither settled in the registry nor present in the loaded transcript.
 *   That child is the only one whose durable state can move with nothing observable in `items`,
 *   which is what the idle cadence exists to catch; a loaded child's live state is already rendered
 *   from the transcript, and a settled child cannot move again.
 * - It is the last page, where a newly spawned child lands and where the `nextAfter` cursor behind
 *   "Load More" is read from.
 *
 * Each chosen page is the held range `(after, through]`, read off the panel's own `sourceSeq`
 * ordering; responses are merged only over the ranges they answer for, so a page the refresh
 * skipped is simply left as held.
 *
 * A changed child the registry has not placed defeats all three rules: it has no page, and the
 * tail cursor cannot return it if the control plane sorted it in mid-registry. That case sweeps
 * every loaded page, as every refresh did before #1290, rather than losing the child. So does a
 * refresh the caller marks `sweepDue`: every Nth idle-cadence refresh, the backstop behind all
 * of the rules above.
 */
export function registryRefreshPlan(
  registry: readonly ChildSessionRegistryEntry[],
  changedIds: ReadonlySet<string>,
  loadedIds: ReadonlySet<string>,
  pageSize: number = PAGE_SIZE,
  sweepDue = false,
): RegistryRefreshPlan {
  const pageCount = Math.max(1, Math.ceil(registry.length / pageSize));
  const placed = new Set(registry.map((child) => child.toolCallId));
  if (sweepDue || registry.length === 0 || [...changedIds].some((id) => !placed.has(id))) {
    return { kind: "sweep", pageCount };
  }
  const pages: { after: number; through: number }[] = [];
  for (let page = 0; page < pageCount; page += 1) {
    const start = page * pageSize;
    const children = registry.slice(start, start + pageSize);
    const worthReading = page === pageCount - 1 || children.some((child) =>
      changedIds.has(child.toolCallId) ||
      (!isSettledRegistryEntry(child) && !loadedIds.has(child.toolCallId)));
    if (worthReading) {
      pages.push({ after: start === 0 ? 0 : registry[start - 1]!.sourceSeq, through: children.at(-1)!.sourceSeq });
    }
  }
  return { kind: "targeted", pages };
}

/**
 * Read the pages a plan names, returning them with the last response, whose `nextAfter` is where
 * "Load More" continues. Boundaries read off the held registry go stale the moment the control
 * plane inserts or drops an entry ahead of them, so neither mode trusts them past the first
 * request. A sweep follows each response's own `nextAfter`, leaving no gap between pages for an
 * entry the control plane dropped to survive in. A targeted page keeps reading until it has covered
 * the held range it was chosen for: an entry sorted in ahead of it pushes the page's own last entry
 * onto the next one, and that entry may be the very child the refresh was sent for. A page that
 * earlier reads already reached is resumed where they stopped, or skipped once they cover it, so no
 * range is read twice in one refresh. A cursor that fails to advance ends the read rather than
 * looping on it.
 */
export async function readRegistryRefresh(
  plan: RegistryRefreshPlan,
  fetchPage: (after: number) => Promise<ChildSessionRegistryPage>,
): Promise<{ pages: RefreshedRegistryPage[]; last: ChildSessionRegistryPage }> {
  const pages: RefreshedRegistryPage[] = [];
  const read = async (after: number) => {
    const page = await fetchPage(after);
    pages.push({ after, children: page.children, truncated: page.truncated });
    return page;
  };
  if (plan.kind === "targeted") {
    let last: ChildSessionRegistryPage | undefined;
    for (const target of plan.pages) {
      // Earlier reads answer through their own `nextAfter`, or to the end when it is null.
      const reached = last?.nextAfter;
      if (reached === null || (reached !== undefined && reached >= target.through)) continue;
      let cursor = reached !== undefined && reached > target.after ? reached : target.after;
      last = await read(cursor);
      while (last.nextAfter !== null && last.nextAfter > cursor && last.nextAfter < target.through) {
        cursor = last.nextAfter;
        last = await read(cursor);
      }
    }
    // The first target is always read, so `last` is set.
    return { pages, last: last! };
  }
  let last = await read(0);
  for (let page = 1; page < plan.pageCount && last.nextAfter !== null; page += 1) {
    last = await read(last.nextAfter);
  }
  return { pages, last };
}

/** Milliseconds to wait before the next registry refresh, measured from the last one. */
export function childRegistryRefreshDelay(rosterChanged: boolean, sinceLastRefresh: number): number {
  const floor = rosterChanged ? REGISTRY_ACTIVE_REFRESH_MS : REGISTRY_IDLE_REFRESH_MS;
  return Math.max(0, floor - Math.max(0, sinceLastRefresh));
}
/** The roster's fixed words (#2857): labels Title Case, sentences sentence case (§17.1). */
export const AGENTS_ROSTER_COPY = {
  filter: "Worker Filter",
  active: "Active",
  history: "History",
  all: "All",
  showMore: `Show ${PAGE_SIZE} More`,
  showHistory: "Show History",
  emptyActiveTitle: "No Active Workers",
  emptyActiveBody: "Workers this session starts appear here.",
  emptyHistoryTitle: "No Worker History",
  emptyHistoryBody: "Workers that finish, fail or stop move here.",
  emptyAllTitle: "No Workers",
  emptyAllBody: "Workers this session starts appear here.",
  loadingMore: "Loading more workers…",
  loading: "Loading recorded workers…",
} as const;

/** The attention notice's key in the panel's notice slot. */
export const AGENTS_ATTENTION_NOTICE = "agents-attention";
/** The notices' fixed words (#2861): titles and buttons Title Case, sentences sentence case (§17.1). */
export const AGENTS_NOTICE_COPY = {
  review: "Review in Session",
  offlineAttention: "Requests Waiting",
  registryError: "Couldn't Load Recorded Workers",
  inventoryError: "Couldn't Load Background Work",
} as const;
const AGENTS_SKELETON_DELAY_MS = 300;

/** The list foot's count: "Showing 7 of 23", "23+" while the registry has more pages to read. */
export function workerListFootLabel(shown: number, total: number, more: boolean): string {
  return `Showing ${shown} of ${total}${more ? "+" : ""}`;
}

export { opensSessionLabel } from "./WorkerRowItem.js";

export interface WorkerGroupView {
  group: WorkerGroup;
  /** Every row the filter keeps in this group, shown or not. */
  count: number;
  rows: { row: WorkerRow; nested: boolean; lastNested: boolean }[];
}

/**
 * The filtered roster as headed groups (§5.2), in order of each group's first row, with a nested
 * worker directly under the worker that spawned it. Children indent once whatever their depth, as
 * threaded families do; a child whose parent the filter hides stands on its own. Only the first
 * `limit` rows show, counted across groups, so the list foot's count is the reader's.
 */
export function groupWorkerRows(rows: readonly WorkerRow[], limit: number): { groups: WorkerGroupView[]; shown: number } {
  const byGroup = new Map<string, WorkerRow[]>();
  const groupOf = new Map<string, WorkerGroup>();
  for (const row of rows) {
    if (!byGroup.has(row.group.id)) { byGroup.set(row.group.id, []); groupOf.set(row.group.id, row.group); }
    byGroup.get(row.group.id)!.push(row);
  }
  const groups: WorkerGroupView[] = [];
  let remaining = limit;
  for (const [id, members] of byGroup) {
    const present = new Set(members.map((row) => row.id));
    const children = new Map<string, WorkerRow[]>();
    for (const row of members) if (row.parentId && present.has(row.parentId)) {
      children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
    }
    const ordered: { row: WorkerRow; nested: boolean }[] = [];
    const placed = new Set<string>();
    const place = (row: WorkerRow, nested: boolean) => {
      if (placed.has(row.id)) return;
      placed.add(row.id);
      ordered.push({ row, nested });
      for (const child of children.get(row.id) ?? []) place(child, true);
    };
    for (const row of members) if (!row.parentId || !present.has(row.parentId)) place(row, false);
    // A parent cycle has no root; its rows still show, unnested.
    for (const row of members) place(row, false);
    const visible = ordered.slice(0, Math.max(0, remaining));
    remaining -= visible.length;
    if (visible.length === 0) continue;
    groups.push({ group: groupOf.get(id)!, count: members.length,
      rows: visible.map((entry, index) => ({ ...entry, lastNested: entry.nested && !visible[index + 1]?.nested })) });
  }
  return { groups, shown: Math.min(limit, rows.length) };
}

/**
 * The facts the roster knows about this session's member sessions: the heading each sits under (its
 * run's title, or its pod's; "Workflow" while a workflow's run is not loaded), the run title its own
 * title repeats, and its workflow phase.
 */
export function memberMetadata(
  session: Pick<SessionView, "runId">,
  run: Pick<RunView, "title" | "sessionIds"> | undefined,
  pod: Pick<PodView, "id" | "title" | "members"> | undefined,
  workflows: readonly Pick<WorkflowInstanceView, "nodeStates">[],
): Map<string, WorkerMemberMetadata> {
  const metadata = new Map<string, WorkerMemberMetadata>();
  // A member sits under its run's title, or its pod's; a workflow member's run may not be loaded.
  const runGroup: WorkerGroup | undefined = session.runId
    ? { id: `run:${session.runId}`, name: run?.title ?? "Workflow" } : undefined;
  const runFacts = runGroup ? { group: runGroup, ...(run?.title ? { runTitle: run.title } : {}) } : {};
  for (const member of pod?.members ?? []) metadata.set(member.sessionId, { role: member.role,
    group: { id: `pod:${pod!.id}`, name: pod!.title } });
  for (const id of run?.sessionIds ?? []) metadata.set(id, { ...metadata.get(id), ...runFacts });
  for (const workflow of workflows) for (const node of workflow.nodeStates) {
    if (node.sessionId) metadata.set(node.sessionId, {
      ...metadata.get(node.sessionId), ...runFacts, phase: node.nodeId, activations: node.attemptCount,
      ...(node.status === "succeeded" || node.status === "skipped" ? { terminalState: "completed" as const }
        : node.status === "failed" ? { terminalState: "failed" as const }
        : node.status === "stopped" ? { terminalState: "stopped" as const } : {}),
      completedAt: node.completedAt,
    });
  }
  return metadata;
}

type Props = Pick<BackgroundWorkPanelProps,
  "runnerProtocolVersion" | "parentTurns" | "onViewTurn" | "inventoryError" | "onRetryInventory"> & {
    session: SessionView;
    items: TimelineItem[];
    runnerOnline: boolean;
    /** True while the reader is showing a bounded window with older turns still unloaded. */
    earlierActivityUnloaded?: boolean;
    /** The subagent selected in the panel's shared state; the transcript's Open names it. */
    requestedId?: string | null;
    /** A request, from outside the panel, to open `requestedId`'s page. */
    focusRequest?: number;
    onFocusRequestHandled?: (request: number) => void;
    /** With `focusRequest`, focus lands on the worker's pending request rather than the page title. */
    focusPendingRequest?: boolean;
    onSelect: (id: string) => void;
    onOpenPrimaryRequest?: (requestId: string) => void;
    attentionTarget?: import("../navigation.js").AttentionTarget;
    /** Switch the panel to Background Work with this job's page open. */
    onOpenInBackgroundWork?: (jobId: string) => void;
  };

/** The worker page's key, as pushed onto the panel's pages: the transcript's Open and #2861 use it. */
export const subagentPageKey = (id: string) => `subagent:${id}`;

/**
 * One roster retains each transport's own detail and response boundary. A worker or a job opens as a
 * page inside the panel (#2856), and so does a subagent opened from the transcript. A subagent's
 * pending request is answered on its page (#2860); a request no page can carry stays in Worker
 * Attention.
 */
export function AgentsPanel(props: Props) {
  const api = useApi();
  const { items, runnerOnline, requestedId, focusRequest, onFocusRequestHandled } = props;
  const pages = usePanelPages();
  const rosterId = `worker-roster-${useId().replace(/:/g, "")}`;
  // The registry refreshes as the session's message count and activity move, which the session view
  // does not render for (#2872).
  const session = useLiveSession(props.session);
  const sessions = useStoreSelector((state) => state.sessions);
  const runs = useStoreSelector((state) => state.runs);
  const runners = useStoreSelector((state) => state.runners);
  const pods = useStoreSelector((state) => state.pods);
  const [workflows, setWorkflows] = useState<WorkflowInstanceView[]>([]);
  const [workflowError, setWorkflowError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setWorkflows([]);
    setWorkflowError(false);
    if (session.runId) {
      const runId = session.runId;
      const refresh = async () => {
        try {
          const result = await api.workflowInstances(runId);
          if (!disposed) { setWorkflows(result); setWorkflowError(false); }
        } catch {
          if (!disposed) setWorkflowError(true);
        } finally {
          if (!disposed) timer = setTimeout(refresh, 15_000);
        }
      };
      void refresh();
    }
    return () => { disposed = true; clearTimeout(timer); };
  }, [api, session.runId]);
  const { navigate, loadSession } = useStoreActions();
  const projector = useRef(new IncrementalSubagentProjector());
  const projection = useMemo(() => projector.current.project(items, {
    sessionStatus: session.status, runnerOnline,
    availability: runnerOnline ? "live" : "recorded",
  }), [items, runnerOnline, session.status]);
  const rosterKey = useMemo(() => childRegistryRosterKey(session, projection.descriptors),
    // The whole point is a fingerprint that ignores the rest of `session`; listing it would rebuild
    // this on every streamed event, which is the cost being removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.status, session.pendingApproval, session.attentionOwners, projection.descriptors]);
  const progressKey = useMemo(() => childRegistryProgressKey(session),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.messageCount, session.lastEventAt, session.status, session.pendingApproval]);
  const agentFingerprints = useMemo(() => childRegistryAgentFingerprints(projection.descriptors),
    [projection.descriptors]);
  const loadedAgentIds = useMemo(() => new Set(projection.descriptors.map((agent) => agent.id)),
    [projection.descriptors]);
  const refreshedRosterKey = useRef(rosterKey);
  const refreshedFingerprints = useRef<ReadonlyMap<string, string>>(agentFingerprints);
  const [registry, setRegistry] = useState<ChildSessionRegistryEntry[] | null>(null);
  const [attentionOwners, setAttentionOwners] = useState<ChildSessionAttentionOwner[]>([]);
  const [registryAfter, setRegistryAfter] = useState<number | null>(0);
  const [unidentifiedChildren, setUnidentifiedChildren] = useState(0);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryUnavailable, setRegistryUnavailable] = useState(false);
  const [registryRetry, setRegistryRetry] = useState<RegistryRetry | null>(null);
  const [registryRetryAfter, setRegistryRetryAfter] = useState<number | null>(null);
  const [registryRetryExhausted, setRegistryRetryExhausted] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const registryRequest = useRef<string | null>(null);
  const registryRef = useRef<ChildSessionRegistryEntry[] | null>(null);
  const lastRegistryRefresh = useRef(0);
  const idleRefreshes = useRef(0);
  const registryGeneration = `${session.id}:${session.eventEpoch ?? 0}`;
  useEffect(() => { registryRef.current = registry; }, [registry]);
  const loadRegistry = (after: number, attempt = 0) => {
    const key = `${registryGeneration}:${after}:attempt:${attempt}`;
    if (registryRequest.current === key) return;
    registryRequest.current = key;
    lastRegistryRefresh.current = Date.now();
    setRegistryLoading(true);
    void api.childSessions(session.id, session.eventEpoch ?? 0, after, PAGE_SIZE).then((page) => {
      if (registryRequest.current !== key) return;
      setRegistry((current) => {
        const byId = new Map((after === 0 ? [] : current ?? []).map((child) => [child.toolCallId, child]));
        for (const child of page.children) byId.set(child.toolCallId, child);
        return [...byId.values()].sort((a, b) => a.sourceSeq - b.sourceSeq);
      });
      setAttentionOwners(page.attentionOwners);
      setUnidentifiedChildren(page.unidentifiedChildren);
      setRegistryAfter(page.nextAfter);
      setRegistryUnavailable(false);
      setRegistryRetry(null);
      setRegistryRetryAfter(null);
      setRegistryRetryExhausted(false);
    }).catch((cause: unknown) => {
      if (registryRequest.current !== key) return;
      if (cause instanceof ApiError && cause.status === 409 && cause.code === "inventory_changed") {
        // A live append can invalidate a fixed-boundary scan. Keep every already verified page and
        // cursor, retry only a bounded number of times, and leave a manual recovery action.
        setRegistryUnavailable(true);
        setRegistryRetryAfter(after);
        if (attempt < REGISTRY_AUTO_RETRY_LIMIT) {
          setRegistryRetry({ generation: registryGeneration, after, attempt: attempt + 1 });
        } else {
          setRegistryRetry(null);
          setRegistryRetryExhausted(true);
          setRegistryError(cause.message);
        }
        return;
      }
      // Rolling compatibility: older control planes keep the existing honest partial-history view.
      setRegistryUnavailable(true);
      setRegistry(null);
      setRegistryAfter(null);
      setRegistryRetry(null);
      setRegistryRetryAfter(null);
      setRegistryRetryExhausted(false);
    }).finally(() => {
      if (registryRequest.current === key) {
        registryRequest.current = null;
        setRegistryLoading(false);
      }
    });
  };
  const refreshRegistry = (
    progress: string, changedIds: ReadonlySet<string>, loadedIds: ReadonlySet<string>,
    // Banked only once the pages are merged: a refresh that fails or is abandoned must leave the
    // evidence it was chasing unspent, or its pages are never selected again and the panel keeps
    // showing what it failed to re-read.
    refreshedTo: ReadonlyMap<string, string>,
    idleTier: boolean,
  ) => {
    const key = `${session.id}:${session.eventEpoch ?? 0}:refresh:${progress}`;
    if (registryRequest.current === key) return;
    registryRequest.current = key;
    // Counted only once the refresh is accepted: a callback deduplicated against the same refresh
    // still in flight reads nothing, and counting it could let the Nth idle refresh pass unswept.
    // Only the idle tier counts, so a burst of roster changes on the 1 s tier never becomes sweeps.
    const sweepDue = idleTier &&
      (idleRefreshes.current = idleRefreshes.current + 1) % REGISTRY_SWEEP_EVERY_IDLE_REFRESHES === 0;
    lastRegistryRefresh.current = Date.now();
    setRegistryLoading(true);
    const held = registryRef.current ?? [];
    const plan = registryRefreshPlan(held, changedIds, loadedIds, PAGE_SIZE, sweepDue);
    void (async () => {
      const { pages, last } = await readRegistryRefresh(plan,
        (after) => api.childSessions(session.id, session.eventEpoch ?? 0, after, PAGE_SIZE));
      if (registryRequest.current !== key) return;
      refreshedFingerprints.current = refreshedTo;
      setRegistry(mergeRefreshedRegistryPages(held, pages));
      setAttentionOwners(last.attentionOwners);
      setUnidentifiedChildren(last.unidentifiedChildren);
      setRegistryAfter(last.nextAfter);
      setRegistryUnavailable(false);
      setRegistryRetry(null);
      setRegistryRetryAfter(null);
      setRegistryRetryExhausted(false);
    })().catch(() => {
      if (registryRequest.current !== key) return;
      setRegistryUnavailable(true);
    }).finally(() => {
      if (registryRequest.current === key) {
        registryRequest.current = null;
        setRegistryLoading(false);
      }
    });
  };
  useEffect(() => {
    setRegistry(null);
    setAttentionOwners([]);
    setRegistryAfter(0);
    setUnidentifiedChildren(0);
    setRegistryUnavailable(false);
    setRegistryRetry(null);
    setRegistryRetryAfter(null);
    setRegistryRetryExhausted(false);
    registryRequest.current = null;
    refreshedRosterKey.current = rosterKey;
    refreshedFingerprints.current = agentFingerprints;
    idleRefreshes.current = 0;
    loadRegistry(0);
    // Registry generations are scoped by exact session + event epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.eventEpoch]);
  useEffect(() => {
    if (!registryRetry) return;
    if (registryRetry.generation !== registryGeneration) {
      setRegistryRetry(null);
      return;
    }
    const timer = setTimeout(() => {
      setRegistryRetry(null);
      loadRegistry(registryRetry.after, registryRetry.attempt);
    }, Math.min(1_000, 200 * (2 ** (registryRetry.attempt - 1))));
    return () => clearTimeout(timer);
    // Retry with the latest render's eventEpoch/messageCount after the prior request's finally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryRetry, registryGeneration, session.messageCount]);
  useEffect(() => {
    if (registryRef.current === null) return;
    // Both keys are strings, so a burst of events that leaves the roster alone re-runs this effect
    // without ever moving the deadline: each run reschedules the same absolute wake-up, which lands
    // one idle-cadence refresh after the last request instead of one per event (#1207).
    const rosterChanged = refreshedRosterKey.current !== rosterKey;
    const remaining = () => childRegistryRefreshDelay(rosterChanged, Date.now() - lastRegistryRefresh.current);
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        // Load More and the inventory retry start their own request without re-running this effect,
        // so they move the deadline under an already-armed timer. Fire only once the deadline has
        // actually passed; otherwise re-arm, or a refresh would both break the cadence and take the
        // request slot away from the page load still in flight.
        if (remaining() > 0) return arm();
        refreshedRosterKey.current = rosterKey;
        refreshRegistry(progressKey,
          changedRosterIds(refreshedFingerprints.current, agentFingerprints), loadedAgentIds,
          agentFingerprints, !rosterChanged);
      }, remaining());
    };
    arm();
    return () => clearTimeout(timer);
    // Event progress invalidates the durable lifecycle even when its transcript row is not loaded,
    // so it still schedules a refresh — at the idle cadence rather than per event. The generation
    // stays a dependency so a session or epoch change still cancels a timer armed for the old one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterKey, progressKey, registryGeneration]);
  const compactAttentionOwners = useMemo(() => mergeCompactAttentionOwners(
    attentionOwners, session.attentionOwners ?? [],
  ), [attentionOwners, session.attentionOwners]);
  const unresolvedOwnerIds = useMemo(() => new Set(compactAttentionOwners
    .filter((owner) => !owner.resolved).map((owner) => owner.toolCallId)), [compactAttentionOwners]);
  const durableAgents = useMemo((): SubagentDescriptor[] =>
    registry ? durableAgentDescriptors(registry, session.status, runnerOnline) : [],
  [registry, runnerOnline, session.status]);
  const agents = useMemo(() => {
    if (!registry) return projection.descriptors.filter((agent) => !unresolvedOwnerIds.has(agent.id));
    return mergeDurableAgents(durableAgents, projection.descriptors, unresolvedOwnerIds);
  }, [durableAgents, projection.descriptors, registry, unresolvedOwnerIds]);
  const machineOnline = useCallback((id: string) => id === session.runnerId ? runnerOnline : runners.get(id)?.status === "online",
    [session.runnerId, runnerOnline, runners]);
  const { members, metadata } = useMemo(() => {
    const run = session.runId ? runs.get(session.runId) : undefined;
    const pod = [...pods.values()].find((value) => value.members.some((member) => member.sessionId === session.id));
    const metadata = memberMetadata(session, run, pod, workflows);
    return { members: memberSessions(session, runs, pods, sessions, metadata.keys()), metadata };
  }, [session, runs, sessions, pods, workflows]);
  const rows = useMemo(() => {
    const unambiguousAgents = agents.map((agent) => projection.ambiguousIds.has(agent.id)
      ? { ...agent, lifecycle: "unknown" as const, availability: "recorded" as const } : agent);
    return workerRoster(session, unambiguousAgents, members, machineOnline, metadata);
  }, [session, agents, projection.ambiguousIds, members, metadata, machineOnline]);
  // Workers the transcript holds that the registry has not listed yet (past its first page): not
  // roster rows until Show More, but their own pages show them and their parents' pages list them,
  // read from the transcript as their rows will be.
  const unlistedRows = useMemo(() => {
    const listed = new Set(agents.map((agent) => agent.id));
    const unlisted = projection.descriptors.filter((agent) => !listed.has(agent.id) &&
      !projection.ambiguousIds.has(agent.id) && !unresolvedOwnerIds.has(agent.id));
    if (unlisted.length === 0) return [];
    const ids = new Set(unlisted.map((agent) => subagentPageKey(agent.id)));
    return workerRoster(session, [...agents, ...unlisted], [], () => runnerOnline).filter((row) => ids.has(row.id));
  }, [session, agents, projection, unresolvedOwnerIds, runnerOnline]);
  const [filter, setFilter] = useState<"active" | "history" | "all">("active");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [chosen, setChosen] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  useEffect(() => {
    if (requestedId && unresolvedOwnerIds.has(requestedId)) {
      setChosen(null);
      props.onSelect("");
    }
  }, [requestedId, unresolvedOwnerIds, props.onSelect]);
  const requests = pendingRequests(session.pendingApproval);
  const selectedRequest = requests.find((request) => request.requestId === requestId);
  const ownerRequests = useMemo(() => pendingRequestsByOwner(session.pendingApproval), [session.pendingApproval]);
  // The worker whose page answers a request (#2860): the one worker it names, listed here. A request
  // preserved across a runner restart is the session's to recover, and an owner that is ambiguous or
  // unresolved has no page; those stay in Worker Attention so nothing becomes unanswerable.
  const requestPageOwner = (request: PendingApproval | undefined): string | null => {
    const ownerId = request?.ownerToolUseId;
    if (!ownerId || request.recoveryReason || projection.ambiguousIds.has(ownerId) || unresolvedOwnerIds.has(ownerId)) return null;
    return agents.some((agent) => agent.id === ownerId) || projection.descriptors.some((agent) => agent.id === ownerId)
      ? ownerId : null;
  };
  // A worker page opened for its request, which takes focus once the page shows it.
  const [pageRequest, setPageRequest] = useState<{ key: string; requestId?: string; focus?: number } | null>(null);
  const pageRequestFocus = useRef(0);
  const openRequestPage = (ownerId: string, requestId: string | undefined, root: boolean) => {
    const key = subagentPageKey(ownerId);
    pages.push(key, root ? { root: true } : undefined);
    setPageRequest({ key, ...(requestId ? { requestId } : {}), focus: ++pageRequestFocus.current });
  };
  // Focus goes to the request once; the page keeps showing the request it was opened for.
  const spendRequestFocus = useCallback((focus: number) => setPageRequest((current) =>
    current?.focus === focus ? { key: current.key, ...(current.requestId ? { requestId: current.requestId } : {}) } : current), []);
  const target = props.attentionTarget;
  const targetEpochMatches = !target || target.eventEpoch === (session.eventEpoch ?? 0);
  const linkedRequestMissing = target?.requestId !== undefined && !requests.some((request) => request.requestId === target.requestId);
  const requestDetailRef = useRef<HTMLDivElement>(null);
  const selectedSecondaryRequestRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const requestOwnsFocus = useRef(false);
  // Focus moves to the attention notice in the panel's notice slot, or to the roster without one.
  // A frame later, so the slot holds the entry this commit added and no flush runs inside an effect.
  const focusAttention = () => window.requestAnimationFrame(() => {
    if (!revealSessionNotice(`panel:${session.id}`, AGENTS_ATTENTION_NOTICE, true)) panelRef.current?.focus();
  });
  const targetKey = target ? JSON.stringify([session.id, target.eventEpoch, target.requestId, target.activationId ?? 0]) : null;
  const handledTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!targetKey || handledTarget.current === targetKey) return;
    handledTarget.current = targetKey;
    setChosen(null);
    setFilter("active");
    const request = targetEpochMatches ? requests.find((value) => value.requestId === target?.requestId) : undefined;
    const pageOwner = requestPageOwner(request);
    if (request && pageOwner) {
      // A worker's request is answered on its page, with Back going to the roster (#2860).
      setRequestId(null);
      props.onSelect(pageOwner);
      openRequestPage(pageOwner, request.requestId, true);
      return;
    }
    // Any other request is answered in the roster's Worker Attention section, so a page gives way to it.
    pages.clear();
    setRequestId(targetEpochMatches && !linkedRequestMissing ? target?.requestId ?? null : null);
    const ownerId = request?.ownerToolUseId;
    props.onSelect(ownerId && !projection.ambiguousIds.has(ownerId) && !unresolvedOwnerIds.has(ownerId) ? ownerId : "");
    // The session's own request is reviewed from the attention notice, which Review in Session opens
    // on the request dock; any other is answered in the roster, where the request takes focus.
    if (!request || shouldOpenPrimaryRequestInSession(request, Boolean(props.onOpenPrimaryRequest))) focusAttention();
    else window.requestAnimationFrame(() => requestDetailRef.current?.focus());
  }, [targetKey, targetEpochMatches, linkedRequestMissing, target, requests, projection.ambiguousIds, unresolvedOwnerIds,
    props.onSelect, session.pendingApproval?.requestId, pages]);
  // The transcript's Open lands on that worker's page, with Back going to the list (#2856), and on
  // its pending request when the caller asks for that (#2861).
  useEffect(() => {
    if (focusRequest === undefined) return;
    if (requestedId && props.focusPendingRequest) openRequestPage(requestedId, undefined, true);
    else if (requestedId) pages.push(subagentPageKey(requestedId), { root: true });
    onFocusRequestHandled?.(focusRequest);
    // Each request is acted on once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);
  const primaryInSession = shouldOpenPrimaryRequestInSession(selectedRequest, Boolean(props.onOpenPrimaryRequest));
  useLayoutEffect(() => {
    if ((!selectedRequest || primaryInSession) && requestOwnsFocus.current) {
      requestOwnsFocus.current = false;
      focusAttention();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRequest?.requestId, primaryInSession, requests.length]);
  useEffect(() => {
    if (!selectedRequest) {
      selectedSecondaryRequestRef.current = null;
      return;
    }
    if (!primaryInSession) {
      selectedSecondaryRequestRef.current = selectedRequest.requestId;
      requestDetailRef.current?.focus();
      return;
    }
    if (selectedSecondaryRequestRef.current === selectedRequest.requestId) {
      selectedSecondaryRequestRef.current = null;
      props.onOpenPrimaryRequest?.(selectedRequest.requestId);
    }
  }, [selectedRequest?.requestId, primaryInSession, requests.length]);
  // The worker that asks, as the Request Card's head line names it ("Plan Reviewer, a subagent").
  const selectedRequestOwner = (() => {
    const ownerId = selectedRequest?.ownerToolUseId;
    if (!ownerId) return undefined;
    const name = (!projection.ambiguousIds.has(ownerId) ? agents.find((agent) => agent.id === ownerId)?.title : undefined) ??
      compactAttentionOwners.find((value) => value.requestId === selectedRequest.requestId && value.toolCallId === ownerId)?.name;
    return name ? `${name}, a subagent` : "A subagent";
  })();
  // Who needs the person (#2861): the session for its own requests, each subagent for its most
  // urgent, then each member session (a pod's, a run's) whose row reads an attention word.
  const askers: AttentionAsker[] = [
    ...attentionAskers(session.pendingApproval, (ownerId, request) =>
      (!projection.ambiguousIds.has(ownerId) ? agents.find((agent) => agent.id === ownerId)?.title : undefined) ??
        compactAttentionOwners.find((value) => value.requestId === request.requestId && value.toolCallId === ownerId)?.name),
    ...memberAttentionAskers(members, machineOnline,
      (member) => rows.find((row) => row.id === `session:${member.id}`)?.name ?? member.title),
  ];
  // Review in Session opens what the notice is about: the request an attention link chose, else this
  // session's top request by the request dock's priority rule, else a waiting member's session whose
  // machine is connected.
  const reviewTarget: { request: PendingApproval } | { sessionId: string } | undefined = selectedRequest
    ? { request: selectedRequest } : askers.find((asker) => asker.request) ?? askers.find((asker) => asker.online);
  const review = (target: { request?: PendingApproval; sessionId?: string }) => {
    if (target.request) reviewRequest(target.request);
    else if (target.sessionId) navigate({ name: "session", id: target.sessionId });
  };
  const reviewRequest = (request: PendingApproval) => {
    const pageOwner = requestPageOwner(request);
    if (pageOwner) {
      // A worker's request is answered on its page, with the request card on top (#2860).
      setRequestId(null);
      setChosen(subagentPageKey(pageOwner));
      props.onSelect(pageOwner);
      openRequestPage(pageOwner, request.requestId, false);
      return;
    }
    if (shouldOpenPrimaryRequestInSession(request, Boolean(props.onOpenPrimaryRequest))) {
      props.onOpenPrimaryRequest?.(request.requestId);
      return;
    }
    // A request no page or dock can carry is answered here, in the roster, which a page gives way to.
    pages.clear();
    setRequestId(request.requestId);
    const owner = request.ownerToolUseId;
    const compactOwner = compactAttentionOwners.find((value) => value.requestId === request.requestId && value.toolCallId === owner);
    if (owner && !projection.ambiguousIds.has(owner) && agents.some((agent) => agent.id === owner)) props.onSelect(owner);
    else if (compactOwner?.resolved) props.onSelect(compactOwner.toolCallId);
    else { props.onSelect(""); setChosen(null); }
    window.requestAnimationFrame(() => requestDetailRef.current?.focus());
  };
  const machine = runnerDisplay(runners.get(session.runnerId), undefined, session.runnerId).name || "The machine";
  const notices: SessionNoticeEntry[] = [];
  if (!runnerOnline) notices.push({
    key: "agents-runner-offline", severity: "warning", rank: PANEL_NOTICE_RANK.runnerOffline, title: "Machine Offline",
    render: ({ trailing }) => <Notice tone="warning" title="Machine Offline" trailing={trailing}>
      {machine} is offline. Workers are shown as Unverified until it reconnects.
    </Notice>,
  });
  if (registryRetryExhausted) notices.push({
    key: "agents-registry-error", severity: "danger", rank: PANEL_NOTICE_RANK.loadError, title: AGENTS_NOTICE_COPY.registryError,
    render: ({ trailing }) => <Notice tone="danger" title={AGENTS_NOTICE_COPY.registryError} trailing={trailing}
      actions={<button type="button" className="btn sm" onClick={() => {
        setRegistryRetryExhausted(false);
        loadRegistry(registryRetryAfter ?? 0);
      }}>Retry</button>}
      details={registryError && <div className="code-well">
        <pre>{`GET /api/sessions/${session.id}/child-sessions\nHTTP 409: ${registryError}`}</pre>
      </div>}>
      The list of recorded workers kept changing while it loaded.
    </Notice>,
  });
  // Offline, the count stays and no action is offered: nothing can be answered until the machine is
  // back, and its workers read Unverified (#2861).
  if (askers.length > 0) notices.push({
    key: AGENTS_ATTENTION_NOTICE, severity: "warning", rank: PANEL_NOTICE_RANK.attention,
    title: runnerOnline ? attentionTitle(askers) : AGENTS_NOTICE_COPY.offlineAttention,
    render: ({ trailing }) => <Notice tone="warning" trailing={trailing}
      actions={runnerOnline && reviewTarget && <button type="button" className="btn sm"
        onClick={() => review(reviewTarget)}>{AGENTS_NOTICE_COPY.review}</button>}>
      {runnerOnline ? attentionSentence(askers)
        : offlineAttentionSentence(requests.length + askers.filter((asker) => asker.sessionId).length, machine)}
    </Notice>,
  });
  if (session.backgroundJobsAvailable && !session.backgroundJobs && props.inventoryError) notices.push({
    key: "agents-inventory-error", severity: "danger", rank: PANEL_NOTICE_RANK.inventoryError, title: AGENTS_NOTICE_COPY.inventoryError,
    render: ({ trailing }) => <Notice tone="danger" title={AGENTS_NOTICE_COPY.inventoryError} trailing={trailing}
      actions={props.onRetryInventory && <button type="button" className="btn sm" onClick={props.onRetryInventory}>Retry</button>}
      details={<div className="code-well"><pre>{props.inventoryError}</pre></div>}>
      The machine&apos;s list of background jobs didn&apos;t load.
    </Notice>,
  });
  const info = (key: string, rank: number, title: string, sentence: string) => notices.push({
    key, severity: "info", rank, title,
    render: ({ trailing, onDismiss }) => <Notice tone="info" compact trailing={trailing} onDismiss={onDismiss}>{sentence}</Notice>,
  });
  if (props.earlierActivityUnloaded && (registryUnavailable || registry?.length === 0 || unidentifiedChildren > 0)) {
    info("agents-earlier-activity", PANEL_NOTICE_RANK.earlierActivityUnloaded, "Earlier Activity Not Loaded",
      "Earlier activity isn't loaded, so workers from those turns may be missing.");
  }
  if (unidentifiedChildren > 0) {
    info("agents-ambiguous-identity", PANEL_NOTICE_RANK.ambiguousIdentity,
      unidentifiedChildren === 1 ? "1 Worker Not Listed" : `${unidentifiedChildren} Workers Not Listed`,
      unidentifiedChildren === 1 ? "1 worker can't be listed because its ID is ambiguous."
        : `${unidentifiedChildren} workers can't be listed because their IDs are ambiguous.`);
  }
  if (workflowError) {
    info("agents-workflow-details", PANEL_NOTICE_RANK.workflowDetailsUnavailable, "Workflow Details Unavailable",
      "Workflow phase details aren't available. Each worker's status is still shown.");
  }
  if (!targetEpochMatches) {
    info("agents-stale-link", PANEL_NOTICE_RANK.staleAttentionLink, "Attention Link Out of Date",
      "This attention link belongs to an earlier version of the session, so no request was selected.");
  } else if (linkedRequestMissing) {
    info("agents-stale-link", PANEL_NOTICE_RANK.staleAttentionLink, "Request No Longer Pending",
      "The linked request is no longer pending, so no request was selected.");
  }
  const selectedKey = requestedId ? `subagent:${requestedId}` : chosen;
  const selected = rows.find((row) => row.id === selectedKey);
  const inFilter = (row: WorkerRow, value: typeof filter) =>
    value === "all" || (value === "active" ? isCurrentWorker(row) : !isCurrentWorker(row));
  const filtered = rows.filter((row) => inFilter(row, filter));
  const filterCounts = { active: rows.filter((row) => inFilter(row, "active")).length,
    history: rows.filter((row) => inFilter(row, "history")).length, all: rows.length };
  const listed = groupWorkerRows(filtered, limit);
  const registryHasMore = registryAfter !== null && registry !== null;
  const showSkeleton = useDelayedFlag(registryLoading && registry === null && filtered.length === 0, AGENTS_SKELETON_DELAY_MS);
  const now = useTimelineClock(rows.length > 0);
  const selectFilter = (value: typeof filter) => { setFilter(value); setLimit(PAGE_SIZE); };
  // Show More first reveals the rows already loaded, then reads the registry's next page.
  const revealsLoadedRows = filtered.length > limit;
  const showMore = () => {
    if (!revealsLoadedRows && registryAfter !== null) loadRegistry(registryAfter);
    setLimit((value) => value + PAGE_SIZE);
  };
  const openSubagentPage = (id: string) => {
    props.onSelect(id);
    pages.push(subagentPageKey(id));
  };
  // A row, in the roster or a page's Nested Workers: a subagent or a job opens its page here, and a
  // member session opens in its own place.
  const openRow = (row: WorkerRow) => {
    setChosen(row.id);
    if (row.target.kind === "subagent") openSubagentPage(row.target.id);
    else if (row.target.kind === "session") navigate({ name: "session", id: row.target.id });
    else {
      props.onSelect("");
      pages.push(row.id);
    }
  };
  const pageSubagentId = pages.current?.startsWith("subagent:") ? pages.current.slice("subagent:".length) : null;
  const pageOutput = useMemo(() => pageSubagentId === null ? [] : projector.current.timeline(pageSubagentId),
    // The projector's timeline moves with each projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projection, pageSubagentId]);
  const statusContext = useMemo(() => subagentStatusContext(session, runnerOnline, projection.ambiguousIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.status, session.pendingApproval, session.attentionOwners, runnerOnline, projection.ambiguousIds]);
  // The page on top: a subagent's, or a background job's.
  const page = pages.current === null ? null : (() => {
    const key = pages.current;
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const row = rows.find((candidate) => candidate.id === key);
    if (kind === "background") {
      return { key, title: row?.name ?? "Background Job", body: <>
        <JobDetail session={session} jobId={id} runnerOnline={runnerOnline}
          runnerProtocolVersion={props.runnerProtocolVersion} parentTurns={props.parentTurns}
          earlierActivityUnloaded={props.earlierActivityUnloaded} onViewTurn={props.onViewTurn} />
        {props.onOpenInBackgroundWork && <button type="button" className="btn sm"
          onClick={() => props.onOpenInBackgroundWork?.(id)}>Open in Background Work</button>}
      </> };
    }
    const ambiguous = projection.ambiguousIds.has(id);
    const descriptor = ambiguous ? undefined
      : agents.find((agent) => agent.id === id) ?? projection.descriptors.find((agent) => agent.id === id);
    const pageRows = unlistedRows.length === 0 ? rows : [...rows, ...unlistedRows];
    const rowOf = (rowId: string) => pageRows.find((candidate) => candidate.id === rowId);
    const worker = rowOf(key);
    const title = worker?.name ?? descriptor?.title ?? "Subagent";
    // The request an attention link or Worker Attention opened the page for, else the worker's most
    // urgent; never one another worker or the session owns.
    const named = pageRequest?.key === key && pageRequest.requestId
      ? requests.find((request) => request.requestId === pageRequest.requestId) : undefined;
    const request = [named, ownerRequests.get(id)].find((candidate) => candidate && requestPageOwner(candidate) === id);
    return { key, title, body: <WorkerDetail session={session} runnerOnline={runnerOnline}
      earlierActivityUnloaded={props.earlierActivityUnloaded}
      worker={ambiguous ? undefined : worker} lifecycle={descriptor?.lifecycle}
      unavailable={ambiguous ? "ambiguous" : worker ? undefined : registry === null && registryLoading ? "loading" : "missing"}
      parent={worker?.parentId ? rowOf(worker.parentId) : undefined}
      nested={pageRows.filter((candidate) => candidate.parentId === key)} output={pageOutput} statusContext={statusContext}
      request={request} requestOwner={`${title}, a subagent`}
      requestFocus={pageRequest?.key === key ? pageRequest.focus : undefined} onRequestFocusHandled={spendRequestFocus}
      onOpenWorker={openRow} onOpenSubagent={openSubagentPage} onBack={pages.pop} /> };
  })();
  return (
    <>
    {/* One notice for the tab's conditions, above the roster and a pushed page alike (#2861). */}
    <PanelNoticeSlot sessionId={session.id} entries={notices} />
    {/* The roster stays mounted under a page, so its rows, filter and scroll are there on Back. */}
    <div className="agents-panel" ref={panelRef} tabIndex={-1} role="region" aria-label="Worker Roster" hidden={page !== null}>
      {selectedRequest && !primaryInSession && <div ref={requestDetailRef} tabIndex={-1} role="region" aria-label="Selected Worker Request"
        onFocusCapture={() => { requestOwnsFocus.current = true; }}
        onBlurCapture={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) requestOwnsFocus.current = false;
        }}
        data-session-request-id={selectedRequest.requestId} data-session-request-session={session.id}>
        {selectedRequest.kind === "question" ? <SessionQuestionBanner key={selectedRequest.requestId}
          sessionId={session.id} requestId={selectedRequest.requestId} occurrenceId={selectedRequest.occurrenceId}
          requestedAt={selectedRequest.requestedAt} recoveryId={selectedRequest.recoveryId}
          questions={selectedRequest.questions ?? []} isAsync={selectedRequest.async}
          recoveryReason={selectedRequest.recoveryReason} recoveryAction={selectedRequest.recoveryAction}
          runnerOnline={runnerOnline} onSessionUpdate={loadSession} showKeyHints={false} />
          : <RequestCard key={selectedRequest.requestId} session={{ ...session, pendingApproval: selectedRequest }}
            request={selectedRequest} runnerOnline={runnerOnline} presentation="panel"
            owner={selectedRequestOwner} onSessionUpdate={loadSession} />}
      </div>}
      <SegmentedControl className="block" label={AGENTS_ROSTER_COPY.filter} value={filter} onChange={selectFilter}
        options={(["active", "history", "all"] as const).map((value) => ({
          value,
          label: <>{AGENTS_ROSTER_COPY[value]}<span className="count">{filterCounts[value]}</span></>,
          ariaLabel: `${AGENTS_ROSTER_COPY[value]}, ${filterCounts[value]}`,
        }))} />
      {showSkeleton && <div className="skeleton agents-skeleton" role="status" aria-live="polite">
        <span className="sr-only">{AGENTS_ROSTER_COPY.loading}</span>
        {[0, 1, 2].map((index) => <div className="row row-2" aria-hidden="true" key={index}>
          <span className="row-body"><span className="skeleton-bar title" /><span className="skeleton-bar" /></span>
        </div>)}
      </div>}
      {filtered.length === 0 && !(registryLoading && registry === null) && (filter === "active"
        ? <State compact icon={<BotIcon size={24} />} title={AGENTS_ROSTER_COPY.emptyActiveTitle}
          actions={filterCounts.history > 0 ? <button type="button" className="btn sm ghost"
            onClick={() => selectFilter("history")}>{AGENTS_ROSTER_COPY.showHistory}</button> : undefined}>
          {AGENTS_ROSTER_COPY.emptyActiveBody}
        </State>
        : filter === "history"
          ? <State compact icon={<BotIcon size={24} />} title={AGENTS_ROSTER_COPY.emptyHistoryTitle}>{AGENTS_ROSTER_COPY.emptyHistoryBody}</State>
          : <State compact icon={<BotIcon size={24} />} title={AGENTS_ROSTER_COPY.emptyAllTitle}>{AGENTS_ROSTER_COPY.emptyAllBody}</State>)}
      {listed.groups.length > 0 && <div className="agents-list">
        {listed.groups.map(({ group, count, rows: groupRows }) => {
          const headingId = `${rosterId}-${group.id}`;
          return <section key={group.id} aria-labelledby={headingId}>
            <h3 className="group-label" id={headingId}>{group.name}<span className="count">{count}</span></h3>
            <div role="list" aria-label={group.name}>
              {groupRows.map(({ row, nested, lastNested }) => (
                <WorkerRowItem key={row.id} row={row} now={now} selected={selected?.id === row.id} nested={nested}
                  lastNested={lastNested} sessionTitle={row.target.kind === "session" ? sessions.get(row.target.id)?.title : undefined}
                  onOpen={openRow} />
              ))}
            </div>
          </section>;
        })}
      </div>}
      {(revealsLoadedRows || registryHasMore) && <ListFoot>
        <span className="worker-list-count">{workerListFootLabel(listed.shown, filtered.length, registryHasMore)}</span>
        <BusyButton className="btn sm ghost" busy={!revealsLoadedRows && (registryLoading || registryRetry !== null)}
          progress={AGENTS_ROSTER_COPY.loadingMore} onClick={showMore}>{AGENTS_ROSTER_COPY.showMore}</BusyButton>
      </ListFoot>}
    </div>
    {page && (
      <div key={page.key} className="agents-page">
        <PanelPageTitle>{page.title}</PanelPageTitle>
        {page.body}
      </div>
    )}
    </>
  );
}
