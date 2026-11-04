import {
  agentContextKey,
  type AgentContext,
  type AgentDefinition,
  type BoxView,
  type HarnessInstallationSelection,
  type ProviderAccountDefinition,
  type RunnerView,
  type TargetHarnessInstallation,
} from "@wollipog/protocol";
import { agentDisplayName } from "./agent-presentation.js";
import { runnerDisplay } from "./runners.js";
import { statusMeta } from "./status-meta.js";

/**
 * Machine Settings as one form (#2991): what each field starts from, which fields changed against
 * the last saved snapshot, and the words its fields and its failure notice use. The dialog sends
 * only the changed fields, each through its own endpoint, in `fieldOrder`.
 */

export type DefaultAccountProvider = ProviderAccountDefinition["provider"];
export const DEFAULT_ACCOUNT_PROVIDERS: readonly DefaultAccountProvider[] = ["claude", "codex"];

/** Where Machine Settings opens: Change Limit… (#2989) at Capacity Limit, Choose Another
 * Installation… (#2990) at Agent Installations. */
export type MachineSettingsTarget = "capacity" | "installations";

export interface MachineSettingsValues {
  name: string;
  /** As typed: validated on blur and on save. */
  capacity: string;
  switching: boolean;
  /** Per provider, the chosen account id, or "" for No Default. */
  defaultAccounts: Partial<Record<DefaultAccountProvider, string>>;
  /** Per installation group, the chosen installation id, or null where none is saved. */
  installations: Record<string, string | null>;
}

/** The revisions each conditional write sends back, as last saved. */
export interface MachineSettingsRevisions {
  capacity: number;
  switching: number;
  defaultAccounts: Partial<Record<DefaultAccountProvider, number>>;
}

/** The last saved state: what the form compares against, and the revisions it writes with. */
export interface MachineSettingsSnapshot {
  values: MachineSettingsValues;
  revisions: MachineSettingsRevisions;
}

export type MachineSettingsField =
  | { kind: "name" }
  | { kind: "capacity" }
  | { kind: "switching" }
  | { kind: "defaultAccount"; provider: DefaultAccountProvider }
  | { kind: "installation"; group: string };

export const CAPACITY_HELPER = "In units, from 1 to 256. Sessions beyond the limit wait in a queue.";
export const CAPACITY_ERROR = "Enter a whole number from 1 to 256.";
export const SWITCHING_DESCRIPTION =
  "When an account reaches its usage limit, the next turn moves to another account from the same provider on this machine.";
export const DEFAULT_ACCOUNTS_HELPER = "Used by new sessions on this machine that don't choose an account.";
export const MISSING_INSTALLATION = "Saved choice not found. Choose another installation.";
export const DELETE_BLOCKED = "Stop the runner to delete.";
export const SAVED_TOAST = "Machine settings saved.";
const NAME_MAX = 120;

export function capacityError(text: string): string | null {
  const trimmed = text.trim();
  if (!/^\d+$/u.test(trimmed)) return CAPACITY_ERROR;
  const value = Number(trimmed);
  return value >= 1 && value <= 256 ? null : CAPACITY_ERROR;
}

/** What a capacity field saves: its whole number when valid, else its trimmed text, so a valid
 * value is compared as the number it sends ("024" equals a saved 24). */
function capacityValue(text: string): number | string {
  return capacityError(text) ? text.trim() : Number(text.trim());
}

export function nameError(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "Enter a name for this machine.";
  return trimmed.length > NAME_MAX ? `Use ${NAME_MAX} characters or fewer.` : null;
}

export function defaultAccountLabel(provider: DefaultAccountProvider): string {
  return provider === "claude" ? "Default Claude Account" : "Default Codex Account";
}

/** An account's sign-in in the shared provider account words (§11.2): Signed In, Sign-In Required
 * or Status Unknown. */
export function accountStatusLabel(authStatus: ProviderAccountDefinition["authStatus"]): string {
  return statusMeta("provider_account", authStatus === "authenticated" ? "signed_in"
    : authStatus === "unauthenticated" ? "sign_in_required" : "status_unknown").label;
}

/** The providers Default Accounts offers: each with an account on this machine or a saved choice. */
export function defaultAccountProviders(runner: RunnerView): DefaultAccountProvider[] {
  const accounts = runner.providerAccounts ?? [];
  const choices = runner.providerAccountDefaults ?? [];
  return DEFAULT_ACCOUNT_PROVIDERS.filter((provider) => accounts.some((account) => account.provider === provider) ||
    choices.some((choice) => choice.provider === provider));
}

