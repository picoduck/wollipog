import type { AuthoritativeSubagentLifecycle, SessionStatus } from "@wollipog/protocol";
import {
  publishTimelineSnapshotDelta,
  timelineSnapshotDelta,
  type SubagentRollup,
  type TimelineItem,
} from "./timeline.js";

export type SubagentLifecycle = AuthoritativeSubagentLifecycle | "unknown";

export interface SubagentDescriptor {
  /** Stable provider task identity: the spawning Task/Agent tool-call id. */
  id: string;
  parentId?: string;
  childIds: string[];
  title: string;
  depth: number;
  sourceIndex: number;
  lifecycle: SubagentLifecycle;
  toolStatus: string;
  availability: "live" | "recorded";
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  directUsage?: SubagentRollup;
  inclusiveUsage?: SubagentRollup;
}

export interface SubagentProjectionContext {
  sessionStatus: SessionStatus;
  runnerOnline: boolean;
  availability: "live" | "recorded";
}

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;

interface SubagentIndex {
  toolsById: Map<string, Map<number, ToolItem>>;
  parentItems: Map<string, Map<number, TimelineItem>>;
  /** Tool ids that can describe agents: explicit agent tools or tools with attributed output. */
  descriptorCandidateIds: Set<string>;
  parentActivityMax: Map<string, number | undefined>;
  dirtyParentActivity: Set<string>;
}

function parentIdOf(item: TimelineItem | undefined): string | undefined {
  return item && "parentToolUseId" in item && typeof item.parentToolUseId === "string" && item.parentToolUseId
    ? item.parentToolUseId
    : undefined;
}

function recordedTimes(item: TimelineItem): number[] {
  if (item.kind === "tool_call") {
    return [item.startedAt, item.lastActivityAt, item.completedAt]
      .filter((value): value is number => Number.isFinite(value));
  }
  if (item.kind === "agent_message" || item.kind === "agent_thought") {
    return [item.createdAt, item.lastActivityAt, item.completedAt]
      .filter((value): value is number => Number.isFinite(value));
  }
  return [];
}

function refreshDescriptorCandidate(index: SubagentIndex, toolCallId: string | undefined): void {
  if (!toolCallId) return;
  const hasAgentTool = [...(index.toolsById.get(toolCallId)?.values() ?? [])]
    .some((tool) => tool.toolKind === "agent");
  if (hasAgentTool || index.parentItems.has(toolCallId)) index.descriptorCandidateIds.add(toolCallId);
  else index.descriptorCandidateIds.delete(toolCallId);
}

function addIndexedItem(index: SubagentIndex, sourceIndex: number, item: TimelineItem): void {
  if (item.kind === "tool_call" && item.toolCallId) {
    const tools = index.toolsById.get(item.toolCallId) ?? new Map<number, ToolItem>();
    tools.set(sourceIndex, item);
    index.toolsById.set(item.toolCallId, tools);
  }
  const parentId = parentIdOf(item);
  if (parentId) {
    const children = index.parentItems.get(parentId) ?? new Map<number, TimelineItem>();
    children.set(sourceIndex, item);
    index.parentItems.set(parentId, children);
    const itemActivity = maxDefined(recordedTimes(item));
    const previousActivity = index.parentActivityMax.get(parentId);
    if (itemActivity != null && (previousActivity == null || itemActivity >= previousActivity)) {
      index.parentActivityMax.set(parentId, itemActivity);
      index.dirtyParentActivity.delete(parentId);
    }
  }
  refreshDescriptorCandidate(index, item.kind === "tool_call" ? item.toolCallId : undefined);
  refreshDescriptorCandidate(index, parentId);
}

function removeIndexedItem(index: SubagentIndex, sourceIndex: number, item: TimelineItem): void {
  if (item.kind === "tool_call") {
    const tools = index.toolsById.get(item.toolCallId);
    tools?.delete(sourceIndex);
    if (tools?.size === 0) index.toolsById.delete(item.toolCallId);
  }
  const parentId = parentIdOf(item);
  if (parentId) {
    const children = index.parentItems.get(parentId);
    children?.delete(sourceIndex);
    if (children?.size === 0) {
      index.parentItems.delete(parentId);
      index.parentActivityMax.delete(parentId);
      index.dirtyParentActivity.delete(parentId);
    } else if (recordedTimes(item).includes(index.parentActivityMax.get(parentId)!)) {
      index.dirtyParentActivity.add(parentId);
    }
  }
  refreshDescriptorCandidate(index, item.kind === "tool_call" ? item.toolCallId : undefined);
  refreshDescriptorCandidate(index, parentId);
}

