import { PodsIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { StatusBadge, statusToneClass } from "./StatusBadge.js";
import { sessionStatusSummary, statusMeta } from "../status-meta.js";
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import type {
  PodContextEntry,
  PodMemberRole,
  PodMemberView,
  PodRelayReceipt,
  PodView,
  RelayPodRequest,
  SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { formatRecordedRelativeTime, relativeTime, titleCaseLabel } from "../format.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { Checkbox } from "./ui/ChoiceControls.js";
import { sessionAgentLabel } from "./agent-options.js";
import { useTimeline } from "./useTimeline.js";
import { subscriptionRecoveryRevision } from "../ui-subscriptions.js";
import { recoverSessionHistories, sessionHistoryEpochKey } from "../history-recovery.js";
import { detailPlaceholder, listPlaceholder } from "../detail-placeholder.js";
import { selectComparisonEvents, selectComparisonHistory, selectComparisonSession } from "../comparison-selectors.js";
import { transcriptPresentation } from "../transcript-presentation.js";
import { matchesShortcut } from "../shortcuts.js";
import { useFeedback } from "./FeedbackProvider.js";
import { confirmWhileAllowed } from "../confirmation-fence.js";
import { DetailBar, PageHeader, type PageMenuAction } from "./PageHeader.js";
import { absoluteViewUrl, backLabel, destination, viewTitle } from "../navigation.js";
import { useDashboardPublicOrigin } from "../remote-access-context.js";
import { writeClipboardText } from "../clipboard.js";
import { podBadgeStatus, podEntrySourceName, podMemberNames, podMemberShortName, podTurnsStopNotice } from "../pod-presentation.js";
import { BusyButton } from "./ui/BusyButton.js";
import { DEFAULT_POD_ORCHESTRATION_POLICY, PodAutomaticTurnsDialog } from "./PodAutomaticTurnsDialog.js";
import { PodMergeWorkDialog, PodRecentMergesDialog } from "./PodMergeWorkDialog.js";
import { CompareMemberBody, CompareMemberHead, CompareRow } from "./CompareColumns.js";
import { memberActivity, memberActivityLine } from "../member-activity.js";
import { useTimelineClock } from "../timeline-clock.js";
import { useIsMobile } from "./useIsMobile.js";
import { TabList } from "./Tabs.js";
import { humanResolver, resolverName, ViewerIdentityContext } from "../resolver-identity.js";

const EMPTY_MEMBER_IDS: string[] = [];
const sameMemberIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const EMPTY_POD_CONTEXT: PodContextEntry[] = [];

const POD_CLOSED = "This pod is closed.";
const MERGE_RUNNING = "Available when the merge finishes.";
const BUSY_REASON = "Available when the current action finishes.";
const NO_POD_LINK_REASON = "Open Wollipog in a browser to copy a link.";
const BACK_TO_MORE_ACTIONS = "Back to More Actions";
const WRITE_OR_SELECT = "Write a note or select entries to relay.";
/** The control plane composes at most this many huddle entries into one relay. */
const MAX_RELAY_ENTRIES = 16;

/** Stop banners already dismissed in this window, by pod, run and stop, so each says why once. */
const dismissedStopBanners = new Set<string>();

/** A relay that did not reach every member: each member's receipt, and what Retry Failed sends. */
interface RelayFailure {
  receipts: PodRelayReceipt[];
  /** The relay's entries, with its note as the log entry it became, so a retry never adds the
   * note to the log twice. */
  retry: Omit<RelayPodRequest, "sessionIds">;
}

const relayedSentence = (count: number) => `Relayed to ${count} ${count === 1 ? "member" : "members"}`;

/** The member's existing settings and actions, kept in the column until its menu replaces them (#2983). */
interface MemberTools {
  member: PodMemberView;
  removable: boolean;
  settingsDisabled: boolean;
  sharing: boolean;
  shareDisabled: boolean;
  onRemove: () => void;
  onShare: () => void;
  onRole: (role: PodMemberRole) => void;
  onBudget: (budget: number | null) => void;
}

/**
 * One member's column (#2981, #2975's recipe): the head with the agent, its status, Open Session
 * and ⋯, the member's settings, what it did, and its activity. On a phone it is the member tab's
 * panel. Its own component, so each member subscribes to its own events.
 */
function PodMemberColumn({ sessionId, tools, onRetry, panel }: {
  sessionId: string;
  tools: MemberTools;
  onRetry: () => void;
  panel?: { id: string; labelledBy: string };
}) {
  const { navigate } = useStoreActions();
  const session = useStoreSelector((state) => selectComparisonSession(state, sessionId));
  const events = useStoreSelector((state) => selectComparisonEvents(state, sessionId));
  const history = useStoreSelector((state) => selectComparisonHistory(state, sessionId));
  const runnerOnline = useStoreSelector((state) => session
    ? state.runners.get(session.runnerId)?.status !== "offline"
    : true);
  const conn = useStoreSelector((state) => state.conn);
  const items = useTimeline(sessionId, events, session?.eventEpoch ?? 0);
  const activity = useMemo(() => memberActivity(items), [items]);
  if (!session) return null;
  const presentation = transcriptPresentation({ itemCount: items.length, hasOptimistic: false, working: false, history, conn });
  const agentLabel = sessionAgentLabel(session.agentName, session.driver, session.agentId);
  const openSession = () => navigate({ name: "session", id: sessionId });
  const known = presentation.body === "timeline" || presentation.body === "empty";
  const did = memberActivityLine(statusMeta("session", session.status).pulse, known ? activity : null);
  const canShare = session.status !== "starting" && session.status !== "running" &&
    Boolean(events?.some((event) => event.payload.kind === "agent_message" && !event.payload.parentToolUseId && event.payload.text));
  const menu: PageMenuAction[] = [{ label: "Open Session", onClick: openSession }];
  return (
    <section
      className="compare-member pod-member"
      aria-label={panel ? undefined : agentLabel}
      id={panel?.id}
      role={panel ? "tabpanel" : undefined}
      aria-labelledby={panel?.labelledBy}
    >
      <CompareMemberHead agent={agentLabel} session={session} runnerOnline={runnerOnline} onOpenSession={openSession} menu={menu} />
      <div className="pod-member-tools">
        <label className="pod-member-setting">
          <span>Role</span>
          <select
            aria-label={`Role for ${session.title}`}
            value={tools.member.role}
            disabled={tools.settingsDisabled}
            onChange={(event) => tools.onRole(event.target.value as PodMemberRole)}
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
            value={tools.member.contextTokenBudget ?? ""}
            disabled={tools.settingsDisabled}
            onChange={(event) => tools.onBudget(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">Inherit</option>
            <option value="4096">4k</option>
            <option value="8192">8k</option>
            <option value="16384">16k</option>
            <option value="32768">32k</option>
          </select>
        </label>
        <BusyButton className="btn ghost sm" busy={tools.sharing} progress="Sharing the latest answer…"
          disabled={!canShare || tools.shareDisabled} onClick={tools.onShare}>
          Share Latest
        </BusyButton>
        {tools.removable && <button type="button" className="btn ghost sm" onClick={tools.onRemove}>Remove</button>}
      </div>
      <p className="compare-member-meta">{did}</p>
      <CompareMemberBody
        agent={agentLabel}
        session={session}
        items={items}
        presentation={presentation}
        conn={conn}
        loaded={events?.length ?? 0}
        onRetry={onRetry}
      />
    </section>
  );
}

const HUDDLE_TAB_ID = "pod-huddle-tab";
const memberTabId = (index: number) => `pod-member-tab-${index}`;
const TAB_PANEL_ID = "pod-tab-panel";

/** A phone's member tab: the agent and its status as a dot, named in words (#2975's tab). */
function MemberTab({ sessionId, index, selected, onSelect, onKeyDown }: {
  sessionId: string;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const session = useStoreSelector((state) => selectComparisonSession(state, sessionId));
  const runnerOnline = useStoreSelector((state) => session
    ? state.runners.get(session.runnerId)?.status !== "offline"
    : true);
  if (!session) return null;
  const agentLabel = sessionAgentLabel(session.agentName, session.driver, session.agentId);
  const status = sessionStatusSummary(session, { runnerOnline }).primary.meta;
  return (
    <button
      id={memberTabId(index)}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={TAB_PANEL_ID}
      tabIndex={selected ? 0 : -1}
      className="tab compare-tab"
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span className={`compare-tab-dot ${statusToneClass(status.tone)}`} aria-hidden="true" />
      {agentLabel}
      <span className="sr-only">, {status.label}</span>
    </button>
  );
}

/**
 * An entry's text, clamped to three lines with Show More when it runs longer. Whether it runs
 * longer is measured against the clamp whenever the text or the panel's width changes.
 */
function HuddleEntryText({ text }: { text: string }) {
  const id = `pod-huddle-text-${useId().replace(/:/g, "")}`;
  const [expanded, setExpanded] = useState(false);
  const [truncates, setTruncates] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const body = textRef.current;
    if (!body) return;
    const measure = () => {
      body.classList.add("is-clamped");
      const hidden = body.scrollHeight > body.clientHeight + 1;
      if (expanded) body.classList.remove("is-clamped");
      setTruncates(hidden);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <>
      <p id={id} ref={textRef} className={`pod-huddle-text${expanded ? "" : " is-clamped"}`}>{text}</p>
      {(truncates || expanded) && (
        <button
          type="button"
          className="link pod-huddle-more"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show Less" : "Show More"}
        </button>
      )}
    </>
  );
}

interface HuddleProps {
  pod: PodView;
  sessions: ReadonlyMap<string, SessionView>;
  entries: readonly PodContextEntry[];
  /** Whether older entries exist above the loaded ones. */
  more: boolean;
  loadError: string | null;
  onRetryLoad: () => void;
  onLoadEarlier: () => void;
  selectedEntries: readonly string[];
  onToggleEntry: (id: string) => void;
  text: string;
  onText: (text: string) => void;
  targets: readonly string[];
  onToggleTarget: (sessionId: string) => void;
  busy: string | null;
  /** Why the pod cannot relay now (closed, automatic turns, a merge), which also holds Retry Failed back. */
  relayBlocked: string | null;
  /** Why Relay is unavailable, or null. */
  relayReason: string | null;
  noteError: string | null;
  relayError: string | null;
  relayFailure: RelayFailure | null;
  onDismissFailure: () => void;
  onSaveNote: () => void;
  onRelay: () => void;
  onRetryFailed: () => void;
  panel?: { id: string; labelledBy: string };
}

/**
 * The Huddle (#2981): its head with the entry count and Load Earlier, the log newest last, each
 * entry a selectable row, and one composer at the bottom that saves a note or relays it with the
 * selected entries to the members checked under Relay To.
 */
function Huddle({
  pod, sessions, entries, more, loadError, onRetryLoad, onLoadEarlier, selectedEntries, onToggleEntry,
  text, onText, targets, onToggleTarget, busy, relayBlocked, relayReason, noteError, relayError, relayFailure,
  onDismissFailure, onSaveNote, onRelay, onRetryFailed, panel,
}: HuddleProps) {
  const ids = useId();
  const viewer = useContext(ViewerIdentityContext);
  const now = useTimelineClock(entries.length > 0);
  const active = pod.status === "active";
  const memberIds = pod.members.map((member) => member.sessionId);
  // Relay To names each member by role and agent; results name them the same way.
  const names = podMemberNames(pod, sessions, [...memberIds, ...(relayFailure?.receipts.map((receipt) => receipt.sessionId) ?? [])], "agent");
  const person = (actorId: string) => {
    const resolver = humanResolver(viewer, actorId);
    return resolver ? resolverName(resolver, { titleCase: true }) : "A Person";
  };

  // Newest last: the log follows a new entry while the person is at its end, and keeps what they
  // read in place when Load Earlier adds older entries above it, so the composer never moves.
  const logRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ first?: string; last?: string; fromBottom: number; atEnd: boolean }>({ fromBottom: 0, atEnd: true });
  const remember = () => {
    const log = logRef.current;
    if (!log) return;
    anchor.current.fromBottom = log.scrollHeight - log.scrollTop;
    anchor.current.atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  };
  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const seen = anchor.current;
    const first = entries[0]?.id;
    const last = entries.at(-1)?.id;
    if (last !== seen.last && seen.atEnd) log.scrollTop = log.scrollHeight;
    else if (first !== seen.first) log.scrollTop = log.scrollHeight - seen.fromBottom;
    seen.first = first;
    seen.last = last;
    remember();
  }, [entries]);

  const reasonId = `${ids}-reason`;
  const relayToId = `${ids}-relay-to`;
  const failed = relayFailure?.receipts.filter((receipt) => receipt.status === "failed") ?? [];
  const relayLabel = targets.length ? `Relay to ${targets.length}` : "Relay";
  return (
    <aside
      className="pod-huddle"
      aria-label={panel ? undefined : "Huddle"}
      id={panel?.id}
      role={panel ? "tabpanel" : undefined}
      aria-labelledby={panel?.labelledBy}
    >
      <div className="pod-huddle-head">
        <h2 className="pod-huddle-title">Huddle</h2>
        <span className="count" aria-label={`${entries.length}${more ? " or more" : ""} entries`}>{entries.length}{more ? "+" : ""}</span>
        {more && (
          <BusyButton className="btn sm ghost" busy={busy === "older"} progress="Loading earlier entries…"
            disabled={Boolean(busy) && busy !== "older"} onClick={onLoadEarlier}>
            Load Earlier
          </BusyButton>
        )}
      </div>
      <div className="pod-huddle-log" ref={logRef} onScroll={remember} role="region" aria-label="Huddle Log" tabIndex={0}>
        {loadError && (
          <Notice tone="danger" compact role="alert" className="pod-huddle-notice"
            actions={<button type="button" className="btn sm" onClick={onRetryLoad}>Retry</button>}>
            The huddle didn't load.
          </Notice>
        )}
        {entries.length === 0 ? (
          !loadError && <p className="pod-huddle-empty">No notes yet. Save a note, or share a member's latest answer.</p>
        ) : (
          <ul className="pod-huddle-entries">
            {entries.map((entry) => {
              const selected = selectedEntries.includes(entry.id);
              const source = podEntrySourceName(entry, pod, sessions, entry.source.kind === "human" ? person(entry.source.actorId) : "");
              const time = formatRecordedRelativeTime(entry.ts, now);
              return (
                <li
                  key={entry.id}
                  className={`pod-huddle-entry${selected ? " is-selected" : ""}`}
                  onClick={(event) => {
                    // The row selects, as its box does; its own controls keep their clicks.
                    if (!active || (event.target as Element).closest("button, a, input, label")) return;
                    onToggleEntry(entry.id);
                  }}
                >
                  <Checkbox
                    labelHidden
                    label="Include in Next Relay"
                    ariaLabel={`Include in Next Relay: ${source}, ${time}`}
                    checked={selected}
                    disabled={!active}
                    onChange={() => onToggleEntry(entry.id)}
                  />
                  <div className="pod-huddle-entry-body">
                    <p className="pod-huddle-entry-meta">
                      <span className="pod-huddle-entry-source">{source}</span>
                      <time dateTime={new Date(entry.ts).toISOString()} title={new Date(entry.ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}>{time}</time>
                    </p>
                    <HuddleEntryText text={entry.content} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="pod-composer">
        {relayFailure && (
          <Notice
            tone="danger"
            role="alert"
            title="Couldn't Relay to Every Member"
            onDismiss={onDismissFailure}
            actions={failed.length > 0 && (
              <BusyButton className="btn sm" busy={busy === "retry"} progress="Retrying the failed members…"
                disabled={(Boolean(busy) && busy !== "retry") || Boolean(relayBlocked)}
                onClick={onRetryFailed}>
                Retry Failed
              </BusyButton>
            )}
          >
            <ul className="pod-results">
              {relayFailure.receipts.map((receipt) => (
                <li key={receipt.sessionId}>
                  <span className="pod-result-name">{names.get(receipt.sessionId) ?? receipt.sessionId}</span>
                  <StatusBadge meta={statusMeta("delivery", receipt.status === "delivered" ? "delivered" : "delivery_failed")} inline />
                  {receipt.status === "failed" && receipt.error && <span className="pod-result-reason">{receipt.error}</span>}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        {relayError && (
          <Notice tone="danger" role="alert" details={<code>{relayError}</code>}>The relay didn't run.</Notice>
        )}
        {noteError && (
          <Notice tone="danger" role="alert" details={<code>{noteError}</code>}>The note wasn't saved.</Notice>
        )}
        <textarea
          className="pod-composer-note"
          rows={3}
          value={text}
          aria-label="Note"
          disabled={!active}
          placeholder="Write a note for the huddle…"
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => {
            if (matchesShortcut(event.nativeEvent, "relay-pod-note")) {
              event.preventDefault();
              onRelay();
            }
          }}
        />
        <div className="pod-recipients" role="group" aria-labelledby={relayToId}>
          <span className="pod-recipients-label" id={relayToId}>Relay To</span>
          {memberIds.map((sessionId) => (
            <Checkbox
              key={sessionId}
              label={names.get(sessionId) ?? sessionId}
              checked={targets.includes(sessionId)}
              disabled={!active}
              onChange={() => onToggleTarget(sessionId)}
            />
          ))}
        </div>
        {relayReason && <p className="pod-composer-reason" id={reasonId}>{relayReason}</p>}
        <div className="pod-composer-actions">
          <BusyButton className="btn" busy={busy === "note"} progress="Saving the note…"
            disabled={!active || (Boolean(busy) && busy !== "note") || !text.trim()} onClick={onSaveNote}>
            Save Note
          </BusyButton>
          <BusyButton className="btn primary" busy={busy === "relay"} progress="Relaying…"
            disabled={!active || (Boolean(relayReason || busy) && busy !== "relay")}
            aria-describedby={relayReason ? reasonId : undefined}
            onClick={onRelay}>
            {relayLabel}
          </BusyButton>
        </div>
      </div>
    </aside>
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
export function PodDetail({ podId, member }: {
  podId: string;
  /** The member tab the URL names (`?member=`), which a phone shows; otherwise the Huddle. */
  member?: string;
}) {
  return <PodDetailContent key={podId} podId={podId} member={member} />;
}

function PodDetailContent({ podId, member }: { podId: string; member?: string }) {
  const api = useApi();
  const phone = useIsMobile();
  const { confirm, showToast } = useFeedback();
  const { eventEpoch, loadEvents, loadPodContext, navigate, recoveryAfter, beginEventHistoryLoad, failEventHistoryLoad } = useStoreActions();
  const pod = useStoreSelector((state) => state.pods.get(podId));
  const sessions = useStoreSelector((state) => state.sessions);
  const runners = useStoreSelector((state) => state.runners);
  const conn = useStoreSelector((state) => state.conn);
  const snapshotLoaded = useStoreSelector((state) => state.snapshotLoaded);
  const memberIds = useStoreSelector(
    (state) => state.pods.get(podId)?.members.map((candidate) => candidate.sessionId) ?? EMPTY_MEMBER_IDS,
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
  const [busy, setBusy] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [relayFailure, setRelayFailure] = useState<RelayFailure | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextRetry, setContextRetry] = useState(0);
  const [beforeSeq, setBeforeSeq] = useState<number | undefined>();
  // Retry on a member's failed history loads every member's history again.
  const [historyRetry, setHistoryRetry] = useState(0);
  const retryHistory = useCallback(() => setHistoryRetry((value) => value + 1), []);
  // The dialogs own their drafts, so reopening one shows what is saved (#2980).
  const [dialog, setDialog] = useState<"turns" | "merge" | "merges" | null>(null);
  const [, setDismissals] = useState(0);
  const dashboardOrigin = useDashboardPublicOrigin();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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
  }, [api, memberIds, conn, recoveryRevision, recoveryEpochKey, recoveryGeneration, eventEpoch, loadEvents, recoveryAfter, beginEventHistoryLoad, failEventHistoryLoad, historyRetry]);

  useEffect(() => {
    if (!pod || conn !== "online" || recoveryRevision == null) return;
    let current = true;
    api.podContext(pod.id)
      .then((page) => {
        if (!current) return;
        loadPodContext(pod.id, page.entries);
        setBeforeSeq(page.beforeSeq);
        setContextError(null);
      })
      .catch((cause) => { if (current) setContextError((cause as Error).message); });
    return () => { current = false; };
  }, [api, pod?.id, conn, recoveryRevision, loadPodContext, contextRetry]);

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
  const receipts = pod.reconciliations ?? [];
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

  // The selected entries in the log's order, which is the order a relay composes them in.
  const selectedEntries = contextEntries.filter((entry) => selectedContext.includes(entry.id)).map((entry) => entry.id);
  // Why the pod cannot relay now, which also holds Retry Failed back; then why this relay cannot
  // go. The composer shows the first that applies under Relay To (§3.1).
  const relayBlocked = !active ? POD_CLOSED
    : orchestrationRunning ? "Automatic turns are running."
      : reconciliationRunning ? MERGE_RUNNING
        : null;
  const relayReason = relayBlocked
    ?? (!text.trim() && selectedEntries.length === 0 ? WRITE_OR_SELECT
      : selectedEntries.length > MAX_RELAY_ENTRIES ? `Select at most ${MAX_RELAY_ENTRIES} entries.`
        : targets.length === 0 ? "Check a member to relay to."
          : null);

  /** Settles a relay or a retry: every member reached is a toast; anything else is the notice. */
  const settleRelay = (results: PodRelayReceipt[], retry: RelayFailure["retry"]) => {
    if (results.every((receipt) => receipt.status === "delivered")) {
      setRelayFailure(null);
      showToast(relayedSentence(results.length), { tone: "success" });
    } else {
      setRelayFailure({ receipts: results, retry });
    }
  };

  const relay = async () => {
    if (relayReason || busy) return;
    const note = text.trim();
    const entries = selectedEntries;
    setBusy("relay");
    setRelayError(null);
    setNoteError(null);
    setRelayFailure(null);
    try {
      const result = await api.relayPod(pod.id, {
        ...(note ? { text: note } : {}),
        sessionIds: targets.filter((id) => memberIds.includes(id)),
        contextEntryIds: entries,
      });
      if (result.appendedEntry) loadPodContext(pod.id, [result.appendedEntry]);
      setText("");
      setSelectedContext([]);
      // A retry relays the note as the entry it became; past the entry limit it sends the note again.
      const withNote = result.appendedEntry ? [...entries, result.appendedEntry.id] : entries;
      const retry = withNote.length <= MAX_RELAY_ENTRIES ? { contextEntryIds: withNote } : { text: note, contextEntryIds: entries };
      settleRelay(result.receipts ?? result.sessions.map((session) => ({ sessionId: session.id, status: "delivered" as const })), retry);
    } catch (cause) {
      setRelayError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const retryFailed = async () => {
    if (!relayFailure || busy || relayBlocked) return;
    const failed = relayFailure.receipts.filter((receipt) => receipt.status === "failed").map((receipt) => receipt.sessionId);
    if (!failed.length) return;
    setBusy("retry");
    const retry = relayFailure.retry;
    let next: PodRelayReceipt[];
    try {
      const result = await api.relayPod(pod.id, { ...retry, sessionIds: failed });
      // Only a relay past the entry limit sends its note again, which logs it again.
      if (result.appendedEntry) loadPodContext(pod.id, [result.appendedEntry]);
      const answered = new Map((result.receipts ?? []).map((receipt) => [receipt.sessionId, receipt]));
      next = relayFailure.receipts.map((receipt) => answered.get(receipt.sessionId) ?? receipt);
    } catch (cause) {
      // Nothing was sent: each retried member keeps Delivery Failed, with the reason it was refused.
      const reason = (cause as Error).message;
      next = relayFailure.receipts.map((receipt) => receipt.status === "failed" ? { ...receipt, error: reason } : receipt);
    } finally {
      setBusy(null);
    }
    settleRelay(next, retry);
  };

  const saveNote = async () => {
    if (busy || !active || !text.trim()) return;
    setBusy("note");
    setNoteError(null);
    setRelayError(null);
    try {
      const result = await api.appendPodContext(pod.id, { kind: "note", text: text.trim() });
      loadPodContext(pod.id, [result.entry]);
      setText("");
    } catch (cause) {
      setNoteError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Runs a member or log action; a failure is an error toast that names what did not happen. */
  const memberAction = async (key: string, failure: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } catch (cause) {
      showToast(`${failure}: ${(cause as Error).message}`, { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const shareLatest = (sessionId: string) => memberAction(`share:${sessionId}`, "The latest answer wasn't shared", async () => {
    const result = await api.appendPodContext(pod.id, { kind: "member_output", sessionId });
    loadPodContext(pod.id, [result.entry]);
  });

  const loadOlder = () => {
    if (beforeSeq === undefined) return;
    return memberAction("older", "Earlier entries didn't load", async () => {
      const page = await api.podContext(pod.id, beforeSeq);
      loadPodContext(pod.id, page.entries);
      setBeforeSeq(page.beforeSeq);
    });
  };

  const removeMember = (sessionId: string) => {
    if (reconciliationRunning) return;
    return memberAction(`remove:${sessionId}`, "The member wasn't removed", () => api.removePodMember(pod.id, sessionId));
  };

  const updateMember = (sessionId: string, patch: { role?: PodMemberRole; contextTokenBudget?: number | null }) => {
    if (orchestrationRunning || reconciliationRunning) return;
    return memberAction(`member:${sessionId}`, "The member's settings weren't saved", () => api.updatePodMember(pod.id, sessionId, patch));
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
    await memberAction("close", "The pod didn't close", () => api.closePod(pod.id));
  };

  const toolsFor = (sessionId: string): MemberTools => ({
    member: pod.members.find((candidate) => candidate.sessionId === sessionId)!,
    removable: active && !orchestrationRunning && !reconciliationRunning && pod.members.length > 2,
    settingsDisabled: !active || orchestrationRunning || reconciliationRunning || Boolean(busy),
    sharing: busy === `share:${sessionId}`,
    shareDisabled: !active || (Boolean(busy) && busy !== `share:${sessionId}`),
    onRemove: () => void removeMember(sessionId),
    onShare: () => void shareLatest(sessionId),
    onRole: (role) => void updateMember(sessionId, { role }),
    onBudget: (contextTokenBudget) => void updateMember(sessionId, { contextTokenBudget }),
  });

  // A phone shows one tab: the member the URL names while it is still a member, else the Huddle.
  const shownMember = member !== undefined && memberIds.includes(member) ? member : null;
  const selectTab = (sessionId: string | null) => {
    // The choice replaces the entry rather than adding one, so Back still leaves the pod.
    navigate(sessionId === null ? { name: "pod", id: podId, tab: "huddle" } : { name: "pod", id: podId, member: sessionId }, { replace: true });
  };
  const tabs = [null, ...memberIds];
  const tabId = (sessionId: string | null) => sessionId === null ? HUDDLE_TAB_ID : memberTabId(memberIds.indexOf(sessionId));
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    flushSync(() => selectTab(tabs[next]!));
    document.getElementById(tabId(tabs[next]!))?.focus();
  };

  const huddle = (panel?: { id: string; labelledBy: string }) => (
    <Huddle
      pod={pod}
      sessions={sessions}
      entries={contextEntries}
      more={beforeSeq !== undefined}
      loadError={contextError}
      onRetryLoad={() => setContextRetry((count) => count + 1)}
      onLoadEarlier={() => void loadOlder()}
      selectedEntries={selectedEntries}
      onToggleEntry={(id) => setSelectedContext((current) => current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : [...current, id])}
      text={text}
      onText={(value) => {
        setText(value);
        setNoteError(null);
      }}
      targets={targets}
      onToggleTarget={(sessionId) => setTargets((current) => current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId])}
      busy={busy}
      relayBlocked={relayBlocked}
      relayReason={relayReason}
      noteError={noteError}
      relayError={relayError}
      relayFailure={relayFailure}
      onDismissFailure={() => setRelayFailure(null)}
      onSaveNote={() => void saveNote()}
      onRelay={() => void relay()}
      onRetryFailed={() => void retryFailed()}
      panel={panel}
    />
  );

  return (
    <div className="run-detail pod-detail">
      <DetailBar
        title={viewTitle({ name: "pod", id: podId }, pod.title)}
        backLabel={backLabel("pods")}
        onBack={() => navigate({ name: "pods" })}
        status={<StatusBadge meta={statusMeta("pod", podBadgeStatus(pod, sessions))} />}
        // Automatic turns and merging are occasional, so they are dialogs from ⋯; closing is
        // destructive, so it comes last after a separator (§3.3, #2980). A closed pod can no longer
        // merge, so its merges stay readable from Recent Merges… (#2981).
        menu={[
          {
            label: "Automatic Turns…",
            disabled: Boolean(turnsReason),
            description: turnsReason ?? undefined,
            onClick: () => setDialog("turns"),
          },
          !active && receipts.length > 0 ? {
            label: "Recent Merges…",
            onClick: () => setDialog("merges"),
          } : {
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
      {phone ? (
        // One tab at a time under the bar (§15.1): the Huddle first, then each member.
        <div className="pod-phone">
          <p className={`pod-objective${pod.objective ? "" : " is-empty"}`} title={pod.objective || undefined}>{pod.objective || "No objective"}</p>
          <TabList label="Pod" className="compare-tabs pod-tabs">
            <button
              id={HUDDLE_TAB_ID}
              type="button"
              role="tab"
              aria-selected={shownMember === null}
              aria-controls={TAB_PANEL_ID}
              tabIndex={shownMember === null ? 0 : -1}
              className="tab compare-tab"
              onClick={() => selectTab(null)}
              onKeyDown={(event) => onTabKeyDown(event, 0)}
            >
              Huddle
            </button>
            {memberIds.map((sessionId, index) => (
              <MemberTab
                key={sessionId}
                sessionId={sessionId}
                index={index}
                selected={sessionId === shownMember}
                onSelect={() => selectTab(sessionId)}
                onKeyDown={(event) => onTabKeyDown(event, index + 1)}
              />
            ))}
          </TabList>
          {shownMember === null
            ? huddle({ id: TAB_PANEL_ID, labelledBy: HUDDLE_TAB_ID })
            : (
              <PodMemberColumn
                key={shownMember}
                sessionId={shownMember}
                tools={toolsFor(shownMember)}
                onRetry={retryHistory}
                panel={{ id: TAB_PANEL_ID, labelledBy: tabId(shownMember) }}
              />
            )}
        </div>
      ) : (
        <div className="pod-layout">
          <div className="pod-main">
            <p className={`pod-objective${pod.objective ? "" : " is-empty"}`} title={pod.objective || undefined}>{pod.objective || "No objective"}</p>
            <CompareRow label="Members">
              {memberIds.map((sessionId) => (
                <PodMemberColumn key={sessionId} sessionId={sessionId} tools={toolsFor(sessionId)} onRetry={retryHistory} />
              ))}
            </CompareRow>
          </div>
          {huddle()}
        </div>
      )}
      {dialog === "turns" && <PodAutomaticTurnsDialog pod={pod} sessions={sessions} onClose={() => setDialog(null)} />}
      {dialog === "merge" && <PodMergeWorkDialog pod={pod} sessions={sessions} runners={runners} onClose={() => setDialog(null)} />}
      {dialog === "merges" && <PodRecentMergesDialog pod={pod} sessions={sessions} onClose={() => setDialog(null)} />}
    </div>
  );
}
