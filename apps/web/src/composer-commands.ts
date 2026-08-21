import type { AgentSlashCommand } from "@wollipog/protocol";

export type ComposerCommandSource = "app" | "provider";

export type ComposerCommandExecutionMode = "app" | "structured" | "passthrough";

/**
 * - preserve: the command does not consume attachments, so they remain in the composer.
 * - send: attachments are included with the command invocation.
 * - forbid: the command cannot run while attachments are present.
 */
export type ComposerCommandAttachmentPolicy = "preserve" | "send" | "forbid";

export type ComposerCommandGroupId = "app" | "provider";

export interface ComposerCommandContext {
  planSupported: boolean;
  canStopTurn: boolean;
}

export interface ProviderComposerCommand {
  id?: string;
  name: string;
  description?: string;
  providerSource?: "builtin" | "user" | "project" | "plugin";
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
  /** User-visible invocation label, including the leading slash. */
  label: string;
  /** Optional Title Case action name shown in the command menu. */
  displayName?: string;
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
}

export const DURABLE_COMMAND_ATTACHMENT_NOTICE =
  "Attached images will not be sent with this command. They will remain for your next prompt.";

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

export interface ComposerCommandGroup extends ComposerCommandGroupMetadata {
  commands: ComposerCommand[];
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
}

export type ComposerCommandResolution =
  | { kind: "plaintext"; text: string }
  | { kind: "command"; command: ComposerCommand; arguments: string; originalText: string };

export type ComposerCommandMatchKind = "none" | "exact" | "prefix" | "boundary" | "substring" | "fuzzy";

export interface RankedComposerCommand {
  command: ComposerCommand;
  matchKind: ComposerCommandMatchKind;
  score: number;
}

export const COMPOSER_COMMAND_GROUPS: readonly ComposerCommandGroupMetadata[] = [
  { id: "app", label: "App Commands", order: 0 },
  { id: "provider", label: "Harness Commands", order: 1 },
] as const;

const GROUP_BY_ID = new Map(COMPOSER_COMMAND_GROUPS.map((group) => [group.id, group]));
const PROVIDER_SOURCE_LABELS: Record<NonNullable<ProviderComposerCommand["providerSource"]>, string> = {
  builtin: "Built-In",
  user: "User",
  project: "Project",
  plugin: "Plugin",
};

const PROVIDER_INVOCATION_PRECEDENCE: Record<NonNullable<ProviderComposerCommand["providerSource"]>, number> = {
  user: 0,
  project: 1,
  plugin: 2,
  builtin: 3,
};

function advertisedName(value: string): { name: string; comparisonName: string } | null {
  const name = value.trim();
  if (name.startsWith("/")) return null;
  return /^[\p{L}\p{N}_][\p{L}\p{N}_.:-]*$/u.test(name)
    ? { name, comparisonName: name.toLowerCase() }
    : null;
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
      displayName: "Rename Session",
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
      id: "app:stop",
      name: "stop",
      label: commandLabel("stop"),
      invocationAlias: "stop",
      description: "Stop the active turn without ending the session.",
      source: "app",
      sourceLabel: "App",
      executionMode: "app",
      available: context.canStopTurn,
      ...(context.canStopTurn ? {} : { disabledReason: "There is no active turn to stop." }),
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
      sourceLabel: provider.providerSource ? PROVIDER_SOURCE_LABELS[provider.providerSource] : "Harness",
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
      groupId: providerGroup.id,
      groupLabel: providerGroup.label,
    };
  });

  return [...apps, ...providerCommands];
}

export function resolveComposerCommandInvocation(
  text: string,
  commands: readonly ComposerCommand[],
): ComposerCommandResolution {
  const trimmed = text.trim();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return { kind: "plaintext", text };
  const alias = match[1]!.toLowerCase();
  const exact = commands.find((candidate) => candidate.invocationAlias.toLowerCase() === alias);
  const qualified = /^(builtin|user|project|plugin|provider):(.+)$/.exec(alias);
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
  if (!command) return { kind: "plaintext", text };
  return {
    kind: "command",
    command,
    arguments: (match[2] ?? "").trimEnd(),
    originalText: text,
  };
}

const TRIGGER_TOKEN = /^\/([\p{L}\p{N}_.:-]*)$/u;
const TRIGGER_CHARACTER = /[\p{L}\p{N}_.:-]/u;

export function findComposerCommandTrigger(text: string, caret: number): ComposerCommandTrigger | null {
  if (!Number.isSafeInteger(caret) || caret < 0 || caret > text.length) return null;
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  if (text.slice(0, lineStart).trim()) return null;
  const prefix = text.slice(lineStart, caret);
  const prefixMatch = TRIGGER_TOKEN.exec(prefix);
  if (!prefixMatch) return null;

  let tokenEnd = caret;
  while (tokenEnd < text.length && TRIGGER_CHARACTER.test(text[tokenEnd]!)) tokenEnd += 1;
  if (text[tokenEnd] === "/") return null;
  const raw = text.slice(lineStart, tokenEnd);
  if (!TRIGGER_TOKEN.test(raw)) return null;
  return {
    start: lineStart,
    end: tokenEnd,
    query: prefixMatch[1]!,
    raw,
  };
}

export function replaceComposerCommandTrigger(
  text: string,
  trigger: ComposerCommandTrigger,
  command: ComposerCommand,
): { text: string; caret: number } {
  let replaceEnd = trigger.end;
  while (text[replaceEnd] === " " || text[replaceEnd] === "\t") replaceEnd += 1;
  const insertion = `/${command.invocationAlias} `;
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
    const fields = [
      { value: command.invocationAlias, allowFuzzy: true },
      { value: command.name, allowFuzzy: true },
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

export function groupComposerCommands(commands: readonly ComposerCommand[]): ComposerCommandGroup[] {
  return COMPOSER_COMMAND_GROUPS.flatMap((metadata) => {
    const grouped = commands.filter((command) => command.groupId === metadata.id);
    return grouped.length ? [{ ...metadata, commands: grouped }] : [];
  });
}

export function retainActiveComposerCommandId(
  activeId: string | null | undefined,
  commands: readonly ComposerCommand[],
): string | null {
  if (activeId && commands.some((command) => command.id === activeId)) return activeId;
  return commands[0]?.id ?? null;
}
