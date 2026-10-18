import { isRetiredCodexExec, type AgentDefinition } from "@wollipog/protocol";
import { agentProvider } from "./AgentIcon.js";
import type { SavedAgentChoice } from "../agent-defaults.js";

/**
 * The runner advertises a union of config-authored and machine-discovered agents, with two naming
 * conventions and raw driver strings that leaked into the New Session UI as chips. This module
 * derives one clean label per agent so the dropdown reads consistently regardless of an entry's
 * origin: family ("Claude Code" / "Codex" / the ACP agent's own name) + driver/context variant.
 * The variant is appended only when a family has more than one.
 */
const FAMILY_ORDER = ["Claude Code", "Codex"];

export function agentFamily(a: AgentDefinition): string {
  if (a.driver === "claude-code") return "Claude Code";
  if (a.driver === "codex" || a.driver === "codex-app-server") return "Codex";
  if (a.driver === "pi") return "Pi";
  return a.name; // Generic ACP agents (Gemini, OpenClaw, …) identify by their own name.
}

/** Distinguishes entries within a family. Empty for single-variant ACP agents. */
export function agentVariant(a: AgentDefinition): string {
  const wsl = a.context?.kind === "wsl" ? ` · WSL: ${a.context.distro}` : "";
  if (a.driver === "codex-app-server") return `App Server${wsl}`;
  if (a.driver === "pi") return `RPC${wsl}`;
  if (a.context?.kind === "wsl") return `WSL: ${a.context.distro}`;
  if (a.driver === "claude-code") return "Native";
  return "";
}

export { agentDriverLabel } from "../agent-presentation.js";

function variantRank(v: string): number {
  if (v.startsWith("App Server")) return 0;
  if (v === "Native") return 1;
  if (v.startsWith("WSL")) return 2;
  return 3;
}

function familyRank(f: string): number {
  const i = FAMILY_ORDER.indexOf(f);
  return i === -1 ? 5 : i;
}

export interface AgentOption {
  agent: AgentDefinition;
  label: string;
  /** `label` without the installation folder, for a list that shows the folder on its own line. */
  name: string;
  /** The installation's folder, when the same agent is offered from more than one; `label` ends
   * with it. */
  installationPath?: string;
  /** Discovery probed this launch path and it is not usable (missing binary / failed probe).
   * Shown greyed-out with a "needs setup" hint rather than hidden — the user should learn the
   * agent could exist here — but it must never be auto-selected or launched. */
  disabled?: boolean;
}

