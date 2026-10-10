import type { DescendantRequestView, PendingApproval } from "@wollipog/protocol";
import type { CampaignStatusAvailability } from "./campaign-status.js";
import type { RightPanelMode } from "./right-panel.js";
import type { ShortcutId } from "./shortcuts.js";

/**
 * The side panel's tools, in the one order the tool switcher (#2843) and the Session Tools list
 * (#2844) both render: Session Tools first, then the Code, Work and Decisions groups. Each tool is
 * a panel mode except Terminal, which opens the bottom dock until it becomes a panel tool (#2868).
 * Each tool's one glyph is `SESSION_TOOL_ICONS` (SessionToolsList.tsx), keyed by the same ids.
 */
export type SessionToolId = RightPanelMode | "terminal";

/** A group's heading, Title Case as written (§9.1). Session Tools itself is in no group. */
export type SessionToolGroup = "Code" | "Work" | "Decisions";

export interface SessionTool {
  id: SessionToolId;
  /** The tool's one name: the switcher's title and item, the list's row, and the panel's heading. */
  name: string;
  group: SessionToolGroup | null;
  /** The chord that opens it, shown as a keycap on fine pointers. */
  shortcut?: ShortcutId;
}

export const SESSION_TOOL_GROUPS: readonly SessionToolGroup[] = ["Code", "Work", "Decisions"];

export const SESSION_TOOLS: readonly SessionTool[] = [
  { id: "launcher", name: "Session Tools", group: null },
  { id: "review", name: "Review", group: "Code", shortcut: "open-review" },
  { id: "files", name: "Files", group: "Code", shortcut: "open-files" },
  { id: "browser", name: "Browser", group: "Code" },
  { id: "terminal", name: "Terminal", group: "Code", shortcut: "toggle-terminal" },
  { id: "subagents", name: "Agents", group: "Work" },
  { id: "sidechat", name: "Side Chat", group: "Work", shortcut: "open-side-chat" },
  { id: "background", name: "Background Work", group: "Work" },
  { id: "campaign", name: "Campaign Status", group: "Work" },
  { id: "requests", name: "Requests", group: "Decisions" },
  { id: "decisions", name: "Decision History", group: "Decisions" },
];

export function sessionTool(id: SessionToolId): SessionTool {
  const tool = SESSION_TOOLS.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`unknown session tool: ${id}`);
  return tool;
}

/** What decides whether a tool can open for this session. */
export interface SessionToolContext {
  filesSupported: boolean;
  /** Why Files is unavailable, when it is. */
  filesHint: string;
  terminalSupported: boolean;
  terminalHint: string;
  backgroundAvailable: boolean;
  campaignAvailability: CampaignStatusAvailability;
}

export const BACKGROUND_WORK_UNAVAILABLE = "No background-work capability or history is available for this session.";

/**
 * Whether a tool is listed, and if it is, why it cannot open (null when it can). Campaign Status is
 * listed only for campaign sessions. An unavailable tool is still listed, with its reason visible.
 */
