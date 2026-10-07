import { AGENT_SPAWN_OBSERVATION_CAP } from "@wollipog/protocol";
import { policyHookOutcome, type GovernanceDecision } from "./governance.js";
import type {
  AgentQuestion,
  ApprovalContext,
  AuthoritativeSubagentLifecycle,
  EventPayloadReference,
  GovernanceReviewer,
  PermissionOption,
  PermissionResolver,
  PlanEntry,
  PromptImageInput,
  ReviewDecisionOutcome,
  ReviewRiskLevel,
  SessionCommandExecutionMode,
  SessionEvent,
  WorkflowArtifactView,
  QuestionAnswerSummaryEntry,
  StructuredRequestResolutionReason,
} from "@wollipog/protocol";


/** One turn's usage as the provider reported it: tokens by bucket and, when priced, its cost. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
  model?: string;
}

function turnUsageFrom(p: {
  inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheCreationInputTokens?: number;
  costUsd?: number; model?: string;
}): TurnUsage | null {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const usage: TurnUsage = {
    inputTokens: count(p.inputTokens),
    outputTokens: count(p.outputTokens),
    cachedInputTokens: count(p.cachedInputTokens),
    cacheCreationTokens: count(p.cacheCreationInputTokens),
    ...(typeof p.costUsd === "number" && Number.isFinite(p.costUsd) && p.costUsd >= 0 ? { costUsd: p.costUsd } : {}),
    ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
  };
  const anyTokens = usage.inputTokens + usage.outputTokens + usage.cachedInputTokens + usage.cacheCreationTokens > 0;
  return anyTokens || usage.costUsd != null ? usage : null;
}

/** A turn can settle usage in more than one event (a persistent process reports per result);
 * later reports add to the earlier ones. */
export function mergeTurnUsage(current: TurnUsage | undefined, addition: TurnUsage): TurnUsage {
  if (!current) return addition;
  const cost = current.costUsd != null || addition.costUsd != null
    ? { costUsd: (current.costUsd ?? 0) + (addition.costUsd ?? 0) }
    : {};
  return {
    inputTokens: current.inputTokens + addition.inputTokens,
    outputTokens: current.outputTokens + addition.outputTokens,
    cachedInputTokens: current.cachedInputTokens + addition.cachedInputTokens,
    cacheCreationTokens: current.cacheCreationTokens + addition.cacheCreationTokens,
    ...cost,
    ...(addition.model ?? current.model ? { model: addition.model ?? current.model } : {}),
  };
}

export type TimelineItem =
  | { kind: "artifact_attached"; id: number; artifact: WorkflowArtifactView; createdAt: number }
  | {
      kind: "user_message";
      id: number;
      text: string;
      images?: PromptImageInput[];
      /** Runner queue id for reconciling a formerly queued prompt without text de-duplication. */
      turnId?: string;
      /** Durable prompt identity; reconciles its pending bubble without text matching. */
      commandId?: string;
      /** Stable receipt identity retained only for canonical steering reconciliation. */
      submissionId?: string;
      /** A canonical user message incorporated into an already-active turn. */
      deliveryIntent?: "steer";
      /** The turn's provider-reported usage, stamped when its parentless token_usage lands. */
      turnUsage?: TurnUsage;
      /** Usage of an automatic continuation after this turn that no checkpoint or stop anchors yet,
       * held here (it has no footer of its own) until one does. */
      continuationUsage?: TurnUsage;
      /** Runner-recorded time of the turn's latest usage report; a terminal report can land after
       * the last visible row, and only the first report stamps `durationMs`. */
      lastUsageAt?: number;
      commandInvocation?: {
        invocationId: string;
        submissionId: string;
        providerCommandId: string;
        catalogRevision: string;
        commandName: string;
        executionMode: SessionCommandExecutionMode;
      };
      /** Runner-recorded time; imported transcripts may not preserve the provider's original time. */
      createdAt?: number;
      /** Completed provider turn represented by the matching conversation checkpoint. */
      turn?: number;
      durationMs?: number;
      durationSource?: "provider" | "observed";
    }
  | {
      kind: "agent_message";
      id: number;
      sourceEndId?: number;
      text: string;
      messageId?: string;
      parentToolUseId?: string;
      /** First runner-recorded chunk for this logical message. */
      createdAt?: number;
      /** Most recent runner-recorded chunk or authoritative completion. */
      lastActivityAt?: number;
      /** Runner-recorded authoritative final, when the provider emits one. */
      completedAt?: number;
    }
  | {
      kind: "agent_thought";
      id: number;
      sourceEndId?: number;
      text: string;
      messageId?: string;
      parentToolUseId?: string;
      /** First runner-recorded chunk for this logical thought. */
      createdAt?: number;
      /** Most recent runner-recorded chunk or authoritative completion. */
      lastActivityAt?: number;
      /** Runner-recorded authoritative final, when the provider emits one. */
      completedAt?: number;
    }
  | { kind: "command_output"; id: number; sourceEndId?: number; text: string; textRefs?: EventPayloadReference[]; parentToolUseId?: string }
  | { kind: "stderr"; id: number; sourceEndId?: number; text: string; textRefs?: EventPayloadReference[] }
  | {
      kind: "tool_call";
      id: number;
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: string;
      text: string;
      referencedText?: Array<{ preview: string; refs: EventPayloadReference[] }>;
      /** The Task tool call that spawned this one (v26+); absent ⇒ a top-level call. */
      parentToolUseId?: string;
      /** Provider-observed lifecycle that remains independent of foreground session state. */
      subagentLifecycle?: AuthoritativeSubagentLifecycle;
      /** The provider's explicit role for an agent it spawned ("Explore"); never parsed from prose. */
      subagentRole?: string;
      /** The integer exit code the provider reported (v207); a later statement or update replaces it. */
      exitCode?: number;
      /** Subagent items nested under this Task call — populated only by nestSubagents(). */
      children?: TimelineItem[];
      /**
       * How many distinct `tool_call` statements of this id have folded into this row, capped at
       * `MAX_TRACKED_TOOL_CALL_STATEMENTS`. Absent means exactly one, the ordinary case. Folding an
       * identical re-statement leaves every other field equal, so this is the only trace left of an
       * observation the control plane counts when deciding whether the id still identifies exactly
       * one child (#1289). Never derived from `tool_call_update`, which a streaming turn emits
       * freely and which cannot change that classification.
       */
      statementCount?: number;
      /** Event timestamps keep duration available even when the provider has no explicit metric. */
      startedAt?: number;
      /** Most recent runner-recorded event for this call. */
      lastActivityAt?: number;
      /** Runner-recorded terminal event time. */
      completedAt?: number;
      subagentRollup?: SubagentRollup;
    }
  | {
      kind: "plan";
      id: number;
      entries: PlanEntry[];
      /** The turn's earlier versions of this plan, oldest first (#2187). */
      history?: PlanEntry[][];
      parentToolUseId?: string;
    }
  | { kind: "file_edit"; id: number; path: string; diff?: string; diffRefs?: EventPayloadReference[]; parentToolUseId?: string }
  | { kind: "error"; id: number; message: string }
  | {
      kind: "turn_interrupted";
      id: number;
      createdAt?: number;
      /** A stopped automatic continuation's latest usage-report time and usage, when no checkpoint
       * anchors it (a cancelled turn records no conversation checkpoint). */
      lastUsageAt?: number;
      turnUsage?: TurnUsage;
    }
  | {
      kind: "review_decision";
      id: number;
      reviewId: string;
      reviewer: GovernanceReviewer;
      outcome: ReviewDecisionOutcome;
      riskLevel?: ReviewRiskLevel;
      rationale?: string;
      /** Runner-recorded decision time. */
      createdAt?: number;
    }
  | {
      kind: "permission";
      id: number;
      requestId: string;
      title: string;
      options: PermissionOption[];
      /** When the request was raised, which the Request Card's head line shows (#2179). */
      createdAt?: number;
      resolvedOptionId?: string | null;
      resolutionReason?: StructuredRequestResolutionReason;
      resolvedByParentSessionId?: string;
      /** The member or policy who settled it (#2628), recorded on the runner's resolution. Absent
       * for a parent's or Wollipog's own resolution and from older peers. */
      resolvedBy?: PermissionResolver;
      /** Runner-recorded time of the resolution, for the Decision Record (#2204). */
      resolvedAt?: number;
      context?: ApprovalContext;
    }
  | {
      kind: "question";
      id: number;
      requestId: string;
      /** The runner's identity for this exact use of the request id. */
      occurrenceId?: string;
      questions: AgentQuestion[];
      /** When the agent asked. */
      createdAt?: number;
      /** undefined = still pending; true = answered; false = dismissed. */
      answered?: boolean;
      answeredByPolicies?: string[];
      resolutionReason?: StructuredRequestResolutionReason;
      resolvedByParentSessionId?: string;
      /** What was answered (#2188), recorded on the runner's resolution. Absent for a dismissal and
       * for an answer an older runner or control plane recorded. */
      answers?: QuestionAnswerSummaryEntry[];
      /** The organization user who submitted the answer (#2527), recorded on the runner's
       * resolution. Absent for a dismissal, a policy or parent answer, and from older peers. */
      answeredByUserId?: string;
      /** When it was answered or otherwise resolved. */
      resolvedAt?: number;
    }
  /** A content-safe policy-hook outcome. Current histories use the runner event sequence as `id`;
   * legacy histories synthesize a negative id from the audit and anchor it chronologically. */
  | { kind: "governance_decision"; id: number; decision: GovernanceDecision }
  | {
      kind: "checkpoint";
      id: number;
      turn: number;
      /** For an automatic continuation the runner started without a prompt: the runner-recorded
       * time of its latest usage report, which would otherwise land on the earlier prompt. */
      lastUsageAt?: number;
      /** That continuation's provider-reported usage, summed like a prompt's `turnUsage`. */
      turnUsage?: TurnUsage;
    }
  | { kind: "checkpoint_restored"; id: number; turn: number }
  | {
      kind: "conversation_checkpoint";
      id: number;
      turn: number;
      /** An automatic continuation's latest usage-report time, when it has no file checkpoint. */
      lastUsageAt?: number;
      /** That continuation's provider-reported usage, when it has no file checkpoint. */
      turnUsage?: TurnUsage;
    }
  | { kind: "conversation_forked"; id: number; sourceSessionId: string; turn: number; handoff?: { sourceAgent: string; destinationAgent: string; disclosure: string } }
  | { kind: "provider_account_switched"; id: number; providerAccountId: string; providerAccountLabel: string; automatic?: boolean }
  /** The provider summarized the conversation to free context (#1224). */
  | { kind: "context_compacted"; id: number; trigger?: "manual" | "auto"; preTokens?: number };

