import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, matchesGlob, normalize, parse as parsePath, resolve, sep } from "node:path";
import { parse, type ParseEntry } from "shell-quote";

const MAX_COMMAND_LENGTH = 32_768;
const MAX_GLOB_METACHARACTERS = 64;
const MAX_GLOB_BRACE_GROUPS = 8;
const MAX_ENV_SPLIT_STRING_EXPANSIONS = 8;
const MAX_ENV_ASSIGNMENT_READINGS = 32;
const MAX_CLASSIFICATION_TOKEN_VISITS = 262_144;
const MAX_DESTRUCTIVE_OPERAND_VISITS = 4_096;
const MAX_CWD_READINGS = 8;
const MAX_EMPTY_COMMAND_EXPANSIONS = 16;
export const MANAGED_WORKTREE_REFUSAL =
  "Wollipog protects this runner-owned worktree. Use discard_worktree so retirement can wait for the provider to exit and then apply the managed safety checks.";

/**
 * Refusal for a destructive command whose target the classifier cannot place (#1324): an unknown
 * variable, a command substitution, a backtick, or a relative path after a `cd` it cannot follow.
 */
export const MANAGED_WORKTREE_UNRESOLVED_REFUSAL =
  "Wollipog cannot tell where this destructive command's target resolves while a runner-owned worktree is protected, so it was not run. Name the target as a literal path, or through a variable the session environment already defines; to retire the worktree itself, use discard_worktree.";

/**
 * Refusal for a `cd` or `pushd` that would leave a managed worktree. The shell keeps its directory
 * between calls, so the escape is refused exactly as before; it only no longer blames the worktree
 * itself, which sent sessions to `discard_worktree` for an ordinary change of directory (#1632).
 */
export const MANAGED_WORKTREE_ESCAPE_REFUSAL =
  "Wollipog keeps this shell inside its managed worktree, and this cd would leave it, so the command was not run. Name files outside the worktree by absolute path instead of changing directory; to retire the worktree itself, use discard_worktree.";

/**
 * Refusal for a Git command that would move a session's own worktree off the branch it is verified
 * on before every turn (#1650). Nothing refused it before, and the session then stopped receiving
 * prompts until someone restored the branch by hand.
 */
export const MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL =
  "Wollipog verifies before every turn that this session's own worktree is still on the branch it was created with, so this command, which would switch, detach, or rename that worktree's branch, was not run: the session would stop receiving prompts until its worktree was recovered. To work on another branch, create a separate worktree with `wollipog worktree create --branch <name>` (or the create_worktree tool) and use the absolute path it returns. Switching this worktree back to its own branch is always allowed; to restore a file rather than switch branches, name it after `--` (`git checkout -- <path>`) or use `git restore <path>`.";

export interface ManagedWorktreeProtection {
  worktreePath: string;
  repoPath: string;
  /**
   * The branch a Git command run inside this worktree must leave it on (#1650). Set only for a
   * session's own default worktree (`agent/<session-id>`), whose branch is its identity: switching
   * it parks the session in worktree recovery. A worktree the session created for another branch
   * carries none, so ordinary branch work there is unaffected.
   */
  pinnedBranch?: string;
}

/**
 * The environment the provider's shell starts from: the one the runner passed it. A value may be
 * undefined only because `process.env` is typed that way.
 */
export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

interface ExpandedField {
  expandedField: string;
  expandsLeadingTilde: boolean;
}
type ShellToken = ParseEntry | ExpandedField;

/**
 * What one command, segment, or operand amounts to: it reaches a protected root (`protected`), it
 * changes directory out of one (`escape`), it moves a pinned worktree off its branch (`branch`), it
 * is destructive but its target cannot be placed (`unresolved`), or neither (`null`). `protected`,
 * `escape`, and `branch` all refuse outright; they differ only in the message.
 */
type Verdict = "protected" | "escape" | "branch" | "unresolved" | null;

function refuses(verdict: Verdict): verdict is "protected" | "escape" | "branch" {
  return verdict === "protected" || verdict === "escape" || verdict === "branch";
}

/**
 * Raised when provider input exceeds an explicit parsing bound. The exported guard turns it into a
 * refusal, so a command the classifier declines to keep parsing retains the managed worktree.
 */
class UnclassifiableCommandError extends Error {}

/**
 * Variable references are parsed into NUL-delimited placeholders rather than values, so a word such
 * as `"$W/x"` stays ONE word (shell-quote splits a reference returned as an object from its
 * neighbours) and is expanded only when it is read, against the assignments seen up to that point.
 * The exported guard rejects any command containing NUL, so provider text cannot forge one.
 */
const REFERENCE = /\0([^\0]*)\0/gu;
const reference = (name: string) => `\0${name}\0`;
/** A reference that is known not to resolve: `$(`, a bare `$`, or a value built from one. */
const UNRESOLVED_REFERENCE = reference("");
/** Rendered in place of an unresolved reference when a script is re-parsed; never resolves. */
const UNRESOLVED_NAME = "__WOLLIPOG_UNRESOLVED__";
/**
 * Variables the shell rewrites as it runs, so the value the runner passed the provider is stale.
 * `PWD` and `CWD` are answered from the tracked working directory instead; the rest never resolve.
 */
const SHELL_MAINTAINED = new Set(["OLDPWD", "DIRSTACK", "_", UNRESOLVED_NAME]);

/**
 * The working directory after a `cd` whose target could not be resolved. Absolute operands are
 * still judged; anything relative to it is unresolved.
 */
const UNKNOWN_CWD = `${sep}.wollipog-unknown-cwd${`${sep}x`.repeat(64)}`;

function operator(token: ShellToken | undefined): string | null {
  return token != null && typeof token === "object" && "op" in token && token.op !== "glob" &&
      typeof token.op === "string"
    ? token.op
    : null;
}

function pathContains(parent: string, child: string): boolean {
  const foldCase = process.platform === "win32" || process.platform === "darwin";
  const normalizedParent = foldCase ? normalize(parent).toLowerCase() : normalize(parent);
  const normalizedChild = foldCase ? normalize(child).toLowerCase() : normalize(child);
  // A filesystem root already ends with the separator; appending another made `/` the ancestor
  // of nothing, so `rm -rf /` and any `..` chain that climbed to the root were never refused.
  const prefix = normalizedParent.endsWith(sep) ? normalizedParent : `${normalizedParent}${sep}`;
  return normalizedChild === normalizedParent || normalizedChild.startsWith(prefix);
}

function withinProtectedRoot(path: string, protections: readonly ManagedWorktreeProtection[]): boolean {
  return protections.some(({ worktreePath }) => pathContains(worktreePath, path));
}

function protectedAdministrativeRoots(
  protection: ManagedWorktreeProtection,
): string[] {
  return [
    resolve(protection.worktreePath, ".git"),
    resolve(protection.repoPath, ".git", "worktrees"),
  ];
}

function protectedTarget(path: string, protections: readonly ManagedWorktreeProtection[]): boolean {
  return protections.some((protection) =>
    pathContains(path, protection.worktreePath) ||
    protectedAdministrativeRoots(protection).some((root) =>
      pathContains(path, root) || pathContains(root, path)));
}

function protectionRepository(path: string, protections: readonly ManagedWorktreeProtection[]): boolean {
  return protections.some(({ repoPath, worktreePath }) =>
    pathContains(repoPath, path) || pathContains(worktreePath, path));
}

/** The raw text of a plain word, including one produced by field expansion. */
function plainWordText(token: ShellToken | undefined): string | null {
  if (typeof token === "string") return token;
  if (token != null && typeof token === "object" && "expandedField" in token) return token.expandedField;
  return null;
}

/** The raw text of a word token (a plain word or a glob), placeholders included. */
function wordText(token: ShellToken | undefined): string | null {
  const plain = plainWordText(token);
  if (plain !== null) return plain;
  if (token != null && typeof token === "object" && "op" in token && token.op === "glob" &&
      "pattern" in token && typeof token.pattern === "string") return token.pattern;
  return null;
}

/** Whether a leading tilde came from shell syntax, rather than from parameter expansion. */
function expandsLeadingTilde(token: ShellToken | undefined): boolean {
  if (token != null && typeof token === "object" && "expandedField" in token) {
    return token.expandsLeadingTilde;
  }
  return wordText(token)?.startsWith("~") === true;
}

function lookup(name: string, cwd: string, environment: ReadonlyMap<string, string>): string | undefined {
  if (name === "PWD" || name === "CWD") return cwd === UNKNOWN_CWD ? undefined : cwd;
  if (SHELL_MAINTAINED.has(name)) return undefined;
  // `env` can create keys that a shell cannot reference. shell-quote may parse the
  // whole body of `${A-.}` as a name, but the shell reads `A` with a default of `.`.
  // Never let such a key shadow the shell's actual expansion.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return undefined;
  return environment.get(name);
}

/** Expand every placeholder that resolves; one that does not becomes `UNRESOLVED_REFERENCE`. */
function expandReferences(text: string, cwd: string, environment: ReadonlyMap<string, string>): string {
  return text.replace(REFERENCE, (_, name: string) => lookup(name, cwd, environment) ?? UNRESOLVED_REFERENCE);
}

/**
 * A word as the shell will see it, or null when it is not a word or cannot be resolved: a variable
 * neither the provider environment nor this command defines, a command substitution, a backtick.
 */
function word(
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
): string | null {
  const text = wordText(token);
  if (text == null || text.includes("`")) return null;
  const value = expandReferences(text, cwd, environment);
  return value.includes("\0") || value.includes("`") ? null : value;
}

/**
 * The characters the shell splits an unquoted expansion on, or `null` when `IFS` is set to
 * something this code cannot see. The default is whitespace; a custom `IFS` is taken as ADDITIONAL
 * separators rather than as a replacement, so a field is never missed for splitting too eagerly.
 */
function fieldSeparators(cwd: string, environment: ReadonlyMap<string, string>): Set<string> | null {
  const ifs = lookup("IFS", cwd, environment);
  if (ifs != null && (ifs.includes("\0") || ifs.includes("`"))) return null;
  return new Set([" ", "\t", "\n", ...(ifs ?? "")]);
}

/**
 * The fields an unquoted expansion becomes. A word with no reference in it is one field whatever it
 * contains — the shell does not re-split literal text — so only a word built from a reference is
 * split. `null` when the separators themselves are unknown.
 */
function expansionFields(
  text: string,
  value: string,
  cwd: string,
  environment: ReadonlyMap<string, string>,
  separatorsOverride?: Set<string>,
): string[] | null {
  if (!text.includes("\0")) return [value];
  const separators = separatorsOverride ?? fieldSeparators(cwd, environment);
  if (separators === null) return null;
  const fields: string[] = [];
  let current = "";
  for (const character of value) {
    if (!separators.has(character)) { current += character; continue; }
    if (current) fields.push(current);
    current = "";
  }
  if (current) fields.push(current);
  return fields;
}

/**
 * A word rendered back into shell text for a nested parse (`sh -c`, `eval`). The outer shell has
 * already expanded what it can, so a resolved value is inlined as text and the nested parse splits
 * it as the nested shell would; a reference that cannot be resolved becomes one that never does,
 * so it reaches the nested classification as unresolved rather than vanishing.
 */
function scriptText(
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
): string | null {
  const text = wordText(token);
  if (text == null || text.includes("`")) return text;
  return text.replace(REFERENCE, (_, name: string) => {
    const value = lookup(name, cwd, environment);
    return value == null || value.includes("\0") ? `\${${UNRESOLVED_NAME}}` : value;
  });
}

function globPattern(
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
): string | null {
  const value = word(token, cwd, environment);
  if (value == null) return null;
  if (typeof token !== "string" || /[*?\[\]{}]/u.test(value)) return value;
  return null;
}

function ancestors(path: string): string[] {
  const values: string[] = [];
  let current = normalize(path);
  for (;;) {
    values.push(current);
    const parent = dirname(current);
    if (parent === current) return values;
    current = parent;
  }
}

