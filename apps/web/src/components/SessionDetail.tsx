import { browserRandomUUID } from "../browser-crypto.js";
import { State } from "./State.js";
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import {
  CODEX_APP_SERVER_IMAGE_MIME_TYPES,
  DEFAULT_LIVE_CHILD_LIMIT,
  MAX_LIVE_CHILD_LIMIT,
  MAX_PROMPT_IMAGES,
  PROMPT_IMAGE_MIME_TYPES,
  validatePromptImageInputs,
  isPolicyApproval,
  pendingRequests,
  isWorkspaceReference,
  isTerminal,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  providerSupportsConversationFork,
  type PromptImageInput,
  type CreateWorkspaceReferenceRequest,
  type QueuedPromptView,
  type SessionConfig,
  type DescendantBlockedChildView,
  type DescendantRequestView,
  type ParentControlMode,
  type WorkflowDecisionAuthority,
  type DelegatableWorkflowDecisionCategory,
  type SessionHoldView,
  type SessionReminderView,
  sessionRole,
  type SessionView,
  usesOrchestratorPresetPermissions,
  type SourceLocation,
  type WorkspaceReference,
  type WorkspaceReferenceCandidate,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { SkillsUnavailableNotice, skillsUnavailableSentence, useSessionSkillsUnavailable, useSkillsNoticeDismissal } from "./SkillsUnavailableNotice.js";
import { isPartialHistory, isRebuiltEventsArray, useStoreActions, useStoreSelector } from "../store.js";
import { relativeTime, shortenPath, titleCaseLabel } from "../format.js";
import { COMPOSER_USAGE_MIN_COLUMN_REM, composerUsagePlacement, useNarrowerThanRem } from "../composer-usage-placement.js";
import { accountLabelText, isPersonalIdentifier, redactPersonalIdentifiers } from "../personal-identifiers.js";
import { AccountLabel } from "./AccountIdentifier.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { compareSessionNotices, SESSION_NOTICE_RANK, SessionNoticeSlot, type SessionNoticeEntry } from "./SessionNoticeSlot.js";
import { sessionAccountSwitchApplicable, SwitchAccountDialog } from "./SwitchAccountDialog.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SessionPlaceholder } from "./SessionPlaceholder.js";
import { sessionUnarchiveRestarts } from "../archive-actions.js";
import { unarchiveSession } from "../session-unarchive.js";
import { TranscriptSkeleton, transcriptLoadingSentence } from "./TranscriptSkeleton.js";
import { TranscriptEmptyState, TranscriptHistoryNotice, transcriptEmptyKind } from "./TranscriptReadingStates.js";
import { clearRoutedSessionLookup, setRoutedSessionLookup, useRoutedSessionLookup } from "../routed-session-lookup.js";
import { agentHarnessIdentityLabel } from "../agent-presentation.js";
import { runnerDisplay } from "../runners.js";
import { integrationIsolationDisclosure, ORCHESTRATOR_PRESET_INTEGRATION_DISCLOSURE } from "../session-preset-defaults.js";
import { MoveToProjectDialog, MoveToWorkspaceDialog, NewWorkspaceDialog } from "./SessionMoveDialogs.js";
import {
  advanceAutomaticAccountSwitchNotice,
  type AutomaticAccountSwitchNoticeState,
  type TimelineItem,
} from "../timeline.js";
import { useTimeline } from "./useTimeline.js";
import {
  BackgroundDeliveryBadge,
  BackgroundNotificationBadge,
  BackgroundWorkBadge,
  UntrackedBackgroundWorkBadge,
  Modal,
  Spinner,
  SessionStatusIndicators,
} from "./common.js";
import { StatusBadge } from "./StatusBadge.js";
import { Notice } from "./Notice.js";
import { sessionArchivedAtRest, statusMeta } from "../status-meta.js";
import { shownWatchdogDelivery } from "../background-delivery-status.js";
import { EventTimeline, TranscriptErrorAlert, type TimelineRevealRequest } from "./EventTimeline.js";
import { ConversationHandoffDialog } from "./ConversationHandoffDialog.js";
import { isTimelineSessionActive } from "../timeline-clock.js";
import { RightPanel, type RightPanelState } from "./RightPanel.js";
import { useCampaignStatusAvailability } from "./useCampaignStatus.js";
import { useGitStatus, useGitSummary } from "./useGitStatus.js";
import { ImageStrip, usePastedImages } from "./images.js";
import { PromptImageView } from "./PromptImageView.js";
import {
  hasNewPendingPrompt,
  isPendingPromptShown,
  isUndeliveredPrompt,
  PendingPromptBubbles,
  queuedPromptsWithControls,
  shouldShowOptimisticPrompt,
} from "./PendingPromptBubbles.js";
import {
  TranscriptTailControl,
  transcriptTailView,
  useOffscreenReceipts,
  useRecoveryAnnouncement,
} from "./TranscriptTailControl.js";
import { ApprovalsControl, ModelEffortControl, useModelSettingsAvailable } from "./ComposerControls.js";
import { modelSupportsImages, resolveCaps } from "../caps.js";
import { PinnedSummary } from "./PinnedSummary.js";
import { PinnedSummaryDock } from "./PinnedSummaryDock.js";
import type { PinnedSummaryState } from "./pinned-summary-state.js";
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
import { routedSessionPlaceholder, shouldHydrateRoutedSession } from "../detail-placeholder.js";
import { transcriptPresentation, transcriptRendersRequestRow } from "../transcript-presentation.js";
import { DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE } from "../ui-evidence-disclosure.js";
import {
  acquireSessionFork,
  canStopActiveTurn,
  checkpointHandoffUnavailableReason,
  composerPrimaryAction,
  conversationForkAvailability,
  editInForkAvailability,
  forkFailureIsAmbiguous,
  isTerminalDeliveryReceipt,
  pendingQueuedPromptCount,
  sessionForkInProgress,
  subscribeSessionForks,
  type ConversationForkAvailability,
  type EditInForkAvailability,
} from "../session-actions.js";
import { SessionApprovalRegion, focusSessionRequest, standaloneApprovalForReview } from "./SessionApproval.js";
import {
  requestTypeLabel,
  sessionRequestPanelKey,
  type DescendantRequestStatus,
} from "./SessionRequestPanel.js";
import { CampaignHeldChildren, type CampaignHeldChild } from "./CampaignHeldChildren.js";
import { ComposerQuestionResponse } from "./ComposerQuestionResponse.js";
import { useGovernanceAudit, useGovernanceTimeline } from "./useGovernanceAudit.js";
import { SessionHeader } from "./SessionHeader.js";
import { useWorktreeSetupSuggestion, WorktreeSetupNotice } from "./WorktreeSetupNotice.js";
import { WorktreeRecoveryCard } from "./WorktreeRecoveryCard.js";
import { useRecoveryWorktreeCreation } from "../recovery-worktree-creation.js";
import { worktreeSetupNoticeSessionIds } from "../worktree-setup-notice.js";
import { useInstanceScope } from "../instance-scope.js";
import { useAccessibleMenu, useDismissiblePopover } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
import { Markdown } from "./Markdown.js";
import { useFeedback } from "./FeedbackProvider.js";
import { ContextWindowMeter } from "./ContextWindowMeter.js";
import { resolveContextWindowCapacity } from "../context-window-capacity.js";
import { SessionUsageControl } from "./SessionUsageControl.js";
import { SessionUsageMenuGroup } from "./SessionUsageMenuGroup.js";
import { useAnchoredPopover } from "./anchored-popover.js";
import {
  hasSavedFollowTailAnchor,
  isFollowTailResumeKey,
  isFollowTailUpwardReadingKey,
  type FollowTailState,
  useFollowTail,
} from "../useFollowTail.js";
import { useSessionReadingKeys, type SessionReadingKeyActions } from "../useSessionReadingKeys.js";
import { VIRTUAL_VIEWPORT_INTENT_EVENT, virtualViewportIntentDirection } from "../viewport-intent.js";
import { inTypingContext, matchesShortcut, shortcutDisplay, shortcutLayerActive } from "../shortcuts.js";
import { useIsMobile, useIsTouchPhone } from "./useIsMobile.js";
import {
  usePreviewNavigationRegistration,
  type PreviewNavigationControls,
} from "./usePreviewNavigationRegistration.js";
import {
  conversationSteeringAvailability,
  queuedPromptEditingAvailability,
  queuedPromptSteeringAvailability,
  shouldReloadReservedDraft,
} from "../conversation-steering.js";
import { deriveSteeringReceipts, SteeringReceipts } from "./SteeringReceipts.js";
import { SessionCommandReceipts, visibleSessionCommandReceipts } from "./SessionCommandReceipts.js";
import { ReceiptLine, RECEIPT_ROW_ATTRIBUTE, receiptRowId, receiptRowIds } from "./TranscriptReceipt.js";
import { ArrowUpIcon, ChevronDownIcon, EditIcon, FolderIcon, ImageIcon, InfoIcon, MicIcon, PlusIcon, ProjectsIcon, RefreshIcon, StopTurnIcon } from "./Icons.js";
import {
  DURABLE_COMMAND_ATTACHMENT_NOTICE,
  buildComposerCommandRegistry,
  composerCommandsForTrigger,
  composerCommandsIncludeSkills,
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
import { composerFieldSizesToContent, resizeComposerToContent } from "../composer-autogrow.js";
import {
  composerAgentName,
  composerPlaceholder as composerPlaceholderText,
  composerUnavailableReason,
} from "../composer-placeholder.js";
import { IncrementalActiveTurnProgress } from "../turn-progress.js";
import { IncrementalSubagentProjector } from "../subagents.js";
import { workerRoster, isCurrentWorker } from "../worker-roster.js";
import { WorkingIndicator } from "./WorkingIndicator.js";
import { Select } from "./ui/ChoiceControls.js";
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
  refreshDurableQueuedEditRecovery,
  saveDurableQueuedEditRecovery,
  storeRuntimeQueuedEditRecovery,
  type QueuedEditRecoveryScope,
  type QueuedPromptEditRecovery,
  type QueuedPromptEditState,
} from "../queued-edit-recovery.js";
import { materializePromptImages } from "../prompt-image-materialization.js";
import { holdRecoveryActionFor, sessionArchiveActionRefusal, sessionCommandRefusal } from "../session-command-permissions.js";

const NO_IMAGE_MIME_TYPES: readonly string[] = [];
const STOP_TURN_RETRY_MS = 8_000;
/** Why a `failed` or `uncertain` durable receipt offers only Dismiss. Worded for both states:
 * uncertain delivery may have landed, but either way no further attempt will be made. */
const TERMINAL_RECEIPT_REASON = "Delivery attempts for this message have ended, so it cannot be steered or edited.";
/** WebKit may synthesize a touch click in a later task. Keep the pointer transfer alive long
 * enough for that click; if no click arrives, finish the collapse instead of leaving a blurred
 * composer expanded. Pointer cancellation (the usual scroll path) finishes immediately. */
const COMPOSER_POINTER_CLICK_FALLBACK_MS = 500;
const EARLIER_ACTIVITY_TRIGGER_PX = 160;
const EARLIER_ACTIVITY_REARM_DISTANCE_PX = 32;
const EARLIER_ACTIVITY_REARM_FRAMES = 8;
/** The virtual list owns an eight-frame post-prepend measurement window. Reveal keyboard focus
 * after that window plus two boundary frames so its final correction cannot hide the fallback. */
const EARLIER_ACTIVITY_FOCUS_REVEAL_FRAMES = 10;
/** One reader gesture rarely maps to one scroll event: a wheel tick or reading key under smooth
 * scrolling, and a touch drag with its momentum, each emit a stream of scroll events. An armed
 * traversal survives that stream while it keeps moving upward and expires after this idle gap. */
const EARLIER_ACTIVITY_INTENT_IDLE_MS = 180;
/** A finger must travel this far downward at the head before it counts as asking for history. */
const EARLIER_ACTIVITY_HEAD_DRAG_PX = 24;
/** Opening recovery may add at most the same 2,000 raw events that server-side turn alignment
 * searches. This keeps a pathological single turn bounded while normal underfilled readers need
 * only one or two pages. */
const OPENING_HISTORY_MAX_PAGES = 10;
/** Leave the earlier-history control safely above a tail-following viewport instead of stopping as
 * soon as the reader gains a one-pixel scroll range. */
const OPENING_HISTORY_HEADROOM_PX = EARLIER_ACTIVITY_TRIGGER_PX;

type EarlierActivityIntent = "single-scroll" | "touch-traversal";

/** A scrollable descendant (a tool output, a diff, a code block) that can still move upward
 * consumes the gesture itself; the reader region only sees the event because it bubbles, so the
 * direct head evaluation must not treat it as a request for earlier activity. */
function nestedScrollerConsumesUpwardInput(target: EventTarget | null, reader: HTMLElement): boolean {
  let node = target as Partial<HTMLElement> | null;
  while (node && node !== reader) {
    if (typeof node.scrollTop === "number" && node.scrollTop > 0.5 &&
        (node.scrollHeight ?? 0) > (node.clientHeight ?? 0) + 1) {
      return true;
    }
    node = node.parentElement ?? null;
  }
  return false;
}

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
  attentionTarget?: import("../navigation.js").AttentionTarget;
  rightPanel: RightPanelState;
  onOpenTerminal: () => void;
  /** The Pinned Summary's state (#2147). Only the expanded session shows the summary; without it,
   * none is shown. */
  pinnedSummary?: PinnedSummaryState;
  composerFocusIntent?: "message" | "reply";
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
  const snapshotLoaded = useStoreSelector((s) => s.snapshotLoaded);
  const isMobile = useIsMobile();
  const lastLookupKeyRef = useRef<string | null>(null);
  // The phone top bar titles the page from the same lookup (#2202).
  const sessionLookup = useRoutedSessionLookup(sessionId);
  // Retry reissues the lookup for the same route, snapshot and connection.
  const [lookupAttempt, setLookupAttempt] = useState(0);
  useEffect(() => () => clearRoutedSessionLookup(sessionId), [sessionId]);

  // Archived sessions are deliberately absent from the live snapshot. Resolve the exact routed id
  // through the normal authorized REST surface so copied links remain durable after archiving.
  // A reconnect keeps the already-rendered archived row mounted, then revalidates it once for the
  // new snapshot generation so a deletion missed while offline still becomes authoritative.
  useEffect(() => {
    if (!shouldHydrateRoutedSession(session, snapshotRevision, conn)) return;
    const lookupKey = JSON.stringify([sessionId, snapshotRevision, conn, lookupAttempt]);
    if (lastLookupKeyRef.current === lookupKey) return;
    lastLookupKeyRef.current = lookupKey;
    let current = true;
    setRoutedSessionLookup({ sessionId, complete: false, error: null });
    void api.session(sessionId)
      .then(({ session: loaded }) => {
        if (!current) return;
        loadSession(loaded);
        setRoutedSessionLookup({ sessionId, complete: true, error: null });
      })
      .catch((cause: unknown) => {
        if (!current) return;
        const notFound = cause instanceof ApiError && cause.status === 404;
        if (notFound && session) {
          dispatch({ type: "msg", msg: { type: "session_removed", sessionId } });
        }
        setRoutedSessionLookup({ sessionId, complete: true, error: notFound ? null : (cause as Error).message });
      });
    return () => { current = false; };
  }, [api, sessionId, session, loadSession, dispatch, conn, snapshotRevision, lookupAttempt]);

  if (!session) {
    return (
      <SessionPlaceholder
        sessionId={sessionId}
        placeholder={routedSessionPlaceholder(sessionId, sessionLookup, conn, snapshotLoaded)}
        preview={props.mode === "preview"}
        isMobile={isMobile}
        onBack={props.onBack ?? (() => navigate({ name: "inbox" }))}
        onRetry={() => setLookupAttempt((attempt) => attempt + 1)}
      />
    );
  }

  return <SessionDetailLoaded {...props} session={session} />;
}

const DESCENDANT_REQUEST_POLL_INTERVAL_MS = 2_000;
export const DESCENDANT_REQUEST_POLL_TIMEOUT_MS = 10_000;
const EMPTY_DESCENDANT_REQUESTS: readonly DescendantRequestView[] = Object.freeze([]);
const EMPTY_BLOCKED_CHILDREN: readonly DescendantBlockedChildView[] = Object.freeze([]);
const EMPTY_HELD_CHILDREN: readonly CampaignHeldChild[] = Object.freeze([]);

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type ActiveDescendantRequestPoll = {
  controller: AbortController;
  timeout: number;
};

type DescendantRequestSnapshot = {
  contextKey: string;
  status: DescendantRequestStatus;
  requests: readonly DescendantRequestView[];
  /** Held descendants; never requests, since there is nothing to answer (#1760). */
  blockedChildren: readonly DescendantBlockedChildView[];
};

function transitionToEmptyDescendantRequestSnapshot(
  current: DescendantRequestSnapshot,
  contextKey: string,
  status: "idle" | "unavailable",
): DescendantRequestSnapshot {
  return current.contextKey === contextKey && current.status === status && current.requests.length === 0 &&
    current.blockedChildren.length === 0
    ? current
    : { contextKey, status, requests: EMPTY_DESCENDANT_REQUESTS, blockedChildren: EMPTY_BLOCKED_CHILDREN };
}

export function useDescendantRequestPolling({
  sessionId,
  enabled,
  available,
}: {
  sessionId: string;
  enabled: boolean;
  available: boolean;
}): {
  requests: readonly DescendantRequestView[];
  blockedChildren: readonly DescendantBlockedChildView[];
  status: DescendantRequestStatus;
  refreshAfterResolution: () => void;
} {
  const api = useApi();
  const contextKey = JSON.stringify([sessionId, enabled, available]);
  const fallbackStatus: DescendantRequestStatus = !enabled ? "idle" : available ? "loading" : "unavailable";
  const [snapshot, setSnapshot] = useState<DescendantRequestSnapshot>(
    () => ({ contextKey, status: fallbackStatus, requests: EMPTY_DESCENDANT_REQUESTS, blockedChildren: EMPTY_BLOCKED_CHILDREN }),
  );
  const currentSnapshot = snapshot.contextKey === contextKey
    ? snapshot
    : { contextKey, status: fallbackStatus, requests: EMPTY_DESCENDANT_REQUESTS, blockedChildren: EMPTY_BLOCKED_CHILDREN };
  const generationRef = useRef(0);
  const inFlightRef = useRef<ActiveDescendantRequestPoll | null>(null);
  const enabledRef = useRef(enabled);
  const availableRef = useRef(available);
  const sessionIdRef = useRef(sessionId);
  const contextKeyRef = useRef(contextKey);
  useLayoutEffect(() => {
    enabledRef.current = enabled;
    availableRef.current = available;
    sessionIdRef.current = sessionId;
    contextKeyRef.current = contextKey;
  }, [available, contextKey, enabled, sessionId]);
  const abortInFlight = useCallback(() => {
    const active = inFlightRef.current;
    if (!active) return;
    inFlightRef.current = null;
    window.clearTimeout(active.timeout);
    active.controller.abort();
  }, []);
  const refresh = useCallback((supersede = false) => {
    if (!enabledRef.current) {
      generationRef.current += 1;
      abortInFlight();
      setSnapshot((current) => transitionToEmptyDescendantRequestSnapshot(
        current, contextKeyRef.current, "idle",
      ));
      return;
    }
    if (!availableRef.current) {
      generationRef.current += 1;
      abortInFlight();
      setSnapshot((current) => transitionToEmptyDescendantRequestSnapshot(
        current, contextKeyRef.current, "unavailable",
      ));
      return;
    }
    if (inFlightRef.current && !supersede) return;
    abortInFlight();
    const controller = new AbortController();
    const generation = ++generationRef.current;
    const requestContextKey = contextKeyRef.current;
    setSnapshot((current) => current.contextKey === requestContextKey
      ? current
      : { contextKey: requestContextKey, status: "loading", requests: EMPTY_DESCENDANT_REQUESTS,
        blockedChildren: EMPTY_BLOCKED_CHILDREN });
    const timeout = window.setTimeout(() => {
      if (inFlightRef.current?.controller !== controller) return;
      inFlightRef.current = null;
      if (generation === generationRef.current && requestContextKey === contextKeyRef.current) {
        setSnapshot((current) => transitionToEmptyDescendantRequestSnapshot(
          current, requestContextKey, "unavailable",
        ));
      }
      controller.abort();
    }, DESCENDANT_REQUEST_POLL_TIMEOUT_MS);
    inFlightRef.current = { controller, timeout };
    void api.descendantRequests(sessionIdRef.current, controller.signal).then(
      ({ requests: next, blockedChildren: nextBlocked }) => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        // A newer web client can briefly talk to an older control plane during a rolling update.
        // Rows without exact routing/ownership metadata are not safe to render or answer.
        const compatible = next.every((request) =>
          Number.isSafeInteger(request.eventEpoch) && request.eventEpoch >= 0 &&
          Number.isFinite(request.createdAt) && request.createdAt > 0 &&
          (request.responseOwner === "human" || request.responseOwner === "orchestrator"))
          ? next : null;
        if (compatible === null) {
          setSnapshot((current) => transitionToEmptyDescendantRequestSnapshot(
            current, requestContextKey, "unavailable",
          ));
          return;
        }
        // Older control planes omit held descendants; they only supply titles for the campaign's list.
        const blockedChildren = Array.isArray(nextBlocked) ? nextBlocked : EMPTY_BLOCKED_CHILDREN;
        setSnapshot((current) => current.contextKey === requestContextKey && current.status === "ready" &&
          JSON.stringify(current.requests) === JSON.stringify(compatible) &&
          JSON.stringify(current.blockedChildren) === JSON.stringify(blockedChildren)
          ? current
          : { contextKey: requestContextKey, status: "ready", requests: compatible, blockedChildren });
      },
      () => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setSnapshot((current) => transitionToEmptyDescendantRequestSnapshot(
          current, requestContextKey, "unavailable",
        ));
      },
    ).finally(() => {
      if (inFlightRef.current?.controller !== controller) return;
      inFlightRef.current = null;
      window.clearTimeout(timeout);
    });
  }, [abortInFlight, api]);
  const refreshAfterResolution = useCallback(() => refresh(true), [refresh]);
  useEffect(() => {
    refresh();
    if (!enabled || !available) return;
    const timer = window.setInterval(refresh, DESCENDANT_REQUEST_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      generationRef.current += 1;
      abortInFlight();
    };
  }, [abortInFlight, available, enabled, refresh, sessionId]);
  return {
    requests: currentSnapshot.requests,
    blockedChildren: currentSnapshot.blockedChildren,
    status: currentSnapshot.status,
    refreshAfterResolution,
  };
}

/**
 * Whether a node belongs to the composer: inside its box, or inside a menu one of its controls
 * opened. Composer menus are portalled to <body> (the shared MenuSurface), so moving focus into one,
 * or tapping its backdrop, must not read as leaving the composer and collapse it on a phone.
 */
function composerOwns(box: Element | null | undefined, node: EventTarget | null): boolean {
  if (!box || !(node instanceof Node)) return false;
  if (box.contains(node)) return true;
  const element = node instanceof Element ? node : node.parentElement;
  const layer = element?.closest(".menu, .popover, .menu-backdrop");
  // A backdrop is rendered just before the surface it dismisses.
  const surface = layer?.classList.contains("menu-backdrop") ? layer.nextElementSibling : layer;
  const id = surface?.id;
  return Boolean(id && [...box.querySelectorAll("[aria-controls]")]
    .some((control) => control.getAttribute("aria-controls") === id));
}

