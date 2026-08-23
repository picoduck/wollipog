import {
  loadInstanceStorageValue,
  saveInstanceStorageValue,
  LOCAL_INSTANCE_SCOPE,
} from "./instance-storage.js";
import type { View } from "./navigation.js";

/**
 * Experimental-feature flags: per device, per control-plane instance, client-side only.
 *
 * These gate UI EXPOSURE, not capability. The control plane keeps serving `/api/runs` and
 * `/api/pods` regardless, the runner's WOLLIPOG_CONDUCTOR gate stays the real conductor
 * switch, and a remote instance never inherits this device's choices — which is why the
 * value is instance-scoped rather than a plain browser key like the theme.
 */

export type ExperimentId = "multiAgent" | "pods" | "conductor";

export interface ExperimentFlags {
  /** Multi-Agent Runs and the workflow surfaces reached through them. */
  readonly multiAgent: boolean;
  /** Collaboration Pods. */
  readonly pods: boolean;
  /** The Conductor-Led Work preset. UI exposure only; a runner must still advertise one. */
  readonly conductor: boolean;
}

export const EXPERIMENTS_STORAGE_KEY = "wollipog.experiments";

/** Everything on: the flags EXISTING must not change what current installs render. */
export const DEFAULT_EXPERIMENT_FLAGS: ExperimentFlags = {
  multiAgent: true,
  pods: true,
  conductor: true,
};

/** Unknown shapes and unknown keys fall back to the defaults key-by-key, never throw. */
export function parseExperimentFlags(raw: string | null): ExperimentFlags {
  if (raw === null) return DEFAULT_EXPERIMENT_FLAGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_EXPERIMENT_FLAGS;
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_EXPERIMENT_FLAGS;
  const record = parsed as Record<string, unknown>;
  const flag = (id: ExperimentId): boolean =>
    typeof record[id] === "boolean" ? (record[id] as boolean) : DEFAULT_EXPERIMENT_FLAGS[id];
  return { multiAgent: flag("multiAgent"), pods: flag("pods"), conductor: flag("conductor") };
}

/** One vocabulary for the settings rows and the disabled-route notice, so they cannot drift. */
export const EXPERIMENT_TITLES: Record<ExperimentId, string> = {
  multiAgent: "Multi-Agent Runs",
  pods: "Collaboration Pods",
  conductor: "Conductor-Led Work",
};

/**
 * The experiment a view belongs to, or null for one that is always available. The list and
 * detail views gate together: hiding /runs while /runs/~id still renders would not be "off".
 */
export function experimentForViewName(name: View["name"]): ExperimentId | null {
  if (name === "runs" || name === "run") return "multiAgent";
  if (name === "pods" || name === "pod") return "pods";
  return null;
}

/**
 * One mutable store per instance scope, shared by every subscriber on the page.
 *
 * `useSyncExternalStore` needs a snapshot that is referentially stable between writes, so the
 * cache holds the exact object handed out until the next write replaces it. A module-level
 * store rather than a provider because the flags are read from both the shell and leaf
 * components (rail, palette, dialogs) and carry no render-scoped state of their own.
 */
const flagsByScope = new Map<string, ExperimentFlags>();
const listeners = new Set<() => void>();

export function getExperimentFlags(instanceScope = LOCAL_INSTANCE_SCOPE): ExperimentFlags {
  const cached = flagsByScope.get(instanceScope);
  if (cached) return cached;
  const loaded = parseExperimentFlags(loadInstanceStorageValue(EXPERIMENTS_STORAGE_KEY, instanceScope));
  flagsByScope.set(instanceScope, loaded);
  return loaded;
}

export function setExperimentFlag(
  id: ExperimentId,
  enabled: boolean,
  instanceScope = LOCAL_INSTANCE_SCOPE,
): void {
  const next = { ...getExperimentFlags(instanceScope), [id]: enabled };
  flagsByScope.set(instanceScope, next);
  // Persistence is best-effort like every other preference; the in-memory value still wins
  // for this page's lifetime even when private mode rejects the write.
  saveInstanceStorageValue(EXPERIMENTS_STORAGE_KEY, JSON.stringify(next), instanceScope);
  for (const listener of listeners) listener();
}

export function subscribeExperimentFlags(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget cached flags so a fresh get() re-reads storage. */
export function resetExperimentFlagsForTest(): void {
  flagsByScope.clear();
}