function globTargetsProtected(
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
): boolean {
  const pattern = globPattern(token, cwd, environment);
  if (!pattern || pattern.includes("\0")) return false;
  const metacharacters = pattern.match(/[*?\[\]{}]/gu)?.length ?? 0;
  const braceGroups = pattern.match(/\{/gu)?.length ?? 0;
  // Destructive glob targets are provider-controlled input. Bound expansion complexity before
  // asking Node's matcher to interpret them; an over-complex target fails closed below.
  if (metacharacters > MAX_GLOB_METACHARACTERS || braceGroups > MAX_GLOB_BRACE_GROUPS) return true;
  const absolutePattern = normalize(isAbsolute(pattern) ? pattern : resolve(cwd, pattern));
  const foldCase = process.platform === "win32" || process.platform === "darwin";
  const comparablePattern = foldCase ? absolutePattern.toLowerCase() : absolutePattern;
  const firstMeta = absolutePattern.search(/[*?\[\]{}]/u);
  const literalPrefix = firstMeta < 0 ? absolutePattern : absolutePattern.slice(0, firstMeta);
  const staticParent = normalize(literalPrefix.endsWith(sep)
    ? literalPrefix.slice(0, -1)
    : dirname(literalPrefix));
  return protections.some((protection) => {
    const matchesRootOrAncestor = ancestors(protection.worktreePath).some((candidate) => {
      try {
        return matchesGlob(foldCase ? candidate.toLowerCase() : candidate, comparablePattern);
      } catch {
        return true;
      }
    });
    if (matchesRootOrAncestor) return true;
    return protectedAdministrativeRoots(protection).some((root) =>
      pathContains(root, staticParent) ||
      ancestors(root).some((candidate) => {
        try {
          return matchesGlob(foldCase ? candidate.toLowerCase() : candidate, comparablePattern);
        } catch {
          return true;
        }
      }));
  });
}

/**
 * The protections as the kernel sees them: a worktree registered through a symlinked prefix is
 * the same directory as its physical path, and the physical reading below must compare like with
 * like or every relative operand beneath such a worktree would read as an escape.
 */
function physicalProtections(protections: readonly ManagedWorktreeProtection[]): ManagedWorktreeProtection[] {
  return protections.map((protection) => ({
    ...protection,
    worktreePath: canonicalPath(normalize(protection.worktreePath)),
    repoPath: canonicalPath(normalize(protection.repoPath)),
  }));
}

/** Where an external command finds `cwd`: symlinks resolved, as the kernel resolves `..` from it. */
function physicalCwd(cwd: string): string {
  return canonicalPath(normalize(cwd));
}

/**
 * Resolve an operand the way the kernel does: one component at a time from the physical
 * directory, following each intermediate symlink BEFORE the next `..` is applied. A textual
 * `resolve()` collapses `alias/..` to nothing, which is exactly the step a symlink changes.
 */
function physicalResolve(cwd: string, value: string, followFinalSymlink: boolean): string {
  // Platform path semantics, not a guess: on POSIX a backslash is an ordinary filename character.
  const windows = process.platform === "win32";
  const root = windows ? parsePath(value).root : value.startsWith("/") ? "/" : "";
  let current = root ? canonicalPath(resolve(root)) : physicalCwd(cwd);
  const parts = value.slice(root.length).split(windows ? /[\\/]+/u : /\/+/u)
    .filter((part) => part && part !== ".");
  // Provider-controlled depth. Past a generous bound the operand is refused outright: falling
  // back to a textual collapse would restore exactly the blindness this walk exists to remove.
  if (parts.length > 256) throw new UnclassifiableCommandError("operand path is too deep to resolve");
  parts.forEach((part, index) => {
    if (part === "..") {
      current = dirname(current);
      return;
    }
    const next = resolve(current, part);
    current = index === parts.length - 1 && !followFinalSymlink ? next : canonicalPath(next);
  });
  return current;
}

/**
 * Whether the shell is inside a managed worktree, by spelling OR physically. The guard hook is
 * handed Claude's physical directory (`pwd -P`), while a worktree can be registered through a
 * symlinked prefix: comparing spellings alone made such a shell look like it was somewhere else,
 * which silently skipped the escape check. Where a `cd` LANDS is decided physically only, because
 * that is where the shell really ends up.
 */
function shellInsideManagedRoot(cwd: string, protections: readonly ManagedWorktreeProtection[]): boolean {
  return withinProtectedRoot(cwd, protections) ||
    withinProtectedRoot(physicalCwd(cwd), physicalProtections(protections));
}

/**
 * Judge one operand of a destructive command. An operand the classifier cannot place is
 * `unresolved`, never harmless (#1324): the shell will expand it into a path this code never sees.
 */
function operandVerdict(
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
  // `rm`, `unlink`, `trash`, and an `mv` source act on a final symlink ITSELF, so removing a
  // harmless alias that points at the worktree is not a removal of the worktree. A trailing slash
  // (or `/.`) makes the kernel follow it after all.
  followFinalSymlink = true,
  // Past a `--` every remaining word is an operand, however it is spelled.
  optionsEnded = false,
): Verdict {
  const value = word(token, cwd, environment);
  if (value == null) return wordText(token) == null ? null : "unresolved";
  const expandTilde = expandsLeadingTilde(token);
  // An unquoted expansion is field-split by the shell, and this parser no longer knows which
  // expansions were quoted. A value built from a reference is judged whole AND field by field; if
  // the separators themselves cannot be read, the operand cannot be placed at all.
  const fields = expansionFields(wordText(token) ?? "", value, cwd, environment);
  if (fields === null) return "unresolved";
  if (fields.length !== 1 || fields[0] !== value) {
    return strongest([value, ...fields].map((field) =>
      literalOperandVerdict(field, field, cwd, environment, protections, followFinalSymlink, optionsEnded,
        expandTilde)));
  }
  return literalOperandVerdict(value, token, cwd, environment, protections, followFinalSymlink, optionsEnded,
    expandTilde);
}

function literalOperandVerdict(
  value: string,
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
  followFinalSymlink: boolean,
  optionsEnded: boolean,
  expandsLeadingTilde: boolean,
): Verdict {
  const expandedValue = expandsLeadingTilde && value.startsWith("~")
    ? expandOperandHome(value, cwd, environment)
    : value;
  if (expandedValue == null) return "unresolved";
  // An option word names no path, so it must not read as a relative operand once the working
  // directory is unknown: `rm -rf /tmp/scratch` is placeable there and `rm -rf build` is not. After
  // `--` there are no options left, so a dashed word there IS a path (`rm -- -managed`).
  if (cwd === UNKNOWN_CWD && !isAbsolute(expandedValue) &&
      (optionsEnded || !expandedValue.startsWith("-"))) {
    return "unresolved";
  }
  const target = resolvedPath(expandedValue, cwd);
  if (target == null) {
    return globTargetsProtected(expandedValue, cwd, environment, protections) ||
        globTargetsProtected(expandedValue, physicalCwd(cwd), environment, physicalProtections(protections))
      ? "protected"
      : null;
  }
  if (protectedTarget(target, protections)) return "protected";
  // The shell's `cd` is logical, but the command this operand belongs to is external and the
  // kernel resolves it from the PHYSICAL directory: `..` beneath a symlink lands where the link
  // points, not where the shell prints. Judge that reading too, against the physical protections.
  const follows = followFinalSymlink ||
    (process.platform === "win32" ? /[\\/]\.?$/u : /\/\.?$/u).test(expandedValue);
  return protectedTarget(physicalResolve(cwd, expandedValue, follows), physicalProtections(protections))
    ? "protected"
    : null;
}

function resolvedPath(value: string, cwd: string): string | null {
  if (!value || value.includes("\0") || /[*?\[\]{}]/u.test(value)) return null;
  if (cwd === UNKNOWN_CWD && !isAbsolute(value)) return null;
  return normalize(isAbsolute(value) ? value : resolve(cwd, value));
}

function resolvedOperand(
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
): string | null {
  const value = word(token, cwd, environment);
  if (value == null) return null;
  const expandedValue = expandsLeadingTilde(token) && value.startsWith("~")
    ? expandOperandHome(value, cwd, environment)
    : value;
  return expandedValue == null ? null : resolvedPath(expandedValue, cwd);
}

/**
 * Match one long-option word against `option`. GNU accepts any unambiguous abbreviation, so a name
 * of at least `minimumLength` characters that prefixes `option` is that option; its value is either
 * attached after `=` or, when `attached` is null, the following word.
 */
function longOption(
  value: string,
  option: string,
  minimumLength: number,
): { attached: string | null } | null {
  if (!value.startsWith("--")) return null;
  const equals = value.indexOf("=");
  const name = equals < 0 ? value : value.slice(0, equals);
  if (name.length < minimumLength || !option.startsWith(name)) return null;
  return { attached: equals < 0 ? null : value.slice(equals + 1) };
}

const MOVE_SHORT_OPTIONS = "bfinuvZTtS";
const MOVE_VALUE_SHORT_OPTIONS = "tS";
const ENV_SHORT_OPTIONS = "i0vuCS";
const ENV_VALUE_SHORT_OPTIONS = "uCS";

/**
 * Decompose a GNU short-option cluster (`-ft/dst`, `-iS'rm -rf .'`). Scanning stops at the first
 * option taking a value; the rest of the word is that value, or null when the value is the following
 * word. A letter outside `options` means the word is not a GNU cluster at all — PowerShell's
 * `Move-Item` aliases (`mv`, `move`) name their arguments the same way, and `-LiteralPath` must not
 * be read as GNU `-t` — so the word reports null and the caller leaves it and its neighbour alone.
 */
function shortCluster(
  value: string,
  options: string,
  valueTaking: string,
): { option: string; attached: string | null } | null {
  if (value.startsWith("--")) return null;
  for (let index = 1; index < value.length; index += 1) {
    const option = value[index] ?? "";
    if (valueTaking.includes(option)) {
      return { option, attached: index === value.length - 1 ? null : value.slice(index + 1) };
    }
    if (!options.includes(option)) return null;
  }
  return null;
}

/**
 * Classify one GNU `mv` option word. The target directory may be named as `-t /dst`, `-t/dst`,
 * `-ft/dst` in a short-option cluster, or `--target-directory=/dst`, and `--target-directory` is the
 * only `mv` long option beginning with `t`. All of those spellings make every remaining operand a
 * source, so they must classify identically; report the option carried and whether its value is
 * still the following word.
 */
function moveOption(value: string): { targetDirectory: boolean; consumesNext: boolean } {
  if (value.startsWith("--")) {
    const target = longOption(value, "--target-directory", 3);
    if (target) return { targetDirectory: true, consumesNext: target.attached == null };
    const suffix = longOption(value, "--suffix", 4);
    return { targetDirectory: false, consumesNext: suffix != null && suffix.attached == null };
  }
  const cluster = shortCluster(value, MOVE_SHORT_OPTIONS, MOVE_VALUE_SHORT_OPTIONS);
  return {
    targetDirectory: cluster?.option === "t",
    consumesNext: cluster != null && cluster.attached == null,
  };
}

/** PowerShell mover parameters can appear in either order and accept prefixes or aliases. */
function powershellMoveParameter(
  value: string,
  executable: string,
): { role: "source" | "destination" | "other"; attached: string | null } | null {
  if (!value.startsWith("-") || value.startsWith("--")) return null;
  // `mv` and `move` also run as GNU commands. `-fi` and `-iv` have valid PowerShell readings
  // that consume a value, so judge those readings too; otherwise keep GNU clusters intact.
  const powerShellValueCluster = ["-fi", "-iv"].includes(value.toLowerCase());
  if (["mv", "move"].includes(executable) && /^-[bfinuvZTtS]+$/u.test(value) &&
      !powerShellValueCluster) return null;
  const colon = value.indexOf(":");
  const name = value.slice(1, colon < 0 ? undefined : colon).toLowerCase();
  if (!name) return null;
  const source = ["path", "literalpath"].some((parameter) => parameter.startsWith(name)) ||
    ["lp", "pspath"].includes(name);
  const rename = ["rename-item", "ren", "rni"].includes(executable);
  const destination = (rename ? "newname" : "destination").startsWith(name);
  // These value-taking options can precede a positional source. Their values must not be mistaken
  // for the source while the real source is dropped as the destination.
  const other = ["credential", "erroraction", "errorvariable", "informationaction", "informationvariable",
    "outbuffer", "outvariable", "pipelinevariable", "progressaction", "warningaction", "warningvariable",
    ...(rename ? [] : ["filter", "include", "exclude"])].some((parameter) => parameter.startsWith(name)) ||
    ["ea", "ev", "infa", "iv", "ov", "ob", "pv", "proga", "wa", "wv"].includes(name);
  if (!source && !destination && !other) return null;
  return { role: source ? "source" : destination ? "destination" : "other",
    attached: colon < 0 ? null : value.slice(colon + 1) };
}

function executableName(value: string): string {
  // zsh resolves a command-position `=name` to that command's executable path. Other shells may
  // treat it literally, so judging the named command is the protective reading.
  const expanded = /^=([^/=]+)$/u.exec(value)?.[1];
  // `cd` and `pushd` are shell builtins: zsh cannot resolve them with `=`, and treating them as
  // successful directory changes would make later relative operands resolve from the wrong cwd.
  const command = expanded && !["cd", "pushd"].includes(expanded.toLowerCase()) ? expanded : value;
  return command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase().replace(/\.exe$/u, "") ?? "";
}

/**
 * The command word at `index`, with the shell's field splitting already applied to the token list:
 * `CMD="command rm -rf"` contributes three words, and an expansion with no fields at all
 * (`$EMPTY rm -rf x`) removes itself so the next word becomes the command. Splitting before the
 * wrapper dispatch below is what lets `sudo`/`command`/`env` be recognised inside such a value.
 */
function commandWordAt(
  tokens: ShellToken[],
  index: number,
  cwd: string,
  environment: ReadonlyMap<string, string>,
): string | null {
  for (let expansions = 0; expansions <= MAX_EMPTY_COMMAND_EXPANSIONS; expansions += 1) {
    const text = wordText(tokens[index]);
    if (text === null) return null;
    const value = word(tokens[index], cwd, environment);
    if (value == null) return null;
    if (!text.includes("\0")) return value;
    const fields = expansionFields(text, value, cwd, environment);
    if (fields === null) throw new UnclassifiableCommandError("IFS cannot be read for a command word");
    tokens.splice(index, 1, ...fields);
    const first = fields[0];
    if (first !== undefined) return first;
  }
  throw new UnclassifiableCommandError("too many empty command expansions");
}

interface ParsedCommand {
  words: ShellToken[];
  executable: string;
  /** A child-only directory change from `env -C`; shell-expanded words still use the outer cwd. */
  executionCwd: string | null;
  /** External wrappers cannot run a `cd` builtin in the provider's parent shell. */
  parentShellBuiltin: boolean;
  /** Nested sh and `builtin --` may disagree across shell dialects about a directory change. */
  builtinWrapper: boolean;
  builtinOptionTerminator: boolean;
  /** The command an unquoted `env` assignment expansion could instead introduce. */
  alternateReadings: Array<{ command: ParsedCommand; environment: Map<string, string> }>;
  /**
   * The environment the command RUNS in: its prefix and `env` assignments, which its own words were
   * expanded before and which do not outlive it. A nested shell (`sh -c`, `eval`) inherits it.
   */
  childEnvironment: Map<string, string>;
}

interface EnvSplitBudget { remaining: number; remainingTokens: number; remainingDestructive: number }

function spendTokenVisits(budget: EnvSplitBudget, count: number): void {
  budget.remainingTokens -= count;
  if (budget.remainingTokens < 0) {
    throw new UnclassifiableCommandError("command classification token-work bound exceeded");
  }
}

function spendDestructiveVisits(budget: EnvSplitBudget, count: number): void {
  budget.remainingDestructive -= count;
  if (budget.remainingDestructive < 0) {
    throw new UnclassifiableCommandError("destructive operand-work bound exceeded");
  }
}

/** Include commands introduced by an unquoted env assignment expansion. */
function parsedExecutables(command: ParsedCommand | null): string[] {
  return command === null ? [] : [command.executable,
    ...command.alternateReadings.flatMap(({ command: alternative }) => parsedExecutables(alternative))];
}

function commandWords(
  tokens: ShellToken[],
  cwd: string,
  environment: Map<string, string>,
  envSplitBudget: EnvSplitBudget = {
    remaining: MAX_ENV_ASSIGNMENT_READINGS, remainingTokens: MAX_CLASSIFICATION_TOKEN_VISITS,
    remainingDestructive: MAX_DESTRUCTIVE_OPERAND_VISITS,
  },
): ParsedCommand | null {
  spendTokenVisits(envSplitBudget, tokens.length);
  let index = 0;
  let splitStringExpansions = 0;
  let executionCwd: string | null = null;
  let parentShellBuiltin = true;
  let builtinWrapper = false;
  let builtinOptionTerminator = false;
  const alternateReadings: ParsedCommand["alternateReadings"] = [];
  // Each `env --split-string` value is re-parsed in place, so a chain of them re-reads its own
  // payload once per level. The command-length cap alone leaves that quadratic; bound the chain
  // explicitly and fail closed past it rather than parsing on.
  const expandSplitString = (script: string): ShellToken[] => {
    splitStringExpansions += 1;
    if (splitStringExpansions > MAX_ENV_SPLIT_STRING_EXPANSIONS) {
      throw new UnclassifiableCommandError("env --split-string nesting exceeded its bound");
    }
    // `env -S` has a word grammar of its own, and shell-quote models only part of it. Its complete
    // set of metacharacters is whitespace, `"`, `'`, `\`, `$` and `#`; the first three agree with
    // shell-quote, and the last three each diverge in a direction that hides the real command:
    //   `\`  — `\_` separates arguments, where shell-quote reads the backslash as POSIX quoting and
    //          joins those words into one.
    //   `$`  — `${VAR}` is expanded and concatenated with its neighbours, where shell-quote emits the
    //          literal and the reference separately, so `r${X}` arrives as `r` rather than as `rm`.
    //   `#`  — a comment starts only at a word start, where shell-quote also starts one mid-word and
    //          so drops every later argument, including a protected path behind an earlier `x#foo`.
    // Enumerating the grammar rather than blacklisting the divergence found most recently is what
    // makes this list closed. A payload carrying any of them is unclassifiable, and the worktree is
    // retained instead of parsed on a guess. Backticks are rejected alongside them because
    // shell-quote reads command substitution that `env` would pass through literally.
    if (/[\\$#`]/u.test(script)) {
      throw new UnclassifiableCommandError("env --split-string payload uses env's own word grammar");
    }
    return parse(script, reference);
  };
  // `W=/tmp rm -rf "$W"` removes the PRE-assignment `W`: the shell expands a command's words before
  // its assignment prefix takes effect, and the prefix does not outlive the command. So assignments
  // build the CHILD environment — which a nested `sh -c` does inherit — and reach `environment`
  // only when they stand alone as their own command. Within the prefix they apply left to right,
  // so `A=$B B=$A` leaves both holding B's original value.
  const childEnvironment = new Map(environment);
  const assigned: string[] = [];
  for (;;) {
    // shell-quote represents `A=*` and `A=?` as glob tokens, but shell assignment words do not
    // perform pathname expansion. They still precede the command being run.
    const assignment = wordText(tokens[index]);
    if (assignment === null || !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(assignment)) break;
    const equals = assignment.indexOf("=");
    const name = assignment.slice(0, equals);
    childEnvironment.set(name, expandReferences(assignment.slice(equals + 1), cwd, childEnvironment));
    assigned.push(name);
    index += 1;
  }
  if (tokens[index] === undefined) {
    // Applied exactly once: the caller does not classify a segment that parsed to no command.
    for (const name of assigned) environment.set(name, childEnvironment.get(name) ?? "");
    return null;
  }
  let executable = commandWordAt(tokens, index, cwd, environment);
  // Before a POSIX special builtin the assignment survives in `/bin/sh` and is discarded by bash
  // outside POSIX mode. Which shell runs the command is not knowable here, and the two readings
  // disagree about what a later `"$W"` names, so the name stops being readable at all: a later
  // destructive operand built from it is unresolved rather than guessed in the wrong direction.
  if (assigned.length > 0 && executable != null && SPECIAL_BUILTINS.has(executableName(executable))) {
    for (const name of assigned) environment.set(name, UNRESOLVED_REFERENCE);
  }
  while (executable) {
    const name = executableName(executable);
    // A path-qualified executable runs in a child process, even when its basename is `cd` or
    // `command`. Only a shell builtin can change the provider shell's directory for later segments.
    if (executable.includes("/") || executable.includes("\\")) parentShellBuiltin = false;
    if (name === "builtin") {
      // `builtin cd` runs in the current shell. An equals-expanded or path-qualified command
      // instead names an external executable, so it cannot change the parent's directory.
      if (executable.startsWith("=")) parentShellBuiltin = false;
      builtinWrapper = true;
      index += 1;
      // Bash accepts `builtin -- cd`, while zsh rejects `--` as a builtin name. Preserve the
      // Bash reading, then leave the later cwd unplaceable when those shell readings disagree.
      if (word(tokens[index], cwd, environment) === "--") {
        builtinOptionTerminator = true;
        index += 1;
      }
      executable = commandWordAt(tokens, index, cwd, environment);
      continue;
    }
    if (name === "sudo") {
      parentShellBuiltin = false;
      index += 1;
      while (true) {
        const option = word(tokens[index], cwd, environment);
        if (!option?.startsWith("-")) break;
        if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
          "-C", "--close-from", "-R", "--chroot", "-T", "--command-timeout"].includes(option)) {
          index += 2;
        } else {
          index += 1;
        }
      }
      executable = commandWordAt(tokens, index, cwd, environment);
      continue;
    }
    if (["command", "nohup", "setsid"].includes(name)) {
      // `command cd` can run the shell builtin, but zsh's `=command` resolves only an external
      // executable (or fails), so it cannot change the provider shell's directory.
      if (name !== "command" || executable.startsWith("=")) parentShellBuiltin = false;
      index += 1;
      while (typeof word(tokens[index], cwd, environment) === "string" &&
          word(tokens[index], cwd, environment)!.startsWith("-")) {
        const option = word(tokens[index], cwd, environment)!;
        // `command -v` and `-V` only describe names; they never run `cd` in this shell.
        if (name === "command" && /^-[^-]*[vV]/u.test(option)) parentShellBuiltin = false;
        index += 1;
      }
      executable = commandWordAt(tokens, index, cwd, environment);
      continue;
    }
    if (name === "env") {
      parentShellBuiltin = false;
      index += 1;
      while (wordText(tokens[index]) !== null) {
        // `env` reads its ARGV, so an assignment that arrived through an expansion
        // (`env "$ASSIGNMENT" sh -c ...`) is an assignment to it like any other.
        const raw = wordText(tokens[index])!;
        const resolved = word(tokens[index], cwd, environment);
        const value = resolved ?? raw;
        // An unquoted option-looking expansion can supply both an `env` option and the
        // command after it. Keep that split reading alongside the whole-word one.
        if (raw.includes("\0") && value.startsWith("-")) {
          const fields = expansionFields(raw, value, cwd, environment);
          if (fields === null) throw new UnclassifiableCommandError("env option has unknown field splitting");
          if (fields.length > 1) {
            if (envSplitBudget.remaining-- <= 0) {
              throw new UnclassifiableCommandError("env option readings exceeded their bound");
            }
            const splitTokens = tokens.slice();
            splitTokens.splice(index, 1, ...fields);
            const splitEnvironment = new Map(environment);
            const splitCommand = commandWords(splitTokens, cwd, splitEnvironment, envSplitBudget);
            if (splitCommand) alternateReadings.push({ command: splitCommand, environment: splitEnvironment });
          }
        }
        // A variable may be quoted (one argv word) or unquoted (several fields), and
        // shell-quote does not preserve which. A split assignment can put a command after its
        // first field even when the assignment name is a valid shell identifier. Keep both
        // readings, so ordinary quoted assignments remain available unless their split reading
        // would actually reach a protected target.
        const envAssignment = !value.startsWith("-") && /^[^=\0]*=/u.test(value);
        if (envAssignment && raw.includes("\0") && resolved === null &&
            !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) {
          // Preserve the existing fail-closed reading for unresolved non-identifier assignments.
          throw new UnclassifiableCommandError("env assignment has unresolved field splitting");
        }
        if (envAssignment && raw.includes("\0")) {
          // An unresolved suffix can disappear in the real shell. Retain the fields made by
          // known parts rather than letting an unknown reference hide a known command.
          const partial = resolved ?? (raw.includes("`") ? null
            : expandReferences(raw, cwd, environment).replaceAll(UNRESOLVED_REFERENCE, ""));
          if (partial !== null) {
            const fields = expansionFields(raw, partial, cwd, environment);
            if (fields === null) throw new UnclassifiableCommandError("env argument has unknown field splitting");
            const ifs = lookup("IFS", cwd, environment);
            // For operands, treating a custom IFS as additional separators is conservative. A
            // command word needs the exact IFS reading too: an extra whitespace split can move
            // the command behind a harmless field and hide its real role.
            const exactFields = ifs == null || ifs.includes("\0") || ifs.includes("`")
              ? null : expansionFields(raw, partial, cwd, environment, new Set(ifs));
            const seen = new Set<string>();
            for (const reading of [fields, exactFields]) {
              if (reading === null || (reading.length === 1 && reading[0] === partial)) continue;
              const key = JSON.stringify(reading);
              if (seen.has(key)) continue;
              seen.add(key);
              // Re-parsing the entire segment for each candidate can branch in different orders.
              // Share one budget across every branch, rather than limiting only recursive depth.
              if (envSplitBudget.remaining-- <= 0) {
                throw new UnclassifiableCommandError("env assignment readings exceeded their bound");
              }
              const splitTokens = tokens.slice();
              splitTokens.splice(index, 1, ...reading);
              const splitEnvironment = new Map(environment);
              const splitCommand = commandWords(splitTokens, cwd, splitEnvironment, envSplitBudget);
              if (splitCommand) alternateReadings.push({ command: splitCommand, environment: splitEnvironment });
            }
          }
        }
        // Like a prefix assignment, this builds the environment of the command `env` runs; it is
        // not in effect while the shell expands the words of this very command.
        // `env` accepts even an empty name, and otherwise any name without `=` or NUL;
        // the shell prefix above has the stricter identifier rule.
        // Keep option-looking words out: long options can carry their own `=` values.
        if (envAssignment) {
          const equals = value.indexOf("=");
          childEnvironment.set(value.slice(0, equals), value.slice(equals + 1));
          index += 1;
          continue;
        }
        // `env` takes an option value attached (`-Srm -rf x`, `-iSrm -rf x`, `--split-string=rm -rf x`)
        // as readily as separated, and accepts any unambiguous long-option abbreviation — no other
        // `env` long option begins with `s`, `u`, or `c`. Every spelling has to consume the same way,
        // or a skipped value is mistaken for the command being wrapped.
        const cluster = shortCluster(value, ENV_SHORT_OPTIONS, ENV_VALUE_SHORT_OPTIONS);
        const splitString = cluster
          ? (cluster.option === "S" ? cluster : null)
          : longOption(value, "--split-string", 3);
        if (splitString) {
          if (splitString.attached != null) {
            tokens.splice(index, 1, ...expandSplitString(splitString.attached));
            continue;
          }
          const script = word(tokens[index + 1], cwd, environment);
          tokens.splice(index, 2, ...(script == null ? [] : expandSplitString(script)));
          continue;
        }
        const chdir = cluster?.option === "C" ? cluster : longOption(value, "--chdir", 3);
        const valued = cluster ?? longOption(value, "--unset", 3) ?? chdir;
        if (valued) {
          if (chdir) {
            const directoryToken = tokens[index + 1];
            const rawDirectory = chdir.attached == null ? wordText(directoryToken) : null;
            const directory = chdir.attached ?? word(directoryToken, cwd, environment);
            if (rawDirectory?.includes("\0") && directory != null) {
              const fields = expansionFields(rawDirectory, directory, cwd, environment);
              if (fields === null) throw new UnclassifiableCommandError("env chdir has unknown field splitting");
              if (fields.length > 1) {
                if (envSplitBudget.remaining-- <= 0) {
                  throw new UnclassifiableCommandError("env chdir readings exceeded their bound");
                }
                const splitTokens = tokens.slice();
                splitTokens.splice(index + 1, 1, ...fields);
                const splitEnvironment = new Map(environment);
                const splitCommand = commandWords(splitTokens, cwd, splitEnvironment, envSplitBudget);
                if (splitCommand) alternateReadings.push({ command: splitCommand, environment: splitEnvironment });
              }
            }
            const expandedDirectory = directory != null && chdir.attached == null &&
                expandsLeadingTilde(directoryToken) && directory.startsWith("~")
              ? expandOperandHome(directory, cwd, environment) : directory;
            executionCwd = expandedDirectory == null ? UNKNOWN_CWD
              : resolvedPath(expandedDirectory, executionCwd ?? cwd) ?? UNKNOWN_CWD;
          }
          index += valued.attached == null ? 2 : 1;
          continue;
        }
        if (value.startsWith("-")) { index += 1; continue; }
        break;
      }
      executable = commandWordAt(tokens, index, cwd, environment);
      continue;
    }
    if (name === "nice") {
      parentShellBuiltin = false;
      index += 1;
      const option = word(tokens[index], cwd, environment);
      if (option === "-n" || option === "--adjustment") index += 2;
      else if (option && (/^-\d+$/u.test(option) || option.startsWith("--adjustment="))) index += 1;
      executable = commandWordAt(tokens, index, cwd, environment);
      continue;
    }
    if (name === "timeout") {
      parentShellBuiltin = false;
      index += 1;
      while (true) {
        const option = word(tokens[index], cwd, environment);
        if (!option?.startsWith("-")) break;
        if (["-k", "--kill-after", "-s", "--signal"].includes(option)) index += 2;
        else index += 1;
      }
      if (word(tokens[index], cwd, environment)) index += 1; // duration
      executable = commandWordAt(tokens, index, cwd, environment);
      continue;
    }
    break;
  }
  if (!executable && alternateReadings.length === 0) return null;
  return { words: tokens.slice(index + 1), executable: executableName(executable ?? ""), childEnvironment,
    alternateReadings, executionCwd, parentShellBuiltin, builtinWrapper, builtinOptionTerminator };
}

