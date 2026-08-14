import type { AgentDefinition } from "@wollipog/protocol";
import { GENERATED_CONDUCTOR_DISPLAY_NAME, isGeneratedConductorName } from "../agent-presentation.js";
import { agentProvider } from "./AgentIcon.js";

/**
 * The runner advertises a union of config-authored and machine-discovered agents, with two naming
 * conventions and raw driver strings that leaked into the New Session UI as chips. This module
 * derives one clean label per agent so the dropdown reads consistently regardless of an entry's
 * origin: family ("Claude Code" / "Codex" / the ACP agent's own name) + driver/context variant.
 * The variant is appended only when a family has more than one.
 */
const FAMILY_ORDER = ["Claude Code", "Codex"];
const CONDUCTOR_FAMILY = GENERATED_CONDUCTOR_DISPLAY_NAME;

export function agentFamily(a: AgentDefinition): string {
  if (a.id === "conductor" || isGeneratedConductorName(a.name)) return CONDUCTOR_FAMILY;
  if (a.driver === "claude-code") return "Claude Code";
  if (a.driver === "codex" || a.driver === "codex-app-server") return "Codex";
  return a.name; // Generic ACP agents (Gemini, OpenClaw, …) identify by their own name.
}

/** Distinguishes entries within a family. Empty for single-variant ACP agents. */
export function agentVariant(a: AgentDefinition): string {
  const wsl = a.context?.kind === "wsl" ? ` · WSL: ${a.context.distro}` : "";
  if (a.driver === "codex-app-server") return `Interactive (Recommended)${wsl}`;
  if (a.driver === "codex") return `Non-Interactive (codex exec)${wsl}`;
  if (a.context?.kind === "wsl") return `WSL: ${a.context.distro}`;
  if (a.driver === "claude-code") return "Native";
  return "";
}

export { agentDriverLabel } from "../agent-presentation.js";

function variantRank(v: string): number {
  if (v.startsWith("Interactive")) return 0;
  if (v === "Native" || v.startsWith("Non-Interactive")) return 1;
  if (v.startsWith("WSL")) return 2;
  return 3;
}

function familyRank(f: string): number {
  if (f === CONDUCTOR_FAMILY) return 9; // always last — it's a special mode, not a plain agent
  const i = FAMILY_ORDER.indexOf(f);
  return i === -1 ? 5 : i;
}

export interface AgentOption {
  agent: AgentDefinition;
  label: string;
  /** Discovery probed this launch path and it is not usable (missing binary / failed probe).
   * Shown greyed-out with a "needs setup" hint rather than hidden — the user should learn the
   * agent could exist here — but it must never be auto-selected or launched. */
  disabled?: boolean;
  /** Compatibility/batch targets stay available, but do not compete with interactive agents in
   * the ordinary picker or get selected into a new multi-agent run by default. */
  advanced?: boolean;
}

/** Group → dedup → order → label the runner's agents into flat, cleanly-named dropdown options. */
export function agentOptions(
  agents: AgentDefinition[],
  options: { includeProviderAdapters?: boolean } = {},
): AgentOption[] {
  // Hide the generic ACP path for a provider once a USABLE native harness for it exists — it's a
  // weaker duplicate (no model picker / slash commands). ACP stays for providers with no native
  // driver, and an explicitly-unavailable native entry (discovery probed and failed) must not
  // hide a working ACP fallback. `available === undefined` (config-authored) counts as usable.
  const nativeProviders = new Set(
    agents
      .filter((a) => a.driver && a.driver !== "acp" && a.available !== false)
      .map((a) => agentProvider(a.driver!, a.name)),
  );
  const visible = agents.filter((a) => {
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
      const cur = byVariant.get(v);
      if (!cur || (a.available && !cur.available)) byVariant.set(v, a);
    }
    const variants = [...byVariant.entries()].sort(
      (a, b) => variantRank(a[0]) - variantRank(b[0]) || a[0].localeCompare(b[0]),
    );
    const multi = variants.length > 1;
    for (const [v, a] of variants) {
      out.push({
        agent: a,
        label: !v || (!multi && a.driver !== "codex") ? f : `${f} — ${v}`,
        ...(a.available === false ? { disabled: true } : {}),
        ...(a.driver === "codex" ? { advanced: true } : {}),
      });
    }
  }
  return out;
}

/** The option a fresh dialog should select: the first USABLE one (never a needs-setup entry). */
export function firstEnabledAgentId(options: AgentOption[]): string {
  return (options.find((option) => !option.advanced && !option.disabled) ??
    options.find((option) => !option.disabled) ??
    options[0])?.agent.id ?? "";
}

export function primaryAgentOptions(options: AgentOption[]): AgentOption[] {
  return options.filter((option) => !option.advanced);
}

