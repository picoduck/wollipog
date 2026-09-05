import { browserRandomUUID } from "../browser-crypto.js";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CODEX_APP_SERVER_IMAGE_MIME_TYPES,
  MAX_PROMPT_IMAGES,
  PROMPT_IMAGE_MIME_TYPES,
  isPolicyApproval,
  isWorkspaceReference,
  isTerminal,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  providerSupportsConversationFork,
  type PromptImageInput,
  type CreateWorkspaceReferenceRequest,
  type QueuedPromptView,
  type SessionConfig,
  type SessionReminderView,
  type SessionView,
  type SourceLocation,
  type WorkspaceReference,
  type WorkspaceReferenceCandidate,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { isPartialHistory, isRebuiltEventsArray, useStoreActions, useStoreSelector } from "../store.js";
import { relativeTime, shortenPath } from "../format.js";
import { runnerDisplay } from "../runners.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { type TimelineItem } from "../timeline.js";
import { useTimeline } from "./useTimeline.js";
import {
  BackgroundDeliveryBadge,
  BackgroundNotificationBadge,
  BackgroundWorkBadge,
  UntrackedBackgroundWorkBadge,
  Empty,
  Modal,
  Spinner,
  SessionStatusIndicators,
} from "./common.js";
import { EventTimeline, type TimelineRevealRequest } from "./EventTimeline.js";
import { isTimelineSessionActive } from "../timeline-clock.js";
import { RightPanel, type RightPanelState } from "./RightPanel.js";
import { useGitStatus, useGitSummary } from "./useGitStatus.js";
import { sessionChangeStatus, sessionMayShowChangeStatus } from "../session-status.js";
import { ImageStrip, usePastedImages } from "./images.js";
import { PromptImageView } from "./PromptImageView.js";
import {
  hasNewPendingPrompt,
  PendingPromptBubbles,
  queuedPromptsWithControls,
  shouldShowOptimisticPrompt,
} from "./PendingPromptBubbles.js";
import { ApprovalsControl, ModelEffortControl } from "./ComposerControls.js";
import { modelSupportsImages, resolveCaps } from "../caps.js";
import { PinnedSummary } from "./PinnedSummary.js";
import { deriveGitPresentation } from "../pinned-summary.js";
import { useVoiceDictation } from "./useVoiceDictation.js";
import { appendTranscript } from "../dictation.js";
import { loadSeen, markSeen, saveSeen } from "../sessions-seen.js";
import { subscriptionRecoveryRevision } from "../ui-subscriptions.js";
import { isHeartbeatBusy } from "../activity.js";
import { ActivityStrip } from "./ActivityStrip.js";
import {
  composerDraftMatches,
  deleteComposerDraftIfMatches,
  consumeComposerDraftHandoff,
  loadComposerDraft,
  markComposerDraftAccepted,
  reserveComposerDraftSnapshot,
  saveComposerDraft,
  stageComposerDraftHandoff,
  type ComposerCommandSubmission,
  type ComposerDraft,
} from "../composer-drafts.js";
import { sessionAgentLabel } from "./agent-options.js";
import {
  loadOlderSessionEvents,
  recoverSessionHistory,
  recoverSessionHistoryWindow,
  shouldReadOpeningWindow,
} from "../history-recovery.js";
import {
  routedSessionPlaceholder,
  shouldHydrateRoutedSession,
  type RoutedSessionLookup,
} from "../detail-placeholder.js";
import { transcriptPresentation } from "../transcript-presentation.js";
import {
  acquireSessionFork,
  canStopActiveTurn,
  composerPrimaryAction,
  conversationForkAvailability,
  editInForkAvailability,
  forkFailureIsAmbiguous,
  sessionForkInProgress,
  subscribeSessionForks,
  type ConversationForkAvailability,
} from "../session-actions.js";
import { SessionApprovalRegion } from "./SessionApproval.js";
import { ComposerQuestionResponse } from "./ComposerQuestionResponse.js";
import { GovernanceAuditTrail } from "./GovernanceAuditTrail.js";
import { SessionHeader } from "./SessionHeader.js";
import { useInstanceScope } from "../instance-scope.js";
import { useAccessibleMenu, useDismissiblePopover } from "./interactions.js";
import { useFeedback } from "./FeedbackProvider.js";
import { ContextWindowMeter } from "./ContextWindowMeter.js";
import { sessionPreviewUsage } from "../session-preview.js";
import {
  followTailControlLabel,
  followTailControlTooltip,
  followTailSurfaceLabel,
  hasSavedFollowTailAnchor,
  isFollowTailResumeKey,
  isFollowTailUpwardReadingKey,
  type FollowTailState,
  useFollowTail,
} from "../useFollowTail.js";
import { useSessionReadingKeys, type SessionReadingKeyActions } from "../useSessionReadingKeys.js";
import { VIRTUAL_VIEWPORT_INTENT_EVENT } from "../viewport-intent.js";
import { inTypingContext, matchesShortcut, shortcutDisplay, shortcutLayerActive } from "../shortcuts.js";
import { useIsMobile, useIsTouchPhone } from "./useIsMobile.js";
import {
  usePreviewNavigationRegistration,
  type PreviewNavigationControls,
} from "./usePreviewNavigationRegistration.js";
import { ShortcutHint } from "./ShortcutHint.js";
import {
  conversationSteeringAvailability,
  queuedPromptEditingAvailability,
  queuedPromptSteeringAvailability,
  shouldReloadReservedDraft,
} from "../conversation-steering.js";
import { SteeringReceipts } from "./SteeringReceipts.js";
import { SessionCommandReceipts } from "./SessionCommandReceipts.js";
import { ArrowUpIcon, ChevronLeftIcon, EditIcon, FolderSolidIcon, ImageIcon, MicIcon, MoreVerticalIcon, PlusIcon, RefreshIcon, StopTurnIcon } from "./Icons.js";
import {
  DURABLE_COMMAND_ATTACHMENT_NOTICE,
  buildComposerCommandRegistry,
  durableCommandPreservesAttachments,
  findComposerCommandTrigger,
  mapProviderComposerCommands,
  rankComposerCommands,
  replaceComposerCommandTrigger,
  resolveComposerCommandInvocation,
  retainActiveComposerCommandId,
  type ComposerCommand,
  type ProviderComposerCommand,
} from "../composer-commands.js";
import { SlashCommandMenu, slashCommandOptionId } from "./SlashCommandMenu.js";
import { WorkspaceReferencePicker } from "./WorkspaceReferencePicker.js";
import {
  captureComposerFocus,
  focusComposerAtEnd,
  placeComposerCaretAtEnd,
  rememberComposerFocusForRemount,
  reportComposerFocus,
  restoreComposerFocus,
  restoreRememberedComposerFocus,
} from "../composer-focus.js";
import { enterKeystrokeSends, useEnterKeyBehavior } from "../enter-key.js";
import { useQuestionResponseStyle } from "../question-response-style.js";
import { KEYBOARD_DISMISS_BLUR_EVENT } from "../mobile-viewport.js";
import { resizeComposerToContent } from "../composer-autogrow.js";
import { IncrementalActiveTurnProgress } from "../turn-progress.js";
import { IncrementalSubagentProjector, selectedSubagentId } from "../subagents.js";
import { WorkingIndicator } from "./WorkingIndicator.js";
import {
  projectAssignmentAudienceConfirmation,
  projectAudienceLabel,
  persistProjectAssignment,
  sessionProjectChoices,
  shouldSubmitProjectAssignment,
} from "../session-project-assignment.js";
import { durableInboxProjectKey, INBOX_NO_PROJECT_SPLIT_KEY } from "../inbox.js";
import { ChoiceCards, type ChoiceCardOption } from "./ui/ChoiceControls.js";
import {
  clearDurableQueuedEditRecoveriesForAccount,
  clearDurableQueuedEditRecovery,
  clearRuntimeQueuedEditRecoveriesForInstance,
  clearRuntimeQueuedEditRecovery,
  cloneQueuedPromptEditRecovery,
  loadDurableQueuedEditRecovery,
  loadRuntimeQueuedEditRecovery,
  queuedEditRecoveryAccountKey,
  reconcileQueuedEditRecovery,
  saveDurableQueuedEditRecovery,
  storeRuntimeQueuedEditRecovery,
  type QueuedEditRecoveryScope,
  type QueuedPromptEditRecovery,
  type QueuedPromptEditState,
} from "../queued-edit-recovery.js";
import { materializePromptImages } from "../prompt-image-materialization.js";

const NO_IMAGE_MIME_TYPES: readonly string[] = [];
const STOP_TURN_RETRY_MS = 8_000;
const EARLIER_ACTIVITY_TRIGGER_PX = 160;
const EARLIER_ACTIVITY_REARM_DISTANCE_PX = 32;
const EARLIER_ACTIVITY_REARM_FRAMES = 8;
const EARLIER_ACTIVITY_TOUCH_IDLE_MS = 180;
/** Opening recovery may add at most the same 2,000 raw events that server-side turn alignment
 * searches. This keeps a pathological single turn bounded while normal underfilled readers need
 * only one or two pages. */
const OPENING_HISTORY_MAX_PAGES = 10;
/** Leave the earlier-history control safely above a tail-following viewport instead of stopping as
 * soon as the reader gains a one-pixel scroll range. */
const OPENING_HISTORY_HEADROOM_PX = EARLIER_ACTIVITY_TRIGGER_PX;

type EarlierActivityIntent = "single-scroll" | "touch-traversal";

type ComposerMutationKind = "send" | "steer" | "promote" | "edit" | "stop";
type ComposerMutationEntry = {
  token: symbol;
  kind: ComposerMutationKind;
  draft?: { text: string; images: PromptImageInput[]; revision?: string };
  queuedEdit?: QueuedPromptEditRecovery;
  displaced?: ComposerMutationEntry;
};
const composerMutationRegistry = new Map<string, ComposerMutationEntry>();
const composerMutationRecoveries = new Map<string, { text: string; images: PromptImageInput[] }>();
const MAX_COMPOSER_MUTATION_RECOVERIES = 20;
const composerMutationListeners = new Map<string, Set<() => void>>();

function composerMutationKey(instanceScope: string, sessionId: string): string {
  return `${instanceScope}\u0000${sessionId}`;
}

/** Forget page-lifetime composer state when an authenticated instance is retired or replaced. */
export function clearSessionDetailComposerRuntimeForInstance(instanceScope: string): void {
  const prefix = `${instanceScope}\u0000`;
  const affected = new Set<string>();
  for (const registry of [composerMutationRegistry, composerMutationRecoveries]) {
    for (const key of registry.keys()) {
      if (!key.startsWith(prefix)) continue;
      registry.delete(key);
      affected.add(key);
    }
  }
  clearRuntimeQueuedEditRecoveriesForInstance(instanceScope);
  for (const key of affected) notifyComposerMutation(key);
}

function notifyComposerMutation(key: string): void {
  for (const listener of composerMutationListeners.get(key) ?? []) listener();
}

function queuedPromptEditMutationRecovery(
  mutation: ComposerMutationEntry | undefined,
): QueuedPromptEditRecovery | undefined {
  if (!mutation) return undefined;
  if (mutation.kind === "edit" && mutation.queuedEdit) return mutation.queuedEdit;
  return queuedPromptEditMutationRecovery(mutation.displaced);
}

function recoveryWithDisplacedDraft(
  recovery: QueuedPromptEditRecovery,
  draft: Pick<ComposerDraft, "text" | "images"> | null | undefined,
): QueuedPromptEditRecovery {
  if (draft === undefined) return recovery;
  const { displacedDraftStoredSeparately: _storedSeparately, ...edit } = recovery.edit;
  return {
    ...recovery,
    edit: {
      ...edit,
      displacedDraft: draft !== null
        ? { text: draft.text, images: draft.images.map((image) => ({ ...image })) }
        : recovery.edit.displacedDraft,
    },
  };
}

function updateQueuedPromptEditMutationRecovery(
  key: string,
  recovery: QueuedPromptEditRecovery,
): void {
  const current = composerMutationRegistry.get(key);
  if (!current) return;
  const update = (entry: ComposerMutationEntry): ComposerMutationEntry => {
    if (entry.kind === "edit" && entry.queuedEdit) {
      return { ...entry, queuedEdit: cloneQueuedPromptEditRecovery(recovery) };
    }
    if (!entry.displaced) return entry;
    const displaced = update(entry.displaced);
    return displaced === entry.displaced ? entry : { ...entry, displaced };
  };
  const next = update(current);
  if (next === current) return;
  composerMutationRegistry.set(key, next);
  notifyComposerMutation(key);
}

function reserveComposerMutation(
  key: string,
  kind: ComposerMutationKind,
  draft?: ComposerMutationEntry["draft"],
  queuedEdit?: QueuedPromptEditRecovery,
): ComposerMutationEntry | null {
  const current = composerMutationRegistry.get(key);
  if (current && (kind !== "stop" || current.kind === "stop")) return null;
  if (kind !== "stop") composerMutationRecoveries.delete(key);
  const entry: ComposerMutationEntry = {
    token: Symbol(kind),
    kind,
    ...(draft ? { draft } : {}),
    ...(queuedEdit ? { queuedEdit: cloneQueuedPromptEditRecovery(queuedEdit) } : {}),
    ...(current ? { displaced: current } : {}),
  };
  composerMutationRegistry.set(key, entry);
  notifyComposerMutation(key);
  return entry;
}

function updateComposerMutationDraft(
  key: string,
  token: symbol,
  draft: NonNullable<ComposerMutationEntry["draft"]>,
): void {
  const current = composerMutationRegistry.get(key);
  if (!current) return;
  if (current.token === token) {
    composerMutationRegistry.set(key, { ...current, draft });
  } else if (current.displaced?.token === token) {
    composerMutationRegistry.set(key, { ...current, displaced: { ...current.displaced, draft } });
  } else {
    return;
  }
  notifyComposerMutation(key);
}

function storeComposerMutationRecovery(
  key: string,
  recoveryDraft?: { text: string; images: PromptImageInput[] },
): void {
  if (!recoveryDraft) return;
  composerMutationRecoveries.delete(key);
  composerMutationRecoveries.set(key, recoveryDraft);
  while (composerMutationRecoveries.size > MAX_COMPOSER_MUTATION_RECOVERIES) {
    const oldest = composerMutationRecoveries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    composerMutationRecoveries.delete(oldest);
  }
}

function releaseComposerMutation(
  key: string,
  token: symbol,
  recoveryDraft?: { text: string; images: PromptImageInput[] },
): void {
  const current = composerMutationRegistry.get(key);
  if (!current) return;
  if (current.token === token) {
    storeComposerMutationRecovery(key, recoveryDraft);
    if (current.displaced) composerMutationRegistry.set(key, current.displaced);
    else composerMutationRegistry.delete(key);
  } else if (current.displaced?.token === token) {
    storeComposerMutationRecovery(key, recoveryDraft);
    composerMutationRegistry.set(key, { ...current, displaced: undefined });
  } else {
    return;
  }
  notifyComposerMutation(key);
}

function subscribeComposerMutation(key: string, listener: () => void): () => void {
  const listeners = composerMutationListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  composerMutationListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) composerMutationListeners.delete(key);
  };
}

function invalidateComposerMutationRecovery(key: string): void {
  composerMutationRecoveries.delete(key);
}

export type SessionDetailMode = "preview" | "expanded";

export interface PreviewForkControls {
  availability: ConversationForkAvailability;
  fork: () => void;
}

export type SessionDetailProps = {
  sessionId: string;
  mode?: SessionDetailMode;
  sourceLocation?: SourceLocation;
  rightPanel: RightPanelState;
  onOpenTerminal: () => void;
  pinnedOpen: boolean;
  focusComposer?: boolean;
  onComposerFocusConsumed?: () => void;
  onBack?: () => void;
  onExpand?: () => void;
  onNextSession?: () => void;
  onPreviousSession?: () => void;
  onApprove?: () => void;
  onDeny?: () => void;
  onArchive?: () => void;
  onSnooze?: () => void;
  reminder?: SessionReminderView;
  onDismissReminder?: () => void;
  /** App-shell control cluster (editor, pinned/terminal/panel toggles) rendered in the unified
   * session bar when it replaces the app-level top bar on desktop. */
  topbarControls?: ReactNode;
  /** Transport-owned policy seam. Native passthrough commands default to the existing send path. */
  providerCommandAttachmentPolicy?: ProviderComposerCommand["attachmentPolicy"];
  /** Registers preview-only paging ownership and live-follow actions with the Inbox key layer. */
  onPreviewNavigationReady?: (controls: PreviewNavigationControls | null) => void;
  /** Registers the selected preview's latest-checkpoint fork action with the Inbox key layer. */
  onPreviewForkReady?: (controls: PreviewForkControls | null) => void;
  /** Injectable storage boundary for deterministic component tests; production uses durable storage. */
  composerDraftLoader?: (sessionId: string, instanceScope: string) => Promise<ComposerDraft | null>;
  /** Injectable cleanup boundary for deterministic post-acceptance storage-fault tests. */
  composerDraftCleanup?: typeof deleteComposerDraftIfMatches;
};

type MessageActionState = {
  mode: "resend" | "fork";
  item: Extract<TimelineItem, { kind: "user_message" }>;
  forkTurn?: number;
};

class AmbiguousForkError extends Error {}

function findWorkspaceReferenceTrigger(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/u.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
}

function ambiguousForkError(cause: unknown): AmbiguousForkError | null {
  if (!forkFailureIsAmbiguous(cause instanceof ApiError ? cause.status : undefined)) return null;
  return new AmbiguousForkError(
    "The fork outcome is uncertain. Do not retry. Wait for the child to appear on the Board, and reload only after checking there.",
  );
}

export function SessionDetail(props: SessionDetailProps) {
  const api = useApi();
  const { sessionId } = props;
  const { dispatch, loadSession, navigate } = useStoreActions();
  const session = useStoreSelector((s) => s.sessions.get(sessionId));
  const conn = useStoreSelector((s) => s.conn);
  const snapshotRevision = useStoreSelector((s) => s.snapshotRevision);
  const isMobile = useIsMobile();
  const lastLookupKeyRef = useRef<string | null>(null);
  const [sessionLookup, setSessionLookup] = useState<RoutedSessionLookup>({
    sessionId,
    complete: false,
    error: null,
  });

  // Archived sessions are deliberately absent from the live snapshot. Resolve the exact routed id
  // through the normal authorized REST surface so copied links remain durable after archiving.
  // A reconnect keeps the already-rendered archived row mounted, then revalidates it once for the
  // new snapshot generation so a deletion missed while offline still becomes authoritative.
  useEffect(() => {
    if (!shouldHydrateRoutedSession(session, snapshotRevision, conn)) return;
    const lookupKey = JSON.stringify([sessionId, snapshotRevision, conn]);
    if (lastLookupKeyRef.current === lookupKey) return;
    lastLookupKeyRef.current = lookupKey;
    let current = true;
    setSessionLookup({ sessionId, complete: false, error: null });
    void api.session(sessionId)
      .then(({ session: loaded }) => {
        if (!current) return;
        loadSession(loaded);
        setSessionLookup({ sessionId, complete: true, error: null });
      })
      .catch((cause: unknown) => {
        if (!current) return;
        const notFound = cause instanceof ApiError && cause.status === 404;
        if (notFound && session) {
          dispatch({ type: "msg", msg: { type: "session_removed", sessionId } });
        }
        setSessionLookup({ sessionId, complete: true, error: notFound ? null : (cause as Error).message });
      });
    return () => { current = false; };
  }, [api, sessionId, session, loadSession, dispatch, conn, snapshotRevision]);

  if (!session) {
    const placeholder = routedSessionPlaceholder(sessionId, sessionLookup, conn);
    // On desktop the session route hides the app-level top bar, so even the loading,
    // unavailable, and not-found states must own the page heading and the `page-title`
    // focus-rescue anchor — otherwise view-change focus rescue lands on <body> and the
    // page has no level-one heading (regression coverage).
    const ownsPageTitle = props.mode !== "preview" && !isMobile;
    return (
      <div className="session-detail expanded" data-session-surface-id={sessionId}>
        {props.mode !== "preview" && !isMobile && (
          <div className="detail-head">
            <button
              className="icon-btn back"
              onClick={props.onBack ?? (() => navigate({ name: "inbox" }))}
              title="Back to inbox"
              aria-label="Back to Inbox"
            >
              <ChevronLeftIcon size={22} />
            </button>
            <div className="detail-crumbs">
              <h1
                className="detail-title"
                id={ownsPageTitle ? "page-title" : undefined}
                tabIndex={ownsPageTitle ? -1 : undefined}
              >
                {placeholder.title}
              </h1>
            </div>
          </div>
        )}
        <Empty title={placeholder.title} hint={placeholder.hint} />
      </div>
    );
  }

  return <SessionDetailLoaded {...props} session={session} />;
}

