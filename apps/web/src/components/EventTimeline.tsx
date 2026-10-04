import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { useShowAgentLogs } from "../agent-logs.js";
import type { AgentDriverKind, WorkflowArtifactView } from "@wollipog/protocol";
import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { isWorkspaceReference, normalizeSourcePath, type AgentQuestion, type PlanEntry, type SessionView, type SourceLocation } from "@wollipog/protocol";
import { type TurnUsage,
  groupTimeline,
  isCollapsibleWorkItem,
  isTurnActivity,
  mergeTurnUsage,
  SubagentTreeProjector,
  timelineBoundaryKey,
  timelineItemIsStreaming,
  timelineSnapshotDelta,
  withoutPromptFailedPrefix,
  type TimelineGroup,
  type TimelineItem,
  type TimelineSnapshotDelta,
} from "../timeline.js";
import { Markdown } from "./Markdown.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { describeTurnError } from "../turn-error.js";
import {
  MeasuredVirtualList,
  type VirtualRevealOutcome,
  type VirtualRevealRequest,
  type VirtualRowState,
  type VirtualScrollAnchor,
} from "./MeasuredVirtualList.js";
import { CopyButton } from "./common.js";
import { accountLabelText } from "../personal-identifiers.js";
import { GovernanceDecisionFacts } from "./GovernanceDecision.js";
import { AccountIcon, AgentLogIcon, BotIcon, ChevronRightIcon, CopyIcon, EditIcon, EditInForkIcon, FileEditIcon, HandOffIcon, NewFileIcon, PlanIcon, PlanInProgressIcon, PlanPendingIcon, RewindFilesIcon, StopTurnIcon, SuccessIcon, ThoughtIcon, ThreadForkIcon } from "./Icons.js";
import { diffFileIsPlain, diffMaxLineNumber, hunkLabel, parseUnifiedDiff, type DiffFile } from "../unified-diff.js";
import { markdownPlainText } from "./markdown-plain-text.js";
import { TranscriptActionMenu, transcriptActionAvailable, type TranscriptAction } from "./TranscriptActions.js";
import { useIsCoarsePointer } from "./useIsMobile.js";
import { formatClock, formatTokens, formatCost, formatDuration, formatRecordedRelativeTime, formatRecordedTimestamp, titleCaseLabel } from "../format.js";
import {
  activitySpanDescription,
  agentLogOnly,
  diffLineCounts,
  foldRetries,
  mergeWork,
  ownsSubagent,
  retryIdentity,
  retryNeighbours,
  sameWork,
  splitStepTitle,
  subagentName,
  summarizeWork,
  workspaceRelativePath,
  type WorkLedger,
} from "../work-steps.js";
import { StepOutput, StepStatus, ToolStep, toolIcon, WorkLedgerLine } from "./ToolStep.js";
import { statusMeta, toolStatusMeta } from "../status-meta.js";
import { StatusBadge } from "./StatusBadge.js";
import { ReadonlyReferenceChip } from "./images.js";
import { PromptImageView } from "./PromptImageView.js";
import { ArtifactPreview } from "./ArtifactPreview.js";
import { TranscriptImageCacheProvider } from "./TranscriptImageCache.js";
import { EventPayloadContent } from "./EventPayloadContent.js";
import { useTimelineClock } from "../timeline-clock.js";
import { deriveSubagentLifecycle } from "../subagents.js";
import { SessionTimelineQuestionRegion } from "./SessionApproval.js";
import { QuestionHistoryRow } from "./QuestionHistoryRow.js";
import type { ConversationForkAvailability, EditInForkAvailability } from "../session-actions.js";

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;
type UserMessageItem = Extract<TimelineItem, { kind: "user_message" }>;