/** A saved default account that this machine no longer lists. */
export function missingDefaultAccount(runner: RunnerView, provider: DefaultAccountProvider, accountId: string): boolean {
  return !!accountId && !(runner.providerAccounts ?? []).some((account) =>
    account.provider === provider && account.id === accountId);
}

/* ------------------------------------------------------------------------------------------------
 * Agent Installations
 * ---------------------------------------------------------------------------------------------- */

export interface InstallationRow {
  /** The installation id, which the group's radios carry. */
  value: string;
  path: string;
  version?: string;
  /** One status sentence, or why the row cannot be chosen. */
  sentence: string;
  /** A saved choice this machine no longer finds, or a target installation that is unavailable. */
  disabled: boolean;
  /** The agent row the native endpoint selects by; null for a missing saved choice. */
  agentId: string | null;
}

export type InstallationGroup = {
  key: string;
  /** Title Case: "Codex", "Claude Code in WSL (Ubuntu)", "Codex in Alpha Image". */
  label: string;
  rows: InstallationRow[];
  /** The saved installation id, or null when nothing is saved. */
  saved: string | null;
} & ({ kind: "native" } | { kind: "target"; targetId: string; agentId: string });

type HarnessFamily = HarnessInstallationSelection["family"];

/** The harness family a saved choice is keyed by, or null for an agent outside the three families. */
function harnessFamily(agent: AgentDefinition): HarnessFamily | null {
  return agent.driver === "claude-code" ? "claude" : agent.driver === "pi" ? "pi"
    : agent.driver === "codex-app-server" || agent.driver === "codex" ? "codex" : null;
}

const FAMILY_LABEL: Readonly<Record<HarnessFamily, string>> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

/** A group's harness name: the family's, or the agent's own name for any other agent. */
function harnessLabel(agent: AgentDefinition): string {
  const family = harnessFamily(agent);
  return family ? FAMILY_LABEL[family] : agentDisplayName(agent);
}

function withContext(label: string, context: AgentContext | undefined): string {
  return context?.kind === "wsl" ? `${label} in WSL (${context.distro})` : label;
}

const SIGN_IN_AGAIN = "Sign in to this installation, then rediscover.";

/** "Available. Signed in.", "Unavailable. Sign in to this installation, then rediscover." */
export function nativeInstallationSentence(agent: AgentDefinition): string {
  const availability = agent.available === true ? "Available." : agent.available === false ? "Unavailable." : "Not verified.";
  if (agent.authStatus === "unauthenticated") return `${availability} ${SIGN_IN_AGAIN}`;
  if (agent.available === false) {
    const reason = agent.unavailableReason ?? agent.codexAppServer?.failure?.message ?? agent.claudeCode?.failure?.message;
    return reason ? `${availability} ${reason}` : availability;
  }
  return agent.authStatus === "authenticated" ? `${availability} Signed in.` : availability;
}

export function targetInstallationSentence(installation: TargetHarnessInstallation): string {
  const availability = installation.available ? "Available." : "Unavailable.";
  if (installation.authentication === "unauthenticated") return `${availability} ${SIGN_IN_AGAIN}`;
  return installation.authentication === "authenticated" ? `${availability} Signed in.` : availability;
}

function missingRow(selection: { installationId: string; path: string; version?: string }): InstallationRow {
  return {
    value: selection.installationId,
    path: selection.path,
    ...(selection.version ? { version: selection.version } : {}),
    sentence: MISSING_INSTALLATION,
    disabled: true,
    agentId: null,
  };
}

/**
 * The radio groups of Agent Installations: one per harness and execution context with more than one
 * installation or a saved choice that is missing, and one per target and agent that offers
 * candidates. Codex's retired exec row is never a choice.
 */
