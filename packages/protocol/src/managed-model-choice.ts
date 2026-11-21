import type { AgentCapabilities, AgentDriverKind, AgentModel } from "./index.js";

const familyKeyPrefix = "wollipog:latest:";
const families = [
  { key: "astra", label: "Astra" },
  { key: "sol", label: "Sol" },
  { key: "terra", label: "Terra" },
  { key: "luna", label: "Luna" },
] as const;

export function managedModelChoiceId(familyLabel: string): string | undefined {
  const family = families.find(candidate => candidate.label === familyLabel);
  return family ? familyKeyPrefix + family.key : undefined;
}

export function isManagedModelChoice(id: string | undefined): boolean {
  return id?.startsWith(familyKeyPrefix) ?? false;
}

const versions = new Intl.Collator("en", { numeric: true });

/** Managed preferences are currently supported only by live Codex App Server discovery.
 * Accept published release IDs in the explicit Codex family naming scheme. Other models remain
 * selectable by ID, even if a gateway happens to report a similar display label. */
export function resolveManagedModelChoice(
  driver: AgentDriverKind | undefined,
  capabilities: Pick<AgentCapabilities, "models" | "modelSource"> | undefined,
  id: string,
): AgentModel | undefined {
  if (driver !== "codex-app-server" || capabilities?.modelSource !== "live") return undefined;
  const family = families.find(candidate => familyKeyPrefix + candidate.key === id);
  if (!family) return undefined;
  let latest: AgentModel | undefined;
  for (const model of capabilities.models) {
    if (model.hidden || !/^gpt-\d+(?:\.\d+){0,2}-(?:astra|sol|terra|luna)$/.test(model.id) ||
      !model.id.endsWith("-" + family.key)) continue;
    if (!latest || versions.compare(model.id, latest.id) > 0) latest = model;
  }
  return latest;
}

/** These IDs are valid in saved settings only. Runner capabilities remain provider-owned. */
export function managedModelChoices(
  driver: AgentDriverKind | undefined,
  capabilities: Pick<AgentCapabilities, "models" | "modelSource"> | undefined,
): AgentModel[] {
  return families.flatMap(({ key, label }) => {
    const id = familyKeyPrefix + key;
    const model = resolveManagedModelChoice(driver, capabilities, id);
    if (!model) return [];
    return [{
      id,
      displayName: label + " Latest",
      description: "Wollipog chooses the latest available release when a new session starts. Currently " +
        (model.displayName ?? model.id) + ".",
      efforts: model.efforts,
      defaultEffort: model.defaultEffort,
    }];
  });
}
