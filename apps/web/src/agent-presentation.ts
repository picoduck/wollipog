import {
  builtInAgentHarnessName,
  isRetiredCodexExec,
  type AgentContext,
  type AgentDefinition,
  type AgentDriverKind,
  type AgentHarnessIdentity,
  type ModelResolutionDrift,
  type OrchestratorHarnessCapability,
} from "@wollipog/protocol";
import { RUNNER_REASON_PATTERNS } from "./components/agent-options.js";

/** "A", "A and B", or "A, B and C". */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function driverKindLabel(driver: AgentDriverKind, registry = false): string {
  if (driver === "codex-app-server") return "Codex App Server";
  if (driver === "codex") return "Codex Non-Interactive";
  if (driver === "claude-code") return "Claude Code Native";
  if (driver === "pi") return "Pi RPC";
  return registry ? "ACP Registry Adapter" : "ACP Adapter";
}

export function agentHarnessDriverLabel(driver: AgentDriverKind): string {
  if (driver === "codex-app-server") return "Codex App Server";
  if (driver === "claude-code") return "Claude Code";
  if (driver === "acp") return "ACP";
  if (driver === "pi") return "Pi";
  return "Codex";
}

export function agentHarnessContextLabel(identity: Pick<AgentHarnessIdentity, "context">): string {
  return identity.context.kind === "wsl" ? `WSL ${identity.context.distro}` : "Native";
}

/** Built-in harnesses are the same harness on every Machine, so they are named by driver alone;
 * only an ACP row's own name says which agent it wraps (#3247). */
export function agentHarnessOptionLabel(
  harness: Pick<OrchestratorHarnessCapability, "name" | "driver" | "context">,
): string {
  return harness.driver === "acp"
    ? `${harness.name} · ${agentHarnessDriverLabel(harness.driver)} · ${agentHarnessContextLabel(harness)}`
    : `${builtInAgentHarnessName(harness.driver)} · ${agentHarnessContextLabel(harness)}`;
}

export function agentHarnessIdentityLabel(identity: AgentHarnessIdentity): string {
  return agentHarnessOptionLabel({ ...identity, name: identity.agentId });
}

/** How many connected Machines provide a Child Harness option. */
export function agentHarnessMachinesDescription(
  harness: Pick<OrchestratorHarnessCapability, "installations" | "machines">,
): string {
  const machines = harness.machines ?? harness.installations;
  return `Available on ${machines} connected machine${machines === 1 ? "" : "s"}.`;
}

/** "“opus” is Opus 5.5 on Laptop and Opus 5 on Desktop." — Machines grouped by what the id resolves to. */
export function modelDriftText(drift: ModelResolutionDrift): string {
  const byResolution = new Map<string, string[]>();
  for (const { machineName, displayName } of drift.machines) {
    byResolution.set(displayName, [...(byResolution.get(displayName) ?? []), machineName]);
  }
  const clauses = [...byResolution].map(([displayName, machines]) => `${displayName} on ${listText(machines)}`);
  return `“${drift.modelId}” is ${listText(clauses)}.`;
}

/** One pinned choice per resolution, so two ids for the same model never show as two equal buttons. */
export function pinnedModelChoices(drift: ModelResolutionDrift): ModelResolutionDrift["pinned"] {
  const seen = new Set<string>();
  return drift.pinned.filter((choice) => !seen.has(choice.displayName) && Boolean(seen.add(choice.displayName)));
}

/** Normalize only names emitted by earlier Wollipog onboarding, preserving custom agent names. */
export function isGeneratedCodexAppServerName(name: string): boolean {
  return /^Codex(?: —)? Interactive$/u.test(name);
}

function baseAgentName(agent: AgentDefinition): string {
  if (agent.source === "discovered" && agent.driver === "codex") return "Codex (Non-Interactive)";
  if (agent.driver === "codex-app-server" &&
      (agent.source === "discovered" || isGeneratedCodexAppServerName(agent.name))) return "Codex App Server";
  return agent.name;
}

/** What tells an agent from another of the same name, in the order a name tries them: the version,
 * then where it runs, then its executable, then its id, which is unique. The last two identify
 * rather than describe. */
const NAME_QUALIFIERS: ReadonlyArray<{ identifies: boolean; of: (agent: AgentDefinition) => string | null }> = [
  { identifies: false, of: (agent) => agent.version ? `v${agent.version}` : null },
  { identifies: false, of: (agent) => agentContextLabel(agent.context) },
  { identifies: true, of: (agent) => agent.installation?.path ?? null },
  { identifies: true, of: (agent) => agent.id },
];

/**
 * An agent's name. Given the machine's agents, a name two of them share gets the first qualifier
 * no namesake has: "Codex App Server (v0.155.1)" beside "Codex App Server (v0.140.0)", or
 * "Claude Code (WSL: Ubuntu)" when the versions match (#2990). With `identifiers: false` a name
 * is qualified only by its version or where it runs, never by its path or id, and otherwise stays
 * plain: for surfaces that never show an id, such as an Automations list row (#2969).
 */
