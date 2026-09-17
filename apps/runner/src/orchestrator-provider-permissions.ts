import { parse, type ParseEntry } from "shell-quote";

const MAX_COMMAND_LENGTH = 16_384;
const MAX_LOOP_ITEMS = 100;
// Some shells expose lowercase special parameters: in zsh, assigning `path` also changes PATH.
// A fixed list prevents loop setup from changing command resolution before the audited `gh` call.
const LOOP_IDENTIFIERS = new Set(["n", "i", "id", "num", "issue", "pr"]);
const ISSUE_OR_PR_NUMBER = /^[1-9][0-9]{0,15}$/u;
const INPUT_KEYS = new Set(["command", "description", "timeout"]);
const COMPOSITION_OPERATORS = new Set([";", "&&", "||"]);
const READ_ONLY_GH_OPERATIONS = new Set([
  "issue:list", "issue:view", "issue:status",
  "pr:list", "pr:view", "pr:checks", "pr:diff", "pr:status",
  "run:list", "run:view", "run:watch", "repo:view", "search:issues", "search:prs",
]);
const READ_ONLY_GIT_COMMANDS = new Set([
  "status", "log", "show", "diff", "blame", "rev-parse", "merge-base", "range-diff",
  "ls-files", "grep", "cat-file", "name-rev", "describe", "show-ref", "for-each-ref",
  "shortlog", "diff-tree", "diff-index", "diff-files", "rev-list", "whatchanged",
]);
const GIT_ARGUMENT_DENYLIST = [
  "--ext-diff", "--textconv", "--output", "--exec", "--open-files-in-pager", "-O", "--filters",
];
const GIT_BRANCH_MUTATION_ARGUMENTS = new Set([
  "-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--edit-description",
  "--set-upstream-to", "--unset-upstream", "--create-reflog", "--force", "-f", "-u", "-t",
]);
const GIT_TAG_MUTATION_ARGUMENTS = new Set([
  "-d", "--delete", "-a", "--annotate", "-s", "--sign", "-u", "--local-user", "-f", "--force",
  "-m", "-F",
]);
const GH_ARGUMENT_DENYLIST = ["--web", "-w", "--repo", "-R", "--hostname"];

interface EnvironmentReference {
  env: string;
}

type ShellToken = ParseEntry | EnvironmentReference;

function isEnvironmentReference(token: ShellToken | undefined): token is EnvironmentReference {
  return token != null && typeof token === "object" && "env" in token && typeof token.env === "string";
}

function isOperator(token: ShellToken | undefined, operator?: string): token is ShellToken & { op: string } {
  return token != null && typeof token === "object" && "op" in token &&
    (operator === undefined || token.op === operator);
}

function isPlainArgument(token: ShellToken | undefined): token is string {
  return typeof token === "string" && !token.includes("`") && !token.includes("\0");
}

interface RoutineContext {
  allowedIssueNumbers: ReadonlySet<string>;
  loopVariable: string | null;
  loopIssueNumbers: readonly string[];
}

function isLoopReference(token: ShellToken | undefined, context: RoutineContext): boolean {
  return context.loopVariable !== null && isEnvironmentReference(token) && token.env === context.loopVariable;
}

function deniedArgument(argument: string, denylist: readonly string[]): boolean {
  const flag = argument.split("=", 1)[0]!;
  return denylist.some((denied) => flag === denied ||
    (denied.startsWith("--") && flag.startsWith("--") && flag.length > 2 && denied.startsWith(flag)) ||
    (denied.startsWith("-") && !denied.startsWith("--") && denied.length === 2 && flag.startsWith(denied)));
}

function containsShortOption(argument: string, options: ReadonlySet<string>): boolean {
  return argument.startsWith("-") && !argument.startsWith("--") &&
    [...argument.slice(1)].some((character) => options.has(`-${character}`));
}