function TranscriptArtifact({ artifact }: { artifact: WorkflowArtifactView }) {
  const [load, setLoad] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (load || artifact.kind === "video" || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") { setLoad(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setLoad(true); observer.disconnect(); }
    }, { rootMargin: "240px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [artifact.kind, load]);
  return (
    <div className="tl-artifact" ref={ref}>
      <div className="tl-artifact-head"><strong>{artifact.name}</strong><span>{artifact.kind === "video" ? "Video" : "Image"} · {artifact.sizeBytes.toLocaleString()} Bytes</span></div>
      {artifact.kind === "video" && !load && <button className="btn ghost sm" type="button" onClick={() => setLoad(true)}>Load Video</button>}
      {load && <ArtifactPreview artifact={artifact} />}
    </div>
  );
}
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface TimelineRevealRequest {
  eventId: number;
  requestId: number;
  /** Session id + event epoch that owns this semantic event id. */
  historyKey: string;
  align?: VirtualRevealRequest["align"];
  focus?: boolean;
}

export interface TimelineRevealTarget {
  rowKey: string;
  disclosureKeys: readonly string[];
}

export interface TimelineQuestionContext {
  sessionId: string;
  pendingQuestion: {
    requestId: string;
    occurrenceId?: string;
    questions: AgentQuestion[];
    async?: boolean;
    recoveryReason?: "provider_restart";
    recoveryAction?: "resume_answer";
  } | null;
  /** True only after the matching pinned row is mounted and measurement-ready. */
  questionInTimeline: boolean;
  onPendingQuestionAvailabilityChange?: (requestId: string, available: boolean) => void;
  runnerOnline: boolean;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
}

export interface TimelineApprovalContext {
  sessionId: string;
  requestId: string;
  onOpenRequest: () => void;
}

/**
 * Announces only errors appended after the opening transcript window has settled. Keeping the
 * live region outside the virtualized rows prevents history paging, reconnect hydration, and row
 * remounts from announcing durable errors again.
 */
export function TranscriptErrorAlert({
  historyKey,
  items,
  ready,
}: {
  historyKey: string;
  items: readonly TimelineItem[];
  ready: boolean;
}) {
  const cursorRef = useRef({ historyKey, initialized: false, maxEventId: 0 });
  const [announcement, setAnnouncement] = useState<{ eventId: number; message: string } | null>(null);

  useEffect(() => {
    const cursor = cursorRef.current;
    if (cursor.historyKey !== historyKey) {
      cursor.historyKey = historyKey;
      cursor.initialized = false;
      cursor.maxEventId = 0;
      setAnnouncement(null);
    }
    if (!ready) return;

    const maxEventId = items.reduce((maximum, item) => Math.max(maximum, item.id), 0);
    if (!cursor.initialized) {
      cursor.initialized = true;
      cursor.maxEventId = maxEventId;
      return;
    }

    const appendedErrors = items.filter(
      (item): item is Extract<TimelineItem, { kind: "error" }> =>
        item.kind === "error" && item.id > cursor.maxEventId,
    );
    cursor.maxEventId = Math.max(cursor.maxEventId, maxEventId);
    const latestError = appendedErrors.at(-1);
    if (latestError) {
      setAnnouncement({ eventId: latestError.id, message: latestError.message });
    }
  }, [historyKey, items, ready]);

  return (
    <span className="sr-only" data-transcript-error-alert aria-live="assertive" aria-atomic="true">
      {announcement && <span key={announcement.eventId}>{announcement.message}</span>}
    </span>
  );
}

/** Runner-initiated authentication outcomes that were never offered as a card button. Every other
 * resolution keeps its established option-id display. */
const RUNNER_RESOLUTION_LABELS: Record<string, string> = {
  "auth:automatic-retry": "Rechecked Automatically",
  "auth:select-account": "Another Account Selected",
};

export function permissionResolutionLabel(
  options: ReadonlyArray<{ optionId: string }>,
  optionId: string,
): string {
  // Providers choose their own option ids, so an offered option always keeps its raw id display.
  if (options.some((option) => option.optionId === optionId)) return optionId;
  return Object.hasOwn(RUNNER_RESOLUTION_LABELS, optionId) ? RUNNER_RESOLUTION_LABELS[optionId]! : optionId;
}

export function timelineFileSourceLocation(path: string): SourceLocation | null {
  const normalized = normalizeSourcePath(path);
  return normalized ? { path: normalized } : null;
}

/** Attach each durable provider checkpoint to the completed top-level assistant response that
 * established it. A later user turn clears the candidate so a cancelled turn cannot borrow the
 * previous response's fork point. */
export function assistantForkTurns(items: readonly TimelineItem[]): ReadonlyMap<number, number> {
  const turns = new Map<number, number>();
  let assistantMessageId: number | null = null;
  for (const item of items) {
    if (item.kind === "user_message") {
      assistantMessageId = null;
    } else if (item.kind === "agent_message" && !item.parentToolUseId) {
      assistantMessageId = item.id;
    } else if (item.kind === "conversation_checkpoint") {
      if (assistantMessageId !== null) turns.set(assistantMessageId, item.turn);
      assistantMessageId = null;
    }
  }
  return turns;
}

/** Attach each file checkpoint to the canonical user message that starts its turn. Checkpoints are
 * explicit semantic boundaries, so this never guesses from row position or lets a later prompt
 * borrow an incomplete turn's checkpoint. */
export function userRewindTurns(items: readonly TimelineItem[]): ReadonlyMap<number, number> {
  const turns = new Map<number, number>();
  let pendingUserMessageId: number | undefined;
  for (const item of items) {
    if (item.kind === "user_message" && item.deliveryIntent !== "steer") {
      pendingUserMessageId = item.id;
    } else if (item.kind === "checkpoint") {
      if (pendingUserMessageId != null) turns.set(pendingUserMessageId, item.turn);
      pendingUserMessageId = undefined;
    } else if (item.kind !== "user_message") {
      // The runner emits a normal checkpoint directly after its canonical prompt. Any intervening
      // durable event means that snapshot was lost or this is an automatic recovery turn without
      // a user message; neither may borrow the earlier prompt's action.
      pendingUserMessageId = undefined;
    }
  }
  return turns;
}
/** Checkpoints stay in the timeline model, where fork and rewind availability read them; the turn
 * footer replaces their Start Turn and End Turn separators, so they render no row. A stop keeps its
 * row, but the row shows nothing of its own: it is the anchor for its turn's footer ("Stopped at …"),
 * which a stop with no other row in its turn would otherwise lack. */
export function timelineItemRendersRow(item: TimelineItem): boolean {
  return item.kind !== "checkpoint" && item.kind !== "conversation_checkpoint";
}

const startsTurn = (item: TimelineItem): boolean =>
  item.kind === "user_message" && item.deliveryIntent !== "steer";

/** History events keep their own dividers (#2184) and sit after a turn's footer, not inside it. */
const HISTORY_DIVIDER_KINDS = new Set<TimelineItem["kind"]>([
  "checkpoint_restored",
  "conversation_forked",
  "provider_account_switched",
]);

/** §2.4 rhythm: `--space-3` between rows of one turn, `--space-8` before the first row of the next. */
export const TIMELINE_ROW_GAP = 12;
export const TIMELINE_TURN_GAP = 32;

export interface TurnFooterSummary {
  /** The checkpoint number the fork, rewind and recover confirmations use; absent when unrecorded. */
  turn?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  usage?: TurnUsage;
  /** The turn's top-level agent messages, for Copy; joined only by a mounted footer. */
  responseParts: readonly string[];
  /** The conversation checkpoint this turn's response established, for Fork and Hand Off. */
  forkTurn?: number;
  /** The message that opened the turn, whose actions the turn menu lists under Your Message. */
  prompt?: UserMessageItem;
  /** The turn was stopped; `at` is the stop's runner-recorded time. The event names no actor. */
  stopped?: { at?: number };
}

export interface TurnSegment extends TurnFooterSummary {
  /** The item that opened the turn: its prompt, or the first item of an automatic continuation.
   * `null` for activity before the window's first turn boundary. */
  key: number | null;
  /** Opened by a prompt, rather than by an automatic continuation or the window's head. */
  prompted: boolean;
  hasAgentContent: boolean;
  /** Agent rows, a usage report or a conversation checkpoint: the turn has something to settle. */
  footerEligible: boolean;
  usageReported: boolean;
  conversationTurn?: number;
  fileTurn?: number;
  responseParts: string[];
}

export interface TimelineTurns {
  /** In transcript order; the first holds activity before the window's first turn boundary. */
  segments: TurnSegment[];
  /** The segment index of every item id, nested subagent items included. */
  segmentOf: Map<number, number>;
}

/** Copy's text: the turn's top-level replies, a blank line apart. */
export const turnResponseText = (summary: Pick<TurnFooterSummary, "responseParts">): string =>
  summary.responseParts.join("\n\n");

function latestActivityAt(item: TimelineItem): number | undefined {
  let candidates: Array<number | undefined>;
  switch (item.kind) {
    case "user_message":
      candidates = [item.createdAt, item.lastUsageAt];
      break;
    case "checkpoint":
    case "conversation_checkpoint":
      candidates = [item.lastUsageAt];
      break;
    case "turn_interrupted":
      candidates = [item.createdAt, item.lastUsageAt];
      break;
    case "artifact_attached":
    case "review_decision":
      candidates = [item.createdAt];
      break;
    case "agent_message":
    case "agent_thought":
      candidates = [item.createdAt, item.lastActivityAt, item.completedAt];
      break;
    case "tool_call":
      candidates = [item.startedAt, item.lastActivityAt, item.completedAt];
      break;
    case "governance_decision":
      candidates = [item.decision.timestamp];
      break;
    default:
      return undefined;
  }
  let latest: number | undefined;
  for (const value of candidates) {
    if (Number.isFinite(value) && (latest === undefined || value! > latest)) latest = value;
  }
  return latest;
}

const emptySegment = (key: number | null, prompted: boolean): TurnSegment => ({
  key, prompted, hasAgentContent: false, footerEligible: false, usageReported: false, responseParts: [],
});

/** One pass over the flat items: each turn's number, span, usage, response text and fork point.
 * A canonical (non-steering) prompt opens a turn. So does an automatic continuation the runner
 * starts without one (resumed background work): agent activity after a turn's conversation
 * checkpoint, or a file checkpoint numbering a different turn. */
export function summarizeTimelineTurns(
  items: readonly TimelineItem[],
  forkTurns: ReadonlyMap<number, number>,
): TimelineTurns {
  let segment = emptySegment(null, false);
  const segments = [segment];
  const segmentOf = new Map<number, number>();
  // Nested subagent output belongs to its parent tool's turn, however late it arrives; the row
  // projector nests it there too.
  const toolSegments = new Map<string, number>();
  for (const item of items) {
    const continues = isTurnActivity(item) && (
      segment.conversationTurn !== undefined ||
      (item.kind === "checkpoint" && segment.fileTurn !== undefined && item.turn !== segment.fileTurn)
    );
    if (startsTurn(item) && item.kind === "user_message") {
      const usage = item.continuationUsage ? mergeTurnUsage(item.turnUsage, item.continuationUsage) : item.turnUsage;
      segment = {
        ...emptySegment(item.id, true),
        prompt: item,
        ...(item.turn != null ? { turn: item.turn } : {}),
        ...(Number.isFinite(item.createdAt) ? { startedAt: item.createdAt } : {}),
        ...(item.durationMs != null ? { durationMs: item.durationMs } : {}),
        ...(usage ? { usage } : {}),
        usageReported: item.lastUsageAt != null || item.durationMs != null,
      };
      segments.push(segment);
    } else if (continues) {
      segment = emptySegment(item.id, false);
      segments.push(segment);
    }
    const parent = "parentToolUseId" in item ? item.parentToolUseId : undefined;
    const targetIndex = (parent ? toolSegments.get(parent) : undefined) ?? segments.length - 1;
    const target = segments[targetIndex]!;
    if (item.kind === "tool_call" && !toolSegments.has(item.toolCallId)) toolSegments.set(item.toolCallId, targetIndex);
    segmentOf.set(item.id, targetIndex);
    if (item.kind === "conversation_checkpoint" || item.kind === "checkpoint") {
      if (item.kind === "conversation_checkpoint") segment.conversationTurn = item.turn;
      else segment.fileTurn ??= item.turn;
      // An automatic continuation's usage rides on the row that anchors it.
      if (item.lastUsageAt != null) segment.usageReported = true;
      if (item.turnUsage) segment.usage = mergeTurnUsage(segment.usage, item.turnUsage);
    } else if (item.kind !== "user_message" && !HISTORY_DIVIDER_KINDS.has(item.kind)) {
      target.hasAgentContent = true;
    }
    if (item.kind === "turn_interrupted") {
      target.stopped = Number.isFinite(item.createdAt) ? { at: item.createdAt } : {};
      if (item.lastUsageAt != null) target.usageReported = true;
      if (item.turnUsage) target.usage = mergeTurnUsage(target.usage, item.turnUsage);
    }
    if (item.kind === "agent_message" && !item.parentToolUseId) {
      if (item.text) segment.responseParts.push(item.text);
      const forkTurn = forkTurns.get(item.id);
      if (forkTurn != null) segment.forkTurn = forkTurn;
    }
    const activity = latestActivityAt(item);
    if (activity !== undefined && (target.finishedAt === undefined || activity > target.finishedAt)) {
      target.finishedAt = activity;
    }
  }
  for (const value of segments) {
    value.footerEligible = value.hasAgentContent || value.usage !== undefined || value.usageReported ||
      value.conversationTurn !== undefined;
    value.turn = value.conversationTurn ?? value.fileTurn ?? value.turn;
    // The prompt's duration ends at the turn's terminal usage report, which can land after the last
    // visible row (Codex's turn.completed); the turn finished at whichever came later.
    if (value.startedAt !== undefined && value.durationMs !== undefined) {
      value.finishedAt = Math.max(value.finishedAt ?? value.startedAt, value.startedAt + value.durationMs);
    }
  }
  return { segments, segmentOf };
}

/** The item that places a row in a turn. A nested subagent row follows its parent, wherever its own
 * event landed. */
function rowItemId(row: TimelineRenderRow): number | undefined {
  if (row.kind === "work_summary") return row.firstItemId;
  if (row.depth > 0) return undefined;
  return row.kind === "item" ? row.item.id : row.tool.id;
}

export interface TurnLayout {
  /** The settled turn summary to render at the end of each row that closes a turn. */
  footers: Map<string, TurnFooterSummary>;
  /** Rows that open a turn, other than the first row: 32px above them instead of 12px. */
  turnStarts: Set<string>;
  /** Replies no turn footer will ever copy, which keep their own Copy: a subagent's replies, which
   * a turn's Copy leaves out, and replies of an unnumbered turn no prompt opened (a subagent's
   * own transcript in the Subagents panel). */
  standaloneReplies: Set<string>;
}

/** Places one footer after the last row of every settled turn, before any trailing history
 * divider; a turn that produced only usage keeps its footer under its prompt. A turn that is still
 * running has none (the working indicator stands in for it), and neither has a turn no prompt
 * opened unless a checkpoint numbers it or it was stopped: a subagent's output or a partial page
 * must not claim an unnumbered turn. */
export function layoutTurns(
  rows: readonly TimelineRenderRow[],
  turns: TimelineTurns,
  sessionActive: boolean,
): TurnLayout {
  const footers = new Map<string, TurnFooterSummary>();
  const turnStarts = new Set<string>();
  const standaloneReplies = new Set<string>();
  const finalIndex = turns.segments.length - 1;
  let current = 0;
  let anchorKey: string | null = null;
  const close = () => {
    const segment = turns.segments[current];
    if (!segment?.footerEligible || anchorKey === null || (current === finalIndex && sessionActive)) return;
    // A stop is the one fact such a turn keeps: its footer says when it stopped, with no number.
    if (!segment.prompted && segment.turn === undefined && !segment.stopped) return;
    footers.set(anchorKey, segment);
  };
  rows.forEach((row, index) => {
    const itemId = rowItemId(row);
    const segmentIndex = (itemId === undefined ? undefined : turns.segmentOf.get(itemId)) ?? current;
    if (segmentIndex !== current) {
      close();
      current = segmentIndex;
      anchorKey = null;
      if (index > 0) turnStarts.add(row.key);
    }
    if (row.kind !== "item" || !HISTORY_DIVIDER_KINDS.has(row.item.kind)) anchorKey = row.key;
    if (row.kind === "item" && row.item.kind === "agent_message") {
      const segment = turns.segments[current];
      if (row.item.parentToolUseId || (segment && !segment.prompted && segment.turn === undefined)) {
        standaloneReplies.add(row.key);
      }
    }
  });
  close();
  return { footers, turnStarts, standaloneReplies };
}

export type TimelineRenderRow =
  | ({
      kind: "work_summary";
      key: string;
      /** The group's first item, which places the summary in its turn. */
      firstItemId?: number;
      open: boolean;
    } & WorkLedger)
  | { kind: "subagent_summary"; key: string; tool: ToolItem; depth: number; open: boolean }
  /** The spawning call's own output, after an open agent's steps: the tool row it replaces is hidden. */
  | { kind: "subagent_output"; key: string; tool: ToolItem; depth: number }
  | {
      kind: "item";
      key: string;
      /** A folded retry's latest attempt; its key stays the first attempt's. */
      item: TimelineItem;
      inWork: boolean;
      depth: number;
      /** Every attempt of a retried tool call, oldest first; absent for an ordinary row. */
      attempts?: readonly ToolItem[];
    };

const timelineRowKey = (row: TimelineRenderRow) => row.key;
export const estimateTimelineRow = (row: TimelineRenderRow, pendingQuestionRequestId: string | null = null): number => {
  if (row.kind === "work_summary") return 28;
  if (row.kind === "subagent_summary" || row.kind === "subagent_output") return 28;
  switch (row.item.kind) {
    case "agent_message": return 100;
    case "agent_thought": return 28;
    case "user_message": return 72;
    case "file_edit": return 28;
    case "question":
      if (row.item.answered !== undefined || row.item.requestId !== pendingQuestionRequestId) return 44;
      return 112 + row.item.questions.reduce(
        (height, question) => height + 64 + question.options.length * 44 + (question.allowOther ? 44 : 0),
        0,
      );
    case "command_output": return 96;
    case "stderr": return 28;
    case "tool_call": return 28;
    case "conversation_forked": return row.item.handoff ? 76 : 52;
    case "provider_account_switched": return 52;
    case "turn_interrupted": return 24;
    default: return 52;
  }
};

/** memo'd on the snapshot identity: a parent re-render with unchanged items (composer
 * keystrokes, status flips) skips the whole timeline subtree, not just the row bodies.
 * `onRewind` (when provided — session detail only) must be identity-stable (useCallback)
 * or it defeats the row memoization. */
const HandoffContext = createContext<{ open: (turn: number) => void; reason?: string } | undefined>(undefined);

/** Retry Turn for a failed turn's notice (#2169): re-submits the turn's prompt as a new turn. */
export interface TurnRetryControl {
  onRetry: (prompt: UserMessageItem) => void;
  /** Why the session cannot take a new turn now; the button is then disabled with this reason. */
  unavailableReason?: string;
  /** The prompt a retry is being submitted for. */
  pendingPromptId?: number;
  /** Why the last retry of this prompt failed (a refused restart sends no prompt). */
  error?: { promptId: number; message: string };
}
const TurnRetryContext = createContext<TurnRetryControl | undefined>(undefined);
export const EventTimeline = memo(function EventTimeline({
  handoff,
  turnRetry,
  items,
  onRewind,
  rewindUnavailableReason,
  onFork,
  onEditAndResend,
  editAndResendUnavailableReason,
  onEditInFork,
  onOpenSourceLocation,
  onOpenInReview,
  editInForkAvailabilityByItem,
  forkAvailabilityByTurn,
  scrollRef,
  historyKey,
  getInitialAnchor,
  preserveAnchor,
  anchorRecoveryPending,
  onVisibleAnchorChange,
  onAnchorLost,
  sessionActive = false,
  driver,
  ariaLabel = "Session Activity",
  onOpenSubagent,
  revealRequest,
  onRevealHandled,
  questionContext,
  approvalContext,
  workspaceRoot,
  onOpenSession,
}: {
  handoff?: { open: (turn: number) => void; reason?: string };
  /** Retry Turn on a failed turn's notice; absent where a transcript cannot start a turn. */
  turnRetry?: TurnRetryControl;
  items: TimelineItem[];
  onRewind?: (turn: number) => void;
  rewindUnavailableReason?: string;
  onFork?: (turn: number) => void;
  /** Composer preparation only; callers must never submit the prompt from this callback. */
  onEditAndResend?: (item: Extract<TimelineItem, { kind: "user_message" }>) => void;
  /** Why Edit & Resend cannot be used now; it then stays visible, disabled with this reason. */
  editAndResendUnavailableReason?: string;
  /** Forks AFTER the supplied predecessor turn, then prepares a child composer draft. */
  onEditInFork?: (item: Extract<TimelineItem, { kind: "user_message" }>, forkTurn: number) => void;
  onOpenSourceLocation?: (location: SourceLocation) => void;
  /** Opens the Review tab on a workspace-relative path (a file edit's Open in Review). */
  onOpenInReview?: (path: string) => void;
  editInForkAvailabilityByItem?: ReadonlyMap<number, EditInForkAvailability>;
  forkAvailabilityByTurn?: ReadonlyMap<number, ConversationForkAvailability>;
  scrollRef?: RefObject<HTMLElement | null>;
  /** Session id + history epoch. A change intentionally resets disclosure and measurements. */
  historyKey?: string;
  getInitialAnchor?: () => VirtualScrollAnchor | null;
  preserveAnchor?: boolean;
  anchorRecoveryPending?: boolean;
  onVisibleAnchorChange?: (anchor: VirtualScrollAnchor) => void;
  onAnchorLost?: (anchor: VirtualScrollAnchor) => void;
  /** True only while this session has a nonterminal turn that can still produce activity. */
  sessionActive?: boolean;
  /** The session's driver, for driver-aware token arithmetic on the turn rows. */
  driver?: AgentDriverKind;
  /** Accessible name when the timeline is reused outside the parent transcript. */
  ariaLabel?: string;
  /** Open an agent task in the dedicated panel without changing its disclosure state. */
  onOpenSubagent?: (toolCallId: string) => void;
  /** Reveal a semantic event, opening only the structural disclosures that contain its row. */
  revealRequest?: TimelineRevealRequest | null;
  onRevealHandled?: (requestId: number, outcome: VirtualRevealOutcome) => void;
  /** Authoritative pending request used to replace its matching historical question row in place. */
  questionContext?: TimelineQuestionContext;
  /** Pending standalone approval that adds one review action to its canonical permission row. */
  approvalContext?: TimelineApprovalContext;
  /** The session's root, so a step names a file by its workspace-relative path. */
  workspaceRoot?: string;
  /** Open another session, such as a fork's source; must be identity-stable. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const effectiveHistoryKey = historyKey ?? "timeline";
  const scopedRevealRequest = revealRequest?.historyKey === effectiveHistoryKey ? revealRequest : null;
  return (
    <HandoffContext.Provider value={handoff}>
    <TimelineSessionLinkContext.Provider value={onOpenSession}>
    <TurnRetryContext.Provider value={turnRetry}>
    <TranscriptImageCacheProvider key={effectiveHistoryKey} enabled={historyKey !== undefined}>
    <EventTimelineBody
      key={effectiveHistoryKey}
      items={items}
      onRewind={onRewind}
      rewindUnavailableReason={rewindUnavailableReason}
      onFork={onFork}
      onEditAndResend={onEditAndResend}
      editAndResendUnavailableReason={editAndResendUnavailableReason}
      onEditInFork={onEditInFork}
      onOpenSourceLocation={onOpenSourceLocation}
      onOpenInReview={onOpenInReview}
      editInForkAvailabilityByItem={editInForkAvailabilityByItem}
      forkAvailabilityByTurn={forkAvailabilityByTurn}
      scrollRef={scrollRef}
      getInitialAnchor={getInitialAnchor}
      preserveAnchor={preserveAnchor}
      anchorRecoveryPending={anchorRecoveryPending}
      onVisibleAnchorChange={onVisibleAnchorChange}
      onAnchorLost={onAnchorLost}
      sessionActive={sessionActive}
      driver={driver}
      ariaLabel={ariaLabel}
      onOpenSubagent={onOpenSubagent}
      revealRequest={scopedRevealRequest}
      onRevealHandled={onRevealHandled}
      questionContext={questionContext}
      approvalContext={approvalContext}
      workspaceRoot={workspaceRoot}
    />
    </TranscriptImageCacheProvider>
    </TurnRetryContext.Provider>
    </TimelineSessionLinkContext.Provider>
    </HandoffContext.Provider>
  );
});

function EventTimelineBody({
  items,
  onRewind,
  rewindUnavailableReason,
  onFork,
  onEditAndResend,
  editAndResendUnavailableReason,
  onEditInFork,
  onOpenSourceLocation,
  onOpenInReview,
  editInForkAvailabilityByItem,
  forkAvailabilityByTurn,
  scrollRef,
  getInitialAnchor,
  preserveAnchor,
  anchorRecoveryPending,
  onVisibleAnchorChange,
  onAnchorLost,
  sessionActive,
  driver,
  ariaLabel,
  onOpenSubagent,
  revealRequest,
  onRevealHandled,
  questionContext,
  approvalContext,
  workspaceRoot,
}: {
  items: TimelineItem[];
  onRewind?: (turn: number) => void;
  rewindUnavailableReason?: string;
  onFork?: (turn: number) => void;
  onEditAndResend?: (item: Extract<TimelineItem, { kind: "user_message" }>) => void;
  /** Why Edit & Resend cannot be used now; it then stays visible, disabled with this reason. */
  editAndResendUnavailableReason?: string;
  onEditInFork?: (item: Extract<TimelineItem, { kind: "user_message" }>, forkTurn: number) => void;
  onOpenSourceLocation?: (location: SourceLocation) => void;
  /** Opens the Review tab on a workspace-relative path (a file edit's Open in Review). */
  onOpenInReview?: (path: string) => void;
  editInForkAvailabilityByItem?: ReadonlyMap<number, EditInForkAvailability>;
  forkAvailabilityByTurn?: ReadonlyMap<number, ConversationForkAvailability>;
  scrollRef?: RefObject<HTMLElement | null>;
  getInitialAnchor?: () => VirtualScrollAnchor | null;
  preserveAnchor?: boolean;
  anchorRecoveryPending?: boolean;
  onVisibleAnchorChange?: (anchor: VirtualScrollAnchor) => void;
  onAnchorLost?: (anchor: VirtualScrollAnchor) => void;
  sessionActive: boolean;
  driver?: AgentDriverKind;
  ariaLabel: string;
  onOpenSubagent?: (toolCallId: string) => void;
  revealRequest?: TimelineRevealRequest | null;
  onRevealHandled?: (requestId: number, outcome: VirtualRevealOutcome) => void;
  questionContext?: TimelineQuestionContext;
  approvalContext?: TimelineApprovalContext;
  workspaceRoot?: string;
}) {
  const projector = useRef<IncrementalTimelineRows | null>(null);
  if (!projector.current) projector.current = new IncrementalTimelineRows();
  const preparedRevealRef = useRef<{ eventId: number; requestId: number } | null>(null);
  const unresolvedRevealRef = useRef<number | null>(null);
  const [disclosure, setDisclosure] = useState<Map<string, boolean>>(() => new Map());
  const showAgentLogs = useShowAgentLogs();
  const projection = useMemo(
    () => projector.current!.project(items, disclosure, showAgentLogs),
    [items, disclosure, showAgentLogs],
  );
  const { rows } = projection;
  const forkTurns = useMemo(() => assistantForkTurns(items), [items]);
  const rewindTurns = useMemo(() => userRewindTurns(items), [items]);
  // Rows are patched in place between revisions, so the revision (not the array) keys this pass.
  const turns = useMemo(() => summarizeTimelineTurns(items, forkTurns), [items, forkTurns]);
  const { footers: turnFooters, turnStarts, standaloneReplies } = useMemo(
    () => layoutTurns(rows, turns, sessionActive),
    [rows, projection.revision, turns, sessionActive],
  );
  // Prompts a settled turn's More Turn Actions already lists; on a coarse pointer every other user
  // message (a steer, a running or footerless turn's prompt) keeps a menu of its own.
  const turnMenuPrompts = useMemo(() => {
    const prompts = new Set<number>();
    for (const footer of turnFooters.values()) if (footer.prompt) prompts.add(footer.prompt.id);
    return prompts;
  }, [turnFooters]);
  // Read at call time: the projector extends `rows` in place, so the closure always sees the tail.
  // An open group's steps sit flush on its rule, so the rule runs unbroken from the ledger line.
  const rowGap = useCallback(
    (_row: TimelineRenderRow, index: number) => {
      const next = rows[index + 1];
      if (next && rowOnWorkRule(next)) return 0;
      return turnStarts.has(next?.key ?? "") ? TIMELINE_TURN_GAP : TIMELINE_ROW_GAP;
    },
    [rows, turnStarts],
  );
  const liveWorkKey = useMemo(
    () => sessionActive ? liveWorkSummaryKey(rows) : null,
    [rows, projection.revision, sessionActive],
  );
  const pendingQuestionRequestId = questionContext?.pendingQuestion?.requestId ?? null;
  let pinnedQuestionRow: TimelineRenderRow | undefined;
  if (pendingQuestionRequestId !== null) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.kind === "item" && row.item.kind === "question" &&
          row.item.requestId === pendingQuestionRequestId && row.item.answered === undefined) {
        pinnedQuestionRow = row;
        break;
      }
    }
  }
  const onPendingQuestionAvailabilityChange = questionContext?.onPendingQuestionAvailabilityChange;
  const reportPinnedQuestionAvailability = useCallback((key: string | null, available: boolean) => {
    if (pendingQuestionRequestId === null) return;
    onPendingQuestionAvailabilityChange?.(
      pendingQuestionRequestId,
      available && key === pinnedQuestionRow?.key,
    );
  }, [onPendingQuestionAvailabilityChange, pendingQuestionRequestId, pinnedQuestionRow?.key]);
  useBrowserLayoutEffect(() => {
    if (scrollRef) return;
    const pinnedKey = pinnedQuestionRow?.key ?? null;
    reportPinnedQuestionAvailability(pinnedKey, pinnedQuestionRow != null);
    return () => reportPinnedQuestionAvailability(pinnedKey, false);
  }, [pinnedQuestionRow?.key, reportPinnedQuestionAvailability, scrollRef]);
  const estimateRow = useMemo(() => (row: TimelineRenderRow) =>
    estimateTimelineRow(row, pendingQuestionRequestId), [pendingQuestionRequestId]);
  const revealTarget = revealRequest == null
    ? null
    : projector.current.resolveRevealTarget(revealRequest.eventId);
  const revealPrepared = revealRequest != null &&
    preparedRevealRef.current?.eventId === revealRequest.eventId &&
    preparedRevealRef.current.requestId === revealRequest.requestId;
  const revealNeedsDisclosure = !revealPrepared &&
    (revealTarget?.disclosureKeys.some((key) => disclosure.get(key) !== true) ?? false);
  useBrowserLayoutEffect(() => {
    if (!revealRequest || revealTarget || unresolvedRevealRef.current === revealRequest.requestId) return;
    unresolvedRevealRef.current = revealRequest.requestId;
    onRevealHandled?.(revealRequest.requestId, "unresolved");
  }, [onRevealHandled, revealRequest, revealTarget]);
  useBrowserLayoutEffect(() => {
    if (!revealRequest || !revealTarget || revealPrepared) return;
    preparedRevealRef.current = { eventId: revealRequest.eventId, requestId: revealRequest.requestId };
    if (revealNeedsDisclosure) {
      setDisclosure((previous) => {
        let next: Map<string, boolean> | null = null;
        for (const key of revealTarget.disclosureKeys) {
          if (previous.get(key) === true) continue;
          next ??= new Map(previous);
          next.set(key, true);
        }
        return next ?? previous;
      });
    }
  }, [revealNeedsDisclosure, revealPrepared, revealRequest, revealTarget]);
  const virtualRevealRequest: VirtualRevealRequest | null = revealRequest && revealTarget && !revealNeedsDisclosure
    ? {
        key: revealTarget.rowKey,
        requestId: revealRequest.requestId,
        align: revealRequest.align,
        focus: revealRequest.focus,
      }
    : null;
  const toggle = (key: string, current: boolean) => {
    setDisclosure((previous) => {
      const next = new Map(previous);
      next.set(key, !current);
      return next;
    });
  };
  const renderRow = (row: TimelineRenderRow, state: VirtualRowState) => {
    const footer = turnFooters.get(row.key);
    // A stop's row is only its turn's footer, sitting where the footer would under the row before.
    const stopRow = row.kind === "item" && row.item.kind === "turn_interrupted";
    const content = stopRow ? null : renderRowContent(row, state);
    if (!footer) return content;
    return (
      <>
        {content}
        <TurnFooter
          alone={stopRow}
          summary={footer}
          onFork={onFork}
          forkAvailability={footer.forkTurn == null ? undefined : forkAvailabilityByTurn?.get(footer.forkTurn)}
          prompt={footer.prompt}
          onRewind={onRewind}
          rewindTurn={footer.prompt ? rewindTurns.get(footer.prompt.id) : undefined}
          rewindUnavailableReason={rewindUnavailableReason}
          onEditAndResend={onEditAndResend}
          editAndResendUnavailableReason={editAndResendUnavailableReason}
          onEditInFork={onEditInFork}
          editInForkAvailability={footer.prompt ? editInForkAvailabilityByItem?.get(footer.prompt.id) : undefined}
        />
      </>
    );
  };
  const renderRowContent = (row: TimelineRenderRow, state: VirtualRowState) => {
  if (row.kind === "work_summary") {
      return (
        <WorkLedgerLine
          ledger={row}
          live={row.key === liveWorkKey}
          open={row.open}
          onToggle={() => toggle(row.key, row.open)}
        />
      );
    }
    if (row.kind === "subagent_summary") {
      return (
        <WorkRule depth={1 + row.depth}>
          <SubagentSummary
            tool={row.tool}
            open={row.open}
            onToggle={() => toggle(row.key, row.open)}
            onOpen={onOpenSubagent ? () => onOpenSubagent(row.tool.toolCallId) : undefined}
          />
        </WorkRule>
      );
    }
    if (row.kind === "subagent_output") {
      const outputKey = `row-details:${row.key}`;
      const outputOpen = disclosure.get(outputKey) ?? false;
      return (
        <WorkRule depth={1 + row.depth}>
          <SubagentOutput tool={row.tool} open={outputOpen} onToggle={() => toggle(outputKey, outputOpen)} />
        </WorkRule>
      );
    }
    const item = row.item;
    const detailsKey = `row-details:${row.key}`;
    const detailsOpen = disclosure.get(detailsKey) ?? false;
    const userRewindTurn = item.kind === "user_message" ? rewindTurns.get(item.id) : undefined;
    return (
      <WorkRule depth={(row.inWork ? 1 : 0) + row.depth}>
        <TimelineRow
          item={item}
          attempts={row.attempts}
          highlightEligible={state.visible}
          disclosureOpen={detailsOpen}
          onDisclosureToggle={() => toggle(detailsKey, detailsOpen)}
          onRewind={onRewind}
          rewindTurn={userRewindTurn}
          rewindUnavailableReason={rewindUnavailableReason}
          onEditAndResend={onEditAndResend}
          editAndResendUnavailableReason={editAndResendUnavailableReason}
          onEditInFork={onEditInFork}
          onOpenSourceLocation={onOpenSourceLocation}
          editInForkAvailability={item.kind === "user_message" ? editInForkAvailabilityByItem?.get(item.id) : undefined}
          standaloneCopy={standaloneReplies.has(row.key)}
          inTurnMenu={item.kind === "user_message" && turnMenuPrompts.has(item.id)}
          failedTurnPrompt={item.kind === "error" ? turns.segments[turns.segmentOf.get(item.id) ?? -1]?.prompt : undefined}
          questionContext={item.kind === "question" && row.key === pinnedQuestionRow?.key &&
            questionContext?.questionInTimeline === true ? questionContext : undefined}
          approvalContext={item.kind === "permission" && item.resolvedOptionId === undefined &&
            item.requestId === approvalContext?.requestId ? approvalContext : undefined}
        />
      </WorkRule>
    );
  };
  const timeline = scrollRef ? (
    <MeasuredVirtualList
      items={rows}
      getKey={timelineRowKey}
      renderItem={renderRow}
      scrollRef={scrollRef}
      estimateSize={estimateRow}
      overscan={8}
      pinnedKey={pinnedQuestionRow?.key ?? null}
      onPinnedAvailabilityChange={reportPinnedQuestionAvailability}
      rowGap={rowGap}
      className="timeline"
      ariaLabel={ariaLabel}
      dataKind="timeline"
      itemsVersion={projection.revision}
      itemsDirtyFrom={projection.keyDirtyFrom}
      getInitialAnchor={getInitialAnchor}
      preserveAnchor={preserveAnchor}
      anchorRecoveryPending={anchorRecoveryPending}
      onVisibleAnchorChange={onVisibleAnchorChange}
      onAnchorLost={onAnchorLost}
      revealRequest={virtualRevealRequest}
      onRevealHandled={onRevealHandled}
    />
  ) : (
    <div className="timeline" role="list" aria-label={ariaLabel}>
      {rows.map((row, index) => (
        <div
          key={row.key}
          className={turnStarts.has(row.key) ? "tl-turn-start" : rowOnWorkRule(row) ? "tl-on-work-rule" : undefined}
          role="listitem"
          aria-posinset={index + 1}
          aria-setsize={rows.length}
        >
          {renderRow(row, { index, visible: true })}
        </div>
      ))}
    </div>
  );
  return (
    <TimelineClockProvider enabled={sessionActive} sessionActive={sessionActive} driver={driver}>
      <WorkspaceRootContext.Provider value={workspaceRoot}>
        <OpenInReviewContext.Provider value={onOpenInReview}>{timeline}</OpenInReviewContext.Provider>
      </WorkspaceRootContext.Provider>
    </TimelineClockProvider>
  );
}

