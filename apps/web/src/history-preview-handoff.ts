import type { SessionHistoryHandoff } from "@wollipog/protocol";
import { TimelineBuilder, groupTimeline, type TimelineItem } from "./timeline.js";
import { flattenTimelineRows, IncrementalTimelineRows, type TimelineReadingState, type TimelineRenderRow } from "./components/EventTimeline.js";
import type { PreviewAnchor } from "./use-history-preview.js";

export function timelineRowSource(row: TimelineRenderRow): number | undefined {
  return row.kind === "item" ? (row.attempts?.[0] ?? row.item).id
    : row.kind === "work_summary" ? row.firstItemId : row.tool.id;
}

/** Preserve disclosures and the actual rendered row, including expanded tool/agent bodies.
 * A CP-only row may split a work block; every resulting piece retains the old open state. */
export function convertPreviewReadingState(reading: TimelineReadingState, page: SessionHistoryHandoff, anchor: PreviewAnchor) {
  const identities = new Map(page.identities.map(value => [value.runnerSeq, value.seq]));
  const reverse = new Map(page.identities.map(value => [value.seq, value.runnerSeq]));
  const builder = new TimelineBuilder();
  for (const event of page.events) builder.push(event);
  const items = builder.snapshot();
  const groups = groupTimeline(items);
  const projector = new IncrementalTimelineRows();
  projector.project(items, new Map(), reading.showAgentLogs);
  const disclosure = new Map<string, boolean>();
  const oldGroups = groupTimeline(reading.items);
  const sourceEnd = (item: TimelineItem): number => {
    const end = "sourceEndId" in item ? item.sourceEndId ?? item.id : item.id;
    return item.kind === "tool_call" ? Math.max(end, ...(item.children ?? []).map(sourceEnd)) : end;
  };
  for (const group of groups) {
    if (group.kind !== "work") continue;
    const source = reverse.get(group.items[0]!.id);
    if (source === undefined) continue;
    const old = oldGroups.find(value => value.kind === "work" && source >= value.items[0]!.id &&
      source <= Math.max(...value.items.map(sourceEnd)));
    if (!old || old.kind !== "work") continue;
    const summary = reading.rows.find(row => row.kind === "work_summary" && row.firstItemId === old.items[0]!.id);
    if (summary?.kind === "work_summary") disclosure.set(`work:${group.id}`, summary.open);
  }
  // Resolve keys through semantic source identities rather than rewriting tool IDs or offsets.
  for (const row of reading.rows) {
    const source = timelineRowSource(row);
    const seq = source === undefined ? undefined : identities.get(source);
    if (seq === undefined || row.kind === "work_summary") continue;
    const target = projector.resolveRevealTarget(seq);
    if (!target) continue;
    const key = row.kind === "subagent_output"
      ? target.rowKey.replace(/^agent:/, "agent-output:") : target.rowKey;
    const open = reading.disclosure.get(row.key);
    if (open !== undefined) disclosure.set(key, open);
    const details = reading.disclosure.get(`row-details:${row.key}`);
    if (details !== undefined) disclosure.set(`row-details:${key}`, details);
  }
  const rows = flattenTimelineRows(groups, disclosure, reading.showAgentLogs);
  const row = rows.find(value => value.kind === anchor.rowKind && timelineRowSource(value) === page.anchorSeq);
  return row ? { disclosure, anchor: { key: row.key, offset: anchor.offset } } : null;
}
