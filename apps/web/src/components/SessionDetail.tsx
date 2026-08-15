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
  PROMPT_IMAGE_MIME_TYPES,
  isPolicyApproval,
  isTerminal,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  providerSupportsConversationFork,
  type PromptImageInput,
  type QueuedPromptView,
  type SessionConfig,
  type SessionView,
  type SourceLocation,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { isRebuiltEventsArray, useStoreActions, useStoreSelector } from "../store.js";
import { relativeTime, shortenPath } from "../format.js";
import { runnerDisplay } from "../runners.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { type TimelineItem } from "../timeline.js";
import { useTimeline } from "./useTimeline.js";
import { BackgroundWorkBadge, Empty, Modal, Spinner, StatusBadge } from "./common.js";
import { EventTimeline, type TimelineRevealRequest } from "./EventTimeline.js";
import { isTimelineSessionActive } from "../timeline-clock.js";
import { RightPanel, type RightPanelState } from "./RightPanel.js";
import { useGitStatus, useGitSummary } from "./useGitStatus.js";
import { ImageStrip, usePastedImages } from "./images.js";
import { PromptImageView } from "./PromptImageView.js";
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
import { recoverSessionHistory } from "../history-recovery.js";
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
  editInForkAvailability,
  forkFailureIsAmbiguous,
} from "../session-actions.js";
import { SessionApprovalRegion } from "./SessionApproval.js";
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
  isFollowTailResumeKey,
  type FollowTailState,
  useFollowTail,
} from "../useFollowTail.js";
import { useSessionReadingKeys, type SessionReadingKeyActions } from "../useSessionReadingKeys.js";
import { matchesShortcut, shortcutDisplay, shortcutLayerActive } from "../shortcuts.js";
import { useIsMobile } from "./useIsMobile.js";
import {
  usePreviewNavigationRegistration,
  type PreviewNavigationControls,
} from "./usePreviewNavigationRegistration.js";
import { ShortcutHint } from "./ShortcutHint.js";
import {
  conversationSteeringAvailability,
  queuedPromptSteeringAvailability,
  shouldReloadReservedDraft,
} from "../conversation-steering.js";
import { SteeringReceipts } from "./SteeringReceipts.js";
import { SessionCommandReceipts } from "./SessionCommandReceipts.js";
import { ArrowUpIcon, ChevronLeftIcon, FolderSolidIcon, MicIcon, MoreHorizontalIcon, StopTurnIcon } from "./Icons.js";
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
import { focusComposerAtEnd, placeComposerCaretAtEnd } from "../composer-focus.js";
import { IncrementalActiveTurnProgress } from "../turn-progress.js";
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

const NO_IMAGE_MIME_TYPES: readonly string[] = [];
const STOP_TURN_RETRY_MS = 8_000;

type ComposerMutationKind = "send" | "steer" | "promote" | "stop";
type ComposerMutationEntry = {
  token: symbol;
  kind: ComposerMutationKind;
  draft?: { text: string; images: PromptImageInput[]; revision?: string };
  displaced?: ComposerMutationEntry;
};
const composerMutationRegistry = new Map<string, ComposerMutationEntry>();
const composerMutationRecoveries = new Map<string, { text: string; images: PromptImageInput[] }>();
const MAX_COMPOSER_MUTATION_RECOVERIES = 20;
const composerMutationListeners = new Map<string, Set<() => void>>();

function composerMutationKey(instanceScope: string, sessionId: string): string {
  return `${instanceScope}\u0000${sessionId}`;
}

function notifyComposerMutation(key: string): void {
  for (const listener of composerMutationListeners.get(key) ?? []) listener();
}