/** A row inside an open work group: a step, a subagent summary, a subagent's nested step or its
 * output. */
const rowOnWorkRule = (row: TimelineRenderRow): boolean =>
  row.kind === "subagent_summary" || row.kind === "subagent_output" || (row.kind === "item" && (row.inWork || row.depth > 0));

/** The run of work still in progress: the transcript's last work group, with nothing after it but
 * its own steps. Every earlier group has settled. */
export function liveWorkSummaryKey(rows: readonly TimelineRenderRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "work_summary") return row.key;
    if (!rowOnWorkRule(row)) return null;
  }
  return null;
}

/** The 1px rule an open group's steps sit on, under the ledger chevron's centre (#2168). A nested
 * agent's steps add one rule per level under that agent's chevron, never an inline margin. */
function WorkRule({ depth, children }: { depth: number; children: ReactNode }) {
  let content = children;
  for (let level = Math.min(depth, 7); level > 0; level -= 1) content = <div className="tl-work-rule">{content}</div>;
  return <>{content}</>;
}

const TimelineClockContext = createContext(Date.now());
const TimelineActivityContext = createContext(false);

/** Historical/inactive transcripts are settled even when an older runner recorded no fence. */
export function timelineMediaSettled(item: TimelineItem, sessionActive: boolean): boolean {
  return !sessionActive || !timelineItemIsStreaming(item);
}

/** The session's driver, for driver-aware token arithmetic on the turn rows; provided once by the
 * timeline so the memoised rows need no extra prop. */
const TimelineDriverContext = createContext<AgentDriverKind | undefined>(undefined);

/** The session root that step titles and edit paths are shown relative to. */
const WorkspaceRootContext = createContext<string | undefined>(undefined);

/** Opens the Review tab on a file; absent where there is no Review tab (a preview, a shared page). */
const OpenInReviewContext = createContext<((path: string) => void) | undefined>(undefined);

/** Opens another session in the app; absent where the transcript cannot navigate (a shared page). */
const TimelineSessionLinkContext = createContext<((sessionId: string) => void) | undefined>(undefined);

function TimelineClockProvider({ enabled, sessionActive, driver, children }: {
  enabled: boolean;
  sessionActive: boolean;
  driver?: AgentDriverKind;
  children: ReactNode;
}) {
  const now = useTimelineClock(enabled);
  return (
    <TimelineActivityContext.Provider value={sessionActive}>
      <TimelineDriverContext.Provider value={driver}>
        <TimelineClockContext.Provider value={now}>{children}</TimelineClockContext.Provider>
      </TimelineDriverContext.Provider>
    </TimelineActivityContext.Provider>
  );
}

export interface TimelineRowsProjection {
  rows: TimelineRenderRow[];
  latestCheckpointTurn: number;
  incremental: boolean;
  processedItems: number;
  revision: number;
  keyDirtyFrom: number;
}

const rendersSubagentSummary = (item: TimelineItem): boolean =>
  item.kind === "tool_call" && ownsSubagent(item);

/** The rows an item contributes besides nested steps: a step row, or an agent row and, while that
 * agent is open, its output row. A change of shape inserts or removes rows, so the incremental
 * paths leave it to the full projector. */
const rowShape = (item: TimelineItem): "step" | "agent" | "agent_output" =>
  !rendersSubagentSummary(item) ? "step" : hasToolOutput(item as ToolItem) ? "agent_output" : "agent";

interface ItemLocation {
  groupIndex: number;
  rootItemIndex: number;
  parentId: string | null;
  childIndex: number;
  item: TimelineItem;
}

/** Retained projection for the ordinary no-subagent streaming path. Exact TimelineBuilder delta
 * metadata lets it rebuild only the active tail group; history replacement, earlier mutations,
 * disclosure changes, and recursive agent topology deliberately take the full defensive path. */
export class IncrementalTimelineRows {
  private readonly subagents = new SubagentTreeProjector();
  private items: TimelineItem[] = [];
  private groups: TimelineGroup[] = [];
  private rows: TimelineRenderRow[] = [];
  private disclosure: ReadonlyMap<string, boolean> | null = null;
  private showAgentLogs = true;
  private latestCheckpointTurn = 0;
  private revision = 0;
  private readonly toolNodes = new Map<string, ToolItem>();
  private readonly toolParents = new Map<string, string | null>();
  private readonly toolChildIndexes = new Map<string, number>();
  private readonly toolRootGroups = new Map<string, number>();
  private readonly toolRootItemIndexes = new Map<string, number>();
  private readonly toolIdCounts = new Map<string, number>();
  private readonly unresolvedParentIds = new Set<string>();
  private readonly rowIndexes = new Map<string, number>();
  private readonly revealRowKeys = new Map<number, string>();
  private readonly rowKeys: string[] = [];
  private readonly summaryBoundaryKeys = new Map<string, string | null>();
  private readonly boundaryDependents = new Map<string | null, Set<string>>();
  private ownedTools = new WeakSet<ToolItem>();
  private readonly itemLocations = new Map<number, ItemLocation>();

  /** `showAgentLogs` false leaves out every run of work whose only steps are Agent Logs (#2184). */
  project(items: TimelineItem[], disclosure: ReadonlyMap<string, boolean>, showAgentLogs = true): TimelineRowsProjection {
    // A disclosure or Show Agent Logs change re-flattens every row on the full path.
    const sameView = disclosure === this.disclosure && showAgentLogs === this.showAgentLogs;
    if (items === this.items && sameView) {
      return {
        rows: this.rows,
        latestCheckpointTurn: this.latestCheckpointTurn,
        incremental: true,
        processedItems: 0,
        revision: this.revision,
        keyDirtyFrom: this.rows.length,
      };
    }
    let delta = timelineSnapshotDelta(items);
    const previousLength = this.items.length;
    let settlementPatched = 0;
    // One boundary can settle several independently identified provider texts and append or update
    // one structural item. Patch every settled object generation first, then let the ordinary
    // one-item paths consume the optional remainder so work scales with the changed batch instead
    // of the full transcript.
    if (delta?.previous === this.items && sameView && previousLength > 0 &&
        items.length >= previousLength && items.length <= previousLength + 1) {
      const settlementIndexes = delta.dirtyIndexes.filter((index) => index < previousLength &&
        timelineItemIsStreaming(this.items[index]!) && !timelineItemIsStreaming(items[index]!));
      const settlementIndexSet = new Set(settlementIndexes);
      const remainingIndexes = delta.dirtyIndexes.filter((index) => !settlementIndexSet.has(index));
      const validRemainder = items.length === previousLength
        ? remainingIndexes.length <= 1
        : remainingIndexes.length === 1 && remainingIndexes[0] === previousLength;
      if (settlementIndexes.length > 0 && validRemainder &&
          settlementIndexes.every((index) => this.patchExistingItem(items, index))) {
        settlementPatched = settlementIndexes.length;
        const remainingIndex = remainingIndexes[0];
        if (remainingIndex === undefined) {
          this.items = items;
          this.disclosure = disclosure;
          this.revision += 1;
          return {
            rows: this.rows,
            latestCheckpointTurn: this.latestCheckpointTurn,
            incremental: true,
            processedItems: settlementPatched,
            revision: this.revision,
            keyDirtyFrom: this.rows.length,
          };
        }
        const remaining = items[remainingIndex]!;
        delta = {
          previous: this.items,
          dirtyFrom: remainingIndex,
          dirtyIndexes: [remainingIndex],
          dirtyHasParentItems: delta.dirtyHasParentItems &&
            "parentToolUseId" in remaining && Boolean(remaining.parentToolUseId),
        };
      }
    }
    const indexedUpdate = delta?.previous === this.items && sameView &&
      items.length === previousLength && delta.dirtyIndexes.length === 1
      ? this.projectExistingItemUpdate(items, delta.dirtyIndexes[0]!, disclosure)
      : null;
    if (indexedUpdate) {
      return settlementPatched > 0
        ? { ...indexedUpdate, processedItems: indexedUpdate.processedItems + settlementPatched }
        : indexedUpdate;
    }
    const parentTail = delta?.previous === this.items && sameView
      ? this.projectParentTail(items, delta, disclosure)
      : null;
    if (parentTail) {
      return settlementPatched > 0
        ? { ...parentTail, processedItems: parentTail.processedItems + settlementPatched }
        : parentTail;
    }
    const tailSafe = this.groups.length > 0 && delta?.previous === this.items &&
      !delta.dirtyHasParentItems && sameView &&
      delta.dirtyFrom >= Math.max(0, previousLength - 1);

    if (tailSafe) {
      const tailDelta = delta!;
      const appended = tailDelta.dirtyFrom >= previousLength;
      const previousLastGroup = this.groups.at(-1)!;
      const firstNew = items[previousLength];
      const joinsLastWork = appended && previousLastGroup.kind === "work" && firstNew != null && isCollapsibleWorkItem(firstNew);
      // A new attempt of the group's failed last call folds into that call's row, which only the
      // full projector rebuilds.
      const lastWorkItem = previousLastGroup.kind === "work" ? previousLastGroup.items.at(-1) : undefined;
      const foldsIntoLast = joinsLastWork && lastWorkItem?.kind === "tool_call" && lastWorkItem.status === "failed" &&
        retryIdentity(firstNew) !== null && retryIdentity(firstNew) === retryIdentity(lastWorkItem);
      const appendedItems = appended ? items.slice(previousLength) : [];
      const appendedToolIds = this.collectToolIds(appendedItems);
      const localToolIds = new Set<string>();
      const hasToolCollision = appendedToolIds.some((id) => {
        if ((this.toolIdCounts.get(id) ?? 0) > 0 || localToolIds.has(id)) return true;
        localToolIds.add(id);
        return false;
      });
      // A newly materialized root tool may claim an older orphan child. That changes earlier
      // topology, so only the full projector may handle it.
      const canAppendWithoutTopologyChange = !appendedToolIds.some((id) => this.unresolvedParentIds.has(id));
      // A hidden Agent Log run that gains other work needs the summary row it never had.
      const revealsHiddenWork = joinsLastWork && !showAgentLogs &&
        agentLogOnly(previousLastGroup.items) && !agentLogOnly(appendedItems);
      if (joinsLastWork && !foldsIntoLast && !revealsHiddenWork && appendedItems.every(isCollapsibleWorkItem) &&
          !hasToolCollision && canAppendWithoutTopologyChange) {
        const oldRowLength = this.rows.length;
        previousLastGroup.items.push(...appendedItems);
        const summaryIndex = this.rowIndexes.get(`work:${previousLastGroup.id}`);
        const summary = summaryIndex == null ? undefined : this.rows[summaryIndex];
        if (summary?.kind === "work_summary") {
          // The batch cannot fold into the group's last row (checked above), so its ledger adds.
          this.rows[summaryIndex!] = workSummaryRow(summary, mergeWork(summary, summarizeWork(appendedItems)));
          if (summary.open) {
            for (const id of appendedToolIds) this.toolIdCounts.set(id, 1);
            const appendedRows = flattenTimelineItemRows(appendedItems, disclosure, true, 0, this.toolIdCounts);
            this.rows.push(...appendedRows);
            this.indexInsertedRows(appendedRows, null);
            this.reindexRows(oldRowLength);
          }
        }
        for (const id of appendedToolIds) this.toolIdCounts.set(id, 1);
        this.registerNewTools(
          appendedItems,
          this.groups.length - 1,
          null,
          previousLastGroup.items.length - appendedItems.length,
        );
        const firstItemIndex = previousLastGroup.items.length - appendedItems.length;
        appendedItems.forEach((item, offset) => this.indexItemLocation(
          item,
          this.groups.length - 1,
          firstItemIndex + offset,
          null,
          -1,
        ));
        this.items = items;
        this.revision += 1;
        for (const item of appendedItems) {
          if (item.kind === "checkpoint" || item.kind === "conversation_checkpoint") {
            this.latestCheckpointTurn = Math.max(this.latestCheckpointTurn, item.turn);
          }
        }
        return {
          rows: this.rows,
          latestCheckpointTurn: this.latestCheckpointTurn,
          incremental: true,
          processedItems: appendedItems.length + settlementPatched,
          revision: this.revision,
          keyDirtyFrom: oldRowLength,
        };
      }
      if (!appended) {
        const updated = this.projectTopLevelTailUpdate(items, tailDelta, disclosure);
        if (updated) return updated;
      } else if (!joinsLastWork && !hasToolCollision && canAppendWithoutTopologyChange) {
        const oldRowLength = this.rows.length;
        const suffixGroups = groupTimeline(appendedItems);
        if (suffixGroups[0]?.kind === "work" && previousLength > 0) {
        suffixGroups[0] = {
          ...suffixGroups[0],
            id: timelineBoundaryKey(items[previousLength - 1]!),
        };
        }
        const suffixRows = flattenTimelineRows(suffixGroups, disclosure, showAgentLogs);
        const groupStart = this.groups.length;
        this.groups.push(...suffixGroups);
        this.rows.push(...suffixRows);
        this.indexInsertedRows(suffixRows, null);
        for (const id of appendedToolIds) this.toolIdCounts.set(id, 1);
        suffixGroups.forEach((group, offset) => {
          if (group.kind === "work") {
            this.registerNewTools(group.items, groupStart + offset, null, 0);
            group.items.forEach((item, itemIndex) => this.indexItemLocation(item, groupStart + offset, itemIndex, null, -1));
          } else {
            this.registerNewTools([group.item], groupStart + offset, null, 0);
            this.indexItemLocation(group.item, groupStart + offset, 0, null, -1);
          }
        });
        this.reindexRows(oldRowLength);
        this.items = items;
        this.disclosure = disclosure;
        this.revision += 1;
        for (const item of appendedItems) {
          if (item.kind === "checkpoint" || item.kind === "conversation_checkpoint") {
            this.latestCheckpointTurn = Math.max(this.latestCheckpointTurn, item.turn);
          }
        }
        return {
          rows: this.rows,
          latestCheckpointTurn: this.latestCheckpointTurn,
          incremental: true,
          processedItems: appendedItems.length + settlementPatched,
          revision: this.revision,
          keyDirtyFrom: oldRowLength,
        };
      }
    }

    const projected = this.subagents.project(items);
    this.groups = stabilizeWorkGroupKeys(groupTimeline(projected), this.groups);
    const nextRows = flattenTimelineRows(this.groups, disclosure, showAgentLogs);
    this.rows = stabilizeTimelineRowKeys(nextRows, this.rows);
    this.items = items;
    this.disclosure = disclosure;
    this.showAgentLogs = showAgentLogs;
    this.latestCheckpointTurn = items.reduce(
      (latest, item) => item.kind === "checkpoint" || item.kind === "conversation_checkpoint"
        ? Math.max(latest, item.turn)
        : latest,
      0,
    );
    this.rebuildToolIndex();
    this.rebuildItemLocations();
    this.reindexRows(0);
    this.rebuildSummaryBoundaries();
    this.revision += 1;
    return {
      rows: this.rows,
      latestCheckpointTurn: this.latestCheckpointTurn,
      incremental: false,
      processedItems: items.length,
      revision: this.revision,
      keyDirtyFrom: 0,
    };
  }

