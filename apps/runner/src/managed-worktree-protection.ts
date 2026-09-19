import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, matchesGlob, normalize, parse as parsePath, resolve, sep } from "node:path";
import { parse, type ParseEntry } from "shell-quote";

const MAX_COMMAND_LENGTH = 32_768;
const MAX_GLOB_METACHARACTERS = 64;
const MAX_GLOB_BRACE_GROUPS = 8;
const MAX_ENV_SPLIT_STRING_EXPANSIONS = 8;
export const MANAGED_WORKTREE_REFUSAL =
  "Wollipog protects this runner-owned worktree. Use discard_worktree so retirement can wait for the provider to exit and then apply the managed safety checks.";

/**
 * Refusal for a destructive command whose target the classifier cannot place (#1324): an unknown
 * variable, a command substitution, a backtick, or a relative path after a `cd` it cannot follow.
 */
export const MANAGED_WORKTREE_UNRESOLVED_REFUSAL =
  "Wollipog cannot tell where this destructive command's target resolves while a runner-owned worktree is protected, so it was not run. Name the target as a literal path, or through a variable the session environment already defines; to retire the worktree itself, use discard_worktree.";

export interface ManagedWorktreeProtection {
  worktreePath: string;
  repoPath: string;
}

/**
 * The environment the provider's shell starts from: the one the runner passed it. A value may be
 * undefined only because `process.env` is typed that way.
 */
export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

type ShellToken = ParseEntry;

/**
 * What one command, segment, or operand amounts to: it reaches a protected root (`protected`), it
 * is destructive but its target cannot be placed (`unresolved`), or neither (`null`).
 */
type Verdict = "protected" | "unresolved" | null;

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

/** The raw text of a word token (a plain word or a glob), placeholders included. */
function wordText(token: ShellToken | undefined): string | null {
  if (typeof token === "string") return token;
  if (token != null && typeof token === "object" && "op" in token && token.op === "glob" &&
      "pattern" in token && typeof token.pattern === "string") return token.pattern;
  return null;
}

function lookup(name: string, cwd: string, environment: ReadonlyMap<string, string>): string | undefined {
  if (name === "PWD" || name === "CWD") return cwd === UNKNOWN_CWD ? undefined : cwd;
  if (SHELL_MAINTAINED.has(name)) return undefined;
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
): Verdict {
  const value = word(token, cwd, environment);
  if (value == null) return wordText(token) == null ? null : "unresolved";
  // An unquoted expansion is split on whitespace, and this parser no longer knows which ones were
  // quoted. A value that came from a variable is judged whole AND field by field.
  if (wordText(token)?.includes("\0") && /\s/u.test(value)) {
    const verdicts = [value, ...value.split(/\s+/u).filter(Boolean)].map((field) =>
      literalOperandVerdict(field, field, cwd, environment, protections, followFinalSymlink));
    return verdicts.includes("protected") ? "protected" : verdicts.includes("unresolved") ? "unresolved" : null;
  }
  return literalOperandVerdict(value, token, cwd, environment, protections, followFinalSymlink);
}

