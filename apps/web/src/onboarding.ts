/** Pure helpers for the "Add a runner" onboarding flow (no DOM, unit-tested). */

import type { AgentDefinition, RunnerView } from "@wollipog/protocol";
import { agentDriverLabel } from "./agent-presentation.js";

export interface RunnerConfigOptions {
  runnerId: string;
  /** ws URL the runner registers against (control plane /runner channel). */
  runnerWsUrl: string;
  workspaceId: string;
  workspacePath: string;
}

/** Produce a ready-to-save runner.config.json for a new runner. */
export function buildRunnerConfigJson(o: RunnerConfigOptions): string {
  const config = {
    runnerId: o.runnerId,
    controlPlaneUrl: o.runnerWsUrl,
    workspaces: [{ id: o.workspaceId, name: o.workspaceId, path: o.workspacePath }],
    agents: [
      { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" },
      { id: "codex-app", name: "Codex App Server", command: "codex", args: [], env: {}, driver: "codex-app-server" },
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

/** The shell command that starts the runner against a saved config file. */
export const RUNNER_TOKEN_FILE = ".agent-manager/runner.token";
export const RUNNER_START_COMMAND = `pnpm runner --config runner.config.json --token-file ${RUNNER_TOKEN_FILE}`;

/** Add the runner's explicit plaintext opt-in only for a deliberately selected remote ws:// URL. */
export function buildRunnerStartCommand(allowInsecureTransport = false): string {
  return allowInsecureTransport
    ? `${RUNNER_START_COMMAND} --allow-insecure-transport`
    : RUNNER_START_COMMAND;
}

export type OnboardingHealthStatus = "pass" | "pending" | "warning" | "fail";

export interface OnboardingHealthCheck {
  id: "control-plane" | "credentials" | "runner" | "workspace" | "agents";
  label: string;
  status: OnboardingHealthStatus;
  detail: string;
  command?: string;
}

function agentProblem(agent: AgentDefinition): { detail: string; command?: string } | null {
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
      return { detail: `${label} needs a Codex version with interactive support.`, command: "npm install -g @openai/codex@latest" };
    }
    if (agent.codexAppServer?.status === "unavailable") {
      return { detail: `${label} is not installed.`, command: "npm install -g @openai/codex@latest" };
    }
  } else if (agent.driver === "codex") {
    if (agent.authStatus === "unauthenticated") {
      return { detail: `${label} is installed but not signed in.`, command: "codex login" };
    }
  } else if (agent.authStatus === "unauthenticated") {
    return { detail: `${label} requires authentication. Complete its adapter login on the runner, then run Rediscover.` };
  }
  if (agent.available === false) {
    return agent.driver === "claude-code"
      ? { detail: `${label} is not installed or could not be launched.`, command: "npm install -g @anthropic-ai/claude-code" }
      : agent.driver?.startsWith("codex")
        ? { detail: `${label} is not installed or could not be launched.`, command: "npm install -g @openai/codex@latest" }
        : { detail: `${label} is unavailable. Check its launch command on the runner.` };
  }
  return null;
}

function agentVerifiedReady(agent: AgentDefinition): boolean {
  if (agentProblem(agent)) return false;
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
  const agents = runner.agents.filter((agent) => agent.id !== "conductor");
  const labels = [...new Set(agents.map(agentDriverLabel))];
  const ready = agents.filter(agentVerifiedReady);
  if (ready.length) {
    return {
      state: "ready",
      title: "This Machine Is Connected",
      detail: `${ready.length} coding agent${ready.length === 1 ? " is" : "s are"} ready to use.`,
      agentLabels: labels,
    };
  }
  const problem = agents.map(agentProblem).find((item): item is NonNullable<typeof item> => item != null);
  return {
    state: "needs-attention",
    title: agents.length ? "Agents Need Attention" : "No Supported Agents Found",
    detail: problem?.detail ?? "Install or sign in to a supported coding agent, then use Rediscover on this runner.",
    agentLabels: labels,
  };
}

/** Derive a live, actionable verification checklist from the runner snapshot already in the app. */
export function onboardingHealth(input: {
  credentialAvailable: boolean;
  runnerId: string;
  workspaceId: string;
  runner?: RunnerView;
  runnerIdCollision?: boolean;
  startCommand?: string;
}): OnboardingHealthCheck[] {
  const runnerId = input.runnerId.trim() || "runner";
  const workspaceId = input.workspaceId.trim() || "my-repo";
  const runner = input.runner;
  const startCommand = input.startCommand ?? RUNNER_START_COMMAND;
  const checks: OnboardingHealthCheck[] = [
    {
      id: "control-plane",
      label: "Control Plane",
      status: "pass",
      detail: "Onboarding settings loaded from this control plane.",
    },
    input.credentialAvailable
      ? { id: "credentials", label: "Runner Credential", status: "pass", detail: `A one-time credential was generated for “${runnerId}”. Save it as ${RUNNER_TOKEN_FILE} and restrict the file to the runner account.` }
      : { id: "credentials", label: "Runner Credential", status: "pending", detail: `Generate the one-time credential for “${runnerId}” before saving the runner configuration.` },
  ];

  if (input.runnerIdCollision) {
    checks.push(
      { id: "runner", label: "Runner Connection", status: "fail", detail: `Runner id “${runnerId}” already existed when this dialog opened. Choose a unique id for the new runner.` },
      { id: "workspace", label: "Workspace", status: "pending", detail: "Choose a unique runner id before workspace verification begins." },
      { id: "agents", label: "Agent Readiness", status: "pending", detail: "Choose a unique runner id before agent verification begins." },
    );
    return checks;
  }

  if (!runner) {
    checks.push(
      { id: "runner", label: "Runner Connection", status: "pending", detail: `Waiting for “${runnerId}” to connect.`, command: startCommand },
      { id: "workspace", label: "Workspace", status: "pending", detail: `Waiting for “${workspaceId}” to be advertised by the runner.` },
      { id: "agents", label: "Agent Readiness", status: "pending", detail: "Waiting for the runner to discover and verify agent CLIs." },
    );
    return checks;
  }

  const online = runner.status === "online";
  checks.push(online
    ? { id: "runner", label: "Runner Connection", status: "pass", detail: `${runner.hostname} is online as “${runner.runnerId}”.` }
    : { id: "runner", label: "Runner Connection", status: "fail", detail: `“${runner.runnerId}” is offline. Restart it with the generated config.`, command: startCommand });

  const workspace = runner.workspaces.find((candidate) => candidate.id === workspaceId);
  checks.push(workspace
    ? {
        id: "workspace",
        label: "Workspace",
        status: online ? "pass" : "warning",
        detail: `“${workspace.name}” ${online ? "is available" : "was last advertised"} at ${workspace.path}.`,
      }
    : { id: "workspace", label: "Workspace", status: online ? "fail" : "pending", detail: `The runner has not advertised workspace “${workspaceId}”. Check the id and path in runner.config.json.` });

  if (runner.agentsRefreshed !== true) {
    checks.push({ id: "agents", label: "Agent Readiness", status: "pending", detail: "Waiting for this connection to finish live agent verification. Upgrade the runner if this does not complete." });
  } else {
    const ready = runner.agents.find(agentVerifiedReady);
    if (ready) {
      checks.push({
        id: "agents",
        label: "Agent Readiness",
        status: online ? "pass" : "warning",
        detail: `${agentDriverLabel(ready)} ${online ? "is installed and ready" : "was ready when this runner was last online"}.`,
      });
    } else {
      const problem = runner.agents.map(agentProblem).find((item): item is NonNullable<typeof item> => item != null);
      const awaitingLive = runner.agents.find((agent) =>
        (agent.driver ?? "acp") === "acp" && !agentProblem(agent) && !agentVerifiedReady(agent));
      checks.push(problem
        ? {
            id: "agents",
            label: "Agent Readiness",
            status: online ? "fail" : "warning",
            detail: online ? problem.detail : `Last reported when this runner was online: ${problem.detail}`,
            ...(problem.command ? { command: problem.command } : {}),
          }
        : awaitingLive
          ? {
              id: "agents",
              label: "Agent Readiness",
              status: "warning",
              detail: `${agentDriverLabel(awaitingLive)} is configured or installed, but readiness is verified only on its first live initialize.`,
            }
          : {
            id: "agents",
            label: "Agent Readiness",
            status: online ? "fail" : "warning",
            detail: online
              ? "No agent CLI was discovered. Install Claude Code or Codex, then run Rediscover."
              : "No agent CLI was discovered when this runner was last online.",
          });
    }
  }
  return checks;
}
