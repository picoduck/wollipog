/**
 * Claude Code's session command catalog (#1224).
 *
 * Claude Code names every command it can run in its `system/init` message: `slash_commands` holds
 * built-ins (`compact`, `context`, `model`), skills, plugin commands (`plugin:command`) and MCP
 * prompts (`mcp__server__prompt`), and `skills`, `plugins` and `terminal_slash_commands` say which
 * is which. That list is the authoritative membership of a session's menu. The disk scan of
 * `.claude/commands` and `.claude/skills` (claude-commands.ts) supplies what the init list lacks:
 * descriptions, argument hints, the user/project origin of a command, and skills marked
 * `user-invocable: false`, which are never advertised.
 *
 * Before a session's first init (and on a runner whose Claude Code predates the list) the disk
 * scan alone is the catalog, as it always was. A built-in only ever appears through the init list,
 * so a catalog containing one tells the web composer it is complete (#2176).
 */

import type { AgentSlashCommand, UnsupportedSlashCommand } from "@wollipog/protocol";

export const CLAUDE_INIT_CATALOG_LIMITS = {
  maxCommands: 512,
  maxPlugins: 64,
  maxNameCharacters: 128,
  maxPathCharacters: 4096,
} as const;

/** The part of one `system/init` message the catalog uses, validated and bounded. */
export interface ClaudeInitCatalog {
  commands: string[];
  skills: string[];
  terminalCommands: string[];
  plugins: Array<{ name: string; path: string }>;
}

/** One skill found on disk. A skill Claude Code also lists becomes a `skill` command with this
 * metadata; `userInvocable: false` keeps it out of the catalog altogether. */
export interface ClaudeSkillMetadata {
  name: string;
  origin: "user" | "project" | "plugin";
  description?: string;
  argumentHint?: string;
  userInvocable: boolean;
}

/** What one session's catalog is computed from; persisted so a relaunch or a later init can
 * recompute it without rescanning. */
export interface ClaudeSessionCatalogInputs {
  /** Command files: personal and project `.claude/commands`, and plugin `commands/` directories
   * (named `plugin:command`, source `plugin`). */
  commands: AgentSlashCommand[];
  skills: ClaudeSkillMetadata[];
  init?: ClaudeInitCatalog;
}

export interface ClaudeSessionCatalog {
  commands: AgentSlashCommand[];
  unsupported: UnsupportedSlashCommand[];
}

/**
 * Commands that need Claude Code's own terminal or mean nothing inside Wollipog. Claude Code's
 * `terminal_slash_commands` adds to this list at runtime; neither is ever advertised, and a client
 * that resolves one typed in full says why instead of sending it.
 */
export const CLAUDE_UNSUPPORTED_COMMANDS: ReadonlySet<string> = new Set([
  "exit", "quit", "theme", "terminal-setup", "login", "logout", "vim", "desktop", "mobile",
  "teleport", "ide", "statusline", "keybindings", "copy", "focus", "stickers", "passes", "voice",
  "upgrade",
]);

/** Short descriptions for common built-ins, which the init list names without one. */
const CLAUDE_BUILTIN_METADATA: Readonly<Record<string, { description: string; argumentHint?: string }>> = {
  compact: { description: "Summarize the conversation to free up context.", argumentHint: "[instructions]" },
  context: { description: "Show what is using the context window." },
  usage: { description: "Show plan usage and limits." },
  cost: { description: "Show the cost and duration of this session." },
  init: { description: "Write a CLAUDE.md that describes this project." },
  review: { description: "Review a pull request." },
  "security-review": { description: "Review the pending changes for security issues." },
  model: { description: "Change the model.", argumentHint: "[model]" },
  effort: { description: "Change the reasoning effort.", argumentHint: "[level]" },
  rename: { description: "Rename the conversation.", argumentHint: "[name]" },
  clear: { description: "Start a new conversation." },
  memory: { description: "Edit Claude Code's memory files." },
  mcp: { description: "Show the MCP servers and their status." },
  agents: { description: "Manage subagents." },
  "add-dir": { description: "Add a working directory.", argumentHint: "<path>" },
};

