/** Pure helpers for the "Add a runner" onboarding flow (no DOM, unit-tested). */

import { CODEX_EXEC_RETIRED_CONFIG_REASON, isRetiredCodexExec, type AgentDefinition, type RunnerView } from "@wollipog/protocol";
import { agentDriverLabel } from "./agent-presentation.js";
import { codexUpgradeGuidance } from "./runners.js";

export interface RunnerConfigWorkspaceOption {
  id: string;
  name: string;
  path: string;
}

export interface RunnerConfigOptions {
  runnerId: string;
  /** ws URL the runner registers against (control plane /runner channel). */
  runnerWsUrl: string;
  /** The first workspace, or null for a runner that starts without one. */
  workspace: RunnerConfigWorkspaceOption | null;
}

/** Produce a ready-to-save runner.config.json for a new runner. */
export function buildRunnerConfigJson(o: RunnerConfigOptions): string {
  const config = {
    runnerId: o.runnerId,
    controlPlaneUrl: o.runnerWsUrl,
    workspaces: o.workspace ? [o.workspace] : [],
    agents: [
      { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" },
      { id: "codex-app", name: "Codex App Server", command: "codex", args: [], env: {}, driver: "codex-app-server" },
      { id: "pi", name: "Pi", command: "pi", args: [], env: {}, driver: "pi" },
    ],
  };
  return JSON.stringify(config, null, 2);
}

/** Suggest a runner id not already taken (runner, runner-2, runner-3, …). */
export function suggestRunnerId(existing: readonly string[], base = "runner"): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const id = `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
  return `${base}-${existing.length + 1}`;
}

/** Swap the host of a ws URL for a chosen address (loopback vs a LAN IP). */
export function withHost(wsUrl: string, host: string): string {
  try {
    const u = new URL(wsUrl);
    u.hostname = host;
    return u.toString().replace(/\/$/, "");
  } catch {
    return wsUrl;
  }
}

/**
 * The first workspace from Install Manually's optional folder and name, or null when the folder is
 * blank. A blank name falls back to the folder's last segment; the id is the name in lowercase with
 * every run of other characters turned into one dash. An id of only dots ("." or "..", from a folder
 * such as `.`) would be a URL dot segment in the workspace's API routes, so it becomes "workspace".
 */
export function firstWorkspace(folder: string, name: string): RunnerConfigWorkspaceOption | null {
  const path = folder.trim();
  if (!path) return null;
  const segment = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
  const label = name.trim() || (/^\.+$/.test(segment) ? "workspace" : segment);
  const slug = label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const id = !slug || /^\.+$/.test(slug) ? "workspace" : slug;
  return { id, name: label, path };
}

/** Where a runner connects from, in words: "This computer (127.0.0.1)", "192.0.2.10 (local network)". */
export function runnerHostLabel(host: string): string {
  return host === "127.0.0.1" ? "This computer (127.0.0.1)" : `${host} (local network)`;
}

/** The shell command that starts the runner against a saved config file. */
export const RUNNER_TOKEN_FILE = ".agent-manager/runner.token";
export const RUNNER_START_COMMAND = `pnpm runner --config runner.config.json --token-file ${RUNNER_TOKEN_FILE}`;

/** Add the runner's explicit plaintext opt-in only for a deliberately selected remote ws:// URL. */
export function buildRunnerStartCommand(allowInsecureTransport = false): string {
  return allowInsecureTransport
    ? `${RUNNER_START_COMMAND} --allow-insecure-transport`
    : RUNNER_START_COMMAND;
}

/**
 * One check's state. `waiting` waits for the person (a credential, a start command) and draws a
 * hollow circle; `pending` is Wollipog waiting on the machine and is the only state with a spinner.
 */
export type OnboardingHealthStatus = "pass" | "waiting" | "pending" | "warning" | "fail";

export interface OnboardingHealthCheck {
  id: "control-plane" | "credentials" | "runner" | "workspace" | "agents";
  label: string;
  status: OnboardingHealthStatus;
  detail: string;
  command?: string;
}

function agentProblem(agent: AgentDefinition, os: RunnerView["os"]): { detail: string; command?: string } | null {
  // The retired Codex exec driver (#3259) is never ready, even when an older runner reports its
  // discovered row available, and its problem is the configuration fix.
  if (isRetiredCodexExec(agent)) return { detail: CODEX_EXEC_RETIRED_CONFIG_REASON };
  const label = agentDriverLabel(agent);
  if (agent.driver === "claude-code") {
    if (agent.authStatus === "unauthenticated" || agent.claudeCode?.status === "unauthenticated") {
      return { detail: `${label} is installed but not signed in.`, command: "claude auth login" };
    }
    if (agent.claudeCode?.status === "unsupported") {
      return { detail: `${label} needs a newer Claude Code CLI.`, command: "claude update" };
    }
    if (agent.claudeCode?.status === "unavailable") {
      return { detail: `${label} is not installed.`, command: "npm install -g @anthropic-ai/claude-code" };
    }
  } else if (agent.driver === "codex-app-server") {
    if (agent.authStatus === "unauthenticated") {
      return { detail: `${label} is installed but not signed in.`, command: "codex login" };
    }
    if (agent.codexAppServer?.status === "unsupported") {
      // A check that timed out or could not run is fixed by rediscovering, not by an upgrade.
      const failure = agent.codexAppServer.failure;
      return failure?.retryable
        ? { detail: failure.message }
        : { detail: `${label} needs a Codex version with interactive support. ${codexUpgradeGuidance(agent, os)}` };
    }
    if (agent.codexAppServer?.status === "unavailable") {
      return { detail: `${label} is unavailable or could not be launched. ${codexUpgradeGuidance(agent, os)}` };
    }
  } else if (agent.driver === "pi") {
    if (agent.authStatus === "unauthenticated") {
      return { detail: `${label} is installed but has no authenticated model.`, command: "pi" };
    }
    if (agent.available !== true) {
      return {
        detail: agent.unavailableReason ?? `${label} is not installed or its RPC protocol is incompatible.`,
        command: "npm install -g @earendil-works/pi-coding-agent@latest",
      };
    }
  } else if (agent.authStatus === "unauthenticated") {
    return { detail: `${label} requires authentication. Complete its adapter login on the runner, then run Rediscover.` };
  }
  if (agent.available !== true) {
    return agent.driver === "claude-code"
      ? { detail: `${label} is not installed or could not be launched.`, command: "npm install -g @anthropic-ai/claude-code" }
      : agent.driver?.startsWith("codex")
        ? { detail: `${label} is not installed or could not be launched. ${codexUpgradeGuidance(agent, os)}` }
        : { detail: `${label} is unavailable. Check its launch command on the runner.` };
  }
  return null;
}

function agentVerifiedReady(agent: AgentDefinition, os: RunnerView["os"]): boolean {
  if (agentProblem(agent, os)) return false;
  if ((agent.driver ?? "acp") === "acp") {
    return agent.authStatus === "authenticated" || agent.acp != null;
  }
  return agent.available === true || agent.claudeCode?.status === "ready" || agent.codexAppServer?.status === "supported";
}

export interface LocalRunnerReadiness {
  state: "starting" | "discovering" | "ready" | "needs-attention";
  title: string;
  detail: string;
  agentLabels: string[];
}

/** Human-scale progress for the config-free runner bundled with the desktop app. */
export function localRunnerReadiness(runner: RunnerView | undefined): LocalRunnerReadiness {
  if (!runner || runner.status !== "online") {
    return {
      state: "starting",
      title: "Starting the Local Runner",
      detail: "Wollipog is connecting the bundled runner. No terminal or configuration file is required.",
      agentLabels: [],
    };
  }
  if (runner.agentsRefreshed !== true) {
    return {
      state: "discovering",
      title: "Discovering Coding Agents",
      detail: "Scanning this machine and its WSL distributions for supported agent CLIs.",
      agentLabels: [],
    };
  }
  const agents = runner.agents;
  const labels = [...new Set(agents.filter((agent) => !isRetiredCodexExec(agent)).map(agentDriverLabel))];
  const ready = agents.filter((agent) => agentVerifiedReady(agent, runner.os));
  if (ready.length) {
    return {
      state: "ready",
      title: "This Machine Is Connected",
      detail: `${ready.length} coding agent${ready.length === 1 ? " is" : "s are"} ready to use.`,
      agentLabels: labels,
    };
  }
  const problem = agents.map((agent) => agentProblem(agent, runner.os))
    .find((item): item is NonNullable<typeof item> => item != null);
  return {
    state: "needs-attention",
    title: agents.length ? "Agents Need Attention" : "No Supported Agents Found",
    detail: problem?.detail ?? "Install or sign in to a supported coding agent, then use Rediscover on this runner.",
    agentLabels: labels,
  };
}

/**
 * The Connection Check: a live checklist derived from the runner snapshot already in the app.
 *
 * Nothing spins until a credential exists: until then every check waits for the person, not for
 * the machine. An empty `workspaceIds` skips the workspace check. `repair` checks a runner that
 * already exists: there are no control-plane or credential rows, and an agent problem is a warning,
 * since the connection is what is being repaired.
 */
export function onboardingHealth(input: {
  credentialAvailable: boolean;
  runnerId: string;
  workspaceIds: readonly string[];
  runner?: RunnerView;
  runnerIdCollision?: boolean;
  repair?: boolean;
}): OnboardingHealthCheck[] {
  const runnerId = input.runnerId.trim() || "runner";
  const workspaceIds = input.workspaceIds.map((id) => id.trim()).filter(Boolean);
  const { runner, credentialAvailable: credential } = input;
  const repair = input.repair === true;
  const checks: OnboardingHealthCheck[] = repair ? [] : [
    { id: "control-plane", label: "Control Plane", status: "pass", detail: "Setup details loaded from this control plane." },
    credential
      ? { id: "credentials", label: "Runner Credential", status: "pass", detail: `A one-time credential was issued for ${runnerId}.` }
      : { id: "credentials", label: "Runner Credential", status: "waiting", detail: `Generate the credential for ${runnerId}.` },
  ];
  const workspaceLabel = workspaceIds.length > 1 ? "Workspaces" : "Workspace";
  const quoted = (ids: readonly string[]) => ids.map((id) => `“${id}”`).join(", ");
  /** A check that can only run once the runner is online: waiting for the person until a
   * credential exists, then waiting on the machine. */
  const notYet = (id: "workspace" | "agents", label: string, waiting: string, pending: string): OnboardingHealthCheck =>
    credential ? { id, label, status: "pending", detail: pending } : { id, label, status: "waiting", detail: waiting };

  if (input.runnerIdCollision) {
    const later = "Checked once the runner has a unique name.";
    checks.push({ id: "runner", label: "Runner Connection", status: "fail", detail: `A runner named ${runnerId} already exists. Choose another name.` });
    if (workspaceIds.length) checks.push({ id: "workspace", label: workspaceLabel, status: "waiting", detail: later });
    checks.push({ id: "agents", label: "Agent Readiness", status: "waiting", detail: later });
    return checks;
  }

  if (runner?.status !== "online") {
    const later = "Checked once the runner connects.";
    checks.push(credential
      ? { id: "runner", label: "Runner Connection", status: "pending", detail: `Waiting for ${runnerId} to connect…` }
      : runner
        ? { id: "runner", label: "Runner Connection", status: "waiting", detail: `${runnerId} is offline. Replace its credential, then restart it.` }
        : { id: "runner", label: "Runner Connection", status: "waiting", detail: "Generate the credential, then start the runner." });
    if (workspaceIds.length) {
      checks.push(notYet("workspace", workspaceLabel, later, `Waiting for ${runnerId} to advertise ${quoted(workspaceIds)}.`));
    }
    // A runner that was online before can say what was wrong with its agents then, as a warning. A
    // last-known ready agent is no problem, so that row still waits for the runner like the others.
    const lastKnown = runner?.agentsRefreshed === true ? agentsCheck(runner, false, repair) : null;
    checks.push(lastKnown && lastKnown.status !== "pass"
      ? lastKnown
      : notYet("agents", "Agent Readiness", later, `Waiting for ${runnerId} to report its agents.`));
    return checks;
  }

  checks.push({ id: "runner", label: "Runner Connection", status: "pass", detail: `${runner.hostname} is online as ${runner.runnerId}.` });

  if (workspaceIds.length) {
    const advertised = runner.workspaces.filter((workspace) => workspaceIds.includes(workspace.id));
    const missing = workspaceIds.filter((id) => !advertised.some((workspace) => workspace.id === id));
    checks.push(missing.length
      ? {
          id: "workspace",
          label: workspaceLabel,
          status: "fail",
          detail: `The runner has not advertised ${quoted(missing)}. Check the folder in runner.config.json.`,
        }
      : {
          id: "workspace",
          label: workspaceLabel,
          status: "pass",
          detail: advertised.length === 1
            ? `“${advertised[0]!.name}” is available at ${advertised[0]!.path}.`
            : `${quoted(advertised.map((workspace) => workspace.name))} are available.`,
        });
  }

  checks.push(runner.agentsRefreshed === true
    ? agentsCheck(runner, true, repair)
    : { id: "agents", label: "Agent Readiness", status: "pending", detail: "Waiting for this connection to finish live agent verification. Upgrade the runner if this does not complete." });
  return checks;
}

/** The Agent Readiness row for a runner that has reported its agents, live or last known. */
function agentsCheck(runner: RunnerView, online: boolean, repair: boolean): OnboardingHealthCheck {
  const failed: OnboardingHealthStatus = online && !repair ? "fail" : "warning";
  const agents = runner.agents;
  const ready = agents.find((agent) => agentVerifiedReady(agent, runner.os));
  if (ready) {
    return { id: "agents", label: "Agent Readiness", status: "pass", detail: `${agentDriverLabel(ready)} is installed and ready.` };
  }
  const problem = agents.map((agent) => agentProblem(agent, runner.os))
    .find((item): item is NonNullable<typeof item> => item != null);
  if (problem) {
    return {
      id: "agents",
      label: "Agent Readiness",
      status: failed,
      detail: online ? problem.detail : `Last reported when this runner was online: ${problem.detail}`,
      ...(problem.command ? { command: problem.command } : {}),
    };
  }
  const awaitingLive = agents.find((agent) =>
    (agent.driver ?? "acp") === "acp" && !agentProblem(agent, runner.os) && !agentVerifiedReady(agent, runner.os));
  if (awaitingLive) {
    return {
      id: "agents",
      label: "Agent Readiness",
      status: "warning",
      detail: `${agentDriverLabel(awaitingLive)} is configured or installed, but readiness is verified only on its first live initialize.`,
    };
  }
  return {
    id: "agents",
    label: "Agent Readiness",
    status: failed,
    detail: online
      ? "No agent CLI was discovered. Install Claude Code, Codex, or Pi, then run Rediscover."
      : "No agent CLI was discovered when this runner was last online.",
  };
}
