/** Google Antigravity sessions (#4779): the New Session agent row the runner advertises from its
 * Antigravity setup (#4780), and the launch every Antigravity session uses.
 *
 * The setup is the single source of truth. It resolves the executable and checks the sign-in in
 * `antigravityCredentialContext()`; a session launches that same executable as `agy acp` with
 * exactly that context's environment and scrub list, so setup, readiness checks and sessions see
 * one credential context. The row is offered only while the setup reports `ready`. A runtime that
 * was never found (or a platform setup does not support) advertises no row at all, so machines
 * without Antigravity gain no Needs Setup entry; a found runtime that needs sign-in or failed its
 * check is listed under Needs Setup with that reason. */

import { ANTIGRAVITY_AGENT_ID, type AgentDefinition, type AntigravitySetupView } from "@wollipog/protocol";
import type { AcpCompatibility } from "./acp-compatibility.js";
import {
  ANTIGRAVITY_AMBIENT_CREDENTIAL_ENV,
  ANTIGRAVITY_AMBIENT_CREDENTIAL_PREFIXES,
  type AntigravityCredentialContext,
} from "./antigravity-setup.js";
import type { RunnerExecutionIsolation } from "./config.js";

export { ANTIGRAVITY_AGENT_ID };
export const ANTIGRAVITY_AGENT_NAME = "Google Antigravity";
/** The launch arguments. Never `--dangerously-skip-permissions`, `--login`, or a directory flag:
 * permissions follow the agent's advertised modes and the session's cwd is its worktree. */
export const ANTIGRAVITY_ACP_ARGS = ["acp"] as const;

/** Real agy 1.5.14 answered initialize at once and opened a session in about a second; these bound
 * a process that never answers. Session creation and resume reach Google, so they get longer. */
export const ANTIGRAVITY_LAUNCH_DEADLINES = { handshakeMs: 20_000, sessionMs: 60_000 } as const;

/** Runner-visible reasons; New Session words them as their fix (`agent-options.ts`). */
export const ANTIGRAVITY_UNAVAILABLE = {
  checkFailed: "The Google Antigravity check failed on this runner.",
  networkDenied: "Google Antigravity needs network access, which this runner's execution isolation denies.",
} as const;

/** Whether this runner's execution isolation lets Antigravity persist its conversations. With
 * bwrap or Seatbelt its state directory under HOME is read-only, so resume is not offered there. */
export function antigravityResumable(isolation: Pick<RunnerExecutionIsolation, "mode">): boolean {
  return isolation.mode === "provider";
}

/** The New Session row for a settled setup (any status but `checking`), or null when the runner
 * advertises none. `launchable` is whether the setup has a committed executable a launch may run. */
export function antigravityAgentDefinition(
  setup: AntigravitySetupView,
  context: AntigravityCredentialContext,
  isolation: Pick<RunnerExecutionIsolation, "mode" | "network">,
  launchable = true,
): AgentDefinition | null {
  const executable = setup.executable?.path;
  if (!executable || setup.status === "missing_runtime" || setup.status === "unsupported" || setup.status === "checking") {
    return null;
  }
  const ready = setup.status === "ready";
  const networkDenied = isolation.network === "deny";
  // A ready check of an update's candidate that was never committed, with nothing committed before
  // it, leaves nothing a launch may run: every attempt would be refused, so nothing is offered.
  const uncommitted = ready && !launchable;
  const available = ready && !networkDenied && !uncommitted;
  return {
    id: ANTIGRAVITY_AGENT_ID,
    name: ANTIGRAVITY_AGENT_NAME,
    command: executable,
    args: [...ANTIGRAVITY_ACP_ARGS],
    env: { ...context.env },
    driver: "acp",
    context: { kind: "native" },
    source: "discovered",
    acpTransport: "stdio",
    ...(setup.executable?.version ? { version: setup.executable.version } : {}),
    available,
    authStatus: setup.status === "sign_in_required" ? "unauthenticated" : ready ? "authenticated" : "unknown",
    ...(networkDenied
      ? { unavailableReason: ANTIGRAVITY_UNAVAILABLE.networkDenied }
      : setup.status === "verification_failed" || uncommitted ? { unavailableReason: ANTIGRAVITY_UNAVAILABLE.checkFailed } : {}),
    capabilities: {
      // The account's models from the setup's last check; a live session replaces them with the
      // model choices its own session advertises.
      models: (ready ? setup.models ?? [] : []).map((model) => ({ id: model.id, displayName: model.name })),
      effortLevels: [],
      slashCommands: [],
      // agy 1.5.14 advertises image prompts; a live session reports its own handshake's value.
      supportsImages: true,
      supportsApprovals: true,
    },
  };
}

