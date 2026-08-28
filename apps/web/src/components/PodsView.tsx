import { PodsIcon } from "./Icons.js";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  isTerminal,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type PodArbitrationMode,
  type PodContextEntry,
  type PodMemberRole,
  type PodMemberView,
  type PodOrchestrationPolicy,
  type PodReconciliation,
  type PodRelayReceipt,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { Empty, SessionStatusIndicators } from "./common.js";
import { EventTimeline } from "./EventTimeline.js";
import { sessionAgentLabel } from "./agent-options.js";
import { useTimeline } from "./useTimeline.js";
import { subscriptionRecoveryRevision } from "../ui-subscriptions.js";
import { recoverSessionHistories, sessionHistoryEpochKey } from "../history-recovery.js";
import { detailPlaceholder } from "../detail-placeholder.js";
import { selectComparisonEvents, selectComparisonHistory } from "../comparison-selectors.js";
import { transcriptPresentation } from "../transcript-presentation.js";
import { matchesShortcut } from "../shortcuts.js";
import { useFeedback } from "./FeedbackProvider.js";
import { confirmWhileAllowed } from "../confirmation-fence.js";
import { isTimelineSessionActive } from "../timeline-clock.js";

const EMPTY_MEMBER_IDS: string[] = [];
const sameMemberIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const EMPTY_POD_CONTEXT: PodContextEntry[] = [];
const DEFAULT_ORCHESTRATION_POLICY: PodOrchestrationPolicy = {
  mode: "manual",
  contextTokenBudget: 4_096,
  summaryTokenBudget: 512,
  maxTurns: 12,
  maxRepeatedOutputs: 2,
};

function shortHead(head: string | undefined): string {
  return head ? head.slice(0, 10) : "pending";
}

const PodMemberTimeline = memo(function PodMemberTimeline({
  sessionId,
  eventEpoch,
  title,
  status,
}: {
  sessionId: string;
  eventEpoch: number;
  title: string;
  status: SessionView["status"];
}) {
  const events = useStoreSelector((state) => selectComparisonEvents(state, sessionId));
  const history = useStoreSelector((state) => selectComparisonHistory(state, sessionId));
  const conn = useStoreSelector((state) => state.conn);
  const items = useTimeline(sessionId, events);
  const presentation = transcriptPresentation({ itemCount: items.length, hasOptimistic: false, working: false, history, conn });
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="compare-body measured-virtual-scroll" ref={scrollRef} role="region" aria-label={`${title} activity`} aria-busy={presentation.busy} tabIndex={0}>
      {presentation.notice === "refreshing" && <div className="muted sm" role="status">Checking for missed activity…</div>}
      {presentation.notice === "stale" && <div className="muted sm" role="status">Showing cached activity.</div>}
      {presentation.notice === "error" && <div className="muted sm" role="status">Activity refresh failed.</div>}
      {presentation.body === "timeline" ? (
        <EventTimeline
          items={items}
          sessionActive={isTimelineSessionActive(status)}
          scrollRef={scrollRef}
          historyKey={`${sessionId}:${eventEpoch}`}
        />
      ) : presentation.body === "empty" ? <div className="muted sm" role="status">No activity yet.</div>
        : presentation.body === "skeleton" ? <div className="muted sm" role="status">Loading activity…</div>
          : <div className="muted sm" role="status">Activity unavailable.</div>}
    </div>
  );
});

function ReconciliationReceipt({
  receipt,
  sessions,
}: {
  receipt: PodReconciliation;
  sessions: ReadonlyMap<string, SessionView>;
}) {
  const source = sessions.get(receipt.sourceSessionId)?.title ?? receipt.sourceSessionId;
  const target = sessions.get(receipt.targetSessionId)?.title ?? receipt.targetSessionId;
  return (
    <article className={`pod-reconcile-receipt pod-reconcile-receipt-${receipt.status}`}>
      <div className="pod-reconcile-receipt-head">
        <strong>{source} → {target}</strong>
        <span>{titleCaseLabel(receipt.status.replaceAll("_", " "))} · {relativeTime(receipt.completedAt ?? receipt.createdAt)}</span>
      </div>
      <div className="pod-reconcile-heads">
        <span>Source {shortHead(receipt.sourceHead)}</span>
        <span>Target {shortHead(receipt.targetHead)}</span>
        {receipt.resultHead && <span>Result {shortHead(receipt.resultHead)}</span>}
        {receipt.mergeBase && <span>Base {shortHead(receipt.mergeBase)}</span>}
      </div>
      {receipt.conflictPaths?.length ? (
        <div className="pod-reconcile-conflicts">Conflicts: {receipt.conflictPaths.join(", ")}</div>
      ) : null}
      {receipt.error && <div className="pod-reconcile-error">{receipt.error}</div>}
    </article>
  );
}

