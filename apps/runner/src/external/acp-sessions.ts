import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type {
  AcpRuntimeCapabilities,
  AgentDefinition,
  ExternalSessionDescriptor,
} from "@wollipog/protocol";
import { AcpClient } from "../acp.js";

const PROBE_TIMEOUT_MS = 6_000;
const MAX_PROBED_ADAPTERS = 16;
const PROBE_CONCURRENCY = 4;

export interface AcpExternalSession {
  descriptor: ExternalSessionDescriptor;
  capabilities: AcpRuntimeCapabilities;
}

export function acpSessionKey(agentId: string, sessionId: string): string {
  return `${agentId}\0${sessionId}`;
}

export function configuredAcpAgent(
  agents: AgentDefinition[],
  agentId: string,
): AgentDefinition | null {
  return agents.find((agent) =>
    agent.id === agentId && (agent.driver ?? "acp") === "acp" && agent.available !== false
  ) ?? null;
}

export function launchForAcpAgent(agent: AgentDefinition): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return { command: agent.command, args: agent.args ?? [], env: agent.env ?? {} };
}

/** Probe configured ACP adapters only when the user explicitly requests external sessions. Each
 * adapter is initialized independently, its stable capability is checked live, and its opaque
 * provider metadata is discarded. A broken/unauthenticated adapter cannot prevent other adapters
 * or native transcript stores from appearing. */
export async function listAcpExternalSessions(
  agents: AgentDefinition[],
  known: Set<string>,
  onCapabilities?: (agentId: string, capabilities: AcpRuntimeCapabilities) => void,
  onWarning?: (warning: string) => void,
): Promise<AcpExternalSession[]> {
  const configured = agents
    .filter((agent) => (agent.driver ?? "acp") === "acp" && agent.available !== false);
  if (configured.length > MAX_PROBED_ADAPTERS) {
    onWarning?.(
      `ACP session discovery is limited to the first ${MAX_PROBED_ADAPTERS} of ${configured.length} configured adapters`,
    );
  }
  const candidates = configured.slice(0, MAX_PROBED_ADAPTERS);
  const all: AcpExternalSession[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(PROBE_CONCURRENCY, candidates.length) },
    async () => {
      while (next < candidates.length) {
        const agent = candidates[next++]!;
        const result = await probeAcpAgent(agent);
        if (result) onCapabilities?.(agent.id, result.capabilities);
        if (result) all.push(...result.sessions);
      }
    },
  );
  await Promise.all(workers);
  const unique = new Map<string, AcpExternalSession>();
  for (const session of all) {
    const key = acpSessionKey(session.descriptor.agentId!, session.descriptor.agentSessionId);
    if (!known.has(key)) unique.set(key, session);
  }
  return [...unique.values()].sort((a, b) => b.descriptor.updatedAt - a.descriptor.updatedAt);
}

/** Re-query one exact configured ACP adapter at adoption time. The caller-supplied cwd/title are
 * never used, and an id from another ACP provider cannot be rebound to the first matching driver. */
export async function findAcpExternalSession(
  agents: AgentDefinition[],
  agentId: string,
  sessionId: string,
): Promise<AcpExternalSession | null> {
  const agent = configuredAcpAgent(agents, agentId);
  if (!agent) return null;
  const result = await probeAcpAgent(agent);
  return result?.sessions.find((session) => session.descriptor.agentSessionId === sessionId) ?? null;
}

async function probeAcpAgent(agent: AgentDefinition): Promise<{
  capabilities: AcpRuntimeCapabilities;
  sessions: AcpExternalSession[];
} | null> {
  let capabilities: AcpRuntimeCapabilities | null = null;
  let client: AcpClient;
  try {
    client = new AcpClient(
      {
        command: agent.command,
        args: agent.args ?? [],
        cwd: agent.context?.kind === "wsl" ? "/" : homedir(),
        env: agent.env ?? {},
        context: agent.context ?? { kind: "native" },
      },
      {
        onEvent: () => {},
        onStderr: () => {},
        onExit: () => {},
        onAcpCapabilities: (value) => { capabilities = value; },
      },
    );
  } catch {
    return null;
  }

  const timer = setTimeout(() => client.dispose(), PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    await client.initialize();
    const stable = capabilities as AcpRuntimeCapabilities | null;
    if (!stable?.sessionList) return null;
    const listed = await client.listSessions();
    const now = Date.now();
    const sessions = listed.flatMap((session): AcpExternalSession[] => {
      if (!session.sessionId || !validAbsoluteCwd(agent, session.cwd)) return [];
      const parsedUpdatedAt = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
      const updatedAt = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : now;
      return [{
        capabilities: stable,
        descriptor: {
          agentSessionId: session.sessionId,
          agentId: agent.id,
          driver: "acp",
          cwd: session.cwd,
          context: agent.context ?? { kind: "native" },
          title: normalizeTitle(session.title),
          createdAt: updatedAt,
          updatedAt,
          messageCount: 0,
          resumable: stable.sessionResume || stable.loadSession,
        },
      }];
    });
    return { capabilities: stable, sessions };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    client.dispose();
  }
}

function validAbsoluteCwd(agent: AgentDefinition, cwd: string): boolean {
  if (!cwd || cwd.length > 32_768 || cwd.includes("\0")) return false;
  return agent.context?.kind === "wsl" ? cwd.startsWith("/") : isAbsolute(cwd);
}

function normalizeTitle(title: string | null): string {
  return (title ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}
