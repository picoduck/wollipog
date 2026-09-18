import { dirname, isAbsolute, matchesGlob, normalize, resolve, sep } from "node:path";
import { parse, type ParseEntry } from "shell-quote";

const MAX_COMMAND_LENGTH = 32_768;
const MAX_GLOB_METACHARACTERS = 64;
const MAX_GLOB_BRACE_GROUPS = 8;
export const MANAGED_WORKTREE_REFUSAL =
  "Wollipog protects this runner-owned worktree. Use discard_worktree so retirement can wait for the provider to exit and then apply the managed safety checks.";

export interface ManagedWorktreeProtection {
  worktreePath: string;
  repoPath: string;
}

interface EnvironmentReference { env: string }
type ShellToken = ParseEntry | EnvironmentReference;

function environmentReference(token: ShellToken | undefined): token is EnvironmentReference {
  return token != null && typeof token === "object" && "env" in token && typeof token.env === "string";
}

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
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
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

function word(
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
): string | null {
  if (typeof token === "string" && !token.includes("`")) return token;
  if (token != null && typeof token === "object" && "op" in token && token.op === "glob" &&
      "pattern" in token && typeof token.pattern === "string") return token.pattern;
  if (!environmentReference(token)) return null;
  if (token.env === "PWD" || token.env === "CWD") return cwd;
  return environment.get(token.env) ?? null;
}