  /** Resolve a semantic event id to its stable virtual row and every collapsed structural owner. */
  resolveRevealTarget(eventId: number): TimelineRevealTarget | null {
    const location = this.itemLocations.get(eventId);
    if (!location) return null;
    const group = this.groups[location.groupIndex];
    if (!group) return null;

    // A hidden Agent Log run has no row to reveal.
    if (group.kind === "work" && !this.showAgentLogs && agentLogOnly(group.items)) return null;
    const disclosureKeys: string[] = [];
    if (group.kind === "work") disclosureKeys.push(`work:${group.id}`);

    const ancestors: string[] = [];
    let parentId = location.parentId;
    const visited = new Set<string>();
    while (parentId) {
      if (visited.has(parentId)) return null;
      visited.add(parentId);
      const parent = this.toolNodes.get(parentId);
      if (!parent) return null;
      const identity = (this.toolIdCounts.get(parent.toolCallId) ?? 0) === 1
        ? parent.toolCallId
        : `${parent.toolCallId}:${parent.id}`;
      ancestors.push(`agent:${identity}`);
      parentId = this.toolParents.get(parentId) ?? null;
    }
    disclosureKeys.push(...ancestors.reverse());
    return { rowKey: this.revealRowKeys.get(eventId) ?? this.rowKeyOf(location.item), disclosureKeys };
  }

  private patchExistingItem(
    items: TimelineItem[],
    dirtyIndex: number,
  ): boolean {
    const previous = this.items[dirtyIndex];
    const changed = items[dirtyIndex];
    if (!previous || !changed || previous.id !== changed.id || previous.kind !== changed.kind) return false;
    const location = this.itemLocations.get(previous.id);
    if (!location || !this.sameSourceItem(location.item, previous)) return false;
    if (location.item.kind === "tool_call" && changed.kind === "tool_call" &&
        location.item.toolCallId !== changed.toolCallId) return false;
    const previousParent = "parentToolUseId" in previous ? previous.parentToolUseId ?? null : null;
    const changedParent = "parentToolUseId" in changed ? changed.parentToolUseId ?? null : null;
    const unchangedOrphanParent = previousParent != null && previousParent === changedParent &&
      !this.toolNodes.has(previousParent) && location.parentId == null;
    if (!unchangedOrphanParent &&
        (previousParent !== changedParent || previousParent !== location.parentId)) return false;

    const projectedChanged = changed.kind === "tool_call" && location.item.kind === "tool_call" && location.item.children?.length
      ? { ...changed, children: location.item.children }
      : changed;
    // Changing whether a tool owns a subagent summary, or whether that agent has an output row,
    // inserts or removes structural rows. Leave that rare transition to the full defensive
    // projector instead of patching payloads.
    if (rowShape(location.item) !== rowShape(projectedChanged)) return false;
    // So does a change that can join or split a folded retry.
    const container = location.parentId
      ? this.toolNodes.get(location.parentId)?.children
      : this.groups[location.groupIndex]?.kind === "work"
        ? (this.groups[location.groupIndex] as Extract<TimelineGroup, { kind: "work" }>).items
        : undefined;
    const containerIndex = location.parentId ? location.childIndex : location.rootItemIndex;
    if (container && retryNeighbours(container, containerIndex, retryIdentity(location.item), retryIdentity(projectedChanged))) {
      return false;
    }
    const visibleTools = new Map<string, ToolItem>();
    if (location.parentId) {
      const parent = this.toolNodes.get(location.parentId);
      if (!parent?.children || !this.ownedTools.has(parent) || parent.children[location.childIndex] !== location.item) return false;
      let toolId: string | null = location.parentId;
      while (toolId) {
        const tool = this.toolNodes.get(toolId);
        if (!tool) return false;
        visibleTools.set(toolId, tool);
        toolId = this.toolParents.get(toolId) ?? null;
      }
      parent.children[location.childIndex] = projectedChanged;
    } else {
      const group = this.groups[location.groupIndex];
      if (!group) return false;
      if (group.kind === "work") {
        if (group.items[location.rootItemIndex] !== location.item) return false;
        group.items[location.rootItemIndex] = projectedChanged;
      } else {
        if (location.rootItemIndex !== 0 || group.item !== location.item) return false;
        group.item = projectedChanged;
      }
    }
    if (projectedChanged.kind === "tool_call") {
      this.toolNodes.set(projectedChanged.toolCallId, projectedChanged);
      if (projectedChanged.children) this.ownedTools.add(projectedChanged);
      visibleTools.set(projectedChanged.toolCallId, projectedChanged);
    }
    this.patchVisibleItem(location.item, projectedChanged);
    this.patchToolRows(visibleTools);
    this.itemLocations.set(changed.id, { ...location, item: projectedChanged });
    if (!location.parentId) this.refreshWorkSummary(location.groupIndex);
    return true;
  }

  private projectExistingItemUpdate(
    items: TimelineItem[],
    dirtyIndex: number,
    disclosure: ReadonlyMap<string, boolean>,
  ): TimelineRowsProjection | null {
    if (!this.patchExistingItem(items, dirtyIndex)) return null;
    this.items = items;
    this.disclosure = disclosure;
    this.revision += 1;
    return {
      rows: this.rows,
      latestCheckpointTurn: this.latestCheckpointTurn,
      incremental: true,
      processedItems: 1,
      revision: this.revision,
      keyDirtyFrom: this.rows.length,
    };
  }

  private projectTopLevelTailUpdate(
    items: TimelineItem[],
    delta: TimelineSnapshotDelta,
    disclosure: ReadonlyMap<string, boolean>,
  ): TimelineRowsProjection | null {
    if (items.length !== this.items.length || delta.dirtyFrom !== items.length - 1) return null;
    const previous = delta.previous[delta.dirtyFrom]!;
    const changed = items[delta.dirtyFrom]!;
    if (("parentToolUseId" in changed && changed.parentToolUseId) || previous.kind !== changed.kind) return null;
    const group = this.groups.at(-1);
    if (!group) return null;
    let rendered: TimelineItem | undefined;
    if (group.kind === "work") rendered = group.items.at(-1);
    else rendered = group.item;
    if (!rendered || !this.sameSourceItem(rendered, previous)) return null;
    if (rendered.kind === "tool_call" && changed.kind === "tool_call" && rendered.toolCallId !== changed.toolCallId) return null;
    const projectedChanged = changed.kind === "tool_call" && rendered.kind === "tool_call" && rendered.children?.length
      ? { ...changed, children: rendered.children }
      : changed;
    if (rowShape(rendered) !== rowShape(projectedChanged)) return null;
    if (group.kind === "work" &&
        retryNeighbours(group.items, group.items.length - 1, retryIdentity(rendered), retryIdentity(projectedChanged))) {
      return null;
    }
    if (group.kind === "work") group.items[group.items.length - 1] = projectedChanged;
    else group.item = projectedChanged;
    const location = this.itemLocations.get(previous.id);
    if (location) this.itemLocations.set(changed.id, { ...location, item: projectedChanged });
    if (projectedChanged.kind === "tool_call") {
      this.toolNodes.set(projectedChanged.toolCallId, projectedChanged);
      if (projectedChanged.children) this.ownedTools.add(projectedChanged);
    }
    this.patchVisibleItem(rendered, projectedChanged);
    if (projectedChanged.kind === "tool_call") {
      this.patchToolRows(new Map([[projectedChanged.toolCallId, projectedChanged]]));
    }
    this.refreshWorkSummary(this.groups.length - 1);
    this.items = items;
    this.disclosure = disclosure;
    this.revision += 1;
    return {
      rows: this.rows,
      latestCheckpointTurn: this.latestCheckpointTurn,
      incremental: true,
      processedItems: 1,
      revision: this.revision,
      keyDirtyFrom: this.rows.length,
    };
  }

  private projectParentTail(
    items: TimelineItem[],
    delta: TimelineSnapshotDelta,
    disclosure: ReadonlyMap<string, boolean>,
  ): TimelineRowsProjection | null {
    const previousLength = this.items.length;
    if (!delta.dirtyHasParentItems || delta.dirtyFrom < Math.max(0, previousLength - 1) ||
        items.length - delta.dirtyFrom !== 1) return null;
    const changed = items[delta.dirtyFrom]!;
    const parentId = "parentToolUseId" in changed ? changed.parentToolUseId : undefined;
    if (!parentId) return null;
    let parent = this.toolNodes.get(parentId);
    const rootGroupIndex = this.toolRootGroups.get(parentId);
    if (!parent || rootGroupIndex == null || rootGroupIndex !== this.groups.length - 1) return null;

    const previous = delta.dirtyFrom < previousLength ? delta.previous[delta.dirtyFrom]! : null;
    const previousProjectedTool = changed.kind === "tool_call" ? this.toolNodes.get(changed.toolCallId) : undefined;
    if (changed.kind === "tool_call" && (
      (!previous && (this.toolIdCounts.get(changed.toolCallId) ?? 0) > 0) ||
      (previous && !previousProjectedTool)
    )) return null;
    const projectedChanged = changed.kind === "tool_call" && previousProjectedTool?.children?.length
      ? { ...changed, children: previousProjectedTool.children }
      : changed;
    if (previousProjectedTool && rowShape(previousProjectedTool) !== rowShape(projectedChanged)) return null;
    const previousChildren = parent.children ?? [];
    // A first attributed child makes an untyped placeholder structurally agent-like. Without an
    // existing summary row there is nowhere to insert that child, so rebuild the visible structure.
    if (!previous && !rendersSubagentSummary(parent)) return null;
    if (previous) {
      const child = previousChildren.at(-1);
      if (child !== previous &&
          !(child?.kind === "tool_call" && changed.kind === "tool_call" && child.toolCallId === changed.toolCallId)) {
        return null;
      }
    }

    // A subagent's retried call folds with its previous attempt; the full projector rebuilds that.
    if (previous
      ? retryNeighbours(previousChildren, previousChildren.length - 1, retryIdentity(previousChildren.at(-1)), retryIdentity(projectedChanged))
      : retryNeighbours(previousChildren, previousChildren.length, retryIdentity(projectedChanged))) {
      return null;
    }

    // Validate the entire ancestor path and root location before touching any retained state.
    // Malformed or ambiguous topology can then fall through to the full defensive projector
    // without observing half-committed tool indexes.
    const ancestors: Array<{ id: string; node: ToolItem }> = [];
    let currentId = parentId;
    let ancestorId = this.toolParents.get(currentId) ?? null;
    while (ancestorId) {
      const ancestor = this.toolNodes.get(ancestorId);
      if (!ancestor?.children) return null;
      ancestors.push({ id: ancestorId, node: ancestor });
      currentId = ancestorId;
      ancestorId = this.toolParents.get(currentId) ?? null;
    }

    const group = this.groups[rootGroupIndex]!;
    const rootItemIndex = this.toolRootItemIndexes.get(currentId);
    if (rootItemIndex == null) return null;
    if (group.kind === "work") {
      const root = group.items[rootItemIndex];
      if (root?.kind !== "tool_call" || root.toolCallId !== currentId) return null;
    } else if (rootItemIndex !== 0 || group.item.kind !== "tool_call" || group.item.toolCallId !== currentId) {
      return null;
    }

    if (!this.ownedTools.has(parent)) {
      const clonedParent: ToolItem = { ...parent, children: [...previousChildren] };
      const directAncestorId = this.toolParents.get(parentId) ?? null;
      if (directAncestorId) {
        const directAncestor = this.toolNodes.get(directAncestorId);
        const childIndex = this.toolChildIndexes.get(parentId);
        if (!directAncestor?.children || childIndex == null || directAncestor.children[childIndex] !== parent) return null;
        directAncestor.children[childIndex] = clonedParent;
      } else if (group.kind === "work") {
        group.items[rootItemIndex] = clonedParent;
      } else {
        group.item = clonedParent;
      }
      parent = clonedParent;
      this.toolNodes.set(parentId, parent);
      this.ownedTools.add(parent);
      const parentLocation = this.itemLocations.get(parent.id);
      if (parentLocation) this.itemLocations.set(parent.id, { ...parentLocation, item: parent });
    }
    const children = parent.children!;
    if (previous) children[children.length - 1] = projectedChanged;
    else children.push(projectedChanged);
    const committedTools = new Map<string, ToolItem>([[parentId, parent]]);
    for (const ancestor of ancestors) {
      committedTools.set(ancestor.id, ancestor.node);
    }
    if (changed.kind === "tool_call") {
      this.toolNodes.set(changed.toolCallId, projectedChanged as ToolItem);
      this.toolParents.set(changed.toolCallId, parentId);
      this.toolChildIndexes.set(changed.toolCallId, children.length - 1);
      this.toolRootGroups.set(changed.toolCallId, rootGroupIndex);
      this.toolRootItemIndexes.set(changed.toolCallId, rootItemIndex);
      if ((projectedChanged as ToolItem).children) this.ownedTools.add(projectedChanged as ToolItem);
    }
    if (!previous) {
      this.indexItemLocation(
        projectedChanged,
        rootGroupIndex,
        rootItemIndex,
        parentId,
        children.length - 1,
      );
    } else {
      const location = this.itemLocations.get(previous.id);
      if (location) this.itemLocations.set(changed.id, { ...location, item: projectedChanged });
    }

    const visibleTools = new Map(committedTools);
    if (changed.kind === "tool_call") visibleTools.set(changed.toolCallId, projectedChanged as ToolItem);
    this.patchToolRows(visibleTools);
    let keyDirtyFrom = this.rows.length;
    if (previous) {
      this.patchVisibleItem(previous, projectedChanged);
    } else {
      if (changed.kind === "tool_call") this.toolIdCounts.set(changed.toolCallId, 1);
      const summaryIndex = this.rowIndexes.get(`agent:${parentId}`);
      const summary = summaryIndex == null ? undefined : this.rows[summaryIndex];
      if (summaryIndex != null && summary?.kind === "subagent_summary") {
        const boundaryKey = this.summaryBoundaryKeys.get(summary.key) ?? null;
        const boundary = this.subtreeBoundary(summaryIndex, summary.depth);
        const nextOpen = disclosure.get(summary.key) ?? automaticSubagentOpen(summary.depth, children.length);
        this.rows[summaryIndex] = { ...summary, tool: committedTools.get(parentId)!, open: nextOpen };
        if (summary.open && !nextOpen) {
          const removed = this.rows.splice(summaryIndex + 1, boundary - summaryIndex - 1);
          for (const row of removed) if (row.kind === "subagent_summary") this.removeSummaryBoundary(row.key);
          keyDirtyFrom = summaryIndex + 1;
        } else if (!summary.open && nextOpen) {
          const childRows = flattenTimelineItemRows([], disclosure, true, summary.depth + 1, this.toolIdCounts, committedTools.get(parentId)!);
          this.rows.splice(summaryIndex + 1, 0, ...childRows);
          this.indexInsertedRows(childRows, boundaryKey);
          keyDirtyFrom = summaryIndex + 1;
        } else if (summary.open && nextOpen) {
          // A new step goes before the agent's output row, which stays last in its body.
          const outputKey = `agent-output:${parentId}`;
          const outputIndex = this.rowIndexes.get(outputKey);
          const insertAt = outputIndex === boundary - 1 ? outputIndex : boundary;
          const childRows = flattenTimelineItemRows([projectedChanged], disclosure, true, summary.depth + 1, this.toolIdCounts);
          this.rows.splice(insertAt, 0, ...childRows);
          this.indexInsertedRows(childRows, insertAt === boundary ? boundaryKey : outputKey);
          keyDirtyFrom = insertAt;
        }
        this.reindexRows(keyDirtyFrom);
      }
    }
    this.items = items;
    this.disclosure = disclosure;
    this.revision += 1;
    return {
      rows: this.rows,
      latestCheckpointTurn: this.latestCheckpointTurn,
      incremental: true,
      processedItems: 1,
      revision: this.revision,
      keyDirtyFrom,
    };
  }

