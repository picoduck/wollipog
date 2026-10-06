import {
  SLASH_COMMAND_NAME_CHARACTERS,
  isSlashCommandName,
  isSlashCommandNameCharacter,
  type AgentDriverKind,
  type AgentSlashCommand,
  type UnsupportedSlashCommand,
} from "@wollipog/protocol";

export type ComposerCommandSource = "app" | "provider";

export type ComposerCommandExecutionMode = "app" | "structured" | "passthrough";

/**
 * - preserve: the command does not consume attachments, so they remain in the composer.
 * - send: attachments are included with the command invocation.
 * - forbid: the command cannot run while attachments are present.
 */
export type ComposerCommandAttachmentPolicy = "preserve" | "send" | "forbid";

/** The picker's groups name a command's source: Wollipog itself, the agent, the agent's skills, or
 * the prompts its MCP servers expose (#1224). */
export type ComposerCommandGroupId = "app" | "provider" | "skill" | "mcp";

export interface ComposerCommandContext {
  planSupported: boolean;
  canStopTurn: boolean;
  canRespond?: boolean;
  /** The agent's display name, which labels its own commands' group. */
  agentLabel?: string;
}

export interface ProviderComposerCommand {
  id?: string;
  name: string;
  description?: string;
  providerSource?: AgentSlashCommand["source"];
  argumentHint?: string;
  executionMode?: Exclude<ComposerCommandExecutionMode, "app">;
  attachmentPolicy?: ComposerCommandAttachmentPolicy;
  /** Opaque runner-authored coordinates. Their absence keeps rolling-compatible legacy
   * passthrough, but only their presence may use the durable v75 invocation endpoint. */
  providerCommandId?: string;
  catalogRevision?: string;
  available?: boolean;
  disabledReason?: string;
}

export interface ComposerCommand {
  /** Stable registry identity. This is distinct from the user-visible invocation token. */
  id: string;
  /** Dispatch name without the leading slash; provider-advertised casing is preserved. */
  name: string;
  /** User-visible invocation label, including the leading slash: the token the picker shows. */
  label: string;
  /** Durable token inserted after the slash. Collisions use an explicit namespace. */
  invocationAlias: string;
  description?: string;
  source: ComposerCommandSource;
  sourceLabel: string;
  providerSource?: ProviderComposerCommand["providerSource"];
  providerCommandId?: string;
  catalogRevision?: string;
  executionMode: ComposerCommandExecutionMode;
  available: boolean;
  disabledReason?: string;
  argumentHint?: string;
  attachmentPolicy: ComposerCommandAttachmentPolicy;
  groupId: ComposerCommandGroupId;
  groupLabel: string;
  /** A command the agent knows but Wollipog won't send (#1224): never offered by a menu, but a
   * message that names it in full resolves to it, so its reason is shown instead of sending it. */
  hidden?: boolean;
}

/** The note for a command that keeps the attached images for the next message, naming the command by
 * the token the person typed ("/review"). */
export function durableCommandAttachmentNote(commandLabel: string): string {
  return `${commandLabel} doesn't send images. They stay here for your next message.`;
}

export function durableCommandPreservesAttachments(
  command: ComposerCommand | undefined,
  hasAttachments: boolean,
): boolean {
  return hasAttachments && command?.source === "provider" &&
    Boolean(command.providerCommandId && command.catalogRevision) &&
    command.attachmentPolicy === "preserve";
}

export interface ComposerCommandGroupMetadata {
  id: ComposerCommandGroupId;
  label: string;
  order: number;
}

export interface ComposerCommandTrigger {
  /** Inclusive start of the slash token. */
  start: number;
  /** Exclusive end of the slash token. */
  end: number;
  /** Query typed between the slash and caret. */
  query: string;
  /** Complete slash token, including any suffix after the caret. */
  raw: string;
  /** `$` when the token is a Codex-style skill reference; absent for a slash command. */
  sigil?: "$";
}

export type ComposerCommandResolution =
  | { kind: "plaintext"; text: string }
  | { kind: "command"; command: ComposerCommand; arguments: string; originalText: string }
  /** A message that starts with a slash token naming no command (#2176). It is never sent as it
   * stands: `token` is the typed token, slash included, and `suggestions` are up to three
   * available commands within a small edit distance of it, closest first. */
  | { kind: "unknown"; token: string; suggestions: ComposerCommand[] };

