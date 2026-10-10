import { browserRandomUUID } from "../browser-crypto.js";
import { State } from "./State.js";
import {
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  Profiler,
  memo,
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
  MAX_PROMPT_IMAGES,
  PROMPT_IMAGE_MIME_TYPES,
  validatePromptImageInputs,
  isPolicyApproval,
  pendingRequests,
  prioritizedPendingRequests,
  isPromptImageReference,
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
  type AgentQuestion,
  type PendingApproval,
  type SessionHoldView,
  type SessionReminderView,
  sessionRole,
  type SessionEvent,
  type SessionView,
  type SourceLocation,
  type WorkspaceReference,
  type WorkspaceReferenceCandidate,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { outstandingSessionResult } from "../session-follow-up.js";
import { SkillsUnavailableNotice, skillsUnavailableSentence, useSessionSkillsUnavailable, useSkillsNoticeDismissal } from "./SkillsUnavailableNotice.js";
import {
  isPartialHistory, isRebuiltEventsArray, sessionEqualIgnoringStreaming, sessionsEqualIgnoringStreaming, useStoreActions,
  useStoreSelector, useStoreSelectorUnlessQuiet, useStoreValueSource,
} from "../store.js";
import { useShowAgentLogs } from "../agent-logs.js";
import { agentLogOnly } from "../work-steps.js";
import { shortenPath, titleCaseLabel } from "../format.js";
import { COMPOSER_USAGE_MIN_COLUMN_REM, composerUsagePlacement, useNarrowerThanRem } from "../composer-usage-placement.js";
import { accountLabelText, isPersonalIdentifier, redactPersonalIdentifiers } from "../personal-identifiers.js";
import { AccountLabel } from "./AccountIdentifier.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import {
  compareSessionNotices,
  SESSION_NOTICE_RANK,
  SessionNoticeSlot,
  type SessionNoticeEntry,
  type SessionNoticeLead,
} from "./SessionNoticeSlot.js";
import { sessionAccountSwitchApplicable, SwitchAccountDialog } from "./SwitchAccountDialog.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SessionPlaceholder } from "./SessionPlaceholder.js";
import { sessionArchiveControlLabel, sessionUnarchiveRestarts } from "../archive-actions.js";
import { unarchiveSession } from "../session-unarchive.js";
import { TranscriptSkeleton, transcriptLoadingSentence } from "./TranscriptSkeleton.js";
import { TranscriptEmptyState, TranscriptHistoryNotice, transcriptEmptyKind } from "./TranscriptReadingStates.js";
import { clearRoutedSessionLookup, setRoutedSessionLookup, useRoutedSessionLookup } from "../routed-session-lookup.js";
import { runnerDisplay } from "../runners.js";
import { MoveToProjectDialog, MoveToWorkspaceDialog, NewWorkspaceDialog } from "./SessionMoveDialogs.js";
import {
  advanceAutomaticAccountSwitchNotice,
  type AutomaticAccountSwitchNoticeState,
  type TimelineItem,
} from "../timeline.js";
import { useTimeline } from "./useTimeline.js";
import { onlyContinuesTrailingText, useLiveTimelineTail } from "./live-timeline-tail.js";
import type { SessionActivity } from "../activity.js";
import {
  Modal,
  Spinner,
} from "./common.js";
import { SessionPreviewBar, type PreviewSessionMenuOpener } from "./SessionPreviewBar.js";
import { Notice } from "./Notice.js";
import { LaterActivityControl } from "./LaterActivityControl.js";
import { QueuedMessages, queuedMessageExcerpt } from "./QueuedMessages.js";
import { sessionArchivedAtRest } from "../status-meta.js";
import {
  EventTimeline,
  TranscriptErrorAlert,
  userRewindTurns,
  type TimelineQuestionContext,
  type TimelineRevealRequest,
  type TurnRetryControl,
} from "./EventTimeline.js";
import { TURN_RETRY_IN_FLIGHT_REASON, turnRetryPlan } from "../turn-retry.js";
import { ConversationHandoffDialog } from "./ConversationHandoffDialog.js";
import { isTimelineSessionActive } from "../timeline-clock.js";
import { RightPanel, type RightPanelState } from "./RightPanel.js";
import { useDiffFileFocus } from "../review-focus.js";
import { useCampaignStatusAvailability } from "./useCampaignStatus.js";
import { useGitStatus, useGitSummary } from "./useGitStatus.js";
import { attachImageDescription, attachmentFileName, attachmentKey, ComposerAttachments, describeAttachmentProblem, modelRefusesImagesSentence, ReadonlyReferenceChip, usePastedImages, type AttachmentProblem } from "./images.js";
import { PromptImageView } from "./PromptImageView.js";
import { WorkspaceReferenceDialog } from "./WorkspaceReferenceDialog.js";
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
import { ApprovalsControl, ComposerButton, ModelEffortControl, useModelSettingsAvailable } from "./ComposerControls.js";
import { reportRenderProbe, SESSION_DETAIL_PROBE, SESSION_VIEW_PROBE, TRANSCRIPT_PROBE } from "./render-probe.js";
import {
  ComposerIdlePreview,
  ComposerTextarea,
  useComposerTextSelector,
  useComposerTextStore,
  type ComposerTextSnapshot,
} from "./ComposerTextInput.js";
import { modelSupportsImages, resolveCaps } from "../caps.js";
import { PinnedSummary } from "./PinnedSummary.js";
import { PinnedSummaryDock } from "./PinnedSummaryDock.js";
import type { PinnedSummaryState } from "./pinned-summary-state.js";
import { deriveGitPresentation } from "../pinned-summary.js";
import { visibleForgeFacts } from "../pinned-summary.js";
import { useVoiceDictation } from "./useVoiceDictation.js";
import { DictationStrip } from "./DictationStrip.js";
import { appendTranscript } from "../dictation.js";
import { loadSeen, markSeen, saveSeen } from "../sessions-seen.js";
import { subscriptionRecoveryRevision } from "../ui-subscriptions.js";
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
  SESSION_EVENT_PAGE_LIMIT,
  loadOlderSessionEvents,
  recoverSessionHistory,
  recoverSessionHistoryGap,
  recoverSessionTurnStartWindow,
  type SessionHistoryRecoveryOptions,
  type SessionHistoryWindowOptions,
  shouldReadOpeningWindow,
} from "../history-recovery.js";
import { routedSessionPlaceholder, shouldHydrateRoutedSession } from "../detail-placeholder.js";
import { composerActionError, type ComposerAction, type ComposerActionError } from "../composer-action-errors.js";
import { transcriptPresentation } from "../transcript-presentation.js";
import { OrchestratorControlsDialog, orchestratorControlsSummary } from "./OrchestratorControlsDialog.js";
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
import {
  editInForkConfirmation,
  editingCopyMessage,
  forkConversationConfirmation,
  recoverSessionConfirmation,
  REPLACE_DRAFT_CONFIRMATION,
  rewindFilesConfirmation,
  type TurnActionConfirmationCopy,
} from "../turn-action-confirmations.js";
import {
  clearComposerEditCopy,
  composerEditCopySending,
  finishComposerEditCopySend,
  forgetComposerEditCopiesForInstance,
  loadComposerEditCopy,
  markComposerEditCopySending,
  saveComposerEditCopy,
  type ComposerEditCopy,
} from "../composer-edit-copy.js";
import { SessionApprovalRegion, focusSessionRequest, useEvidenceDraftRetirement } from "./SessionApproval.js";
import { type DescendantRequestStatus } from "./SessionRequestPanel.js";
import { RequestDock, dockRequests } from "./requests/RequestDock.js";
import { useQuestionWhereAsked, type PendingQuestionRef } from "./requests/where-asked.js";
import { RequestKindIcon, pendingRequestsTitle } from "./requests/request-meta.js";
import { useSoftwareKeyboardOpen } from "./requests/software-keyboard.js";
import { decideDockedRequest, registerRequestRevealer } from "./requests/request-reveal.js";
import { useRemovedFocus } from "./useRemovedFocus.js";
import { CampaignHeldChildren, type CampaignHeldChild } from "./CampaignHeldChildren.js";
import { ComposerQuestionResponse } from "./ComposerQuestionResponse.js";
import { useGovernanceAudit, useGovernanceTimeline } from "./useGovernanceAudit.js";
import {
  indexTranscriptDecisionRows,
  transcriptRowForDecision,
  type GovernanceDecision,
  type TranscriptDecisionIndex,
} from "../governance.js";
import { SessionHeader } from "./SessionHeader.js";
import { useWorktreeSetupSuggestion, WorktreeSetupNotice } from "./WorktreeSetupNotice.js";
import { WorktreeRecoveryCard } from "./WorktreeRecoveryCard.js";
import { useRecoveryWorktreeCreation } from "../recovery-worktree-creation.js";
import { worktreeSetupNoticeSessionIds } from "../worktree-setup-notice.js";
import { useInstanceScope } from "../instance-scope.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
import { Markdown } from "./Markdown.js";
import { ConfirmationFailure, useFeedback, type ConfirmationOptions } from "./FeedbackProvider.js";
import { ContextWindowMeter } from "./ContextWindowMeter.js";
import { resolveContextWindowCapacity } from "../context-window-capacity.js";
import { SessionUsageControl } from "./SessionUsageControl.js";
import { SessionUsageMenuGroup } from "./SessionUsageMenuGroup.js";
import { GuardrailsDialog } from "./GuardrailsDialog.js";
import { guardrailSummary } from "../guardrail-values.js";
import {
  hasSavedFollowTailAnchor,
  isFollowTailResumeKey,
  isFollowTailUpwardReadingKey,
  type FollowTailState,
  useFollowTail,
} from "../useFollowTail.js";
import { useSessionReadingKeys, type SessionReadingKeyActions } from "../useSessionReadingKeys.js";
import { VIRTUAL_VIEWPORT_INTENT_EVENT, virtualViewportIntentDirection } from "../viewport-intent.js";
import { inTypingContext, isMacPlatform, matchesShortcut, shortcutDisplay, shortcutLayerActive } from "../shortcuts.js";
import { useIsCompact, useIsMobile, useIsTouchPhone } from "./useIsMobile.js";
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
import { ArrowUpIcon, AtSignIcon, CheckIcon, ChevronDownIcon, EditIcon, FolderIcon, GuardrailsIcon, ImageIcon, ImageOffIcon, MicIcon, OrchestratorControlsIcon, PlanIcon, PlusIcon, ProjectsIcon, RefreshIcon, StopTurnIcon, WarningIcon } from "./Icons.js";
import {
  durableCommandAttachmentNote,
  buildComposerCommandRegistry,
  composerCommandsForTrigger,
  composerCommandsInPickerOrder,
  composerCommandsIncludeSkills,
  durableCommandPreservesAttachments,
  findComposerCommandTrigger,
  mapProviderComposerCommands,
  rankComposerCommands,
  replaceComposerCommandTrigger,
  resolveComposerCommandInvocation,
  retainActiveComposerCommandId,
  composerRejectsUnknownCommands,
  replaceLeadingCommandToken,
  stepComposerCommandId,
  suggestComposerCommands,
  unlistedCommandNames,
  type ComposerCommand,
  type ComposerCommandTrigger,
  type ComposerCommandResolution,
  type ComposerCommandResolutionOptions,
  type ProviderComposerCommand,
} from "../composer-commands.js";
import { SEND_AS_TEXT_TOOLTIP, SlashCommandMenu, slashCommandOptionId } from "./SlashCommandMenu.js";
import { WorkspaceReferencePicker, workspaceReferenceOptionId } from "./WorkspaceReferencePicker.js";
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
import { sessionReadingTarget } from "../focus-zones.js";

const NO_IMAGE_MIME_TYPES: readonly string[] = [];
/** The side panel tools that show the job inventory a compact session view omits; Session Tools
 * counts its running jobs (#2844). */
const BACKGROUND_INVENTORY_MODES: readonly string[] = ["background", "subagents", "launcher"];
const STOP_TURN_RETRY_MS = 8_000;
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
/** The history notice's details when the cache stopped short because its machine is offline. */
const MACHINE_OFFLINE_HISTORY_ERROR = "Session activity could not finish loading while its machine is offline.";

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

/** React delivers a portal's events through the component tree, so a menu sheet or dialog opened
 * from a transcript row reports its presses, wheels and keys to the reader too. Only input on the
 * reader's own page content moves the follow state (#2526) or reaches for earlier history (#2570). */
