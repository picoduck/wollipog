import type { AgentCapabilities, AgentDriverKind, AgentModel } from "./index.js";

const familyKeyPrefix = "wollipog:latest:";
const codexFamilies = [
  { key: "astra", label: "Astra" },
  { key: "sol", label: "Sol" },
  { key: "terra", label: "Terra" },
  { key: "luna", label: "Luna" },
] as const;

interface Family {
  key: string;
  label: string;
  matches: (id: string) => boolean;
}

const gptFamilies: Family[] = codexFamilies.map(({ key, label }) => ({
  key, label,
  matches: id => /^gpt-\d+(?:\.\d+){0,2}-(?:astra|sol|terra|luna)$/.test(id) && id.endsWith("-" + key),
}));
const piFamilies: Family[] = [
  ...gptFamilies.map(family => ({
    ...family,
    matches: (id: string) => id.startsWith("openai/") && family.matches(id.slice("openai/".length)),
  })),
  ...["Fable", "Opus", "Sonnet", "Haiku"].map(label => {
    const key = label.toLowerCase();
    const prefix = `anthropic/claude-${key}-`;
    return {
      key, label,
      // Claude's dateless 4.6+ IDs are fixed releases. Older short IDs are minor-version aliases.
      matches: (id: string) => {
        if (!id.startsWith(prefix)) return false;
        const version = /^([1-9]\d?)(?:-(0|[1-9]\d{0,2}))?$/.exec(id.slice(prefix.length));
        if (!version) return false;
        const major = Number(version[1]);
        return major >= 5 || (major === 4 && Number(version[2]) >= 6);
      },
    };
  }),
  { key: "glm-flagship", label: "GLM Flagship", matches: id => /^zai\/glm-5(?:\.\d{1,3})?$/.test(id) },
];

function managedFamilies(driver: AgentDriverKind | undefined): readonly Family[] {
  if (driver === "codex-app-server") return gptFamilies;
  return driver === "pi" ? piFamilies : [];
}

export function managedModelChoiceId(familyLabel: string): string | undefined {
  const family = piFamilies.find(candidate => candidate.label === familyLabel);
  return family ? familyKeyPrefix + family.key : undefined;
}

export function managedModelChoiceLabel(id: string): string | undefined {
  const family = piFamilies.find(candidate => familyKeyPrefix + candidate.key === id);
  return family && `${family.label} Latest`;
}

export function isManagedModelChoice(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(familyKeyPrefix);
}

export function managedModelFamilyLabel(driver: AgentDriverKind | undefined, id: string): string | undefined {
  return managedFamilies(driver).find(family => family.matches(id))?.label;
}

export const compareManagedModelVersions = new Intl.Collator("en", { numeric: true }).compare;

/** Only live, visible releases matching a curated driver and provider ID can resolve a choice. */
export function resolveManagedModelChoice(
  driver: AgentDriverKind | undefined,
  capabilities: Pick<AgentCapabilities, "models" | "modelSource"> | undefined,
  id: string,
): AgentModel | undefined {
  if (capabilities?.modelSource !== "live") return undefined;
  const family = managedFamilies(driver).find(candidate => familyKeyPrefix + candidate.key === id);
  if (!family) return undefined;
  let latest: AgentModel | undefined;
  for (const model of capabilities.models) {
    if (model.hidden || !family.matches(model.id)) continue;
    if (!latest || compareManagedModelVersions(model.id, latest.id) > 0) latest = model;
  }
  return latest;
}

/** A launch-setting choice and its current resolution. Never a runner model advertisement. */
export interface ManagedModelChoice extends AgentModel {
  resolvedModelId: string;
}

export function managedModelChoices(
  driver: AgentDriverKind | undefined,
  capabilities: Pick<AgentCapabilities, "models" | "modelSource"> | undefined,
): ManagedModelChoice[] {
  return managedFamilies(driver).flatMap(({ key, label }) => {
    const id = familyKeyPrefix + key;
    const model = resolveManagedModelChoice(driver, capabilities, id);
    if (!model) return [];
    return [{
      id,
      resolvedModelId: model.id,
      displayName: label + " Latest",
      description: "Wollipog chooses the latest available release when a new session starts. Currently " +
        (model.displayName ?? model.id) + ".",
      efforts: model.efforts,
      defaultEffort: model.defaultEffort,
    }];
  });
}

/** Resolve a launch choice without changing existing provider aliases or exact pins. */
export function launchModelChoice(
  driver: AgentDriverKind | undefined,
  capabilities: Pick<AgentCapabilities, "models" | "modelSource"> | undefined,
  id: string | undefined,
): AgentModel | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return id.startsWith(familyKeyPrefix)
    ? resolveManagedModelChoice(driver, capabilities, id)
    : capabilities?.models.find(model => model.id === id);
}
