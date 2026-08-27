import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { normalizeSourcePath, type PlanEntry, type SessionView, type SourceLocation } from "@wollipog/protocol";
import {
  groupTimeline,
  SubagentTreeProjector,
  timelineBoundaryKey,
  timelineSnapshotDelta,
  type TimelineGroup,
  type TimelineItem,
  type TimelineSnapshotDelta,
} from "../timeline.js";
import { Markdown } from "./Markdown.js";
import {
  MeasuredVirtualList,
  type VirtualRevealOutcome,
  type VirtualRevealRequest,
  type VirtualRowState,
  type VirtualScrollAnchor,
} from "./MeasuredVirtualList.js";
import { CopyButton } from "./common.js";
import { BranchIcon, EditIcon } from "./Icons.js";
import { formatDuration, formatRecordedRelativeTime, formatRecordedTimestamp, titleCaseLabel } from "../format.js";
import { PromptImageView } from "./PromptImageView.js";
import { EventPayloadContent } from "./EventPayloadContent.js";
import { useTimelineClock } from "../timeline-clock.js";
import { SessionTimelineQuestionRegion } from "./SessionApproval.js";

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;
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
  session: SessionView;
  runnerOnline: boolean;
  fallbackFocusRef: RefObject<HTMLElement>;
  alternateFallbackFocusRef?: RefObject<HTMLElement>;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
}

export function timelineFileSourceLocation(path: string): SourceLocation | null {
  const normalized = normalizeSourcePath(path);
  return normalized ? { path: normalized } : null;
}
export type TimelineRenderRow =
  | { kind: "work_summary"; key: string; tools: number; edits: number; thoughts: number; open: boolean }
  | { kind: "subagent_summary"; key: string; tool: ToolItem; depth: number; open: boolean }
  | { kind: "item"; key: string; item: TimelineItem; inWork: boolean; depth: number };

const timelineRowKey = (row: TimelineRenderRow) => row.key;
export const estimateTimelineRow = (row: TimelineRenderRow): number => {
  if (row.kind === "work_summary") return 32;
  if (row.kind === "subagent_summary") return 52;
  switch (row.item.kind) {
    case "agent_message": return 100;
    case "agent_thought": return 72;
    case "user_message": return 72;
    case "file_edit": return 120;
    case "question": return 112 + row.item.questions.reduce(
      (height, question) => height + 64 + question.options.length * 44 + (question.allowOther ? 44 : 0),
      0,
    );
    case "command_output":
    case "stderr": return 96;
    case "tool_call": return 72;
    default: return 52;
  }
};

/** memo'd on the snapshot identity: a parent re-render with unchanged items (composer
 * keystrokes, status flips) skips the whole timeline subtree, not just the row bodies.
 * `onRewind` (when provided — session detail only) must be identity-stable (useCallback)
 * or it defeats the row memoization. */
export const EventTimeline = memo(function EventTimeline({
  items,
  onRewind,
  onFork,
  onEditAndResend,
  onEditInFork,
  onOpenSourceLocation,
  editInForkTargets,
  forkLatestOnly = false,
  scrollRef,
  historyKey,
  getInitialAnchor,
  preserveAnchor,
  anchorRecoveryPending,
  onVisibleAnchorChange,
  onAnchorLost,
  sessionActive = false,
  ariaLabel = "Session Activity",
  onOpenSubagent,
  revealRequest,
  onRevealHandled,
  questionContext,
}: {
  items: TimelineItem[];
  onRewind?: (turn: number) => void;
  onFork?: (turn: number) => void;
  /** Composer preparation only; callers must never submit the prompt from this callback. */
  onEditAndResend?: (item: Extract<TimelineItem, { kind: "user_message" }>) => void;
  /** Forks AFTER the supplied predecessor turn, then prepares a child composer draft. */
  onEditInFork?: (item: Extract<TimelineItem, { kind: "user_message" }>, forkTurn: number) => void;
  onOpenSourceLocation?: (location: SourceLocation) => void;
  editInForkTargets?: ReadonlyMap<number, number>;
  /** Claude CLI can only fork the current transcript; older provider checkpoints stay visible. */
  forkLatestOnly?: boolean;
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
  /** Accessible name when the timeline is reused outside the parent transcript. */
  ariaLabel?: string;
  /** Open an agent task in the dedicated panel without changing its disclosure state. */
  onOpenSubagent?: (toolCallId: string) => void;
  /** Reveal a semantic event, opening only the structural disclosures that contain its row. */
  revealRequest?: TimelineRevealRequest | null;
  onRevealHandled?: (requestId: number, outcome: VirtualRevealOutcome) => void;
  /** Authoritative pending request used to replace its matching historical question row in place. */
  questionContext?: TimelineQuestionContext;
}) {
  const effectiveHistoryKey = historyKey ?? "timeline";
  const scopedRevealRequest = revealRequest?.historyKey === effectiveHistoryKey ? revealRequest : null;
  return (
    <EventTimelineBody
      key={effectiveHistoryKey}
      items={items}
      onRewind={onRewind}
      onFork={onFork}
      onEditAndResend={onEditAndResend}
      onEditInFork={onEditInFork}
      onOpenSourceLocation={onOpenSourceLocation}
      editInForkTargets={editInForkTargets}
      forkLatestOnly={forkLatestOnly}
      scrollRef={scrollRef}
      getInitialAnchor={getInitialAnchor}
      preserveAnchor={preserveAnchor}
      anchorRecoveryPending={anchorRecoveryPending}
      onVisibleAnchorChange={onVisibleAnchorChange}
      onAnchorLost={onAnchorLost}
      sessionActive={sessionActive}
      ariaLabel={ariaLabel}
      onOpenSubagent={onOpenSubagent}
      revealRequest={scopedRevealRequest}
      onRevealHandled={onRevealHandled}
      questionContext={questionContext}
    />
  );
});

