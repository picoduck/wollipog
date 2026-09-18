import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { pendingRequests, sessionAttentionStatus, type ChildSessionAttentionOwner,
  type ChildSessionRegistryEntry, type ChildSessionRegistryPage, type SessionView,
  type WorkflowInstanceView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { formatDuration, formatRecordedRelativeTime, titleCaseLabel } from "../format.js";
import { deriveSubagentLifecycle, IncrementalSubagentProjector, type SubagentDescriptor } from "../subagents.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useTimelineClock } from "../timeline-clock.js";
import { isCurrentWorker, workerRoster, type WorkerState, type WorkerMemberMetadata } from "../worker-roster.js";
import { SubagentsPanel } from "./SubagentsPanel.js";
import { BackgroundWorkPanel } from "./BackgroundWorkPanel.js";
import { SessionApprovalBanner } from "./SessionApproval.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

const STATE_LABELS: Record<WorkerState, string> = {
  working: "Working", waiting: "Waiting", input_required: "Input Required",
  completed: "Completed", failed: "Failed", stopped: "Stopped", unverified: "Status Unverified",
};
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
 */
export function mergeRefreshedRegistryPages(
  existing: readonly ChildSessionRegistryEntry[],
  fetched: readonly RefreshedRegistryPage[],
): ChildSessionRegistryEntry[] {
  const covered = fetched.map((page) => ({
    from: page.after,
    to: page.truncated ? page.children.at(-1)?.sourceSeq ?? page.after : Number.POSITIVE_INFINITY,
  }));
  const byId = new Map(existing
    .filter((child) => !covered.some((range) => child.sourceSeq > range.from && child.sourceSeq <= range.to))
    .map((child) => [child.toolCallId, child]));
  for (const page of fetched) for (const child of page.children) byId.set(child.toolCallId, child);
  return [...byId.values()].sort((a, b) => a.sourceSeq - b.sourceSeq);
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
  primaryRequestId: string | undefined,
  hasOpenHandler: boolean,
): boolean {
  return Boolean(hasOpenHandler && request && (request.kind === "question" || !request.ownerToolUseId) &&
    request.requestId === primaryRequestId);
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
 * every loaded page, as every refresh did before #1290, rather than losing the child.
 */
export function registryRefreshPlan(
  registry: readonly ChildSessionRegistryEntry[],
  changedIds: ReadonlySet<string>,
  loadedIds: ReadonlySet<string>,
  pageSize: number = PAGE_SIZE,
): RegistryRefreshPlan {
  const pageCount = Math.max(1, Math.ceil(registry.length / pageSize));
  const placed = new Set(registry.map((child) => child.toolCallId));
  if (registry.length === 0 || [...changedIds].some((id) => !placed.has(id))) {
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
 * onto the next one, and that entry may be the very child the refresh was sent for.
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
      last = await read(target.after);
      while (last.nextAfter !== null && last.nextAfter < target.through) last = await read(last.nextAfter);
    }
    // The plan always names the tail page, so at least one page was read.
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
type Props = ComponentProps<typeof SubagentsPanel> & Pick<ComponentProps<typeof BackgroundWorkPanel>,
  "runnerProtocolVersion" | "parentTurnEventIds" | "onOpenParentTurn" | "inventoryError" | "onRetryInventory"> & {
    onOpenPrimaryRequest?: (requestId: string) => void;
    attentionTarget?: import("../navigation.js").AttentionTarget;
  };

/** One roster retains each transport's own detail and response boundary. */
export function AgentsPanel(props: Props) {
  const api = useApi();
  const { session, items, runnerOnline, requestedId } = props;
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
  const registryRequest = useRef<string | null>(null);
  const registryRef = useRef<ChildSessionRegistryEntry[] | null>(null);
  const lastRegistryRefresh = useRef(0);
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
  ) => {
    const key = `${session.id}:${session.eventEpoch ?? 0}:refresh:${progress}`;
    if (registryRequest.current === key) return;
    registryRequest.current = key;
    lastRegistryRefresh.current = Date.now();
    setRegistryLoading(true);
    const held = registryRef.current ?? [];
    const plan = registryRefreshPlan(held, changedIds, loadedIds);
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
          agentFingerprints);
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
  const durableAgents = useMemo((): SubagentDescriptor[] => {
    if (!registry) return [];
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
      lifecycle: deriveSubagentLifecycle(child.status, session.status, runnerOnline, child.lifecycle),
      toolStatus: child.status,
      availability: runnerOnline ? "live" : "recorded",
      startedAt: child.startedAt,
      lastActivityAt: child.lastActivityAt,
      ...(child.completedAt == null ? {} : { completedAt: child.completedAt }),
      toolCount: child.toolCount,
      ...(child.latestTool ? { latestTool: child.latestTool } : {}),
    }));
  }, [registry, runnerOnline, session.status]);
  const agents = useMemo(() => {
    if (!registry) return projection.descriptors.filter((agent) => !unresolvedOwnerIds.has(agent.id));
    return mergeDurableAgents(durableAgents, projection.descriptors, unresolvedOwnerIds);
  }, [durableAgents, projection.descriptors, registry, unresolvedOwnerIds]);
  const rows = useMemo(() => {
    const run = session.runId ? runs.get(session.runId) : undefined;
    const pod = [...pods.values()].find((value) => value.members.some((member) => member.sessionId === session.id));
    const metadata = new Map<string, WorkerMemberMetadata>();
    for (const member of pod?.members ?? []) metadata.set(member.sessionId, { role: member.role, type: "Pod Member" });
    for (const workflow of workflows) for (const node of workflow.nodeStates) {
      if (node.sessionId) metadata.set(node.sessionId, {
        ...metadata.get(node.sessionId), type: "Workflow Member", phase: node.nodeId, activations: node.attemptCount,
        ...(node.status === "succeeded" || node.status === "skipped" ? { terminalState: "completed" as const }
          : node.status === "failed" ? { terminalState: "failed" as const }
          : node.status === "stopped" ? { terminalState: "stopped" as const } : {}),
        completedAt: node.completedAt,
      });
    }
    const members = [...new Set([...(run?.sessionIds ?? []), ...metadata.keys()])].flatMap((id) => {
      const member = sessions.get(id);
      return member ? [member] : [];
    });
    const unambiguousAgents = agents.map((agent) => projection.ambiguousIds.has(agent.id)
      ? { ...agent, lifecycle: "unknown" as const, availability: "recorded" as const } : agent);
    return workerRoster(session, unambiguousAgents, members, (id) => id === session.runnerId ? runnerOnline : runners.get(id)?.status === "online", metadata);
  }, [session, agents, projection.ambiguousIds, runs, sessions, runners, pods, workflows, runnerOnline]);
  const [filter, setFilter] = useState<"active" | "history" | "all">("active");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [chosen, setChosen] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [requestLimit, setRequestLimit] = useState(PAGE_SIZE);
  useEffect(() => {
    if (requestedId && unresolvedOwnerIds.has(requestedId)) {
      setChosen(null);
      props.onSelect("");
    }
  }, [requestedId, unresolvedOwnerIds, props.onSelect]);
  const requests = pendingRequests(session.pendingApproval);
  const selectedRequest = requests.find((request) => request.requestId === requestId);
  const target = props.attentionTarget;
  const targetEpochMatches = !target || target.eventEpoch === (session.eventEpoch ?? 0);
  const linkedRequestMissing = target?.requestId !== undefined && !requests.some((request) => request.requestId === target.requestId);
  const requestDetailRef = useRef<HTMLDivElement>(null);
  const primaryRequestRef = useRef<HTMLButtonElement>(null);
  const selectedSecondaryRequestRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const attentionRef = useRef<HTMLElement>(null);
  const requestOwnsFocus = useRef(false);
  const targetKey = target ? JSON.stringify([session.id, target.eventEpoch, target.requestId, target.activationId ?? 0]) : null;
  const handledTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!targetKey || handledTarget.current === targetKey) return;
    handledTarget.current = targetKey;
    setRequestId(targetEpochMatches && !linkedRequestMissing ? target?.requestId ?? null : null);
    setChosen(null);
    setFilter("active");
    const request = targetEpochMatches ? requests.find((value) => value.requestId === target?.requestId) : undefined;
    const ownerId = request?.ownerToolUseId;
    props.onSelect(ownerId && !projection.ambiguousIds.has(ownerId) && !unresolvedOwnerIds.has(ownerId) ? ownerId : "");
    if (!request) (attentionRef.current ?? panelRef.current)?.focus();
    else window.requestAnimationFrame(() =>
      (request.requestId === session.pendingApproval?.requestId ? primaryRequestRef.current : requestDetailRef.current)?.focus());
  }, [targetKey, targetEpochMatches, linkedRequestMissing, target, requests, projection.ambiguousIds, unresolvedOwnerIds,
    props.onSelect, session.pendingApproval?.requestId]);
  const primaryInSession = shouldOpenPrimaryRequestInSession(
    selectedRequest,
    session.pendingApproval?.requestId,
    Boolean(props.onOpenPrimaryRequest),
  );
  useLayoutEffect(() => {
    if ((!selectedRequest || primaryInSession) && requestOwnsFocus.current) {
      requestOwnsFocus.current = false;
      (attentionRef.current ?? panelRef.current)?.focus();
    }
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
      return;
    }
    primaryRequestRef.current?.focus();
  }, [selectedRequest?.requestId, primaryInSession, requests.length]);
  const selectedKey = requestedId ? `subagent:${requestedId}` : chosen;
  const selected = rows.find((row) => row.id === selectedKey);
  const filtered = rows.filter((row) => filter === "all" || (filter === "active" ? isCurrentWorker(row) : !isCurrentWorker(row)));
  const now = useTimelineClock(rows.length > 0);
  const selectFilter = (value: typeof filter) => { setFilter(value); setLimit(PAGE_SIZE); };
  return (
    <div className="agents-panel" ref={panelRef} tabIndex={-1} role="region" aria-label="Worker Roster">
      {!targetEpochMatches && <p role="status">This attention link belongs to an earlier session version. No request was selected.</p>}
      {targetEpochMatches && linkedRequestMissing && <p role="status">The linked request is no longer pending. No replacement request was selected.</p>}
      {requests.length > 0 && <section ref={attentionRef} tabIndex={-1} aria-label="Worker Attention" className="agents-attention">
        {requests.slice(0, requestLimit).map((request) => {
          const owner = !projection.ambiguousIds.has(request.ownerToolUseId ?? "")
            ? agents.find((agent) => agent.id === request.ownerToolUseId) : undefined;
          const compactOwner = compactAttentionOwners.find((value) => value.requestId === request.requestId &&
            value.toolCallId === request.ownerToolUseId);
          const ownerRole = owner?.role ?? compactOwner?.role;
          const attention = sessionAttentionStatus({ status: session.status,
            pendingApproval: { ...request, ownerToolUseId: undefined } });
          return <button type="button" className="btn" key={request.requestId} onClick={() => {
            setRequestId(request.requestId);
            if (owner) props.onSelect(owner.id);
            else if (compactOwner?.resolved) props.onSelect(compactOwner.toolCallId);
            else { props.onSelect(""); setChosen(null); }
          }}>
            {owner?.title ?? compactOwner?.name ?? (request.ownerToolUseId ? "Subagent" : "Session")}
            {ownerRole ? ` · ${titleCaseLabel(ownerRole)}` : ""}
            {` · ${attention?.label ?? "Input Required"}`}
            {!owner && request.ownerToolUseId && compactOwner?.resolved !== true && " · Child Owner Unavailable"}
          </button>;
        })}
        {requests.length > requestLimit && <button type="button" onClick={() => setRequestLimit((value) => value + PAGE_SIZE)}>Show More Requests</button>}
        {selectedRequest && primaryInSession && <button ref={primaryRequestRef} type="button" className="btn"
          onClick={() => props.onOpenPrimaryRequest?.(selectedRequest.requestId)}>Open Request in Session</button>}
        {selectedRequest && !primaryInSession && <div ref={requestDetailRef} tabIndex={-1} role="region" aria-label="Selected Worker Request"
          onFocusCapture={() => { requestOwnsFocus.current = true; }}
          onBlurCapture={(event) => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) requestOwnsFocus.current = false;
          }}
          data-session-request-id={selectedRequest.requestId} data-session-request-session={session.id}><SessionApprovalBanner key={selectedRequest.requestId}
          session={{ ...session, pendingApproval: selectedRequest }} runnerOnline={runnerOnline}
          onSessionUpdate={loadSession} showKeyHints={false} /></div>}
      </section>}
      <SegmentedControl label="Worker Filter" className="agents-filters" value={filter} onChange={selectFilter}
        options={(["active", "history", "all"] as const).map((value) => ({
          value,
          label: `${value === "active" ? "Active" : value === "history" ? "History" : "All"} (${rows.filter((row) => value === "all" || (value === "active" ? isCurrentWorker(row) : !isCurrentWorker(row))).length}${registryAfter !== null && registry !== null ? " Loaded" : ""})`,
        }))} />
      {props.earlierActivityUnloaded && (registryUnavailable || registry?.length === 0 || unidentifiedChildren > 0) && <p className="hint" role="status">Earlier transcript activity is not loaded. Workers recorded only in those turns may be missing.</p>}
      {registryAfter !== null && registry !== null && <p className="hint" role="status">More recorded workers are available.</p>}
      {unidentifiedChildren > 0 && <p className="hint" role="status">{unidentifiedChildren} {unidentifiedChildren === 1 ? "worker has" : "workers have"} an ambiguous provider identity and cannot be listed safely.</p>}
      {registryLoading && registry === null && <p className="hint" role="status">Loading recorded workers…</p>}
      {registryRetry && !registryRetryExhausted && <p className="hint" role="status">Recorded worker inventory changed while loading. Retrying…</p>}
      {registryRetryExhausted && <p className="hint" role="status">Recorded worker inventory kept changing.
        <button type="button" onClick={() => {
          setRegistryRetryExhausted(false);
          loadRegistry(registryRetryAfter ?? 0);
        }}>Retry Recorded Workers</button>
      </p>}
      {workflowError && <p className="hint" role="status">Workflow phase details are unavailable. Session status remains visible.</p>}
      {session.backgroundJobsAvailable && !session.backgroundJobs && <p className="hint" role="status">
        {props.inventoryError || "Loading background work…"}
        {props.inventoryError && <button type="button" onClick={props.onRetryInventory}>Retry Background Work</button>}
      </p>}
      {session.backgroundWorkTracking === "untracked" && <p className="hint">This provider does not expose a managed background-job inventory. Detached work cannot be verified.</p>}
      {session.backgroundJobsTruncated && <p className="hint">Older background-job history is outside the loaded inventory.</p>}
      {filtered.length === 0 && <p role="status">No {filter === "active" ? "active" : filter === "history" ? "historical" : "recorded"} workers in the available evidence.</p>}
      <div role="list" aria-label="Agents" className="agents-list">
        {filtered.slice(0, limit).map((row) => {
          const end = row.completedAt ?? (isCurrentWorker(row) ? now : row.lastActivityAt);
          return <div key={row.id} role="listitem">
            <button type="button" className="subagent-list-row" aria-current={selected?.id === row.id ? "true" : undefined}
              style={{ paddingLeft: 12 + Math.min(row.depth, 2) * 14 }}
              onClick={() => {
                setChosen(row.id);
                if (row.target.kind === "subagent") props.onSelect(row.target.id);
                else if (row.target.kind === "session") navigate({ name: "session", id: row.target.id });
                else props.onSelect("");
              }}>
              <span className="subagent-list-copy">
                <span className="subagent-list-title">{row.name}</span>
                <span className="subagent-list-meta">
                  <span>{row.type}</span><span>{STATE_LABELS[row.state]}</span>
                  {row.startedAt != null && end != null && <span>{formatDuration(Math.max(0, end - row.startedAt))}</span>}
                  {row.lastActivityAt != null && <span>Last Activity {formatRecordedRelativeTime(row.lastActivityAt, now)}</span>}
                  {row.model && <span>{row.model}</span>}{row.effort && <span>{row.effort}</span>}
                  {row.role && <span>{titleCaseLabel(row.role)}</span>}
                  {row.phase && <span>Phase: {row.phase}</span>}
                  {row.activations != null && <span>{row.activations} Activations</span>}
                  {row.toolCount != null && <span>{row.toolCount} {row.toolCount === 1 ? "Tool Use" : "Tool Uses"}</span>}
                  {row.latestTool && <span>{row.latestTool.active ? "Current Activity" : "Last Tool"}: {row.latestTool.title}</span>}
                  {row.tokens != null && <span>{row.tokens.toLocaleString()} {row.target.kind === "subagent" ? "Direct Tokens" : "Tokens"}</span>}
                  {row.inclusiveTokens != null && <span>{row.inclusiveTokens.toLocaleString()} Inclusive Tokens</span>}
                  {row.depth > 2 && <span>Depth {row.depth + 1}</span>}
                </span>
              </span>
            </button>
          </div>;
        })}
      </div>
      {filtered.length > limit && <button type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>Show More Workers</button>}
      {registryAfter !== null && registry !== null && <button type="button" disabled={registryLoading}
        onClick={() => loadRegistry(registryAfter)}>{registryLoading ? "Loading More Workers…" : "Load More Recorded Workers"}</button>}
      {(selected?.target.kind === "subagent" || requestedId) &&
        <SubagentsPanel {...props} detailOnly requestedId={requestedId || (selected?.target.kind === "subagent" ? selected.target.id : null)} />}
      {selected?.target.kind === "background" &&
        <BackgroundWorkPanel {...props} selectedJobId={selected.target.id} />}
    </div>
  );
}