function literalOperandVerdict(
  value: string,
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
  followFinalSymlink: boolean,
): Verdict {
  if (cwd === UNKNOWN_CWD && !isAbsolute(value)) return "unresolved";
  const target = resolvedPath(value, cwd);
  if (target == null) {
    return globTargetsProtected(token, cwd, environment, protections) ||
        globTargetsProtected(token, physicalCwd(cwd), environment, physicalProtections(protections))
      ? "protected"
      : null;
  }
  if (protectedTarget(target, protections)) return "protected";
  // The shell's `cd` is logical, but the command this operand belongs to is external and the
  // kernel resolves it from the PHYSICAL directory: `..` beneath a symlink lands where the link
  // points, not where the shell prints. Judge that reading too, against the physical protections.
  const follows = followFinalSymlink ||
    (process.platform === "win32" ? /[\\/]\.?$/u : /\/\.?$/u).test(value);
  return protectedTarget(physicalResolve(cwd, value, follows), physicalProtections(protections))
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
  return value == null ? null : resolvedPath(value, cwd);
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

function executableName(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase().replace(/\.exe$/u, "") ?? "";
}

function commandWords(
  tokens: ShellToken[],
  cwd: string,
  environment: Map<string, string>,
): { words: ShellToken[]; executable: string } | null {
  let index = 0;
  let splitStringExpansions = 0;
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
  while (typeof tokens[index] === "string" && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] as string)) {
    const assignment = tokens[index] as string;
    const equals = assignment.indexOf("=");
    environment.set(assignment.slice(0, equals), expandReferences(assignment.slice(equals + 1), cwd, environment));
    index += 1;
  }
  let executable = word(tokens[index], cwd, environment);
  while (executable) {
    const name = executableName(executable);
    if (name === "sudo") {
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
      executable = word(tokens[index], cwd, environment);
      continue;
    }
    if (["command", "nohup", "setsid"].includes(name)) {
      index += 1;
      while (typeof word(tokens[index], cwd, environment) === "string" &&
          word(tokens[index], cwd, environment)!.startsWith("-")) index += 1;
      executable = word(tokens[index], cwd, environment);
      continue;
    }
    if (name === "env") {
      index += 1;
      while (typeof tokens[index] === "string") {
        const value = tokens[index] as string;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) {
          const equals = value.indexOf("=");
          environment.set(value.slice(0, equals), expandReferences(value.slice(equals + 1), cwd, environment));
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
        const valued = cluster ?? longOption(value, "--unset", 3) ?? longOption(value, "--chdir", 3);
        if (valued) {
          index += valued.attached == null ? 2 : 1;
          continue;
        }
        if (value.startsWith("-")) { index += 1; continue; }
        break;
      }
      executable = word(tokens[index], cwd, environment);
      continue;
    }
    if (name === "nice") {
      index += 1;
      const option = word(tokens[index], cwd, environment);
      if (option === "-n" || option === "--adjustment") index += 2;
      else if (option && (/^-\d+$/u.test(option) || option.startsWith("--adjustment="))) index += 1;
      executable = word(tokens[index], cwd, environment);
      continue;
    }
    if (name === "timeout") {
      index += 1;
      while (true) {
        const option = word(tokens[index], cwd, environment);
        if (!option?.startsWith("-")) break;
        if (["-k", "--kill-after", "-s", "--signal"].includes(option)) index += 2;
        else index += 1;
      }
      if (word(tokens[index], cwd, environment)) index += 1; // duration
      executable = word(tokens[index], cwd, environment);
      continue;
    }
    break;
  }
  if (!executable) return null;
  return { words: tokens.slice(index + 1), executable: executableName(executable) };
}

/** The most severe of several verdicts: a protected target outranks one that cannot be placed. */
function strongest(verdicts: Iterable<Verdict>): Verdict {
  let result: Verdict = null;
  for (const verdict of verdicts) {
    if (verdict === "protected") return verdict;
    result ??= verdict;
  }
  return result;
}

const REMOVERS = ["rm", "rmdir", "unlink", "trash", "trash-put", "mv", "move"];

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