function refreshDirtyParentActivity(index: SubagentIndex): void {
  for (const parentId of index.dirtyParentActivity) {
    const activity = maxDefined(
      [...(index.parentItems.get(parentId)?.values() ?? [])].flatMap(recordedTimes),
    );
    index.parentActivityMax.set(parentId, activity);
  }
  index.dirtyParentActivity.clear();
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return finite.length ? Math.max(...finite) : undefined;
}

function sumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left == null) return right;
  if (right == null) return left;
  return left + right;
}

function inclusiveRollup(
  own: SubagentRollup | undefined,
  children: Array<SubagentRollup | undefined>,
): SubagentRollup | undefined {
  let durationMs = own?.durationMs;
  let inputTokens = own?.inputTokens;
  let outputTokens = own?.outputTokens;
  let cachedInputTokens = own?.cachedInputTokens;
  let costUsd = own?.costUsd;
  for (const child of children) {
    if (!child) continue;
    durationMs = maxDefined([durationMs, child.durationMs]);
    inputTokens = sumDefined(inputTokens, child.inputTokens);
    outputTokens = sumDefined(outputTokens, child.outputTokens);
    cachedInputTokens = sumDefined(cachedInputTokens, child.cachedInputTokens);
    costUsd = sumDefined(costUsd, child.costUsd);
  }
  if ([durationMs, inputTokens, outputTokens, cachedInputTokens, costUsd]
    .every((value) => value == null)) return undefined;
  return {
    ...(durationMs == null ? {} : { durationMs }),
    ...(inputTokens == null ? {} : { inputTokens }),
    ...(outputTokens == null ? {} : { outputTokens }),
    ...(cachedInputTokens == null ? {} : { cachedInputTokens }),
    ...(costUsd == null ? {} : { costUsd }),
  };
}

export function deriveSubagentLifecycle(
  toolStatus: string,
  sessionStatus: SessionStatus,
  runnerOnline: boolean,
  authoritative?: AuthoritativeSubagentLifecycle,
): SubagentLifecycle {
  if (authoritative) {
    const active = authoritative === "starting" || authoritative === "running" || authoritative === "waiting";
    if (active && (!runnerOnline || sessionStatus === "failed")) return "unreachable";
    return authoritative;
  }
  const normalized = toolStatus.toLowerCase();
  if (["completed", "success", "succeeded"].includes(normalized)) return "completed";
  if (["failed", "error", "rejected"].includes(normalized)) return "failed";
  if (["cancelled", "canceled"].includes(normalized)) return "interrupted";

  const activeSession = ["queued", "starting", "running", "input_required"].includes(sessionStatus);
  if (!runnerOnline && activeSession) return "unreachable";
  if (sessionStatus === "failed") return "unreachable";
  if (["stopped", "idle", "completed"].includes(sessionStatus) &&
      ["pending", "in_progress", "running"].includes(normalized)) return "interrupted";
  if (normalized === "pending" || normalized === "starting") return "starting";
  if (normalized === "in_progress" || normalized === "running") return "running";
  return "unknown";
}

/**
 * Project the flat, provider-neutral timeline into selectable subagent descriptors. The spawning
 * Task/Agent tool is the identity boundary; child events remain on the ordinary event stream.
 * Duplicate ids and cycles fail open: ambiguous nodes stay visible but do not claim one another.
 */
