import type { SessionLaunchSpec } from "@wollipog/protocol";

/** First line of the role instructions. Also the marker that finds them in persisted arguments,
 * so a relaunch replaces them instead of appending a second copy. */
export const ASSISTANT_INSTRUCTIONS_PREFIX = "You are the Wollipog Assistant";

/** Concise role instructions for an `assistant`-role session (#4663). The shared `wollipog`
 * assistant skill carries the detail. */
export const ASSISTANT_INSTRUCTIONS = [
  `${ASSISTANT_INSTRUCTIONS_PREFIX}, working in one of your owner's threads inside Wollipog.`,
  "You act on your owner's Wollipog installation only through the Assistant tools of the `wollipog_assistant` MCP server. " +
    "Call assistant_discover first to learn the installation, your connection's grant and the operations it allows.",
  "Before a mutation, choose a new command ID and keep it. If a call's outcome is unknown, read its receipt with the same ID " +
    "instead of sending the command again.",
  "Report what you did and what each call returned, including refusals, plainly and briefly.",
  "Never confirm, approve or answer anything on your owner's behalf. A destructive action, an approval or a question for the " +
    "owner waits for the owner, in Wollipog; tell them it is waiting and stop.",
  "Credentials, governance, budgets and persistent permission grants stay with your owner. Never ask for a credential or " +
    "try to read one.",
].join("\n\n");

/** Harness drivers that can carry the assistant launch. */
export function assistantLaunchSupported(driver: SessionLaunchSpec["driver"]): boolean {
  return driver === "claude-code" || driver === "codex" || driver === "codex-app-server";
}

function toml(value: string): string { return JSON.stringify(value); }

/** Removes the role instructions an earlier launch of this session added. A user's own
 * instructions are left where they were. */
export function stripAssistantLaunchArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (typeof value === "string" && ((args[i] === "--append-system-prompt" && value.startsWith(ASSISTANT_INSTRUCTIONS_PREFIX)) ||
        (args[i] === "-c" && value.startsWith(`developer_instructions=${toml(ASSISTANT_INSTRUCTIONS_PREFIX).slice(0, -1)}`)))) {
      i++;
      continue;
    }
    kept.push(args[i]!);
  }
  return kept;
}

/** The launch arguments of an `assistant`-role session: its baseline plus the role instructions.
 * It receives no general Wollipog agent-control server, CLI or credential; its Wollipog tools
 * come only from its thread's Assistant connection. Refuses a harness that cannot carry it, so it
 * never launches as an ordinary session instead. */
export function assistantLaunchArgs(driver: SessionLaunchSpec["driver"], args: readonly string[]): string[] {
  if (!assistantLaunchSupported(driver)) {
    throw new Error("Wollipog Assistant threads run only on Claude Code or Codex. Start the thread with one of them.");
  }
  const baseline = stripAssistantLaunchArgs(args);
  if (driver === "claude-code") return [...baseline, "--append-system-prompt", ASSISTANT_INSTRUCTIONS];
  // Codex has no append form: the last `developer_instructions` wins, as for an Orchestrator.
  return [...baseline, "-c", `developer_instructions=${toml(ASSISTANT_INSTRUCTIONS)}`];
}