function segmentVerdict(
  tokens: ShellToken[],
  cwd: string,
  environment: Map<string, string>,
  protections: readonly ManagedWorktreeProtection[],
  depth: number,
): Verdict {
  const command = commandWords(tokens, cwd, environment);
  if (!command) return null;
  const { executable, words } = command;
  if (["sh", "bash", "zsh", "dash", "fish", "cmd"].includes(executable) && depth < 3) {
    const flag = words.findIndex((token) => {
      const value = word(token, cwd, environment)?.toLowerCase() ?? "";
      return value === "/c" || /^-[a-z]*c[a-z]*$/u.test(value);
    });
    const script = flag >= 0 ? scriptText(words[flag + 1], cwd, environment) : null;
    return script ? classify(script, cwd, protections, environment, depth + 1) : null;
  }
  if (executable === "eval" && depth < 3) {
    const script = words.map((token) => scriptText(token, cwd, environment) ?? "").join(" ");
    return classify(script, cwd, protections, environment, depth + 1);
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
    const verdict = segmentVerdict(nested, cwd, new Map(environment), protections, depth + 1);
    const nestedExecutable = commandWords(nested, cwd, new Map(environment))?.executable ?? "";
    if (!REMOVERS.includes(nestedExecutable)) return verdict;
    // What arrives on stdin is invisible, so a remover run from inside a managed root is refused
    // outright, and one run from a directory the classifier lost track of cannot be placed.
    if (shellInsideManagedRoot(cwd, protections)) return "protected";
    return strongest([verdict, cwd === UNKNOWN_CWD ? "unresolved" : null]);
  }
  if (executable === "git") return gitWorktreeVerdict(words, cwd, environment, protections);
  if (["rm", "rmdir", "unlink", "trash", "trash-put", "remove-item", "del", "rd"].includes(executable)) {
    return strongest(words.map((token) => operandVerdict(token, cwd, environment, protections, false)));
  }
  if (executable === "gio" && word(words[0], cwd, environment) === "trash") {
    return strongest(words.slice(1).map((token) => operandVerdict(token, cwd, environment, protections, false)));
  }
  if (["mv", "move", "rename-item"].includes(executable)) {
    let targetDirectory = false;
    const operands: ShellToken[] = [];
    for (let index = 0; index < words.length; index += 1) {
      const token = words[index];
      if (token == null) continue;
      const value = word(token, cwd, environment);
      if (value === "--") {
        operands.push(...words.slice(index + 1));
        break;
      }
      if (value?.startsWith("-")) {
        const option = moveOption(value);
        if (option.targetDirectory) targetDirectory = true;
        if (option.consumesNext) index += 1;
        continue;
      }
      operands.push(token);
    }
    // A word that cannot be resolved is taken as an operand, so it is judged as a source unless it
    // is the final destination, which receives the move and is not itself retired.
    const sources = targetDirectory ? operands : operands.slice(0, -1);
    return strongest(sources.map((source) => operandVerdict(source, cwd, environment, protections, false)));
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
      // `find` defaults to -P: a symlink given as a search root is not followed, so `-delete`
      // unlinks the alias, not what it points at. -H and -L before the roots follow it, and so
      // does the `-follow` expression anywhere after them.
      const followsRoots = words.slice(0, rootStart).some((token) =>
        ["-H", "-L"].includes(word(token, cwd, environment) ?? "")) ||
        words.some((token) => word(token, cwd, environment) === "-follow");
      const rootVerdict = strongest(effectiveRoots.map((token) =>
        operandVerdict(token, cwd, environment, protections, followsRoots)));
      const action = word(words[actionIndex], cwd, environment);
      if (action === "-delete") return rootVerdict;
      if (depth < 3) {
        const end = words.findIndex((token, index) => index > actionIndex &&
          [";", "+"].includes(word(token, cwd, environment) ?? ""));
        const nested = words.slice(actionIndex + 1, end < 0 ? undefined : end);
        const verdict = segmentVerdict(nested, cwd, new Map(environment), protections, depth + 1);
        const nestedExecutable = commandWords(nested, cwd, new Map(environment))?.executable ?? "";
        const removal = REMOVERS.includes(nestedExecutable) ? rootVerdict : null;
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
function classify(
  command: string,
  cwd: string,
  protections: readonly ManagedWorktreeProtection[],
  providerEnvironment: ReadonlyMap<string, string>,
  depth: number,
): Verdict {
  // A nested script is rebuilt from expanded values, so it is bounded again here.
  if (command.length > MAX_COMMAND_LENGTH) throw new UnclassifiableCommandError("nested script is too long");
  let tokens: ShellToken[];
  try {
    tokens = parse(command, reference);
  } catch {
    return null;
  }
  let segment: ShellToken[] = [];
  let currentCwd = normalize(cwd);
  const environment = new Map(providerEnvironment);
  let unresolved = false;
  const evaluate = (): Verdict => {
    if (!segment.length) return null;
    const localEnvironment = new Map(environment);
    const parsed = commandWords(segment, currentCwd, localEnvironment);
    if (parsed?.executable === "cd" || parsed?.executable === "pushd") {
      const operand = parsed.words[0];
      // A bare `cd` goes home; `cd -`, a bare `pushd`, and a target that does not resolve go
      // somewhere this code cannot name, and a later relative operand is then unresolved.
      const home = operand === undefined && parsed.executable === "cd"
        ? lookup("HOME", currentCwd, localEnvironment)
        : undefined;
      const target = operand === undefined
        ? (home == null ? null : resolvedPath(home, currentCwd))
        : word(operand, currentCwd, localEnvironment) === "-"
          ? null
          : resolvedOperand(operand, currentCwd, localEnvironment);
      // Claude's Bash tool keeps its shell directory between calls. Refuse an escape from every
      // managed root so a later relative removal cannot be resolved against an unobservable cwd.
      if (target && shellInsideManagedRoot(currentCwd, protections) &&
          !withinProtectedRoot(canonicalPath(target), physicalProtections(protections))) return "protected";
      currentCwd = target ?? UNKNOWN_CWD;
      for (const [key, value] of localEnvironment) environment.set(key, value);
      return null;
    }
    const verdict = segmentVerdict(segment, currentCwd, localEnvironment, protections, depth);
    for (const [key, value] of localEnvironment) environment.set(key, value);
    return verdict;
  };
  for (const token of tokens) {
    if (operator(token)) {
      const verdict = evaluate();
      if (verdict === "protected") return verdict;
      if (verdict === "unresolved") unresolved = true;
      segment = [];
    } else {
      segment.push(token);
    }
  }
  return strongest([evaluate(), unresolved ? "unresolved" : null]);
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
  try {
    const verdict = classify(command, cwd, protections, providerEnvironmentMap(environment), 0);
    if (verdict === "protected") return MANAGED_WORKTREE_REFUSAL;
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
function homeSpelling(path: string, cwd: string): { base: string; rest: string } | null {
  if (!path.startsWith("~")) return null;
  const end = path.search(/[\\/]/u);
  const head = end < 0 ? path : path.slice(0, end);
  const rest = end < 0 ? "" : path.slice(end + 1);
  if (head === "~") return { base: homedir(), rest };
  if (head === "~+") return { base: cwd || ".", rest };
  if (head === "~-") return null;
  const name = head.slice(1);
  let current = "";
  try {
    current = userInfo().username;
  } catch {
    /* no passwd entry for this uid: fall through to the sibling layout */
  }
  return { base: name === current ? homedir() : resolve(dirname(homedir()), name), rest };
}

function expandHome(path: string, cwd = ""): string {
  const home = homeSpelling(path, cwd);
  return home === null ? path : resolve(home.base, home.rest);
}

/**
 * Follow symlinks as far as the filesystem allows: the nearest existing ancestor is resolved and
 * the not-yet-existing remainder is appended, so a link into the guard state is seen for what it
 * is even when the final component does not exist yet.
 */
function canonicalPath(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (let depth = 0; depth < 256; depth++) {
    try {
      return resolve(realpathSync(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      missing.unshift(basename(current));
      current = parent;
    }
  }
  return path;
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
    pairs.push([resolved, root], [canonicalPath(resolved), realRoot]);
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
        if (text === null) words = null;
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
  const foldCase = process.platform === "win32" || process.platform === "darwin";
  const haystack = foldCase ? command.toLowerCase() : command;
  // Raw text first: concatenations, inline `--settings=<path>`, and quoting styles that tokenize
  // in ways a path comparison would miss still name the directory verbatim.
  for (const candidate of [root, root.split(sep).join("/")]) {
    if (haystack.includes(foldCase ? candidate.toLowerCase() : candidate)) return GUARD_STATE_REFUSAL;
  }
  let tokens: ShellToken[];
  try {
    // `$HOME` is as direct a spelling of the data directory's parent as `~`; every other variable
    // stays opaque, which is the documented limit of a command-text matcher.
    tokens = parse(command, (name) => name === "HOME" ? homedir() : { env: name }) as ShellToken[];
  } catch {
    return GUARD_STATE_REFUSAL;
  }
  // A backtick nests a command the tokenizer does not separate, and a newline would silently join
  // two commands into one; nothing in either is inspectable.
  const segments = /[`\n\r]/u.test(command) ? null : commandSegments(tokens);
  if (segments === null) {
    for (const token of tokens) {
      const value = tokenText(token);
      if (value !== null && pathTargetsGuardState(value, cwd, root)) return GUARD_STATE_REFUSAL;
    }
    return null;
  }
  let namesAncestor = false;
  // Each distinct word is resolved once, and a bounded `find` reads its START depths back from here.
  const relations = new Map<string, GuardStateRelation | null>();
  for (const { operands } of segments) {
    for (const value of operands) {
      if (value === null || relations.has(value)) continue;
      const relation = guardStateRelation(value, cwd, root);
      relations.set(value, relation);
      if (relation === null) continue;
      if (relation.kind === "inside") return GUARD_STATE_REFUSAL;
      namesAncestor = true;
    }
  }
  if (!namesAncestor) return null;
  // A command with no operand acts on the working directory, so from inside the guard state there
  // is no inspection-only form of one.
  if (guardStateRelation(cwd, cwd, root)?.kind === "inside") return GUARD_STATE_REFUSAL;
  // Every command in the list has to be an inspection, not only the ones naming an ancestor: an
  // earlier `hash -p`, `PATH=`, or function definition decides what a later `ls` runs.
  const depthBelow = (start: string): number | null => {
    // Every word is an operand, so it was resolved above.
    const relation = relations.has(start) ? relations.get(start) : guardStateRelation(start, cwd, root);
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