/** Group → dedup → order → label the runner's agents into flat, cleanly-named dropdown options. */
export function agentOptions(
  agents: AgentDefinition[],
  options: { includeProviderAdapters?: boolean } = {},
): AgentOption[] {
  // Hide the generic ACP path for a provider once a USABLE native harness for it exists — it's a
  // weaker duplicate (no model picker / slash commands). ACP stays for providers with no native
  // driver, and an unavailable or unverified native entry must not hide a working ACP fallback.
  // Nor may the retired Codex exec driver, which is never offered itself (#3259).
  const nativeProviders = new Set(
    agents
      .filter((a) => a.driver && a.driver !== "acp" && a.available === true && !isRetiredCodexExec(a))
      .map((a) => agentProvider(a.driver!, a.name)),
  );
  const visible = agents.filter((a) => {
    if (isRetiredCodexExec(a)) return false;
    if (options.includeProviderAdapters) return true;
    const driver = a.driver ?? "acp";
    if (driver !== "acp") return true;
    const p = agentProvider(driver, a.name);
    return !(p !== "other" && nativeProviders.has(p));
  });

  const families = new Map<string, AgentDefinition[]>();
  for (const a of visible) {
    const f = agentFamily(a);
    const list = families.get(f) ?? [];
    list.push(a);
    families.set(f, list);
  }

  const out: AgentOption[] = [];
  for (const f of [...families.keys()].sort((x, y) => familyRank(x) - familyRank(y) || x.localeCompare(y))) {
    // Collapse entries that resolve to the same variant (e.g. a config Codex and a discovered one),
    // preferring an available agent.
    const byVariant = new Map<string, AgentDefinition>();
    for (const a of families.get(f)!) {
      const v = agentVariant(a);
      const key = `${v}\0${a.installation?.id ?? "legacy"}`;
      const cur = byVariant.get(key);
      if (!cur || (a.available && !cur.available)) byVariant.set(key, a);
    }
    const variants = [...byVariant.values()].sort(
      (a, b) => variantRank(agentVariant(a)) - variantRank(agentVariant(b)) ||
        agentVariant(a).localeCompare(agentVariant(b)) || a.name.localeCompare(b.name),
    );
    const multi = variants.length > 1;
    for (const a of variants) {
      const v = agentVariant(a);
      const repeated = variants.filter((candidate) => agentVariant(candidate) === v).length > 1;
      const installationPath = repeated ? a.installation?.path : undefined;
      const name = a.driver === "codex-app-server" || a.driver === "pi"
        ? `${f} ${v}`
        : !v || !multi ? f : `${f} — ${v}`;
      out.push({
        agent: a,
        label: installationPath ? `${name} · ${installationPath}` : name,
        name,
        ...(installationPath ? { installationPath } : {}),
        ...(a.available !== true || a.installation?.selection === "other" || a.harnessSelectionBlocked
          ? { disabled: true } : {}),
      });
    }
  }
  return out;
}

/** The option a fresh dialog should select: the first USABLE one (never a needs-setup entry). */
export function firstEnabledAgentId(options: AgentOption[]): string {
  return options.find((option) => !option.disabled)?.agent.id ?? "";
}

export type SavedAgentDefaultIssue = "legacy" | "unavailable" | "missing" | "unbound";

function sameContext(a: AgentDefinition, b: AgentDefinition): boolean {
  const aKind = a.context?.kind ?? "native";
  const bKind = b.context?.kind ?? "native";
  if (aKind !== bKind) return false;
  if (aKind !== "wsl") return true;
  return a.context?.kind === "wsl" && b.context?.kind === "wsl" && a.context.distro === b.context.distro;
}

/** Resolve a saved per-runner default without silently rewriting it. Legacy/unavailable choices
 * remain visible so the dialog can explain them and offer an explicit one-click migration.
 * `agents` is the runner's full list, needed to recognize a saved choice of the retired Codex exec
 * driver, which `options` never contains. */
export function savedAgentSelection(
  options: AgentOption[],
  choice: string | SavedAgentChoice | undefined,
  agents: readonly AgentDefinition[] = [],
): { agentId: string; issue?: SavedAgentDefaultIssue; recommendedId: string } {
  const recommendedId = firstEnabledAgentId(options);
  if (!choice) return { agentId: recommendedId, recommendedId };
  const retired = agents.find((agent) => isRetiredCodexExec(agent) && (typeof choice === "string"
    ? agent.id === choice
    : agent.installation?.id === choice.installationId && agent.driver === choice.driver &&
      sameContext(agent, { context: choice.context } as AgentDefinition)));
  if (retired) {
    // Nothing is preselected: the saved agent can no longer start, and the user chooses its
    // replacement.
    const appServers = options.filter((option) =>
      option.agent.driver === "codex-app-server" && !option.disabled && sameContext(option.agent, retired));
    const sibling = appServers.find((option) => option.agent.installation?.id === retired.installation?.id) ??
      appServers[0];
    return { agentId: "", issue: "legacy", recommendedId: sibling?.agent.id ?? recommendedId };
  }
  if (typeof choice !== "string") {
    const matching = options.find(({ agent }) =>
      agent.installation?.id === choice.installationId && agent.driver === choice.driver &&
      sameContext(agent, { context: choice.context } as AgentDefinition));
    // A stable choice must never fall back to a reused plain agent id.
    return matching
      ? { agentId: matching.agent.id, ...(matching.disabled ? { issue: "unavailable" as const } : {}), recommendedId }
      : { agentId: "", issue: "missing", recommendedId };
  }
  const savedId = choice;
  const saved = options.find((option) => option.agent.id === savedId);
  if (!saved) return { agentId: "", issue: "missing", recommendedId };
  if (saved.agent.installation) return {
    agentId: "", issue: "unbound", recommendedId: saved.disabled ? recommendedId : savedId,
  };
  if (saved.disabled) return { agentId: savedId, issue: "unavailable", recommendedId };
  return { agentId: savedId, recommendedId };
}