  /** Recount a work group's ledger line after one of its items changed in place. */
  private refreshWorkSummary(groupIndex: number): void {
    const group = this.groups[groupIndex];
    if (group?.kind !== "work") return;
    const index = this.rowIndexes.get(`work:${group.id}`);
    const summary = index == null ? undefined : this.rows[index];
    if (summary?.kind !== "work_summary") return;
    const ledger = summarizeWork(group.items);
    if (!sameWork(summary, ledger)) this.rows[index!] = workSummaryRow(summary, ledger);
  }

  private rebuildToolIndex(): void {
    this.toolNodes.clear();
    this.toolParents.clear();
    this.toolChildIndexes.clear();
    this.toolRootGroups.clear();
    this.toolRootItemIndexes.clear();
    this.ownedTools = new WeakSet<ToolItem>();
    this.toolIdCounts.clear();
    this.unresolvedParentIds.clear();
    const count = (item: TimelineItem) => {
      if (item.kind !== "tool_call") return;
      this.toolIdCounts.set(item.toolCallId, (this.toolIdCounts.get(item.toolCallId) ?? 0) + 1);
      for (const child of item.children ?? []) count(child);
    };
    for (const group of this.groups) {
      if (group.kind === "work") for (const item of group.items) count(item);
      else count(group.item);
    }
    for (const item of this.items) {
      const parentId = "parentToolUseId" in item ? item.parentToolUseId : undefined;
      if (parentId && (this.toolIdCounts.get(parentId) ?? 0) !== 1) this.unresolvedParentIds.add(parentId);
    }
    const register = (
      item: TimelineItem,
      parentId: string | null,
      childIndex: number,
      rootGroup: number,
      rootItemIndex: number,
    ) => {
      if (item.kind !== "tool_call") return;
      if (item.children) this.ownedTools.add(item);
      if (this.toolIdCounts.get(item.toolCallId) === 1) {
        this.toolNodes.set(item.toolCallId, item);
        this.toolParents.set(item.toolCallId, parentId);
        this.toolChildIndexes.set(item.toolCallId, childIndex);
        this.toolRootGroups.set(item.toolCallId, rootGroup);
        this.toolRootItemIndexes.set(item.toolCallId, rootItemIndex);
      }
      item.children?.forEach((child, index) => register(child, item.toolCallId, index, rootGroup, rootItemIndex));
    };
    this.groups.forEach((group, groupIndex) => {
      if (group.kind === "work") group.items.forEach((item, itemIndex) => register(item, null, -1, groupIndex, itemIndex));
      else register(group.item, null, -1, groupIndex, 0);
    });
  }

  private collectToolIds(items: readonly TimelineItem[]): string[] {
    const ids: string[] = [];
    const visit = (item: TimelineItem) => {
      if (item.kind !== "tool_call") return;
      ids.push(item.toolCallId);
      for (const child of item.children ?? []) visit(child);
    };
    for (const item of items) visit(item);
    return ids;
  }

  private registerNewTools(
    items: readonly TimelineItem[],
    rootGroup: number,
    parentId: string | null,
    rootItemStart: number,
  ): void {
    items.forEach((item, itemIndex) => {
      if (item.kind !== "tool_call") return;
      const rootItemIndex = parentId == null ? rootItemStart + itemIndex : rootItemStart;
      this.toolNodes.set(item.toolCallId, item);
      this.toolParents.set(item.toolCallId, parentId);
      this.toolChildIndexes.set(item.toolCallId, parentId == null ? -1 : itemIndex);
      this.toolRootGroups.set(item.toolCallId, rootGroup);
      this.toolRootItemIndexes.set(item.toolCallId, rootItemIndex);
      if (item.children) this.ownedTools.add(item);
      this.registerNewTools(item.children ?? [], rootGroup, item.toolCallId, rootItemIndex);
    });
  }

  private indexItemLocation(
    item: TimelineItem,
    groupIndex: number,
    rootItemIndex: number,
    parentId: string | null,
    childIndex: number,
  ): void {
    this.itemLocations.set(item.id, { groupIndex, rootItemIndex, parentId, childIndex, item });
    if (item.kind !== "tool_call") return;
    item.children?.forEach((child, index) => this.indexItemLocation(
      child,
      groupIndex,
      rootItemIndex,
      item.toolCallId,
      index,
    ));
  }

  private rebuildItemLocations(): void {
    this.itemLocations.clear();
    this.groups.forEach((group, groupIndex) => {
      if (group.kind === "work") {
        group.items.forEach((item, itemIndex) => this.indexItemLocation(item, groupIndex, itemIndex, null, -1));
      } else {
        this.indexItemLocation(group.item, groupIndex, 0, null, -1);
      }
    });
  }

  private sameSourceItem(rendered: TimelineItem, raw: TimelineItem): boolean {
    return rendered === raw || (rendered.kind === "tool_call" && raw.kind === "tool_call" && rendered.toolCallId === raw.toolCallId);
  }

  private itemKey(item: TimelineItem): string {
    if (item.kind !== "tool_call") return `item:${item.kind}:${item.id}`;
    const identity = (this.toolIdCounts.get(item.toolCallId) ?? 0) === 1
      ? item.toolCallId
      : `${item.toolCallId}:${item.id}`;
    return `item:tool:${identity}`;
  }

  /** The row an item renders as: an agent call is its agent row, every other item its own row. */
  private rowKeyOf(item: TimelineItem): string {
    const key = this.itemKey(item);
    return rendersSubagentSummary(item) ? `agent:${key.slice("item:tool:".length)}` : key;
  }

  private patchVisibleItem(previous: TimelineItem, changed: TimelineItem): void {
    const key = this.itemKey(previous);
    const index = this.rowIndexes.get(key);
    const row = index == null ? undefined : this.rows[index];
    if (row?.kind === "item") this.rows[index!] = { ...row, item: changed };
    // An agent call renders as its agent row and output row, keyed by the same identity as its
    // item key, which disambiguates a tool id two calls share; `patchToolRows` sees unique ids only.
    if (changed.kind !== "tool_call" || !key.startsWith("item:tool:")) return;
    const identity = key.slice("item:tool:".length);
    const summaryIndex = this.rowIndexes.get(`agent:${identity}`);
    const summary = summaryIndex == null ? undefined : this.rows[summaryIndex];
    if (summary?.kind === "subagent_summary") this.rows[summaryIndex!] = { ...summary, tool: changed };
    const outputIndex = this.rowIndexes.get(`agent-output:${identity}`);
    const output = outputIndex == null ? undefined : this.rows[outputIndex];
    if (output?.kind === "subagent_output") this.rows[outputIndex!] = { ...output, tool: changed };
  }

  private patchToolRows(tools: ReadonlyMap<string, ToolItem>): void {
    for (const [toolId, tool] of tools) {
      const itemIndex = this.rowIndexes.get(`item:tool:${toolId}`);
      const itemRow = itemIndex == null ? undefined : this.rows[itemIndex];
      if (itemRow?.kind === "item") this.rows[itemIndex!] = { ...itemRow, item: tool };
      const summaryIndex = this.rowIndexes.get(`agent:${toolId}`);
      const summaryRow = summaryIndex == null ? undefined : this.rows[summaryIndex];
      if (summaryRow?.kind === "subagent_summary") this.rows[summaryIndex!] = { ...summaryRow, tool };
      const outputIndex = this.rowIndexes.get(`agent-output:${toolId}`);
      const outputRow = outputIndex == null ? undefined : this.rows[outputIndex];
      if (outputRow?.kind === "subagent_output") this.rows[outputIndex!] = { ...outputRow, tool };
    }
  }

  private subtreeBoundary(summaryIndex: number, _depth: number): number {
    const summary = this.rows[summaryIndex];
    if (summary?.kind !== "subagent_summary") return this.rows.length;
    const boundaryKey = this.summaryBoundaryKeys.get(summary.key);
    return boundaryKey == null ? this.rows.length : this.rowIndexes.get(boundaryKey) ?? this.rows.length;
  }

  private rowDepth(row: TimelineRenderRow): number {
    return row.kind === "work_summary" ? -1 : row.depth;
  }

  private setSummaryBoundary(summaryKey: string, boundaryKey: string | null): void {
    if (this.summaryBoundaryKeys.has(summaryKey)) {
      const previous = this.summaryBoundaryKeys.get(summaryKey) ?? null;
      const dependents = this.boundaryDependents.get(previous);
      dependents?.delete(summaryKey);
      if (dependents?.size === 0) this.boundaryDependents.delete(previous);
    }
    this.summaryBoundaryKeys.set(summaryKey, boundaryKey);
    const dependents = this.boundaryDependents.get(boundaryKey) ?? new Set<string>();
    dependents.add(summaryKey);
    this.boundaryDependents.set(boundaryKey, dependents);
  }

  private removeSummaryBoundary(summaryKey: string): void {
    if (!this.summaryBoundaryKeys.has(summaryKey)) return;
    const boundaryKey = this.summaryBoundaryKeys.get(summaryKey) ?? null;
    this.summaryBoundaryKeys.delete(summaryKey);
    const dependents = this.boundaryDependents.get(boundaryKey);
    dependents?.delete(summaryKey);
    if (dependents?.size === 0) this.boundaryDependents.delete(boundaryKey);
  }

  private indexInsertedRows(rows: readonly TimelineRenderRow[], externalBoundaryKey: string | null): void {
    if (!rows.length) return;
    const first = rows[0]!;
    const firstDepth = this.rowDepth(first);
    for (const summaryKey of [...(this.boundaryDependents.get(externalBoundaryKey) ?? [])]) {
      const summaryIndex = this.rowIndexes.get(summaryKey);
      const summary = summaryIndex == null ? undefined : this.rows[summaryIndex];
      if (summary?.kind === "subagent_summary" && summary.depth >= firstDepth) {
        this.setSummaryBoundary(summaryKey, first.key);
      }
    }
    const stack: Array<{ key: string; depth: number }> = [];
    for (const row of rows) {
      const depth = this.rowDepth(row);
      while (stack.length && stack.at(-1)!.depth >= depth) {
        this.setSummaryBoundary(stack.pop()!.key, row.key);
      }
      if (row.kind === "subagent_summary") stack.push({ key: row.key, depth: row.depth });
    }
    while (stack.length) this.setSummaryBoundary(stack.pop()!.key, externalBoundaryKey);
  }

  private rebuildSummaryBoundaries(): void {
    this.summaryBoundaryKeys.clear();
    this.boundaryDependents.clear();
    this.indexInsertedRows(this.rows, null);
  }

  private reindexRows(start: number): void {
    for (let index = start; index < this.rowKeys.length; index += 1) {
      this.rowIndexes.delete(this.rowKeys[index]!);
    }
    this.rowKeys.length = start;
    for (let index = start; index < this.rows.length; index += 1) {
      const row = this.rows[index]!;
      const key = row.key;
      this.rowIndexes.set(key, index);
      if (row.kind === "item") {
        this.revealRowKeys.set(row.item.id, key);
        for (const attempt of row.attempts ?? []) this.revealRowKeys.set(attempt.id, key);
      } else if (row.kind === "subagent_summary") {
        this.revealRowKeys.set(row.tool.id, key);
      }
      this.rowKeys[index] = key;
    }
  }
}

function textStream(item: TimelineItem): { key: string; start: number; end: number } | null {
  if (item.kind !== "agent_message" && item.kind !== "agent_thought" &&
      item.kind !== "command_output" && item.kind !== "stderr") return null;
  const parent = "parentToolUseId" in item ? item.parentToolUseId ?? "" : "";
  return { key: `${item.kind}:${parent}`, start: item.id, end: item.sourceEndId ?? item.id };
}

function itemSourceEnd(item: TimelineItem): number {
  return item.kind === "agent_message" || item.kind === "agent_thought" ||
    item.kind === "command_output" || item.kind === "stderr"
    ? item.sourceEndId ?? item.id
    : item.id;
}

/** A tail-first cache may initially expose a work block at the transcript head and later recover
 * its preceding user row. Reuse the old block id whenever source ranges overlap so disclosure and
 * virtual anchors survive that newly-discovered boundary. A newly prepended, disjoint head block
 * must yield that natural id to the retained block; duplicate virtual keys would otherwise bind
 * the reading anchor to the new window head instead of the old page boundary. */
export function stabilizeWorkGroupKeys(
  groups: TimelineGroup[],
  previous: readonly TimelineGroup[],
): TimelineGroup[] {
  const candidates = previous
    .filter((group): group is Extract<TimelineGroup, { kind: "work" }> => group.kind === "work")
    .map((group) => ({
      group,
      start: group.items[0]?.id ?? 0,
      end: group.items.reduce((end, item) => Math.max(end, itemSourceEnd(item)), 0),
    }));
  const retainedIds = new Map<number, string>();
  const reservedIds = new Set<string>();
  let offset = 0;
  groups.forEach((group, index) => {
    if (group.kind !== "work" || group.items.length === 0) return;
    const start = group.items[0]!.id;
    const end = group.items.reduce((value, item) => Math.max(value, itemSourceEnd(item)), start);
    while (offset < candidates.length && candidates[offset]!.end < start) offset += 1;
    const candidate = candidates[offset];
    if (!candidate || candidate.start > end) return;
    offset += 1;
    retainedIds.set(index, candidate.group.id);
    reservedIds.add(candidate.group.id);
  });

  const usedIds = new Set<string>();
  return groups.map((group, index) => {
    if (group.kind !== "work" || group.items.length === 0) return group;
    const retainedId = retainedIds.get(index);
    let id = retainedId ?? group.id;
    if (retainedId == null && (reservedIds.has(id) || usedIds.has(id))) {
      const source = timelineBoundaryKey(group.items[0]!);
      id = `${group.id}:${source}`;
      let suffix = 2;
      while (reservedIds.has(id) || usedIds.has(id)) id = `${group.id}:${source}:${suffix++}`;
    }
    usedIds.add(id);
    return id === group.id ? group : { ...group, id };
  });
}

/** Reuses a streamed text row's prior render key when recovery extends its source range backward.
 * The merge is linear in row count and also covers forward chunk growth without key churn. */
