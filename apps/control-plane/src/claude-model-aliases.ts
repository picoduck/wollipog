import type { AgentCapabilities } from "@wollipog/protocol";

/** The catalog entry a Claude stable alias the catalog does not list stands in for: the first
 * entry of the same family. Current/stable aliases for one Claude family are capability-equivalent;
 * exact dated model pins and unknown ids resolve to nothing, so they stay exact and fail closed. */
export function claudeStableAliasCatalogModel(
  modelId: string,
  models: AgentCapabilities["models"],
): AgentCapabilities["models"][number] | undefined {
  const family = claudeStableAliasFamily(modelId);
  return family ? models.find((candidate) => claudeCatalogFamily(candidate.id) === family) : undefined;
}

export function claudeStableAliasFamily(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^(opus|fable|sonnet|haiku)(?:\[1m\])?$/.exec(normalized)?.[1] ?? null;
}

export function claudeCatalogFamily(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return claudeStableAliasFamily(normalized)
    ?? /^claude-(opus|fable|sonnet|haiku)-\d+(?:-\d+)?(?:-\d{8})?(?:\[1m\])?$/.exec(normalized)?.[1]
    ?? null;
}
