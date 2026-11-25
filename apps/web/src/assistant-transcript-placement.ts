import type { AssistantTranscriptReceipt } from "@wollipog/protocol";
import { publishTimelineSnapshotDelta, timelineSnapshotDelta, type TimelineItem } from "./timeline.js";

export type AssistantMessageReceipt = Exclude<AssistantTranscriptReceipt, { kind: "decision" }>;

interface ToolAnchor {
  order: number;
  messageId?: number;
}

function receiptIdentity(receipt: AssistantTranscriptReceipt): string {
  switch (receipt.kind) {
    case "launch": return "launch:" + receipt.sessionId;
    case "decision": return "decision:" + receipt.occurrenceId;
    case "request": return "request:" + receipt.confirmationId;
  }
}

/** Use where each provider tool call began, even when its result comes back after another message.
 * Calls before any visible prose in a turn sit under its first reply. Until that reply arrives,
 * or when paging leaves the call unloaded, the receipt keeps its own row at the result. */
interface PlacedReceipts {
  items: TimelineItem[];
  messages: ReadonlyMap<number, readonly AssistantMessageReceipt[]>;
  /** The filtered row at each original index, for streaming updates that keep the same items. */
  rowIndexes: number[];
}

function placeAssistantReceipts(items: TimelineItem[]): PlacedReceipts | null {
  if (!items.some((item) => item.kind === "assistant_receipt")) return null;

  const tools = new Map<string, ToolAnchor>();
  let messageId: number | undefined;
  let awaitingReply: ToolAnchor[] = [];
  for (const item of items) {
    if (item.kind === "user_message") {
      messageId = undefined;
      awaitingReply = [];
    } else if (item.kind === "agent_message" && !item.parentToolUseId) {
      messageId = item.id;
      for (const anchor of awaitingReply) anchor.messageId = messageId;
      awaitingReply = [];
    } else if (item.kind === "tool_call") {
      const anchor = { order: item.id, messageId };
      tools.set(item.toolCallId, anchor);
      if (messageId === undefined) awaitingReply.push(anchor);
    }
  }

  const attached = new Map<number, { order: number; receipt: AssistantMessageReceipt }[]>();
  const seen = new Set<string>();
  const rowIndexes: number[] = [];
  const rows: TimelineItem[] = [];
  for (const [index, item] of items.entries()) {
    if (item.kind !== "assistant_receipt") {
      rowIndexes[index] = rows.push(item) - 1;
      continue;
    }
    const key = receiptIdentity(item.receipt);
    if (seen.has(key)) continue;
    seen.add(key);
    const anchor = tools.get(item.toolCallId);
    if (item.receipt.kind === "decision" || anchor?.messageId === undefined) {
      rowIndexes[index] = rows.push(item) - 1;
      continue;
    }
    const receipts = attached.get(anchor.messageId) ?? [];
    receipts.push({ order: anchor.order, receipt: item.receipt });
    attached.set(anchor.messageId, receipts);
  }
  const messages = new Map([...attached].map(([id, receipts]) =>
    [id, receipts.sort((a, b) => a.order - b.order).map(({ receipt }) => receipt)]));
  return { items: rows, messages, rowIndexes };
}

/** A new boundary can attach receipts. Ordinary streaming changes to existing text cannot.
 * Keep the message map and pass through the timeline's update coordinates on that hot path. */
export class AssistantReceiptProjector {
  private source: TimelineItem[] = [];
  private placed: PlacedReceipts | null = null;

  project(items: TimelineItem[]): PlacedReceipts | null {
    if (items === this.source) return this.placed;
    const delta = timelineSnapshotDelta(items);
    const onlyText = delta?.previous === this.source && items.length === this.source.length &&
      delta.dirtyIndexes.every((index) => {
        const before = this.source[index], next = items[index];
        return next && (next.kind === "agent_message" || next.kind === "agent_thought" ||
          next.kind === "command_output" || next.kind === "stderr") &&
          before?.kind === next.kind && before.id === next.id &&
          ("parentToolUseId" in before ? before.parentToolUseId : undefined) ===
          ("parentToolUseId" in next ? next.parentToolUseId : undefined);
      });
    this.source = items;
    if (!onlyText || !delta) return this.placed = placeAssistantReceipts(items);
    if (!this.placed) return null;
    const previous = this.placed.items;
    const rows = previous.slice();
    const dirtyIndexes = delta.dirtyIndexes.map((index) => {
      const rowIndex = this.placed!.rowIndexes[index]!;
      rows[rowIndex] = items[index]!;
      return rowIndex;
    });
    publishTimelineSnapshotDelta(rows, {
      previous, dirtyIndexes, dirtyFrom: dirtyIndexes[0] ?? rows.length,
      dirtyHasParentItems: delta.dirtyHasParentItems,
    });
    return this.placed = { ...this.placed, items: rows };
  }
}
