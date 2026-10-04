/**
 * Session-scoped Claude command discovery.
 *
 * Claude reads personal commands from ~/.claude/commands and project commands from
 * <session-root>/.claude/commands. The session root is deliberately the exact
 * `worktreePath ?? repoPath` launch root; falling back on truthiness could inspect the shared
 * checkout for a worktree session.
 *
 * All reads are bounded. Native paths use node:fs directly. WSL uses one shell-free HOME probe and
 * maps supported absolute paths through the WSL UNC provider, so command traversal shares the same
 * containment and link-swap protections without depending on guest GNU utilities.
 */

import { constants, type Dir, type Dirent, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { posix } from "node:path";
import { isSlashCommandName, type AgentContext, type AgentSlashCommand } from "@wollipog/protocol";
import type { SessionMeta, SessionSlashCommandProvenance } from "../session-store.js";
import {
  mergeClaudeSessionCatalog,
  type ClaudeInitCatalog,
  type ClaudeSessionCatalogInputs,
  type ClaudeSkillMetadata,
} from "./claude-slash-catalog.js";
import { run, type ExecResult } from "./resolve.js";

export const CLAUDE_COMMAND_LIMITS = {
  maxFilesPerSource: 256,
  maxDirectoriesPerSource: 256,
  maxEntriesPerDirectory: 1024,
  maxDepth: 8,
  maxFileBytes: 64 * 1024,
  maxFrontmatterBytes: 16 * 1024,
  maxFrontmatterLines: 128,
  maxLineBytes: 4 * 1024,
  maxDescriptionCharacters: 280,
  maxArgumentHintCharacters: 160,
  maxNativeDiscoveryMs: 8_000,
  maxWslDiscoveryMs: 8_000,
} as const;

export type DiscoveredClaudeSlashCommand = AgentSlashCommand;

export function includeClaudeUserCommandsForTarget(adapter: "host" | "container" | "cloud" | undefined): boolean {
  return adapter !== "container" && adapter !== "cloud";
}

export interface ClaudeSlashCommandDiscoveryRequest {
  context: AgentContext;
  repoPath: string;
  worktreePath?: string | null;
  /** Remote container/cloud launches may inspect the mounted project, never the host user's home. */
  includeUserCommands?: boolean;
  /** Plugin roots Claude Code reported in its init message (#1224). Plugins live under the user's
   * Claude home, so they are read only where personal commands are. */
  pluginRoots?: ClaudeInitCatalog["plugins"];
}

export type ClaudeSlashCommandDiscoveryResult =
  | { ok: true; commands: DiscoveredClaudeSlashCommand[]; skills: ClaudeSkillMetadata[] }
  | { ok: false; error: string };

export type ClaudeSlashCommandRefreshResult =
  | { outcome: "updated" | "cleared"; commands: DiscoveredClaudeSlashCommand[]; skills: ClaudeSkillMetadata[] }
  | { outcome: "retained"; commands: readonly DiscoveredClaudeSlashCommand[]; error: string };

export type ClaudeSlashCommandPreparationResult =
  | { outcome: "updated" | "cleared" }
  | { outcome: "retained"; error: string }
  | { outcome: "discarded"; error: string };

export interface ClaudeSlashCommandDiscoveryDeps {
  nativeHome?: () => string;
  run?: (file: string, args: string[], options?: { timeoutMs?: number; maxBuffer?: number }) => Promise<ExecResult>;
  /** Test seam; production discovery is always capped by maxWslDiscoveryMs. */
  wslDiscoveryTimeoutMs?: number;
  /** Test seam; production native/UNC traversal is always capped by maxNativeDiscoveryMs. */
  nativeDiscoveryTimeoutMs?: number;
  /** Test seam maps WSL roots onto local fixtures; production uses the WSL UNC provider. */
  wslPathToWindows?: (distro: string, absolutePath: string) => string;
  /** Test seam for proving enumeration-to-open replacement safety. */
  beforeNativeCommandRead?: (path: string) => void | Promise<void>;
  /** Test seam for descendant permission and aggregate-deadline coverage. */
  beforeNativeDirectoryRead?: (path: string) => void | Promise<void>;
  /** Test seam for the root lstat-to-realpath race. */
  beforeNativeRootRealpath?: (path: string) => void | Promise<void>;
  /** Test seams for verifying that late resource acquisitions are closed before timeout failure. */
  openNativeFile?: (path: string, flags: number) => Promise<FileHandle>;
  openNativeDirectory?: (path: string) => Promise<Dir>;
}

export interface CommandFile {
  path: string;
  name: string;
  source: "user" | "project" | "plugin";
  canonicalRoot?: string;
  caseSensitiveRoot?: boolean;
}

interface CommandRootBinding {
  requestedRoot: string;
  requestedEntry: Stats;
  canonicalRoot: string;
  canonicalEntry: Stats;
  caseSensitiveRoot: boolean;
}

export interface NativeCommandFileDiscovery {
  files: CommandFile[];
  binding?: CommandRootBinding;
}

function contextKey(context: AgentContext): string {
  return context.kind === "native" ? "native" : `wsl:${context.distro}`;
}

export function claudeSlashCommandProvenance(meta: Pick<
  SessionMeta,
  "driver" | "context" | "repoPath" | "worktreePath" | "executionTarget" | "executionHandoff"
>): SessionSlashCommandProvenance {
  const targetAdapter = meta.executionTarget?.adapter ?? "host";
  return {
    driver: meta.driver,
    context: contextKey(meta.context),
    root: meta.worktreePath ?? meta.repoPath,
    targetAdapter,
    targetId: meta.executionTarget?.id ?? null,
    includeUserCommands: includeClaudeUserCommandsForTarget(targetAdapter),
    handoffManifestDigest: meta.executionHandoff?.manifestDigest ?? null,
  };
}

export function sameClaudeSlashCommandProvenance(
  left: SessionSlashCommandProvenance | undefined,
  right: SessionSlashCommandProvenance,
): boolean {
  return !!left && left.driver === right.driver && left.context === right.context &&
    left.root === right.root && left.targetAdapter === right.targetAdapter &&
    left.targetId === right.targetId && left.includeUserCommands === right.includeUserCommands &&
    left.handoffManifestDigest === right.handoffManifestDigest;
}

function boundedText(value: string, maxCharacters: number): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  return characters.length <= maxCharacters ? normalized : characters.slice(0, maxCharacters).join("");
}

function unquoteFrontmatterScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed.replace(/\s+#.*$/, "");
}

function frontmatterValue(
  lines: string[],
  key: "description" | "argument-hint" | "user-invocable",
): string | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (Buffer.byteLength(line, "utf8") > CLAUDE_COMMAND_LIMITS.maxLineBytes) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match || match[1]!.toLowerCase() !== key) continue;
    const raw = match[2]!.trim();
    if (raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      const folded: string[] = [];
      for (let child = index + 1; child < lines.length; child += 1) {
        const continuation = lines[child]!;
        if (!/^\s+/.test(continuation)) break;
        folded.push(continuation.trim());
      }
      return folded.join(raw.startsWith("|") ? "\n" : " ");
    }
    return unquoteFrontmatterScalar(raw);
  }
  return undefined;
}

/** Parse only the metadata Claude documents for command files. This is intentionally not a general
 * YAML parser: aliases, tags, objects, and executable extensions are never interpreted. */
export function parseClaudeCommandMetadata(content: string, options: {
  /** Claude documents a first-body-line fallback; callers that must not expose body text omit it. */
  descriptionFromBody?: boolean;
} = {}): {
  description?: string;
  argumentHint?: string;
} {
  const bounded = Buffer.from(content, "utf8")
    .subarray(0, CLAUDE_COMMAND_LIMITS.maxFileBytes)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  const lines = bounded.split(/\r?\n/);
  let bodyStart = 0;
  let frontmatter: string[] = [];

  if (lines[0]?.trim() === "---") {
    let bytes = 0;
    const candidate: string[] = [];
    let closedAt = -1;
    for (let index = 1; index < lines.length && index <= CLAUDE_COMMAND_LIMITS.maxFrontmatterLines; index += 1) {
      const line = lines[index]!;
      bytes += Buffer.byteLength(line, "utf8") + 1;
      if (bytes > CLAUDE_COMMAND_LIMITS.maxFrontmatterBytes) break;
      if (line.trim() === "---" || line.trim() === "...") {
        closedAt = index;
        break;
      }
      candidate.push(line);
    }
    // Malformed/unbounded frontmatter is ordinary body text, not partially trusted metadata.
    if (closedAt >= 0) {
      frontmatter = candidate;
      bodyStart = closedAt + 1;
    }
  }

  const frontmatterDescription = frontmatterValue(frontmatter, "description");
  const argumentHint = frontmatterValue(frontmatter, "argument-hint");
  let firstBodyLine: string | undefined;
  for (const line of lines.slice(bodyStart)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---" || trimmed.startsWith("<!--")) continue;
    firstBodyLine = trimmed.replace(/^#{1,6}\s+/, "");
    break;
  }

  const description = boundedText(
    frontmatterDescription ?? (options.descriptionFromBody === false ? undefined : firstBodyLine) ?? "",
    CLAUDE_COMMAND_LIMITS.maxDescriptionCharacters,
  );
  const hint = boundedText(argumentHint ?? "", CLAUDE_COMMAND_LIMITS.maxArgumentHintCharacters);
  return {
    ...(description ? { description } : {}),
    ...(hint ? { argumentHint: hint } : {}),
  };
}

/** Frontmatter lines of a bounded file, or none when the block is missing, unclosed or too large. */
function frontmatterLines(content: string): { lines: string[]; frontmatter: string[]; bodyStart: number } {
  const bounded = Buffer.from(content, "utf8")
    .subarray(0, CLAUDE_COMMAND_LIMITS.maxFileBytes)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  const lines = bounded.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { lines, frontmatter: [], bodyStart: 0 };
  let bytes = 0;
  const candidate: string[] = [];
  for (let index = 1; index < lines.length && index <= CLAUDE_COMMAND_LIMITS.maxFrontmatterLines; index += 1) {
    const line = lines[index]!;
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (bytes > CLAUDE_COMMAND_LIMITS.maxFrontmatterBytes) break;
    if (line.trim() === "---" || line.trim() === "...") return { lines, frontmatter: candidate, bodyStart: index + 1 };
    candidate.push(line);
  }
  return { lines, frontmatter: [], bodyStart: 0 };
}

/** Parse the metadata Claude Code documents for a skill's SKILL.md: `description`,
 * `argument-hint` and `user-invocable`. A skill's body is instructions for the model, so it never
 * becomes a description. */
export function parseClaudeSkillMetadata(content: string): Omit<ClaudeSkillMetadata, "name" | "origin"> {
  const { frontmatter } = frontmatterLines(content);
  const description = boundedText(frontmatterValue(frontmatter, "description") ?? "",
    CLAUDE_COMMAND_LIMITS.maxDescriptionCharacters);
  const argumentHint = boundedText(frontmatterValue(frontmatter, "argument-hint") ?? "",
    CLAUDE_COMMAND_LIMITS.maxArgumentHintCharacters);
  const invocable = frontmatterValue(frontmatter, "user-invocable")?.trim().toLowerCase();
  return {
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    userInvocable: invocable !== "false",
  };
}

function commandName(relativePath: string, pathSeparator: string): string | null {
  const normalized = relativePath.split(pathSeparator).join("/");
  if (!/\.md$/i.test(normalized)) return null;
  const filename = normalized.slice(normalized.lastIndexOf("/") + 1, -3);
  return fileCommandName(filename);
}

/** A skill is a `<name>/SKILL.md` directly below its root; the directory names it. */
function skillName(relativePath: string, pathSeparator: string): string | null {
  const segments = relativePath.split(pathSeparator);
  if (segments.length !== 2 || segments[1] !== "SKILL.md") return null;
  return fileCommandName(segments[0]!);
}

/** A file or directory names a command when the shared grammar (#2602) accepts it. A colon is
 * reserved for the `plugin:command` namespace, so a file can't claim one. */
function fileCommandName(name: string): string | null {
  return isSlashCommandName(name) && !name.includes(":") ? name : null;
}

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function wslAbsolutePathToUnc(distro: string, absolutePath: string): string {
  if (!distro || /[\\/:*?"<>|\0]/.test(distro) || distro === "." || distro === "..") {
    throw new Error("WSL distro name cannot be represented safely as a UNC share");
  }
  if (!posix.isAbsolute(absolutePath) || posix.normalize(absolutePath) !== absolutePath) {
    throw new Error("WSL command path must be normalized and absolute");
  }
  const segments = absolutePath.split("/").slice(1);
  if (segments.some((segment) => !segment || /[\\:\0]/.test(segment) || segment === "." || segment === "..")) {
    throw new Error("WSL command path cannot be represented safely through the UNC provider");
  }
  return `\\\\wsl.localhost\\${distro}\\${segments.join("\\")}`;
}

async function withinDiscoveryDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  label: string,
): Promise<T> {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error(`${label} deadline exceeded`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineFailure = () => new Error(`${label} deadline exceeded`);
  const pending = Promise.resolve().then(operation).then((result) => {
    if (Date.now() >= deadline) throw deadlineFailure();
    return result;
  });
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(deadlineFailure()), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function acquireWithinDiscoveryDeadline<T extends { close(): Promise<void> }>(
  operation: () => Promise<T>,
  deadline: number,
  label: string,
): Promise<T> {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error(`${label} deadline exceeded`);
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineFailure = () => new Error(`${label} deadline exceeded`);
  const pending = Promise.resolve().then(operation).then(async (resource) => {
    if (expired || Date.now() >= deadline) {
      await resource.close().catch(() => {});
      throw deadlineFailure();
    }
    return resource;
  });
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(deadlineFailure());
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeWithinDiscoveryDeadline(
  resource: { close(): Promise<void> },
  deadline: number,
): Promise<void> {
  const closing = resource.close().catch(() => {});
  if (Date.now() >= deadline) {
    void closing;
    return;
  }
  await withinDiscoveryDeadline(() => closing, deadline, "command discovery").catch(() => {});
}

export function assertClaudeCommandPathContained(
  canonicalRoot: string,
  canonicalPath: string,
  caseSensitive = false,
): void {
  if (caseSensitive) {
    const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
    if (canonicalPath === canonicalRoot || canonicalPath.startsWith(prefix)) return;
    throw new Error("command path escaped its discovery root");
  }
  const rel = relative(canonicalRoot, canonicalPath);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
  throw new Error("command path escaped its discovery root");
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameCanonicalPath(left: string, right: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return left === right;
  return relative(left, right) === "" && relative(right, left) === "";
}

export async function validateCommandRootBinding(
  binding: CommandRootBinding,
  deadline: number,
): Promise<void> {
  const requestedEntry = await withinDiscoveryDeadline(
    () => lstat(binding.requestedRoot), deadline, "command discovery",
  );
  if (!sameFileIdentity(requestedEntry, binding.requestedEntry)) {
    throw new Error("command root changed during discovery");
  }
  const canonicalRoot = await withinDiscoveryDeadline(
    () => realpath(binding.requestedRoot), deadline, "command discovery",
  );
  if (!sameCanonicalPath(canonicalRoot, binding.canonicalRoot, binding.caseSensitiveRoot)) {
    throw new Error("command root changed during discovery");
  }
  const canonicalEntry = await withinDiscoveryDeadline(
    () => stat(canonicalRoot), deadline, "command discovery",
  );
  if (!canonicalEntry.isDirectory() || !sameFileIdentity(canonicalEntry, binding.canonicalEntry)) {
    throw new Error("command root changed during discovery");
  }
}

export async function readBoundedNative(
  path: string,
  canonicalRoot: string,
  deadline: number,
  caseSensitiveRoot: boolean,
  openFile: (path: string, flags: number) => Promise<FileHandle>,
): Promise<string> {
  const entry = await withinDiscoveryDeadline(() => lstat(path), deadline, "command discovery");
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("command file is not a regular in-root file");
  const beforeOpen = await withinDiscoveryDeadline(() => realpath(path), deadline, "command discovery");
  assertClaudeCommandPathContained(canonicalRoot, beforeOpen, caseSensitiveRoot);
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await acquireWithinDiscoveryDeadline(
    () => openFile(path, constants.O_RDONLY | noFollow),
    deadline,
    "command discovery",
  );
  try {
    const opened = await withinDiscoveryDeadline(() => handle.stat(), deadline, "command discovery");
    if (!opened.isFile()) throw new Error("command file is not regular after open");
    const afterOpen = await withinDiscoveryDeadline(() => realpath(path), deadline, "command discovery");
    assertClaudeCommandPathContained(canonicalRoot, afterOpen, caseSensitiveRoot);
    const named = await withinDiscoveryDeadline(() => stat(afterOpen), deadline, "command discovery");
    if (opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new Error("command file changed during discovery");
    }
    const buffer = Buffer.alloc(CLAUDE_COMMAND_LIMITS.maxFileBytes);
    const { bytesRead } = await withinDiscoveryDeadline(
      () => handle.read(buffer, 0, buffer.length, 0),
      deadline,
      "command discovery",
    );
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await closeWithinDiscoveryDeadline(handle, deadline);
  }
}

/** Bounded, containment-checked enumeration of `.md` command files below one source root. Shared
 * with Codex prompt discovery, which reads only the root's own entries (`maxDepth: 0`). */
export async function nativeCommandFiles(
  root: string,
  source: CommandFile["source"],
  deadline: number,
  options: {
    caseSensitiveRoot: boolean;
    maxDepth?: number;
    /** Maps a root-relative file path to its command name, or null to skip it. Defaults to a
     * `.md` file's basename. */
    nameFile?: (relativePath: string, pathSeparator: string) => string | null;
    beforeDirectoryRead?: ClaudeSlashCommandDiscoveryDeps["beforeNativeDirectoryRead"];
    beforeRootRealpath?: ClaudeSlashCommandDiscoveryDeps["beforeNativeRootRealpath"];
    openDirectory: (path: string) => Promise<Dir>;
  },
): Promise<NativeCommandFileDiscovery> {
  let canonicalRoot: string;
  let rootEntry: Stats;
  try {
    rootEntry = await withinDiscoveryDeadline(() => lstat(root), deadline, "command discovery");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [] };
    throw error;
  }
  if (!rootEntry.isSymbolicLink() && !rootEntry.isDirectory()) return { files: [] };
  const initialCanonicalRoot = await withinDiscoveryDeadline(
    () => realpath(root), deadline, "command discovery",
  );
  const initialCanonicalEntry = await withinDiscoveryDeadline(
    () => stat(initialCanonicalRoot), deadline, "command discovery",
  );
  if (!initialCanonicalEntry.isDirectory()) return { files: [] };
  await withinDiscoveryDeadline(
    async () => options.beforeRootRealpath?.(root), deadline, "command discovery",
  );
  canonicalRoot = await withinDiscoveryDeadline(() => realpath(root), deadline, "command discovery");
  const canonicalEntry = await withinDiscoveryDeadline(() => stat(canonicalRoot), deadline, "command discovery");
  if (
    !canonicalEntry.isDirectory() ||
    !sameCanonicalPath(initialCanonicalRoot, canonicalRoot, options.caseSensitiveRoot) ||
    !sameFileIdentity(initialCanonicalEntry, canonicalEntry)
  ) throw new Error("command root changed during discovery");
  const binding: CommandRootBinding = {
    requestedRoot: root,
    requestedEntry: rootEntry,
    canonicalRoot,
    canonicalEntry,
    caseSensitiveRoot: options.caseSensitiveRoot,
  };
  await validateCommandRootBinding(binding, deadline);

  const files: CommandFile[] = [];
  const pending = [{ dir: canonicalRoot, depth: 0 }];
  let visitedDirectories = 0;
  while (
    pending.length &&
    files.length < CLAUDE_COMMAND_LIMITS.maxFilesPerSource &&
    visitedDirectories < CLAUDE_COMMAND_LIMITS.maxDirectoriesPerSource
  ) {
    const current = pending.shift()!;
    visitedDirectories += 1;
    let directory: Dir;
    try {
      await withinDiscoveryDeadline(
        async () => options.beforeDirectoryRead?.(current.dir),
        deadline,
        "command discovery",
      );
      const currentEntry = await withinDiscoveryDeadline(
        () => lstat(current.dir), deadline, "command discovery",
      );
      if (currentEntry.isSymbolicLink() || !currentEntry.isDirectory()) {
        throw new Error("command directory changed during discovery");
      }
      assertClaudeCommandPathContained(canonicalRoot, await withinDiscoveryDeadline(
        () => realpath(current.dir), deadline, "command discovery",
      ), options.caseSensitiveRoot);
      directory = await acquireWithinDiscoveryDeadline(
        () => options.openDirectory(current.dir), deadline, "command discovery",
      );
    } catch (error) {
      if (current.depth > 0 && ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    const entries: Dirent[] = [];
    try {
      while (true) {
        const entry = await withinDiscoveryDeadline(() => directory.read(), deadline, "command discovery");
        if (!entry) break;
        let low = 0;
        let high = entries.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (compareStable(entries[middle]!.name, entry.name) <= 0) low = middle + 1;
          else high = middle;
        }
        if (low < CLAUDE_COMMAND_LIMITS.maxEntriesPerDirectory) {
          entries.splice(low, 0, entry);
          if (entries.length > CLAUDE_COMMAND_LIMITS.maxEntriesPerDirectory) entries.pop();
        }
      }
    } finally {
      await closeWithinDiscoveryDeadline(directory, deadline);
    }
    for (const entry of entries) {
      if (files.length >= CLAUDE_COMMAND_LIMITS.maxFilesPerSource) break;
      const path = join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < (options.maxDepth ?? CLAUDE_COMMAND_LIMITS.maxDepth)) {
        pending.push({ dir: path, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        const name = (options.nameFile ?? commandName)(relative(canonicalRoot, path), sep);
        if (name) files.push({ path, name, source, canonicalRoot, caseSensitiveRoot: options.caseSensitiveRoot });
      }
      // Symlinks are deliberately skipped: discovery must stay within the documented source root.
    }
  }
  await validateCommandRootBinding(binding, deadline);
  return { files, binding };
}

export async function executeWithinWslBudget(
  execute: NonNullable<ClaudeSlashCommandDiscoveryDeps["run"]>,
  deadline: number,
  file: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<ExecResult> {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error("WSL command discovery deadline exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execute(file, args, {
        ...options,
        timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? remaining, remaining)),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("WSL command discovery deadline exceeded")), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function mergeClaudeSlashCommands(commands: DiscoveredClaudeSlashCommand[]): DiscoveredClaudeSlashCommand[] {
  const byName = new Map<string, DiscoveredClaudeSlashCommand>();
  const stable = [...commands].sort((a, b) => compareStable(a.name, b.name));
  for (const command of stable.filter((entry) => entry.source === "project")) {
    const key = command.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, command);
  }
  // Claude's documented precedence is personal commands over project commands.
  const personal = new Map<string, DiscoveredClaudeSlashCommand>();
  for (const command of stable.filter((entry) => entry.source === "user")) {
    const key = command.name.toLowerCase();
    if (!personal.has(key)) personal.set(key, command);
  }
  for (const [key, command] of personal) byName.set(key, command);
  // Plugin commands are namespaced by their plugin (`plugin:command`), so they never collide.
  for (const command of stable.filter((entry) => entry.source === "plugin")) {
    const key = command.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, command);
  }
  return [...byName.values()].sort((a, b) => compareStable(a.name, b.name));
}

export async function discoverClaudeSlashCommands(
  request: ClaudeSlashCommandDiscoveryRequest,
  deps: ClaudeSlashCommandDiscoveryDeps = {},
): Promise<ClaudeSlashCommandDiscoveryResult> {
  const sessionRoot = request.worktreePath ?? request.repoPath;
  try {
    const files: CommandFile[] = [];
    const skillFiles: CommandFile[] = [];
    const contents = new Map<string, string>();
    const includeUserCommands = request.includeUserCommands !== false;
    let userRoot: string | undefined;
    let projectRoot: string;
    let userSkillRoot: string | undefined;
    let projectSkillRoot: string;
    const pluginRoots: Array<{ name: string; root: string }> = [];
    let deadline = Date.now();
    if (request.context.kind === "native") {
      const budgetMs = Math.max(1, Math.min(
        deps.nativeDiscoveryTimeoutMs ?? CLAUDE_COMMAND_LIMITS.maxNativeDiscoveryMs,
        CLAUDE_COMMAND_LIMITS.maxNativeDiscoveryMs,
      ));
      deadline = Date.now() + budgetMs;
      if (includeUserCommands) {
        const home = (deps.nativeHome ?? homedir)();
        userRoot = join(home, ".claude", "commands");
        userSkillRoot = join(home, ".claude", "skills");
        for (const plugin of request.pluginRoots ?? []) {
          if (isAbsolute(plugin.path)) pluginRoots.push({ name: plugin.name, root: plugin.path });
        }
      }
      projectRoot = join(sessionRoot, ".claude", "commands");
      projectSkillRoot = join(sessionRoot, ".claude", "skills");
    } else {
      const rawExecute = deps.run ?? run;
      const budgetMs = Math.max(1, Math.min(
        deps.wslDiscoveryTimeoutMs ?? CLAUDE_COMMAND_LIMITS.maxWslDiscoveryMs,
        CLAUDE_COMMAND_LIMITS.maxWslDiscoveryMs,
      ));
      deadline = Date.now() + budgetMs;
      const execute: NonNullable<ClaudeSlashCommandDiscoveryDeps["run"]> =
        (file, args, options) => executeWithinWslBudget(rawExecute, deadline, file, args, options);
      const distro = request.context.distro;
      const mapWslPath = deps.wslPathToWindows ?? wslAbsolutePathToUnc;
      if (includeUserCommands) {
        const home = await execute("wsl.exe", ["-d", distro, "--exec", "printenv", "HOME"], { timeoutMs: 6_000 });
        if (home.timedOut) throw new Error("WSL home lookup timed out");
        if (home.errorCode || home.code !== 0 || !home.stdout.trim()) {
          throw new Error((home.errorCode ?? home.stderr.trim()) || "could not resolve WSL home");
        }
        const wslHome = home.stdout.trim().split(/\r?\n/, 1)[0]!;
        userRoot = mapWslPath(distro, posix.join(wslHome, ".claude", "commands"));
        userSkillRoot = mapWslPath(distro, posix.join(wslHome, ".claude", "skills"));
        for (const plugin of request.pluginRoots ?? []) {
          if (posix.isAbsolute(plugin.path) && posix.normalize(plugin.path) === plugin.path) {
            pluginRoots.push({ name: plugin.name, root: mapWslPath(distro, plugin.path) });
          }
        }
      }
      projectRoot = mapWslPath(distro, posix.join(sessionRoot, ".claude", "commands"));
      projectSkillRoot = mapWslPath(distro, posix.join(sessionRoot, ".claude", "skills"));
    }

    const caseSensitiveRoot = request.context.kind === "wsl";
    const traversalOptions = {
      caseSensitiveRoot,
      beforeDirectoryRead: deps.beforeNativeDirectoryRead,
      beforeRootRealpath: deps.beforeNativeRootRealpath,
      openDirectory: deps.openNativeDirectory ?? ((path: string) => opendir(path)),
    };
    const discoveries: NativeCommandFileDiscovery[] = [];
    const commandRoot = async (root: string, source: CommandFile["source"], options: Partial<typeof traversalOptions> & {
      maxDepth?: number;
      nameFile?: (relativePath: string, pathSeparator: string) => string | null;
    } = {}) => {
      const discovery = await nativeCommandFiles(root, source, deadline, { ...traversalOptions, ...options });
      discoveries.push(discovery);
      return discovery.files;
    };
    if (userRoot) files.push(...await commandRoot(userRoot, "user"));
    files.push(...await commandRoot(projectRoot, "project"));
    if (userSkillRoot) skillFiles.push(...await commandRoot(userSkillRoot, "user", { maxDepth: 1, nameFile: skillName }));
    skillFiles.push(...await commandRoot(projectSkillRoot, "project", { maxDepth: 1, nameFile: skillName }));
    for (const plugin of pluginRoots) {
      // Plugin commands and skills are namespaced by their plugin, as Claude Code lists them. A
      // plugin root that can't be read loses only its own descriptions, never the whole catalog.
      const prefixed = (name: string | null) => name ? `${plugin.name}:${name}` : null;
      try {
        files.push(...await commandRoot(join(plugin.root, "commands"), "plugin", {
          maxDepth: 0,
          nameFile: (path, separator) => prefixed(commandName(path, separator)),
        }));
        skillFiles.push(...await commandRoot(join(plugin.root, "skills"), "plugin", {
          maxDepth: 1,
          nameFile: (path, separator) => prefixed(skillName(path, separator)),
        }));
      } catch (error) {
        if (!["EACCES", "EPERM", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    files.sort((left, right) => compareStable(left.path, right.path));
    skillFiles.sort((left, right) => compareStable(left.path, right.path));
    for (const file of [...files, ...skillFiles]) {
      try {
        await withinDiscoveryDeadline(
          async () => deps.beforeNativeCommandRead?.(file.path),
          deadline,
          "command discovery",
        );
        contents.set(file.path, await readBoundedNative(
          file.path,
          file.canonicalRoot!,
          deadline,
          file.caseSensitiveRoot ?? false,
          deps.openNativeFile ?? ((path, flags) => open(path, flags)),
        ));
      } catch (error) {
        if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
    }

    for (const discovery of discoveries) {
      if (discovery.binding) await validateCommandRootBinding(discovery.binding, deadline);
    }

    const commands = files.filter((file) => contents.has(file.path)).map((file) => ({
      name: file.name,
      source: file.source,
      ...parseClaudeCommandMetadata(contents.get(file.path) ?? ""),
    }));
    const skills = skillFiles.filter((file) => contents.has(file.path)).map((file): ClaudeSkillMetadata => ({
      name: file.name,
      origin: file.source,
      ...parseClaudeSkillMetadata(contents.get(file.path) ?? ""),
    }));
    return { ok: true, commands: mergeClaudeSlashCommands(commands), skills };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Claude command discovery failed: ${detail || "unknown error"}` };
  }
}

/** Apply a fresh discovery atomically. A successful empty result intentionally clears stale
 * commands; a failed discovery preserves the exact prior catalog for restart/resume resilience. */
export async function refreshClaudeSlashCommandCatalog(
  previous: readonly DiscoveredClaudeSlashCommand[],
  request: ClaudeSlashCommandDiscoveryRequest,
  deps: ClaudeSlashCommandDiscoveryDeps = {},
): Promise<ClaudeSlashCommandRefreshResult> {
  const discovered = await discoverClaudeSlashCommands(request, deps);
  if (!discovered.ok) return { outcome: "retained", commands: previous, error: discovered.error };
  return {
    outcome: discovered.commands.length || discovered.skills.length ? "updated" : "cleared",
    commands: discovered.commands,
    skills: discovered.skills,
  };
}

/** Store a session's catalog sources and the menu merged from them (#1224). */
export function applyClaudeSessionCatalog(meta: SessionMeta, inputs: ClaudeSessionCatalogInputs): void {
  const merged = mergeClaudeSessionCatalog(inputs);
  meta.claudeSlashCatalogInputs = inputs;
  meta.sessionSlashCommands = merged.commands;
  meta.sessionUnsupportedSlashCommands = merged.unsupported.length ? merged.unsupported : undefined;
}

function clearClaudeSessionCatalog(meta: SessionMeta): void {
  meta.sessionSlashCommands = undefined;
  meta.sessionSlashCommandProvenance = undefined;
  meta.claudeSlashCatalogInputs = undefined;
  meta.sessionUnsupportedSlashCommands = undefined;
}

/** Refresh one launch atomically and bind retained results to the exact runner-local boundary that
 * produced them. Cloud handoffs intentionally publish an authoritative empty overlay until the
 * target itself exposes a command-enumeration contract. */
export async function prepareClaudeSlashCommandCatalog(
  meta: SessionMeta,
  deps: ClaudeSlashCommandDiscoveryDeps = {},
): Promise<ClaudeSlashCommandPreparationResult> {
  if (meta.driver !== "claude-code") {
    clearClaudeSessionCatalog(meta);
    return { outcome: "cleared" };
  }

  const provenance = claudeSlashCommandProvenance(meta);
  const priorMatches = sameClaudeSlashCommandProvenance(meta.sessionSlashCommandProvenance, provenance);
  // The last init list Claude Code reported for this exact boundary stays authoritative until the
  // relaunched process reports its own, so a relaunch doesn't drop the built-ins meanwhile.
  const priorInit = priorMatches ? meta.claudeSlashCatalogInputs?.init : undefined;
  if (provenance.targetAdapter === "cloud") {
    // Nothing on disk is the cloud target's; only the target's own init list names its commands.
    applyClaudeSessionCatalog(meta, { commands: [], skills: [], ...(priorInit ? { init: priorInit } : {}) });
    meta.sessionSlashCommandProvenance = provenance;
    return { outcome: "cleared" };
  }

  const previous = priorMatches
    ? (meta.claudeSlashCatalogInputs?.commands ?? meta.sessionSlashCommands ?? [])
    : [];
  if (!priorMatches) clearClaudeSessionCatalog(meta);
  const refreshed = await refreshClaudeSlashCommandCatalog(previous, {
    context: meta.context,
    repoPath: meta.repoPath,
    worktreePath: meta.worktreePath,
    includeUserCommands: provenance.includeUserCommands,
    ...(priorInit?.plugins.length ? { pluginRoots: priorInit.plugins } : {}),
  }, deps);
  if (refreshed.outcome === "retained") {
    if (priorMatches) return { outcome: "retained", error: refreshed.error };
    return { outcome: "discarded", error: refreshed.error };
  }
  applyClaudeSessionCatalog(meta, {
    commands: [...refreshed.commands],
    skills: refreshed.skills,
    ...(priorInit ? { init: priorInit } : {}),
  });
  meta.sessionSlashCommandProvenance = provenance;
  return { outcome: refreshed.outcome };
}