function deriveIndexedSubagentDescriptors(
  index: SubagentIndex,
  context: SubagentProjectionContext,
): SubagentDescriptor[] {
  refreshDirtyParentActivity(index);
  const nodes = new Map<string, { tool: ToolItem; sourceIndex: number; parentId?: string }>();
  for (const toolCallId of index.descriptorCandidateIds) {
    const tools = index.toolsById.get(toolCallId);
    if (!toolCallId) continue;
    if (tools?.size !== 1) continue;
    const [sourceIndex, tool] = tools.entries().next().value as [number, ToolItem];
    if (tool.toolKind !== "agent" && !index.parentItems.has(toolCallId)) continue;
    nodes.set(toolCallId, { tool, sourceIndex, parentId: parentIdOf(tool) });
  }

  const cyclic = new Set<string>();
  const resolved = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (resolved.has(id)) return;
    const cycleAt = path.indexOf(id);
    if (cycleAt >= 0) {
      for (const member of path.slice(cycleAt)) cyclic.add(member);
      return;
    }
    const parentId = nodes.get(id)?.parentId;
    if (parentId && nodes.has(parentId)) visit(parentId, [...path, id]);
    resolved.add(id);
  };
  for (const id of nodes.keys()) visit(id, []);

  const effectiveParent = new Map<string, string | undefined>();
  const children = new Map<string, string[]>();
  for (const [id, node] of nodes) {
    const parentId = node.parentId && nodes.has(node.parentId) && !cyclic.has(id)
      ? node.parentId
      : undefined;
    effectiveParent.set(id, parentId);
    if (parentId) children.set(parentId, [...(children.get(parentId) ?? []), id]);
  }
  for (const ids of children.values()) {
    ids.sort((left, right) => nodes.get(left)!.sourceIndex - nodes.get(right)!.sourceIndex);
  }

  const directLastActivity = new Map<string, number | undefined>();
  for (const [id, node] of nodes) {
    directLastActivity.set(id, maxDefined([...recordedTimes(node.tool), index.parentActivityMax.get(id)]));
  }

  const inclusiveActivity = new Map<string, number | undefined>();
  const inclusiveUsageById = new Map<string, SubagentRollup | undefined>();
  const aggregate = (id: string): void => {
    const childIds = children.get(id) ?? [];
    for (const childId of childIds) aggregate(childId);
    inclusiveActivity.set(id, maxDefined([
      directLastActivity.get(id),
      ...childIds.map((childId) => inclusiveActivity.get(childId)),
    ]));
    inclusiveUsageById.set(id, inclusiveRollup(
      nodes.get(id)!.tool.subagentRollup,
      childIds.map((childId) => inclusiveUsageById.get(childId)),
    ));
  };
  for (const id of nodes.keys()) if (!effectiveParent.get(id)) aggregate(id);

  const descriptors: SubagentDescriptor[] = [];
  const emitted = new Set<string>();
  const emit = (id: string, depth: number): void => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const node = nodes.get(id)!;
    const childIds = children.get(id) ?? [];
    descriptors.push({
      id,
      ...(effectiveParent.get(id) ? { parentId: effectiveParent.get(id) } : {}),
      childIds,
      title: node.tool.title && !/^(Task|Agent)$/i.test(node.tool.title) ? node.tool.title : "Agent",
      depth,
      sourceIndex: node.sourceIndex,
      lifecycle: deriveSubagentLifecycle(
        node.tool.status,
        context.sessionStatus,
        context.runnerOnline,
        node.tool.subagentLifecycle,
      ),
      toolStatus: node.tool.status,
      availability: context.availability,
      ...(node.tool.startedAt == null ? {} : { startedAt: node.tool.startedAt }),
      ...(inclusiveActivity.get(id) == null ? {} : { lastActivityAt: inclusiveActivity.get(id) }),
      ...(node.tool.completedAt == null ? {} : { completedAt: node.tool.completedAt }),
      ...(node.tool.subagentRollup == null ? {} : { directUsage: node.tool.subagentRollup }),
      ...(inclusiveUsageById.get(id) == null ? {} : { inclusiveUsage: inclusiveUsageById.get(id) }),
    });
    for (const childId of childIds) emit(childId, depth + 1);
  };

  const roots = [...nodes.keys()]
    .filter((id) => !effectiveParent.get(id))
    .sort((left, right) => nodes.get(left)!.sourceIndex - nodes.get(right)!.sourceIndex);
  for (const id of roots) emit(id, 0);
  for (const id of [...nodes.keys()]
    .sort((left, right) => nodes.get(left)!.sourceIndex - nodes.get(right)!.sourceIndex)) emit(id, 0);
  return descriptors;
}

function emptySubagentIndex(): SubagentIndex {
  return {
    toolsById: new Map(),
    parentItems: new Map(),
    descriptorCandidateIds: new Set(),
    parentActivityMax: new Map(),
    dirtyParentActivity: new Set(),
  };
}

export function deriveSubagentDescriptors(
  items: TimelineItem[],
  context: SubagentProjectionContext,
): SubagentDescriptor[] {
  const index = emptySubagentIndex();
  items.forEach((item, sourceIndex) => addIndexedItem(index, sourceIndex, item));
  return deriveIndexedSubagentDescriptors(index, context);
}

export interface SubagentProjection {
  descriptors: SubagentDescriptor[];
  /** Provider ids that cannot safely identify one agent in this generation. */
  ambiguousIds: ReadonlySet<string>;
  /** Number of agent/output-owner ids inspected while deriving descriptors. */
  descriptorCandidates: number;
  /** True when exact TimelineBuilder metadata let the projector touch only changed slots. */
  incremental: boolean;
  /** Number of raw timeline slots inspected for this projection. */
  processedItems: number;
  revision: number;
}