export function currentAgentSelectionIssue(
  options: AgentOption[],
  selectedId: string,
  choice: string | SavedAgentChoice | undefined,
  agents: readonly AgentDefinition[] = [],
): SavedAgentDefaultIssue | undefined {
  if (options.find((option) => option.agent.id === selectedId)?.disabled) return "unavailable";
  return savedAgentSelection(options, choice, agents).issue;
}

/** Multi-agent runs must never preselect or render a discovery row known to be unavailable. */
export function runnableAgentIds(agents: AgentDefinition[]): string[] {
  return agentOptions(agents)
    .filter((option) => !option.disabled)
    .map((option) => option.agent.id);
}

/** One-line context shown under the dropdown: where it runs, version, and auth state. */
export function agentMeta(a: AgentDefinition): string {
  const where = a.context?.kind === "wsl" ? `WSL · ${a.context.distro}` : "native host";
  const codexFamily = a.driver === "codex-app-server";
  const bits = codexFamily && a.authStatus === "unauthenticated"
    // Signed-out is a setup problem, not an installation problem: name the fix, and don't let
    // the generic "Interactive target unavailable" branch below mislabel it.
    ? [
        "Not signed in",
        // Auth is probed per context: a WSL row reads that distro's ~/.codex/auth.json, so a
        // login on the Windows host would not enable it.
        `run \`codex login\` ${a.context?.kind === "wsl" ? `inside ${a.context.distro}` : "on the runner host"}, then rediscover`,
        `runs on ${where}`,
      ]
    : a.driver === "codex-app-server" && a.available !== true
    ? ["Interactive target unavailable", `runs on ${where}`]
    : a.driver === "codex-app-server"
      ? [
          "Interactive approvals",
          "resumable conversations",
          ...(a.capabilities?.supportsImages === true
            ? ["images"]
            : a.capabilities?.supportsImages === false
              ? ["text-only model"]
              : []),
          `runs on ${where}`,
        ]
      : [`Runs on ${where}`];
  if (a.version) bits.push(/^\d/.test(a.version) ? `v${a.version}` : a.version);
  if (a.installation?.selection === "other") bits.push("select this installation in Machine Settings to use it");
  if (a.harnessSelectionBlocked) bits.push("another installation is selected in Machine Settings");
  if (a.authStatus === "unauthenticated" && !codexFamily) bits.push("not signed in");
  if (!a.registry && a.acpTransport) bits.push(`ACP ${a.acpTransport}`);
  if (a.registry) {
    bits.push(`ACP ${a.registry.transport}`);
    bits.push(`adapter v${a.registry.adapterVersion}`);
    if (a.registry.installStatus === "approval-required") bits.push("install approval required");
    if (a.registry.installStatus === "approved") bits.push("exact package launch approved");
    if (a.registry.installStatus === "manual-only") bits.push("manual install only");
    if (a.registry.installStatus === "unsupported-platform") bits.push("no compatible registry distribution");
  }
  if (a.codexAppServer?.status === "supported" && a.authStatus !== "unauthenticated") {
    bits.push("interactive target ready");
  }
  if (a.codexAppServer?.status === "unsupported") {
    bits.push(`interactive target unavailable: ${a.codexAppServer.failure?.message ?? "interactive mode unavailable"}`);
  }
  if (a.codexAppServer?.status === "unavailable") {
    bits.push(`unavailable: ${a.codexAppServer.failure?.message ?? "Codex is not installed"}`);
  }
  if (a.claudeCode) {
    if (a.claudeCode.status === "ready") bits.push("Claude ready");
    else bits.push(a.claudeCode.failure?.message ?? `Claude ${a.claudeCode.status}`);
    if (a.claudeCode.auth.billingSource !== "unknown") {
      bits.push(a.claudeCode.auth.billingSource === "api" ? "API billing" : `${a.claudeCode.auth.billingSource} auth`);
    }
    if (a.claudeCode.launchSource && a.claudeCode.launchSource !== "path") bits.push("PATH recovered");
  }
  return bits.join(" · ");
}