export function installationGroups(runner: RunnerView): InstallationGroup[] {
  const native = new Map<string, {
    family: HarnessFamily | null;
    label: string;
    context: AgentContext | undefined;
    agents: AgentDefinition[];
  }>();
  const seen = new Set<string>();
  for (const agent of runner.agents) {
    if (!agent.installation || agent.driver === "codex") continue;
    const family = harnessFamily(agent);
    const label = harnessLabel(agent);
    // An agent outside the three families keeps a group of its own, under its own name.
    const key = `native:${family ?? `agent:${label}`}:${agentContextKey(agent.context)}`;
    const installationKey = `${key}:${agent.installation.id}`;
    if (seen.has(installationKey)) continue;
    seen.add(installationKey);
    const group = native.get(key) ?? { family, label, context: agent.context, agents: [] };
    group.agents.push(agent);
    native.set(key, group);
  }
  for (const selection of runner.harnessSelections ?? []) {
    const key = `native:${selection.family}:${agentContextKey(selection.context)}`;
    if (!native.has(key)) {
      native.set(key, { family: selection.family, label: FAMILY_LABEL[selection.family], context: selection.context, agents: [] });
    }
  }
  const groups: InstallationGroup[] = [];
  for (const [key, { family, label, context, agents }] of native) {
    const selection = family === null ? undefined : (runner.harnessSelections ?? []).find((item) =>
      item.family === family && agentContextKey(item.context) === agentContextKey(context));
    const missing = !!selection && selection.agentId === null &&
      !agents.some((agent) => agent.installation!.id === selection.installationId);
    if (agents.length < 2 && !missing) continue;
    groups.push({
      kind: "native",
      key,
      label: withContext(label, context),
      saved: selection?.installationId ?? null,
      rows: [
        ...agents.map((agent) => ({
          value: agent.installation!.id,
          path: agent.installation!.path,
          ...(agent.version ? { version: agent.version } : {}),
          sentence: nativeInstallationSentence(agent),
          disabled: false,
          agentId: agent.id,
        })),
        ...(missing ? [missingRow(selection)] : []),
      ],
    });
  }

  const targetSelections = runner.targetHarnessSelections ?? [];
  /** Target and agent pairs a group already lists, so a saved choice is shown once. */
  const listed = new Set<string>();
  const agentLabel = (agentId: string) => {
    const agent = runner.agents.find((candidate) => candidate.id === agentId);
    return agent ? harnessLabel(agent) : agentId;
  };
  for (const target of runner.executionTargets ?? []) {
    if ((target.adapter !== "container" && target.adapter !== "cloud") || !target.harnessInstallations?.length) continue;
    const agentIds = [...new Set(target.harnessInstallations.map((installation) => installation.agentId))];
    for (const agentId of agentIds) {
      listed.add(JSON.stringify([target.id, agentId]));
      const installations = target.harnessInstallations.filter((installation) => installation.agentId === agentId);
      const selection = targetSelections.find((item) => item.targetId === target.id && item.agentId === agentId);
      const missing = !!selection && !installations.some((installation) => installation.id === selection.installationId);
      groups.push({
        kind: "target",
        key: `target:${target.id}:${agentId}`,
        targetId: target.id,
        agentId,
        label: `${agentLabel(agentId)} in ${target.name}`,
        saved: selection?.installationId ?? null,
        rows: [
          ...installations.map((installation) => ({
            value: installation.id,
            path: installation.path,
            ...(installation.version ? { version: installation.version } : {}),
            sentence: targetInstallationSentence(installation),
            disabled: !installation.available,
            agentId,
          })),
          ...(missing ? [missingRow(selection)] : []),
        ],
      });
    }
  }
  // A saved choice whose target, or whose agent on that target, is no longer listed keeps its row
  // until another is chosen.
  for (const selection of targetSelections) {
    if (listed.has(JSON.stringify([selection.targetId, selection.agentId]))) continue;
    groups.push({
      kind: "target",
      key: `target:${selection.targetId}:${selection.agentId}`,
      targetId: selection.targetId,
      agentId: selection.agentId,
      label: `${agentLabel(selection.agentId)} in ${selection.targetName}`,
      saved: selection.installationId,
      rows: [missingRow(selection)],
    });
  }
  return groups;
}

/* ------------------------------------------------------------------------------------------------
 * The snapshot and what changed
 * ---------------------------------------------------------------------------------------------- */