export interface ComposerCommandResolutionOptions {
  /** Whether `$name` names a skill: Codex's spelling. Claude Code invokes its skills as `/name`,
   * so a `$` there stays text (#1224). */
  skillSigil?: boolean;
  /** `reject` (the default) resolves an unmatched slash token as `unknown`; `plaintext` keeps the
   * fallback that forwards it as ordinary text, for a session whose catalog can't name every
   * command its agent runs. */
  unknownCommands?: "reject" | "plaintext";
  /** Lowercase names the agent advertises that the registry can't list (see
   * `unlistedCommandNames`). A token naming one is sent as text, as before #2176, rather than
   * refused as unknown. */
  unlistedNames?: ReadonlySet<string>;
}

export type ComposerCommandMatchKind = "none" | "exact" | "prefix" | "boundary" | "substring" | "fuzzy";

export interface RankedComposerCommand {
  command: ComposerCommand;
  matchKind: ComposerCommandMatchKind;
  score: number;
}

/** The provider group's label when the agent has no display name. */
export const AGENT_COMMAND_GROUP_FALLBACK_LABEL = "Agent";

// Skills share the provider order, so splitting them into their own group changes no ranking.
export const COMPOSER_COMMAND_GROUPS: readonly ComposerCommandGroupMetadata[] = [
  { id: "app", label: "Wollipog", order: 0 },
  { id: "provider", label: AGENT_COMMAND_GROUP_FALLBACK_LABEL, order: 1 },
  { id: "skill", label: "Skills", order: 1 },
  { id: "mcp", label: "MCP Prompts", order: 1 },
] as const;

const GROUP_BY_ID = new Map(COMPOSER_COMMAND_GROUPS.map((group) => [group.id, group]));
const PROVIDER_SOURCE_LABELS: Record<NonNullable<ProviderComposerCommand["providerSource"]>, string> = {
  builtin: "Built-In",
  user: "User",
  project: "Project",
  plugin: "Plugin",
  skill: "Skill",
  mcp: "MCP",
};

const PROVIDER_INVOCATION_PRECEDENCE: Record<NonNullable<ProviderComposerCommand["providerSource"]>, number> = {
  user: 0,
  project: 1,
  skill: 2,
  plugin: 3,
  mcp: 4,
  builtin: 4,
};

/** The runner advertises only names the shared grammar accepts (#2602), so this drops nothing a
 * current runner sends. */
function advertisedName(value: string): { name: string; comparisonName: string } | null {
  const name = value.trim();
  return isSlashCommandName(name) ? { name, comparisonName: name.toLowerCase() } : null;
}

/** The names an agent advertises that the shared grammar can't list, lowercased. They are real
 * commands, so the unknown-command rule must not refuse them. A runner from before #2602 can still
 * send one (Pi names went unchecked); a current runner drops them before advertising. */