/** What an agent New Session lists under Needs Setup lacks before it can start (#2953). */
export type AgentSetupProblem =
  | "other_installation"
  | "update_wollipog"
  | "changed"
  | "needs_windows"
  | "not_installed"
  | "sign_in"
  | "update_agent"
  | "version_unreadable"
  | "needs_git_bash"
  | "unchecked"
  | "launch_failed"
  | "approve_install"
  | "manual_install"
  | "unsupported_platform";

/**
 * Discovery outcomes the runner reports only as `unavailableReason` text, matched on the runner's
 * own wording (apps/runner/src/discovery). agent-options.test.ts reads that source and fails if a
 * pattern stops matching it, so a reworded reason cannot quietly fall through to the generic one.
 */
export const RUNNER_REASON_PATTERNS = {
  changed: /^The discovered harness executable changed\./u,
  needsWindows: /incompatible with a non-Windows runner/u,
  notInstalled: /^Pi is not installed\.|^The configured command was not found/u,
  updatePi: /did not satisfy Wollipog's RPC compatibility probe/u,
  /** Claude Code's one unsupported mode that an update does not fix: Git for Windows Bash. */
  gitBash: /requires Git for Windows Bash/u,
} as const;

/**
 * Classify why an unavailable agent cannot start, keeping each distinct runner diagnosis distinct:
 * a fix that does not match the cause (updating Claude for a missing Git Bash, checking again for a
 * Codex that is too old) sends people the wrong way. `availabilityVerified` is whether the machine's
 * Wollipog checks its agents before listing them; one that does not cannot say any agent is ready.
 */
export function agentSetupProblem(a: AgentDefinition, availabilityVerified: boolean): AgentSetupProblem {
  if (a.installation?.selection === "other" || a.harnessSelectionBlocked) return "other_installation";
  if (!availabilityVerified && a.available !== true) return "update_wollipog";
  const reason = a.unavailableReason ?? "";
  if (RUNNER_REASON_PATTERNS.changed.test(reason)) return "changed";
  if (RUNNER_REASON_PATTERNS.needsWindows.test(reason)) return "needs_windows";
  if (a.codexAppServer?.status === "unavailable" || a.codexAppServer?.failure?.code === "codex_unavailable" ||
    a.claudeCode?.status === "unavailable" || a.claudeCode?.failure?.code === "claude_unavailable" ||
    RUNNER_REASON_PATTERNS.notInstalled.test(reason)) {
    return "not_installed";
  }
  if (a.authStatus === "unauthenticated" || a.claudeCode?.status === "unauthenticated") return "sign_in";
  const codexFailure = a.codexAppServer?.failure?.code;
  if (codexFailure === "version_unverified") {
    // A version Codex reported but Wollipog doesn't support yet needs an update; one it couldn't read
    // needs an update too, and then a fresh check.
    return a.codexAppServer?.installedVersion ? "update_agent" : "version_unreadable";
  }
  const claudeFailure = a.claudeCode?.failure;
  if (claudeFailure?.code === "unsupported_mode" && RUNNER_REASON_PATTERNS.gitBash.test(claudeFailure.message)) {
    return "needs_git_bash";
  }
  switch (codexFailure ?? claudeFailure?.code) {
    case "app_server_unavailable":
    case "contract_mismatch":
    case "unsupported_mode":
      return "update_agent";
    case "version_unverified":
    case "probe_timeout":
    case "probe_failed":
      return "unchecked";
  }
  if (RUNNER_REASON_PATTERNS.updatePi.test(reason)) return "update_agent";
  switch (a.registry?.installStatus) {
    case "approval-required": return "approve_install";
    case "manual-only": return "manual_install";
    case "unsupported-platform": return "unsupported_platform";
  }
  // A configured launch that failed its probe, or any reason this list doesn't know yet: the
  // runner's full explanation is on the machine's page.
  return reason ? "launch_failed" : "not_installed";
}