function EventTimelineBody({
  items,
  onRewind,
  onFork,
  onEditAndResend,
  onEditInFork,
  onOpenSourceLocation,
  editInForkTargets,
  forkLatestOnly,
  scrollRef,
  getInitialAnchor,
  preserveAnchor,
  anchorRecoveryPending,
  onVisibleAnchorChange,
  onAnchorLost,
  sessionActive,
  ariaLabel,
  onOpenSubagent,
  revealRequest,
  onRevealHandled,
  questionContext,
}: {
  items: TimelineItem[];
  onRewind?: (turn: number) => void;
  onFork?: (turn: number) => void;
  onEditAndResend?: (item: Extract<TimelineItem, { kind: "user_message" }>) => void;
  onEditInFork?: (item: Extract<TimelineItem, { kind: "user_message" }>, forkTurn: number) => void;
  onOpenSourceLocation?: (location: SourceLocation) => void;
  editInForkTargets?: ReadonlyMap<number, number>;
  forkLatestOnly: boolean;
  scrollRef?: RefObject<HTMLElement | null>;
  getInitialAnchor?: () => VirtualScrollAnchor | null;
  preserveAnchor?: boolean;
  anchorRecoveryPending?: boolean;
  onVisibleAnchorChange?: (anchor: VirtualScrollAnchor) => void;
  onAnchorLost?: (anchor: VirtualScrollAnchor) => void;
  sessionActive: boolean;
  ariaLabel: string;
  onOpenSubagent?: (toolCallId: string) => void;
  revealRequest?: TimelineRevealRequest | null;
  onRevealHandled?: (requestId: number, outcome: VirtualRevealOutcome) => void;
  questionContext?: TimelineQuestionContext;
}) {
  const projector = useRef<IncrementalTimelineRows | null>(null);
  if (!projector.current) projector.current = new IncrementalTimelineRows();
  const preparedRevealRef = useRef<{ eventId: number; requestId: number } | null>(null);
  const unresolvedRevealRef = useRef<number | null>(null);
  const [disclosure, setDisclosure] = useState<Map<string, boolean>>(() => new Map());
  const projection = useMemo(() => projector.current!.project(items, disclosure), [items, disclosure]);
  const { latestCheckpointTurn, rows } = projection;
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
  if (row.kind === "work_summary") {
      return (
        <WorkSummary
          tools={row.tools}
          edits={row.edits}
          thoughts={row.thoughts}
          open={row.open}
          onToggle={() => toggle(row.key, row.open)}
        />
      );
    }
    if (row.kind === "subagent_summary") {
      return <SubagentSummary
        tool={row.tool}
        depth={row.depth}
        open={row.open}
        onToggle={() => toggle(row.key, row.open)}
        onOpen={onOpenSubagent ? () => onOpenSubagent(row.tool.toolCallId) : undefined}
      />;
    }
    const item = row.item;
    const detailsKey = `row-details:${row.key}`;
    const detailsOpen = disclosure.get(detailsKey) ?? false;
    const forkBlocked = onFork && forkLatestOnly && item.kind === "conversation_checkpoint" && item.turn !== latestCheckpointTurn;
    return (
      <div
        className={row.depth > 0 ? "tl-nested-row" : row.inWork ? "tl-work-row" : undefined}
        style={row.depth > 0 ? { marginLeft: Math.min(row.depth, 6) * 12 } : undefined}
      >
        <TimelineRow
          item={item}
          inWork={row.inWork}
          highlightEligible={state.settledVisible}
          disclosureOpen={detailsOpen}
          onDisclosureToggle={() => toggle(detailsKey, detailsOpen)}
          onRewind={onRewind}
          onEditAndResend={onEditAndResend}
          onEditInFork={onEditInFork}
          onOpenSourceLocation={onOpenSourceLocation}
          editInForkTurn={item.kind === "user_message" ? editInForkTargets?.get(item.id) : undefined}
          onFork={forkBlocked ? undefined : onFork}
          forkUnavailableReason={forkBlocked
            ? "Claude CLI can fork only its current transcript at the matching latest-turn checkpoint. A later turn attempt advanced the conversation; files-only rewind remains available."
            : undefined}
          questionContext={item.kind === "question" ? questionContext : undefined}
        />
      </div>
    );
  };
  const timeline = scrollRef ? (
    <MeasuredVirtualList
      items={rows}
      getKey={timelineRowKey}
      renderItem={renderRow}
      scrollRef={scrollRef}
      estimateSize={estimateTimelineRow}
      overscan={8}
      rowGap={12}
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
        <div key={row.key} role="listitem" aria-posinset={index + 1} aria-setsize={rows.length}>
          {renderRow(row, { index, visible: true, settledVisible: true })}
        </div>
      ))}
    </div>
  );
  return (
    <TimelineClockProvider enabled={sessionActive} sessionActive={sessionActive}>
      {timeline}
    </TimelineClockProvider>
  );
}