/** The most severe of several verdicts: a protected target outranks one that cannot be placed. */
function strongest(verdicts: Iterable<Verdict>): Verdict {
  let result: Verdict = null;
  for (const verdict of verdicts) {
    if (refuses(verdict)) return verdict;
    result ??= verdict;
  }
  return result;
}

const REMOVERS = ["rm", "rmdir", "unlink", "trash", "trash-put", "mv", "move"];

/**
 * POSIX special builtins: a prefix assignment before one of these SURVIVES the command in
 * `/bin/sh` (and in bash's POSIX mode), so `W=<root> : ; rm -rf "$W"` removes the root. The list is
 * applied in every shell, which over-refuses under a bash that would have discarded the value —
 * the safe direction, and the provider's shell is not knowable from here.
 */
const SPECIAL_BUILTINS = new Set([
  ":", ".", "source", "break", "continue", "eval", "exec", "exit", "export",
  "readonly", "return", "set", "shift", "times", "trap", "unset",
]);

/** Every word of a remover, with `--` ending the options so a dashed operand after it is a path. */
function removerVerdicts(
  words: readonly ShellToken[],
  cwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
): Verdict[] {
  let optionsEnded = false;
  return words.map((token) => {
    const verdict = operandVerdict(token, cwd, environment, protections, false, optionsEnded);
    if (word(token, cwd, environment) === "--") optionsEnded = true;
    return verdict;
  });
}

/** `Remove-Item` binds Path/LiteralPath to String[]; commas can hide a later protected item. */
function powershellRemoverVerdict(
  words: readonly ShellToken[],
  cwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
  executable: string,
  budget: EnvSplitBudget,
): Verdict {
  const sources: ShellToken[] = [];
  let optionsEnded = false;
  for (let index = 0; index < words.length; index += 1) {
    const token = words[index]!;
    const value = word(token, cwd, environment);
    if (!optionsEnded && value === "--") { optionsEnded = true; continue; }
    if (!optionsEnded && value?.startsWith("-")) {
      const parameter = powershellMoveParameter(value, executable);
      if (parameter?.role === "source") {
        const source = parameter.attached == null || parameter.attached === ""
          ? words[++index] : parameter.attached;
        if (source !== undefined) sources.push(source);
      } else if (parameter?.role === "other" && parameter.attached == null) {
        index += 1;
      }
      continue;
    }
    sources.push(token);
  }
  return strongest(sources.flatMap((source) => {
    const value = word(source, cwd, environment);
    // Preserve the whole spelling too: a native command, or a literal filename, can contain a comma.
    const elements: ShellToken[] = value?.includes(",") ? [source, ...value.split(",")] : [source];
    spendDestructiveVisits(budget, elements.length - 1);
    return elements.map((element) => operandVerdict(element, cwd, environment, protections, false, true));
  }));
}

function gitWorktreeVerdict(
  words: ShellToken[],
  initialCwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
): Verdict {
  let cwd = initialCwd;
  const actionIndex = words.findIndex((token, index) =>
    word(token, cwd, environment) === "worktree" &&
    ["remove", "move", "prune"].includes(word(words[index + 1], cwd, environment) ?? ""));
  if (actionIndex < 0) return null;
  let index = 0;
  while (index < actionIndex) {
    const value = word(words[index], cwd, environment);
    if (value === "-C") {
      // A dynamic -C cannot make an absolute protected removal operand safe, so scanning goes on
      // and the worktree subcommand and target still reach the veto; but a RELATIVE target, or a
      // prune, is judged from a directory nobody can name and is therefore unresolved.
      cwd = resolvedOperand(words[index + 1], cwd, environment) ?? UNKNOWN_CWD;
      index += 2;
      continue;
    }
    if (["-c", "--config-env", "--git-dir", "--work-tree", "--namespace",
      "--super-prefix"].includes(value ?? "")) {
      index += 2;
      continue;
    }
    if (value?.startsWith("-")) { index += 1; continue; }
    // shell-quote represents an unresolved command substitution as an environment placeholder
    // followed by its parenthesized source. It is opaque for cwd resolution but not a reason to
    // lose an absolute protected removal operand later in the same Git invocation.
    if (!value || (value.startsWith("(") && value.endsWith(")"))) {
      index += 1;
      continue;
    }
    return null;
  }
  const action = word(words[actionIndex + 1], cwd, environment);
  const operands = words.slice(actionIndex + 2).filter((token) => {
    const value = word(token, cwd, environment);
    return value !== "--" && !value?.startsWith("-");
  });
  if (action === "prune") {
    if (cwd === UNKNOWN_CWD) return "unresolved";
    return protectionRepository(cwd, protections) ||
        protectionRepository(physicalCwd(cwd), physicalProtections(protections))
      ? "protected"
      : null;
  }
  if (action !== "remove" && action !== "move") return null;
  return operandVerdict(operands[0], cwd, environment, protections);
}

/** Git's own options that take the following word as their value. */
const GIT_VALUE_OPTIONS = ["-c", "--config-env", "--work-tree", "--namespace", "--super-prefix"];

/**
 * The pinned worktree a Git command run from `cwd` acts on, or null. Git takes its repository from
 * the nearest `.git` above the working directory, so a directory beneath the worktree that holds a
 * repository of its own (a test fixture, a nested clone) is that repository and not the worktree;
 * the innermost protected root wins for the same reason. Both spellings of the directory are tried,
 * as everywhere else here, because a worktree can be registered through a symlinked prefix.
 */
function pinnedWorktreeAt(
  cwd: string,
  protections: readonly ManagedWorktreeProtection[],
): ManagedWorktreeProtection | null {
  if (cwd === UNKNOWN_CWD) return null;
  for (const [location, roots] of [
    [normalize(cwd), protections],
    [physicalCwd(cwd), physicalProtections(protections)],
  ] as const) {
    const innermost = roots.filter(({ worktreePath }) => pathContains(worktreePath, location))
      .sort((left, right) => right.worktreePath.length - left.worktreePath.length)[0];
    if (!innermost?.pinnedBranch) continue;
    const root = normalize(innermost.worktreePath);
    let nested = false;
    for (let current = location; current !== root && pathContains(root, current); current = dirname(current)) {
      if (existsSync(join(current, ".git"))) {
        nested = true;
        break;
      }
    }
    if (!nested) return innermost;
  }
  return null;
}

/**
 * Revision syntax: a commit reached from another (`~`, `^`, `@{…}`, `A...B`), found by its message
 * (`:/text`), or named by `git describe` (`v1.2-3-g<abbreviated id>`); `@`, which checkout reads as
 * the current commit and detaches at; and the pseudo-refs Git keeps beside `HEAD` (`ORIG_HEAD`,
 * `FETCH_HEAD`, …). A lone `checkout` operand spelled this way switches or detaches.
 */
