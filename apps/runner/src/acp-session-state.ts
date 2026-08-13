import type { AgentCapabilities, AgentModel, AgentSlashCommand, SessionConfig } from "@wollipog/protocol";

export interface SafeAcpMode {
  id: string;
  name: string;
  description?: string;
}

export interface SafeAcpModeState {
  currentModeId: string;
  availableModes: SafeAcpMode[];
}

export interface SafeAcpSelectValue {
  value: string;
  name: string;
  description?: string;
}

export interface SafeAcpConfigOption {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: SafeAcpSelectValue[];
}

export interface SafeAcpCommand {
  name: string;
  description?: string;
}

export interface SafeAcpUsage {
  contextTokensUsed: number;
  contextWindow: number;
  costUsd?: number;
}

export interface SafeAcpSessionInfo {
  title?: string | null;
  providerUpdatedAt?: string;
}

export function normalizeAcpModes(value: unknown): SafeAcpModeState | null {
  if (!isRecord(value)) return null;
  const currentModeId = boundedId(value.currentModeId);
  if (!currentModeId || !Array.isArray(value.availableModes)) return null;
  const availableModes: SafeAcpMode[] = [];
  const ids = new Set<string>();
  for (const candidate of value.availableModes) {
    if (availableModes.length >= 32) break;
    if (!isRecord(candidate)) continue;
    const id = boundedId(candidate.id);
    const name = boundedText(candidate.name, 160);
    if (!id || !name || ids.has(id)) continue;
    ids.add(id);
    const description = boundedText(candidate.description, 320);
    availableModes.push({ id, name, ...(description ? { description } : {}) });
  }
  return availableModes.some((mode) => mode.id === currentModeId)
    ? { currentModeId, availableModes }
    : null;
}

/** Wollipog currently maps only stable select options into its model/effort/mode controls. Boolean
 * options are deliberately ignored until a provider-neutral UI exists and the client advertises
 * the ACP boolean-option capability. */
export function normalizeAcpConfigOptions(value: unknown): SafeAcpConfigOption[] {
  if (!Array.isArray(value)) return [];
  const options: SafeAcpConfigOption[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (options.length >= 32) break;
    if (!isRecord(candidate) || candidate.type !== "select") continue;
    const id = boundedId(candidate.id);
    const name = boundedText(candidate.name, 160);
    const currentValue = boundedId(candidate.currentValue);
    if (!id || !name || !currentValue || ids.has(id)) continue;
    const values = flattenSelectValues(candidate.options);
    if (!values.some((entry) => entry.value === currentValue)) continue;
    ids.add(id);
    const category = boundedId(candidate.category);
    options.push({ id, name, currentValue, options: values, ...(category ? { category } : {}) });
  }
  return options;
}

export function normalizeAcpCommands(value: unknown): SafeAcpCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: SafeAcpCommand[] = [];
  const names = new Set<string>();
  for (const candidate of value) {
    if (commands.length >= 100) break;
    if (!isRecord(candidate)) continue;
    const name = boundedCommand(candidate.name);
    if (!name || names.has(name)) continue;
    names.add(name);
    const description = boundedText(candidate.description, 320);
    commands.push({ name, ...(description ? { description } : {}) });
  }
  return commands;
}

export function normalizeAcpUsage(value: unknown): SafeAcpUsage | null {
  if (!isRecord(value)) return null;
  const contextTokensUsed = safeUnsigned(value.used);
  const contextWindow = safeUnsigned(value.size);
  if (contextTokensUsed == null || contextWindow == null || contextWindow === 0) return null;
  const cost = isRecord(value.cost) ? value.cost : null;
  const amount = cost ? safeCost(cost.amount) : null;
  const currency = cost && typeof cost.currency === "string" ? cost.currency.toUpperCase() : "";
  return {
    contextTokensUsed,
    contextWindow,
    ...(amount != null && currency === "USD" ? { costUsd: amount } : {}),
  };
}

/** undefined means no title field/invalid input; null is the stable explicit-clear operation. */
export function normalizeAcpTitle(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  return boundedText(value, 120) ?? null;
}

export function normalizeAcpSessionInfo(value: unknown): SafeAcpSessionInfo | null {
  if (!isRecord(value)) return null;
  const info: SafeAcpSessionInfo = {};
  if (Object.prototype.hasOwnProperty.call(value, "title")) {
    const title = normalizeAcpTitle(value.title);
    if (title !== undefined) info.title = title;
  }
  if (typeof value.updatedAt === "string" && value.updatedAt.length <= 64) {
    const timestamp = Date.parse(value.updatedAt);
    if (Number.isFinite(timestamp)) info.providerUpdatedAt = new Date(timestamp).toISOString();
  }
  return Object.keys(info).length ? info : null;
}

export function acpSessionPresentation(
  modes: SafeAcpModeState | null,
  options: SafeAcpConfigOption[],
  commands: SafeAcpCommand[],
  supportsImages: boolean,
): { capabilities: AgentCapabilities; config: SessionConfig } {
  const model = optionForCategory(options, "model");
  const effort = optionForCategory(options, "thought_level");
  const modeOption = optionForCategory(options, "mode");
  const models: AgentModel[] = (model?.options ?? []).map((entry) => ({
    id: entry.value,
    displayName: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.value === model?.currentValue ? { default: true } : {}),
  }));
  const slashCommands: AgentSlashCommand[] = commands.map((command) => ({
    name: command.name,
    source: "builtin",
    ...(command.description ? { description: command.description } : {}),
  }));
  const permissionModes = modes?.availableModes.map((mode) => mode.id)
    ?? modeOption?.options.map((entry) => entry.value)
    ?? [];
  const elicitation = Object.fromEntries(
    permissionModes.map((mode) => [mode, ["acp-permission" as const]]),
  );
  return {
    capabilities: {
      models,
      effortLevels: effort?.options.map((entry) => entry.value) ?? [],
      slashCommands,
      supportsImages,
      supportsApprovals: true,
      ...(permissionModes.length ? { permissionModes, elicitation } : {}),
    },
    config: {
      ...(model ? { model: model.currentValue } : {}),
      ...(effort ? { effort: effort.currentValue } : {}),
      ...(modes ? { permissionMode: modes.currentModeId } : modeOption ? { permissionMode: modeOption.currentValue } : {}),
    },
  };
}

export function optionForCategory(
  options: SafeAcpConfigOption[],
  category: "model" | "thought_level" | "mode",
): SafeAcpConfigOption | undefined {
  return options.find((option) => option.category === category);
}

function flattenSelectValues(value: unknown): SafeAcpSelectValue[] {
  if (!Array.isArray(value)) return [];
  const values: SafeAcpSelectValue[] = [];
  const ids = new Set<string>();
  const add = (candidate: unknown) => {
    if (values.length >= 100 || !isRecord(candidate)) return;
    const id = boundedId(candidate.value);
    const name = boundedText(candidate.name, 160);
    if (!id || !name || ids.has(id)) return;
    ids.add(id);
    const description = boundedText(candidate.description, 320);
    values.push({ value: id, name, ...(description ? { description } : {}) });
  };
  for (const candidate of value) {
    if (isRecord(candidate) && Array.isArray(candidate.options)) {
      for (const grouped of candidate.options) add(grouped);
    } else {
      add(candidate);
    }
    if (values.length >= 100) break;
  }
  return values;
}

function boundedCommand(value: unknown): string | null {
  const command = boundedId(value);
  return command && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(command) ? command : null;
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function safeUnsigned(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
