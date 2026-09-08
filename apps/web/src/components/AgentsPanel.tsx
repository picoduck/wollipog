import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { pendingRequests, sessionAttentionStatus, type ChildSessionAttentionOwner,
  type ChildSessionRegistryEntry, type WorkflowInstanceView } from "@wollipog/protocol";
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

export function mergeDurableAgents(
  durableAgents: readonly SubagentDescriptor[],
  loadedAgents: readonly SubagentDescriptor[],
): SubagentDescriptor[] {
  const loaded = new Map(loadedAgents.map((agent) => [agent.id, agent]));
  const durableIds = new Set(durableAgents.map((agent) => agent.id));
  return [...durableAgents.map((durable) => ({ ...loaded.get(durable.id), ...durable,
    directUsage: loaded.get(durable.id)?.directUsage,
    inclusiveUsage: loaded.get(durable.id)?.inclusiveUsage })),
  ...loadedAgents.filter((agent) => !durableIds.has(agent.id))];
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
  const [registry, setRegistry] = useState<ChildSessionRegistryEntry[] | null>(null);
  const [attentionOwners, setAttentionOwners] = useState<ChildSessionAttentionOwner[]>([]);
  const [registryAfter, setRegistryAfter] = useState<number | null>(0);
  const [unidentifiedChildren, setUnidentifiedChildren] = useState(0);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryUnavailable, setRegistryUnavailable] = useState(false);
  const registryRequest = useRef<string | null>(null);
  const loadRegistry = (after: number) => {
    const key = `${session.id}:${session.eventEpoch ?? 0}:${after}`;
    if (registryRequest.current === key) return;
    registryRequest.current = key;
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
    }).catch(() => {
      if (registryRequest.current !== key) return;
      // Rolling compatibility: older control planes keep the existing honest partial-history view.
      setRegistryUnavailable(true);
      setRegistry(null);
      setRegistryAfter(null);
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
    registryRequest.current = null;
    loadRegistry(0);
    // Registry generations are scoped by exact session + event epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.eventEpoch]);
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
    if (!registry) return projection.descriptors;
    return mergeDurableAgents(durableAgents, projection.descriptors);
  }, [durableAgents, projection.descriptors, registry]);
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
    props.onSelect(ownerId && !projection.ambiguousIds.has(ownerId) ? ownerId : "");
    if (!request) (attentionRef.current ?? panelRef.current)?.focus();
    else window.requestAnimationFrame(() =>
      (request.requestId === session.pendingApproval?.requestId ? primaryRequestRef.current : requestDetailRef.current)?.focus());
  }, [targetKey, targetEpochMatches, linkedRequestMissing, target, requests, projection.ambiguousIds,
    props.onSelect, session.pendingApproval?.requestId]);
  const primaryInSession = Boolean(props.onOpenPrimaryRequest && selectedRequest?.requestId === session.pendingApproval?.requestId);
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
  }, [selectedRequest?.requestId, primaryInSession]);
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
          const compactOwner = attentionOwners.find((value) => value.requestId === request.requestId);
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
          label: `${value === "active" ? "Active" : value === "history" ? "History" : "All"} (${rows.filter((row) => value === "all" || (value === "active" ? isCurrentWorker(row) : !isCurrentWorker(row))).length})`,
        }))} />
      {props.earlierActivityUnloaded && registryUnavailable && <p className="hint" role="status">Earlier transcript activity is not loaded. Workers recorded only in those turns may be missing.</p>}
      {registryAfter !== null && registry !== null && <p className="hint" role="status">More recorded workers are available.</p>}
      {unidentifiedChildren > 0 && <p className="hint" role="status">{unidentifiedChildren} {unidentifiedChildren === 1 ? "worker has" : "workers have"} an ambiguous provider identity and cannot be listed safely.</p>}
      {registryLoading && registry === null && <p className="hint" role="status">Loading Recorded Workers…</p>}
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