const TimelineClockContext = createContext({ now: Date.now(), sessionActive: false });

function TimelineClockProvider({ enabled, sessionActive, children }: {
  enabled: boolean;
  sessionActive: boolean;
  children: ReactNode;
}) {
  const now = useTimelineClock(enabled);
  const value = useMemo(() => ({ now, sessionActive }), [now, sessionActive]);
  return <TimelineClockContext.Provider value={value}>{children}</TimelineClockContext.Provider>;
}

export interface TimelineRowsProjection {
  rows: TimelineRenderRow[];
  latestCheckpointTurn: number;
  incremental: boolean;
  processedItems: number;
  revision: number;
  keyDirtyFrom: number;
}

const isWorkItem = (item: TimelineItem): boolean =>
  item.kind === "agent_thought" || item.kind === "tool_call" || item.kind === "command_output" ||
  item.kind === "stderr" || item.kind === "file_edit" || item.kind === "plan";

const rendersSubagentSummary = (item: TimelineItem): boolean =>
  item.kind === "tool_call" && (item.toolKind === "agent" || Boolean(item.children?.length));

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

  project(items: TimelineItem[], disclosure: ReadonlyMap<string, boolean>): TimelineRowsProjection {
    if (items === this.items && disclosure === this.disclosure) {
      return {
        rows: this.rows,
        latestCheckpointTurn: this.latestCheckpointTurn,
        incremental: true,
        processedItems: 0,
        revision: this.revision,
        keyDirtyFrom: this.rows.length,
      };
    }
    const delta = timelineSnapshotDelta(items);
    const previousLength = this.items.length;
    const indexedUpdate = delta?.previous === this.items && disclosure === this.disclosure &&
      items.length === previousLength && delta.dirtyIndexes.length === 1
      ? this.projectExistingItemUpdate(items, delta.dirtyIndexes[0]!, disclosure)
      : null;
    if (indexedUpdate) return indexedUpdate;
    const parentTail = delta?.previous === this.items && disclosure === this.disclosure
      ? this.projectParentTail(items, delta, disclosure)
      : null;
    if (parentTail) return parentTail;
    const tailSafe = this.groups.length > 0 && delta?.previous === this.items &&
      !delta.dirtyHasParentItems && disclosure === this.disclosure &&
      delta.dirtyFrom >= Math.max(0, previousLength - 1);

    if (tailSafe) {
      const appended = delta.dirtyFrom >= previousLength;
      const previousLastGroup = this.groups.at(-1)!;
      const firstNew = items[previousLength];
      const joinsLastWork = appended && previousLastGroup.kind === "work" && firstNew != null && isWorkItem(firstNew);
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
      if (joinsLastWork && appendedItems.every(isWorkItem) && !hasToolCollision && canAppendWithoutTopologyChange) {
        const oldRowLength = this.rows.length;
        previousLastGroup.items.push(...appendedItems);
        const summaryIndex = this.rowIndexes.get(`work:${previousLastGroup.id}`);
        const summary = summaryIndex == null ? undefined : this.rows[summaryIndex];
        if (summary?.kind === "work_summary") {
          let tools = 0;
          let edits = 0;
          let thoughts = 0;
          for (const item of appendedItems) {
            if (item.kind === "tool_call") tools += 1;
            else if (item.kind === "file_edit") edits += 1;
            else if (item.kind === "agent_thought") thoughts += 1;
          }
          this.rows[summaryIndex!] = {
            ...summary,
            tools: summary.tools + tools,
            edits: summary.edits + edits,
            thoughts: summary.thoughts + thoughts,
          };
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
          processedItems: appendedItems.length,
          revision: this.revision,
          keyDirtyFrom: oldRowLength,
        };
      }
      if (!appended) {
        const updated = this.projectTopLevelTailUpdate(items, delta, disclosure);
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
        const suffixRows = flattenTimelineRows(suffixGroups, disclosure);
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
          processedItems: appendedItems.length,
          revision: this.revision,
          keyDirtyFrom: oldRowLength,
        };
      }
    }

    const projected = this.subagents.project(items);
    this.groups = stabilizeWorkGroupKeys(groupTimeline(projected), this.groups);
    const nextRows = flattenTimelineRows(this.groups, disclosure);
    this.rows = stabilizeTimelineRowKeys(nextRows, this.rows);
    this.items = items;
    this.disclosure = disclosure;
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
    return { rowKey: this.revealRowKeys.get(eventId) ?? this.itemKey(location.item), disclosureKeys };
  }

  private projectExistingItemUpdate(
    items: TimelineItem[],
    dirtyIndex: number,
    disclosure: ReadonlyMap<string, boolean>,
  ): TimelineRowsProjection | null {
    const previous = this.items[dirtyIndex];
    const changed = items[dirtyIndex];
    if (!previous || !changed || previous.id !== changed.id || previous.kind !== changed.kind) return null;
    const location = this.itemLocations.get(previous.id);
    if (!location || !this.sameSourceItem(location.item, previous)) return null;
    if (location.item.kind === "tool_call" && changed.kind === "tool_call" &&
        location.item.toolCallId !== changed.toolCallId) return null;
    const previousParent = "parentToolUseId" in previous ? previous.parentToolUseId ?? null : null;
    const changedParent = "parentToolUseId" in changed ? changed.parentToolUseId ?? null : null;
    const unchangedOrphanParent = previousParent != null && previousParent === changedParent &&
      !this.toolNodes.has(previousParent) && location.parentId == null;
    if (!unchangedOrphanParent &&
        (previousParent !== changedParent || previousParent !== location.parentId)) return null;

    const projectedChanged = changed.kind === "tool_call" && location.item.kind === "tool_call" && location.item.children?.length
      ? { ...changed, children: location.item.children }
      : changed;
    // Changing whether a tool owns a subagent summary inserts or removes structural rows.
    // Leave that rare transition to the full defensive projector instead of patching payloads.
    if (rendersSubagentSummary(location.item) !== rendersSubagentSummary(projectedChanged)) return null;
    const visibleTools = new Map<string, ToolItem>();
    if (location.parentId) {
      const parent = this.toolNodes.get(location.parentId);
      if (!parent?.children || !this.ownedTools.has(parent) || parent.children[location.childIndex] !== location.item) return null;
      let toolId: string | null = location.parentId;
      while (toolId) {
        const tool = this.toolNodes.get(toolId);
        if (!tool) return null;
        visibleTools.set(toolId, tool);
        toolId = this.toolParents.get(toolId) ?? null;
      }
      parent.children[location.childIndex] = projectedChanged;
    } else {
      const group = this.groups[location.groupIndex];
      if (!group) return null;
      if (group.kind === "work") {
        if (group.items[location.rootItemIndex] !== location.item) return null;
        group.items[location.rootItemIndex] = projectedChanged;
      } else {
        if (location.rootItemIndex !== 0 || group.item !== location.item) return null;
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
    if (rendersSubagentSummary(rendered) !== rendersSubagentSummary(projectedChanged)) return null;
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
    if (previousProjectedTool &&
        rendersSubagentSummary(previousProjectedTool) !== rendersSubagentSummary(projectedChanged)) return null;
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
          const childRows = flattenTimelineItemRows(children, disclosure, true, summary.depth + 1, this.toolIdCounts);
          this.rows.splice(summaryIndex + 1, 0, ...childRows);
          this.indexInsertedRows(childRows, boundaryKey);
          keyDirtyFrom = summaryIndex + 1;
        } else if (summary.open && nextOpen) {
          const childRows = flattenTimelineItemRows([projectedChanged], disclosure, true, summary.depth + 1, this.toolIdCounts);
          this.rows.splice(boundary, 0, ...childRows);
          this.indexInsertedRows(childRows, boundaryKey);
          keyDirtyFrom = boundary;
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

  private patchVisibleItem(previous: TimelineItem, changed: TimelineItem): void {
    const index = this.rowIndexes.get(this.itemKey(previous));
    const row = index == null ? undefined : this.rows[index];
    if (row?.kind === "item") this.rows[index!] = { ...row, item: changed };
  }

  private patchToolRows(tools: ReadonlyMap<string, ToolItem>): void {
    for (const [toolId, tool] of tools) {
      const itemIndex = this.rowIndexes.get(`item:tool:${toolId}`);
      const itemRow = itemIndex == null ? undefined : this.rows[itemIndex];
      if (itemRow?.kind === "item") this.rows[itemIndex!] = { ...itemRow, item: tool };
      const summaryIndex = this.rowIndexes.get(`agent:${toolId}`);
      const summaryRow = summaryIndex == null ? undefined : this.rows[summaryIndex];
      if (summaryRow?.kind === "subagent_summary") this.rows[summaryIndex!] = { ...summaryRow, tool };
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
      if (row.kind === "item") this.revealRowKeys.set(row.item.id, key);
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
 * virtual anchors survive that newly-discovered boundary. */
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
  let offset = 0;
  return groups.map((group) => {
    if (group.kind !== "work" || group.items.length === 0) return group;
    const start = group.items[0]!.id;
    const end = group.items.reduce((value, item) => Math.max(value, itemSourceEnd(item)), start);
    while (offset < candidates.length && candidates[offset]!.end < start) offset += 1;
    const candidate = candidates[offset];
    if (!candidate || candidate.start > end) return group;
    offset += 1;
    return candidate.group.id === group.id ? group : { ...group, id: candidate.group.id };
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

export function flattenTimelineRows(
  groups: ReturnType<typeof groupTimeline>,
  disclosure: ReadonlyMap<string, boolean>,
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
    const key = `work:${group.id}`;
    const open = disclosure.get(key) ?? false;
    let tools = 0;
    let edits = 0;
    let thoughts = 0;
    for (const item of group.items) {
      if (item.kind === "tool_call") tools += 1;
      else if (item.kind === "file_edit") edits += 1;
      else if (item.kind === "agent_thought") thoughts += 1;
    }
    rows.push({ kind: "work_summary", key, tools, edits, thoughts, open });
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
): TimelineRenderRow[] {
  const rows: TimelineRenderRow[] = [];
  const appendItem = (item: TimelineItem, nestedInWork: boolean, itemDepth: number) => {
    const toolIdentity = item.kind === "tool_call" && (toolIds.get(item.toolCallId) ?? 0) === 1
      ? item.toolCallId
      : item.kind === "tool_call" ? `${item.toolCallId}:${item.id}` : null;
    const itemKey = item.kind === "tool_call"
      ? `item:tool:${toolIdentity}`
      : `item:${item.kind}:${item.id}`;
    rows.push({ kind: "item", key: itemKey, item, inWork: nestedInWork, depth: itemDepth });
    if (item.kind !== "tool_call" || (item.toolKind !== "agent" && !item.children?.length)) return;
    const key = `agent:${toolIdentity}`;
    const childCount = item.children?.length ?? 0;
    const open = disclosure.get(key) ?? automaticSubagentOpen(itemDepth, childCount);
    rows.push({ kind: "subagent_summary", key, tool: item, depth: itemDepth, open });
    if (open) for (const child of item.children ?? []) appendItem(child, true, itemDepth + 1);
  };
  for (const item of items) appendItem(item, inWork, depth);
  return rows;
}

/** Codex-style collapsed "Worked…" disclosure folding a turn's reasoning + tool calls. */
function WorkSummary({
  tools,
  edits,
  thoughts,
  open,
  onToggle,
}: {
  tools: number;
  edits: number;
  thoughts: number;
  open: boolean;
  onToggle: () => void;
}) {
  const parts: string[] = [];
  if (tools) parts.push(`${tools} command${tools === 1 ? "" : "s"}`);
  if (edits) parts.push(`${edits} edit${edits === 1 ? "" : "s"}`);
  if (!tools && !edits && thoughts) parts.push(`${thoughts} reasoning step${thoughts === 1 ? "" : "s"}`);
  const summary = parts.length ? `Worked · ${parts.join(", ")}` : "Worked";
  return (
    <div className={`tl-work${open ? " open" : ""}`}>
      <button type="button" className="tl-disclosure" aria-expanded={open} onClick={onToggle}>
        <span className="work-caret">▸</span>
        {summary}
      </button>
    </div>
  );
}

/** A recursively nested agent's work. First-level, reasonably sized trees start open; deeper or
 * large trees mount lazily only after disclosure, preventing an event burst from rendering an
 * arbitrarily deep/large hidden subtree. Local state survives streamed child updates. */
function SubagentSummary({ tool, depth, open, onToggle, onOpen }: {
  tool: ToolItem;
  depth: number;
  open: boolean;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  const timingDescriptionId = useId();
  const items = tool.children ?? [];
  const rollup = tool.subagentRollup;
  const tokens = (rollup?.inputTokens ?? 0) + (rollup?.outputTokens ?? 0);
  const metrics = [tokens > 0 ? `${tokens.toLocaleString()} tokens` : null]
    .filter((value): value is string => !!value);
  const hasTimingDescription = Number.isFinite(tool.startedAt) || Number.isFinite(tool.lastActivityAt)
    || (Number.isFinite(tool.completedAt) && Number.isFinite(rollup?.durationMs) && (rollup?.durationMs ?? -1) >= 0);
  return (
    <div className={`tl-subagent${open ? " open" : ""}`} style={{ marginLeft: 10 + Math.min(depth, 6) * 12 }}>
      <div className="subagent-head">
        <button
          type="button"
          className="subagent-toggle tl-disclosure"
          aria-expanded={open}
          aria-label={`Agent · ${items.length} Step${items.length === 1 ? "" : "s"} · ${titleCaseLabel(tool.status)}${metrics.length > 0 ? ` · ${metrics.join(" · ")}` : ""}`}
          aria-describedby={hasTimingDescription ? timingDescriptionId : undefined}
          onClick={onToggle}
        >
          <span className="subagent-caret">▸</span>
          <span className="subagent-icon">⑃</span>
          <span>Agent · {items.length} Step{items.length === 1 ? "" : "s"}</span>
          <span className={`subagent-status tool-${tool.status}`}>{titleCaseLabel(tool.status)}</span>
          {metrics.length > 0 && <span className="subagent-metrics">· {metrics.join(" · ")}</span>}
          <ActivityTimestampMeta
            id={hasTimingDescription ? timingDescriptionId : undefined}
            className="tl-subagent-time"
            startedAt={tool.startedAt}
            lastActivityAt={tool.lastActivityAt}
            completedAt={tool.completedAt}
            durationOverrideMs={rollup?.durationMs}
            pointWhenEqual
            showDuration
          />
        </button>
        {onOpen && (
          <button type="button" className="subagent-open" onClick={onOpen} aria-label="Open Agent in Subagents Panel">
            Open
          </button>
        )}
      </div>
    </div>
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
  inWork = false,
  onRewind,
  onFork,
  onEditAndResend,
  onEditInFork,
  onOpenSourceLocation,
  editInForkTurn,
  forkUnavailableReason,
  highlightEligible = true,
  disclosureOpen = false,
  onDisclosureToggle,
  questionContext,
}: {
  item: TimelineItem;
  inWork?: boolean;
  onRewind?: (turn: number) => void;
  onFork?: (turn: number) => void;
  onEditAndResend?: (item: Extract<TimelineItem, { kind: "user_message" }>) => void;
  onEditInFork?: (item: Extract<TimelineItem, { kind: "user_message" }>, forkTurn: number) => void;
  onOpenSourceLocation?: (location: SourceLocation) => void;
  editInForkTurn?: number;
  forkUnavailableReason?: string;
  highlightEligible?: boolean;
  disclosureOpen?: boolean;
  onDisclosureToggle?: () => void;
  questionContext?: TimelineQuestionContext;
}) {
  const timingDescriptionId = useId();
  switch (item.kind) {
    case "checkpoint":
      // Thin turn divider; the Rewind affordance shows on hover (session detail only).
      return (
        <div className="tl-checkpoint" title={`Files snapshot taken at the start of turn ${item.turn}`}>
          <span className="checkpoint-line" />
          <span className="checkpoint-label">Turn {item.turn}</span>
          {onRewind && (
            <button className="btn ghost sm checkpoint-rewind" onClick={() => onRewind(item.turn)}>
              ⤺ Rewind Files to Here
            </button>
          )}
          <span className="checkpoint-line" />
        </div>
      );
    case "checkpoint_restored":
      return (
        <div className="tl-checkpoint restored">
          <span className="checkpoint-line" />
          <span className="checkpoint-label">⤺ files rewound to before turn {item.turn}</span>
          <span className="checkpoint-line" />
        </div>
      );
    case "conversation_checkpoint":
      return (
        <div className="tl-checkpoint conversation" title={`Conversation and files after turn ${item.turn}`}>
          <span className="checkpoint-line" />
          <span className="checkpoint-label">after turn {item.turn}</span>
          {onFork && (
            <button className="btn ghost sm checkpoint-rewind" onClick={() => onFork(item.turn)}>
              Fork Conversation Here
            </button>
          )}
          {!onFork && forkUnavailableReason && (
            <button className="btn ghost sm checkpoint-rewind" disabled title={forkUnavailableReason}>
              Claude Forks Latest Only
            </button>
          )}
          <span className="checkpoint-line" />
        </div>
      );
    case "conversation_forked":
      return (
        <div className="tl-checkpoint restored">
          <span className="checkpoint-line" />
          <span className="checkpoint-label">forked from turn {item.turn}</span>
          <span className="checkpoint-line" />
        </div>
      );
    case "user_message":
      return (
        <div className="tl-row user">
          <div className="tl-message-stack user">
            <div className="bubble user-bubble">
              {item.deliveryIntent === "steer" && item.submissionId && (
                <span className="steered-marker">Steered</span>
              )}
              {item.images && item.images.length > 0 && (
                <div className="bubble-images">
                  {item.images.map((img, i) => (
                    <PromptImageView key={"artifactId" in img ? img.artifactId : i} image={img} alt={`attachment ${i + 1}`} />
                  ))}
                </div>
              )}
              {item.text && <div className="bubble-text">{item.text}</div>}
            </div>
            <MessageMeta
              createdAt={item.createdAt}
              durationMs={item.durationMs}
              durationSource={item.durationSource}
              copyText={item.text}
              copyLabel="Copy user message"
              onEditAndResend={onEditAndResend ? () => onEditAndResend(item) : undefined}
              onEditInFork={onEditInFork && editInForkTurn != null ? () => onEditInFork(item, editInForkTurn) : undefined}
            />
          </div>
        </div>
      );
    case "agent_message":
      // Codex-style: the model response is full-width document flow, not a chat bubble.
      return (
        <div className="tl-agent-msg">
          <Markdown highlightEligible={highlightEligible}>{item.text}</Markdown>
          {/* Meta trails the text it describes, matching the user-bubble arrangement. */}
          <MessageMeta
            createdAt={item.createdAt}
            lastActivityAt={item.lastActivityAt}
            completedAt={item.completedAt}
            copyText={item.text}
            copyLabel="Copy assistant message"
          />
        </div>
      );
    case "agent_thought":
      // Inside a "Worked" block, reasoning is a plain muted paragraph (no nested disclosure).
      if (inWork) {
        return (
          <div className="tl-reasoning">
            <ActivityTimestampMeta
              className="tl-thought-time"
              startedAt={item.createdAt}
              lastActivityAt={item.lastActivityAt}
              completedAt={item.completedAt}
              pointWhenEqual
            />
            <Markdown highlightEligible={highlightEligible}>{item.text}</Markdown>
          </div>
        );
      }
      return (
        <details
          className="tl-thought"
          open={disclosureOpen}
          onToggle={(event) => {
            if (event.nativeEvent.isTrusted && event.currentTarget.open !== disclosureOpen) onDisclosureToggle?.();
          }}
        >
          <summary
            aria-label="Thinking"
            aria-describedby={Number.isFinite(item.createdAt) || Number.isFinite(item.lastActivityAt) ? timingDescriptionId : undefined}
          >
            <span className="thought-head-main">
              <span className="thought-caret" aria-hidden="true">▸</span>
              <span>💭 Thinking</span>
            </span>
            <ActivityTimestampMeta
              id={Number.isFinite(item.createdAt) || Number.isFinite(item.lastActivityAt) ? timingDescriptionId : undefined}
              className="tl-thought-time"
              startedAt={item.createdAt}
              lastActivityAt={item.lastActivityAt}
              completedAt={item.completedAt}
              pointWhenEqual
            />
          </summary>
          <div className="thought-body">
            <Markdown highlightEligible={highlightEligible}>{item.text}</Markdown>
          </div>
        </details>
      );
    case "tool_call": {
      const hasTimingDescription = Number.isFinite(item.startedAt) || Number.isFinite(item.lastActivityAt);
      const head = (disclosure: boolean) => (
        <>
          <span className="tool-head-main">
            {disclosure && <span className="tool-caret">▸</span>}
            <span className="tool-kind">{toolIcon(item.toolKind)}</span>
            <span className="tool-title">{item.title}</span>
            <span className={`tool-status tool-${item.status}`}>{titleCaseLabel(item.status)}</span>
          </span>
          <ActivityTimestampMeta
            id={disclosure && hasTimingDescription ? timingDescriptionId : undefined}
            className="tl-tool-time"
            startedAt={item.startedAt}
            lastActivityAt={item.lastActivityAt}
            completedAt={item.completedAt}
            pointWhenEqual
            showDuration
          />
        </>
      );
      // Output is collapsed by default — only the command header shows; click to reveal it.
      if (!item.text && !item.referencedText?.length) {
        return (
          <div className={`tl-tool status-${item.status}`}>
            <div className="tool-head">{head(false)}</div>
          </div>
        );
      }
      return (
        <details
          className={`tl-tool status-${item.status}`}
          open={disclosureOpen}
          onToggle={(event) => {
            if (event.nativeEvent.isTrusted && event.currentTarget.open !== disclosureOpen) onDisclosureToggle?.();
          }}
        >
          <summary
            className="tool-head"
            aria-label={`${item.title} · ${titleCaseLabel(item.status)}`}
            aria-describedby={hasTimingDescription ? timingDescriptionId : undefined}
          >
            {head(true)}
          </summary>
          {item.text && <pre className="tool-body">{item.text}</pre>}
          {item.referencedText?.map((fragment, index) => (
            <EventPayloadContent
              key={`${fragment.refs[0]?.artifactId ?? index}:${index}`}
              preview=""
              references={fragment.refs}
              mimeType="text/plain"
              label="Tool Content"
              appendFull
            >
              {(text, full) => full ? <pre className="tool-body">{text}</pre> : null}
            </EventPayloadContent>
          ))}
        </details>
      );
    }
    case "plan":
      return <PlanBlock entries={item.entries} />;
    case "file_edit": {
      const sourceLocation = timelineFileSourceLocation(item.path);
      return (
        <div className="tl-file">
          {sourceLocation && onOpenSourceLocation ? (
            <button type="button" className="file-head source-path-link" onClick={() => onOpenSourceLocation(sourceLocation)}>✎ {item.path}</button>
          ) : (
            <div className="file-head">✎ {item.path}</div>
          )}
          {(item.diff || item.diffRefs?.length) && (
            <EventPayloadContent
              preview={item.diff ?? ""}
              references={item.diffRefs}
              mimeType="text/x-diff"
              label="Diff"
            >
              {(text) => <DiffBlock diff={text} />}
            </EventPayloadContent>
          )}
        </div>
      );
    }
    case "command_output":
      return (
        <div className="tl-output">
          <EventPayloadContent preview={item.text} references={item.textRefs} mimeType="text/plain" label="Output">
            {(text) => <pre>{text}</pre>}
          </EventPayloadContent>
        </div>
      );
    case "stderr":
      return (
        <div className="tl-stderr">
          <EventPayloadContent preview={item.text} references={item.textRefs} mimeType="text/plain" label="STDERR">
            {(text) => <pre>{text}</pre>}
          </EventPayloadContent>
        </div>
      );
    case "error":
      return <div className="tl-error">⚠ {item.message}</div>;
    case "turn_interrupted":
      return (
        <div className="tl-interrupted">
          <span>Interrupted</span>
          <ActivityTimestampMeta startedAt={item.createdAt} pointWhenEqual />
        </div>
      );
    case "review_decision":
      return (
        <div className="tl-perm">
          <div className="tl-perm-head">
            <span className="perm-icon">Review</span>
            <span>Automated Review</span>
            <span className="perm-resolved">
              {titleCaseLabel(item.outcome.replace("_", " "))}{item.riskLevel ? ` (${titleCaseLabel(item.riskLevel)} Risk)` : ""}
            </span>
          </div>
          {item.rationale && <div className="bubble-text">{item.rationale}</div>}
        </div>
      );
    case "permission":
      return (
        <div className="tl-perm">
          <div className="tl-perm-head">
            <span className="perm-icon">🔐</span>
            <span>{item.title}</span>
            {item.resolvedOptionId !== undefined ? (
              <span className="perm-resolved">
                {item.resolutionReason === "replaced"
                  ? "→ Replaced"
                  : item.resolutionReason === "provider_resolved"
                    ? "→ Resolved by Provider"
                    : item.resolutionReason === "dismissed"
                      ? "→ Dismissed"
                      : item.resolvedOptionId
                      ? `→ ${item.resolvedOptionId}`
                      : "→ Dismissed"}
              </span>
            ) : (
              <span className="perm-pending">awaiting decision…</span>
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
    case "question": {
      const historicalQuestion = (
        <div className="tl-perm tl-question">
          <div className="tl-perm-head">
            <span className="perm-icon">❓</span>
            <span>
              {item.questions.length === 1
                ? item.questions[0]!.question
                : `The agent asked ${item.questions.length} questions`}
            </span>
            {item.answered !== undefined ? (
              <span className="perm-resolved">
                {item.resolutionReason === "replaced"
                  ? "→ Replaced"
                  : item.resolutionReason === "provider_resolved"
                    ? "→ Resolved by Provider"
                    : item.answered ? "→ Answered" : "→ Dismissed"}
              </span>
            ) : (
              <span className="perm-pending">awaiting answer…</span>
            )}
          </div>
          {item.questions.length > 1 && (
            <ul className="question-recap">
              {item.questions.map((q) => (
                <li key={q.id}>{q.question}</li>
              ))}
            </ul>
          )}
        </div>
      );
      return questionContext ? (
        <SessionTimelineQuestionRegion
          session={questionContext.session}
          eventRequestId={item.requestId}
          eventQuestions={item.questions}
          eventResolved={item.answered !== undefined}
          runnerOnline={questionContext.runnerOnline}
          fallbackFocusRef={questionContext.fallbackFocusRef}
          alternateFallbackFocusRef={questionContext.alternateFallbackFocusRef}
          onSessionUpdate={questionContext.onSessionUpdate}
          showKeyHints={questionContext.showKeyHints}
        >
          {historicalQuestion}
        </SessionTimelineQuestionRegion>
      ) : historicalQuestion;
    }
  }
});

function TimelineTimestamp({ label, timestamp }: { label: "Recorded" | "Started" | "Last Activity"; timestamp?: number }) {
  const { now, sessionActive } = useContext(TimelineClockContext);
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
  compact = false,
  className,
}: {
  id?: string;
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  durationOverrideMs?: number;
  pointWhenEqual?: boolean;
  showDuration?: boolean;
  /** Message-meta presentation: "start → end" with the Started/Last Activity labels demoted to
   * screen-reader-only text (each value keeps its labeled title and absolute sr time). */
  compact?: boolean;
  className?: string;
}) {
  const { now, sessionActive } = useContext(TimelineClockContext);
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
    <span id={id} className={`tl-timestamp-meta${compact ? " tl-timestamp-compact" : ""}${className ? ` ${className}` : ""}`}>
      {point ? (
        <TimelineTimestamp label="Recorded" timestamp={started} />
      ) : (
        <>
          {started != null && <TimelineTimestamp label="Started" timestamp={started} />}
          {compact && started != null && lastActivity != null && (
            <span className="tl-timestamp-arrow" aria-hidden="true">→</span>
          )}
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

function MessageMeta({
  createdAt,
  lastActivityAt,
  completedAt,
  durationMs,
  durationSource,
  copyText,
  copyLabel,
  onEditAndResend,
  onEditInFork,
}: {
  createdAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  durationMs?: number;
  durationSource?: "provider" | "observed";
  copyText: string;
  copyLabel: string;
  onEditAndResend?: () => void;
  onEditInFork?: () => void;
}) {
  const duration = durationMs != null ? formatDuration(durationMs) : "";
  const timestamp = Number.isFinite(createdAt);
  if (!timestamp && !duration && !copyText && !onEditAndResend && !onEditInFork) return null;
  return (
    <div className="tl-message-meta">
      {timestamp && (
        <ActivityTimestampMeta
          startedAt={createdAt}
          lastActivityAt={lastActivityAt}
          completedAt={completedAt}
          pointWhenEqual
          compact
        />
      )}
      {duration && (
        <span
          title={durationSource === "observed" ? "Approximate runner-recorded activity span" : "Provider-reported turn duration"}
          aria-label={`${durationSource === "observed" ? "Approximate runner-recorded activity span" : "Provider-reported turn duration"}, ${duration}`}
        >
          {durationSource === "observed" ? "~" : ""}{duration}
        </span>
      )}
      {copyText && <CopyButton text={copyText} iconOnly ariaLabel={copyLabel} className="tl-message-icon" />}
      {onEditAndResend && (
        <button
          type="button"
          className="tl-message-icon"
          onClick={onEditAndResend}
          title="Edit & Resend"
          aria-label="Edit User Message as a New Turn"
        >
          <EditIcon size={14} />
        </button>
      )}
      {onEditInFork && (
        <button
          type="button"
          className="tl-message-icon"
          onClick={onEditInFork}
          title="Edit in Fork"
          aria-label="Edit User Message in a New Conversation Fork"
        >
          <BranchIcon size={14} />
        </button>
      )}
    </div>
  );
}

function PlanBlock({ entries }: { entries: PlanEntry[] }) {
  return (
    <div className="tl-plan">
      <div className="plan-head">Plan</div>
      <ul>
        {entries.map((e, i) => (
          <li key={i} className={`plan-${e.status}`}>
            <span className="plan-check">
              {e.status === "completed" ? "✓" : e.status === "in_progress" ? "◐" : "○"}
            </span>
            {e.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="diff">
      {lines.map((line, i) => {
        let cls = "d-ctx";
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "d-add";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "d-del";
        else if (line.startsWith("@@")) cls = "d-hunk";
        else if (line.startsWith("+++") || line.startsWith("---")) cls = "d-head";
        return (
          <div key={i} className={`d-line ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function toolIcon(kind?: string): string {
  switch (kind) {
    case "read":
      return "📖";
    case "edit":
      return "✏️";
    case "delete":
      return "🗑️";
    case "move":
      return "📦";
    case "search":
      return "🔎";
    case "execute":
      return "⚡";
    case "fetch":
      return "🌐";
    case "think":
      return "💭";
    case "agent":
      return "⑃";
    default:
      return "🔧";
  }
}