export interface AutomaticAccountSwitchNoticeState {
  sessionId: string;
  seenThroughEventId: number;
  initialized: boolean;
}

/** Advance the live-toast cursor without treating the initial or earlier-history page as new. */
export function advanceAutomaticAccountSwitchNotice(
  state: AutomaticAccountSwitchNoticeState,
  input: {
    sessionId: string;
    historyReady: boolean;
    loadedEventHighWater: number;
    items: TimelineItem[];
  },
): { state: AutomaticAccountSwitchNoticeState; providerAccountLabel?: string } {
  const current = state.sessionId === input.sessionId
    ? state
    : { sessionId: input.sessionId, seenThroughEventId: 0, initialized: false };
  if (!input.historyReady) return { state: current };
  if (!current.initialized) {
    return {
      state: {
        sessionId: input.sessionId,
        seenThroughEventId: input.loadedEventHighWater,
        initialized: true,
      },
    };
  }
  const latest = input.items.reduce<Extract<TimelineItem, { kind: "provider_account_switched" }> | null>(
    (found, item) => item.kind === "provider_account_switched" && item.automatic &&
      (!found || item.id > found.id) ? item : found,
    null,
  );
  return {
    state: {
      sessionId: input.sessionId,
      seenThroughEventId: Math.max(current.seenThroughEventId, input.loadedEventHighWater),
      initialized: true,
    },
    ...(latest && latest.id > current.seenThroughEventId
      ? { providerAccountLabel: latest.providerAccountLabel }
      : {}),
  };
}

type AgentTextItem = Extract<TimelineItem, { kind: "agent_message" | "agent_thought" }>;
const streamingTimelineItems = new WeakSet<AgentTextItem>();

/** True only for the current object generation of an agent text item that can still gain chunks. */
export function timelineItemIsStreaming(item: TimelineItem): boolean {
  return (item.kind === "agent_message" || item.kind === "agent_thought") && streamingTimelineItems.has(item);
}

export interface TimelineSnapshotDelta {
  previous: TimelineItem[];
  dirtyFrom: number;
  dirtyIndexes: readonly number[];
  dirtyHasParentItems: boolean;
}

const timelineSnapshotDeltas = new WeakMap<TimelineItem[], TimelineSnapshotDelta>();

export function timelineSnapshotDelta(items: TimelineItem[]): TimelineSnapshotDelta | undefined {
  return timelineSnapshotDeltas.get(items);
}

/**
 * Attach exact predecessor metadata to a derived timeline snapshot. Retained projections use the
 * same one-generation contract as TimelineBuilder so downstream row projectors can update only
 * the changed slots without retaining an unbounded chain of prior arrays.
 */
export function publishTimelineSnapshotDelta(items: TimelineItem[], delta: TimelineSnapshotDelta): void {
  // Publishers of shrinking snapshots must include every vacated trailing index in dirtyIndexes so
  // retained consumers can remove stale index entries. TimelineBuilder snapshots never shrink.
  timelineSnapshotDeltas.delete(delta.previous);
  timelineSnapshotDeltas.set(items, delta);
}