export function stabilizeTimelineRowKeys(
  rows: TimelineRenderRow[],
  previous: readonly TimelineRenderRow[],
): TimelineRenderRow[] {
  const candidates = new Map<string, Array<{ row: TimelineRenderRow; start: number; end: number }>>();
  for (const row of previous) {
    if (row.kind !== "item") continue;
    const stream = textStream(row.item);
    if (!stream) continue;
    const list = candidates.get(stream.key) ?? [];
    list.push({ row, start: stream.start, end: stream.end });
    candidates.set(stream.key, list);
  }
  const offsets = new Map<string, number>();
  return rows.map((row) => {
    if (row.kind !== "item") return row;
    const stream = textStream(row.item);
    if (!stream) return row;
    const list = candidates.get(stream.key);
    if (!list?.length) return row;
    let offset = offsets.get(stream.key) ?? 0;
    while (offset < list.length && list[offset]!.end < stream.start) offset += 1;
    const candidate = list[offset];
    if (!candidate || candidate.start > stream.end) {
      offsets.set(stream.key, offset);
      return row;
    }
    offsets.set(stream.key, offset + 1);
    return candidate.row.key === row.key ? row : { ...row, key: candidate.row.key };
  });
}

/** A work summary row with a recounted ledger; the spread never keeps a stale optional field. */
function workSummaryRow(
  summary: Extract<TimelineRenderRow, { kind: "work_summary" }>,
  ledger: WorkLedger,
): Extract<TimelineRenderRow, { kind: "work_summary" }> {
  return { kind: "work_summary", key: summary.key, firstItemId: summary.firstItemId, open: summary.open, ...ledger };
}

export function flattenTimelineRows(
  groups: ReturnType<typeof groupTimeline>,
  disclosure: ReadonlyMap<string, boolean>,
  showAgentLogs = true,
): TimelineRenderRow[] {
  const rows: TimelineRenderRow[] = [];
  const toolIds = new Map<string, number>();
  const countTools = (item: TimelineItem) => {
    if (item.kind !== "tool_call") return;
    toolIds.set(item.toolCallId, (toolIds.get(item.toolCallId) ?? 0) + 1);
    for (const child of item.children ?? []) countTools(child);
  };
  for (const group of groups) {
    if (group.kind === "item") countTools(group.item);
    else for (const item of group.items) countTools(item);
  }
  for (const group of groups) {
    if (group.kind === "item") {
      rows.push(...flattenTimelineItemRows([group.item], disclosure, false, 0, toolIds));
      continue;
    }
    if (!showAgentLogs && agentLogOnly(group.items)) continue;
    const key = `work:${group.id}`;
    const open = disclosure.get(key) ?? false;
    rows.push({ kind: "work_summary", key, firstItemId: group.items[0]?.id, ...summarizeWork(group.items), open });
    if (open) rows.push(...flattenTimelineItemRows(group.items, disclosure, true, 0, toolIds));
  }
  return rows;
}

function flattenTimelineItemRows(
  items: readonly TimelineItem[],
  disclosure: ReadonlyMap<string, boolean>,
  inWork: boolean,
  depth: number,
  toolIds: ReadonlyMap<string, number>,
  /** Flatten this open agent's body (its steps and output) instead of `items`. */
  agentBodyOf?: ToolItem,
): TimelineRenderRow[] {
  const rows: TimelineRenderRow[] = [];
  const toolIdentity = (item: ToolItem) => (toolIds.get(item.toolCallId) ?? 0) === 1
    ? item.toolCallId
    : `${item.toolCallId}:${item.id}`;
  const appendSteps = (container: readonly TimelineItem[], nestedInWork: boolean, itemDepth: number) => {
    for (const { item, attempts } of foldRetries(container)) {
      if (!timelineItemRendersRow(item)) continue;
      // One row, not two (#2183): the agent's row carries its spawning call's name and status, so
      // that call has no step row of its own. Agent calls never fold, so nothing is lost.
      if (item.kind === "tool_call" && ownsSubagent(item)) {
        const key = `agent:${toolIdentity(item)}`;
        const childCount = item.children?.length ?? 0;
        const open = disclosure.get(key) ?? automaticSubagentOpen(itemDepth, childCount);
        rows.push({ kind: "subagent_summary", key, tool: item, depth: itemDepth, open });
        if (open) appendAgentBody(item, itemDepth + 1);
        continue;
      }
      // A folded retry keeps its first attempt's key, so a later attempt never remounts the row.
      const keyed = attempts?.[0] ?? item;
      const itemKey = keyed.kind === "tool_call" ? `item:tool:${toolIdentity(keyed)}` : `item:${keyed.kind}:${keyed.id}`;
      rows.push(attempts
        ? { kind: "item", key: itemKey, item, inWork: nestedInWork, depth: itemDepth, attempts }
        : { kind: "item", key: itemKey, item, inWork: nestedInWork, depth: itemDepth });
    }
  };
  // An open agent's steps, then its call's own output last, as a command's output follows it.
  const appendAgentBody = (tool: ToolItem, bodyDepth: number) => {
    appendSteps(tool.children ?? [], true, bodyDepth);
    if (hasToolOutput(tool)) rows.push({ kind: "subagent_output", key: `agent-output:${toolIdentity(tool)}`, tool, depth: bodyDepth });
  };
  if (agentBodyOf) appendAgentBody(agentBodyOf, depth);
  else appendSteps(items, inWork, depth);
  return rows;
}

/** The subagent vocabulary (§11.2) for an agent call: the provider's lifecycle when it reported
 * one, otherwise the call's own status. An unreachable agent is Lost, as in the Agents panel. */
export function subagentStatusMeta(tool: Pick<ToolItem, "status" | "subagentLifecycle">) {
  const lifecycle = deriveSubagentLifecycle(tool.status, "running", true, tool.subagentLifecycle);
  return statusMeta("job", lifecycle === "unreachable" ? "lost" : lifecycle);
}

/**
 * One agent a turn spawned (#2183): the §5.5 chevron, a Bot icon, the spawning call's name, its
 * role when the provider gave one and its step count, then its status (Running a pulsing badge,
 * every other state inline) and Open. The disclosure shows the agent's steps on the work rule;
 * deeper or large trees mount lazily only after disclosure, so an event burst never renders an
 * arbitrarily deep or large hidden subtree. Local state survives streamed child updates.
 */
