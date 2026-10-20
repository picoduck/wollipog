import type { TimelineItem } from "./timeline.js";
import { stepObjectIsPath } from "./work-steps.js";

/** What one comparison member did, counted from its timeline (#2975). */
export interface MemberActivity {
  /** Shell commands it ran (`execute` tool calls). */
  commands: number;
  /** Edit tool calls: one per Edit, Write or MultiEdit, or per Codex file change. */
  edits: number;
  /** Files it read. Glob and Grep are searches, not reads, so they are left out. */
  reads: number;
}

/**
 * Counts the member's tool calls by kind, including the work of the subagents it spawned, which is
 * still the member's. A tool call is one row however many updates it had, so a call is counted once.
 * `file_edit` rows are not counted: the drivers emit one beside each edit tool call, and the runner's
 * per-turn worktree capture is a diff, not an edit.
 */
export function memberActivity(items: readonly TimelineItem[]): MemberActivity {
  const activity: MemberActivity = { commands: 0, edits: 0, reads: 0 };
  const visit = (list: readonly TimelineItem[]) => {
    for (const item of list) {
      if (item.kind !== "tool_call") continue;
      if (item.toolKind === "execute") activity.commands += 1;
      else if (item.toolKind === "edit") activity.edits += 1;
      else if (item.toolKind === "read" && stepObjectIsPath(item.title, item.toolKind)) activity.reads += 1;
      if (item.children?.length) visit(item.children);
    }
  };
  visit(items);
  return activity;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The column's one meta line: "5 commands, 1 edit, 2 files read", naming only the kinds it did, or
 * null when it did none of them.
 */
export function memberActivityLabel(activity: MemberActivity): string | null {
  const parts = [
    activity.commands > 0 ? count(activity.commands, "command", "commands") : null,
    activity.edits > 0 ? count(activity.edits, "edit", "edits") : null,
    activity.reads > 0 ? count(activity.reads, "file read", "files read") : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(", ") : null;
}

/**
 * The whole meta line under a column's head: "Working…" while the member runs, then what it did
 * once its history is known, and nothing before that.
 */
export function memberActivityLine(working: boolean, activity: MemberActivity | null): string | null {
  if (working) return "Working…";
  if (!activity) return null;
  return memberActivityLabel(activity) ?? "No commands, edits or files read";
}