export interface SubagentRollup {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

/** Maximum number of concurrently streamed provider text items retained between transcript
 * boundaries. Real providers keep this set small; the cap prevents malformed/unclosed streams
 * from turning stable message identities into transcript-lifetime state. */
export const MAX_OPEN_PROVIDER_TEXT_ITEMS = 128;

/**
 * The control plane stops accumulating spawn observations for one tool-call id at
 * `AGENT_SPAWN_OBSERVATION_CAP`, and an observation at that cap is permanently ambiguous, so a
 * count saturating there carries every classification the registry can still reach. Saturation is
 * what keeps the signal bounded: over a whole session an id can move this number at most twice,
 * never once per streamed event.
 *
 * This is the control plane's cap, not a copy of it (#1385): raising one raises both, so the
 * fingerprint cannot silently stop observing a reclassification the registry can still make.
 */
export const MAX_TRACKED_TOOL_CALL_STATEMENTS = AGENT_SPAWN_OBSERVATION_CAP;

function nativePolicyHookDecision(ev: SessionEvent): GovernanceDecision | null {
  const payload = ev.payload;
  if (payload.kind !== "policy_hook_decision") return null;
  if ((payload.stage !== "policy_decision" && payload.stage !== "resolution") ||
      (payload.outcome !== "allowed" && payload.outcome !== "denied" &&
       payload.outcome !== "timed_out" && payload.outcome !== "aborted")) return null;
  const outcome = policyHookOutcome(payload.stage, payload.outcome, payload.actor, payload.governancePolicyId, "event");
  if (!outcome) return null;
  return {
    ...outcome,
    auditId: payload.auditId,
    requestId: payload.requestId,
    ...(payload.governancePolicyId ? { policyId: payload.governancePolicyId } : {}),
    timestamp: ev.ts,
  };
}

const TURN_NEUTRAL_KINDS = new Set<TimelineItem["kind"]>([
  "user_message",
  "conversation_checkpoint",
  "checkpoint_restored",
  "conversation_forked",
  "provider_account_switched",
  "context_compacted",
]);

/** Top-level activity that, after a completed turn, means the runner began another without a
 * prompt (resumed background work). Prompts, conversation checkpoints, history dividers and nested
 * subagent output (which belongs to its parent tool's turn) never do. */
export function isTurnActivity(item: TimelineItem): boolean {
  return !TURN_NEUTRAL_KINDS.has(item.kind) && !("parentToolUseId" in item && item.parentToolUseId);
}

/** A rendered row is either a standalone item or a collapsible block of "work" (reasoning + tools). */
export type TimelineGroup =
  | { kind: "item"; item: TimelineItem }
  | { kind: "work"; id: string; items: TimelineItem[] };

/** Item kinds that are intermediate "work" — folded into a collapsed "Worked" block, Codex-style. */
const WORK_KINDS = new Set(["agent_thought", "tool_call", "command_output", "stderr", "file_edit", "plan"]);

/** Routine automated approvals belong to the surrounding work block. Exceptional review outcomes
 * remain standalone so denials, escalations, timeouts, and aborts cannot disappear in a summary. */
export function isCollapsibleWorkItem(item: TimelineItem): boolean {
  return WORK_KINDS.has(item.kind) ||
    (item.kind === "review_decision" && item.outcome === "allowed") ||
    (item.kind === "governance_decision" &&
      (item.decision.outcome === "allowed" || item.decision.outcome === "answered_by_policy"));
}

const PROMPT_FAILED_PREFIX = /^prompt failed:\s*/i;

/** The provider's message without the runner's "prompt failed:" lead-in. */
export function withoutPromptFailedPrefix(message: string): string {
  return message.replace(PROMPT_FAILED_PREFIX, "");
}

export function timelineBoundaryKey(item: TimelineItem): string {
  if (item.kind === "agent_message" || item.kind === "agent_thought" ||
      item.kind === "command_output" || item.kind === "stderr") {
    return `${item.kind}:${item.sourceEndId ?? item.id}`;
  }
  return `${item.kind}:${item.id}`;
}

/**
 * Group consecutive work items (reasoning + tool calls + edits) into collapsible blocks, leaving
 * messages, errors, and permission prompts as standalone rows. Mirrors Codex: the step-by-step work
 * collapses under a "Worked…" disclosure while the final answer stays in view.
 */
export function groupTimeline(items: TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let work: TimelineItem[] | null = null;
  let boundary = "head";
  for (const it of items) {
    if (isCollapsibleWorkItem(it)) {
      if (!work) {
        work = [];
        // A block belongs to the preceding standalone row (or the transcript head), not its
        // earliest currently-cached work event. Prefix recovery can then extend the block without
        // changing its disclosure/virtual-anchor identity.
        groups.push({ kind: "work", id: boundary, items: work });
      }
      work.push(it);
    } else {
      work = null;
      groups.push({ kind: "item", item: it });
      boundary = timelineBoundaryKey(it);
    }
  }
  return groups;
}

/** Item kinds a subagent emits, which the recursive projection may re-parent under an agent tool. */
const NESTABLE_CHILD_KINDS = new Set([
  "agent_message",
  "agent_thought",
  "command_output",
  "tool_call",
  "plan",
  "file_edit",
]);

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;

function parentIdOf(item: TimelineItem): string | undefined {
  return "parentToolUseId" in item && typeof item.parentToolUseId === "string" && item.parentToolUseId
    ? item.parentToolUseId
    : undefined;
}

function sameItems(a: readonly TimelineItem[], b: readonly TimelineItem[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

interface CachedToolProjection {
  source: ToolItem;
  children: TimelineItem[];
  rendered: ToolItem;
}

/**
 * Stateful recursive projection used by the streamed timeline. Graph discovery is deliberately
 * cheap and defensive, while rendered tool nodes and child arrays are structurally shared across
 * snapshots. An unrelated stream delta therefore does not clone every old agent subtree.
 */
export class SubagentTreeProjector {
  private cache = new Map<string, CachedToolProjection>();
  private top: TimelineItem[] = [];

  project(items: TimelineItem[]): TimelineItem[] {
    if (!items.some((item) => parentIdOf(item))) return items;

    // Only unique tool ids are valid parents. Ambiguous duplicate ids remain flat rather than
    // silently attributing work to whichever duplicate happened to be visited last.
    const uniqueTools = new Map<string, ToolItem | null>();
    for (const item of items) {
      if (item.kind !== "tool_call") continue;
      uniqueTools.set(item.toolCallId, uniqueTools.has(item.toolCallId) ? null : item);
    }

    // Mark every tool participating in a parent cycle. We break all edges in that cycle, keeping
    // the malformed nodes visible at top level; valid descendants can still attach beneath them.
    const state = new Map<ToolItem, 0 | 1 | 2>();
    const stack: ToolItem[] = [];
    const cyclic = new Set<ToolItem>();
    const visit = (tool: ToolItem): void => {
      const current = state.get(tool) ?? 0;
      if (current !== 0) return;
      state.set(tool, 1);
      stack.push(tool);
      const parentId = parentIdOf(tool);
      const parent = parentId ? uniqueTools.get(parentId) : undefined;
      if (parent) {
        const parentState = state.get(parent) ?? 0;
        if (parentState === 0) visit(parent);
        else if (parentState === 1) {
          const start = stack.lastIndexOf(parent);
          for (let i = Math.max(0, start); i < stack.length; i++) cyclic.add(stack[i]!);
        }
      }
      stack.pop();
      state.set(tool, 2);
    };
    for (const tool of uniqueTools.values()) if (tool) visit(tool);

    const children = new Map<ToolItem, TimelineItem[]>();
    const attached = new Set<TimelineItem>();
    for (const item of items) {
      if (!NESTABLE_CHILD_KINDS.has(item.kind) || (item.kind === "tool_call" && cyclic.has(item))) continue;
      const parentId = parentIdOf(item);
      const parent = parentId ? uniqueTools.get(parentId) : undefined;
      if (!parent || parent === item) continue; // orphan, duplicate parent id, or self-cycle
      const list = children.get(parent) ?? [];
      list.push(item);
      children.set(parent, list);
      attached.add(item);
    }
    if (attached.size === 0) return items;

    const nextCache = new Map<string, CachedToolProjection>();
    const render = (item: TimelineItem): TimelineItem => {
      if (item.kind !== "tool_call") return item;
      const rawChildren = children.get(item);
      if (!rawChildren?.length) return item;
      const renderedChildren = rawChildren.map(render);
      const previous = this.cache.get(item.toolCallId);
      const stableChildren = previous && sameItems(previous.children, renderedChildren) ? previous.children : renderedChildren;
      const rendered = previous && previous.source === item && previous.children === stableChildren
        ? previous.rendered
        : { ...item, children: stableChildren };
      nextCache.set(item.toolCallId, { source: item, children: stableChildren, rendered });
      return rendered;
    };

    const nextTop = items.filter((item) => !attached.has(item)).map(render);
    this.cache = nextCache;
    if (sameItems(this.top, nextTop)) return this.top;
    this.top = nextTop;
    return nextTop;
  }
}

/**
 * One-shot recursive fold for tests and small lists. Streamed rendering should retain a
 * SubagentTreeProjector so unchanged subtrees preserve identity between snapshots.
 */
export function nestSubagents(items: TimelineItem[]): TimelineItem[] {
  return new SubagentTreeProjector().project(items);
}

/** Structured second view over the derived timeline for the task/summary side pane. */
export interface SidePaneContent {
  plan: PlanEntry[];
  artifacts: { path: string; hasDiff: boolean }[];
  tools: { toolCallId: string; title: string; status: string }[];
  isEmpty: boolean;
}

/**
 * Codex-style task/summary pane content: the live plan, files touched (artifacts), and tool calls by
 * status — a second projection of the SAME derived timeline (pass `deriveTimeline`'s output in), so
 * the pane can't drift from the transcript. Per-file edits are deduped-by-path upstream, but the
 * runner's synthetic per-turn `worktree` captures are deliberately NOT (each turn keeps its delta in
 * the transcript) — the Files rollup collapses them here into one entry, or it would grow by one
 * identical row per turn. Pure — unit-tested in timeline.test.ts.
 */
export function deriveSidePaneContent(items: TimelineItem[]): SidePaneContent {
  // The side pane shows the SESSION's live plan — the top-level agent's. A subagent's TodoWrite
  // (parentToolUseId set) is its own scoped plan and must not masquerade as the top-level one,
  // e.g. when a subagent plans before the top-level agent does. Fall back to any plan only when
  // no top-level plan exists yet, so a subagent-only turn still surfaces something.
  // Each turn that revised the plan has its own card; the pane shows the latest.
  const plans = items.filter((it): it is Extract<TimelineItem, { kind: "plan" }> => it.kind === "plan");
  const planItem = plans.filter((it) => !it.parentToolUseId).at(-1) ?? plans[0];
  const plan = planItem?.entries ?? [];
  const artifactByPath = new Map<string, { path: string; hasDiff: boolean }>();
  for (const it of items) {
    if (it.kind !== "file_edit") continue;
    const cur = artifactByPath.get(it.path);
    artifactByPath.set(it.path, { path: it.path, hasDiff: (cur?.hasDiff ?? false) || !!it.diff || !!it.diffRefs?.length });
  }
  const artifacts = [...artifactByPath.values()];
  const tools = items
    .filter((it): it is Extract<TimelineItem, { kind: "tool_call" }> => it.kind === "tool_call")
    .map((it) => ({ toolCallId: it.toolCallId, title: it.title, status: it.status }));
  return { plan, artifacts, tools, isEmpty: plan.length === 0 && artifacts.length === 0 && tools.length === 0 };
}

/**
 * Incremental fold of the raw event stream into renderable items: coalesce consecutive text
 * chunks (agent message / thought / stderr / command output), group tool calls and their
 * updates by toolCallId, collapse repeated file edits by path (except per-turn "worktree"
 * deltas), keep one plan card per turn, and pair permission requests with their resolutions.
 *
 * Push events ONE AT A TIME and read `snapshot()` — re-folding the whole stream per streamed
 * chunk made timeline derivation O(n²) over a session's life. Updates are CLONE-ON-WRITE:
 * an untouched item keeps its object identity across snapshots, so memoized row components
 * skip re-rendering everything except the item that actually changed.
 */
const samePlan = (a: readonly PlanEntry[], b: readonly PlanEntry[]) =>
  a.length === b.length && a.every((entry, index) => entry.content === b[index]!.content && entry.status === b[index]!.status);

interface ContinuationUsageOwner {
  kind: "continuation";
  anchor: number | null;
  pendingUsageAt: number | null;
  pendingUsage: TurnUsage | null;
  /** The prompt row holding `pendingUsage` until an anchor exists. */
  heldBy: number | null;
}

const continuationOwner = (anchor: number | null, heldBy: number | null = null): ContinuationUsageOwner =>
  ({ kind: "continuation", anchor, pendingUsageAt: null, pendingUsage: null, heldBy });

export class TimelineBuilder {
  private items: TimelineItem[] = [];
  private readonly toolIndex = new Map<string, number>();
  /** Statements per tool-call id, saturating at `MAX_TRACKED_TOOL_CALL_STATEMENTS`: one small
   * integer per id `toolIndex` already tracks. A `tool_call_update` never contributes. */
  private readonly toolStatements = new Map<string, number>();
  // fileIndex + planIndex are keyed by PARENT CONTEXT (parentToolUseId ?? "") so a subagent's
  // edit/plan never coalesces into — or overwrites — the top-level agent's (or another
  // subagent's). tool ids are globally unique, so toolIndex needs no such scoping.
  private readonly fileIndex = new Map<string, number>();
  private readonly permIndex = new Map<string, number>();
  /** Authentication recovery may rotate request ids while one provider-owned recovery remains
   * active. Keep that episode anchored to its first transcript row; only a resolution ends it. */
  private activeAuthenticationIndex: number | null = null;
  private readonly planIndex = new Map<string, number>();
  /** Each parent context's latest plan, so an unchanged re-statement is not shown as a revision. */
  private readonly latestPlans = new Map<string, PlanEntry[]>();
  private readonly pendingSubagentRollups = new Map<string, SubagentRollup>();
  private activeUserIndex: number | null = null;
  /** The current turn's latest error, which a repeat of the same failure merges into. */
  private lastErrorIndex: number | null = null;

  private turnActivitySinceCompletion(): boolean {
    if (this.usageOwnerCompletedAt == null) return false;
    for (let index = this.usageOwnerCompletedAt; index < this.items.length; index += 1) {
      if (isTurnActivity(this.items[index]!)) return true;
    }
    return false;
  }

  /** Records a usage report's time and counters on the row anchoring an automatic continuation. */
  private stampUsage(index: number, at: number | null, usage: TurnUsage | null): void {
    const item = this.items[index];
    if (item?.kind !== "checkpoint" && item?.kind !== "conversation_checkpoint" && item?.kind !== "turn_interrupted") return;
    const later = at != null && (item.lastUsageAt == null || at > item.lastUsageAt);
    if (!later && !usage) return;
    this.items[index] = {
      ...item,
      ...(later ? { lastUsageAt: at } : {}),
      ...(usage ? { turnUsage: mergeTurnUsage(item.turnUsage, usage) } : {}),
    };
    this.markDirty(index);
  }

  /** Sets (or clears) the unanchored continuation usage a prompt holds. */
  private holdContinuationUsage(index: number, usage: TurnUsage | null): void {
    const item = this.items[index];
    if (item?.kind !== "user_message" || (item.continuationUsage ?? null) === usage) return;
    const { continuationUsage: _released, ...rest } = item;
    this.items[index] = usage ? { ...rest, continuationUsage: usage } : rest;
    this.markDirty(index);
  }

  /** Moves an unanchored continuation's pending usage onto the row that now anchors it. */
  private anchorPendingUsage(owner: ContinuationUsageOwner, index: number): void {
    if (owner.heldBy != null) this.holdContinuationUsage(owner.heldBy, null);
    this.stampUsage(index, owner.pendingUsageAt, owner.pendingUsage);
  }
  /** Kept independently from duration closure: terminal usage can arrive before the durable
   * conversation checkpoint that proves this user message completed and is fork-addressable. */
  private pendingConversationUserIndex: number | null = null;
  /** Which turn a usage report belongs to: the active prompt, or an automatic continuation the
   * runner started without one (resumed background work, or activity before the loaded page's
   * first prompt). A continuation is anchored on its file checkpoint, else on its conversation
   * checkpoint, else on its stop; until one exists its latest usage time waits in `pendingUsageAt`
   * and its counters in `pendingUsage`. A continuation that never gets an anchor (a refusal or a
   * provider error records neither a conversation checkpoint nor a stop) has no footer of its own,
   * so meanwhile the prompt before it holds those counters (`heldBy`) and none are dropped. */
  private usageOwner: { kind: "prompt" } | ContinuationUsageOwner | null = null;
  /** Item count just after the owner's conversation checkpoint. A report with nothing new since
   * still belongs to that completed turn; anything new means a continuation began. */
  private usageOwnerCompletedAt: number | null = null;
  // ID-less providers retain the historical contiguous-only behavior. Identified provider items
  // may interleave, so they use a separate bounded LRU set until completion or a real boundary.
  private lastText: { kind: string; index: number; parent?: string } | null = null;
  private readonly openProviderTexts = new Map<string, number>();
  private dirty = true;
  private dirtyFrom = 0;
  private readonly dirtyIndexes = new Set<number>();
  private dirtyHasParentItems = false;
  private snap: TimelineItem[] = [];

  /** The current items as a stable array: a NEW array identity when anything changed since the
   * last snapshot, the SAME array otherwise (so React memoization keys work at both levels). */
  snapshot(): TimelineItem[] {
    if (this.dirty) {
      const previous = this.snap;
      this.snap = [...this.items];
      // The new generation needs only its immediate predecessor. Removing the predecessor's
      // metadata breaks what would otherwise become a strongly-reachable WeakMap value chain of
      // every historical full-array snapshot.
      publishTimelineSnapshotDelta(this.snap, {
        previous,
        dirtyFrom: this.dirtyFrom,
        dirtyIndexes: [...this.dirtyIndexes].sort((left, right) => left - right),
        dirtyHasParentItems: this.dirtyHasParentItems,
      });
      this.dirty = false;
      this.dirtyFrom = this.items.length;
      this.dirtyIndexes.clear();
      this.dirtyHasParentItems = false;
    }
    return this.snap;
  }

  private markDirty(index: number): void {
    this.dirty = true;
    this.dirtyFrom = Math.min(this.dirtyFrom, index);
    this.dirtyIndexes.add(index);
    const item = this.items[index];
    if (item && "parentToolUseId" in item && item.parentToolUseId) {
      this.dirtyHasParentItems = true;
    }
  }

  private pushText(
    kind: "agent_message" | "agent_thought" | "command_output" | "stderr",
    id: number,
    text: string,
    final?: boolean,
    parentToolUseId?: string,
    createdAt?: number,
    textRefs?: EventPayloadReference[],
    messageId?: string,
  ): void {
    // Coalesce consecutive same-kind chunks (live streaming emits many word-deltas per message).
    // A `final` event is a COMPLETE message (backfill/adopt) — keep it as its own item, and don't
    // let the next same-kind event merge into it, so adopted transcripts don't run together.
    // Exception: a final carrying an open provider id is its authoritative replacement.
    // Only coalesce identified chunks from the SAME subagent (or both top-level): another parent
    // gets a distinct map key and bubble so one agent's words never fold into another's.
    if ((kind === "agent_message" || kind === "agent_thought") && messageId != null && messageId.length > 0 && !textRefs?.length) {
      // Provider identity is authoritative across other identified deltas, but only within the
      // same kind and parent context. Updating the Map entry also makes the cap true LRU.
      const key = JSON.stringify([kind, parentToolUseId ?? "", messageId]);
      const openIndex = this.openProviderTexts.get(key);
      if (this.lastText) this.settleText(this.lastText.index);
      this.lastText = null;
      if (openIndex != null) {
        const idx = openIndex;
        const it = this.items[idx] as Extract<TimelineItem, { kind: "agent_message" | "agent_thought" }>;
        const activityAt = Number.isFinite(createdAt)
          ? latestTimelineTimestamp(it.lastActivityAt ?? it.createdAt, createdAt!)
          : undefined;
        const updated: AgentTextItem = {
          ...it,
          sourceEndId: id,
          text: final ? text : it.text + text,
          ...(activityAt != null ? { lastActivityAt: activityAt } : {}),
          ...(final && activityAt != null ? { completedAt: activityAt } : {}),
        };
        this.items[idx] = updated;
        if (!final) streamingTimelineItems.add(updated);
        this.markDirty(idx);
        this.openProviderTexts.delete(key);
        if (!final) this.rememberProviderText(key, idx);
        return;
      }

      const item: AgentTextItem = {
        kind,
        id,
        sourceEndId: id,
        text,
        messageId,
        parentToolUseId,
        ...(Number.isFinite(createdAt)
          ? {
              createdAt,
              lastActivityAt: createdAt,
              ...(final ? { completedAt: createdAt } : {}),
            }
          : {}),
      };
      if (!final) streamingTimelineItems.add(item);
      const index = this.items.push(item) - 1;
      this.markDirty(index);
      if (!final) this.rememberProviderText(key, index);
      return;
    }

    // Losing provider identity is an ambiguity boundary: keep legacy chunks contiguous, but never
    // let a later reintroduced id reach backward across untagged output.
    this.settleProviderTexts();
    const open = this.lastText;
    const legacyChunk = !textRefs?.length && open != null && open.kind === kind &&
      open.parent === parentToolUseId && !final;
    if (open && legacyChunk) {
      const idx = open.index;
      const it = this.items[idx] as Extract<TimelineItem, {
        kind: "agent_message" | "agent_thought" | "command_output" | "stderr";
      }>;
      const activityAt = Number.isFinite(createdAt)
        ? latestTimelineTimestamp(
            "lastActivityAt" in it ? it.lastActivityAt ?? ("createdAt" in it ? it.createdAt : undefined) : undefined,
            createdAt!,
          )
        : undefined;
      const updated = {
        ...it,
        sourceEndId: id,
        text: final ? text : it.text + text,
        ...(activityAt != null ? { lastActivityAt: activityAt } : {}),
        ...(final && activityAt != null ? { completedAt: activityAt } : {}),
      } as TimelineItem;
      this.items[idx] = updated;
      if (!final && (updated.kind === "agent_message" || updated.kind === "agent_thought")) {
        streamingTimelineItems.add(updated);
      }
      this.markDirty(idx);
      this.lastText = { kind, index: idx, parent: parentToolUseId };
      return;
    }
    if (open) this.settleText(open.index);
    const item = {
      kind,
      id,
      sourceEndId: id,
      text,
      ...((kind === "command_output" || kind === "stderr") && textRefs?.length ? { textRefs } : {}),
      parentToolUseId,
      ...((kind === "agent_message" || kind === "agent_thought") && Number.isFinite(createdAt)
        ? {
            createdAt,
            lastActivityAt: createdAt,
            ...(final ? { completedAt: createdAt } : {}),
          }
        : {}),
    } as TimelineItem;
    if (!final && (item.kind === "agent_message" || item.kind === "agent_thought")) {
      streamingTimelineItems.add(item);
    }
    const index = this.items.push(item) - 1;
    this.markDirty(index);
    this.lastText = final || textRefs?.length
      ? null
      : { kind, index: this.items.length - 1, parent: parentToolUseId };
  }

  private rememberProviderText(key: string, index: number): void {
    this.openProviderTexts.set(key, index);
    while (this.openProviderTexts.size > MAX_OPEN_PROVIDER_TEXT_ITEMS) {
      const oldest = this.openProviderTexts.keys().next().value;
      if (oldest === undefined) break;
      const oldestIndex = this.openProviderTexts.get(oldest);
      this.openProviderTexts.delete(oldest);
      if (oldestIndex !== undefined) this.settleText(oldestIndex);
    }
  }

  private settleText(index: number): void {
    const item = this.items[index];
    if (!item || !timelineItemIsStreaming(item)) return;
    // Cloning without carrying WeakSet membership publishes a settled object generation while
    // leaving the public transcript shape and persistence format unchanged.
    this.items[index] = { ...item };
    this.markDirty(index);
  }

  private settleProviderTexts(): void {
    for (const index of new Set(this.openProviderTexts.values())) this.settleText(index);
    this.openProviderTexts.clear();
  }

  /** A turn ended: the top-level agent's next plan revision opens a new card in the next turn. A
   * subagent's plan lives in its spawning call's turn, so its card is never split. */
  private endTurnPlan(): void {
    this.planIndex.delete("");
  }

  private breakText(): void {
    if (this.lastText) this.settleText(this.lastText.index);
    this.lastText = null;
    this.settleProviderTexts();
  }

  push(ev: SessionEvent): void {
    const p = ev.payload;
    switch (p.kind) {
      case "artifact_attached":
        this.breakText();
        this.markDirty(this.items.push({ kind: "artifact_attached", id: ev.seq, artifact: p.artifact, createdAt: ev.ts }) - 1);
        break;
      case "user_message": {
        this.breakText();
        const userIndex = this.items.push({
          kind: "user_message",
          id: ev.seq,
          text: p.text,
          images: p.images,
          turnId: p.turnId,
          commandId: p.commandId,
          submissionId: p.submissionId,
          deliveryIntent: p.deliveryIntent,
          commandInvocation: p.commandInvocation,
          ...(Number.isFinite(ev.ts) ? { createdAt: ev.ts } : {}),
        }) - 1;
        // A canonical steer is an additional visible message inside the already-active provider
        // turn. It must not replace the original prompt as owner of that turn's duration or
        // conversation checkpoint.
        if (p.deliveryIntent !== "steer") {
          this.endTurnPlan();
          this.activeUserIndex = userIndex;
          this.pendingConversationUserIndex = userIndex;
          this.usageOwner = { kind: "prompt" };
          this.usageOwnerCompletedAt = null;
          this.lastErrorIndex = null;
        }
        this.markDirty(userIndex);
        break;
      }
      case "agent_message":
        this.pushText("agent_message", ev.seq, p.text, p.final, p.parentToolUseId, ev.ts, undefined, p.messageId);
        break;
      case "agent_thought":
        this.pushText("agent_thought", ev.seq, p.text, p.final, p.parentToolUseId, ev.ts, undefined, p.messageId);
        break;
      case "review_decision":
        this.breakText();
        this.markDirty(this.items.push({
          kind: "review_decision",
          id: ev.seq,
          reviewId: p.reviewId,
          reviewer: p.reviewer,
          outcome: p.outcome,
          riskLevel: p.riskLevel,
          rationale: p.rationale,
          ...(Number.isFinite(ev.ts) ? { createdAt: ev.ts } : {}),
        }) - 1);
        break;
      case "workflow_action_admission_armed":
        // This runner-owned ordering fence is operational metadata, not transcript content.
        this.breakText();
        break;
      case "policy_hook_decision": {
        this.breakText();
        const decision = nativePolicyHookDecision(ev);
        if (decision) {
          this.markDirty(this.items.push({
            kind: "governance_decision",
            id: ev.seq,
            decision,
          }) - 1);
        }
        break;
      }
      case "command_output":
        this.pushText("command_output", ev.seq, p.text, undefined, p.parentToolUseId, undefined, p.textRefs);
        break;
      case "stderr":
        if (p.runnerMarker === "background_continuation_delivery") {
          this.breakText();
          break;
        }
        this.pushText("stderr", ev.seq, p.text, undefined, undefined, undefined, p.textRefs);
        break;
      case "background_continuation_delivered":
        // Durable control-plane evidence; the visible assistant result is represented by the
        // preceding agent-message chunks.
        this.breakText();
        break;
      case "agent_response_completed":
        // Completion evidence wakes reminders without replaying transcript content.
        this.breakText();
        break;
      case "tool_call": {
        this.breakText();
        // Count the statement itself, not the row it lands on: an update-created row has never been
        // stated, so the first real statement must read as one rather than as a re-statement.
        const statementCount = Math.min(
          (this.toolStatements.get(p.toolCallId) ?? 0) + 1,
          MAX_TRACKED_TOOL_CALL_STATEMENTS,
        );
        this.toolStatements.set(p.toolCallId, statementCount);
        const exitCode = toolExitCode(p.exitCode);
        const existing = this.toolIndex.get(p.toolCallId);
        if (existing != null) {
          const item = this.items[existing] as ToolItem;
          const activityAt = Number.isFinite(ev.ts)
            ? latestTimelineTimestamp(item.lastActivityAt ?? item.startedAt, ev.ts)
            : undefined;
          const updated: ToolItem = {
            ...item,
            title: p.title || item.title,
            toolKind: p.toolKind ?? item.toolKind,
            status: p.status,
            text: p.text ? (item.text ? `${item.text}\n${p.text}` : p.text) : item.text,
            ...(p.textRefs?.length ? {
              referencedText: [...(item.referencedText ?? []), { preview: p.text ?? "", refs: p.textRefs }],
            } : {}),
            parentToolUseId: item.parentToolUseId ?? p.parentToolUseId,
            ...((p.subagentLifecycle ?? item.subagentLifecycle)
              ? { subagentLifecycle: p.subagentLifecycle ?? item.subagentLifecycle }
              : {}),
            ...((p.subagentRole ?? item.subagentRole) ? { subagentRole: p.subagentRole ?? item.subagentRole } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(activityAt != null ? { lastActivityAt: activityAt } : {}),
            ...(statementCount > 1 ? { statementCount } : {}),
          };
          if (isTerminalToolStatus(p.status) && activityAt != null) updated.completedAt = activityAt;
          else delete updated.completedAt;
          this.items[existing] = updated;
          this.markDirty(existing);
          break;
        }
        const idx =
          this.items.push({
            kind: "tool_call",
            id: ev.seq,
            toolCallId: p.toolCallId,
            title: p.title,
            toolKind: p.toolKind,
            status: p.status,
            text: p.text ?? "",
            ...(p.textRefs?.length ? { referencedText: [{ preview: p.text ?? "", refs: p.textRefs }] } : {}),
            parentToolUseId: p.parentToolUseId,
            ...(p.subagentLifecycle ? { subagentLifecycle: p.subagentLifecycle } : {}),
            ...(p.subagentRole ? { subagentRole: p.subagentRole } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(statementCount > 1 ? { statementCount } : {}),
            ...(Number.isFinite(ev.ts) ? { startedAt: ev.ts, lastActivityAt: ev.ts } : {}),
            ...(isTerminalToolStatus(p.status) && Number.isFinite(ev.ts) ? { completedAt: ev.ts } : {}),
            subagentRollup: this.pendingSubagentRollups.get(p.toolCallId),
          }) - 1;
        this.pendingSubagentRollups.delete(p.toolCallId);
        this.toolIndex.set(p.toolCallId, idx);
        this.markDirty(idx);
        break;
      }
      case "tool_call_update": {
        const exitCode = toolExitCode(p.exitCode);
        const idx = this.toolIndex.get(p.toolCallId);
        if (idx != null) {
          const it = this.items[idx] as Extract<TimelineItem, { kind: "tool_call" }>;
          const activityAt = Number.isFinite(ev.ts)
            ? latestTimelineTimestamp(it.lastActivityAt ?? it.startedAt, ev.ts)
            : undefined;
          const updated: ToolItem = {
            ...it,
            status: p.status,
            title: p.title || it.title,
            text: p.text ? (it.text ? `${it.text}\n${p.text}` : p.text) : it.text,
            ...(p.textRefs?.length ? {
              referencedText: [...(it.referencedText ?? []), { preview: p.text ?? "", refs: p.textRefs }],
            } : {}),
            parentToolUseId: it.parentToolUseId ?? p.parentToolUseId,
            ...((p.subagentLifecycle ?? it.subagentLifecycle)
              ? { subagentLifecycle: p.subagentLifecycle ?? it.subagentLifecycle }
              : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(activityAt != null ? { lastActivityAt: activityAt } : {}),
            subagentRollup: isTerminalToolStatus(p.status) && it.startedAt != null
              ? { ...it.subagentRollup, durationMs: it.subagentRollup?.durationMs ?? Math.max(0, (activityAt ?? it.startedAt) - it.startedAt) }
              : it.subagentRollup,
          };
          if (isTerminalToolStatus(p.status) && activityAt != null) updated.completedAt = activityAt;
          else delete updated.completedAt;
          this.items[idx] = updated;
          this.markDirty(idx);
        } else {
          this.breakText();
          const i =
            this.items.push({
              kind: "tool_call",
              id: ev.seq,
              toolCallId: p.toolCallId,
              title: p.title ?? "tool",
              status: p.status,
              text: p.text ?? "",
              ...(p.textRefs?.length ? { referencedText: [{ preview: p.text ?? "", refs: p.textRefs }] } : {}),
              parentToolUseId: p.parentToolUseId,
              ...(p.subagentLifecycle ? { subagentLifecycle: p.subagentLifecycle } : {}),
              ...(exitCode !== undefined ? { exitCode } : {}),
              ...(Number.isFinite(ev.ts) ? { startedAt: ev.ts, lastActivityAt: ev.ts } : {}),
              ...(isTerminalToolStatus(p.status) && Number.isFinite(ev.ts) ? { completedAt: ev.ts } : {}),
              subagentRollup: this.pendingSubagentRollups.get(p.toolCallId),
            }) - 1;
          this.pendingSubagentRollups.delete(p.toolCallId);
          this.toolIndex.set(p.toolCallId, i);
          this.markDirty(i);
        }
        break;
      }
      case "token_usage": {
        if (!p.parentToolUseId) {
          if (this.usageOwner == null || this.turnActivitySinceCompletion()) {
            this.usageOwner = continuationOwner(null, this.activeUserIndex);
            this.usageOwnerCompletedAt = null;
          }
          const owner = this.usageOwner;
          if (owner.kind === "continuation") {
            // An automatic continuation's report is its own turn's: its timing and its counters.
            const at = Number.isFinite(ev.ts) ? ev.ts : null;
            const usage = turnUsageFrom(p);
            if (owner.anchor != null) {
              this.stampUsage(owner.anchor, at, usage);
            } else {
              if (at != null) owner.pendingUsageAt = Math.max(owner.pendingUsageAt ?? at, at);
              if (usage) {
                owner.pendingUsage = mergeTurnUsage(owner.pendingUsage ?? undefined, usage);
                if (owner.heldBy != null) this.holdContinuationUsage(owner.heldBy, owner.pendingUsage);
              }
            }
          } else if (this.activeUserIndex != null) {
            const item = this.items[this.activeUserIndex];
            if (item?.kind === "user_message") {
              const providerDuration = Number.isFinite(p.durationMs) && (p.durationMs ?? -1) >= 0
                ? p.durationMs
                : undefined;
              const observedDuration = providerDuration == null && item.createdAt != null &&
                Number.isFinite(ev.ts) && ev.ts >= item.createdAt
                ? ev.ts - item.createdAt
                : undefined;
              const durationMs = item.durationMs == null ? (providerDuration ?? observedDuration) : undefined;
              const turnUsage = turnUsageFrom(p);
              const usageAt = Number.isFinite(ev.ts) && (item.lastUsageAt == null || ev.ts > item.lastUsageAt)
                ? ev.ts
                : undefined;
              if (durationMs != null || turnUsage || usageAt != null) {
                this.items[this.activeUserIndex] = {
                  ...item,
                  ...(durationMs != null
                    ? { durationMs, durationSource: providerDuration != null ? "provider" as const : "observed" as const }
                    : {}),
                  ...(turnUsage ? { turnUsage: mergeTurnUsage(item.turnUsage, turnUsage) } : {}),
                  ...(usageAt != null ? { lastUsageAt: usageAt } : {}),
                };
                this.markDirty(this.activeUserIndex);
              }
            }
            // The prompt stays the turn's owner until the next prompt arrives: a persistent
            // process can settle one turn in more than one usage report, and each must land on
            // the same row. The duration is stamped once, by the first report that carries one.
          }
          break;
        }
        const addition: SubagentRollup = {
          durationMs: p.durationMs,
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          cachedInputTokens: p.cachedInputTokens,
          costUsd: p.costUsd,
        };
        const idx = this.toolIndex.get(p.parentToolUseId);
        if (idx == null) {
          this.pendingSubagentRollups.set(
            p.parentToolUseId,
            mergeSubagentRollup(this.pendingSubagentRollups.get(p.parentToolUseId), addition),
          );
          break;
        }
        const item = this.items[idx] as ToolItem;
        this.items[idx] = { ...item, subagentRollup: mergeSubagentRollup(item.subagentRollup, addition) };
        this.markDirty(idx);
        break;
      }
      case "plan": {
        // One plan card per turn PER parent context — a subagent's TodoWrite must not overwrite
        // the top-level plan (or vice-versa). The card sits where the plan first changed in its
        // turn; a later revision in the same turn updates it and keeps the version it replaced.
        const key = p.parentToolUseId ?? "";
        const latest = this.latestPlans.get(key);
        if (latest && samePlan(latest, p.entries)) break;
        this.latestPlans.set(key, p.entries);
        const at = this.planIndex.get(key);
        if (at != null) {
          const it = this.items[at] as Extract<TimelineItem, { kind: "plan" }>;
          this.items[at] = { ...it, entries: p.entries, history: [...(it.history ?? []), it.entries] };
          this.markDirty(at);
        } else {
          this.breakText();
          const index = this.items.push({ kind: "plan", id: ev.seq, entries: p.entries, parentToolUseId: p.parentToolUseId }) - 1;
          this.planIndex.set(key, index);
          this.markDirty(index);
        }
        break;
      }
      case "file_edit": {
        this.breakText();
        // The runner's post-turn capture (path "worktree") is a PER-TURN DELTA — each one is a
        // distinct record, so it must never dedupe-overwrite the previous turn's diff. Real
        // per-file driver events still coalesce by path (progressive edits to one file).
        if (p.path === "worktree") {
          this.markDirty(this.items.push({ kind: "file_edit", id: ev.seq, path: p.path, diff: p.diff, diffRefs: p.diffRefs }) - 1);
          break;
        }
        // Coalesce progressive edits to one file WITHIN a parent context: a subagent editing the
        // same path as the top-level agent is a distinct row nested under its Task call.
        const fkey = JSON.stringify([p.parentToolUseId ?? "", p.path]); // unambiguous (parent, path) key
        const idx = this.fileIndex.get(fkey);
        if (idx != null) {
          if (p.diff || p.diffRefs?.length) {
            const it = this.items[idx] as Extract<TimelineItem, { kind: "file_edit" }>;
            this.items[idx] = { ...it, diff: p.diff, diffRefs: p.diffRefs };
            this.markDirty(idx);
          }
        } else {
          const i = this.items.push({ kind: "file_edit", id: ev.seq, path: p.path, diff: p.diff, diffRefs: p.diffRefs, parentToolUseId: p.parentToolUseId }) - 1;
          this.fileIndex.set(fkey, i);
          this.markDirty(i);
        }
        break;
      }
      case "permission_request": {
        this.breakText();
        const indexed = this.permIndex.get(p.requestId);
        const authIndex = p.purpose === "authentication" ? this.activeAuthenticationIndex : null;
        const i = indexed ?? authIndex;
        if (i != null && this.items[i]?.kind === "permission") {
          // A reopened request drops its earlier resolution's actor and time with its outcome.
          const { resolvedByParentSessionId: _parent, resolvedBy: _by, resolvedAt: _at, ...prior } = this.items[i];
          if (prior.requestId !== p.requestId) this.permIndex.delete(prior.requestId);
          this.items[i] = {
            ...prior,
            requestId: p.requestId,
            title: p.title,
            options: p.options,
            context: p.context,
            ...(Number.isFinite(ev.ts) ? { createdAt: ev.ts } : {}),
            resolvedOptionId: undefined,
            resolutionReason: undefined,
          };
          this.permIndex.set(p.requestId, i);
          if (p.purpose === "authentication") this.activeAuthenticationIndex = i;
          this.markDirty(i);
          break;
        }
        const appended =
          this.items.push({
            kind: "permission",
            id: ev.seq,
            requestId: p.requestId,
            title: p.title,
            options: p.options,
            context: p.context,
            ...(Number.isFinite(ev.ts) ? { createdAt: ev.ts } : {}),
          }) - 1;
        this.permIndex.set(p.requestId, appended);
        if (p.purpose === "authentication") this.activeAuthenticationIndex = appended;
        this.markDirty(appended);
        break;
      }
      case "permission_resolved": {
        const idx = this.permIndex.get(p.requestId);
        if (idx != null) {
          const it = this.items[idx] as Extract<TimelineItem, { kind: "permission" }>;
          this.items[idx] = {
            ...it,
            resolvedOptionId: p.optionId,
            resolutionReason: p.resolutionReason,
            ...(p.resolvedByParentSessionId
              ? { resolvedByParentSessionId: p.resolvedByParentSessionId }
              : {}),
            ...(p.resolvedBy ? { resolvedBy: p.resolvedBy } : {}),
            ...(Number.isFinite(ev.ts) ? { resolvedAt: ev.ts } : {}),
          };
          this.permIndex.delete(p.requestId);
          if (this.activeAuthenticationIndex === idx) this.activeAuthenticationIndex = null;
          this.markDirty(idx);
        }
        break;
      }
      case "question_request": {
        this.breakText();
        const i =
          this.items.push({
            kind: "question",
            id: ev.seq,
            requestId: p.requestId,
            ...(p.occurrenceId ? { occurrenceId: p.occurrenceId } : {}),
            questions: p.questions,
            ...(Number.isFinite(ev.ts) ? { createdAt: ev.ts } : {}),
          }) - 1;
        this.permIndex.set(p.requestId, i);
        this.markDirty(i);
        break;
      }
      case "question_policy_answered": {
        const idx = p.questionEventSeq !== undefined
          ? this.items.findIndex((item) => item.kind === "question" && item.id === p.questionEventSeq && item.requestId === p.requestId)
          : this.permIndex.get(p.requestId);
        if (idx != null && idx >= 0 && this.items[idx]?.kind === "question") {
          const it = this.items[idx] as Extract<TimelineItem, { kind: "question" }>;
          if (it.answered === false) break;
          this.items[idx] = { ...it, answered: true, answeredByPolicies: p.policies.map((policy) => policy.name) };
          this.markDirty(idx);
        }
        break;
      }
      case "question_resolved": {
        // An async answer can start the next provider turn with no prompt or checkpoint
        // (turn-progress.ts reads the same boundary).
        if (p.startsTurn) this.endTurnPlan();
        let idx = this.permIndex.get(p.requestId);
        // A provider may reuse a request id; the runner's occurrence names the exact question. A
        // resolution never lands on a question that names a different occurrence, even when its own
        // question lies outside the loaded history.
        const candidateOccurrence = idx != null ? (this.items[idx] as { occurrenceId?: string }).occurrenceId : undefined;
        if (p.occurrenceId && candidateOccurrence !== undefined && candidateOccurrence !== p.occurrenceId) {
          idx = undefined;
          for (let index = this.items.length - 1; index >= 0; index -= 1) {
            const item = this.items[index]!;
            if (item.kind === "question" && item.requestId === p.requestId && item.occurrenceId === p.occurrenceId) {
              idx = index;
              break;
            }
          }
        }
        if (idx != null && this.items[idx]!.kind === "question") {
          const it = this.items[idx] as Extract<TimelineItem, { kind: "question" }>;
          this.items[idx] = { ...it, answered: p.answered, resolutionReason: p.resolutionReason,
            ...(p.resolvedByParentSessionId
              ? { resolvedByParentSessionId: p.resolvedByParentSessionId }
              : {}),
            ...(Number.isFinite(ev.ts) ? { resolvedAt: ev.ts } : {}),
            ...(p.answered && p.answers ? { answers: p.answers } : {}),
            // Each resolution says who settled it; a later one never keeps an earlier member.
            answeredByUserId: p.answered ? p.answeredByUserId : undefined,
            ...(!p.answered ? { answeredByPolicies: undefined, answers: undefined } : {}) };
          this.markDirty(idx);
        }
        break;
      }
      case "checkpoint": {
        this.breakText();
        // A checkpoint bounds a turn, including an automatic continuation no prompt opened, so a
        // later failure never merges into an earlier turn's error.
        this.lastErrorIndex = null;
        const index = this.items.push({ kind: "checkpoint", id: ev.seq, turn: p.turn }) - 1;
        this.markDirty(index);
        // A prompt's own checkpoint directly follows it; any other opens an automatic continuation.
        if (this.activeUserIndex == null || index - 1 !== this.activeUserIndex) {
          this.endTurnPlan();
          const previous = this.usageOwner;
          this.usageOwner = continuationOwner(index);
          if (previous?.kind === "continuation" && previous.anchor == null && this.usageOwnerCompletedAt == null) {
            this.anchorPendingUsage(previous, index);
          }
          this.usageOwnerCompletedAt = null;
        }
        break;
      }
      case "checkpoint_restored":
        this.breakText();
        this.markDirty(this.items.push({ kind: "checkpoint_restored", id: ev.seq, turn: p.turn }) - 1);
        break;
      case "conversation_checkpoint": {
        this.breakText();
        this.lastErrorIndex = null;
        this.endTurnPlan();
        const promptTurn = this.pendingConversationUserIndex != null;
        if (this.pendingConversationUserIndex != null) {
          const item = this.items[this.pendingConversationUserIndex];
          if (item?.kind === "user_message") {
            this.items[this.pendingConversationUserIndex] = { ...item, turn: p.turn };
            this.markDirty(this.pendingConversationUserIndex);
          }
          this.pendingConversationUserIndex = null;
        }
        const index = this.items.push({ kind: "conversation_checkpoint", id: ev.seq, turn: p.turn }) - 1;
        this.markDirty(index);
        const owner = this.usageOwner;
        if (!(promptTurn && owner?.kind === "prompt" && this.usageOwnerCompletedAt == null)) {
          // A continuation's turn completes here (including one whose start lies before the loaded
          // page). It keeps its file checkpoint as anchor, or takes this one.
          const inProgress = owner?.kind === "continuation" && this.usageOwnerCompletedAt == null ? owner : null;
          const anchor = inProgress?.anchor ?? index;
          if (inProgress && inProgress.anchor == null) this.anchorPendingUsage(inProgress, index);
          this.usageOwner = continuationOwner(anchor);
        }
        this.usageOwnerCompletedAt = this.items.length;
        break;
      }
      case "conversation_forked":
        this.breakText();
        this.markDirty(this.items.push({ kind: "conversation_forked", id: ev.seq, sourceSessionId: p.sourceSessionId, turn: p.turn, ...(p.handoff ? { handoff: p.handoff } : {}) }) - 1);
        break;
      case "context_compacted":
        this.breakText();
        this.markDirty(this.items.push({
          kind: "context_compacted",
          id: ev.seq,
          ...(p.trigger ? { trigger: p.trigger } : {}),
          ...(p.preTokens !== undefined ? { preTokens: p.preTokens } : {}),
        }) - 1);
        break;
      case "provider_account_switched":
        this.breakText();
        this.markDirty(this.items.push({
          kind: "provider_account_switched",
          id: ev.seq,
          providerAccountId: p.providerAccountId,
          providerAccountLabel: p.providerAccountLabel,
          ...(p.automatic ? { automatic: true } : {}),
        }) - 1);
        break;
      case "error": {
        this.breakText();
        // The runner reports a failed prompt as "prompt failed: X" and the driver often reports the
        // same X on its own; the turn failed once, so the second merges into the first, keeping
        // the provider's own wording.
        const previous = this.lastErrorIndex == null ? undefined : this.items[this.lastErrorIndex];
        if (previous?.kind === "error" && withoutPromptFailedPrefix(previous.message) === withoutPromptFailedPrefix(p.message)) {
          const message = withoutPromptFailedPrefix(p.message);
          if (previous.message !== message) {
            this.items[this.lastErrorIndex!] = { ...previous, message };
            this.markDirty(this.lastErrorIndex!);
          }
          break;
        }
        this.lastErrorIndex = this.items.push({ kind: "error", id: ev.seq, message: p.message }) - 1;
        this.markDirty(this.lastErrorIndex);
        break;
      }
      case "turn_interrupted": {
        this.breakText();
        const index = this.items.push({ kind: "turn_interrupted", id: ev.seq, createdAt: ev.ts }) - 1;
        this.markDirty(index);
        // A cancelled turn records no conversation checkpoint, so a stopped continuation without a
        // file checkpoint is anchored here (the stop after a completed turn opens one).
        const owner = this.usageOwner;
        if (owner == null || this.usageOwnerCompletedAt != null) {
          this.usageOwner = continuationOwner(index);
          this.usageOwnerCompletedAt = null;
        } else if (owner.kind === "continuation" && owner.anchor == null) {
          this.usageOwner = continuationOwner(index);
          this.anchorPendingUsage(owner, index);
        }
        break;
      }
      case "status":
        break;
    }
  }
}

/** A tool event's exit code (v207), only when it is an integer: the payload crosses the wire. */
function toolExitCode(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function isTerminalToolStatus(status: string): boolean {
  return /^(completed|failed|cancelled|canceled|error|rejected)$/.test(status);
}

function latestTimelineTimestamp(previous: number | undefined, incoming: number): number {
  return Number.isFinite(previous) ? Math.max(previous!, incoming) : incoming;
}

function mergeSubagentRollup(current: SubagentRollup | undefined, addition: SubagentRollup): SubagentRollup {
  const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    a == null ? b : b == null ? a : a + b;
  const rollup: SubagentRollup = {};
  const durationMs = addition.durationMs ?? current?.durationMs;
  const inputTokens = sum(current?.inputTokens, addition.inputTokens);
  const outputTokens = sum(current?.outputTokens, addition.outputTokens);
  const cachedInputTokens = sum(current?.cachedInputTokens, addition.cachedInputTokens);
  const costUsd = sum(current?.costUsd, addition.costUsd);
  if (durationMs != null) rollup.durationMs = durationMs;
  if (inputTokens != null) rollup.inputTokens = inputTokens;
  if (outputTokens != null) rollup.outputTokens = outputTokens;
  if (cachedInputTokens != null) rollup.cachedInputTokens = cachedInputTokens;
  if (costUsd != null) rollup.costUsd = costUsd;
  return rollup;
}

/** One-shot fold (tests, small lists). Hot paths should hold a TimelineBuilder and push
 * incrementally — see useTimeline(). */
export function deriveTimeline(events: SessionEvent[], retainedAttachmentSeqs: ReadonlySet<number> = new Set()): TimelineItem[] {
  const b = new TimelineBuilder();
  const timestamps = new Map<number, number>();
  for (const ev of events) {
    b.push(ev);
    timestamps.set(ev.seq, ev.ts);
  }
  return placeRetainedAttachmentItems(b.snapshot(), timestamps, retainedAttachmentSeqs);
}

/** Retained reset attachments have old CP cursors at the start of the new epoch. Move only those
 * visible rows by timestamp; other items keep their source order and object identity. */
export function placeRetainedAttachmentItems(
  items: TimelineItem[],
  timestampsBySeq: ReadonlyMap<number, number>,
  retainedAttachmentSeqs: ReadonlySet<number>,
): TimelineItem[] {
  if (retainedAttachmentSeqs.size === 0) return items;
  const attachments = items.filter((item): item is Extract<TimelineItem, { kind: "artifact_attached" }> =>
    item.kind === "artifact_attached" && retainedAttachmentSeqs.has(item.id));
  if (attachments.length === 0) return items;
  attachments.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const ordered: TimelineItem[] = [];
  let nextAttachment = 0;
  for (const item of items) {
    if (item.kind === "artifact_attached" && retainedAttachmentSeqs.has(item.id)) continue;
    const timestamp = timestampsBySeq.get(item.id);
    while (nextAttachment < attachments.length && (
      timestamp !== undefined && (attachments[nextAttachment]!.createdAt < timestamp ||
        (attachments[nextAttachment]!.createdAt === timestamp && attachments[nextAttachment]!.id < item.id))
    )) {
      ordered.push(attachments[nextAttachment++]!);
    }
    ordered.push(item);
  }
  while (nextAttachment < attachments.length) ordered.push(attachments[nextAttachment++]!);
  return ordered.every((item, index) => item === items[index]) ? items : ordered;
}