export function advancedAgentOptions(options: AgentOption[]): AgentOption[] {
  return options.filter((option) => option.advanced);
}

export function isAdvancedAgentId(options: AgentOption[], agentId: string): boolean {
  return options.some((option) => option.agent.id === agentId && option.advanced);
}

export type SavedAgentDefaultIssue = "legacy" | "unavailable" | "missing";

function sameContext(a: AgentDefinition, b: AgentDefinition): boolean {
  const aKind = a.context?.kind ?? "native";
  const bKind = b.context?.kind ?? "native";
  if (aKind !== bKind) return false;
  if (aKind !== "wsl") return true;
  return a.context?.kind === "wsl" && b.context?.kind === "wsl" && a.context.distro === b.context.distro;
}

/** Resolve a saved per-runner default without silently rewriting it. Legacy/unavailable choices
 * remain visible so the dialog can explain them and offer an explicit one-click migration. */
export function savedAgentSelection(
  options: AgentOption[],
  savedId: string | undefined,
): { agentId: string; issue?: SavedAgentDefaultIssue; recommendedId: string } {
  const recommendedId = firstEnabledAgentId(options);
  if (!savedId) return { agentId: recommendedId, recommendedId };
  const saved = options.find((option) => option.agent.id === savedId);
  if (!saved) return { agentId: recommendedId, issue: "missing", recommendedId };
  if (saved.disabled) return { agentId: savedId, issue: "unavailable", recommendedId };
  if (saved.advanced) {
    const interactiveSibling = options.find(
      (option) =>
        option.agent.driver === "codex-app-server" &&
        !option.disabled &&
        sameContext(option.agent, saved.agent),
    );
    return interactiveSibling
      ? { agentId: savedId, issue: "legacy", recommendedId: interactiveSibling.agent.id }
      : { agentId: savedId, recommendedId: savedId };
  }
  return { agentId: savedId, recommendedId };
}

export function currentAgentSelectionIssue(
  options: AgentOption[],
  selectedId: string,
  savedId: string | undefined,
): SavedAgentDefaultIssue | undefined {
  if (options.find((option) => option.agent.id === selectedId)?.disabled) return "unavailable";
  return savedAgentSelection(options, savedId).issue;
}

/** Multi-agent runs must never preselect or render a discovery row known to be unavailable. */
export function runnableAgentIds(agents: AgentDefinition[]): string[] {
  return agentOptions(agents)
    .filter((option) => !option.disabled)
    .map((option) => option.agent.id);
}

/** Ordinary multi-agent runs default to interactive/non-legacy targets. Advanced exec remains
 * selectable after disclosure, but is never silently paired with its app-server sibling. */
export function defaultRunAgentIds(agents: AgentDefinition[]): string[] {
  return agentOptions(agents)
    .filter((option) => !option.disabled && !option.advanced)
    .map((option) => option.agent.id);
}

/** One-line context shown under the dropdown: where it runs, version, and auth state. */
export function agentMeta(a: AgentDefinition): string {
  const where = a.context?.kind === "wsl" ? `WSL · ${a.context.distro}` : "native host";
  const codexFamily = a.driver === "codex-app-server" || a.driver === "codex";
  const bits = codexFamily && a.authStatus === "unauthenticated"
    // Signed-out is a setup problem, not an installation problem: name the fix, and don't let
    // the generic "Interactive target unavailable" branch below mislabel it.
    ? ["Not signed in", "run `codex login` on the runner host, then rediscover", `runs on ${where}`]
    : a.driver === "codex-app-server" && a.available === false
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
    : a.driver === "codex"
      ? ["Non-interactive via codex exec", "approval settings are fixed before each turn", `runs on ${where}`]
      : [`Runs on ${where}`];
  if (a.version) bits.push(/^\d/.test(a.version) ? `v${a.version}` : a.version);
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
    bits.push(a.driver === "codex" ? "non-interactive fallback ready" : "interactive target ready");
  }
  if (a.codexAppServer?.status === "unsupported") {
    bits.push(`${a.driver === "codex" ? "batch fallback" : "interactive target unavailable"}: ${a.codexAppServer.failure?.message ?? "interactive mode unavailable"}`);
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

/** Persisted sessions keep their actual transport visible even after the runner's stable `codex`
 * id migrates from exec to app-server. */
export function sessionAgentLabel(
  agentName: string | null | undefined,
  driver: AgentDefinition["driver"],
  agentId?: string | null,
): string {
  if (agentId === "conductor" || (agentName != null && isGeneratedConductorName(agentName))) {
    return CONDUCTOR_FAMILY;
  }
  if (driver === "codex-app-server") return "Codex — Interactive";
  if (driver === "codex") return "Codex — Non-Interactive (codex exec)";
  return agentName ?? agentId ?? driver ?? "Agent";
}