function PodMemberColumn({
  session,
  member,
  selected,
  removable,
  settingsDisabled,
  onToggle,
  onOpen,
  onRemove,
  onShare,
  onRole,
  onBudget,
  sharing,
}: {
  session: SessionView;
  member: PodMemberView;
  selected: boolean;
  removable: boolean;
  settingsDisabled: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRemove: () => void;
  onShare: () => void;
  onRole: (role: PodMemberRole) => void;
  onBudget: (budget: number | null) => void;
  sharing: boolean;
}) {
  const events = useStoreSelector((state) => state.events.get(session.id));
  const runnerOnline = useStoreSelector((state) => state.runners.get(session.runnerId)?.status === "online");
  const canShare = session.status !== "starting" && session.status !== "running" &&
    Boolean(events?.some((event) => event.payload.kind === "agent_message" && !event.payload.parentToolUseId && event.payload.text));
  return (
    <div className="compare-col pod-member-col">
      <div className="compare-head pod-member-head">
        <button className="pod-member-open" onClick={onOpen}>
          <span className="compare-agent">{sessionAgentLabel(session.agentName, session.driver, session.agentId)}</span>
          <span className="muted sm">{session.title}</span>
        </button>
        <SessionStatusIndicators session={session} disconnected={!runnerOnline} />
        <label className="pod-member-setting">
          <span>Role</span>
          <select
            aria-label={`Role for ${session.title}`}
            value={member.role}
            disabled={settingsDisabled}
            onChange={(event) => onRole(event.target.value as PodMemberRole)}
          >
            <option value="lead">Lead</option>
            <option value="worker">Worker</option>
            <option value="reviewer">Reviewer</option>
          </select>
        </label>
        <label className="pod-member-setting">
          <span>Context</span>
          <select
            aria-label={`Context budget for ${session.title}`}
            value={member.contextTokenBudget ?? ""}
            disabled={settingsDisabled}
            onChange={(event) => onBudget(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">Inherit</option>
            <option value="4096">4k</option>
            <option value="8192">8k</option>
            <option value="16384">16k</option>
            <option value="32768">32k</option>
          </select>
        </label>
        <label className="pod-relay-target" title="Include this member in the next manual relay">
          <input type="checkbox" checked={selected} onChange={onToggle} /> Relay
        </label>
        <button className="btn ghost sm" disabled={!canShare || sharing} onClick={onShare}>
          {sharing ? "Sharing…" : "Share Latest"}
        </button>
        {removable && <button className="btn ghost sm" onClick={onRemove}>Remove</button>}
      </div>
      <PodMemberTimeline
        sessionId={session.id}
        eventEpoch={session.eventEpoch ?? 0}
        title={session.title}
        status={session.status}
      />
    </div>
  );
}

export function PodsView({ onNewPod }: { onNewPod: () => void }) {
  const { navigate } = useStoreActions();
  const pods = useStoreSelector((state) => state.pods);
  const list = useMemo(() => [...pods.values()].sort((a, b) => b.updatedAt - a.updatedAt), [pods]);
  if (list.length === 0) {
    return <Empty
        icon={<PodsIcon size={28} />}
        title="No Collaboration Pods Yet"
        hint="Group isolated sessions to relay context across agents and runners."
        action={<button type="button" className="btn primary sm" onClick={onNewPod}>New Pod</button>}
      />;
  }
  return (
    <div className="runs-list">
      {list.map((pod) => (
        <button key={pod.id} type="button" className="run-card" onClick={() => navigate({ name: "pod", id: pod.id })}>
          <div className="run-card-head">
            <span className="run-title">{pod.title}</span>
            <span className={`pod-status pod-status-${pod.status}`}>{titleCaseLabel(pod.status)}</span>
          </div>
          <div className="run-prompt">{pod.objective || "Manual collaboration pod"}</div>
          <div className="muted sm">
            {pod.members.length} Members · {titleCaseLabel(pod.orchestration?.policy.mode.replaceAll("_", " ") ?? "manual")}
            {pod.orchestration?.state.status === "running" ? ` · turn ${pod.orchestration.state.turnsUsed}` : ""}
            {` · updated ${relativeTime(pod.updatedAt)}`}
          </div>
        </button>
      ))}
    </div>
  );
}

export function PodDetail({ podId }: { podId: string }) {
  const api = useApi();
  const { confirm } = useFeedback();
  const { eventEpoch, loadEvents, loadPodContext, navigate, recoveryAfter, beginEventHistoryLoad, failEventHistoryLoad } = useStoreActions();
  const pod = useStoreSelector((state) => state.pods.get(podId));
  const sessions = useStoreSelector((state) => state.sessions);
  const runners = useStoreSelector((state) => state.runners);
  const pods = useStoreSelector((state) => state.pods);
  const conn = useStoreSelector((state) => state.conn);
  const snapshotLoaded = useStoreSelector((state) => state.snapshotLoaded);
  const memberIds = useStoreSelector(
    (state) => state.pods.get(podId)?.members.map((member) => member.sessionId) ?? EMPTY_MEMBER_IDS,
    sameMemberIds,
  );
  const contextEntries = useStoreSelector((state) => state.podContext.get(podId) ?? EMPTY_POD_CONTEXT);
  const recoveryRevision = useStoreSelector((state) => subscriptionRecoveryRevision(
    state.streamSubscriptions,
    memberIds,
    [podId],
  ));
  const recoveryGeneration = useStoreSelector((state) => state.snapshotRevision);
  const recoveryEpochKey = useStoreSelector((state) => sessionHistoryEpochKey(
    memberIds,
    (sessionId) => state.sessions.get(sessionId)?.eventEpoch ?? 0,
  ));
  const [targets, setTargets] = useState<string[]>([]);
  const [selectedContext, setSelectedContext] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [addSessionId, setAddSessionId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<PodRelayReceipt[]>([]);
  const [beforeSeq, setBeforeSeq] = useState<number | undefined>();
  const [orchestrationMode, setOrchestrationMode] = useState<PodArbitrationMode>("manual");
  const [contextTokenBudget, setContextTokenBudget] = useState(4_096);
  const [summaryTokenBudget, setSummaryTokenBudget] = useState(512);
  const [maxTurns, setMaxTurns] = useState(12);
  const [maxRepeatedOutputs, setMaxRepeatedOutputs] = useState(2);
  const [orchestrationSeed, setOrchestrationSeed] = useState("");
  const [firstSessionId, setFirstSessionId] = useState("");
  const [reconcileSourceId, setReconcileSourceId] = useState("");
  const [reconcileTargetId, setReconcileTargetId] = useState("");

  const members = useMemo(
    () => memberIds.map((id) => sessions.get(id)).filter((session): session is SessionView => Boolean(session)),
    [memberIds, sessions],
  );
  const occupied = useMemo(
    () => new Set([...pods.values()].filter((candidate) => candidate.status === "active").flatMap((candidate) => candidate.members.map((member) => member.sessionId))),
    [pods],
  );
  const addCandidates = useMemo(
    () => [...sessions.values()]
      .filter((session) => session.useWorktree && !isTerminal(session.status) && !occupied.has(session.id))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, occupied],
  );

  useEffect(() => {
    setTargets((current) => {
      const retained = current.filter((id) => memberIds.includes(id));
      return retained.length ? retained : [...memberIds];
    });
  }, [memberIds]);

  useEffect(() => {
    if (!memberIds.length || conn !== "online" || recoveryRevision == null) return;
    let current = true;
    void recoverSessionHistories(
      memberIds.map((sessionId) => ({
        sessionId,
        after: recoveryAfter(sessionId),
        eventEpoch: eventEpoch(sessionId),
        recoveryRevision,
      })),
      {
        fetchPage: api.getSessionEventPage,
        applyPage: (id, events, pageEpoch, revision, complete) =>
          loadEvents(id, events, pageEpoch, revision, complete, recoveryGeneration),
        isCurrent: () => current,
        retryOnIdleTimeout: true,
        onRequestStart: (request) => beginEventHistoryLoad(request.sessionId, request.eventEpoch, request.recoveryRevision, recoveryGeneration),
        onRequestError: (request) => failEventHistoryLoad(request.sessionId, "Activity refresh failed.", request.eventEpoch, request.recoveryRevision, recoveryGeneration),
      },
    );
    return () => { current = false; };
  }, [api, memberIds, conn, recoveryRevision, recoveryEpochKey, recoveryGeneration, eventEpoch, loadEvents, recoveryAfter, beginEventHistoryLoad, failEventHistoryLoad]);

  useEffect(() => {
    if (!pod || conn !== "online" || recoveryRevision == null) return;
    let current = true;
    api.podContext(pod.id)
      .then((page) => {
        if (!current) return;
        loadPodContext(pod.id, page.entries);
        setBeforeSeq(page.beforeSeq);
      })
      .catch((cause) => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [api, pod?.id, conn, recoveryRevision, loadPodContext]);

  useEffect(() => {
    setSelectedContext((current) => current.filter((id) => contextEntries.some((entry) => entry.id === id)));
  }, [contextEntries]);

  const policy = pod?.orchestration?.policy ?? DEFAULT_ORCHESTRATION_POLICY;
  const orchestrationState = pod?.orchestration?.state;
  const orchestrationRunning = orchestrationState?.status === "running";
  const reconciliationRunning = Boolean(pod?.reconciliations?.some((receipt) => receipt.status === "running"));
  const closeBlocked = useRef(false);
  closeBlocked.current = Boolean(busy) || reconciliationRunning;

  useEffect(() => {
    setOrchestrationMode(policy.mode);
    setContextTokenBudget(policy.contextTokenBudget);
    setSummaryTokenBudget(policy.summaryTokenBudget);
    setMaxTurns(policy.maxTurns);
    setMaxRepeatedOutputs(policy.maxRepeatedOutputs);
  }, [policy.mode, policy.contextTokenBudget, policy.summaryTokenBudget, policy.maxTurns, policy.maxRepeatedOutputs]);

  useEffect(() => {
    if (!pod) return;
    const eligible = pod.members.filter((member) => member.role !== "lead");
    setFirstSessionId((current) => pod.members.some((member) => member.sessionId === current)
      ? current
      : (eligible[0]?.sessionId ?? pod.members[0]?.sessionId ?? ""));
  }, [pod?.members]);

  useEffect(() => {
    if (!pod) return;
    const targetDefault = pod.members.find((member) => member.role === "lead")?.sessionId ?? pod.members[0]?.sessionId ?? "";
    const sourceDefault = pod.members.find((member) => member.sessionId !== targetDefault)?.sessionId ?? "";
    setReconcileTargetId((current) => pod.members.some((member) => member.sessionId === current) ? current : targetDefault);
    setReconcileSourceId((current) => pod.members.some((member) => member.sessionId === current) && current !== targetDefault
      ? current
      : sourceDefault);
  }, [pod?.members]);

  if (!pod) {
    const placeholder = detailPlaceholder("Pod", { authoritative: snapshotLoaded, conn });
    return <Empty title={placeholder.title} hint={placeholder.hint} />;
  }
  const active = pod.status === "active";
  const policyDirty = orchestrationMode !== policy.mode || contextTokenBudget !== policy.contextTokenBudget ||
    summaryTokenBudget !== policy.summaryTokenBudget || maxTurns !== policy.maxTurns ||
    maxRepeatedOutputs !== policy.maxRepeatedOutputs;
  const lastStep = pod.orchestration?.lastStep;
  const reconcileSource = sessions.get(reconcileSourceId);
  const reconcileTarget = sessions.get(reconcileTargetId);
  const reconcileRunner = reconcileTarget ? runners.get(reconcileTarget.runnerId) : undefined;
  const reconcileCapabilityCopy = runnerCapabilityRequirement(
    reconcileRunner?.protocolVersion,
    "podReconciliation",
    "Pod worktree reconciliation",
  );
  const reconcileIssue = (() => {
    if (!active) return "This pod is closed.";
    if (orchestrationRunning) return "Stop the automatic cycle before reconciling worktrees.";
    if (reconciliationRunning) return "A reconciliation is already running for this pod.";
    if (!reconcileSource || !reconcileTarget) return "Choose a source and integration target.";
    if (reconcileSource.id === reconcileTarget.id) return "Source and integration target must be different sessions.";
    if (!reconcileSource.useWorktree || !reconcileTarget.useWorktree || !reconcileSource.worktreePath || !reconcileTarget.worktreePath) {
      return "Both sessions must use isolated worktrees.";
    }
    if (reconcileSource.runnerId !== reconcileTarget.runnerId) return "Cross-runner reconciliation is not supported.";
    if (!reconcileSource.workspaceId || reconcileSource.workspaceId !== reconcileTarget.workspaceId) {
      return "Both sessions must belong to the same configured workspace.";
    }
    if (reconcileSource.status !== "idle" || reconcileTarget.status !== "idle") return "Both sessions must be idle.";
    if (reconcileSource.pendingApproval || reconcileTarget.pendingApproval) return "Resolve pending approvals before reconciling.";
    if (reconcileRunner?.status !== "online") return "The shared runner is offline.";
    if (!runnerSupportsProtocol(reconcileRunner.protocolVersion, "podReconciliation")) return reconcileCapabilityCopy;
    return null;
  })();

  const relay = async () => {
    if (busy || orchestrationRunning || reconciliationRunning || (!text.trim() && selectedContext.length === 0) || targets.length === 0) return;
    setBusy("relay");
    setError(null);
    setReceipts([]);
    try {
      const result = await api.relayPod(pod.id, {
        ...(text.trim() ? { text: text.trim() } : {}),
        sessionIds: targets,
        contextEntryIds: selectedContext,
      });
      if (result.appendedEntry) loadPodContext(pod.id, [result.appendedEntry]);
      setReceipts(result.receipts ?? result.sessions.map((session) => ({ sessionId: session.id, status: "delivered" as const })));
      setText("");
      setSelectedContext([]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveNote = async () => {
    if (busy || !text.trim()) return;
    setBusy("note");
    setError(null);
    try {
      const result = await api.appendPodContext(pod.id, { kind: "note", text: text.trim() });
      loadPodContext(pod.id, [result.entry]);
      setText("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const shareLatest = async (sessionId: string) => {
    if (busy) return;
    setBusy(`share:${sessionId}`);
    setError(null);
    try {
      const result = await api.appendPodContext(pod.id, { kind: "member_output", sessionId });
      loadPodContext(pod.id, [result.entry]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const loadOlder = async () => {
    if (busy || beforeSeq === undefined) return;
    setBusy("older");
    setError(null);
    try {
      const page = await api.podContext(pod.id, beforeSeq);
      loadPodContext(pod.id, page.entries);
      setBeforeSeq(page.beforeSeq);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const contextSource = (entry: PodContextEntry) => entry.source.kind === "human"
    ? `Human · ${entry.source.actorId}`
    : `${entry.source.agentLabel} · ${entry.source.sessionTitle}`;

  const addMember = async () => {
    if (busy || reconciliationRunning || !addSessionId) return;
    setBusy("add");
    setError(null);
    try {
      await api.addPodMember(pod.id, { sessionId: addSessionId });
      setAddSessionId("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const removeMember = async (sessionId: string) => {
    if (busy || reconciliationRunning) return;
    setBusy(`remove:${sessionId}`);
    setError(null);
    try {
      await api.removePodMember(pod.id, sessionId);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const updateMember = async (sessionId: string, patch: { role?: PodMemberRole; contextTokenBudget?: number | null }) => {
    if (busy || orchestrationRunning || reconciliationRunning) return;
    setBusy(`member:${sessionId}`);
    setError(null);
    try {
      await api.updatePodMember(pod.id, sessionId, patch);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveOrchestration = async () => {
    if (busy || orchestrationRunning || reconciliationRunning) return;
    setBusy("orchestration-policy");
    setError(null);
    try {
      await api.updatePodOrchestration(pod.id, {
        mode: orchestrationMode,
        contextTokenBudget,
        summaryTokenBudget,
        maxTurns,
        maxRepeatedOutputs,
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const startOrchestration = async () => {
    if (busy || orchestrationRunning || reconciliationRunning || orchestrationMode === "manual") return;
    setBusy("orchestration-start");
    setError(null);
    try {
      const result = await api.startPodOrchestration(pod.id, {
        ...(orchestrationSeed.trim() ? { instruction: orchestrationSeed.trim() } : {}),
        ...((orchestrationMode === "event_triggered" || orchestrationMode === "round_robin") && firstSessionId
          ? { firstSessionId }
          : {}),
      });
      if (result.appendedEntry) loadPodContext(pod.id, [result.appendedEntry]);
      setOrchestrationSeed("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const stopOrchestration = async () => {
    if (busy || !orchestrationRunning) return;
    setBusy("orchestration-stop");
    setError(null);
    try {
      await api.stopPodOrchestration(pod.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const reconcile = async () => {
    if (busy || reconcileIssue) return;
    setBusy("reconcile");
    setError(null);
    try {
      await api.reconcilePod(pod.id, {
        sourceSessionId: reconcileSourceId,
        targetSessionId: reconcileTargetId,
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const close = async () => {
    if (!await confirmWhileAllowed(confirm, () => closeBlocked.current, {
      title: "Close this pod?",
      message: "Its membership remains readable, but relays and membership changes stop.",
      confirmLabel: "Close Pod",
      tone: "danger",
    })) return;
    setBusy("close");
    setError(null);
    try {
      await api.closePod(pod.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="run-detail pod-detail">
      <div className="detail-head">
        <button className="icon-btn back" onClick={() => navigate({ name: "pods" })} title="Back">←</button>
        <div className="detail-headinfo">
          <div className="detail-title">{pod.title}</div>
          <div className="detail-sub"><span className="muted">{pod.objective || "Manual collaboration pod"}</span></div>
        </div>
        <span className={`pod-status pod-status-${pod.status}`}>{titleCaseLabel(pod.status)}</span>
        {active && <button className="btn ghost sm" disabled={Boolean(busy) || reconciliationRunning} onClick={() => void close()}>Close Pod</button>}
      </div>

      <section className="pod-orchestration" aria-label="Pod Orchestration Policy">
        <div className="pod-relay-head">
          <div>
            <strong>Orchestration Controls</strong>
            <p className="muted sm">Durable role arbitration with per-member context cursors, bounded summaries, loop detection, and hard turn caps.</p>
          </div>
          <span className={`pod-orchestration-status pod-orchestration-status-${orchestrationState?.status ?? "idle"}`}>
            {titleCaseLabel(orchestrationState?.status ?? "idle")}
          </span>
        </div>
        <div className="pod-orchestration-grid">
          <label className="field compact">
            <span>Arbitration</span>
            <select value={orchestrationMode} disabled={!active || orchestrationRunning || reconciliationRunning || Boolean(busy)} onChange={(event) => setOrchestrationMode(event.target.value as PodArbitrationMode)}>
              <option value="manual">Manual Only</option>
              <option value="round_robin">Round Robin</option>
              <option value="lead_driven">Lead Driven</option>
              <option value="event_triggered">Event Triggered</option>
            </select>
          </label>
          <label className="field compact">
            <span>Default Context Tokens</span>
            <select value={contextTokenBudget} disabled={!active || orchestrationRunning || reconciliationRunning || Boolean(busy)} onChange={(event) => setContextTokenBudget(Number(event.target.value))}>
              <option value={4096}>4,096</option>
              <option value={8192}>8,192</option>
              <option value={16384}>16,384</option>
              <option value={32768}>32,768</option>
            </select>
          </label>
          <label className="field compact">
            <span>Summary Tokens</span>
            <input type="number" min={128} max={Math.min(4096, Math.floor(contextTokenBudget / 2))} step={128} value={summaryTokenBudget} disabled={!active || orchestrationRunning || reconciliationRunning || Boolean(busy)} onChange={(event) => setSummaryTokenBudget(Number(event.target.value))} />
          </label>
          <label className="field compact">
            <span>Turn Cap</span>
            <input type="number" min={1} max={100} value={maxTurns} disabled={!active || orchestrationRunning || reconciliationRunning || Boolean(busy)} onChange={(event) => setMaxTurns(Number(event.target.value))} />
          </label>
          <label className="field compact">
            <span>Repeated-Output Cap</span>
            <input type="number" min={2} max={5} value={maxRepeatedOutputs} disabled={!active || orchestrationRunning || reconciliationRunning || Boolean(busy)} onChange={(event) => setMaxRepeatedOutputs(Number(event.target.value))} />
          </label>
        </div>
        <div className="pod-orchestration-runner">
          <textarea
            rows={2}
            value={orchestrationSeed}
            disabled={!active || orchestrationRunning || reconciliationRunning || Boolean(busy)}
            placeholder="Optional attributed instruction for the next automatic cycle…"
            onChange={(event) => setOrchestrationSeed(event.target.value)}
          />
          {(orchestrationMode === "event_triggered" || orchestrationMode === "round_robin") && (
            <label className="field compact">
              <span>{orchestrationMode === "event_triggered" ? "Trigger Member" : "First Member"}</span>
              <select value={firstSessionId} disabled={!active || orchestrationRunning || reconciliationRunning || Boolean(busy)} onChange={(event) => setFirstSessionId(event.target.value)}>
                {pod.members
                  .filter((member) => orchestrationMode !== "event_triggered" || member.role !== "lead")
                  .map((member) => (
                    <option key={member.sessionId} value={member.sessionId}>
                      {sessions.get(member.sessionId)?.title || member.sessionId} · {titleCaseLabel(member.role)}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
        <div className="pod-orchestration-summary">
          <span>
            Turns {orchestrationState?.turnsUsed ?? 0}/{policy.maxTurns}
            {orchestrationState?.currentSessionId ? ` · active: ${sessions.get(orchestrationState.currentSessionId)?.title || orchestrationState.currentSessionId}` : ""}
            {orchestrationState?.stopReason ? ` · ${orchestrationState.stopReason}` : ""}
          </span>
          {lastStep && (
            <span>
              Last Turn #{lastStep.turn} · {sessions.get(lastStep.targetSessionId)?.title || lastStep.targetSessionId}
              {` · ${lastStep.estimatedTokens} est. tokens · ${titleCaseLabel(lastStep.status)}`}
            </span>
          )}
        </div>
        <div className="pod-relay-actions">
          <button className="btn ghost" disabled={!active || orchestrationRunning || reconciliationRunning || Boolean(busy) || !policyDirty} onClick={() => void saveOrchestration()}>
            {busy === "orchestration-policy" ? "Saving…" : policyDirty ? "Save Policy" : "Policy Saved"}
          </button>
          {orchestrationRunning ? (
            <button className="btn danger" disabled={Boolean(busy)} onClick={() => void stopOrchestration()}>
              {busy === "orchestration-stop" ? "Stopping…" : "Stop Auto-Advance"}
            </button>
          ) : (
            <button
              className="btn primary"
              disabled={!active || reconciliationRunning || Boolean(busy) || policyDirty || orchestrationMode === "manual" ||
                (orchestrationMode === "event_triggered" && !firstSessionId)}
              onClick={() => void startOrchestration()}
            >
              {busy === "orchestration-start" ? "Starting…" : "Start Automatic Cycle"}
            </button>
          )}
        </div>
      </section>

      <section className="pod-reconcile" aria-label="Pod Worktree Reconciliation">
        <div className="pod-relay-head">
          <div>
            <strong>Reconcile Committed Work</strong>
            <p className="muted sm">Merge one clean, idle member worktree into another on the same runner and workspace. Conflicts roll the target back unchanged.</p>
          </div>
          <span className={`pod-orchestration-status pod-orchestration-status-${reconciliationRunning ? "running" : "idle"}`}>
            {titleCaseLabel(reconciliationRunning ? "running" : "ready")}
          </span>
        </div>
        <div className="pod-reconcile-grid">
          <label className="field compact">
            <span>Committed Source</span>
            <select value={reconcileSourceId} disabled={!active || reconciliationRunning || Boolean(busy)} onChange={(event) => setReconcileSourceId(event.target.value)}>
              {pod.members.map((member) => (
                <option key={member.sessionId} value={member.sessionId}>
                  {sessions.get(member.sessionId)?.title || member.sessionId} · {titleCaseLabel(member.role)}
                </option>
              ))}
            </select>
          </label>
          <span className="pod-reconcile-arrow" aria-hidden="true">→</span>
          <label className="field compact">
            <span>Integration Target</span>
            <select value={reconcileTargetId} disabled={!active || reconciliationRunning || Boolean(busy)} onChange={(event) => setReconcileTargetId(event.target.value)}>
              {pod.members.map((member) => (
                <option key={member.sessionId} value={member.sessionId}>
                  {sessions.get(member.sessionId)?.title || member.sessionId} · {titleCaseLabel(member.role)}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" disabled={Boolean(busy) || Boolean(reconcileIssue)} title={reconcileIssue ?? undefined} onClick={() => void reconcile()}>
            {busy === "reconcile" ? "Reconciling…" : "Merge Committed Work"}
          </button>
        </div>
        {reconcileIssue && <p className="pod-reconcile-issue muted sm">{reconcileIssue}</p>}
        {(pod.reconciliations?.length ?? 0) > 0 && (
          <div className="pod-reconcile-receipts" aria-label="Worktree Reconciliation Receipts">
            {pod.reconciliations!.map((receipt) => (
              <ReconciliationReceipt key={receipt.reconciliationId} receipt={receipt} sessions={sessions} />
            ))}
          </div>
        )}
      </section>

      <section className="pod-relay" aria-label="Manual Pod Relay">
        <div className="pod-relay-head">
          <div>
            <strong>Manual Relay</strong>
            <p className="muted sm">Select shared-log entries, add an optional note, and relay the composed context to isolated members.</p>
          </div>
          <span className="muted sm">{targets.length}/{pod.members.length} Targets</span>
        </div>
        {error && <div className="tl-error">{error}</div>}
        {receipts.length > 0 && (
          <div className="pod-receipts" aria-label="Relay Delivery Receipts">
            {receipts.map((receipt) => (
              <span key={receipt.sessionId} className={`pod-receipt pod-receipt-${receipt.status}`}>
                {sessions.get(receipt.sessionId)?.title || receipt.sessionId}: {titleCaseLabel(receipt.status)}
                {receipt.error ? ` · ${receipt.error}` : ""}
              </span>
            ))}
          </div>
        )}
        <textarea
          rows={4}
          value={text}
          disabled={!active || Boolean(busy)}
          placeholder={active ? "Add an attributed note to the huddle log, with or without relaying it…" : "This pod is closed."}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (matchesShortcut(event.nativeEvent, "relay-pod-note")) {
              event.preventDefault();
              void relay();
            }
          }}
        />
        <div className="pod-relay-actions">
          {active && !orchestrationRunning && !reconciliationRunning && addCandidates.length > 0 && (
            <div className="pod-add-member">
              <select value={addSessionId} onChange={(event) => setAddSessionId(event.target.value)}>
                <option value="">Add an Isolated Session…</option>
                {addCandidates.map((session) => <option key={session.id} value={session.id}>{session.title} · {session.runnerId}</option>)}
              </select>
              <button className="btn ghost sm" disabled={!addSessionId || Boolean(busy)} onClick={() => void addMember()}>
                {busy === "add" ? "Adding…" : "Add Member"}
              </button>
            </div>
          )}
          <button className="btn ghost" disabled={!active || Boolean(busy) || !text.trim()} onClick={() => void saveNote()}>
            {busy === "note" ? "Saving…" : "Save Note"}
          </button>
          <button className="btn primary" disabled={!active || orchestrationRunning || reconciliationRunning || Boolean(busy) || (!text.trim() && selectedContext.length === 0) || targets.length === 0} onClick={() => void relay()}>
            {busy === "relay" ? "Relaying…" : "Relay to Selected"}
          </button>
        </div>
      </section>

      <section className="pod-context" aria-label="Shared Huddle Context">
        <div className="pod-relay-head">
          <div>
            <strong>Shared Huddle Log</strong>
            <p className="muted sm">Append-only, durable, and frozen with source attribution.</p>
          </div>
          <span className="muted sm">{selectedContext.length} Selected</span>
        </div>
        {beforeSeq !== undefined && (
          <button className="btn ghost sm" disabled={Boolean(busy)} onClick={() => void loadOlder()}>
            {busy === "older" ? "Loading…" : "Load Earlier Entries"}
          </button>
        )}
        {contextEntries.length === 0 ? (
          <p className="muted sm">No shared context yet. Save a note or share a settled member output.</p>
        ) : (
          <div className="pod-context-list">
            {contextEntries.map((entry) => (
              <label key={entry.id} className={`pod-context-entry ${selectedContext.includes(entry.id) ? "on" : ""}`}>
                <input
                  type="checkbox"
                  disabled={!active}
                  checked={selectedContext.includes(entry.id)}
                  onChange={() => setSelectedContext((current) => current.includes(entry.id)
                    ? current.filter((id) => id !== entry.id)
                    : [...current, entry.id])}
                />
                <span>
                  <span className="pod-context-meta">#{entry.seq} · {contextSource(entry)} · {relativeTime(entry.ts)}</span>
                  <span className="pod-context-content">{entry.content}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </section>

      <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${Math.max(members.length, 1)}, minmax(320px, 1fr))` }}>
        {members.map((session) => {
          const member = pod.members.find((candidate) => candidate.sessionId === session.id)!;
          return (
            <PodMemberColumn
              key={session.id}
              session={session}
              member={member}
              selected={targets.includes(session.id)}
              removable={active && !orchestrationRunning && !reconciliationRunning && pod.members.length > 2}
              settingsDisabled={!active || orchestrationRunning || reconciliationRunning || Boolean(busy)}
              onToggle={() => setTargets((current) => current.includes(session.id)
                ? current.filter((id) => id !== session.id)
                : [...current, session.id])}
              onOpen={() => navigate({ name: "session", id: session.id })}
              onRemove={() => void removeMember(session.id)}
              onShare={() => void shareLatest(session.id)}
              onRole={(role) => void updateMember(session.id, { role })}
              onBudget={(contextTokenBudget) => void updateMember(session.id, { contextTokenBudget })}
              sharing={busy === `share:${session.id}`}
            />
          );
        })}
      </div>
    </div>
  );
}