function isReadOnlyGit(tokens: ShellToken[]): boolean {
  if (tokens.length < 2 || tokens[0] !== "git" || !tokens.every(isPlainArgument)) return false;
  const command = tokens[1] as string;
  const args = tokens.slice(2) as string[];
  if (args.some((arg) => deniedArgument(arg, GIT_ARGUMENT_DENYLIST))) return false;
  if (READ_ONLY_GIT_COMMANDS.has(command)) return true;
  if (command === "worktree") {
    return args[0] === "list" && args.slice(1).every((arg) => arg.startsWith("-"));
  }
  if (command === "branch") {
    return args.every((arg) => arg.startsWith("-") &&
      !deniedArgument(arg, [...GIT_BRANCH_MUTATION_ARGUMENTS]) &&
      !containsShortOption(arg, GIT_BRANCH_MUTATION_ARGUMENTS));
  }
  return command === "tag" && (args.length === 0 ||
    (args.some((arg) => arg === "--list" || arg === "-l") &&
      args.every((arg) => arg.startsWith("-") && !deniedArgument(arg, [...GIT_TAG_MUTATION_ARGUMENTS]) &&
        !containsShortOption(arg, GIT_TAG_MUTATION_ARGUMENTS))));
}

function splitFlag(token: string): { flag: string; inlineValue: string | null } {
  const equals = token.indexOf("=");
  return equals < 0
    ? { flag: token, inlineValue: null }
    : { flag: token.slice(0, equals), inlineValue: token.slice(equals + 1) };
}

function isScopedIssueTarget(token: ShellToken | undefined, context: RoutineContext): boolean {
  if (isPlainArgument(token) && ISSUE_OR_PR_NUMBER.test(token)) {
    return context.allowedIssueNumbers.has(token);
  }
  return isLoopReference(token, context) && context.loopIssueNumbers.length > 0 &&
    context.loopIssueNumbers.every((number) => context.allowedIssueNumbers.has(number));
}

function isRoutineIssueEdit(tokens: ShellToken[], context: RoutineContext): boolean {
  let targetCount = 0;
  let operationCount = 0;
  for (let index = 3; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (isScopedIssueTarget(token, context)) {
      targetCount += 1;
      continue;
    }
    if (!isPlainArgument(token)) return false;
    const { flag, inlineValue } = splitFlag(token);
    if (!["--add-assignee", "--remove-assignee", "--add-label", "--remove-label"].includes(flag)) return false;
    const value = inlineValue ?? tokens[++index];
    if (!isPlainArgument(value) || value.length === 0) return false;
    if ((flag === "--add-assignee" || flag === "--remove-assignee") && value !== "@me") return false;
    operationCount += 1;
  }
  return targetCount === 1 && operationCount > 0;
}

function isRoutineIssueComment(tokens: ShellToken[], context: RoutineContext): boolean {
  let targetCount = 0;
  let bodyCount = 0;
  for (let index = 3; index < tokens.length; index++) {
    const token = tokens[index];
    if (isScopedIssueTarget(token, context)) {
      targetCount += 1;
      continue;
    }
    if (!isPlainArgument(token)) return false;
    const { flag, inlineValue } = splitFlag(token);
    if (flag !== "--body") return false;
    const value = inlineValue ?? tokens[++index];
    if (!isPlainArgument(value) || value.length === 0) return false;
    bodyCount += 1;
  }
  return targetCount === 1 && bodyCount === 1;
}

function isRoutineGh(tokens: ShellToken[], context: RoutineContext): boolean {
  if (tokens.length < 3 || tokens[0] !== "gh" || !isPlainArgument(tokens[1]) ||
      !isPlainArgument(tokens[2])) return false;
  const operation = `${tokens[1]}:${tokens[2]}`;
  if (operation === "issue:edit") return isRoutineIssueEdit(tokens, context);
  if (operation === "issue:comment") return isRoutineIssueComment(tokens, context);
  if (!READ_ONLY_GH_OPERATIONS.has(operation)) return false;
  return tokens.slice(3).every((token) => isPlainArgument(token) || isLoopReference(token, context)) &&
    !tokens.slice(3).some((token) => isPlainArgument(token) &&
      (deniedArgument(token, GH_ARGUMENT_DENYLIST) ||
        (token.startsWith("-") && !token.startsWith("--") && token.length > 2)));
}

