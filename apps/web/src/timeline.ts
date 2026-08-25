import type {
  AgentQuestion,
  ApprovalContext,
  AuthoritativeSubagentLifecycle,
  EventPayloadReference,
  GovernanceReviewer,
  PermissionOption,
  PlanEntry,
  PromptImageInput,
  ReviewDecisionOutcome,
  ReviewRiskLevel,
  SessionCommandExecutionMode,
  SessionEvent,
  StructuredRequestResolutionReason,
} from "@wollipog/protocol";


export type TimelineItem =
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
      /** Subagent items nested under this Task call — populated only by nestSubagents(). */
      children?: TimelineItem[];
      /** Event timestamps keep duration available even when the provider has no explicit metric. */
      startedAt?: number;
      /** Most recent runner-recorded event for this call. */
      lastActivityAt?: number;
      /** Runner-recorded terminal event time. */
      completedAt?: number;
      subagentRollup?: SubagentRollup;
    }
  | { kind: "plan"; id: number; entries: PlanEntry[]; parentToolUseId?: string }
  | { kind: "file_edit"; id: number; path: string; diff?: string; diffRefs?: EventPayloadReference[]; parentToolUseId?: string }
  | { kind: "error"; id: number; message: string }
  | { kind: "turn_interrupted"; id: number; createdAt?: number }
  | {
      kind: "review_decision";
      id: number;
      reviewId: string;
      reviewer: GovernanceReviewer;
      outcome: ReviewDecisionOutcome;
      riskLevel?: ReviewRiskLevel;
      rationale?: string;
    }
  | {
      kind: "permission";
      id: number;
      requestId: string;
      title: string;
      options: PermissionOption[];
      resolvedOptionId?: string | null;
      resolutionReason?: StructuredRequestResolutionReason;
      context?: ApprovalContext;
    }
  | {
      kind: "question";
      id: number;
      requestId: string;
      questions: AgentQuestion[];
      /** undefined = still pending; true = answered; false = dismissed. */
      answered?: boolean;
      resolutionReason?: StructuredRequestResolutionReason;
    }
  | { kind: "checkpoint"; id: number; turn: number }
  | { kind: "checkpoint_restored"; id: number; turn: number }
  | { kind: "conversation_checkpoint"; id: number; turn: number }
  | { kind: "conversation_forked"; id: number; sourceSessionId: string; turn: number };

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

/** A rendered row is either a standalone item or a collapsible block of "work" (reasoning + tools). */
export type TimelineGroup =
  | { kind: "item"; item: TimelineItem }
  | { kind: "work"; id: string; items: TimelineItem[] };

/** Item kinds that are intermediate "work" — folded into a collapsed "Worked" block, Codex-style. */
const WORK_KINDS = new Set(["agent_thought", "tool_call", "command_output", "stderr", "file_edit", "plan"]);

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
    if (WORK_KINDS.has(it.kind)) {
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
  const plans = items.filter((it): it is Extract<TimelineItem, { kind: "plan" }> => it.kind === "plan");
  const planItem = plans.find((it) => !it.parentToolUseId) ?? plans[0];
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
 * deltas), keep a single live plan, and pair permission requests with their resolutions.
 *
 * Push events ONE AT A TIME and read `snapshot()` — re-folding the whole stream per streamed
 * chunk made timeline derivation O(n²) over a session's life. Updates are CLONE-ON-WRITE:
 * an untouched item keeps its object identity across snapshots, so memoized row components
 * skip re-rendering everything except the item that actually changed.
 */
export class TimelineBuilder {
  private items: TimelineItem[] = [];
  private readonly toolIndex = new Map<string, number>();
  // fileIndex + planIndex are keyed by PARENT CONTEXT (parentToolUseId ?? "") so a subagent's
  // edit/plan never coalesces into — or overwrites — the top-level agent's (or another
  // subagent's). tool ids are globally unique, so toolIndex needs no such scoping.
  private readonly fileIndex = new Map<string, number>();
  private readonly permIndex = new Map<string, number>();
  /** Authentication recovery may rotate request ids while one provider-owned recovery remains
   * active. Keep that episode anchored to its first transcript row; only a resolution ends it. */
  private activeAuthenticationIndex: number | null = null;
  private readonly planIndex = new Map<string, number>();
  private readonly pendingSubagentRollups = new Map<string, SubagentRollup>();
  private activeUserIndex: number | null = null;
  /** Kept independently from duration closure: terminal usage can arrive before the durable
   * conversation checkpoint that proves this user message completed and is fork-addressable. */
  private pendingConversationUserIndex: number | null = null;
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
      this.lastText = null;
      if (openIndex != null) {
        const idx = openIndex;
        const it = this.items[idx] as Extract<TimelineItem, { kind: "agent_message" | "agent_thought" }>;
        const activityAt = Number.isFinite(createdAt)
          ? latestTimelineTimestamp(it.lastActivityAt ?? it.createdAt, createdAt!)
          : undefined;
        this.items[idx] = {
          ...it,
          sourceEndId: id,
          text: final ? text : it.text + text,
          ...(activityAt != null ? { lastActivityAt: activityAt } : {}),
          ...(final && activityAt != null ? { completedAt: activityAt } : {}),
        };
        this.markDirty(idx);
        this.openProviderTexts.delete(key);
        if (!final) this.rememberProviderText(key, idx);
        return;
      }