export function unlistedCommandNames(commands: readonly Pick<AgentSlashCommand, "name">[]): Set<string> {
  const names = new Set<string>();
  for (const command of commands) {
    const name = command.name.trim().replace(/^\//, "");
    if (name && !/\s/u.test(name) && !advertisedName(name)) names.add(name.toLowerCase());
  }
  return names;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function commandLabel(invocationAlias: string): string {
  return `/${invocationAlias}`;
}

function appCommands(context: ComposerCommandContext): ComposerCommand[] {
  const appGroup = GROUP_BY_ID.get("app")!;
  return [
    {
      id: "app:rename-session",
      name: "rename-session",
      label: commandLabel("rename-session"),
      invocationAlias: "rename-session",
      description: "Rename this session from its conversation.",
      source: "app",
      sourceLabel: "App",
      executionMode: "app",
      available: true,
      attachmentPolicy: "preserve",
      groupId: appGroup.id,
      groupLabel: appGroup.label,
    },
    {
      id: "app:plan",
      name: "plan",
      label: commandLabel("plan"),
      invocationAlias: "plan",
      description: "Toggle plan mode without allowing edits.",
      source: "app",
      sourceLabel: "App",
      executionMode: "app",
      available: context.planSupported,
      ...(context.planSupported ? {} : { disabledReason: "Plan mode is unavailable for this provider." }),
      argumentHint: "[on|off]",
      attachmentPolicy: "preserve",
      groupId: appGroup.id,
      groupLabel: appGroup.label,
    },
    {
      id: "app:respond",
      name: "respond",
      label: commandLabel("respond"),
      invocationAlias: "respond",
      description: "Enter Answer Mode for the pending structured question.",
      source: "app",
      sourceLabel: "App",
      executionMode: "app",
      available: context.canRespond === true,
      ...(context.canRespond === true ? {} : { disabledReason: "There is no pending question." }),
      attachmentPolicy: "preserve",
      groupId: appGroup.id,
      groupLabel: appGroup.label,
    },
    {
      id: "app:stop",
      name: "stop",
      label: commandLabel("stop"),
      invocationAlias: "stop",
      description: "Stop the active turn without ending the session.",
      source: "app",
      sourceLabel: "App",
      executionMode: "app",
      available: context.canStopTurn,
      ...(context.canStopTurn ? {} : { disabledReason: "There's no turn to stop right now." }),
      attachmentPolicy: "preserve",
      groupId: appGroup.id,
      groupLabel: appGroup.label,
    },
  ];
}

function providerStableId(command: ProviderComposerCommand, name: string): string {
  const explicit = optionalText(command.id)?.toLowerCase();
  return explicit ? `provider:${explicit}` : `provider:${command.providerSource ?? "harness"}:${name}`;
}

function invocationIdQualifier(id: string): string {
  return id.replace(/^provider:/, "").replace(/[^\p{L}\p{N}_.-]+/gu, "-").toLowerCase();
}

/** An injective, alias-safe suffix used only when lossy qualifier sanitization collides. */
function collisionSafeQualifierSuffix(id: string): string {
  return [...id.replace(/^provider:/, "")]
    .map((character) => character.codePointAt(0)!.toString(16))
    .join(".");
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeProviderCommands(commands: readonly ProviderComposerCommand[]): Array<{
  input: ProviderComposerCommand;
  id: string;
  name: string;
  comparisonName: string;
}> {
  const normalized = commands.flatMap((input) => {
    const parsed = advertisedName(input.name);
    return parsed
      ? [{ input, id: providerStableId(input, parsed.comparisonName), ...parsed }]
      : [];
  });
  normalized.sort((left, right) =>
    ordinalCompare(left.id, right.id)
    || ordinalCompare(left.comparisonName, right.comparisonName)
    || ordinalCompare(left.name, right.name)
    || ordinalCompare(left.input.description ?? "", right.input.description ?? ""));

  const seenIds = new Set<string>();
  return normalized.filter((command) => {
    if (seenIds.has(command.id)) return false;
    seenIds.add(command.id);
    return true;
  });
}

/** Map wire-safe provider metadata into the web registry. Passthrough commands retain the existing
 * attachment path; callers may inject a stricter policy when their transport owns that metadata. */
export function mapProviderComposerCommands(
  commands: readonly AgentSlashCommand[],
  attachmentPolicy: ProviderComposerCommand["attachmentPolicy"] = "send",
): ProviderComposerCommand[] {
  return commands.map((command) => {
    const hasInvocation = Object.prototype.hasOwnProperty.call(command, "invocation");
    const rawInvocation = (command as AgentSlashCommand & { invocation?: unknown }).invocation;
    const validInvocation = rawInvocation && typeof rawInvocation === "object" &&
      typeof (rawInvocation as { id?: unknown }).id === "string" &&
      Boolean((rawInvocation as { id: string }).id) &&
      typeof (rawInvocation as { catalogRevision?: unknown }).catalogRevision === "string" &&
      Boolean((rawInvocation as { catalogRevision: string }).catalogRevision) &&
      ((rawInvocation as { executionMode?: unknown }).executionMode === "passthrough" ||
        (rawInvocation as { executionMode?: unknown }).executionMode === "structured")
      ? rawInvocation as NonNullable<AgentSlashCommand["invocation"]>
      : null;
    return {
      name: command.name,
      description: command.description,
      providerSource: command.source,
      argumentHint: command.argumentHint,
      executionMode: validInvocation?.executionMode ?? "passthrough",
      attachmentPolicy: hasInvocation ? "preserve" : attachmentPolicy,
      ...(validInvocation ? {
        providerCommandId: validInvocation.id,
        catalogRevision: validInvocation.catalogRevision,
      } : {}),
      ...(hasInvocation && !validInvocation ? {
        available: false,
        disabledReason: "Provider command authority is invalid. Refresh the session before retrying.",
      } : {}),
    };
  });
}

export function buildComposerCommandRegistry(input: {
  context: ComposerCommandContext;
  providerCommands?: readonly ProviderComposerCommand[];
  /** Commands the session reports it can't run here, each with its reason (#1224). */
  unsupportedCommands?: readonly UnsupportedSlashCommand[];
}): ComposerCommand[] {
  const apps = appCommands(input.context);
  const appNames = new Set(apps.map((command) => command.name));
  const providers = normalizeProviderCommands(input.providerCommands ?? []);
  const providersByName = new Map<string, number>();
  const providersByNameAndSource = new Map<string, number>();
  for (const command of providers) {
    providersByName.set(command.comparisonName, (providersByName.get(command.comparisonName) ?? 0) + 1);
    const sourceKey = `${command.comparisonName}\u0000${command.input.providerSource ?? "provider"}`;
    providersByNameAndSource.set(sourceKey, (providersByNameAndSource.get(sourceKey) ?? 0) + 1);
  }
  const sanitizedQualifierCounts = new Map<string, number>();
  for (const command of providers) {
    const providerNamespace = command.input.providerSource ?? "provider";
    const sourceKey = `${command.comparisonName}\u0000${providerNamespace}`;
    if ((providersByNameAndSource.get(sourceKey) ?? 0) < 2) continue;
    const qualifierKey = `${sourceKey}\u0000${invocationIdQualifier(command.id)}`;
    sanitizedQualifierCounts.set(qualifierKey, (sanitizedQualifierCounts.get(qualifierKey) ?? 0) + 1);
  }
  const providerGroup = GROUP_BY_ID.get("provider")!;
  const skillGroup = GROUP_BY_ID.get("skill")!;
  const mcpGroup = GROUP_BY_ID.get("mcp")!;
  const agentGroupLabel = optionalText(input.context.agentLabel) ?? providerGroup.label;
  const providerCommands = providers.map(({ input: provider, id, name, comparisonName }): ComposerCommand => {
    const duplicateProviderName = (providersByName.get(comparisonName) ?? 0) > 1;
    const collidesWithApp = appNames.has(comparisonName);
    const providerNamespace = provider.providerSource ?? "provider";
    const sourceKey = `${comparisonName}\u0000${providerNamespace}`;
    const duplicateProviderSource = (providersByNameAndSource.get(sourceKey) ?? 0) > 1;
    const sanitizedQualifier = invocationIdQualifier(id);
    const qualifierKey = `${sourceKey}\u0000${sanitizedQualifier}`;
    const idQualifier = (sanitizedQualifierCounts.get(qualifierKey) ?? 0) > 1
      ? `${sanitizedQualifier}:${collisionSafeQualifierSuffix(id)}`
      : sanitizedQualifier;
    const invocationAlias = duplicateProviderName
      ? `${providerNamespace}:${comparisonName}${duplicateProviderSource ? `:${idQualifier}` : ""}`
      : collidesWithApp
        ? `provider:${comparisonName}`
        : comparisonName;
    const available = provider.available !== false;
    return {
      id,
      name,
      label: `/${invocationAlias}`,
      invocationAlias,
      ...(optionalText(provider.description) ? { description: optionalText(provider.description) } : {}),
      source: "provider",
      // A source newer than this client still renders as a harness command.
      sourceLabel: (provider.providerSource && PROVIDER_SOURCE_LABELS[provider.providerSource]) || "Harness",
      ...(provider.providerSource ? { providerSource: provider.providerSource } : {}),
      ...(provider.providerCommandId ? { providerCommandId: provider.providerCommandId } : {}),
      ...(provider.catalogRevision ? { catalogRevision: provider.catalogRevision } : {}),
      executionMode: provider.executionMode ?? "passthrough",
      available,
      ...(!available
        ? { disabledReason: optionalText(provider.disabledReason) ?? "This command is unavailable." }
        : {}),
      ...(optionalText(provider.argumentHint) ? { argumentHint: optionalText(provider.argumentHint) } : {}),
      attachmentPolicy: provider.attachmentPolicy ?? "send",
      ...(provider.providerSource === "skill"
        ? { groupId: skillGroup.id, groupLabel: skillGroup.label }
        : provider.providerSource === "mcp"
          ? { groupId: mcpGroup.id, groupLabel: mcpGroup.label }
          : { groupId: providerGroup.id, groupLabel: agentGroupLabel }),
    };
  });

  // An unsupported command resolves only by its exact bare name, and never shadows a command the
  // session can run.
  const taken = new Set([...apps, ...providerCommands].flatMap((command) =>
    [command.invocationAlias.toLowerCase(), command.name.toLowerCase()]));
  const unsupportedCommands = (input.unsupportedCommands ?? []).flatMap((unsupported): ComposerCommand[] => {
    const parsed = advertisedName(unsupported.name);
    const reason = optionalText(unsupported.reason);
    if (!parsed || !reason || taken.has(parsed.comparisonName)) return [];
    taken.add(parsed.comparisonName);
    return [{
      id: `unsupported:${parsed.comparisonName}`,
      name: parsed.name,
      label: `/${parsed.comparisonName}`,
      invocationAlias: parsed.comparisonName,
      source: "provider",
      sourceLabel: "Harness",
      executionMode: "passthrough",
      available: false,
      disabledReason: reason,
      attachmentPolicy: "preserve",
      groupId: providerGroup.id,
      groupLabel: agentGroupLabel,
      hidden: true,
    }];
  });

  return [...apps, ...providerCommands, ...unsupportedCommands];
}

/**
 * Whether this session's composer refuses an unknown slash token (#2176) instead of sending it as
 * text. Refusing is only safe where the catalog names every command the agent runs.
 *
 * Codex, Pi and ACP agents don't run slash text they don't advertise, so an unmatched token is a
 * typo and is always refused there. Claude Code does run its built-ins (`/compact`, `/context`)
 * when they arrive as prompt text, and a runner reports them only once it forwards Claude Code's
 * init-time catalog with source `builtin` (#1224); its disk commands are `user` or `project`. A
 * Claude Code catalog without a built-in comes from an older runner, which keeps the plain-text
 * fallback so those commands still run.
 */
export function composerRejectsUnknownCommands(
  driver: AgentDriverKind | undefined,
  slashCommands: readonly Pick<AgentSlashCommand, "source">[],
): boolean {
  return driver !== "claude-code" || slashCommands.some((command) => command.source === "builtin");
}

/** Optimal string alignment distance: an insertion, deletion, substitution or swap of two adjacent
 * characters each costs one, so `reveiw` is one step from `review`. With a `limit`, any distance
 * past it is reported as `limit + 1` without finishing the table: a pasted path at the start of a
 * message must not cost a full table per command on every render. */
export function commandEditDistance(left: string, right: string, limit = Number.POSITIVE_INFINITY): number {
  const a = [...left];
  const b = [...right];
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  // Three rows: the one being filled and the two a transposition looks back to.
  let before = new Array<number>(b.length + 1).fill(0);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMinimum = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, before[j - 2]! + 1);
      }
      current[j] = best;
      rowMinimum = Math.min(rowMinimum, best);
    }
    // A cell looks back at most two rows, so once two rows in a row are past the limit, no later
    // cell can come back under it.
    if (rowMinimum > limit && Math.min(...previous) > limit) return limit + 1;
    [before, previous, current] = [previous, current, before];
  }
  return Math.min(previous[b.length]!, limit + 1);
}