function reserveComposerMutation(
  key: string,
  kind: ComposerMutationKind,
  draft?: ComposerMutationEntry["draft"],
): ComposerMutationEntry | null {
  const current = composerMutationRegistry.get(key);
  if (current && (kind !== "stop" || current.kind === "stop")) return null;
  if (kind !== "stop") composerMutationRecoveries.delete(key);
  const entry: ComposerMutationEntry = {
    token: Symbol(kind),
    kind,
    ...(draft ? { draft } : {}),
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
  /** App-shell control cluster (editor, pinned/terminal/panel toggles) rendered in the unified
   * session bar when it replaces the app-level top bar on desktop. */
  topbarControls?: ReactNode;
  /** Transport-owned policy seam. Native passthrough commands default to the existing send path. */
  providerCommandAttachmentPolicy?: ProviderComposerCommand["attachmentPolicy"];
  /** Registers preview-only paging ownership and live-follow actions with the Inbox key layer. */
  onPreviewNavigationReady?: (controls: PreviewNavigationControls | null) => void;
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
        {props.mode !== "preview" && (
          <div className="detail-head">
            <button
              className="icon-btn back"
              onClick={props.onBack ?? (() => navigate({ name: "inbox" }))}
              title="Back to Inbox"
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
  topbarControls,
  providerCommandAttachmentPolicy = "send",
  onPreviewNavigationReady,
  composerDraftLoader = loadComposerDraft,
  composerDraftCleanup = deleteComposerDraftIfMatches,
  session,
}: SessionDetailProps & { session: SessionView }) {
  const api = useApi();
  const isMobile = useIsMobile();
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
  const { confirm } = useFeedback();
  // Narrow selector subscriptions: this component must re-render for ITS session's events and
  // row, not for every token-usage upsert of every other session on the board.
  const { loadEvents, loadSession, navigate, recoveryAfter, beginEventHistoryLoad, failEventHistoryLoad } = useStoreActions();
  const openSourceLocation = useCallback((location: SourceLocation) => {
    navigate({ name: "session", id: sessionId, location });
  }, [navigate, sessionId]);
  const clearSourceLocation = useCallback(() => {
    navigate({ name: "session", id: sessionId });
  }, [navigate, sessionId]);
  const recoveryEventEpoch = useStoreSelector((s) => s.sessions.get(sessionId)?.eventEpoch ?? 0);
  const recoveryGeneration = useStoreSelector((s) => s.snapshotRevision);
  const evs = useStoreSelector((s) => s.events.get(sessionId));
  const eventHistory = useStoreSelector((s) => {
    const history = s.eventHistory.get(sessionId);
    return history?.eventEpoch === (s.sessions.get(sessionId)?.eventEpoch ?? 0) ? history : undefined;
  });
  const runner = useStoreSelector((s) => s.runners.get(session.runnerId));
  const runnerOnline = runner?.status === "online";
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
  const [steeringBusy, setSteeringBusy] = useState(false);
  const queueSteeringInFlightRef = useRef(new Set<string>());
  const steeringResolutionInFlightRef = useRef(new Set<string>());
  const [queueSteeringPending, setQueueSteeringPending] = useState<ReadonlySet<string>>(() => new Set());
  const [steeringResolutionPending, setSteeringResolutionPending] = useState<ReadonlyMap<
    string,
    "queue_again" | "dismiss"
  >>(() => new Map());
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const sendRequestBusy = busy || activeComposerMutation?.kind === "send";
  const steeringRequestBusy = steeringBusy || activeComposerMutation?.kind === "steer" ||
    activeComposerMutation?.kind === "promote";
  const stopRequestPending = stoppingTurn || activeComposerMutation?.kind === "stop";
  const composerRequestBusy = activeComposerMutation !== undefined || busy || steeringBusy || stoppingTurn;
  const stopTurnPendingRef = useRef(false);
  const stopTurnMutationRef = useRef<ComposerMutationEntry | null>(null);
  const stopTurnAttemptRef = useRef(0);
  const stopTurnRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messageAction, setMessageAction] = useState<MessageActionState | null>(null);
  const messageActionReturnFocusRef = useRef<HTMLElement | null>(null);
  const forkInFlightRef = useRef(false);
  const viewGenerationRef = useRef(0);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [optimisticModel, setOptimisticModel] = useState<string | undefined>();
  const [activeSlashCommandId, setActiveSlashCommandId] = useState<string | null>(null);
  const [timelineRevealRequest, setTimelineRevealRequest] = useState<TimelineRevealRequest | null>(null);
  const timelineRevealRequestRef = useRef<TimelineRevealRequest | null>(null);
  const timelineRevealRestoreState = useRef<{ requestId: number; state: FollowTailState } | null>(null);
  const timelineRevealRequestId = useRef(0);
  const timelineHistoryKey = `${session.id}:${session.eventEpoch ?? 0}`;
  const [composerSelection, setComposerSelection] = useState({ start: 0, end: 0 });
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
  const slashListboxId = `session-slash-${useId().replace(/:/g, "")}`;
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
  const rightPanelRef = useRef(rightPanel);
  rightPanelRef.current = rightPanel;
  const composerComposingRef = useRef(false);
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

  useEffect(() => {
    queueSteeringInFlightRef.current.clear();
    steeringResolutionInFlightRef.current.clear();
    composerInteractionVersionRef.current += 1;
    composerDraftVersionRef.current += 1;
    commandSubmissionRetryRef.current = null;
    setBusy(false);
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
  const { images, onPaste, addFiles, remove, clear, replace } = usePastedImages(
    markDraftDirty,
    setError,
    allowedImageMimeTypes,
  );
  const draftState = useRef<{ text: string; images: PromptImageInput[] }>({ text: "", images: [] });
  draftState.current = { text, images };
  const updateComposerSelection = useCallback((start: number, end = start) => {
    setComposerSelection((current) => current.start === start && current.end === end
      ? current
      : { start, end });
  }, []);
  const setProgrammaticComposerText = useCallback((next: string, caret = next.length) => {
    draftState.current = { ...draftState.current, text: next };
    setText(next);
    updateComposerSelection(caret);
    setSlashDismissedFor(`${next}\u0000${caret}`);
  }, [updateComposerSelection]);
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

  useEffect(() => {
    const generation = ++viewGenerationRef.current;
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
    draftDirty.current = false;
    composerComposingRef.current = false;
    draftHydratedSessionRef.current = null;
    suppressedDraftRef.current = null;
    pendingHydrationCaretRef.current = null;
    pendingHydrationCommitRef.current = null;
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
      } else if (draft && !draftDirty.current) {
        // Defer completion until a layout effect observes the controlled textarea's committed
        // value. Promise settlement and animation-frame ordering cannot prove that React has
        // written the hydrated text to the DOM yet.
        pendingHydrationCommitRef.current = { sessionId, expectedText: draft.text };
        setProgrammaticComposerText(draft.text);
        replace(draft.images);
        commandSubmissionRetryRef.current = draft.commandSubmission ?? null;
        consumeComposerDraftHandoff(sessionId, draft, instanceScope);
        setHydrationCommitRevision((revision) => revision + 1);
      } else {
        draftHydratedSessionRef.current = sessionId;
        pendingHydrationCaretRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [instanceScope, sessionId, replace, setProgrammaticComposerText]);

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
  }, [hydrationCommitRevision, sessionId]);

  useEffect(() => {
    if (activeComposerMutation || suppressedDraftRef.current?.sessionId !== sessionId) return;
    let cancelled = false;
    let completed = false;
    const suppressed = suppressedDraftRef.current;
    suppressedDraftRef.current = null;
    void loadComposerDraft(sessionId, instanceScope).then((draft) => {
      completed = true;
      const recoveryDraft = composerMutationRecoveries.get(mutationKey);
      if (cancelled) return;
      if (draftDirty.current) {
        composerMutationRecoveries.delete(mutationKey);
        return;
      }
      const restored = draft ?? (recoveryDraft ? { ...recoveryDraft, updatedAt: Date.now() } : null);
      composerMutationRecoveries.delete(mutationKey);
      if (!restored) return;
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
  }, [activeComposerMutation, instanceScope, sessionId, replace, setProgrammaticComposerText]);

  // Coalesce rapid edits so typing beside a large base64 attachment does not rewrite it on every
  // keystroke. Dirty edits save even while hydration is pending; unmount cleanup below flushes
  // captured state when the user navigates away before the timer fires.
  useEffect(() => {
    if (!draftDirty.current) return;
    const timer = window.setTimeout(() => {
      const latest = draftState.current;
      const consumed = consumedDraftsRef.current.get(`${instanceScope}\u0000${sessionId}`);
      if (consumed && consumed.draftVersion === composerDraftVersionRef.current &&
          composerDraftMatches(latest, consumed.text, consumed.images)) {
        return;
      }
      void saveComposerDraft(sessionId, latest.text, latest.images, instanceScope);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [images, instanceScope, sessionId, text]);

  useEffect(
    () => () => {
      if (!draftDirty.current) return;
      const latest = draftState.current;
      const consumed = consumedDraftsRef.current.get(`${instanceScope}\u0000${sessionId}`);
      if (consumed && consumed.draftVersion === composerDraftVersionRef.current &&
          composerDraftMatches(latest, consumed.text, consumed.images)) {
        return;
      }
      void saveComposerDraft(sessionId, latest.text, latest.images, instanceScope);
    },
    [instanceScope, sessionId],
  );

  // Mark the session seen while it is open so the inbox unread badge stays current.
  useEffect(() => {
    if (mode !== "expanded") return;
    const ts = session?.lastEventAt ?? Date.now();
    saveSeen(markSeen(loadSeen(instanceScope), sessionId, ts), instanceScope);
  }, [instanceScope, mode, sessionId, session?.lastEventAt]);

  // Backfill only the gap since what we already have (loadEvents is stable, so this runs once
  // per session, not on every streamed event). Also re-runs when the socket comes back ONLINE:
  // events broadcast during the outage never arrived, and without this re-fetch the timeline
  // silently misses them until the user navigates away and back. The cursor is frozen when the
  // requested subscription revision is sent, so live events cannot move it past an outage gap.
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
    beginEventHistoryLoad(sessionId, epoch, recoveryRevision, generation);
    void recoverSessionHistory(
      { sessionId, after, eventEpoch: epoch, recoveryRevision },
      {
        fetchPage: api.getSessionEventPage,
        applyPage: (id, events, pageEpoch, revision, complete) =>
          loadEvents(id, events, pageEpoch, revision, complete, generation),
        isCurrent: () => !cancelled,
        retryOnIdleTimeout: true,
      },
    ).then((complete) => {
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

  // Auto-grow the composer to its content, up to the CSS max-height (then it scrolls internally).
  // Skip while the element has no laid-out width (e.g. a hidden/collapsed column): a scrollHeight
  // read at zero width returns a garbage-tall value; the next keystroke recomputes once visible.
  useLayoutEffect(() => {
    if (mode !== "expanded") return;
    const el = inputRef.current;
    if (!el || el.clientWidth === 0) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [mode, text]);

  // Once the runner echoes the real user_message (count rises past the send baseline), drop the
  // optimistic bubble so the just-sent message isn't rendered twice.
  useEffect(() => {
    if (pending && timelineUserPrompts.length > sendBaselineRef.current) setPending(null);
  }, [timelineUserPrompts.length, pending]);

  const canCancelQueued = runnerSupportsProtocol(runner?.protocolVersion, "queuedPromptCancellation");
  const terminal = isTerminal(session.status);
  // A guardrail pause (cost budget / tool-call limit) must be resolved via the Continue/Stop card,
  // not bypassed by sending a prompt.
  const policyPaused = isPolicyApproval(session.pendingApproval);
  const canPrompt = runnerOnline && !terminal && !policyPaused;
  const steeringAvailabilityInput = {
    runnerProtocolVersion: runner?.protocolVersion,
    runnerOnline,
    sessionStatus: session.status,
    activeTurnId: session.activeTurnId,
    supportsSteering: sessionCaps?.supportsSteering,
    policyPaused,
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
    reply: focusComposerAtDraftEnd,
    pauseFollow: followTail.pause,
    resumeFollow: followTail.follow,
  }), [focusComposerAtDraftEnd, followTail.follow, followTail.pause, onApprove, onArchive, onDeny, onNextSession, onPreviousSession]);
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
        setError("A conversation fork is already in progress for this session. Wait for it to appear on the Board.");
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
          if (viewGenerationRef.current === generation) setError((ambiguous ?? cause as Error).message);
        } finally {
          if (releaseOnFinish) releaseFork();
          forkInFlightRef.current = false;
          setBusy(false);
        }
      })();
    },
    [busy, confirm, navigate, session?.driver, sessionId],
  );

  const canSend = canPrompt && (text.trim().length > 0 || images.length > 0);
  const primaryComposerAction = composerPrimaryAction({
    canStopTurn,
    hasContent: text.length > 0 || images.length > 0,
    stopping: stopRequestPending,
  });
  const completedConversationTurns = useMemo(
    () => new Set(items.flatMap((item) => item.kind === "conversation_checkpoint" ? [item.turn] : [])),
    [items],
  );
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
    closeMessageAction(false);
    window.setTimeout(focusComposerAtDraftEnd, 0);
  }, [canPrompt, closeMessageAction, focusComposerAtDraftEnd, replace, setProgrammaticComposerText]);

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
    context: { planSupported, canStopTurn },
    providerCommands: mapProviderComposerCommands(
      agentCaps?.slashCommands ?? [],
      providerCommandAttachmentPolicy,
    ),
  }), [agentCaps?.slashCommands, canStopTurn, planSupported, providerCommandAttachmentPolicy]);
  const slashTrigger = useMemo(
    () => composerSelection.start === composerSelection.end
      ? findComposerCommandTrigger(text, composerSelection.start)
      : null,
    [composerSelection.end, composerSelection.start, text],
  );
  const slashMatches = useMemo(() => {
    if (!slashTrigger) return [];
    const ranked = rankComposerCommands(composerCommands, slashTrigger.query).map((match) => match.command);
    return slashTrigger.query ? ranked : ranked.filter((command) => command.available);
  }, [composerCommands, slashTrigger]);
  const slashDismissKey = slashTrigger ? `${text}\u0000${composerSelection.start}` : null;
  const paletteOpen = canPrompt && slashMatches.length > 0 && slashDismissedFor !== slashDismissKey;
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

  const send = async () => {
    if (composerMutationRegistry.has(mutationKey) || stopTurnPendingRef.current) return;
    const outgoing = text.trim();
    let invocation = resolveComposerCommandInvocation(outgoing, composerCommands);
    if (invocation.kind === "command" && invocation.command.source === "app") {
      const args = invocation.arguments.trim().toLowerCase();
      const validArguments = invocation.command.name === "plan"
        ? !args || args === "on" || args === "off"
        : invocation.command.name === "stop"
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
    if (images.length && !preservesAttachments && !modelSupportsImages(sessionCaps, effectiveModel)) {
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
    const willQueue =
      session.status === "running" || session.status === "starting" || session.status === "input_required";
    sendBaselineRef.current = timelineUserPrompts.length;
    if (!willQueue && !durableProviderInvocation) setPending({ text: outgoing, images: outgoingImages });
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
        await api.prompt(sessionId, promptText, outgoingImages, cfg, slashCommand);
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
    if (images.length && !modelSupportsImages(sessionCaps, effectiveModel)) {
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
    // Steering owns exact Ctrl+Enter before slash-palette selection. The composed slash text is
    // steering content; it is not dispatched as an app or provider slash command.
    if (!shortcutLayerActive(document) && matchesShortcut(e, "steer-turn")) {
      e.preventDefault();
      void steerDraft();
      return;
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
    if (!paletteOpen && !e.shiftKey && !e.metaKey && !e.ctrlKey && userPrompts.length) {
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
    // Enter sends; Shift+Enter inserts a newline. (Ctrl/Cmd+Enter intentionally does NOT send.)
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !composing) {
      e.preventDefault();
      void send();
    }
  };

  const usage = sessionPreviewUsage(session);

  return (
    <div className={`session-detail ${mode}`} data-session-surface-id={session.id}>
      {mode === "expanded" ? (
        <SessionHeader
          session={session}
          runnerOnline={runnerOnline}
          runnerProtocolVersion={runner?.protocolVersion}
          providerLogoutSupported={runner?.agents.find((agent) => agent.id === session.agentId)?.acp?.logout === true}
          exportReady={eventHistory?.everComplete === true}
          onBack={onBack ?? (() => navigate({ name: "inbox" }))}
          onArchive={onArchive}
          projectCrumb={<ProjectChip session={session} onOpenInbox={onBack ?? (() => navigate({ name: "inbox" }))} />}
          topbarControls={topbarControls}
          // The unified bar replaces the app-level top bar on desktop, so it owns the page-title
          // focus-rescue anchor there; the mobile layout keeps the app bar and its own anchor.
          titleId={!isMobile ? "page-title" : undefined}
        />
      ) : (
        <header className="session-preview-head">
          <div className="session-preview-heading">
            <h2 className="session-preview-title">{session.title}</h2>
            <div className="session-preview-meta">
              <StatusBadge status={session.status} />
              {session.backgroundWorkState && <BackgroundWorkBadge state={session.backgroundWorkState} />}
              <span className="tag tag-machine" title={session.runnerId}>{runnerDisp.name}</span>
              {session.agentName && (
                <span className="tag tag-agent">{sessionAgentLabel(session.agentName, session.driver, session.agentId)}</span>
              )}
              {session.workspaceName && <span className="tag tag-workspace">{session.workspaceName}</span>}
              <ContextWindowMeter session={session} />
              {usage && <span className="tag tag-usage" aria-label={`Usage: ${usage}`}>{usage}</span>}
              {!runner || runner.status !== "online" ? <span className="tag tag-offline">Runner Offline</span> : null}
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
            onPointerDownCapture={() => setActivePane("reader")}
          >
            {/* Floating pinned summary overlays the TRANSCRIPT's top-right (Codex behavior);
                the timeline does not reflow around it, and it shifts with the right panel.
                Anchored inside detail-main — not the whole chat column — so its max-height
                can never extend down over the composer. */}
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
              className="detail-scroll"
              ref={scrollRef}
              role="region"
              aria-label={mode === "expanded" ? "Session Activity" : "Session Preview Activity"}
              aria-busy={transcript.busy}
              tabIndex={0}
              onScroll={followTail.onScroll}
              onWheel={followTail.onWheel}
              onPointerMove={followTail.onPointerMove}
              onTouchStart={followTail.onTouchStart}
              onKeyDown={(event) => {
                if (event.defaultPrevented) return;
                if (mode !== "expanded" && !isFollowTailResumeKey(event)) return;
                if (!followTail.onKeyDown(event)) return;
                event.preventDefault();
              }}
            >
              {transcript.notice && (
                <TranscriptLoadNotice
                  kind={transcript.notice}
                  error={transcript.error}
                  canRetry={conn === "online" && !transcript.busy}
                  onRetry={() => setHistoryRetry((value) => value + 1)}
                />
              )}
              {transcript.body === "skeleton" ? (
                <TranscriptSkeleton />
              ) : transcript.body === "unavailable" ? (
                <Empty
                  title={conn === "unauthorized" ? "Pair to load activity" : "Activity Unavailable"}
                  hint={transcript.error ?? (conn === "offline" ? "Reconnect to load this transcript." : "This device needs access to the control plane.")}
                />
              ) : transcript.body === "empty" ? (
                <Empty title="No Activity Yet" hint="Waiting for the agent…" />
              ) : (
                <>
                  {items.length > 0 && (
                    <EventTimeline
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
                      onFork={
                        mode === "expanded" &&
                        supportsConversationFork &&
                        session.worktreePath != null &&
                        runnerSupportsProtocol(runner?.protocolVersion, "conversationFork") &&
                        runnerOnline &&
                        (session.queued?.length ?? 0) === 0 &&
                        !busy &&
                        !["queued", "running", "starting", "input_required"].includes(session.status)
                          ? onFork
                          : undefined
                      }
                      onEditAndResend={mode === "expanded" && canPrompt ? openResendAction : undefined}
                      onEditInFork={mode === "expanded" ? openForkEditAction : undefined}
                      editInForkTargets={mode === "expanded" ? editInForkTargets : undefined}
                      forkLatestOnly={session.driver === "claude-code"}
                      revealRequest={timelineRevealRequest}
                      onRevealHandled={handleTimelineReveal}
                    />
                  )}
                  {showOptimistic && pending && (
                    <div className="tl-row user">
                      <div className="bubble user-bubble">
                        {pending.images.length > 0 && (
                          <div className="bubble-images">
                            {pending.images.map((img, i) => (
                              <PromptImageView key={"artifactId" in img ? img.artifactId : i} image={img} alt={`attachment ${i + 1}`} />
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
            <div className="transcript-status-strip" aria-label="Transcript Status">
              <div className="transcript-status-context">
                {mode === "expanded" && <ContextWindowMeter session={session} />}
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
            {error && <div className="composer-error">{error}</div>}
            {/* Active-turn progress renders in the transcript's Working row, not as a card here —
                the composer area keeps only composer concerns (receipts, queue, input). */}
            <SessionCommandReceipts invocations={session.commandInvocations ?? []} timelineItems={items} />
            <SteeringReceipts
              attempts={session.steeringAttempts ?? []}
              timelineItems={items}
              activeTurnId={session.activeTurnId}
              pendingActions={steeringResolutionPending}
              onQueueAgain={(submissionId) => void resolveSteeringAttempt(submissionId, "queue_again")}
              onDismiss={(submissionId) => void resolveSteeringAttempt(submissionId, "dismiss")}
            />
            {session.queued && session.queued.length > 0 && (
              <div className="queued-list" aria-label="Queued Messages">
                {session.queued.map((q) => {
                  const availability = queuedPromptSteeringAvailability(steeringAvailabilityInput, q);
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
                    <div className="queued-item" key={q.id} data-testid={`queued-prompt-${q.id}`}>
                      <span
                        className={`queued-badge${session.queueHeld ? " held" : ""}`}
                        title={session.queueHeld
                          ? "Held after stopping the active turn; send another prompt to resume"
                          : queueTitle}
                      >
                        {queueLabel}
                      </span>
                      <span className="queued-text">
                        {q.hasImages && <span className="queued-img" aria-hidden="true">🖼 </span>}
                        {q.text || (q.hasImages ? "(image)" : "")}
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
            <div
              className={`composer-box${dragActive ? " drag-over" : ""}`}
              onDragEnter={(e) => {
                if (!canPrompt) return;
                e.preventDefault();
                dragDepth.current += 1; // dragenter/leave fire per child; count so leaving a child doesn't clear
                setDragActive(true);
              }}
              onDragOver={(e) => {
                if (canPrompt) e.preventDefault(); // required for the element to be a valid drop target
              }}
              onDragLeave={() => {
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDragActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                dragDepth.current = 0;
                setDragActive(false);
                if (!canPrompt) return;
                const files = Array.from(e.dataTransfer.files);
                if (files.length) void addFiles(files);
              }}
            >
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
              <ImageStrip images={images} onRemove={remove} />
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
                aria-expanded={paletteOpen}
                aria-busy={steeringRequestBusy || undefined}
                aria-controls={paletteOpen ? slashListboxId : undefined}
                aria-activedescendant={paletteOpen && selectedSlashCommandId
                  ? slashCommandOptionId(slashListboxId, selectedSlashCommandId)
                  : undefined}
                value={text}
                onPointerDown={() => {
                  composerInteractionVersionRef.current += 1;
                }}
                onCompositionStart={() => {
                  composerComposingRef.current = true;
                  composerInteractionVersionRef.current += 1;
                }}
                onCompositionEnd={() => {
                  composerComposingRef.current = false;
                }}
                onSelect={(e) => {
                  updateComposerSelection(
                    e.currentTarget.selectionStart,
                    e.currentTarget.selectionEnd,
                  );
                }}
                onChange={(e) => {
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
                {usage && (
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
                  {primaryComposerAction === "send" ? (
                    <button
                      className="send-btn"
                      onClick={send}
                      disabled={!canSend || composerRequestBusy}
                      title="Send (Enter)"
                      aria-label="Send"
                    >
                      {busy ? <Spinner /> : <ArrowUpIcon size={14} />}
                    </button>
                  ) : (
                    <button
                      className={`send-btn stop-turn-btn${primaryComposerAction === "stopping" ? " is-stopping" : ""}`}
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
            </div>
            {/* No context footer under the composer: project identity lives in the session bar's
                breadcrumb, and git, agent, model, and host facts live in the pinned summary. */}
            </div>
          )}
        </div>

        {mode === "expanded" && <RightPanel
          state={rightPanel}
          session={session}
          sourceLocation={sourceLocation}
          onOpenSourceLocation={openSourceLocation}
          onClearSourceLocation={clearSourceLocation}
          runnerOnline={runnerOnline}
          runnerProtocolVersion={runner?.protocolVersion}
          git={git}
          onOpenTerminal={onOpenTerminal}
          onInsertSideChatDraft={insertSideChatDraft}
          items={items}
        />}
      </div>
      {mode === "expanded" && messageAction && (
        <MessageActionDialog
          key={`${messageAction.mode}-${messageAction.item.id}`}
          action={messageAction}
          existingDraftPresent={Boolean(text || images.length)}
          canPrepareResend={canPrompt}
          busy={busy}
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
  onClose,
  onPrepareResend,
  onPrepareFork,
}: {
  action: MessageActionState;
  existingDraftPresent: boolean;
  canPrepareResend: boolean;
  busy: boolean;
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
 * Inbox, and a hover/focus-revealed ⋯ trigger opens a small actions menu (Manage Project /
 * Move Session). Reassignment moved out of the name itself so the crumb behaves like a
 * breadcrumb.
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
        {currentName}
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
        <MoreHorizontalIcon size={14} />
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

/** Codex-style "+" menu in the composer: Plan mode + the cost budget; home for future modes/attach. */
function ComposerPlusMenu({
  session,
  planActive,
  planSupported,
  onTogglePlan,
  onApply,
  disabled,
}: {
  session: SessionView;
  planActive: boolean;
  planSupported: boolean;
  onTogglePlan: (on?: boolean) => void;
  onApply: (patch: Partial<SessionConfig>) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const popover = useDismissiblePopover(open, setOpen, "composer-modes-popover");
  return (
    <div className="plus-menu">
      <button
        ref={popover.triggerRef}
        type="button"
        className="plus-btn"
        disabled={disabled}
        aria-label="Add and Modes"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popover.panelId}
        title="Modes & Budget"
        onClick={popover.toggle}
        onKeyDown={popover.onTriggerKeyDown}
      >
        +
      </button>
      {open && (
        <>
          <div className="plus-backdrop" onClick={() => popover.close(true)} />
          <div
            className="plus-pop"
            id={popover.panelId}
            ref={popover.panelRef}
            role="dialog"
            aria-label="Session Modes and Guardrails"
            onKeyDown={popover.onPanelKeyDown}
          >
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

function TranscriptLoadNotice({
  kind,
  error,
  canRetry,
  onRetry,
}: {
  kind: "refreshing" | "stale" | "error";
  error: string | null;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const message = kind === "refreshing"
    ? "Checking for missed activity…"
    : kind === "stale"
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
