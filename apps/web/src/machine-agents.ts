/**
 * The machine's Agents section and Agent Details (#2990, docs/design-system.md §6): pure helpers
 * that turn one agent's runner report into its row group, its status notice and its facts.
 */

import { CODEX_EXEC_RETIRED_CONFIG_REASON, isRetiredCodexExec, type AgentDefinition, type OS } from "@wollipog/protocol";
import { agentStatus, type AgentStatus } from "./agent-presentation.js";
import { titleCaseLabel } from "./format.js";
import { agentInstallHints, codexUpgradeGuidance } from "./runners.js";
import { statusMeta, type StatusTone } from "./status-meta.js";

const PI_INSTALL = "npm install -g @earendil-works/pi-coding-agent@latest";

export interface MachineAgentRow {
  agent: AgentDefinition;
  status: AgentStatus;
}

/** The section's rows: the agents on the machine, then those that are not, which fold away. */
export interface MachineAgentGroups {
  listed: MachineAgentRow[];
  notInstalled: MachineAgentRow[];
  /** At least one agent is Ready, or was when the machine was last seen. */
  anyReady: boolean;
}

export function machineAgentGroups(agents: readonly AgentDefinition[], online: boolean): MachineAgentGroups {
  const rows = agents.map((agent) => ({ agent, status: agentStatus(agent, online) }));
  return {
    listed: rows.filter((row) => row.status !== "not_installed"),
    notInstalled: rows.filter((row) => row.status === "not_installed"),
    anyReady: rows.some((row) => row.status === "ready" || row.status === "ready_when_last_seen"),
  };
}

/** "3 Agents Not Installed": the disclosure the not-installed agents fold into. */
export function notInstalledLabel(count: number): string {
  return `${count} ${count === 1 ? "Agent" : "Agents"} Not Installed`;
}

/** The install command for a missing agent, when one command installs it on this machine. */
function installCommand(agent: AgentDefinition, os: OS): string | undefined {
  if (agent.registry?.installStatus === "manual-only") return agent.registry.installPreview;
  if (agent.driver === "pi") return PI_INSTALL;
  if (agent.driver !== "claude-code") return undefined;
  const hostOs = agent.context?.kind === "wsl" ? "linux" : os;
  return agentInstallHints(hostOs).find((hint) => hint.name === "Claude Code")?.command;
}

function signInCommand(agent: AgentDefinition): string | undefined {
  if (agent.driver === "claude-code") return "claude auth login";
  if (agent.driver === "codex-app-server") return "codex login";
  if (agent.driver === "pi") return "pi";
  return undefined;
}

/** A failure the check reported rather than the installation: checking again may clear it. */
function checkFailure(agent: AgentDefinition): boolean {
  const failure = agent.codexAppServer?.failure ?? agent.claudeCode?.failure;
  return failure?.retryable === true || failure?.code === "probe_timeout" || failure?.code === "probe_failed";
}

/** Agent Details' status notice: what is wrong, in one sentence, and how to fix it. */
export interface AgentNotice {
  status: AgentStatus;
  tone: Extract<StatusTone, "neutral" | "warning" | "danger">;
  title: string;
  /** What is wrong, then the fix. */
  text: string;
  /** The remediation command, for a code well with copy. */
  command?: string;
  /** The fix is a control: Approve Launch…, or Choose Another Installation… in Machine Settings. */
  action?: "approve_launch" | "choose_installation";
}

/**
 * The notice Agent Details leads with, or null for a Ready agent. `verified` is whether the runner
 * checks its agents before listing them; one that does not cannot say why an agent is unavailable.
 */