const MAX_COMMAND_SUGGESTIONS = 3;

/** Up to three available commands close to a typed name (without its slash), closest first. The
 * allowance grows with the name, one edit per three characters, so a short token doesn't match
 * everything. */
export function suggestComposerCommands(
  typedName: string,
  commands: readonly ComposerCommand[],
): ComposerCommand[] {
  const typed = typedName.toLowerCase();
  if (!typed) return [];
  const allowance = Math.max(1, Math.floor([...typed].length / 3));
  return commands
    .flatMap((command) => {
      if (!command.available) return [];
      const name = command.name.toLowerCase();
      // A namespaced command (`superpowers:brainstorming`) is also close to its own last part, which
      // is what a person usually types.
      const unqualified = name.slice(name.lastIndexOf(":") + 1);
      const distance = Math.min(
        commandEditDistance(typed, command.invocationAlias.toLowerCase(), allowance),
        commandEditDistance(typed, name, allowance),
        unqualified !== name ? commandEditDistance(typed, unqualified, allowance) : allowance + 1,
      );
      return distance <= allowance ? [{ command, distance }] : [];
    })
    .sort((left, right) =>
      left.distance - right.distance
      || groupOrder(left.command) - groupOrder(right.command)
      || ordinalCompare(left.command.label, right.command.label))
    .slice(0, MAX_COMMAND_SUGGESTIONS)
    .map(({ command }) => command);
}