function isReaderInput(event: { target: EventTarget; currentTarget: HTMLElement }): boolean {
  return event.currentTarget.contains(event.target as Node);
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
  forgetComposerEditCopiesForInstance(instanceScope);
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
  /** The previewed session these controls fork, so a caller never applies them to another. */
  sessionId: string;
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
  /** The preview's ⋯: opens the Sessions list's context menu for this session (#2210). */
  onSessionMenu?: PreviewSessionMenuOpener;
  /** The preview's Answer in Session: opens the session with this request docked (#2210). */
  onOpenRequest?: (requestId: string) => void;
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

type ComposerDraftContent = { text: string; images: PromptImageInput[] };

/** A turn action's confirmation copy as `confirm()` options, its note as the dim second line. */
function turnActionConfirmation({ note, ...copy }: TurnActionConfirmationCopy): ConfirmationOptions {
  return { ...copy, ...(note ? { details: <p className="confirmation-note">{note}</p> } : {}) };
}

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

/** What a pending prompt's Cancel, Dismiss and Retry are called when they fail. */
const PENDING_PROMPT_ACTIONS = {
  cancel: "cancelMessage", dismiss: "dismissMessage", retry: "retryMessage",
} as const satisfies Record<"cancel" | "dismiss" | "retry", ComposerAction>;

/** A failed fork or recovery as a notice: an uncertain outcome says not to retry, in its own words. */
function forkFailure(
  action: "fork" | "recoverConversation" | "editInFork",
  cause: unknown,
  ambiguous: AmbiguousForkError | null,
  machineName: string | undefined,
): ComposerActionError {
  if (!ambiguous) return composerActionError(action, cause, machineName);
  const { detail } = composerActionError(action, cause);
  return { title: "Fork Outcome Unknown", message: ambiguous.message, ...(detail ? { detail } : {}) };
}

/** What the composer couldn't do, as a notice slot entry (#2156). */
interface ComposerError {
  /** One line, Title Case: the "+N More" menu item. */
  title: string;
  /** Sentence case: what happened and what to do. */
  message: string;
  /** The server's own words, behind Show Details rather than in the sentence (§17.2). */
  detail?: string;
  /** What Retry repeats: a failed send or direct steer, and the exact draft that failed. Retry is
   * offered only while the composer still holds that draft, so it never sends a different one. */
  retry?: ComposerRetry;
}
interface ComposerRetry {
  /** The `AsText` actions repeat a failed Send as Text (#2176), with the text as it stands. */
  action: "send" | "steer" | "sendAsText" | "steerAsText";
  draft: { text: string; images: PromptImageInput[] };
}
/** How `send` and `steerDraft` read the draft: Send as Text skips command resolution. */
interface ComposerSubmitOptions {
  asText?: boolean;
}
/** A slash command the composer refused to send (#2176), shown in the notice slot while the draft
 * it was refused for is unchanged. `action` is what Send as Text repeats. */
interface CommandNotSent {
  problem:
    | { kind: "unknown"; token: string; suggestionId?: string }
    | { kind: "unavailable"; token: string; reason: string };
  action: "send" | "steer";
  text: string;
}
/** A failed send or another composer action, or an attachment that did not land. */
type ComposerErrorSource = "action" | "attachment";
type ComposerErrors = Partial<Record<ComposerErrorSource, ComposerError>>;

/** The composer still holds the draft a Retry would repeat. Attachments are compared by what they
 * carry, since a submission clones each one. */
function composerHoldsDraft(
  current: { text: string; images: readonly PromptImageInput[] },
  draft: ComposerRetry["draft"],
): boolean {
  const identity = (image: PromptImageInput) => isPromptImageReference(image) ? image.artifactId : image.data;
  return current.text === draft.text && current.images.length === draft.images.length &&
    current.images.every((image, index) => identity(image) === identity(draft.images[index]!));
}

/** "Couldn't send your message." with what happened, for a send the server did not accept. A request
 * that never got an answer is the machine not responding; any other refusal keeps the server's
 * reason behind Show Details. Without `retry` the draft was changed while the send was in flight, so
 * there is no kept draft to retry. */
function messageNotSent(cause: unknown, machineName: string | undefined, retry?: ComposerRetry): ComposerError {
  const kept = retry ? " Your draft is kept." : "";
  if (!(cause instanceof ApiError) || cause.status === 502 || cause.status === 503 || cause.status === 504) {
    return {
      title: "Message Not Sent",
      message: `Couldn't send your message. ${machineName ? `${machineName} stopped responding` : "The runner stopped responding"}.${kept}`,
      ...(retry ? { retry } : {}),
    };
  }
  const detail = cause.message.trim();
  return {
    title: "Message Not Sent",
    message: `Couldn't send your message.${kept}`,
    ...(detail ? { detail } : {}),
    ...(retry ? { retry } : {}),
  };
}

export function SessionDetail(props: SessionDetailProps) {
  const api = useApi();
  const { sessionId } = props;
  const { dispatch, loadSession, beginSessionDetailLoad, navigate } = useStoreActions();
  // A paced upsert that moves only streaming fields (live usage, activity time, the message count
  // and the preview) keeps the version this view rendered, so it renders neither the view nor its
  // children four times a second while an agent streams (#2872). The parts that show one of those
  // fields read it through `useLiveSession`.
  const session = useStoreSelector((s) => s.sessions.get(sessionId), sessionEqualIgnoringStreaming);
  const needsDetail = !session || session.projection === "summary" || Boolean(session.archived);
  const detailEpoch = session?.eventEpoch ?? 0;
  const conn = useStoreSelector((s) => s.conn);
  const snapshotRevision = useStoreSelector((s) => s.snapshotRevision);
  const summarySnapshot = useStoreSelector((s) => s.sessionSummarySnapshots);
  const snapshotLoaded = useStoreSelector((s) => s.snapshotLoaded);
  const isMobile = useIsMobile();
  const lastLookupKeyRef = useRef<string | null>(null);
  // The phone top bar titles the page from the same lookup (#2202).
  const sessionLookup = useRoutedSessionLookup(sessionId);
  // Retry reissues the lookup for the same route, snapshot and connection.
  const [lookupAttempt, setLookupAttempt] = useState(0);
  useEffect(() => () => clearRoutedSessionLookup(sessionId), [sessionId]);

  // Revalidate mounted detail once per snapshot generation. Paged reconnects keep the rendered
  // row (and its local UI) while this exact authorized read refreshes omitted detail fields.
  useEffect(() => {
    if (!shouldHydrateRoutedSession(session, snapshotRevision, conn, summarySnapshot)) return;
    const lookupKey = JSON.stringify([sessionId, snapshotRevision, conn, lookupAttempt, detailEpoch]);
    if (lastLookupKeyRef.current === lookupKey) return;
    lastLookupKeyRef.current = lookupKey;
    let current = true;
    let complete = false;
    const detailLoad=beginSessionDetailLoad(sessionId);
    setRoutedSessionLookup({ sessionId, complete: false, error: null });
    void api.session(sessionId)
      .then(({ session: loaded }) => {
        if (!current) return;
        complete = true;
        if (!detailLoad.apply(loaded)) {
          setLookupAttempt((attempt) => attempt+1);
          return;
        }
        setRoutedSessionLookup({ sessionId, complete: true, error: null });
      })
      .catch((cause: unknown) => {
        if (!current) return;
        complete = true;
        if (!detailLoad.isCurrent()) {
          setLookupAttempt((attempt) => attempt+1);
          return;
        }
        const notFound = cause instanceof ApiError && cause.status === 404;
        if (notFound) {
          dispatch({ type: "msg", msg: { type: "session_removed", sessionId } });
        }
        setRoutedSessionLookup({ sessionId, complete: true, error: notFound ? null : (cause as Error).message });
      });
    return () => {
      current = false;
      detailLoad.cancel();
      if (!complete && lastLookupKeyRef.current === lookupKey) lastLookupKeyRef.current = null;
    };
  // Summary pages and live list updates can replace a row during its lookup. They must not cancel
  // that in-flight detail read unless whether the row needs hydration actually changed.
  }, [api, sessionId, needsDetail, detailEpoch, beginSessionDetailLoad, dispatch, conn, snapshotRevision, summarySnapshot, lookupAttempt]);

  if (!session || session.projection === "summary") {
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

// Facts the session view reads from the composer's draft in render (#2764). Module-level, so the
// selector keeps its identity and a keystroke that leaves the fact unchanged renders nothing here.
const composerHoldsText = ({ text }: ComposerTextSnapshot) => text !== "";
const composerHoldsMessage = ({ text }: ComposerTextSnapshot) => text.trim() !== "";
const composerHoldsLineBreak = ({ text }: ComposerTextSnapshot) => /[\r\n]/u.test(text);

interface ComposerTriggers {
  slashTrigger: ComposerCommandTrigger | null;
  /** The draft and caret an open slash token is dismissed for; null with no token. */
  slashDismissKey: string | null;
  workspaceTrigger: { start: number; query: string } | null;
  workspaceDismissKey: string | null;
}

/** The slash and @ tokens under a collapsed caret, and the keys that dismissing either is bound to. */
function composerTriggersAt(
  { text, selection }: ComposerTextSnapshot,
  skillSigil: boolean,
  workspaceReferencesSupported: boolean,
): ComposerTriggers {
  const collapsed = selection.start === selection.end;
  const slashTrigger = collapsed ? findComposerCommandTrigger(text, selection.start, { skillSigil }) : null;
  const workspaceTrigger = workspaceReferencesSupported && collapsed
    ? findWorkspaceReferenceTrigger(text, selection.start)
    : null;
  const dismissKey = `${text}\u0000${selection.start}`;
  return {
    slashTrigger,
    slashDismissKey: slashTrigger ? dismissKey : null,
    workspaceTrigger,
    workspaceDismissKey: workspaceTrigger ? dismissKey : null,
  };
}

function sameComposerTriggers(left: ComposerTriggers, right: ComposerTriggers): boolean {
  const slash = left.slashTrigger === right.slashTrigger || (
    left.slashTrigger !== null && right.slashTrigger !== null &&
    left.slashTrigger.start === right.slashTrigger.start && left.slashTrigger.end === right.slashTrigger.end &&
    left.slashTrigger.query === right.slashTrigger.query && left.slashTrigger.raw === right.slashTrigger.raw &&
    left.slashTrigger.sigil === right.slashTrigger.sigil
  );
  const workspace = left.workspaceTrigger === right.workspaceTrigger || (
    left.workspaceTrigger !== null && right.workspaceTrigger !== null &&
    left.workspaceTrigger.start === right.workspaceTrigger.start &&
    left.workspaceTrigger.query === right.workspaceTrigger.query
  );
  return slash && workspace && left.slashDismissKey === right.slashDismissKey &&
    left.workspaceDismissKey === right.workspaceDismissKey;
}

/**
 * The transcript behind the timeline's own props compare, with the render probe inside that
 * boundary, so the probe counts the timeline's renders rather than its parent's (#2764). It also
 * shows the chunks streamed into the trailing reply since `items` was derived from
 * `itemsDerivedFrom`, which render the transcript without the session view around it (#2763).
 */
const ProfiledEventTimeline = memo(function ProfiledEventTimeline({ liveSessionId, itemsDerivedFrom, items, ...props }:
  ComponentProps<typeof EventTimeline> & { liveSessionId: string; itemsDerivedFrom: SessionEvent[] | undefined }) {
  const liveItems = useLiveTimelineTail(liveSessionId, itemsDerivedFrom, items);
  return (
    <Profiler id={TRANSCRIPT_PROBE} onRender={reportRenderProbe}>
      <EventTimeline {...props} items={liveItems} />
    </Profiler>
  );
});

/** The history notice, counting the loaded events and the session's messages itself: a chunk that
 * only lengthens the reply (#2763), and a paced upsert that only moves the count (#2872), do not
 * render the session view around it. */
function LiveTranscriptHistoryNotice({ sessionId, ...props }:
  Omit<ComponentProps<typeof TranscriptHistoryNotice>, "loaded" | "total"> & { sessionId: string }) {
  const loaded = useStoreSelector((state) => state.events.get(sessionId)?.length ?? 0);
  const messageCount = useStoreSelector((state) => state.sessions.get(sessionId)?.messageCount ?? 0);
  return <TranscriptHistoryNotice {...props} loaded={loaded} total={messageCount > 0 ? messageCount : undefined} />;
}

/** The opening skeleton, saying how many messages are coming as the count moves (#2872). */
function LiveTranscriptSkeleton({ sessionId }: { sessionId: string }) {
  const messageCount = useStoreSelector((state) => state.sessions.get(sessionId)?.messageCount ?? 0);
  return <TranscriptSkeleton sentence={transcriptLoadingSentence(messageCount)} />;
}

/** Heartbeats within one busy period of one history: the same for everything but the transcript. */
function sameActivityPeriod(previous: SessionActivity | undefined, next: SessionActivity | undefined): boolean {
  return previous !== undefined && next !== undefined && previous.eventEpoch === next.eventEpoch &&
    previous.busySince === next.busySince;
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
  onSessionMenu,
  onOpenRequest,
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
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // False once this view has been left, so a late callback cannot reach the shell's shared state.
  const detailMountedRef = useRef(true);
  useEffect(() => {
    detailMountedRef.current = true;
    return () => { detailMountedRef.current = false; };
  }, []);
  const isCompact = useIsCompact();
  const isCompactRef = useRef(isCompact);
  isCompactRef.current = isCompact;
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
    loadTurnStartWindow,
    loadOlderEvents,
    beginOlderEventsLoad,
    failOlderEventsLoad,
    eventWindowBase,
    loadSession,
    getSession,
    navigate,
    recoveryReadAfter,
    beginEventHistoryLoad,
    failEventHistoryLoad,
    isEventGapRecoveryCurrent,
    beginEventGapRecovery,
    cancelEventGapRecovery,
    finishEventGapRecovery,
    loadEventGapWindow,
    deferEventTail,
    beginLaterEventsLoad,
    loadLaterEvents,
    failLaterEventsLoad,
    promoteDeferredEventTail,
  } = useStoreActions();
  const openSourceLocation = useCallback((location: SourceLocation) => {
    navigate({ name: "session", id: sessionId, location });
  }, [navigate, sessionId]);
  const clearSourceLocation = useCallback(() => {
    navigate({ name: "session", id: sessionId });
  }, [navigate, sessionId]);
  // A transcript edit's Open in Review (#2187): the Review tab, scrolled to that file once.
  const { focus: reviewFocus, request: requestReviewFocus, clear: clearReviewFocus } = useDiffFileFocus();
  const openInReview = useCallback((path: string) => {
    requestReviewFocus(path);
    rightPanel.show("review");
  }, [requestReviewFocus, rightPanel]);
  const openSession = useCallback((id: string) => navigate({ name: "session", id }), [navigate]);
  const recoveryEventEpoch = useStoreSelector((s) => s.sessions.get(sessionId)?.eventEpoch ?? 0);
  const currentTurnOpeningSupported = useStoreSelector((s) => s.currentTurnOpeningSupported);
  const recoveryGeneration = useStoreSelector((s) => s.snapshotRevision);
  // A chunk that only lengthens the trailing reply renders the transcript alone (`ProfiledEventTimeline`
  // folds it in); this view reads it the next time it renders for anything else (#2763).
  const evs = useStoreSelectorUnlessQuiet((s) => s.events.get(sessionId), onlyContinuesTrailingText);
  // Read inside the recovery effect without becoming one of its dependencies: that effect must run
  // once per open, not once per streamed event.
  const evsRef = useRef(evs);
  evsRef.current = evs;
  const olderInFlightRef = useRef(false);
  const eventHistory = useStoreSelector((s) => {
    const history = s.eventHistory.get(sessionId);
    return history?.eventEpoch === (s.sessions.get(sessionId)?.eventEpoch ?? 0) ? history : undefined;
  });
  const eventWindow = useStoreSelector((s) => {
    const window = s.eventWindows.get(sessionId);
    return window?.eventEpoch === (s.sessions.get(sessionId)?.eventEpoch ?? 0) ? window : undefined;
  });
  const runner = useStoreSelector((s) => s.runners.get(session.runnerId));
  const showAgentLogs = useShowAgentLogs();
  // Which session first used each project's worktree reads no streaming field (#2872).
  const allSessions = useStoreSelector((s) => s.sessions, sessionsEqualIgnoringStreaming);
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
  // Routed REST metadata can mount this reader before socket capabilities arrive. Try the
  // additive opening read while capability is unknown; an old server uses the existing fallback.
  const turnStartOpeningAvailable = currentTurnOpeningSupported || !snapshotLoaded;
  const stopBeforeArchiveSupported = useStoreSelector((s) => s.stopBeforeArchiveSupported);
  const sessionRoleConversionSupported = useStoreSelector((s) => s.sessionRoleConversionSupported);
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
  // The session's own requests, questions included, answered on the request dock above the
  // composer (#2179, #2205), in attention priority order; a worker's stay in the Agents panel.
  const prioritizedRequests = useMemo(() => prioritizedPendingRequests(session.pendingApproval),
    [session.pendingApproval]);
  const dockedRequests = useMemo(() => dockRequests(prioritizedRequests), [prioritizedRequests]);
  const topRequestDocked = prioritizedRequests[0] !== undefined && dockedRequests.includes(prioritizedRequests[0]);
  useEvidenceDraftRetirement(session.id, dockedRequests);
  const chatReadingRef = useRef<HTMLDivElement>(null);
  const detailChatRef = useRef<HTMLDivElement>(null);
  const softwareKeyboardOpen = useSoftwareKeyboardOpen();
  const [selectedRequestKey, setSelectedRequestKey] = useState<string | null>(null);
  // The bar's one child-request status counts what waits for the person (#2206); the Orchestrator's
  // share is counted inside the Requests panel.
  const humanDescendantRequests = useMemo(
    () => descendantRequests.filter((request) => request.responseOwner === "human").length,
    [descendantRequests],
  );
  // Opened from the bar, the Requests panel starts at its list; with nothing pending it says so.
  const openChildRequests = useCallback(() => {
    setSelectedRequestKey(null);
    rightPanel.show("requests");
  }, [rightPanel]);
  const anchorRecoveryPending = eventHistory?.refreshing === true ||
    (conn === "online" && eventHistory?.everComplete !== true && eventHistory?.error == null && !eventWindow?.laterGap);
  const recoveryRevision = useStoreSelector((s) =>
    subscriptionRecoveryRevision(s.streamSubscriptions, [sessionId]));
  // Every event moves the heartbeat; only a new busy period or history is worth a render of its own.
  const activity = useStoreSelectorUnlessQuiet((s) => s.activity.get(sessionId), sameActivityPeriod);
  // The draft lives outside this component's state, so typing renders the composer alone (#2764).
  const composerText = useComposerTextStore();
  const composerHasText = useComposerTextSelector(composerText, composerHoldsText);
  const composerHasMessage = useComposerTextSelector(composerText, composerHoldsMessage);
  const composerMultiline = useComposerTextSelector(composerText, composerHoldsLineBreak);
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
          clearComposerErrors();
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
  // What the composer couldn't do, as notice slot entries (§13.2; #2156): one per source, so a failed
  // send and an attachment that did not land can both wait in the slot. Each clears on its own
  // Dismiss, and every one clears when the draft changes or the next send is accepted.
  const [composerErrors, setComposerErrors] = useState<ComposerErrors>({});
  const showComposerError = useCallback((source: ComposerErrorSource, next: ComposerError | null) => {
    // An expanded side panel hides the notice slot with the chat column (#2845). What an action could
    // not do is never left unseen: its failure restores the panel. Clearing one leaves the panel be.
    // Read through refs, since callers can hold an older copy of this callback: a Sessions preview
    // shares the panel's state but never shows the panel, and a view that has been left (a late
    // failure after navigating away) must not change the panel of the session now shown.
    const panel = rightPanelRef.current;
    if (next && detailMountedRef.current && modeRef.current === "expanded" && !isMobileRef.current &&
        panel.open && panel.expanded) panel.setExpanded(false);
    setComposerErrors((current) => {
      if (next) return { ...current, [source]: next };
      if (!current[source]) return current;
      const { [source]: _cleared, ...rest } = current;
      return rest;
    });
  }, []);
  const clearComposerErrors = useCallback(() => {
    setComposerErrors((current) => Object.keys(current).length ? {} : current);
  }, []);
  // What a composer error's Retry repeats, assigned once `send` and `steerDraft` exist below.
  const composerRetryRef = useRef<Record<ComposerRetry["action"], () => Promise<void>> | null>(null);
  /** A composer action's error, in one sentence that says what to do; null clears it. */
  const setError = useCallback((message: string | null, title = "Action Failed") => {
    showComposerError("action", message === null ? null : { title, message });
  }, [showComposerError]);
  // The session's machine, named when it is why an action failed; assigned once it is known below.
  const actionMachineNameRef = useRef<string | undefined>(undefined);
  /** A composer action the server refused (#2511): its own title and sentence, and the server's words
   * behind Show Details. */
  const showActionError = useCallback((action: ComposerAction, cause: unknown) => {
    showComposerError("action", composerActionError(action, cause, actionMachineNameRef.current));
  }, [showComposerError]);
  // Edit as a New Turn's copy in the composer and the draft it replaced (#2185), kept per session
  // with the draft so leaving the session or reloading does not lose Discard Edit.
  const [editCopy, setEditCopyState] = useState<ComposerEditCopy | null>(() =>
    loadComposerEditCopy(sessionId, instanceScope));
  const editCopyRef = useRef(editCopy);
  editCopyRef.current = editCopy;
  const updateEditCopy = useCallback((next: ComposerEditCopy | null) => {
    editCopyRef.current = next;
    setEditCopyState(next);
    if (next) saveComposerEditCopy(sessionId, next, instanceScope);
    else clearComposerEditCopy(sessionId, instanceScope);
  }, [instanceScope, sessionId]);
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
  const openingReadScope = useRef({});
  const turnStartReadKeyRef = useRef<string | null>(null);
  const openingReadKey = `${instanceScope}:${sessionId}:${recoveryEventEpoch}:${recoveryGeneration}:${historyRetry}`;
  const [unsupportedOpeningKey, setUnsupportedOpeningKey] = useState<string | null>(null);
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
    /** Each reader finger, keyed by its touch or pointer identity, with the listeners awaiting its end. */
    heldTouches: new Map<string, () => void>(),
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
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
  // The close match the arrow keys reached under an unknown command, for the token it was reached
  // under; none is active until then, so Enter can't guess (#2176).
  const [activeCloseMatch, setActiveCloseMatch] = useState<{ token: string; id: string } | null>(null);
  const [commandNotSent, setCommandNotSent] = useState<CommandNotSent | null>(null);
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
  // Files dragged over the card (#2156): the images a drop would attach, counted from the drag's
  // items, or null when nothing is being dragged over it.
  const [dropImageCount, setDropImageCount] = useState<number | null>(null);
  const dragActive = dropImageCount !== null;
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
  // While a question is answered in the composer it is shown there alone, not on the dock (#2212):
  // bringing it up opens the answer panel and focuses its field. Registered with the shared request
  // revealer, so every control that brings a request up (Jump to Question, an attention link, the
  // Agents and campaign panels) reaches it as it reaches the dock.
  const answerRevealRef = useRef<((requestId: string) => boolean) | null>(null);
  useEffect(() => registerRequestRevealer(session.id, (requestId) => answerRevealRef.current?.(requestId) === true),
    [session.id]);
  const retitleReceiptRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef(rightPanel);
  rightPanelRef.current = rightPanel;
  /**
   * An expanded side panel hides the chat column (#2845). An action whose result shows there (a
   * draft, a reference chip, a request, a transcript row) restores the panel first, and commits it
   * at once, so focus that follows in the same gesture lands on something visible. Phones have no
   * Expand. Returns whether it restored.
   */
  const restoreExpandedPanel = useCallback(() => {
    const panel = rightPanelRef.current;
    if (isMobile || !panel.open || !panel.expanded) return false;
    flushSync(() => panel.setExpanded(false));
    return true;
  }, [isMobile]);
  // Resolve attention only against this generation's known requests. Cold links stay on the
  // transcript while hydration catches up; they never guess an Agents overview first.
  const handledAttentionRef = useRef<string | null>(null);
  const preparedAttentionRef = useRef<string | null>(null);
  const closeRequestOverlay = useCallback(() => {
    const panel = rightPanelRef.current;
    if (!panel.open) return;
    // Requests also overlays the transcript in the compact desktop tier (#2206).
    if (isMobileRef.current || panel.mode === "subagents" ||
        (isCompactRef.current && panel.mode === "requests")) panel.close();
    // An expanded panel fills the chat column's place (#2845): it restores, keeping its tool.
    else if (panel.expanded) panel.setExpanded(false);
  }, []);
  const attentionRequest = attentionTarget && attentionTarget.eventEpoch === (session.eventEpoch ?? 0)
    ? attentionTarget.requestId === undefined ? prioritizedRequests[0]
      : prioritizedRequests.find((request) => request.requestId === attentionTarget.requestId)
    : undefined;
  const resolvedAttentionTarget = attentionTarget && attentionRequest
    ? { ...attentionTarget, requestId: attentionRequest.requestId } : attentionTarget;
  useLayoutEffect(() => {
    if (mode !== "expanded" || !attentionTarget || !attentionRequest) return;
    const requestId = attentionRequest.requestId;
    const key = JSON.stringify([session.id, attentionTarget.eventEpoch, attentionTarget.requestId, attentionTarget.activationId ?? 0]);
    if (handledAttentionRef.current === key) return;
    if (attentionRequest.ownerToolUseId) {
      handledAttentionRef.current = key;
      rightPanelRef.current.show("subagents");
      return;
    }
    // Close an obstructing panel before paint, then let the mounted dock reveal the exact card.
    if (preparedAttentionRef.current !== key) {
      preparedAttentionRef.current = key;
      closeRequestOverlay();
    }
    // After the dock has mounted; a re-render before the frame reschedules it.
    const frame = window.requestAnimationFrame(() => {
      if (!focusSessionRequest(session.id, requestId)) return;
      handledAttentionRef.current = key;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mode, attentionTarget, attentionRequest, session.id, closeRequestOverlay]);
  const backgroundInventoryRequestRef = useRef<{ key: string } | null>(null);
  useEffect(() => () => { backgroundInventoryRequestRef.current = null; }, []);
  const [backgroundInventoryError, setBackgroundInventoryError] = useState<string | null>(null);
  const [backgroundInventoryAttempt, setBackgroundInventoryAttempt] = useState(0);
  const retryBackgroundInventory = useCallback(() => {
    backgroundInventoryRequestRef.current = null;
    setBackgroundInventoryError(null);
    setBackgroundInventoryAttempt((attempt) => attempt + 1);
  }, []);
  useEffect(() => {
    if (mode !== "expanded" || !rightPanel.open || !BACKGROUND_INVENTORY_MODES.includes(rightPanel.mode) ||
        session.backgroundJobsAvailable !== true || session.backgroundJobs !== undefined) {
      if (session.backgroundJobs !== undefined || mode !== "expanded" ||
          !rightPanel.open || !BACKGROUND_INVENTORY_MODES.includes(rightPanel.mode)) {
        backgroundInventoryRequestRef.current = null;
        setBackgroundInventoryError(null);
      }
      return;
    }
    const requestKey = `${session.id}:${recoveryGeneration}`;
    if (backgroundInventoryRequestRef.current?.key === requestKey) return;
    // The load belongs to this request, not to this run of the effect: moving between the tools that
    // show the inventory (Session Tools to Background Work, #2844) re-runs the effect for the same
    // request, which must not discard the answer. Leaving them, another session or recovery
    // generation, Retry and unmounting all drop the request, and a later one is a new request even
    // under the same key, so a late answer never replaces fresher session data.
    const request = { key: requestKey };
    backgroundInventoryRequestRef.current = request;
    setBackgroundInventoryError(null);
    const current = () => backgroundInventoryRequestRef.current === request;
    void api.session(session.id)
      .then(({ session: loaded }) => {
        if (current()) loadSession(loaded);
      })
      .catch((cause: unknown) => {
        if (current()) setBackgroundInventoryError((cause as Error).message);
      });
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

  // Runs after each commit that can make a pending restore possible: an expansion, a session, or a
  // changed draft (through the textarea's `onTextCommitted`, since the draft is not state here).
  const restorePendingComposerFocusRef = useRef(() => {});
  restorePendingComposerFocusRef.current = () => {
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
  };
  useLayoutEffect(() => {
    restorePendingComposerFocusRef.current();
  }, [composerExpanded, isMobile, sessionId]);

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
    setEditCopyState(loadComposerEditCopy(sessionId, instanceScope));
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
    // The reading pane: the transcript, or the switcher of a side panel expanded over it (#2845).
    const frame = window.requestAnimationFrame(() => {
      const row = scrollRef.current?.closest(".detail-columns");
      (row ? sessionReadingTarget(row) : scrollRef.current)?.focus();
    });
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
  // The model a "can't read images" sentence names: the one Model Settings shows.
  const selectedModelName = (effectiveModel
    ? sessionCaps?.models.find((model) => model.id === effectiveModel)?.displayName ?? effectiveModel
    : sessionCaps?.models.find((model) => model.default && !model.hidden)?.displayName) ?? null;
  const modelRefusesImages = modelRefusesImagesSentence(selectedModelName);
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
  const imagesRefused = allowedImageMimeTypes.length === 0;
  const markDraftDirty = useCallback(() => {
    draftDirty.current = true;
    commandSubmissionRetryRef.current = null;
    composerInteractionVersionRef.current += 1;
    composerDraftVersionRef.current += 1;
    invalidateComposerMutationRecovery(mutationKey);
    clearComposerErrors();
  }, [clearComposerErrors, mutationKey]);
  const reportAttachmentProblem = useCallback((problem: AttachmentProblem) => {
    showComposerError("attachment", describeAttachmentProblem(problem));
  }, [showComposerError]);
  const { images, onPaste, addFiles, addWorkspaceReference, remove, clear, replace } = usePastedImages(
    markDraftDirty,
    reportAttachmentProblem,
    allowedImageMimeTypes,
    selectedModelName,
  );
  const actualImages = images.filter((attachment) => !isWorkspaceReference(attachment));
  // Attached images that couldn't be shown (#2177). Each stays a notice slot entry until it is removed:
  // it is still sent, so the entry is about the attachment rather than an outcome a draft change clears.
  const [brokenImages, setBrokenImages] = useState<ReadonlySet<PromptImageInput>>(() => new Set());
  const reportBrokenImage = useCallback((image: PromptImageInput) => {
    setBrokenImages((current) => current.has(image) ? current : new Set(current).add(image));
  }, []);
  useEffect(() => {
    setBrokenImages((current) => [...current].every((image) => images.includes(image))
      ? current
      : new Set([...current].filter((image) => images.includes(image))));
  }, [images]);
  const draftState = useRef<{ text: string; images: PromptImageInput[] }>({ text: "", images: [] });
  draftState.current = { text: composerText.text, images };
  const setText = useCallback((next: string) => {
    draftState.current = { ...draftState.current, text: next };
    composerText.setText(next);
  }, [composerText]);
  const updateComposerSelection = useCallback((start: number, end = start) => {
    composerText.setSelection(start, end);
  }, [composerText]);
  const setProgrammaticComposerText = useCallback((
    next: string,
    caret = next.length,
    preservePendingFocusRestore = false,
    /** Loading the stored draft into the composer replaces nothing the person wrote, so a failure
     * raised while it loaded (a Stop Turn that failed) stays. */
    hydration = false,
  ) => {
    if (!preservePendingFocusRestore) pendingComposerFocusRestoreRef.current = null;
    draftState.current = { ...draftState.current, text: next };
    setText(next);
    updateComposerSelection(caret);
    setSlashDismissedFor(`${next}\u0000${caret}`);
    // Every replaced draft (a queued edit, Edit as a New Turn, a slash command, history recall) is
    // a new message, so the composer's notices about the old one go with it. A caller that has a
    // notice for the new draft sets it afterwards.
    if (!hydration) clearComposerErrors();
  }, [clearComposerErrors, setText, updateComposerSelection]);
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
  // The queued-edit Save attempt this composer watched in flight, kept until that recovery ends: its
  // failure is this view's own action error, while an outcome restored from storage the strip says
  // alone (#2560). It outlives the settlement, which may come before the recovery scope can load it,
  // and names the attempt, so another tab's recovery for the same message is not taken for it.
  const queuedEditSaveWatchedRef = useRef<{ key: string; submissionId: string } | null>(null);
  const queuedEditSaveInFlight = queuedPromptEditMutationRecovery(activeComposerMutation)?.edit.submissionId;
  if (queuedEditSaveInFlight) {
    queuedEditSaveWatchedRef.current = { key: mutationKey, submissionId: queuedEditSaveInFlight };
  }
  const clearQueuedPromptEditRecovery = useCallback((key: string): void => {
    queuedEditSaveWatchedRef.current = null;
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
    // The Recovered Queued Message strip says what happened. Only a Save this view watched fail is
    // also a notice, with the reason it failed; a stored outcome would repeat the strip (#2560).
    const watched = queuedEditSaveWatchedRef.current;
    const saveFailedHere = !pending && watched?.key === mutationKey &&
      watched.submissionId === restored.edit.submissionId;
    setError(saveFailedHere ? restored.error ?? null : null);
    commandSubmissionRetryRef.current = null;
    suppressedDraftRef.current = pending ? { sessionId } : null;
    draftHydratedSessionRef.current = sessionId;
    pendingHydrationCaretRef.current = null;
    pendingComposerFocusRestoreRef.current = null;
  }, [mutationKey, replace, sessionId, setProgrammaticComposerText]);
  // Tap-or-hold dictation (browser SpeechRecognition; hidden when unsupported, #2193).
  const dictation = useVoiceDictation((phrase) => {
    revealOrdinaryComposerRef.current("always");
    markDraftDirty();
    const next = appendTranscript(draftState.current.text, phrase);
    setProgrammaticComposerText(next);
  });
  // Side Chat's Insert into Draft, with Undo putting back the draft exactly as it was (#2862). Undo
  // writes only into the session the reply went into, while it is still the one on screen; anywhere
  // else it fails visibly rather than overwrite another session's draft.
  const sideChatUndoTargetRef = useRef<string | null>(sessionId);
  useEffect(() => {
    sideChatUndoTargetRef.current = sessionId;
    return () => { sideChatUndoTargetRef.current = null; };
  }, [sessionId]);
  const insertSideChatDraft = useCallback((response: string) => {
    restoreExpandedPanel();
    revealOrdinaryComposerRef.current("always");
    markDraftDirty();
    // The whole draft, attachments included: Undo gives back exactly this.
    const previous = draftState.current;
    setProgrammaticComposerText(appendTranscript(previous.text, response));
    const target = sessionId;
    showUndo("Inserted into your session draft.", () => {
      if (sideChatUndoTargetRef.current !== target) throw new Error("This session's draft is no longer open.");
      restoreExpandedPanel();
      revealOrdinaryComposerRef.current("always");
      markDraftDirty();
      setProgrammaticComposerText(previous.text);
      replace(previous.images);
    });
  }, [markDraftDirty, replace, restoreExpandedPanel, sessionId, setProgrammaticComposerText, showUndo]);
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
  // Review's pull request row (#2846) reads the same forge facts as the Pinned Summary, hidden by the
  // same current-repository decision.
  const reviewForgeFacts = useMemo(() => visibleForgeFacts(
    gitSummary.summary,
    git.status?.remoteUrl,
    !richGitSupported || gitPresentation.state !== "not_repository",
  ), [git.status?.remoteUrl, gitPresentation.state, gitSummary.summary, richGitSupported]);

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
        setProgrammaticComposerText(draft.text, draft.text.length, true, true);
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
    // With the recovery scope known, no recovery means the watched Save left none to explain.
    if (queuedEditRecoveryScope) queuedEditSaveWatchedRef.current = null;
    if (suppressedDraftRef.current?.sessionId !== sessionId) return;
    const completedQueuedEdit = queuedEditRef.current !== null;
    if (completedQueuedEdit) {
      draftDirty.current = false;
      queuedEditRef.current = null;
      setQueuedEdit(null);
      setQueuedEditRecovered(false);
      setQueuedEditBusy(false);
      clearComposerErrors();
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
      setProgrammaticComposerText(restored.text, restored.text.length, false, true);
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
  // captured state when the user navigates away before the timer fires. The draft's text is not state
  // here, so its changes restart the timer through a store subscription (#2764).
  useEffect(() => {
    let timer: number | undefined;
    // A store notification arrives inside the change, before the caller may have finished marking
    // the draft dirty or clean (a send clears the text and then the flag), so whether to save is
    // decided when the timer fires, where the effect used to decide it after the commit.
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 400);
    };
    const save = () => {
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
    };
    if (draftDirty.current) schedule();
    let lastText = composerText.text;
    const unsubscribe = composerText.subscribe(() => {
      if (composerText.text === lastText) return;
      lastText = composerText.text;
      schedule();
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [composerText, images, instanceScope, mutationKey, persistQueuedPromptEditRecovery, queuedEditRecoveryScope,
    sessionId, storeQueuedPromptEditRecovery]);

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

  // A newly opened conversation can already exist in the REST API while the UI socket is
  // connecting or its stream acknowledgement is missing. Read one bounded opening window and
  // refresh the creation-time row independently; neither requires live stream admission.
  // Revision -1 keeps this provisional read from advancing the frozen reconnect cursor.
  // Completion is read at a subscription transition, rather than restarting this effect when
  // a history response completes and cancelling its independent Starting metadata timer.
  const completedOpeningRef = useRef(false);
  completedOpeningRef.current = eventHistory?.everComplete === true &&
    eventHistory.refreshing === false && eventHistory.error === null;
  // The control plane fills its history cache from the session's machine, so an incomplete cache
  // stays incomplete while that machine is offline; reading it again only holds the skeleton (#2773).
  // Read at each answer, so a machine that reconnects mid-read keeps filling it.
  const machineOfflineRef = useRef(false);
  machineOfflineRef.current = runner?.status === "offline";
  const cacheCannotFill = useCallback(() => machineOfflineRef.current, []);
  // Once the machine reconnects it can fill the cache again, so a history that stopped short reads
  // again rather than waiting for Retry.
  const historyFailedRef = useRef(false);
  historyFailedRef.current = eventHistory?.error != null;
  const priorRunnerStatusRef = useRef(runner?.status);
  useEffect(() => {
    const prior = priorRunnerStatusRef.current;
    priorRunnerStatusRef.current = runner?.status;
    if (prior === "offline" && runner?.status === "online" && historyFailedRef.current) {
      setHistoryRetry((value) => value + 1);
    }
  }, [runner?.status]);
  const acknowledgedOpeningRef = useRef<{
    api: typeof api; instanceScope: string; sessionId: string; eventEpoch: number; generation: number;
  } | null>(null);
  const provisionalFollowStateRef = useRef<((state: FollowTailState) => void) | null>(null);
  useEffect(() => {
    // Busy sessions elsewhere replace the fleet subscription while this detail remains live.
    // Once this mounted opening has settled successfully after acknowledgement, wait for its
    // ordinary forward gap recovery instead of reading metadata and a new tail on every fleet change.
    // A real outage clears the receipt so a missing reconnect acknowledgement can use REST again.
    const acknowledged = acknowledgedOpeningRef.current;
    const sameOpening = acknowledged?.api === api && acknowledged.instanceScope === instanceScope &&
      acknowledged.sessionId === sessionId && acknowledged.eventEpoch === recoveryEventEpoch &&
      acknowledged.generation === recoveryGeneration;
    if (conn !== "online" || !sameOpening) acknowledgedOpeningRef.current = null;
    if (conn === "online" && recoveryRevision != null) {
      acknowledgedOpeningRef.current = {
        api, instanceScope, sessionId, eventEpoch: recoveryEventEpoch, generation: recoveryGeneration,
      };
      return;
    }
    if (conn === "unauthorized" || (conn === "online" && completedOpeningRef.current && sameOpening)) return;
    let cancelled = false;
    const epoch = recoveryEventEpoch;
    const generation = recoveryGeneration;
    const revision = -1;
    // Metadata cannot hold up the transcript. A creation-time Starting row can precede provider
    // readiness, so recheck only that state every two seconds, at most five more times. An
    // acknowledgement, navigation, epoch change or connection phase cancels the whole operation.
    let metadataRetryTimer: number | undefined;
    let metadataAttempts = 0;
    const refreshMetadata = () => {
      const requestedRow = getSession(sessionId);
      if (cancelled || !requestedRow || (metadataAttempts > 0 && requestedRow.status !== "starting")) return;
      metadataAttempts++;
      void api.session(sessionId).then(({ session: refreshed }) => {
        if (cancelled || refreshed.id !== sessionId) return;
        const latest = getSession(sessionId);
        if (!latest) return;
        // A same-millisecond live upsert still owns its newer row identity. Do not let an older
        // in-flight HTTP response replace it merely because the timestamps happen to match.
        if (refreshed.updatedAt >= latest.updatedAt &&
            (latest === requestedRow || refreshed.updatedAt > latest.updatedAt) &&
            (refreshed.eventEpoch ?? 0) >= (latest.eventEpoch ?? 0)) {
          loadSession(refreshed);
        }
        if (refreshed.status === "starting" && latest.status === "starting" && metadataAttempts <= 5) {
          metadataRetryTimer = window.setTimeout(refreshMetadata, 2_000);
        }
      }).catch(() => { /* Preserve the latest row; the transcript reports its REST failure below. */ });
    };
    refreshMetadata();
    // Follow transitions only retry this owner's history read; they cannot restart metadata.
    // Keep one live read even if pause/resume happens before its HTTP response has settled.
    let historyInFlight = false;
    let historyRetryNeeded = true;
    let following = !hasSavedFollowTailAnchor(instanceScope, sessionId);
    const readHistory = () => {
      if (cancelled || historyInFlight || !historyRetryNeeded || !following ||
          hasSavedFollowTailAnchor(instanceScope, sessionId)) return;
      historyInFlight = true;
      historyRetryNeeded = false;
      let skippedForPause = false;
      const canApply = () => {
        if (cancelled) return false;
        if (hasSavedFollowTailAnchor(instanceScope, sessionId)) {
          skippedForPause = true;
          return false;
        }
        return true;
      };
      beginEventHistoryLoad(sessionId, epoch, revision, generation);
      if (turnStartOpeningAvailable) turnStartReadKeyRef.current = openingReadKey;
      void recoverSessionTurnStartWindow(
        { sessionId, eventEpoch: epoch, recoveryRevision: revision },
        {
          scope: openingReadScope.current,
          readKey: openingReadKey,
          fetchOpening: turnStartOpeningAvailable ? api.getSessionTurnStartPage : undefined,
          onUnsupported: () => { if (!cancelled) setUnsupportedOpeningKey(openingReadKey); },
          applyOpening: (page) => canApply() && loadTurnStartWindow(sessionId, page, revision, generation),
          fetchTailPage: api.getSessionEventTailPage,
          applyWindow: (id, events, pageEpoch, pageRevision, complete, hasOlder, turnAligned) => {
            // A warm reader can pause while this GET is pending. Its saved row and offset own
            // the window at the response boundary, just as they do during acknowledged recovery.
            if (canApply()) {
              loadEvents(id, events, pageEpoch, pageRevision, complete, generation, hasOlder, turnAligned);
            }
          },
          isCurrent: canApply,
          cacheCannotFill,
        },
      ).then((result) => {
        if (cancelled) return;
        if (skippedForPause) {
          historyRetryNeeded = true;
          return;
        }
        if (!result.complete) {
          if (!canApply()) {
            historyRetryNeeded = true;
            return;
          }
          // Unsupported backward reads wait for ordinary acknowledged recovery. Do not start an
          // unbounded forward walk here and recreate the slow opening path.
          failEventHistoryLoad(sessionId, cacheCannotFill()
            ? MACHINE_OFFLINE_HISTORY_ERROR
            : "Could not load session activity before the live connection was ready.", epoch, revision, generation);
        }
      }).catch(() => {
        if (cancelled) return;
        if (skippedForPause || !canApply()) {
          historyRetryNeeded = true;
          return;
        }
        failEventHistoryLoad(sessionId, "Could not load session activity.", epoch, revision, generation);
      }).finally(() => {
        historyInFlight = false;
        // Resume may have happened between the response fence and its promise continuation.
        readHistory();
      });
    };
    const onFollowState = (state: FollowTailState) => {
      following = state === "following";
      readHistory();
    };
    provisionalFollowStateRef.current = onFollowState;
    readHistory();
    return () => {
      cancelled = true;
      if (provisionalFollowStateRef.current === onFollowState) provisionalFollowStateRef.current = null;
      if (metadataRetryTimer !== undefined) window.clearTimeout(metadataRetryTimer);
    };
  }, [api, instanceScope, sessionId, conn, recoveryRevision, recoveryEventEpoch, recoveryGeneration,
    historyRetry, beginEventHistoryLoad, failEventHistoryLoad, loadEvents, loadTurnStartWindow, loadSession, getSession, cacheCannotFill, openingReadKey, turnStartOpeningAvailable]);

  // Opening a session reads a bounded prefix at the current turn's start. Reopening after an
  // outage instead backfills only the gap
  // since what we already have, with a fixed page budget before tail replacement while following.
  // Also re-runs when the socket comes back ONLINE: events broadcast during the
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
    const epoch = recoveryEventEpoch;
    const generation = recoveryGeneration;
    const after = recoveryReadAfter(sessionId, epoch, generation);
    const isCurrent = () => !cancelled && (gapFence === null || isEventGapRecoveryCurrent(gapFence));
    const historyOptions: SessionHistoryRecoveryOptions = {
      fetchPage: api.getSessionEventPage,
      applyPage: (id, events, pageEpoch, revision, complete) =>
        loadEvents(id, events, pageEpoch, revision, complete, generation),
      isCurrent,
      retryOnIdleTimeout: true,
    };
    const windowOptions: SessionHistoryWindowOptions = {
      fetchTailPage: api.getSessionEventTailPage,
      applyWindow: (id, events, pageEpoch, revision, complete, hasOlder, turnAligned) =>
        gapFence
          ? loadEventGapWindow(gapFence, events, complete, hasOlder, turnAligned)
          : loadEvents(id, events, pageEpoch, revision, complete, generation, hasOlder, turnAligned),
      isCurrent,
      cacheCannotFill,
    };
    const request = { sessionId, after, eventEpoch: epoch, recoveryRevision };
    const forwardRecovery = () => recoverSessionHistory(request, historyOptions);
    const canReplaceWithWindow = () => !hasSavedFollowTailAnchor(instanceScope, sessionId);
    // A complete provisional REST window contributes its own contiguous tail to this read even
    // before its subscription acknowledgement. Pausing after it painted must not replay an omitted
    // prefix from the old frozen cursor. Small reconnect gaps retain their rows; long gaps use a fixed
    // forward-page budget before replacing the tail. Check paused state again at that boundary so
    // a reader who starts reading during recovery keeps the rows their saved position depends on.
    // After the budget, a paused reader keeps its slice while a separately retained current tail
    // makes returning to live independent of the gap's size. Missing middle rows are reader-driven.
    const openWindow = (turnStartReadKeyRef.current === openingReadKey &&
      eventWindow?.openingStartSeq !== undefined && !eventWindow.complete) || shouldReadOpeningWindow({
      recoveryAfter: after,
      hasSavedReadingPosition: !canReplaceWithWindow(),
    });
    beginEventHistoryLoad(sessionId, epoch, recoveryRevision, generation);
    if (openWindow && turnStartOpeningAvailable) turnStartReadKeyRef.current = openingReadKey;
    const gapFence = openWindow && turnStartOpeningAvailable ? null : beginEventGapRecovery(sessionId, epoch, recoveryRevision, generation,
      () => hasSavedFollowTailAnchor(instanceScope, sessionId));
    const load = openWindow
      ? recoverSessionTurnStartWindow(request, { ...windowOptions,
        scope: openingReadScope.current, readKey: openingReadKey,
        fetchOpening: turnStartOpeningAvailable ? api.getSessionTurnStartPage : undefined,
        onUnsupported: () => { if (isCurrent()) setUnsupportedOpeningKey(openingReadKey); },
        applyOpening: (page) => isCurrent() && loadTurnStartWindow(sessionId, page, recoveryRevision, generation),
      })
        .then((result) => (result.supported ? result.complete : forwardRecovery()))
      : recoverSessionHistoryGap(request, {
        history: historyOptions,
        window: windowOptions,
        canReplaceWithWindow,
        deferWindow: gapFence === null ? undefined : (_id, events, pageEpoch, _revision, complete, hasOlder, turnAligned) =>
          !cancelled && pageEpoch === gapFence.eventEpoch &&
          deferEventTail(gapFence, events, complete, hasOlder, turnAligned),
      });
    void load.then((complete) => {
      if (isCurrent() && !complete) {
        failEventHistoryLoad(sessionId, cacheCannotFill()
          ? MACHINE_OFFLINE_HISTORY_ERROR
          : "Some session activity could not be loaded.", epoch, recoveryRevision, generation);
      }
    }).catch(() => {
      if (isCurrent()) {
        failEventHistoryLoad(sessionId, "Could not load complete session activity.", epoch, recoveryRevision, generation);
      }
    }).finally(() => {
      if (gapFence) finishEventGapRecovery(gapFence);
    });
    return () => {
      cancelled = true;
      if (gapFence) cancelEventGapRecovery(gapFence);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId, loadEvents, loadTurnStartWindow, conn, recoveryRevision, recoveryReadAfter, recoveryEventEpoch, recoveryGeneration, historyRetry, beginEventHistoryLoad, failEventHistoryLoad, isEventGapRecoveryCurrent, beginEventGapRecovery, cancelEventGapRecovery, finishEventGapRecovery, loadEventGapWindow, deferEventTail, cacheCannotFill, openingReadKey, turnStartOpeningAvailable]);

  const loadLater = useCallback(() => {
    const request = beginLaterEventsLoad(sessionId);
    if (!request) return false;
    void api.getSessionEventPage(sessionId, request.after, request.fence.eventEpoch, SESSION_EVENT_PAGE_LIMIT)
      .then((page) => {
        if (!loadLaterEvents(request, page)) {
          failLaterEventsLoad(request, "Some later activity is not available yet. Retry to continue reading.");
        }
      })
      .catch(() => failLaterEventsLoad(request, "Could not load later activity. Retry to continue reading."));
    return true;
  }, [api, sessionId, beginLaterEventsLoad, loadLaterEvents, failLaterEventsLoad]);

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
        else {
          failOlderEventsLoad(
            sessionId,
            "Earlier activity isn't available from this version of Wollipog. Update Wollipog to load it.",
            base,
            epoch,
          );
        }
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
    for (const detach of state.heldTouches.values()) detach();
    state.heldTouches.clear();
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

  const finishTouchEarlierActivityIntent = useCallback(() => {
    const state = automaticEarlierLoadRef.current;
    if (state.readerIntent !== "touch-traversal") return;
    state.inputHeld = false;
    deferEarlierActivityIdleEnd();
  }, [deferEarlierActivityIdleEnd]);

  /** Holds one reader finger until `target` hears the end that `ends` recognises as that finger's
   * own; the traversal finishes once no reader finger is held. */
  const holdEarlierActivityTouch = useCallback((
    key: string,
    target: EventTarget,
    endTypes: readonly string[],
    ends: (event: Event) => boolean,
  ) => {
    const heldTouches = automaticEarlierLoadRef.current.heldTouches;
    heldTouches.get(key)?.();
    const onEnd = (event: Event) => {
      if (!ends(event) || heldTouches.get(key) !== detach) return;
      heldTouches.delete(key);
      detach();
      if (heldTouches.size === 0) finishTouchEarlierActivityIntent();
    };
    const detach = () => {
      for (const type of endTypes) target.removeEventListener(type, onEnd);
    };
    for (const type of endTypes) target.addEventListener(type, onEnd);
    heldTouches.set(key, detach);
  }, [finishTouchEarlierActivityIntent]);

  // A touch pointer's end can land outside the reader (a drag relayed from the floating tail control
  // ends wherever the finger lifts), so it is heard on the window. A native pan cancels its pointer
  // while the finger is still down; its touch, held below, keeps the traversal armed.
  const markTouchPointerEarlierActivityIntent = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    markEarlierActivityIntent("touch-traversal", event.clientY);
    const pointerId = event.pointerId;
    holdEarlierActivityTouch(
      `pointer:${pointerId}`,
      event.currentTarget.ownerDocument.defaultView ?? window,
      ["pointerup", "pointercancel"],
      (end) => (end as PointerEvent).pointerId === pointerId,
    );
  }, [holdEarlierActivityTouch, markEarlierActivityIntent]);

  // A touch's later events all go to the element it started on, even once a re-render has removed
  // that element and they no longer bubble to the reader; and a reader `touchend` cannot say when
  // the reader's own fingers are gone, since `touches` counts fingers anywhere on the page. So each
  // finger is released by its own end, heard where it started (#2563).
  const markNativeTouchEarlierActivityIntent = useCallback((event: TouchEvent) => {
    const state = automaticEarlierLoadRef.current;
    const target = event.target;
    if (!target) return;
    const nativeTouchHeld = [...state.heldTouches.keys()].some((key) => key.startsWith("touch:"));
    if (!nativeTouchHeld) markEarlierActivityIntent("touch-traversal", event.touches[0]?.clientY ?? null);
    for (const touch of Array.from(event.changedTouches)) {
      const identifier = touch.identifier;
      holdEarlierActivityTouch(`touch:${identifier}`, target, ["touchend", "touchcancel"], (end) =>
        Array.from((end as TouchEvent).changedTouches ?? []).some((ended) => ended.identifier === identifier));
    }
  }, [holdEarlierActivityTouch, markEarlierActivityIntent]);

  const markTouchEarlierActivityMovement = useCallback((clientY: number | null) => {
    const state = automaticEarlierLoadRef.current;
    if (state.readerIntent !== "touch-traversal" || clientY === null) return;
    if (state.touchInputY !== null && clientY > state.touchInputY + 1) {
      state.touchTraversalStarted = true;
    }
    state.touchInputY = clientY;
  }, []);

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
  // When each docked request was raised: a workflow decision carries its own time, and a provider's
  // request has its transcript row.
  const requestCreatedAt = useMemo(() => {
    const times = new Map<string, number>();
    const wanted = new Set(dockedRequests.map((request) => request.requestId));
    for (let index = items.length - 1; wanted.size > 0 && index >= 0; index -= 1) {
      const item = items[index]!;
      if ((item.kind !== "permission" && item.kind !== "question") || !wanted.has(item.requestId)) continue;
      wanted.delete(item.requestId);
      if (item.createdAt !== undefined) times.set(item.requestId, item.createdAt);
    }
    return (request: PendingApproval) => request.workflowDecision?.createdAt ?? times.get(request.requestId);
  }, [dockedRequests, items]);
  // Governance outcomes are transcript context, not a persistent header: the decisions whose
  // request has no transcript row of its own are spliced in at their chronological position, and
  // the whole list stays reviewable in the side panel (a full-screen drawer on phones).
  // It refreshes whenever the session's `updatedAt` or request moves, as the session renders. A
  // policy that decides a tool call records its outcome without changing anything else, so the paced
  // upserts that move `updatedAt` while an agent streams refresh it too, without rendering this view
  // (#2872).
  const governanceRevision = useStoreValueSource((s) => {
    const live = s.sessions.get(sessionId);
    return `${live?.updatedAt ?? ""}:${live?.pendingApproval?.requestId ?? ""}`;
  });
  const governanceAudit = useGovernanceAudit(sessionId, "", mode === "expanded", evs?.[0]?.ts, governanceRevision);
  const governanceDecisions = governanceAudit.decisions;
  const timelineItems = useGovernanceTimeline(
    items,
    governanceDecisions,
    evs,
    session.status === "running" || session.status === "starting",
    timelineHistoryKey,
  );
  // Decision History's Show in Transcript: the loaded row that shows each decision's request. The
  // index is built only when the panel asks, so a streamed chunk never walks the whole transcript.
  const transcriptItemForDecision = useMemo(() => {
    let index: TranscriptDecisionIndex | null = null;
    return (decision: GovernanceDecision): number | undefined =>
      transcriptRowForDecision(index ??= indexTranscriptDecisionRows(timelineItems), decision);
  }, [timelineItems]);
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
  // Only the count of current workers is read here, and a worker's state reads no streaming field (#2872).
  const rosterSessions = useStoreSelector((state) => state.sessions, sessionsEqualIgnoringStreaming);
  const rosterRuns = useStoreSelector((state) => state.runs);
  const rosterRunners = useStoreSelector((state) => state.runners);
  const activeWorkerCount = useMemo(() => workerRoster(session, activeSubagents,
    (session.runId ? rosterRuns.get(session.runId)?.sessionIds ?? [] : []).flatMap((id) => {
      const member = rosterSessions.get(id);
      return member ? [member] : [];
    }), (id) => rosterRunners.get(id)?.status === "online").filter(isCurrentWorker).length,
  [session, activeSubagents, rosterSessions, rosterRuns, rosterRunners]);
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
  const autoGrowComposerRef = useRef(() => {});
  autoGrowComposerRef.current = () => {
    if (mode !== "expanded" || composerFieldSizesToContent()) return;
    const el = inputRef.current;
    if (!el) return;
    resizeComposerToContent(el);
  };
  // A phone's side panel sheet hides the composer (#2843). A draft that changed while it was hidden
  // had no width to measure, so revealing it grows it again.
  const phonePanelOpen = isMobile && rightPanel.open;
  useLayoutEffect(() => {
    autoGrowComposerRef.current();
  }, [mode, phonePanelOpen]);
  // A changed draft commits in the textarea alone, so what followed the draft here runs from the
  // textarea's layout phase instead: a pending focus restore, then the auto-grow, in the order their
  // effects above run.
  const handleComposerTextCommitted = useCallback(() => {
    restorePendingComposerFocusRef.current();
    autoGrowComposerRef.current();
  }, []);

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
      showActionError(PENDING_PROMPT_ACTIONS[action], cause);
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
      showActionError("cancelQueuedMessage", cause);
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
  actionMachineNameRef.current = runnerDisp.name || undefined;
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
  // The composer, and with it Answer Mode, shows only in the expanded session; a preview keeps the
  // question on the dock even while Answer Mode is open for it (#2212).
  const answeringInComposer = composerAnswerActive && mode === "expanded";
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
      // A panel shrunk by Show Context opens again to take the answer.
      if (!answerRevealRef.current?.(pendingQuestion.requestId)) answerInputRef.current?.focus();
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
      setError("There's no turn to stop right now.", "Turn Not Stopped");
      return false;
    }
    if (stopTurnPendingRef.current) return false;
    const mutation = reserveComposerMutation(mutationKey, "stop");
    if (!mutation) {
      setError("A stop request is already in progress.", "Turn Not Stopped");
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
      setError("The turn is still active. Try stopping it again or use Stop Session.", "Turn Not Stopped");
    }, STOP_TURN_RETRY_MS);
    try {
      await api.cancelTurn(sessionId);
      if (stopTurnAttemptRef.current !== attempt) return false;
      return true;
    } catch (cause) {
      if (stopTurnAttemptRef.current !== attempt) return false;
      clearStopTurnAttempt();
      showActionError("stopTurn", cause);
      return false;
    }
  }, [api, canStopTurn, cancelTurnRefusal, clearStopTurnAttempt, mutationKey, sessionId]);

  useEffect(() => {
    if (mode !== "expanded" || !canStopTurn || cancelTurnRefusal !== null) return;
    const onStopTurnShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".xterm") || shortcutLayerActive(document, false, event)) return;
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
    openingAnchor: eventWindow?.openingStartSeq && evs?.[0]
      ? { key: `item:${evs[0].payload.kind}:${eventWindow.openingStartSeq}`, offset: 0 }
      : null,
  });
  useEffect(() => {
    provisionalFollowStateRef.current?.(followTail.state);
  }, [followTail.state]);
  const acknowledgedFollowRef = useRef({ key: timelineHistoryKey, state: followTail.state });
  const jumpTailInFlightRef = useRef<symbol | null>(null);
  const [jumpTailSettled, setJumpTailSettled] = useState(0);
  useEffect(() => {
    const previous = acknowledgedFollowRef.current;
    acknowledgedFollowRef.current = { key: timelineHistoryKey, state: followTail.state };
    if (followTail.state !== "following") return;
    const gap = eventWindow?.laterGap;
    if (gap) {
      // Promotion cancels a pending reader-driven page before adopting the separately fetched tail.
      // Its operation fence also rejects a tail retained by an obsolete API or recovery owner.
      if (!promoteDeferredEventTail(gap.fence)) {
        if (jumpTailInFlightRef.current) return;
        const attempt = Symbol("jump-tail");
        jumpTailInFlightRef.current = attempt;
        const failJump = () => {
          if (!isEventGapRecoveryCurrent(gap.fence)) return;
          followTail.pause();
          failEventHistoryLoad(sessionId, "Could not load the latest activity. Retry to continue reading.",
            gap.fence.eventEpoch, gap.fence.recoveryRevision, gap.fence.recoveryGeneration);
        };
        // A cold opening knows the tail coordinate but has fetched only its turn-start prefix.
        // The explicit Jump action owns this replacement; automatic opening never moves there.
        void api.getSessionEventTailPage(sessionId, undefined, gap.fence.eventEpoch, SESSION_EVENT_PAGE_LIMIT)
          .then((page) => {
            if (!isEventGapRecoveryCurrent(gap.fence)) return;
            if (page.eventEpoch !== gap.fence.eventEpoch ||
                page.cacheComplete !== true || !deferEventTail(gap.fence, page.events, true,
                  page.hasMoreOlder === true, page.turnAligned) ||
                (isEventGapRecoveryCurrent(gap.fence) && !promoteDeferredEventTail(gap.fence))) {
              failJump();
            }
          }).catch(failJump)
          .finally(() => {
            if (jumpTailInFlightRef.current !== attempt) return;
            jumpTailInFlightRef.current = null;
            // A newer acknowledgement can transfer the gap while this request is pending. Its
            // stale response cannot apply, but releasing the guard must resume the current owner.
            setJumpTailSettled(value => value + 1);
          });
      }
    } else if (previous.key === timelineHistoryKey && previous.state !== "following" &&
        recoveryRevision != null && eventHistory?.error != null) {
      // A sparse live slice can deliberately refuse staging to preserve a chosen reading row.
      // Explicitly returning to live may now replace it with a bounded current window.
      setHistoryRetry((value) => value + 1);
    }
  }, [followTail.state, followTail.pause, jumpTailSettled, timelineHistoryKey, eventWindow?.laterGap, eventHistory?.error,
    recoveryRevision, promoteDeferredEventTail, api, sessionId, isEventGapRecoveryCurrent, deferEventTail, failEventHistoryLoad]);

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
    if (eventWindow.openingStartSeq !== undefined) {
      settle();
      return;
    }
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
  const revealTranscriptEvent = useCallback((eventId: number, place: "operation" | "question") => {
    // Semantic navigation owns the viewport until the reader explicitly resumes following. A
    // question's place is read back to as the reader would scroll there, so the request dock takes
    // its strip (#2205).
    const requestId = ++timelineRevealRequestId.current;
    timelineRevealRestoreState.current = { requestId, state: followTail.state };
    if (place === "question") followTail.pause();
    else followTail.preview();
    const request: TimelineRevealRequest = {
      eventId,
      requestId,
      historyKey: timelineHistoryKey,
      align: place === "question" ? "upper-third" : "center",
      focus: true,
    };
    timelineRevealRequestRef.current = request;
    setTimelineRevealRequest(request);
  }, [followTail.pause, followTail.preview, followTail.state, timelineHistoryKey]);
  const revealCurrentOperation = useCallback((eventId: number) => revealTranscriptEvent(eventId, "operation"),
    [revealTranscriptEvent]);
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
  const revealTranscriptItemFromPanel = useCallback((eventId: number) => {
    // A phone's panel covers the transcript; an expanded one fills its place (#2845).
    if (isMobile) rightPanelRef.current.close();
    else restoreExpandedPanel();
    revealCurrentOperation(eventId);
  }, [isMobile, restoreExpandedPanel, revealCurrentOperation]);
  const previewNavigationControls = useMemo<PreviewNavigationControls>(() => ({
    beginProgrammaticScroll: followTail.beginProgrammaticScroll,
    follow: followTail.follow,
  }), [followTail.beginProgrammaticScroll, followTail.follow]);
  usePreviewNavigationRegistration(mode, onPreviewNavigationReady, previewNavigationControls);
  // The archive shortcut runs the header's archive action, so it is refused for the same people.
  const archiveRefusal = sessionArchiveActionRefusal(session);
  // F runs More Actions' Fork Conversation…, which the header registers here only while enabled.
  const forkShortcutRef = useRef<(() => void) | null>(null);
  // The top question being answered in the composer is off the dock (#2212). A brings its answer up;
  // D does nothing, so it can never fall through to another request the dock or the Sessions list
  // holds. The question is dismissed from its card once Answer Mode is closed.
  const topQuestionInComposer = answeringInComposer && prioritizedRequests[0]?.requestId === pendingQuestion.requestId;
  const readingActions = useMemo<SessionReadingKeyActions>(() => ({
    nextSession: () => onNextSession?.(),
    previousSession: () => onPreviousSession?.(),
    // A and D act on the dock's expanded request when the session's top request is docked (#2179,
    // #2205); otherwise (a worker's request), or for A on a top question, they act on the top request.
    approve: () => {
      if (topQuestionInComposer) {
        enterAnswerMode();
        return;
      }
      if (topRequestDocked && decideDockedRequest(session.id, "approve")) return;
      if (responseRefusal === null) onApprove?.();
      else setError(responseRefusal);
    },
    deny: () => {
      if (topQuestionInComposer) return;
      if (topRequestDocked && decideDockedRequest(session.id, "deny")) return;
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
  }), [archiveRefusal, canAnswerPendingQuestion, enterAnswerMode, focusComposerAtDraftEnd, followTail.follow, followTail.pause, onApprove, onArchive, onDeny, onNextSession, onPreviousSession, onSnooze, responseRefusal,
    session.id, topQuestionInComposer, topRequestDocked]);
  // The reader's keys (J/K, A/D, R…) act on the transcript and the request dock, so they are off
  // while an expanded side panel hides them (#2845).
  const sessionReadingKeys = mode === "expanded" && !isMobile && !(rightPanel.open && rightPanel.expanded);
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
  // Read by the turn actions' confirmations, which quote a turn's prompt, without giving the
  // memoized handlers below a new identity on every transcript update.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Rewind FILES to a per-turn checkpoint (T3-style). Stable identity (useCallback) — it rides
  // into the memoized timeline rows. The confirm copy is explicit that the conversation is not
  // rewound: the agent may still reference later changes in its context.
  const onRewind = useCallback(
    async (turn: number) => {
      if (rewindRefusal !== null) return;
      const timeline = itemsRef.current;
      const rewindTurns = userRewindTurns(timeline);
      const prompt = timeline.find((item): item is Extract<TimelineItem, { kind: "user_message" }> =>
        item.kind === "user_message" && rewindTurns.get(item.id) === turn);
      if (!await confirm({
        ...turnActionConfirmation(rewindFilesConfirmation(turn, prompt?.text)),
        tone: "danger",
      }) || rewindRefusalRef.current !== null) return;
      await api.rewind(sessionId, turn).catch((cause: unknown) => showActionError("rewind", cause));
    },
    [api, confirm, rewindRefusal, sessionId],
  );

  const onFork = useCallback(
    async (turn: number) => {
      if (busy || forkInFlightRef.current || forkRefusal !== null) return;
      if (!await confirm(turnActionConfirmation(forkConversationConfirmation(turn, session?.driver))) ||
        forkRefusalRef.current !== null) return;
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
            const failure = forkFailure("fork", cause, ambiguous, actionMachineNameRef.current);
            showComposerError("action", failure);
            if (mode === "preview") showToast(failure.message, { tone: "error" });
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
      setError("This session's machine no longer has its agent, so a new conversation can't start from it.", "Session Not Recovered");
      return;
    }
    if (!await confirm(turnActionConfirmation(
      recoverSessionConfirmation(quarantine.recoveryTurn, handoff ? "handoff" : "fork"),
    )) || forkRefusalRef.current !== null) return;
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
        const failure = forkFailure("recoverConversation", cause, ambiguous, actionMachineNameRef.current);
        showComposerError("action", failure);
        if (mode === "preview") showToast(failure.message, { tone: "error" });
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
  // A recovered edit says what happened in one visible sentence (§13.2): why Save is disabled when it
  // can't be retried, which Save then references, or that it is still unsaved when it can.
  const queuedEditRecoveryReason = queuedEditReconciliation === null
    ? null
    : queuedEditReconciliation.status === "retryable"
      ? "This edit hasn't been saved yet."
      : queuedEditReconciliation.reason;
  const canSend = canPrompt && (composerHasMessage || images.length > 0);
  const restartRefusal = sessionCommandRefusal(session, "restart");
  // The control plane refuses to restart an archived session, so the composer offers no Restart
  // there; the Session Archived notice's Unarchive (and Restart) is the way back (#2301).
  const composerRestartOffered = session.status === "stopped" &&
    session.stopOperation?.status !== "stop_failed" && !session.archived;
  // Retry Turn's restart and the composer's Restart share one guard: two restarts in flight would
  // let the second replace the process the first started, interrupting the retried turn (#2169).
  const turnRetryInFlightRef = useRef(false);
  // More Actions → Restart Session in the header, which Retry Turn also waits for.
  const [headerRestartPending, setHeaderRestartPending] = useState(false);
  const restartFromComposer = useCallback(async () => {
    if (!composerRestartOffered || !runnerOnline || busy || restartPending || restartRefusal !== null ||
        turnRetryInFlightRef.current) return;
    const generation = viewGenerationRef.current;
    setError(null);
    setBusy(true);
    setRestartPending(true);
    try {
      loadSession(await api.restart(session.id));
    } catch (cause) {
      if (viewGenerationRef.current === generation) showActionError("restart", cause);
    } finally {
      if (viewGenerationRef.current === generation) {
        setRestartPending(false);
        setBusy(false);
      }
    }
  }, [api, busy, composerRestartOffered, loadSession, restartPending, restartRefusal, runnerOnline, session.id]);
  // Retry Turn on a failed turn's notice (#2169): the turn's prompt again, as a new turn. A failed
  // or stopped session restarts first, since the control plane admits no prompt to it until then,
  // but only where the restart resumes the provider conversation.
  const retryPlan = turnRetryPlan({
    status: session.status,
    driver: session.driver,
    runnerOnline,
    promptRefusal,
    restartRefusal,
    sessionNoticeReason,
    policyPaused,
    stopFailed: session.stopOperation?.status === "stop_failed",
    restarting: restartPending || headerRestartPending,
  });
  const [retryingTurnPromptId, setRetryingTurnPromptId] = useState<number>();
  const [turnRetryError, setTurnRetryError] = useState<{ promptId: number; message: string }>();
  const retryTurn = useCallback(async (prompt: Extract<TimelineItem, { kind: "user_message" }>) => {
    // One retry at a time, decided synchronously: a second click before the pending state renders
    // must not submit the prompt twice.
    if (turnRetryInFlightRef.current || restartPending || headerRestartPending ||
        retryPlan.kind === "unavailable") return;
    turnRetryInFlightRef.current = true;
    const generation = viewGenerationRef.current;
    setTurnRetryError(undefined);
    setRetryingTurnPromptId(prompt.id);
    try {
      // A refused restart throws here, so the prompt is never sent into a session that did not
      // restart.
      if (retryPlan.kind === "restart_then_prompt") loadSession(await api.restart(session.id));
      // The accepted prompt's session (queued or running) is loaded before the guard opens, so the
      // button cannot offer the same prompt again while the socket's update is still on its way.
      // A model or effort chosen since the failure travels with the prompt, as Send's does, so the
      // turn never starts on the previous selection while that change is still being saved.
      const cfg = Object.keys(pendingConfig.current).length ? pendingConfig.current : undefined;
      loadSession(await api.prompt(session.id, prompt.text, prompt.images ?? [], cfg));
      pendingConfig.current = {};
    } catch (cause) {
      if (viewGenerationRef.current === generation) {
        setTurnRetryError({ promptId: prompt.id, message: (cause as Error).message });
      }
    } finally {
      turnRetryInFlightRef.current = false;
      if (viewGenerationRef.current === generation) setRetryingTurnPromptId(undefined);
    }
  }, [api, headerRestartPending, loadSession, restartPending, retryPlan.kind, session.id]);
  const retryPlanReason = retryPlan.kind === "unavailable" ? retryPlan.reason : undefined;
  const turnRetry = useMemo<TurnRetryControl>(() => ({
    onRetry: (prompt) => void retryTurn(prompt),
    ...(retryPlanReason !== undefined ? { unavailableReason: retryPlanReason } : {}),
    ...(retryingTurnPromptId !== undefined ? { pendingPromptId: retryingTurnPromptId } : {}),
    ...(turnRetryError ? { error: turnRetryError } : {}),
  }), [retryTurn, retryPlanReason, retryingTurnPromptId, turnRetryError]);
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
    // Which request failed: the retry itself, or the restart a setup that now succeeded needs.
    let failedAction: ComposerAction = "retrySetup";
    try {
      const result = await api.retryWorktreeSetup(session.id, failedSetupWorktree.path);
      loadSession(result.session);
      // Initial launch failures need a fresh start after setup succeeds. Provider forks and
      // handoffs are restored to idle by the runner so Retry never discards their continuation.
      if (result.session.status === "failed") {
        failedAction = "restartAfterSetup";
        loadSession(await api.restart(session.id));
      }
    } catch (cause) {
      if (viewGenerationRef.current === generation) showActionError(failedAction, cause);
    } finally {
      if (viewGenerationRef.current === generation) setSetupRetryPending(false);
    }
  }, [api, failedSetupWorktree, loadSession, runnerOnline, session.id, session.status, setupRetryPending,
    worktreeSetupRefusal]);
  const primaryComposerAction = composerPrimaryAction({
    canStopTurn,
    hasContent: composerHasText || images.length > 0,
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
    sessionId,
    availability: latestForkAvailability,
    fork: () => {
      if (latestForkAvailability.available) void onFork(latestForkAvailability.forkTurn);
    },
  }), [latestForkAvailability, onFork, sessionId]);
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

  // Edit as a New Turn loads the message straight into the composer (#2185). A draft it replaces is
  // kept with the copy, so Discard Edit can put it back; sending the copy ends the edit.
  const canPromptRef = useRef(canPrompt);
  canPromptRef.current = canPrompt;
  // A send that outlived an earlier view of this session settles its copy in the store and then
  // releases the composer mutation, which re-renders this view: follow the store.
  useEffect(() => {
    const stored = loadComposerEditCopy(sessionId, instanceScope);
    if ((stored?.id ?? null) !== (editCopyRef.current?.id ?? null)) setEditCopyState(stored);
  }, [activeComposerMutation, instanceScope, sessionId]);
  const putComposerDraft = useCallback((draft: ComposerDraftContent) => {
    // A draft put in place of another (Edit as a New Turn, Discard Edit) ends the dictation that was
    // writing the old one (#2193).
    dictation.cancel();
    draftDirty.current = true;
    composerDraftVersionRef.current += 1;
    draftState.current = draft;
    setProgrammaticComposerText(draft.text);
    if (draft.images.length) replace(draft.images);
    else clear();
    setHistIdx(-1);
  }, [clear, dictation.cancel, replace, setProgrammaticComposerText]);
  const openResendAction = useCallback(async (item: Extract<TimelineItem, { kind: "user_message" }>) => {
    if (!canPromptRef.current) return;
    const held = draftState.current;
    if ((held.text.trim() || held.images.length > 0) && !await confirm({
      ...REPLACE_DRAFT_CONFIRMATION,
      returnFocus: inputRef,
    })) return;
    // The session can stop taking turns, or the draft can change, while the confirmation is open.
    if (!canPromptRef.current) return;
    const current = draftState.current;
    // A second edit replaces the first copy, not the person's own draft: Discard Edit still
    // restores what they had written before either. A copy already being sent is not replaced; the
    // draft written since is.
    const loaded = editCopyRef.current &&
      !composerEditCopySending(sessionId, instanceScope, editCopyRef.current.id)
      ? editCopyRef.current
      : null;
    const previous = loaded
      ? loaded.previous
      : current.text || current.images.length
        ? { text: current.text, images: current.images.map((image) => ({ ...image })) }
        : null;
    revealOrdinaryComposerRef.current("always");
    putComposerDraft({ text: item.text, images: (item.images ?? []).map((image) => ({ ...image })) });
    const turn = item.turn ?? userRewindTurns(itemsRef.current).get(item.id);
    updateEditCopy({ id: browserRandomUUID(), ...(turn !== undefined ? { turn } : {}), previous });
  }, [confirm, instanceScope, putComposerDraft, sessionId, updateEditCopy]);
  const discardEditCopy = useCallback(() => {
    const copy = editCopyRef.current;
    if (!copy) return;
    putComposerDraft(copy.previous ?? { text: "", images: [] });
    updateEditCopy(null);
    focusComposerAtDraftEnd();
  }, [focusComposerAtDraftEnd, putComposerDraft, updateEditCopy]);

  const prepareFork = useCallback(async (
    forkTurn: number,
    draft: ComposerDraftContent,
  ) => {
    if (forkInFlightRef.current) throw new Error("A conversation fork is already in progress for this session.");
    // Read now rather than when the confirmation opened: a refusal can arrive while it is open.
    if (forkRefusalRef.current !== null) throw new Error(forkRefusalRef.current);
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
      if (viewGenerationRef.current === generation) navigate({ name: "session", id: forked.id });
    } catch (cause) {
      // The confirmation shows the failure as its danger notice, with the server's words behind
      // Show Details. An ambiguous fork keeps the lock, so trying again says a fork is already in
      // progress rather than creating a second one.
      const ambiguous = ambiguousForkError(cause);
      if (ambiguous) releaseOnFinish = false;
      const failure = forkFailure("editInFork", cause, ambiguous, actionMachineNameRef.current);
      throw new ConfirmationFailure(failure.message, failure.detail);
    } finally {
      if (releaseOnFinish) releaseFork();
      forkInFlightRef.current = false;
      setBusy(false);
    }
  }, [api, instanceScope, navigate, sessionId]);
  const openForkEditAction = useCallback(
    (item: Extract<TimelineItem, { kind: "user_message" }>, forkTurn: number) => {
      const draft = { text: item.text, images: (item.images ?? []).map((image) => ({ ...image })) };
      void confirm({
        ...turnActionConfirmation(editInForkConfirmation(forkTurn + 1)),
        progress: "Creating the fork…",
        // The fork cannot be withdrawn once requested, and it opens its session when it lands.
        cancelWhileRunning: false,
        onConfirm: () => prepareFork(forkTurn, draft),
      });
    },
    [confirm, prepareFork],
  );

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
                  ? `Recovering continues from the checkpoint after Turn ${quarantine.recoveryTurn} in a new session with the same files. This session stays here, unchanged, for inspection.`
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
  // The working line's Review and a marker's Jump to Question bring the request blocking the turn
  // into view: on the request dock (or the notice slot holding its place), else in the Agents panel,
  // which lists every pending request (a worker's beside an async question).
  const reviewPendingRequest = useCallback((requestId: string) => {
    if (dockedRequests.some((request) => request.requestId === requestId)) {
      if (mode === "expanded") closeRequestOverlay();
      if (focusSessionRequest(session.id, requestId)) return;
    }
    navigate({ name: "session", id: session.id, attention: { eventEpoch: session.eventEpoch ?? 0, requestId } });
  }, [navigate, session.eventEpoch, session.id, dockedRequests, mode, closeRequestOverlay]);

  // The pending questions, whose transcript rows are markers (#2205): the dock's, and a worker's,
  // whose Jump to Question opens the Agents panel. Keyed by their ids, so heartbeats that replace the
  // session view keep the transcript's context.
  const pendingQuestionKey = JSON.stringify(prioritizedRequests.flatMap((request) =>
    request.kind === "question" ? [{ requestId: request.requestId, occurrenceId: request.occurrenceId }] : []));
  const pendingQuestions = useMemo(() => JSON.parse(pendingQuestionKey) as PendingQuestionRef[], [pendingQuestionKey]);
  const pendingQuestionIds = useMemo(() => pendingQuestions.map((question) => question.requestId), [pendingQuestions]);
  const revealQuestionMarker = useCallback((eventId: number) => revealTranscriptEvent(eventId, "question"),
    [revealTranscriptEvent]);
  const { whereAsked: dockWhereAsked, selectedRequestId: selectedMarker } = useQuestionWhereAsked({
    items,
    history: {
      hasOlder: eventWindow?.hasOlder === true && !eventWindow.error && eventWindow.baseSeq > 1,
      loadingOlder: eventWindow?.loadingOlder === true || olderInFlightRef.current,
      complete: eventHistory?.everComplete === true && eventWindow !== undefined,
    },
    loadOlder,
    pendingQuestions,
    reveal: revealQuestionMarker,
    readerRef: scrollRef,
    following: followTail.state === "following",
    resetKey: timelineHistoryKey,
  });
  const timelineQuestionContext = useMemo<TimelineQuestionContext>(() => ({
    pendingRequestIds: pendingQuestionIds,
    onJumpToQuestion: reviewPendingRequest,
    selectedRequestId: selectedMarker,
  }), [pendingQuestionIds, reviewPendingRequest, selectedMarker]);
  // A question whose request carries none of its questions (an older control plane) reads them from
  // its transcript event.
  const dockQuestions = useCallback((request: PendingApproval): AgentQuestion[] => {
    if (request.questions?.length) return request.questions;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (item.kind === "question" && item.requestId === request.requestId && item.answered === undefined) return item.questions;
    }
    return [];
  }, [items]);
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
  // With Show Agent Logs off, a transcript of only Agent Logs renders no row, so a whole history of
  // them is empty rather than a blank reader (#2773). A partial window keeps its timeline: earlier
  // activity can still hold rows. Governance decisions are rows the timeline adds to these items.
  const historyPartial = isPartialHistory(eventWindow);
  const shownItemCount = !showAgentLogs && !historyPartial && agentLogOnly(timelineItems) ? 0 : items.length;
  // Socket delivery can race ahead of the opening read. A cold reader must not paint those tail
  // rows before it has the turn start; a warm reading slice keeps its existing content.
  const awaitingTurnStart = turnStartOpeningAvailable && eventWindow === undefined &&
    eventHistory?.everComplete !== true && unsupportedOpeningKey !== openingReadKey;
  const transcript = transcriptPresentation({
    itemCount: awaitingTurnStart ? 0 : shownItemCount,
    hasOptimistic: !awaitingTurnStart && showOptimistic,
    working: !awaitingTurnStart && activeTurnVisible && !startingWithoutActivity,
    history: eventHistory,
    conn,
  });
  // Receipts for messages already sent are rows of the transcript, under their message (#2171). The
  // full session view shows steering, command and rename receipts; the pending prompts show
  // everywhere the transcript does.
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
  const recoveryAnnouncement = useRecoveryAnnouncement(eventWindow?.laterGap ? "stale" : transcript.notice, sessionId);
  const tailView = transcriptTailView({
    hasTail: transcriptHasTail,
    offscreenNotSent: offscreenUndeliveredIds.length,
    recovering: transcript.notice === "refreshing",
    following: followTail.isFollowing,
    newRows: followTail.newRowCount,
    canScroll: followTail.canScroll,
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
  const composerAgentLabel = sessionAgentLabel(session.agentName, session.driver, session.agentId);
  const composerCommands = useMemo(() => buildComposerCommandRegistry({
    context: { planSupported, canStopTurn, canRespond: canAnswerPendingQuestion, agentLabel: composerAgentLabel },
    providerCommands: mapProviderComposerCommands(
      agentCaps?.slashCommands ?? [],
      providerCommandAttachmentPolicy,
    ),
    unsupportedCommands: agentCaps?.unsupportedSlashCommands,
  }), [agentCaps?.slashCommands, agentCaps?.unsupportedSlashCommands, canAnswerPendingQuestion, canStopTurn,
    composerAgentLabel, planSupported, providerCommandAttachmentPolicy]);
  // `$name` is Codex's spelling for a skill. Claude Code invokes its skills as `/name` (#1224), so
  // there a `$` stays ordinary text and a skill's receipt shows its slash.
  const dollarSkills = session.driver === "codex" || session.driver === "codex-app-server";
  const composerSkillSigil = useMemo(
    () => dollarSkills && composerCommandsIncludeSkills(composerCommands),
    [composerCommands, dollarSkills],
  );
  // Whether an unknown slash token is refused rather than sent as text (#2176): always, except on a
  // Claude Code runner whose catalog can't yet name the built-ins its plain-text fallback runs.
  const rejectUnknownCommands = composerRejectsUnknownCommands(session.driver, agentCaps?.slashCommands ?? []);
  // A command the agent advertises under a name the registry can't list still runs as text.
  const unlistedNames = useMemo(() => unlistedCommandNames(agentCaps?.slashCommands ?? []), [agentCaps?.slashCommands]);
  const composerCommandResolutionOptions: ComposerCommandResolutionOptions = {
    unknownCommands: rejectUnknownCommands ? "reject" : "plaintext",
    skillSigil: composerSkillSigil,
    unlistedNames,
  };
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
    return (invocation: { submissionId: string; providerCommandId: string; commandName: string }) => dollarSkills &&
      (submissionIsSkillRef.current.get(invocation.submissionId) ??
        (skillIds.has(invocation.providerCommandId) || skillOnlyNames.has(invocation.commandName.toLowerCase())));
  }, [agentCaps?.slashCommands, dollarSkills]);
  const workspaceReferencesSupported = runnerSupportsProtocol(runner?.protocolVersion, "workspaceReferences");
  // The slash and @ tokens under the caret. Typing outside one changes none of this, so it renders
  // nothing here; typing inside one does, since the menus filter on every keystroke.
  // Each selector keeps its identity while its inputs do, so a render for anything else (a streamed
  // event) reuses what it selected instead of recomputing it, as the memos these replaced did.
  const selectComposerTriggers = useCallback(
    (snapshot: ComposerTextSnapshot) => composerTriggersAt(snapshot, composerSkillSigil, workspaceReferencesSupported),
    [composerSkillSigil, workspaceReferencesSupported],
  );
  const { slashTrigger, slashDismissKey, workspaceTrigger, workspaceDismissKey } = useComposerTextSelector(
    composerText,
    selectComposerTriggers,
    sameComposerTriggers,
  );
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
    // Busy from the keystroke, not from the debounced request: a query is never reported as
    // matching nothing, or as failing with the previous query's error, before it has been searched.
    setWorkspaceSearchBusy(true);
    setWorkspaceSearchError(null);
    const timer = window.setTimeout(() => {
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
      // The chip appearing in the tray is the confirmation, so an added reference raises no toast
      // (§13.1). The limit and a duplicate are attachment notices in the slot (#2156).
      if (addWorkspaceReference(reference) !== "limit") setError(null);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } catch (cause) {
      showActionError("addReference", cause);
    }
  }, [addWorkspaceReference, api, runner?.protocolVersion, sessionId, workspaceReferencesSupported]);

  // The chip in the composer's tray is an attachment's confirmation (§13.1), so the panel's Attach
  // to Prompt restores an expanded panel to show it (#2845).
  const attachWorkspaceTargetFromPanel = useCallback((target: CreateWorkspaceReferenceRequest) => {
    restoreExpandedPanel();
    return attachWorkspaceTarget(target);
  }, [attachWorkspaceTarget, restoreExpandedPanel]);

  const selectWorkspaceCandidate = (candidate: WorkspaceReferenceCandidate) => {
    if (!workspaceTrigger) return;
    const text = composerText.text;
    const nextText = text.slice(0, workspaceTrigger.start) + text.slice(composerText.selection.start);
    markDraftDirty();
    setProgrammaticComposerText(nextText, workspaceTrigger.start);
    setWorkspaceDismissedFor(null);
    void attachWorkspaceTarget({
      path: candidate.path,
      kind: candidate.isDirectory ? "directory" : "file",
    });
  };
  // The + menu's Reference a File… (#2203): type the "@" for the person, which opens the @ picker.
  // Runs inside the menu row's activation, so expanding a collapsed phone composer and focusing it
  // happen in the same gesture and the software keyboard is allowed to open.
  const insertWorkspaceReferenceTrigger = () => {
    const input = inputRef.current;
    if (!input || !canPrompt) return;
    // A textarea keeps its selection after the menu takes focus, and it is exact where the state
    // copy can lag a programmatic change (a recalled prompt); the copy covers a textarea that does
    // not hold the draft yet.
    const { text, selection } = composerText;
    const live = input.value === text;
    const start = Math.min(live ? input.selectionStart : selection.start, text.length);
    const end = Math.min(Math.max(live ? input.selectionEnd : selection.end, start), text.length);
    const before = text.slice(0, start);
    // The trigger needs the start of the message or whitespace before "@".
    const inserted = before === "" || /\s$/u.test(before) ? "@" : " @";
    const caret = start + inserted.length;
    markDraftDirty();
    flushSync(() => {
      setHistIdx(-1); // typing exits history browsing, and this types for the person
      setComposerExpanded(true);
      setProgrammaticComposerText(before + inserted + text.slice(end), caret);
      setWorkspaceDismissedFor(null);
    });
    input.focus({ preventScroll: true });
    input.setSelectionRange(caret, caret);
  };
  const slashMatches = useMemo(() => {
    if (!slashTrigger) return [];
    const ranked = rankComposerCommands(composerCommandsForTrigger(composerCommands, slashTrigger), slashTrigger.query)
      .map((match) => match.command);
    // The picker's order (each group once, best match's group first) is the order arrows walk.
    return composerCommandsInPickerOrder(slashTrigger.query ? ranked : ranked.filter((command) => command.available));
  }, [composerCommands, slashTrigger]);
  // A slash query that matches nothing keeps the picker open on its no-match row, so a typo does
  // not look like an ordinary message; Escape or a space closes it. A `$` stays ordinary text.
  const slashNoMatch = slashTrigger !== null && slashTrigger.sigil !== "$" && slashTrigger.query !== "" &&
    slashMatches.length === 0;
  const paletteOpen = !workspacePickerOpen && canPrompt && (slashMatches.length > 0 || slashNoMatch) &&
    slashDismissedFor !== slashDismissKey;
  // A token that names no command, in a session that refuses one (#2176): the no-match row becomes
  // the unknown row, with Send as Text and the token's Close Matches, none of them active.
  // A queued edit saves its text as it stands, so it keeps the plain no-match row.
  // A command the session reports it can't run (#1224) is known, not unknown: no menu offers it, and
  // typed in full it resolves to its reason when sent.
  const slashNamesUnsupported = slashTrigger !== null && composerCommands.some((command) =>
    command.hidden && command.invocationAlias === slashTrigger.query.toLowerCase());
  const slashUnknown = rejectUnknownCommands && slashNoMatch && !queuedEdit && !slashNamesUnsupported;
  const slashCloseMatches = useMemo(
    () => slashUnknown && slashTrigger ? suggestComposerCommands(slashTrigger.query, composerCommands) : [],
    [composerCommands, slashTrigger, slashUnknown],
  );
  const selectedCloseMatch = slashUnknown && activeCloseMatch?.token === slashTrigger?.raw
    ? slashCloseMatches.find((command) => command.id === activeCloseMatch?.id)
    : undefined;
  const selectedSlashCommandId = slashUnknown
    ? selectedCloseMatch?.id ?? null
    : retainActiveComposerCommandId(activeSlashCommandId, slashMatches);
  const selectedSlashCommand = slashMatches.find((command) => command.id === selectedSlashCommandId);
  // The command the draft resolves to, if any; only which command it is matters to the render.
  const selectResolvedCommand = useCallback(({ text }: ComposerTextSnapshot) => {
    const resolution = resolveComposerCommandInvocation(text, composerCommands, {
      unknownCommands: rejectUnknownCommands ? "reject" : "plaintext",
      skillSigil: composerSkillSigil,
      unlistedNames,
    });
    return resolution.kind === "command" ? resolution.command : null;
  }, [composerCommands, composerSkillSigil, rejectUnknownCommands, unlistedNames]);
  const composerResolvedCommand = useComposerTextSelector(composerText, selectResolvedCommand);
  const commandPreservesAttachedImages = composerResolvedCommand !== null &&
    durableCommandPreservesAttachments(composerResolvedCommand, images.length > 0);
  // The composer's own slot entries (#2156), behind the session's conditions of the same severity.
  // An error is danger with its own Dismiss, and Retry where the failed action can be repeated with
  // the kept draft; the note that a command keeps the attached images is info, dismissed by the slot.
  const composerErrorEntries = Object.entries(composerErrors) as [ComposerErrorSource, ComposerError][];
  // A failed send is about the draft that failed. Once the composer holds another one (a slash
  // command or Edit as a New Turn replaced it), the entry and its Retry no longer apply.
  const selectRetriesStillHeld = useCallback(({ text }: ComposerTextSnapshot) =>
    (Object.entries(composerErrors) as [ComposerErrorSource, ComposerError][])
      .flatMap(([source, { retry }]) => retry && composerHoldsDraft({ text, images }, retry.draft) ? [source] : [])
      .join("\n"), [composerErrors, images]);
  const retriesStillHeld = useComposerTextSelector(composerText, selectRetriesStillHeld);
  for (const [source, composerError] of composerErrorEntries) {
    const retry = composerError.retry;
    if (retry && !retriesStillHeld.split("\n").includes(source)) continue;
    const retryRefusal = retry ? promptUnavailableReason : null;
    const refusalId = `composer-${source}-retry-refusal`;
    sessionNotices.push({
      key: `composer-error:${source}`,
      severity: "danger",
      rank: source === "attachment" ? SESSION_NOTICE_RANK.attachmentError : SESSION_NOTICE_RANK.composerError,
      title: composerError.title,
      render: ({ trailing }) => (
        <Notice tone="danger" role="alert" ariaLabel={composerError.title} title={composerError.title}
          trailing={trailing}
          onDismiss={() => showComposerError(source, null)}
          actions={retry && (
            <button
              type="button"
              className="btn primary sm"
              disabled={composerRequestBusy || retryRefusal !== null}
              aria-describedby={retryRefusal !== null ? refusalId : undefined}
              onClick={() => {
                if (!composerHoldsDraft(draftState.current, retry.draft)) return;
                void composerRetryRef.current?.[retry.action]();
              }}
            >
              Retry
            </button>
          )}
          details={composerError.detail && <div className="code-well"><code>{composerError.detail}</code></div>}>
          <p>{composerError.message}</p>
          {retryRefusal !== null && <p className="notice-meta" id={refusalId}>{retryRefusal}</p>}
        </Notice>
      ),
    });
  }
  if (commandPreservesAttachedImages && composerResolvedCommand !== null) {
    const commandLabel = composerResolvedCommand.label;
    sessionNotices.push({
      key: `attachment-note:${commandLabel}`,
      severity: "info",
      rank: SESSION_NOTICE_RANK.attachmentNote,
      title: "Images Kept for Next Message",
      render: ({ trailing, onDismiss }) => (
        <Notice tone="info" role="status" ariaLabel="Images Kept for Next Message" title="Images Kept for Next Message"
          trailing={trailing} onDismiss={onDismiss}>
          <p>{durableCommandAttachmentNote(commandLabel)}</p>
        </Notice>
      ),
    });
  }
  // A slash command that wasn't sent (#2176) is a warning while its draft is unchanged: editing the
  // draft clears it. An unknown token offers its closest match, which replaces only the token, and
  // both kinds offer Send as Text, which repeats the refused send or steer with the text as typed.
  const selectCommandNotSentStillHeld = useCallback(
    ({ text }: ComposerTextSnapshot) => commandNotSent !== null && commandNotSent.text === text,
    [commandNotSent],
  );
  const commandNotSentStillHeld = useComposerTextSelector(composerText, selectCommandNotSentStillHeld);
  const visibleCommandNotSent = commandNotSentStillHeld && !queuedEdit ? commandNotSent : null;
  if (visibleCommandNotSent) {
    const { problem, action } = visibleCommandNotSent;
    // The suggestion is read from the current catalog, so a collision added since the refusal uses
    // the command's current alias, and a command that's gone or unavailable is no longer offered.
    const suggestion = problem.kind === "unknown" && problem.suggestionId
      ? composerCommands.find((command) => command.id === problem.suggestionId && command.available)
      : undefined;
    const title = problem.kind === "unknown" ? "Unknown Command" : "Command Unavailable";
    const sentence = problem.kind === "unavailable"
      ? `“${problem.token}” can't run here, so nothing was sent. ${problem.reason}`
      : `“${problem.token}” isn't a recognized command, so nothing was sent.${suggestion ? ` Did you mean ${suggestion.label}?` : ""}`;
    sessionNotices.push({
      key: "command-not-sent",
      severity: "warning",
      rank: SESSION_NOTICE_RANK.commandNotSent,
      title,
      render: ({ trailing }) => (
        <Notice tone="warning" role="alert" ariaLabel={title} title={title} trailing={trailing}
          onDismiss={() => setCommandNotSent(null)}
          actions={<>
            {suggestion && (
              <button type="button" className="btn primary sm" onClick={() => applyCommandSuggestion(suggestion)}>
                Use {suggestion.label}
              </button>
            )}
            <button
              type="button"
              className="btn sm"
              title={SEND_AS_TEXT_TOOLTIP}
              disabled={composerRequestBusy}
              onClick={() => void (action === "steer" ? steerDraft({ asText: true }) : send({ asText: true }))}
            >
              Send as Text
            </button>
          </>}>
          <p>{sentence}</p>
        </Notice>
      ),
    });
  }
  // A queued message being edited owns the composer and keeps the copy aside as its displaced draft,
  // so Discard Edit waits until that edit ends rather than overwriting the queued message.
  if (editCopy && !queuedEdit) {
    sessionNotices.push({
      key: "editing-copy",
      severity: "info",
      rank: SESSION_NOTICE_RANK.editingCopy,
      title: "Editing a Copy",
      // Not dismissible: Discard Edit is the way out, and sending the copy ends it.
      render: ({ trailing }) => (
        <Notice tone="info" compact role="status" ariaLabel="Editing a Copy" trailing={trailing}
          actions={<button type="button" className="btn sm" onClick={discardEditCopy}>Discard Edit</button>}>
          <p>{editingCopyMessage(editCopy.turn)}</p>
        </Notice>
      ),
    });
  }
  // A queued message whose delivery failed is a notice of this slot, not a fragment of its queue
  // row (#2178): the row keeps its Delivery Failed badge and its own Dismiss, and either Dismiss
  // removes the receipt once.
  for (const prompt of queuedPromptControls) {
    const reason = prompt.durableDeliveryError;
    if (!reason) continue;
    const terminal = isTerminalDeliveryReceipt(prompt);
    const failed = prompt.durableDeliveryState === "failed";
    const excerpt = queuedMessageExcerpt(prompt);
    const subject = prompt.text.trim() ? `“${excerpt}”` : "A message with images";
    const title = failed ? "Message Not Delivered" : terminal ? "Delivery Uncertain" : "Message Not Delivered Yet";
    const sentence = failed
      ? `${subject} wasn't delivered.`
      : terminal
        ? `Wollipog couldn't confirm ${prompt.text.trim() ? subject : "a message with images"} was delivered.`
        : `${subject} hasn't been delivered yet.`;
    const dismissLabel = failed ? "Dismiss Failed Message" : "Dismiss Uncertain Message";
    const dismissBusy = pendingPromptAction?.commandId === prompt.id && pendingPromptAction.action === "dismiss";
    const refusalId = `queued-delivery-refusal-${prompt.id}`;
    sessionNotices.push({
      key: `queued-delivery:${prompt.id}`,
      severity: failed ? "danger" : "warning",
      rank: SESSION_NOTICE_RANK.queuedMessageError,
      title,
      render: ({ trailing }) => (
        <Notice tone={failed ? "danger" : "warning"} role="alert" ariaLabel={title} title={title}
          trailing={trailing}
          actions={terminal && (
            <button
              type="button"
              className="btn sm"
              disabled={pendingPromptAction !== undefined || queueRefusal !== null}
              aria-busy={dismissBusy || undefined}
              aria-label={dismissLabel}
              aria-describedby={queueRefusal !== null ? refusalId : undefined}
              onClick={() => void resolvePendingPrompt(prompt.id, "dismiss")}
            >
              Dismiss
            </button>
          )}>
          <p>{sentence} {reason}</p>
          {terminal && queueRefusal !== null && <p className="notice-meta" id={refusalId}>{queueRefusal}</p>}
        </Notice>
      ),
    });
  }
  actualImages.forEach((image, index) => {
    if (!brokenImages.has(image)) return;
    const name = attachmentFileName(image);
    sessionNotices.push({
      key: `attachment-broken:${attachmentKey(image)}`,
      severity: "warning",
      rank: SESSION_NOTICE_RANK.attachmentBroken,
      title: "Image Couldn't Be Shown",
      render: ({ trailing }) => (
        <Notice tone="warning" role="status" ariaLabel="Image Couldn't Be Shown" title="Image Couldn't Be Shown"
          trailing={trailing}>
          <p>{name ? `“${name}”` : `Attached image ${index + 1}`} couldn't be shown. Remove it and attach it again.</p>
        </Notice>
      ),
    });
  });
  const composerIdleCollapsed = isMobile && !composerExpanded && !composerMultiline &&
    images.length === 0 && session.pendingApproval == null &&
    !historyQuarantine && !queuedEdit && composerErrorEntries.length === 0 && !retitleFeedback && !dictation.recording &&
    !dragActive && !paletteOpen && !workspacePickerOpen;
  // Where focus goes when the notice slot or the queue tray removes the control that held it: the
  // composer when it can take a message, or a collapsed phone composer's own Edit Message control, so
  // the layout does not change under the person. A composer that still refuses a message (a plain
  // Unarchive leaves the session stopped) cannot hold focus, so the page title takes it (#2202).
  const focusComposerOrTitle = () => {
    const input = inputRef.current;
    const target = !input || input.disabled ? null
      : composerIdleCollapsed ? input.closest(".composer-box")?.querySelector<HTMLElement>(".composer-idle-preview")
      : input;
    target?.focus({ preventScroll: true });
    if (!target || target.ownerDocument.activeElement !== target) document.getElementById("page-title")?.focus();
  };
  // The phone capsule's preview (#2154): the draft's first line to edit, or who a new message goes
  // to. A composer that cannot send says why instead.
  const composerIdlePlaceholder = canPrompt ? `Message ${composerAgent}` : composerPlaceholder;
  // R focuses the composer from the reader; the idle, unfocused composer says so (#2166).
  const composerReplyKeycap = sessionReadingKeys && canPrompt && activePane === "reader" && !composerHasText &&
    !composerIdleCollapsed && !composerAnswerActive;
  useEffect(() => {
    setActiveSlashCommandId((current) => retainActiveComposerCommandId(current, slashMatches));
  }, [slashMatches]);
  // Editing the draft clears a refused command's notice for good, so undoing the edit doesn't bring
  // it back; so does leaving the session.
  // Each draft starts with no close match active, so Enter can't inherit an earlier draft's choice.
  // The draft is not state here, so both follow it through the store (#2764).
  useEffect(() => {
    let lastText = composerText.text;
    return composerText.subscribe(() => {
      const text = composerText.text;
      if (text === lastText) return;
      lastText = text;
      setCommandNotSent((current) => current && current.text !== text ? null : current);
      setActiveCloseMatch((current) => current === null ? current : null);
    });
  }, [composerText]);
  useEffect(() => setCommandNotSent(null), [sessionId]);
  useEffect(() => setActiveCloseMatch(null), [sessionId]);
  const setComposerCaret = (caret: number) => {
    composerText.setSelection(caret, caret);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(caret, caret);
    });
  };
  // The picker sits where the notice does, so a refusal closes it for this draft, as Escape would;
  // the notice offers what the picker did.
  const showCommandNotSent = (problem: CommandNotSent["problem"], action: CommandNotSent["action"]) => {
    setCommandNotSent({ problem, action, text: composerText.text });
    if (slashDismissKey) setSlashDismissedFor(slashDismissKey);
  };
  // Use /review: the close match replaces the unknown token, the rest of the message stays, and the
  // caret follows the command so its arguments can be typed.
  const applyCommandSuggestion = (command: ComposerCommand) => {
    const replacement = replaceLeadingCommandToken(composerText.text, command);
    markDraftDirty();
    flushSync(() => {
      setHistIdx(-1);
      setCommandNotSent(null);
      setProgrammaticComposerText(replacement.text, replacement.caret);
    });
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(replacement.caret, replacement.caret);
  };
  const insertSlashCommand = (command: ComposerCommand) => {
    if (!slashTrigger || !command.available) return;
    const replacement = replaceComposerCommandTrigger(composerText.text, slashTrigger, command);
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
  // Orchestrator Controls (#2192) opens from the + menu and from the Pinned Summary's Orchestrator
  // rows, and returns focus to whichever opened it.
  const [orchestratorControlsOpen, setOrchestratorControlsOpen] = useState(false);
  const orchestratorControlsReturnFocusRef = useRef<HTMLElement | null>(null);
  const openOrchestratorControls = useCallback((returnFocus: HTMLElement | null) => {
    orchestratorControlsReturnFocusRef.current = returnFocus;
    setOrchestratorControlsOpen(true);
  }, []);
  // A composer the session cannot send from reads as paused (#2154): its permission, Plan and model
  // controls stay in the bar, disabled, with the reason it cannot send. Each refusal is per command,
  // so a person refused only prompts keeps the configuration they are allowed (#1857).
  const composerControlsDisabledReason = configRefusal ??
    (promptRefusal === null ? promptUnavailableReason : null);
  const composerUnavailableId = `composer-unavailable-${session.id}`;
  // A composer that can no longer send stops listening (#2154, #2193): a disabled mic never sees the
  // tap or release that would have ended it.
  const stopDictation = dictation.stop;
  useEffect(() => {
    if (!canPrompt && dictation.recording) stopDictation();
  }, [canPrompt, dictation.recording, stopDictation]);
  // Dictation lives as long as the mic that shows it (#2193). Whatever removes the mic — Answer Mode
  // replacing the bar, the Inbox collapsing the session to its preview — cancels dictation rather
  // than leave it listening unseen, where a late phrase would rewrite a hidden draft or reopen the
  // ordinary composer mid-answer. A new session's composer starts without it too.
  const cancelDictation = dictation.cancel;
  const micRef = useCallback((mic: HTMLButtonElement | null) => {
    if (!mic) return;
    return () => cancelDictation();
  }, [cancelDictation]);
  useEffect(() => cancelDictation, [session.id, cancelDictation]);
  // Opening a queued edit, or leaving one (Save, Cancel Edit, Dismiss Recovery), swaps the draft the
  // words go into: dictation ends with the draft it was writing, so no unsettled phrase lands in the
  // other one.
  const queuedEditPromptId = queuedEdit?.promptId ?? null;
  useEffect(() => cancelDictation, [queuedEditPromptId, cancelDictation]);
  // A phone's side panel sheet hides the composer, mic included (#2843), and so does an expanded
  // panel on desktop (#2845): either ends dictation, so no phrase lands in a draft nobody can see.
  const composerHiddenByPanel = phonePanelOpen || (mode === "expanded" && rightPanel.open && rightPanel.expanded);
  useEffect(() => {
    if (composerHiddenByPanel) cancelDictation();
  }, [composerHiddenByPanel, cancelDictation]);
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
  // The Guardrails dialog (#2175) waits for its one request, so a refused or failed save stays in
  // the dialog instead of being fired and forgotten. A saved change joins the pending configuration
  // the next prompt carries, as applyConfig's changes do.
  const saveGuardrails = useCallback(
    async (patch: Partial<SessionConfig>) => {
      if (configRefusal !== null) throw new Error(configRefusal);
      await api.setConfig(sessionId, patch);
      pendingConfig.current = { ...pendingConfig.current, ...patch };
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

  /** A send or steer of a copy settled. The stored edit ends only when the send was accepted and no
   * newer copy has replaced it. This view then follows the store and never writes it: by now it may
   * be an unmounted view whose idea of the copy is older than the store's. */
  const settleSentEditCopy = (copy: ComposerEditCopy | null, accepted: boolean) => {
    if (!copy) return;
    finishComposerEditCopySend(sessionId, instanceScope, copy.id, accepted);
    if (!accepted || editCopyRef.current?.id !== copy.id) return;
    const stored = loadComposerEditCopy(sessionId, instanceScope);
    editCopyRef.current = stored;
    setEditCopyState(stored);
  };
  const send = async ({ asText = false }: ComposerSubmitOptions = {}) => {
    if (composerMutationRegistry.has(mutationKey) || stopTurnPendingRef.current || retitleInFlightRef.current) return;
    // Sending ends dictation first (#2193) and drops what the engine has not settled: a phrase
    // landing while the request is in flight would join the sent text or be lost to restoration.
    dictation.cancel();
    const text = composerText.text;
    const outgoing = text.trim();
    let invocation: ComposerCommandResolution = asText
      ? { kind: "plaintext", text: outgoing }
      : resolveComposerCommandInvocation(outgoing, composerCommands, composerCommandResolutionOptions);
    // An unknown command is never sent (#2176): the draft, its attachments and the caret stay, and
    // the notice slot says why and offers the close match and Send as Text.
    if (invocation.kind === "unknown") {
      showCommandNotSent({ kind: "unknown", token: invocation.token, suggestionId: invocation.suggestions[0]?.id }, "send");
      return;
    }
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
        showCommandNotSent({
          kind: "unavailable",
          token: invocation.command.label,
          reason: invocation.command.disabledReason ?? "This command isn't available in this session.",
        }, "send");
        return;
      }
      if (images.length && invocation.command.attachmentPolicy === "forbid") {
        setError(`${invocation.command.label} can't run with attachments. Remove them to run it.`, "Command Not Run");
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
            setError("/respond doesn't take an answer. Send /respond on its own to answer in Answer Mode.", "Command Not Run");
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
          setError(`${invocation.command.label} can't run here.`, "Command Not Run");
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
      reportAttachmentProblem({ kind: "model-refuses-images", modelName: selectedModelName });
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
    // Sending the copy ends the edit once the send is accepted. Until then the edit, and Discard
    // Edit's way back, stay stored, so a send that fails after the view has gone keeps them.
    const submittedCopy = editCopyRef.current;
    if (submittedCopy) markComposerEditCopySending(sessionId, instanceScope, submittedCopy.id);
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
      setPending({ text: invocation.kind === "plaintext" ? invocation.text : outgoing, images: outgoingImages });
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
      // Plain text is sent as resolved: an escaped `//x` or `\/x` goes as `/x`.
      const promptText = invocation.kind === "command" ? invocation.arguments : invocation.text;
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
        const prompted = await api.prompt(sessionId, promptText, outgoingImages, cfg, slashCommand,
          outstandingSessionResult(session)?.revision);
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
      if (viewGenerationRef.current === generation) clearComposerErrors();
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
          showComposerError("action", messageNotSent(e, runnerDisp.name || undefined,
            composerDraftVersionRef.current === submissionVersion
              ? { action: asText ? "sendAsText" : "send", draft: submittedDraft }
              : undefined));
          setPending(null); // send failed — retract the optimistic bubble
        }
      }
    } finally {
      settleSentEditCopy(submittedCopy, providerAccepted);
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

  const steerDraft = async ({ asText = false }: ComposerSubmitOptions = {}) => {
    // Direct steering posts to the same route as queued steering, so it follows that verdict (#1857).
    if (composerMutationRegistry.has(mutationKey) || stopTurnPendingRef.current || !canSend) return;
    dictation.cancel();
    if (queueRefusal !== null) {
      setError(queueRefusal, "Message Not Sent");
      return;
    }
    if (!directSteeringAvailability.available) {
      setError(directSteeringAvailability.reason, "Message Not Sent");
      return;
    }
    // A command that resolves is steering content as typed, but an unknown one is never sent
    // (#2176), and an escaped `//x` steers as `/x`.
    const text = composerText.text;
    const resolved = asText ? null
      : resolveComposerCommandInvocation(text.trim(), composerCommands, composerCommandResolutionOptions);
    if (resolved?.kind === "unknown") {
      showCommandNotSent({ kind: "unknown", token: resolved.token, suggestionId: resolved.suggestions[0]?.id }, "steer");
      return;
    }
    const outgoing = resolved?.kind === "plaintext" ? resolved.text : text.trim();
    if (actualImages.length && !modelSupportsImages(sessionCaps, effectiveModel)) {
      reportAttachmentProblem({ kind: "model-refuses-images", modelName: selectedModelName });
      return;
    }

    const generation = viewGenerationRef.current;
    const submittedImages = images.map((image) => ({ ...image }));
    const submittedDraft = { text, images: submittedImages };
    const submissionVersion = composerDraftVersionRef.current;
    const mutation = reserveComposerMutation(mutationKey, "steer", submittedDraft);
    if (!mutation) return;
    const submittedCopy = editCopyRef.current;
    if (submittedCopy) markComposerEditCopySending(sessionId, instanceScope, submittedCopy.id);
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
        reviewedResultRevision: outstandingSessionResult(session)?.revision,
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
      if (viewGenerationRef.current === generation) clearComposerErrors();
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
        if (viewGenerationRef.current === generation) {
          showComposerError("action", messageNotSent(cause, runnerDisp.name || undefined,
            composerDraftVersionRef.current === submissionVersion
              ? { action: asText ? "steerAsText" : "steer", draft: submittedDraft }
              : undefined));
        }
      }
    } finally {
      settleSentEditCopy(submittedCopy, providerAccepted);
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
  composerRetryRef.current = {
    send: () => send(),
    steer: () => steerDraft(),
    sendAsText: () => send({ asText: true }),
    steerAsText: () => steerDraft({ asText: true }),
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
      if (viewGenerationRef.current === generation) showActionError("steerQueuedMessage", cause);
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
      // The recovered message replaces the displaced draft, which held any loaded copy, so that
      // copy's edit and Discard Edit go with it.
      updateEditCopy(null);
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
    dictation.cancel();
    // An edit opened before the person lost queue management is not sent (#1857).
    if (queueRefusal !== null) {
      setError(queueRefusal);
      return;
    }
    const submittedDraft = {
      text: composerText.text.trim(),
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
      if (viewGenerationRef.current === generation) {
        showActionError(action === "queue_again" ? "queueAgain" : "dismissSteering", cause);
      }
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
    if (!command.available) return;
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
    if (canStopTurn && cancelTurnRefusal === null && !shortcutLayerActive(document, false, e.nativeEvent) && matchesShortcut(e, "stop-turn")) {
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
    // steering content; it is not dispatched as an app or provider slash command, and an unknown
    // one is not sent at all (#2176).
    if (!shortcutLayerActive(document, false, e.nativeEvent) && matchesShortcut(e, "steer-turn")) {
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
      // Under an unknown command the arrows walk its Close Matches, and Enter or Tab inserts the one
      // they reached. Until then Enter goes on to `send`, which refuses the token and says so in the
      // notice slot, and Tab leaves the composer.
      if (slashUnknown) {
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && plainKey && slashCloseMatches.length && slashTrigger) {
          e.preventDefault();
          const next = stepComposerCommandId(selectedSlashCommandId, slashCloseMatches, e.key === "ArrowDown" ? 1 : -1);
          setActiveCloseMatch(next ? { token: slashTrigger.raw, id: next } : null);
          return;
        }
        if ((e.key === "Tab" || e.key === "Enter") && plainKey && selectedCloseMatch) {
          e.preventDefault();
          insertSlashCommand(selectedCloseMatch);
          return;
        }
      }
      // The no-match row of a session that still sends an unknown token as text has nothing to move
      // to or choose: Enter sends the text as typed, and Tab leaves the composer.
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && plainKey && slashMatches.length) {
        e.preventDefault();
        setActiveSlashCommandId(stepComposerCommandId(selectedSlashCommandId, slashMatches,
          e.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if ((e.key === "Tab" || e.key === "Enter") && plainKey && selectedSlashCommand) {
        e.preventDefault();
        commitSlashCommand(selectedSlashCommand);
        return;
      }
      // Every match is unavailable, and an unavailable row is never chosen: Enter goes on to `send`,
      // which refuses a command typed in full with its reason (#2176), and Tab stays in the composer.
      if (e.key === "Tab" && plainKey && slashMatches.length) {
        e.preventDefault();
        return;
      }
    }
    // Escape ends dictation first: it is the layer on top, beneath only the pickers it would close
    // first (§16.2, #2193). A second Escape then reaches an open queued edit.
    if (dictation.recording && e.key === "Escape" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      dictation.stop();
      return;
    }
    // With no picker open, Escape cancels an open edit as Cancel Edit does. A recovered edit is the
    // only copy of its content, so Escape never dismisses it; it keeps its ordinary meaning there.
    if (queuedEdit && !queuedEditRecovered && !queuedEditBusy && e.key === "Escape" &&
        !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      cancelQueuedPromptEdit();
      return;
    }
    // ↑/↓ recall previous prompts (palette closed, no modifiers). ↑ engages only when the box is
    // empty or already browsing history, so a multi-line draft's caret navigation isn't hijacked.
    // Alt+↑/↓ is Session Reading's Previous/Next Session, never a recall.
    if (!queuedEdit && !paletteOpen && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && userPrompts.length) {
      if (e.key === "ArrowUp" && (histIdx !== -1 || composerText.text === "")) {
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
  // The last docked request can resolve while the coordinator tracks a different primary request (a
  // worker's), so it never sees the dock's focused control go. The dock's own hand-off (to the next
  // request's heading) needs a dock; with none left, focus returns to the composer or the reader.
  // A preview docks its requests above the reading column rather than in it (#2210).
  const dockHadRequestsRef = useRef(false);
  const dockFocusRemoved = useRemovedFocus(mode === "expanded" ? chatReadingRef : detailChatRef, '[data-request-card-menu="dock"]');
  // A question answered in the composer is shown there alone (#2212).
  const dockShownRequests = useMemo(() => answeringInComposer
    ? dockedRequests.filter((request) => request.requestId !== pendingQuestion.requestId)
    : dockedRequests, [answeringInComposer, dockedRequests, pendingQuestion?.requestId]);
  // Composer Response answers the session's question in the composer, so its card is compact. A
  // preview has no composer: its question is the preview's own card, answered in the session (#2210).
  const dockComposerAnswer = useMemo(() => mode === "expanded" && questionResponseStyle === "composer" &&
    pendingQuestion && composerQuestions.length > 0 ? { requestId: pendingQuestion.requestId, onAnswer: enterAnswerMode } : undefined,
  [composerQuestions.length, enterAnswerMode, mode, pendingQuestion, questionResponseStyle]);
  useLayoutEffect(() => {
    const had = dockHadRequestsRef.current;
    dockHadRequestsRef.current = dockShownRequests.length > 0;
    if (!dockFocusRemoved() || !had || dockShownRequests.length > 0) return;
    if (mode === "expanded" && focusComposerAfterRequestResolution()) return;
    const composer = inputRef.current;
    (composer && !composer.disabled && mode === "expanded" ? composer : scrollRef.current)?.focus();
  });

  // The request dock (#2179), as the notice slot's lead while the session has a request of its own.
  const requestDockLead: SessionNoticeLead | undefined = dockShownRequests.length > 0 ? {
    key: "request-dock",
    title: pendingRequestsTitle(dockShownRequests.length),
    icon: <RequestKindIcon request={dockShownRequests[0]!} />,
    requestIds: dockShownRequests.map((request) => request.requestId),
    render: ({ trailing, revealRequestId, concealTrailing }) => (
      <RequestDock
        session={session}
        requests={dockShownRequests}
        runnerOnline={runnerOnline}
        owner={sessionAgentLabel(session.agentName, session.driver, session.agentId)}
        createdAt={requestCreatedAt}
        headTrailing={trailing}
        onSessionUpdate={loadSession}
        // A and D reach the card from the session's reader and, in a preview, from the Sessions list.
        showKeyHints={!isMobile}
        keyboardOpen={softwareKeyboardOpen}
        revealRequestId={revealRequestId}
        // Above a preview's reader, reading back has no rows under the card to give height back to,
        // so the card never shrinks to its strip there.
        followTailState={mode === "expanded" ? followTail.state : undefined}
        readerRef={scrollRef}
        onConceal={concealTrailing}
        questionsFor={dockQuestions}
        whereAsked={mode === "expanded" ? dockWhereAsked : undefined}
        onAnswerInSession={mode === "preview" ? onOpenRequest : undefined}
        readingAvailable={mode === "expanded"}
        composerAnswer={dockComposerAnswer}
      />
    ),
  } : undefined;

  // On a phone a summary row that opens the right panel closes the sheet, since only one overlay is
  // open at a time (#2147). The row that had focus is gone with the sheet, so focus follows it into
  // the panel; the sheet's Close and Escape still return it to the toggle.
  const focusPanelAfterSheetRef = useRef(false);
  const summaryToggleRef = pinnedSummary?.toggleRef;
  const sheetReturnFocusRef = useMemo(() => ({
    get current(): HTMLElement | null {
      if (focusPanelAfterSheetRef.current) {
        focusPanelAfterSheetRef.current = false;
        const panelControl = document.querySelector<HTMLElement>("#right-panel .rpanel-switcher");
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
      onOpenOrchestratorControls={() => openOrchestratorControls(
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
      )}
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
      {/* Reports each render of this view itself, never one of the transcript alone (#2763). */}
      <Profiler id={SESSION_DETAIL_PROBE} onRender={reportRenderProbe} />
      {mode === "expanded" && <MarkSessionSeen sessionId={sessionId} instanceScope={instanceScope} />}
      {mode === "expanded" ? (
        <>
        <SessionHeader
          session={session}
          covered={phonePanelOpen}
          runnerOnline={runnerOnline}
          machineName={runnerDisp.name}
          machineAccounts={runner?.providerAccounts}
          onOpenConnections={() => navigate({ name: "runners", section: "machines" })}
          runnerProtocolVersion={runner?.protocolVersion}
          stopBeforeArchiveSupported={stopBeforeArchiveSupported}
          sessionRoleConversionSupported={sessionRoleConversionSupported}
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
          restartBlockedReason={retryingTurnPromptId !== undefined ? TURN_RETRY_IN_FLIGHT_REASON : undefined}
          onRestartPendingChange={setHeaderRestartPending}
          onRestarted={loadSession}
          activeSubagents={activeWorkerCount ? {
            count: activeWorkerCount,
            workers: true,
            onOpen: () => rightPanel.show("subagents"),
          } : undefined}
          childRequests={{ count: humanDescendantRequests, onOpen: openChildRequests }}
          onOpenBackgroundWork={() => rightPanel.show("background")}
          onOpenAttention={() => {
            restoreExpandedPanel();
            // The top request is answered on the dock when it is the session's own.
            const top = prioritizedRequests[0];
            if (top && dockedRequests.includes(top)) {
              reviewPendingRequest(top.requestId);
              return;
            }
            const requests = pendingRequests(session.pendingApproval);
            if (requests.length > 1) {
              navigate({ name: "session", id: session.id, attention: {
                eventEpoch: session.eventEpoch ?? 0,
              } });
              return;
            }
            if (requests.length === 0 && (session.orchestratorCampaign?.pendingRequests?.human ?? 0) > 0) {
              openChildRequests();
              return;
            }
            // Each activation is handled against the known request, including a repeated press.
            navigate({ name: "session", id: session.id, attention: {
              eventEpoch: session.eventEpoch ?? 0,
              ...(requests.length === 1 ? { requestId: requests[0]!.requestId } : {}),
            } });
          }}
          // The unified bar replaces the app-level top bar on desktop, so it owns the page-title
          // focus-rescue anchor there; the mobile layout keeps the app bar and its own anchor.
          titleId={!isMobile ? "page-title" : undefined}
        />
        </>
      ) : (
        <>
        <SessionPreviewBar
          session={session}
          runnerOnline={runnerOnline}
          machineName={runnerDisp.name}
          agentLabel={sessionAgentLabel(session.agentName, session.driver, session.agentId)}
          archiveLabel={sessionArchiveControlLabel(session, stopBeforeArchiveSupported)}
          onSnooze={onSnooze}
          onArchive={onArchive}
          onSessionMenu={onSessionMenu}
          onOpen={onExpand}
        />
        </>
      )}

      {/* Chat column + the Codex-style right side panel. The panel's open/mode/width state
          lives at the app shell (survives navigation); its per-session bodies (e.g. the Files
          browser) reset with SessionDetail's own session-id key. */}
      <div className="detail-columns">
        {/* The session body: the reader column, then the docked Pinned Summary (#2147). It is the
            `session-body` container, so docking follows the room the right panel leaves. A phone's
            side panel sheet covers it, so it is inert while the sheet is open (#2888). */}
        <div className="detail-body" ref={setDetailBody} inert={phonePanelOpen || undefined}>
        <div className="detail-chat" ref={detailChatRef}>
          {/* A preview has no composer to dock above, so its requests head the preview, right under
              the meta line, where Approve and Deny sit under the cursor that selected the row (#2210). */}
          {mode === "preview" && requestDockLead && (
            <SessionNoticeSlot
              sessionId={session.id}
              entries={[]}
              lead={requestDockLead}
              onFocusLost={() => scrollRef.current?.focus({ preventScroll: true })}
            />
          )}
          {/* Campaign notices, not session notices (§13.2; #2036): they describe the campaign, not
              whether this session can take its next turn, so they head the chat column directly
              under the session bar, in this order, on its edges (#2157), rather than in the notice
              slot above the composer. */}
          {mode === "expanded" && (session.orchestratorCampaign?.continuation || heldChildren.length > 0) && (
            <div className="campaign-notices">
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
            </div>
          )}
          {/* Inside the CHAT COLUMN (not .session-detail) so the card centers against the
              same width the transcript and composer use — with the right panel open, a
              session-wide card would sit visibly off-axis from the column it belongs to. */}
          <SessionApprovalRegion
            session={session}
            runnerOnline={runnerOnline}
            fallbackFocusRef={mode === "expanded" ? inputRef : scrollRef}
            alternateFallbackFocusRef={mode === "expanded" ? scrollRef : undefined}
            onFallbackFocus={mode === "expanded" ? focusComposerAfterRequestResolution : undefined}
          />
          {/* The reading column (#2179): the transcript, then the request dock directly above the
              composer. The dock caps at a share of this column, so the transcript keeps at least
              half of it (§13.2). */}
          <div className="chat-reading" ref={chatReadingRef}>
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
                <LiveTranscriptHistoryNotice
                  sessionId={sessionId}
                  kind={transcript.notice}
                  error={transcript.error}
                  machine={runnerDisp.name || undefined}
                  machineOffline={runner?.status === "offline"}
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
                if (!isReaderInput(event)) return;
                if (event.deltaY < 0) {
                  markSingleEarlierActivityIntent();
                  if (!nestedScrollerConsumesUpwardInput(event.target, event.currentTarget)) {
                    requestEarlierFromInputAtHead();
                  }
                }
                followTail.onWheel(event);
              }}
              onPointerDown={(event) => {
                if (!isReaderInput(event)) return;
                if (event.pointerType === "touch") {
                  markTouchPointerEarlierActivityIntent(event);
                  // A touch pauses following on the press, as its touchstart does. A drag the
                  // floating tail control hands over (#2425) arrives as pointer events only.
                  followTail.onTouchPointerDown(event);
                } else markPointerEarlierActivityIntent(event.currentTarget);
              }}
              onPointerMove={(event) => {
                if (!isReaderInput(event)) return;
                if (event.pointerType === "touch") {
                  markTouchEarlierActivityMovement(event.clientY);
                  requestEarlierFromTouchAtHead(event.clientY, event.target);
                  // The press already paused; a drag that reaches the tail must be able to resume.
                  return;
                }
                followTail.onPointerMove(event);
              }}
              onTouchStart={(event) => {
                if (!isReaderInput(event)) return;
                markNativeTouchEarlierActivityIntent(event.nativeEvent);
                followTail.onTouchStart(event.nativeEvent);
              }}
              onTouchMove={(event) => {
                if (!isReaderInput(event)) return;
                const clientY = event.touches[0]?.clientY ?? null;
                markTouchEarlierActivityMovement(clientY);
                requestEarlierFromTouchAtHead(clientY, event.target);
              }}
              onKeyDown={(event) => {
                if (event.defaultPrevented || !isReaderInput(event)) return;
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
              <TranscriptErrorAlert
                historyKey={timelineHistoryKey}
                items={items}
                ready={openingHistoryFillSettled}
              />
              {transcript.body === "skeleton" ? (
                <LiveTranscriptSkeleton sessionId={sessionId} />
              ) : transcript.body === "unavailable" ? (
                // A failed load is the history notice above, alone (#2172); only a disconnected or
                // unpaired device with nothing cached still needs a state here.
                !transcript.error && (
                  <State variant="offline" title={conn === "unauthorized" ? "Pair to Load Activity" : "Activity Unavailable"}>
                    {conn === "offline" ? "Reconnect to load this transcript." : "Pair this device with Wollipog to load this transcript."}
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
                    <Profiler id={SESSION_VIEW_PROBE} onRender={reportRenderProbe}>
                      <ProfiledEventTimeline
                        driver={session.driver}
                        items={timelineItems}
                        itemsDerivedFrom={evs}
                        liveSessionId={sessionId}
                        sessionActive={isTimelineSessionActive(session.status) ||
                          (eventWindow?.openingStartSeq !== undefined && eventWindow.laterGap !== undefined)}
                        onOpenSubagent={mode === "expanded" ? openSubagent : undefined}
                        onOpenSourceLocation={openSourceLocation}
                        onOpenInReview={mode === "expanded" ? openInReview : undefined}
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
                        turnRetry={mode === "expanded" ? turnRetry : undefined}
                        onEditAndResend={mode === "expanded" ? openResendAction : undefined}
                        editAndResendUnavailableReason={promptUnavailableReason ?? undefined}
                        onEditInFork={mode === "expanded" ? openForkEditAction : undefined}
                        editInForkAvailabilityByItem={mode === "expanded" ? editInForkAvailabilityByItem : undefined}
                        forkAvailabilityByTurn={mode === "expanded" ? forkAvailabilityByTurn : undefined}
                        revealRequest={timelineRevealRequest}
                        onRevealHandled={handleTimelineReveal}
                        questionContext={timelineQuestionContext}
                      />
                    </Profiler>
                  )}
                </>
              )}
              {/* One place for every transcript state, so a pending prompt or receipt never remounts
                  (and drops the focus it holds) when history arrives; while history loads or fails, a
                  failed message and the recovery receipts still keep their actions (#2171, #2500). */}
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
                          <ReadonlyReferenceChip key={reference.artifactId} reference={reference} />
                        ))}
                      </div>
                    )}
                    {pending.text && <div className="bubble-text"><Markdown profile="inline">{pending.text}</Markdown></div>}
                  </div>
                </div>
              )}
              {sentMessageReceipts}
              {transcriptRowsShown && activeTurnVisible && (
                <WorkingIndicator
                  label={workingLabel}
                  progress={activeTurnProgress}
                  onRevealCurrentOperation={revealCurrentOperation}
                  onOpenSubagent={mode === "expanded" ? openSubagent : undefined}
                  onReviewPendingRequest={reviewPendingRequest}
                  liveActivitySessionId={sessionId}
                />
              )}
            </div>
            </div>
            {/* The one floating control at the reader's lower edge (#2153), where the newest
                activity is (#56: a top-only recovery notice read as "frozen"). Its anchor takes no
                height, so the control can come and go without moving the reader. */}
            <TranscriptTailControl
              view={eventWindow?.laterGap && tailView?.kind === "jump" ? null : tailView}
              shortcut={isMobile
                ? null
                : shortcutDisplay(mode === "preview" ? "inbox-follow-latest-end" : "session-reading-latest-end")}
              readerRef={scrollRef}
              onJump={followTail.follow}
              onShowNotSent={showFirstUndelivered}
              onFocusLost={keepFocusInReader}
            />
            <LaterActivityControl gap={eventWindow?.laterGap} onLoad={loadLater}
              onJump={followTail.follow} onFocusLost={keepFocusInReader} />
            {/* The one polite live region for recovery, whatever the control is showing. */}
            <span className="sr-only" role="status" data-transcript-recovery-status>{recoveryAnnouncement}</span>
          </div>
          {/* While a request is pending it takes the notice slot ahead of every notice, which wait
              behind the "+N More" in its card's head line (§13.2). */}
          {mode === "expanded" && requestDockLead && (
            <SessionNoticeSlot
              sessionId={session.id}
              entries={sessionNotices}
              lead={requestDockLead}
              onFocusLost={focusComposerOrTitle}
            />
          )}
          </div>

          {/* A phone's side panel is a full-screen sheet; while it is open the composer is hidden
              (no box, out of the accessibility tree), so nothing covers a field the panel is editing
              (#2843). It stays mounted: Answer Mode keeps a secret answer only in its own state. */}
          {mode === "expanded" && (
            <div
              className="composer"
              hidden={phonePanelOpen}
              onFocusCapture={() => setActivePane("composer")}
              onPointerDownCapture={() => setActivePane("composer")}
            >
            {/* The one notice slot (§13.2): the most severe session condition, the rest behind
                "+N More". Session notices are entries of it, never banners of their own. */}
            {!requestDockLead && (
              <SessionNoticeSlot sessionId={session.id} entries={sessionNotices} onFocusLost={focusComposerOrTitle} />
            )}
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
            <QueuedMessages
              sessionId={session.id}
              prompts={queuedPromptControls}
              queueHeld={session.queueHeld === true}
              agent={composerAgent}
              steering={steeringAvailabilityInput}
              requestBusy={composerRequestBusy}
              refusal={queueRefusal}
              steeringPending={queueSteeringPending}
              editingPromptId={queuedEdit?.promptId ?? null}
              editOpen={queuedEdit !== null}
              pendingAction={pendingPromptAction}
              onSteer={(prompt) => void promoteQueuedPrompt(prompt)}
              onEdit={(prompt) => void beginQueuedPromptEdit(prompt)}
              onCancel={(prompt) => void api.cancelQueuedPrompt(session.id, prompt.id)
                .catch((cause: unknown) => showActionError("cancelQueuedMessage", cause))}
              onDismiss={(prompt) => void resolvePendingPrompt(prompt.id, "dismiss")}
              onFocusLost={focusComposerOrTitle}
            />
            <div
              ref={composerBoxRef}
              className={`composer-box${dragActive ? imagesRefused ? " is-drop is-refused" : " is-drop" : ""}${composerAnswerActive ? " answer-mode" : ""}${composerIdleCollapsed ? " idle-collapsed" : ""}${canPrompt ? "" : " is-disabled"}`}
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
                // Only files make the card a drop target; dragged text is the textarea's own.
                if (!canPrompt || composerAnswerActive || !Array.from(e.dataTransfer.types).includes("Files")) return;
                e.preventDefault();
                dragDepth.current += 1; // dragenter/leave fire per child; count so leaving a child doesn't clear
                setDropImageCount(Array.from(e.dataTransfer.items)
                  .filter((item) => item.kind === "file" && item.type.startsWith("image/")).length);
              }}
              onDragOver={(e) => {
                if (canPrompt && !composerAnswerActive) e.preventDefault(); // required for the element to be a valid drop target
              }}
              onDragLeave={() => {
                if (dragDepth.current === 0) return;
                dragDepth.current -= 1;
                if (dragDepth.current === 0) setDropImageCount(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                dragDepth.current = 0;
                setDropImageCount(null);
                if (!canPrompt || composerAnswerActive) return;
                const files = Array.from(e.dataTransfer.files);
                if (files.length) void addFiles(files);
              }}
            >
              {queuedEdit && !composerAnswerActive && (
                /* Editing is a mode of the card (#2194): a 40px strip at its top names the mode and
                   holds the way out. The tray marks which row is being edited, so this doesn't. */
                <div className={`composer-mode${queuedEditRecovered ? " is-recovered" : ""}`} role="status">
                  <span className="composer-mode-icon" aria-hidden="true">
                    {queuedEditRecovered ? <WarningIcon size={16} /> : <EditIcon size={16} />}
                  </span>
                  <span className="composer-mode-label">
                    <span className="composer-mode-title">
                      {queuedEditRecovered ? "Recovered Queued Message" : "Editing Queued Message"}
                    </span>
                    {queuedEditRetryable && (
                      <span className="shortcut-hint" aria-hidden="true">
                        <kbd>{enterKeySetting === "send" ? "Enter" : isMacPlatform() ? "⇧Enter" : "Shift+Enter"}</kbd>
                        <span className="shortcut-hint-label">Save</span>
                      </span>
                    )}
                  </span>
                  <span className="composer-mode-actions">
                    {queuedEditRecovered && (
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={queuedEditBusy}
                        onClick={() => void useRecoveredQueuedEditAsNewMessage()}
                      >
                        Use as New Message
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={queuedEditBusy}
                      onClick={cancelQueuedPromptEdit}
                    >
                      {queuedEditRecovered ? "Dismiss Recovery" : "Cancel Edit"}
                    </button>
                  </span>
                  {queuedEditRecoveryReason !== null && (
                    <p className="composer-mode-reason" id={`queued-edit-reason-${session.id}`}>
                      {queuedEditRecoveryReason}
                    </p>
                  )}
                </div>
              )}
              {pendingQuestion && (
                <ComposerQuestionResponse
                  sessionId={session.id}
                  requestId={pendingQuestion.requestId}
                  occurrenceId={pendingQuestion.occurrenceId}
                  requestedAt={pendingQuestion.requestedAt}
                  recoveryId={pendingQuestion.recoveryId}
                  isAsync={pendingQuestion.async}
                  questions={composerQuestions}
                  runnerOnline={runnerOnline}
                  active={composerAnswerActive}
                  inputRef={answerInputRef}
                  revealRef={answerRevealRef}
                  recovery={pendingQuestion.recoveryReason === "provider_restart"}
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
              {paletteOpen && (
                <SlashCommandMenu
                  listboxId={slashListboxId}
                  commands={slashMatches}
                  query={slashTrigger?.raw ?? ""}
                  activeCommandId={selectedSlashCommandId}
                  hasAttachments={images.length > 0}
                  onActiveCommandChange={(commandId) => slashUnknown
                    ? setActiveCloseMatch(slashTrigger ? { token: slashTrigger.raw, id: commandId } : null)
                    : setActiveSlashCommandId(commandId)}
                  onSelectCommand={commitSlashCommand}
                  unknown={slashUnknown ? {
                    suggestions: slashCloseMatches,
                    onSendAsText: () => void send({ asText: true }),
                    sendAsTextDisabled: composerRequestBusy,
                  } : undefined}
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
                  workspaceName={session.workspaceName || session.projectName || "this workspace"}
                  machineName={runnerDisp.name || "This machine"}
                  machineOnline={runnerOnline}
                  onSelect={selectWorkspaceCandidate}
                  onActiveIndexChange={setActiveWorkspaceResult}
                />
              )}
              <ComposerAttachments
                images={images}
                onRemove={(i, control) => {
                  remove(i);
                  keepFocusInComposer(control);
                }}
                onInspectReference={(reference, opener) => {
                  workspaceReferenceReturnFocusRef.current = opener;
                  setInspectedWorkspaceReference(reference);
                }}
                onImageBroken={reportBrokenImage}
              />
              {composerReplyKeycap && (
                /* The Reply shortcut's hint (§11.5): a keycap at the end of the idle composer's
                   placeholder row. It takes no height, so it can come and go without moving the
                   textarea; the global coarse-pointer rule hides the keycap itself. */
                <div className="composer-reply-hint" aria-hidden="true">
                  <kbd>{shortcutDisplay("session-reading-reply")}</kbd>
                </div>
              )}
              <ComposerTextarea
                store={composerText}
                ref={inputRef}
                onTextCommitted={handleComposerTextCommitted}
                className="composer-input"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={paletteOpen || workspacePickerOpen}
                aria-busy={steeringRequestBusy || retitlePending || undefined}
                aria-controls={workspacePickerOpen ? workspaceListboxId : paletteOpen ? slashListboxId : undefined}
                aria-activedescendant={workspacePickerOpen && workspaceResults[activeWorkspaceResult]
                  ? workspaceReferenceOptionId(workspaceListboxId, activeWorkspaceResult)
                  : paletteOpen && selectedSlashCommandId
                    ? slashCommandOptionId(slashListboxId, selectedSlashCommandId)
                    : undefined}
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
                  // A changed draft is a new message: the composer's notices were about the old one.
                  // The resets below are skipped when there is nothing to reset, so a keystroke
                  // renders the textarea alone rather than this whole view (#2764). The errors are
                  // cleared through their updater instead, which leaves an empty set untouched and
                  // still sees one queued since this view last rendered (a paste's refusal).
                  clearComposerErrors();
                  setText(e.currentTarget.value);
                  updateComposerSelection(
                    e.currentTarget.selectionStart,
                    e.currentTarget.selectionEnd,
                  );
                  if (slashDismissedFor !== null) setSlashDismissedFor(null);
                  if (workspaceDismissedFor !== null) setWorkspaceDismissedFor(null);
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
                {dragActive && (
                  /* While files are over the card only this row changes: it says what a drop does,
                     and the draft and its attachments above stay in view (#2156). */
                  <div className="composer-drop-label" role="status">
                    {imagesRefused ? (
                      <>
                        <ImageOffIcon size={16} />
                        <span>{modelRefusesImages}</span>
                      </>
                    ) : dropImageCount
                      ? `Drop to attach ${dropImageCount} ${dropImageCount === 1 ? "image" : "images"}`
                      : "Drop images to attach"}
                  </div>
                )}
                {/* While the mic listens, the left group says so (#2193); the trailing group, the mic
                    and Send stay where they are. */}
                {dictation.recording && dictation.startedAt !== null ? (
                  <DictationStrip startedAt={dictation.startedAt} held={dictation.held} interim={dictation.interim} />
                ) : (
                <div className="cbar-left">
                  <ComposerPlusMenu
                    session={session}
                    planActive={planActive}
                    planSupported={planSupported}
                    onTogglePlan={togglePlan}
                    onSaveGuardrails={saveGuardrails}
                    configRefusal={configRefusal}
                    onOpenOrchestratorControls={openOrchestratorControls}
                    {...(workspaceReferencesSupported ? { onReferenceFile: insertWorkspaceReferenceTrigger } : {})}
                    disabled={!canPrompt}
                    {...(promptUnavailableReason !== null ? { disabledReason: promptUnavailableReason } : {})}
                    imageMimeTypes={allowedImageMimeTypes}
                    imagesRefusedReason={modelRefusesImages}
                    onAttachImages={addFiles}
                  />
                  <ComposerIdlePreview
                    store={composerText}
                    placeholder={composerIdlePlaceholder}
                    onClick={expandIdleComposer}
                  />
                  <ApprovalsControl session={session} apply={applyConfig} disabledReason={composerControlsDisabledReason} />
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
                  {/* After the model chip, so turning Plan on or off never moves the chip (#2174). */}
                  {planActive && (
                    <ComposerButton
                      className="plan-toggle"
                      aria-pressed="true"
                      disabled={composerControlsDisabledReason !== null}
                      onClick={(event) => {
                        togglePlan(false);
                        // The toggle unmounts with the mode it shows (#1913).
                        if (planSupported) keepFocusInComposer(event.currentTarget);
                      }}
                      aria-describedby={composerControlsDisabledReason !== null ? configRefusalId : undefined}
                      title={composerControlsDisabledReason !== null
                        ? `Plan mode is on. ${composerControlsDisabledReason}`
                        : "Plan mode is on: the agent researches and proposes without editing. Turn it off."}
                    >
                      <PlanIcon size={16} />
                      Plan
                    </ComposerButton>
                  )}
                  {composerControlsDisabledReason !== null && planActive && (
                    <span className="sr-only" id={configRefusalId}>{composerControlsDisabledReason}</span>
                  )}
                </div>
                )}
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
                    <ComposerButton
                      ref={micRef}
                      square
                      // A composer that cannot send takes no dictation either (#2154).
                      disabled={!canPrompt}
                      aria-describedby={canPrompt ? undefined : composerUnavailableId}
                      // A tap toggles and a hold is push-to-talk (#2193): the press starts or stops,
                      // releasing a hold stops, and a press that never completes (the browser took
                      // the touch, the mouse left) stops. Only a primary left-button press counts —
                      // a right-click's context menu swallows the pointerup on some platforms.
                      onPress={(e) => {
                        if (!e.isPrimary || e.button !== 0) return;
                        // The press keeps focus where it was, and the strip is about to replace the
                        // left group: a control there that holds focus (the model chip after its menu
                        // closed) would take it to the page body, where Escape no longer reaches
                        // dictation. Focus moves to the mic, which stays: its Escape stops dictation,
                        // and unlike the textarea it opens no phone keyboard (§16.2).
                        const mic = e.currentTarget;
                        const focused = mic.ownerDocument.activeElement;
                        if (!dictation.recording && focused instanceof HTMLElement && focused.closest(".cbar-left")) {
                          mic.focus({ preventScroll: true });
                        }
                        dictation.pressStart();
                      }}
                      onPointerUp={dictation.pressEnd}
                      onPointerCancel={dictation.pressCancel}
                      onPointerLeave={dictation.pressCancel}
                      // Enter, Space and assistive technology click without a pointer (detail 0);
                      // a pointer's own click has already been handled by its press.
                      onClick={(e) => {
                        if (e.detail === 0) dictation.toggle();
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Escape" || !dictation.recording) return;
                        e.preventDefault();
                        dictation.stop();
                      }}
                      title="Tap to dictate, or hold and release"
                      aria-label={dictation.recording ? "Stop Dictating" : "Dictate"}
                      aria-pressed={dictation.recording}
                    >
                      <MicIcon size={16} />
                    </ComposerButton>
                  )}
                  {/* One seat for the primary action: Send is the bar's only accent fill, Restart
                      takes its place on a stopped session, and Stop Turn is a neutral outlined
                      square during a turn, since red means "failed" (#2174). */}
                  {composerRestartOffered ? (
                    <ComposerButton
                      variant="primary"
                      square
                      onClick={() => void restartFromComposer()}
                      disabled={!runnerOnline || composerRequestBusy || restartRefusal !== null ||
                        retryingTurnPromptId !== undefined}
                      title={restartPending ? "Restarting Session" : restartRefusal ?? "Restart Session"}
                      aria-label={restartPending ? "Restarting Session" : "Restart Session"}
                    >
                      {restartPending ? <Spinner /> : <RefreshIcon size={16} />}
                    </ComposerButton>
                  ) : primaryComposerAction === "send" ? (
                    <ComposerButton
                      variant="primary"
                      square
                      // Focus stays in the textarea, which also keeps a phone keyboard open after
                      // sending: the chat convention.
                      onClick={queuedEdit ? saveQueuedPromptEdit : () => void send()}
                      disabled={!canSend || composerRequestBusy || (queuedEdit !== null && !queuedEditRetryable)}
                      title={queuedEdit
                        ? !queuedEditRetryable && queuedEditRecoveryReason !== null
                          ? queuedEditRecoveryReason
                          : enterKeySetting === "send"
                          ? "Save queued message (Enter)"
                          : isTouchPhone ? "Save queued message" : "Save queued message (Shift+Enter)"
                        : enterKeySetting === "send"
                          ? "Send (Enter)"
                          : isTouchPhone ? "Send" : "Send (Shift+Enter)"}
                      aria-label={queuedEdit ? "Save Queued Message" : "Send"}
                      // A recovered edit that can't be retried is disabled for the reason the strip
                      // shows, never only in this tooltip (§13.2).
                      aria-describedby={queuedEdit && !queuedEditRetryable && queuedEditRecoveryReason !== null
                        ? `queued-edit-reason-${session.id}`
                        : undefined}
                    >
                      {busy || queuedEditBusy
                        ? <Spinner />
                        : queuedEdit ? <CheckIcon size={16} /> : <ArrowUpIcon size={16} />}
                    </ComposerButton>
                  ) : (
                    <ComposerButton
                      variant="secondary"
                      square
                      className={`stop-turn-btn${primaryComposerAction === "stopping" ? " is-stopping" : ""}`}
                      onClick={() => void stopTurn()}
                      disabled={primaryComposerAction === "stopping" || cancelTurnRefusal !== null}
                      title={primaryComposerAction === "stopping"
                        ? "Stopping Turn"
                        : cancelTurnRefusal ?? `Stop turn (${shortcutDisplay("stop-turn")})`}
                      aria-label={primaryComposerAction === "stopping" ? "Stopping Turn" : "Stop Turn"}
                      aria-describedby={cancelTurnRefusal !== null ? `stop-turn-refusal-${session.id}` : undefined}
                    >
                      {primaryComposerAction === "stopping" ? <Spinner /> : <StopTurnIcon size={16} />}
                    </ComposerButton>
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
          attentionTarget={resolvedAttentionTarget}
          onOpenSourceLocation={openSourceLocation}
          onClearSourceLocation={clearSourceLocation}
          runnerOnline={runnerOnline}
          runnerProtocolVersion={runner?.protocolVersion}
          git={git}
          forge={reviewForgeFacts.forge}
          forgeFacts={reviewForgeFacts}
          onOpenTerminal={onOpenTerminal}
          onInsertSideChatDraft={insertSideChatDraft}
          onAttachWorkspaceReference={workspaceReferencesSupported ? attachWorkspaceTargetFromPanel : undefined}
          reviewFocus={reviewFocus}
          onReviewFocusHandled={clearReviewFocus}
          onOpenInReview={openInReview}
          items={items}
          decisionHistory={governanceAudit.history}
          decisionHistoryStatus={governanceAudit.status}
          onRetryDecisionHistory={governanceAudit.retry}
          decisionHistoryHasMore={governanceAudit.hasMore}
          decisionHistoryLoadingOlder={governanceAudit.loadingOlder}
          onLoadOlderDecisions={governanceAudit.loadOlder}
          transcriptItemForDecision={transcriptItemForDecision}
          onShowDecisionInTranscript={revealTranscriptItemFromPanel}
          descendantRequests={descendantRequests}
          descendantRequestStatus={descendantRequestStatus}
          campaignAvailability={campaignAvailability}
          onOpenSession={(id) => navigate({ name: "session", id })}
          selectedRequestKey={selectedRequestKey}
          onSelectedRequestKeyChange={setSelectedRequestKey}
          onDescendantsUpdate={refreshDescendantRequestsAfterResolution}
          onRetryDescendantRequests={refreshDescendantRequestsAfterResolution}
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
          onOpenParentTurn={revealTranscriptItemFromPanel}
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
      {orchestratorControlsOpen && sessionRole(session) === "orchestrator" && (
        <OrchestratorControlsDialog
          session={session}
          onClose={() => setOrchestratorControlsOpen(false)}
          onSessionChanged={loadSession}
          refusal={configRefusal}
          returnFocusRef={orchestratorControlsReturnFocusRef}
        />
      )}
      {mode === "expanded" && inspectedWorkspaceReference && (
        <WorkspaceReferenceDialog
          reference={inspectedWorkspaceReference}
          machineName={runner ? runnerDisp.name || null : null}
          onClose={() => setInspectedWorkspaceReference(null)}
          returnFocusRef={workspaceReferenceReturnFocusRef}
          onRemove={() => {
            // The chip goes with the reference, so focus moves to the message instead (#1913). On a
            // phone, removing the last attachment would collapse the idle composer and hide that
            // textarea, so the close commits with the composer revealed and the message takes focus
            // inside this click: the composer's pointer-transfer check, which runs after it, then
            // finds focus in the composer and keeps it open. A disabled composer can't take focus, so
            // it goes to Session Activity, as it does after the chip's own remove.
            const index = images.indexOf(inspectedWorkspaceReference);
            const input = inputRef.current;
            const target = input && !input.disabled ? input : scrollRef.current;
            workspaceReferenceReturnFocusRef.current = target;
            flushSync(() => {
              setComposerExpanded(true);
              if (index !== -1) remove(index);
              setInspectedWorkspaceReference(null);
            });
            target?.focus({ preventScroll: true });
          }}
          onOpenInFiles={inspectedWorkspaceReference.kind === "file" || inspectedWorkspaceReference.kind === "lines"
            ? () => {
              openSourceLocation({ path: inspectedWorkspaceReference.path, line: inspectedWorkspaceReference.startLine });
              rightPanel.show("files");
              setInspectedWorkspaceReference(null);
            }
            : undefined}
        />
      )}
      {handoffTurn !== null && <ConversationHandoffDialog agents={runner?.agents ?? []} sourceDriver={session.driver}
        sourceAgentId={session.agentId ?? undefined} machineName={runnerDisp.name || undefined}
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
    </div>
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

/**
 * Marks the open session seen as its activity time moves, so the inbox unread badge stays current.
 * Every streamed event moves that time, so this reads it itself rather than rendering the session
 * view for it (#2872).
 */
function MarkSessionSeen({ sessionId, instanceScope }: { sessionId: string; instanceScope: string }) {
  const lastEventAt = useStoreSelector((s) => s.sessions.get(sessionId)?.lastEventAt);
  useEffect(() => {
    const ts = lastEventAt ?? Date.now();
    saveSeen(markSeen(loadSeen(instanceScope), sessionId, ts), instanceScope);
  }, [instanceScope, sessionId, lastEventAt]);
  return null;
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

type CampaignContinuation = NonNullable<NonNullable<SessionView["orchestratorCampaign"]>["continuation"]>;

/** What each continuation state tells a person (#2157): a titled notice where someone must act, one
 * plain sentence where Wollipog is still working on it. The counts and the provider's error are
 * details, behind Show Details. */
function campaignContinuationCopy(continuation: CampaignContinuation): {
  tone: "warning" | "danger" | "neutral";
  title?: string;
  body: string;
} {
  const updates = `${continuation.pendingEvents} ${continuation.pendingEvents === 1 ? "update" : "updates"}`;
  switch (continuation.state) {
    case "missing_result":
      return {
        tone: "warning",
        title: "Update Result Missing",
        body: "The Orchestrator accepted an update but never reported a result. It won't be sent again automatically.",
      };
    case "failed":
      return continuation.canRetry === true
        ? {
            tone: "danger",
            title: "Couldn't Resume the Orchestrator",
            body: "Automatic retries stopped. Retry when the problem is fixed.",
          }
        : { tone: "warning", body: "Couldn't resume the Orchestrator. Wollipog will try again." };
    case "running":
      return { tone: "neutral", body: `The Orchestrator is working through ${updates}.` };
    case "held":
      return { tone: "neutral", body: "Updates are kept until the current hold clears." };
    default:
      return { tone: "neutral", body: `Catching up on ${updates} before the Orchestrator continues.` };
  }
}

export function CampaignContinuationNotice({
  continuation,
  acknowledgementPending = false,
  actionRefusal = null,
  onAcknowledge,
  onRetry,
}: {
  continuation: CampaignContinuation;
  acknowledgementPending?: boolean;
  /** Why the signed-in person may not resolve the continuation (#1857). */
  actionRefusal?: string | null;
  onAcknowledge?: (commandId: string) => void;
  onRetry?: (commandId: string) => void;
}) {
  const refusalId = `campaign-continuation-refusal-${useId().replace(/:/gu, "")}`;
  const copy = campaignContinuationCopy(continuation);
  const canAcknowledge = continuation.state === "missing_result" &&
    continuation.canAcknowledgeMissingResult === true && Boolean(continuation.commandId) && onAcknowledge;
  const canRetry = continuation.state === "failed" && continuation.canRetry === true &&
    Boolean(continuation.commandId) && onRetry;
  const refused = actionRefusal !== null && Boolean(canAcknowledge || canRetry);
  return (
    <Notice
      tone={copy.tone}
      compact={!copy.title}
      dataState={continuation.state}
      role="status"
      ariaLabel={copy.title}
      title={copy.title}
      actions={(canAcknowledge || canRetry) && (
        <>
          {canAcknowledge && (
            <BusyButton
              className="btn sm"
              busy={acknowledgementPending}
              progress="Acknowledging the missing result…"
              disabled={actionRefusal !== null}
              aria-describedby={refused ? refusalId : undefined}
              onClick={() => onAcknowledge(continuation.commandId!)}
            >
              Acknowledge
            </BusyButton>
          )}
          {canRetry && (
            <BusyButton
              className="btn sm"
              busy={acknowledgementPending}
              progress="Retrying the Orchestrator…"
              disabled={actionRefusal !== null}
              aria-describedby={refused ? refusalId : undefined}
              onClick={() => onRetry(continuation.commandId!)}
            >
              Retry Now
            </BusyButton>
          )}
        </>
      )}
      details={(
        <dl className="facts">
          <div>
            <dt>Pending Updates</dt>
            <dd>{continuation.pendingEvents}</dd>
          </div>
          <div>
            <dt>Attempt</dt>
            <dd>{continuation.attemptCount}</dd>
          </div>
          {continuation.error && (
            <div>
              <dt>Error</dt>
              <dd><div className="code-well"><code>{continuation.error}</code></div></dd>
            </div>
          )}
        </dl>
      )}
    >
      <p>{copy.body}</p>
      {refused && <p id={refusalId}>{actionRefusal}</p>}
    </Notice>
  );
}

/** The composer's + button: Attach and Settings, a plain menu (#2203). It adds to the message
 * (Attach Image…, Reference a File…), sets the mode (Plan Mode), and opens the session's limits
 * (Guardrails…, #2175) and an Orchestrator's controls (Orchestrator Controls…, #2192). Every row is a
 * menu item: the forms live in those dialogs, so the menu holds no field. */
export function ComposerPlusMenu({
  session,
  planActive,
  planSupported,
  onTogglePlan,
  onSaveGuardrails,
  configRefusal = null,
  onOpenOrchestratorControls,
  onReferenceFile,
  disabled,
  disabledReason = "This session cannot accept a prompt right now.",
  imageMimeTypes,
  imagesRefusedReason = modelRefusesImagesSentence(null),
  onAttachImages,
}: {
  session: SessionView;
  planActive: boolean;
  planSupported: boolean;
  onTogglePlan: (on?: boolean) => void;
  /** Sends the Guardrails dialog's changes in one configuration request; rejects on failure. */
  onSaveGuardrails: (patch: Partial<SessionConfig>) => Promise<void>;
  /** Why this person may not change the session's configuration (#1857): Plan Mode is disabled
   * with it, and Guardrails opens read-only. */
  configRefusal?: string | null;
  /** Opens Orchestrator Controls (#2192), returning focus to `returnFocus` when it closes. It opens
   * on a paused composer too: the dialog's controls refuse for a person refused configuration. */
  onOpenOrchestratorControls?: (returnFocus: HTMLElement | null) => void;
  /** Inserts "@" at the composer's caret and focuses it, which opens the @ picker. Present only when
   * the runner supports workspace references; called inside the activating gesture, so a phone
   * keeps its keyboard. */
  onReferenceFile?: () => void;
  /** The composer cannot send. The menu still opens, so Guardrails can be read and changed while
   * the session is paused, stopped or read-only; only the rows that change the message or the mode
   * refuse. */
  disabled: boolean;
  /** Why the composer cannot send, shown under the rows that refuse while `disabled`. */
  disabledReason?: string;
  /** Exactly the types the connected runner and selected model accept; empty when images cannot be sent. */
  imageMimeTypes: readonly string[];
  /** Why images cannot be attached when `imageMimeTypes` is empty: the composer's one sentence for a
   * model without image input. */
  imagesRefusedReason?: string;
  onAttachImages: (files: File[]) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [guardrailsOpen, setGuardrailsOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "composer-plus-menu");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesSupported = imageMimeTypes.length > 0;
  // Plan Mode changes the configuration, so it refuses for the same reasons the bar's Plan toggle
  // does: a composer that cannot send, or a person refused configuration.
  const planRefusal = disabled ? disabledReason : configRefusal;
  // Attachment follows the composer, exactly as paste (a disabled textarea) and drop (its own
  // `canPrompt` guard) already do. `disabled` can flip while the menu — or the native chooser — is
  // already open, so the item and the change handler are gated separately.
  const canAttach = !disabled && imagesSupported;
  const referenceOffered = onReferenceFile !== undefined;
  const orchestratorOffered = sessionRole(session) === "orchestrator" && onOpenOrchestratorControls !== undefined;
  // A row can leave or refuse while the menu is open (the runner reconnects without workspace
  // references, the composer pauses): if it held focus, focus would drop to <body> with the menu
  // still open (or stay on a disabled row, as some browsers leave it), so it moves to the first item
  // that remains enabled.
  useLayoutEffect(() => {
    const surface = menu.menuRef.current;
    if (!open || !surface) return;
    const active = document.activeElement;
    const stranded = !active || active === document.body ||
      (surface.contains(active) && active instanceof HTMLButtonElement && active.disabled);
    if (!stranded) return;
    surface.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [open, menu.menuRef, referenceOffered, planSupported, orchestratorOffered, canAttach, planRefusal]);
  return (
    <div className="composer-plus">
      {/*
        The one image ingress that works on a phone: paste and drag-and-drop have no reliable
        mobile equivalent. Mounted OUTSIDE the `open &&` menu so activating the item can close the
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
      <ComposerButton
        ref={menu.triggerRef}
        square
        className="plus-btn"
        aria-label="Attach and Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu.menuId}
        title="Attach and Settings"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <PlusIcon size={16} />
      </ComposerButton>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Attach and Settings"
          width={320}
          boundary=".composer-box"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuItem
            icon={<ImageIcon size={16} />}
            description={!imagesSupported
              ? imagesRefusedReason
              : disabled
                ? disabledReason
                : attachImageDescription(imageMimeTypes, MAX_PROMPT_IMAGES)}
            disabled={!canAttach}
            onClick={() => {
              fileInputRef.current?.click();
              menu.close(true);
            }}
          >
            Attach Image…
          </MenuItem>
          {referenceOffered && (
            <MenuItem
              icon={<AtSignIcon size={16} />}
              description={disabled ? disabledReason : <>Attach a workspace file or folder. Or type <code>@</code>.</>}
              disabled={disabled}
              onClick={() => {
                // The composer takes focus here, inside the tap, so the menu must not hand it back
                // to +.
                onReferenceFile();
                menu.close(false);
              }}
            >
              Reference a File…
            </MenuItem>
          )}

          {planSupported && (
            <>
              <MenuSeparator />
              <MenuItem
                role="menuitemcheckbox"
                icon={<PlanIcon size={16} />}
                checked={planActive}
                description={planRefusal ?? <>Research and propose a plan without editing files. Or type <code>/plan</code>.</>}
                disabled={planRefusal !== null}
                onClick={() => {
                  onTogglePlan();
                  menu.close(true);
                }}
              >
                Plan Mode
              </MenuItem>
            </>
          )}

          <MenuSeparator />
          <MenuItem
            icon={<GuardrailsIcon size={16} />}
            description={guardrailSummary(session)}
            onClick={() => {
              menu.close(false);
              setGuardrailsOpen(true);
            }}
          >
            Guardrails…
          </MenuItem>
          {orchestratorOffered && (
            <MenuItem
              icon={<OrchestratorControlsIcon size={16} />}
              description={orchestratorControlsSummary(session)}
              onClick={() => {
                // The row goes with the menu, so the dialog returns focus to + instead.
                menu.close(false);
                onOpenOrchestratorControls(menu.triggerRef.current);
              }}
            >
              Orchestrator Controls…
            </MenuItem>
          )}
        </MenuSurface>
      )}
      {guardrailsOpen && (
        <GuardrailsDialog
          session={session}
          configRefusal={configRefusal}
          onSave={onSaveGuardrails}
          onClose={() => setGuardrailsOpen(false)}
          returnFocusRef={menu.triggerRef}
        />
      )}
    </div>
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