export function agentNotice(
  agent: AgentDefinition,
  { os, online, name, verified }: { os: OS; online: boolean; name: string; verified: boolean },
): AgentNotice | null {
  const status = agentStatus(agent, online);
  if (status === "ready") return null;
  const meta = statusMeta("agent", status);
  const notice = (text: string, extra: Pick<AgentNotice, "command" | "action"> = {}): AgentNotice => ({
    status,
    tone: meta.tone === "danger" || meta.tone === "warning" ? meta.tone : "neutral",
    title: meta.label,
    text,
    ...extra,
  });
  const failure = agent.claudeCode?.failure?.message ?? agent.codexAppServer?.failure?.message ?? agent.unavailableReason;
  const selected = agent.installation?.selection === "selected";
  switch (status) {
    case "ready_when_last_seen":
      return notice(`${name} was ready when this machine was last seen. Its status updates when the machine is back online.`);
    case "not_installed": {
      if (agent.registry?.installStatus === "manual-only") {
        return notice("The ACP Registry gives no exact package pin or binary digest for it, so Wollipog won't install it. Install it yourself, then rediscover.",
          { command: agent.registry.installPreview });
      }
      const command = installCommand(agent, os);
      const what = failure ?? `${name} isn't installed on this machine.`;
      const fix = command ? "Install it, then rediscover."
        : agent.driver === "codex-app-server" ? codexUpgradeGuidance(agent, os)
          : "Install it on this machine, or correct its launch command, then rediscover.";
      return notice(`${what} ${fix}`, {
        ...(command ? { command } : {}),
        ...(selected ? { action: "choose_installation" as const } : {}),
      });
    }
    case "sign_in_required": {
      const command = signInCommand(agent);
      const what = agent.claudeCode?.failure?.code === "unauthenticated" ? agent.claudeCode.failure.message
        : agent.driver === "pi" && agent.unavailableReason ? agent.unavailableReason
          : `${name} isn't signed in on this machine.`;
      const fix = command ? "Sign in on the machine, then rediscover." : "Complete its sign-in on the machine, then rediscover.";
      return notice(`${what} ${fix}`, command ? { command } : {});
    }
    case "update_required": {
      const what = failure ?? `${name} is too old for Wollipog.`;
      if (agent.driver === "codex-app-server") return notice(`${what} ${codexUpgradeGuidance(agent, os)}`);
      if (agent.driver === "claude-code") return notice(`${what} Update it, then rediscover.`, { command: "claude update" });
      if (agent.driver === "pi") return notice(`${what} Update it, then rediscover.`, { command: PI_INSTALL });
      return notice(`${what} Update it on this machine, then rediscover.`);
    }
    case "approval_required":
      return notice(`${name} from the ACP Registry can't launch until you approve its exact command.`, { action: "approve_launch" });
    case "unavailable": {
      const choose = selected ? { action: "choose_installation" as const } : {};
      if (isRetiredCodexExec(agent)) return notice(CODEX_EXEC_RETIRED_CONFIG_REASON);
      if (!verified && agent.available !== true) {
        return notice("This machine's runner can't check whether the agent is available. Update the runner, then rediscover.");
      }
      if (agent.registry?.installStatus === "unsupported-platform") {
        return notice("The ACP Registry has no version of this agent for this machine's platform.");
      }
      if (agent.registry?.installStatus === "approved" && agent.available !== true) {
        return notice("Its launch is approved, but the package runner it needs isn't available. Install it, then rediscover.",
          { command: agent.registry.installPreview });
      }
      if (failure && checkFailure(agent)) return notice(`${failure} Rediscover to check it again.`, choose);
      return notice(failure ?? `${name} couldn't start on this machine. Check its launch command in the runner configuration.`, choose);
    }
  }
}

/** The Sign-In fact: whether the agent is signed in, and for Claude Code or Codex, how it bills. */
export function agentSignInFact(agent: AgentDefinition): string {
  if (agent.authStatus === "unauthenticated" || agent.claudeCode?.status === "unauthenticated") return "Not Signed In";
  if (agent.authStatus !== "authenticated" && agent.claudeCode?.auth.status !== "authenticated") return "Unknown";
  const billing = agent.claudeCode?.auth.billingSource ?? agent.codexBillingSource;
  if (!billing || billing === "unknown") return "Signed In";
  return `Signed In (${billing === "api" ? "API Billing" : titleCaseLabel(billing.replace(/_/g, " "))})`;
}

/** A Registry agent's description and the ACP capabilities its live handshake reported. */
export function acpCapabilitySummary(agent: AgentDefinition): string {
  if (!agent.acp) return "Capabilities pending live ACP handshake";
  const names: Array<[keyof NonNullable<AgentDefinition["acp"]>, string]> = [
    ["loadSession", "load"],
    ["sessionList", "list"],
    ["sessionResume", "resume"],
    ["sessionClose", "close"],
    ["sessionDelete", "delete"],
    ["logout", "logout"],
  ];
  const enabled = names.filter(([key]) => agent.acp?.[key]).map(([, label]) => label);
  return enabled.length ? `Live capabilities: ${enabled.join(", ")}` : "Live ACP handshake reported no optional stable capabilities";
}