function SessionDetailLoaded({
  sessionId,
  sourceLocation,
  attentionTarget,
  rightPanel,
  onOpenTerminal,
  pinnedSummary: pinnedSummaryProp,
  composerFocusIntent,
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
  const privacy = useAccountEmailPrivacy();
  const api = useApi();
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
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
  const { confirm, showToast, showUndo } = useFeedback();
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
  const openSession = useCallback((id: string) => navigate({ name: "session", id }), [navigate]);
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
  const allSessions = useStoreSelector((s) => s.sessions);
  const allRunners = useStoreSelector((s) => s.runners);
  const worktreeSetupConfigSupported = useStoreSelector((s) => s.worktreeSetupConfigSupported);
  const setupDismissals = useStoreSelector((s) => s.worktreeSetupNoticeDismissals);
  const showWorktreeSetupNotice = useMemo(() => worktreeSetupNoticeSessionIds(
    allSessions.values(), allRunners, setupDismissals, worktreeSetupConfigSupported,
  ).has(sessionId), [allRunners, allSessions, sessionId, setupDismissals, worktreeSetupConfigSupported]);
  const activeWorktreeSetupConfig = session.worktreePath
    ? session.worktrees?.find((worktree) => worktree.path === session.worktreePath)?.setupConfig
    : undefined;
  const runnerOnline = runner?.status === "online";
  const snapshotLoaded = useStoreSelector((s) => s.snapshotLoaded);
  const stopBeforeArchiveSupported = useStoreSelector((s) => s.stopBeforeArchiveSupported);
  const unarchiveAndRestartSupported = useStoreSelector((s) => s.unarchiveAndRestartSupported);
  const richGitSupported = runnerSupportsProtocol(runner?.protocolVersion, "gitVisibility");
  const box = useStoreSelector((s) => [...s.boxes.values()].find((candidate) => candidate.runnerId === session.runnerId));
  const conn = useStoreSelector((s) => s.conn);
  const descendantRequestPollingEnabled = mode === "expanded" && (
    session.orchestratorCampaign != null ||
    (session.parentControl ?? "off") !== "off" ||
    Object.values(session.parentControlPolicy?.decisions ?? {}).includes("orchestrator")
  );
  const {
    requests: descendantRequests,
    blockedChildren: blockedDescendants,
    status: descendantRequestStatus,
    refreshAfterResolution: refreshDescendantRequestsAfterResolution,
  } = useDescendantRequestPolling({
    sessionId,
    enabled: descendantRequestPollingEnabled,
    available: conn === "online",
  });
  // Held children come from the campaign projection, the same snapshot as its Blocked count, so the
  // list and the count move together. Titles prefer the live session store and fall back to the
  // held descendants the request poll reports, then to the id (#1760).
  const heldChildren = session.orchestratorCampaign?.heldChildren ?? EMPTY_HELD_CHILDREN;
  const campaignAvailability = useCampaignStatusAvailability(session);
  // Compared element-wise so an unrelated store update keeps the same array and skips a re-render.
  const heldChildStoreTitles = useStoreSelector(
    (s) => heldChildren.map((child) => s.sessions.get(child.sessionId)?.title ?? ""),
    sameStrings,
  );
  const heldChildTitle = useCallback((childSessionId: string) => {
    const index = heldChildren.findIndex((child) => child.sessionId === childSessionId);
    const stored = index >= 0 ? heldChildStoreTitles[index] : undefined;
    return stored || blockedDescendants.find((child) => child.sessionId === childSessionId)?.sessionTitle;
  }, [blockedDescendants, heldChildStoreTitles, heldChildren]);
  // Each hold's advice as written for this person, from the child's own view (#1857).
  const heldChildStoreRecoveryActions = useStoreSelector(
    (s) => heldChildren.flatMap((child) => child.holds.map((hold) =>
      holdRecoveryActionFor(hold, s.sessions.get(child.sessionId)))),
    sameStrings,
  );
  const heldChildRecoveryAction = useCallback((childSessionId: string, hold: SessionHoldView) => {
    let index = 0;
    for (const child of heldChildren) {
      for (const candidate of child.holds) {
        if (child.sessionId === childSessionId && candidate.holdId === hold.holdId) {
          return heldChildStoreRecoveryActions[index] ?? hold.recoveryAction;
        }
        index += 1;
      }
    }
    return hold.recoveryAction;
  }, [heldChildStoreRecoveryActions, heldChildren]);
  const ownStandaloneApproval = standaloneApprovalForReview(session.pendingApproval);
  const ownWorkerApproval = session.pendingApproval?.ownerToolUseId
    ? session.pendingApproval : null;
  const ownApprovalRequestId = ownStandaloneApproval?.requestId;
  const ownApprovalOccurrenceId = ownStandaloneApproval?.occurrenceId ?? ownStandaloneApproval?.requestId;
  const timelineApprovalRequestId = ownApprovalRequestId ?? ownWorkerApproval?.requestId;
  const ownWorkflowDecision = ownStandaloneApproval?.kind === "workflow_decision"
    ? ownStandaloneApproval.workflowDecision : undefined;
  const ownEvidenceSnapshot = ownWorkflowDecision?.resourceSnapshot.category === "ui_evidence_approval"
    ? ownWorkflowDecision.resourceSnapshot : null;
  const ownEvidenceDecision = ownEvidenceSnapshot ? ownWorkflowDecision! : null;
  const [selectedRequestKey, setSelectedRequestKey] = useState<string | null>(null);
  const requestPanelModeActive = mode === "expanded" && rightPanel.mode === "requests";
  const openRequestPanel = useCallback((key: string) => {
    setSelectedRequestKey(key);
    rightPanel.show("requests");
    if (mode === "preview") onExpand?.();
  }, [mode, onExpand, rightPanel]);
  useLayoutEffect(() => {
    if (!requestPanelModeActive || ownStandaloneApproval || descendantRequests.length > 0 ||
        (descendantRequestStatus !== "idle" && descendantRequestStatus !== "ready")) return;
    rightPanel.setMode("launcher");
    if (rightPanel.open) rightPanel.close();
  }, [descendantRequests.length, descendantRequestStatus, ownStandaloneApproval,
    requestPanelModeActive, rightPanel]);
  const anchorRecoveryPending = eventHistory?.refreshing === true ||
    (conn === "online" && eventHistory?.everComplete !== true && eventHistory?.error == null);
  const recoveryRevision = useStoreSelector((s) =>
    subscriptionRecoveryRevision(s.streamSubscriptions, [sessionId]));
  const activity = useStoreSelector((s) => s.activity.get(sessionId));
  const activityNow = useStoreSelector((s) => s.activityNow);
  const stalled = useStoreSelector((s) => s.stalledSessionIds.has(sessionId));
  const lastActivityAt = Math.max(session.lastEventAt ?? 0, activity?.lastEventAt ?? 0) || session.updatedAt;
  const [text, setText] = useState("");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerExpansionSessionRef = useRef(sessionId);
  const draftDirty = useRef(false);
  const [busy, setBusy] = useState(false);
  const [handoffTurn, setHandoffTurn] = useState<number | null>(null);
  const [restartPending, setRestartPending] = useState(false);
  const [setupRetryPending, setSetupRetryPending] = useState(false);
  const setupSuggestion = useWorktreeSetupSuggestion(
    showWorktreeSetupNotice && session.projectId ? session as SessionView & { projectId: string } : undefined,
    () => openSourceLocation({ path: ".wollipog.json" }),
  );
  // Only the expanded session shows the condition (the slot and the Pinned Summary), so a preview
  // does not read the Machine's assignments.
  const skillsUnavailable = useSessionSkillsUnavailable({
    runnerId: session.runnerId,
    agentId: session.agentId,
    adapter: mode === "expanded" ? session.executionTarget?.adapter : undefined,
  });
  const [skillsNoticeDismissed, dismissSkillsNotice] = useSkillsNoticeDismissal(session.id);
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
  // The command alone cannot say which control is busy: one commandId can own several resolution
  // controls at once (the recovery card's Retry and Dismiss, plus the composer row's Dismiss), so
  // the action travels with it and each control reports progress only for its own request.
  const [pendingPromptAction, setPendingPromptAction] = useState<{
    commandId: string;
    action: "cancel" | "dismiss" | "retry";
  }>();
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
  const revealOrdinaryComposerRef = useRef<(focus: "always" | "answer-owned") => void>(() => {});
  const forkInFlightRef = useRef(false);
  const readForkInProgress = useCallback(() => sessionForkInProgress(sessionId), [sessionId]);
  const forkInProgress = useSyncExternalStore(
    subscribeSessionForks,
    readForkInProgress,
    readForkInProgress,
  );
  const viewGenerationRef = useRef(0);
  const [historyRetry, setHistoryRetry] = useState(0);
  const timelineHistoryKey = `${session.id}:${session.eventEpoch ?? 0}`;
  const timelineHistoryKeyRef = useRef(timelineHistoryKey);
  timelineHistoryKeyRef.current = timelineHistoryKey;
  const [olderRequestSettled, setOlderRequestSettled] = useState({
    historyKey: timelineHistoryKey,
    version: 0,
  });
  const [openingHistoryFill, setOpeningHistoryFill] = useState({
    historyKey: timelineHistoryKey,
    settled: false,
  });
  const [optimisticModel, setOptimisticModel] = useState<string | undefined>();
  const [activeSlashCommandId, setActiveSlashCommandId] = useState<string | null>(null);
  const [timelineRevealRequest, setTimelineRevealRequest] = useState<TimelineRevealRequest | null>(null);
  const timelineRevealRequestRef = useRef<TimelineRevealRequest | null>(null);
  const timelineRevealRestoreState = useRef<{ requestId: number; state: FollowTailState } | null>(null);
  const timelineRevealRequestId = useRef(0);
  const automaticEarlierLoadRef = useRef({
    historyKey: timelineHistoryKey,
    requestedBase: null as number | null,
    nextTriggerTop: null as number | null,
    readerStarted: false,
    settling: false,
    settleFrame: null as number | null,
    readerIntent: null as EarlierActivityIntent | null,
    readerIntentTop: null as number | null,
    inputHeld: false,
    nativeTouchActive: false,
    touchInputY: null as number | null,
    touchStartY: null as number | null,
    touchTraversalStarted: false,
    intentIdleTimer: null as number | null,
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
  // The chip never takes focus from a pointer (#1797), so the inspector cannot learn its opener
  // from the focused element at open.
  const workspaceReferenceReturnFocusRef = useRef<HTMLElement | null>(null);
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
  const attentionEntryScope = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== "expanded") return;
    const scope = `${session.id}:${session.eventEpoch ?? 0}`;
    if (attentionEntryScope.current === scope) return;
    attentionEntryScope.current = scope;
    if (session.pendingApproval?.ownerToolUseId || session.pendingApproval?.additionalRequests?.length) {
      rightPanelRef.current.show("subagents");
    }
  }, [mode, session.id, session.eventEpoch, session.pendingApproval]);
  const backgroundInventoryRequestRef = useRef<string | null>(null);
  const [backgroundInventoryError, setBackgroundInventoryError] = useState<string | null>(null);
  const [backgroundInventoryAttempt, setBackgroundInventoryAttempt] = useState(0);
  const retryBackgroundInventory = useCallback(() => {
    backgroundInventoryRequestRef.current = null;
    setBackgroundInventoryError(null);
    setBackgroundInventoryAttempt((attempt) => attempt + 1);
  }, []);
  useEffect(() => {
    if (mode !== "expanded" || !rightPanel.open || !["background", "subagents"].includes(rightPanel.mode) ||
        session.backgroundJobsAvailable !== true || session.backgroundJobs !== undefined) {
      if (session.backgroundJobs !== undefined || mode !== "expanded" ||
          !rightPanel.open || !["background", "subagents"].includes(rightPanel.mode)) {
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
  const composerPointerTransferRef = useRef<"inside" | "outside" | null>(null);
  const composerFocusRestoreFrameRef = useRef<number | null>(null);
  const pendingRequestFallbackFocusRef = useRef<string | null>(null);
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
  const focusComposerRequestedRef = useRef(composerFocusIntent !== undefined);
  focusComposerRequestedRef.current = composerFocusIntent !== undefined;

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
        if (isMobileRef.current) {
          // The idle phone capsule removes the textarea from layout. Reveal it in a commit before
          // restoring focus, otherwise browsers correctly reject focus on the hidden control.
          setComposerExpanded(true);
        } else {
          element.focus({ preventScroll: true });
          if (restoreComposerFocus(element, remembered)) {
            pendingComposerFocusRestoreRef.current = null;
            reportComposerFocus(sessionId, "restore", element, false);
          }
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
    if (isMobile && !composerExpanded) return;
    const active = element.ownerDocument.activeElement;
    if (active && active !== element.ownerDocument.body && active !== element) {
      pendingComposerFocusRestoreRef.current = null;
      return;
    }
    // Preserve focus throughout asynchronous hydration even when the empty replacement textarea
    // cannot restore the remembered selection geometry until its stored draft arrives.
    element.focus({ preventScroll: true });
    if (!restoreComposerFocus(element, pending)) return;
    pendingComposerFocusRestoreRef.current = null;
    reportComposerFocus(sessionId, "restore", element, false);
  }, [composerExpanded, isMobile, sessionId, text]);

  useEffect(() => {
    let clearExplicitTransferTimer: ReturnType<typeof setTimeout> | null = null;
    let clearPointerTransferTimer: ReturnType<typeof setTimeout> | null = null;
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
      if (clearPointerTransferTimer) clearTimeout(clearPointerTransferTimer);
      clearPointerTransferTimer = null;
      composerPointerTransferRef.current = null;
      if (!composer || !(event.target instanceof Node) || composer.contains(event.target)) return;
      markExplicitTransfer();
      // Safari and Firefox on macOS need the inside marker because clicking a button may blur the
      // textarea without focusing the button. The control must survive until its click completes.
      composerPointerTransferRef.current = composerOwns(composer.closest(".composer-box"), event.target)
        ? "inside"
        : "outside";
    };
    const finishExplicitPointerTransfer = () => {
      const transfer = composerPointerTransferRef.current;
      if (transfer === null) return;
      composerPointerTransferRef.current = null;
      if (clearPointerTransferTimer) clearTimeout(clearPointerTransferTimer);
      clearPointerTransferTimer = null;
      const composer = inputRef.current;
      const composerBox = composer?.closest(".composer-box");
      const activeElement = composer?.ownerDocument.activeElement;
      if (transfer === "outside" && !composerOwns(composerBox, activeElement ?? null)) {
        setComposerExpanded(false);
      }
    };
    const schedulePointerTransferFallback = () => {
      if (composerPointerTransferRef.current === null) return;
      if (clearPointerTransferTimer) clearTimeout(clearPointerTransferTimer);
      clearPointerTransferTimer = setTimeout(finishExplicitPointerTransfer, COMPOSER_POINTER_CLICK_FALLBACK_MS);
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
    document.addEventListener("click", finishExplicitPointerTransfer);
    document.addEventListener("pointerup", schedulePointerTransferFallback);
    document.addEventListener("pointercancel", finishExplicitPointerTransfer);
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
      document.removeEventListener("click", finishExplicitPointerTransfer);
      document.removeEventListener("pointerup", schedulePointerTransferFallback);
      document.removeEventListener("pointercancel", finishExplicitPointerTransfer);
      document.removeEventListener("keydown", markExplicitKeyboardTransfer, true);
      window.removeEventListener("blur", markWindowTransfer);
      window.removeEventListener("focus", clearExplicitTransfer);
      window.removeEventListener(KEYBOARD_DISMISS_BLUR_EVENT, markExplicitTransfer);
      if (clearExplicitTransferTimer) clearTimeout(clearExplicitTransferTimer);
      if (clearPointerTransferTimer) clearTimeout(clearPointerTransferTimer);
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
      if (explicit && composerPointerTransferRef.current === null &&
          !composerOwns(element.closest(".composer-box"), relatedElement)) {
        setComposerExpanded(false);
      }
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
    const sessionChanged = composerExpansionSessionRef.current !== sessionId;
    composerExpansionSessionRef.current = sessionId;
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
    if (sessionChanged) setComposerExpanded(false);
  }, [sessionId]);

  const focusComposerAtDraftEnd = useCallback(() => {
    const element = inputRef.current;
    if (!element) return;
    setComposerExpanded(true);
    const focus = () => {
      const moved = focusComposerAtEnd(element, composerComposingRef.current);
      const focused = element.ownerDocument.activeElement === element;
      if (moved && focused && draftHydratedSessionRef.current !== sessionId) {
        pendingHydrationCaretRef.current = {
          sessionId,
          interactionVersion: composerInteractionVersionRef.current,
        };
      }
      return focused;
    };
    // A collapsed phone composer hides its textarea. Retry after React commits the expanded
    // state; desktop and already-expanded composers retain the immediate focus path.
    if (!focus() && isMobile) window.requestAnimationFrame(focus);
  }, [isMobile, sessionId]);

  const focusComposerAfterRequestResolution = useCallback(() => {
    const element = inputRef.current;
    if (!element) return false;
    if (element.disabled) return false;
    if (!isMobile || composerExpanded) {
      element.focus({ preventScroll: true });
      return element.ownerDocument.activeElement === element;
    }
    // The request coordinator runs after the resolving commit has hidden an idle phone textarea.
    // Own the fallback now, reveal in the next synchronous layout commit, then focus before paint.
    pendingRequestFallbackFocusRef.current = sessionId;
    setComposerExpanded(true);
    return true;
  }, [composerExpanded, isMobile, sessionId]);

  useLayoutEffect(() => {
    if (pendingRequestFallbackFocusRef.current !== sessionId) return;
    if (isMobile && !composerExpanded) return;
    pendingRequestFallbackFocusRef.current = null;
    inputRef.current?.focus({ preventScroll: true });
  }, [composerExpanded, isMobile, sessionId]);

  const expandIdleComposer = useCallback(() => {
    // Keep expansion and focus inside the activating gesture so iOS is allowed to open its
    // software keyboard. A requestAnimationFrame retry occurs too late for that permission.
    flushSync(() => setComposerExpanded(true));
    focusComposerAtDraftEnd();
  }, [focusComposerAtDraftEnd]);

  useLayoutEffect(() => {
    const pending = retitleFocusRestoreRef.current;
    if (retitleFeedback !== null || pending === null) return;
    if (pending.sessionId !== sessionId || viewGenerationRef.current !== pending.generation) {
      retitleFocusRestoreRef.current = null;
      return;
    }
    const input = inputRef.current;
    if (!input || input.ownerDocument.activeElement !== input.ownerDocument.body) {
      retitleFocusRestoreRef.current = null;
      return;
    }
    if (isMobile && !composerExpanded) {
      setComposerExpanded(true);
      return;
    }
    retitleFocusRestoreRef.current = null;
    if (restoreComposerFocus(input, pending.composer)) {
      reportComposerFocus(sessionId, "restore", input, false);
    }
  }, [composerExpanded, isMobile, retitleFeedback, sessionId]);

  useLayoutEffect(() => {
    if (mode !== "expanded" || focusComposerRequestedRef.current || attentionTarget) return;
    const frame = window.requestAnimationFrame(() => scrollRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mode, sessionId, attentionTarget]);

  useEffect(() => {
    if (composerFocusIntent !== "message") return;
    const frame = window.requestAnimationFrame(() => {
      focusComposerAtDraftEnd();
      onComposerFocusConsumed?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [composerFocusIntent, focusComposerAtDraftEnd, onComposerFocusConsumed, sessionId]);

  const sessionCaps = resolveCaps(runner, session);
  const effectiveModel = optimisticModel ?? session?.model;
  const selectedModelSupportsImages = modelSupportsImages(sessionCaps, effectiveModel);
  // Codex app-server forks predate the generic capability bit (rolling-upgrade compatibility).
  // Claude and Pi must explicitly prove their native clone surface before the button appears.
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
    revealOrdinaryComposerRef.current("answer-owned");
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
    revealOrdinaryComposerRef.current("always");
    markDraftDirty();
    const next = appendTranscript(draftState.current.text, phrase);
    setProgrammaticComposerText(next);
  });
  const insertSideChatDraft = useCallback((response: string) => {
    revealOrdinaryComposerRef.current("always");
    markDraftDirty();
    const next = appendTranscript(draftState.current.text, response);
    setProgrammaticComposerText(next);
  }, [markDraftDirty, setProgrammaticComposerText]);
  // Shared git status: the composer branch chip + the right panel's Review mode read one
  // fetch. Called before the !session guard — hooks must run unconditionally.
  // Inbox previews render neither the composer Git chip, pinned summary, nor Review panel. Do not
  // turn keyboard preview navigation into runner Git/gh fanout for facts nobody can see.
  const gitConsumerSession = mode === "expanded" ? session : undefined;
  const pinnedSummary = mode === "expanded" ? pinnedSummaryProp : undefined;
  const summaryConsumerSession = mode === "expanded" && (richGitSupported || pinnedSummary?.open)
    ? session
    : undefined;
  // The summary docks while the session body leaves the reader 560px beside it. The stylesheet's
  // container query lays that out; this mirrors it, so the toggle, focus and scrim agree. A body
  // with no layout (width 0) reports nothing.
  const [detailBody, setDetailBody] = useState<HTMLDivElement | null>(null);
  const reportSummaryBodyWidth = pinnedSummary?.reportBodyWidth;
  useLayoutEffect(() => {
    if (!detailBody || !reportSummaryBodyWidth) return;
    const report = (width: number) => {
      if (width > 0) reportSummaryBodyWidth(width);
    };
    report(detailBody.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) report(entry.contentRect.width);
    });
    observer.observe(detailBody);
    return () => observer.disconnect();
  }, [detailBody, reportSummaryBodyWidth]);
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
    const commitOrdinaryDraftHydration = (draft: ComposerDraft | null) => {
      if (cancelled) return;
      if (draft && !draftDirty.current) {
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
    };
    const reconcileOrdinaryDraftHydration = async (initialDraft: ComposerDraft | null) => {
      let draft = initialDraft;
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
      } else {
        commitOrdinaryDraftHydration(draft);
      }
    };
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
      const finishRecoveryRestore = (
        candidate: QueuedPromptEditRecovery,
        expectedDurableRecovery?: QueuedPromptEditRecovery,
        ordinaryDraft?: ComposerDraft | null,
      ) => {
        if (cancelled) return;
        if (queuedEditRef.current && !pendingQueuedEdit &&
            (!hydrationKeyChanged || queuedEditRef.current !== queuedEditAtHydrationStart)) return;
        let restored = candidate;
        let displacedDraftChanged = false;
        if (draftDirty.current && queuedEditRef.current === null) {
          const displacedDraft = {
            text: draftState.current.text,
            images: draftState.current.images.map((image) => ({ ...image })),
          };
          restored = recoveryWithDisplacedDraft(restored, displacedDraft);
          displacedDraftChanged = true;
          void saveComposerDraft(sessionId, displacedDraft.text, displacedDraft.images, instanceScope);
        }
        if (queuedEditRecoveryScope && expectedDurableRecovery) {
          const refresh = refreshDurableQueuedEditRecovery(
            queuedEditRecoveryScope,
            expectedDurableRecovery,
            restored,
          );
          if (refresh === "stale") {
            clearRuntimeQueuedEditRecovery(mutationKey);
            void reconcileOrdinaryDraftHydration(ordinaryDraft ?? null);
            return;
          }
          if (refresh === "conflict") {
            clearRuntimeQueuedEditRecovery(mutationKey);
            const current = loadDurableQueuedEditRecovery(queuedEditRecoveryScope);
            if (!current) {
              void reconcileOrdinaryDraftHydration(ordinaryDraft ?? null);
              return;
            }
            let latest = !current.error
              ? { ...current, error: "The prior queued message edit outcome was not recorded. Check the current queue before retrying." }
              : current;
            if (latest.edit.displacedDraftStoredSeparately && ordinaryDraft !== undefined) {
              latest = recoveryWithDisplacedDraft(latest, ordinaryDraft);
            }
            if (draftDirty.current && queuedEditRef.current === null) {
              latest = recoveryWithDisplacedDraft(latest, {
                text: draftState.current.text,
                images: draftState.current.images.map((image) => ({ ...image })),
              });
            }
            storeRuntimeQueuedEditRecovery(mutationKey, queuedEditRecoveryScope.accountKey, latest);
            restoreQueuedPromptEditRecovery(latest, false);
            return;
          }
        } else if (queuedEditRecoveryScope && displacedDraftChanged) {
          saveDurableQueuedEditRecovery(queuedEditRecoveryScope, restored);
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
          finishRecoveryRestore(
            recoveryWithDisplacedDraft(queuedEditRecovery, displaced),
            storedQueuedEdit,
            displaced,
          );
        })();
      } else {
        finishRecoveryRestore(queuedEditRecovery);
      }
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      const draft = await loadDraftForSession(sessionId, instanceScope);
      if (cancelled) return;
      await reconcileOrdinaryDraftHydration(draft);
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
            const refresh = refreshDurableQueuedEditRecovery(
              queuedEditRecoveryScope,
              queuedEditRecovery,
              restored,
            );
            if (refresh === "stale" || refresh === "conflict") {
              clearRuntimeQueuedEditRecovery(mutationKey);
              return;
            }
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
      revealOrdinaryComposerRef.current("answer-owned");
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
    if (!beginOlderEventsLoad(sessionId, base, epoch)) {
      olderInFlightRef.current = false;
      return false;
    }
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
        if (timelineHistoryKeyRef.current !== timelineHistoryKey) return;
        setOlderRequestSettled((current) => ({
          historyKey: timelineHistoryKey,
          version: current.historyKey === timelineHistoryKey ? current.version + 1 : 1,
        }));
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
    if (state.intentIdleTimer !== null) window.clearTimeout(state.intentIdleTimer);
    state.intentIdleTimer = null;
    state.readerIntent = null;
    state.readerIntentTop = null;
    state.readerIntentMovedUp = false;
    state.inputHeld = false;
    state.nativeTouchActive = false;
    state.touchInputY = null;
    state.touchStartY = null;
    state.touchTraversalStarted = false;
  }, []);

  // Expire an armed traversal once its scroll stream goes quiet, unless the reader still holds the
  // finger or button that started it. A prepend, a live row, or a reveal that scrolls later must
  // never inherit intent from input the reader finished long ago.
  const deferEarlierActivityIdleEnd = useCallback(() => {
    const state = automaticEarlierLoadRef.current;
    if (!state.readerIntent) return;
    if (state.intentIdleTimer !== null) window.clearTimeout(state.intentIdleTimer);
    state.intentIdleTimer = window.setTimeout(() => {
      state.intentIdleTimer = null;
      if (!state.inputHeld && state.readerIntent) clearEarlierActivityIntent();
    }, EARLIER_ACTIVITY_INTENT_IDLE_MS);
  }, [clearEarlierActivityIntent]);

  const markEarlierActivityIntent = useCallback((
    intent: EarlierActivityIntent,
    touchInputY: number | null = null,
  ) => {
    const state = automaticEarlierLoadRef.current;
    if (state.intentIdleTimer !== null) window.clearTimeout(state.intentIdleTimer);
    state.intentIdleTimer = null;
    state.readerIntent = intent;
    state.readerIntentTop = scrollRef.current?.scrollTop ?? null;
    state.readerIntentMovedUp = false;
    state.inputHeld = intent === "touch-traversal";
    state.touchInputY = touchInputY;
    state.touchStartY = touchInputY;
    state.touchTraversalStarted = false;
    cancelEarlierActivitySettle();
    // A touch stays armed while the finger is down; a single scroll must produce its stream soon.
    if (intent === "single-scroll") deferEarlierActivityIdleEnd();
  }, [cancelEarlierActivitySettle, deferEarlierActivityIdleEnd]);

  const markSingleEarlierActivityIntent = useCallback(() => {
    markEarlierActivityIntent("single-scroll");
  }, [markEarlierActivityIntent]);

  // A scrollbar press stays armed for as long as the button is held: the drag it starts may begin
  // well after the idle window and still end at the head.
  const markPointerEarlierActivityIntent = useCallback((target: HTMLElement) => {
    markEarlierActivityIntent("single-scroll");
    const state = automaticEarlierLoadRef.current;
    state.inputHeld = true;
    const view = target.ownerDocument.defaultView ?? window;
    const release = () => {
      view.removeEventListener("pointerup", release);
      view.removeEventListener("pointercancel", release);
      if (state.readerIntent !== "single-scroll" || !state.inputHeld) return;
      state.inputHeld = false;
      deferEarlierActivityIdleEnd();
    };
    view.addEventListener("pointerup", release);
    view.addEventListener("pointercancel", release);
  }, [deferEarlierActivityIdleEnd, markEarlierActivityIntent]);

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

  const finishTouchEarlierActivityIntent = useCallback(() => {
    const state = automaticEarlierLoadRef.current;
    if (state.readerIntent !== "touch-traversal") return;
    state.inputHeld = false;
    deferEarlierActivityIdleEnd();
  }, [deferEarlierActivityIdleEnd]);

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

  // `source` names what delivered the reader here: the scroll stream of a gesture, or explicit
  // upward input at the head, where the browser has no scroll event left to emit.
  const maybeLoadEarlier = useCallback((scroll: HTMLElement, source: "scroll" | "input" = "scroll") => {
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
    if (eventWindow?.hasOlder !== true || eventWindow.error || eventWindow.baseSeq <= 1 || !readerIntent) {
      clearEarlierActivityIntent();
      return;
    }
    if (eventWindow.loadingOlder || state.requestedBase !== null || state.settling) {
      // A page in flight or a prepend still settling is a pause, not an answer. Keep the traversal
      // armed under its idle expiry: the prepend that follows moves the reader away from the head,
      // which reads as forward movement and releases it; a stream that outlives the settle window
      // can still load once the window closes.
      if (!state.inputHeld) deferEarlierActivityIdleEnd();
      return;
    }

    const previousIntentTop = state.readerIntentTop;
    const movedUp = previousIntentTop !== null && scroll.scrollTop < previousIntentTop - 1;
    const movedDown = previousIntentTop !== null && scroll.scrollTop > previousIntentTop + 1;
    if (movedDown) {
      // Reading forward is never a request for history, whatever armed the traversal.
      clearEarlierActivityIntent();
      return;
    }
    if (movedUp && (readerIntent === "single-scroll" || state.inputHeld || state.touchTraversalStarted)) {
      state.touchTraversalStarted = readerIntent === "touch-traversal";
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
      // Keep the traversal armed while its stream continues upward. A gesture that starts above
      // the trigger and lands inside it, or at the head itself, is exactly the one that must load;
      // consuming its intent on the first event would strand the reader at the manual control.
      state.readerIntentTop = scroll.scrollTop;
      if (!state.inputHeld) deferEarlierActivityIdleEnd();
      return;
    }
    // Explicit input at the head stands in for the scroll movement that cannot happen there; above
    // the head, that same input still has a scroll stream on the way, so leave it to that path.
    const atHead = scroll.scrollTop < 1;
    if (source === "input" && !atHead) return;
    if (readerIntent === "touch-traversal" && !state.readerIntentMovedUp &&
        !(source === "input" && state.touchTraversalStarted)) {
      return;
    }

    clearEarlierActivityIntent();
    state.readerStarted = true;
    state.nextTriggerTop = null;
    if (loadOlder()) state.requestedBase = eventWindow.baseSeq;
  }, [cancelEarlierActivitySettle, clearEarlierActivityIntent, deferEarlierActivityIdleEnd, eventWindow, loadOlder, timelineHistoryKey]);

  // At the head, upward input produces no scroll event, so the scroll path can never see it.
  // Evaluate the armed intent directly, but only when the reader cannot scroll further up.
  const requestEarlierFromInputAtHead = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll || scroll.scrollTop >= 1) return;
    maybeLoadEarlier(scroll, "input");
  }, [maybeLoadEarlier]);

  const requestEarlierFromTouchAtHead = useCallback((clientY: number | null, target: EventTarget | null) => {
    const state = automaticEarlierLoadRef.current;
    if (state.readerIntent !== "touch-traversal" || !state.touchTraversalStarted) return;
    if (clientY === null || state.touchStartY === null) return;
    if (clientY - state.touchStartY < EARLIER_ACTIVITY_HEAD_DRAG_PX) return;
    const scroll = scrollRef.current;
    if (!scroll || nestedScrollerConsumesUpwardInput(target, scroll)) return;
    requestEarlierFromInputAtHead();
  }, [requestEarlierFromInputAtHead]);

  const loadEarlierFromControl = useCallback((): boolean => {
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
    if (base === undefined || !loadOlder()) return false;
    clearEarlierActivityIntent();
    state.readerStarted = true;
    state.nextTriggerTop = null;
    state.requestedBase = base;
    return true;
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
    // Session Reading keys and Inbox paging claim the viewport right before a programmatic
    // scroll. A downward claim is never a request for history; an upward one at the head has no
    // scroll event to ride on, exactly like an upward reading key on the region itself.
    const markProgrammaticIntent = (event: Event) => {
      const direction = virtualViewportIntentDirection(event);
      if (direction === "down") return;
      markSingleEarlierActivityIntent();
      if (direction === "up") requestEarlierFromInputAtHead();
    };
    scroll.addEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, markProgrammaticIntent);
    return () => scroll.removeEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, markProgrammaticIntent);
  }, [markSingleEarlierActivityIntent, requestEarlierFromInputAtHead]);

  // Incremental derivation: streamed chunks push only the NEW events into a per-session
  // builder instead of re-folding the whole array (O(n²) over a long session).
  const items = useTimeline(sessionId, evs, session.eventEpoch ?? 0);
  const ownApprovalHasTimelineRow = timelineApprovalRequestId !== undefined && items.some((item) =>
    item.kind === "permission" && item.requestId === timelineApprovalRequestId &&
    item.resolvedOptionId === undefined);
  // Governance outcomes are transcript context, not a persistent header: the decisions whose
  // request has no transcript row of its own are spliced in at their chronological position, and
  // the whole list stays reviewable in the side panel (a full-screen drawer on phones).
  const governanceAudit = useGovernanceAudit(
    sessionId,
    `${session.updatedAt}:${session.pendingApproval?.requestId ?? ""}`,
    mode === "expanded",
    evs?.[0]?.ts,
  );
  const governanceDecisions = governanceAudit.decisions;
  const timelineItems = useGovernanceTimeline(
    items,
    governanceDecisions,
    evs,
    session.status === "running" || session.status === "starting",
    timelineHistoryKey,
  );
  const automaticAccountSwitchNotice = useRef<AutomaticAccountSwitchNoticeState>({
    sessionId: session.id,
    seenThroughEventId: 0,
    initialized: false,
  });
  useEffect(() => {
    const update = advanceAutomaticAccountSwitchNotice(automaticAccountSwitchNotice.current, {
      sessionId: session.id,
      historyReady: eventHistory?.everComplete === true,
      loadedEventHighWater: (evs ?? []).reduce((highest, event) => Math.max(highest, event.seq), 0),
      items: timelineItems,
    });
    automaticAccountSwitchNotice.current = update.state;
    if (update.providerAccountLabel) {
      showToast(`Moved this session to ${accountLabelText(update.providerAccountLabel, "another account")} after its prior account exhausted a usage window.`, {
        messageContent: <>Moved this session to <AccountLabel value={update.providerAccountLabel} hidden="another account" /> after its prior account exhausted a usage window.</>,
      });
    }
  }, [eventHistory?.everComplete, evs, session.id, showToast, timelineItems]);
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
  const rosterSessions = useStoreSelector((state) => state.sessions);
  const rosterRuns = useStoreSelector((state) => state.runs);
  const rosterRunners = useStoreSelector((state) => state.runners);
  const activeWorkerCount = useMemo(() => workerRoster(session, activeSubagents,
    (session.runId ? rosterRuns.get(session.runId)?.sessionIds ?? [] : []).flatMap((id) => {
      const member = rosterSessions.get(id);
      return member ? [member] : [];
    }), (id) => rosterRunners.get(id)?.status === "online").filter(isCurrentWorker).length,
  [session, activeSubagents, rosterSessions, rosterRuns, rosterRunners]);
  const visibleBackgroundWorkState = session.backgroundWorkState === "resumed"
    ? undefined
    : session.backgroundWorkState;
  const shownDelivery = shownWatchdogDelivery(session.backgroundDeliveries);
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
  // keystroke can never reflow — and scroll-clamp — the transcript above it (BUG-017). A browser
  // with `field-sizing: content` grows it from the stylesheet instead (#2154).
  useLayoutEffect(() => {
    if (mode !== "expanded" || composerFieldSizesToContent()) return;
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
  // A person the server refuses queue management (a Viewer) sees queued messages, delivery
  // receipts and steering attempts with their actions disabled and the reason (#1857).
  const queueRefusal = sessionCommandRefusal(session, "manageQueue");
  const queueRefusalId = `queued-refusal-${session.id}`;
  const resolvePendingPrompt = useCallback(async (
    commandId: string,
    action: "cancel" | "dismiss" | "retry",
  ) => {
    if (pendingPromptAction || queueRefusal !== null) return;
    setPendingPromptAction({ commandId, action });
    setError(null);
    try {
      await api.resolvePendingPrompt(session.id, commandId, action);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPendingPromptAction(undefined);
    }
  }, [api, pendingPromptAction, queueRefusal, session.id]);
  const cancelLivePendingPrompt = useCallback(async (commandId: string) => {
    if (pendingPromptAction || queueRefusal !== null) return;
    setPendingPromptAction({ commandId, action: "cancel" });
    setError(null);
    try {
      await api.cancelQueuedPrompt(session.id, commandId);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPendingPromptAction(undefined);
    }
  }, [api, pendingPromptAction, queueRefusal, session.id]);
  const terminal = isTerminal(session.status);
  // A guardrail pause (cost budget / tool-call limit) must be resolved via the Continue/Stop card,
  // not bypassed by sending a prompt.
  const policyPaused = isPolicyApproval(session.pendingApproval);
  // A quarantined provider conversation rejects every submission before the model runs, so the
  // composer must not invite retries that cannot succeed.
  const historyQuarantine = session.historyQuarantine;
  const worktreeRecovery = session.worktreeRecovery;
  const accountSwitchFailureKey = session.providerAccountSwitchFailure
    ? `${session.id}:${session.providerAccountSwitchFailure.detectedAt}` : null;
  const [dismissedAccountSwitchFailureKey, setDismissedAccountSwitchFailureKey] = useState<string | null>(null);
  const accountSwitchFailure = accountSwitchFailureKey !== dismissedAccountSwitchFailureKey
    ? session.providerAccountSwitchFailure : undefined;
  // The failed switch's notice opens the same dialog as More Actions → Switch Account….
  const [switchAccountOpen, setSwitchAccountOpen] = useState(false);
  const switchAccountButtonRef = useRef<HTMLButtonElement | null>(null);
  // The Session Archived notice's Unarchive (#2202): the same operation as More Actions' item.
  const [unarchivePending, setUnarchivePending] = useState(false);
  const unarchiveFromNotice = async (restarts: boolean) => {
    if (unarchivePending) return;
    setUnarchivePending(true);
    try {
      await unarchiveSession({
        sessionId: session.id,
        restarts,
        api,
        showToast,
        showUndo,
        reloadSession: async () => { loadSession((await api.session(session.id)).session); },
      });
    } finally {
      setUnarchivePending(false);
    }
  };
  // The notice slot's order for the conditions that also stop a new message. Their slot entries
  // take it from here, so the composer names the one the slot shows first (#2037).
  const worktreeMissingOrder = worktreeRecovery && {
    key: `worktree-missing:${worktreeRecovery.recoveryId}`, severity: "danger", rank: SESSION_NOTICE_RANK.worktreeMissing,
  } as const;
  const historyQuarantineOrder = historyQuarantine && {
    key: "history-quarantine", severity: "danger", rank: SESSION_NOTICE_RANK.historyQuarantine,
  } as const;
  const accountSwitchFailedOrder = accountSwitchFailure && {
    key: `account-switch-failed:${accountSwitchFailureKey}`, severity: "warning", rank: SESSION_NOTICE_RANK.accountSwitchFailed,
  } as const;
  // An archived session that has stopped says so in the slot, with Unarchive as the way back (#2202).
  const archivedOrder = sessionArchivedAtRest(session) ? {
    key: "archived", severity: "info", rank: SESSION_NOTICE_RANK.archived,
  } as const : undefined;
  const sessionNoticeReason = [
    worktreeMissingOrder && { ...worktreeMissingOrder, reason: "Worktree recovery is required before sending another message." },
    historyQuarantineOrder && { ...historyQuarantineOrder, reason: "Conversation quarantined. Recover this session to continue." },
    accountSwitchFailedOrder && { ...accountSwitchFailedOrder, reason: "Choose another account before sending another message." },
    archivedOrder && { ...archivedOrder, reason: "Unarchive the session to send a message." },
  ].filter((condition) => condition !== undefined).sort(compareSessionNotices)[0]?.reason;
  // A person the server refuses a prompt (a Viewer) gets a read-only composer that says why.
  const promptRefusal = sessionCommandRefusal(session, "prompt");
  // Friendly machine label (hostname + local/SSH) instead of the raw random box runner id.
  const runnerDisp = runnerDisplay(runner, box, session.runnerId);
  // Why the composer cannot send a new message now (#2154). Edit & Resend states the same reason.
  // An archived session is also stopped; its notice is in the slot, so the slot's order decides.
  const promptUnavailableReason = composerUnavailableReason({
    refusal: promptRefusal,
    archivedReason: archivedOrder ? sessionNoticeReason : undefined,
    status: session.status,
    runnerOnline,
    machineName: runnerDisp.name,
    noticeReason: sessionNoticeReason,
    policyPaused,
  });
  const canPrompt = promptUnavailableReason === null;
  const composerAgent = composerAgentName(session.driver, session.agentName, session.agentId);
  const composerPlaceholder = composerPlaceholderText({
    unavailableReason: promptUnavailableReason,
    agent: composerAgent,
    narrow: isMobile,
    inputPending: pendingRequests(session.pendingApproval).some((request) => !request.async),
    turnActive: session.status === "running",
    fileReferences: runnerSupportsProtocol(runner?.protocolVersion, "workspaceReferences"),
  });
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
  // A person the server refuses a response (a Viewer) never enters Answer Mode; the question card
  // says why (#1857).
  const responseRefusal = sessionCommandRefusal(session, "respond");
  const canAnswerPendingQuestion = pendingQuestion !== null && composerQuestions.length > 0 &&
    responseRefusal === null &&
    (pendingQuestion.recoveryReason !== "provider_restart" || pendingQuestion.recoveryAction === "resume_answer");
  const questionResponseStyle = useQuestionResponseStyle();
  const steeringAvailabilityInput = {
    runnerProtocolVersion: runner?.protocolVersion,
    runnerOnline,
    sessionStatus: session.status,
    activeTurnId: session.activeTurnId,
    supportsSteering: sessionCaps?.supportsSteering,
    policyPaused,
    inputPending: pendingRequests(session.pendingApproval).some((request) => !request.async),
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
  // A person the server refuses Stop Turn (a Viewer) keeps the button, disabled with the reason,
  // and its shortcut does nothing (#1857).
  const cancelTurnRefusal = sessionCommandRefusal(session, "cancelTurn");
  const [activePane, setActivePane] = useState<"reader" | "composer">("reader");
  const [answerModeRequestId, setAnswerModeRequestId] = useState<string | null>(null);
  const answerModeExplicitRequestRef = useRef<string | null>(null);
  const answerModeArrivalRef = useRef({
    requestId: null as string | null,
    style: questionResponseStyle,
    answerable: false,
  });
  const answerModeFocusRequestRef = useRef<"answer" | "message" | null>(null);
  const answerFocusRequestIdRef = useRef<string | null>(pendingQuestion?.requestId ?? null);
  const composerAnswerActive = canAnswerPendingQuestion && answerModeRequestId === pendingQuestion.requestId;
  const activeAnswerModeRequestRef = useRef<string | null>(composerAnswerActive ? answerModeRequestId : null);
  activeAnswerModeRequestRef.current = composerAnswerActive ? answerModeRequestId : null;
  const answerModeRegion = answerInputRef.current?.closest<HTMLElement>(".composer-answer") ?? null;
  const answerFocusOwnedBeforeRender = answerModeRegion !== null &&
    answerModeRegion.contains(answerInputRef.current!.ownerDocument.activeElement);

  const revealOrdinaryComposer = useCallback((focus: "always" | "answer-owned") => {
    const input = answerInputRef.current;
    const activeElement = input?.ownerDocument.activeElement ?? null;
    const region = input?.closest<HTMLElement>(".composer-answer") ?? null;
    const shouldFocus = focus === "always" || (region !== null && region.contains(activeElement));
    answerModeExplicitRequestRef.current = null;
    answerModeFocusRequestRef.current = shouldFocus && composerAnswerActive ? "message" : null;
    setAnswerModeRequestId(null);
    if (!composerAnswerActive && shouldFocus) window.requestAnimationFrame(focusComposerAtDraftEnd);
  }, [composerAnswerActive, focusComposerAtDraftEnd]);
  revealOrdinaryComposerRef.current = revealOrdinaryComposer;

  const exitAnswerMode = useCallback(() => {
    if (!answerModeRequestId || activeAnswerModeRequestRef.current !== answerModeRequestId) return;
    revealOrdinaryComposer("always");
  }, [answerModeRequestId, revealOrdinaryComposer]);
  const enterAnswerMode = useCallback(() => {
    if (!canAnswerPendingQuestion) {
      focusComposerAtDraftEnd();
      return;
    }
    answerModeExplicitRequestRef.current = pendingQuestion.requestId;
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
    if (composerFocusIntent !== "reply") return;
    // An Inbox Reply request is contextual: a pending question owns it before the ordinary
    // composer does. Resolve that ownership during the expansion commit so the very next bare key
    // cannot escape to the global shortcut layer while focus is waiting on an animation frame.
    enterAnswerMode();
    // Acknowledge only after InboxView's expansion frame records the new surface. Clearing the
    // request in this layout commit would cancel that frame; its replacement sees an ordinary
    // expansion and moves focus back to the reader.
    const frame = window.requestAnimationFrame(() => onComposerFocusConsumed?.());
    return () => window.cancelAnimationFrame(frame);
  }, [composerFocusIntent, enterAnswerMode, onComposerFocusConsumed, sessionId]);

  useLayoutEffect(() => {
    const liveRequestId = pendingQuestion?.requestId ?? null;
    const requestChanged = answerFocusRequestIdRef.current !== liveRequestId;
    answerFocusRequestIdRef.current = liveRequestId;
    if (requestChanged && answerModeExplicitRequestRef.current !== liveRequestId) {
      answerModeExplicitRequestRef.current = null;
    }
    if (requestChanged && answerModeFocusRequestRef.current === "answer") {
      answerModeFocusRequestRef.current = null;
    }
    if (!composerAnswerActive && answerFocusOwnedBeforeRender) {
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
  }, [answerFocusOwnedBeforeRender, composerAnswerActive, focusComposerAtDraftEnd, pendingQuestion?.requestId]);

  useEffect(() => {
    const previous = answerModeArrivalRef.current;
    const requestId = pendingQuestion?.requestId ?? null;
    const answerable = composerQuestions.length > 0;
    const requestChanged = previous.requestId !== requestId;
    const styleChanged = previous.style !== questionResponseStyle;
    const answerabilityChanged = previous.answerable !== answerable;
    const nextArrival = { requestId, style: questionResponseStyle, answerable };
    if (!requestId || questionResponseStyle !== "composer" || !answerable) {
      answerModeExplicitRequestRef.current = null;
      answerModeArrivalRef.current = nextArrival;
      if (!requestId || styleChanged || answerabilityChanged) setAnswerModeRequestId(null);
      return;
    }
    if (answerModeExplicitRequestRef.current !== requestId) answerModeExplicitRequestRef.current = null;
    if (requestChanged || styleChanged || answerabilityChanged) {
      answerModeArrivalRef.current = nextArrival;
      let cancelled = false;
      let frame: number | null = null;
      let remainingHydrationFrames = 120;
      const chooseInitialMode = () => {
        if (cancelled) return;
        if (answerModeExplicitRequestRef.current === requestId) {
          setAnswerModeRequestId(requestId);
          return;
        }
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
    if (cancelTurnRefusal !== null) return false;
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
  }, [api, canStopTurn, cancelTurnRefusal, clearStopTurnAttempt, mutationKey, sessionId]);

  useEffect(() => {
    if (mode !== "expanded" || !canStopTurn || cancelTurnRefusal !== null) return;
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
  }, [canStopTurn, cancelTurnRefusal, mode, stopTurn]);

  // Follow state belongs to the stable session surface, so compact/expanded mode changes preserve
  // the reader's position while a session change resets to live output.
  const followTail = useFollowTail({
    scrollRef,
    contentRevision: `${evs?.length ?? 0}:${items.length}:${pending?.text.length ?? 0}:${pending?.images.length ?? 0}:${session.status}`,
    sessionId,
    persistenceScope: instanceScope,
    rows: items,
    rowGeneration: session.eventEpoch ?? 0,
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
  const currentEarlierRequestSettled = (
    olderRequestSettled.historyKey === timelineHistoryKey && olderRequestSettled.version > 0
  );
  const readerStartedEarlierActivity = (
    automaticEarlierLoadRef.current.historyKey === timelineHistoryKey &&
    automaticEarlierLoadRef.current.readerStarted
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
  // The archive shortcut runs the header's archive action, so it is refused for the same people.
  const archiveRefusal = sessionArchiveActionRefusal(session);
  // F runs More Actions' Fork Conversation…, which the header registers here only while enabled.
  const forkShortcutRef = useRef<(() => void) | null>(null);
  const readingActions = useMemo<SessionReadingKeyActions>(() => ({
    nextSession: () => onNextSession?.(),
    previousSession: () => onPreviousSession?.(),
    approve: () => {
      if (responseRefusal === null) onApprove?.();
      else setError(responseRefusal);
    },
    deny: () => {
      if (responseRefusal === null) onDeny?.();
      else setError(responseRefusal);
    },
    archive: () => {
      if (archiveRefusal === null) onArchive?.();
      else setError(archiveRefusal);
    },
    snooze: () => onSnooze?.(),
    fork: () => forkShortcutRef.current?.(),
    reply: canAnswerPendingQuestion ? enterAnswerMode : focusComposerAtDraftEnd,
    pauseFollow: followTail.pause,
    resumeFollow: followTail.follow,
  }), [archiveRefusal, canAnswerPendingQuestion, enterAnswerMode, focusComposerAtDraftEnd, followTail.follow, followTail.pause, onApprove, onArchive, onDeny, onNextSession, onPreviousSession, onSnooze, responseRefusal]);
  const sessionReadingKeys = mode === "expanded" && !isMobile;
  useSessionReadingKeys({
    enabled: sessionReadingKeys,
    sessionId,
    scrollRef,
    composerAvailable: canPrompt,
    actions: readingActions,
  });
  // Fork also covers Edit in Fork, handoff and quarantine recovery, which share its route (#1864).
  const forkRefusal = sessionCommandRefusal(session, "fork");
  const rewindRefusal = sessionCommandRefusal(session, "rewind");
  const worktreeSetupRefusal = sessionCommandRefusal(session, "worktreeSetup");
  // A refusal can arrive while a confirmation is open; the handlers re-read these after it closes.
  const forkRefusalRef = useRef(forkRefusal);
  forkRefusalRef.current = forkRefusal;
  const rewindRefusalRef = useRef(rewindRefusal);
  rewindRefusalRef.current = rewindRefusal;
  // Rewind FILES to a per-turn checkpoint (T3-style). Stable identity (useCallback) — it rides
  // into the memoized timeline rows. The confirm copy is explicit that the conversation is not
  // rewound: the agent may still reference later changes in its context.
  const onRewind = useCallback(
    async (turn: number) => {
      if (rewindRefusal !== null) return;
      if (!await confirm({
        title: "Restore Files",
        message: `Files revert to the checkpoint before turn ${turn}, but the conversation does not. The agent keeps its memory of later turns.`,
        confirmLabel: "Restore Files",
        tone: "danger",
      }) || rewindRefusalRef.current !== null) return;
      await api.rewind(sessionId, turn).catch((e) => setError((e as Error).message));
    },
    [api, confirm, rewindRefusal, sessionId],
  );

  const onFork = useCallback(
    async (turn: number) => {
      if (busy || forkInFlightRef.current || forkRefusal !== null) return;
      const provider = session?.driver === "claude-code"
        ? "Claude session"
        : session?.driver === "pi"
          ? "Pi session"
          : "Codex thread";
      const providerNote = session?.driver === "claude-code" || session?.driver === "pi"
        ? ` ${session.driver === "pi" ? "Pi" : "Claude Code"} can fork only the latest completed conversation turn.`
        : "";
      if (!await confirm({
        title: "Create Fork",
        message: `A new ${provider} and isolated worktree are created after turn ${turn}; this session stays unchanged.${providerNote}`,
        confirmLabel: "Create Fork",
      }) || forkRefusalRef.current !== null) return;
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
    [api, busy, confirm, forkRefusal, mode, navigate, session?.driver, sessionId, showToast],
  );

  /**
   * Recovery for a quarantined conversation. It never repairs the poisoned thread — that is
   * impossible — and never deletes it: the original session, its transcript, and its provider
   * thread stay exactly as they are. What it creates is a usable conversation from the last
   * checkpoint known to precede the invalid item, with that checkpoint's files, plus any prompt
   * the session retained unsent while quarantined.
   */
  const onRecoverQuarantinedConversation = useCallback(async () => {
    const quarantine = session.historyQuarantine;
    if (!quarantine || quarantine.recoveryTurn === undefined || busy || forkInFlightRef.current ||
      forkRefusal !== null) return;
    const handoff = quarantine.recovery === "handoff";
    if (handoff && !session.agentId) {
      setError("This session has no agent on its runner, so a fresh conversation cannot be started for it.");
      return;
    }
    if (!await confirm({
      title: "Recover Session",
      message: handoff
        ? `A new session starts a fresh provider conversation seeded with a bounded, redacted summary of the visible dialogue through turn ${quarantine.recoveryTurn}, in a worktree holding that checkpoint's files. This session is left untouched for inspection.`
        : `A new session forks the provider conversation at turn ${quarantine.recoveryTurn}, which excludes the rejected item, in a worktree holding that checkpoint's files. This session is left untouched for inspection.`,
      confirmLabel: "Recover Session",
    }) || forkRefusalRef.current !== null) return;
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
    let releaseOnFinish = true;
    try {
      const recovered = await api.recoverQuarantinedConversation(
        sessionId,
        quarantine.recoveryTurn,
        handoff
          ? {
              agentId: session.agentId!,
              config: {
                ...(session.model ? { model: session.model } : {}),
                ...(session.effort ? { effort: session.effort } : {}),
                ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
                // The tier is a deliberate cost/latency choice; recovery must not quietly reset it.
                ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
              },
            }
          : undefined,
      );
      // Both matter and there is one composer. The handoff draft is what seeds a fresh thread with
      // the checkpoint dialogue, so it must lead; the retained prompt is the user's own unsent
      // request, so it follows as the actual instruction. Dropping either would break a promise the
      // confirmation just made.
      const context = recovered.handoffDraft;
      const retained = recovered.retainedPrompt;
      // Each draft is independently valid, but their attachments are not additive: concatenating
      // them can exceed the per-prompt image count or aggregate byte budget, or repeat the same
      // file, leaving a staged draft the composer refuses to send. Merge under the real validator,
      // and let the user's own attachments win the budget over recovered context.
      const mimeTypes = session.driver === "codex-app-server"
        ? CODEX_APP_SERVER_IMAGE_MIME_TYPES
        : PROMPT_IMAGE_MIME_TYPES;
      const images: PromptImageInput[] = [];
      const seen = new Set<string>();
      let droppedImages = 0;
      for (const image of [...(retained?.images ?? []), ...(context?.images ?? [])]) {
        const key = JSON.stringify(image);
        if (seen.has(key)) { droppedImages += 1; continue; }
        if (!validatePromptImageInputs([...images, image], mimeTypes).ok) { droppedImages += 1; continue; }
        seen.add(key);
        images.push(image);
      }
      const body = context && retained?.text
        ? `${context.text}\n\nYour unsent message follows.\n\n${retained.text}`
        : context?.text ?? retained?.text ?? "";
      const text = droppedImages
        ? `${body}\n\n[${droppedImages} attachment${droppedImages === 1 ? "" : "s"} could not be carried into this draft. Re-attach anything still needed.]`
        : body;
      if (text || images.length) {
        stageComposerDraftHandoff(recovered.id, text, images, instanceScope);
        await saveComposerDraft(recovered.id, text, images, instanceScope);
      }
      if (viewGenerationRef.current === generation) navigate({ name: "session", id: recovered.id });
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
  }, [api, busy, confirm, forkRefusal, instanceScope, mode, navigate, session.agentId, session.effort,
    session.historyQuarantine, session.model, session.permissionMode, sessionId, showToast]);

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
  const restartRefusal = sessionCommandRefusal(session, "restart");
  // The control plane refuses to restart an archived session, so the composer offers no Restart
  // there; the Session Archived notice's Unarchive (and Restart) is the way back (#2301).
  const composerRestartOffered = session.status === "stopped" &&
    session.stopOperation?.status !== "stop_failed" && !session.archived;
  const restartFromComposer = useCallback(async () => {
    if (!composerRestartOffered || !runnerOnline || busy || restartPending || restartRefusal !== null) return;
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
  }, [api, busy, composerRestartOffered, loadSession, restartPending, restartRefusal, runnerOnline, session.id]);
  const failedSetupWorktree = session.worktrees?.find((worktree) => worktree.setup?.status === "failed");
  const { creation: recoveryCreation, create: createRecoveryWorktreeWithProgress } =
    useRecoveryWorktreeCreation({ api, session, onSession: loadSession });
  // Held here rather than in the card: the notice slot unmounts the card while another notice shows,
  // and a selection still running must keep both recovery actions refused when it comes back, and
  // one that failed meanwhile must still say why.
  const [recoverySelectPending, setRecoverySelectPending] = useState(false);
  // Tied to its incident: a later recovery starts without an earlier one's failure.
  const [recoverySelectError, setRecoverySelectError] =
    useState<{ recoveryId: string | undefined; message: string } | null>(null);
  const createRecoveryWorktree = useCallback(async (input: { branch: string; baseRef?: string }) => {
    setError(null);
    setRecoverySelectError(null);
    await createRecoveryWorktreeWithProgress(input);
  }, [createRecoveryWorktreeWithProgress]);
  const selectRecoveryWorktree = useCallback(async (path: string) => {
    const generation = viewGenerationRef.current;
    const recoveryId = session.worktreeRecovery?.recoveryId;
    setError(null);
    setRecoverySelectError(null);
    setRecoverySelectPending(true);
    try {
      const result = await api.selectSessionWorktree(session.id, path);
      if (viewGenerationRef.current === generation) loadSession(result.session);
    } catch (cause) {
      if (viewGenerationRef.current === generation) setRecoverySelectError({ recoveryId, message: (cause as Error).message });
      throw cause;
    } finally {
      setRecoverySelectPending(false);
    }
  }, [api, loadSession, session.id, session.worktreeRecovery?.recoveryId]);
  const retryWorktreeSetup = useCallback(async () => {
    if (!failedSetupWorktree || setupRetryPending || !runnerOnline || worktreeSetupRefusal !== null) return;
    const generation = viewGenerationRef.current;
    setSetupRetryPending(true);
    setError(null);
    try {
      const result = await api.retryWorktreeSetup(session.id, failedSetupWorktree.path);
      loadSession(result.session);
      // Initial launch failures need a fresh start after setup succeeds. Provider forks and
      // handoffs are restored to idle by the runner so Retry never discards their continuation.
      if (result.session.status === "failed") loadSession(await api.restart(session.id));
    } catch (cause) {
      if (viewGenerationRef.current === generation) setError((cause as Error).message);
    } finally {
      if (viewGenerationRef.current === generation) setSetupRetryPending(false);
    }
  }, [api, failedSetupWorktree, loadSession, runnerOnline, session.id, session.status, setupRetryPending,
    worktreeSetupRefusal]);
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
  // Settled delivery receipts stay listed so they can be dismissed, but they are not pending work:
  // counting them would report an idle Session as busy until each one was dismissed.
  const pendingQueuedPrompts = pendingQueuedPromptCount(session.queued);
  const forkContext = useMemo(() => ({
    driver: session.driver,
    providerSupported: supportsConversationFork,
    hasWorktree: session.worktreePath != null,
    runnerOnline,
    runnerProtocolVersion: runner?.protocolVersion,
    status: session.status,
    queuedPrompts: pendingQueuedPrompts,
    busy,
    forkInProgress,
    forkRefusal,
  }), [
    busy,
    forkInProgress,
    forkRefusal,
    pendingQueuedPrompts,
    runner?.protocolVersion,
    runnerOnline,
    session.driver,
    session.status,
    session.worktreePath,
    supportsConversationFork,
  ]);
  const forkAvailabilityByTurn = useMemo(() => new Map(conversationCheckpointTurns.map((turn) => [
    turn,
    conversationForkAvailability(turn, latestKnownTurn, forkContext),
  ])), [conversationCheckpointTurns, forkContext, latestKnownTurn]);
  const handoffControls = useMemo(() => ({
    open: setHandoffTurn,
    reason: checkpointHandoffUnavailableReason({
      runnerOnline,
      runnerProtocolVersion: runner?.protocolVersion,
      hasWorktree: Boolean(session.worktreePath),
      status: session.status,
      queuedPrompts: pendingQueuedPrompts,
      busy,
      forkInProgress,
      forkRefusal,
    }),
  }), [runnerOnline, runner?.protocolVersion, session.worktreePath, pendingQueuedPrompts, session.status, busy, forkInProgress,
    forkRefusal]);
  const rewindUnavailableReason = rewindRefusal ?? (session.worktreePath == null
    ? "A worktree is required."
    : !runnerSupportsProtocol(runner?.protocolVersion, "checkpointRewind")
      ? runnerCapabilityRequirement(runner?.protocolVersion, "checkpointRewind", "checkpoint rewind")
      : undefined);
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
  const editInForkAvailabilityByItem = useMemo(() => {
    // Every offered message, usable or not, so an unavailable Edit in Fork says why (#1869).
    const targets = new Map<number, EditInForkAvailability>();
    for (const item of items) {
      if (item.kind !== "user_message") continue;
      const availability = editInForkAvailability(item.turn, completedConversationTurns, {
        driver: session.driver,
        hasWorktree: session.worktreePath != null,
        runnerOnline,
        runnerProtocolVersion: runner?.protocolVersion,
        status: session.status,
        queuedPrompts: pendingQueuedPrompts,
        busy,
        forkRefusal,
      });
      if (availability.available || availability.offered) targets.set(item.id, availability);
    }
    return targets;
  }, [api, busy, completedConversationTurns, forkRefusal, items, pendingQueuedPrompts, runner?.protocolVersion, runnerOnline, session.driver, session.status, session.worktreePath]);

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
    revealOrdinaryComposerRef.current("always");
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
    if (forkRefusal !== null) throw new Error(forkRefusal);
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
  }, [api, closeMessageAction, forkRefusal, instanceScope, navigate, sessionId]);

  // The session's problem states, shown one at a time in the notice slot above the composer
  // (#1966). An action a person cannot take now says why in a visible line it is described by.
  const runnerOfflineReason = runnerOnline ? null : `${runnerDisp.name || "This machine"} is offline.`;
  const accountSwitchApplicable = sessionAccountSwitchApplicable(session);
  const accountSwitchSupported = runnerSupportsProtocol(runner?.protocolVersion, "sessionProviderAccountSwitch");
  const sessionNotices: SessionNoticeEntry[] = [];
  if (worktreeRecovery && worktreeMissingOrder) {
    sessionNotices.push({
      ...worktreeMissingOrder,
      title: "Worktree Missing",
      render: ({ trailing }) => (
        <WorktreeRecoveryCard
          session={session}
          runnerOnline={runnerOnline}
          machineName={runnerDisp.name || undefined}
          creation={recoveryCreation}
          selecting={recoverySelectPending}
          selectError={recoverySelectError?.recoveryId === worktreeRecovery.recoveryId ? recoverySelectError.message : null}
          onCreate={createRecoveryWorktree}
          onSelect={selectRecoveryWorktree}
          trailing={trailing}
        />
      ),
    });
  }
  if (historyQuarantine && historyQuarantineOrder) {
    const quarantine = historyQuarantine;
    const recoverable = quarantine.recoveryTurn !== undefined;
    const recoverReason = forkRefusal ?? runnerOfflineReason;
    sessionNotices.push({
      ...historyQuarantineOrder,
      title: "Conversation Quarantined",
      render: ({ trailing }) => (
        <Notice tone="danger" role="status" ariaLabel="Conversation Quarantined" title="Conversation Quarantined"
          trailing={trailing}
          actions={recoverable && (
            <button
              type="button"
              className="btn primary sm"
              disabled={busy || recoverReason !== null}
              title={recoverReason ?? undefined}
              aria-describedby={recoverReason !== null ? "history-quarantine-recovery-refusal" : undefined}
              onClick={() => void onRecoverQuarantinedConversation()}
            >
              Recover Session
            </button>
          )}
          details={(
            <>
              <p>
                {recoverable
                  ? `Recovering continues from the checkpoint after turn ${quarantine.recoveryTurn} in a new session with the same files. This session stays here, unchanged, for inspection.`
                  : "There is no earlier checkpoint to recover from. Start a new session to continue the work; the files in this session's worktree are unchanged."}
                {recoverable && quarantine.retainedPrompt
                  ? " Your unsent message moves to the recovered session's composer."
                  : ""}
              </p>
              <div className="code-well"><code>{providerHistoryRejection(items) ?? quarantine.reason}</code></div>
            </>
          )}>
          <p>The provider rejects something stored in this conversation, so new messages can&rsquo;t be sent here.</p>
          {recoverable && recoverReason !== null && (
            <p className="notice-meta" id="history-quarantine-recovery-refusal">{recoverReason}</p>
          )}
        </Notice>
      ),
    });
  }
  if (failedSetupWorktree) {
    const setupError = failedSetupWorktree.setup?.error?.trim();
    const retryReason = worktreeSetupRefusal ?? runnerOfflineReason;
    sessionNotices.push({
      key: `worktree-setup-failed:${failedSetupWorktree.path}`,
      severity: "danger",
      rank: SESSION_NOTICE_RANK.worktreeSetupFailed,
      title: "Worktree Setup Failed",
      render: ({ trailing }) => (
        <Notice tone="danger" role="status" ariaLabel="Worktree Setup Failed" title="Worktree Setup Failed"
          trailing={trailing}
          actions={(
            <BusyButton
              className="btn primary sm"
              busy={setupRetryPending}
              progress="Retrying the worktree setup…"
              disabled={retryReason !== null}
              title={retryReason ?? undefined}
              aria-describedby={retryReason !== null ? "worktree-setup-retry-refusal" : undefined}
              onClick={() => void retryWorktreeSetup()}
            >
              Retry Setup
            </BusyButton>
          )}>
          <p>{setupError ? asSentence(setupError) : "A required setup step failed."} The worktree was kept.</p>
          {retryReason !== null && <p className="notice-meta" id="worktree-setup-retry-refusal">{retryReason}</p>}
        </Notice>
      ),
    });
  }
  if (activeWorktreeSetupConfig?.status === "invalid") {
    const configError = activeWorktreeSetupConfig.error;
    sessionNotices.push({
      key: `worktree-setup-config-invalid:${session.worktreePath}`,
      severity: "danger",
      rank: SESSION_NOTICE_RANK.worktreeSetupConfigInvalid,
      title: "Invalid Worktree Setup Configuration",
      render: ({ trailing }) => (
        <Notice tone="danger" role="status" ariaLabel="Invalid Worktree Setup Configuration"
          title="Invalid Worktree Setup Configuration"
          trailing={trailing}
          details={<div className="code-well"><code>{configError}</code></div>}>
          <p>Wollipog can&rsquo;t read the setup configuration this worktree was created from, so its setup didn&rsquo;t run.</p>
        </Notice>
      ),
    });
  }
  if (accountSwitchFailure && accountSwitchFailedOrder) {
    const failure = accountSwitchFailure;
    // With hiding enabled, generated account sentences name an email-shaped account by role.
    const account = privacy.hide && isPersonalIdentifier(failure.providerAccountLabel)
      ? "the selected account"
      : failure.providerAccountLabel;
    const reason = privacy.hide ? redactPersonalIdentifiers(failure.reason, "the selected account") : failure.reason;
    // An email's local part can be case-sensitive; sentence formatting must not change it.
    const capitalizeReason = privacy.hide || !isPersonalIdentifier(reason.trim().split(/\s/u)[0]);
    const switchReason = !accountSwitchSupported
      ? runnerCapabilityRequirement(runner?.protocolVersion, "sessionProviderAccountSwitch", "session account switching")
      : runnerOfflineReason;
    sessionNotices.push({
      ...accountSwitchFailedOrder,
      title: "Account Switch Failed",
      render: ({ trailing }) => (
        <Notice tone="warning" role="status" ariaLabel="Account Switch Failed" title="Account Switch Failed"
          trailing={trailing}
          dismissLabel="Dismiss Notice"
          onDismiss={() => setDismissedAccountSwitchFailureKey(accountSwitchFailureKey)}
          actions={accountSwitchApplicable && (
            <button
              ref={switchAccountButtonRef}
              type="button"
              className="btn primary sm"
              disabled={switchReason !== null}
              title={switchReason ?? undefined}
              aria-describedby={switchReason !== null ? "account-switch-refusal" : undefined}
              onClick={() => setSwitchAccountOpen(true)}
            >
              Switch Account…
            </button>
          )}>
          <p>
            Wollipog couldn&rsquo;t continue with {account}.
            {" "}{asSentence(reason, capitalizeReason)}
          </p>
          {accountSwitchApplicable && switchReason !== null && (
            <p className="notice-meta" id="account-switch-refusal">{switchReason}</p>
          )}
        </Notice>
      ),
    });
  }
  // Nothing waits on the person for these two (#1977), so they are info: below every problem, and
  // dismissible. The skills dismissal is kept on this device for the session; the setup suggestion's
  // is the Project's, on the server.
  if (skillsUnavailable && !skillsNoticeDismissed) {
    const skills = skillsUnavailable;
    sessionNotices.push({
      key: "skills-unavailable",
      severity: "info",
      rank: SESSION_NOTICE_RANK.skillsUnavailable,
      title: "Skills Unavailable",
      render: ({ trailing, onDismiss }) => (
        <SkillsUnavailableNotice machine={runnerDisp.name} adapter={skills.adapter} skillNames={skills.skillNames}
          trailing={trailing}
          onDismiss={() => {
            dismissSkillsNotice();
            onDismiss?.();
          }}
          onOpenSkills={() => navigate({ name: "skills" })} />
      ),
    });
  }
  if (showWorktreeSetupNotice && session.projectId) {
    const projectName = projects.get(session.projectId)?.name ?? "This Project";
    sessionNotices.push({
      key: `setup-suggestion:${session.projectId}`,
      severity: "info",
      rank: SESSION_NOTICE_RANK.setupSuggestion,
      title: `Set Up ${projectName}`,
      render: ({ trailing }) => (
        <WorktreeSetupNotice compact projectName={projectName} trailing={trailing}
          generating={setupSuggestion.generating} dismissing={setupSuggestion.dismissing} error={setupSuggestion.error}
          generateRefusal={setupSuggestion.generateRefusal}
          onGenerate={setupSuggestion.generate} onDismiss={setupSuggestion.dismiss} />
      ),
    });
  }

  if (archivedOrder) {
    const unarchiveRestarts = sessionUnarchiveRestarts(session, unarchiveAndRestartSupported);
    // A person the server would refuse (a Viewer) sees the action disabled, with the reason (#1843).
    const unarchiveRefusal = sessionCommandRefusal(session, "unarchive");
    sessionNotices.push({
      ...archivedOrder,
      title: "Session Archived",
      // Not dismissible: it is the way back, and the composer's placeholder points to it.
      render: ({ trailing }) => (
        <Notice tone="info" role="status" ariaLabel="Session Archived" title="Session Archived"
          trailing={trailing}
          actions={(
            <BusyButton
              className="btn primary sm"
              busy={unarchivePending}
              progress="Restoring the session…"
              disabled={unarchiveRefusal !== null}
              title={unarchiveRefusal ?? undefined}
              aria-describedby={unarchiveRefusal !== null ? "session-archived-refusal" : undefined}
              onClick={() => void unarchiveFromNotice(unarchiveRestarts)}
            >
              {unarchiveRestarts ? "Unarchive and Restart" : "Unarchive"}
            </BusyButton>
          )}>
          <p>This session is archived and stopped.</p>
          {unarchiveRefusal !== null && <p className="notice-meta" id="session-archived-refusal">{unarchiveRefusal}</p>}
        </Notice>
      ),
    });
  }

  // "Agent is working" state (items 1 + 2): true the instant a send is optimistically pending
  // (before status flips) and for the whole turn while the runner reports running/starting.
  const showOptimistic = pending != null && timelineUserPrompts.length <= sendBaselineRef.current;
  // A request id owns an immutable question schema. Keep the timeline context stable across
  // heartbeat, usage, and lifecycle snapshots that replace the surrounding SessionView.
  const timelinePendingQuestion = useMemo(() => pendingQuestion ? {
    requestId: pendingQuestion.requestId,
    occurrenceId: pendingQuestion.occurrenceId,
    questions: pendingQuestion.questions ?? [],
    async: pendingQuestion.async,
    recoveryReason: pendingQuestion.recoveryReason,
    recoveryAction: pendingQuestion.recoveryAction,
  } : null, [session.id, pendingQuestion?.requestId, pendingQuestion?.occurrenceId,
    pendingQuestion?.recoveryReason, pendingQuestion?.recoveryAction]);
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
  // The working line's Review moves focus to the request blocking the turn, wherever it can be
  // answered: its transcript row when the transcript owns that request (revealed like a step, since
  // the virtual list may not have it mounted), else a request card outside the transcript, else
  // the Agents panel, which lists every pending request (a worker's beside an async question).
  const reviewPendingRequest = useCallback((requestId: string) => {
    const transcriptOwnsRequest = requestId === pendingQuestion?.requestId
      ? questionInTimeline
      : requestId === timelineApprovalRequestId && ownApprovalHasTimelineRow;
    for (let index = items.length - 1; transcriptOwnsRequest && index >= 0; index -= 1) {
      const item = items[index]!;
      if ((item.kind === "permission" && item.requestId === requestId && item.resolvedOptionId === undefined) ||
          (item.kind === "question" && item.requestId === requestId && item.answered === undefined)) {
        revealCurrentOperation(item.id);
        return;
      }
    }
    if (focusSessionRequest(session.id, requestId)) return;
    rightPanel.show("subagents");
    navigate({ name: "session", id: session.id, attention: { eventEpoch: session.eventEpoch ?? 0, requestId } });
  }, [items, navigate, ownApprovalHasTimelineRow, pendingQuestion?.requestId, questionInTimeline,
    revealCurrentOperation, rightPanel, session.eventEpoch, session.id, timelineApprovalRequestId]);
  const timelineApprovalContext = useMemo(() => timelineApprovalRequestId && ownApprovalHasTimelineRow ? {
      sessionId: session.id,
      requestId: timelineApprovalRequestId,
      onOpenRequest: ownStandaloneApproval && ownApprovalOccurrenceId
        ? () => openRequestPanel(sessionRequestPanelKey(session.id, ownApprovalOccurrenceId))
        : () => {
            rightPanel.show("subagents");
            navigate({ name: "session", id: session.id, attention: {
              eventEpoch: session.eventEpoch ?? 0,
              requestId: timelineApprovalRequestId,
            } });
          },
    } : undefined, [navigate, openRequestPanel, ownApprovalHasTimelineRow, ownApprovalOccurrenceId,
      ownStandaloneApproval, rightPanel, session.eventEpoch, session.id, timelineApprovalRequestId]);
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
  // A session that is starting with nothing to show yet is an empty transcript that says so
  // ("Starting Claude Code", #2172), not a lone Working row.
  const startingWithoutActivity = session.status === "starting" && items.length === 0 && !showOptimistic &&
    activeTurnProgress === null && (session.pendingPrompts?.length ?? 0) === 0;
  const transcript = transcriptPresentation({
    itemCount: items.length,
    hasOptimistic: showOptimistic,
    working: activeTurnVisible && !startingWithoutActivity,
    history: eventHistory,
    conn,
  });
  // Receipts for messages already sent are rows of the transcript, under their message (#2171). The
  // full session view shows steering, command and rename receipts; the pending prompts show
  // everywhere the transcript does.
  const historyPartial = isPartialHistory(eventWindow);
  const steeringReceipts = mode === "expanded"
    ? deriveSteeringReceipts(session.steeringAttempts ?? [], items, session.activeTurnId, historyPartial)
    : [];
  const commandReceipts = mode === "expanded"
    ? visibleSessionCommandReceipts(session.commandInvocations ?? [], items, historyPartial)
    : [];
  const hasTranscriptReceipts = (session.pendingPrompts?.length ?? 0) > 0 || steeringReceipts.length > 0 ||
    commandReceipts.length > 0 || (mode === "expanded" && retitleFeedback !== null);
  // The rows branch of the reader: not loading, not unavailable, and not the empty state.
  const transcriptRowsShown = transcript.body !== "skeleton" && transcript.body !== "unavailable" &&
    !(transcript.body === "empty" && !hasTranscriptReceipts);
  // The floating tail control (#2153). Only a transcript with rows has a tail to jump to; loading,
  // history-error and empty states show nothing there.
  const transcriptHasTail = transcript.body === "timeline" ||
    (transcript.body === "empty" && hasTranscriptReceipts);
  // Every message the agent did not take — a failed prompt, a steer it did not accept, a command it
  // rejected — raises "Message Not Sent" when its row is off-screen, so a receipt in the scroll never
  // hides a failure.
  const undeliveredReceiptIds = [
    ...(session.pendingPrompts ?? [])
      .filter((prompt) => isPendingPromptShown(prompt, deliveredPromptCommandIds) && isUndeliveredPrompt(prompt))
      .map((prompt) => receiptRowId.prompt(prompt.commandId)),
    ...steeringReceipts
      .filter(({ status }) => status === "rejected")
      .map(({ attempt }) => receiptRowId.steering(attempt.submissionId)),
    ...commandReceipts
      .filter((invocation) => invocation.state === "rejected")
      .map((invocation) => receiptRowId.command(invocation.invocationId)),
  ];
  const offscreenUndeliveredIds = useOffscreenReceipts(scrollRef, undeliveredReceiptIds, transcriptHasTail);
  const recoveryAnnouncement = useRecoveryAnnouncement(transcript.notice, sessionId);
  const tailView = transcriptTailView({
    hasTail: transcriptHasTail,
    offscreenNotSent: offscreenUndeliveredIds.length,
    recovering: transcript.notice === "refreshing",
    following: followTail.isFollowing,
    newRows: followTail.newRowCount,
  });
  // The control leaves with the tail, or yields to recovery; keep focus in the reader, not the page.
  const keepFocusInReader = useCallback(() => scrollRef.current?.focus({ preventScroll: true }), []);
  const showFirstUndelivered = useCallback(() => {
    const scroller = scrollRef.current;
    const id = offscreenUndeliveredIds[0];
    if (!scroller || id === undefined) return;
    const row = [...scroller.querySelectorAll<HTMLElement>(`[${RECEIPT_ROW_ATTRIBUTE}]`)]
      .find((candidate) => receiptRowIds(candidate).includes(id));
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    const action = row.querySelector<HTMLButtonElement>(".tl-receipt-buttons button:not(:disabled)");
    (action ?? scroller).focus({ preventScroll: true });
  }, [offscreenUndeliveredIds]);

  // The web registry owns app/provider identity, availability, collisions, and menu ranking. The
  // provider wire shape stays unchanged until IDEA-004C adds transport-specific execution modes.
  const agentCaps = resolveCaps(runner, session);
  const contextWindow = resolveContextWindowCapacity(session, agentCaps?.models ?? []);
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
  const composerSkillSigil = useMemo(() => composerCommandsIncludeSkills(composerCommands), [composerCommands]);
  // A receipt outlives catalog rotation. The kind of every submission this view sent is known
  // exactly; otherwise a current skill command id, then a name only skills use, identifies a skill.
  const submissionIsSkillRef = useRef(new Map<string, boolean>());
  const isSkillInvocation = useMemo(() => {
    const commands = agentCaps?.slashCommands ?? [];
    const skillIds = new Set(commands.flatMap((command) =>
      command.source === "skill" && command.invocation ? [command.invocation.id] : []));
    const skillOnlyNames = new Set(commands
      .filter((command) => command.source === "skill")
      .map((command) => command.name.toLowerCase())
      .filter((name) => commands.every((command) => command.source === "skill" || command.name.toLowerCase() !== name)));
    return (invocation: { submissionId: string; providerCommandId: string; commandName: string }) =>
      submissionIsSkillRef.current.get(invocation.submissionId) ??
      (skillIds.has(invocation.providerCommandId) || skillOnlyNames.has(invocation.commandName.toLowerCase()));
  }, [agentCaps?.slashCommands]);
  const slashTrigger = useMemo(
    () => composerSelection.start === composerSelection.end
      ? findComposerCommandTrigger(text, composerSelection.start, { skillSigil: composerSkillSigil })
      : null,
    [composerSelection.end, composerSelection.start, composerSkillSigil, text],
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
      setError(runnerCapabilityRequirement(runner?.protocolVersion, "workspaceReferences", "workspace references"));
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
    const ranked = rankComposerCommands(composerCommandsForTrigger(composerCommands, slashTrigger), slashTrigger.query)
      .map((match) => match.command);
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
  const composerIdleCollapsed = isMobile && !composerExpanded && !/[\r\n]/u.test(text) &&
    images.length === 0 && session.pendingApproval == null &&
    !historyQuarantine && !queuedEdit && !error && !retitleFeedback && !dictation.recording &&
    !dragActive && !paletteOpen && !workspacePickerOpen;
  // The phone capsule's preview (#2154): the draft's first line to edit, or who a new message goes
  // to. A composer that cannot send says why instead.
  const composerIdleDraft = text.trim();
  const composerIdlePreview = composerIdleDraft || (canPrompt ? `Message ${composerAgent}` : composerPlaceholder);
  // R focuses the composer from the reader; the idle, unfocused composer says so (#2166).
  const composerReplyKeycap = sessionReadingKeys && canPrompt && activePane === "reader" && text === "" &&
    !composerIdleCollapsed && !composerAnswerActive;
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
  // A person the server refuses configuration (a Viewer) sees the controls disabled with the
  // reason, and nothing is applied (#1857).
  const configRefusal = sessionCommandRefusal(session, "configure");
  const configRefusalId = `config-refusal-${session.id}`;
  // A composer the session cannot send from reads as paused (#2154): its permission, Plan and model
  // controls stay in the bar, disabled, with the reason it cannot send. Each refusal is per command,
  // so a person refused only prompts keeps the configuration they are allowed (#1857).
  const composerControlsDisabledReason = configRefusal ??
    (promptRefusal === null ? promptUnavailableReason : null);
  const composerUnavailableId = `composer-unavailable-${session.id}`;
  // A disabled mic never sees the pointerup that ends a hold, so a hold the composer loses mid-way
  // ends here.
  const stopDictation = dictation.stop;
  useEffect(() => {
    if (!canPrompt && dictation.recording) stopDictation();
  }, [canPrompt, dictation.recording, stopDictation]);
  // Live context and cost sit in the composer bar's trailing cluster, or in Model Settings when the
  // bar has no room for them (#2166).
  const [composerBoxRef, composerColumnNarrow] = useNarrowerThanRem<HTMLDivElement>(COMPOSER_USAGE_MIN_COLUMN_REM);
  const composerUsageNarrow = isMobile || composerColumnNarrow;
  const modelSettingsAvailable = useModelSettingsAvailable(
    session,
    () => pendingConfig.current.model,
    () => pendingConfig.current.serviceTier,
  );
  const usagePlacement = composerUsagePlacement({
    narrow: composerUsageNarrow,
    modelSettingsOpenable: modelSettingsAvailable && composerControlsDisabledReason === null,
  });
  const applyConfig = useCallback(
    (patch: Partial<SessionConfig>) => {
      if (configRefusal !== null) return;
      pendingConfig.current = { ...pendingConfig.current, ...patch };
      if (patch.model !== undefined) setOptimisticModel(patch.model || undefined);
      void api.setConfig(sessionId, patch); // optimistic between-turns apply (updates the UI + snapshot)
    },
    [api, configRefusal, sessionId],
  );

  const planActive = session.permissionMode === "plan";
  const togglePlan = (on = !planActive) => {
    if (!planSupported) return; // never set an unsupported "plan" mode (would map to a writable sandbox)
    applyConfig({ permissionMode: on ? "plan" : "" });
  };
  // The Plan pill and each attachment ✕ unmount when they act. A pointer never focuses them, but a
  // keyboard user's focus would fall to the page with them, so it moves to the composer (#1913).
  // A composer that cannot prompt is disabled and refuses focus; then Session Activity takes it, as
  // it does when a resolved request cannot hand focus back to the composer.
  const keepFocusInComposer = (control: HTMLElement) => {
    const document = control.ownerDocument;
    if (document.activeElement !== control) return;
    for (const target of [inputRef.current, scrollRef.current]) {
      target?.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
  };

  const clearAppCommandText = () => {
    draftDirty.current = true;
    composerDraftVersionRef.current += 1;
    draftState.current = { text: "", images };
    setProgrammaticComposerText("", 0);
    void saveComposerDraft(sessionId, "", images, instanceScope);
  };

  const renameRefusal = sessionCommandRefusal(session, "rename");
  const requestSessionRetitle = async (
    composerFocus?: ReturnType<typeof captureComposerFocus>,
  ) => {
    if (retitleInFlightRef.current || renameRefusal !== null) return;
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
      submissionIsSkillRef.current.set(commandSubmission.submissionId, invocation.command.providerSource === "skill");
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
    // Direct steering posts to the same route as queued steering, so it follows that verdict (#1857).
    if (composerMutationRegistry.has(mutationKey) || stopTurnPendingRef.current || !canSend) return;
    if (queueRefusal !== null) {
      setError(queueRefusal);
      return;
    }
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
    if (queueRefusal !== null || queueSteeringInFlightRef.current.has(prompt.id) ||
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
    if (queuedEdit || composerRequestBusy || queueRefusal !== null) return;
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
    revealOrdinaryComposerRef.current("always");
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
  };

  const useRecoveredQueuedEditAsNewMessage = async () => {
    if (!queuedEdit || !queuedEditRecovered || queuedEditBusy) return;
    revealOrdinaryComposerRef.current("always");
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
    // An edit opened before the person lost queue management is not sent (#1857).
    if (queueRefusal !== null) {
      setError(queueRefusal);
      return;
    }
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
    if (queueRefusal !== null || steeringResolutionInFlightRef.current.has(submissionId)) return;
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
    if (canStopTurn && cancelTurnRefusal === null && !shortcutLayerActive(document) && matchesShortcut(e, "stop-turn")) {
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
    // Alt+↑/↓ is Session Reading's Previous/Next Session, never a recall.
    if (!queuedEdit && !paletteOpen && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && userPrompts.length) {
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

  // Absent when the session has none: More Actions then offers "Move to a Project…" alone.
  const currentProjectName = projectsSupported
    ? session.projectId ? projects.get(session.projectId)?.name ?? session.projectName : undefined
    : session.workspaceName;
  const standaloneRequestCard = ownStandaloneApproval && ownApprovalOccurrenceId &&
    !transcriptRendersRequestRow(transcript.body, ownApprovalHasTimelineRow) ? (
      <section
        className="tl-request-card"
        aria-label={`Pending ${requestTypeLabel(ownStandaloneApproval)} Request`}
        data-session-request-id={ownStandaloneApproval.requestId}
        data-session-request-session={session.id}
      >
        <span className="tl-request-icon" aria-hidden="true">{ownEvidenceSnapshot ? "🖼️" : "🔐"}</span>
        <span className="tl-request-copy">
          <strong>{ownStandaloneApproval.title}</strong>
          <span>
            {ownEvidenceSnapshot
              ? `${ownEvidenceSnapshot.evidence.length} evidence ${ownEvidenceSnapshot.evidence.length === 1 ? "item" : "items"}`
              : `${requestTypeLabel(ownStandaloneApproval)} · Review Required`}
          </span>
        </span>
        <button
          className="btn primary sm"
          type="button"
          data-session-request-control="review"
          aria-controls="right-panel"
          onClick={() => openRequestPanel(
            sessionRequestPanelKey(session.id, ownApprovalOccurrenceId),
          )}
        >
          {ownEvidenceDecision ? "Review Evidence" : "Review Request"}
        </button>
      </section>
    ) : null;

  // On a phone a summary row that opens the right panel closes the sheet, since only one overlay is
  // open at a time (#2147). The row that had focus is gone with the sheet, so focus follows it into
  // the panel; the sheet's Close and Escape still return it to the toggle.
  const focusPanelAfterSheetRef = useRef(false);
  const summaryToggleRef = pinnedSummary?.toggleRef;
  const sheetReturnFocusRef = useMemo(() => ({
    get current(): HTMLElement | null {
      if (focusPanelAfterSheetRef.current) {
        focusPanelAfterSheetRef.current = false;
        const panelControl = document.querySelector<HTMLElement>("#right-panel .rp-head button");
        if (panelControl) return panelControl;
      }
      return summaryToggleRef?.current ?? null;
    },
  }), [summaryToggleRef]);
  const fromSummary = <A extends unknown[]>(open: (...args: A) => void) => (...args: A) => {
    if (pinnedSummary?.presentation === "sheet") focusPanelAfterSheetRef.current = true;
    open(...args);
  };

  // The summary's contents (#2160); the container depends on the presentation.
  const pinnedSummaryContent = pinnedSummary?.open ? (
    <PinnedSummary
      session={session}
      git={git}
      gitSummary={gitSummary}
      gitPresentation={gitPresentation}
      richGitSupported={richGitSupported}
      items={items}
      onOpenReview={fromSummary(() => rightPanel.show("review"))}
      onOpenBackgroundWork={fromSummary(() => rightPanel.show("background"))}
      onOpenSourceLocation={fromSummary(openSourceLocation)}
      skillsUnavailableReason={skillsUnavailable
        ? skillsUnavailableSentence(runnerDisp.name, skillsUnavailable.adapter, null)
        : null}
    />
  ) : null;

  // Receipts for messages already sent (#2171), shown by the full session view only: the Inbox
  // preview never had the composer they used to sit above. They are recovery work, so they stay
  // reachable while the history is still loading or failed to load.
  const sentMessageReceipts = mode === "expanded" ? (
    <>
      <SessionCommandReceipts
        invocations={session.commandInvocations ?? []}
        timelineItems={items}
        historyPartial={historyPartial}
        agentLabel={sessionAgentLabel(session.agentName, session.driver, session.agentId)}
        isSkillInvocation={isSkillInvocation}
      />
      <SteeringReceipts
        attempts={session.steeringAttempts ?? []}
        timelineItems={items}
        activeTurnId={session.activeTurnId}
        historyPartial={historyPartial}
        pendingActions={steeringResolutionPending}
        actionRefusal={queueRefusal}
        onQueueAgain={(submissionId) => void resolveSteeringAttempt(submissionId, "queue_again")}
        onDismiss={(submissionId) => resolveSteeringAttempt(submissionId, "dismiss")}
      />
      {retitleFeedback && (
        <div
          ref={retitleReceiptRef}
          className="tl-row user tl-receipt-row"
          data-status={retitleFeedback.state}
          role="region"
          aria-label="Rename Session Status"
          tabIndex={-1}
        >
          <div className="tl-message-stack user">
            <ReceiptLine
              status={retitleFeedback.state === "running" ? "sending" : "rename_failed"}
              progress={retitleFeedback.state === "running" ? "Renaming session…" : undefined}
              reason={retitleFeedback.state === "failed" ? "Couldn't rename this session." : undefined}
              detailsId={`retitle-details-${session.id}`}
              details={retitleFeedback.state === "failed" && retitleFeedback.message
                ? <p className="tl-receipt-raw">{retitleFeedback.message}</p>
                : undefined}
              actions={retitleFeedback.state === "failed" ? (
                <span className="tl-receipt-buttons">
                  <button
                    type="button"
                    className="btn sm"
                    disabled={renameRefusal !== null}
                    title={renameRefusal ?? undefined}
                    aria-describedby={renameRefusal !== null ? `retitle-refusal-${session.id}` : undefined}
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
                </span>
              ) : undefined}
            />
            {retitleFeedback.state === "failed" && renameRefusal !== null && (
              <p className="tl-receipt-refusal" id={`retitle-refusal-${session.id}`}>{renameRefusal}</p>
            )}
          </div>
        </div>
      )}    </>
  ) : null;

  return (
    <div className={`session-detail ${mode}`} data-session-surface-id={session.id}>
      {mode === "expanded" ? (
        <>
        <SessionHeader
          session={session}
          runnerOnline={runnerOnline}
          machineName={runnerDisp.name}
          machineAccounts={runner?.providerAccounts}
          onOpenConnections={() => navigate({ name: "runners", section: "machines" })}
          runnerProtocolVersion={runner?.protocolVersion}
          stopBeforeArchiveSupported={stopBeforeArchiveSupported}
          unarchiveAndRestartSupported={unarchiveAndRestartSupported}
          onReloadSession={async () => { loadSession((await api.session(session.id)).session); }}
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
          forkShortcutRef={sessionReadingKeys ? forkShortcutRef : undefined}
          projectControl={<ProjectMenuButton session={session} />}
          projectName={currentProjectName ?? undefined}
          projectLabel={projectsSupported ? "Project" : "Workspace"}
          onOpenProject={projectsSupported && session.projectId ? () => {
            navigate({ name: "projects", id: session.projectId! });
          } : undefined}
          renderMoveProjectDialog={({ onClose, returnFocusRef }) => projectsSupported ? (
            <MoveToProjectDialog session={session} onClose={onClose} returnFocusRef={returnFocusRef} />
          ) : (
            <MoveToWorkspaceDialog session={session} onClose={onClose} returnFocusRef={returnFocusRef} />
          )}
          topbarControls={topbarControls}
          activeSubagents={activeWorkerCount ? {
            count: activeWorkerCount,
            workers: true,
            onOpen: () => rightPanel.show("subagents"),
          } : undefined}
          descendantRequests={descendantRequests.length > 0 ? {
            count: descendantRequests.length,
            // Reopening the inbox must not replace the row the user last selected.
            onOpen: () => rightPanel.show("requests"),
          } : undefined}
          onOpenBackgroundWork={() => rightPanel.show("background")}
          onOpenAttention={() => {
            const requests = pendingRequests(session.pendingApproval);
            if (requests.length > 1) {
              rightPanel.show("subagents");
              navigate({ name: "session", id: session.id, attention: {
                eventEpoch: session.eventEpoch ?? 0,
              } });
              return;
            }
            if (ownStandaloneApproval && ownApprovalOccurrenceId) {
              openRequestPanel(sessionRequestPanelKey(session.id, ownApprovalOccurrenceId));
              return;
            }
            if (requests.length === 0 && (session.orchestratorCampaign?.pendingRequests?.human ?? 0) > 0) {
              rightPanel.show("requests");
              return;
            }
            // Navigation makes the target reload-safe; the direct state transition also makes a
            // repeat press reopen a panel that was closed while the route stayed unchanged.
            rightPanel.show("subagents");
            navigate({ name: "session", id: session.id, attention: {
              eventEpoch: session.eventEpoch ?? 0,
              ...(requests.length === 1 ? { requestId: requests[0]!.requestId } : {}),
            } });
          }}
          onOpenCampaignRequests={() => rightPanel.show("requests")}
          // The unified bar replaces the app-level top bar on desktop, so it owns the page-title
          // focus-rescue anchor there; the mobile layout keeps the app bar and its own anchor.
          titleId={!isMobile ? "page-title" : undefined}
        />
        {/* Campaign notices, not session notices (§13.2; #2036): they describe the campaign, not
            whether this session can take its next turn, so they stay here, in this order, rather
            than in the notice slot above the composer. */}
        {session.orchestratorCampaign?.continuation && (
          <CampaignContinuationNotice
            continuation={session.orchestratorCampaign.continuation}
            acknowledgementPending={pendingPromptAction?.commandId === session.orchestratorCampaign.continuation.commandId}
            actionRefusal={queueRefusal}
            onAcknowledge={(commandId) => void resolvePendingPrompt(commandId, "dismiss")}
            onRetry={(commandId) => void resolvePendingPrompt(commandId, "retry")}
          />
        )}
        {heldChildren.length > 0 && (
          <CampaignHeldChildren
            heldChildren={heldChildren}
            blocked={session.orchestratorCampaign?.children?.blocked ?? heldChildren.length}
            childTitle={heldChildTitle}
            recoveryAction={heldChildRecoveryAction}
            onOpenChild={(childSessionId) => navigate({ name: "session", id: childSessionId })}
          />
        )}
        </>
      ) : (
        <>
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
              {shownDelivery && (
                <BackgroundDeliveryBadge
                  state={shownDelivery.watchdogState}
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
              <ContextWindowMeter session={session} resolution={contextWindow} />
              <SessionUsageControl session={session} />
              {isHeartbeatBusy(session.status) && (
                <ActivityStrip activity={activity} now={activityNow} />
              )}
              {stalled && (
                <StatusBadge meta={statusMeta("session", "stalled")} ariaLabel="Stalled: No Activity for at Least 10 Minutes" />
              )}
              <span className="muted">Updated {relativeTime(lastActivityAt)}</span>
            </div>
          </div>
          <button type="button" className="btn ghost sm" onClick={onExpand} aria-label="Expand Session" title="Expand Session (Enter)">
            Expand <kbd>Enter</kbd>
          </button>
        </header>
        </>
      )}

      {/* Chat column + the Codex-style right side panel. The panel's open/mode/width state
          lives at the app shell (survives navigation); its per-session bodies (e.g. the Files
          browser) reset with SessionDetail's own session-id key. */}
      <div className="detail-columns">
        {/* The session body: the reader column, then the docked Pinned Summary (#2147). It is the
            `session-body` container, so docking follows the room the right panel leaves. */}
        <div className="detail-body" ref={setDetailBody}>
        <div className="detail-chat">
          {/* Inside the CHAT COLUMN (not .session-detail) so the card centers against the
              same width the transcript and composer use — with the right panel open, a
              session-wide card would sit visibly off-axis from the column it belongs to. */}
          <SessionApprovalRegion
            session={session}
            runnerOnline={runnerOnline}
            fallbackFocusRef={mode === "expanded" ? inputRef : scrollRef}
            alternateFallbackFocusRef={mode === "expanded" ? scrollRef : undefined}
            onFallbackFocus={mode === "expanded" ? focusComposerAfterRequestResolution : undefined}
            onSessionUpdate={loadSession}
            showKeyHints={!isMobile}
            // The fallback owns the request only until the matching pinned row is mounted and the
            // virtual list can keep it reachable at its canonical transcript position.
            questionInTimeline={questionInTimeline}
            standaloneInReviewSurface={Boolean(ownStandaloneApproval)}
          />
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
            {/* The reader region: the scroller, and NOTHING below it. It clips, so in a pane
                shorter than the scroller's padding floor nothing can paint over the status strip. */}
            <div className="detail-reader">
            {/* The history notice heads the reading column in its own band above the scroller
                (#2172): it takes its height, so it never covers a row, and it stays in view while
                the reader is at the tail. */}
            {(transcript.notice === "stale" || transcript.notice === "error") && (
              <div className="transcript-history-band">
                <TranscriptHistoryNotice
                  kind={transcript.notice}
                  error={transcript.error}
                  loaded={evs?.length ?? 0}
                  total={session.messageCount > 0 ? session.messageCount : undefined}
                  machine={runnerDisp.name || undefined}
                  canRetry={conn === "online" && !transcript.busy}
                  onRetry={() => setHistoryRetry((value) => value + 1)}
                />
              </div>
            )}
            <div
              className="detail-scroll measured-virtual-scroll"
              ref={scrollRef}
              data-follow-tail-state={followTail.state}
              role="region"
              aria-label={mode === "expanded" ? "Session Activity" : "Session Preview Activity"}
              aria-busy={transcript.busy}
              tabIndex={0}
              onScroll={(event) => {
                followTail.onScroll();
                maybeLoadEarlier(event.currentTarget);
              }}
              onWheel={(event) => {
                if (event.deltaY < 0) {
                  markSingleEarlierActivityIntent();
                  if (!nestedScrollerConsumesUpwardInput(event.target, event.currentTarget)) {
                    requestEarlierFromInputAtHead();
                  }
                }
                followTail.onWheel(event);
              }}
              onPointerDown={(event) => {
                if (event.pointerType === "touch") markTouchEarlierActivityIntent(event.clientY);
                else markPointerEarlierActivityIntent(event.currentTarget);
              }}
              onPointerMove={(event) => {
                if (event.pointerType === "touch") {
                  markTouchEarlierActivityMovement(event.clientY);
                  requestEarlierFromTouchAtHead(event.clientY, event.target);
                }
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
                const clientY = event.touches[0]?.clientY ?? null;
                markTouchEarlierActivityMovement(clientY);
                requestEarlierFromTouchAtHead(clientY, event.target);
              }}
              onTouchEnd={(event) => finishNativeTouchEarlierActivityIntent(event.touches.length)}
              onTouchCancel={(event) => finishNativeTouchEarlierActivityIntent(event.touches.length)}
              onKeyDown={(event) => {
                if (event.defaultPrevented) return;
                if (inTypingContext(event.currentTarget.ownerDocument)) return;
                if (mode !== "expanded" && !isFollowTailResumeKey(event)) return;
                if (isFollowTailUpwardReadingKey(event)) {
                  markSingleEarlierActivityIntent();
                  requestEarlierFromInputAtHead();
                }
                if (!followTail.onKeyDown(event)) return;
                event.preventDefault();
              }}
            >
              <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-earlier-activity-announcement>
                {currentEarlierRequestSettled && eventWindow?.error
                  ? `${eventWindow.error} Retry is available.`
                  : readerStartedEarlierActivity && eventWindow?.loadingOlder
                  ? "Loading earlier activity."
                  : readerStartedEarlierActivity && currentEarlierRequestSettled
                    ? "Earlier activity loaded."
                    : ""}
              </div>
              {items.length > 0 && openingHistoryFillSettled && (
                <EarlierActivityControl
                  available={eventWindow?.hasOlder === true}
                  loading={eventWindow?.loadingOlder === true}
                  error={eventWindow?.error ?? null}
                  // Seqs count from 1 without gaps within an epoch, so the loaded window's base
                  // says how many events sit above it.
                  olderCount={eventWindow ? eventWindow.baseSeq - 1 : undefined}
                  onLoad={loadEarlierFromControl}
                  fallbackFocusRef={scrollRef}
                />
              )}
              {transcript.body !== "timeline" && standaloneRequestCard}
              <TranscriptErrorAlert
                historyKey={timelineHistoryKey}
                items={items}
                ready={openingHistoryFillSettled}
              />
              {transcript.body === "skeleton" ? (
                <TranscriptSkeleton sentence={transcriptLoadingSentence(session.messageCount)} />
              ) : transcript.body === "unavailable" ? (
                // A failed load is the history notice above, alone (#2172); only a disconnected or
                // unpaired device with nothing cached still needs a state here.
                !transcript.error && (
                  <State variant="offline" title={conn === "unauthorized" ? "Pair to Load Activity" : "Activity Unavailable"}>
                    {conn === "offline" ? "Reconnect to load this transcript." : "This device needs access to the control plane."}
                  </State>
                )
              ) : transcript.body === "empty" && !hasTranscriptReceipts ? (
                // Offline and error outrank empty (§12): a once-empty history that failed to refresh
                // or is cached while disconnected is its notice alone, never the notice above "Start
                // the Conversation" or "Starting {Agent}".
                transcript.notice !== "error" && transcript.notice !== "stale" && <TranscriptEmptyState
                  kind={transcriptEmptyKind(session)}
                  agent={sessionAgentLabel(session.agentName, session.driver, session.agentId)}
                  project={currentProjectName ?? undefined}
                  machine={runnerDisp.name || undefined}
                  onBrowseFiles={mode === "expanded" && runnerSupportsProtocol(runner?.protocolVersion, "sessionFiles")
                    ? () => rightPanel.show("files")
                    : undefined}
                />
              ) : (
                <>
                  {items.length > 0 && (
                    <EventTimeline
                      driver={session.driver}
                      items={timelineItems}
                      sessionActive={isTimelineSessionActive(session.status)}
                      onOpenSubagent={mode === "expanded" ? openSubagent : undefined}
                      onOpenSourceLocation={openSourceLocation}
                      onOpenSession={openSession}
                      workspaceRoot={session.worktreePath ?? runner?.workspaces.find((workspace) => workspace.id === session.workspaceId)?.path}
                      scrollRef={scrollRef}
                      historyKey={timelineHistoryKey}
                      getInitialAnchor={followTail.getInitialAnchor}
                      preserveAnchor={!followTail.isFollowing}
                      anchorRecoveryPending={anchorRecoveryPending}
                      onVisibleAnchorChange={followTail.onVisibleAnchorChange}
                      onAnchorLost={followTail.onAnchorLost}
                      // Keep checkpoint actions discoverable when the runner or worktree cannot
                      // currently satisfy them; activation still uses the existing API contract.
                      onRewind={mode === "expanded" ? onRewind : undefined}
                      rewindUnavailableReason={rewindUnavailableReason}
                      onFork={mode === "expanded" ? onFork : undefined}
                      handoff={mode === "expanded" ? handoffControls : undefined}
                      onEditAndResend={mode === "expanded" ? openResendAction : undefined}
                      editAndResendUnavailableReason={promptUnavailableReason ?? undefined}
                      onEditInFork={mode === "expanded" ? openForkEditAction : undefined}
                      editInForkAvailabilityByItem={mode === "expanded" ? editInForkAvailabilityByItem : undefined}
                      forkAvailabilityByTurn={mode === "expanded" ? forkAvailabilityByTurn : undefined}
                      revealRequest={timelineRevealRequest}
                      onRevealHandled={handleTimelineReveal}
                      questionContext={timelineQuestionContext}
                      approvalContext={timelineApprovalContext}
                    />
                  )}
                  <PendingPromptBubbles
                    prompts={session.pendingPrompts ?? []}
                    deliveredCommandIds={deliveredPromptCommandIds}
                    liveQueueIds={liveQueueIds}
                    canCancelLive={runnerOnline && canCancelQueued}
                    pendingAction={pendingPromptAction?.commandId}
                    worktreeRecoveryPending={worktreeRecovery !== undefined}
                    actionRefusal={queueRefusal}
                    onCancelPending={(commandId) => void resolvePendingPrompt(commandId, "cancel")}
                    onCancelLive={(commandId) => void cancelLivePendingPrompt(commandId)}
                    onDismiss={(commandId) => void resolvePendingPrompt(commandId, "dismiss")}
                    onRetry={(commandId) => void resolvePendingPrompt(commandId, "retry")}
                  />
                  {showOptimistic && pending && (
                    <div className="tl-row user">
                      <div className="tl-bubble">
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
                        {pending.text && <div className="bubble-text"><Markdown profile="inline">{pending.text}</Markdown></div>}
                      </div>
                    </div>
                  )}
                </>
              )}
              {/* One place for every transcript state, so a receipt never remounts (and drops the
                  focus it holds) when history arrives; while history loads or fails, recovery
                  receipts still keep their actions. */}
              {sentMessageReceipts}
              {transcriptRowsShown && activeTurnVisible && (
                <WorkingIndicator
                  label={workingLabel}
                  progress={activeTurnProgress}
                  onRevealCurrentOperation={revealCurrentOperation}
                  onOpenSubagent={mode === "expanded" ? openSubagent : undefined}
                  onReviewPendingRequest={reviewPendingRequest}
                />
              )}
              {transcriptRowsShown && transcript.body === "timeline" && standaloneRequestCard}
            </div>
            </div>
            {/* The one floating control at the reader's lower edge (#2153), where the newest
                activity is (#56: a top-only recovery notice read as "frozen"). Its anchor takes no
                height, so the control can come and go without moving the reader. */}
            <TranscriptTailControl
              view={tailView}
              shortcut={isMobile
                ? null
                : shortcutDisplay(mode === "preview" ? "inbox-follow-latest-end" : "session-reading-latest-end")}
              onJump={followTail.follow}
              onShowNotSent={showFirstUndelivered}
              onFocusLost={keepFocusInReader}
            />
            {/* The one polite live region for recovery, whatever the control is showing. */}
            <span className="sr-only" role="status" data-transcript-recovery-status>{recoveryAnnouncement}</span>
          </div>

          {mode === "expanded" && (
            <div
              className="composer"
              onFocusCapture={() => setActivePane("composer")}
              onPointerDownCapture={() => setActivePane("composer")}
            >
            {/* The one notice slot (§13.2): the most severe session condition, the rest behind
                "+N More". Session notices are entries of it, never banners of their own. */}
            <SessionNoticeSlot sessionId={session.id} entries={sessionNotices}
              onFocusLost={() => {
                // The composer when it can take a message: a collapsed phone composer's own Edit
                // Message control, so the layout does not change under the person. A composer that
                // still refuses a message (a plain Unarchive leaves the session stopped) cannot hold
                // focus, so the page title takes it (#2202).
                const input = inputRef.current;
                const target = !input || input.disabled ? null
                  : composerIdleCollapsed ? input.closest(".composer-box")?.querySelector<HTMLElement>(".composer-idle-preview")
                  : input;
                target?.focus({ preventScroll: true });
                if (!target || target.ownerDocument.activeElement !== target) document.getElementById("page-title")?.focus();
              }} />
            {switchAccountOpen && (
              <SwitchAccountDialog
                session={session}
                machineName={runnerDisp.name}
                machineAccounts={runner?.providerAccounts}
                onOpenConnections={() => navigate({ name: "runners", section: "machines" })}
                onClose={() => setSwitchAccountOpen(false)}
                onSwitched={(scheduled) => showToast(scheduled
                  ? "Account switch scheduled for the next turn boundary."
                  : "Account switched.")}
                returnFocusRef={switchAccountButtonRef}
              />
            )}
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {retitleFeedback?.state === "running"
                ? "Renaming Session."
                : retitleFeedback?.state === "failed"
                  ? "Rename failed. Couldn't rename this session."
                  : ""}
            </span>
            {error && <Notice tone="danger" compact role="alert">{error}</Notice>}
            {queuedPromptControls.length > 0 && (
              <div className="queued-list" aria-label="Queued Messages">
                {/* A disabled control's tooltip is announced by nothing, so the refusal is also a
                    programmatic description of each action it disables. */}
                {queueRefusal !== null && <p className="sr-only" id={queueRefusalId}>{queueRefusal}</p>}
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
                  const queueStatus = statusMeta("queuedMessage", q.durableDeliveryState === "failed"
                    ? "failed"
                    : q.durableDeliveryState === "uncertain"
                      ? "uncertain"
                      : q.durableDeliveryState === "pending"
                        ? "pending_delivery"
                        : locallyPromoting || q.steeringState === "promoting"
                          ? "steering"
                          : q.steeringState === "uncertain"
                            ? "uncertain"
                            : session.queueHeld ? "held" : "queued");
                  // A terminal durable receipt records delivery that has already stopped, so it can
                  // never be cancelled. It carries dismissal instead, and the two are mutually
                  // exclusive: cancellation removes work that may still run, dismissal only hides
                  // settled evidence. The row's removal affordance must not be a disabled control —
                  // the transcript recovery card that used to carry Dismiss is suppressed as soon
                  // as `userEventSeq` lands, so this row is the only place the action can live.
                  const terminalDurable = isTerminalDeliveryReceipt(q);
                  // Session-wide gates (a held queue, a busy turn) are checked before per-row state,
                  // so they would otherwise explain a receipt as waiting on the live FIFO. A settled
                  // receipt is waiting on nothing: it explains itself, and borrows no held styling.
                  const queueTitle = terminalDurable
                    ? TERMINAL_RECEIPT_REASON
                    : locallyPromoting
                      ? "Steering is being submitted for this queued message."
                      : !availability.available
                        ? availability.reason
                        : composerRequestBusy
                          ? "Wait for the current message request to finish."
                        : "Promote this queued message into the active turn.";
                  const heldBadge = session.queueHeld === true && !terminalDurable;
                  const canCancelThis = canCancelQueued && !durable && !reserved && !locallyPromoting &&
                    queueRefusal === null;
                  const steerTitle = queueRefusal ?? queueTitle;
                  const steerDisabled = queueRefusal !== null || !availability.available || locallyPromoting ||
                    composerRequestBusy;
                  const dismissBusy = pendingPromptAction?.commandId === q.id &&
                    pendingPromptAction.action === "dismiss";
                  return (
                    <div
                      className={`queued-item${queuedEdit?.promptId === q.id ? " is-editing" : ""}`}
                      key={q.id}
                      data-testid={`queued-prompt-${q.id}`}
                      aria-current={queuedEdit?.promptId === q.id ? "true" : undefined}
                    >
                      <StatusBadge
                        meta={queueStatus}
                        inline
                        title={heldBadge
                          ? "Waiting for the active turn or control-plane decision to settle; resolve any visible prompt to continue"
                          : queueTitle}
                      />
                      <span className="queued-text">
                        {q.hasImages && <span className="queued-img" aria-hidden="true">📎 </span>}
                        {q.text || (q.hasImages ? "(attachment)" : "")}
                      </span>
                      {q.durableDeliveryError && (
                        <Notice tone="danger" compact>{q.durableDeliveryError}</Notice>
                      )}
                      <div className="queued-actions">
                        <button
                          type="button"
                          className="btn ghost sm queued-steer"
                          disabled={steerDisabled}
                          title={steerTitle}
                          aria-describedby={queueRefusal !== null ? queueRefusalId : undefined}
                          aria-label="Steer Queued Message"
                          onClick={() => void promoteQueuedPrompt(q)}
                        >
                          {locallyPromoting || q.steeringState === "promoting" ? "Steering…" : "Steer"}
                        </button>
                        {steerDisabled && (
                          <details className="queued-steer-info">
                            <summary aria-label="Why Steering Is Unavailable">ⓘ</summary>
                            <span role="status">{steerTitle}</span>
                          </details>
                        )}
                        <button
                          type="button"
                          className="btn ghost sm queued-edit"
                          disabled={queueRefusal !== null || !editAvailability.available || queuedEdit !== null}
                          title={queueRefusal ?? (terminalDurable
                            ? TERMINAL_RECEIPT_REASON
                            : queuedEdit?.promptId === q.id
                              ? "This queued message is already being edited."
                              : editAvailability.available
                                ? "Edit this queued message."
                                : editAvailability.reason)}
                          aria-label="Edit Queued Message"
                          aria-describedby={queueRefusal !== null ? queueRefusalId : undefined}
                          onClick={() => void beginQueuedPromptEdit(q)}
                        >
                          <EditIcon size={14} />
                        </button>
                        {terminalDurable ? (
                          <button
                            type="button"
                            className="btn ghost sm queued-dismiss"
                            disabled={pendingPromptAction !== undefined || queueRefusal !== null}
                            aria-busy={dismissBusy || undefined}
                            title={queueRefusal ?? "Remove this delivery receipt. The message already recorded in the transcript is kept, and no provider work is canceled, resent, or restarted."}
                            aria-label={q.durableDeliveryState === "failed"
                              ? "Dismiss Failed Message"
                              : "Dismiss Uncertain Message"}
                            aria-describedby={queueRefusal !== null ? queueRefusalId : undefined}
                            onClick={() => void resolvePendingPrompt(q.id, "dismiss")}
                          >
                            {dismissBusy ? "Dismissing…" : "Dismiss"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="queued-cancel"
                            disabled={!canCancelThis}
                            title={queueRefusal ?? (
                              !canCancelQueued
                                ? runnerCapabilityRequirement(
                                    runner?.protocolVersion,
                                    "queuedPromptCancellation",
                                    "queued prompt cancellation",
                                  )
                                : reserved || locallyPromoting
                                  ? "Resolve steering before canceling this queued message."
                                  : durable
                                    ? "Durable delivery entries cannot be canceled before runner admission."
                                  : "Cancel this queued message."
                            )}
                            aria-label={canCancelThis ? "Cancel Queued Message" : "Queued Message Cancellation Unavailable"}
                            aria-describedby={queueRefusal !== null ? queueRefusalId : undefined}
                            onClick={() => void api.cancelQueuedPrompt(session.id, q.id)}
                          >
                            ✕
                          </button>
                        )}
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
              ref={composerBoxRef}
              className={`composer-box${dragActive ? " drag-over" : ""}${composerAnswerActive ? " answer-mode" : ""}${composerIdleCollapsed ? " idle-collapsed" : ""}${canPrompt ? "" : " is-disabled"}`}
              onBlur={(event) => {
                const blurredTarget = event.target as HTMLElement;
                if (blurredTarget === inputRef.current || blurredTarget.classList.contains("composer-idle-preview")) {
                  return;
                }
                // A dialog opened from a composer control is portalled to <body>: React still bubbles
                // its focus events through this box, but they are not this box losing focus.
                if (!event.currentTarget.contains(blurredTarget)) return;
                const next = event.relatedTarget as Node | null;
                // Dialogs are portalled to <body>, so a dialog opened from a composer control (the
                // permission details) takes focus outside this box. It hands focus back on close.
                const intoDialog = next instanceof Element && next.closest(".modal-backdrop") !== null;
                // Composer menus are portalled too: a keyboard-opened menu takes focus from its
                // trigger into <body>, which is still the composer's own control.
                if (!composerOwns(event.currentTarget, next) && !intoDialog) {
                  if (composerPointerTransferRef.current === null) setComposerExpanded(false);
                }
              }}
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
                  occurrenceId={pendingQuestion.occurrenceId}
                  isAsync={pendingQuestion.async}
                  questions={composerQuestions}
                  runnerOnline={runnerOnline}
                  active={composerAnswerActive}
                  showWaiting={questionResponseStyle === "composer"}
                  responseRefusal={responseRefusal}
                  inputRef={answerInputRef}
                  onEnter={enterAnswerMode}
                  onExit={exitAnswerMode}
                  onSessionUpdate={loadSession}
                  // Answer Mode replaces the composer bar, Model Settings included, so the figures
                  // come along to stay in reach while the person answers (#2166).
                  usage={composerAnswerActive ? <>
                    <ContextWindowMeter session={session} resolution={contextWindow} placement="bar" />
                    <SessionUsageControl session={session} placement="bar" />
                  </> : null}
                  usageOwnRow={composerUsageNarrow}
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
              <ImageStrip
                images={images}
                onRemove={(i, control) => {
                  remove(i);
                  keepFocusInComposer(control);
                }}
                onInspectReference={(reference, opener) => {
                  workspaceReferenceReturnFocusRef.current = opener;
                  setInspectedWorkspaceReference(reference);
                }}
              />
              {commandPreservesAttachedImages && (
                <Notice tone="warning" compact role="status">{DURABLE_COMMAND_ATTACHMENT_NOTICE}</Notice>
              )}
              {composerReplyKeycap && (
                /* The Reply shortcut's hint (§11.5): a keycap at the end of the idle composer's
                   placeholder row. It takes no height, so it can come and go without moving the
                   textarea; the global coarse-pointer rule hides the keycap itself. */
                <div className="composer-reply-hint" aria-hidden="true">
                  <kbd>{shortcutDisplay("session-reading-reply")}</kbd>
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
                  setComposerExpanded(true);
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
                placeholder={composerPlaceholder}
                rows={1}
                disabled={!canPrompt}
                tabIndex={composerIdleCollapsed ? -1 : undefined}
              />
              {usagePlacement === "row" && (
                /* A narrow column whose Model Settings cannot open: the figures keep a row of their
                   own rather than crowding the bar or becoming unreachable. */
                <div className="composer-usage-row">
                  <ContextWindowMeter session={session} resolution={contextWindow} placement="bar" />
                  <SessionUsageControl session={session} placement="bar" />
                </div>
              )}
              <div className="composer-bar">
                <div className="cbar-left">
                  <ComposerPlusMenu
                    session={session}
                    planActive={planActive}
                    planSupported={planSupported}
                    onTogglePlan={togglePlan}
                    onApply={applyConfig}
                    onSetParentControl={(mode) => {
                      void api.setParentControl(sessionId, mode).then(loadSession, (cause) => {
                        setError((cause as Error).message);
                      });
                    }}
                    onSetParentControlPolicy={(category, authority) => {
                      const policy = session.parentControlPolicy;
                      if (!policy) return;
                      void api.setParentControlPolicy(sessionId, {
                        ...policy.decisions,
                        [category]: authority,
                      }, policy.revision).then(loadSession, (cause) => {
                        setError((cause as Error).message);
                      });
                    }}
                    disabled={!canPrompt}
                    imageMimeTypes={allowedImageMimeTypes}
                    onAttachImages={addFiles}
                  />
                  <button
                    type="button"
                    className={`composer-idle-preview${composerIdleDraft ? "" : " is-empty"}`}
                    aria-label={composerIdleDraft ? `Edit Draft: ${composerIdleDraft}` : composerIdlePreview}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={expandIdleComposer}
                  >
                    {composerIdlePreview}
                  </button>
                  <ApprovalsControl session={session} apply={applyConfig} disabledReason={composerControlsDisabledReason} />
                  {planActive && (
                    <button
                      type="button"
                      className="mode-pill"
                      disabled={composerControlsDisabledReason !== null}
                      // Keep the composer focused until the click lands, like Send: blurring it on
                      // pointerdown brings the phone rail back and moves this pill out from under the
                      // finger (#1903).
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        togglePlan(false);
                        if (planSupported) keepFocusInComposer(event.currentTarget);
                      }}
                      aria-describedby={composerControlsDisabledReason !== null ? configRefusalId : undefined}
                      title={composerControlsDisabledReason !== null
                        ? `Plan mode is on. ${composerControlsDisabledReason}`
                        : "Plan mode is on — the agent researches + proposes, no edits. Click to turn off."}
                    >
                      ◒ Plan
                    </button>
                  )}
                  <ModelEffortControl
                    session={session}
                    apply={applyConfig}
                    pendingModel={() => pendingConfig.current.model}
                    pendingEffort={() => pendingConfig.current.effort}
                    pendingServiceTier={() => pendingConfig.current.serviceTier}
                    disabledReason={composerControlsDisabledReason}
                    sessionUsage={usagePlacement === "model-settings"
                      ? <SessionUsageMenuGroup session={session} resolution={contextWindow} />
                      : null}
                  />
                  {composerControlsDisabledReason !== null && planActive && (
                    <span className="sr-only" id={configRefusalId}>{composerControlsDisabledReason}</span>
                  )}
                </div>
                <div className="cbar-right">
                  {cancelTurnRefusal !== null && (
                    <span className="sr-only" id={`stop-turn-refusal-${session.id}`}>{cancelTurnRefusal}</span>
                  )}
                  {dictation.supported && !canPrompt && (
                    <span className="sr-only" id={composerUnavailableId}>{promptUnavailableReason}</span>
                  )}
                  {usagePlacement === "bar" && <>
                    {/* Context, then cost (#781): occupancy and spend, each opening its own popover. */}
                    <ContextWindowMeter session={session} resolution={contextWindow} placement="bar" />
                    <SessionUsageControl session={session} placement="bar" />
                  </>}
                  {dictation.supported && (
                    <button
                      type="button"
                      className={`voice-btn${dictation.recording ? " voice-recording" : ""}`}
                      // A composer that cannot send takes no dictation either (#2154).
                      disabled={!canPrompt}
                      aria-describedby={canPrompt ? undefined : composerUnavailableId}
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
                  {composerRestartOffered ? (
                    <button
                      type="button"
                      className="send-btn"
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => void restartFromComposer()}
                      disabled={!runnerOnline || composerRequestBusy || restartRefusal !== null}
                      title={restartPending ? "Restarting Session" : restartRefusal ?? "Restart Session"}
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
                      disabled={primaryComposerAction === "stopping" || cancelTurnRefusal !== null}
                      title={primaryComposerAction === "stopping"
                        ? "Stopping Turn"
                        : cancelTurnRefusal ?? `Stop Turn (${shortcutDisplay("stop-turn")})`}
                      aria-label={primaryComposerAction === "stopping" ? "Stopping Turn" : "Stop Turn"}
                      aria-describedby={cancelTurnRefusal !== null ? `stop-turn-refusal-${session.id}` : undefined}
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
        {pinnedSummary && pinnedSummaryContent && pinnedSummary.presentation !== "sheet" && (
          <PinnedSummaryDock
            presentation={pinnedSummary.presentation}
            onClose={pinnedSummary.closeOverlay}
            toggleRef={pinnedSummary.toggleRef}
          >
            {pinnedSummaryContent}
          </PinnedSummaryDock>
        )}
        </div>

        {mode === "expanded" && <RightPanel
          state={rightPanel}
          session={session}
          earlierActivityUnloaded={isPartialHistory(eventWindow)}
          sourceLocation={sourceLocation}
          attentionTarget={attentionTarget}
          onOpenSourceLocation={openSourceLocation}
          onClearSourceLocation={clearSourceLocation}
          runnerOnline={runnerOnline}
          runnerProtocolVersion={runner?.protocolVersion}
          git={git}
          forge={gitSummary.summary?.forge}
          onOpenTerminal={onOpenTerminal}
          onInsertSideChatDraft={insertSideChatDraft}
          onAttachWorkspaceReference={workspaceReferencesSupported ? attachWorkspaceTarget : undefined}
          items={items}
          governanceDecisions={governanceDecisions}
          governanceAvailable={governanceAudit.available}
          governanceHasMore={governanceAudit.hasMore}
          governanceLoadingOlder={governanceAudit.loadingOlder}
          onLoadOlderGovernance={governanceAudit.loadOlder}
          descendantRequests={descendantRequests}
          descendantRequestStatus={descendantRequestStatus}
          campaignAvailability={campaignAvailability}
          onOpenSession={(id) => navigate({ name: "session", id })}
          selectedRequestKey={selectedRequestKey}
          onSelectedRequestKeyChange={setSelectedRequestKey}
          onSessionUpdate={loadSession}
          onDescendantsUpdate={refreshDescendantRequestsAfterResolution}
          onOpenChildRequest={(request) => {
            rightPanel.close();
            navigate({
              name: "session",
              id: request.sessionId,
              attention: {
                eventEpoch: request.eventEpoch,
                requestId: request.request.requestId,
              },
            });
          }}
          parentTurnEventIds={backgroundParentTurnEventIds}
          onOpenParentTurn={revealBackgroundParentTurn}
          backgroundInventoryError={backgroundInventoryError}
          onRetryBackgroundInventory={retryBackgroundInventory}
        />}
      </div>
      {/* A phone opens the summary as a bottom sheet (§7.5, §9.2), so the transcript never sits
          behind a nested scroll box. */}
      {pinnedSummary && pinnedSummaryContent && pinnedSummary.presentation === "sheet" && (
        <Modal
          title="Pinned Summary"
          onClose={pinnedSummary.closeOverlay}
          returnFocusRef={sheetReturnFocusRef}
          className="ps-sheet"
        >
          {pinnedSummaryContent}
        </Modal>
      )}
      {mode === "expanded" && inspectedWorkspaceReference && (
        <Modal
          title="Workspace Reference"
          onClose={() => setInspectedWorkspaceReference(null)}
          returnFocusRef={workspaceReferenceReturnFocusRef}
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
      {handoffTurn !== null && <ConversationHandoffDialog agents={runner?.agents ?? []} sourceDriver={session.driver}
        sourceServiceTier={session.serviceTier ?? undefined} turn={handoffTurn} refusal={forkRefusal}
        onClose={() => setHandoffTurn(null)} onCreate={async (agentId, config) => {
          if (forkRefusal !== null) throw new Error(forkRefusal);
          const release = acquireSessionFork(sessionId);
          if (!release) throw new Error("A conversation fork or handoff is already in progress.");
          let releaseOnFinish = true;
          try {
            const child = await api.handoff(sessionId, handoffTurn, agentId, config);
            if (!child.handoffDraft) throw new Error("The runner returned no handoff draft.");
            stageComposerDraftHandoff(child.id, child.handoffDraft.text, child.handoffDraft.images, instanceScope);
            await saveComposerDraft(child.id, child.handoffDraft.text, child.handoffDraft.images, instanceScope);
            setHandoffTurn(null); navigate({ name: "session", id: child.id });
          } catch (cause) {
            const ambiguous = ambiguousForkError(cause);
            if (ambiguous) { releaseOnFinish = false; throw ambiguous; }
            throw cause;
          } finally { if (releaseOnFinish) release(); }
        }} />}
      {mode === "expanded" && messageAction && (
        <MessageActionDialog
          key={`${messageAction.mode}-${messageAction.item.id}`}
          action={messageAction}
          existingDraftPresent={Boolean(text || images.length)}
          resendUnavailableReason={promptUnavailableReason}
          forkRefusal={forkRefusal}
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
  resendUnavailableReason,
  forkRefusal,
  busy,
  returnFocusRef,
  onClose,
  onPrepareResend,
  onPrepareFork,
}: {
  action: MessageActionState;
  existingDraftPresent: boolean;
  /** Why the session cannot accept a new turn, when that changes while the dialog is open. */
  resendUnavailableReason: string | null;
  /** Why the signed-in person may not fork, when that changes while the dialog is open (#1864). */
  forkRefusal: string | null;
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
  const refusal = action.mode === "fork" ? forkRefusal : null;

  const submit = async () => {
    if (submitLock.current || refusal !== null) return;
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
      title={action.mode === "resend" ? "Edit as a New Turn" : "Edit in a Conversation Fork"}
      onClose={submitting ? () => {} : onClose}
      returnFocusRef={returnFocusRef}
      footer={(
        <>
          <button className="btn" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="btn primary"
            type="submit"
            form={formId}
            disabled={submitting || retryBlocked || (action.mode === "fork" && busy) || (action.mode === "resend" && resendUnavailableReason !== null) ||
              refusal !== null}
            title={refusal ?? undefined}
            aria-describedby={refusal !== null ? `${formId}-refusal` : undefined}
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
        {refusal !== null && (
          <p id={`${formId}-refusal`} className="message-action-warning" role="status">{refusal}</p>
        )}
        {action.mode === "resend" && resendUnavailableReason !== null && (
          <p className="message-action-warning" role="status">{resendUnavailableReason}</p>
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

/**
 * A width change into the compact tier hides the project button (§15.2), and More Actions holds its
 * items from then on. Like a page header's folded menu button, it takes its open menu with it, and
 * focus that was on the button or in the menu moves to More Actions, or else to the page title,
 * rather than being left on a hidden element and dropped on <body> (§16.1).
 */
function useProjectButtonFold(
  open: boolean,
  close: () => void,
  triggerRef: RefObject<HTMLButtonElement | null>,
  surfaceRef: RefObject<HTMLDivElement | null>,
) {
  // Whether focus last landed on the button or in its menu. Hiding the focused button lets the
  // browser's focus fixup drop focus on <body> before the observer below runs, so the active
  // element alone cannot say where focus was; `focusin` never fires for that drop.
  const focusHeld = useRef(false);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      focusHeld.current = target !== null &&
        (target === triggerRef.current || Boolean(surfaceRef.current?.contains(target)));
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [triggerRef, surfaceRef]);
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof ResizeObserver === "undefined") return;
    const bar = trigger.closest<HTMLElement>(".session-bar");
    const observer = new ResizeObserver(() => {
      if (trigger.getClientRects().length > 0) return;
      const active = trigger.ownerDocument.activeElement;
      const dropped = active === null || active === trigger.ownerDocument.body;
      const hadFocus = active === trigger || Boolean(active && surfaceRef.current?.contains(active)) ||
        (dropped && focusHeld.current);
      if (open) close();
      if (!hadFocus) return;
      const target = projectButtonHandoffTarget(trigger);
      target?.focus();
      if (target && target !== trigger.ownerDocument.getElementById("page-title") &&
        trigger.ownerDocument.activeElement !== target) {
        trigger.ownerDocument.getElementById("page-title")?.focus();
      }
    });
    observer.observe(trigger);
    if (bar) observer.observe(bar);
    return () => observer.disconnect();
  }, [open, close, triggerRef, surfaceRef]);
}

/**
 * Where focus belongs for the project button: the button while it is shown, More Actions once the
 * compact tier folds the button away, or the page title while More Actions is disabled (a session
 * action is running) — a disabled button cannot take focus, and the title always can.
 */
function projectButtonHandoffTarget(trigger: HTMLButtonElement | null): HTMLElement | null {
  if (!trigger) return null;
  if (trigger.isConnected && trigger.getClientRects().length > 0) return trigger;
  const more = trigger.closest<HTMLElement>(".session-bar")
    ?.querySelector<HTMLButtonElement>('.detail-actions [aria-label="More Actions"]');
  if (more && !more.disabled && more.getClientRects().length > 0) return more;
  return trigger.ownerDocument.getElementById("page-title");
}

/**
 * A dialog opened from the project button returns focus to a visible target (§16.1): the window
 * can narrow while it is open and fold the button away, which used to leave focus on nothing. The
 * target is resolved as the dialog closes, not as it opens.
 */
function useProjectButtonReturnFocus(triggerRef: RefObject<HTMLButtonElement | null>): { current: HTMLElement | null } {
  return useMemo(() => ({
    get current() { return projectButtonHandoffTarget(triggerRef.current); },
  }), [triggerRef]);
}

/** Assigns durable Project organization without changing the session's execution Location. */
function ProjectMenuButton({ session }: { session: SessionView }) {
  const projectsSupported = useStoreSelector((state) => state.projectsSupported);
  return projectsSupported
    ? <DurableProjectMenuButton session={session} />
    : <LegacyWorkspaceChip session={session} />;
}

/**
 * The session bar's project menu button (§4.3, §9.1): the projects icon, the project name and a
 * caret, opening a menu headed by the name with Open Project and Move to Another Project…. A
 * session with no project offers only Move to a Project…. The name does not navigate on its own.
 */
function DurableProjectMenuButton({ session }: { session: SessionView }) {
  const projects = useStoreSelector((state) => state.projects);
  const { navigate } = useStoreActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const menu = useAccessibleMenu(menuOpen, setMenuOpen, "session-project-menu");
  const closeFolded = useCallback(() => menu.close(false), [menu.close]);
  useProjectButtonFold(menuOpen, closeFolded, menu.triggerRef, menu.menuRef);
  const returnFocusRef = useProjectButtonReturnFocus(menu.triggerRef);
  const currentName = (session.projectId ? projects.get(session.projectId)?.name : undefined) ?? session.projectName;

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn ghost session-project-button"
        data-empty={currentName ? undefined : ""}
        title={currentName ?? "No Project"}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menu.menuId}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <ProjectsIcon size={14} />
        <span className="session-project-button-label">{currentName ?? "No Project"}</span>
        <ChevronDownIcon size={14} />
      </button>
      {menuOpen && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Project Actions"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuLabel className="session-project-menu-label">{currentName ?? "No Project"}</MenuLabel>
          {session.projectId && currentName && (
            <MenuItem
              onClick={() => {
                menu.close(false);
                navigate({ name: "projects", id: session.projectId! });
              }}
            >
              Open Project
            </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              menu.close(false);
              setMoveOpen(true);
            }}
          >
            {session.projectId && currentName ? "Move to Another Project…" : "Move to a Project…"}
          </MenuItem>
        </MenuSurface>
      )}
      {moveOpen && (
        <MoveToProjectDialog
          session={session}
          onClose={() => setMoveOpen(false)}
          returnFocusRef={returnFocusRef}
        />
      )}
    </>
  );
}

/** The session bar's project button on control planes without Projects (#2163, §9.1): the folder
 * icon and the session's workspace, opening a radio-like menu titled Move to Workspace. Choosing a
 * workspace files the session there; New Workspace… opens its own dialog, so no form grows inside
 * the menu. The assignment is CP-owned view state (no runner round-trip), so it works while the
 * runner is offline — the store's last-registered workspace list is fine. */
function LegacyWorkspaceChip({ session }: { session: SessionView }) {
  const api = useApi();
  const runner = useStoreSelector((s) => s.runners.get(session.runnerId));
  const box = useStoreSelector((s) => [...s.boxes.values()].find((candidate) => candidate.runnerId === session.runnerId));
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const workspaces = runner?.workspaces ?? [];
  const runnerOnline = runner?.status === "online";
  const menu = useAccessibleMenu(open, setOpen, "workspace-menu");
  const closeFolded = useCallback(() => menu.close(false), [menu.close]);
  useProjectButtonFold(open, closeFolded, menu.triggerRef, menu.menuRef);
  const returnFocusRef = useProjectButtonReturnFocus(menu.triggerRef);

  const pick = (workspaceId: string | null) => {
    menu.close(true);
    if (workspaceId !== session.workspaceId) void api.setWorkspace(session.id, workspaceId);
  };

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn ghost session-project-button"
        data-empty={session.workspaceName ? undefined : ""}
        title={session.workspaceName ?? "No Workspace"}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu.menuId}
      >
        <FolderIcon size={14} />
        <span className="session-project-button-label">{session.workspaceName ?? "No Workspace"}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Move to Workspace"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuLabel>Move to Workspace</MenuLabel>
          <MenuItem
            role="menuitemradio"
            checked={session.workspaceId == null}
            description="Keep the session ungrouped."
            onClick={() => pick(null)}
          >
            No Workspace
          </MenuItem>
          {workspaces.map((ws) => (
            <MenuItem
              key={ws.id}
              role="menuitemradio"
              checked={session.workspaceId === ws.id}
              description={<span title={ws.path}>{shortenPath(ws.path)}</span>}
              onClick={() => pick(ws.id)}
            >
              {ws.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            icon={<PlusIcon size={16} />}
            disabled={!runnerOnline}
            description={runnerOnline ? undefined : `${runnerDisplay(runner, box, session.runnerId).name} is offline.`}
            onClick={() => {
              menu.close(false);
              setCreating(true);
            }}
          >
            New Workspace…
          </MenuItem>
        </MenuSurface>
      )}
      {creating && (
        <NewWorkspaceDialog session={session} onClose={() => setCreating(false)} returnFocusRef={returnFocusRef} />
      )}
    </>
  );
}

export function CampaignContinuationNotice({
  continuation,
  acknowledgementPending = false,
  actionRefusal = null,
  onAcknowledge,
  onRetry,
}: {
  continuation: NonNullable<NonNullable<SessionView["orchestratorCampaign"]>["continuation"]>;
  acknowledgementPending?: boolean;
  /** Why the signed-in person may not resolve the continuation (#1857). */
  actionRefusal?: string | null;
  onAcknowledge?: (commandId: string) => void;
  onRetry?: (commandId: string) => void;
}) {
  const refusalId = `campaign-continuation-refusal-${useId().replace(/:/gu, "")}`;
  const label = continuation.state === "missing_result"
    ? "Missing Result"
    : titleCaseLabel(continuation.state);
  const eventLabel = `${continuation.pendingEvents} Pending ${continuation.pendingEvents === 1 ? "Event" : "Events"}`;
  const explanation = continuation.state === "pending"
    ? "Wollipog is coalescing durable campaign events before resuming the Orchestrator."
    : continuation.state === "running"
      ? "The Orchestrator is reconciling durable descendant campaign events."
      : continuation.state === "held"
        ? "Campaign events are preserved until the current human, lifecycle, or guardrail blocker clears."
        : continuation.state === "failed"
          ? continuation.canRetry
            ? "Automatic retrying stopped. Retry the continuation when the failure is resolved."
            : "The continuation failed. Wollipog will retry it with bounded backoff."
          : "The provider accepted this continuation, but no terminal result was recorded. It will not be replayed automatically.";
  const canAcknowledge = continuation.state === "missing_result" &&
    continuation.canAcknowledgeMissingResult === true && Boolean(continuation.commandId) && onAcknowledge;
  const canRetry = continuation.state === "failed" && continuation.canRetry === true &&
    Boolean(continuation.commandId) && onRetry;
  return (
    <Notice
      tone={continuation.state === "failed" || continuation.state === "missing_result" ? "warning" : "neutral"}
      dataState={continuation.state}
      role="status"
      ariaLabel={`Campaign Continuation: ${label}`}
      ariaBusy={acknowledgementPending}
      title={`Campaign Continuation: ${label}`}
      actions={(canAcknowledge || canRetry) && (
        <>
          {canAcknowledge && (
            <button
              type="button"
              className="btn sm"
              disabled={acknowledgementPending || actionRefusal !== null}
              title={actionRefusal ?? undefined}
              aria-describedby={actionRefusal !== null ? refusalId : undefined}
              onClick={() => onAcknowledge(continuation.commandId!)}
            >
              {acknowledgementPending ? "Acknowledging…" : "Acknowledge Missing Result"}
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              className="btn sm"
              disabled={acknowledgementPending || actionRefusal !== null}
              title={actionRefusal ?? undefined}
              aria-describedby={actionRefusal !== null ? refusalId : undefined}
              onClick={() => onRetry(continuation.commandId!)}
            >
              {acknowledgementPending ? "Retrying…" : "Retry Campaign Continuation"}
            </button>
          )}
        </>
      )}
    >
      <p>{explanation}</p>
      <p className="notice-meta">{eventLabel} · Attempt {continuation.attemptCount}</p>
      {continuation.error && <p className="notice-meta">{continuation.error}</p>}
      {actionRefusal !== null && (canAcknowledge || canRetry) && <p className="notice-meta" id={refusalId}>{actionRefusal}</p>}
    </Notice>
  );
}

/** Codex-style "+" menu in the composer: Attach Image, Plan mode, and the cost budget. */
export function ComposerPlusMenu({
  session,
  planActive,
  planSupported,
  onTogglePlan,
  onApply,
  onSetParentControl,
  onSetParentControlPolicy,
  disabled,
  imageMimeTypes,
  onAttachImages,
}: {
  session: SessionView;
  planActive: boolean;
  planSupported: boolean;
  onTogglePlan: (on?: boolean) => void;
  onApply: (patch: Partial<SessionConfig>) => void;
  onSetParentControl?: (mode: ParentControlMode) => void;
  onSetParentControlPolicy?: (category: DelegatableWorkflowDecisionCategory, authority: WorkflowDecisionAuthority) => void;
  disabled: boolean;
  /** Exactly the types the connected runner and selected model accept; empty when images cannot be sent. */
  imageMimeTypes: readonly string[];
  onAttachImages: (files: File[]) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const popover = useDismissiblePopover(open, setOpen, "composer-modes-popover");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesSupported = imageMimeTypes.length > 0;
  // Attachment follows the composer, exactly as paste (a disabled textarea) and drop (its own
  // `canPrompt` guard) already do. `disabled` can flip while the panel — or the native chooser —
  // is already open, so the item and the change handler are gated separately.
  const canAttach = !disabled && imagesSupported;
  return (
    <div className="composer-plus">
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
        // Keep the composer focused until the click lands, like Send: blurring it on pointerdown
        // brings the phone rail back and moves this button out from under the finger (#1797).
        onPointerDown={(event) => event.preventDefault()}
        onClick={popover.toggle}
        onKeyDown={popover.onTriggerKeyDown}
      >
        <PlusIcon size={16} />
      </button>
      {open && (
        // Menu-shaped, but it holds the guardrail fields too, so it is a dialog rather than a menu.
        <MenuSurface
          surfaceRef={popover.panelRef}
          anchor={{ trigger: popover.triggerRef }}
          id={popover.panelId}
          role="dialog"
          label="Session Attachments, Modes, and Guardrails"
          // Where a coarse pointer's focus lands when the first enabled control is a field.
          tabIndex={-1}
          width={320}
          boundary=".composer-box"
          onDismiss={() => popover.close(true)}
          onKeyDown={popover.onPanelKeyDown}
        >
          <MenuLabel>Attach</MenuLabel>
          <MenuItem
            role="button"
            icon={<ImageIcon size={16} />}
            description={!imagesSupported
              ? "The selected model does not support image input."
              : disabled
                ? "This session cannot accept a prompt right now."
                : `Photos, camera, or files · up to ${MAX_PROMPT_IMAGES}`}
            disabled={!canAttach}
            onClick={() => {
              fileInputRef.current?.click();
              popover.close(true);
            }}
          >
            Attach Image
          </MenuItem>

          {planSupported && (
            <>
              <MenuLabel>Modes</MenuLabel>
              <MenuItem
                role="checkbox"
                checked={planActive}
                description={<>Research + propose a plan, no edits. Or type <code>/plan</code>.</>}
                onClick={() => {
                  onTogglePlan();
                  popover.close(true);
                }}
              >
                Plan Mode
              </MenuItem>
            </>
          )}

          <MenuLabel>Guardrails</MenuLabel>
          <GuardrailInput
            prefix="$"
            label="Recurring Cost Threshold"
            step="0.5"
            value={session.costBudgetUsd}
            hint="Pauses when spend reaches this amount. Continue advances the next threshold by another equal allowance."
            onCommit={(v) => onApply({ costBudgetUsd: v })}
          />
          <CheckpointsInput
            value={session.costCheckpointsUsd ?? null}
            approvedUsd={session.costCheckpointApprovedUsd ?? null}
            onCommit={(list) => onApply({ costCheckpointsUsd: list })}
          />
          <GuardrailInput
            prefix="#"
            label="Tool-Call Threshold"
            step="1"
            integer
            value={session.maxToolCalls}
            hint={
              "Pauses after this many tool calls." +
              (session.maxToolCalls != null && session.toolCallCount != null ? ` ${session.toolCallCount} used.` : "")
            }
            onCommit={(v) => onApply({ maxToolCalls: v })}
          />
          <GuardrailInput
            prefix="↳"
            label="Live Child Limit"
            step="1"
            integer
            value={session.maxChildSessions}
            placeholder={String(DEFAULT_LIVE_CHILD_LIMIT)}
            max={String(MAX_LIVE_CHILD_LIMIT)}
            emptyMeansNoop
            hint={session.liveChildCapacity
              ? `${session.liveChildCapacity.limit} limit · ${session.liveChildCapacity.occupied} occupied · ${session.liveChildCapacity.remaining} remaining. Set 0 to pause new child admission. Terminal and archived children release their slots.`
              : "A session can run four live children by default. Set 0 to pause new child admission. Terminal and archived children release their slots."}
            onCommit={(v) => onApply({ maxChildSessions: v })}
          />
          {sessionRole(session) === "orchestrator" && (
            <div className="plus-budget">
              <span className="plus-budget-prefix" aria-hidden="true">↯</span>
              <div className="parent-control-settings">
                {session.orchestratorPolicy && <section className="active-campaign-policy" aria-label="Active Campaign Behavior">
                  <strong>Campaign Behavior</strong>
                  <span className="muted">This campaign keeps its stored policy when account defaults change.</span>
                  <dl>
                    {session.orchestratorCampaign && <div><dt>Campaign Status</dt><dd>{session.orchestratorCampaign.status === "waiting_human" ? "Waiting for Human" : titleCaseLabel(session.orchestratorCampaign.status.replaceAll("_", " "))}<small>Policy Revision {session.orchestratorCampaign.policyRevision}</small></dd></div>}
                    <div><dt>Child Harness</dt><dd>{session.orchestratorPolicy.behavior.childHarness
                      ? agentHarnessIdentityLabel(session.orchestratorPolicy.behavior.childHarness)
                      : "Automatic"}<small>{titleCaseLabel((session.orchestratorPolicy.sources.behavior.childHarness ?? "legacy_session").replaceAll("_", " "))}</small></dd></div>
                    <div><dt>Child Model</dt><dd>{session.orchestratorPolicy.behavior.childModel ?? "Automatic"}<small>{titleCaseLabel(session.orchestratorPolicy.sources.behavior.childModel.replaceAll("_", " "))}</small></dd></div>
                    <div><dt>Child Effort</dt><dd>{session.orchestratorPolicy.behavior.childEffort ? titleCaseLabel(session.orchestratorPolicy.behavior.childEffort) : "Automatic"}<small>{titleCaseLabel(session.orchestratorPolicy.sources.behavior.childEffort.replaceAll("_", " "))}</small></dd></div>
                    <div><dt>Maximum Concurrent Children</dt><dd>{session.orchestratorPolicy.behavior.maximumConcurrentChildren}<small>{titleCaseLabel(session.orchestratorPolicy.sources.behavior.maximumConcurrentChildren.replaceAll("_", " "))}</small></dd></div>
                    <div><dt>Follow-Ups</dt><dd>{titleCaseLabel(session.orchestratorPolicy.behavior.followUps.replaceAll("_", " "))}<small>{titleCaseLabel(session.orchestratorPolicy.sources.behavior.followUps.replaceAll("_", " "))}</small></dd></div>
                    <div><dt>Completion</dt><dd>{titleCaseLabel(session.orchestratorPolicy.behavior.completion.replaceAll("_", " "))}<small>{titleCaseLabel(session.orchestratorPolicy.sources.behavior.completion.replaceAll("_", " "))}</small></dd></div>
                    {/* An older control plane publishes no execution block at all, and one between
                        v144 and v164 publishes it without this field. Read both defensively and
                        fall back the same way the stored policy's own migration does: a strict
                        policy is only ever delivered by a preset launch, which carries no user
                        integration. */}
                    {(() => {
                      // A pre-v164 payload has no field. Derive it in the same order the
                      // control-plane migration does, and for the same reason: EVERY coupled
                      // preset launch replaces the provider surface and so carries no user
                      // integration, including the non-strict Claude and Codex preset shapes,
                      // where `strictProjectIsolation` is false. Reading strictness first would
                      // report those as Disabled even though they removed the integrations.
                      const enabled = session.orchestratorPolicy!.execution?.integrationIsolation ??
                        (usesOrchestratorPresetPermissions(session) ||
                          (session.orchestratorPolicy!.execution?.strictProjectIsolation ?? true));
                      // A preset launch is not the additive launch minus integrations, so it
                      // gets its own sentence instead of the per-harness "kept" list.
                      const copy = integrationIsolationDisclosure(session.driver);
                      const disclosure = usesOrchestratorPresetPermissions(session)
                        ? ORCHESTRATOR_PRESET_INTEGRATION_DISCLOSURE
                        : `${copy.removed} ${copy.kept}`;
                      return <div title={enabled ? disclosure : undefined}>
                        <dt>Integration Isolation</dt>
                        <dd>{enabled ? "Enabled" : "Disabled"}<small>{titleCaseLabel(
                          (session.orchestratorPolicy!.sources.execution?.integrationIsolation ?? "legacy_session")
                            .replaceAll("_", " "))}</small></dd>
                      </div>;
                    })()}
                    {session.orchestratorCampaign && <>
                      <div><dt>Children</dt><dd>{session.orchestratorCampaign.children.total}<small>{session.orchestratorCampaign.children.verified} Verified · {session.orchestratorCampaign.children.active} Active · {session.orchestratorCampaign.children.waitingHuman} Waiting for Human · {session.orchestratorCampaign.children.blocked} Blocked</small></dd></div>
                      <div><dt>Follow-Up Recommendations</dt><dd>{session.orchestratorCampaign.followUps.unique}<small>{session.orchestratorCampaign.followUps.duplicates} Duplicates Skipped</small></dd></div>
                    </>}
                  </dl>
                  {session.orchestratorCampaign?.uiEvidenceReview.status === "unavailable" && <span className="muted" role="status">UI Evidence Approval is assigned to the Orchestrator but is routed to a human. {session.orchestratorCampaign.uiEvidenceReview.reason ?? "This Orchestrator client cannot inspect the evidence bytes."}</span>}
                  {session.orchestratorCampaign?.uiEvidenceReview.status === "available" && session.orchestratorCampaign.uiEvidenceReview.effectiveOwner === "orchestrator" && <span className="muted" role="status">The Orchestrator reviews image evidence attached as Session artifacts. Video normally goes to a human; one operator-enabled short-frame validation campaign may delegate it. Externally stored evidence goes to a human.</span>}
                </section>}
                <div className="parent-control-setting">
                  <span className="parent-control-setting-label">Descendant Requests</span>
                  <Select<ParentControlMode>
                    label="Parent Control"
                    value={session.parentControl ?? "off"}
                    onChange={(value) => onSetParentControl?.(value)}
                    options={[
                      { value: "off", label: "Human", description: "Keep descendant requests human-owned." },
                      { value: "questions", label: "Questions", description: "Delegate non-secret descendant questions." },
                      { value: "questions_and_approvals", label: "Questions and Approvals", description: "Also delegate eligible one-time approvals." },
                    ]}
                  />
                </div>
                {session.parentControlPolicy && ([
                  ["implementation_question", "Implementation Questions"],
                  ["pr_merge", "PR Merge Approval"],
                  ["merged_branch_deletion", "Merged Branch Deletion"],
                  ["follow_up_issue_publication", "Follow-Up Issue Publication"],
                  ["ui_evidence_approval", "UI Evidence Approval"],
                ] as Array<[DelegatableWorkflowDecisionCategory, string]>).map(([category, label]) => (
                  <div className="parent-control-setting" key={category}>
                    <span className="parent-control-setting-label">{label}</span>
                    <Select<WorkflowDecisionAuthority>
                      label={label}
                      value={session.parentControlPolicy!.decisions[category]}
                      onChange={(value) => onSetParentControlPolicy?.(category, value)}
                      options={[
                        { value: "human", label: "Human", description: "Require a human decision for this exact workflow gate." },
                        { value: "orchestrator", label: "Orchestrator", description: "Let the controlling Orchestrator review this typed gate." },
                      ]}
                    />
                    {category === "ui_evidence_approval" && <span className="muted parent-control-help">{DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE}</span>}
                  </div>
                ))}
                <span className="muted parent-control-help">Only an authenticated human can change these assignments. Existing unconsumed approvals are revoked when the policy changes. Secrets, authentication, persistent grants, governance, budgets, and tool guardrails remain human-only.</span>
              </div>
            </div>
          )}
        </MenuSurface>
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
  const inputId = useId();
  const hint = `Enter absolute spend amounts separated by commas. Each pauses once; after approval, it does not ask again. ` +
    `Checkpoints at or above the recurring cost threshold do not pause separately.` +
    (approvedUsd != null ? ` Approved through $${approvedUsd.toFixed(2)}.` : "");
  const commit = () => {
    if (draft === null) return;
    const list = draft.split(/[\s,]+/).map(Number).filter((usd) => Number.isFinite(usd) && usd > 0);
    setDraft(null);
    if (list.join(",") !== (value ?? []).join(",")) onCommit(list);
  };
  return (
    <div className="plus-budget">
      <span className="plus-budget-prefix" aria-hidden="true">$…</span>
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        placeholder="none"
        value={draft ?? live}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }}
      />
      <span className="plus-budget-copy">
        <span className="plus-budget-label-row">
          <label className="plus-budget-label" htmlFor={inputId}>Cost Checkpoints</label>
          <GuardrailHelp label="Cost Checkpoints" hint={hint} />
        </span>
      </span>
    </div>
  );
}

/**
 * A guardrail numeric input. A controlled draft shadows the server value only WHILE editing, so a
 * WebSocket echo (or another dashboard's change) can't remount the input mid-edit and discard
 * typing; unfocused, it tracks the live value. Typos (badInput like "1e", or sub-1 values for
 * integer fields that would floor into the clear sentinel) are a no-op + display resync — only a
 * deliberate empty/0 reaches the caller. Spend/tool callers treat that as clear; the live-child
 * caller treats it as pausing new child admission.
 */
function GuardrailInput({
  prefix,
  label,
  step,
  integer,
  value,
  placeholder = "∞",
  max,
  emptyMeansNoop,
  hint,
  onCommit,
}: {
  prefix: string;
  label: string;
  step: string;
  integer?: boolean;
  value: number | null | undefined;
  placeholder?: string;
  max?: string;
  /** This field has no clear sentinel: zero is meaningful, while an empty edit is a no-op. */
  emptyMeansNoop?: boolean;
  hint: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null); // null = not editing
  const inputId = useId();
  return (
    <div className="plus-budget">
      <span className="plus-budget-prefix" aria-hidden="true">{prefix}</span>
      <input
        id={inputId}
        type="number"
        min="0"
        max={max}
        step={step}
        placeholder={placeholder}
        value={draft ?? (value ?? "")}
        onFocus={(e) => setDraft(e.target.value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          if (draft === null) return;
          if (emptyMeansNoop && draft.trim() === "") {
            setDraft(null);
            return;
          }
          const v = parseFloat(draft);
          if (e.target.validity.badInput || e.target.validity.rangeOverflow || e.target.validity.rangeUnderflow ||
              (integer && Number.isFinite(v) && v > 0 && v < 1)) {
            setDraft(null); // typo — resync to the live value, don't clear an armed limit
            return;
          }
          setDraft(null);
          onCommit(Number.isFinite(v) && v > 0 ? (integer ? Math.floor(v) : v) : 0);
        }}
      />
      <span className="plus-budget-copy">
        <span className="plus-budget-label-row">
          <label className="plus-budget-label" htmlFor={inputId}>{label}</label>
          <GuardrailHelp label={label} hint={hint} />
        </span>
      </span>
    </div>
  );
}

/** Compact, keyboard-dismissible disclosure for guardrail guidance that would otherwise dominate the menu. */
function GuardrailHelp({ label, hint }: { label: string; hint: string }) {
  const popover = useAnchoredPopover<HTMLSpanElement, HTMLButtonElement>({
    width: 224,
    height: 96,
    consumeEscape: true,
  });
  const popoverId = useId();
  return (
    <span
      ref={popover.rootRef}
      className={`plus-budget-help${popover.open ? " is-open" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) popover.close();
      }}
    >
      <button
        ref={popover.anchorRef}
        className="plus-budget-info"
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={popover.open}
        aria-controls={popoverId}
        aria-describedby={popover.open ? popoverId : undefined}
        title={`About ${label}`}
        onClick={popover.toggle}
      >
        <InfoIcon size={14} />
      </button>
      {popover.open && (
        <span className="plus-budget-help-popover" id={popoverId} role="note" style={popover.style}>{hint}</span>
      )}
    </span>
  );
}

/** Head of a bounded window: the transcript continues above, but only on request. Scrolling to the
 * top loads it automatically; this row is the fallback for people who cannot scroll to trigger that
 * (#313). It is one `.tl-earlier` row in every state (#2172): a hairline, centered content and a
 * hairline, holding Load Earlier Activity, a loading line or a compact danger notice with Retry. */
export function EarlierActivityControl({
  available,
  loading,
  error,
  olderCount,
  onLoad,
  fallbackFocusRef,
}: {
  available: boolean;
  loading: boolean;
  error: string | null;
  /** Events above the loaded window, when known. */
  olderCount?: number;
  onLoad: () => boolean;
  fallbackFocusRef: { current: HTMLElement | null };
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const keyboardRequestRef = useRef(false);
  const loadingFocusEstablishedRef = useRef(false);

  useLayoutEffect(() => {
    if (!keyboardRequestRef.current) return;
    const root = rootRef.current;
    if (!root) return;
    if (loading) {
      // Hand focus to the persistent loading target once. Later in-flight state changes must not
      // reclaim it if the reader has already moved to another control.
      if (!loadingFocusEstablishedRef.current) {
        root.focus();
        loadingFocusEstablishedRef.current = true;
      }
      return;
    }
    loadingFocusEstablishedRef.current = false;

    if (root.ownerDocument.activeElement !== root) {
      keyboardRequestRef.current = false;
      return;
    }
    if (!available) {
      keyboardRequestRef.current = false;
      fallbackFocusRef.current?.focus();
      return;
    }
    if (error) {
      keyboardRequestRef.current = false;
      actionRef.current?.focus();
      return;
    }

    // A successful prepend corrects the virtual-list anchor in the following animation frames.
    // Restore the fallback afterwards so its native focus reveal is not immediately undone. Keep
    // checking ownership because the reader may move to another control while those frames settle.
    const view = root.ownerDocument.defaultView;
    if (!view) return;
    let revealFrame = 0;
    const revealAfterAnchor = (frames: number) => {
      revealFrame = view.requestAnimationFrame(() => {
        if (root.ownerDocument.activeElement !== root) {
          keyboardRequestRef.current = false;
          return;
        }
        if (frames > 1) {
          revealAfterAnchor(frames - 1);
          return;
        }
        keyboardRequestRef.current = false;
        const action = actionRef.current;
        action?.focus();
        action?.scrollIntoView({ block: "nearest" });
      });
    };
    revealAfterAnchor(EARLIER_ACTIVITY_FOCUS_REVEAL_FRAMES);
    return () => {
      if (revealFrame) view.cancelAnimationFrame(revealFrame);
    };
  }, [available, error, fallbackFocusRef, loading]);

  const load = (event: ReactMouseEvent<HTMLButtonElement>) => {
    // Keyboard and assistive-technology activation dispatch a click with no click count. Pointer
    // users keep the browser's normal focus behavior instead of being moved after the request.
    const started = onLoad();
    keyboardRequestRef.current = event.detail === 0 && started;
    loadingFocusEstablishedRef.current = false;
  };

  // Keep the root's DOM identity for the exhaustion commit so focus ownership can be checked
  // before moving it to the stable transcript region. This empty anchor has no layout or a11y
  // surface and remains inert for sessions that opened with no earlier history.
  if (loading) {
    return (
      <div ref={rootRef} className="tl-earlier" data-state="loading" tabIndex={-1} role="group"
        aria-label="Loading Earlier Activity">
        <span className="tl-earlier-content"><Spinner decorative />Loading earlier activity…</span>
      </div>
    );
  }

  if (!available) {
    return <div ref={rootRef} data-earlier-activity-focus-anchor tabIndex={-1} aria-hidden="true" />;
  }

  if (error) {
    return (
      <div ref={rootRef} className="tl-earlier" data-state="error" tabIndex={-1}>
        <Notice compact tone="danger" className="tl-earlier-content"
          actions={<button ref={actionRef} className="btn sm" type="button" onClick={load}>Retry</button>}>
          {error}
        </Notice>
      </div>
    );
  }

  const count = olderCount !== undefined && olderCount > 0 ? olderCount : undefined;
  return (
    <div ref={rootRef} className="tl-earlier" data-state="idle" tabIndex={-1}>
      <button ref={actionRef} className="btn sm ghost tl-earlier-content" type="button" onClick={load}>
        Load Earlier Activity
        {count !== undefined && (
          <>
            <span className="count" aria-hidden="true">{count.toLocaleString("en-US")}</span>
            <span className="sr-only"> ({count.toLocaleString("en-US")} Earlier {count === 1 ? "Event" : "Events"})</span>
          </>
        )}
      </button>
    </div>
  );
}

/** A runner-written fragment ("Install Dependencies exited with 1", "the provider conversation
 * cannot be resumed…") as a sentence of its own: capitalized, with closing punctuation. */
function asSentence(text: string, capitalize = true): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capitalized = capitalize ? trimmed[0]!.toUpperCase() + trimmed.slice(1) : trimmed;
  return /[.!?…]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

/** The runner's bounded, content-free account of the provider's rejection
 * (apps/runner/src/drivers/poisoned-provider-history.ts), from the latest transcript error that
 * carries it, when the loaded history holds one. */
const PROVIDER_HISTORY_REJECTION = "The agent provider rejected this conversation's stored history";
function providerHistoryRejection(items: readonly TimelineItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "error" && item.message.startsWith(PROVIDER_HISTORY_REJECTION)) return item.message;
  }
  return undefined;
}