const REVISION_SYNTAX = /[~^]|@\{|\.\.\.|^:\/|^@$|-g[0-9a-fA-F]{4,}$|^(?:[A-Z]+_)+HEAD$/u;

/**
 * A spelling no ref can have (`git check-ref-format`): a component starting with `.`, `..`, a space
 * or control character, one of `:?*[\`, a leading, trailing, or doubled `/`, or a trailing `.` or
 * `.lock`. Once revision syntax is ruled out, such an operand can only be a path or pathspec.
 */
const PATH_ONLY_SPELLING =
  /(?:^|\/)\.|\.\.|[\u0000- \u007f:?*[\\]|^\/|\/$|\/\/|\.$|\.lock(?:\/|$)/u;

/** A packed-refs file larger than this is not read; the operand is then treated as a commit. */
const MAX_PACKED_REFS_BYTES = 8 * 1024 * 1024;
/** Git's own pointer files are a line or two; a larger one is not what it claims to be. */
const MAX_GIT_POINTER_BYTES = 64 * 1024;
/** Remotes inspected for a remote-tracking branch `checkout` would create a local one from; past
 * this many the answer is unknown, and the operand is treated as a commit. */
const MAX_REMOTES = 256;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canEnterDirectory(path: string): boolean {
  if (!isDirectory(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One of Git's small pointer files (`.git`, `commondir`, `gitdir`), or null. */
function readGitPointer(path: string): string | null {
  if (!isFile(path) || statSync(path).size > MAX_GIT_POINTER_BYTES) return null;
  return readFileSync(path, "utf8").trim() || null;
}

/**
 * A worktree's own Git directory and the shared one its refs live in: its `.git` file names its
 * administrative directory, whose `commondir` names the repository's `.git`. Null when either
 * cannot be found, which callers treat as unreadable.
 */
function gitDirectories(worktreePath: string): { gitDir: string; common: string } | null {
  const dotGit = join(worktreePath, ".git");
  const pointer = readGitPointer(dotGit);
  let gitDir = dotGit;
  if (pointer !== null) {
    const target = /^gitdir: (.+)$/u.exec(pointer)?.[1];
    if (target === undefined) return null;
    gitDir = resolve(worktreePath, target);
  }
  const commonPointer = readGitPointer(join(gitDir, "commondir"));
  const common = commonPointer === null ? gitDir : resolve(gitDir, commonPointer);
  return isDirectory(gitDir) && isDirectory(common) ? { gitDir, common } : null;
}

/**
 * Whether Git would resolve a lone `checkout` operand to a commit, or create a local branch for it
 * from a remote-tracking one. This is the one place the classifier reads Git state, and only the
 * ref store's plain files: loose refs and packed-refs. Whatever it cannot read — a reftable store,
 * an oversized packed-refs, an I/O error — and a name that could abbreviate an object id count as
 * a commit, so the command is refused with advice to name the path after `--` instead.
 */
function mayNameCommit(name: string, worktreePath: string, guess: boolean): boolean {
  if (/^[0-9a-f]{4,64}$/iu.test(name)) return true;
  try {
    const directories = gitDirectories(worktreePath);
    if (directories === null || existsSync(join(directories.common, "reftable"))) return true;
    const { gitDir, common } = directories;
    // Git's own order for a short name: the full name itself, then refs/, tags, heads, remotes,
    // and a remote's HEAD. Per-worktree refs live in the worktree's own directory.
    const candidates = [
      ...(name.startsWith("refs/") ? [name] : []),
      `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`,
      `refs/remotes/${name}/HEAD`,
    ];
    if (candidates.some((ref) => isFile(join(common, ref)) || isFile(join(gitDir, ref)))) return true;
    // `checkout <name>` with no such commit creates `<name>` from a remote's branch of that name,
    // unless `--no-guess` turned that off.
    const remotes = join(common, "refs", "remotes");
    if (guess && isDirectory(remotes)) {
      const names = readdirSync(remotes);
      if (names.length > MAX_REMOTES || names.some((remote) => isFile(join(remotes, remote, name)))) return true;
    }
    const packed = join(common, "packed-refs");
    if (!isFile(packed)) return false;
    if (statSync(packed).size > MAX_PACKED_REFS_BYTES) return true;
    return readFileSync(packed, "utf8").split("\n").some((line) => {
      const ref = /^[0-9a-f]{40,64} (refs\/\S+)$/u.exec(line)?.[1];
      if (ref === undefined) return false;
      if (candidates.includes(ref)) return true;
      if (!guess || !ref.startsWith("refs/remotes/")) return false;
      const tracking = ref.slice("refs/remotes/".length);
      const slash = tracking.indexOf("/");
      return slash > 0 && tracking.slice(slash + 1) === name;
    });
  } catch {
    return true;
  }
}

/**
 * Whether a lone `checkout` operand is a file to restore rather than a commit to switch to. Git
 * tries a commit first, then a remote-tracking branch to create one from, then a path
 * (`parse_branchname_arg`), and this follows it: revision syntax is a commit, a spelling no ref can
 * have is a path, and any other name is a path exactly when no ref of that name exists — whether or
 * not it is on disk, since a deleted tracked file is restored from the index the same way.
 */
function checkoutOperandIsPath(value: string, worktreePath: string, guess: boolean): boolean {
  if (value === "-" || REVISION_SYNTAX.test(value)) return false;
  if (PATH_ONLY_SPELLING.test(value)) return true;
  return !mayNameCommit(value, worktreePath, guess);
}

/**
 * The worktree a `--git-dir` names: its own `.git`, or its administrative directory beneath the
 * repository's `.git/worktrees`, whose `gitdir` file records the worktree's `.git`.
 */
function worktreeForGitDirectory(gitDir: string): string {
  if (basename(gitDir) === ".git") return dirname(gitDir);
  try {
    const recorded = readGitPointer(join(gitDir, "gitdir"));
    if (recorded) return dirname(resolve(gitDir, recorded));
  } catch {
    /* Unreadable: a repository this code does not place. */
  }
  return UNKNOWN_CWD;
}

/** The new branch an option such as `-b`/`--orphan` names: attached, or the following word. */
function createdBranch(
  attached: string | null,
  next: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
): string | null {
  return attached || word(next, cwd, environment);
}

function checkoutMovesBranch(
  words: readonly ShellToken[],
  cwd: string,
  environment: ReadonlyMap<string, string>,
  pinned: Required<ManagedWorktreeProtection>,
): boolean {
  const operands: Array<string | null> = [];
  let pathspecs = false;
  let detach = false;
  // Remote-branch guessing is on unless `--no-guess` (the last of the two wins, as in Git).
  let guess = true;
  // `undefined` while no new branch is named; `null` for a name this code cannot resolve.
  let created: string | null | undefined;
  for (let index = 0; index < words.length; index += 1) {
    const value = word(words[index], cwd, environment);
    if (value === "--") {
      // `checkout [<tree-ish>] -- <path>…` restores files; a bare trailing `--` only ends options.
      pathspecs = index + 1 < words.length;
      break;
    }
    if (value == null) {
      operands.push(null);
      continue;
    }
    if (value.startsWith("--")) {
      const orphan = longOption(value, "--orphan", 5);
      if (orphan) {
        created = createdBranch(orphan.attached, words[index + 1], cwd, environment);
        if (orphan.attached == null) index += 1;
      } else if (longOption(value, "--detach", 3)) {
        detach = true;
      } else if (longOption(value, "--patch", 6) || longOption(value, "--ours", 4) ||
          longOption(value, "--theirs", 4)) {
        pathspecs = true;
      } else if (value === "--no-guess" || value === "--guess") {
        guess = value === "--guess";
      } else {
        // `--pathspec-from-file` restores files; it and `--conflict` take a value, attached or next.
        const fromFile = longOption(value, "--pathspec-from-file", 13);
        const valued = fromFile ?? longOption(value, "--conflict", 4);
        if (fromFile) pathspecs = true;
        if (valued && valued.attached == null) index += 1;
      }
      continue;
    }
    if (value.startsWith("-") && value !== "-") {
      // A short-option cluster: `-d` detaches, `-p` patches paths, and `-b`/`-B` take the new
      // branch's name, attached or as the next word.
      const letters = value.slice(1);
      const create = [...letters].findIndex((letter) => letter === "b" || letter === "B");
      const flags = create >= 0 ? letters.slice(0, create) : letters;
      if (flags.includes("d")) detach = true;
      if (flags.includes("p")) pathspecs = true;
      if (create >= 0) {
        const attached = letters.slice(create + 1);
        created = createdBranch(attached || null, words[index + 1], cwd, environment);
        if (!attached) index += 1;
      }
      continue;
    }
    operands.push(value);
  }
  if (pathspecs) return false;
  if (created !== undefined) return created !== pinned.pinnedBranch;
  if (detach) return true;
  // No operand switches nothing, and several are `<tree-ish> <path>…`, which restores files.
  if (operands.length !== 1) return false;
  const target = operands[0];
  // `HEAD` alone stays on the current branch; `@`, its synonym elsewhere, detaches here.
  if (target == null || target === pinned.pinnedBranch || target === "HEAD") return false;
  return !checkoutOperandIsPath(target, pinned.worktreePath, guess);
}

function switchMovesBranch(
  words: readonly ShellToken[],
  cwd: string,
  environment: ReadonlyMap<string, string>,
  pinnedBranch: string,
): boolean {
  // `undefined` while no operand is seen; `null` for one this code cannot resolve.
  let target: string | null | undefined;
  for (let index = 0; index < words.length; index += 1) {
    const value = word(words[index], cwd, environment);
    if (value == null) {
      if (target === undefined) target = null;
      continue;
    }
    if (value === "--") continue;
    if (value.startsWith("--")) {
      const create = longOption(value, "--create", 4) ?? longOption(value, "--force-create", 8) ??
        longOption(value, "--orphan", 4);
      if (create) return createdBranch(create.attached, words[index + 1], cwd, environment) !== pinnedBranch;
      if (longOption(value, "--detach", 4)) return true;
      // `--conflict` takes its style as the next word when it is not attached.
      if (longOption(value, "--conflict", 4)?.attached === null) index += 1;
      continue;
    }
    if (value.startsWith("-") && value !== "-") {
      const letters = value.slice(1);
      const create = [...letters].findIndex((letter) => letter === "c" || letter === "C");
      if (create >= 0) {
        const attached = letters.slice(create + 1);
        return createdBranch(attached || null, words[index + 1], cwd, environment) !== pinnedBranch;
      }
      if (letters.includes("d")) return true;
      continue;
    }
    if (target === undefined) target = value;
  }
  return target != null && target !== pinnedBranch;
}

function branchRenamesPinned(
  words: readonly ShellToken[],
  cwd: string,
  environment: ReadonlyMap<string, string>,
  pinnedBranch: string,
): boolean {
  let move = false;
  const operands: Array<string | null> = [];
  for (const token of words) {
    const value = word(token, cwd, environment);
    if (value === "--") continue;
    if (value?.startsWith("--")) {
      if (longOption(value, "--move", 4)) move = true;
      continue;
    }
    if (value?.startsWith("-") && value !== "-") {
      if (/[mM]/u.test(value.slice(1))) move = true;
      continue;
    }
    operands.push(value);
  }
  if (!move) return false;
  // `branch -m <new>` renames the branch the worktree is on; `branch -m <old> <new>` names it.
  if (operands.length === 1) return operands[0] !== pinnedBranch;
  return operands.length === 2 && operands[0] === pinnedBranch && operands[1] !== pinnedBranch;
}

/**
 * Whether a Git command moves a pinned worktree off its branch (#1650): `checkout` or `switch` to
 * another branch, a new branch, a revision, or a detached HEAD; `branch -m` renaming the branch;
 * and `stash branch`. Restoring files and switching back to the pinned branch are ordinary work, and
 * a repository that is not a pinned worktree is not this classifier's concern at all. Where the
 * command cannot be placed (an unresolved `-C`, an unresolved branch name) it is left alone: a
 * branch switch is recoverable, and refusing what cannot be read would refuse ordinary Git work.
 * Plumbing that rewrites `HEAD` directly (`symbolic-ref`, `update-ref`), `rebase <upstream>
 * <branch>`, and `bisect` are not recognised; they are not how an agent starts work on a branch.
 */
function gitBranchVerdict(
  words: readonly ShellToken[],
  initialCwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
): Verdict {
  if (!protections.some(({ pinnedBranch }) => pinnedBranch)) return null;
  let cwd = initialCwd;
  let index = 0;
  for (; index < words.length; index += 1) {
    const value = word(words[index], cwd, environment);
    if (value === "-C") {
      cwd = resolvedOperand(words[index + 1], cwd, environment) ?? UNKNOWN_CWD;
      index += 1;
      continue;
    }
    if (value === "--git-dir" || value?.startsWith("--git-dir=")) {
      // Git takes its repository from here instead of from the working directory.
      const gitDir = value === "--git-dir"
        ? resolvedOperand(words[index + 1], cwd, environment)
        : resolvedPath(value.slice("--git-dir=".length), cwd);
      cwd = gitDir ? worktreeForGitDirectory(gitDir) : UNKNOWN_CWD;
      if (value === "--git-dir") index += 1;
      continue;
    }
    if (GIT_VALUE_OPTIONS.includes(value ?? "")) {
      index += 1;
      continue;
    }
    if (value == null || value.startsWith("-")) continue;
    break;
  }
  const subcommand = word(words[index], cwd, environment);
  if (!["checkout", "switch", "branch", "stash"].includes(subcommand ?? "")) return null;
  const pinned = pinnedWorktreeAt(cwd, protections);
  if (!pinned?.pinnedBranch) return null;
  const rest = words.slice(index + 1);
  const moves = subcommand === "checkout"
    ? checkoutMovesBranch(rest, cwd, environment, { ...pinned, pinnedBranch: pinned.pinnedBranch })
    : subcommand === "switch" ? switchMovesBranch(rest, cwd, environment, pinned.pinnedBranch)
    : subcommand === "branch" ? branchRenamesPinned(rest, cwd, environment, pinned.pinnedBranch)
    : word(rest[0], cwd, environment) === "branch";
  return moves ? "branch" : null;
}

/**
 * A forge CLI's change-request checkout (`gh pr checkout`, `glab mr checkout`) switches the
 * repository in the current directory to that change's branch, so inside a pinned worktree it is
 * the same move as `git switch` (#1650).
 */
function forgeCheckoutVerdict(
  executable: string,
  words: readonly ShellToken[],
  cwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
): Verdict {
  // The first two positional words, past options: `gh -R owner/repo pr checkout 1` still checks out
  // into the current repository. `-R`/`--repo` is the one option either CLI gives a separate value.
  const positional: Array<string | null> = [];
  for (let index = 0; index < words.length && positional.length < 2; index += 1) {
    const value = word(words[index], cwd, environment);
    if (value === "-R" || value === "--repo") {
      index += 1;
      continue;
    }
    if (value?.startsWith("-")) continue;
    positional.push(value);
  }
  const [group, action] = positional;
  const checkout = executable === "gh" ? group === "pr" && action === "checkout"
    : executable === "glab" && group === "mr" && action === "checkout";
  return checkout && pinnedWorktreeAt(cwd, protections)?.pinnedBranch ? "branch" : null;
}

/**
 * Every reading of a command's words this classifier has to consider.
 *
 * `shell-quote` does not report whether an expansion was quoted, and the two possibilities are
 * different commands: unquoted, `$PAIR` becomes as many words as it has fields; quoted, it stays
 * one. Roles follow from that — an `mv` destination is its LAST word, a `find` root is a word
 * before the expression — so a single hybrid reading gets them wrong in one direction or the
 * other: `mv $PAIR` must read a protected first field as a source, while `mv /tmp/a "$W"` must
 * read a protected path that merely contains a space as the destination it lands in.
 *
 * So both readings are classified in full and the stronger verdict stands. Where nothing splits,
 * the two coincide and only one reading is produced.
 */
function wordReadings(
  words: readonly ShellToken[],
  cwd: string,
  environment: ReadonlyMap<string, string>,
  budget: EnvSplitBudget,
): ShellToken[][] {
  spendTokenVisits(budget, words.length);
  const split: ShellToken[] = [];
  const whole: ShellToken[] = [];
  let divided = false;
  for (const token of words) {
    const text = wordText(token);
    const value = text === null ? null : word(token, cwd, environment);
    const fields = text === null || value == null || !text.includes("\0")
      ? null
      : expansionFields(text, value, cwd, environment);
    if (fields === null || value == null) {
      // Unresolvable, or nothing to expand: the token is carried into both readings as it is.
      split.push(token);
      whole.push(token);
      continue;
    }
    const syntacticTilde = text?.startsWith("~") === true;
    split.push(...fields.map((field): ExpandedField => ({
      expandedField: field,
      expandsLeadingTilde: syntacticTilde,
    })));
    whole.push(token);
    if (fields.length !== 1 || fields[0] !== value) divided = true;
  }
  return divided ? [split, whole] : [split];
}

function segmentVerdict(
  tokens: ShellToken[],
  cwd: string,
  environment: Map<string, string>,
  protections: readonly ManagedWorktreeProtection[],
  depth: number,
  envSplitBudget: EnvSplitBudget,
  // Parsing splits command expansions in place and applies assignments, so a caller that has
  // already parsed this segment passes its result rather than parsing it a second time.
  command: ParsedCommand | null = commandWords(tokens, cwd, environment, envSplitBudget),
): Verdict {
  if (!command) return null;
  // `env -C` changes only the child command's directory. The outer shell expanded its
  // arguments before `env` ran, so judge both directory readings rather than replacing one.
  const directories = command.executionCwd === null ? [cwd] : [cwd, command.executionCwd];
  const readings = wordReadings(command.words, cwd, environment, envSplitBudget);
  spendTokenVisits(envSplitBudget, command.words.length * (directories.length - 1));
  return strongest([
    ...directories.flatMap((directory) => readings.map((words) =>
      commandVerdict(words, command, directory, environment, protections, depth, envSplitBudget))),
    ...command.alternateReadings.map(({ command: alternative, environment: splitEnvironment }) =>
      segmentVerdict([], cwd, splitEnvironment, protections, depth, envSplitBudget, alternative)),
  ]);
}

/** One command, judged in one reading of its words. */
function commandVerdict(
  words: ShellToken[],
  command: ParsedCommand,
  cwd: string,
  environment: Map<string, string>,
  protections: readonly ManagedWorktreeProtection[],
  depth: number,
  envSplitBudget: EnvSplitBudget,
): Verdict {
  const { executable, childEnvironment } = command;
  // Every destructive interpretation shares one operand budget, including split/whole readings,
  // nested scripts and `env -C` directory readings. Spend it before doing filesystem resolution.
  if (["rm", "rmdir", "unlink", "trash", "trash-put", "remove-item", "del", "rd", "ri", "erase",
    "mv", "move", "mi", "move-item", "ren", "rni", "rename-item"].includes(executable)) {
    spendDestructiveVisits(envSplitBudget, words.length);
  }
  if (["sh", "bash", "zsh", "dash", "fish", "cmd"].includes(executable) && depth < 3) {
    // A `-c` script is consumed WHOLE by the shell it is handed to, so the unsplit words are read
    // here whichever reading this is. Where the expansion really was unquoted the shell would keep
    // only its first field as the script, which this over-refuses rather than misses.
    const words = command.words;
    const flag = words.findIndex((token) => {
      const value = word(token, cwd, environment)?.toLowerCase() ?? "";
      return value === "/c" || /^-[a-z]*c[a-z]*$/u.test(value);
    });
    const script = flag >= 0 ? scriptText(words[flag + 1], cwd, environment) : null;
    // The nested shell runs in the child environment, so `W=<root> sh -c \'rm -rf "$W"\'` resolves
    // there even though the outer command's own words never saw that assignment.
    return script ? classify(script, cwd, protections, childEnvironment, depth + 1, envSplitBudget) : null;
  }
  if (executable === "eval" && depth < 3) {
    const script = command.words.map((token) => scriptText(token, cwd, environment) ?? "").join(" ");
    return classify(script, cwd, protections, childEnvironment, depth + 1, envSplitBudget);
  }
  if (executable === "xargs" && depth < 3) {
    let commandIndex = 0;
    while (commandIndex < words.length) {
      const option = word(words[commandIndex], cwd, environment);
      if (option === "--") { commandIndex += 1; break; }
      if (!option?.startsWith("-")) break;
      if (["-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace",
        "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"].includes(option)) {
        commandIndex += 2;
      } else {
        commandIndex += 1;
      }
    }
    const nested = words.slice(commandIndex);
    // These words are ARGV: the outer shell expanded them before the prefix assignment applied, so
    // they are read in the outer environment. Where the two disagree this over-refuses, never less.
    const nestedCommand = commandWords(nested, cwd, new Map(environment), envSplitBudget);
    const verdict = segmentVerdict(nested, cwd, new Map(environment), protections, depth + 1,
      envSplitBudget, nestedCommand);
    if (!parsedExecutables(nestedCommand).some((name) => REMOVERS.includes(name))) return verdict;
    // What arrives on stdin is invisible, so a remover run from inside a managed root is refused
    // outright, and one run from a directory the classifier lost track of cannot be placed.
    if (shellInsideManagedRoot(cwd, protections)) return "protected";
    return strongest([verdict, cwd === UNKNOWN_CWD ? "unresolved" : null]);
  }
  if (executable === "git") {
    return strongest([
      gitWorktreeVerdict(words, cwd, environment, protections),
      gitBranchVerdict(words, cwd, environment, protections),
    ]);
  }
  if (executable === "gh" || executable === "glab") {
    return forgeCheckoutVerdict(executable, words, cwd, environment, protections);
  }
  if (["rm", "rmdir", "unlink", "trash", "trash-put", "remove-item", "del", "rd", "ri", "erase"].includes(executable)) {
    const powerShell = ["remove-item", "del", "rd", "ri", "erase"].includes(executable) ||
      (process.platform === "win32" && ["rm", "rmdir"].includes(executable));
    return strongest([
      ...removerVerdicts(words, cwd, environment, protections),
      powerShell ? powershellRemoverVerdict(words, cwd, environment, protections, executable,
        envSplitBudget) : null,
    ]);
  }
  if (executable === "gio" && word(words[0], cwd, environment) === "trash") {
    spendDestructiveVisits(envSplitBudget, words.length - 1);
    return strongest(removerVerdicts(words.slice(1), cwd, environment, protections));
  }
  if (["mv", "move", "mi", "move-item", "ren", "rni", "rename-item"].includes(executable)) {
    let targetDirectory = false;
    let namedDestination = false;
    let optionsEnded = false;
    const operands: ShellToken[] = [];
    const namedSources: ShellToken[] = [];
    const gnuClusterOperands: ShellToken[] = [];
    for (let index = 0; index < words.length; index += 1) {
      const token = words[index];
      if (token == null) continue;
      const value = word(token, cwd, environment);
      if (value == null && powershellMoveParameter(wordText(token) ?? "", executable)?.role === "source") {
        namedSources.push(token);
        continue;
      }
      if (value === "--") {
        for (const operand of words.slice(index + 1)) operands.push(operand);
        optionsEnded = true;
        break;
      }
      if (value?.startsWith("-")) {
        const parameter = powershellMoveParameter(value, executable);
        if (parameter) {
          // With a following option word, PowerShell cannot bind a value to -fi/-iv. Preserve the
          // GNU reading so a subsequent -t or --target-directory still marks every operand source.
          if (["mv", "move"].includes(executable) && ["-fi", "-iv"].includes(value.toLowerCase()) &&
              word(words[index + 1], cwd, environment)?.startsWith("-")) continue;
          const argument = parameter.attached == null || parameter.attached === ""
            ? words[++index]
            : parameter.attached;
          if (argument != null) {
            if (parameter.role === "source") namedSources.push(argument);
            if (parameter.role === "destination") namedDestination = true;
            if (["mv", "move"].includes(executable) && ["-fi", "-iv"].includes(value.toLowerCase())) {
              gnuClusterOperands.push(argument);
            }
          }
          continue;
        }
        const option = moveOption(value);
        if (option.targetDirectory) targetDirectory = true;
        if (option.consumesNext) index += 1;
        continue;
      }
      operands.push(token);
    }
    // The last operand is where the files LAND unless `-t` named that directory already. Moving
    // something into a protected worktree is ordinary work; moving the worktree away is not.
    const positionalSources = targetDirectory || namedDestination || (namedSources.length === 0 && operands.length === 1)
      ? operands
      : operands.slice(0, -1);
    const gnuSources = gnuClusterOperands.length === 0 ? []
      : targetDirectory ? [...gnuClusterOperands, ...operands]
      : [...gnuClusterOperands, ...operands].slice(0, -1);
    // PowerShell's comma operator turns a source argument into an array for Move-Item's String[]
    // Path and LiteralPath parameters. A protected source can be any element, not just the first.
    // `mv` and `move` may also be PowerShell aliases, so include their array reading too.
    const powerShellArrayReading = ["move-item", "mi"].includes(executable) ||
      (["mv", "move"].includes(executable) && (process.platform === "win32" || namedSources.length > 0));
    const sources = [...namedSources, ...positionalSources, ...gnuSources].flatMap((source) => {
      const value = word(source, cwd, environment);
      // Keep the whole source as well: comma is an ordinary filename character for GNU `mv`,
      // and the protected worktree itself may have a comma in its name.
      return powerShellArrayReading && value?.includes(",") ? [source, ...value.split(",")] : [source];
    });
    spendDestructiveVisits(envSplitBudget, Math.max(0, sources.length - words.length));
    return strongest(sources.map((source) =>
      operandVerdict(source, cwd, environment, protections, false, optionsEnded)));
  }
  if (executable === "find") {
    const actionIndex = words.findIndex((token) =>
      ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(word(token, cwd, environment) ?? ""));
    if (actionIndex >= 0) {
      // Pre-root options: -H/-L/-P, -O<level> (attached), -D <opts> (a separate word), and `--`
      // ending the options. Every one of them has to be stepped over, or the real roots and a
      // later -L land beyond rootStart and are never examined.
      let rootStart = 0;
      for (;;) {
        const option = word(words[rootStart], cwd, environment) ?? "";
        if (option === "--") { rootStart += 1; break; }
        if (["-H", "-L", "-P"].includes(option) || /^-O/u.test(option)) { rootStart += 1; continue; }
        if (option === "-D") { rootStart += 2; continue; }
        if (/^-D./u.test(option)) { rootStart += 1; continue; }
        break;
      }
      const expressionStart = words.findIndex((token, index) => index >= rootStart &&
        (word(token, cwd, environment)?.startsWith("-") === true || operator(token) === "(" ||
          word(token, cwd, environment) === "!"));
      const roots = words.slice(rootStart, expressionStart < 0 ? actionIndex : expressionStart);
      const effectiveRoots = roots.length ? roots : ["."];
      spendDestructiveVisits(envSplitBudget, effectiveRoots.length);
      // `find` defaults to -P: a symlink given as a search root is not followed, so `-delete`
      // unlinks the alias, not what it points at. -H and -L before the roots follow it, and so
      // does the `-follow` expression anywhere after them.
      const followsRoots = words.slice(0, rootStart).some((token) =>
        ["-H", "-L"].includes(word(token, cwd, environment) ?? "")) ||
        words.some((token) => word(token, cwd, environment) === "-follow");
      const rootVerdict = strongest(effectiveRoots.map((token) =>
        operandVerdict(token, cwd, environment, protections, followsRoots, true)));
      const action = word(words[actionIndex], cwd, environment);
      if (action === "-delete") return rootVerdict;
      if (depth < 3) {
        const end = words.findIndex((token, index) => index > actionIndex &&
          [";", "+"].includes(word(token, cwd, environment) ?? ""));
        const nested = words.slice(actionIndex + 1, end < 0 ? undefined : end);
        const nestedCommand = commandWords(nested, cwd, new Map(environment), envSplitBudget);
        const verdict = segmentVerdict(nested, cwd, new Map(environment), protections, depth + 1,
          envSplitBudget, nestedCommand);
        const removal = parsedExecutables(nestedCommand).some((name) => REMOVERS.includes(name))
          ? rootVerdict : null;
        if (verdict || removal) return strongest([verdict, removal]);
      }
    }
  }
  if (["python", "python3", "node", "perl", "ruby", "pwsh", "powershell"].includes(executable)) {
    const rendered = words.map((token) => word(token, cwd, environment) ?? "").join(" ");
    const destructive = /\b(?:rmtree|remove|unlink|rmdir|rename|remove-item)\b/iu.test(rendered);
    return destructive && protections.some(({ worktreePath }) => rendered.includes(worktreePath))
      ? "protected"
      : null;
  }
  return null;
}

/**
 * Return a provider-facing refusal when a shell command targets a runner-owned worktree root.
 * Ordinary mutations beneath that root remain allowed; retirement of the root itself belongs to
 * the managed discard lifecycle. The parser is deliberately shared by every provider boundary.
 *
 * What "ordinary mutations beneath that root" covers is easy to misread, and #1393 was filed on the
 * opposite reading — that an agent cannot delete a scratch file it created moments earlier. It can,
 * and always could. `protectedTarget` refuses exactly three things:
 *
 *   1. the worktree ROOT, and any ancestor of it;
 *   2. anything inside either Git administrative tree, `<worktree>/.git` and
 *      `<repo>/.git/worktrees` — both of which do sit beneath a root, the first beneath the
 *      worktree's own;
 *   3. any ancestor of those administrative trees, which is how `<repo>` itself is refused.
 *
 * Everything else beneath the worktree root is an ordinary mutation whatever its Git status, so
 * removing a file or directory there is permitted. That is deliberate, and is #1209's own
 * acceptance criterion ("Normal file creation, editing, Git commits, tests, and other expected work
 * inside the selected worktree remain available"), not an oversight to be tightened later:
 *
 * - The boundary this guard owns is worktree LIFECYCLE. Deleting the root, or unregistering it,
 *   strands the session's durable selection and breaks the next launch; deleting a file inside it
 *   is the same class of act as editing one, which the provider must be able to do.
 * - Consulting the Git index to spare tracked files would refuse ordinary work (`rm -rf dist`,
 *   `rm -rf node_modules/.cache`, deleting a file mid-refactor). It would also put a Git
 *   SUBPROCESS on the path of every Bash call. This code already does bounded filesystem I/O — the
 *   hook reads its protections file, and resolution here calls `realpathSync` — but it spawns
 *   nothing and reads no Git state, which is what keeps it cheap and independent of whether the
 *   repository is healthy. Git is already the recovery path for anything tracked.
 * - "Created by this session" has no trustworthy record here in any case: the runner's `file_edit`
 *   events go to the control plane, this hook is a short-lived process with no network, and nothing
 *   observes files a Bash command creates.
 *
 * `managed-worktree-protection.test.ts` pins both halves of this contract.
 *
 * One refusal is not about removal (#1650). A session's own default worktree is verified to be on
 * its `agent/<session-id>` branch before every turn, so a Git command run inside it that switches,
 * detaches, or renames that branch (`gitBranchVerdict`) is refused with a pointer to
 * `wollipog worktree create`, instead of silently parking the session in worktree recovery. Only a
 * protection carrying `pinnedBranch` is judged this way; a worktree the session created for
 * another branch is not. Git prefers a commit to a path for a lone `checkout` operand, so that
 * judgement reads the worktree's ref store (`mayNameCommit`): the only Git state this module reads,
 * and only as plain files.
 *
 * What an operand RESOLVES to is the other half (#1324). A command is judged in the environment the
 * provider's shell starts from — the one the runner passed it, which is where
 * `WOLLIPOG_WORKTREE_PATH` and the rest of the worktree setup keys live — so
 * `rm -rf "$WOLLIPOG_WORKTREE_PATH"` is the same command as naming the root, and is refused the
 * same way. `PWD` reads the tracked working directory, and variables the shell rewrites as it runs
 * (`OLDPWD`, `DIRSTACK`, `_`) never resolve, because the value passed at launch is stale for them.
 *
 * An operand of a DESTRUCTIVE command that still cannot be resolved — a variable neither that
 * environment nor the command defines, a command substitution, a backtick, a path relative to a
 * `cd` or `git -C` this code could not follow — fails closed with
 * `MANAGED_WORKTREE_UNRESOLVED_REFUSAL`, because the shell will expand it into a path the classifier
 * never sees, and that path may be the root. The destructive positions are exactly the ones judged
 * for a protected target: every word of a remover (`rm`, `rmdir`, `unlink`, `trash`, `del`, `rd`,
 * `Remove-Item`, `gio trash`), every `mv` source, the target of `git worktree remove`/`move`, the
 * directory of `git worktree prune`, and the roots of a `find` that deletes or runs a remover.
 * Anything else — an unresolved read, an unresolved `cd` on its own, an unresolved `mv`
 * destination — is not refused for being unresolved.
 *
 * The environment is the one at LAUNCH. It is exact for Codex, which starts each command from it,
 * and for Claude's Bash tool, which keeps its working directory between calls but not its exported
 * variables; a variable exported by a startup file the shell sources is not seen, and a command
 * that indirects through a script file or an interpreter is not parsed at all.
 */
/** Evaluate the POSIX single-line and-or grammar without executing skipped segments. */
function classifyReachableList(
  tokens: ShellToken[],
  cwd: string,
  protections: readonly ManagedWorktreeProtection[],
  providerEnvironment: ReadonlyMap<string, string>,
  depth: number,
  budget: EnvSplitBudget,
): Verdict {
  type Reading = {
    cwd: string;
    environment: Map<string, string>;
    succeeded: boolean;
    priorNonDirectoryCommand: boolean;
  };
  let readings: Reading[] = [{
    cwd: normalize(cwd), environment: new Map(providerEnvironment), succeeded: true,
    priorNonDirectoryCommand: false,
  }];
  let previousOperator: string | null = null;
  let segment: ShellToken[] = [];
  let unresolved = false;
  const unique = (candidates: Reading[]): Reading[] => {
    const result: Reading[] = [];
    for (const candidate of candidates) {
      if (!result.some((existing) => existing.cwd === candidate.cwd &&
          existing.succeeded === candidate.succeeded &&
          existing.priorNonDirectoryCommand === candidate.priorNonDirectoryCommand &&
          existing.environment.size === candidate.environment.size &&
          [...existing.environment].every(([key, value]) => candidate.environment.get(key) === value))) {
        result.push(candidate);
      }
    }
    return result;
  };
  const evaluate = (followingOperator: string | null): Verdict => {
    if (!segment.length) {
      if (followingOperator === null && (previousOperator === null || previousOperator === ";")) return null;
      throw new UnclassifiableCommandError("empty and-or segment");
    }
    const next: Reading[] = [];
    const verdicts: Verdict[] = [];
    for (const reading of readings) {
      const runs = previousOperator === null || previousOperator === ";" ||
        (previousOperator === "&&" ? reading.succeeded : !reading.succeeded);
      if (!runs) {
        next.push(reading);
        continue;
      }
      spendTokenVisits(budget, segment.length);
      const localEnvironment = new Map(reading.environment);
      const parsed = commandWords(segment, reading.cwd, localEnvironment, budget);
      if (parsed === null) {
        // Assignment-only commands can fail through command substitution. Both statuses retain
        // the assignment reading until the next separator makes status immaterial.
        next.push({ ...reading, environment: localEnvironment, succeeded: true });
        next.push({ ...reading, environment: localEnvironment, succeeded: false });
        continue;
      }
      if (parsed.parentShellBuiltin && (parsed.executable === "cd" || parsed.executable === "pushd")) {
        const alternateVerdict = strongest(parsed.alternateReadings.map(({ command: alternative,
          environment: splitEnvironment }) =>
          segmentVerdict([], reading.cwd, splitEnvironment, protections, depth, budget, alternative)));
        if (refuses(alternateVerdict)) return alternateVerdict;
        verdicts.push(alternateVerdict);
        const operand = parsed.words[0];
        const value = word(operand, reading.cwd, localEnvironment);
        if (parsed.executable === "pushd" && value === "-n" && process.platform !== "win32") {
          // Bash and zsh keep cwd; sh/dash fail because pushd is unavailable.
          next.push({ ...reading, environment: localEnvironment, succeeded: true });
          next.push({ ...reading, environment: localEnvironment, succeeded: false });
          continue;
        }
        const stackForm = parsed.executable === "pushd" &&
          (operand === undefined || value === "-n" || /^[+-]\d+$/u.test(value ?? ""));
        const home = operand === undefined && parsed.executable === "cd"
          ? lookup("HOME", reading.cwd, parsed.childEnvironment)
          : undefined;
        const target = stackForm ? null : operand === undefined
          ? (home == null ? null : resolvedPath(home, reading.cwd))
          : value === "-" ? null : resolvedOperand(operand, reading.cwd, localEnvironment);
        if ((stackForm && shellInsideManagedRoot(reading.cwd, protections)) ||
            (target && shellInsideManagedRoot(reading.cwd, protections) &&
              !withinProtectedRoot(canonicalPath(target), physicalProtections(protections)))) return "escape";
        const ambiguousBuiltin = parsed.builtinWrapper &&
          (depth > 0 || parsed.builtinOptionTerminator || process.platform === "win32");
        // A successful host-side directory probe cannot prove `cd` will succeed inside the
        // provider's namespace, or that the directory will still exist when the shell runs.
        // Retain the failure branch so a destructive `||` tail is never skipped optimistically.
        const mayFail = followingOperator === "||" || ambiguousBuiltin ||
          parsed.executable === "pushd" || target === null ||
          !canEnterDirectory(target) || reading.priorNonDirectoryCommand;
        if (mayFail) next.push({ ...reading, environment: new Map(localEnvironment), succeeded: false });
        // Options, CDPATH and unresolved targets can make a successful shell change land at the
        // original cwd even when the apparent operand points elsewhere. Unlike a failed change,
        // this reading may continue through &&.
        if (value === null || value.startsWith("-") || target === null ||
            lookup("CDPATH", reading.cwd, parsed.childEnvironment) ||
            parsed.alternateReadings.length > 0) {
          next.push({ ...reading, environment: new Map(localEnvironment), succeeded: true });
        }
        next.push({ ...reading, cwd: target ?? UNKNOWN_CWD, environment: localEnvironment, succeeded: true });
        continue;
      }
      verdicts.push(segmentVerdict(segment, reading.cwd, localEnvironment, protections, depth,
        budget, parsed));
      const base = { ...reading, environment: localEnvironment, priorNonDirectoryCommand: true };
      // Even `true` and `false` can be shell functions inherited from the provider shell. Keep
      // both statuses unless the directory change itself gives us a reachable result.
      next.push({ ...base, succeeded: true });
      next.push({ ...base, succeeded: false });
    }
    readings = unique(next.map((reading) => followingOperator === ";"
      ? { ...reading, succeeded: true } : reading));
    if (readings.length > MAX_CWD_READINGS) {
      throw new UnclassifiableCommandError("directory readings exceeded their bound");
    }
    return strongest(verdicts);
  };
  for (const token of tokens) {
    const op = operator(token);
    if (op) {
      const verdict = evaluate(op);
      if (refuses(verdict)) return verdict;
      if (verdict === "unresolved") unresolved = true;
      segment = [];
      previousOperator = op;
    } else {
      segment.push(token);
    }
  }
  return strongest([evaluate(null), unresolved ? "unresolved" : null]);
}

function classify(
  command: string,
  cwd: string,
  protections: readonly ManagedWorktreeProtection[],
  providerEnvironment: ReadonlyMap<string, string>,
  depth: number,
  envSplitBudget: EnvSplitBudget = {
    remaining: MAX_ENV_ASSIGNMENT_READINGS, remainingTokens: MAX_CLASSIFICATION_TOKEN_VISITS,
    remainingDestructive: MAX_DESTRUCTIVE_OPERAND_VISITS,
  },
): Verdict {
  // A nested script is rebuilt from expanded values, so it is bounded again here.
  if (command.length > MAX_COMMAND_LENGTH) throw new UnclassifiableCommandError("nested script is too long");
  let tokens: ShellToken[];
  try {
    tokens = parse(command, reference);
  } catch {
    // A failed parse cannot safely tell whether a directory-changing segment was skipped.
    return /(?:^|[\s;&|()])(?:builtin\s+|command\s+)?(?:cd|pushd)(?:\s|$)/u.test(command)
      ? "protected" : null;
  }
  let segment: ShellToken[] = [];
  type CwdReading = { cwd: string; environment: Map<string, string> };
  let readings: CwdReading[] = [{ cwd: normalize(cwd), environment: new Map(providerEnvironment) }];
  let parkedReadings: CwdReading[] = [];
  // shell-quote discards newlines and this classifier does not model pipelines or subshells.
  // Restrict short-circuit tracking to simple single-line lists; keep other forms conservative.
  const canTrackAndChain = !/[\r\n]/u.test(command) && tokens.every((token) => {
    const op = operator(token);
    return op === null || op === "&&" || op === "||" || op === ";";
  });
  if (canTrackAndChain && process.platform !== "win32") {
    return classifyReachableList(tokens, cwd, protections, providerEnvironment, depth, envSplitBudget);
  }
  const hasDirectoryCommand = tokens.some((token, index) => {
    const value = wordText(token);
    if (value !== "cd" && value !== "pushd") return false;
    const before = tokens[index - 1];
    return index === 0 || operator(before) !== null ||
      wordText(before) === "builtin" || wordText(before) === "command";
  });
  // shell-quote discards newlines and does not model pipeline/subshell cwd effects. The fallback
  // must not replace the original cwd optimistically when those forms contain a directory change.
  const ambiguousDirectoryControl =
    (hasDirectoryCommand || (/[\r\n]/u.test(command) && tokens.some((token) =>
      wordText(token) === "cd" || wordText(token) === "pushd"))) &&
    (!canTrackAndChain || tokens.some((token) => operator(token) === "||"));
  const sameReading = (left: CwdReading, right: CwdReading): boolean =>
    left.cwd === right.cwd && left.environment.size === right.environment.size &&
    [...left.environment].every(([key, value]) => right.environment.get(key) === value);
  const uniqueReadings = (candidates: CwdReading[]): CwdReading[] => {
    const unique: CwdReading[] = [];
    for (const reading of candidates) {
      if (!unique.some((existing) => sameReading(existing, reading))) unique.push(reading);
    }
    return unique;
  };
  // An earlier command may remove or replace a directory before a later cd reaches it. A chain
  // made only of cd/pushd commands does not itself mutate the filesystem.
  let priorNonDirectoryCommand = false;
  let unresolved = false;
  const evaluate = (followingOperator: string | null): Verdict => {
    if (!segment.length) {
      if (followingOperator !== "&&" && parkedReadings.length) {
        readings = uniqueReadings([...readings, ...parkedReadings]);
        parkedReadings = [];
      }
      return null;
    }
    const next: CwdReading[] = [];
    const parked = [...parkedReadings];
    const verdicts: Verdict[] = [];
    let sawNonDirectoryCommand = false;
    for (const { cwd: currentCwd, environment } of readings) {
      spendTokenVisits(envSplitBudget, segment.length);
      const localEnvironment = new Map(environment);
      const parsed = commandWords(segment, currentCwd, localEnvironment, envSplitBudget);
      if (parsed === null) {
        // No executable remains (for example, standalone assignments). Keep the cwd and use the
        // environment `commandWords` produced for this reading.
        next.push({ cwd: currentCwd, environment: localEnvironment });
        continue;
      }
      if (parsed.parentShellBuiltin && (parsed.executable === "cd" || parsed.executable === "pushd")) {
        const alternateVerdict = strongest(parsed.alternateReadings.map(({ command: alternative,
          environment: splitEnvironment }) =>
          segmentVerdict([], currentCwd, splitEnvironment, protections, depth, envSplitBudget, alternative)));
        if (refuses(alternateVerdict)) return alternateVerdict;
        verdicts.push(alternateVerdict);
        const operand = parsed.words[0];
        // A bare cd reads its prefix-assigned HOME. A directory-stack operand is not a path.
        const value = word(operand, currentCwd, localEnvironment);
        if (parsed.executable === "pushd" && value === "-n" && process.platform !== "win32") {
          // Bash and zsh update the stack without changing the shell's working directory.
          next.push({ cwd: currentCwd, environment: localEnvironment });
          continue;
        }
        const stackForm = parsed.executable === "pushd" &&
          (operand === undefined || value === "-n" || /^[+-]\d+$/u.test(value ?? ""));
        const home = operand === undefined && parsed.executable === "cd"
          ? lookup("HOME", currentCwd, parsed.childEnvironment)
          : undefined;
        const target = stackForm ? null : operand === undefined
          ? (home == null ? null : resolvedPath(home, currentCwd))
          : value === "-" ? null : resolvedOperand(operand, currentCwd, localEnvironment);
        // A stack rotation can land anywhere; from a managed root it may escape the persistent
        // shell. Literal targets keep the existing escape check even if the change might fail.
        if ((stackForm && shellInsideManagedRoot(currentCwd, protections)) ||
            (target && shellInsideManagedRoot(currentCwd, protections) &&
              !withinProtectedRoot(canonicalPath(target), physicalProtections(protections)))) return "escape";
        const ambiguousBuiltin = parsed.builtinWrapper &&
          (depth > 0 || parsed.builtinOptionTerminator || process.platform === "win32");
        // The caller does not tell us its shell dialect: sh/dash have no pushd even for an
        // accessible literal target, while Bash/zsh do. Retain the old cwd for either result.
        const mayFail = ambiguousBuiltin || parsed.executable === "pushd" || target === null ||
          !canEnterDirectory(target) || priorNonDirectoryCommand;
        if (mayFail) {
          // A failed cd/pushd retains the old cwd. Under && its failure skips the rest of that
          // chain, but a later ; or || can run from the old cwd again.
          const failedReading = { cwd: currentCwd, environment: new Map(localEnvironment) };
          if (canTrackAndChain && followingOperator === "&&" && parsed.alternateReadings.length === 0 &&
              parsed.words.length === 1 && value !== null && !value.startsWith("-") && target !== null &&
              !lookup("CDPATH", currentCwd, parsed.childEnvironment)) {
            parked.push(failedReading);
          } else {
            next.push(failedReading);
          }
          next.push({ cwd: target ?? UNKNOWN_CWD, environment: localEnvironment });
        } else {
          next.push({ cwd: target, environment: localEnvironment });
        }
        continue;
      }
      sawNonDirectoryCommand = true;
      verdicts.push(segmentVerdict(segment, currentCwd, localEnvironment, protections, depth,
        envSplitBudget, parsed));
      next.push({ cwd: currentCwd, environment: localEnvironment });
    }
    const active = uniqueReadings(next);
    const inactive = uniqueReadings(parked).filter((reading) =>
      !active.some((existing) => sameReading(existing, reading)));
    if (active.length + inactive.length > MAX_CWD_READINGS) {
      throw new UnclassifiableCommandError("directory readings exceeded their bound");
    }
    readings = followingOperator === "&&" ? active : uniqueReadings([...active, ...inactive]);
    parkedReadings = followingOperator === "&&" ? inactive : [];
    priorNonDirectoryCommand ||= sawNonDirectoryCommand;
    return strongest(verdicts);
  };
  for (const token of tokens) {
    const op = operator(token);
    if (op) {
      const verdict = evaluate(op);
      if (refuses(verdict)) return verdict;
      if (verdict === "unresolved") unresolved = true;
      segment = [];
    } else {
      segment.push(token);
    }
  }
  const verdict = strongest([evaluate(null), unresolved ? "unresolved" : null]);
  if (!ambiguousDirectoryControl || refuses(verdict)) return verdict;
  // shell-quote discards newlines, so it cannot recover command boundaries from those inputs.
  if (/[\r\n]/u.test(command)) return "protected";
  // Pipes, redirections and subshells make a preceding cd's effect uncertain. Recheck each
  // segment from an unknown directory: path-sensitive destructive operands then fail closed,
  // while ordinary commands such as `cd sub && make > build.log` remain usable.
  const uncertainVerdicts: Verdict[] = [];
  let uncertainSegment: ShellToken[] = [];
  const inspectUncertainSegment = () => {
    if (!uncertainSegment.length) return;
    uncertainVerdicts.push(segmentVerdict(uncertainSegment, UNKNOWN_CWD,
      new Map(providerEnvironment), protections, depth, envSplitBudget));
    uncertainSegment = [];
  };
  for (const token of tokens) {
    if (operator(token)) inspectUncertainSegment();
    else uncertainSegment.push(token);
  }
  inspectUncertainSegment();
  return strongest([verdict, ...uncertainVerdicts]);
}

/** The provider environment as a lookup table, keeping only values a shell could hold. */
function providerEnvironmentMap(environment: ProviderEnvironment): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(environment)) {
    if (name && typeof value === "string" && !value.includes("\0")) map.set(name, value);
  }
  return map;
}

export function commandTargetsManagedWorktree(
  command: string,
  cwd: string,
  protections: readonly ManagedWorktreeProtection[],
  // The environment the runner passed the provider. Omitting it resolves no variable at all, so
  // every variable in a destructive operand fails closed as unresolved.
  environment: ProviderEnvironment = {},
): string | null {
  if (!protections.length || !command || command.length > MAX_COMMAND_LENGTH || command.includes("\0")) return null;
  // The linked-worktree admin directory must be writable for Git's own lock-and-rename protocol,
  // so the provider sandbox cannot preserve its static registration files by itself. Refuse a
  // command that directly names the repository's worktree registry before syntax classification:
  // redirection targets are intentionally not destructive operands below, but `> commondir` is a
  // write all the same. This has the guard's documented command-text strength class; scripts and
  // runtime-built paths still require a runner-owned filesystem boundary.
  const foldCase = process.platform === "win32" || process.platform === "darwin";
  const haystack = foldCase ? command.toLowerCase() : command;
  for (const protection of protections) {
    const root = resolve(protection.repoPath, ".git", "worktrees");
    for (const candidate of new Set([root, canonicalPath(root)])) {
      const needle = foldCase ? candidate.toLowerCase() : candidate;
      if (haystack.includes(`${needle}${sep}`) || haystack.includes(`${needle.split(sep).join("/")}/`)) {
        return MANAGED_WORKTREE_REFUSAL;
      }
    }
  }
  try {
    const verdict = classify(command, cwd, protections, providerEnvironmentMap(environment), 0);
    if (verdict === "protected") return MANAGED_WORKTREE_REFUSAL;
    if (verdict === "escape") return MANAGED_WORKTREE_ESCAPE_REFUSAL;
    if (verdict === "branch") return MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL;
    return verdict === "unresolved" ? MANAGED_WORKTREE_UNRESOLVED_REFUSAL : null;
  } catch {
    // Provider-controlled syntax must never escape the guard or crash the runner. If a bounded
    // destructive target cannot be classified safely, retain the managed worktree.
    return MANAGED_WORKTREE_REFUSAL;
  }
}

/**
 * A working directory that is nowhere: deep enough that no realistic `..` chain climbs out of it,
 * and beneath nothing that is protected. Judging a command from here keeps exactly the refusals
 * that do not depend on where the shell is (an absolute path to the worktree, an absolute `cd`
 * followed by a relative removal) and drops the ones that do.
 *
 * It exists for one caller. Claude's `can_use_tool` request carries no cwd, and its Bash tool keeps
 * a directory of its own between calls, so the control channel cannot know where a relative
 * operand lands (#1333). Inferring it from command text does not converge: renaming the shell's
 * own directory defeats every such inference. The guard hook DOES receive the real directory and
 * has already judged the command, so the control channel only adds what it can know.
 */
export const PLACELESS_CWD = `${sep}.wollipog-placeless${`${sep}x`.repeat(64)}`;

/* ---------------------------------------------------------------------------------------------
 * Guard-state boundary.
 *
 * The managed-worktree guard keeps its protection list in a runner-owned file, and the provider
 * runs as the same OS user, so a permitted command could rewrite that file and disarm the veto.
 * Real integrity against a same-user process needs an OS boundary (#1302); what IS achievable is
 * to refuse every tool call that references the runner's own hook state directory at all — reads
 * included, since the provider never needs them — and to make tampering evident. A command that
 * merely inspects a DIRECTORY CONTAINING it, without enumerating it, is the one carve-out (#1334).
 *
 * The match is deliberately conservative and of the same strength class as
 * `commandTargetsManagedWorktree`: it inspects command text and resolved tool paths, so both are
 * defeated by indirection (a script file, an interpreter, an unexpanded variable).
 * ------------------------------------------------------------------------------------------ */

export const GUARD_STATE_REFUSAL =
  "Wollipog protects its own managed-worktree guard state. That runner-owned directory is not part of this session's workspace and must not be read or modified.";

/**
 * The refusal for a command whose shape, not its target, stopped the check (#1632). Blaming the
 * guard state for a command that never named it sent sessions off treating their own scratch
 * directories as protected; this names the actual reason and what to do instead.
 */
export const GUARD_STATE_UNINSPECTABLE_PREFIX = "Wollipog could not inspect this command for access to its runner-owned state";
export function guardStateUninspectableRefusal(reason: string): string {
  return `${GUARD_STATE_UNINSPECTABLE_PREFIX} (${reason}), so it was not run. Split it into simpler commands, ` +
    "write multi-line content with a file tool, or run it from a script file.";
}

/** Values remembered per assigned name, and spellings judged per word, so no command is unbounded. */
const MAX_ASSIGNED_VALUES = 4;
const MAX_ASSIGNED_SPELLINGS = 16;

const UNMODELLED_SHAPE_REASON =
  "it uses a heredoc, newline, backtick, pipe, or subshell, which the guard does not model, and one of its words names a directory that contains that state";

/** The tokenizer's own complaint, without the command text it quotes back. */
function tokenizerReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const head = message.split(":")[0]?.trim().replace(/[\0-\x1f\x7f]/gu, " ").slice(0, 80);
  return `the shell tokenizer rejected it: ${head || "unparsable syntax"}`;
}

/**
 * Tools whose input names a filesystem location and therefore has to respect the guard-state
 * boundary. `optional` tools search the working directory when the key is absent; `pattern` names
 * a glob input whose static prefix is a location of its own.
 */
export interface GuardStateToolPath { key: string; optional?: true; pattern?: string }
export const GUARD_STATE_FILE_TOOLS: Readonly<Record<string, GuardStateToolPath>> = {
  Edit: { key: "file_path" },
  MultiEdit: { key: "file_path" },
  Write: { key: "file_path" },
  Read: { key: "file_path" },
  NotebookEdit: { key: "notebook_path" },
  Grep: { key: "path", optional: true },
  Glob: { key: "path", optional: true, pattern: "pattern" },
};

/**
 * Tilde forms as the shell (and Claude's file tools) spell a home directory: `~`, `~/x`, the
 * named-user `~name/x`, and `~+` for the working directory. There is no passwd lookup here, so a
 * named user resolves to the current home when it is the current user and to a sibling of it
 * otherwise, which is where every conventional layout puts it. `~-` (OLDPWD) is unknowable.
 */
function homeSpelling(
  path: string,
  cwd: string,
  homeDirectory = homedir(),
): { base: string; rest: string } | null {
  if (!path.startsWith("~")) return null;
  const end = path.search(/[\\/]/u);
  const head = end < 0 ? path : path.slice(0, end);
  const rest = end < 0 ? "" : path.slice(end + 1);
  if (head === "~") return { base: homeDirectory, rest };
  if (head === "~+") return { base: cwd || ".", rest };
  if (head === "~-") return null;
  const name = head.slice(1);
  let current = "";
  try {
    current = userInfo().username;
  } catch {
    /* no passwd entry for this uid: fall through to the sibling layout */
  }
  return { base: name === current ? homeDirectory : resolve(dirname(homeDirectory), name), rest };
}

function expandHome(path: string, cwd = "", homeDirectory = homedir()): string {
  const home = homeSpelling(path, cwd, homeDirectory);
  return home === null ? path : resolve(home.base, home.rest);
}

/**
 * Expand a syntactically leading tilde as the provider's shell will. The launch environment wins
 * over the runner account's home; an absent or empty HOME falls back to the latter. shell-quote
 * does not preserve whether literal text was quoted, so a quoted leading tilde is deliberately
 * expanded too (and may over-refuse), while a tilde produced by `$VAR` is not expanded at all.
 */
function expandOperandHome(
  path: string,
  cwd: string,
  environment: ReadonlyMap<string, string>,
): string | null {
  const configuredHome = lookup("HOME", cwd, environment);
  if (configuredHome?.includes("\0")) return null;
  const homeDirectory = configuredHome
    ? (isAbsolute(configuredHome) ? configuredHome : cwd === UNKNOWN_CWD ? null : resolve(cwd, configuredHome))
    : homedir();
  if (homeDirectory === null) return null;
  const spelling = homeSpelling(path, cwd, homeDirectory);
  if (spelling === null) return path;
  if (spelling.base === UNKNOWN_CWD || spelling.base.includes("\0")) return null;
  return resolve(spelling.base, spelling.rest);
}

/**
 * Follow symlinks as far as the filesystem allows: the nearest existing ancestor is resolved and
 * the not-yet-existing remainder is appended, so a link into the guard state is seen for what it
 * is even when the final component does not exist yet.
 *
 * `null` when the climb could not reach an existing ancestor within its bound. That is not the
 * same as "the spelling is already physical", and the difference matters: a spelling with more
 * not-yet-existing components than the bound has NO physical reading here, and a classifier that
 * fell back to the unresolved spelling would compare a symlinked prefix textually and read
 * `/proc/self/root<guard state>/<257 new directories>/file` as unrelated to the guard state, while
 * the kernel — and a tool that creates missing parents — lands inside it. Every classifier below
 * treats the exhaustion as out of bounds instead.
 */
function canonicalPathOrNull(path: string): string | null {
  const missing: string[] = [];
  let current = path;
  for (let depth = 0; depth < 256; depth++) {
    try {
      return resolve(realpathSync(current), ...missing);
    } catch {
      const parent = dirname(current);
      // Nothing above to resolve: there is no symlink left to follow, so the spelling is physical.
      if (parent === current) return path;
      missing.unshift(basename(current));
      current = parent;
    }
  }
  return null;
}

/** Best-effort physical reading, for callers holding a location that already exists. */
function canonicalPath(path: string): string {
  return canonicalPathOrNull(path) ?? path;
}

/**
 * Every location a spelling can name. A tilde form is ambiguous without a passwd lookup: the shell
 * expands `~name` only when that user exists and otherwise leaves a literal path component, so
 * both readings are candidates and either one landing in the guard state refuses the call.
 */
function guardStateCandidates(path: string, cwd: string): string[] {
  const literal = isAbsolute(path) ? resolve(path) : resolve(cwd || ".", path);
  const expanded = expandHome(path, cwd);
  if (expanded === path) return [literal];
  const home = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd || ".", expanded);
  return home === literal ? [literal] : [literal, home];
}

/**
 * Where the kernel lands on a spelling that climbs with `..`. Resolving it lexically first, as
 * `resolve` does, is wrong once a symlink precedes the `..`: `<ancestor>/link/..` climbs out of the
 * link's TARGET, which can be the hook directory itself. `null` when the spelling cannot resolve,
 * because `..` past a component that does not exist fails before anything is read.
 */
function physicalSpelling(raw: string): string | null {
  const missing: string[] = [];
  let current = raw;
  for (let depth = 0; depth < 256; depth++) {
    try {
      return resolve(realpathSync.native(current), ...missing);
    } catch {
      const name = basename(current);
      if (name === "..") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      if (name !== "" && name !== ".") missing.unshift(name);
      current = parent;
    }
  }
  return null;
}

/** The unnormalized forms of a spelling that climbs with `..`, one per reading of a tilde. */
function climbingSpellings(path: string, cwd: string): string[] {
  if (!/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path)) return [];
  const raw = isAbsolute(path) ? [path] : [`${cwd || "."}${sep}${path}`];
  const home = homeSpelling(path, cwd);
  if (home !== null) raw.push(`${home.base}${sep}${home.rest}`);
  return raw;
}