const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:@-]*$/;

function commandNames(value: unknown, limit: number = CLAUDE_INIT_CATALOG_LIMITS.maxCommands): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of value) {
    if (names.length >= limit) break;
    if (typeof entry !== "string") continue;
    // Claude Code lists names bare; tolerate a leading slash from a future release.
    const name = entry.trim().replace(/^\//, "");
    if (!name || name.length > CLAUDE_INIT_CATALOG_LIMITS.maxNameCharacters || !NAME_PATTERN.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** Read the catalog from a `system/init` message. Returns null when the message carries no
 * `slash_commands` array (a Claude Code release that predates it), so the disk catalog stands. */
export function parseClaudeInitCatalog(message: Record<string, unknown>): ClaudeInitCatalog | null {
  if (!Array.isArray(message.slash_commands)) return null;
  const plugins: ClaudeInitCatalog["plugins"] = [];
  if (Array.isArray(message.plugins)) {
    for (const entry of message.plugins) {
      if (plugins.length >= CLAUDE_INIT_CATALOG_LIMITS.maxPlugins) break;
      if (!entry || typeof entry !== "object") continue;
      const { name, path } = entry as { name?: unknown; path?: unknown };
      if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.includes(":") ||
          name.length > CLAUDE_INIT_CATALOG_LIMITS.maxNameCharacters) continue;
      if (typeof path !== "string" || !path || path.length > CLAUDE_INIT_CATALOG_LIMITS.maxPathCharacters ||
          path.includes("\0")) continue;
      if (plugins.some((plugin) => plugin.name.toLowerCase() === name.toLowerCase())) continue;
      plugins.push({ name, path });
    }
  }
  return {
    commands: commandNames(message.slash_commands),
    skills: commandNames(message.skills),
    terminalCommands: commandNames(message.terminal_slash_commands),
    plugins,
  };
}

export function sameClaudeInitCatalog(left: ClaudeInitCatalog | undefined, right: ClaudeInitCatalog | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const sameList = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return sameList(left.commands, right.commands) && sameList(left.skills, right.skills) &&
    sameList(left.terminalCommands, right.terminalCommands) &&
    left.plugins.length === right.plugins.length &&
    left.plugins.every((plugin, index) =>
      plugin.name === right.plugins[index]!.name && plugin.path === right.plugins[index]!.path);
}

/** The plugin roots whose `skills/` and `commands/` the disk scan reads. */
export function samePluginRoots(left: ClaudeInitCatalog | undefined, right: ClaudeInitCatalog | undefined): boolean {
  const roots = (catalog: ClaudeInitCatalog | undefined) =>
    (catalog?.plugins ?? []).map((plugin) => `${plugin.name}\u0000${plugin.path}`).join("\n");
  return roots(left) === roots(right);
}

export function claudeUnsupportedReason(name: string): string {
  return `Claude Code's /${name} needs its own terminal, so Wollipog doesn't send it.`;
}

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Personal skills shadow project skills of the same name, as personal commands do. */
function skillsByName(skills: readonly ClaudeSkillMetadata[]): Map<string, ClaudeSkillMetadata> {
  const order = { user: 0, project: 1, plugin: 2 } as const;
  const byName = new Map<string, ClaudeSkillMetadata>();
  for (const skill of [...skills].sort((a, b) => order[a.origin] - order[b.origin] || compareStable(a.name, b.name))) {
    const key = skill.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, skill);
  }
  return byName;
}

function skillCommand(name: string, skill: ClaudeSkillMetadata | undefined): AgentSlashCommand {
  return {
    name,
    source: "skill",
    ...(skill?.description ? { description: skill.description } : {}),
    ...(skill?.argumentHint ? { argumentHint: skill.argumentHint } : {}),
  };
}

/**
 * Merge one session's sources into its menu: the init list decides membership when present, the
 * disk scan supplies metadata (a disk entry wins over a classification by name), names compare
 * case-insensitively, and unsupported commands are split out with their reason.
 */
export function mergeClaudeSessionCatalog(inputs: ClaudeSessionCatalogInputs): ClaudeSessionCatalog {
  const files = new Map<string, AgentSlashCommand>();
  for (const command of inputs.commands) {
    const key = command.name.toLowerCase();
    if (!files.has(key)) files.set(key, command);
  }
  const skills = skillsByName(inputs.skills);
  // Every unsupported name gets its reason whether or not a list advertises it: Claude Code omits
  // some (`/exit`) from `slash_commands`, and typing one must still say why rather than send it.
  const unsupportedNames = new Map<string, string>();
  for (const name of [...CLAUDE_UNSUPPORTED_COMMANDS, ...(inputs.init?.terminalCommands ?? [])]) {
    const key = name.toLowerCase();
    if (!unsupportedNames.has(key)) unsupportedNames.set(key, name);
  }
  for (const name of inputs.init?.commands ?? []) {
    // Keep the casing Claude Code reports for a name it lists.
    if (unsupportedNames.has(name.toLowerCase())) unsupportedNames.set(name.toLowerCase(), name);
  }
  const unsupported: UnsupportedSlashCommand[] = [...unsupportedNames.values()]
    .map((name) => ({ name, reason: claudeUnsupportedReason(name) }))
    .sort((a, b) => compareStable(a.name.toLowerCase(), b.name.toLowerCase()));
  const commands: AgentSlashCommand[] = [];
  const seen = new Set<string>();
  const add = (command: AgentSlashCommand) => {
    const key = command.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    commands.push(command);
  };

  if (!inputs.init) {
    for (const command of inputs.commands) {
      // Only an init list says which plugins are enabled, so their commands wait for one.
      if (command.source === "plugin" || CLAUDE_UNSUPPORTED_COMMANDS.has(command.name.toLowerCase())) continue;
      add(command);
    }
    for (const skill of skills.values()) {
      if (!skill.userInvocable || skill.origin === "plugin") continue;
      if (CLAUDE_UNSUPPORTED_COMMANDS.has(skill.name.toLowerCase())) continue;
      add(skillCommand(skill.name, skill));
    }
    commands.sort((a, b) => compareStable(a.name.toLowerCase(), b.name.toLowerCase()));
    return { commands: commands.slice(0, CLAUDE_INIT_CATALOG_LIMITS.maxCommands), unsupported };
  }

  const terminal = new Set(inputs.init.terminalCommands.map((name) => name.toLowerCase()));
  const listedSkills = new Set(inputs.init.skills.map((name) => name.toLowerCase()));
  const plugins = new Set(inputs.init.plugins.map((plugin) => plugin.name.toLowerCase()));
  for (const name of inputs.init.commands) {
    // Double-underscore names are Claude Code's own plumbing, not commands for a person.
    if (name.startsWith("__")) continue;
    const key = name.toLowerCase();
    if (CLAUDE_UNSUPPORTED_COMMANDS.has(key) || terminal.has(key)) continue;
    const skill = skills.get(key);
    if (skill && !skill.userInvocable) continue;
    const file = files.get(key);
    if (file) {
      add(file);
    } else if (skill || listedSkills.has(key)) {
      add(skillCommand(name, skill));
    } else if (key.startsWith("mcp__")) {
      add({ name, source: "mcp" });
    } else if (key.includes(":") && plugins.has(key.slice(0, key.indexOf(":")))) {
      add({ name, source: "plugin" });
    } else {
      const metadata = CLAUDE_BUILTIN_METADATA[key];
      add({
        name,
        source: "builtin",
        ...(metadata ? { description: metadata.description } : {}),
        ...(metadata?.argumentHint ? { argumentHint: metadata.argumentHint } : {}),
      });
    }
  }
  commands.sort((a, b) => compareStable(a.name.toLowerCase(), b.name.toLowerCase()));
  return { commands: commands.slice(0, CLAUDE_INIT_CATALOG_LIMITS.maxCommands), unsupported };
}
