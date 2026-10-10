import type { CampaignStatusAvailability } from "./campaign-status.js";
import type { RightPanelMode } from "./right-panel.js";
import type { ShortcutId } from "./shortcuts.js";

/**
 * The side panel's tools, in the one order the tool switcher (#2843) and the Session Tools list
 * (#2844) both render: Session Tools first, then the Code, Work and Decisions groups. Each tool is
 * a panel mode except Terminal, which opens the bottom dock until it becomes a panel tool (#2868).
 */
export type SessionToolId = RightPanelMode | "terminal";

/** A group's heading, Title Case as written (§9.1). Session Tools itself is in no group. */
export type SessionToolGroup = "Code" | "Work" | "Decisions";

export interface SessionTool {
  id: SessionToolId;
  /** The tool's one name: the switcher's title and item, and the panel's heading. */
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
  { id: "sidechat", name: "Side Chat", group: "Work" },
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