/** Components under the platform's own separator: on POSIX a backslash is part of a name. */
function componentCount(path: string): number {
  return normalize(path).split(sep).filter(Boolean).length;
}

/**
 * How a spelling relates to the guard-state directory. `inside` is the directory itself or anything
 * beneath it. `ancestor` is a strict ancestor: a directory that contains it, which an inspection may
 * name but a walk would reach. Its `depth` is how many components below it the hook directory sits,
 * under the reading that puts it nearest, so a walk bounded to `depth` levels may name the hook
 * directory but never read it.
 */
export type GuardStateRelation = { kind: "inside" } | { kind: "ancestor"; depth: number };

/**
 * Test-only: how much work the guard-state classifier has done, so a test can assert it grows
 * linearly with a command list without timing it (#1428). `relations` counts path resolutions and
 * `segments` counts per-segment inspection checks. Reset both before measuring.
 */
export const guardStateClassifierWork = { relations: 0, segments: 0 };

/**
 * Where a spelling sits relative to the guard-state directory, or `null` when the two are
 * unrelated. Every candidate is judged twice — by its spelling and by its physical path, since a
 * symlink anywhere along either one lands elsewhere — and the most restrictive answer wins.
 *
 * A candidate with no physical reading at all is treated as `inside`, not as unrelated: see
 * `canonicalPathOrNull`. No location a tool legitimately names has more not-yet-existing
 * components than that bound, so nothing real is refused by it.
 */
