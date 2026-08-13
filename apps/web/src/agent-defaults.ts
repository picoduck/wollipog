import {
  LOCAL_INSTANCE_SCOPE,
  loadInstanceStorageValue,
  saveInstanceStorageValue,
} from "./instance-storage.js";

const STORAGE_KEY = "wollipog.newSession.agentDefaults";

export type AgentDefaults = Record<string, string>;

export function parseAgentDefaults(raw: string | null | undefined): AgentDefaults {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          entry[0].length > 0 && typeof entry[1] === "string" && entry[1].length > 0,
      ),
    );
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
): AgentDefaults {
  const next = { ...defaults, [runnerId]: agentId };
  try {
    saveInstanceStorageValue(STORAGE_KEY, JSON.stringify(next), instanceScope);
  } catch {
    // Best-effort preference: private mode or a restricted webview must not block session creation.
  }
  return next;
}
