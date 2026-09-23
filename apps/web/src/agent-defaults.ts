import {
  LOCAL_INSTANCE_SCOPE,
  loadInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";
import type { AgentDefinition } from "@wollipog/protocol";

const STORAGE_KEY = "wollipog.newSession.agentDefaults";

export interface SavedAgentChoice {
  agentId: string;
  driver: AgentDefinition["driver"];
  context: AgentDefinition["context"];
  installationId: string;
}

export type AgentDefaults = Record<string, string | SavedAgentChoice>;

function savedChoice(value: unknown): value is SavedAgentChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SavedAgentChoice>;
  const context = candidate.context;
  return typeof candidate.agentId === "string" && candidate.agentId.length > 0 &&
    typeof candidate.installationId === "string" && candidate.installationId.length > 0 &&
    ["acp", "claude-code", "codex", "codex-app-server", "pi"].includes(candidate.driver ?? "") &&
    !!context && (context.kind === "native" ||
      context.kind === "wsl" && typeof context.distro === "string" && context.distro.length > 0);
}

export function parseAgentDefaults(raw: string | null | undefined): AgentDefaults {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
      key.length > 0 && (typeof value === "string" && value.length > 0 || savedChoice(value)),
    )) as AgentDefaults;
  } catch {
    return {};
  }
}

export function loadAgentDefaults(instanceScope = LOCAL_INSTANCE_SCOPE): AgentDefaults {
  try {
    return parseAgentDefaults(loadInstanceStorageValue(STORAGE_KEY, instanceScope));
  } catch {
    return {};
  }
}

export function saveAgentDefault(
  defaults: AgentDefaults,
  runnerId: string,
  agentId: string,
  instanceScope = LOCAL_INSTANCE_SCOPE,
  agent?: AgentDefinition,
): AgentDefaults {
  const choice: string | SavedAgentChoice = agent?.installation
    ? { agentId, driver: agent.driver, context: agent.context ?? { kind: "native" },
        installationId: agent.installation.id }
    : agentId;
  const next = { ...defaults, [runnerId]: choice };
  try {
    saveInstanceStorageValue(STORAGE_KEY, JSON.stringify(next), instanceScope);
  } catch {
    // Best-effort preference: private mode or a restricted webview must not block session creation.
  }
  return next;
}
