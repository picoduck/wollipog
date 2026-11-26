/**
 * Model and Effort choices for an Assistant thread (New Thread and Settings → Assistant): the
 * models and efforts the harness's installation reports, after Automatic, the same way the
 * Orchestrator's Child Model and Child Effort list them.
 */
import type { AgentCapabilities, AgentModel, AssistantThreadHarnessOption } from "@wollipog/protocol";
import { modelOptionLabel } from "./agent-presentation.js";
import { effectiveModelEffortForDisplay } from "./caps.js";
import { effortLabel } from "./format.js";

/** The Select value that stands for null: the harness's or model's own default. */
export const AUTOMATIC = "__automatic__";

export interface AssistantModelChoice {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export const toChoice = (value: string | null): string => value ?? AUTOMATIC;
export const fromChoice = (value: string): string | null => value === AUTOMATIC ? null : value;

/** Whether this control plane lists a harness's models, so the fields can be offered at all. */
export function reportsModels(option: AssistantThreadHarnessOption | undefined): boolean {
  return Boolean(option?.models);
}

function modelOf(option: AssistantThreadHarnessOption | undefined, model: string | null): AgentModel | undefined {
  return model === null ? undefined : option?.models?.find((candidate) => candidate.id === model);
}

/**
 * The efforts a model accepts: its own list, else the installation's. For Automatic, the efforts of
 * the model the launch will pick, resolved the way the session's launch resolves it (the advertised
 * default, then the harness's preferred model, then the first compatible one). The installation's
 * list is a union across models, and an effort outside the resolved model's would be replaced.
 */
export function effortsFor(option: AssistantThreadHarnessOption | undefined, model: string | null): string[] {
  const installation = option?.effortLevels ?? [];
  if (model !== null) {
    const chosen = modelOf(option, model);
    return chosen?.efforts?.length ? chosen.efforts : installation;
  }
  if (!option?.models?.length || !option.driver) return installation;
  const capabilities = { models: option.models, effortLevels: installation } as unknown as AgentCapabilities;
  return effectiveModelEffortForDisplay(capabilities, option.driver, null).efforts;
}

export function assistantModelChoices(option: AssistantThreadHarnessOption | undefined, selected: string | null): AssistantModelChoice[] {
  const models = option?.models ?? [];
  const choices: AssistantModelChoice[] = [
    { value: AUTOMATIC, label: "Automatic", description: "Use the harness's own default model." },
    ...models.map((model) => ({
      value: model.id,
      label: modelOptionLabel(model, models),
      ...(model.description ? { description: model.description } : {}),
    })),
  ];
  if (selected !== null && !models.some((model) => model.id === selected)) {
    choices.push({ value: selected, label: `${selected} (Unavailable)`, disabled: true,
      description: "The harness no longer reports this model." });
  }
  return choices;
}

export function assistantEffortChoices(
  option: AssistantThreadHarnessOption | undefined,
  model: string | null,
  selected: string | null,
): AssistantModelChoice[] {
  const efforts = effortsFor(option, model);
  const choices: AssistantModelChoice[] = [
    { value: AUTOMATIC, label: "Automatic", description: "Use the model's own default effort." },
    ...efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
  ];
  if (selected !== null && !efforts.includes(selected)) {
    choices.push({ value: selected, label: `${effortLabel(selected)} (Unavailable)`, disabled: true,
      description: "The chosen model doesn't support this effort." });
  }
  return choices;
}

/** One sentence for a model or effort the harness no longer offers, or null when both are fine. */
export function modelEffortProblem(
  option: AssistantThreadHarnessOption | undefined,
  model: string | null,
  effort: string | null,
): { field: "model" | "effort"; message: string } | null {
  if (!reportsModels(option)) return null;
  if (model !== null && !modelOf(option, model)) {
    return { field: "model", message: "This model isn't available for the harness. Choose another model, or Automatic." };
  }
  if (effort !== null && !effortsFor(option, model).includes(effort)) {
    return { field: "effort", message: "This model doesn't support that effort. Choose another effort, or Automatic." };
  }
  return null;
}

/** After the model changes: keep the effort only if the new model accepts it. */
export function effortAfterModelChange(option: AssistantThreadHarnessOption | undefined, model: string | null, effort: string | null): string | null {
  return effort !== null && effortsFor(option, model).includes(effort) ? effort : null;
}