function SessionDetailLoaded({
  sessionId,
  sourceLocation,
  rightPanel,
  onOpenTerminal,
  pinnedOpen,
  focusComposer,
  onComposerFocusConsumed,
  mode = "expanded",
  onBack,
  onExpand,
  onNextSession,
  onPreviousSession,
  onApprove,
  onDeny,
  onArchive,
  onSnooze,
  reminder,
  onDismissReminder,
  topbarControls,
  providerCommandAttachmentPolicy = "send",
  onPreviewNavigationReady,
  onPreviewForkReady,
  composerDraftLoader = loadComposerDraft,
  composerDraftCleanup = deleteComposerDraftIfMatches,
  session,
}: SessionDetailProps & { session: SessionView }) {
  const api = useApi();
  const isMobile = useIsMobile();
  const projectsSupported = useStoreSelector((state) => state.projectsSupported);
  const projects = useStoreSelector((state) => state.projects);
  const instanceScope = useInstanceScope();
  const mutationKey = composerMutationKey(instanceScope, sessionId);
  const subscribeMutation = useCallback(
    (listener: () => void) => subscribeComposerMutation(mutationKey, listener),
    [mutationKey],
  );
  const readMutation = useCallback(
    () => composerMutationRegistry.get(mutationKey),
    [mutationKey],
  );
  const activeComposerMutation = useSyncExternalStore(subscribeMutation, readMutation, readMutation);
  const { confirm, showToast } = useFeedback();
  // Narrow selector subscriptions: this component must re-render for ITS session's events and
  // row, not for every token-usage upsert of every other session on the board.
  const {
    loadEvents,
    loadOlderEvents,
    beginOlderEventsLoad,
    failOlderEventsLoad,
    eventWindowBase,
    loadSession,
    navigate,
    recoveryAfter,
    beginEventHistoryLoad,
    failEventHistoryLoad,
  } = useStoreActions();
  const openSourceLocation = useCallback((location: SourceLocation) => {
    navigate({ name: "session", id: sessionId, location });
  }, [navigate, sessionId]);
  const clearSourceLocation = useCallback(() => {
    navigate({ name: "session", id: sessionId });
  }, [navigate, sessionId]);
  const recoveryEventEpoch = useStoreSelector((s) => s.sessions.get(sessionId)?.eventEpoch ?? 0);
  const recoveryGeneration = useStoreSelector((s) => s.snapshotRevision);
  const evs = useStoreSelector((s) => s.events.get(sessionId));
  // Read inside the recovery effect without becoming one of its dependencies: that effect must run
  // once per open, not once per streamed event.
  const evsRef = useRef(evs);
  evsRef.current = evs;
  const olderInFlightRef = useRef(false);
  // Whether a fetched history has ever completed for the CURRENT epoch. Read by the recovery effect
  // before it registers its own load, so the effect sees the state that preceded it.
  const everCompletedRef = useRef(false);
  const eventHistory = useStoreSelector((s) => {
    const history = s.eventHistory.get(sessionId);
    return history?.eventEpoch === (s.sessions.get(sessionId)?.eventEpoch ?? 0) ? history : undefined;
  });
  everCompletedRef.current = eventHistory?.everComplete === true;
  const eventWindow = useStoreSelector((s) => {
    const window = s.eventWindows.get(sessionId);
    return window?.eventEpoch === (s.sessions.get(sessionId)?.eventEpoch ?? 0) ? window : undefined;
  });
  const runner = useStoreSelector((s) => s.runners.get(session.runnerId));
  const runnerOnline = runner?.status === "online";
  const snapshotLoaded = useStoreSelector((s) => s.snapshotLoaded);
  const stopBeforeArchiveSupported = useStoreSelector((s) => s.stopBeforeArchiveSupported);
  const richGitSupported = runnerSupportsProtocol(runner?.protocolVersion, "gitVisibility");
  const box = useStoreSelector((s) => [...s.boxes.values()].find((candidate) => candidate.runnerId === session.runnerId));
  const conn = useStoreSelector((s) => s.conn);
  const anchorRecoveryPending = eventHistory?.refreshing === true ||
    (conn === "online" && eventHistory?.everComplete !== true && eventHistory?.error == null);
  const recoveryRevision = useStoreSelector((s) =>
    subscriptionRecoveryRevision(s.streamSubscriptions, [sessionId]));
  const activity = useStoreSelector((s) => s.activity.get(sessionId));
  const activityNow = useStoreSelector((s) => s.activityNow);
  const stalled = useStoreSelector((s) => s.stalledSessionIds.has(sessionId));
  const lastActivityAt = Math.max(session.lastEventAt ?? 0, activity?.lastEventAt ?? 0) || session.updatedAt;
  const [text, setText] = useState("");
  const draftDirty = useRef(false);
  const [busy, setBusy] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [steeringBusy, setSteeringBusy] = useState(false);
  const [queuedEditBusy, setQueuedEditBusy] = useState(false);
  const [queuedEdit, setQueuedEdit] = useState<QueuedPromptEditState | null>(null);
  const [queuedEditRecovered, setQueuedEditRecovered] = useState(false);
  const [queuedEditAccountKey, setQueuedEditAccountKey] = useState<string | null>(null);
  const queuedEditAccountKeyRef = useRef<string | null>(null);
  const queuedEditRef = useRef<QueuedPromptEditState | null>(null);
  queuedEditRef.current = queuedEdit;
  useEffect(() => {
    setQueuedEdit(null);
    setQueuedEditBusy(false);
    setQueuedEditRecovered(false);
  }, [sessionId]);
  useEffect(() => {
    if (mode !== "expanded" || conn !== "online") return;
    let cancelled = false;
    let retryTimer: number | undefined;
    let retryDelayMs = 1_000;
    const loadIdentity = () => {
      void api.getIdentity().then(({ context }) => {
        if (cancelled) return;
        const nextAccountKey = queuedEditRecoveryAccountKey(context.organizationId, context.userId);
        const priorAccountKey = queuedEditAccountKeyRef.current;
        if (priorAccountKey && priorAccountKey !== nextAccountKey) {
          clearDurableQueuedEditRecoveriesForAccount(instanceScope, priorAccountKey);
          clearSessionDetailComposerRuntimeForInstance(instanceScope);
          queuedEditRef.current = null;
          setQueuedEdit(null);
          setQueuedEditBusy(false);
          setQueuedEditRecovered(false);
          setError(null);
        }
        queuedEditAccountKeyRef.current = nextAccountKey;
        setQueuedEditAccountKey(nextAccountKey);
      }).catch(() => {
        if (cancelled) return;
        // Do not guess an account scope. Retry with bounded backoff so a transient identity error
        // cannot disable queued editing for the lifetime of an otherwise-online view.
        retryTimer = window.setTimeout(loadIdentity, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      });
    };
    loadIdentity();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [api, conn, instanceScope, mode]);
  const queuedEditRecoveryScope = useMemo<QueuedEditRecoveryScope | null>(() =>
    queuedEditAccountKey
      ? { instanceScope, accountKey: queuedEditAccountKey, sessionId }
      : null,
  [instanceScope, queuedEditAccountKey, sessionId]);
  const queueSteeringInFlightRef = useRef(new Set<string>());
  const steeringResolutionInFlightRef = useRef(new Set<string>());
  const [queueSteeringPending, setQueueSteeringPending] = useState<ReadonlySet<string>>(() => new Set());
  const [steeringResolutionPending, setSteeringResolutionPending] = useState<ReadonlyMap<
    string,
    "queue_again" | "dismiss"
  >>(() => new Map());
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const [retitleFeedback, setRetitleFeedback] = useState<
    { state: "running" } | { state: "failed"; message: string } | null
  >(null);
  const retitlePending = retitleFeedback?.state === "running";
  const retitleInFlightRef = useRef(false);
  const retitleFocusRestoreRef = useRef<{
    generation: number;
    sessionId: string;
    composer: ReturnType<typeof captureComposerFocus>;
  } | null>(null);
  const retitleRetryPointerActivationRef = useRef(false);
  const [pendingPromptAction, setPendingPromptAction] = useState<string>();
  const sendRequestBusy = busy || activeComposerMutation?.kind === "send";
  const steeringRequestBusy = steeringBusy || activeComposerMutation?.kind === "steer" ||
    activeComposerMutation?.kind === "promote";
  const stopRequestPending = stoppingTurn || activeComposerMutation?.kind === "stop";
  const composerRequestBusy = activeComposerMutation !== undefined || busy || steeringBusy || queuedEditBusy || stoppingTurn ||
    retitlePending;
  const stopTurnPendingRef = useRef(false);
  const stopTurnMutationRef = useRef<ComposerMutationEntry | null>(null);
  const stopTurnAttemptRef = useRef(0);
  const stopTurnRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messageAction, setMessageAction] = useState<MessageActionState | null>(null);
  const messageActionReturnFocusRef = useRef<HTMLElement | null>(null);
  const forkInFlightRef = useRef(false);
  const readForkInProgress = useCallback(() => sessionForkInProgress(sessionId), [sessionId]);
  const forkInProgress = useSyncExternalStore(
    subscribeSessionForks,
    readForkInProgress,
    readForkInProgress,
  );
  const viewGenerationRef = useRef(0);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [olderRequestSettled, setOlderRequestSettled] = useState(0);
  const [openingHistoryFill, setOpeningHistoryFill] = useState({
    historyKey: `${session.id}:${session.eventEpoch ?? 0}`,
    settled: false,
  });
  const [optimisticModel, setOptimisticModel] = useState<string | undefined>();
  const [activeSlashCommandId, setActiveSlashCommandId] = useState<string | null>(null);
  const [timelineRevealRequest, setTimelineRevealRequest] = useState<TimelineRevealRequest | null>(null);
  const timelineRevealRequestRef = useRef<TimelineRevealRequest | null>(null);
  const timelineRevealRestoreState = useRef<{ requestId: number; state: FollowTailState } | null>(null);
  const timelineRevealRequestId = useRef(0);
  const timelineHistoryKey = `${session.id}:${session.eventEpoch ?? 0}`;
  const automaticEarlierLoadRef = useRef({
    historyKey: timelineHistoryKey,
    requestedBase: null as number | null,
    nextTriggerTop: null as number | null,
    readerStarted: false,
    settling: false,
    settleFrame: null as number | null,
    readerIntent: null as EarlierActivityIntent | null,
    readerIntentTop: null as number | null,
    touchActive: false,
    nativeTouchActive: false,
    touchInputY: null as number | null,
    touchTraversalStarted: false,
    touchEndTimer: null as number | null,
    readerIntentMovedUp: false,
  });
  const openingHistoryFillRef = useRef({
    historyKey: timelineHistoryKey,
    requestedBase: null as number | null,
    pagesRequested: 0,
    settled: false,
    recheckOnExpansion: false,
    mode,
    measureFrame: null as number | null,
  });
  const [composerSelection, setComposerSelection] = useState({ start: 0, end: 0 });
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
  const slashListboxId = `session-slash-${useId().replace(/:/g, "")}`;
  const workspaceListboxId = `session-workspace-${useId().replace(/:/g, "")}`;
  const [workspaceResults, setWorkspaceResults] = useState<WorkspaceReferenceCandidate[]>([]);
  const [workspaceSearchBusy, setWorkspaceSearchBusy] = useState(false);
  const [workspaceSearchError, setWorkspaceSearchError] = useState<string | null>(null);
  const [workspaceSearchTruncated, setWorkspaceSearchTruncated] = useState(false);
  const [activeWorkspaceResult, setActiveWorkspaceResult] = useState(0);
  const [workspaceDismissedFor, setWorkspaceDismissedFor] = useState<string | null>(null);
  const [inspectedWorkspaceReference, setInspectedWorkspaceReference] = useState<WorkspaceReference | null>(null);
  const [dragActive, setDragActive] = useState(false);
  // Up-arrow history recall (-1 = editing/not browsing). Prior prompts come from the timeline.
  const [histIdx, setHistIdx] = useState(-1);
  // Optimistic just-sent message: renders immediately so the send feels instant, then yields to the
  // real user_message event the runner echoes back (deduped by user-message count, see below).
  const [pending, setPending] = useState<{ text: string; images: PromptImageInput[] } | null>(null);
  const sendBaselineRef = useRef(0);
  const dragDepth = useRef(0); // enter/leave bubble from children — count depth so the overlay doesn't stick
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const answerInputRef = useRef<HTMLInputElement>(null);
  const retitleReceiptRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef(rightPanel);
  rightPanelRef.current = rightPanel;
  const backgroundInventoryRequestRef = useRef<string | null>(null);
  const [backgroundInventoryError, setBackgroundInventoryError] = useState<string | null>(null);
  const [backgroundInventoryAttempt, setBackgroundInventoryAttempt] = useState(0);
  const retryBackgroundInventory = useCallback(() => {
    backgroundInventoryRequestRef.current = null;
    setBackgroundInventoryError(null);
    setBackgroundInventoryAttempt((attempt) => attempt + 1);
  }, []);
  useEffect(() => {
    if (mode !== "expanded" || !rightPanel.open || rightPanel.mode !== "background" ||
        session.backgroundJobsAvailable !== true || session.backgroundJobs !== undefined) {
      if (session.backgroundJobs !== undefined || mode !== "expanded" ||
          !rightPanel.open || rightPanel.mode !== "background") {
        backgroundInventoryRequestRef.current = null;
        setBackgroundInventoryError(null);
      }
      return;
    }
    const requestKey = `${session.id}:${recoveryGeneration}`;
    if (backgroundInventoryRequestRef.current === requestKey) return;
    backgroundInventoryRequestRef.current = requestKey;
    setBackgroundInventoryError(null);
    let current = true;
    void api.session(session.id)
      .then(({ session: loaded }) => {
        if (current) loadSession(loaded);
      })
      .catch((cause: unknown) => {
        if (current) setBackgroundInventoryError((cause as Error).message);
      });
    return () => { current = false; };
  }, [api, backgroundInventoryAttempt, loadSession, mode, recoveryGeneration,
    rightPanel.mode, rightPanel.open, session.backgroundJobs, session.backgroundJobsAvailable, session.id]);
  const composerComposingRef = useRef(false);
  const pendingComposerFocusRestoreRef = useRef<ReturnType<typeof captureComposerFocus> | null>(null);
  const composerExplicitFocusTransferRef = useRef(false);
  const composerFocusRestoreFrameRef = useRef<number | null>(null);
  const composerWindowTransferVersionRef = useRef(0);
  const composerInteractionVersionRef = useRef(0);
  const composerDraftVersionRef = useRef(0);
  const commandSubmissionRetryRef = useRef<ComposerCommandSubmission | null>(null);
  const consumedDraftsRef = useRef(new Map<string, {
    text: string;
    images: PromptImageInput[];
    draftVersion: number;
  }>());
  const composerDraftLoaderRef = useRef(composerDraftLoader);
  composerDraftLoaderRef.current = composerDraftLoader;
  const draftHydrationKeyRef = useRef<string | null>(null);
  const draftHydratedSessionRef = useRef<string | null>(null);
  const suppressedDraftRef = useRef<{ sessionId: string; revision?: string } | null>(null);
  const pendingHydrationCaretRef = useRef<{
    sessionId: string;
    interactionVersion: number;
  } | null>(null);
  const pendingHydrationCommitRef = useRef<{
    sessionId: string;
    expectedText: string;
  } | null>(null);
  const [hydrationCommitRevision, setHydrationCommitRevision] = useState(0);
  const focusComposerRequestedRef = useRef(focusComposer);
  focusComposerRequestedRef.current = focusComposer;

  const composerFocusKey = `${instanceScope}\u0000${sessionId}`;

  const snapshotComposerFocus = useCallback((kind: Parameters<typeof reportComposerFocus>[1]) => {
    const element = inputRef.current;
    if (!element) return;
    reportComposerFocus(sessionId, kind, element, composerComposingRef.current);
  }, [sessionId]);

  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    pendingComposerFocusRestoreRef.current = null;
    reportComposerFocus(sessionId, "mount", element, false);
    const remembered = restoreRememberedComposerFocus(composerFocusKey, element);
    if (remembered) {
      const active = element.ownerDocument.activeElement;
      if (active && active !== element.ownerDocument.body && active !== element) {
        pendingComposerFocusRestoreRef.current = null;
      } else {
        pendingComposerFocusRestoreRef.current = remembered;
        element.focus({ preventScroll: true });
        if (restoreComposerFocus(element, remembered)) {
          pendingComposerFocusRestoreRef.current = null;
          reportComposerFocus(sessionId, "restore", element, false);
        }
      }
    }
    return () => {
      if (composerFocusRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(composerFocusRestoreFrameRef.current);
        composerFocusRestoreFrameRef.current = null;
      }
      if (
        element.ownerDocument.activeElement === element
        && !composerComposingRef.current
        && !composerExplicitFocusTransferRef.current
      ) {
        rememberComposerFocusForRemount(composerFocusKey, element);
      }
      reportComposerFocus(sessionId, "unmount", element, composerComposingRef.current);
    };
  }, [composerFocusKey, sessionId]);

  useLayoutEffect(() => {
    const pending = pendingComposerFocusRestoreRef.current;
    const element = inputRef.current;
    if (!pending || !element || composerComposingRef.current) return;
    if (!restoreComposerFocus(element, pending)) return;
    pendingComposerFocusRestoreRef.current = null;
    reportComposerFocus(sessionId, "restore", element, false);
  }, [sessionId, text]);

  useEffect(() => {
    let clearExplicitTransferTimer: ReturnType<typeof setTimeout> | null = null;
    const markExplicitTransfer = () => {
      composerExplicitFocusTransferRef.current = true;
      if (clearExplicitTransferTimer) clearTimeout(clearExplicitTransferTimer);
      clearExplicitTransferTimer = setTimeout(() => {
        composerExplicitFocusTransferRef.current = false;
        clearExplicitTransferTimer = null;
      }, 0);
    };
    const clearExplicitTransfer = () => {
      composerExplicitFocusTransferRef.current = false;
      if (clearExplicitTransferTimer) clearTimeout(clearExplicitTransferTimer);
      clearExplicitTransferTimer = null;
    };
    const markExplicitPointerTransfer = (event: PointerEvent) => {
      const composer = inputRef.current;
      if (composer && event.target instanceof Node && !composer.contains(event.target)) markExplicitTransfer();
    };
    const markExplicitKeyboardTransfer = (event: globalThis.KeyboardEvent) => {
      const plainEscape = event.key === "Escape"
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
        && !event.altKey;
      if (event.key === "Tab" || event.key === "F6" || plainEscape) markExplicitTransfer();
    };
    const markWindowTransfer = () => {
      composerWindowTransferVersionRef.current += 1;
      markExplicitTransfer();
    };
    document.addEventListener("pointerdown", markExplicitPointerTransfer, true);
    document.addEventListener("keydown", markExplicitKeyboardTransfer, true);
    window.addEventListener("blur", markWindowTransfer);
    window.addEventListener("focus", clearExplicitTransfer);
    // The keyboard-dismissal detector (mobile-viewport.ts) blurs the composer when the software
    // keyboard closes without one — Android Back — and a programmatic blur has no pointerdown or
    // keydown to mark it. Unmarked, it reads as accidental background loss, and the recovery
    // refocus re-summons on Android the very keyboard the user just collapsed.
    window.addEventListener(KEYBOARD_DISMISS_BLUR_EVENT, markExplicitTransfer);
    return () => {
      document.removeEventListener("pointerdown", markExplicitPointerTransfer, true);
      document.removeEventListener("keydown", markExplicitKeyboardTransfer, true);
      window.removeEventListener("blur", markWindowTransfer);
      window.removeEventListener("focus", clearExplicitTransfer);
      window.removeEventListener(KEYBOARD_DISMISS_BLUR_EVENT, markExplicitTransfer);
      if (clearExplicitTransferTimer) clearTimeout(clearExplicitTransferTimer);
    };
  }, []);

  const handleComposerBlur = useCallback((event: React.FocusEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const snapshot = captureComposerFocus(element);
    const windowTransferVersion = composerWindowTransferVersionRef.current;
    reportComposerFocus(sessionId, "blur", element, composerComposingRef.current, event.relatedTarget);
    const relatedTarget = event.relatedTarget;
    const elementConstructor = element.ownerDocument.defaultView?.Element;
    const relatedElement = elementConstructor && relatedTarget instanceof elementConstructor
      ? relatedTarget as Element
      : null;
    const backgroundTarget = relatedElement === null
      || relatedElement === element.ownerDocument.body
      || relatedElement.closest(".detail-main") !== null;
    const explicit = composerExplicitFocusTransferRef.current;
    composerExplicitFocusTransferRef.current = false;
    if (explicit || composerComposingRef.current || !backgroundTarget) {
      pendingComposerFocusRestoreRef.current = null;
      return;
    }
    if (composerFocusRestoreFrameRef.current !== null) window.cancelAnimationFrame(composerFocusRestoreFrameRef.current);
    composerFocusRestoreFrameRef.current = window.requestAnimationFrame(() => {
      composerFocusRestoreFrameRef.current = null;
      if (composerWindowTransferVersionRef.current !== windowTransferVersion) return;
      if (!element.isConnected || !restoreComposerFocus(element, snapshot, true)) return;
      reportComposerFocus(sessionId, "restore", element, false);
    });
  }, [sessionId]);

  useEffect(() => {
    queueSteeringInFlightRef.current.clear();
    steeringResolutionInFlightRef.current.clear();
    composerInteractionVersionRef.current += 1;
    composerDraftVersionRef.current += 1;
    commandSubmissionRetryRef.current = null;
    setBusy(false);
    setRestartPending(false);
    setSteeringBusy(false);
    setQueueSteeringPending(new Set());
    setSteeringResolutionPending(new Map());
  }, [sessionId]);

  const focusComposerAtDraftEnd = useCallback(() => {
    const element = inputRef.current;
    if (!element) return;
    const moved = focusComposerAtEnd(element, composerComposingRef.current);
    if (moved && draftHydratedSessionRef.current !== sessionId) {
      pendingHydrationCaretRef.current = {
        sessionId,
        interactionVersion: composerInteractionVersionRef.current,
      };
    }
  }, [sessionId]);

  useLayoutEffect(() => {
    const pending = retitleFocusRestoreRef.current;
    retitleFocusRestoreRef.current = null;
    if (retitleFeedback !== null || pending === null) return;
    if (pending.sessionId !== sessionId || viewGenerationRef.current !== pending.generation) return;
    const input = inputRef.current;
    if (!input || input.ownerDocument.activeElement !== input.ownerDocument.body) return;
    if (restoreComposerFocus(input, pending.composer)) {
      reportComposerFocus(sessionId, "restore", input, false);
    }
  }, [retitleFeedback, sessionId]);

  useLayoutEffect(() => {
    if (mode !== "expanded" || focusComposerRequestedRef.current) return;
    const frame = window.requestAnimationFrame(() => scrollRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mode, sessionId]);

  useEffect(() => {
    if (!focusComposer) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposerAtDraftEnd();
      onComposerFocusConsumed?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusComposer, focusComposerAtDraftEnd, onComposerFocusConsumed, sessionId]);
  const sessionCaps = resolveCaps(runner, session);
  const effectiveModel = optimisticModel ?? session?.model;
  const selectedModelSupportsImages = modelSupportsImages(sessionCaps, effectiveModel);
  // Codex app-server forks predate the generic capability bit (rolling-upgrade compatibility).
  // Claude must explicitly prove --fork-session through discovery before the button appears.
  const supportsConversationFork = session
    ? providerSupportsConversationFork(session.driver, sessionCaps)
    : false;
  const allowedImageMimeTypes = selectedModelSupportsImages
    ? session?.driver === "codex-app-server"
      ? CODEX_APP_SERVER_IMAGE_MIME_TYPES
      : PROMPT_IMAGE_MIME_TYPES
    : NO_IMAGE_MIME_TYPES;
  const markDraftDirty = useCallback(() => {
    draftDirty.current = true;
    commandSubmissionRetryRef.current = null;
    composerInteractionVersionRef.current += 1;
    composerDraftVersionRef.current += 1;
    invalidateComposerMutationRecovery(mutationKey);
  }, [mutationKey]);
  const { images, onPaste, addFiles, addWorkspaceReference, remove, clear, replace } = usePastedImages(
    markDraftDirty,
    setError,
    allowedImageMimeTypes,
  );
  const actualImages = images.filter((attachment) => !isWorkspaceReference(attachment));
  const draftState = useRef<{ text: string; images: PromptImageInput[] }>({ text: "", images: [] });
  draftState.current = { text, images };
  const updateComposerSelection = useCallback((start: number, end = start) => {
    setComposerSelection((current) => current.start === start && current.end === end
      ? current
      : { start, end });
  }, []);
  const setProgrammaticComposerText = useCallback((
    next: string,
    caret = next.length,
    preservePendingFocusRestore = false,
  ) => {
    if (!preservePendingFocusRestore) pendingComposerFocusRestoreRef.current = null;
    draftState.current = { ...draftState.current, text: next };
    setText(next);
    updateComposerSelection(caret);
    setSlashDismissedFor(`${next}\u0000${caret}`);
  }, [updateComposerSelection]);
  const persistQueuedPromptEditRecovery = useCallback((recovery: QueuedPromptEditRecovery): boolean =>
    queuedEditRecoveryScope !== null &&
      saveDurableQueuedEditRecovery(queuedEditRecoveryScope, recovery),
  [queuedEditRecoveryScope]);
  const storeQueuedPromptEditRecovery = useCallback((
    key: string,
    recovery: QueuedPromptEditRecovery,
  ): boolean => {
    if (!queuedEditRecoveryScope) return false;
    storeRuntimeQueuedEditRecovery(key, queuedEditRecoveryScope.accountKey, recovery);
    return persistQueuedPromptEditRecovery(recovery);
  }, [persistQueuedPromptEditRecovery, queuedEditRecoveryScope]);
  const clearQueuedPromptEditRecovery = useCallback((key: string): void => {
    clearRuntimeQueuedEditRecovery(key);
    if (queuedEditRecoveryScope) clearDurableQueuedEditRecovery(queuedEditRecoveryScope);
  }, [queuedEditRecoveryScope]);
  const restoreQueuedPromptEditRecovery = useCallback((
    recovery: QueuedPromptEditRecovery,
    pending: boolean,
    preserveDraft = false,
  ) => {
    const restored = cloneQueuedPromptEditRecovery(recovery);
    queuedEditRef.current = restored.edit;
    setQueuedEdit(restored.edit);
    setQueuedEditRecovered(true);
    setQueuedEditBusy(pending);
    if (!preserveDraft) {
      draftState.current = restored.draft;
      setProgrammaticComposerText(restored.draft.text);
      replace(restored.draft.images);
      setHistIdx(-1);
    }
    setError(restored.error ?? null);
    commandSubmissionRetryRef.current = null;
    suppressedDraftRef.current = pending ? { sessionId } : null;
    draftHydratedSessionRef.current = sessionId;
    pendingHydrationCaretRef.current = null;
    pendingComposerFocusRestoreRef.current = null;
  }, [replace, sessionId, setProgrammaticComposerText]);
  // Hold-to-talk dictation (browser SpeechRecognition; hidden when unsupported).
  const dictation = useVoiceDictation((phrase) => {
    markDraftDirty();
    const next = appendTranscript(draftState.current.text, phrase);
    setProgrammaticComposerText(next);
  });
  const insertSideChatDraft = useCallback((response: string) => {
    markDraftDirty();
    const next = appendTranscript(draftState.current.text, response);
    setProgrammaticComposerText(next);
    window.requestAnimationFrame(focusComposerAtDraftEnd);
  }, [focusComposerAtDraftEnd, markDraftDirty, setProgrammaticComposerText]);
  // Shared git status: the composer branch chip + the right panel's Review mode read one
  // fetch. Called before the !session guard — hooks must run unconditionally.
  // Inbox previews render neither the composer Git chip, pinned summary, nor Review panel. Do not
  // turn keyboard preview navigation into runner Git/gh fanout for facts nobody can see.
  const gitConsumerSession = mode === "expanded" ? session : undefined;
  const summaryConsumerSession = mode === "expanded" && (richGitSupported || pinnedOpen)
    ? session
    : undefined;
  const git = useGitStatus(
    gitConsumerSession,
    runnerOnline,
    richGitSupported,
    recoveryGeneration,
  );
  const gitSummary = useGitSummary(
    summaryConsumerSession,
    runnerOnline,
    richGitSupported,
    git.mutationRevision,
    recoveryGeneration,
  );
  const gitPresentation = useMemo(() => deriveGitPresentation({
    runnerOnline,
    worktreePath: session.worktreePath,
    status: {
      value: git.status,
      observation: git.observation,
      settled: git.settled,
      busy: git.busy,
      error: git.error,
      errorCode: git.errorCode,
    },
    summary: {
      value: gitSummary.summary,
      observation: gitSummary.observation,
      settled: gitSummary.settled,
      busy: gitSummary.busy,
      error: gitSummary.error,
      errorCode: gitSummary.errorCode,
    },
  }), [git, gitSummary, runnerOnline, session.worktreePath]);
  const changeStatus = sessionChangeStatus({
    status: git.status,
    summary: gitSummary.summary,
    settled: git.settled || gitSummary.settled,
    available: sessionMayShowChangeStatus(session.status) &&
      (gitPresentation.state === "ready" || gitPresentation.state === "updating"),
  });

  useEffect(() => {
    const generation = ++viewGenerationRef.current;
    retitleInFlightRef.current = false;
    retitleFocusRestoreRef.current = null;
    retitleRetryPointerActivationRef.current = false;
    setRetitleFeedback(null);
    return () => {
      if (viewGenerationRef.current === generation) viewGenerationRef.current += 1;
    };
  }, [sessionId]);

  useEffect(() => {
    if (optimisticModel !== undefined && session?.model === optimisticModel) setOptimisticModel(undefined);
  }, [optimisticModel, session?.model]);

  // Drafts are per session and durable. Hydrate before writing so the initial empty React state
  // cannot erase a saved draft; if the user types while IndexedDB opens, their newer input wins.
  useEffect(() => {
    let cancelled = false;
    // Loader identity is an injection detail, not a hydration boundary. Capture the latest loader
    // for this session transition so inline test/app wrappers cannot restart hydration on every
    // render, while a deliberate loader replacement made with the next session is still observed.
    const loadDraftForSession = composerDraftLoaderRef.current;
    const hydrationKeyChanged = draftHydrationKeyRef.current !== mutationKey;
    if (hydrationKeyChanged) {
      draftHydrationKeyRef.current = mutationKey;
      draftDirty.current = false;
      composerComposingRef.current = false;
      draftHydratedSessionRef.current = null;
      suppressedDraftRef.current = null;
      pendingHydrationCaretRef.current = null;
      pendingHydrationCommitRef.current = null;
    }
    const pendingQueuedEdit = queuedPromptEditMutationRecovery(activeComposerMutation);
    const queuedEditAtHydrationStart = queuedEditRef.current;
    // A locally opened edit owns the composer. Identity can settle later and reveal a runtime or
    // durable recovery, but only the in-process mutation recovery is allowed to supersede it.
    if (!hydrationKeyChanged && queuedEditRef.current && !pendingQueuedEdit) {
      return () => {
        cancelled = true;
      };
    }
    const runtimeQueuedEdit = queuedEditRecoveryScope
      ? loadRuntimeQueuedEditRecovery(mutationKey, queuedEditRecoveryScope.accountKey)
      : undefined;
    const storedQueuedEdit = queuedEditRecoveryScope
      ? loadDurableQueuedEditRecovery(queuedEditRecoveryScope)
      : undefined;
    const durableQueuedEdit = storedQueuedEdit && !storedQueuedEdit.error
      ? { ...storedQueuedEdit, error: "The prior queued message edit outcome was not recorded. Check the current queue before retrying." }
      : storedQueuedEdit;
    let queuedEditRecovery = pendingQueuedEdit ?? runtimeQueuedEdit ?? durableQueuedEdit;
    if (queuedEditRecovery && !pendingQueuedEdit && draftDirty.current && queuedEditRef.current === null) {
      const displacedDraft = {
        text: draftState.current.text,
        images: draftState.current.images.map((image) => ({ ...image })),
      };
      queuedEditRecovery = {
        ...recoveryWithDisplacedDraft(queuedEditRecovery, displacedDraft),
      };
      // Identity can settle after the user has already begun a new ordinary draft. Keep that work
      // in both draft storage and the recovery's displaced-draft slot before showing the recovery.
      void saveComposerDraft(sessionId, displacedDraft.text, displacedDraft.images, instanceScope);
      if (queuedEditRecoveryScope) {
        saveDurableQueuedEditRecovery(queuedEditRecoveryScope, queuedEditRecovery);
        storeRuntimeQueuedEditRecovery(mutationKey, queuedEditRecoveryScope.accountKey, queuedEditRecovery);
      }
    }
    if (queuedEditRecovery) {
      const finishRecoveryRestore = (candidate: QueuedPromptEditRecovery) => {
        if (cancelled) return;
        if (queuedEditRef.current && !pendingQueuedEdit &&
            (!hydrationKeyChanged || queuedEditRef.current !== queuedEditAtHydrationStart)) return;
        let restored = candidate;
        if (draftDirty.current && queuedEditRef.current === null) {
          const displacedDraft = {
            text: draftState.current.text,
            images: draftState.current.images.map((image) => ({ ...image })),
          };
          restored = recoveryWithDisplacedDraft(restored, displacedDraft);
          void saveComposerDraft(sessionId, displacedDraft.text, displacedDraft.images, instanceScope);
          if (queuedEditRecoveryScope) saveDurableQueuedEditRecovery(queuedEditRecoveryScope, restored);
        }
        if (!runtimeQueuedEdit && queuedEditRecoveryScope) {
          storeRuntimeQueuedEditRecovery(mutationKey, queuedEditRecoveryScope.accountKey, restored);
        }
        restoreQueuedPromptEditRecovery(restored, pendingQueuedEdit !== undefined);
      };
      if (queuedEditRecovery.edit.displacedDraftStoredSeparately) {
        void (async () => {
          let displaced: ComposerDraft | null | undefined;
          try { displaced = await loadDraftForSession(sessionId, instanceScope); } catch { /* retain compact text */ }
          if (displaced === undefined) return;
          finishRecoveryRestore(recoveryWithDisplacedDraft(queuedEditRecovery, displaced));
        })();
      } else {
        finishRecoveryRestore(queuedEditRecovery);
      }
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      let draft = await loadDraftForSession(sessionId, instanceScope);
      if (cancelled) return;
      const currentMutation = composerMutationRegistry.get(mutationKey);
      // The request can settle while IndexedDB hydration is in flight. Re-read after release so a
      // stale pre-delete result cannot resurrect a successfully submitted reservation.
      if (shouldReloadReservedDraft(activeComposerMutation?.token, currentMutation?.token)) {
        draft = await loadDraftForSession(sessionId, instanceScope);
        if (cancelled) return;
      }
      const recoveryDraft = !composerMutationRegistry.has(mutationKey)
        ? composerMutationRecoveries.get(mutationKey)
        : undefined;
      if (!draft && recoveryDraft) {
        draft = { ...recoveryDraft, updatedAt: Date.now() };
        composerMutationRecoveries.delete(mutationKey);
        void saveComposerDraft(sessionId, recoveryDraft.text, recoveryDraft.images, instanceScope);
      } else if (draft && recoveryDraft) {
        composerMutationRecoveries.delete(mutationKey);
      }
      const reservedDraft = composerMutationRegistry.get(mutationKey)?.draft;
      const reserved = Boolean(reservedDraft && (
        !draft || (
          reservedDraft.revision
            ? draft.revision === reservedDraft.revision
            : composerDraftMatches(draft, reservedDraft.text, reservedDraft.images)
        )
      ));
      if (reserved) {
        suppressedDraftRef.current = { sessionId, revision: draft?.revision };
        draftHydratedSessionRef.current = sessionId;
        pendingHydrationCaretRef.current = null;
        pendingComposerFocusRestoreRef.current = null;
      } else if (draft && !draftDirty.current) {
        // Defer completion until a layout effect observes the controlled textarea's committed
        // value. Promise settlement and animation-frame ordering cannot prove that React has
        // written the hydrated text to the DOM yet.
        pendingHydrationCommitRef.current = { sessionId, expectedText: draft.text };
        setProgrammaticComposerText(draft.text, draft.text.length, true);
        replace(draft.images);
        commandSubmissionRetryRef.current = draft.commandSubmission ?? null;
        consumeComposerDraftHandoff(sessionId, draft, instanceScope);
        setHydrationCommitRevision((revision) => revision + 1);
      } else {
        draftHydratedSessionRef.current = sessionId;
        pendingHydrationCaretRef.current = null;
        pendingComposerFocusRestoreRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [instanceScope, mutationKey, queuedEditRecoveryScope, sessionId, replace, restoreQueuedPromptEditRecovery,
    setProgrammaticComposerText]);

  useLayoutEffect(() => {
    const commit = pendingHydrationCommitRef.current;
    if (!commit) return;
    if (commit.sessionId !== sessionId) {
      pendingHydrationCommitRef.current = null;
      return;
    }

    pendingHydrationCommitRef.current = null;
    draftHydratedSessionRef.current = sessionId;
    const pendingCaret = pendingHydrationCaretRef.current;
    pendingHydrationCaretRef.current = null;
    const current = inputRef.current;
    if (
      current
      && current.value === commit.expectedText
      && current.ownerDocument.activeElement === current
      && !draftDirty.current
      && !composerComposingRef.current
      && pendingCaret?.sessionId === sessionId
      && pendingCaret.interactionVersion === composerInteractionVersionRef.current
    ) {
      placeComposerCaretAtEnd(current);
    }
    // A remount lease is valid only through initial draft hydration. If the persisted value did
    // not match the remembered live value, do not let a later programmatic edit revive it.
    pendingComposerFocusRestoreRef.current = null;
  }, [hydrationCommitRevision, sessionId]);

  useEffect(() => {
    if (activeComposerMutation) return;
    // An ordinary locally initiated queued edit already owns the composer. Leave a recovery that
    // another tab publishes recoverable until this edit is saved or cancelled.
    if (queuedEditRef.current && !queuedEditRecovered) return;
    let queuedEditRecovery = (queuedEditRecoveryScope
      ? loadRuntimeQueuedEditRecovery(mutationKey, queuedEditRecoveryScope.accountKey)
      : undefined) ??
      (queuedEditRecoveryScope ? loadDurableQueuedEditRecovery(queuedEditRecoveryScope) : undefined);
    if (queuedEditRecovery) {
      suppressedDraftRef.current = null;
      const openQueuedEdit = queuedEditRef.current;
      const preserveQueuedEditDraft = draftDirty.current &&
        openQueuedEdit?.promptId === queuedEditRecovery.edit.promptId;
      if (preserveQueuedEditDraft) {
        storeQueuedPromptEditRecovery(mutationKey, {
          ...queuedEditRecovery,
          draft: draftState.current,
        });
      } else if (draftDirty.current && openQueuedEdit === null) {
        const displacedDraft = {
          text: draftState.current.text,
          images: draftState.current.images.map((image) => ({ ...image })),
        };
        queuedEditRecovery = {
          ...recoveryWithDisplacedDraft(queuedEditRecovery, displacedDraft),
        };
        void saveComposerDraft(sessionId, displacedDraft.text, displacedDraft.images, instanceScope);
        if (queuedEditRecoveryScope) {
          saveDurableQueuedEditRecovery(queuedEditRecoveryScope, queuedEditRecovery);
          storeRuntimeQueuedEditRecovery(mutationKey, queuedEditRecoveryScope.accountKey, queuedEditRecovery);
        }
      }
      if (queuedEditRecovery.edit.displacedDraftStoredSeparately) {
        let cancelled = false;
        const loadDraftForSession = composerDraftLoaderRef.current;
        void (async () => {
          let displaced: ComposerDraft | null | undefined;
          try { displaced = await loadDraftForSession(sessionId, instanceScope); } catch { /* retain compact text */ }
          if (displaced === undefined || cancelled || (queuedEditRef.current && !queuedEditRecovered)) return;
          const openQueuedEditAfterLoad = queuedEditRef.current;
          if (openQueuedEditAfterLoad && openQueuedEditAfterLoad.promptId !== queuedEditRecovery.edit.promptId) return;
          let preserveDraftAfterLoad = draftDirty.current && openQueuedEditAfterLoad?.promptId === queuedEditRecovery.edit.promptId;
          let restored = recoveryWithDisplacedDraft(queuedEditRecovery, displaced);
          if (preserveDraftAfterLoad) {
            restored = {
              ...restored,
              draft: {
                text: draftState.current.text,
                images: draftState.current.images.map((image) => ({ ...image })),
              },
            };
          } else if (draftDirty.current && openQueuedEditAfterLoad === null) {
            const currentDisplacedDraft = {
              text: draftState.current.text,
              images: draftState.current.images.map((image) => ({ ...image })),
            };
            restored = recoveryWithDisplacedDraft(queuedEditRecovery, currentDisplacedDraft);
            void saveComposerDraft(
              sessionId,
              currentDisplacedDraft.text,
              currentDisplacedDraft.images,
              instanceScope,
            );
            preserveDraftAfterLoad = false;
          }
          if (queuedEditRecoveryScope) {
            saveDurableQueuedEditRecovery(queuedEditRecoveryScope, restored);
            storeRuntimeQueuedEditRecovery(mutationKey, queuedEditRecoveryScope.accountKey, restored);
          }
          restoreQueuedPromptEditRecovery(restored, false, preserveDraftAfterLoad);
        })();
        return () => { cancelled = true; };
      }
      restoreQueuedPromptEditRecovery(queuedEditRecovery, false, preserveQueuedEditDraft);
      return;
    }
    if (suppressedDraftRef.current?.sessionId !== sessionId) return;
    const completedQueuedEdit = queuedEditRef.current !== null;
    if (completedQueuedEdit) {
      draftDirty.current = false;
      queuedEditRef.current = null;
      setQueuedEdit(null);
      setQueuedEditRecovered(false);
      setQueuedEditBusy(false);
      setError(null);
      draftState.current = { text: "", images: [] };
      setProgrammaticComposerText("", 0);
      replace([]);
      commandSubmissionRetryRef.current = null;
    }
    let cancelled = false;
    let completed = false;
    const suppressed = suppressedDraftRef.current;
    const interactionVersion = composerInteractionVersionRef.current;
    suppressedDraftRef.current = null;
    void loadComposerDraft(sessionId, instanceScope).then((draft) => {
      completed = true;
      const recoveryDraft = composerMutationRecoveries.get(mutationKey);
      if (cancelled) return;
      const editedAfterRestoreStarted = composerInteractionVersionRef.current !== interactionVersion;
      if (draftDirty.current && (!completedQueuedEdit || editedAfterRestoreStarted)) {
        composerMutationRecoveries.delete(mutationKey);
        return;
      }
      const restored = draft ?? (recoveryDraft ? { ...recoveryDraft, updatedAt: Date.now() } : null);
      composerMutationRecoveries.delete(mutationKey);
      if (!restored) {
        if (completedQueuedEdit) draftHydratedSessionRef.current = sessionId;
        return;
      }
      setProgrammaticComposerText(restored.text);
      replace(restored.images);
      commandSubmissionRetryRef.current = restored.commandSubmission ?? null;
      if (draft) consumeComposerDraftHandoff(sessionId, draft, instanceScope);
      else void saveComposerDraft(sessionId, restored.text, restored.images, instanceScope);
      draftHydratedSessionRef.current = sessionId;
    });
    return () => {
      cancelled = true;
      if (!completed && suppressedDraftRef.current === null) suppressedDraftRef.current = suppressed;
    };
  }, [activeComposerMutation, instanceScope, mutationKey, queuedEditRecovered, queuedEditRecoveryScope, sessionId, replace,
    restoreQueuedPromptEditRecovery, setProgrammaticComposerText, storeQueuedPromptEditRecovery]);

  // Coalesce rapid edits so typing beside a large base64 attachment does not rewrite it on every
  // keystroke. Dirty edits save even while hydration is pending; unmount cleanup below flushes
  // captured state when the user navigates away before the timer fires.
  useEffect(() => {
    if (!draftDirty.current) return;
    const timer = window.setTimeout(() => {
      if (queuedEditRef.current) {
        const recovery = queuedEditRecoveryScope
          ? loadRuntimeQueuedEditRecovery(mutationKey, queuedEditRecoveryScope.accountKey)
          : undefined;
        if (recovery) {
          storeQueuedPromptEditRecovery(mutationKey, {
            ...recovery,
            edit: queuedEditRef.current,
            draft: draftState.current,
          });
        } else {
          const pending = queuedPromptEditMutationRecovery(composerMutationRegistry.get(mutationKey));
          if (pending) {
            const updated = {
              ...pending,
              edit: queuedEditRef.current,
              draft: draftState.current,
            };
            updateQueuedPromptEditMutationRecovery(mutationKey, updated);
            persistQueuedPromptEditRecovery(updated);
          }
        }
        return;
      }
      const latest = draftState.current;
      const consumed = consumedDraftsRef.current.get(`${instanceScope}\u0000${sessionId}`);
      if (consumed && consumed.draftVersion === composerDraftVersionRef.current &&
          composerDraftMatches(latest, consumed.text, consumed.images)) {
        return;
      }
      void saveComposerDraft(sessionId, latest.text, latest.images, instanceScope);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [images, instanceScope, mutationKey, persistQueuedPromptEditRecovery, queuedEditRecoveryScope, sessionId,
    storeQueuedPromptEditRecovery, text]);

  useEffect(
    () => () => {
      if (!draftDirty.current) return;
      if (queuedEditRef.current) {
        const recovery = queuedEditRecoveryScope
          ? loadRuntimeQueuedEditRecovery(mutationKey, queuedEditRecoveryScope.accountKey)
          : undefined;
        if (recovery) {
          storeQueuedPromptEditRecovery(mutationKey, {
            ...recovery,
            edit: queuedEditRef.current,
            draft: draftState.current,
          });
        } else {
          const pending = queuedPromptEditMutationRecovery(composerMutationRegistry.get(mutationKey));
          if (pending) {
            const updated = {
              ...pending,
              edit: queuedEditRef.current,
              draft: draftState.current,
            };
            updateQueuedPromptEditMutationRecovery(mutationKey, updated);
            persistQueuedPromptEditRecovery(updated);
          }
        }
        return;
      }
      const latest = draftState.current;
      const consumed = consumedDraftsRef.current.get(`${instanceScope}\u0000${sessionId}`);
      if (consumed && consumed.draftVersion === composerDraftVersionRef.current &&
          composerDraftMatches(latest, consumed.text, consumed.images)) {
        return;
      }
      void saveComposerDraft(sessionId, latest.text, latest.images, instanceScope);
    },
    [instanceScope, mutationKey, persistQueuedPromptEditRecovery, queuedEditRecoveryScope, sessionId,
      storeQueuedPromptEditRecovery],
  );

  // Mark the session seen while it is open so the inbox unread badge stays current.
  useEffect(() => {
    if (mode !== "expanded") return;
    const ts = session?.lastEventAt ?? Date.now();
    saveSeen(markSeen(loadSeen(instanceScope), sessionId, ts), instanceScope);
  }, [instanceScope, mode, sessionId, session?.lastEventAt]);

  // Opening a session reads a bounded window at the TAIL: one request paints the newest activity
  // no matter how long the session is. Reopening after an outage instead backfills only the gap
  // since what we already have (loadEvents is stable, so this runs once per session, not on every
  // streamed event). Also re-runs when the socket comes back ONLINE: events broadcast during the
  // outage never arrived, and without this re-fetch the timeline silently misses them until the
  // user navigates away and back. The cursor is frozen when the requested subscription revision is
  // sent, so live events cannot move it past an outage gap.
  useEffect(() => {
    if (conn !== "online" || recoveryRevision == null) return;
    let cancelled = false;
    // Cursor by SEQ (the per-session runner-owned counter the endpoint filters on) — the DB row
    // id is a GLOBAL counter that races ahead of any one session's seqs, so using it as the
    // cursor silently skipped every gap event.
    // Frozen before the acknowledged subscription was sent; a post-ack live seq must not advance
    // recovery past older outage gaps.
    const after = recoveryAfter(sessionId);
    const epoch = recoveryEventEpoch;
    const generation = recoveryGeneration;
    const isCurrent = () => !cancelled;
    const forwardRecovery = () => recoverSessionHistory(
      { sessionId, after, eventEpoch: epoch, recoveryRevision },
      {
        fetchPage: api.getSessionEventPage,
        applyPage: (id, events, pageEpoch, revision, complete) =>
          loadEvents(id, events, pageEpoch, revision, complete, generation),
        isCurrent,
        retryOnIdleTimeout: true,
      },
    );
    // Nothing cached and no gap to close: this is an open, so read the window instead of walking
    // the log forward from its first event. Any other cursor means a reconnect gap the forward
    // chain owns. A control plane without backward reads answers `supported: false`, and the
    // forward chain runs exactly as before.
    //
    // A reader with a saved position is deliberately excluded: that position can sit below the
    // window, and restoring it depends on those rows arriving in this same load. Reading only the
    // tail would strand them away from where they stopped, so those loads keep the full chain until
    // the list can restore an anchor against a windowed history.
    //
    // "Nothing cached" is asked of completed HISTORY, not of the event array: a live event
    // delivered between the subscription acknowledgement and this effect would otherwise divert a
    // long session back to walking its log from seq 0. Live rows sit at the tail, so they merge
    // into the window they arrive beside.
    const openWindow = shouldReadOpeningWindow({
      recoveryAfter: after,
      historyEverCompleted: everCompletedRef.current,
      hasSavedReadingPosition: hasSavedFollowTailAnchor(instanceScope, sessionId),
    });
    beginEventHistoryLoad(sessionId, epoch, recoveryRevision, generation);
    const load = openWindow
      ? recoverSessionHistoryWindow(
        { sessionId, eventEpoch: epoch, recoveryRevision },
        {
          fetchTailPage: api.getSessionEventTailPage,
          applyWindow: (id, events, pageEpoch, revision, complete, hasOlder, turnAligned) =>
            loadEvents(id, events, pageEpoch, revision, complete, generation, hasOlder, turnAligned),
          isCurrent,
        },
      ).then((result) => (result.supported ? result.complete : forwardRecovery()))
      : forwardRecovery();
    void load.then((complete) => {
      if (!cancelled && !complete) {
        failEventHistoryLoad(sessionId, "Timeline recovery ended before the complete history was available.", epoch, recoveryRevision, generation);
      }
    }).catch(() => {
      if (!cancelled) {
        failEventHistoryLoad(sessionId, "Could not load complete session activity.", epoch, recoveryRevision, generation);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId, loadEvents, conn, recoveryRevision, recoveryAfter, recoveryEventEpoch, recoveryGeneration, historyRetry, beginEventHistoryLoad, failEventHistoryLoad]);

  // Older pages have one serialized fetch path. Opening recovery may use it briefly to complete an
  // underfilled first viewport; afterward only explicit controls and reader navigation call it.
  // `preserveAnchor` keeps an existing reading row fixed while a prepend re-measures.
  const loadOlder = useCallback((alignToTurn = false) => {
    const base = eventWindowBase(sessionId);
    if (base <= 1 || olderInFlightRef.current) return false;
    const epoch = recoveryEventEpoch;
    olderInFlightRef.current = true;
    // Every dispatch carries the base this page was requested below. A reopen re-reads the tail,
    // so a page that outlives its window must be dropped rather than prepended under a newer one.
    beginOlderEventsLoad(sessionId, base, epoch);
    void loadOlderSessionEvents(sessionId, base, epoch, api.getSessionEventTailPage, alignToTurn)
      .then((page) => {
        if (page) {
          loadOlderEvents(
            sessionId,
            page.events,
            page.hasOlder,
            base,
            page.eventEpoch,
            page.turnAligned,
          );
        }
        else failOlderEventsLoad(sessionId, "Earlier activity is unavailable from this control plane.", base, epoch);
      })
      .catch(() => failOlderEventsLoad(sessionId, "Could not load earlier activity.", base, epoch))
      .finally(() => {
        olderInFlightRef.current = false;
        setOlderRequestSettled((version) => version + 1);
      });
    return true;
  }, [api, sessionId, recoveryEventEpoch, eventWindowBase, beginOlderEventsLoad, loadOlderEvents, failOlderEventsLoad]);

  const cancelEarlierActivitySettle = useCallback(() => {
    const state = automaticEarlierLoadRef.current;
    if (state.settleFrame !== null) window.cancelAnimationFrame(state.settleFrame);
    state.settleFrame = null;
    state.settling = false;
  }, []);

  const clearEarlierActivityIntent = useCallback(() => {
    const state = automaticEarlierLoadRef.current;
    if (state.touchEndTimer !== null) window.clearTimeout(state.touchEndTimer);
    state.touchEndTimer = null;
    state.readerIntent = null;
    state.readerIntentTop = null;
    state.readerIntentMovedUp = false;
    state.touchActive = false;
    state.nativeTouchActive = false;
    state.touchInputY = null;
    state.touchTraversalStarted = false;
  }, []);

  const markEarlierActivityIntent = useCallback((
    intent: EarlierActivityIntent,
    touchInputY: number | null = null,
  ) => {
    const state = automaticEarlierLoadRef.current;
    if (state.touchEndTimer !== null) window.clearTimeout(state.touchEndTimer);
    state.touchEndTimer = null;
    state.readerIntent = intent;
    state.readerIntentTop = scrollRef.current?.scrollTop ?? null;
    state.readerIntentMovedUp = false;
    state.touchActive = intent === "touch-traversal";
    state.touchInputY = touchInputY;
    state.touchTraversalStarted = false;
    cancelEarlierActivitySettle();
  }, [cancelEarlierActivitySettle]);

  const markSingleEarlierActivityIntent = useCallback(() => {
    markEarlierActivityIntent("single-scroll");
  }, [markEarlierActivityIntent]);

  const markTouchEarlierActivityIntent = useCallback((clientY: number | null = null) => {
    markEarlierActivityIntent("touch-traversal", clientY);
  }, [markEarlierActivityIntent]);

  const markNativeTouchEarlierActivityIntent = useCallback((clientY: number | null) => {
    const state = automaticEarlierLoadRef.current;
    if (state.nativeTouchActive) return;
    markTouchEarlierActivityIntent(clientY);
    state.nativeTouchActive = true;
  }, [markTouchEarlierActivityIntent]);

  const markTouchEarlierActivityMovement = useCallback((clientY: number | null) => {
    const state = automaticEarlierLoadRef.current;
    if (state.readerIntent !== "touch-traversal" || clientY === null) return;
    if (state.touchInputY !== null && clientY > state.touchInputY + 1) {
      state.touchTraversalStarted = true;
    }
    state.touchInputY = clientY;
  }, []);

  const deferTouchEarlierActivityEnd = useCallback(() => {
    const state = automaticEarlierLoadRef.current;
    if (state.readerIntent !== "touch-traversal") return;
    if (state.touchEndTimer !== null) window.clearTimeout(state.touchEndTimer);
    state.touchEndTimer = window.setTimeout(() => {
      state.touchEndTimer = null;
      if (!state.touchActive && state.readerIntent === "touch-traversal") {
        clearEarlierActivityIntent();
      }
    }, EARLIER_ACTIVITY_TOUCH_IDLE_MS);
  }, [clearEarlierActivityIntent]);

  const finishTouchEarlierActivityIntent = useCallback(() => {
    const state = automaticEarlierLoadRef.current;
    if (state.readerIntent !== "touch-traversal") return;
    state.touchActive = false;
    deferTouchEarlierActivityEnd();
  }, [deferTouchEarlierActivityEnd]);

  const finishPointerTouchEarlierActivityIntent = useCallback(() => {
    if (automaticEarlierLoadRef.current.nativeTouchActive) return;
    finishTouchEarlierActivityIntent();
  }, [finishTouchEarlierActivityIntent]);

  const finishNativeTouchEarlierActivityIntent = useCallback((remainingTouches: number) => {
    if (remainingTouches > 0) return;
    automaticEarlierLoadRef.current.nativeTouchActive = false;
    finishTouchEarlierActivityIntent();
  }, [finishTouchEarlierActivityIntent]);

  const rearmEarlierActivityAfterMeasurements = useCallback(() => {
    cancelEarlierActivitySettle();
    const state = automaticEarlierLoadRef.current;
    state.settling = true;
    const settle = (frames: number) => {
      state.settleFrame = window.requestAnimationFrame(() => {
        if (state.historyKey !== timelineHistoryKey) {
          state.settleFrame = null;
          state.settling = false;
          return;
        }
        const scroll = scrollRef.current;
        if (scroll) {
          state.nextTriggerTop = Math.max(0, scroll.scrollTop - EARLIER_ACTIVITY_REARM_DISTANCE_PX);
        }
        if (frames > 1) settle(frames - 1);
        else {
          state.settleFrame = null;
          state.settling = false;
        }
      });
    };
    settle(EARLIER_ACTIVITY_REARM_FRAMES);
  }, [cancelEarlierActivitySettle, timelineHistoryKey]);

  useEffect(() => cancelEarlierActivitySettle, [cancelEarlierActivitySettle, timelineHistoryKey]);
  useEffect(() => clearEarlierActivityIntent, [clearEarlierActivityIntent, timelineHistoryKey]);

  const maybeLoadEarlier = useCallback((scroll: HTMLElement) => {
    const state = automaticEarlierLoadRef.current;
    if (state.historyKey !== timelineHistoryKey) {
      cancelEarlierActivitySettle();
      state.historyKey = timelineHistoryKey;
      state.requestedBase = null;
      state.nextTriggerTop = null;
      clearEarlierActivityIntent();
      state.readerStarted = false;
    }
    const readerIntent = state.readerIntent;
    if (eventWindow?.hasOlder !== true || eventWindow.loadingOlder || eventWindow.error ||
        eventWindow.baseSeq <= 1 || state.requestedBase !== null || state.settling ||
        !readerIntent) {
      clearEarlierActivityIntent();
      return;
    }

    const previousIntentTop = state.readerIntentTop;
    const movedUp = previousIntentTop !== null && scroll.scrollTop < previousIntentTop - 1;
    const movedDown = previousIntentTop !== null && scroll.scrollTop > previousIntentTop + 1;
    if (readerIntent === "touch-traversal" && movedUp &&
        (state.touchActive || state.touchTraversalStarted)) {
      state.touchTraversalStarted = true;
      state.readerIntentMovedUp = true;
    }

    // A transcript waits until the reader is genuinely near its head, rather than treating every
    // follow-tail scroll as a request for history. A zero-range viewport cannot produce real
    // reader scrolling, so it remains bounded until the explicit control starts paging.
    const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    // A zero-range scroll event can be a browser layout clamp, but cannot be produced by reader
    // navigation. Keep a bounded opening inert until the reader has started from scrollable
    // geometry (or used the explicit control).
    if (!state.readerStarted && maxScrollTop <= 1) {
      clearEarlierActivityIntent();
      return;
    }
    const initialTriggerTop = Math.min(EARLIER_ACTIVITY_TRIGGER_PX, maxScrollTop * 0.25);
    // Rearming proves fresh upward traversal; it never replaces the requirement to remain near
    // the newly loaded window head after an anchor-preserved prepend.
    const triggerTop = Math.min(
      state.nextTriggerTop ?? Number.POSITIVE_INFINITY,
      initialTriggerTop,
    );
    if (scroll.scrollTop > triggerTop) {
      // A wheel tick or reading-key scroll is a single scroll. Touch, however, emits a stream of
      // scroll events for one drag and its momentum. Keep that traversal armed while it continues
      // upward so the first event cannot consume intent before a later event reaches the head.
      if (readerIntent === "touch-traversal" && !movedDown) {
        state.readerIntentTop = scroll.scrollTop;
        if (state.touchEndTimer !== null) deferTouchEarlierActivityEnd();
      } else {
        clearEarlierActivityIntent();
      }
      return;
    }
    if (readerIntent === "touch-traversal" && (!state.readerIntentMovedUp || movedDown)) {
      if (movedDown) clearEarlierActivityIntent();
      return;
    }

    clearEarlierActivityIntent();
    state.readerStarted = true;
    state.nextTriggerTop = null;
    if (loadOlder()) state.requestedBase = eventWindow.baseSeq;
  }, [cancelEarlierActivitySettle, clearEarlierActivityIntent, deferTouchEarlierActivityEnd, eventWindow, loadOlder, timelineHistoryKey]);

  const loadEarlierFromControl = useCallback(() => {
    const state = automaticEarlierLoadRef.current;
    if (state.historyKey !== timelineHistoryKey) {
      cancelEarlierActivitySettle();
      state.historyKey = timelineHistoryKey;
      state.requestedBase = null;
      state.nextTriggerTop = null;
      clearEarlierActivityIntent();
      state.readerStarted = false;
    }
    const base = eventWindow?.baseSeq;
    if (base === undefined || !loadOlder()) return;
    clearEarlierActivityIntent();
    state.readerStarted = true;
    state.nextTriggerTop = null;
    state.requestedBase = base;
  }, [cancelEarlierActivitySettle, clearEarlierActivityIntent, eventWindow?.baseSeq, loadOlder, timelineHistoryKey]);

  // Once a prepend settles, require a fresh upward traversal before requesting another page. The
  // only exception is a reader-initiated window that still cannot scroll at all: keep filling that
  // viewport until navigation becomes possible or history is exhausted.
  useEffect(() => {
    const state = automaticEarlierLoadRef.current;
    if (state.historyKey !== timelineHistoryKey) {
      cancelEarlierActivitySettle();
      state.historyKey = timelineHistoryKey;
      state.requestedBase = null;
      state.nextTriggerTop = null;
      clearEarlierActivityIntent();
      state.readerStarted = false;
      return;
    }
    if (state.requestedBase === null || eventWindow?.loadingOlder ||
        eventWindow?.baseSeq === undefined || olderInFlightRef.current) return;

    const scroll = scrollRef.current;
    if (!scroll) return;
    const madeProgress = eventWindow.baseSeq < state.requestedBase;
    const hasUsableGeometry = scroll.clientHeight > 0 && scroll.scrollHeight > 0;
    const cannotScroll = hasUsableGeometry && scroll.scrollHeight <= scroll.clientHeight + 1;
    if (madeProgress && state.readerStarted && cannotScroll && eventWindow.hasOlder && !eventWindow.error) {
      if (loadOlder()) {
        state.requestedBase = eventWindow.baseSeq;
        return;
      }
    }
    // A failed or empty page still settles this exact request. Release the base gate so a manual
    // retry or later reader traversal can try again instead of wedging automatic pagination.
    state.nextTriggerTop = Math.max(0, scroll.scrollTop - EARLIER_ACTIVITY_REARM_DISTANCE_PX);
    state.requestedBase = null;
    if (!eventWindow.error) rearmEarlierActivityAfterMeasurements();
  }, [
    cancelEarlierActivitySettle,
    clearEarlierActivityIntent,
    eventWindow,
    loadOlder,
    olderRequestSettled,
    rearmEarlierActivityAfterMeasurements,
    timelineHistoryKey,
  ]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.addEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, markSingleEarlierActivityIntent);
    return () => scroll.removeEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, markSingleEarlierActivityIntent);
  }, [markSingleEarlierActivityIntent]);

  // Incremental derivation: streamed chunks push only the NEW events into a per-session
  // builder instead of re-folding the whole array (O(n²) over a long session).
  const items = useTimeline(sessionId, evs);
  const observedLastEventAt = Math.max(session.lastEventAt ?? 0, activity?.lastEventAt ?? 0) || undefined;
  const activeTurnProgressProjector = useRef<IncrementalActiveTurnProgress | null>(null);
  activeTurnProgressProjector.current ??= new IncrementalActiveTurnProgress();
  const activeTurnEvents = evs ?? [];
  const activeTurnProgress = activeTurnProgressProjector.current.project(activeTurnEvents, {
    scopeKey: `${session.id}:${session.eventEpoch ?? 0}`,
    status: session.status,
    activeTurnId: session.activeTurnId,
    pendingApproval: session.pendingApproval,
    observedLastActivityAt: observedLastEventAt,
    historyRebuilt: isRebuiltEventsArray(activeTurnEvents),
  }).progress;
  const openSubagent = useCallback((subagentId: string) => {
    rightPanelRef.current.showSubagent(session.id, session.eventEpoch ?? 0, subagentId);
  }, [session.eventEpoch, session.id]);
  const headerSubagentProjector = useRef<IncrementalSubagentProjector | null>(null);
  headerSubagentProjector.current ??= new IncrementalSubagentProjector();
  const activeSubagents = useMemo(() => headerSubagentProjector.current!.project(items, {
    sessionStatus: session.status,
    runnerOnline,
    availability: runnerOnline && isTimelineSessionActive(session.status) ? "live" : "recorded",
  }).descriptors.filter((descriptor) =>
    descriptor.availability === "live" &&
    ["starting", "running", "waiting"].includes(descriptor.lifecycle)),
  [items, runnerOnline, session.status]);
  const preferredActiveSubagentId = selectedSubagentId(activeSubagents);
  const visibleBackgroundWorkState = session.backgroundWorkState === "resumed"
    ? undefined
    : session.backgroundWorkState;
  const backgroundParentTurnEventIds = useMemo(() => new Map(items
    .filter((item): item is Extract<TimelineItem, { kind: "user_message" }> =>
      item.kind === "user_message" && Boolean(item.turnId))
    .map((item) => [item.turnId!, item.id] as const)), [items]);

  // Prior user prompts for ↑ history recall (chronological; recall walks from newest backward).
  const timelineUserPrompts = useMemo(
    () =>
      items
        .filter((i): i is Extract<TimelineItem, { kind: "user_message" }> => i.kind === "user_message")
        .map((i) => i.text)
        .filter(Boolean),
    [items],
  );
  const queuedPromptHistoryRef = useRef<{ sessionId: string; prompts: Map<string, string> }>({
    sessionId,
    prompts: new Map(),
  });
  if (queuedPromptHistoryRef.current.sessionId !== sessionId) {
    queuedPromptHistoryRef.current = { sessionId, prompts: new Map() };
  }
  for (const prompt of session.queued ?? []) {
    if (prompt.text) queuedPromptHistoryRef.current.prompts.set(prompt.id, prompt.text);
  }
  const promotedQueueBySubmission = new Map(
    (session.steeringAttempts ?? []).flatMap((attempt) =>
      attempt.source === "queued" && attempt.sourceQueueId
        ? [[attempt.submissionId, attempt.sourceQueueId] as const]
        : []
    ),
  );
  // Once a queued prompt is represented by its real runner event, remove only that exact queue id.
  // Text de-duplication would collapse legitimate repeated prompts.
  for (const item of items) {
    if (item.kind !== "user_message") continue;
    const promotedQueueId = item.deliveryIntent === "steer" && item.submissionId
      ? promotedQueueBySubmission.get(item.submissionId)
      : undefined;
    if (promotedQueueId) queuedPromptHistoryRef.current.prompts.delete(promotedQueueId);
    else if (item.turnId) queuedPromptHistoryRef.current.prompts.delete(item.turnId);
  }
  const userPrompts = useMemo(
    () => [...timelineUserPrompts, ...queuedPromptHistoryRef.current.prompts.values()],
    // Queue changes drive recomputation; the ref deliberately retains removed entries for recall.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelineUserPrompts, session.queued, session.steeringAttempts],
  );

  // Auto-grow the composer to its content. The probe is confined to the composer box so a draft
  // keystroke can never reflow — and scroll-clamp — the transcript above it (BUG-017).
  useLayoutEffect(() => {
    if (mode !== "expanded") return;
    const el = inputRef.current;
    if (!el) return;
    resizeComposerToContent(el);
  }, [mode, text]);

  // Once the runner echoes the real user_message (count rises past the send baseline), drop the
  // optimistic bubble so the just-sent message isn't rendered twice.
  useEffect(() => {
    if (pending && timelineUserPrompts.length > sendBaselineRef.current) setPending(null);
  }, [timelineUserPrompts.length, pending]);

  const canCancelQueued = runnerSupportsProtocol(runner?.protocolVersion, "queuedPromptCancellation");
  const deliveredPromptCommandIds = useMemo(() => new Set(items.flatMap((item) =>
    item.kind === "user_message" && item.commandId ? [item.commandId] : []
  )), [items]);
  const liveQueueIds = useMemo(() => new Set((session.queued ?? []).flatMap((prompt) =>
    prompt.liveQueueObserved ? [prompt.id] : []
  )), [session.queued]);
  const queuedPromptControls = queuedPromptsWithControls(session.queued);
  const resolvePendingPrompt = useCallback(async (
    commandId: string,
    action: "cancel" | "dismiss",
  ) => {
    if (pendingPromptAction) return;
    setPendingPromptAction(commandId);
    setError(null);
    try {
      await api.resolvePendingPrompt(session.id, commandId, action);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPendingPromptAction(undefined);
    }
  }, [api, pendingPromptAction, session.id]);
  const cancelLivePendingPrompt = useCallback(async (commandId: string) => {
    if (pendingPromptAction) return;
    setPendingPromptAction(commandId);
    setError(null);
    try {
      await api.cancelQueuedPrompt(session.id, commandId);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPendingPromptAction(undefined);
    }
  }, [api, pendingPromptAction, session.id]);
  const terminal = isTerminal(session.status);
  // A guardrail pause (cost budget / tool-call limit) must be resolved via the Continue/Stop card,
  // not bypassed by sending a prompt.
  const policyPaused = isPolicyApproval(session.pendingApproval);
  const canPrompt = runnerOnline && !terminal && !policyPaused;
  const pendingQuestion = session.pendingApproval?.kind === "question" ? session.pendingApproval : null;
  const composerQuestions = (() => {
    const approvalQuestions = pendingQuestion?.questions ?? [];
    if (approvalQuestions.length > 0 || !pendingQuestion) return approvalQuestions;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind === "question" && item.requestId === pendingQuestion.requestId && item.answered === undefined) {
        return item.questions;
      }
    }
    return approvalQuestions;
  })();
  const canAnswerPendingQuestion = pendingQuestion !== null && composerQuestions.length > 0 &&
    (pendingQuestion.recoveryReason !== "provider_restart" || pendingQuestion.recoveryAction === "resume_answer");
  const questionResponseStyle = useQuestionResponseStyle();
  const steeringAvailabilityInput = {
    runnerProtocolVersion: runner?.protocolVersion,
    runnerOnline,
    sessionStatus: session.status,
    activeTurnId: session.activeTurnId,
    supportsSteering: sessionCaps?.supportsSteering,
    policyPaused,
    inputPending: session.pendingApproval != null,
    queueHeld: session.queueHeld === true,
    stopPending: stopRequestPending,
  } as const;
  const directSteeringAvailability = conversationSteeringAvailability(steeringAvailabilityInput);
  const canStopTurn = canStopActiveTurn({
    runnerOnline,
    runnerProtocolVersion: runner?.protocolVersion,
    status: session.status,
    policyPaused,
    activeTurnId: session.activeTurnId,
  });
  const [activePane, setActivePane] = useState<"reader" | "composer">("reader");
  const [answerModeRequestId, setAnswerModeRequestId] = useState<string | null>(null);
  const answerModeArrivalRef = useRef({
    requestId: null as string | null,
    style: questionResponseStyle,
    answerable: false,
  });
  const answerModeFocusRequestRef = useRef<"answer" | "message" | null>(null);
  const answerFocusRequestIdRef = useRef<string | null>(pendingQuestion?.requestId ?? null);
  const composerAnswerActive = canAnswerPendingQuestion && answerModeRequestId === pendingQuestion.requestId;
  const answerFocusedBeforeRender = typeof document !== "undefined" && answerInputRef.current !== null &&
    answerInputRef.current.ownerDocument.activeElement === answerInputRef.current;

  const exitAnswerMode = useCallback(() => {
    answerModeFocusRequestRef.current = "message";
    setAnswerModeRequestId(null);
  }, []);
  const enterAnswerMode = useCallback(() => {
    if (!canAnswerPendingQuestion) {
      focusComposerAtDraftEnd();
      return;
    }
    setActivePane("composer");
    if (composerAnswerActive) {
      answerModeFocusRequestRef.current = null;
      answerInputRef.current?.focus();
      return;
    }
    answerModeFocusRequestRef.current = "answer";
    setAnswerModeRequestId(pendingQuestion.requestId);
  }, [canAnswerPendingQuestion, composerAnswerActive, focusComposerAtDraftEnd, pendingQuestion?.requestId]);

  useLayoutEffect(() => {
    const liveRequestId = pendingQuestion?.requestId ?? null;
    const requestChanged = answerFocusRequestIdRef.current !== liveRequestId;
    answerFocusRequestIdRef.current = liveRequestId;
    if (requestChanged && answerFocusedBeforeRender) {
      answerModeFocusRequestRef.current = null;
      focusComposerAtDraftEnd();
      return;
    }
    const requested = answerModeFocusRequestRef.current;
    if (composerAnswerActive && requested === "answer") {
      answerModeFocusRequestRef.current = null;
      answerInputRef.current?.focus();
    } else if (!composerAnswerActive && requested === "message") {
      answerModeFocusRequestRef.current = null;
      focusComposerAtDraftEnd();
    }
  }, [answerFocusedBeforeRender, composerAnswerActive, focusComposerAtDraftEnd, pendingQuestion?.requestId]);

  useEffect(() => {
    const previous = answerModeArrivalRef.current;
    const requestId = pendingQuestion?.requestId ?? null;
    const answerable = composerQuestions.length > 0;
    const requestChanged = previous.requestId !== requestId;
    const styleChanged = previous.style !== questionResponseStyle;
    const answerabilityChanged = previous.answerable !== answerable;
    const nextArrival = { requestId, style: questionResponseStyle, answerable };
    if (!requestId || questionResponseStyle !== "composer" || !answerable) {
      answerModeArrivalRef.current = nextArrival;
      if (!requestId || styleChanged || answerabilityChanged) setAnswerModeRequestId(null);
      return;
    }
    if (requestChanged || styleChanged || answerabilityChanged) {
      answerModeArrivalRef.current = nextArrival;
      let cancelled = false;
      let frame: number | null = null;
      let remainingHydrationFrames = 120;
      const chooseInitialMode = () => {
        if (cancelled) return;
        if (queuedEditRef.current) {
          setAnswerModeRequestId(null);
          return;
        }
        // The ordinary draft hydrates asynchronously. Deciding before that boundary would hide a
        // restored draft behind Answer Mode instead of showing the explicit waiting prompt.
        if (draftHydratedSessionRef.current !== sessionId) {
          remainingHydrationFrames -= 1;
          if (remainingHydrationFrames <= 0) {
            setAnswerModeRequestId(null);
            return;
          }
          frame = window.requestAnimationFrame(chooseInitialMode);
          return;
        }
        const hasOrdinaryDraft = Boolean(draftState.current.text.trim() || draftState.current.images.length || queuedEditRef.current);
        if (!hasOrdinaryDraft && inputRef.current?.ownerDocument.activeElement === inputRef.current) {
          // Auto-entry normally leaves focus alone. If it removes the currently focused ordinary
          // composer, transfer that existing focus into Answer Mode so bare reading shortcuts do
          // not become armed while the user keeps typing.
          answerModeFocusRequestRef.current = "answer";
        }
        setAnswerModeRequestId(hasOrdinaryDraft ? null : requestId);
      };
      chooseInitialMode();
      return () => {
        cancelled = true;
        if (frame !== null) window.cancelAnimationFrame(frame);
        // StrictMode simulates an unmount/remount without recreating refs. Restore the observation
        // only when this effect still owns it so the replacement effect can make the decision.
        if (answerModeArrivalRef.current === nextArrival) answerModeArrivalRef.current = previous;
      };
    }
    answerModeArrivalRef.current = nextArrival;
  }, [composerQuestions.length, pendingQuestion?.requestId, questionResponseStyle, sessionId]);

  const clearStopTurnAttempt = useCallback(() => {
    stopTurnAttemptRef.current += 1;
    stopTurnPendingRef.current = false;
    if (stopTurnRetryTimerRef.current) clearTimeout(stopTurnRetryTimerRef.current);
    stopTurnRetryTimerRef.current = null;
    const mutation = stopTurnMutationRef.current;
    if (mutation) releaseComposerMutation(mutationKey, mutation.token);
    stopTurnMutationRef.current = null;
    setStoppingTurn(false);
  }, [mutationKey]);

  useEffect(() => () => {
    stopTurnAttemptRef.current += 1;
    stopTurnPendingRef.current = false;
    if (stopTurnRetryTimerRef.current) clearTimeout(stopTurnRetryTimerRef.current);
    stopTurnRetryTimerRef.current = null;
    const mutation = stopTurnMutationRef.current;
    if (mutation) releaseComposerMutation(mutationKey, mutation.token);
    stopTurnMutationRef.current = null;
  }, [mutationKey]);

  useEffect(() => {
    if (canStopTurn) return;
    const inherited = composerMutationRegistry.get(mutationKey);
    if (inherited?.kind === "stop") releaseComposerMutation(mutationKey, inherited.token);
    clearStopTurnAttempt();
  }, [canStopTurn, clearStopTurnAttempt, mutationKey, sessionId]);

  const stopTurn = useCallback(async (): Promise<boolean> => {
    if (!canStopTurn) {
      setError("There is no active turn to stop.");
      return false;
    }
    if (stopTurnPendingRef.current) return false;
    const mutation = reserveComposerMutation(mutationKey, "stop");
    if (!mutation) {
      setError("A stop request is already in progress.");
      return false;
    }
    stopTurnMutationRef.current = mutation;
    stopTurnPendingRef.current = true;
    const attempt = ++stopTurnAttemptRef.current;
    const generation = viewGenerationRef.current;
    setStoppingTurn(true);
    setError(null);
    stopTurnRetryTimerRef.current = setTimeout(() => {
      if (stopTurnAttemptRef.current !== attempt) return;
      stopTurnRetryTimerRef.current = null;
      stopTurnPendingRef.current = false;
      releaseComposerMutation(mutationKey, mutation.token);
      stopTurnMutationRef.current = null;
      if (viewGenerationRef.current !== generation) return;
      setStoppingTurn(false);
      setError("The turn is still active. Try stopping it again or use Stop Session.");
    }, STOP_TURN_RETRY_MS);
    try {
      await api.cancelTurn(sessionId);
      if (stopTurnAttemptRef.current !== attempt) return false;
      return true;
    } catch (cause) {
      if (stopTurnAttemptRef.current !== attempt) return false;
      clearStopTurnAttempt();
      setError((cause as Error).message);
      return false;
    }
  }, [api, canStopTurn, clearStopTurnAttempt, mutationKey, sessionId]);

  useEffect(() => {
    if (mode !== "expanded" || !canStopTurn) return;
    const onStopTurnShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".xterm") || shortcutLayerActive(document)) return;
      if (!matchesShortcut(event, "stop-turn")) return;
      event.preventDefault();
      void stopTurn();
    };
    window.addEventListener("keydown", onStopTurnShortcut);
    return () => window.removeEventListener("keydown", onStopTurnShortcut);
  }, [canStopTurn, mode, stopTurn]);

  // Follow state belongs to the stable session surface, so compact/expanded mode changes preserve
  // the reader's position while a session change resets to live output.
  const followTail = useFollowTail({
    scrollRef,
    contentRevision: `${evs?.length ?? 0}:${items.length}:${pending?.text.length ?? 0}:${pending?.images.length ?? 0}:${session.status}`,
    sessionId,
    persistenceScope: instanceScope,
  });

  // A 200-event opening window is a transport budget, not a visual one: hundreds of streamed
  // chunks can collapse into a single short timeline row. While a freshly opened reader is still
  // following the tail, prepend only enough bounded pages to recover the leading turn and
  // put the earlier-history control safely above the first viewport. Reader interaction, hidden
  // geometry, errors, no progress, exhaustion, and the page cap all settle this automatic phase.
  useLayoutEffect(() => {
    const state = openingHistoryFillRef.current;
    const publishSettled = (settled: boolean) => {
      setOpeningHistoryFill((current) =>
        current.historyKey === timelineHistoryKey && current.settled === settled
          ? current
          : { historyKey: timelineHistoryKey, settled });
    };
    const settle = (recheckOnExpansion = false) => {
      state.settled = true;
      state.requestedBase = null;
      state.recheckOnExpansion = recheckOnExpansion;
      publishSettled(true);
    };

    if (state.historyKey !== timelineHistoryKey) {
      if (state.measureFrame !== null) window.cancelAnimationFrame(state.measureFrame);
      state.historyKey = timelineHistoryKey;
      state.requestedBase = null;
      state.pagesRequested = 0;
      state.settled = false;
      state.recheckOnExpansion = false;
      state.mode = mode;
      state.measureFrame = null;
      publishSettled(false);
    }
    if (state.mode !== mode) {
      const recheck = state.mode === "preview" && mode === "expanded" &&
        state.recheckOnExpansion;
      state.mode = mode;
      state.recheckOnExpansion = false;
      if (recheck) {
        state.settled = false;
        publishSettled(false);
      }
    }
    if (state.settled) return;
    publishSettled(false);
    if (followTail.state !== "following" || automaticEarlierLoadRef.current.readerStarted) {
      settle();
      return;
    }
    if (!eventWindow) return;
    if (!eventWindow.hasOlder || eventWindow.error || eventWindow.baseSeq <= 1) {
      settle();
      return;
    }
    if (eventWindow.loadingOlder || olderInFlightRef.current) return;
    if (state.requestedBase !== null) {
      if (eventWindow.baseSeq >= state.requestedBase) {
        settle();
        return;
      }
      state.requestedBase = null;
    }

    state.measureFrame = window.requestAnimationFrame(() => {
      state.measureFrame = null;
      if (state.historyKey !== timelineHistoryKey || state.settled) return;
      const scroll = scrollRef.current;
      if (!scroll || scroll.clientHeight <= 0 || scroll.scrollHeight <= 0) {
        settle();
        return;
      }
      const leadingTurnIncomplete = eventWindow.turnAligned === false;
      const viewportUnderfilled = scroll.scrollHeight <=
        scroll.clientHeight + OPENING_HISTORY_HEADROOM_PX;
      if (!leadingTurnIncomplete && !viewportUnderfilled) {
        settle(mode === "preview");
        return;
      }
      if (state.pagesRequested >= OPENING_HISTORY_MAX_PAGES) {
        settle();
        return;
      }
      const requestedBase = eventWindow.baseSeq;
      if (!loadOlder(true)) {
        settle();
        return;
      }
      state.requestedBase = requestedBase;
      state.pagesRequested += 1;
    });

    return () => {
      if (state.measureFrame !== null) window.cancelAnimationFrame(state.measureFrame);
      state.measureFrame = null;
    };
  }, [
    eventWindow,
    followTail.state,
    loadOlder,
    mode,
    olderRequestSettled,
    timelineHistoryKey,
  ]);

  const openingHistoryFillSettled = (
    openingHistoryFill.historyKey === timelineHistoryKey && openingHistoryFill.settled
  );

  useEffect(() => {
    timelineRevealRequestRef.current = null;
    timelineRevealRestoreState.current = null;
    setTimelineRevealRequest(null);
    timelineRevealRequestId.current = 0;
  }, [timelineHistoryKey]);
  const revealCurrentOperation = useCallback((eventId: number) => {
    // Semantic navigation owns the viewport until the reader explicitly resumes following.
    const requestId = ++timelineRevealRequestId.current;
    timelineRevealRestoreState.current = { requestId, state: followTail.state };
    followTail.preview();
    const request: TimelineRevealRequest = {
      eventId,
      requestId,
      historyKey: timelineHistoryKey,
      align: "center",
      focus: true,
    };
    timelineRevealRequestRef.current = request;
    setTimelineRevealRequest(request);
  }, [followTail.preview, followTail.state, timelineHistoryKey]);
  const handleTimelineReveal = useCallback((
    requestId: number,
    outcome: "revealed" | "unresolved" | "cancelled",
  ) => {
    if (timelineRevealRequestRef.current?.requestId !== requestId) return;
    timelineRevealRequestRef.current = null;
    setTimelineRevealRequest(null);
    const restore = timelineRevealRestoreState.current;
    timelineRevealRestoreState.current = null;
    if (outcome !== "unresolved" || restore?.requestId !== requestId) return;
    if (restore.state === "following") followTail.follow();
    else if (restore.state === "paused") followTail.pause();
    else followTail.preview();
  }, [followTail.follow, followTail.pause, followTail.preview]);
  const revealBackgroundParentTurn = useCallback((eventId: number) => {
    if (isMobile) rightPanelRef.current.close();
    revealCurrentOperation(eventId);
  }, [isMobile, revealCurrentOperation]);
  const previewNavigationControls = useMemo<PreviewNavigationControls>(() => ({
    beginProgrammaticScroll: followTail.beginProgrammaticScroll,
    follow: followTail.follow,
  }), [followTail.beginProgrammaticScroll, followTail.follow]);
  usePreviewNavigationRegistration(mode, onPreviewNavigationReady, previewNavigationControls);
  const readingActions = useMemo<SessionReadingKeyActions>(() => ({
    nextSession: () => onNextSession?.(),
    previousSession: () => onPreviousSession?.(),
    approve: () => onApprove?.(),
    deny: () => onDeny?.(),
    archive: () => onArchive?.(),
    snooze: () => onSnooze?.(),
    reply: canAnswerPendingQuestion ? enterAnswerMode : focusComposerAtDraftEnd,
    pauseFollow: followTail.pause,
    resumeFollow: followTail.follow,
  }), [canAnswerPendingQuestion, enterAnswerMode, focusComposerAtDraftEnd, followTail.follow, followTail.pause, onApprove, onArchive, onDeny, onNextSession, onPreviousSession, onSnooze]);
  useSessionReadingKeys({
    enabled: mode === "expanded" && !isMobile,
    sessionId,
    scrollRef,
    composerAvailable: canPrompt,
    actions: readingActions,
  });
  const followLabel = followTailSurfaceLabel(followTail.state, mode, isMobile);
  // Rewind FILES to a per-turn checkpoint (T3-style). Stable identity (useCallback) — it rides
  // into the memoized timeline rows. The confirm copy is explicit that the conversation is not
  // rewound: the agent may still reference later changes in its context.
  const onRewind = useCallback(
    async (turn: number) => {
      if (!await confirm({
        title: `Restore files before turn ${turn}?`,
        message: "Files revert to the checkpoint, but the conversation does not. The agent keeps its memory of later turns.",
        confirmLabel: "Restore Files",
        tone: "danger",
      })) return;
      await api.rewind(sessionId, turn).catch((e) => setError((e as Error).message));
    },
    [api, confirm, sessionId],
  );

  const onFork = useCallback(
    async (turn: number) => {
      if (busy || forkInFlightRef.current) return;
      const provider = session?.driver === "claude-code" ? "Claude session" : "Codex thread";
      const providerNote = session?.driver === "claude-code"
        ? " Claude Code can fork only the latest completed conversation turn."
        : "";
      if (!await confirm({
        title: `Fork after turn ${turn}?`,
        message: `A new ${provider} and isolated worktree will be created; this session stays unchanged.${providerNote}`,
        confirmLabel: "Create Fork",
      })) return;
      const releaseFork = acquireSessionFork(sessionId);
      if (!releaseFork) {
        const message = "A conversation fork is already in progress for this session. Wait for it to appear on the Board.";
        setError(message);
        if (mode === "preview") showToast(message, { tone: "error" });
        return;
      }
      const generation = viewGenerationRef.current;
      forkInFlightRef.current = true;
      setBusy(true);
      void (async () => {
        let releaseOnFinish = true;
        try {
          const forked = await api.fork(sessionId, turn);
          if (viewGenerationRef.current === generation) navigate({ name: "session", id: forked.id });
        } catch (cause) {
          const ambiguous = ambiguousForkError(cause);
          if (ambiguous) releaseOnFinish = false;
          if (viewGenerationRef.current === generation) {
            const message = (ambiguous ?? cause as Error).message;
            setError(message);
            if (mode === "preview") showToast(message, { tone: "error" });
          }
        } finally {
          if (releaseOnFinish) releaseFork();
          forkInFlightRef.current = false;
          setBusy(false);
        }
      })();
    },
    [api, busy, confirm, mode, navigate, session?.driver, sessionId, showToast],
  );

  const queuedEditReconciliation = queuedEdit && queuedEditRecovered
    ? reconcileQueuedEditRecovery(
        queuedEdit.promptId,
        queuedEdit.editRevision,
        session.queued,
        conn === "online" && snapshotLoaded && runnerOnline,
      )
    : null;
  const queuedEditRetryable = queuedEditReconciliation === null ||
    queuedEditReconciliation.status === "retryable";
  const canSend = canPrompt && (text.trim().length > 0 || images.length > 0);
  const restartFromComposer = useCallback(async () => {
    if (session.status !== "stopped" || session.stopOperation?.status === "stop_failed" ||
      !runnerOnline || busy || restartPending) return;
    const generation = viewGenerationRef.current;
    setError(null);
    setBusy(true);
    setRestartPending(true);
    try {
      loadSession(await api.restart(session.id));
    } catch (cause) {
      if (viewGenerationRef.current === generation) setError((cause as Error).message);
    } finally {
      if (viewGenerationRef.current === generation) {
        setRestartPending(false);
        setBusy(false);
      }
    }
  }, [api, busy, loadSession, restartPending, runnerOnline, session.id, session.status,
    session.stopOperation?.status]);
  const primaryComposerAction = composerPrimaryAction({
    canStopTurn,
    hasContent: text.length > 0 || images.length > 0,
    stopping: stopRequestPending,
  });
  const conversationCheckpointTurns = useMemo(
    () => items.flatMap((item) => item.kind === "conversation_checkpoint" ? [item.turn] : []),
    [items],
  );
  const completedConversationTurns = useMemo(
    () => new Set(conversationCheckpointTurns),
    [conversationCheckpointTurns],
  );
  const latestConversationForkTurn = conversationCheckpointTurns.length > 0
    ? Math.max(...conversationCheckpointTurns)
    : undefined;
  const latestKnownTurn = useMemo(() => items.reduce(
    (latest, item) => item.kind === "checkpoint" || item.kind === "conversation_checkpoint"
      ? Math.max(latest, item.turn)
      : latest,
    0,
  ) || undefined, [items]);
  const forkContext = useMemo(() => ({
    driver: session.driver,
    providerSupported: supportsConversationFork,
    hasWorktree: session.worktreePath != null,
    runnerOnline,
    runnerProtocolVersion: runner?.protocolVersion,
    status: session.status,
    queuedPrompts: session.queued?.length ?? 0,
    busy,
    forkInProgress,
  }), [
    busy,
    forkInProgress,
    runner?.protocolVersion,
    runnerOnline,
    session.driver,
    session.queued?.length,
    session.status,
    session.worktreePath,
    supportsConversationFork,
  ]);
  const forkAvailabilityByTurn = useMemo(() => new Map(conversationCheckpointTurns.map((turn) => [
    turn,
    conversationForkAvailability(turn, latestKnownTurn, forkContext),
  ])), [conversationCheckpointTurns, forkContext, latestKnownTurn]);
  const latestForkAvailability = useMemo(
    () => conversationForkAvailability(latestConversationForkTurn, latestKnownTurn, forkContext),
    [forkContext, latestConversationForkTurn, latestKnownTurn],
  );
  const previewForkControls = useMemo<PreviewForkControls>(() => ({
    availability: latestForkAvailability,
    fork: () => {
      if (latestForkAvailability.available) void onFork(latestForkAvailability.forkTurn);
    },
  }), [latestForkAvailability, onFork]);
  useLayoutEffect(() => {
    if (mode !== "preview" || !onPreviewForkReady) return;
    onPreviewForkReady(previewForkControls);
    return () => onPreviewForkReady(null);
  }, [mode, onPreviewForkReady, previewForkControls]);
  const editInForkTargets = useMemo(() => {
    const targets = new Map<number, number>();
    for (const item of items) {
      if (item.kind !== "user_message") continue;
      const availability = editInForkAvailability(item.turn, completedConversationTurns, {
        driver: session.driver,
        hasWorktree: session.worktreePath != null,
        runnerOnline,
        runnerProtocolVersion: runner?.protocolVersion,
        status: session.status,
        queuedPrompts: session.queued?.length ?? 0,
        busy,
      });
      if (availability.available) targets.set(item.id, availability.forkTurn);
    }
    return targets;
  }, [api, busy, completedConversationTurns, items, runner?.protocolVersion, runnerOnline, session.driver, session.queued?.length, session.status, session.worktreePath]);

  const openMessageAction = useCallback((next: MessageActionState) => {
    messageActionReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMessageAction(next);
  }, []);
  const openResendAction = useCallback(
    (item: Extract<TimelineItem, { kind: "user_message" }>) => openMessageAction({ mode: "resend", item }),
    [openMessageAction],
  );
  const openForkEditAction = useCallback(
    (item: Extract<TimelineItem, { kind: "user_message" }>, forkTurn: number) =>
      openMessageAction({ mode: "fork", item, forkTurn }),
    [openMessageAction],
  );

  const closeMessageAction = useCallback((restoreFocus = true) => {
    setMessageAction(null);
    if (restoreFocus) window.setTimeout(() => messageActionReturnFocusRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (mode === "expanded") return;
    setMessageAction(null);
    messageActionReturnFocusRef.current = null;
  }, [mode]);

  const prepareResend = useCallback((draft: { text: string; images: PromptImageInput[] }) => {
    if (!canPrompt) throw new Error("This session cannot accept a new turn right now.");
    draftDirty.current = true;
    composerDraftVersionRef.current += 1;
    draftState.current = draft;
    setProgrammaticComposerText(draft.text);
    replace(draft.images);
    setHistIdx(-1);
    setError(null);
    messageActionReturnFocusRef.current = inputRef.current;
    closeMessageAction(false);
  }, [canPrompt, closeMessageAction, replace, setProgrammaticComposerText]);

  const prepareFork = useCallback(async (
    forkTurn: number,
    draft: { text: string; images: PromptImageInput[] },
  ) => {
    if (forkInFlightRef.current) return;
    const releaseFork = acquireSessionFork(sessionId);
    if (!releaseFork) throw new Error("A conversation fork is already in progress for this session.");
    const generation = viewGenerationRef.current;
    forkInFlightRef.current = true;
    setBusy(true);
    let releaseOnFinish = true;
    try {
      const forked = await api.fork(sessionId, forkTurn);
      stageComposerDraftHandoff(forked.id, draft.text, draft.images, instanceScope);
      await saveComposerDraft(forked.id, draft.text, draft.images, instanceScope);
      if (viewGenerationRef.current === generation) {
        closeMessageAction(false);
        navigate({ name: "session", id: forked.id });
      }
    } catch (cause) {
      const ambiguous = ambiguousForkError(cause);
      if (ambiguous) releaseOnFinish = false;
      if (viewGenerationRef.current === generation) setError((ambiguous ?? cause as Error).message);
      throw ambiguous ?? cause;
    } finally {
      if (releaseOnFinish) releaseFork();
      forkInFlightRef.current = false;
      setBusy(false);
    }
  }, [api, closeMessageAction, instanceScope, navigate, sessionId]);

  // Friendly machine label (hostname + local/SSH) instead of the raw random box runner id.
  const runnerDisp = runnerDisplay(runner, box, session.runnerId);

  // "Agent is working" state (items 1 + 2): true the instant a send is optimistically pending
  // (before status flips) and for the whole turn while the runner reports running/starting.
  const showOptimistic = pending != null && timelineUserPrompts.length <= sendBaselineRef.current;
  // A request id owns an immutable question schema. Keep the timeline context stable across
  // heartbeat, usage, and lifecycle snapshots that replace the surrounding SessionView.
  const timelinePendingQuestion = useMemo(() => pendingQuestion ? {
    requestId: pendingQuestion.requestId,
    questions: pendingQuestion.questions ?? [],
    recoveryReason: pendingQuestion.recoveryReason,
    recoveryAction: pendingQuestion.recoveryAction,
  } : null, [session.id, pendingQuestion?.requestId, pendingQuestion?.recoveryReason, pendingQuestion?.recoveryAction]);
  const [inlineQuestionRequestId, setInlineQuestionRequestId] = useState<string | null>(null);
  const handlePendingQuestionAvailabilityChange = useCallback((requestId: string, available: boolean) => {
    setInlineQuestionRequestId((current) => available
      ? current === requestId ? current : requestId
      : current === requestId ? null : current);
  }, []);
  const matchingQuestionLoaded = pendingQuestion !== null && items.some((item) =>
    item.kind === "question" && item.requestId === pendingQuestion.requestId && item.answered === undefined);
  const questionInTimeline = matchingQuestionLoaded && inlineQuestionRequestId === pendingQuestion?.requestId;
  const timelineQuestionContext = useMemo(() => ({
    sessionId: session.id,
    pendingQuestion: timelinePendingQuestion,
    questionInTimeline,
    onPendingQuestionAvailabilityChange: handlePendingQuestionAvailabilityChange,
    runnerOnline,
    onSessionUpdate: loadSession,
    showKeyHints: !isMobile,
  }), [handlePendingQuestionAvailabilityChange, isMobile, loadSession, questionInTimeline, runnerOnline,
    session.id, timelinePendingQuestion]);
  const working =
    showOptimistic || (!terminal && (session.status === "running" || session.status === "starting"));
  // The merged Working row must also survive approval/question waits: the projector keeps
  // reporting the active turn (with its waiting reason, elapsed time, and counts) through
  // input_required, which the running/starting flag alone would hide (regression coverage).
  const activeTurnVisible = working || activeTurnProgress !== null;
  // Name the current step when it's an in-flight tool call; otherwise a plain "Working…".
  const lastItem = items[items.length - 1];
  const workingLabel =
    lastItem && lastItem.kind === "tool_call" && lastItem.status !== "completed" ? lastItem.title : undefined;
  const transcript = transcriptPresentation({
    itemCount: items.length,
    hasOptimistic: showOptimistic,
    working: activeTurnVisible,
    history: eventHistory,
    conn,
  });

  // The web registry owns app/provider identity, availability, collisions, and menu ranking. The
  // provider wire shape stays unchanged until IDEA-004C adds transport-specific execution modes.
  const agentCaps = resolveCaps(runner, session);
  // Plan mode is only safe where the driver actually advertises the `plan` approval mode (Claude).
  // Codex silently falls back to a writable sandbox for an unknown mode, so exposing it there would
  // let "plan" edit files despite the "no edits" copy — only offer it when the driver supports it.
  const planSupported = (agentCaps?.permissionModes ?? []).includes("plan");
  const composerCommands = useMemo(() => buildComposerCommandRegistry({
    context: { planSupported, canStopTurn, canRespond: canAnswerPendingQuestion },
    providerCommands: mapProviderComposerCommands(
      agentCaps?.slashCommands ?? [],
      providerCommandAttachmentPolicy,
    ),
  }), [agentCaps?.slashCommands, canAnswerPendingQuestion, canStopTurn, planSupported, providerCommandAttachmentPolicy]);
  const slashTrigger = useMemo(
    () => composerSelection.start === composerSelection.end
      ? findComposerCommandTrigger(text, composerSelection.start)
      : null,
    [composerSelection.end, composerSelection.start, text],
  );
  const workspaceReferencesSupported = runnerSupportsProtocol(runner?.protocolVersion, "workspaceReferences");
  const workspaceTrigger = useMemo(
    () => workspaceReferencesSupported && composerSelection.start === composerSelection.end
      ? findWorkspaceReferenceTrigger(text, composerSelection.start)
      : null,
    [composerSelection.end, composerSelection.start, text, workspaceReferencesSupported],
  );
  const workspaceDismissKey = workspaceTrigger ? `${text}\u0000${composerSelection.start}` : null;
  const workspacePickerOpen = canPrompt && workspaceTrigger !== null && workspaceDismissedFor !== workspaceDismissKey;
  useEffect(() => {
    if (!workspacePickerOpen || !workspaceTrigger?.query) {
      setWorkspaceResults([]);
      setWorkspaceSearchBusy(false);
      setWorkspaceSearchError(null);
      setWorkspaceSearchTruncated(false);
      setActiveWorkspaceResult(0);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      setWorkspaceSearchBusy(true);
      setWorkspaceSearchError(null);
      void api.searchWorkspaceReferences(sessionId, workspaceTrigger.query).then((result) => {
        if (!current) return;
        setWorkspaceResults(result.results);
        setWorkspaceSearchTruncated(result.truncated);
        setActiveWorkspaceResult(0);
      }).catch((cause: unknown) => {
        if (!current) return;
        setWorkspaceResults([]);
        setWorkspaceSearchError((cause as Error).message);
      }).finally(() => {
        if (current) setWorkspaceSearchBusy(false);
      });
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [api, sessionId, workspacePickerOpen, workspaceTrigger?.query]);

  const attachWorkspaceTarget = useCallback(async (target: CreateWorkspaceReferenceRequest) => {
    if (!workspaceReferencesSupported) {
      setError(runnerCapabilityRequirement(runner?.protocolVersion, "workspaceReferences", "Workspace references"));
      return;
    }
    try {
      const { reference } = await api.createWorkspaceReference(sessionId, target);
      const outcome = addWorkspaceReference(reference);
      if (outcome !== "limit") setError(null);
      if (outcome === "added") showToast(`Attached ${reference.path}.`);
      if (outcome === "duplicate") showToast(`${reference.path} is already attached.`);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [addWorkspaceReference, api, runner?.protocolVersion, sessionId, showToast, workspaceReferencesSupported]);

  const selectWorkspaceCandidate = (candidate: WorkspaceReferenceCandidate) => {
    if (!workspaceTrigger) return;
    const nextText = text.slice(0, workspaceTrigger.start) + text.slice(composerSelection.start);
    markDraftDirty();
    setProgrammaticComposerText(nextText, workspaceTrigger.start);
    setWorkspaceDismissedFor(null);
    void attachWorkspaceTarget({
      path: candidate.path,
      kind: candidate.isDirectory ? "directory" : "file",
    });
  };
  const slashMatches = useMemo(() => {
    if (!slashTrigger) return [];
    const ranked = rankComposerCommands(composerCommands, slashTrigger.query).map((match) => match.command);
    return slashTrigger.query ? ranked : ranked.filter((command) => command.available);
  }, [composerCommands, slashTrigger]);
  const slashDismissKey = slashTrigger ? `${text}\u0000${composerSelection.start}` : null;
  const paletteOpen = !workspacePickerOpen && canPrompt && slashMatches.length > 0 && slashDismissedFor !== slashDismissKey;
  const selectedSlashCommandId = retainActiveComposerCommandId(activeSlashCommandId, slashMatches);
  const selectedSlashCommand = slashMatches.find((command) => command.id === selectedSlashCommandId);
  const selectedSlashCommandIndex = selectedSlashCommand
    ? slashMatches.findIndex((command) => command.id === selectedSlashCommand.id)
    : -1;
  const composerCommandResolution = resolveComposerCommandInvocation(text, composerCommands);
  const commandPreservesAttachedImages = composerCommandResolution.kind === "command" &&
    durableCommandPreservesAttachments(composerCommandResolution.command, images.length > 0);
  useEffect(() => {
    setActiveSlashCommandId((current) => retainActiveComposerCommandId(current, slashMatches));
  }, [slashMatches]);
  const setComposerCaret = (caret: number) => {
    setComposerSelection({ start: caret, end: caret });
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(caret, caret);
    });
  };
  const insertSlashCommand = (command: ComposerCommand) => {
    if (!slashTrigger || !command.available) return;
    const replacement = replaceComposerCommandTrigger(text, slashTrigger, command);
    draftDirty.current = true;
    composerDraftVersionRef.current += 1;
    pendingComposerFocusRestoreRef.current = null;
    draftState.current = { text: replacement.text, images };
    setText(replacement.text);
    setComposerCaret(replacement.caret);
    setActiveSlashCommandId(command.id);
    setSlashDismissedFor(null);
  };

  // Pending composer config: remember what the user selected so a change made just before Send is
  // included atomically in the prompt (not lost to an in-flight setConfig round trip).
  const pendingConfig = useRef<SessionConfig>({});
  const applyConfig = useCallback(
    (patch: Partial<SessionConfig>) => {
      pendingConfig.current = { ...pendingConfig.current, ...patch };
      if (patch.model !== undefined) setOptimisticModel(patch.model || undefined);
      void api.setConfig(sessionId, patch); // optimistic between-turns apply (updates the UI + snapshot)
    },
    [api, sessionId],
  );

  const planActive = session.permissionMode === "plan";
  const togglePlan = (on = !planActive) => {
    if (!planSupported) return; // never set an unsupported "plan" mode (would map to a writable sandbox)
    applyConfig({ permissionMode: on ? "plan" : "" });
  };

  const clearAppCommandText = () => {
    draftDirty.current = true;
    composerDraftVersionRef.current += 1;
    draftState.current = { text: "", images };
    setProgrammaticComposerText("", 0);
    void saveComposerDraft(sessionId, "", images, instanceScope);
  };

  const requestSessionRetitle = async (
    composerFocus?: ReturnType<typeof captureComposerFocus>,
  ) => {
    if (retitleInFlightRef.current) return;
    const generation = viewGenerationRef.current;
    retitleInFlightRef.current = true;
    setRetitleFeedback({ state: "running" });
    try {
      await api.retitleSession(sessionId);
      if (viewGenerationRef.current !== generation) return;
      const receipt = retitleReceiptRef.current;
      const restoreComposerAfterReceipt = composerFocus !== undefined
        && receipt?.ownerDocument.activeElement === receipt;
      retitleFocusRestoreRef.current = restoreComposerAfterReceipt
        ? { generation, sessionId, composer: composerFocus }
        : null;
      setRetitleFeedback(null);
      showToast("Session renamed.", { tone: "success" });
    } catch (cause) {
      if (viewGenerationRef.current === generation) {
        setRetitleFeedback({ state: "failed", message: (cause as Error).message });
      }
    } finally {
      if (viewGenerationRef.current === generation) retitleInFlightRef.current = false;
    }
  };

  const send = async () => {
    if (composerMutationRegistry.has(mutationKey) || stopTurnPendingRef.current || retitleInFlightRef.current) return;
    const outgoing = text.trim();
    let invocation = resolveComposerCommandInvocation(outgoing, composerCommands);
    if (invocation.kind === "command" && invocation.command.source === "app") {
      const args = invocation.arguments.trim().toLowerCase();
      const validArguments = invocation.command.name === "plan"
        ? !args || args === "on" || args === "off"
        : invocation.command.name === "stop" || invocation.command.name === "rename-session"
          ? !args
          : true;
      if (!validArguments) invocation = { kind: "plaintext", text: outgoing };
    }
    if (invocation.kind === "command") {
      if (!invocation.command.available) {
        setError(invocation.command.disabledReason ?? "This command is unavailable.");
        return;
      }
      if (images.length && invocation.command.attachmentPolicy === "forbid") {
        setError(`${invocation.command.label} cannot run with attachments.`);
        return;
      }
      if (invocation.command.source === "app") {
        const args = invocation.arguments.trim().toLowerCase();
        if (invocation.command.name === "stop") {
          if (!await stopTurn()) return;
          clearAppCommandText();
          return;
        }
        if (invocation.command.name === "rename-session") {
          setError(null);
          clearAppCommandText();
          await requestSessionRetitle();
          return;
        }
        if (invocation.command.name === "respond") {
          if (args) {
            setError("Direct /respond answers are not supported. Use /respond to enter Answer Mode.");
            return;
          }
          clearAppCommandText();
          enterAnswerMode();
          return;
        }
        if (invocation.command.name === "plan") {
          togglePlan(args === "off" ? false : args === "on" ? true : !planActive);
          clearAppCommandText();
          return;
        } else {
          setError(`No app action is registered for ${invocation.command.label}.`);
          return;
        }
      }
    }
    const durableProviderInvocation = invocation.kind === "command" &&
      invocation.command.source === "provider" &&
      Boolean(invocation.command.providerCommandId && invocation.command.catalogRevision);
    const preservesAttachments = invocation.kind === "command" &&
      invocation.command.attachmentPolicy === "preserve";
    if (actualImages.length && !preservesAttachments && !modelSupportsImages(sessionCaps, effectiveModel)) {
      setError("The selected model does not support image input. Remove the attachment or choose an image-capable model.");
      return;
    }
    if (!canSend) return;
    const outgoingImages = images.map((image) => ({ ...image }));
    const preservedImages = durableProviderInvocation ? outgoingImages : [];
    const submittedDraft = { text, images: outgoingImages };
    let commandSubmission: ComposerCommandSubmission | undefined;
    if (durableProviderInvocation && invocation.kind === "command") {
      const candidate = {
        providerCommandId: invocation.command.providerCommandId!,
        catalogRevision: invocation.command.catalogRevision!,
        argumentText: invocation.arguments,
      };
      const retry = commandSubmissionRetryRef.current;
      commandSubmission = {
        submissionId: retry && retry.providerCommandId === candidate.providerCommandId &&
          retry.catalogRevision === candidate.catalogRevision && retry.argumentText === candidate.argumentText
          ? retry.submissionId
          : `web_${browserRandomUUID()}`,
        ...candidate,
      };
      commandSubmissionRetryRef.current = commandSubmission;
    }
    const submissionVersion = composerDraftVersionRef.current;
    const generation = viewGenerationRef.current;
    const mutation = reserveComposerMutation(mutationKey, "send", submittedDraft);
    if (!mutation) return;
    consumedDraftsRef.current.set(mutationKey, {
      ...submittedDraft,
      draftVersion: submissionVersion,
    });
    setError(null);
    setBusy(true);
    setHistIdx(-1);
    // Optimistic echo: render the message + working indicator instantly (item 1), before the
    // status flips and the runner echoes the real user_message. Baseline the current user-message
    // count so that echoed event supersedes this bubble (see the clear-pending effect above).
    // NOT when a turn is already active: the prompt QUEUES (no user_message until it starts), so
    // an optimistic bubble would show it as sent — and stick around forever if the user cancels it
    // from the queued list. The queue list under the composer is the honest echo there.
    // input_required counts as active: a turn parked on a mid-turn tool approval still holds the
    // runner's turn slot, so a send there queues exactly like running/starting.
    sendBaselineRef.current = timelineUserPrompts.length;
    const knownPendingPromptIds = new Set(
      (session.pendingPrompts ?? []).map((prompt) => prompt.commandId),
    );
    if (shouldShowOptimisticPrompt(session.status, durableProviderInvocation)) {
      setPending({ text: outgoing, images: outgoingImages });
    }
    let providerAccepted = false;
    let preservedDraftVersion: number | null = null;
    const reservationPromise = reserveComposerDraftSnapshot(
      sessionId,
      submittedDraft.text,
      submittedDraft.images,
      instanceScope,
      commandSubmission,
    );
    try {
      const cfg = Object.keys(pendingConfig.current).length ? pendingConfig.current : undefined;
      const promptText = invocation.kind === "command" ? invocation.arguments : outgoing;
      const slashCommand = invocation.kind === "command" ? invocation.command.name : undefined;
      if (durableProviderInvocation && invocation.kind === "command") {
        await api.invokeSessionCommand(sessionId, {
          submissionId: commandSubmission!.submissionId,
          providerCommandId: commandSubmission!.providerCommandId,
          catalogRevision: commandSubmission!.catalogRevision,
          argumentText: promptText,
        });
        commandSubmissionRetryRef.current = null;
      } else {
        const prompted = await api.prompt(sessionId, promptText, outgoingImages, cfg, slashCommand);
        if (prompted && viewGenerationRef.current === generation &&
            (prompted.status === "queued" || prompted.status === "starting") &&
            hasNewPendingPrompt(knownPendingPromptIds, prompted.pendingPrompts)) {
          // The server had newer admission state than this render and durably staged the prompt.
          // Replace the stale optimistic echo with the authoritative command-keyed bubble now.
          setPending(null);
        }
        pendingConfig.current = {};
      }
      providerAccepted = true;
      if (viewGenerationRef.current === generation &&
          composerDraftVersionRef.current === submissionVersion) {
        draftDirty.current = true;
        draftState.current = { text: "", images: preservedImages };
        setProgrammaticComposerText("", 0);
        if (preservedImages.length) replace(preservedImages);
        else clear();
        if (preservedImages.length) preservedDraftVersion = composerDraftVersionRef.current;
      }
      const reservedDraft = await reservationPromise;
      updateComposerMutationDraft(mutationKey, mutation.token, reservedDraft);
      // Acceptance and local cleanup are separate outcomes. Persist a revision-scoped suppression
      // marker first so a failed or inconclusive delete cannot resurrect the accepted submission
      // on navigation, remount, or reload. A newer edit has a different revision and remains live.
      await markComposerDraftAccepted(
        sessionId,
        submittedDraft.text,
        submittedDraft.images,
        instanceScope,
        reservedDraft.revision,
        reservedDraft.supersededRevision,
      ).catch(() => false);
      const deleted = await composerDraftCleanup(
        sessionId,
        submittedDraft.text,
        submittedDraft.images,
        instanceScope,
        reservedDraft.revision,
        reservedDraft.supersededRevision,
      ).catch(() => false);
      if (preservedImages.length && preservedDraftVersion !== null &&
          viewGenerationRef.current === generation &&
          composerDraftVersionRef.current === preservedDraftVersion) {
        // A false cleanup can mean either that the accepted reservation survived behind its
        // marker or that another writer stored a newer draft. Re-save the command-owned images
        // only when storage is now empty; never replace another tab's newer edit.
        const currentDraft = deleted ? null : await loadComposerDraft(sessionId, instanceScope);
        if (!currentDraft) await saveComposerDraft(sessionId, "", preservedImages, instanceScope);
      }
    } catch (e) {
      await reservationPromise.catch(() => undefined);
      if (!providerAccepted) {
        if (consumedDraftsRef.current.get(mutationKey)?.draftVersion === submissionVersion) {
          consumedDraftsRef.current.delete(mutationKey);
        }
        if (viewGenerationRef.current === generation) {
          setError((e as Error).message);
          setPending(null); // send failed — retract the optimistic bubble
        }
      }
    } finally {
      releaseComposerMutation(
        mutationKey,
        mutation.token,
        !providerAccepted && composerDraftVersionRef.current === submissionVersion
          ? submittedDraft
          : undefined,
      );
      if (viewGenerationRef.current === generation) setBusy(false);
    }
  };

  const steerDraft = async () => {
    if (composerMutationRegistry.has(mutationKey) || stopTurnPendingRef.current || !canSend) return;
    if (!directSteeringAvailability.available) {
      setError(directSteeringAvailability.reason);
      return;
    }
    const outgoing = text.trim();
    if (actualImages.length && !modelSupportsImages(sessionCaps, effectiveModel)) {
      setError("The selected model does not support image input. Remove the attachment or choose an image-capable model.");
      return;
    }

    const generation = viewGenerationRef.current;
    const submittedImages = images.map((image) => ({ ...image }));
    const submittedDraft = { text, images: submittedImages };
    const submissionVersion = composerDraftVersionRef.current;
    const mutation = reserveComposerMutation(mutationKey, "steer", submittedDraft);
    if (!mutation) return;
    consumedDraftsRef.current.set(mutationKey, {
      ...submittedDraft,
      draftVersion: submissionVersion,
    });
    setSteeringBusy(true);
    setError(null);
    setHistIdx(-1);
    let recoverReservation = false;
    let providerAccepted = false;
    const reservationPromise = reserveComposerDraftSnapshot(
      sessionId,
      submittedDraft.text,
      submittedDraft.images,
      instanceScope,
    );
    try {
      const receipt = await api.steer(sessionId, {
        submissionId: browserRandomUUID(),
        turnId: session.activeTurnId!,
        ...(outgoing ? { text: outgoing } : {}),
        ...(submittedImages.length ? { images: submittedImages } : {}),
      });
      // A definite rejection did not reach the provider. Preserve the exact draft so the user can
      // edit, queue, or retry it deliberately; all other durable states require reconciliation.
      if (receipt.state === "rejected") {
        recoverReservation = true;
        await reservationPromise.catch(() => undefined);
        consumedDraftsRef.current.delete(mutationKey);
        return;
      }
      providerAccepted = true;
      if (viewGenerationRef.current === generation &&
          composerDraftVersionRef.current === submissionVersion) {
        draftDirty.current = true;
        draftState.current = { text: "", images: [] };
        setProgrammaticComposerText("", 0);
        clear();
      }
      const reservedDraft = await reservationPromise;
      updateComposerMutationDraft(mutationKey, mutation.token, reservedDraft);
      await markComposerDraftAccepted(
        sessionId,
        submittedDraft.text,
        submittedDraft.images,
        instanceScope,
        reservedDraft.revision,
        reservedDraft.supersededRevision,
      ).catch(() => false);
      await composerDraftCleanup(
        sessionId,
        submittedDraft.text,
        submittedDraft.images,
        instanceScope,
        reservedDraft.revision,
        reservedDraft.supersededRevision,
      ).catch(() => false);
    } catch (cause) {
      await reservationPromise.catch(() => undefined);
      if (!providerAccepted) {
        recoverReservation = true;
        if (consumedDraftsRef.current.get(mutationKey)?.draftVersion === submissionVersion) {
          consumedDraftsRef.current.delete(mutationKey);
        }
        if (viewGenerationRef.current === generation) setError((cause as Error).message);
      }
    } finally {
      releaseComposerMutation(
        mutationKey,
        mutation.token,
        !providerAccepted && recoverReservation && composerDraftVersionRef.current === submissionVersion
          ? submittedDraft
          : undefined,
      );
      if (viewGenerationRef.current === generation) setSteeringBusy(false);
    }
  };

  const promoteQueuedPrompt = async (prompt: QueuedPromptView) => {
    if (queueSteeringInFlightRef.current.has(prompt.id) ||
        composerMutationRegistry.has(mutationKey) || stopTurnPendingRef.current) return;
    const availability = queuedPromptSteeringAvailability(steeringAvailabilityInput, prompt);
    if (!availability.available) {
      setError(availability.reason);
      return;
    }
    const generation = viewGenerationRef.current;
    const mutation = reserveComposerMutation(mutationKey, "promote");
    if (!mutation) return;
    queueSteeringInFlightRef.current.add(prompt.id);
    setQueueSteeringPending((current) => new Set(current).add(prompt.id));
    setError(null);
    try {
      await api.steer(sessionId, {
        submissionId: browserRandomUUID(),
        turnId: session.activeTurnId!,
        promotePromptId: prompt.id,
      });
    } catch (cause) {
      if (viewGenerationRef.current === generation) setError((cause as Error).message);
    } finally {
      releaseComposerMutation(mutationKey, mutation.token);
      queueSteeringInFlightRef.current.delete(prompt.id);
      if (viewGenerationRef.current === generation) {
        setQueueSteeringPending((current) => {
          const next = new Set(current);
          next.delete(prompt.id);
          return next;
        });
      }
    }
  };

  const beginQueuedPromptEdit = async (prompt: QueuedPromptView) => {
    if (queuedEdit || composerRequestBusy) return;
    const availability = queuedPromptEditingAvailability({
      runnerProtocolVersion: runner?.protocolVersion,
      runnerOnline,
      requestBusy: false,
    }, prompt);
    if (!availability.available) {
      setError(availability.reason);
      return;
    }
    if (composerAnswerActive) exitAnswerMode();
    const generation = viewGenerationRef.current;
    const displacedDraft = {
      text: draftState.current.text,
      images: draftState.current.images.map((image) => ({ ...image })),
    };
    setQueuedEditBusy(true);
    setError(null);
    try {
      const { prompt: exact } = await api.readQueuedPrompt(sessionId, prompt.id);
      if (viewGenerationRef.current !== generation) return;
      await saveComposerDraft(sessionId, displacedDraft.text, displacedDraft.images, instanceScope);
      if (viewGenerationRef.current !== generation) return;
      const editState = { ...exact, displacedDraft };
      queuedEditRef.current = editState;
      setQueuedEdit(editState);
      setQueuedEditRecovered(false);
      setProgrammaticComposerText(exact.text);
      replace(exact.images);
      setHistIdx(-1);
      window.requestAnimationFrame(focusComposerAtDraftEnd);
    } catch (cause) {
      if (viewGenerationRef.current === generation) setError((cause as Error).message);
    } finally {
      if (viewGenerationRef.current === generation) setQueuedEditBusy(false);
    }
  };

  const cancelQueuedPromptEdit = () => {
    if (!queuedEdit || queuedEditBusy) return;
    const displaced = queuedEdit.displacedDraft;
    markDraftDirty();
    clearQueuedPromptEditRecovery(mutationKey);
    queuedEditRef.current = null;
    setQueuedEdit(null);
    setQueuedEditRecovered(false);
    draftState.current = displaced;
    setProgrammaticComposerText(displaced.text);
    replace(displaced.images);
    setHistIdx(-1);
    setError(null);
    void saveComposerDraft(sessionId, displaced.text, displaced.images, instanceScope);
    window.requestAnimationFrame(focusComposerAtDraftEnd);
  };

  const useRecoveredQueuedEditAsNewMessage = async () => {
    if (!queuedEdit || !queuedEditRecovered || queuedEditBusy) return;
    const generation = viewGenerationRef.current;
    const recoveredEdit = queuedEdit;
    const draftVersion = composerDraftVersionRef.current;
    const retainedDraft = {
      text: draftState.current.text,
      images: draftState.current.images.map((image) => ({ ...image })),
    };
    setError(null);
    setQueuedEditBusy(true);
    try {
      const materializedImages = await materializePromptImages(retainedDraft.images, api.artifactExport);
      if (viewGenerationRef.current !== generation || queuedEditRef.current !== recoveredEdit) return;
      if (composerDraftVersionRef.current !== draftVersion) {
        setError("Recovered message was not converted because the composer changed. Try again.");
        return;
      }
      const recoveredDraft = { text: retainedDraft.text, images: materializedImages };
      const saved = await saveComposerDraft(sessionId, recoveredDraft.text, recoveredDraft.images, instanceScope);
      if (viewGenerationRef.current !== generation || queuedEditRef.current !== recoveredEdit) return;
      if (composerDraftVersionRef.current !== draftVersion) {
        const displaced = recoveredEdit.displacedDraft;
        await saveComposerDraft(sessionId, displaced.text, displaced.images, instanceScope);
        if (viewGenerationRef.current !== generation || queuedEditRef.current !== recoveredEdit) return;
        setError("Recovered message was not converted because the composer changed. Try again.");
        return;
      }
      if (!saved) {
        setError("Recovered message was not converted because the ordinary draft could not be saved safely.");
        return;
      }
      markDraftDirty();
      clearQueuedPromptEditRecovery(mutationKey);
      setQueuedEditBusy(false);
      queuedEditRef.current = null;
      setQueuedEdit(null);
      setQueuedEditRecovered(false);
      draftState.current = recoveredDraft;
      replace(recoveredDraft.images);
      setHistIdx(-1);
      setError(null);
      window.requestAnimationFrame(focusComposerAtDraftEnd);
    } catch (cause) {
      if (viewGenerationRef.current === generation && queuedEditRef.current === recoveredEdit) {
        setError(`Recovered message was not converted because an attachment could not be retained. ${(cause as Error).message}`);
      }
    } finally {
      if (viewGenerationRef.current === generation && queuedEditRef.current === recoveredEdit) {
        setQueuedEditBusy(false);
      }
    }
  };

  const saveQueuedPromptEdit = async () => {
    if (!queuedEdit || queuedEditBusy || !queuedEditRetryable || composerMutationRegistry.has(mutationKey)) return;
    const submittedDraft = {
      text: text.trim(),
      images: images.map((image) => ({ ...image })),
    };
    if (!submittedDraft.text && submittedDraft.images.length === 0) return;
    if (!queuedEditRecoveryScope) {
      setError("Queued message edit was not sent because authenticated recovery storage is not ready.");
      return;
    }
    let recovery: QueuedPromptEditRecovery = { edit: queuedEdit, draft: submittedDraft };
    const mutation = reserveComposerMutation(mutationKey, "edit", submittedDraft, recovery);
    if (!mutation) return;
    const generation = viewGenerationRef.current;
    let editAccepted = false;
    setQueuedEditBusy(true);
    setError(null);
    try {
      // Browser paste data is base64 and can legitimately exceed localStorage quotas. Upload every
      // image first, then persist the compact immutable references before submitting the edit.
      // Artifact creation is not a queued-edit submission and references remain safe to retry.
      const editImageCount = queuedEdit.images.length;
      let preparedImages: PromptImageInput[];
      try {
        preparedImages = await api.preparePromptImages(sessionId, [
          ...queuedEdit.images,
          ...submittedDraft.images,
        ]);
      } catch (cause) {
        if (viewGenerationRef.current === generation) {
          setError(`Queued message edit was not sent. ${(cause as Error).message}`);
        }
        return;
      }
      const preparedEditImages = preparedImages.slice(0, editImageCount);
      const preparedDraft = {
        text: submittedDraft.text,
        images: preparedImages.slice(editImageCount),
      };
      const submissionFingerprint = JSON.stringify(preparedDraft);
      const submissionId = queuedEdit.submissionId && queuedEdit.submissionFingerprint === submissionFingerprint
        ? queuedEdit.submissionId
        : browserRandomUUID();
      const editForAttempt: QueuedPromptEditState = {
        ...queuedEdit,
        images: preparedEditImages,
        // The ordinary draft remains in IndexedDB/local draft storage. It is not part of this
        // queued-edit submission and must not create authenticated server artifacts merely to
        // compact the recovery record.
        displacedDraft: queuedEdit.displacedDraft,
        submissionId,
        submissionFingerprint,
      };
      recovery = { edit: editForAttempt, draft: preparedDraft };
      updateQueuedPromptEditMutationRecovery(mutationKey, recovery);
      updateComposerMutationDraft(mutationKey, mutation.token, preparedDraft);
      if (viewGenerationRef.current === generation) {
        queuedEditRef.current = editForAttempt;
        setQueuedEdit(editForAttempt);
        draftState.current = preparedDraft;
        replace(preparedDraft.images);
      }
      if (!persistQueuedPromptEditRecovery(recovery)) {
        if (viewGenerationRef.current === generation) {
          setError("Queued message edit was not sent because its recovery could not be saved safely.");
        }
        return;
      }
      await api.editQueuedPrompt(sessionId, queuedEdit.promptId, {
        submissionId,
        expectedRevision: queuedEdit.editRevision,
        text: preparedDraft.text,
        images: preparedDraft.images,
      });
      editAccepted = true;
      clearQueuedPromptEditRecovery(mutationKey);
      if (viewGenerationRef.current !== generation) return;
      const displaced = editForAttempt.displacedDraft;
      markDraftDirty();
      queuedEditRef.current = null;
      setQueuedEdit(null);
      setQueuedEditRecovered(false);
      draftState.current = displaced;
      setProgrammaticComposerText(displaced.text);
      replace(displaced.images);
      setHistIdx(-1);
      await saveComposerDraft(sessionId, displaced.text, displaced.images, instanceScope);
      window.requestAnimationFrame(focusComposerAtDraftEnd);
    } catch (cause) {
      // A departed view cannot display the failure, so retain the typed edit separately from its
      // displaced ordinary draft. A definitive runner acceptance must never enter recovery even
      // if restoring that displaced draft later hits a local storage error.
      const failureMessage = editAccepted
        ? (cause as Error).message
        : `Queued message edit was not confirmed. ${(cause as Error).message}`;
      if (!editAccepted) {
        const latestRecovery = queuedPromptEditMutationRecovery(
          composerMutationRegistry.get(mutationKey),
        ) ?? recovery;
        storeQueuedPromptEditRecovery(mutationKey, {
          ...latestRecovery,
          error: failureMessage,
        });
        if (viewGenerationRef.current === generation) setQueuedEditRecovered(true);
      }
      if (viewGenerationRef.current === generation) setError(failureMessage);
    } finally {
      releaseComposerMutation(mutationKey, mutation.token);
      if (viewGenerationRef.current === generation) setQueuedEditBusy(false);
    }
  };

  const resolveSteeringAttempt = async (
    submissionId: string,
    action: "queue_again" | "dismiss",
  ) => {
    if (steeringResolutionInFlightRef.current.has(submissionId)) return;
    const generation = viewGenerationRef.current;
    steeringResolutionInFlightRef.current.add(submissionId);
    setSteeringResolutionPending((current) => new Map(current).set(submissionId, action));
    setError(null);
    try {
      await api.resolveSteeringAttempt(sessionId, submissionId, action);
    } catch (cause) {
      if (viewGenerationRef.current === generation) setError((cause as Error).message);
    } finally {
      steeringResolutionInFlightRef.current.delete(submissionId);
      if (viewGenerationRef.current === generation) {
        setSteeringResolutionPending((current) => {
          const next = new Map(current);
          next.delete(submissionId);
          return next;
        });
      }
    }
  };

  const commitSlashCommand = (command: ComposerCommand) => {
    if (!command.available) {
      setError(command.disabledReason ?? "This command is unavailable.");
      return;
    }
    const exactTypedCommand = slashTrigger?.raw.toLowerCase() === command.label.toLowerCase();
    if (exactTypedCommand && command.source === "app" && command.name === "stop") {
      void send();
      return;
    }
    insertSlashCommand(command);
  };

  // The tooltip advertises whichever binding actually sends under the Enter-key setting; on a
  // touch phone in newline mode it stays plain "Send" — the software keyboard has no Shift+Enter
  // to advertise, and the button itself is the affordance there.
  const isTouchPhone = useIsTouchPhone();
  const enterKeySetting = useEnterKeyBehavior();

  const onKeyDown = (e: KeyboardEvent) => {
    composerInteractionVersionRef.current += 1;
    // While an IME owns the key sequence, the app owns nothing: not submission, shortcuts, menu
    // navigation, dismissal, or history. Arrow and Escape are part of candidate selection too.
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (composing) return;
    if (canStopTurn && !shortcutLayerActive(document) && matchesShortcut(e, "stop-turn")) {
      e.preventDefault();
      void stopTurn();
      return;
    }
    // Editing owns submission and never lets Ctrl+Enter reinterpret the draft as active-turn
    // steering. Up/Down remain the ordinary history behavior outside this explicit state.
    if (queuedEdit && matchesShortcut(e, "steer-turn")) {
      e.preventDefault();
      return;
    }
    if (queuedEdit && e.key === "Enter" && !e.metaKey && !e.ctrlKey && !composing) {
      if (!enterKeystrokeSends(e.shiftKey)) return;
      e.preventDefault();
      if (queuedEditRetryable) void saveQueuedPromptEdit();
      return;
    }
    // Steering owns exact Ctrl+Enter before slash-palette selection. The composed slash text is
    // steering content; it is not dispatched as an app or provider slash command.
    if (!shortcutLayerActive(document) && matchesShortcut(e, "steer-turn")) {
      e.preventDefault();
      void steerDraft();
      return;
    }
    if (workspacePickerOpen) {
      const plainKey = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === "Escape" && plainKey) {
        e.preventDefault();
        setWorkspaceDismissedFor(workspaceDismissKey);
        return;
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && plainKey && workspaceResults.length) {
        e.preventDefault();
        setActiveWorkspaceResult((current) => e.key === "ArrowDown"
          ? (current + 1) % workspaceResults.length
          : (current - 1 + workspaceResults.length) % workspaceResults.length);
        return;
      }
      if ((e.key === "Tab" || e.key === "Enter") && plainKey && workspaceResults[activeWorkspaceResult]) {
        e.preventDefault();
        selectWorkspaceCandidate(workspaceResults[activeWorkspaceResult]!);
        return;
      }
    }
    if (paletteOpen) {
      const plainKey = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === "Escape" && plainKey) {
        e.preventDefault();
        setSlashDismissedFor(slashDismissKey);
        return;
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && plainKey) {
        e.preventDefault();
        const currentIndex = Math.max(0, selectedSlashCommandIndex);
        const nextIndex = e.key === "ArrowDown"
          ? (currentIndex + 1) % slashMatches.length
          : (currentIndex - 1 + slashMatches.length) % slashMatches.length;
        setActiveSlashCommandId(slashMatches[nextIndex]?.id ?? null);
        return;
      }
      if ((e.key === "Tab" || e.key === "Enter") && plainKey) {
        e.preventDefault();
        if (selectedSlashCommand) commitSlashCommand(selectedSlashCommand);
        return;
      }
    }
    // ↑/↓ recall previous prompts (palette closed, no modifiers). ↑ engages only when the box is
    // empty or already browsing history, so a multi-line draft's caret navigation isn't hijacked.
    if (!queuedEdit && !paletteOpen && !e.shiftKey && !e.metaKey && !e.ctrlKey && userPrompts.length) {
      if (e.key === "ArrowUp" && (histIdx !== -1 || text === "")) {
        e.preventDefault();
        const idx = histIdx === -1 ? userPrompts.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(idx);
        markDraftDirty();
        setProgrammaticComposerText(userPrompts[idx]!);
        return;
      }
      if (e.key === "ArrowDown" && histIdx !== -1) {
        e.preventDefault();
        const idx = histIdx + 1;
        markDraftDirty();
        if (idx >= userPrompts.length) {
          setHistIdx(-1);
          setProgrammaticComposerText("", 0);
        } else {
          setHistIdx(idx);
          setProgrammaticComposerText(userPrompts[idx]!);
        }
        return;
      }
    }
    // Enter and Shift+Enter split send from newline; WHICH is which is the per-device Enter-key
    // setting (Settings > Behavior), whose unstored default derives from the device class —
    // send on a hardware-keyboard layout, newline on a touch phone, where a software keyboard
    // has no Shift to hold and send-on-Enter made multi-line drafts unwritable. The pair swaps
    // as a unit so a keyboard send always exists without touching Ctrl+Enter, which is steering.
    // Read at keydown, not render: the settings panel can flip it while this composer is mounted.
    // (Ctrl/Cmd+Enter intentionally does NOT send.)
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !composing) {
      if (!enterKeystrokeSends(e.shiftKey)) return; // the other half of the pair is the newline
      e.preventDefault();
      void send();
    }
  };

  const usage = sessionPreviewUsage(session);
  const currentProjectName = projectsSupported
    ? (session.projectId ? projects.get(session.projectId)?.name : undefined) ?? session.projectName ?? "No Project"
    : session.workspaceName ?? "No Workspace";

  return (
    <div className={`session-detail ${mode}`} data-session-surface-id={session.id}>
      {mode === "expanded" ? (
        <SessionHeader
          session={session}
          runnerOnline={runnerOnline}
          runnerProtocolVersion={runner?.protocolVersion}
          stopBeforeArchiveSupported={stopBeforeArchiveSupported}
          providerLogoutSupported={runner?.agents.find((agent) => agent.id === session.agentId)?.acp?.logout === true}
          exportReady={eventHistory?.everComplete === true}
          onBack={onBack ?? (() => navigate({ name: "inbox" }))}
          onArchive={onArchive}
          onSnooze={onSnooze}
          reminder={reminder}
          onDismissReminder={onDismissReminder}
          forkAvailability={latestForkAvailability}
          onFork={() => {
            if (latestForkAvailability.available) void onFork(latestForkAvailability.forkTurn);
          }}
          projectCrumb={<ProjectChip session={session} onOpenInbox={onBack ?? (() => navigate({ name: "inbox" }))} />}
          projectName={currentProjectName}
          projectLabel={projectsSupported ? "Project" : "Workspace"}
          onManageProject={projectsSupported ? () => {
            navigate(session.projectId ? { name: "projects", id: session.projectId } : { name: "projects" });
          } : undefined}
          renderMoveProjectDialog={({ onClose, returnFocusRef }) => projectsSupported ? (
            <MoveToProjectDialog session={session} onClose={onClose} returnFocusRef={returnFocusRef} />
          ) : (
            <LegacyWorkspaceMoveDialog session={session} onClose={onClose} returnFocusRef={returnFocusRef} />
          )}
          topbarControls={topbarControls}
          changeStatus={changeStatus}
          activeSubagents={preferredActiveSubagentId ? {
            count: activeSubagents.length,
            onOpen: () => openSubagent(preferredActiveSubagentId),
          } : undefined}
          onOpenBackgroundWork={() => rightPanel.show("background")}
          // The unified bar replaces the app-level top bar on desktop, so it owns the page-title
          // focus-rescue anchor there; the mobile layout keeps the app bar and its own anchor.
          titleId={!isMobile ? "page-title" : undefined}
        />
      ) : (
        <header className="session-preview-head">
          <div className="session-preview-heading">
            <h2 className="session-preview-title">{session.title}</h2>
            <div className="session-preview-meta">
              <SessionStatusIndicators session={session} disconnected={!runnerOnline} />
              {visibleBackgroundWorkState && <BackgroundWorkBadge state={visibleBackgroundWorkState} onOpen={() => {
                rightPanel.show("background");
                onExpand?.();
              }} />}
              {!visibleBackgroundWorkState && session.backgroundWorkTracking === "untracked" && (
                <UntrackedBackgroundWorkBadge onOpen={() => {
                  rightPanel.show("background");
                  onExpand?.();
                }} />
              )}
              {session.backgroundDeliveries?.find((delivery) => delivery.watchdogState)?.watchdogState && (
                <BackgroundDeliveryBadge
                  state={session.backgroundDeliveries.find((delivery) => delivery.watchdogState)!.watchdogState!}
                  onOpen={() => {
                    rightPanel.show("background");
                    onExpand?.();
                  }}
                />
              )}
              {session.backgroundDeliveries?.flatMap((delivery) => delivery.notifications ?? []).slice(-2).map((receipt) => (
                <BackgroundNotificationBadge key={receipt.deliveryId} state={receipt.state} onOpen={() => {
                  rightPanel.show("background");
                  onExpand?.();
                }} />
              ))}
              <span className="tag tag-machine" title={session.runnerId}>{runnerDisp.name}</span>
              {session.agentName && (
                <span className="tag tag-agent">{sessionAgentLabel(session.agentName, session.driver, session.agentId)}</span>
              )}
              {session.workspaceName && <span className="tag tag-workspace">{session.workspaceName}</span>}
              <ContextWindowMeter session={session} />
              {usage && <span className="tag tag-usage" aria-label={`Usage: ${usage}`}>{usage}</span>}
              {isHeartbeatBusy(session.status) && (
                <ActivityStrip activity={activity} now={activityNow} />
              )}
              {stalled && (
                <span className="inbox-status-pill stalled" aria-label="Stalled: No Activity for at Least 10 Minutes">
                  Stalled
                </span>
              )}
              <span className="muted">Updated {relativeTime(lastActivityAt)}</span>
            </div>
          </div>
          <button type="button" className="btn ghost sm" onClick={onExpand} aria-label="Expand Session" title="Expand Session (Enter)">
            Expand <kbd className="inbox-key-hint">Enter</kbd>
          </button>
        </header>
      )}

      {/* Chat column + the Codex-style right side panel. The panel's open/mode/width state
          lives at the app shell (survives navigation); its per-session bodies (e.g. the Files
          browser) reset with SessionDetail's own session-id key. */}
      <div className="detail-columns">
        <div className="detail-chat">
          {/* Inside the CHAT COLUMN (not .session-detail) so the card centers against the
              same width the transcript and composer use — with the right panel open, a
              session-wide card would sit visibly off-axis from the column it belongs to. */}
          <SessionApprovalRegion
            session={session}
            runnerOnline={runnerOnline}
            fallbackFocusRef={mode === "expanded" ? inputRef : scrollRef}
            alternateFallbackFocusRef={mode === "expanded" ? scrollRef : undefined}
            onSessionUpdate={loadSession}
            showKeyHints={!isMobile}
            // The fallback owns the request only until the matching pinned row is mounted and the
            // virtual list can keep it reachable at its canonical transcript position.
            questionInTimeline={questionInTimeline}
          />
          {mode === "expanded" && (
            <GovernanceAuditTrail
              sessionId={session.id}
              revision={`${session.updatedAt}:${session.pendingApproval?.requestId ?? ""}`}
            />
          )}
          <div
            className="detail-main"
            data-active-pane={activePane}
            onFocusCapture={() => setActivePane("reader")}
            onPointerDownCapture={(event) => {
              setActivePane("reader");
              const composer = inputRef.current;
              // Mobile browsers can defer native textarea blur while recognizing a tap, scroll,
              // or long-press. Relinquish focus inside React's reader event boundary so transcript
              // selection cannot be followed by stale focus recovery or a reopened keyboard.
              if (event.pointerType !== "mouse" && composer && composer.ownerDocument.activeElement === composer) {
                composer.blur();
              }
            }}
          >
            {/* The reader region: the scroller and its floating pinned summary, and NOTHING
                below them. It is the summary's containing block, so the card's bounds can never
                reach the recovery slot or the status strip regardless of the pill's rendered
                height — a structural exclusion, not a pixel reservation. */}
            <div className="detail-reader">
            {/* Floating pinned summary overlays the TRANSCRIPT's top-right (Codex behavior);
                the timeline does not reflow around it, and it shifts with the right panel.
                Anchored inside detail-reader — not the whole chat column — so its max-height
                can never extend down over the recovery slot, status strip, or composer. */}
            {mode === "expanded" && pinnedOpen && (
              <PinnedSummary
                session={session}
                git={git}
                gitSummary={gitSummary}
                gitPresentation={gitPresentation}
                richGitSupported={richGitSupported}
                items={items}
                onOpenReview={() => rightPanel.show("review")}
                onOpenSourceLocation={openSourceLocation}
              />
            )}
            <div
              className="detail-scroll measured-virtual-scroll"
              ref={scrollRef}
              role="region"
              aria-label={mode === "expanded" ? "Session Activity" : "Session Preview Activity"}
              aria-busy={transcript.busy}
              tabIndex={0}
              onScroll={(event) => {
                followTail.onScroll();
                maybeLoadEarlier(event.currentTarget);
              }}
              onWheel={(event) => {
                markSingleEarlierActivityIntent();
                followTail.onWheel(event);
              }}
              onPointerDown={(event) => {
                if (event.pointerType === "touch") markTouchEarlierActivityIntent(event.clientY);
                else markSingleEarlierActivityIntent();
              }}
              onPointerMove={(event) => {
                if (event.pointerType === "touch") markTouchEarlierActivityMovement(event.clientY);
                followTail.onPointerMove(event);
              }}
              onPointerUp={(event) => {
                if (event.pointerType === "touch") finishPointerTouchEarlierActivityIntent();
              }}
              onPointerCancel={(event) => {
                if (event.pointerType === "touch") finishPointerTouchEarlierActivityIntent();
              }}
              onTouchStart={(event) => {
                markNativeTouchEarlierActivityIntent(event.touches[0]?.clientY ?? null);
                followTail.onTouchStart();
              }}
              onTouchMove={(event) => {
                markTouchEarlierActivityMovement(event.touches[0]?.clientY ?? null);
              }}
              onTouchEnd={(event) => finishNativeTouchEarlierActivityIntent(event.touches.length)}
              onTouchCancel={(event) => finishNativeTouchEarlierActivityIntent(event.touches.length)}
              onKeyDown={(event) => {
                if (event.defaultPrevented) return;
                if (inTypingContext(event.currentTarget.ownerDocument)) return;
                if (mode !== "expanded" && !isFollowTailResumeKey(event)) return;
                if (isFollowTailUpwardReadingKey(event)) markSingleEarlierActivityIntent();
                if (!followTail.onKeyDown(event)) return;
                event.preventDefault();
              }}
            >
              {(transcript.notice === "stale" || transcript.notice === "error") && (
                <TranscriptLoadNotice
                  kind={transcript.notice}
                  error={transcript.error}
                  canRetry={conn === "online" && !transcript.busy}
                  onRetry={() => setHistoryRetry((value) => value + 1)}
                />
              )}
              {eventWindow?.hasOlder === true && items.length > 0 && openingHistoryFillSettled && (
                <EarlierActivityControl
                  loading={eventWindow.loadingOlder}
                  error={eventWindow.error}
                  onLoad={loadEarlierFromControl}
                />
              )}
              {transcript.body === "skeleton" ? (
                <TranscriptSkeleton />
              ) : transcript.body === "unavailable" ? (
                <Empty
                  title={conn === "unauthorized" ? "Pair to load activity" : "Activity Unavailable"}
                  hint={transcript.error ?? (conn === "offline" ? "Reconnect to load this transcript." : "This device needs access to the control plane.")}
                />
              ) : transcript.body === "empty" && (session.pendingPrompts?.length ?? 0) === 0 ? (
                <Empty title="No Activity Yet" hint="Waiting for the agent…" />
              ) : (
                <>
                  {items.length > 0 && (
                    <EventTimeline
                      driver={session.driver}
                      items={items}
                      sessionActive={isTimelineSessionActive(session.status)}
                      onOpenSubagent={mode === "expanded" ? openSubagent : undefined}
                      onOpenSourceLocation={openSourceLocation}
                      scrollRef={scrollRef}
                      historyKey={timelineHistoryKey}
                      getInitialAnchor={followTail.getInitialAnchor}
                      preserveAnchor={!followTail.isFollowing}
                      anchorRecoveryPending={anchorRecoveryPending}
                      onVisibleAnchorChange={followTail.onVisibleAnchorChange}
                      onAnchorLost={followTail.onAnchorLost}
                      // Worktree sessions on a v25+ runner only — persisted checkpoint rows can
                      // outlive a runner downgrade, and the CP would 409 the click anyway.
                      onRewind={
                        mode === "expanded" &&
                        session.worktreePath != null && runnerSupportsProtocol(runner?.protocolVersion, "checkpointRewind")
                          ? onRewind
                          : undefined
                      }
                      onFork={mode === "expanded" ? onFork : undefined}
                      onEditAndResend={mode === "expanded" && canPrompt ? openResendAction : undefined}
                      onEditInFork={mode === "expanded" ? openForkEditAction : undefined}
                      editInForkTargets={mode === "expanded" ? editInForkTargets : undefined}
                      forkAvailabilityByTurn={mode === "expanded" ? forkAvailabilityByTurn : undefined}
                      revealRequest={timelineRevealRequest}
                      onRevealHandled={handleTimelineReveal}
                      questionContext={timelineQuestionContext}
                    />
                  )}
                  <PendingPromptBubbles
                    prompts={session.pendingPrompts ?? []}
                    deliveredCommandIds={deliveredPromptCommandIds}
                    liveQueueIds={liveQueueIds}
                    canCancelLive={runnerOnline && canCancelQueued}
                    pendingAction={pendingPromptAction}
                    onCancelPending={(commandId) => void resolvePendingPrompt(commandId, "cancel")}
                    onCancelLive={(commandId) => void cancelLivePendingPrompt(commandId)}
                    onDismiss={(commandId) => void resolvePendingPrompt(commandId, "dismiss")}
                  />
                  {showOptimistic && pending && (
                    <div className="tl-row user">
                      <div className="bubble user-bubble">
                        {pending.images.length > 0 && (
                          <div className="bubble-images">
                            {pending.images.filter((attachment) => !isWorkspaceReference(attachment)).map((img, i) => (
                              <PromptImageView key={"artifactId" in img ? img.artifactId : i} image={img} alt={`attachment ${i + 1}`} />
                            ))}
                            {pending.images.filter(isWorkspaceReference).map((reference) => (
                              <span className="workspace-reference-chip is-readonly" key={reference.artifactId}>@{reference.path}</span>
                            ))}
                          </div>
                        )}
                        {pending.text && <div className="bubble-text">{pending.text}</div>}
                      </div>
                    </div>
                  )}
                  {activeTurnVisible && (
                    <WorkingIndicator
                      label={workingLabel}
                      progress={activeTurnProgress}
                      onRevealCurrentOperation={revealCurrentOperation}
                      onOpenSubagent={mode === "expanded" ? openSubagent : undefined}
                    />
                  )}
                </>
              )}
            </div>
            </div>
            {/* Reconnect recovery indicator lives at the LOWER edge of the reader — where the
                newest activity is — not sticky-top inside the scroller (issue #56: users watching
                the tail read a top-only notice as "frozen" or "fully caught up"). The slot is
                ALWAYS mounted between the reader and the status strip, so toggling recovery
                can never change layout, scroll position, or follow state. In height-constrained
                panes CSS collapses the slot and surfaces the echo inside the status strip. */}
            <TranscriptRecoveryNotice active={transcript.notice === "refreshing"} />
            <div className="transcript-status-strip" aria-label="Transcript Status">
              <div className="transcript-status-context">
                {mode === "expanded" && <ContextWindowMeter session={session} />}
                <TranscriptRecoveryStripEcho active={transcript.notice === "refreshing"} />
              </div>
              {/* One compact centered cluster: Page Up · follow-state control (with its resume
                  keycap inside) · Page Down. The pager hints sit directly beside the badge at the
                  standard inter-control gap instead of being distributed toward the strip edges
                  (dogfooding IDEA-007/BUG-009, 2026-08-10). */}
              <div className="follow-tail-control">
                {mode === "preview" && !isMobile && (
                  <ShortcutHint label="Page Up" shortcut={shortcutDisplay("inbox-page-up")} />
                )}
                <button
                  className={`follow-tail-chip ${followTail.state}`}
                  data-follow-tail-state={followTail.state}
                  onClick={followTail.follow}
                  aria-label={followTailControlLabel(followTail.state, followLabel)}
                  title={followTailControlTooltip(
                    followTail.state,
                    !isMobile,
                    shortcutDisplay(mode === "preview" ? "inbox-follow-latest" : "session-reading-latest"),
                  )}
                >
                  <span aria-live="polite">{followLabel}</span>
                  {!followTail.isFollowing && <span className="follow-tail-action">Follow Live Output</span>}
                  {!isMobile && !followTail.isFollowing && (
                    <kbd
                      className="follow-tail-kbd"
                      aria-hidden="true"
                      data-shortcut-hint={shortcutDisplay(mode === "preview" ? "inbox-follow-latest" : "session-reading-latest")}
                    >
                      {shortcutDisplay(mode === "preview" ? "inbox-follow-latest" : "session-reading-latest")}
                    </kbd>
                  )}
                </button>
                {mode === "preview" && !isMobile && !followTail.isFollowing && (
                  <ShortcutHint label="Page Down" shortcut={shortcutDisplay("inbox-page-down")} shortcutFirst />
                )}
              </div>
              <div className="transcript-status-trailing">
                {mode === "expanded" && isMobile && usage && (
                  <span
                    className="transcript-status-usage"
                    title={`Session usage: ${usage}`}
                    aria-label={`Usage: ${usage}`}
                  >
                    {usage}
                  </span>
                )}
                <div className="transcript-status-actions">
                  {mode === "expanded" && !isMobile && canPrompt && activePane === "reader" && (
                    <ShortcutHint
                      label="Reply"
                      shortcut={shortcutDisplay("session-reading-reply")}
                      title={`Reply (${shortcutDisplay("session-reading-reply")})`}
                      ariaLabel="Reply"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={focusComposerAtDraftEnd}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>

          {mode === "expanded" && (
            <div
              className="composer"
              onFocusCapture={() => setActivePane("composer")}
              onPointerDownCapture={() => setActivePane("composer")}
            >
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {retitleFeedback?.state === "running"
                ? "Renaming Session."
                : retitleFeedback?.state === "failed"
                  ? `Rename failed. ${retitleFeedback.message}`
                  : ""}
            </span>
            {error && <div className="composer-error" role="alert">{error}</div>}
            {retitleFeedback && (
              <div
                ref={retitleReceiptRef}
                className="retitle-receipt"
                data-status={retitleFeedback.state}
                role="region"
                aria-label="Rename Session Status"
                tabIndex={-1}
              >
                <div className="retitle-receipt-head">
                  <span className="retitle-receipt-command">/rename-session</span>
                  <span className="retitle-receipt-status">
                    {retitleFeedback.state === "running" ? "Renaming Session…" : "Rename Failed"}
                  </span>
                </div>
                {retitleFeedback.state === "failed" && (
                  <div className="retitle-receipt-details">
                    <span>{retitleFeedback.message}</span>
                    <button
                      type="button"
                      className="btn ghost sm retitle-receipt-retry"
                      onPointerDown={() => {
                        retitleRetryPointerActivationRef.current = true;
                      }}
                      onPointerCancel={() => {
                        retitleRetryPointerActivationRef.current = false;
                      }}
                      onKeyDown={() => {
                        retitleRetryPointerActivationRef.current = false;
                      }}
                      onClick={(event) => {
                        const input = inputRef.current;
                        const keyboardActivation = event.detail === 0
                          && !retitleRetryPointerActivationRef.current;
                        retitleRetryPointerActivationRef.current = false;
                        const composerFocus = keyboardActivation && input
                          ? captureComposerFocus(input)
                          : undefined;
                        retitleReceiptRef.current?.focus();
                        void requestSessionRetitle(composerFocus);
                      }}
                    >
                      Retry Rename
                    </button>
                  </div>
                )}
              </div>
            )}
            {/* Active-turn progress renders in the transcript's Working row, not as a card here —
                the composer area keeps only composer concerns (receipts, queue, input). */}
            <SessionCommandReceipts
              invocations={session.commandInvocations ?? []}
              timelineItems={items}
              historyPartial={isPartialHistory(eventWindow)}
            />
            <SteeringReceipts
              attempts={session.steeringAttempts ?? []}
              timelineItems={items}
              activeTurnId={session.activeTurnId}
              historyPartial={isPartialHistory(eventWindow)}
              pendingActions={steeringResolutionPending}
              onQueueAgain={(submissionId) => void resolveSteeringAttempt(submissionId, "queue_again")}
              onDismiss={(submissionId) => resolveSteeringAttempt(submissionId, "dismiss")}
            />
            {queuedPromptControls.length > 0 && (
              <div className="queued-list" aria-label="Queued Messages">
                {queuedPromptControls.map((q) => {
                  const availability = queuedPromptSteeringAvailability(steeringAvailabilityInput, q);
                  const editAvailability = queuedPromptEditingAvailability({
                    runnerProtocolVersion: runner?.protocolVersion,
                    runnerOnline,
                    requestBusy: composerRequestBusy,
                  }, q);
                  const locallyPromoting = queueSteeringPending.has(q.id);
                  const reserved = q.steeringState === "promoting" || q.steeringState === "uncertain";
                  const durable = q.durableDeliveryState !== undefined;
                  const queueLabel = q.durableDeliveryState === "failed"
                    ? "Delivery Failed"
                    : q.durableDeliveryState === "uncertain"
                      ? "Delivery Uncertain"
                      : q.durableDeliveryState === "pending"
                        ? "Pending Delivery"
                        : locallyPromoting || q.steeringState === "promoting"
                    ? "Steering…"
                    : q.steeringState === "uncertain"
                      ? "Delivery Uncertain"
                      : session.queueHeld ? "Held" : "Queued";
                  const queueTitle = locallyPromoting
                    ? "Steering is being submitted for this queued message."
                    : !availability.available
                      ? availability.reason
                      : "Promote this queued message into the active turn.";
                  const canCancelThis = canCancelQueued && !durable && !reserved && !locallyPromoting;
                  return (
                    <div
                      className={`queued-item${queuedEdit?.promptId === q.id ? " is-editing" : ""}`}
                      key={q.id}
                      data-testid={`queued-prompt-${q.id}`}
                      aria-current={queuedEdit?.promptId === q.id ? "true" : undefined}
                    >
                      <span
                        className={`queued-badge${session.queueHeld ? " held" : ""}`}
                        title={session.queueHeld
                          ? "Held after stopping the active turn; send another prompt to resume"
                          : queueTitle}
                      >
                        {queueLabel}
                      </span>
                      <span className="queued-text">
                        {q.hasImages && <span className="queued-img" aria-hidden="true">📎 </span>}
                        {q.text || (q.hasImages ? "(attachment)" : "")}
                        {q.durableDeliveryError && (
                          <span className="queued-error"> — {q.durableDeliveryError}</span>
                        )}
                      </span>
                      <div className="queued-actions">
                        <button
                          type="button"
                          className="btn ghost sm queued-steer"
                          disabled={!availability.available || locallyPromoting || composerRequestBusy}
                          title={queueTitle}
                          aria-label="Steer Queued Message"
                          onClick={() => void promoteQueuedPrompt(q)}
                        >
                          {locallyPromoting || q.steeringState === "promoting" ? "Steering…" : "Steer"}
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm queued-edit"
                          disabled={!editAvailability.available || queuedEdit !== null}
                          title={queuedEdit?.promptId === q.id
                            ? "This queued message is already being edited."
                            : editAvailability.available
                              ? "Edit this queued message."
                              : editAvailability.reason}
                          aria-label="Edit Queued Message"
                          onClick={() => void beginQueuedPromptEdit(q)}
                        >
                          <EditIcon size={14} />
                        </button>
                        <button
                          type="button"
                          className="queued-cancel"
                          disabled={!canCancelThis}
                          title={
                            !canCancelQueued
                              ? runnerCapabilityRequirement(
                                  runner?.protocolVersion,
                                  "queuedPromptCancellation",
                                  "Queued prompt cancellation",
                                )
                              : reserved || locallyPromoting
                                ? "Resolve steering before cancelling this queued message."
                                : durable
                                  ? "Durable delivery entries cannot be cancelled before runner admission."
                                : "Cancel this queued message."
                          }
                          aria-label={canCancelThis ? "Cancel Queued Message" : "Queued Message Cancellation Unavailable"}
                          onClick={() => void api.cancelQueuedPrompt(session.id, q.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {queuedEdit && (
              <div className="queued-edit-banner" role="status">
                <div className="queued-edit-copy">
                  <span>{queuedEditRecovered ? "Recovered Queued Message" : "Editing Queued Message"}</span>
                  {queuedEditReconciliation && queuedEditReconciliation.status !== "retryable" && (
                    <span className="queued-edit-reason">{queuedEditReconciliation.reason}</span>
                  )}
                </div>
                <div className="queued-edit-actions">
                  {queuedEditRecovered && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={queuedEditBusy}
                      onClick={() => void useRecoveredQueuedEditAsNewMessage()}
                    >
                      Use as New Message
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={queuedEditBusy}
                    onClick={cancelQueuedPromptEdit}
                  >
                    {queuedEditRecovered ? "Dismiss Recovery" : "Cancel Edit"}
                  </button>
                </div>
              </div>
            )}
            <div
              className={`composer-box${dragActive ? " drag-over" : ""}${composerAnswerActive ? " answer-mode" : ""}`}
              onDragEnter={(e) => {
                if (!canPrompt || composerAnswerActive) return;
                e.preventDefault();
                dragDepth.current += 1; // dragenter/leave fire per child; count so leaving a child doesn't clear
                setDragActive(true);
              }}
              onDragOver={(e) => {
                if (canPrompt && !composerAnswerActive) e.preventDefault(); // required for the element to be a valid drop target
              }}
              onDragLeave={() => {
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDragActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                dragDepth.current = 0;
                setDragActive(false);
                if (!canPrompt || composerAnswerActive) return;
                const files = Array.from(e.dataTransfer.files);
                if (files.length) void addFiles(files);
              }}
            >
              {pendingQuestion && (
                <ComposerQuestionResponse
                  sessionId={session.id}
                  requestId={pendingQuestion.requestId}
                  questions={composerQuestions}
                  runnerOnline={runnerOnline}
                  active={composerAnswerActive}
                  showWaiting={questionResponseStyle === "composer"}
                  inputRef={answerInputRef}
                  onEnter={enterAnswerMode}
                  onExit={exitAnswerMode}
                  onSessionUpdate={loadSession}
                />
              )}
              {!composerAnswerActive && <>
              {dragActive && (
                <div className="composer-dropzone">
                  {selectedModelSupportsImages ? "Drop images to attach" : "Selected model does not support images"}
                </div>
              )}
              {paletteOpen && (
                <SlashCommandMenu
                  listboxId={slashListboxId}
                  commands={slashMatches}
                  activeCommandId={selectedSlashCommandId}
                  hasAttachments={images.length > 0}
                  onActiveCommandChange={setActiveSlashCommandId}
                  onSelectCommand={commitSlashCommand}
                />
              )}
              {workspacePickerOpen && (
                <WorkspaceReferencePicker
                  listboxId={workspaceListboxId}
                  results={workspaceResults}
                  activeIndex={activeWorkspaceResult}
                  busy={workspaceSearchBusy}
                  error={workspaceSearchError}
                  truncated={workspaceSearchTruncated}
                  query={workspaceTrigger?.query ?? ""}
                  onSelect={selectWorkspaceCandidate}
                />
              )}
              <ImageStrip images={images} onRemove={remove} onInspectReference={setInspectedWorkspaceReference} />
              {commandPreservesAttachedImages && (
                <div className="composer-attachment-notice" role="status">
                  {DURABLE_COMMAND_ATTACHMENT_NOTICE}
                </div>
              )}
              <textarea
                ref={inputRef}
                className="composer-input"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={paletteOpen || workspacePickerOpen}
                aria-busy={steeringRequestBusy || retitlePending || undefined}
                aria-controls={workspacePickerOpen ? workspaceListboxId : paletteOpen ? slashListboxId : undefined}
                aria-activedescendant={workspacePickerOpen && workspaceResults[activeWorkspaceResult]
                  ? `${workspaceListboxId}-${activeWorkspaceResult}`
                  : paletteOpen && selectedSlashCommandId
                    ? slashCommandOptionId(slashListboxId, selectedSlashCommandId)
                    : undefined}
                value={text}
                onFocus={(event) => {
                  composerExplicitFocusTransferRef.current = false;
                  reportComposerFocus(sessionId, "focus", event.currentTarget, composerComposingRef.current);
                }}
                onBlur={handleComposerBlur}
                onScroll={() => snapshotComposerFocus("scroll")}
                onPointerDown={() => {
                  pendingComposerFocusRestoreRef.current = null;
                  composerInteractionVersionRef.current += 1;
                }}
                onCompositionStart={() => {
                  pendingComposerFocusRestoreRef.current = null;
                  composerComposingRef.current = true;
                  composerInteractionVersionRef.current += 1;
                  snapshotComposerFocus("composition-start");
                }}
                onCompositionEnd={() => {
                  composerComposingRef.current = false;
                  snapshotComposerFocus("composition-end");
                }}
                onSelect={(e) => {
                  updateComposerSelection(
                    e.currentTarget.selectionStart,
                    e.currentTarget.selectionEnd,
                  );
                  reportComposerFocus(sessionId, "selection", e.currentTarget, composerComposingRef.current);
                }}
                onChange={(e) => {
                  pendingComposerFocusRestoreRef.current = null;
                  draftDirty.current = true;
                  composerInteractionVersionRef.current += 1;
                  composerDraftVersionRef.current += 1;
                  invalidateComposerMutationRecovery(mutationKey);
                  setText(e.currentTarget.value);
                  updateComposerSelection(
                    e.currentTarget.selectionStart,
                    e.currentTarget.selectionEnd,
                  );
                  setSlashDismissedFor(null);
                  setWorkspaceDismissedFor(null);
                  if (histIdx !== -1) setHistIdx(-1); // typing exits history browsing
                }}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                placeholder={canPrompt ? "Do anything" : terminal ? `Session is ${session.status}.` : "Runner is offline."}
                rows={2}
                disabled={!canPrompt}
              />
              <div className="composer-bar">
                <div className="cbar-left">
                  <ComposerPlusMenu
                    session={session}
                    planActive={planActive}
                    planSupported={planSupported}
                    onTogglePlan={togglePlan}
                    onApply={applyConfig}
                    disabled={!canPrompt}
                    imageMimeTypes={allowedImageMimeTypes}
                    onAttachImages={addFiles}
                  />
                  <ApprovalsControl session={session} apply={applyConfig} />
                  {planActive && (
                    <button
                      type="button"
                      className="mode-pill"
                      onClick={() => togglePlan(false)}
                      title="Plan mode is on — the agent researches + proposes, no edits. Click to turn off."
                    >
                      ◒ Plan
                    </button>
                  )}
                </div>
                {/* Session-level usage lives with the session-level controls, not in the
                    transcript status strip — the otherwise-empty center of the composer bar. */}
                {usage && !isMobile && (
                  <span className="cbar-usage" title={`Session usage: ${usage}`} aria-label={`Usage: ${usage}`}>
                    {usage}
                  </span>
                )}
                <div className="cbar-right">
                  <ModelEffortControl session={session} apply={applyConfig} />
                  {dictation.supported && (
                    <button
                      type="button"
                      className={`voice-btn${dictation.recording ? " voice-recording" : ""}`}
                      onPointerDown={(e) => {
                        // Only a primary left-button press dictates — a right-click's context menu
                        // swallows the pointerup on some platforms and would leave the mic hot.
                        if (!e.isPrimary || e.button !== 0) return;
                        e.preventDefault(); // keep focus in the textarea
                        dictation.start();
                      }}
                      onPointerUp={dictation.stop}
                      onPointerCancel={dictation.stop}
                      onPointerLeave={() => dictation.recording && dictation.stop()}
                      title="Hold to Dictate"
                      aria-label="Hold to Dictate"
                      aria-pressed={dictation.recording}
                    >
                      <MicIcon size={14} />
                    </button>
                  )}
                  {session.status === "stopped" && session.stopOperation?.status !== "stop_failed" ? (
                    <button
                      type="button"
                      className="send-btn"
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => void restartFromComposer()}
                      disabled={!runnerOnline || composerRequestBusy}
                      title={restartPending ? "Restarting Session" : "Restart Session"}
                      aria-label={restartPending ? "Restarting Session" : "Restart Session"}
                    >
                      {restartPending ? <Spinner /> : <RefreshIcon size={14} />}
                    </button>
                  ) : primaryComposerAction === "send" ? (
                    <button
                      className="send-btn"
                      /* Keep focus in the textarea, like the dictation button above. On a phone
                         the tap otherwise blurs the composer, and the blur closes the keyboard
                         and brings the bottom rail back — a layout shift between touchstart and
                         click that moved this button out from under the finger, so the first tap
                         collapsed the keyboard instead of sending. Retained focus also keeps the
                         keyboard open after sending, which is the chat convention. */
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={queuedEdit ? saveQueuedPromptEdit : send}
                      disabled={!canSend || composerRequestBusy || (queuedEdit !== null && !queuedEditRetryable)}
                      title={queuedEdit
                        ? !queuedEditRetryable
                          ? queuedEditReconciliation && "reason" in queuedEditReconciliation
                            ? queuedEditReconciliation.reason
                            : "This recovered queued edit cannot be retried yet."
                          : enterKeySetting === "send"
                          ? "Save Queued Message (Enter)"
                          : isTouchPhone ? "Save Queued Message" : "Save Queued Message (Shift+Enter)"
                        : enterKeySetting === "send"
                          ? "Send (Enter)"
                          : isTouchPhone ? "Send" : "Send (Shift+Enter)"}
                      aria-label={queuedEdit ? "Save Queued Message" : "Send"}
                    >
                      {busy || queuedEditBusy ? <Spinner /> : <ArrowUpIcon size={14} />}
                    </button>
                  ) : (
                    <button
                      className={`send-btn stop-turn-btn${primaryComposerAction === "stopping" ? " is-stopping" : ""}`}
                      /* Same tap-vs-reflow race as the Send button it replaces in this slot. */
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => void stopTurn()}
                      disabled={primaryComposerAction === "stopping"}
                      title={primaryComposerAction === "stopping"
                        ? "Stopping Turn"
                        : `Stop Turn (${shortcutDisplay("stop-turn")})`}
                      aria-label={primaryComposerAction === "stopping" ? "Stopping Turn" : "Stop Turn"}
                    >
                      {primaryComposerAction === "stopping" ? <Spinner /> : <StopTurnIcon size={14} />}
                    </button>
                  )}
                </div>
              </div>
              </>}
            </div>
            {/* No context footer under the composer: project identity lives in the session bar's
                breadcrumb, and git, agent, model, and host facts live in the pinned summary. */}
            </div>
          )}
        </div>

        {mode === "expanded" && <RightPanel
          state={rightPanel}
          session={session}
          earlierActivityUnloaded={isPartialHistory(eventWindow)}
          sourceLocation={sourceLocation}
          onOpenSourceLocation={openSourceLocation}
          onClearSourceLocation={clearSourceLocation}
          runnerOnline={runnerOnline}
          runnerProtocolVersion={runner?.protocolVersion}
          git={git}
          onOpenTerminal={onOpenTerminal}
          onInsertSideChatDraft={insertSideChatDraft}
          onAttachWorkspaceReference={workspaceReferencesSupported ? attachWorkspaceTarget : undefined}
          items={items}
          parentTurnEventIds={backgroundParentTurnEventIds}
          onOpenParentTurn={revealBackgroundParentTurn}
          backgroundInventoryError={backgroundInventoryError}
          onRetryBackgroundInventory={retryBackgroundInventory}
        />}
      </div>
      {mode === "expanded" && inspectedWorkspaceReference && (
        <Modal
          title="Workspace Reference"
          onClose={() => setInspectedWorkspaceReference(null)}
          footer={<button className="btn primary" type="button" onClick={() => setInspectedWorkspaceReference(null)}>Done</button>}
        >
          <dl className="workspace-reference-details">
            <dt>Path</dt><dd><code>{inspectedWorkspaceReference.path}</code></dd>
            <dt>Reference Type</dt><dd>{inspectedWorkspaceReference.kind === "diff" ? "Diff Lines" : inspectedWorkspaceReference.kind === "lines" ? "File Lines" : inspectedWorkspaceReference.kind === "directory" ? "Folder" : "File"}</dd>
            {inspectedWorkspaceReference.startLine !== undefined && (
              <><dt>Line Range</dt><dd>{inspectedWorkspaceReference.startLine}–{inspectedWorkspaceReference.endLine}</dd></>
            )}
            {inspectedWorkspaceReference.side && (
              <><dt>Diff Side</dt><dd>{inspectedWorkspaceReference.side === "left" ? "Base" : "Worktree"}</dd></>
            )}
            {inspectedWorkspaceReference.diffScope && (
              <><dt>Diff Scope</dt><dd>{inspectedWorkspaceReference.diffScope.replace("_", " ")}</dd></>
            )}
            <dt>Revision</dt><dd><code>{inspectedWorkspaceReference.targetFingerprint.slice(0, 12)}</code></dd>
          </dl>
          <p className="muted">The runner will verify this path, workspace, and revision again before delivery.</p>
          {inspectedWorkspaceReference.kind !== "directory" && inspectedWorkspaceReference.kind !== "diff" && (
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                openSourceLocation({ path: inspectedWorkspaceReference.path, line: inspectedWorkspaceReference.startLine });
                rightPanel.show("files");
                setInspectedWorkspaceReference(null);
              }}
            >
              Open in Files
            </button>
          )}
        </Modal>
      )}
      {mode === "expanded" && messageAction && (
        <MessageActionDialog
          key={`${messageAction.mode}-${messageAction.item.id}`}
          action={messageAction}
          existingDraftPresent={Boolean(text || images.length)}
          canPrepareResend={canPrompt}
          busy={busy}
          returnFocusRef={messageActionReturnFocusRef}
          onClose={() => closeMessageAction(true)}
          onPrepareResend={prepareResend}
          onPrepareFork={(draft) => prepareFork(messageAction.forkTurn!, draft)}
        />
      )}
    </div>
  );
}

function MessageActionDialog({
  action,
  existingDraftPresent,
  canPrepareResend,
  busy,
  returnFocusRef,
  onClose,
  onPrepareResend,
  onPrepareFork,
}: {
  action: MessageActionState;
  existingDraftPresent: boolean;
  canPrepareResend: boolean;
  busy: boolean;
  returnFocusRef: { current: HTMLElement | null };
  onClose: () => void;
  onPrepareResend: (draft: { text: string; images: PromptImageInput[] }) => void;
  onPrepareFork: (draft: { text: string; images: PromptImageInput[] }) => Promise<void>;
}) {
  const [draftText, setDraftText] = useState(action.item.text);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const submitLock = useRef(false);
  const retainedImages = action.item.images ?? [];
  const formId = `message-action-${action.item.id}`;

  const submit = async () => {
    if (submitLock.current) return;
    if (!draftText.trim() && retainedImages.length === 0) {
      setDialogError("Enter a message or retain at least one attachment.");
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    setDialogError(null);
    const draft = { text: draftText, images: retainedImages };
    try {
      if (action.mode === "resend") onPrepareResend(draft);
      else await onPrepareFork(draft);
    } catch (cause) {
      if (cause instanceof AmbiguousForkError) setRetryBlocked(true);
      setDialogError((cause as Error).message);
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={action.mode === "resend" ? "Edit as a new turn" : "Edit in a conversation fork"}
      onClose={submitting ? () => {} : onClose}
      returnFocusRef={returnFocusRef}
      footer={(
        <>
          <button className="btn ghost" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="btn primary"
            type="submit"
            form={formId}
            disabled={submitting || retryBlocked || (action.mode === "fork" && busy) || (action.mode === "resend" && !canPrepareResend)}
          >
            {submitting ? "Preparing…" : action.mode === "resend" ? "Load into Composer" : "Create Fork"}
          </button>
        </>
      )}
    >
      <form
        id={formId}
        className="message-action-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="muted">
          {action.mode === "resend"
            ? "This prepares a deliberate new turn in the current conversation. Nothing is sent until you press Send."
            : `The new conversation starts after turn ${action.forkTurn}. Nothing is sent until you review the child draft and press Send.`}
        </p>
        {existingDraftPresent && action.mode === "resend" && (
          <p className="message-action-warning" role="note">Loading this message replaces the current composer draft.</p>
        )}
        {action.mode === "resend" && !canPrepareResend && (
          <p className="message-action-warning" role="status">This session cannot accept a new turn right now.</p>
        )}
        <label className="field-label" htmlFor={`${formId}-text`}>Message</label>
        <textarea
          id={`${formId}-text`}
          className="input message-action-input"
          value={draftText}
          onChange={(event) => setDraftText(event.target.value)}
          rows={7}
          autoFocus
        />
        {retainedImages.length > 0 && (
          <p className="muted">Retains {retainedImages.length} original attachment{retainedImages.length === 1 ? "" : "s"}.</p>
        )}
        {dialogError && <div className="form-error" role="alert">{dialogError}</div>}
      </form>
    </Modal>
  );
}

/** Assigns durable Project organization without changing the session's execution Location. */
function ProjectChip({ session, onOpenInbox }: { session: SessionView; onOpenInbox: () => void }) {
  const projectsSupported = useStoreSelector((state) => state.projectsSupported);
  return projectsSupported
    ? <DurableProjectChip session={session} onOpenInbox={onOpenInbox} />
    : <LegacyWorkspaceChip session={session} />;
}

/**
 * The breadcrumb's Project segment: the name navigates back to this Project's split in the
 * Inbox, and a persistent vertical-ellipsis trigger opens a small actions menu (Manage Project /
 * Move Session). Reassignment moved out of the name itself so the crumb behaves like a breadcrumb.
 */
function DurableProjectChip({ session, onOpenInbox }: { session: SessionView; onOpenInbox: () => void }) {
  const projects = useStoreSelector((state) => state.projects);
  const { navigate, setInboxSplit } = useStoreActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const menu = useAccessibleMenu(menuOpen, setMenuOpen, "crumb-project-menu");
  const current = session.projectId ? projects.get(session.projectId) : undefined;
  const currentName = current?.name ?? session.projectName ?? "No Project";

  return (
    <div className="crumb-project">
      <button
        type="button"
        className="cctx-item cctx-chip"
        title={`Open ${currentName} in the Inbox`}
        onClick={() => {
          setInboxSplit(session.projectId ? durableInboxProjectKey(session.projectId) : INBOX_NO_PROJECT_SPLIT_KEY);
          onOpenInbox();
        }}
      >
        <span className="crumb-project-label">{currentName}</span>
      </button>
      <button
        ref={menu.triggerRef}
        type="button"
        className="crumb-project-actions"
        title="Project Actions"
        aria-label="Project Actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menu.menuId}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <MoreVerticalIcon size={14} />
      </button>
      {menuOpen && (
        <>
          <div className="menu-backdrop" onClick={() => menu.close(true)} />
          <div
            className="menu-pop"
            id={menu.menuId}
            ref={menu.menuRef}
            role="menu"
            aria-label="Project Actions"
            onKeyDown={menu.onMenuKeyDown}
          >
            <button
              className="menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                menu.close(false);
                navigate(session.projectId ? { name: "projects", id: session.projectId } : { name: "projects" });
              }}
            >
              Manage Project
            </button>
            <button
              className="menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                menu.close(false);
                setMoveOpen(true);
              }}
            >
              Move Session…
            </button>
          </div>
        </>
      )}
      {moveOpen && (
        <MoveToProjectDialog
          session={session}
          onClose={() => setMoveOpen(false)}
          returnFocusRef={menu.triggerRef}
        />
      )}
    </div>
  );
}

function MoveToProjectDialog({ session, onClose, returnFocusRef }: {
  session: SessionView;
  onClose: () => void;
  /** The crumb's ⋯ trigger — the menu item that opened this dialog unmounts with its menu. */
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const projects = useStoreSelector((state) => state.projects);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = useMemo(() => sessionProjectChoices(session, projects.values()), [session, projects]);

  const pick = async (projectId: string | null, linkLocation = false) => {
    if (busy || !shouldSubmitProjectAssignment(session.projectId, projectId, linkLocation)) return;
    const target = projectId ? projects.get(projectId) : undefined;
    const audienceConfirmation = target ? projectAssignmentAudienceConfirmation(session, target) : null;
    if (target && (audienceConfirmation || linkLocation)) {
      const accepted = await confirm({
        title: linkLocation
          ? `Link Location and Move to ${target.name}?`
          : audienceConfirmation === "team"
            ? `Share session with ${target.name}?`
            : `Confirm move to ${target.name}?`,
        message: linkLocation
          ? `This registers the imported working directory as a Location in “${target.name}” without moving files. This can also change how future imported sessions in this directory are filed.${audienceConfirmation === "team" ? " The team will also be able to read the transcript." : ""}`
          : audienceConfirmation === "team"
            ? `Moving this session to the team-owned Project “${target.name}” lets that team read its transcript. Files and the execution Location stay unchanged.`
            : `This control plane does not report sharing details. Moving this session to “${target.name}” may change who can read its transcript. Files and the execution Location stay unchanged.`,
        confirmLabel: linkLocation
          ? "Link Location and Move"
          : audienceConfirmation === "team" ? "Share and Move" : "Confirm Move",
      });
      if (!accepted) return;
    }
    setBusy(true);
    setError(null);
    try {
      await persistProjectAssignment(api.setProject, session.id, projectId, linkLocation);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const options: ChoiceCardOption<string>[] = [
    {
      value: "",
      title: "No Project",
      description: "Keep this session outside Project organization.",
      disabled: busy,
    },
    ...choices.map((choice) => ({
      value: choice.id,
      title: choice.name,
      description: `${projectAudienceLabel(choice.audience) ? `${projectAudienceLabel(choice.audience)}. ` : ""}${
        choice.compatible
          ? "Linked to this exact Location."
          : choice.linkable
            ? "Link this imported Location when moving."
            : session.adopted && session.importLocationReady !== true
              ? "Waiting for the runner to verify this imported Location."
            : choice.current
              ? "Current assignment; exact Location not linked."
              : "Project management permission is required to link this Location."}`,
      disabled: busy || (!choice.compatible && !choice.linkable),
      disabledReason: busy || choice.compatible
        ? undefined
        : choice.linkable
          ? undefined
          : session.adopted && session.importLocationReady !== true
            ? "Waiting for the runner to verify this imported Location."
            : "Project management permission is required to link this Location.",
    })),
  ];

  return (
    <Modal
      title="Move to Project"
      onClose={() => { if (!busy) onClose(); }}
      returnFocusRef={returnFocusRef}
      footer={<button className="btn ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>}
    >
      <div className="project-assignment-menu project-move-list">
        <p className="muted project-assignment-note">
          Changing this organizes the session without moving files or changing its execution Location. Team sharing is confirmed separately.
        </p>
        <ChoiceCards
          label="Project"
          options={options}
          value={session.projectId ?? ""}
          onChange={(picked) => {
            const choice = choices.find((candidate) => candidate.id === picked);
            void pick(picked === "" ? null : picked, choice?.linkable ?? false);
          }}
        />
        {choices.length === 0 && (
          <p className="muted project-assignment-empty">No Project is linked to this session's exact Location.</p>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

/** Preserves compatibility-only Workspace re-filing when the mobile Project crumb is absent. */
function LegacyWorkspaceMoveDialog({ session, onClose, returnFocusRef }: {
  session: SessionView;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const runner = useStoreSelector((state) => state.runners.get(session.runnerId));
  const workspaces = runner?.workspaces ?? [];
  const runnerOnline = runner?.status === "online";
  const browseSupported = runnerSupportsProtocol(runner?.protocolVersion, "directoryListing");
  const sessionAgent = runner?.agents.find((agent) => agent.id === session.agentId);
  const browseDistro = sessionAgent?.context?.kind === "wsl" ? sessionAgent.context.distro : undefined;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [browsedPath, setBrowsedPath] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetCreate = () => {
    setCreating(false);
    setName("");
    setBrowsedPath(null);
    setBrowsing(false);
    setError(null);
  };

  const pick = async (workspaceId: string | null) => {
    if (busy || workspaceId === session.workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      await api.setWorkspace(session.id, workspaceId);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createWorkspaceGroup = async () => {
    const trimmed = name.trim();
    if (busy || !trimmed || !browsedPath) return;
    setBusy(true);
    setError(null);
    try {
      const { workspace } = await api.createWorkspace(session.runnerId, { name: trimmed, path: browsedPath });
      await api.setWorkspace(session.id, workspace.id);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const options: ChoiceCardOption<string>[] = [
    {
      value: "",
      title: "No Workspace",
      description: "Keep this session outside legacy Workspace grouping.",
      disabled: busy,
    },
    ...workspaces.map((workspace) => ({
      value: workspace.id,
      title: workspace.name,
      description: shortenPath(workspace.path),
      disabled: busy,
    })),
  ];

  return (
    <Modal
      title={creating ? "Create Workspace" : "Move to Workspace"}
      onClose={() => { if (!busy) onClose(); }}
      returnFocusRef={returnFocusRef}
      footer={creating ? (
        <>
          <button className="btn ghost" type="button" onClick={resetCreate} disabled={busy}>Cancel</button>
          <button
            className="btn primary"
            type="button"
            onClick={() => void createWorkspaceGroup()}
            disabled={busy || !name.trim() || !browsedPath}
          >
            {busy ? "Creating…" : "Create Workspace"}
          </button>
        </>
      ) : (
        <>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              setCreating(true);
              setError(null);
            }}
            disabled={!runnerOnline}
            title={runnerOnline ? undefined : "Runner offline — start it to browse for a folder"}
          >
            New Workspace…
          </button>
          <button className="btn ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </>
      )}
    >
      {creating ? (
        <div className="project-assignment-menu project-move-list">
          <label className="field-label" htmlFor="legacy-workspace-name">Workspace Name</label>
          <input
            id="legacy-workspace-name"
            className="input"
            value={name}
            autoFocus
            spellCheck={false}
            placeholder="Workspace Name"
            onChange={(event) => setName(event.target.value)}
          />
          {browsedPath ? (
            <div className="ws-chosen">
              <span className="ws-chosen-path" title={browsedPath}>{shortenPath(browsedPath)}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Clear Workspace Selection"
                title="Clear — pick another folder"
                onClick={() => setBrowsedPath(null)}
              >
                ✕
              </button>
            </div>
          ) : browsing ? (
            <DirectoryPicker
              runnerId={session.runnerId}
              protocolVersion={runner?.protocolVersion}
              distro={browseDistro}
              onPick={(path) => {
                setBrowsedPath(path);
                setBrowsing(false);
              }}
              onCancel={() => setBrowsing(false)}
            />
          ) : (
            <button
              type="button"
              className="btn ghost"
              onClick={() => setBrowsing(true)}
              disabled={!browseSupported}
              title={browseSupported
                ? "Browse the runner for a workspace folder"
                : runnerCapabilityRequirement(runner?.protocolVersion, "directoryListing", "Directory browsing")}
            >
              Browse for a Folder…
            </button>
          )}
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      ) : (
        <div className="project-assignment-menu project-move-list">
          <p className="muted project-assignment-note">
            Changing this legacy grouping does not move files or change the session's execution path.
          </p>
          <ChoiceCards
            label="Workspace"
            options={options}
            value={session.workspaceId ?? ""}
            onChange={(picked) => { void pick(picked === "" ? null : picked); }}
          />
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

/** The legacy composer footer workspace chip shows the session's old workspace grouping and opens
 * a small popover to re-file it. The assignment is CP-owned view state (no runner round-trip), so
 * it works even while the runner is offline — the store's last-registered workspace list is fine. */
function LegacyWorkspaceChip({ session }: { session: SessionView }) {
  const api = useApi();
  const runner = useStoreSelector((s) => s.runners.get(session.runnerId));
  const [open, setOpen] = useState(false);
  const workspaces = runner?.workspaces ?? [];
  const runnerOnline = runner?.status === "online";
  const browseSupported = runnerSupportsProtocol(runner?.protocolVersion, "directoryListing");
  // Browse in the session agent's context: a WSL-context agent must browse its distro, not the
  // runner's native host (mirrors NewSessionDialog). Without this the picker lists C:\ for WSL sessions.
  const sessionAgent = runner?.agents.find((a) => a.id === session.agentId);
  const browseDistro = sessionAgent?.context?.kind === "wsl" ? sessionAgent.context.distro : undefined;

  // Compatibility-only workspace grouping for control planes without durable Projects.
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [browsedPath, setBrowsedPath] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu = useAccessibleMenu(open, setOpen, "workspace-menu");

  const resetCreate = () => {
    setCreating(false);
    setName("");
    setBrowsedPath(null);
    setBrowsing(false);
    setBusy(false);
    setError(null);
  };
  const close = () => {
    menu.close(true);
    resetCreate();
  };
  const focusWorkspaceControl = (selector: string) => {
    window.setTimeout(() => menu.menuRef.current?.querySelector<HTMLElement>(selector)?.focus(), 0);
  };
  const cancelCreate = () => {
    resetCreate();
    focusWorkspaceControl('[role="menuitemradio"][aria-checked="true"], [role="menuitem"]');
  };
  const cancelBrowse = () => {
    setBrowsing(false);
    focusWorkspaceControl(".ws-browse");
  };
  const chooseBrowsedPath = (path: string) => {
    setBrowsedPath(path);
    setBrowsing(false);
    focusWorkspaceControl(".ws-chosen button");
  };
  const clearBrowsedPath = () => {
    setBrowsedPath(null);
    focusWorkspaceControl(".ws-browse");
  };

  const pick = (workspaceId: string | null) => {
    close();
    if (workspaceId !== session.workspaceId) void api.setWorkspace(session.id, workspaceId);
  };

  const createWorkspaceGroup = async () => {
    const trimmed = name.trim();
    if (busy || !trimmed || !browsedPath) return;
    setBusy(true);
    setError(null);
    try {
      const { workspace } = await api.createWorkspace(session.runnerId, { name: trimmed, path: browsedPath });
      // Apply the new compatibility group without changing the pinned execution path.
      await api.setWorkspace(session.id, workspace.id);
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="plus-menu">
      <button
        ref={menu.triggerRef}
        type="button"
        className="cctx-item cctx-chip"
        title="Workspace — change legacy grouping"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        aria-haspopup={creating ? "dialog" : "menu"}
        aria-expanded={open}
        aria-controls={menu.menuId}
      >
        <FolderSolidIcon className="cctx-icon" size={13} />
        {session.workspaceName ?? "No Workspace"}
        <span className="cctx-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <>
          <div className="plus-backdrop" onClick={close} />
          <div
            className={`plus-pop narrow${creating ? " creating" : ""}`}
            id={menu.menuId}
            ref={menu.menuRef}
            role={creating ? "dialog" : "menu"}
            aria-label={creating ? "Create Workspace" : "Choose Workspace"}
            onKeyDown={creating
              ? (event) => {
                  if (event.key !== "Escape" || browsing) return;
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                }
              : menu.onMenuKeyDown}
          >
            {creating ? (
              <div className="ws-create">
                <div className="plus-section">New Workspace</div>
                <input
                  className="ws-create-name"
                  value={name}
                  autoFocus
                  spellCheck={false}
                  placeholder="Workspace Name"
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Workspace Name"
                />
                {browsedPath ? (
                  <div className="ws-chosen">
                    <span className="ws-chosen-path" title={browsedPath}>
                      {shortenPath(browsedPath)}
                    </span>
                    <button type="button" className="icon-btn" aria-label="Clear Workspace Selection" title="Clear — pick another folder" onClick={clearBrowsedPath}>
                      ✕
                    </button>
                  </div>
                ) : browsing ? (
                  <DirectoryPicker
                    runnerId={session.runnerId}
                    protocolVersion={runner?.protocolVersion}
                    distro={browseDistro}
                    onPick={chooseBrowsedPath}
                    onCancel={cancelBrowse}
                  />
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm ws-browse"
                    onClick={() => setBrowsing(true)}
                    disabled={!browseSupported}
                    title={
                      browseSupported
                        ? "Browse the runner for a workspace folder"
                        : runnerCapabilityRequirement(runner?.protocolVersion, "directoryListing", "Directory browsing")
                    }
                  >
                    Browse for a Folder…
                  </button>
                )}
                {error && <div className="form-error" role="alert">{error}</div>}
                <div className="ws-create-actions">
                  <button type="button" className="btn ghost sm" onClick={cancelCreate} disabled={busy}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn primary sm"
                    onClick={() => void createWorkspaceGroup()}
                    disabled={busy || !name.trim() || !browsedPath}
                  >
                    {busy ? "Creating…" : "Create"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="plus-section" role="presentation">Workspace</div>
                <button
                  type="button"
                  className={`plus-item${session.workspaceId == null ? " on" : ""}`}
                  role="menuitemradio"
                  aria-checked={session.workspaceId == null}
                  onClick={() => pick(null)}
                >
                  <span className="plus-check">{session.workspaceId == null ? "✓" : ""}</span>
                  <span className="plus-item-body">
                    <span className="plus-item-title">No Workspace</span>
                    <span className="plus-item-desc">Not Grouped</span>
                  </span>
                </button>
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    className={`plus-item${session.workspaceId === ws.id ? " on" : ""}`}
                    role="menuitemradio"
                    aria-checked={session.workspaceId === ws.id}
                    onClick={() => pick(ws.id)}
                  >
                    <span className="plus-check">{session.workspaceId === ws.id ? "✓" : ""}</span>
                    <span className="plus-item-body">
                      <span className="plus-item-title">{ws.name}</span>
                      <span className="plus-item-desc" title={ws.path}>
                        {shortenPath(ws.path)}
                      </span>
                    </span>
                  </button>
                ))}
                <div className="plus-divider" />
                <button
                  type="button"
                  className="plus-item plus-add"
                  role="menuitem"
                  disabled={!runnerOnline}
                  title={runnerOnline ? undefined : "Runner offline — start it to browse for a folder"}
                  onClick={() => setCreating(true)}
                >
                  <span className="plus-check" aria-hidden="true">
                    ＋
                  </span>
                  <span className="plus-item-body">
                    <span className="plus-item-title">New Workspace</span>
                  </span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Codex-style "+" menu in the composer: Attach Image, Plan mode, and the cost budget. */
function ComposerPlusMenu({
  session,
  planActive,
  planSupported,
  onTogglePlan,
  onApply,
  disabled,
  imageMimeTypes,
  onAttachImages,
}: {
  session: SessionView;
  planActive: boolean;
  planSupported: boolean;
  onTogglePlan: (on?: boolean) => void;
  onApply: (patch: Partial<SessionConfig>) => void;
  disabled: boolean;
  /** Exactly the types the connected runner and selected model accept; empty when images cannot be sent. */
  imageMimeTypes: readonly string[];
  onAttachImages: (files: File[]) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const popover = useDismissiblePopover(open, setOpen, "composer-modes-popover");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachDescriptionId = useId();
  const imagesSupported = imageMimeTypes.length > 0;
  // Attachment follows the composer, exactly as paste (a disabled textarea) and drop (its own
  // `canPrompt` guard) already do. `disabled` can flip while the panel — or the native chooser —
  // is already open, so the item and the change handler are gated separately.
  const canAttach = !disabled && imagesSupported;
  return (
    <div className="plus-menu">
      {/*
        The one image ingress that works on a phone: paste and drag-and-drop have no reliable
        mobile equivalent. Mounted OUTSIDE the `open &&` panel so activating the item can close the
        menu without unmounting the input the native chooser is attached to, and clipped rather
        than `display: none`, which some browsers refuse to open a picker for.
      */}
      <input
        ref={fileInputRef}
        className="composer-attach-input"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        // No `capture`: it would force the camera and hide the photo library and file browser.
        // `accept` mirrors the session capability, so the chooser cannot offer a type that
        // validation would reject downstream.
        accept={imageMimeTypes.join(",")}
        onChange={(event) => {
          const input = event.currentTarget;
          const files = Array.from(input.files ?? []);
          // Clear before dispatching so re-picking the same file after removing it still fires
          // `change`; a cancelled picker fires nothing and leaves the draft untouched.
          input.value = "";
          // The runner can go offline, or the session end, while the chooser is up: a re-render
          // has already installed this handler with the new `canAttach`, so the late selection is
          // dropped rather than landing in a composer that cannot send it.
          if (canAttach && files.length) void onAttachImages(files);
        }}
      />
      <button
        ref={popover.triggerRef}
        type="button"
        className="plus-btn"
        disabled={disabled}
        aria-label="Add and Modes"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popover.panelId}
        title="Attach, Modes & Budget"
        onClick={popover.toggle}
        onKeyDown={popover.onTriggerKeyDown}
      >
        <PlusIcon size={16} />
      </button>
      {open && (
        <>
          <div className="plus-backdrop" onClick={() => popover.close(true)} />
          <div
            className="plus-pop"
            id={popover.panelId}
            ref={popover.panelRef}
            role="dialog"
            aria-label="Session Attachments, Modes, and Guardrails"
            onKeyDown={popover.onPanelKeyDown}
          >
            <div className="plus-section">Attach</div>
            <button
              type="button"
              className="plus-item"
              // The item carries its own explanation, so the name is set explicitly rather than
              // computed from the row's text.
              aria-label="Attach Image"
              aria-describedby={attachDescriptionId}
              disabled={!canAttach}
              onClick={() => {
                fileInputRef.current?.click();
                popover.close(true);
              }}
            >
              <span className="plus-check"><ImageIcon size={14} /></span>
              <span className="plus-item-body">
                <span className="plus-item-title">Attach Image</span>
                <span className="plus-item-desc" id={attachDescriptionId}>
                  {!imagesSupported
                    ? "The selected model does not support image input."
                    : disabled
                      ? "This session cannot accept a prompt right now."
                      : `Photos, camera, or files · up to ${MAX_PROMPT_IMAGES}`}
                </span>
              </span>
            </button>

            {planSupported && (
              <>
                <div className="plus-section">Modes</div>
                <button
                  type="button"
                  className={`plus-item${planActive ? " on" : ""}`}
                  role="checkbox"
                  aria-checked={planActive}
                  onClick={() => {
                    onTogglePlan();
                    popover.close(true);
                  }}
                >
                  <span className="plus-check">{planActive ? "✓" : ""}</span>
                  <span className="plus-item-body">
                    <span className="plus-item-title">Plan Mode</span>
                    <span className="plus-item-desc">
                      Research + propose a plan, no edits. Or type <code>/plan</code>.
                    </span>
                  </span>
                </button>
              </>
            )}

            <div className="plus-section">Guardrails</div>
            <GuardrailInput
              prefix="$"
              step="0.5"
              value={session.costBudgetUsd}
              hint="pause + ask when spend reaches this"
              onCommit={(v) => onApply({ costBudgetUsd: v })}
            />
            <CheckpointsInput
              value={session.costCheckpointsUsd ?? null}
              approvedUsd={session.costCheckpointApprovedUsd ?? null}
              onCommit={(list) => onApply({ costCheckpointsUsd: list })}
            />
            <GuardrailInput
              prefix="#"
              step="1"
              integer
              value={session.maxToolCalls}
              hint={
                "pause + ask after N tool calls" +
                (session.maxToolCalls != null && session.toolCallCount != null ? ` · ${session.toolCallCount} used` : "")
              }
              onCommit={(v) => onApply({ maxToolCalls: v })}
            />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Soft cost checkpoints as a comma-separated dollar list ("1, 2.5"). Each parks the session once
 * with a Continue/Stop card ahead of the hard budget; an empty commit clears them.
 */
function CheckpointsInput({
  value,
  approvedUsd,
  onCommit,
}: {
  value: number[] | null;
  approvedUsd: number | null;
  onCommit: (list: number[]) => void;
}) {
  const live = (value ?? []).join(", ");
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const list = draft.split(/[\s,]+/).map(Number).filter((usd) => Number.isFinite(usd) && usd > 0);
    setDraft(null);
    if (list.join(",") !== (value ?? []).join(",")) onCommit(list);
  };
  return (
    <div className="plus-budget">
      <span className="plus-budget-prefix">$…</span>
      <input
        type="text"
        inputMode="decimal"
        placeholder="none"
        aria-label="Cost Checkpoints"
        value={draft ?? live}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }}
      />
      <span className="plus-budget-hint">
        {"pause + ask once at each amount"}{approvedUsd != null ? ` · approved through $${approvedUsd.toFixed(2)}` : ""}
      </span>
    </div>
  );
}

/**
 * A guardrail numeric input. A controlled draft shadows the server value only WHILE editing, so a
 * WebSocket echo (or another dashboard's change) can't remount the input mid-edit and discard
 * typing; unfocused, it tracks the live value. Typos (badInput like "1e", or sub-1 values for
 * integer fields that would floor into the clear sentinel) are a no-op + display resync — only a
 * deliberate empty/0 clears. Commits 0 to mean "clear" (the CP maps ≤0 to unlimited).
 */
function GuardrailInput({
  prefix,
  step,
  integer,
  value,
  hint,
  onCommit,
}: {
  prefix: string;
  step: string;
  integer?: boolean;
  value: number | null | undefined;
  hint: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null); // null = not editing
  return (
    <div className="plus-budget">
      <span className="plus-budget-prefix">{prefix}</span>
      <input
        type="number"
        min="0"
        step={step}
        placeholder="∞"
        value={draft ?? (value ?? "")}
        onFocus={(e) => setDraft(e.target.value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          if (draft === null) return;
          const v = parseFloat(draft);
          if (e.target.validity.badInput || (integer && Number.isFinite(v) && v > 0 && v < 1)) {
            setDraft(null); // typo — resync to the live value, don't clear an armed limit
            return;
          }
          setDraft(null);
          onCommit(Number.isFinite(v) && v > 0 ? (integer ? Math.floor(v) : v) : 0);
        }}
      />
      <span className="plus-budget-hint">{hint}</span>
    </div>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="transcript-skeleton" role="status" aria-label="Loading Session Activity">
      <span className="sr-only">Loading Session Activity…</span>
      <div className="transcript-skeleton-row user" aria-hidden="true"><span /><span /></div>
      <div className="transcript-skeleton-row agent" aria-hidden="true"><span /><span /><span /></div>
      <div className="transcript-skeleton-row agent short" aria-hidden="true"><span /><span /></div>
    </div>
  );
}

/** Head of a bounded window: the transcript continues above, but only on request. Rendering it as a
 * real button keeps the reach-back available without a pointer scroll. */
function EarlierActivityControl({
  loading,
  error,
  onLoad,
}: {
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}) {
  return (
    <div className="transcript-earlier-activity">
      <button
        className="btn ghost sm"
        type="button"
        disabled={loading}
        onClick={onLoad}
      >
        {loading ? "Loading Earlier Activity…" : "Load Earlier Activity"}
      </button>
      {error && <span role="status">{error}</span>}
    </div>
  );
}

function TranscriptLoadNotice({
  kind,
  error,
  canRetry,
  onRetry,
}: {
  kind: "stale" | "error";
  error: string | null;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const message = kind === "stale"
    ? "Showing cached activity while disconnected."
    : `Could not refresh activity${error ? `: ${error}` : "."}`;
  return (
    <div className={`transcript-load-notice ${kind}`} role="status">
      <span>{message}</span>
      {kind === "error" && (
        <button className="btn ghost sm" type="button" disabled={!canRetry} onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}

/** Reconnect/reopen recovery pill in a permanently-present normal-flow slot immediately above
 * the transcript status strip. The pill markup is ALWAYS mounted so the slot's height is the
 * pill's real rendered height at the current pane width and font scale — a wrapped label or a
 * rem-scaled root font simply makes the slot taller. Activity toggles only visibility and the
 * live-region text, never layout: showing or hiding recovery cannot shift scroll position or
 * follow state by construction, and the pill can never overlap transcript content because it is
 * not an overlay. The visual pill stays decorative; the sr-only sibling owns the live status
 * semantics through a text swap, matching the follow chip's permanently-mounted live region.
 * The sr-only region deliberately lives OUTSIDE the slot: height-constrained panes collapse the
 * slot with `display: none` (see the transcript-pane container query), and the live region must
 * keep announcing identically in that compact mode. */
function TranscriptRecoveryNotice({ active }: { active: boolean }) {
  return (
    <>
      <div className={`transcript-recovery-slot${active ? " active" : ""}`}>
        <div className="transcript-recovery-notice" aria-hidden="true">
          <span className="transcript-recovery-dot" />
          <span>Checking for Missed Activity…</span>
        </div>
      </div>
      <span className="sr-only" role="status">{active ? "Checking for Missed Activity…" : ""}</span>
    </>
  );
}

/** Compact-mode echo of the recovery notice inside the status strip's leading cell. Hidden in
 * normal panes; a height-constrained transcript pane swaps it in for the collapsed slot via CSS
 * (the strip is a persistent status surface and the only non-overlapping placement left in a
 * pane too short for the pill band). Decorative like the pill — the sr-only live region in
 * TranscriptRecoveryNotice owns the announcements in both modes — and its activity toggle is
 * visibility-only, so neither mode ever changes layout when recovery starts or stops. */
function TranscriptRecoveryStripEcho({ active }: { active: boolean }) {
  return (
    <span className={`transcript-recovery-strip-echo${active ? " active" : ""}`} aria-hidden="true">
      <span className="transcript-recovery-dot" />
      <span>Checking for Missed Activity…</span>
    </span>
  );
}