      const index = this.items.push({
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
      } as TimelineItem) - 1;
      this.markDirty(index);
      if (!final) this.rememberProviderText(key, index);
      return;
    }

    // Losing provider identity is an ambiguity boundary: keep legacy chunks contiguous, but never
    // let a later reintroduced id reach backward across untagged output.
    this.openProviderTexts.clear();
    const open = this.lastText;
    const legacyChunk = !textRefs?.length && open != null && open.kind === kind &&
      open.parent === parentToolUseId && !final;
    if (open && legacyChunk) {
      const idx = open.index;
      const it = this.items[idx] as Extract<TimelineItem, { kind: "agent_message" | "agent_thought" }>;
      const activityAt = Number.isFinite(createdAt)
        ? latestTimelineTimestamp(it.lastActivityAt ?? it.createdAt, createdAt!)
        : undefined;
      this.items[idx] = {
        ...it,
        sourceEndId: id,
        text: final ? text : it.text + text,
        ...(activityAt != null ? { lastActivityAt: activityAt } : {}),
        ...(final && activityAt != null ? { completedAt: activityAt } : {}),
      };
      this.markDirty(idx);
      this.lastText = { kind, index: idx, parent: parentToolUseId };
      return;
    }
    const index = this.items.push({
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
    } as TimelineItem) - 1;
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
      this.openProviderTexts.delete(oldest);
    }
  }

  private breakText(): void {
    this.lastText = null;
    this.openProviderTexts.clear();
  }

  push(ev: SessionEvent): void {
    const p = ev.payload;
    switch (p.kind) {
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
          this.activeUserIndex = userIndex;
          this.pendingConversationUserIndex = userIndex;
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
        }) - 1);
        break;
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
            ...(activityAt != null ? { lastActivityAt: activityAt } : {}),
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
          if (this.activeUserIndex != null) {
            const item = this.items[this.activeUserIndex];
            if (item?.kind === "user_message") {
              const providerDuration = Number.isFinite(p.durationMs) && (p.durationMs ?? -1) >= 0
                ? p.durationMs
                : undefined;
              const observedDuration = providerDuration == null && item.createdAt != null &&
                Number.isFinite(ev.ts) && ev.ts >= item.createdAt
                ? ev.ts - item.createdAt
                : undefined;
              const durationMs = providerDuration ?? observedDuration;
              if (durationMs != null) {
                this.items[this.activeUserIndex] = {
                  ...item,
                  durationMs,
                  durationSource: providerDuration != null ? "provider" : "observed",
                };
                this.markDirty(this.activeUserIndex);
              }
            }
            this.activeUserIndex = null;
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
        // One live plan PER parent context — a subagent's TodoWrite must not overwrite the
        // top-level plan (or vice-versa).
        const key = p.parentToolUseId ?? "";
        const at = this.planIndex.get(key);
        if (at != null) {
          const it = this.items[at] as Extract<TimelineItem, { kind: "plan" }>;
          this.items[at] = { ...it, entries: p.entries };
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
          const prior = this.items[i];
          if (prior.requestId !== p.requestId) this.permIndex.delete(prior.requestId);
          this.items[i] = {
            ...prior,
            requestId: p.requestId,
            title: p.title,
            options: p.options,
            context: p.context,
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
          this.items[idx] = { ...it, resolvedOptionId: p.optionId, resolutionReason: p.resolutionReason };
          this.permIndex.delete(p.requestId);
          if (this.activeAuthenticationIndex === idx) this.activeAuthenticationIndex = null;
          this.markDirty(idx);
        }
        break;
      }
      case "question_request": {
        this.breakText();
        const i =
          this.items.push({ kind: "question", id: ev.seq, requestId: p.requestId, questions: p.questions }) - 1;
        this.permIndex.set(p.requestId, i);
        this.markDirty(i);
        break;
      }
      case "question_resolved": {
        const idx = this.permIndex.get(p.requestId);
        if (idx != null && this.items[idx]!.kind === "question") {
          const it = this.items[idx] as Extract<TimelineItem, { kind: "question" }>;
          this.items[idx] = { ...it, answered: p.answered, resolutionReason: p.resolutionReason };
          this.markDirty(idx);
        }
        break;
      }
      case "checkpoint":
        this.breakText();
        this.markDirty(this.items.push({ kind: "checkpoint", id: ev.seq, turn: p.turn }) - 1);
        break;
      case "checkpoint_restored":
        this.breakText();
        this.markDirty(this.items.push({ kind: "checkpoint_restored", id: ev.seq, turn: p.turn }) - 1);
        break;
      case "conversation_checkpoint":
        this.breakText();
        if (this.pendingConversationUserIndex != null) {
          const item = this.items[this.pendingConversationUserIndex];
          if (item?.kind === "user_message") {
            this.items[this.pendingConversationUserIndex] = { ...item, turn: p.turn };
            this.markDirty(this.pendingConversationUserIndex);
          }
          this.pendingConversationUserIndex = null;
        }
        this.markDirty(this.items.push({ kind: "conversation_checkpoint", id: ev.seq, turn: p.turn }) - 1);
        break;
      case "conversation_forked":
        this.breakText();
        this.markDirty(this.items.push({ kind: "conversation_forked", id: ev.seq, sourceSessionId: p.sourceSessionId, turn: p.turn }) - 1);
        break;
      case "error":
        this.breakText();
        this.markDirty(this.items.push({ kind: "error", id: ev.seq, message: p.message }) - 1);
        break;
      case "turn_interrupted":
        this.breakText();
        this.markDirty(this.items.push({ kind: "turn_interrupted", id: ev.seq, createdAt: ev.ts }) - 1);
        break;
      case "status":
        break;
    }
  }
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
export function deriveTimeline(events: SessionEvent[]): TimelineItem[] {
  const b = new TimelineBuilder();
  for (const ev of events) b.push(ev);
  return b.snapshot();
}
