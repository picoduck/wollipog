import type { ReviewRiskLevel } from "@wollipog/protocol";
import { formatDuration, formatRecordedTimestamp } from "./format.js";
import type { TimelineItem } from "./timeline.js";

/**
 * The pure half of the transcript's work ledger (#2168, docs/design-system.md §5.5, §11.2): which
 * steps a run of work shows, what its one ledger line counts, and how a step names itself. The
 * row projector and the step components share these, so a count, a folded retry and a rendered row
 * can never disagree.
 */

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;

/** An agent tool call owns a subagent summary and its nested rows, so it never folds. */
const ownsSubagent = (item: ToolItem): boolean => item.toolKind === "agent" || Boolean(item.children?.length);

/** Consecutive calls with this identity are attempts at the same step; `null` never folds. */
export function retryIdentity(item: TimelineItem | undefined): string | null {
  if (item?.kind !== "tool_call" || ownsSubagent(item)) return null;
  return `${item.toolKind ?? ""}\u0000${item.title}`;
}

/** One rendered step: a single item, or the attempts of a retried tool call, oldest first. */
export type WorkStep =
  | { item: TimelineItem; attempts?: undefined }
  | { item: ToolItem; attempts: readonly ToolItem[] };

/**
 * Fold consecutive tool calls of the same kind and title while the previous attempt failed: three
 * failed runs of one command are one step whose last attempt is its status. A call after a
 * success starts a new step, so two deliberate reads of one file stay two rows.
 */
export function foldRetries(items: readonly TimelineItem[]): WorkStep[] {
  const steps: WorkStep[] = [];
  let attempts: ToolItem[] | null = null;
  let identity: string | null = null;
  const flush = () => {
    if (!attempts) return;
    const last = attempts.at(-1)!;
    steps.push(attempts.length > 1 ? { item: last, attempts } : { item: last });
    attempts = null;
    identity = null;
  };
  for (const item of items) {
    const next = retryIdentity(item);
    if (attempts && next !== null && next === identity && attempts.at(-1)!.status === "failed") {
      attempts.push(item as ToolItem);
      continue;
    }
    flush();
    if (next !== null) {
      attempts = [item as ToolItem];
      identity = next;
    } else {
      steps.push({ item });
    }
  }
  flush();
  return steps;
}

/** True when a change to `item` at `index` could join or split a fold with a neighbour. */
export function retryNeighbours(container: readonly TimelineItem[], index: number, ...identities: Array<string | null>): boolean {
  const relevant = identities.filter((identity): identity is string => identity !== null);
  if (relevant.length === 0) return false;
  const before = retryIdentity(container[index - 1]);
  const after = retryIdentity(container[index + 1]);
  return relevant.some((identity) => identity === before || identity === after);
}

/** What one work ledger line says about its run of work. */
export interface WorkLedger {
  /** Tool steps, a folded retry counting once. */
  tools: number;
  edits: number;
  thoughts: number;
  /** Tool steps whose latest attempt failed. */
  failed: number;
  autoApproved: number;
  highestReviewRisk?: ReviewRiskLevel;
  /** The run's first and last recorded activity, for "Worked for 26s". */
  startedAt?: number;
  finishedAt?: number;
}

const reviewRiskRank: Record<ReviewRiskLevel, number> = { low: 1, medium: 2, high: 3 };

export function higherReviewRisk(
  current: ReviewRiskLevel | undefined,
  candidate: ReviewRiskLevel | undefined,
): ReviewRiskLevel | undefined {
  if (!candidate || (current && reviewRiskRank[current] >= reviewRiskRank[candidate])) return current;
  return candidate;
}

function itemTimes(item: TimelineItem): Array<number | undefined> {
  switch (item.kind) {
    case "agent_thought":
      return [item.createdAt, item.lastActivityAt, item.completedAt];
    case "tool_call":
      return [item.startedAt, item.lastActivityAt, item.completedAt];
    case "review_decision":
      return [item.createdAt];
    case "governance_decision":
      return [item.decision.timestamp];
    default:
      return [];
  }
}

/** The ledger for a run of work's top-level items. Nested subagent work is the agent's own. */
export function summarizeWork(items: readonly TimelineItem[]): WorkLedger {
  const ledger: WorkLedger = { tools: 0, edits: 0, thoughts: 0, failed: 0, autoApproved: 0 };
  for (const step of foldRetries(items)) {
    const item = step.item;
    if (item.kind === "tool_call") {
      ledger.tools += 1;
      if (item.status === "failed") ledger.failed += 1;
    } else if (item.kind === "file_edit") ledger.edits += 1;
    else if (item.kind === "agent_thought") ledger.thoughts += 1;
    else if (item.kind === "review_decision" && item.outcome === "allowed") {
      ledger.autoApproved += 1;
      const risk = higherReviewRisk(ledger.highestReviewRisk, item.riskLevel);
      if (risk) ledger.highestReviewRisk = risk;
    }
  }
  for (const item of items) {
    for (const time of itemTimes(item)) {
      if (!Number.isFinite(time)) continue;
      if (ledger.startedAt === undefined || time! < ledger.startedAt) ledger.startedAt = time;
      if (ledger.finishedAt === undefined || time! > ledger.finishedAt) ledger.finishedAt = time;
    }
  }
  return ledger;
}