export function sessionToolAvailability(
  id: SessionToolId,
  context: SessionToolContext,
): { listed: false } | { listed: true; unavailableReason: string | null } {
  switch (id) {
    case "files":
      return { listed: true, unavailableReason: context.filesSupported ? null : context.filesHint };
    case "terminal":
      return { listed: true, unavailableReason: context.terminalSupported ? null : context.terminalHint };
    case "background":
      return { listed: true, unavailableReason: context.backgroundAvailable ? null : BACKGROUND_WORK_UNAVAILABLE };
    case "campaign":
      if (context.campaignAvailability.kind === "hidden") return { listed: false };
      return {
        listed: true,
        unavailableReason: context.campaignAvailability.kind === "unavailable" ? context.campaignAvailability.reason : null,
      };
    default:
      return { listed: true, unavailableReason: null };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Facts: each row's second line in the Session Tools list (#2844, #1261), in sentence case. Each is
 * a pure function of data the panel already holds, so the list follows it while open.
 * ---------------------------------------------------------------------------------------------- */

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const TERMINAL_FACT = "Opens in the dock below the conversation";
export const SIDE_CHAT_FACT = "Ask a question without interrupting the agent";

/**
 * Review: the uncommitted change count from the session's one git status reader, as Review's own
 * summary counts it (a capped list reads "50+", and staging reads "1 of 9 changes staged"), and the
 * required findings still open, the number Review's findings section shows in its "N Required" badge.
 */
export function reviewFact(
  changes: { files: number; truncated: boolean; staged: number } | "checking" | "unknown",
  requiredFindings: number,
): string {
  let first: string;
  if (changes === "checking") first = "Checking for changes…";
  else if (changes === "unknown") first = "See what this session changed";
  else if (changes.files === 0) first = "No changes yet";
  else {
    const total = `${changes.files}${changes.truncated ? "+" : ""}`;
    const noun = changes.files === 1 && !changes.truncated ? "change" : "changes";
    first = changes.staged > 0 ? `${changes.staged} of ${total} ${noun} staged` : `${total} uncommitted ${noun}`;
  }
  return requiredFindings > 0 ? `${first}, ${count(requiredFindings, "required finding", "required findings")}` : first;
}

export function filesFact(folderName: string): string {
  return `Browse ${folderName}`;
}

/** Browser: the artifacts the session attached; a first page that has more reads "50+". */
export function browserFact(artifacts: { count: number; more: boolean } | null): string {
  if (!artifacts || artifacts.count === 0) return "Preview a web page";
  const shown = artifacts.more ? `${artifacts.count}+ artifacts` : count(artifacts.count, "artifact", "artifacts");
  return `${shown}, or preview a web page`;
}

export function agentsFact(subagents: number): string {
  return subagents === 0 ? "No subagents in this session" : `${count(subagents, "subagent", "subagents")} in this session`;
}

export function backgroundFact(jobs: readonly { terminalStatus?: string }[]): string {
  if (jobs.length === 0) return "Nothing has run in the background";
  const running = jobs.filter((job) => job.terminalStatus === undefined).length;
  return `${running} of ${count(jobs.length, "job", "jobs")} running`;
}

/** Campaign Status: delivered of committed work, when this browser holds the campaign's summary. */
export function campaignFact(work: { counts: { delivered: number; committed: number } } | null | undefined): string {
  return work ? `${work.counts.delivered} of ${work.counts.committed} delivered` : "Progress of this session's campaign";
}

/** What kind of request it is, as a phrase inside a sentence ("a question", "a PR merge"). */
export function requestKindPhrase(request: Pick<PendingApproval, "kind" | "workflowDecision">): string {
  if (request.kind === "question") return "a question";
  if (request.kind === "authentication") return "a sign-in";
  if (request.kind === "workflow_decision") {
    switch (request.workflowDecision?.category) {
      case "ui_evidence_approval": return "a UI evidence review";
      case "pr_merge": return "a PR merge";
      case "merged_branch_deletion": return "a branch deletion";
      case "issue_closure": return "an issue closure";
      case "campaign_issue_scope": return "a campaign scope change";
      case "follow_up_issue_publication": return "an issue publication";
      case "implementation_question": return "an implementation decision";
      default: return "a workflow decision";
    }
  }
  return "an approval";
}

export const NO_REQUESTS_FACT = "No requests are waiting for you";

/**
 * Requests: what waits for you among the child sessions' requests, the panel's "Waiting for You"
 * group, which is also the row's count badge. "A PR merge from Fix login, and a question from
 * Docs"; three or more name the first and count the rest.
 */
export function requestsFact(
  requests: readonly Pick<DescendantRequestView, "responseOwner" | "sessionTitle" | "request">[],
  status: "idle" | "loading" | "ready" | "unavailable",
): string {
  const waiting = requests.filter((request) => request.responseOwner === "human");
  if (waiting.length === 0) {
    if (status === "unavailable") return "Requests from child sessions can't be checked right now";
    if (status === "loading" && requests.length === 0) return "Checking for requests…";
    const handling = requests.length;
    return handling > 0
      ? `${NO_REQUESTS_FACT}; the Orchestrator is handling ${handling}`
      : NO_REQUESTS_FACT;
  }
  const phrase = (request: (typeof waiting)[number]) => {
    const title = request.sessionTitle.trim();
    return title ? `${requestKindPhrase(request.request)} from ${title}` : requestKindPhrase(request.request);
  };
  if (waiting.length === 1) return sentence(phrase(waiting[0]!));
  if (waiting.length === 2) return sentence(`${phrase(waiting[0]!)}, and ${phrase(waiting[1]!)}`);
  return sentence(`${phrase(waiting[0]!)}, and ${waiting.length - 1} more`);
}

export function decisionsFact(decisions: number, more: boolean, status: "loading" | "error" | "ready"): string {
  if (decisions === 0) {
    if (status === "loading") return "Loading decisions…";
    if (status === "error") return "Decisions can't be loaded right now";
    return more ? "Older decisions are recorded" : "No decisions recorded yet";
  }
  return more ? `${decisions}+ decisions recorded` : `${count(decisions, "decision", "decisions")} recorded`;
}