export function agentDisplayName(
  agent: AgentDefinition,
  machineAgents?: readonly AgentDefinition[],
  options: { identifiers?: boolean } = {},
): string {
  const name = baseAgentName(agent);
  const namesakes = machineAgents?.filter((other) => other.id !== agent.id && baseAgentName(other) === name) ?? [];
  if (namesakes.length === 0) return name;
  for (const qualifier of NAME_QUALIFIERS) {
    if (qualifier.identifies && options.identifiers === false) break;
    const own = qualifier.of(agent);
    if (own && namesakes.every((other) => qualifier.of(other) !== own)) return `${name} (${own})`;
  }
  return options.identifiers === false ? name : `${name} (${agent.id})`;
}

/** Where an agent runs: "Native", or its WSL distribution ("WSL: Ubuntu"). */
export function agentContextLabel(context: AgentContext | undefined): string {
  return context?.kind === "wsl" ? `WSL: ${context.distro}` : "Native";
}


/** Friendly driver name for status surfaces. Raw protocol ids remain useful in logs and CSS only. */
export function agentDriverLabel(agent: AgentDefinition): string {
  return driverKindLabel(agent.driver ?? "acp", Boolean(agent.registry));
}

/** Where an installation stands against its releases; on a machine that is not online, as it last
 * reported. */
export function harnessUpdateLabel(update: NonNullable<AgentDefinition["update"]>, online: boolean): string {
  const label = update.evidenceSource === "Machine pinned-version policy" ? "Pinned by Machine Policy"
    : update.evidenceSource === "Machine update-check policy" ? "Checks Disabled by Machine Policy"
    : ({
    update_available: "New Release Published",
    up_to_date: "Up to Date",
    check_failed: "Check Failed",
    version_unknown: "Version Unknown",
    preview_channel: "Preview Channel",
    managed_externally: "Managed Externally",
  } as const)[update.status];
  return online ? label : `Last Reported: ${label}`;
}

/**
 * An agent's one status on its machine (docs/design-system.md §11.2), a `statusMeta("agent", …)`
 * key. The agent rows, Agent Details, the Machines list and the All Machines overview all read it.
 */
export type AgentStatus =
  | "ready"
  | "not_installed"
  | "sign_in_required"
  | "update_required"
  | "approval_required"
  | "unavailable"
  | "ready_when_last_seen";

/** Diagnoses of the check rather than the installation: checking again fixes them, not an update. */
const CHECK_FAILURES: ReadonlySet<string> = new Set(["probe_timeout", "probe_failed"]);

function checkFailed(failure: { code: string; retryable?: boolean } | undefined): boolean {
  return failure?.retryable === true || CHECK_FAILURES.has(failure?.code ?? "");
}

/** The installed CLI is too old, or too new to verify, for the integration Wollipog drives it by. */
function agentNeedsUpdate(agent: AgentDefinition): boolean {
  const codex = agent.codexAppServer;
  if (codex?.status === "unsupported" && !checkFailed(codex.failure)) return true;
  const claude = agent.claudeCode;
  // Claude Code without Git for Windows Bash is unsupported too, but no update fixes that.
  if (claude?.status === "unsupported" && !checkFailed(claude.failure) &&
      !RUNNER_REASON_PATTERNS.gitBash.test(claude.failure?.message ?? "")) return true;
  return RUNNER_REASON_PATTERNS.updatePi.test(agent.unavailableReason ?? "");
}

function reportedAgentStatus(agent: AgentDefinition): Exclude<AgentStatus, "ready_when_last_seen"> {
  // The retired Codex exec driver (#3259) never runs, whatever an older runner reports for it.
  if (isRetiredCodexExec(agent)) return "unavailable";
  if (agent.claudeCode?.status === "unavailable" || agent.codexAppServer?.status === "unavailable" ||
      RUNNER_REASON_PATTERNS.notInstalled.test(agent.unavailableReason ?? "") ||
      (agent.registry?.installStatus === "manual-only" && agent.available !== true)) return "not_installed";
  if (agentNeedsUpdate(agent)) return "update_required";
  if (agent.registry?.installStatus === "approval-required") return "approval_required";
  if (agent.authStatus === "unauthenticated" || agent.claudeCode?.status === "unauthenticated") return "sign_in_required";
  if (agent.available !== true || agent.registry?.installStatus === "unsupported-platform" ||
      (agent.claudeCode && agent.claudeCode.status !== "ready") ||
      (agent.codexAppServer && agent.codexAppServer.status !== "supported")) return "unavailable";
  return "ready";
}

/**
 * The one status an agent shows, the most limiting first: Not Installed, Update Required, Approval
 * Required, Sign-In Required, Unavailable, then Ready. A ready agent on a machine that is not online
 * reads Ready When Last Seen: it was ready, but nothing current says it still is.
 */
export function agentStatus(agent: AgentDefinition, online = true): AgentStatus {
  const status = reportedAgentStatus(agent);
  return status === "ready" && !online ? "ready_when_last_seen" : status;
}
