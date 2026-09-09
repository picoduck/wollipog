/**
 * Context-window variants of one base model (protocol v120 `AgentModel.baseModelId`). Pure and
 * framework-free: the composer's model menu, the context meter, and their tests share this file.
 *
 * A "real choice" exists only when the provider's own catalog lists two or more launchable ids for
 * the same base with distinct, provider-stated context windows. Nothing here derives a window from
 * a model name; an id without catalog evidence simply has no window to offer.
 */

import type { AgentModel } from "@wollipog/protocol";

export interface ContextWindowOption {
  /** The launchable model id that selects this window (`opus[1m]`). */
  id: string;
  contextWindow: number;
  /** "200K", "1M" — the label users see and read in the composer and the meter. */
  label: string;
  /** The variant's own advertised reasoning efforts, when it advertises any. Empty or absent means
   * it inherits the agent's effort levels, which the currently selected variant also uses. */
  efforts?: string[];
}

export interface ContextWindowChoice {
  baseModelId: string;
  /** Ascending by window size. */
  options: ContextWindowOption[];
  /** The option matching the session's selected model, if it is one of them. */
  selectedId: string | null;
}

/** 200000 → "200K", 1000000 → "1M", 272000 → "272K", 1500000 → "1.5M". */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function modelBaseId(model: Pick<AgentModel, "id" | "baseModelId">): string {
  return model.baseModelId ?? model.id;
}

function knownWindow(model: AgentModel): number | null {
  return typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : null;
}

/** Members of the selected model's base group that a user may pick: visible entries, plus the
 * selected one even when the catalog hides it (a persisted alias). */
function groupMembers(models: AgentModel[], baseModelId: string, selectedModelId: string | null | undefined): AgentModel[] {
  return models.filter((model) => modelBaseId(model) === baseModelId && (!model.hidden || model.id === selectedModelId));
}

function optionsFor(members: AgentModel[]): ContextWindowOption[] {
  const byWindow = new Map<number, AgentModel>();
  for (const member of members) {
    const window = knownWindow(member);
    if (window != null && !byWindow.has(window)) byWindow.set(window, member);
  }
  return [...byWindow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([contextWindow, member]) => ({
      id: member.id,
      contextWindow,
      label: formatContextWindow(contextWindow),
      ...(member.efforts?.length ? { efforts: member.efforts } : {}),
    }));
}

/** The Context Window choice for the selected model, or null when the catalog offers no real one:
 * fewer than two variants of its base carry a provider-stated window. */
export function contextWindowChoice(
  models: AgentModel[],
  selectedModelId: string | null | undefined,
): ContextWindowChoice | null {
  if (!selectedModelId) return null;
  const selected = models.find((model) => model.id === selectedModelId);
  if (!selected) return null;
  const baseModelId = modelBaseId(selected);
  const options = optionsFor(groupMembers(models, baseModelId, selectedModelId));
  if (options.length < 2) return null;
  return {
    baseModelId,
    options,
    selectedId: options.some((option) => option.id === selectedModelId) ? selectedModelId : null,
  };
}

/** Whether a window variant accepts the effort the session currently has selected. Mirrors the
 * control plane's own rule exactly (`capabilityConfigError` in apps/control-plane/src/sessions.ts:
 * `selectedModel?.efforts?.length ? selectedModel.efforts : capabilities.effortLevels`), because an
 * effort this returns false for is a 409 rather than a config change. A variant advertising no
 * efforts of its own inherits the agent's levels, so those are what it must be checked against —
 * the currently displayed effort can be stale after discovery narrows them. When the effort cannot
 * carry over the caller clears it and the target variant's own default applies. */
export function contextWindowOptionAcceptsEffort(
  option: ContextWindowOption,
  effort: string,
  agentEffortLevels: readonly string[] | undefined,
): boolean {
  if (!effort) return false;
  const supported = option.efforts?.length ? option.efforts : agentEffortLevels ?? [];
  return supported.includes(effort);
}

/** "Opus 5 (1M Context)" → "Opus 5": the window moves to the Context Window control. */
export function baseDisplayName(model: Pick<AgentModel, "id" | "displayName">): string {
  const raw = (model.displayName ?? model.id).trim();
  const stripped = raw.replace(/\s*\((?:[^()]*\bcontext\b[^()]*)\)\s*$/iu, "").trim();
  return stripped || raw;
}

/** Model-picker entries with each real context-window choice collapsed into one base entry. The
 * entry keeps the id of the member the session already selects, else the plain base id, else the
 * first listed variant, so choosing a model never silently changes an explicit window selection.
 * Groups without a real choice pass through untouched (including every `default` alias). */
export function collapseContextWindowVariants(
  models: AgentModel[],
  selectedModelId: string | null | undefined,
): AgentModel[] {
  const out: AgentModel[] = [];
  const collapsed = new Set<string>();
  for (const model of models) {
    const baseModelId = modelBaseId(model);
    if (collapsed.has(baseModelId)) continue;
    const members = groupMembers(models, baseModelId, selectedModelId);
    if (optionsFor(members).length < 2) {
      out.push(model);
      continue;
    }
    collapsed.add(baseModelId);
    const representative = members.find((member) => member.id === selectedModelId)
      ?? members.find((member) => member.id === baseModelId)
      ?? members[0]!;
    out.push({
      ...representative,
      displayName: baseDisplayName(representative),
      // The collapsed entry stands for the whole base; a variant's own default flag would make the
      // picker claim a default the provider attached to one window only.
      default: members.some((member) => member.default),
      hidden: members.every((member) => member.hidden),
    });
  }
  return out;
}

export interface ContextWindowDiscrepancy {
  advertised: number;
  served: number;
  kind: "smaller" | "larger";
}

/** The provider served a different window than the selected model's catalog entry advertises —
 * a silent downgrade (or an unadvertised upgrade) the meter must name rather than hide. */
export function contextWindowDiscrepancy(
  advertised: number | null | undefined,
  served: number | null | undefined,
): ContextWindowDiscrepancy | null {
  if (!advertised || !served || advertised <= 0 || served <= 0 || advertised === served) return null;
  return { advertised, served, kind: served < advertised ? "smaller" : "larger" };
}

/** The exact selected model's provider-stated window; no family or default fallback, because a
 * discrepancy check against a substitute entry would report the wrong expectation. */
export function advertisedContextWindow(models: AgentModel[], selectedModelId: string | null | undefined): number | null {
  if (!selectedModelId) return null;
  const model = models.find((candidate) => candidate.id === selectedModelId);
  return model ? knownWindow(model) : null;
}