export function guardStateRelation(
  path: string,
  cwd: string,
  directory: string,
): GuardStateRelation | null {
  guardStateClassifierWork.relations += 1;
  if (!directory || !path || path.includes("\0")) return null;
  const root = resolve(directory);
  const realRoot = canonicalPath(root);
  // Each reading of the spelling, paired with the reading of the hook directory it is judged against.
  const pairs: Array<[string, string]> = [];
  for (const resolved of guardStateCandidates(path, cwd)) {
    const physical = canonicalPathOrNull(resolved);
    if (physical === null) return { kind: "inside" };
    pairs.push([resolved, root], [physical, realRoot]);
  }
  for (const raw of climbingSpellings(path, cwd)) {
    const physical = physicalSpelling(raw);
    if (physical !== null) pairs.push([physical, realRoot], [physical, root]);
  }
  let depth = Number.POSITIVE_INFINITY;
  for (const [reading, target] of pairs) {
    if (pathContains(target, reading)) return { kind: "inside" };
    if (pathContains(reading, target)) depth = Math.min(depth, componentCount(target) - componentCount(reading));
  }
  return Number.isFinite(depth) ? { kind: "ancestor", depth } : null;
}

/** A path is out of bounds when it is inside the guard-state directory, or contains it. */
export function pathTargetsGuardState(path: string, cwd: string, directory: string): boolean {
  return guardStateRelation(path, cwd, directory) !== null;
}

/* ---------------------------------------------------------------------------------------------
 * Bounded inspection of an ancestor.
 *
 * Refusing every operand that CONTAINS the hook directory also refused `ls /home` and a listing of
 * the home directory in every session whose data directory lives under it (#1334), though neither
 * reads anything the guard owns. The carve-out below is deliberately narrow and fails closed: an
 * operand that is a strict ancestor is allowed only for `ls` without a recursive option, `stat`,
 * `du` with value-free options, and `find START... -maxdepth N` whose bound stops at or above the
 * hook directory — and only when the WHOLE command is such an inspection and nothing else. A
 * recursive removal or a recursive search rooted at an ancestor is refused as before.
 *
 * `du` and `find` came back in a change of their own (#1390), because each needs reasoning `ls` and
 * `stat` do not: both walk the tree they are given, and both can be pointed at a file through an
 * option value, which is not an operand and so is never compared against the guard state. Neither
 * is parsed in general. Each is admitted only in exact argv shapes:
 *
 * - `du` takes only options from a closed list of value-free flags spelled in full, plus a numeric
 *   `--max-depth=`. No option value can name a file, so none needs resolving — `-X`,
 *   `--exclude-from`, and `--files0-from` are simply absent, and a bare value naming a symlink into
 *   the hook directory never gets a chance. `du` does walk the whole ancestor, hook directory
 *   included: it learns the directory's shape and size but opens no file (#1334 accepts that).
 * - `find` takes one or more explicit starts and then exactly `-maxdepth N`. The walk is bounded by
 *   the directory it actually starts in, measured under every reading of that start — spelling,
 *   physical path, and the physical landing of a `..` — with the nearest one deciding. Without an
 *   explicit start it walks the working directory, which no operand names, so it is refused.
 *
 * What disqualifies a command, and why each one has to:
 *
 * - Every command in the list has to be an inspection, not merely the one holding the operand. The
 *   shell carries state across `;` and `&&`: `hash -p /bin/rm ls; ls -rf <ancestor>` runs `rm`, and
 *   a bare `PATH=` assignment or a function definition rebinds a later name the same way.
 * - Anything that routes one command's output into another, or nests a command inside another:
 *   `|`, `|&`, `( )`, `<( )`, `>( )`, a backtick, or an operator not modelled here. A listing piped
 *   into `xargs rm -rf` is not an inspection, and neither is a removal whose operand is a command
 *   substitution, though each contains one.
 * - A newline or carriage return anywhere in the command. `shell-quote` treats an unescaped newline
 *   as whitespace, so a second line would join the first command's words rather than starting a
 *   command of its own, and a backslash-newline would split `-R` into `-` and `R`.
 * - A redirection does NOT start a new command, so its target is kept out of the classification and
 *   is judged as a location only. Treating it as a command word let a leading `>ls` pass a removal
 *   off as an `ls`. A LEADING IO number belongs to the redirection that follows it.
 * - A glob or brace metacharacter anywhere in the command: the shell expands `--recurs{ive,}` into
 *   `--recursive` long before this classifier would see it.
 * - A `NAME=value` assignment: a `PATH=` prefix decides what the command name resolves to.
 * - A command word that is not a bare name: `./ls` and `/tmp/ls` are whatever was planted there.
 * - An option word carrying a path separator. None of the admitted forms has an option that opens a
 *   file, so this refuses nothing they need to read; it is kept so that a path inside an option is
 *   never the one thing the classifier waves through, whatever the option turns out to mean.
 * - A working directory inside the guard state, since a command with no operand acts there.
 *
 * It over-refuses where the safe direction is to do so. A short-option cluster is scanned for `R`
 * without modelling which options take an attached value, so GNU's `ls -IREADME` reads as recursive
 * and is refused; the alternative, a hard-coded list of value-taking options, fails OPEN the day
 * that list is wrong. And `find <ancestor> -maxdepth 1 2>/dev/null` is refused: the tokenizer drops
 * the adjacency that makes `2>` a redirection, so the `2` reads as one more word after the bound.
 * ------------------------------------------------------------------------------------------ */

/** Operators that end one command and begin another. */
const SEGMENT_SEPARATORS = new Set([";", ";;", "&&", "||", "&"]);
/** Operators that attach a target to the CURRENT command rather than starting a new one. */
const REDIRECTIONS = new Set([">", ">>", "<", ">&"]);

function tokenText(token: ShellToken): string | null {
  if (typeof token === "string") return token;
  return token != null && typeof token === "object" && "op" in token && token.op === "glob" &&
      "pattern" in token && typeof token.pattern === "string"
    ? token.pattern
    : null;
}

/**
 * The locations one shell word can name, for the guard-state check.
 *
 * Words are tokenized with every unknown variable kept in place as a `reference`, so a word stays
 * whole: `$S/$d/outdated.txt` is one word, not `$S`, `/`, `$d`, and `/outdated.txt`. Judging those
 * pieces as locations of their own read the lone `/` as the root directory, an ancestor of the hook
 * directory, and refused an ordinary loop over a scratch directory (#1632). A word with no variable
 * is its own reading. Otherwise:
 *
 * - The static prefix before the first variable is judged in full, since whatever follows it lands
 *   beneath it: `~/.wollipog-data/$X` still names an ancestor of the hook directory.
 * - The reading with every variable empty is judged in full, because an unset variable IS empty:
 *   `rm -rf $A/$B` can be `rm -rf /`.
 * - The reading with every variable as one path component is judged in full, because a `..` after it
 *   climbs back out: `$X/../../<data>/hooks/*` reaches the hook directory for any one-component `$X`.
 *   The old tokenizer kept a variable in a glob as literal text, which read it exactly this way.
 * - Each literal piece after a variable is judged in full, as a location of its own, exactly as the
 *   split tokens were: `$X..`, `$X/home/<user>`, `$X/<hook directory>/file`, and a trailing `$X/`
 *   stay refused. The one exception is a piece of nothing but separators BETWEEN two variables. The
 *   `/` in `$S/$d` joins two unknown components rather than naming a location, and reading it as the
 *   root directory was #1632 itself. It is judged only for landing inside, which it never does.
 */
