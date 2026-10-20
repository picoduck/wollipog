import { PodsIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { statusMeta } from "../status-meta.js";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  isTerminal,
  type PodContextEntry,
  type PodMemberRole,
  type PodMemberView,
  type PodRelayReceipt,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { SessionStatusIndicators } from "./common.js";
import { Checkbox } from "./ui/ChoiceControls.js";
import { EventTimeline } from "./EventTimeline.js";
import { sessionAgentLabel } from "./agent-options.js";
import { useTimeline } from "./useTimeline.js";
import { subscriptionRecoveryRevision } from "../ui-subscriptions.js";
import { recoverSessionHistories, sessionHistoryEpochKey } from "../history-recovery.js";
import { detailPlaceholder, listPlaceholder } from "../detail-placeholder.js";
import { selectComparisonEvents, selectComparisonHistory } from "../comparison-selectors.js";
import { transcriptPresentation } from "../transcript-presentation.js";
import { matchesShortcut } from "../shortcuts.js";
import { useFeedback } from "./FeedbackProvider.js";
import { confirmWhileAllowed } from "../confirmation-fence.js";
import { DetailBar, PageHeader } from "./PageHeader.js";
import { absoluteViewUrl, backLabel, destination, viewTitle } from "../navigation.js";
import { isTimelineSessionActive } from "../timeline-clock.js";
import { useDashboardPublicOrigin } from "../remote-access-context.js";
import { writeClipboardText } from "../clipboard.js";
import { podMemberShortName, podTurnsStopNotice } from "../pod-presentation.js";
import { BusyButton } from "./ui/BusyButton.js";
import { DEFAULT_POD_ORCHESTRATION_POLICY, PodAutomaticTurnsDialog } from "./PodAutomaticTurnsDialog.js";
import { PodMergeWorkDialog } from "./PodMergeWorkDialog.js";

const EMPTY_MEMBER_IDS: string[] = [];
const sameMemberIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const EMPTY_POD_CONTEXT: PodContextEntry[] = [];

const POD_CLOSED = "This pod is closed.";
const MERGE_RUNNING = "Available when the merge finishes.";
const BUSY_REASON = "Available when the current action finishes.";
const NO_POD_LINK_REASON = "Open Wollipog in a browser to copy a link.";
const BACK_TO_MORE_ACTIONS = "Back to More Actions";

/** Stop banners already dismissed in this window, by pod, run and stop, so each says why once. */
const dismissedStopBanners = new Set<string>();

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
  const driver = useStoreSelector((state) => state.sessions.get(sessionId)?.driver);
  const events = useStoreSelector((state) => selectComparisonEvents(state, sessionId));
  const history = useStoreSelector((state) => selectComparisonHistory(state, sessionId));
  const conn = useStoreSelector((state) => state.conn);
  const items = useTimeline(sessionId, events, eventEpoch);
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
          driver={driver}
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
        <Checkbox label="Relay" title="Include this member in the next manual relay"
          checked={selected} onChange={onToggle} />
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
  const conn = useStoreSelector((state) => state.conn);
  const snapshotLoaded = useStoreSelector((state) => state.snapshotLoaded);
  const list = useMemo(() => [...pods.values()].sort((a, b) => b.updatedAt - a.updatedAt), [pods]);
  const podsDestination = destination("pods");
  const header = (
    <PageHeader
      title={podsDestination.name}
      description={podsDestination.description}
      primary={{ label: "New Pod", onClick: onNewPod }}
    />
  );
  if (list.length === 0) {
    // An empty map proves nothing before the first snapshot or while disconnected (§12.5).
    if (!snapshotLoaded || conn !== "online") {
      const placeholder = listPlaceholder("pods", conn);
      return (
        <div className="page">
          {header}
          <State variant={placeholder.variant} icon={<PodsIcon />} title={placeholder.title}>{placeholder.hint}</State>
        </div>
      );
    }
    return (
      <div className="page">
        {header}
        <State
          icon={<PodsIcon />}
          title={`No ${podsDestination.name} Yet`}
          actions={<button type="button" className="btn primary" onClick={onNewPod}>New Pod</button>}
        >
          Group isolated sessions to relay context across agents and runners.
        </State>
      </div>
    );
  }
  return (
    <div className="page">
    {header}
    <div className="surface">
      {list.map((pod) => (
        <button key={pod.id} type="button" className="row row-2" onClick={() => navigate({ name: "pod", id: pod.id })}>
          <span className="row-body">
            <span className="row-line">
              <span className="row-title">{pod.title}</span>
              <StatusBadge meta={statusMeta("pod", pod.status)} />
            </span>
            <span className="row-sub">{pod.objective || "Manual collaboration pod"}</span>
          </span>
          <span className="row-trail">
            {pod.members.length} Members · {titleCaseLabel(pod.orchestration?.policy.mode.replaceAll("_", " ") ?? "manual")}
            {pod.orchestration?.state.status === "running" ? ` · turn ${pod.orchestration.state.turnsUsed}` : ""}
            {` · updated ${relativeTime(pod.updatedAt)}`}
          </span>
        </button>
      ))}
    </div>
    </div>
  );
}

