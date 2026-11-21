import { useEffect, useSyncExternalStore } from "react";
import { isManagedModelChoice, managedModelChoiceId, type AgentDriverKind } from "@wollipog/protocol";
import bundledCatalog from "./model-picker-catalog.json";
import type { SelectOption } from "./components/ui/ChoiceControls.js";

interface ModelFamily {
  label: string;
  alias?: string;
  siblings?: boolean;
  releases: string[];
}

export interface ModelPickerCatalog {
  version: number;
  families: ModelFamily[];
}

export interface ModelPickerContext {
  mode: "launch" | "exact";
  driver?: AgentDriverKind;
}

export interface ModelPickerOption extends SelectOption<string> {
  /** A saved route can be shown without becoming a choice. */
  retained?: boolean;
  legacy?: boolean;
}

export interface ModelPickerFamily {
  name: string;
  options: ModelPickerOption[];
}

const movableRoutes = new Set([
  "deepseek-flash", "kimi-for-coding", "kimi-for-coding-highspeed",
  "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest",
]);
const claudeRoutes = new Set(["opus", "best", "fable", "sonnet", "haiku", "opusplan"]);

export function isExactModelChoice(id: string, driver?: AgentDriverKind): boolean {
  if (id === "default" || isManagedModelChoice(id) || movableRoutes.has(id)) return false;
  return driver !== "claude-code" || !claudeRoutes.has(id.split("[", 1)[0]!);
}

export function buildModelPicker(
  options: readonly SelectOption<string>[],
  value: string | null,
  { mode, driver }: ModelPickerContext,
  catalog: ModelPickerCatalog = bundledCatalog,
): { lead: ModelPickerOption[]; groups: ModelPickerFamily[]; trailing: ModelPickerOption[] } {
  const byId = new Map(options.map(option => [option.value, option]));
  const take = (id: string) => {
    const row = byId.get(id);
    byId.delete(id);
    return row ? { ...row, keywords: [...(row.keywords ?? []), id] } : undefined;
  };
  const lead: ModelPickerOption[] = [];
  for (const id of ["", "automatic", "__automatic__", "default"]) {
    if (mode === "launch" || id !== "default") {
      const option = take(id);
      if (option) lead.push(option);
    }
  }
  const groups: ModelPickerFamily[] = [];
  for (const family of catalog.families) {
    const rows: ModelPickerOption[] = [];
    let aliasName: string | undefined;
    if (driver === "claude-code" && family.alias) {
      const option = take(family.alias);
      const suffix = " (" + family.alias + ")";
      aliasName = option?.label.endsWith(suffix) ? option.label.slice(0, -suffix.length) : option?.label;
      if (option && mode === "launch") rows.push({
        ...option,
        label: family.label + " Latest",
        selectedLabel: family.label + " Latest",
        description: "Follows the version selected by the harness for new launches.",
      });
    }
    if (mode === "launch" && driver === "codex-app-server") {
      const id = managedModelChoiceId(family.label);
      const option = id ? take(id) : undefined;
      if (option) rows.push(option);
    }
    let foundCurrent = false;
    for (const id of family.releases) {
      const option = take(id);
      if (!option) continue;
      // The parenthetical id disambiguated this row from the alias before it was named Latest.
      const suffix = " (" + id + ")";
      const label = aliasName && option.label === aliasName + suffix ? aliasName : option.label;
      rows.push({ ...option, label, legacy: !family.siblings && foundCurrent });
      foundCurrent = true;
    }
    if (rows.length) groups.push({ name: family.label, options: rows });
  }
  const trailing: ModelPickerOption[] = [...byId.keys()].flatMap(id => {
    const option = take(id)!;
    if (mode === "exact" && !isExactModelChoice(id, driver)) return [];
    if (mode === "launch" && id === "deepseek-flash") return [{
      ...option, label: "DeepSeek Flash Latest", selectedLabel: "DeepSeek Flash Latest",
      description: "Follows the Flash release selected by DeepSeek.",
    }];
    return [option];
  });
  if (value && ![...lead, ...groups.flatMap(group => group.options), ...trailing].some(option => option.value === value)) {
    const original = options.find(option => option.value === value);
    trailing.unshift({
      label: original?.label ?? value,
      value,
      description: original
        ? "This is the saved model route. Choose a specific model to change it."
        : "This saved model is unavailable for the current harness.",
      retained: true,
    });
  }
  return { lead, groups, trailing };
}

export function parseModelPickerCatalog(input: unknown): ModelPickerCatalog | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<ModelPickerCatalog>;
  if (!Number.isSafeInteger(value.version) || value.version! < 1 || !Array.isArray(value.families) || value.families.length > 100) return null;
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const family of value.families) {
    if (!family || typeof family.label !== "string" || !family.label.trim() || family.label.length > 80 ||
        names.has(family.label) || !Array.isArray(family.releases) || !family.releases.length || family.releases.length > 100 ||
        (family.alias !== undefined && !["opus", "sonnet", "haiku", "fable"].includes(family.alias)) ||
        (family.siblings !== undefined && typeof family.siblings !== "boolean")) return null;
    names.add(family.label);
    for (const id of [...family.releases, ...(family.alias ? [family.alias] : [])]) {
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(id) || ids.has(id)) return null;
      ids.add(id);
    }
  }
  return value as ModelPickerCatalog;
}

let current = bundledCatalog as ModelPickerCatalog;
let attemptedAt = -Infinity;
const cacheKey = "wollipog-model-picker-catalog";

function replaceCatalog(value: unknown) {
  const catalog = parseModelPickerCatalog(value);
  if (!catalog || catalog.version <= current.version) return false;
  current = catalog;
  for (const listener of listeners) listener();
  return true;
}
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => current;

function refreshModelPickerCatalog() {
  if (Date.now() - attemptedAt < 15 * 60_000) return;
  attemptedAt = Date.now();
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached && cached.length <= 128_000) {
      const value = JSON.parse(cached) as { bundleVersion?: unknown; catalog?: unknown } | null;
      if (value?.bundleVersion === bundledCatalog.version) replaceCatalog(value.catalog);
    }
  } catch { /* Storage may be unavailable. */ }
  void fetch("/model-picker-catalog.json", { signal: AbortSignal.timeout(5_000) }).then(async response => {
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return;
    const contentLength = Number(response.headers.get("content-length"));
    if (contentLength > 128_000) return;
    const content = await response.text();
    if (content.length <= 128_000 && replaceCatalog(JSON.parse(content))) {
      localStorage.setItem(cacheKey, JSON.stringify({ bundleVersion: bundledCatalog.version, catalog: current }));
    }
  }).catch(() => { /* Keep the last usable catalog. */ });
}

export function useModelPickerCatalog(): ModelPickerCatalog {
  useEffect(refreshModelPickerCatalog, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