/** Two independent runs of work, as one: the incremental projector appends a batch's ledger. */
export function mergeWork(left: WorkLedger, right: WorkLedger): WorkLedger {
  const startedAt = [left.startedAt, right.startedAt].filter((value): value is number => value !== undefined);
  const finishedAt = [left.finishedAt, right.finishedAt].filter((value): value is number => value !== undefined);
  const risk = higherReviewRisk(left.highestReviewRisk, right.highestReviewRisk);
  return {
    tools: left.tools + right.tools,
    edits: left.edits + right.edits,
    thoughts: left.thoughts + right.thoughts,
    failed: left.failed + right.failed,
    autoApproved: left.autoApproved + right.autoApproved,
    ...(risk ? { highestReviewRisk: risk } : {}),
    ...(startedAt.length ? { startedAt: Math.min(...startedAt) } : {}),
    ...(finishedAt.length ? { finishedAt: Math.max(...finishedAt) } : {}),
  };
}

export function sameWork(left: WorkLedger, right: WorkLedger): boolean {
  return left.tools === right.tools && left.edits === right.edits && left.thoughts === right.thoughts &&
    left.failed === right.failed && left.autoApproved === right.autoApproved &&
    left.highestReviewRisk === right.highestReviewRisk && left.startedAt === right.startedAt &&
    left.finishedAt === right.finishedAt;
}

/**
 * A provider title as a verb and its object: "Edit: /repo/src/a.ts" → Edit, src/a.ts; Codex's
 * "$ npm test" → Run, npm test. A title without an object keeps its words as the verb.
 */
export function splitStepTitle(title: string, workspaceRoot?: string): { verb: string; object?: string } {
  const command = /^\$\s+(.+)$/s.exec(title);
  if (command) return { verb: "Run", object: command[1]!.trim() };
  const labelled = /^([A-Za-z][\w-]*(?: [A-Za-z][\w-]*)?):\s+(.+)$/s.exec(title);
  if (labelled) {
    const name = labelled[1]!;
    return {
      verb: Object.hasOwn(TOOL_VERBS, name) ? TOOL_VERBS[name]! : name,
      object: workspaceRelativePath(labelled[2]!.trim(), workspaceRoot),
    };
  }
  return { verb: title };
}

/** Provider tool names that are not verbs, as the verb a person would use. */
const TOOL_VERBS: Record<string, string> = {
  Bash: "Run",
  Glob: "Find",
  Grep: "Search",
  MultiEdit: "Edit",
  NotebookEdit: "Edit Notebook",
  WebFetch: "Fetch",
  WebSearch: "Search Web",
};

/** "Started 12:25:38 AM, finished 12:26:04 AM (26s)": the exact span behind a compact duration. */
export function activitySpanDescription(startedAt: number | undefined, finishedAt: number | undefined): string {
  const started = formatRecordedTimestamp(startedAt)?.label;
  const finished = formatRecordedTimestamp(finishedAt)?.label;
  const duration = startedAt !== undefined && finishedAt !== undefined
    ? formatDuration(Math.max(0, finishedAt - startedAt))
    : "";
  const span = started && finished
    ? `Started ${started}, finished ${finished}`
    : finished ? `Finished ${finished}` : started ? `Started ${started}` : "";
  return span && duration ? `${span} (${duration})` : span;
}

/** A path under the session's root, relative to it; any other path as given. */
export function workspaceRelativePath(path: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return path;
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const slashed = path.replace(/\\/g, "/");
  if (!root || !slashed.startsWith(`${root}/`)) return path;
  return slashed.slice(root.length + 1) || path;
}

/** "+12 −3" from a unified diff's body lines; headers are not changes. */
export function diffLineCounts(diff: string | undefined): { added: number; removed: number } | null {
  if (!diff) return null;
  const lines = diff.split("\n");
  // Inside a hunk every +/- line is a change, even "+++counter;"; only a file's header, before its
  // first "@@", carries ---/+++ paths. A bare body with no hunk header falls back to the prefixes.
  const hunked = lines.some((line) => line.startsWith("@@"));
  let inHunk = !hunked;
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (hunked && line.startsWith("diff ")) inHunk = false;
    else if (hunked && line.startsWith("@@")) inHunk = true;
    else if (!inHunk) continue;
    else if (line.startsWith("+") && (hunked || !line.startsWith("+++"))) added += 1;
    else if (line.startsWith("-") && (hunked || !line.startsWith("---"))) removed += 1;
  }
  return { added, removed };
}

const EXIT_CODE = /^\s*(?:exit(?:ed with)? code|exit status|process exited with code|command exited with code)[:\s]+(-?\d+)\b/i;
const ERROR_LINE = /\b(?:error|errors|errno|fail|failed|failure|fatal|exception|traceback|panic(?:ked)?)\b/i;

/**
 * Which output lines of a failed step read as the failure: the exit code line and the lines that
 * name an error. When neither appears, the whole output is the provider's error message.
 */
export function failureLines(text: string): { lines: string[]; failing: boolean[]; exitCode?: number } {
  const lines = text.split("\n");
  let exitCode: number | undefined;
  const failing = lines.map((line) => {
    const exit = EXIT_CODE.exec(line);
    if (exit) {
      exitCode ??= Number(exit[1]);
      return true;
    }
    return ERROR_LINE.test(line);
  });
  if (!failing.some(Boolean)) return { lines, failing: lines.map((line) => line.trim() !== "") };
  return exitCode === undefined ? { lines, failing } : { lines, failing, exitCode };
}