/**
 * Why an agent cannot start on `machine`, as its fix: New Session's Needs Setup second line. The
 * runner's own messages and `agentMeta` describe the mechanism (rediscovery, the runner host,
 * transports), which belongs on the machine's page in Connections.
 */
export function agentSetupReason(a: AgentDefinition, machine: string, availabilityVerified: boolean): string {
  const family = agentFamily(a);
  switch (agentSetupProblem(a, availabilityVerified)) {
    case "other_installation": return "Another installation is selected in Machine Settings.";
    case "update_wollipog": return `Update Wollipog on ${machine} to use it.`;
    case "changed": return `It changed on ${machine} since Wollipog last checked it. Check it again in Connections.`;
    case "needs_windows": return "Its WSL launch runs only on a Windows machine.";
    case "not_installed": return `Not installed on ${machine}.`;
    case "sign_in": return "Sign in before the session can start.";
    case "update_agent": {
      const version = a.codexAppServer?.failure?.code === "version_unverified" ? a.codexAppServer.installedVersion : undefined;
      return version
        ? `${family} ${version} is too old for Wollipog. Update it on ${machine} to use it.`
        : `Update ${family} on ${machine} to use it.`;
    }
    case "version_unreadable":
      return `Wollipog couldn't read its version on ${machine}. Update ${family}, then check it again in Connections.`;
    case "needs_git_bash": return `Install Git for Windows on ${machine} to use it.`;
    case "unchecked": return `Wollipog couldn't check it on ${machine}. Check it again in Connections.`;
    case "launch_failed": return `Wollipog couldn't start it on ${machine}. Check its setup in Connections.`;
    case "approve_install": return "Approve its install in Connections first.";
    case "manual_install": return `Install it on ${machine} yourself to use it.`;
    case "unsupported_platform": return `No version of it runs on ${machine}.`;
  }
}

/** How an agent limits the session it starts, for New Session's second line; empty when it doesn't. */
export function agentSessionLimits(a: AgentDefinition): string[] {
  return [
    ...(a.capabilities?.supportsImages === false ? ["Text-only model"] : []),
    ...(a.capabilities?.supportsApprovals === false ? ["No approval cards"] : []),
  ];
}

/** The agent a saved default names, for a message about it when this machine no longer offers it.
 * Undefined when only an id is left: an id is not a name to show. */
export function savedAgentName(
  choice: string | SavedAgentChoice,
  agents: readonly AgentDefinition[],
): string | undefined {
  const agentId = typeof choice === "string" ? choice : choice.agentId;
  const listed = agents.find((agent) => agent.id === agentId);
  if (listed) return agentFamily(listed);
  if (typeof choice === "string" || !choice.driver || choice.driver === "acp") return undefined;
  return agentFamily({ driver: choice.driver, name: agentId } as AgentDefinition);
}

/** Persisted sessions keep their actual transport visible even after the runner's stable `codex`
 * id migrates from exec to app-server. */
export function sessionAgentLabel(
  agentName: string | null | undefined,
  driver: AgentDefinition["driver"],
  agentId?: string | null,
): string {
  if (driver === "codex-app-server") return "Codex App Server";
  if (driver === "codex") return "Codex — Non-Interactive (codex exec)";
  return agentName ?? agentId ?? driver ?? "Agent";
}