function isRoutineLeaf(tokens: ShellToken[], context: RoutineContext): boolean {
  if (isReadOnlyGit(tokens) || isRoutineGh(tokens, context)) return true;
  return tokens.length > 0 && tokens[0] === "echo" &&
    tokens.slice(1).every((token) => isPlainArgument(token) || isLoopReference(token, context));
}

/** Every shell leaf must independently satisfy the routine-operation contract. The only permitted
 * redirection discards stdout; file writes, pipes, substitutions, backgrounding, and grouping fail
 * closed before any leaf is considered. */
function isRoutineSequence(tokens: ShellToken[], context: RoutineContext): boolean {
  let command: ShellToken[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (isOperator(token, ">")) {
      if (command.length === 0 || tokens[index + 1] !== "/dev/null") return false;
      index += 1;
      continue;
    }
    if (isOperator(token) && COMPOSITION_OPERATORS.has(token.op)) {
      if (command.length === 0 || !isRoutineLeaf(command, context)) return false;
      command = [];
      if (index === tokens.length - 1) return token.op === ";";
      continue;
    }
    if (token == null || (typeof token === "object" && !isEnvironmentReference(token))) return false;
    command.push(token);
  }
  return command.length > 0 && isRoutineLeaf(command, context);
}

/** Classify a Bash request by operation rather than a finite set of command strings. Issue writes
 * must target the authenticated human's explicit campaign scope; reads remain repository-local. */
export function isRoutineClaudeOrchestratorBash(
  command: string,
  allowedIssueNumbers: readonly number[] = [],
): boolean {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH || /[\r\n]/u.test(command) ||
      /(?:^|[\s;&|])[0-9]+(?:>|>>|>&)/u.test(command)) return false;
  let tokens: ShellToken[];
  try {
    tokens = parse<EnvironmentReference>(command, (env) => ({ env }));
  } catch {
    return false;
  }

  const allowed = new Set(allowedIssueNumbers.filter((number) => Number.isSafeInteger(number) && number > 0).map(String));
  const directContext: RoutineContext = { allowedIssueNumbers: allowed, loopVariable: null, loopIssueNumbers: [] };
  if (tokens[0] !== "for") return isRoutineSequence(tokens, directContext);
  if (!isPlainArgument(tokens[1]) || !LOOP_IDENTIFIERS.has(tokens[1]) || tokens[2] !== "in") return false;
  const loopVariable = tokens[1];
  const listEnd = tokens.findIndex((token, index) => index >= 3 && isOperator(token, ";"));
  if (listEnd < 4 || listEnd - 3 > MAX_LOOP_ITEMS) return false;
  const loopIssueNumbers = tokens.slice(3, listEnd);
  if (!loopIssueNumbers.every((token) => isPlainArgument(token) && ISSUE_OR_PR_NUMBER.test(token))) return false;
  if (tokens[listEnd + 1] !== "do" || tokens.at(-1) !== "done" ||
      !isOperator(tokens.at(-2), ";")) return false;
  return isRoutineSequence(tokens.slice(listEnd + 2, -2), {
    allowedIssueNumbers: allowed,
    loopVariable,
    loopIssueNumbers: loopIssueNumbers as string[],
  });
}

/** Auto-approval is confined to Orchestrator Bash asks with a bounded input and issue scope. */
export function isRoutineClaudeOrchestratorPermission(
  toolName: unknown,
  input: unknown,
  allowedIssueNumbers: readonly number[] = [],
): boolean {
  if (toolName !== "Bash" || input == null || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  if (!Object.keys(record).every((key) => INPUT_KEYS.has(key)) || typeof record.command !== "string") return false;
  if (record.description !== undefined && typeof record.description !== "string") return false;
  if (record.timeout !== undefined &&
      (!Number.isSafeInteger(record.timeout) || (record.timeout as number) < 0 || (record.timeout as number) > 120_000)) {
    return false;
  }
  return isRoutineClaudeOrchestratorBash(record.command, allowedIssueNumbers);
}