/**
 * Retained structural projection for the Subagents panel. TimelineBuilder snapshots identify the
 * exact changed indexes, so streamed text updates and appends update the parent/tool indexes in
 * O(changed items) instead of rescanning the full transcript on every chunk. Descriptor assembly
 * then walks only agent structure, while `timeline()` reads the indexed selected subtree.
 */
export class IncrementalSubagentProjector {
  private items: TimelineItem[] = [];
  private index = emptySubagentIndex();
  private context: SubagentProjectionContext | null = null;
  private projection: SubagentProjection = {
    descriptors: [], ambiguousIds: new Set(), descriptorCandidates: 0,
    incremental: false, processedItems: 0, revision: 0,
  };
  private outputCache: {
    selectedId: string;
    childKey: string;
    revision: number;
    sourceIndexes: number[];
    items: TimelineItem[];
  } | null = null;
  private previousItems: TimelineItem[] = [];
  private changedIndexes: number[] = [];

  project(items: TimelineItem[], context: SubagentProjectionContext): SubagentProjection {
    const sameContext = this.context?.sessionStatus === context.sessionStatus &&
      this.context.runnerOnline === context.runnerOnline && this.context.availability === context.availability;
    if (items === this.items && sameContext) return this.projection;

    const delta = timelineSnapshotDelta(items);
    const incremental = delta?.previous === this.items;
    let processedItems = 0;
    this.previousItems = this.items;
    this.changedIndexes = [];
    if (incremental) {
      const changed = new Set(delta.dirtyIndexes);
      for (let sourceIndex = this.items.length; sourceIndex < items.length; sourceIndex += 1) changed.add(sourceIndex);
      this.changedIndexes = [...changed].sort((left, right) => left - right);
      for (const sourceIndex of this.changedIndexes) {
        const previous = this.items[sourceIndex];
        const current = items[sourceIndex];
        if (previous) removeIndexedItem(this.index, sourceIndex, previous);
        if (current) addIndexedItem(this.index, sourceIndex, current);
      }
      processedItems = changed.size;
    } else if (items !== this.items) {
      this.index = emptySubagentIndex();
      items.forEach((item, sourceIndex) => addIndexedItem(this.index, sourceIndex, item));
      processedItems = items.length;
      this.outputCache = null;
    } else if (!sameContext) {
      // Lifecycle and availability can change while the retained timeline array stays identical.
      // Rebuild the selected output cache instead of treating that revision as an item delta.
      this.outputCache = null;
    }

    this.items = items;
    this.context = context;
    const descriptors = deriveIndexedSubagentDescriptors(this.index, context);
    const ambiguousIds = new Set([...this.index.descriptorCandidateIds]
      .filter((id) => (this.index.toolsById.get(id)?.size ?? 0) > 1));
    this.projection = {
      descriptors,
      ambiguousIds,
      descriptorCandidates: this.index.descriptorCandidateIds.size,
      incremental,
      processedItems,
      revision: this.projection.revision + 1,
    };
    return this.projection;
  }

  timeline(selectedId: string | null): TimelineItem[] {
    if (!selectedId) return [];
    const byId = new Map(this.projection.descriptors.map((descriptor) => [descriptor.id, descriptor]));
    if (!byId.has(selectedId)) return [];
    const included = new Set<string>();
    const include = (id: string): void => {
      if (included.has(id)) return;
      included.add(id);
      for (const childId of byId.get(id)?.childIds ?? []) include(childId);
    };
    include(selectedId);
    const childKey = [...included].sort().join("\u0000");
    if (this.outputCache?.selectedId === selectedId && this.outputCache.childKey === childKey &&
        this.outputCache.revision === this.projection.revision) return this.outputCache.items;

    if (this.projection.incremental && this.outputCache?.selectedId === selectedId &&
        this.outputCache.childKey === childKey &&
        this.outputCache.revision === this.projection.revision - 1) {
      const previousProjected = this.outputCache.items;
      let sourceIndexes = this.outputCache.sourceIndexes;
      let projected = this.outputCache.items;
      let mutable = false;
      const ensureMutable = () => {
        if (mutable) return;
        sourceIndexes = [...sourceIndexes];
        projected = [...projected];
        mutable = true;
      };
      for (const sourceIndex of this.changedIndexes) {
        const previousParent = parentIdOf(this.previousItems[sourceIndex]);
        const currentParent = parentIdOf(this.items[sourceIndex]);
        const previousIncluded = previousParent != null && included.has(previousParent);
        const currentIncluded = currentParent != null && included.has(currentParent);
        const outputIndex = previousIncluded ? sourceIndexes.indexOf(sourceIndex) : -1;
        if (previousIncluded && currentIncluded && outputIndex >= 0) {
          ensureMutable();
          projected[outputIndex] = this.items[sourceIndex]!;
        } else if (previousIncluded && !currentIncluded && outputIndex >= 0) {
          ensureMutable();
          sourceIndexes.splice(outputIndex, 1);
          projected.splice(outputIndex, 1);
        } else if (!previousIncluded && currentIncluded) {
          ensureMutable();
          const insertion = sourceIndex > (sourceIndexes.at(-1) ?? -1)
            ? -1
            : sourceIndexes.findIndex((candidate) => candidate > sourceIndex);
          const target = insertion < 0 ? sourceIndexes.length : insertion;
          sourceIndexes.splice(target, 0, sourceIndex);
          projected.splice(target, 0, this.items[sourceIndex]!);
        }
      }
      this.outputCache = {
        selectedId,
        childKey,
        revision: this.projection.revision,
        sourceIndexes,
        items: projected,
      };
      if (projected !== previousProjected) publishFilteredTimelineDelta(previousProjected, projected, selectedId);
      return projected;
    }

    const sourceIndexes = [...included].flatMap((id) => [...(this.index.parentItems.get(id)?.keys() ?? [])])
      .sort((left, right) => left - right);
    const projected = sourceIndexes.map((sourceIndex) => this.items[sourceIndex]!).filter(Boolean);
    this.outputCache = { selectedId, childKey, revision: this.projection.revision, sourceIndexes, items: projected };
    return projected;
  }
}