type GuardStateReading = { path: string; insideOnly: boolean };

/** A path component no real directory is named, standing in for an unknown variable. */
const VARIABLE_COMPONENT = "␀wollipog-variable␀";

function guardStateReadings(text: string): GuardStateReading[] {
  if (!text.includes("\0")) return [{ path: text, insideOnly: false }];
  const pieces = text.split(/\0[^\0]*\0/u);
  const readings: GuardStateReading[] = [];
  const head = pieces[0] ?? "";
  const unset = pieces.join("");
  const component = pieces.join(VARIABLE_COMPONENT);
  if (head) readings.push({ path: head, insideOnly: false });
  if (unset && unset !== head) readings.push({ path: unset, insideOnly: false });
  readings.push({ path: component, insideOnly: false });
  pieces.forEach((piece, index) => {
    if (index === 0 || !piece) return;
    const joinsVariables = index < pieces.length - 1 && /^[\\/]+$/u.test(piece);
    readings.push({ path: piece, insideOnly: joinsVariables });
  });
  return readings;
}

/**
 * One command out of a list: every word that names a location, and separately the words that decide
 * what the command DOES. `words` is null when the segment carries an unexpanded variable, since one
 * opaque word could be a recursion flag or another operand.
 */
interface CommandSegment { operands: Array<string | null>; words: string[] | null }

/**
 * Split a parsed command into segments, or `null` when it contains a construct this classifier does
 * not model — in which case nothing in it is an inspection and the caller refuses every related
 * operand, exactly as it did before #1334.
 */
function commandSegments(tokens: readonly ShellToken[]): CommandSegment[] | null {
  const segments: CommandSegment[] = [];
  let operands: Array<string | null> = [];
  let words: string[] | null = [];
  let redirected = false;
  let previousWord: string | null = null;
  for (const token of tokens) {
    const op = operator(token);
    if (op === null) {
      const text = tokenText(token);
      operands.push(text);
      if (redirected) redirected = false;
      else if (words !== null) {
        if (text === null || text.includes("\0")) words = null;
        else words.push(text);
      }
      previousWord = text;
      continue;
    }
    if (SEGMENT_SEPARATORS.has(op)) {
      segments.push({ operands, words });
      operands = [];
      words = [];
      redirected = false;
      previousWord = null;
      continue;
    }
    if (!REDIRECTIONS.has(op)) return null;
    // `2>file`: the IO number is a word of its own here, but it belongs to the redirection. Only a
    // LEADING one is claimed, because `shell-quote` drops the adjacency that separates `2>x` from
    // an ordinary numeric argument.
    if (words !== null && words.length === 1 && previousWord !== null &&
        words[0] === previousWord && /^\d+$/u.test(previousWord)) words.pop();
    redirected = true;
    previousWord = null;
  }
  segments.push({ operands, words });
  return segments;
}

/** `-R`, or any abbreviation of `--recursive` that GNU `getopt_long` accepts. */
function recursiveListing(word: string): boolean {
  if (word.startsWith("--")) {
    const name = word.slice(2).split("=")[0] ?? "";
    return name.length > 0 && "recursive".startsWith(name);
  }
  return /^-[^-]/u.test(word) && word.includes("R");
}

/**
 * `du` options that take no value, spelled exactly: a short cluster made only of these letters, or
 * one of these long names in full. Anything else — `-X`, `--exclude-from`, `--files0-from`, an
 * abbreviation, an unknown option — disqualifies the command. The list names options that are SAFE,
 * so an option missing from it is refused, never waved through. `-a`/`--all` is deliberately absent:
 * it prints every FILE, which would enumerate the hook directory, where plain `du` prints only
 * directories.
 */
const DU_SHORT_FLAGS = /^-[bchkmsx]+$/u;
const DU_LONG_FLAGS = new Set([
  "--apparent-size", "--bytes", "--human-readable", "--one-file-system", "--si", "--summarize", "--total",
]);

/** `du` with nothing but value-free options, a numeric `--max-depth=`, and operands. */
function plainDiskUsage(words: readonly string[]): boolean {
  let options = true;
  for (const word of words.slice(1)) {
    if (!options || !word.startsWith("-")) continue;
    if (word === "--") options = false;
    else if (!DU_SHORT_FLAGS.test(word) && !DU_LONG_FLAGS.has(word) && !/^--max-depth=\d{1,9}$/u.test(word)) {
      return false;
    }
  }
  return true;
}

/**
 * Exactly `find START... -maxdepth N`, with at least one START and no other word. A walk bounded to
 * `N` levels reads the directories above level `N` and only names what sits at it, so it never
 * reads the hook directory when every START holds it at least `N` levels down. Everything else
 * `find` accepts is refused: a leading `-L` follows links out of the tree, a test such as `-empty`
 * opens the directory it names at the bound, and an action acts on it. A walk with no START begins
 * in the working directory, which no operand names, so it is never an inspection here.
 */
function boundedFind(words: readonly string[], depthBelow: (start: string) => number | null): boolean {
  if (words.length < 4 || words.at(-2) !== "-maxdepth") return false;
  const bound = words.at(-1) ?? "";
  if (!/^\d{1,9}$/u.test(bound)) return false;
  for (const start of words.slice(1, -2)) {
    // `find` reads these as the start of its expression, not as a place to walk.
    if (start === "" || start.startsWith("-") || ["!", "(", ")", ","].includes(start)) return false;
    const depth = depthBelow(start);
    if (depth !== null && Number(bound) > depth) return false;
  }
  return true;
}

/**
 * Whether this segment only inspects the directories it names, without reading what is inside the
 * hook directory. `depthBelow` reports how far below a word the hook directory sits, or `null` when
 * that word is unrelated to it. An empty segment — a stray separator, or a bare redirection —
 * commands nothing and can rebind nothing, so it qualifies vacuously.
 */
function inspectsAncestorOnly(
  words: readonly string[],
  depthBelow: (start: string) => number | null,
): boolean {
  guardStateClassifierWork.segments += 1;
  if (words.length === 0) return true;
  // The shell expands these into words this classifier never sees.
  if (words.some((word) => /[*?[\]{}]/u.test(word))) return false;
  // An assignment decides what the command name resolves to.
  if (words.some((word) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word))) return false;
  // A path inside an option is never waved through, whatever the option turns out to mean.
  if (words.some((word) => word.startsWith("-") && (word.includes("/") || word.includes("\\")))) {
    return false;
  }
  const name = words[0];
  if (name === undefined || name === "" || name.includes("/") || name.includes("\\")) return false;
  switch (name) {
    case "ls":
      return !words.some(recursiveListing);
    case "stat":
      return true;
    case "du":
      return plainDiskUsage(words);
    case "find":
      return boundedFind(words, depthBelow);
    default:
      return false;
  }
}

/* ---------------------------------------------------------------------------------------------
 * Reading a command the way bash does, not the way the tokenizer happens to (#1734).
 *
 * `shell-quote` diverges from bash in three ways that each turned into a wrong verdict here. The
 * pre-pass below corrects all three, every correction fail-closed: anything it cannot parse with
 * confidence it leaves untouched, so the fallback is the old, stricter reading.
 *
 *  - COMMENTS. Bash begins a comment only at the start of a word, and ends it at the newline. The
 *    tokenizer treats ANY `#` as a comment and runs it to the end of the whole string, so every
 *    command after the first `#` silently vanished — a real UNDER-refusal, since `echo x#; cat
 *    <state>` then reached the state unseen. Comments are removed to the end of their LINE; a
 *    mid-word `#` is kept (escaped, so the tokenizer keeps it too).
 *  - QUOTED HEREDOC BODIES. A `<<'E'` body handed to a copy-only consumer (`cat`, `tee`) is inert
 *    data: the consumer writes it to its operand or redirect target, both of which the classifier
 *    still inspects, so the body provably cannot reach the state. Its `/`, `//`, and `${...}` no
 *    longer read as paths. A body opened by an UNQUOTED delimiter (it expands), or handed to
 *    anything that executes it (a shell, an unknown command), or spelled inside a pipe/subshell
 *    where the consumer is not the command that wrote the `<<`, is kept and scanned exactly as
 *    before — so a write INTO the state, or a read of it after the heredoc, is still refused.
 *  - REJECTED `${...}`. A substitution bash accepts but the tokenizer rejects (an embedded space,
 *    a `%`/`#`/`:` operator) was refused outright. It is reduced to a reference to its leading
 *    name, so the command is classified on its merits; an assigned name still substitutes, so
 *    nothing that reached the state through a variable stops being refused.
 *
 * The pre-pass returns TWO readings (see `PreparedGuardStateCommand`): the literal-path text scan
 * reads `scan`, which removes only a copy-only heredoc body (inert data) and keeps everything else —
 * comments, `${...}` operator defaults — verbatim, so dropping text for the tokenizer can never hide
 * a literal hook path from the scan. The tokenizer reads the fully-rewritten `parse`.
 * ------------------------------------------------------------------------------------------ */

/**
 * Consumers that copy a heredoc body to a destination without executing it. Their write targets are
 * ordinary operands or redirects, which the classifier inspects regardless, so a quoted body they
 * receive is data that cannot itself reach the guard state. Anything else keeps its body.
 */
const GUARD_STATE_HEREDOC_DATA_CONSUMERS = new Set(["cat", "tee"]);

/** The opaque name a `${...}` with no leading identifier is reduced to: unknown, never assigned. */
const GUARD_STATE_OPAQUE_SUBSTITUTION = "__WOLLIPOG_GUARD_SUB__";

/** The reference a `${...}` is reduced to: its leading identifier, or an opaque, never-assigned name
 *  when it has none. Keeping the leading name means an assigned variable still substitutes. */
function leadingSubstitutionName(inner: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*/u.exec(inner)?.[0] ?? GUARD_STATE_OPAQUE_SUBSTITUTION;
}

/**
 * Reduce every `${...}` in a span of LITERAL text (a heredoc body, which the delimiter quoting keeps
 * unparsed) to `${leadingName}`, so a substitution the tokenizer would reject does not refuse the
 * whole command. Braces are matched by depth, so an embedded space or `%`/`#`/`:` operator — the
 * exact forms shell-quote rejects — is dropped rather than left to break tokenizing.
 */
function reduceBraceSubstitutions(text: string): string {
  if (!text.includes("${")) return text;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "$" && text[i + 1] === "{") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j += 1) {
        if (text[j] === "{" && text[j - 1] === "$") depth += 1;
        else if (text[j] === "}") { depth -= 1; if (depth === 0) break; }
      }
      if (j < text.length) { out += `\${${leadingSubstitutionName(text.slice(i + 2, j))}}`; i = j; continue; }
      out += text.slice(i); break; // unbalanced: leave verbatim
    }
    out += text[i];
  }
  return out;
}

interface PendingHeredoc { delimiter: string; dashStrip: boolean; strip: boolean }

/**
 * The two readings of a command the guard needs. `scan` is the raw text with ONLY the provably-inert
 * regions removed (a copy-only heredoc body); everything else — comments, `${...}`, operator default
 * values — is kept verbatim, so the literal-path raw-text scan still sees a hook path anywhere bash
 * could reach, exactly as it did on the untouched command. `parse` is the fully bash-faithful
 * rewrite the tokenizer reads. Keeping them separate means the rewrite that makes a command parseable
 * can never also hide a literal path from the text scan.
 */
export interface PreparedGuardStateCommand { scan: string; parse: string }

const GUARD_STATE_WORD_BOUNDARY = new Set([" ", "\t", "\n", "\r", ";", "&", "|", "<", ">", "(", ")"]);
const GUARD_STATE_COMMAND_BOUNDARY = new Set([";", "&", "|", "\n", "\r", "(", ")"]);
const GUARD_STATE_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * Rewrite a command so the guard-state classifier reads it as bash would. See the block comment
 * above for the three corrections; everything the scanner cannot parse with confidence is emitted
 * verbatim, so the result is never read MORE permissively than the raw command was.
 *
 * `$'...'` ANSI-C quoting is modelled (a backslash escapes the next character, so `\'` does not
 * close the string), so a `#` or quote after one is read in the right state. A bare carriage return
 * is treated as a line and command boundary — bash does not, but splitting more only scans more.
 */
export function prepareGuardStateCommand(command: string): PreparedGuardStateCommand {
  const n = command.length;
  let scan = "";                // raw text, minus only stripped heredoc bodies — for the text scan
  let out = "";                 // the bash-faithful rewrite — for the tokenizer
  let quote: "'" | '"' | "$'" | null = null;
  let inWord = false;           // inside a word: a `#` here is literal, not a comment
  let firstWord = "";           // the current simple command's first word, for consumer detection
  let firstWordComplete = false;
  let segmentAmbiguous = false; // a leading redirect or an assignment first word: never a clean consumer
  // A pipe, subshell, backtick, or command substitution in a COMMAND region (heredoc bodies are
  // skipped) means a body's consumer is not the word that wrote the `<<`, so no body is stripped.
  // Set persistently once seen; a quoted body full of these metacharacters never reaches here.
  let routingSeen = false;
  const pending: PendingHeredoc[] = [];
  let i = 0;

  const both = (text: string) => { scan += text; out += text; };
  const resetSegment = () => { firstWord = ""; firstWordComplete = false; segmentAmbiguous = false; };
  const settleFirstWord = (isRedirect: boolean) => {
    if (firstWord === "") { if (isRedirect) segmentAmbiguous = true; return; }
    if (!firstWordComplete) {
      firstWordComplete = true;
      if (GUARD_STATE_ASSIGNMENT.test(firstWord)) segmentAmbiguous = true;
    }
  };
  const addWordChar = (ch: string) => { if (!firstWordComplete) firstWord += ch; inWord = true; };
  const strippableConsumer = () =>
    !routingSeen && !segmentAmbiguous && GUARD_STATE_HEREDOC_DATA_CONSUMERS.has(firstWord);

  // Consume the remaining body lines of `pending`. A stripped body leaves BOTH readings (it is inert
  // data copied to an inspected destination). A kept body stays in both — verbatim in `scan`, with
  // its `${...}` reduced in `parse` so a literal substitution does not break tokenizing (#1734).
  const consumeBodies = () => {
    while (pending.length > 0 && i < n) {
      let lineEnd = i;
      while (lineEnd < n && command[lineEnd] !== "\n" && command[lineEnd] !== "\r") lineEnd += 1;
      const line = command.slice(i, lineEnd);
      const terminatorLine = pending[0]!.dashStrip ? line.replace(/^\t+/u, "") : line;
      const sep = command.slice(lineEnd, Math.min(lineEnd + 1, n)); // the single \n or \r, if any
      const isTerminator = terminatorLine === pending[0]!.delimiter;
      if (!pending[0]!.strip) {
        scan += line + sep;
        out += (isTerminator ? line : reduceBraceSubstitutions(line)) + sep;
      }
      if (isTerminator) pending.shift();
      i = lineEnd + (sep ? 1 : 0);
    }
  };

  while (i < n) {
    const c = command[i]!;
    if (quote === "'") { both(c); if (c === "'") quote = null; i += 1; continue; }
    if (quote === "$'") { // ANSI-C: a backslash escapes the next char, so `\'` does not close
      if (c === "\\") { both(c + (command[i + 1] ?? "")); i += 2; continue; }
      both(c); if (c === "'") quote = null; i += 1; continue;
    }
    if (quote === '"') {
      if (c === "\\") { both(c + (command[i + 1] ?? "")); i += 2; continue; }
      if (c === "$" && command[i + 1] === "{") { i = emitSubstitution(i); continue; }
      both(c); if (c === '"') quote = null; i += 1; continue;
    }
    if (c === "\\") { both(c + (command[i + 1] ?? "")); i += 2; addWordChar("\\"); continue; }
    if (c === "$" && command[i + 1] === "'") { both("$'"); addWordChar("$"); quote = "$'"; i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; both(c); addWordChar(c); i += 1; continue; }
    if (c === "#" && !inWord) { // a comment: `parse` drops it to end of line; `scan` keeps it, so a
      while (i < n && command[i] !== "\n" && command[i] !== "\r") { scan += command[i]; i += 1; } // literal path in a comment still refuses, as before
      continue;
    }
    if (c === "#") { scan += "#"; out += "\\#"; addWordChar("#"); i += 1; continue; } // mid-word: literal
    if (c === "`") { both(c); routingSeen = true; inWord = false; i += 1; continue; }
    if (c === "$" && command[i + 1] === "{") { i = emitSubstitution(i); continue; }
    // `<<<` is a here-string (its word is on the line, no body); emit it whole so its trailing `<<`
    // is never mistaken for a heredoc operator.
    if (c === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
      settleFirstWord(true); both("<<<"); inWord = false; i += 3; continue;
    }
    if (c === "<" && command[i + 1] === "<") { i = handleHeredocOperator(i); continue; }
    if (c === "\n" || c === "\r") {
      both(c); inWord = false; resetSegment(); i += 1;
      if (pending.length > 0) consumeBodies();
      continue;
    }
    if (c === " " || c === "\t") { settleFirstWord(false); both(c); inWord = false; i += 1; continue; }
    if (GUARD_STATE_WORD_BOUNDARY.has(c)) { // an operator: `;`, `&`, `|`, redirects, `(`, `)`
      settleFirstWord(c === "<" || c === ">" || c === "&");
      if (c === "|") for (const p of pending) p.strip = false; // this body feeds the pipeline
      if (c === "(") routingSeen = true;
      both(c); inWord = false;
      if (GUARD_STATE_COMMAND_BOUNDARY.has(c)) resetSegment();
      i += 1;
      continue;
    }
    both(c); addWordChar(c); i += 1;
  }
  return { scan, parse: out };

  /** Keep the `${...}` verbatim in `scan`, and reduce it to `${leadingName}` in `parse` so the
   *  operators the tokenizer chokes on are dropped only from the text the tokenizer reads. */
  function emitSubstitution(start: number): number {
    let depth = 0;
    let j = start + 1; // at the `{`
    for (; j < n; j += 1) {
      if (command[j] === "{" && command[j - 1] === "$") depth += 1;
      else if (command[j] === "}") { depth -= 1; if (depth === 0) break; }
    }
    if (j >= n) { both(command.slice(start)); addWordChar("$"); return n; } // unbalanced: verbatim
    scan += command.slice(start, j + 1);
    out += `\${${leadingSubstitutionName(command.slice(start + 2, j))}}`;
    addWordChar("$");
    return j + 1;
  }

  /** Consume a `<<`/`<<-` operator and its delimiter. `scan` keeps it; `parse` drops it when the
   *  body is stripped, so the kept operator never reads as a path (its delimiter is not one). */
  function handleHeredocOperator(start: number): number {
    settleFirstWord(true); // the `<<` ends the command word; a leading one marks the segment ambiguous
    let j = start + 2;
    const dashStrip = command[j] === "-";
    if (dashStrip) j += 1;
    while (j < n && (command[j] === " " || command[j] === "\t")) j += 1;
    let delimiter = "";
    let quoted = false;
    let dq: "'" | '"' | null = null;
    while (j < n) {
      const ch = command[j]!;
      if (dq) { if (ch === dq) { dq = null; } else { delimiter += ch; } j += 1; continue; }
      if (ch === "'" || ch === '"') { dq = ch; quoted = true; j += 1; continue; }
      if (ch === "\\") { quoted = true; delimiter += command[j + 1] ?? ""; j += 2; continue; }
      if (GUARD_STATE_WORD_BOUNDARY.has(ch)) break;
      delimiter += ch; j += 1;
    }
    if (delimiter === "") { both(command.slice(start, j)); inWord = false; return j; }
    const strip = quoted && strippableConsumer();
    pending.push({ delimiter, dashStrip, strip });
    scan += command.slice(start, j);
    if (!strip) out += command.slice(start, j);
    inWord = false;
    return j;
  }
}