/** The form as the machine has it saved, read once when the dialog opens. */
export function machineSettingsSnapshot(runner: RunnerView | undefined, box: BoxView | undefined): MachineSettingsSnapshot {
  const runnerId = runner?.runnerId ?? box?.runnerId ?? "";
  const configuredName = runner?.displayName ?? box?.displayName ?? "";
  const configuredCapacity = runner?.capacity?.configuredUnits ?? runner?.runtime?.maxConcurrentSessions;
  const defaultAccounts: MachineSettingsValues["defaultAccounts"] = {};
  const defaultRevisions: MachineSettingsRevisions["defaultAccounts"] = {};
  for (const provider of runner ? defaultAccountProviders(runner) : []) {
    const choice = runner?.providerAccountDefaults?.find((candidate) => candidate.provider === provider);
    defaultAccounts[provider] = choice?.accountId ?? "";
    defaultRevisions[provider] = choice?.revision ?? 0;
  }
  return {
    values: {
      name: configuredName || runnerDisplay(runner, box, runnerId).name,
      capacity: configuredCapacity?.toString() ?? "",
      switching: runner?.automaticAccountSwitching?.enabled ?? false,
      defaultAccounts,
      installations: Object.fromEntries((runner ? installationGroups(runner) : []).map((group) => [group.key, group.saved])),
    },
    revisions: {
      capacity: runner?.capacity?.revision ?? 0,
      switching: runner?.automaticAccountSwitching?.revision ?? 0,
      defaultAccounts: defaultRevisions,
    },
  };
}

/**
 * The fields this form shows, in the order Save Changes sends them: name, capacity, switching,
 * default accounts, installations. What this viewer or this machine does not offer is left out.
 */
export function fieldOrder(shown: {
  name: boolean;
  capacity: boolean;
  switching: boolean;
  defaultAccounts: readonly DefaultAccountProvider[];
  /** Installation group keys, in the order the form lists them. */
  installations: readonly string[];
}): MachineSettingsField[] {
  return [
    ...(shown.name ? [{ kind: "name" as const }] : []),
    ...(shown.capacity ? [{ kind: "capacity" as const }] : []),
    ...(shown.switching ? [{ kind: "switching" as const }] : []),
    ...DEFAULT_ACCOUNT_PROVIDERS.filter((provider) => shown.defaultAccounts.includes(provider))
      .map((provider) => ({ kind: "defaultAccount" as const, provider })),
    ...shown.installations.map((group) => ({ kind: "installation" as const, group })),
  ];
}

export function fieldChanged(field: MachineSettingsField, draft: MachineSettingsValues, saved: MachineSettingsValues): boolean {
  switch (field.kind) {
    case "name": return draft.name.trim() !== saved.name.trim();
    case "capacity": return capacityValue(draft.capacity) !== capacityValue(saved.capacity);
    case "switching": return draft.switching !== saved.switching;
    case "defaultAccount": return (draft.defaultAccounts[field.provider] ?? "") !== (saved.defaultAccounts[field.provider] ?? "");
    case "installation": return (draft.installations[field.group] ?? null) !== (saved.installations[field.group] ?? null);
  }
}

/** Copy one field's value from `from` into `into`: a saved field becomes the new baseline. */
export function withField(into: MachineSettingsValues, from: MachineSettingsValues, field: MachineSettingsField): MachineSettingsValues {
  switch (field.kind) {
    case "name": return { ...into, name: from.name.trim() };
    case "capacity": return { ...into, capacity: from.capacity.trim() };
    case "switching": return { ...into, switching: from.switching };
    case "defaultAccount":
      return { ...into, defaultAccounts: { ...into.defaultAccounts, [field.provider]: from.defaultAccounts[field.provider] ?? "" } };
    case "installation":
      return { ...into, installations: { ...into.installations, [field.group]: from.installations[field.group] ?? null } };
  }
}

/** A field's name in the failure notice: the label the form shows it under. */
export function fieldLabel(field: MachineSettingsField, groups: readonly InstallationGroup[]): string {
  switch (field.kind) {
    case "name": return "Machine Name";
    case "capacity": return "Capacity Limit";
    case "switching": return "Switch Accounts Automatically";
    case "defaultAccount": return defaultAccountLabel(field.provider);
    case "installation": return `${groups.find((group) => group.key === field.group)?.label ?? "Agent"} Installation`;
  }
}

/** "Capacity Limit wasn't saved.", "Machine Name and Capacity Limit weren't saved." */
export function unsavedSentence(labels: readonly string[]): string {
  const list = labels.length <= 1 ? labels.join("")
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return `${list} ${labels.length === 1 ? "wasn't" : "weren't"} saved.`;
}

/** What an offline machine's changes do. No field's endpoint needs the machine online: each saves
 * now, and the runner is sent its capacity and switching when it reconnects. */
export function offlineSentence(name: string): string {
  return `${name} is offline. Changes save now; Capacity Limit and automatic switching take effect when it reconnects.`;
}