/** The agent list with Antigravity's row in place of any earlier one. A configured agent that
 * already uses the id keeps it: an operator's own entry is never replaced. */
export function withAntigravityAgent(
  agents: readonly AgentDefinition[],
  row: AgentDefinition | null,
  configuredIds: ReadonlySet<string>,
): AgentDefinition[] {
  if (configuredIds.has(ANTIGRAVITY_AGENT_ID)) return [...agents];
  const others = agents.filter((agent) => agent.id !== ANTIGRAVITY_AGENT_ID);
  return row ? [...others, row] : others;
}

/** Whether a setup confirms the sign-in after a session reported it gone. Only a ready check whose
 * access probe ran after the report does, judged by when it observed access (`accessObservedAt`),
 * not when it published: a check can publish after slower work, and a republished earlier view
 * (install or update progress, say) observed nothing new. */
export function antigravitySignOutSuperseded(
  setup: Pick<AntigravitySetupView, "status">,
  accessObservedAt: number | undefined,
  signedOutAt: number | undefined,
): boolean {
  if (setup.status !== "ready") return false;
  return signedOutAt === undefined || (accessObservedAt !== undefined && accessObservedAt > signedOutAt);
}

/** The agents external-session discovery and adoption may probe: never the setup-derived
 * Antigravity row. Those paths spawn adapters without its credential context or compatibility
 * profile, and listing (and the load that adoption needs) is withheld for Antigravity anyway. */
export function withoutAntigravityAgent<T extends Pick<AgentDefinition, "id">>(
  agents: readonly T[],
  configuredIds: ReadonlySet<string>,
): T[] {
  return configuredIds.has(ANTIGRAVITY_AGENT_ID) ? [...agents] : agents.filter((agent) => agent.id !== ANTIGRAVITY_AGENT_ID);
}

export interface AntigravitySessionLaunch {
  /** Undefined when the setup has no executable: the launch keeps the command it was started with
   * and, if that is gone, fails as an installation problem. */
  command?: string;
  args: string[];
  env: Record<string, string>;
  scrubInheritedEnv: string[];
  acpCompatibility: AcpCompatibility;
}

/** How an Antigravity session launches now: the executable the setup currently resolves (it can
 * change between launches, for example when a managed install moves its current version), with the
 * setup's credential context and the Antigravity compatibility profile. */
export function antigravitySessionLaunch(
  setup: AntigravitySetupView,
  context: AntigravityCredentialContext,
  isolation: Pick<RunnerExecutionIsolation, "mode">,
): AntigravitySessionLaunch {
  const command = setup.executable?.path;
  return {
    ...(command ? { command } : {}),
    args: [...ANTIGRAVITY_ACP_ARGS],
    env: { ...context.env },
    scrubInheritedEnv: [...context.scrubInheritedEnv],
    acpCompatibility: { profile: "antigravity", resumable: antigravityResumable(isolation),
      withheldEnvironment: { names: [...ANTIGRAVITY_AMBIENT_CREDENTIAL_ENV], prefixes: [...ANTIGRAVITY_AMBIENT_CREDENTIAL_PREFIXES] },
      ...(Object.keys(context.env).length ? { pinnedEnvironment: { ...context.env } } : {}),
      deadlines: { ...ANTIGRAVITY_LAUNCH_DEADLINES } },
  };
}

/** The spawn-time answer to what an Antigravity launch runs (`AcpCompatibility.resolveLaunch`):
 * the setup's launchable executable and its pinned values at that moment, held until the client
 * releases it, or null to refuse. */
export function antigravityLaunchResolver(
  setup: { acquireLaunchTarget(): { command: string; context: AntigravityCredentialContext; release: () => void } | null },
): NonNullable<AcpCompatibility["resolveLaunch"]> {
  return () => {
    const target = setup.acquireLaunchTarget();
    return target ? { command: target.command, pinnedEnvironment: { ...target.context.env }, release: target.release } : null;
  };
}

/** A prepared launch's explicit environment: without the credential context's scrubbed names, and
 * without the values a context pins (the managed copy's updater switch, read from `managedContext`).
 * Those belong to whichever copy the spawn resolves and are applied there (`pinnedEnvironment`), so
 * a PATH copy resolved instead keeps the setting its own environment gives it. */
export function antigravitySessionEnvironment(
  env: Readonly<Record<string, string>>,
  scrubInheritedEnv: readonly string[],
  managedContext: AntigravityCredentialContext,
): Record<string, string> {
  const removed = new Set([...scrubInheritedEnv, ...Object.keys(managedContext.env)]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !removed.has(name)));
}