function SubagentSummary({ tool, open, onToggle, onOpen }: {
  tool: ToolItem;
  open: boolean;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  const timingId = useId();
  const name = subagentName(tool);
  const role = tool.subagentRole ? titleCaseLabel(tool.subagentRole) : undefined;
  const steps = foldRetries(tool.children ?? []).filter((step) => timelineItemRendersRow(step.item)).length;
  const stepCount = `${steps} Step${steps === 1 ? "" : "s"}`;
  const status = subagentStatusMeta(tool);
  const span = useStepSpan(tool.startedAt, tool.lastActivityAt, tool.completedAt, status.pulse === true);
  return (
    <div className={`tl-agent${open ? " open" : ""}`}>
      <button
        type="button"
        className="disclosure-trigger tl-agent-toggle"
        aria-expanded={open}
        aria-label={[name, role, stepCount, status.label].filter(Boolean).join(" · ")}
        aria-describedby={span.description ? timingId : undefined}
        onClick={onToggle}
      >
        <ChevronRightIcon size={14} className="disclosure-chevron" />
        <span className="tl-step-icon"><BotIcon size={16} /></span>
        <span className="tl-agent-name">{name}</span>
        <span className="tl-agent-meta">
          {role && <span className="tl-agent-role">{role}</span>}
          <span className="tl-agent-steps">{stepCount}</span>
        </span>
        <StatusBadge meta={status} inline={!status.pulse} className="tl-agent-status" />
        {span.description && <span id={timingId} className="sr-only">{span.description}</span>}
      </button>
      {onOpen && (
        <button type="button" className="btn sm ghost" onClick={onOpen} aria-label={`Open ${name}`}>
          Open
        </button>
      )}
    </div>
  );
}

/** The spawning call's own output, last in an open agent's body: the result it returned, or why it
 * failed, in the quiet output well with a failure's lines in the danger colour. Collapsed to one
 * line, as a step's output is; its name ties it to the agent. */
function SubagentOutput({ tool, open, onToggle }: { tool: ToolItem; open: boolean; onToggle: () => void }) {
  return (
    <ToolStep
      icon={toolIcon()}
      verb="Result"
      label={`Result of ${subagentName(tool)}`}
      open={open}
      onToggle={onToggle}
    >
      <ToolOutput item={tool} failed={tool.status === "failed"} />
    </ToolStep>
  );
}

/** Default/automatic disclosure policy; exported so live empty→child and large-tree transitions
 * have a pure compatibility contract in addition to browser interaction coverage. */
export function automaticSubagentOpen(depth: number, itemCount: number): boolean {
  return depth === 0 && itemCount > 0 && itemCount <= 40;
}

export function automaticSubagentOpenAfterChange(
  depth: number,
  previousCount: number,
  itemCount: number,
  userToggled: boolean,
  current: boolean,
): boolean {
  if (userToggled) return current;
  if (previousCount === 0 && itemCount > 0) return automaticSubagentOpen(depth, itemCount);
  if (itemCount > 40) return false;
  return current;
}

/** Memoized on item identity: the builder clones-on-write, so only the row whose item actually
 * changed re-renders on a streamed chunk — the rest of a long transcript is skipped entirely. */
const TimelineRow = memo(function TimelineRow({
  item,
  attempts,
  onRewind,
  rewindTurn,
  rewindUnavailableReason,
  onEditAndResend,
  editAndResendUnavailableReason,
  onEditInFork,
  onOpenSourceLocation,
  editInForkAvailability,
  standaloneCopy = false,
  inTurnMenu = false,
  failedTurnPrompt,
  highlightEligible = true,
  disclosureOpen = false,
  onDisclosureToggle,
  questionContext,
  approvalContext,
}: {
  item: TimelineItem;
  /** A folded retry's attempts, oldest first, when `item` is its latest. */
  attempts?: readonly ToolItem[];
  onRewind?: (turn: number) => void;
  rewindTurn?: number;
  rewindUnavailableReason?: string;
  onEditAndResend?: (item: Extract<TimelineItem, { kind: "user_message" }>) => void;
  /** Why Edit & Resend cannot be used now; it then stays visible, disabled with this reason. */
  editAndResendUnavailableReason?: string;
  onEditInFork?: (item: Extract<TimelineItem, { kind: "user_message" }>, forkTurn: number) => void;
  onOpenSourceLocation?: (location: SourceLocation) => void;
  editInForkAvailability?: EditInForkAvailability;
  /** A reply no turn footer copies (a subagent's) keeps its own Copy. */
  standaloneCopy?: boolean;
  /** A user message its settled turn's More Turn Actions already lists. */
  inTurnMenu?: boolean;
  /** For an error: the prompt that opened its turn, which Retry Turn submits again. */
  failedTurnPrompt?: UserMessageItem;
  highlightEligible?: boolean;
  disclosureOpen?: boolean;
  onDisclosureToggle?: () => void;
  questionContext?: TimelineQuestionContext;
  approvalContext?: TimelineApprovalContext;
}) {
  const sessionActive = useContext(TimelineActivityContext);
  const mediaSettled = timelineMediaSettled(item, sessionActive);
  switch (item.kind) {
    case "artifact_attached":
      return <TranscriptArtifact artifact={item.artifact} />;
    case "checkpoint_restored":
      return (
        <HistoryDivider
          icon={<RewindFilesIcon size={14} />}
          label={`Files Rewound to Before Turn ${item.turn}`}
          title={`Files restored to the checkpoint before turn ${item.turn}`}
        />
      );
    case "conversation_forked":
      return <ForkDivider item={item} />;
    case "provider_account_switched":
      return <AccountSwitchDivider item={item} />;
    case "user_message":
      return (
        <div className="tl-row user">
          <div className="tl-message-stack user">
            <div className="tl-bubble">
              {item.images && item.images.length > 0 && (
                <div className="bubble-images">
                  {item.images.filter((attachment) => !isWorkspaceReference(attachment)).map((img, i) => (
                    <PromptImageView key={"artifactId" in img ? img.artifactId : i} image={img} alt={`attachment ${i + 1}`} />
                  ))}
                  {item.images.filter(isWorkspaceReference).map((reference) => (
                    <ReadonlyReferenceChip key={reference.artifactId} reference={reference} />
                  ))}
                </div>
              )}
              {item.text && <div className="bubble-text"><Markdown profile="inline" highlightEligible={highlightEligible}>{item.text}</Markdown></div>}
            </div>
            {/* A steer the agent took keeps one quiet fact under it (#2171). */}
            {item.deliveryIntent === "steer" && item.submissionId && (
              <div className="tl-receipt" data-status="steered">
                <StatusBadge meta={statusMeta("messageReceipt", "steered")} inline className="tl-receipt-status" />
              </div>
            )}
            <UserMessageActions
              item={item}
              inTurnMenu={inTurnMenu}
              onRewind={onRewind}
              rewindTurn={rewindTurn}
              rewindUnavailableReason={rewindUnavailableReason}
              onEditAndResend={onEditAndResend}
              editAndResendUnavailableReason={editAndResendUnavailableReason}
              onEditInFork={onEditInFork}
              editInForkAvailability={editInForkAvailability}
            />
          </div>
        </div>
      );
    case "agent_message":
      // Codex-style: the model response is full-width document flow, not a chat bubble. Its time,
      // usage and actions live once in the turn's footer.
      return (
        <div className="tl-agent-msg">
          <Markdown highlightEligible={highlightEligible} inlineMedia settled={mediaSettled}>{item.text}</Markdown>
          {standaloneCopy && item.text && (
            <div className="tl-message-actions tl-reply-actions" role="group" aria-label="Message Actions">
              <CopyButton text={item.text} format={markdownPlainText} iconOnly ariaLabel="Copy Response" className="icon-btn sm" />
            </div>
          )}
        </div>
      );
    case "agent_thought":
      return (
        <ThoughtStep
          item={item}
          open={disclosureOpen}
          onToggle={onDisclosureToggle}
          highlightEligible={highlightEligible}
          mediaSettled={mediaSettled}
        />
      );
    case "tool_call":
      return <ToolCallStep item={item} attempts={attempts} open={disclosureOpen} onToggle={onDisclosureToggle} />;
    case "plan":
      return <PlanBlock item={item} historyOpen={disclosureOpen} onHistoryToggle={onDisclosureToggle} />;
    case "file_edit":
      return (
        <FileEditStep
          item={item}
          open={disclosureOpen}
          onToggle={onDisclosureToggle}
          onOpenSourceLocation={onOpenSourceLocation}
        />
      );
    case "command_output":
      return (
        <div className="tl-output">
          <EventPayloadContent preview={item.text} references={item.textRefs} mimeType="text/plain" label="Output">
            {(text) => <pre>{text}</pre>}
          </EventPayloadContent>
        </div>
      );
    case "stderr":
      return <AgentLogStep item={item} open={disclosureOpen} onToggle={onDisclosureToggle} />;
    case "error":
      return <TurnFailedNotice message={item.message} prompt={failedTurnPrompt} />;
    case "turn_interrupted":
      // The row shows only its turn's footer ("Stopped at …"); EventTimelineBody renders that.
      return null;
    case "review_decision":
      return (
        <div className="tl-perm">
          <div className="tl-perm-head">
            <span className="perm-icon">Review</span>
            <span>Automated Review</span>
            <span className="perm-resolved">
              {titleCaseLabel(item.outcome.replace("_", " "))}{item.riskLevel ? ` (${titleCaseLabel(item.riskLevel)} Risk)` : ""}
            </span>
            <span>{titleCaseLabel(item.reviewer.kind)}{item.reviewer.id ? ` · ${item.reviewer.id}` : ""}</span>
            <ActivityTimestampMeta startedAt={item.createdAt} pointWhenEqual />
          </div>
          {item.rationale && <div className="bubble-text">{item.rationale}</div>}
        </div>
      );
    case "permission":
      return (
        <div
          className="tl-perm"
          data-session-request-id={approvalContext?.requestId}
          data-session-request-session={approvalContext?.sessionId}
        >
          <div className="tl-perm-head">
            <span className="perm-icon">🔐</span>
            <span>{item.title}</span>
            {item.resolvedOptionId !== undefined ? (
              <span className="perm-resolved">
                {item.resolvedByParentSessionId
                  ? item.resolvedOptionId == null
                    ? `→ Dismissed by Parent ${item.resolvedByParentSessionId}`
                    : (() => {
                      const option = item.options.find((candidate) => candidate.optionId === item.resolvedOptionId);
                      return option?.kind === "allow_once" || (option?.kind == null && item.resolvedOptionId === "allow");
                    })()
                      ? `→ Approved by Parent ${item.resolvedByParentSessionId}`
                      : `→ Denied by Parent ${item.resolvedByParentSessionId}`
                  : item.resolutionReason === "replaced"
                  ? "→ Replaced"
                  : item.resolutionReason === "provider_resolved"
                    ? "→ Resolved by Provider"
                    : item.resolutionReason === "dismissed"
                      ? "→ Dismissed"
                      : item.resolvedOptionId
                      ? `→ ${permissionResolutionLabel(item.options, item.resolvedOptionId)}`
                      : "→ Dismissed"}
              </span>
            ) : (
              <span className="perm-pending">awaiting decision…</span>
            )}
            {approvalContext && (
              <button
                className="btn primary sm tl-perm-review"
                type="button"
                data-session-request-control="review"
                aria-controls="right-panel"
                onClick={approvalContext.onOpenRequest}
              >
                Review Request
              </button>
            )}
          </div>
          {item.context?.input && (
            <details
              className="perm-context"
              open={disclosureOpen}
              onToggle={(event) => {
                if (event.nativeEvent.isTrusted && event.currentTarget.open !== disclosureOpen) onDisclosureToggle?.();
              }}
            >
              <summary>What Was Requested</summary>
              <pre>{item.context.input}</pre>
            </details>
          )}
        </div>
      );
    case "governance_decision": {
      const decision = item.decision;
      return (
        <div className={`tl-governance ${decision.tone}`} data-audit-id={decision.auditId}>
          <details
            className="governance-decision"
            open={disclosureOpen}
            onToggle={(event) => {
              if (event.nativeEvent.isTrusted && event.currentTarget.open !== disclosureOpen) onDisclosureToggle?.();
            }}
          >
            <summary className="tl-governance-head">
              <span className="governance-icon" aria-hidden="true">⚖️</span>
              <span className="sr-only">Governance Decision: </span>
              <span className="governance-label">{decision.label}</span>
              <ActivityTimestampMeta startedAt={decision.timestamp} pointWhenEqual />
            </summary>
            <GovernanceDecisionFacts decision={decision} />
          </details>
        </div>
      );
    }
    case "question": {
      const historicalQuestion = <QuestionHistoryRow item={item} open={disclosureOpen} onToggle={onDisclosureToggle} />;
      return questionContext ? (
        <SessionTimelineQuestionRegion
          sessionId={questionContext.sessionId}
          pendingQuestion={questionContext.pendingQuestion}
          eventRequestId={item.requestId}
          eventQuestions={item.questions}
          eventResolved={item.answered !== undefined}
          runnerOnline={questionContext.runnerOnline}
          onSessionUpdate={questionContext.onSessionUpdate}
          showKeyHints={questionContext.showKeyHints}
        >
          {historicalQuestion}
        </SessionTimelineQuestionRegion>
      ) : historicalQuestion;
    }
  }
});

const RUNNING_TOOL_STATUSES = new Set(["pending", "in_progress", "running"]);

/** A step's span: its start, its finish when it has one, and the duration a running step has had
 * so far by the timeline's shared clock. */
function useStepSpan(startedAt: number | undefined, lastActivityAt: number | undefined, completedAt: number | undefined, running: boolean) {
  const now = useContext(TimelineClockContext);
  const sessionActive = useContext(TimelineActivityContext);
  const start = Number.isFinite(startedAt) ? startedAt : undefined;
  const finish = Number.isFinite(completedAt) ? completedAt : Number.isFinite(lastActivityAt) ? lastActivityAt : undefined;
  const live = running && sessionActive;
  const end = live ? Math.max(now, finish ?? now) : finish;
  const durationMs = start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined;
  // One settled observation is a moment, not a zero-length span.
  return {
    durationMs,
    description: live
      ? activitySpanDescription(start, undefined)
      : activitySpanDescription(finish === start ? undefined : start, finish),
  };
}

/** The accessible name starts with the visible title ("Run npm test"), never the provider's raw
 * "Bash: npm test", so speech input can target what is on screen. */
function stepLabel(title: string, status: string, fact?: string): string {
  return [title, fact, toolStatusMeta(status).label].filter(Boolean).join(" · ");
}

function ToolOutput({ item, failed }: { item: ToolItem; failed: boolean }) {
  return (
    <>
      {item.text && <StepOutput text={item.text} failed={failed} />}
      {item.referencedText?.map((fragment, index) => (
        <EventPayloadContent
          key={`${fragment.refs[0]?.artifactId ?? index}:${index}`}
          preview=""
          references={fragment.refs}
          mimeType="text/plain"
          label="Tool Content"
          appendFull
        >
          {(text, full) => full ? <StepOutput text={text} failed={failed} /> : null}
        </EventPayloadContent>
      ))}
    </>
  );
}

const hasToolOutput = (item: ToolItem): boolean => Boolean(item.text || item.referencedText?.length);

/** One tool call, or every attempt of a retried one folded into a single "3 Attempts" step. */
function ToolCallStep({ item, attempts, open, onToggle }: {
  item: ToolItem;
  attempts?: readonly ToolItem[];
  open: boolean;
  onToggle?: () => void;
}) {
  const workspaceRoot = useContext(WorkspaceRootContext);
  const { verb, object } = splitStepTitle(item.title, workspaceRoot);
  const first = attempts?.[0] ?? item;
  const span = useStepSpan(first.startedAt, item.lastActivityAt, item.completedAt, RUNNING_TOOL_STATUSES.has(item.status));
  const failed = item.status === "failed";
  const lineCount = item.text ? item.text.replace(/\n$/, "").split("\n").length : 0;
  const fact = attempts
    ? `${attempts.length} Attempts`
    : span.durationMs ? formatDuration(span.durationMs) : lineCount ? `${lineCount} Line${lineCount === 1 ? "" : "s"}` : undefined;
  const body = attempts ? (
    <ol className="tl-step-attempts">
      {attempts.map((attempt, index) => (
        <li key={attempt.id} className="tl-step-attempt">
          <span className="tl-step-attempt-head">
            <span>Attempt {index + 1}</span>
            <StepStatus status={attempt.status} />
          </span>
          <ToolOutput item={attempt} failed={attempt.status === "failed"} />
        </li>
      ))}
    </ol>
  ) : hasToolOutput(item) ? <ToolOutput item={item} failed={failed} /> : null;
  return (
    <ToolStep
      icon={toolIcon(item.toolKind)}
      verb={verb}
      object={object}
      trail={fact}
      timing={span.description || undefined}
      status={<StepStatus status={item.status} />}
      label={stepLabel(object ? `${verb} ${object}` : verb, item.status, attempts ? fact : undefined)}
      open={open}
      onToggle={onToggle}
    >
      {body}
    </ToolStep>
  );
}

/** Reasoning as a step: "Thought for 2s", its text aligned with the row's title when opened. */
function ThoughtStep({ item, open, onToggle, highlightEligible, mediaSettled }: {
  item: Extract<TimelineItem, { kind: "agent_thought" }>;
  open: boolean;
  onToggle?: () => void;
  highlightEligible: boolean;
  mediaSettled: boolean;
}) {
  const sessionActive = useContext(TimelineActivityContext);
  const live = sessionActive && timelineItemIsStreaming(item);
  const span = useStepSpan(item.createdAt, item.lastActivityAt, item.completedAt, live);
  const title = live
    ? "Thinking"
    : span.durationMs !== undefined && span.durationMs >= 1_000 ? `Thought for ${formatDuration(span.durationMs)}` : "Thought";
  return (
    <ToolStep
      icon={<ThoughtIcon size={16} />}
      verb={title}
      timing={span.description || undefined}
      status={<StepStatus status={live ? "running" : "completed"} />}
      label={`${title} · ${live ? "Running" : "Completed"}`}
      open={open}
      onToggle={onToggle}
    >
      {item.text && (
        <div className="tl-step-prose">
          <Markdown highlightEligible={highlightEligible} inlineMedia settled={mediaSettled}>{item.text}</Markdown>
        </div>
      )}
    </ToolStep>
  );
}

/** A path in mono 12px, its directory faint and its file name in full text (#2187). Short of
 * room, the directory gives way before the file name (§11.3); the whole path is its title. */
function PathLabel({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className="tl-path" title={path}>
      {slash > 0 && <span className="tl-path-dir">{path.slice(0, slash + 1)}</span>}
      <span className="tl-path-name">{path.slice(slash + 1)}</span>
    </span>
  );
}

/**
 * A file edit names its workspace-relative path once, with its +/− counts (#2187). Its body is the
 * parsed diff under Open in Review, Copy Path and Open File.
 */
function FileEditStep({ item, open, onToggle, onOpenSourceLocation }: {
  item: Extract<TimelineItem, { kind: "file_edit" }>;
  open: boolean;
  onToggle?: () => void;
  onOpenSourceLocation?: (location: SourceLocation) => void;
}) {
  const workspaceRoot = useContext(WorkspaceRootContext);
  const openInReview = useContext(OpenInReviewContext);
  // The runner's per-turn capture spans the whole worktree: it names no single file to act on.
  const capture = item.path === "worktree";
  const path = workspaceRelativePath(item.path, workspaceRoot);
  const sourceLocation = capture ? null : timelineFileSourceLocation(path);
  const counts = diffLineCounts(item.diff);
  const fact = counts ? `+${counts.added} \u2212${counts.removed}` : undefined;
  const files = useMemo(() => item.diff ? parseUnifiedDiff(item.diff) : [], [item.diff]);
  const created = !capture && files.length === 1 && files[0]!.isNew;
  const hasDiff = Boolean(item.diff || item.diffRefs?.length);
  const actions = !capture && (
    <div className="tl-diff-actions">
      {sourceLocation && openInReview && (
        <button type="button" className="btn sm ghost" onClick={() => openInReview(sourceLocation.path)}>Open in Review</button>
      )}
      <CopyButton text={path} label="Copy Path" className="btn sm ghost" />
      {sourceLocation && onOpenSourceLocation && (
        <button type="button" className="btn sm ghost" onClick={() => onOpenSourceLocation(sourceLocation)}>Open File</button>
      )}
    </div>
  );
  return (
    <ToolStep
      icon={created ? <NewFileIcon size={16} /> : <FileEditIcon size={16} />}
      verb="Edit"
      object={<PathLabel path={path} />}
      trail={fact}
      status={<StepStatus status="completed" />}
      label={`Edit ${path}${fact ? ` · ${fact}` : ""} · Completed`}
      open={open}
      onToggle={onToggle}
    >
      {actions}
      {hasDiff && (
        <EventPayloadContent
          preview={item.diff ?? ""}
          references={item.diffRefs}
          mimeType="text/x-diff"
          label="Diff"
        >
          {(text) => <DiffBlock diff={text} namesFiles={capture} />}
        </EventPayloadContent>
      )}
    </ToolStep>
  );
}

/**
 * A harness's own output (stderr, such as a boot line) as a quiet step in its run of work (#2184):
 * its text in the neutral well, never the danger tone. A run with nothing else in it renders only
 * while Show Agent Logs is on.
 */
function AgentLogStep({ item, open, onToggle }: {
  item: Extract<TimelineItem, { kind: "stderr" }>;
  open: boolean;
  onToggle?: () => void;
}) {
  // A preview cut short by stored references would undercount, so only a complete text is counted.
  const lineCount = item.text && !item.textRefs?.length ? item.text.replace(/\n$/, "").split("\n").length : 0;
  const fact = lineCount ? `${lineCount} Line${lineCount === 1 ? "" : "s"}` : undefined;
  return (
    <ToolStep
      icon={<AgentLogIcon size={16} />}
      verb="Agent Log"
      trail={fact}
      label={fact ? `Agent Log · ${fact}` : "Agent Log"}
      open={open}
      onToggle={onToggle}
    >
      {item.text || item.textRefs?.length ? (
        <EventPayloadContent preview={item.text} references={item.textRefs} mimeType="text/plain" label="Agent Log">
          {(text) => <StepOutput text={text} />}
        </EventPayloadContent>
      ) : null}
    </ToolStep>
  );
}

function TimelineTimestamp({ label, timestamp }: { label: "Recorded" | "Started" | "Last Activity"; timestamp?: number }) {
  const now = useContext(TimelineClockContext);
  const sessionActive = useContext(TimelineActivityContext);
  const absolute = formatRecordedTimestamp(timestamp);
  const relative = formatRecordedRelativeTime(timestamp, now);
  if (!absolute || !relative) return null;
  const absoluteMoment = absolute.title.startsWith("Recorded ")
    ? absolute.title.slice("Recorded ".length)
    : absolute.title;
  const description = `${label} ${absoluteMoment}`;
  return (
    <span className="tl-timestamp-value">
      <span className="tl-timestamp-label">{label}</span>{" "}
      <time dateTime={absolute.dateTime} title={description}>
        <span aria-hidden="true">{sessionActive ? relative : absolute.label}</span>
        <span className="sr-only">{absoluteMoment}</span>
      </time>
    </span>
  );
}

function ActivityTimestampMeta({
  id,
  startedAt,
  lastActivityAt,
  completedAt,
  durationOverrideMs,
  pointWhenEqual = false,
  showDuration = false,
  className,
}: {
  id?: string;
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  durationOverrideMs?: number;
  pointWhenEqual?: boolean;
  showDuration?: boolean;
  className?: string;
}) {
  const now = useContext(TimelineClockContext);
  const sessionActive = useContext(TimelineActivityContext);
  const started = Number.isFinite(startedAt) ? startedAt : undefined;
  const observedActivity = Number.isFinite(lastActivityAt) ? lastActivityAt : undefined;
  const lastActivity = observedActivity ?? started;
  const completed = Number.isFinite(completedAt) ? completedAt : undefined;
  const point = pointWhenEqual && started != null && lastActivity === started &&
    (completed != null || !sessionActive || observedActivity === undefined);
  const liveDurationEnd = lastActivity != null ? Math.max(now, lastActivity) : now;
  const durationEnd = completed ?? (sessionActive ? liveDurationEnd : lastActivity);
  const providerDuration = completed != null && Number.isFinite(durationOverrideMs) && durationOverrideMs! >= 0
    ? formatDuration(durationOverrideMs!)
    : "";
  const observedDurationMs = started != null && durationEnd != null
    ? Math.max(0, durationEnd - started)
    : undefined;
  const duration = showDuration
    ? providerDuration || (observedDurationMs != null && observedDurationMs > 0
      ? formatDuration(observedDurationMs)
      : "")
    : "";
  const durationLabel = completed != null ? "Duration" : sessionActive ? "Elapsed" : "Observed";
  if (started == null && lastActivity == null && !duration) return null;
  return (
    <span id={id} className={`tl-timestamp-meta${className ? ` ${className}` : ""}`}>
      {point ? (
        <TimelineTimestamp label="Recorded" timestamp={started} />
      ) : (
        <>
          {started != null && <TimelineTimestamp label="Started" timestamp={started} />}
          {lastActivity != null && <TimelineTimestamp label="Last Activity" timestamp={lastActivity} />}
        </>
      )}
      {duration && (
        <span
          className="tl-timestamp-duration"
          title={completed != null
            ? "Completed activity duration"
            : sessionActive ? "Elapsed activity duration" : "Observed span through last recorded activity"}
        >
          {durationLabel} {duration}
        </span>
      )}
    </span>
  );
}

/** "12.4K tok · $0.03": the turn's processed tokens and, when priced, its cost. Tokens are input
 * across every cache bucket plus output; the tooltip lists the buckets so the compact figure never
 * hides where they went. */
function turnUsageLabel(usage: TurnUsage, driver: AgentDriverKind | undefined): { text: string; title: string } {
  // Codex reports input inclusive of its cache reads; Anthropic reports the uncached part.
  const inclusiveInput = driver === "codex" || driver === "codex-app-server";
  const processed = usage.inputTokens + (inclusiveInput ? 0 : usage.cachedInputTokens) + usage.cacheCreationTokens + usage.outputTokens;
  const cost = usage.costUsd != null ? formatCost(usage.costUsd) : "";
  const parts = [`${formatTokens(processed)} tok`];
  if (cost) parts.push(cost);
  const detail = [
    `${formatTokens(usage.inputTokens)} input`,
    usage.cachedInputTokens ? `${formatTokens(usage.cachedInputTokens)} cached` : "",
    usage.cacheCreationTokens ? `${formatTokens(usage.cacheCreationTokens)} cache write` : "",
    `${formatTokens(usage.outputTokens)} output`,
    usage.model ? `model ${usage.model}` : "",
    cost ? `cost ${cost}` : "unpriced",
  ].filter(Boolean).join(" · ");
  return { text: parts.join(" · "), title: `Turn usage: ${detail}` };
}

/** What a user message's actions need: the handlers and availability its row already receives. */
interface MessageActionInput {
  onRewind?: (turn: number) => void;
  rewindTurn?: number;
  rewindUnavailableReason?: string;
  onEditAndResend?: (item: UserMessageItem) => void;
  editAndResendUnavailableReason?: string;
  onEditInFork?: (item: UserMessageItem, forkTurn: number) => void;
  editInForkAvailability?: EditInForkAvailability;
}

/** The Your Message group, in menu order. An action that does not apply to this message (no handler,
 * no checkpoint, a provider that cannot edit history) is absent; one that applies but cannot be used
 * now stays, with its reason. */
export function messageActions(item: UserMessageItem, input: MessageActionInput): TranscriptAction[] {
  const actions: TranscriptAction[] = [{
    key: "copy-message",
    label: "Copy Message",
    icon: <CopyIcon size={16} />,
    ...(item.text
      ? { copy: { text: item.text, copied: "Message copied.", failed: "Couldn't copy the message." } }
      : { unavailableReason: "This message has no text to copy." }),
  }];
  const { onEditAndResend, onEditInFork, editInForkAvailability: fork, onRewind, rewindTurn } = input;
  if (onEditAndResend) {
    actions.push({
      key: "edit",
      label: "Edit as a New Turn",
      icon: <EditIcon size={16} />,
      unavailableReason: input.editAndResendUnavailableReason,
      onSelect: () => onEditAndResend(item),
    });
  }
  if (onEditInFork && fork && (fork.available || fork.offered)) {
    actions.push({
      key: "edit-in-fork",
      label: "Edit in a Fork…",
      icon: <EditInForkIcon size={16} />,
      ...(fork.available
        ? { onSelect: () => onEditInFork(item, fork.forkTurn) }
        : { unavailableReason: fork.reason }),
    });
  }
  if (onRewind && rewindTurn != null) {
    actions.push({
      key: "rewind",
      label: "Rewind Files to Before This Turn…",
      icon: <RewindFilesIcon size={16} />,
      unavailableReason: input.rewindUnavailableReason,
      onSelect: () => onRewind(rewindTurn),
    });
  }
  return actions;
}

/** Beside the user bubble, drawn to its left and taking no height. On a fine pointer (§15.3): Copy
 * Message, Edit as a New Turn when it can be used, and More Message Actions, transparent until the
 * message is hovered, focused within or its menu is open. On a coarse pointer the turn's More Turn
 * Actions holds the same actions, so nothing renders here, unless no turn menu lists this message
 * (a steer, or a prompt whose turn is running or has no footer): then More Message Actions alone,
 * visible at rest, so no message loses its actions on a touch screen. */
function UserMessageActions({ item, inTurnMenu, ...input }: MessageActionInput & { item: UserMessageItem; inTurnMenu: boolean }) {
  const coarsePointer = useIsCoarsePointer();
  if (coarsePointer && inTurnMenu) return null;
  const actions = messageActions(item, input);
  if (coarsePointer) {
    return (
      <div className="tl-message-actions tl-user-menu" role="group" aria-label="Message Actions">
        <TranscriptActionMenu label="More Message Actions" groups={[{ label: "Your Message", actions }]} />
      </div>
    );
  }
  const edit = actions.find((action) => action.key === "edit");
  return (
    <div className="tl-message-actions tl-user-actions" role="group" aria-label="Message Actions">
      {item.text && <CopyButton text={item.text} iconOnly ariaLabel="Copy Message" className="icon-btn sm" />}
      {edit && transcriptActionAvailable(edit) && (
        <button type="button" className="icon-btn sm" onClick={edit.onSelect} title={edit.label} aria-label={edit.label}>
          <EditIcon size={16} />
        </button>
      )}
      <TranscriptActionMenu label="More Message Actions" groups={[{ label: "Your Message", actions }]} />
    </div>
  );
}

/** Why Retry Turn cannot re-run a turn a provider command opened: the command is the composer's to
 * invoke, with its own arguments and catalog revision. */
export const RETRY_TURN_COMMAND_REASON = "Run the command again from the composer to retry this turn.";

/** A failed turn, said once at the end of its turn (§13.2): a plain sentence from describeTurnError,
 * Retry Turn to submit the turn's prompt again, and the provider's own words behind Show Details. */
function TurnFailedNotice({ message, prompt }: { message: string; prompt?: UserMessageItem }) {
  const retry = useContext(TurnRetryContext);
  const reasonId = useId();
  const raw = withoutPromptFailedPrefix(message);
  const reason = prompt?.commandInvocation ? RETRY_TURN_COMMAND_REASON : retry?.unavailableReason;
  const retrying = prompt !== undefined && retry?.pendingPromptId === prompt.id;
  const actions = retry && prompt && (
    <BusyButton
      className="btn sm"
      busy={retrying}
      progress="Retrying the turn…"
      disabled={reason !== undefined || (retry.pendingPromptId !== undefined && !retrying)}
      aria-describedby={reason !== undefined ? reasonId : undefined}
      onClick={() => retry.onRetry(prompt)}
    >
      Retry Turn
    </BusyButton>
  );
  return (
    <Notice
      tone="danger"
      title="Turn Failed"
      actions={actions || undefined}
      details={<div className="code-well"><pre>{raw}</pre></div>}
    >
      <p>{describeTurnError(message)}</p>
      {actions && reason !== undefined && <p className="notice-meta" id={reasonId}>{reason}</p>}
      {prompt !== undefined && retry?.error?.promptId === prompt.id && (
        <p className="notice-meta" role="alert">Couldn't retry the turn: {retry.error.message}</p>
      )}
    </Notice>
  );
}

/** "Started 12:25:38 AM, finished 12:26:04 AM (26s)": the exact span behind the footer's clock. The
 * duration is always finish minus start, so the three figures never contradict one another. */
export function turnSpanDescription(summary: Pick<TurnFooterSummary, "startedAt" | "finishedAt">): string {
  return activitySpanDescription(summary.startedAt, summary.finishedAt);
}

/** The This Turn group, in menu order. Fork and Hand Off appear where the turn established a
 * conversation checkpoint, disabled with their reason when they cannot be used now. */
export function turnActions({ responseText, forkAvailability, onFork, forkTurn, handoff }: {
  responseText: string;
  forkAvailability?: ConversationForkAvailability;
  onFork?: (turn: number) => void;
  forkTurn?: number;
  handoff?: { open: (turn: number) => void; reason?: string };
}): TranscriptAction[] {
  const noResponse = "This turn has no response to copy.";
  const actions: TranscriptAction[] = [
    {
      key: "copy-response",
      label: "Copy Response",
      icon: <CopyIcon size={16} />,
      ...(responseText
        ? { copy: { text: responseText, format: markdownPlainText, copied: "Response copied.", failed: "Couldn't copy the response." } }
        : { unavailableReason: noResponse }),
    },
    {
      key: "copy-response-markdown",
      label: "Copy Response as Markdown",
      icon: <CopyIcon size={16} />,
      ...(responseText
        ? { copy: { text: responseText, copied: "Response copied as Markdown.", failed: "Couldn't copy the response." } }
        : { unavailableReason: noResponse }),
    },
  ];
  if (forkAvailability) {
    actions.push({
      key: "fork",
      label: "Fork After This Turn…",
      icon: <ThreadForkIcon size={16} />,
      ...(forkAvailability.available && onFork && forkTurn != null
        ? { onSelect: () => onFork(forkTurn) }
        : { unavailableReason: forkAvailability.available ? "This action is unavailable." : forkAvailability.reason }),
    });
  }
  if (handoff && forkTurn != null) {
    actions.push({
      key: "handoff",
      label: "Hand Off After This Turn…",
      icon: <HandOffIcon size={16} />,
      unavailableReason: handoff.reason,
      onSelect: () => handoff.open(forkTurn),
    });
  }
  return actions;
}

/** One footer per settled turn (§11.3): Turn N, its finishing clock time, tokens and cost, then the
 * turn's actions at the trailing end. More Turn Actions stays visible at rest on every pointer, so
 * every action, Rewind included, is found without hovering (#599); on a fine pointer, Copy Response
 * and a usable Fork After This Turn sit before it and show on hover or focus. */
function TurnFooter({ summary, onFork, forkAvailability, prompt, alone = false, ...messageInput }: MessageActionInput & {
  /** The footer is its row's only content (a stop's row), so the row gap already spaces it. */
  alone?: boolean;
  summary: TurnFooterSummary;
  onFork?: (turn: number) => void;
  forkAvailability?: ConversationForkAvailability;
  prompt?: UserMessageItem;
}) {
  const driver = useContext(TimelineDriverContext);
  const handoff = useContext(HandoffContext);
  const coarsePointer = useIsCoarsePointer();
  const tooltipId = useId();
  const { forkTurn, stopped } = summary;
  // A stopped turn names when it stopped in place of when it finished.
  const clockAt = stopped?.at ?? summary.finishedAt ?? summary.startedAt;
  const clock = formatClock(clockAt);
  const span = turnSpanDescription(summary);
  const usage = summary.usage ? turnUsageLabel(summary.usage, driver) : null;
  const responseText = useMemo(() => turnResponseText(summary), [summary.responseParts]);
  const actions = turnActions({ responseText, forkAvailability, onFork, forkTurn, handoff });
  const fork = actions.find((action) => action.key === "fork");
  const forkUsable = fork !== undefined && transcriptActionAvailable(fork);
  const groups = [
    ...(prompt ? [{ label: "Your Message", actions: messageActions(prompt, messageInput) }] : []),
    { label: "This Turn", actions },
  ];
  return (
    <div className={alone ? "tl-turn-footer alone" : "tl-turn-footer"} data-turn-footer={summary.turn ?? ""}>
      {summary.turn !== undefined && <span className="tl-turn-label">Turn {summary.turn}</span>}
      {stopped ? (
        <span className="tl-turn-time tl-turn-stopped">
          <StopTurnIcon size={14} aria-hidden="true" />
          {clock ? (
            <>
              Stopped at{" "}
              <time dateTime={new Date(clockAt!).toISOString()} aria-describedby={span ? tooltipId : undefined}>{clock}</time>
            </>
          ) : "Stopped"}
          {clock && span && <span id={tooltipId} className="tl-tooltip" role="tooltip">{span}</span>}
        </span>
      ) : clock && (
        <span className="tl-turn-time">
          <time dateTime={new Date(clockAt!).toISOString()} aria-describedby={span ? tooltipId : undefined}>{clock}</time>
          {span && <span id={tooltipId} className="tl-tooltip" role="tooltip">{span}</span>}
        </span>
      )}
      {usage && (
        <span className="tl-turn-usage" title={usage.title} aria-label={usage.title}>
          {usage.text}
        </span>
      )}
      <div className="tl-message-actions tl-turn-actions" role="group" aria-label="Turn Actions">
        {!coarsePointer && responseText && (
          <CopyButton text={responseText} format={markdownPlainText} iconOnly ariaLabel="Copy Response" className="icon-btn sm tl-hover-action" />
        )}
        {!coarsePointer && forkUsable && (
          <button type="button" className="icon-btn sm tl-hover-action" onClick={fork.onSelect} title="Fork After This Turn" aria-label="Fork After This Turn">
            <ThreadForkIcon size={16} />
          </button>
        )}
        <TranscriptActionMenu label="More Turn Actions" groups={groups} />
      </div>
    </div>
  );
}

const PLAN_STATUS_TEXT: Record<PlanEntry["status"], string> = {
  completed: "Done",
  in_progress: "In Progress",
  pending: "Not Started",
};

const planProgressLabel = (entries: readonly PlanEntry[]) =>
  `${entries.filter((entry) => entry.status === "completed").length} of ${entries.length} Done`;

/** A plan's items in a 16px icon column, so every label starts at the same x (§18: no glyphs). */
function PlanEntries({ entries }: { entries: readonly PlanEntry[] }) {
  return (
    <ul className="tl-plan-items">
      {entries.map((entry, index) => (
        <li key={index} className={entry.status === "completed" ? "tl-plan-item is-completed"
          : entry.status === "in_progress" ? "tl-plan-item is-in-progress" : "tl-plan-item"}>
          <span className="tl-plan-icon" aria-hidden="true">
            {entry.status === "completed" ? <SuccessIcon size={16} />
              : entry.status === "in_progress" ? <PlanInProgressIcon size={16} />
                : <PlanPendingIcon size={16} />}
          </span>
          <span className="tl-plan-text">
            {entry.content}
            <span className="sr-only">{`, ${PLAN_STATUS_TEXT[entry.status]}`}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The plan as one card per turn (#2187), at the point it first changed in that turn and updated
 * there. The turn's earlier versions wait behind Show Earlier Versions, oldest first.
 */
function PlanBlock({ item, historyOpen, onHistoryToggle }: {
  item: Extract<TimelineItem, { kind: "plan" }>;
  historyOpen: boolean;
  onHistoryToggle?: () => void;
}) {
  const history = item.history ?? [];
  return (
    <section className="tl-plan" aria-label="Plan">
      <div className="tl-plan-head">
        <span className="tl-plan-icon" aria-hidden="true"><PlanIcon size={16} /></span>
        <span>Plan</span>
        <span className="count">{planProgressLabel(item.entries)}</span>
      </div>
      <PlanEntries entries={item.entries} />
      {history.length > 0 && (
        <div className="disclosure tl-plan-history">
          <button type="button" className="disclosure-trigger" aria-expanded={historyOpen} onClick={onHistoryToggle}>
            <ChevronRightIcon size={14} className="disclosure-chevron" />
            Show Earlier Versions
            <span className="count">{history.length}</span>
          </button>
          {historyOpen && (
            <ol className="disclosure-body tl-plan-versions">
              {history.map((entries, index) => (
                <li key={index} className="tl-plan-version">
                  <div className="tl-plan-version-head">
                    Version {index + 1}
                    <span className="count">{planProgressLabel(entries)}</span>
                  </div>
                  <PlanEntries entries={entries} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

/** How many diff lines show before the rest wait behind Show N More Lines. */
const DIFF_PREVIEW_LINES = 8;
const DIFF_SIGN = { added: "+", removed: "\u2212", context: "" } as const;

/** What Git says about a change that has no lines to show, or about a renamed file's origin. */
function diffFileNote(file: DiffFile): string | null {
  if (file.binary) return file.isDeleted ? "Binary file deleted." : file.isNew ? "Binary file added." : "Binary file changed.";
  if (file.oldPath && file.oldPath !== file.path) return `Renamed from ${file.oldPath}.`;
  if (file.hunks.length === 0) return file.isDeleted ? "Empty file deleted." : file.isNew ? "Empty file added." : "No line changes.";
  return null;
}

const diffLineTotal = (files: readonly DiffFile[]) =>
  files.reduce((sum, file) => sum + file.hunks.reduce((lines, hunk) => lines + hunk.lines.length, 0), 0);

/**
 * A file edit's diff (#2187): Git's metadata dropped, each hunk opened by "Lines 12–40 in
 * Header()", and each line as number, sign and text. Washes mark the changes of an edited file
 * only; a new file is plain code with green + signs. Past 8 lines the rest waits behind Show N More
 * Lines.
 */
function DiffBlock({ diff, namesFiles = false }: {
  diff: string;
  /** Name every file, even a lone one: the runner's per-turn capture names no file in its head. */
  namesFiles?: boolean;
}) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const total = diffLineTotal(files);
  const digits = String(diffMaxLineNumber(files)).length;
  const hidden = total - DIFF_PREVIEW_LINES;
  // Only a collapsed diff has a budget; otherwise every file shows, including ones with no lines.
  let budget = hidden > 0 && !expanded ? DIFF_PREVIEW_LINES : Number.POSITIVE_INFINITY;
  return (
    <div className="tl-diff" style={{ "--tl-diff-digits": digits } as CSSProperties}>
      {files.map((file, fileIndex) => {
        if (budget <= 0) return null;
        return (
          <section key={fileIndex} className={`tl-diff-file${diffFileIsPlain(file) ? " is-plain" : ""}`}>
            {(namesFiles || files.length > 1) && file.path && <div className="tl-diff-file-path"><PathLabel path={file.path} /></div>}
            {diffFileNote(file) && <div className="tl-diff-note">{diffFileNote(file)}</div>}
            {file.hunks.map((hunk, hunkIndex) => {
              if (budget <= 0) return null;
              const shown = hunk.lines.slice(0, budget);
              budget -= shown.length;
              const label = hunkLabel(hunk);
              return (
                <div key={hunkIndex} className="tl-diff-hunk">
                  {label && <div className="tl-diff-hunk-label">{label}</div>}
                  <div className="tl-diff-scroll">
                    <div className="tl-diff-lines">
                      {shown.map((line, lineIndex) => (
                        <div key={lineIndex} className={line.kind === "added" ? "tl-diff-line is-added"
                          : line.kind === "removed" ? "tl-diff-line is-removed" : "tl-diff-line"}>
                          <span className="tl-diff-number">{line.number}</span>
                          <span className="tl-diff-sign">{DIFF_SIGN[line.kind]}</span>
                          <span className="tl-diff-text">{line.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
      {hidden > 0 && (
        <button type="button" className="btn sm ghost tl-diff-more" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {expanded ? "Show Fewer Lines" : `Show ${hidden} More Line${hidden === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}

/**
 * A history divider (docs/design-system.md §11.3; #2184): a hairline with a centred quiet label and
 * a faint 14px icon, and an optional one-line description on the same axis. Neutral in every
 * theme: history is a fact, not an action or a status.
 */
function HistoryDivider({ icon, label, title, description }: {
  icon: ReactNode;
  label: string;
  title?: string;
  description?: ReactNode;
}) {
  const descriptionId = useId();
  const divider = (
    <div
      className="tl-divider"
      role="separator"
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      title={title}
    >
      <span className="tl-divider-label">
        <span className="tl-divider-icon" aria-hidden="true">{icon}</span>
        {label}
      </span>
    </div>
  );
  if (!description) return divider;
  return (
    <div className="tl-divider-event">
      {divider}
      <p id={descriptionId} className="tl-divider-desc">{description}</p>
    </div>
  );
}

/** A fork or handoff names its turn; where the app can navigate, its source session is a link. */
function ForkDivider({ item }: { item: Extract<TimelineItem, { kind: "conversation_forked" }> }) {
  const openSession = useContext(TimelineSessionLinkContext);
  const sourceLink = openSession && (
    <button type="button" className="link" onClick={() => openSession(item.sourceSessionId)}>Open Source Session</button>
  );
  if (!item.handoff) {
    return (
      <HistoryDivider
        icon={<ThreadForkIcon size={14} />}
        label={`Forked from Turn ${item.turn}`}
        title={`Conversation forked from turn ${item.turn}`}
        description={sourceLink || undefined}
      />
    );
  }
  return (
    <HistoryDivider
      icon={<HandOffIcon size={14} />}
      label={`Handoff from ${item.handoff.sourceAgent} to ${item.handoff.destinationAgent} After Turn ${item.turn}`}
      description={<>Fresh provider conversation. {item.handoff.disclosure}{sourceLink && <> {sourceLink}</>}</>}
    />
  );
}

/** A structured account checkpoint follows privacy without changing transcript text. */
function AccountSwitchDivider({ item }: { item: Extract<TimelineItem, { kind: "provider_account_switched" }> }) {
  const privacy = useAccountEmailPrivacy();
  const account = accountLabelText(item.providerAccountLabel, undefined, privacy.hide);
  return (
    <HistoryDivider
      icon={<AccountIcon size={14} />}
      label={`${item.automatic ? "Automatically Switched" : "Switched"} Account to ${account}`}
      title={`Provider conversation resumed with ${account}`}
    />
  );
}
