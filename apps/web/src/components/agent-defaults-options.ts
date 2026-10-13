import type {
  AgentDriverKind,
  AgentHarnessDefaultConfig,
  AgentHarnessDefaultOption,
  AgentModel,
} from "@wollipog/protocol";
import { effortLabel, permissionModeLabel, titleCaseLabel } from "../format.js";

/**
 * What an agent's defaults can be set to, read from every machine it is discovered on (Settings ›
 * Behavior › Agent Defaults, #3024). The row and its dialog share these, so the row's "Not
 * Configurable" and the dialog's fields can never disagree about what the agent offers.
 */

export function harnessIdentityKey(option: Pick<AgentHarnessDefaultOption, "agentId" | "driver" | "context">): string {
  return JSON.stringify([
    option.agentId,
    option.driver,
    option.context.kind,
    option.context.kind === "wsl" ? option.context.distro : "",
  ]);
}

export function uniqueModels(option: AgentHarnessDefaultOption): AgentModel[] {
  const models = new Map<string, AgentModel>();
  for (const installation of option.installations) {
    for (const model of installation.models) {
      const current = models.get(model.id);
      models.set(model.id, current ? {
        ...current,
        efforts: [...new Set([...(current.efforts ?? []), ...(model.efforts ?? [])])],
      } : model);
    }
  }
  return [...models.values()].sort((left, right) =>
    (left.displayName ?? left.id).localeCompare(right.displayName ?? right.id) || left.id.localeCompare(right.id));
}

export function effortsForModel(option: AgentHarnessDefaultOption, modelId: string): string[] {
  const efforts = new Set<string>();
  for (const installation of option.installations) {
    const model = installation.models.find((candidate) => candidate.id === modelId);
    if (!model) continue;
    for (const effort of model.efforts?.length ? model.efforts : installation.effortLevels) efforts.add(effort);
  }
  return [...efforts].sort();
}

export function harnessEfforts(option: AgentHarnessDefaultOption): string[] {
  return [...new Set(option.installations.flatMap((installation) => installation.effortLevels))].sort();
}

/** The efforts a draft can choose from: its model's, or the agent's own when it lists no models. */
export function effortsForDraft(option: AgentHarnessDefaultOption, draft: Pick<AgentHarnessDefaultConfig, "model">): string[] {
  if (draft.model) return effortsForModel(option, draft.model);
  return uniqueModels(option).length === 0 ? harnessEfforts(option) : [];
}

function installationsSupportingDraft(
  option: AgentHarnessDefaultOption,
  draft: Pick<AgentHarnessDefaultConfig, "model" | "effort">,
): AgentHarnessDefaultOption["installations"] {
  return option.installations.filter((installation) => {
    const model = draft.model
      ? installation.models.find((candidate) => candidate.id === draft.model)
      : undefined;
    if (draft.model && !model) return false;
    const efforts = model?.efforts?.length ? model.efforts : installation.effortLevels;
    return !draft.effort || efforts.includes(draft.effort);
  });
}

/** Only the modes a machine offers together with the chosen model and effort. */
export function permissionModesForDraft(
  option: AgentHarnessDefaultOption,
  draft: Pick<AgentHarnessDefaultConfig, "model" | "effort">,
): string[] {
  return [...new Set(installationsSupportingDraft(option, draft)
    .flatMap((installation) => installation.permissionModes))].sort();
}

export function permissionModeDisplayLabel(mode: string, driver: AgentDriverKind): string {
  const label = permissionModeLabel(mode, driver);
  return label === mode ? titleCaseLabel(mode.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ")) : label;
}

/** Whether the agent offers anything to choose: a model, an effort or a permission mode. */
export function isConfigurable(option: AgentHarnessDefaultOption): boolean {
  return option.installations.some((installation) =>
    installation.models.length > 0 || installation.effortLevels.length > 0 || installation.permissionModes.length > 0);
}

/** Drops whatever the agent no longer offers, so a saved choice never names a missing option. */
export function repairDraft(
  option: AgentHarnessDefaultOption,
  candidate: AgentHarnessDefaultConfig,
): AgentHarnessDefaultConfig {
  const next = { ...candidate };
  if (next.model && !uniqueModels(option).some((model) => model.id === next.model)) {
    delete next.model;
    delete next.effort;
  }
  if (next.effort && !effortsForDraft(option, next).includes(next.effort)) delete next.effort;
  if (next.permissionMode && !permissionModesForDraft(option, next).includes(next.permissionMode)) {
    delete next.permissionMode;
  }
  return next;
}

export function repairedDraftFields(
  candidate: AgentHarnessDefaultConfig,
  repaired: AgentHarnessDefaultConfig,
): string[] {
  const fields: string[] = [];
  if (candidate.model && candidate.model !== repaired.model) fields.push("Model");
  if (candidate.effort && candidate.effort !== repaired.effort) fields.push("Reasoning Effort");
  if (candidate.permissionMode && candidate.permissionMode !== repaired.permissionMode) fields.push("Permission Mode");
  return fields;
}

export function draftRepairNotice(fields: string[]): string | null {
  if (fields.length === 0) return null;
  const names = fields.length === 1
    ? fields[0]
    : `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}`;
  return `Capabilities changed. Removed unavailable draft selections for ${names}.`;
}

/**
 * The row's description (§17): what is set as a sentence-case list, "Luna, low effort, Approve for
 * Me", or "Uses Wollipog defaults"; then where the saved choice can apply when that is not every
 * machine. Model and permission-mode names keep their own casing; an effort is a plain word.
 */
export function agentDefaultsDescription(option: AgentHarnessDefaultOption): string {
  const preference = option.preference;
  const parts = preference ? [
    preference.model
      ? uniqueModels(option).find((model) => model.id === preference.model)?.displayName ?? preference.model
      : undefined,
    preference.effort ? `${effortLabel(preference.effort).toLowerCase()} effort` : undefined,
    preference.permissionMode ? permissionModeDisplayLabel(preference.permissionMode, option.driver) : undefined,
  ].filter((part): part is string => !!part) : [];
  const listed = parts.join(", ");
  // A model's name is shown as the agent spells it; a leading effort starts the sentence.
  const summary = !listed
    ? "Uses Wollipog defaults"
    : preference?.model ? listed : `${listed.charAt(0).toUpperCase()}${listed.slice(1)}`;
  if (option.compatibleInstallations === 0) return `${summary}. Not available on any machine.`;
  if (option.compatibleInstallations < option.installations.length) {
    const total = option.installations.length;
    return `${summary}. Available on ${option.compatibleInstallations} of ${total} machine${total === 1 ? "" : "s"}.`;
  }
  return summary;
}