function globPattern(token: ShellToken | undefined): string | null {
  if (token != null && typeof token === "object" && "op" in token && token.op === "glob" &&
      "pattern" in token && typeof token.pattern === "string") return token.pattern;
  if (typeof token === "string" && /[*?\[\]{}]/u.test(token)) return token;
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
  protections: readonly ManagedWorktreeProtection[],
): boolean {
  const pattern = globPattern(token);
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

function operandTargetsProtected(
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
): boolean {
  const target = resolvedOperand(token, cwd, environment);
  return target != null ? protectedTarget(target, protections) : globTargetsProtected(token, cwd, protections);
}

function resolvedOperand(
  token: ShellToken | undefined,
  cwd: string,
  environment: ReadonlyMap<string, string>,
): string | null {
  const value = word(token, cwd, environment);
  if (!value || value.includes("\0") || /[*?\[\]{}]/u.test(value)) return null;
  return normalize(isAbsolute(value) ? value : resolve(cwd, value));
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
  while (typeof tokens[index] === "string" && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] as string)) {
    const assignment = tokens[index] as string;
    const equals = assignment.indexOf("=");
    environment.set(assignment.slice(0, equals), assignment.slice(equals + 1));
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
          environment.set(value.slice(0, equals), value.slice(equals + 1));
          index += 1;
          continue;
        }
        if (["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(value)) {
          index += 2;
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

function gitWorktreeRefusal(
  words: ShellToken[],
  initialCwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
): boolean {
  let cwd = initialCwd;
  const actionIndex = words.findIndex((token, index) =>
    word(token, cwd, environment) === "worktree" &&
    ["remove", "move", "prune"].includes(word(words[index + 1], cwd, environment) ?? ""));
  if (actionIndex < 0) return false;
  let index = 0;
  while (index < actionIndex) {
    const value = word(words[index], cwd, environment);
    if (value === "-C") {
      const next = resolvedOperand(words[index + 1], cwd, environment);
      // A dynamic -C cannot make an absolute protected removal operand safe. Retain the last
      // known cwd and continue scanning so the worktree subcommand and target still reach the veto.
      if (next) cwd = next;
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
    return false;
  }
  const action = word(words[actionIndex + 1], cwd, environment);
  const operands = words.slice(actionIndex + 2).filter((token) => {
    const value = word(token, cwd, environment);
    return value !== "--" && !value?.startsWith("-");
  });
  if (action === "prune") return protectionRepository(cwd, protections);
  if (action !== "remove" && action !== "move") return false;
  return operandTargetsProtected(operands[0], cwd, environment, protections);
}

function segmentRefusal(
  tokens: ShellToken[],
  cwd: string,
  environment: Map<string, string>,
  protections: readonly ManagedWorktreeProtection[],
  depth: number,
): boolean {
  const command = commandWords(tokens, cwd, environment);
  if (!command) return false;
  const { executable, words } = command;
  if (["sh", "bash", "zsh", "dash", "fish", "cmd"].includes(executable) && depth < 3) {
    const flag = words.findIndex((token) => {
      const value = word(token, cwd, environment)?.toLowerCase() ?? "";
      return value === "/c" || /^-[a-z]*c[a-z]*$/u.test(value);
    });
    const script = flag >= 0 ? word(words[flag + 1], cwd, environment) : null;
    return script ? commandTargetsManagedWorktree(script, cwd, protections, depth + 1) != null : false;
  }
  if (executable === "eval" && depth < 3) {
    const script = words.map((token) => word(token, cwd, environment) ?? "").join(" ");
    return commandTargetsManagedWorktree(script, cwd, protections, depth + 1) != null;
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
    if (segmentRefusal(nested, cwd, new Map(environment), protections, depth + 1)) return true;
    const nestedExecutable = commandWords(nested, cwd, new Map(environment))?.executable ?? "";
    return withinProtectedRoot(cwd, protections) &&
      ["rm", "rmdir", "unlink", "trash", "trash-put", "mv", "move"].includes(nestedExecutable);
  }
  if (executable === "git") return gitWorktreeRefusal(words, cwd, environment, protections);
  if (["rm", "rmdir", "unlink", "trash", "trash-put", "remove-item", "del", "rd"].includes(executable)) {
    return words.some((token) => operandTargetsProtected(token, cwd, environment, protections));
  }
  if (executable === "gio" && word(words[0], cwd, environment) === "trash") {
    return words.slice(1).some((token) => operandTargetsProtected(token, cwd, environment, protections));
  }
  if (["mv", "move", "rename-item"].includes(executable)) {
    let source: ShellToken | undefined;
    for (let index = 0; index < words.length; index += 1) {
      const token = words[index];
      const value = word(token, cwd, environment);
      if (value === "--") {
        source = words[index + 1];
        break;
      }
      if (["-t", "--target-directory", "-S", "--suffix"].includes(value ?? "")) {
        index += 1;
        continue;
      }
      if (value?.startsWith("-")) continue;
      source = token;
      break;
    }
    return operandTargetsProtected(source, cwd, environment, protections);
  }
  if (executable === "find") {
    const actionIndex = words.findIndex((token) =>
      ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(word(token, cwd, environment) ?? ""));
    if (actionIndex >= 0) {
      let rootStart = 0;
      while (["-H", "-L", "-P"].includes(word(words[rootStart], cwd, environment) ?? "") ||
          /^-(?:O|D)/u.test(word(words[rootStart], cwd, environment) ?? "")) rootStart += 1;
      const expressionStart = words.findIndex((token, index) => index >= rootStart &&
        (word(token, cwd, environment)?.startsWith("-") === true || operator(token) === "(" ||
          word(token, cwd, environment) === "!"));
      const roots = words.slice(rootStart, expressionStart < 0 ? actionIndex : expressionStart);
      const effectiveRoots = roots.length ? roots : ["."];
      const protectedRoot = effectiveRoots.some((token) =>
        operandTargetsProtected(token, cwd, environment, protections));
      const action = word(words[actionIndex], cwd, environment);
      if (action === "-delete") return protectedRoot;
      if (depth < 3) {
        const end = words.findIndex((token, index) => index > actionIndex &&
          [";", "+"].includes(word(token, cwd, environment) ?? ""));
        const nested = words.slice(actionIndex + 1, end < 0 ? undefined : end);
        if (segmentRefusal(nested, cwd, new Map(environment), protections, depth + 1)) return true;
        const nestedExecutable = commandWords(nested, cwd, new Map(environment))?.executable ?? "";
        if (protectedRoot && ["rm", "rmdir", "unlink", "trash", "trash-put", "mv", "move"].includes(nestedExecutable)) {
          return true;
        }
      }
    }
  }
  if (["python", "python3", "node", "perl", "ruby", "pwsh", "powershell"].includes(executable)) {
    const rendered = words.map((token) => word(token, cwd, environment) ?? "").join(" ");
    const destructive = /\b(?:rmtree|remove|unlink|rmdir|rename|remove-item)\b/iu.test(rendered);
    return destructive && protections.some(({ worktreePath }) => rendered.includes(worktreePath));
  }
  return false;
}

/**
 * Return a provider-facing refusal when a shell command targets a runner-owned worktree root.
 * Ordinary mutations beneath that root remain allowed; retirement of the root itself belongs to
 * the managed discard lifecycle. The parser is deliberately shared by every provider boundary.
 */
function commandTargetsManagedWorktreeUnsafe(
  command: string,
  cwd: string,
  protections: readonly ManagedWorktreeProtection[],
  depth = 0,
): string | null {
  let tokens: ShellToken[];
  try {
    tokens = parse<EnvironmentReference>(command, (env) => ({ env }));
  } catch {
    return null;
  }
  let segment: ShellToken[] = [];
  let currentCwd = normalize(cwd);
  const environment = new Map<string, string>();
  const evaluate = () => {
    if (!segment.length) return false;
    const localEnvironment = new Map(environment);
    const parsed = commandWords(segment, currentCwd, localEnvironment);
    if (parsed?.executable === "cd" || parsed?.executable === "pushd") {
      const target = resolvedOperand(parsed.words[0], currentCwd, localEnvironment);
      // Claude's Bash tool keeps its shell directory between calls. Refuse an escape from every
      // managed root so a later relative removal cannot be resolved against an unobservable cwd.
      if (target && withinProtectedRoot(currentCwd, protections) &&
          !withinProtectedRoot(target, protections)) return true;
      if (target) currentCwd = target;
      for (const [key, value] of localEnvironment) environment.set(key, value);
      return false;
    }
    const refused = segmentRefusal(segment, currentCwd, localEnvironment, protections, depth);
    for (const [key, value] of localEnvironment) environment.set(key, value);
    return refused;
  };
  for (const token of tokens) {
    if (operator(token)) {
      if (evaluate()) return MANAGED_WORKTREE_REFUSAL;
      segment = [];
    } else {
      segment.push(token);
    }
  }
  return evaluate() ? MANAGED_WORKTREE_REFUSAL : null;
}

export function commandTargetsManagedWorktree(
  command: string,
  cwd: string,
  protections: readonly ManagedWorktreeProtection[],
  depth = 0,
): string | null {
  if (!protections.length || !command || command.length > MAX_COMMAND_LENGTH || command.includes("\0")) return null;
  try {
    return commandTargetsManagedWorktreeUnsafe(command, cwd, protections, depth);
  } catch {
    // Provider-controlled syntax must never escape the guard or crash the runner. If a bounded
    // destructive target cannot be classified safely, retain the managed worktree.
    return MANAGED_WORKTREE_REFUSAL;
  }
}