function publishFilteredTimelineDelta(
  previous: TimelineItem[],
  current: TimelineItem[],
  selectedId: string,
): void {
  const dirtyIndexes: number[] = [];
  let dirtyFrom = Math.max(previous.length, current.length);
  let dirtyHasParentItems = false;
  const comparedLength = Math.max(previous.length, current.length);
  for (let index = 0; index < comparedLength; index += 1) {
    const previousItem = previous[index];
    const currentItem = current[index];
    if (previousItem === currentItem) continue;
    dirtyFrom = Math.min(dirtyFrom, index);
    dirtyIndexes.push(index);
    // The selected root tool is intentionally absent from its filtered output. Treat its direct
    // children as top-level orphans so EventTimeline can use the safe tail-append path; nested
    // agents remain represented by their tool item and keep parent-aware projection.
    const previousParent = parentIdOf(previousItem);
    const currentParent = parentIdOf(currentItem);
    if ((previousParent != null && previousParent !== selectedId) ||
        (currentParent != null && currentParent !== selectedId)) dirtyHasParentItems = true;
  }
  publishTimelineSnapshotDelta(current, { previous, dirtyFrom, dirtyIndexes, dirtyHasParentItems });
}

export function selectedSubagentId(
  descriptors: SubagentDescriptor[],
  requested?: string | null,
  retainedAutomatic?: string | null,
): string | null {
  if (requested != null) {
    return descriptors.some((descriptor) => descriptor.id === requested) ? requested : null;
  }
  if (retainedAutomatic && descriptors.some((descriptor) => descriptor.id === retainedAutomatic)) {
    return retainedAutomatic;
  }
  const mostRecent = (candidates: SubagentDescriptor[]): string | null => [...candidates]
    .sort((left, right) =>
      (right.lastActivityAt ?? right.startedAt ?? right.sourceIndex) -
      (left.lastActivityAt ?? left.startedAt ?? left.sourceIndex))
    .at(0)?.id ?? null;
  return mostRecent(descriptors.filter((descriptor) =>
    descriptor.lifecycle === "starting" || descriptor.lifecycle === "running"))
    ?? mostRecent(descriptors.filter((descriptor) => descriptor.lifecycle === "failed"))
    ?? mostRecent(descriptors);
}

/** Selected output includes the whole subtree, in original event order, but no parent/sibling work. */
export function filterSubagentTimeline(
  items: TimelineItem[],
  descriptors: SubagentDescriptor[],
  selectedId: string,
): TimelineItem[] {
  const includedParents = new Set<string>();
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const include = (id: string): void => {
    if (includedParents.has(id)) return;
    includedParents.add(id);
    for (const childId of byId.get(id)?.childIds ?? []) include(childId);
  };
  include(selectedId);
  return items.filter((item) => {
    const parentId = parentIdOf(item);
    return parentId != null && includedParents.has(parentId);
  });
}

export function subagentTokenTotal(usage: SubagentRollup | undefined): number | undefined {
  if (usage?.inputTokens == null && usage?.outputTokens == null) return undefined;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}