/**
 * Refuse a shell command that references the guard-state directory in any form. Unparsable input
 * is refused rather than allowed: this is the state the veto itself depends on. An operand that is
 * a strict ancestor of the directory is refused too, unless the whole command is inspection — see
 * "Bounded inspection of an ancestor" above.
 */
export function commandTargetsGuardState(
  command: string,
  cwd: string,
  directory: string,
): string | null {
  if (!directory || !command || command.length > MAX_COMMAND_LENGTH || command.includes("\0")) return null;
  const root = resolve(directory);
  // Read the command as bash would before matching: comments, quoted copy-only heredoc bodies, and
  // substitutions the tokenizer rejects all turned into wrong verdicts otherwise (#1734). The text
  // scan reads `scan` (literal paths kept everywhere bash could reach); the tokenizer reads `parse`.
  const { scan: scanText, parse: parseText } = prepareGuardStateCommand(command);
  const foldCase = process.platform === "win32" || process.platform === "darwin";
  const haystack = foldCase ? scanText.toLowerCase() : scanText;
  // Raw text first: concatenations, inline `--settings=<path>`, and quoting styles that tokenize
  // in ways a path comparison would miss still name the directory verbatim.
  for (const candidate of [root, root.split(sep).join("/")]) {
    if (haystack.includes(foldCase ? candidate.toLowerCase() : candidate)) return GUARD_STATE_REFUSAL;
  }
  let tokens: ShellToken[];
  try {
    // `$HOME` is as direct a spelling of the data directory's parent as `~`; every other variable
    // stays opaque, which is the documented limit of a command-text matcher. It is kept in place as
    // a reference so the word around it stays whole (see `guardStateReadings`).
    tokens = parse(parseText, (name) => name === "HOME" ? homedir() : reference(name)) as ShellToken[];
  } catch (error) {
    // Still refused: this is the state the veto itself depends on. The raw-text scan above has
    // already refused any command that names the hook directory outright.
    return guardStateUninspectableRefusal(tokenizerReason(error));
  }
  // Each distinct reading is resolved once, and a bounded `find` reads its START depths back from here.
  const relations = new Map<string, GuardStateRelation | null>();
  const relationOf = (path: string): GuardStateRelation | null => {
    if (!relations.has(path)) relations.set(path, guardStateRelation(path, cwd, root));
    return relations.get(path) ?? null;
  };
  // A variable the command assigns is also judged by the value it assigns: `Y=../../<data>/hooks;
  // rm -rf "$HOME/x/y/$Y/"` names the hook directory, however opaque `$Y` would be on its own. Every
  // assignment-looking word counts, wherever it sits, because the values only ADD readings: the word
  // is still judged as written too. So an assignment the shell never keeps (a prefix, a subshell, a
  // background job) cannot hide anything; it can only add a refusal.
  const assignedValues = new Map<string, string[]>();
  for (const token of tokens) {
    const text = tokenText(token);
    const assignment = text === null ? null : /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(text);
    if (!assignment) continue;
    const [, name, value] = assignment as unknown as [string, string, string];
    // The most recent values are kept: a flood of harmless assignments cannot push out the one that
    // is in effect when the word runs.
    const values = (assignedValues.get(name) ?? []).filter((kept) => kept !== value);
    values.push(value);
    assignedValues.set(name, values.slice(-MAX_ASSIGNED_VALUES));
  }
  /** The word as written, then with assigned values substituted, bounded to a few combinations. */
  const spellings = (value: string): string[] => {
    const texts = [value];
    for (let index = 0; index < texts.length && texts.length < MAX_ASSIGNED_SPELLINGS; index += 1) {
      // The first variable in this spelling that the command assigns; unknown ones stay in place.
      const match = [...texts[index]!.matchAll(/\0([^\0]*)\0/gu)].find(([, name]) => assignedValues.has(name!));
      if (!match) continue;
      const before = texts[index]!.slice(0, match.index);
      const after = texts[index]!.slice(match.index + match[0].length);
      for (const assigned of assignedValues.get(match[1]!)!) {
        const text = `${before}${assigned}${after}`;
        if (!texts.includes(text) && texts.length < MAX_ASSIGNED_SPELLINGS) texts.push(text);
      }
    }
    return texts;
  };
  /** The strongest relation any reading of a word has: `inside`, then `ancestor`, then none. */
  const wordRelation = (value: string): GuardStateRelation["kind"] | null => {
    let strongest: GuardStateRelation["kind"] | null = null;
    for (const text of spellings(value)) {
      for (const { path, insideOnly } of guardStateReadings(text)) {
        const relation = relationOf(path);
        if (relation?.kind === "inside") return "inside";
        if (relation?.kind === "ancestor" && !insideOnly) strongest = "ancestor";
      }
    }
    return strongest;
  };
  // A backtick nests a command the tokenizer does not separate, and a newline would silently join
  // two commands into one; nothing in either is inspectable.
  const segments = /[`\n\r]/u.test(parseText) ? null : commandSegments(tokens);
  if (segments === null) {
    // Nothing here is an inspection, so any related word refuses. A word INSIDE the hook directory
    // names the guard state itself. One that only encloses it is refused because the command cannot
    // be inspected, which is what the refusal then says: a kept heredoc's data can read as `/`
    // (a copy-only quoted body is removed before this point and no longer reaches here — #1734).
    let enclosing = false;
    for (const token of tokens) {
      const value = tokenText(token);
      // The tokenizer leaves a backtick glued to its neighbours (`echo` and `<dir>`), so each piece
      // between backticks is a word of its own: `rm -rf \`echo <dir>\`` names `<dir>`. The whole word
      // is still judged too, as written and with every substitution empty, since `<dir>\`\`/../x`
      // joins its pieces into one path.
      const readings = value === null ? [] : [value, value.replaceAll("`", ""), ...value.split("`")];
      for (const piece of new Set(readings)) {
        const relation = piece ? wordRelation(piece) : null;
        if (relation === "inside") return GUARD_STATE_REFUSAL;
        if (relation === "ancestor") enclosing = true;
      }
    }
    return enclosing ? guardStateUninspectableRefusal(UNMODELLED_SHAPE_REASON) : null;
  }
  let namesAncestor = false;
  for (const { operands } of segments) {
    for (const value of operands) {
      if (value === null) continue;
      const relation = wordRelation(value);
      if (relation === "inside") return GUARD_STATE_REFUSAL;
      if (relation === "ancestor") namesAncestor = true;
    }
  }
  if (!namesAncestor) return null;
  // A command with no operand acts on the working directory, so from inside the guard state there
  // is no inspection-only form of one.
  if (guardStateRelation(cwd, cwd, root)?.kind === "inside") return GUARD_STATE_REFUSAL;
  // Every command in the list has to be an inspection, not only the ones naming an ancestor: an
  // earlier `hash -p`, `PATH=`, or function definition decides what a later `ls` runs.
  const depthBelow = (start: string): number | null => {
    // Every word is an operand with no variable in it (a variable disqualifies the segment), so it
    // was resolved above as its own reading.
    const relation = relationOf(start);
    return relation?.kind === "ancestor" ? relation.depth : null;
  };
  const inspection = segments.every(({ words }) => words !== null && inspectsAncestorOnly(words, depthBelow));
  return inspection ? null : GUARD_STATE_REFUSAL;
}

/**
 * Refuse a file tool whose target resolves inside the guard-state directory. Returns `"malformed"`
 * when a matched file tool carries no usable path: the caller must fail closed rather than guess.
 */
export function toolTargetsGuardState(
  toolName: string,
  input: unknown,
  cwd: string,
  directory: string,
): string | "malformed" | null {
  if (!directory) return null;
  const spec = Object.hasOwn(GUARD_STATE_FILE_TOOLS, toolName) ? GUARD_STATE_FILE_TOOLS[toolName] : undefined;
  if (!spec) return null;
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const value = fields[spec.key];
  const absent = value === undefined || value === null || value === "";
  if (absent ? !spec.optional : typeof value !== "string") return "malformed";
  // A search tool without a path searches the working directory.
  if (pathTargetsGuardState(absent ? cwd : value as string, cwd, directory)) return GUARD_STATE_REFUSAL;
  if (spec.pattern) {
    const pattern = fields[spec.pattern];
    if (typeof pattern === "string" && pattern) {
      // Only the static prefix of a glob is a location; the rest is matched beneath it.
      const wildcard = pattern.search(/[*?[{]/u);
      const prefix = wildcard < 0 ? pattern : pattern.slice(0, pattern.lastIndexOf("/", wildcard) + 1);
      // The prefix is a location of its own when it is absolute or a tilde form; otherwise it
      // hangs beneath every reading of the search base, resolved against the EVENT's cwd.
      const bases = absent ? [resolve(cwd || ".")] : guardStateCandidates(value as string, cwd);
      const anchors = isAbsolute(prefix) || prefix.startsWith("~")
        ? [prefix, ...bases.map((base) => resolve(base, prefix))]
        : bases.map((base) => resolve(base, prefix || "."));
      if (anchors.some((anchor) => pathTargetsGuardState(anchor, cwd, directory))) return GUARD_STATE_REFUSAL;
    }
  }
  return null;
}

/** File tools that can change a path, unlike Read, Grep, and Glob. */
const WORKTREE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
export const MANAGED_WORKTREE_EDIT_UNRESOLVED_REFUSAL =
  "Wollipog cannot tell where this relative file-tool path resolves without the managed-worktree guard, so it was not run. Use an absolute path.";

/** Hold Claude's path-bearing edits to the same managed-worktree boundary as `apply_patch`. */
export function editToolTargetsManagedWorktree(
  toolName: string,
  input: unknown,
  cwd: string | null,
  protections: readonly ManagedWorktreeProtection[],
): string | "malformed" | null {
  if (!WORKTREE_EDIT_TOOLS.has(toolName)) return null;
  const spec = GUARD_STATE_FILE_TOOLS[toolName]!;
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = fields[spec.key];
  if (typeof path !== "string" || !path || path.includes("\0")) return "malformed";
  // Claude's control requests carry no event cwd. A relative path can land differently after a
  // Bash cd, so the hookless fallback cannot safely locate it. The sidecar passes the real cwd.
  if (cwd === null && !isAbsolute(path)) return MANAGED_WORKTREE_EDIT_UNRESOLVED_REFUSAL;
  return pathTargetsManagedWorktree(path, cwd ?? "", protections) ? MANAGED_WORKTREE_REFUSAL : null;
}

/* ---------------------------------------------------------------------------------------------
 * Codex `apply_patch`.
 *
 * Codex's edit tool is not a path-bearing file tool: it is one freeform patch document, and the
 * locations it writes live in the patch's own headers (#1437). Measured against codex-cli 0.155.1
 * on this machine (2026-09-19), in a throwaway `CODEX_HOME` against a throwaway repository, by
 * capturing the real `PreToolUse` stdin of every call:
 *
 *   - The payload is the Bash-shaped one: `tool_name` is `apply_patch` and the patch text is
 *     `tool_input.command`, the SAME key a shell call carries its command in. The observed key set
 *     was `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
 *     `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`.
 *   - Header paths may be absolute or relative, and a relative one is resolved against the
 *     payload's `cwd`. Both spellings were produced and both applied.
 *   - The grammar is the CLI's own, read out of the binary it ships, and only four of its
 *     directives name a file:
 *
 *       start:          begin_patch environment_id? hunk+ end_patch
 *       environment_id: "*** Environment ID: " filename LF
 *       add_hunk:       "*** Add File: "    filename LF add_line+
 *       delete_hunk:    "*** Delete File: " filename LF
 *       update_hunk:    "*** Update File: " filename LF change_move? change?
 *       change_move:    "*** Move to: "     filename LF
 *       eof_line:       "*** End of File"   LF
 *       filename:       /(.+)/
 *
 *     Every content line is prefixed (`+` in an add hunk, `+`/`-`/` ` in a change), so a line
 *     beginning `*** ` is always a directive and never file content, and a directive is always a
 *     whole line. That is what makes the line scan below both complete and safe.
 *
 * Judging is therefore a path question, not a command question: each header's filename is resolved
 * the way a file tool's is and held to the same two boundaries — the runner's hook state directory
 * and the managed-worktree rules. A patch this parser cannot account for names locations it cannot
 * enumerate, so it is refused rather than guessed at, exactly as an unreadable command is.
 * ------------------------------------------------------------------------------------------ */

/** Codex's edit tool, as `tool_name` spells it in a `PreToolUse` payload. */
export const APPLY_PATCH_TOOL = "apply_patch";

/** The hook payload itself is capped at 1 MB upstream; a patch cannot be larger than its envelope. */
const MAX_PATCH_LENGTH = 1_000_000;
/**
 * Header paths resolved for one patch. Each resolution walks the filesystem, and the bound keeps a
 * provider-authored patch from turning one tool call into unbounded work. No real edit approaches
 * it, and a patch that exceeds it is refused rather than partly judged.
 */
const MAX_PATCH_PATHS = 1_000;

/** Every line that begins this way is a directive; file content is always prefixed by `+`/`-`/` `. */
const PATCH_DIRECTIVE_PREFIX = "*** ";
/** Directives whose remainder is a filename. */
const PATCH_PATH_DIRECTIVES = [
  "*** Add File: ",
  "*** Update File: ",
  "*** Delete File: ",
  "*** Move to: ",
] as const;
/** Directives that name no location. `*** Environment ID: ` carries an opaque id, not a path. */
const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const PATCH_END_OF_FILE = "*** End of File";
const PATCH_ENVIRONMENT_ID = "*** Environment ID: ";

/**
 * The filenames an `apply_patch` document names, or `"malformed"` when it cannot be accounted for.
 *
 * Unparseable means: not a patch envelope, naming no file at all, or carrying a `*** ` directive
 * this build does not know. The last one is the important case — an unknown directive may name a
 * location, and a guard that skipped it would wave through exactly the write it exists to refuse.
 */
export function parseApplyPatchPaths(patch: string): string[] | "malformed" {
  if (!patch || patch.length > MAX_PATCH_LENGTH || patch.includes("\0")) return "malformed";
  const paths: string[] = [];
  let begun = false;
  let ended = false;
  for (const rawLine of patch.split("\n")) {
    // A patch written with CRLF endings would otherwise carry the carriage return into the path.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith(PATCH_DIRECTIVE_PREFIX)) continue;
    if (line === PATCH_BEGIN) { begun = true; continue; }
    if (line === PATCH_END) { ended = true; continue; }
    if (line === PATCH_END_OF_FILE || line.startsWith(PATCH_ENVIRONMENT_ID)) continue;
    const directive = PATCH_PATH_DIRECTIVES.find((candidate) => line.startsWith(candidate));
    if (directive === undefined) return "malformed";
    const filename = line.slice(directive.length);
    // `filename: /(.+)/` — a header with no name is not a header this guard can judge.
    if (!filename) return "malformed";
    if (paths.length >= MAX_PATCH_PATHS) return "malformed";
    paths.push(filename);
  }
  return begun && ended && paths.length > 0 ? paths : "malformed";
}

/**
 * Trailing padding a header's filename loses before the file is opened.
 *
 * Unicode `White_Space` — which is exactly what Rust's `str::trim_end` removes, and so what
 * codex-cli removes. Deliberately NOT JavaScript's `trimEnd`, whose set differs on precisely two
 * code points, both of them measured here. U+0085 is `White_Space` but not JavaScript whitespace,
 * and codex strips it: judging only `trimEnd`'s result let `*** Delete File: <worktree>/.git<U+0085>`
 * read as an ordinary workspace path while codex resolved it to the protected gitdir pointer.
 * U+FEFF is JavaScript whitespace but not `White_Space`, and codex keeps it: stripping it would
 * refuse `*** Add File: .git<U+FEFF>`, an ordinary workspace file. Those two are the whole
 * disagreement, so this set is pinned by measurement rather than chosen for safety margin.
 */
const PATCH_TRAILING_PAD = /\p{White_Space}+$/u;

/**
 * Where a patch header's filename can land.
 *
 * The grammar takes the rest of the line verbatim, but codex-cli does not. Measured at 0.155.1 by
 * driving live calls and reading the bytes of the files created:
 *
 *     *** Add File: trailing.txt      ->  trailing.txt
 *     *** Add File: nel.txt<U+0085>   ->  nel.txt
 *     *** Add File: bom.txt<U+FEFF>   ->  bom.txt<U+FEFF>
 *     *** Add File:  leading.txt      ->   leading.txt
 *
 * So a trailing pad names a SECOND location, which is judged alongside the verbatim one, while a
 * LEADING space is part of the name: stripping it would refuse `*** Add File:  .git/x`, an
 * ordinary workspace file whose trimmed spelling only looks like Git administration.
 */
function patchPathSpellings(filename: string): string[] {
  const unpadded = filename.replace(PATCH_TRAILING_PAD, "");
  return unpadded && unpadded !== filename ? [filename, unpadded] : [filename];
}

/**
 * Whether a single path is something the managed-worktree rules protect: a worktree's Git
 * administrative area, its registration under the repository, or a location that CONTAINS a
 * protected worktree. Ordinary files inside a protected worktree are the session's own workspace
 * and are not protected — the guard defends the worktree's existence and its Git state, not its
 * contents.
 *
 * Every spelling is judged, the same way `guardStateRelation` judges one: the literal reading, the
 * home-relative reading, the physical reading with symlinks followed, and — for a spelling that
 * climbs with `..` — where the kernel actually lands, since a symlink before a `..` moves it. A
 * spelling with no physical reading at all is protected rather than waved through, for the reason
 * `canonicalPathOrNull` gives.
 */
export function pathTargetsManagedWorktree(
  path: string,
  cwd: string,
  protections: readonly ManagedWorktreeProtection[],
): boolean {
  if (!path || path.includes("\0") || protections.length === 0) return false;
  const physical = physicalProtections(protections);
  for (const candidate of guardStateCandidates(path, cwd)) {
    if (protectedTarget(candidate, protections)) return true;
    const resolved = canonicalPathOrNull(candidate);
    if (resolved === null || protectedTarget(resolved, physical)) return true;
  }
  for (const raw of climbingSpellings(path, cwd)) {
    const landing = physicalSpelling(raw);
    if (landing !== null && protectedTarget(landing, physical)) return true;
  }
  return false;
}

/**
 * Judge one `apply_patch` document. Returns the refusal to show the model, `"malformed"` when the
 * patch cannot be parsed (the caller must fail closed), or `null` when every file it names is an
 * ordinary one.
 *
 * The guard's own state is judged first, for the same reason the Bash path judges it first: a
 * patch that can rewrite the protection list would otherwise disarm every later check.
 */
export function applyPatchTargetsProtected(
  patch: string,
  cwd: string,
  guardStateDirectory: string,
  protections: readonly ManagedWorktreeProtection[],
): string | "malformed" | null {
  const filenames = parseApplyPatchPaths(patch);
  if (filenames === "malformed") return "malformed";
  const spellings = filenames.flatMap(patchPathSpellings);
  if (guardStateDirectory &&
      spellings.some((spelling) => pathTargetsGuardState(spelling, cwd, guardStateDirectory))) {
    return GUARD_STATE_REFUSAL;
  }
  return spellings.some((spelling) => pathTargetsManagedWorktree(spelling, cwd, protections))
    ? MANAGED_WORKTREE_REFUSAL
    : null;
}