/** Replace a message's leading slash token with a command's and keep the rest of the message; the
 * caret goes after the inserted token. */
export function replaceLeadingCommandToken(
  text: string,
  command: ComposerCommand,
): { text: string; caret: number } {
  const match = /^(\s*)\/\S*[^\S\n]*/u.exec(text);
  const insertion = `/${command.invocationAlias} `;
  if (!match) return { text: `${insertion}${text}`, caret: insertion.length };
  const start = match[1]!.length;
  return {
    text: `${text.slice(0, start)}${insertion}${text.slice(match[0].length)}`,
    caret: start + insertion.length,
  };
}

export function resolveComposerCommandInvocation(
  text: string,
  commands: readonly ComposerCommand[],
  options: ComposerCommandResolutionOptions = {},
): ComposerCommandResolution {
  const trimmed = text.trim();
  // `//x` and `\/x` mark a message that starts with a slash as text: the escape is removed and `/x`
  // is sent as it stands.
  if (trimmed.startsWith("//") || trimmed.startsWith("\\/")) {
    const escape = text.indexOf(trimmed[0]!);
    return { kind: "plaintext", text: `${text.slice(0, escape)}${text.slice(escape + 1)}` };
  }
  const skillReference = options.skillSigil === false ? null : /^\$([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (skillReference) {
    // `$name` is Codex's skill spelling: it names only a skill, and ordinary `$` text stays text.
    const skill = commands.find((candidate) => candidate.providerSource === "skill" &&
      candidate.name.toLowerCase() === skillReference[1]!.toLowerCase());
    return skill
      ? { kind: "command", command: skill, arguments: (skillReference[2] ?? "").trimEnd(), originalText: text }
      : { kind: "plaintext", text };
  }
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return { kind: "plaintext", text };
  const alias = match[1]!.toLowerCase();
  const exact = commands.find((candidate) => candidate.invocationAlias.toLowerCase() === alias);
  const qualified = /^(builtin|user|project|plugin|skill|mcp|provider):(.+)$/.exec(alias);
  const qualifiedProvider = !exact && qualified
    ? commands
        .filter((candidate) => candidate.source === "provider" &&
          (candidate.providerSource ?? "provider") === qualified[1] && [
            `${qualified[1]}:${candidate.name.toLowerCase()}`,
            `${qualified[1]}:${candidate.name.toLowerCase()}:${invocationIdQualifier(candidate.id)}`,
            `${qualified[1]}:${candidate.name.toLowerCase()}:${invocationIdQualifier(candidate.id)}:${collisionSafeQualifierSuffix(candidate.id)}`,
          ].includes(alias))
        .sort((left, right) => ordinalCompare(left.id, right.id))[0]
    : undefined;
  // A provider may gain a same-name peer after a draft has already stored the old bare alias.
  // Exact aliases (including app-owned names) always win; otherwise retain that legacy token by
  // choosing the provider with the same explicit scope precedence regardless of catalog/input
  // order. Within one scope, stable ids provide the deterministic final tie-break.
  const command = exact ?? qualifiedProvider ?? (!qualified ? commands
    .filter((candidate) => candidate.source === "provider" && candidate.name.toLowerCase() === alias)
    .sort((left, right) =>
      (left.providerSource ? PROVIDER_INVOCATION_PRECEDENCE[left.providerSource] : 4) -
        (right.providerSource ? PROVIDER_INVOCATION_PRECEDENCE[right.providerSource] : 4) ||
      ordinalCompare(left.id, right.id))[0] : undefined);
  if (!command) {
    return options.unknownCommands === "plaintext" || options.unlistedNames?.has(alias)
      ? { kind: "plaintext", text }
      : { kind: "unknown", token: `/${match[1]!}`, suggestions: suggestComposerCommands(match[1]!, commands) };
  }
  return {
    kind: "command",
    command,
    arguments: (match[2] ?? "").trimEnd(),
    originalText: text,
  };
}

const TRIGGER_TOKEN = new RegExp(`^\\/([${SLASH_COMMAND_NAME_CHARACTERS}]*)$`, "u");
const SKILL_TRIGGER_TOKEN = new RegExp(`^\\$([${SLASH_COMMAND_NAME_CHARACTERS}]*)$`, "u");

/** Find the command token being typed. `$` opens the menu only when the session advertises skills,
 * so a `$` in any other composer stays ordinary text. */
export function findComposerCommandTrigger(
  text: string,
  caret: number,
  options: { skillSigil?: boolean } = {},
): ComposerCommandTrigger | null {
  if (!Number.isSafeInteger(caret) || caret < 0 || caret > text.length) return null;
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  if (text.slice(0, lineStart).trim()) return null;
  const prefix = text.slice(lineStart, caret);
  const skill = options.skillSigil === true && prefix.startsWith("$");
  const token = skill ? SKILL_TRIGGER_TOKEN : TRIGGER_TOKEN;
  const prefixMatch = token.exec(prefix);
  if (!prefixMatch) return null;

  let tokenEnd = caret;
  // Walk whole code points, so a letter outside the Basic Multilingual Plane extends the token.
  while (tokenEnd < text.length) {
    const character = String.fromCodePoint(text.codePointAt(tokenEnd)!);
    if (!isSlashCommandNameCharacter(character)) break;
    tokenEnd += character.length;
  }
  if (text[tokenEnd] === "/" || text[tokenEnd] === "$") return null;
  const raw = text.slice(lineStart, tokenEnd);
  if (!token.test(raw)) return null;
  return {
    start: lineStart,
    end: tokenEnd,
    query: prefixMatch[1]!,
    raw,
    ...(skill ? { sigil: "$" as const } : {}),
  };
}

/** True when a `$` token can name one of these commands. */
export function composerCommandsIncludeSkills(commands: readonly ComposerCommand[]): boolean {
  return commands.some((command) => command.providerSource === "skill");
}

/** The commands a trigger may offer: every command for `/`, and only skills, spelled `$name`,
 * for `$`. */
export function composerCommandsForTrigger(
  commands: readonly ComposerCommand[],
  trigger: ComposerCommandTrigger,
): ComposerCommand[] {
  const offered = commands.filter((command) => !command.hidden);
  if (trigger.sigil !== "$") return offered;
  return offered
    .filter((command) => command.providerSource === "skill")
    .map((command) => ({ ...command, label: `$${command.name}` }));
}

export function replaceComposerCommandTrigger(
  text: string,
  trigger: ComposerCommandTrigger,
  command: ComposerCommand,
): { text: string; caret: number } {
  let replaceEnd = trigger.end;
  while (text[replaceEnd] === " " || text[replaceEnd] === "\t") replaceEnd += 1;
  const insertion = trigger.sigil === "$" ? `$${command.name} ` : `/${command.invocationAlias} `;
  return {
    text: `${text.slice(0, trigger.start)}${insertion}${text.slice(replaceEnd)}`,
    caret: trigger.start + insertion.length,
  };
}

function fuzzyMatch(value: string, query: string): boolean {
  let queryIndex = 0;
  for (const character of value) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

const MATCH_ORDER: Record<ComposerCommandMatchKind, number> = {
  none: 5,
  exact: 0,
  prefix: 1,
  boundary: 2,
  substring: 3,
  fuzzy: 4,
};

function matchKind(value: string, query: string, allowFuzzy: boolean): ComposerCommandMatchKind | null {
  if (value === query) return "exact";
  if (value.startsWith(query)) return "prefix";
  const index = value.indexOf(query);
  if (index >= 0 && /[^\p{L}\p{N}]/u.test(value[index - 1] ?? "")) return "boundary";
  if (index >= 0) return "substring";
  return allowFuzzy && fuzzyMatch(value, query) ? "fuzzy" : null;
}

function groupOrder(command: ComposerCommand): number {
  return GROUP_BY_ID.get(command.groupId)?.order ?? Number.MAX_SAFE_INTEGER;
}

export function rankComposerCommands(
  commands: readonly ComposerCommand[],
  query: string,
): RankedComposerCommand[] {
  const normalizedQuery = query.trim().toLowerCase();
  const ranked = commands.flatMap((command): RankedComposerCommand[] => {
    if (!normalizedQuery) return [{ command, matchKind: "none", score: MATCH_ORDER.none * 100 }];
    const allowCommandFuzzy = command.source === "provider";
    const fields = [
      { value: command.invocationAlias, allowFuzzy: allowCommandFuzzy },
      { value: command.name, allowFuzzy: allowCommandFuzzy },
      { value: command.description, allowFuzzy: false },
      { value: command.argumentHint, allowFuzzy: false },
    ].filter((field): field is { value: string; allowFuzzy: boolean } => Boolean(field.value));
    let best: { kind: ComposerCommandMatchKind; fieldIndex: number } | null = null;
    for (const [fieldIndex, field] of fields.entries()) {
      const kind = matchKind(field.value.toLowerCase(), normalizedQuery, field.allowFuzzy);
      if (!kind) continue;
      if (!best || MATCH_ORDER[kind] < MATCH_ORDER[best.kind] ||
          (MATCH_ORDER[kind] === MATCH_ORDER[best.kind] && fieldIndex < best.fieldIndex)) {
        best = { kind, fieldIndex };
      }
    }
    return best
      ? [{ command, matchKind: best.kind, score: MATCH_ORDER[best.kind] * 100 + best.fieldIndex }]
      : [];
  });
  return ranked.sort((left, right) =>
    left.score - right.score
    || Number(!left.command.available) - Number(!right.command.available)
    || groupOrder(left.command) - groupOrder(right.command)
    || left.command.name.localeCompare(right.command.name)
    || left.command.id.localeCompare(right.command.id));
}

/**
 * The picker's sections for a ranked list. Each group appears once, in the order its first command
 * ranks, so the best match's group leads; within a group the ranked order is kept.
 */
export function groupRankedComposerCommands(
  commands: readonly ComposerCommand[],
): Array<{ groupId: ComposerCommandGroupId; label: string; commands: ComposerCommand[] }> {
  const sections = new Map<string, { groupId: ComposerCommandGroupId; label: string; commands: ComposerCommand[] }>();
  for (const command of commands) {
    const section = sections.get(command.groupId);
    if (section) section.commands.push(command);
    else sections.set(command.groupId, { groupId: command.groupId, label: command.groupLabel, commands: [command] });
  }
  return [...sections.values()];
}

/** The commands in the order the picker shows them, which is the order arrow keys walk. */
export function composerCommandsInPickerOrder(commands: readonly ComposerCommand[]): ComposerCommand[] {
  return groupRankedComposerCommands(commands).flatMap((section) => section.commands);
}

/** Keep the active command while it is still offered and can run; otherwise the first that can.
 * Unavailable commands are never active: their reason is always visible on their row. */
export function retainActiveComposerCommandId(
  activeId: string | null | undefined,
  commands: readonly ComposerCommand[],
): string | null {
  if (activeId && commands.some((command) => command.id === activeId && command.available)) return activeId;
  return commands.find((command) => command.available)?.id ?? null;
}

/** The next command arrow keys move to, skipping unavailable rows and wrapping at either end. */
export function stepComposerCommandId(
  activeId: string | null | undefined,
  commands: readonly ComposerCommand[],
  direction: 1 | -1,
): string | null {
  const count = commands.length;
  if (!count) return null;
  const current = commands.findIndex((command) => command.id === activeId);
  for (let step = 1; step <= count; step += 1) {
    const start = current < 0 ? (direction === 1 ? -1 : 0) : current;
    const candidate = commands[(((start + direction * step) % count) + count) % count]!;
    if (candidate.available) return candidate.id;
  }
  return null;
}
