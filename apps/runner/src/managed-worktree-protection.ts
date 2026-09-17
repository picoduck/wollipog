import { isAbsolute, normalize, resolve, sep } from "node:path";
import { parse, type ParseEntry } from "shell-quote";

const MAX_COMMAND_LENGTH = 32_768;
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
  return token != null && typeof token === "object" && "op" in token && typeof token.op === "string"
    ? token.op
    : null;
}

function pathContains(parent: string, child: string): boolean {
  const normalizedParent = normalize(parent);
  const normalizedChild = normalize(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

function protectedTarget(path: string, protections: readonly ManagedWorktreeProtection[]): boolean {
  return protections.some(({ worktreePath }) => pathContains(path, worktreePath));
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
  if (!environmentReference(token)) return null;
  if (token.env === "PWD" || token.env === "CWD") return cwd;
  return environment.get(token.env) ?? null;
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
  if (!executable) return null;
  if (executableName(executable) === "command" || executableName(executable) === "sudo") {
    index += 1;
    while (typeof tokens[index] === "string" && (tokens[index] as string).startsWith("-")) index += 1;
    executable = word(tokens[index], cwd, environment);
  } else if (executableName(executable) === "env") {
    index += 1;
    while (typeof tokens[index] === "string") {
      const value = tokens[index] as string;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) {
        const equals = value.indexOf("=");
        environment.set(value.slice(0, equals), value.slice(equals + 1));
        index += 1;
        continue;
      }
      if (value.startsWith("-")) { index += 1; continue; }
      break;
    }
    executable = word(tokens[index], cwd, environment);
  }
  if (!executable) return null;
  return { words: tokens.slice(index + 1), executable: executableName(executable) };
}

function filesystemRemovalTargets(
  words: ShellToken[],
  cwd: string,
  environment: ReadonlyMap<string, string>,
): Array<string | null> {
  const targets: Array<string | null> = [];
  let options = true;
  for (const token of words) {
    const value = word(token, cwd, environment);
    if (options && value === "--") { options = false; continue; }
    if (options && value?.startsWith("-")) continue;
    targets.push(resolvedOperand(token, cwd, environment));
  }
  return targets;
}

function gitWorktreeRefusal(
  words: ShellToken[],
  initialCwd: string,
  environment: ReadonlyMap<string, string>,
  protections: readonly ManagedWorktreeProtection[],
): boolean {
  let cwd = initialCwd;
  let index = 0;
  while (index < words.length) {
    const value = word(words[index], cwd, environment);
    if (value === "-C") {
      const next = resolvedOperand(words[index + 1], cwd, environment);
      if (!next) return false;
      cwd = next;
      index += 2;
      continue;
    }
    if (value?.startsWith("-")) { index += 1; continue; }
    break;
  }
  if (word(words[index], cwd, environment) !== "worktree") return false;
  const action = word(words[index + 1], cwd, environment);
  const operands = words.slice(index + 2).filter((token) => {
    const value = word(token, cwd, environment);
    return value !== "--" && !value?.startsWith("-");
  });
  if (action === "prune") return protectionRepository(cwd, protections);
  if (action !== "remove" && action !== "move") return false;
  const target = resolvedOperand(operands[0], cwd, environment);
  return target != null && protectedTarget(target, protections);
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
    const flag = words.findIndex((token) => ["-c", "/c"].includes(word(token, cwd, environment)?.toLowerCase() ?? ""));
    const script = flag >= 0 ? word(words[flag + 1], cwd, environment) : null;
    return script ? commandTargetsManagedWorktree(script, cwd, protections, depth + 1) != null : false;
  }
  if (executable === "git") return gitWorktreeRefusal(words, cwd, environment, protections);
  if (["rm", "rmdir", "unlink", "trash", "trash-put", "remove-item", "del", "rd"].includes(executable)) {
    return filesystemRemovalTargets(words, cwd, environment)
      .some((target) => target != null && protectedTarget(target, protections));
  }
  if (executable === "gio" && word(words[0], cwd, environment) === "trash") {
    return filesystemRemovalTargets(words.slice(1), cwd, environment)
      .some((target) => target != null && protectedTarget(target, protections));
  }
  if (["mv", "move", "rename-item"].includes(executable)) {
    const source = filesystemRemovalTargets(words, cwd, environment)[0];
    return source != null && protectedTarget(source, protections);
  }
  if (executable === "find" && words.some((token) => word(token, cwd, environment) === "-delete")) {
    const roots = words.slice(0, words.findIndex((token) => word(token, cwd, environment)?.startsWith("-") === true));
    return roots.some((token) => {
      const target = resolvedOperand(token, cwd, environment);
      return target != null && protectedTarget(target, protections);
    });
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
export function commandTargetsManagedWorktree(
  command: string,
  cwd: string,
  protections: readonly ManagedWorktreeProtection[],
  depth = 0,
): string | null {
  if (!protections.length || !command || command.length > MAX_COMMAND_LENGTH || command.includes("\0")) return null;
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
    if (parsed?.executable === "cd") {
      const target = resolvedOperand(parsed.words[0], currentCwd, localEnvironment);
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