/** Keyed by pod: the route renders this in place, so a direct pod-to-pod change would otherwise
 * reuse one instance and carry the previous pod's draft, errors, receipts and unsaved policy. */
export function PodDetail({ podId }: { podId: string }) {
  return <PodDetailContent key={podId} podId={podId} />;
}

function PodDetailContent({ podId }: { podId: string }) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
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
  // The dialogs own their drafts, so reopening one shows what is saved (#2980).
  const [dialog, setDialog] = useState<"turns" | "merge" | null>(null);
  const [, setDismissals] = useState(0);
  const dashboardOrigin = useDashboardPublicOrigin();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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

  const policy = pod?.orchestration?.policy ?? DEFAULT_POD_ORCHESTRATION_POLICY;
  const orchestrationState = pod?.orchestration?.state;
  const orchestrationRunning = orchestrationState?.status === "running";
  const reconciliationRunning = Boolean(pod?.reconciliations?.some((receipt) => receipt.status === "running"));
  const closeBlocked = useRef(false);
  closeBlocked.current = Boolean(busy) || reconciliationRunning;

  if (!pod) {
    const placeholder = detailPlaceholder("Pod", { authoritative: snapshotLoaded, conn });
    return (
      <div className="run-detail pod-detail">
        <DetailBar title={viewTitle({ name: "pod", id: podId })} backLabel={backLabel("pods")} onBack={() => navigate({ name: "pods" })} />
        <State
          variant={placeholder.variant}
          title={placeholder.title}
          actions={placeholder.actions.includes("back") && (
            <button type="button" className="btn primary" onClick={() => navigate({ name: "pods" })}>{backLabel("pods")}</button>
          )}
        >
          {placeholder.hint}
        </State>
      </div>
    );
  }
  const active = pod.status === "active";
  // Every disabled ⋯ item says why on its second line (§9.1).
  const turnsReason = !active ? POD_CLOSED : reconciliationRunning ? MERGE_RUNNING
    : orchestrationRunning ? "Stop automatic turns to change them." : null;
  const mergeReason = !active ? POD_CLOSED : reconciliationRunning ? MERGE_RUNNING : null;
  const closeReason = reconciliationRunning ? MERGE_RUNNING : busy ? BUSY_REASON : null;
  const runningSentence = [
    "Automatic turns are running",
    `Turn ${orchestrationState?.turnsUsed ?? 0} of ${policy.maxTurns}`,
    ...(orchestrationState?.currentSessionId
      ? [`${podMemberShortName(pod, sessions, orchestrationState.currentSessionId)} is up`]
      : []),
  ].join(" · ");
  const stopNotice = podTurnsStopNotice(orchestrationState);
  const stopKey = `${pod.id}:${orchestrationState?.runId ?? ""}:${orchestrationState?.updatedAt ?? 0}`;
  const showStopNotice = Boolean(stopNotice) && !dismissedStopBanners.has(stopKey);

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

  const stopOrchestration = async () => {
    if (busy || !orchestrationRunning) return;
    setBusy("orchestration-stop");
    try {
      await api.stopPodOrchestration(pod.id);
    } catch (cause) {
      showToast(`Automatic turns didn't stop: ${(cause as Error).message}`, { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    if (!dashboardOrigin) return;
    const invoker = document.activeElement;
    const current = () => mountedRef.current && (document.activeElement === null ||
      document.activeElement === document.body || document.activeElement === invoker);
    const copied = await writeClipboardText(absoluteViewUrl(dashboardOrigin, { name: "pod", id: pod.id }), current);
    if (copied === null) return;
    if (invoker instanceof HTMLElement && (document.activeElement === document.body || document.activeElement === null)) invoker.focus();
    if (copied) showToast("Link copied.", { tone: "success" });
    else showToast("Couldn't copy the link.", { tone: "error" });
  };

  const close = async (reopen: () => void) => {
    if (!await confirmWhileAllowed(confirm, () => closeBlocked.current, {
      title: "Close Pod",
      message: "Relays and membership changes stop for this pod. Its membership stays readable.",
      confirmLabel: "Close Pod",
      tone: "danger",
      back: { label: BACK_TO_MORE_ACTIONS, run: reopen },
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
      <DetailBar
        title={viewTitle({ name: "pod", id: podId }, pod.title)}
        backLabel={backLabel("pods")}
        onBack={() => navigate({ name: "pods" })}
        status={<StatusBadge meta={statusMeta("pod", pod.status)} />}
        // Automatic turns and merging are occasional, so they are dialogs from ⋯; closing is
        // destructive, so it comes last after a separator (§3.3, #2980).
        menu={[
          {
            label: "Automatic Turns…",
            disabled: Boolean(turnsReason),
            description: turnsReason ?? undefined,
            onClick: () => setDialog("turns"),
          },
          {
            label: "Merge Work…",
            disabled: Boolean(mergeReason),
            description: mergeReason ?? undefined,
            onClick: () => setDialog("merge"),
          },
          {
            label: "Copy Link",
            disabled: !dashboardOrigin,
            description: dashboardOrigin ? undefined : NO_POD_LINK_REASON,
            onClick: () => void copyLink(),
          },
          ...(active ? [{
            label: "Close Pod…",
            danger: true,
            disabled: Boolean(closeReason),
            description: closeReason ?? undefined,
            onClick: ({ reopen }: { reopen: () => void }) => void close(reopen),
          }] : []),
        ]}
      />
      {orchestrationRunning && (
        <Notice
          tone="info"
          className="pod-turns-banner"
          role="status"
          actions={(
            <BusyButton className="btn sm" busy={busy === "orchestration-stop"} progress="Stopping automatic turns…"
              disabled={Boolean(busy) && busy !== "orchestration-stop"} onClick={() => void stopOrchestration()}>
              Stop Automatic Turns
            </BusyButton>
          )}
        >
          {runningSentence}
        </Notice>
      )}
      {!orchestrationRunning && showStopNotice && stopNotice && (
        <Notice
          tone="neutral"
          className="pod-turns-banner"
          role="status"
          details={stopNotice.details ? <code>{stopNotice.details}</code> : undefined}
          onDismiss={() => {
            dismissedStopBanners.add(stopKey);
            setDismissals((count) => count + 1);
          }}
        >
          {stopNotice.sentence}
        </Notice>
      )}
      <p className="detail-summary">{pod.objective || "Manual collaboration pod"}</p>

      <section className="pod-relay" aria-label="Manual Pod Relay">
        <div className="pod-relay-head">
          <div>
            <strong>Manual Relay</strong>
            <p className="muted sm">Select shared-log entries, add an optional note, and relay the composed context to isolated members.</p>
          </div>
          <span className="muted sm">{targets.length}/{pod.members.length} Targets</span>
        </div>
        {error && <Notice tone="danger" compact>{error}</Notice>}
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
      {dialog === "turns" && <PodAutomaticTurnsDialog pod={pod} sessions={sessions} onClose={() => setDialog(null)} />}
      {dialog === "merge" && <PodMergeWorkDialog pod={pod} sessions={sessions} runners={runners} onClose={() => setDialog(null)} />}
    </div>
  );
}
