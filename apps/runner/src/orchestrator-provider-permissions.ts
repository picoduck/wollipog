import { parse, type ParseEntry } from "shell-quote";

const MAX_COMMAND_LENGTH = 16_384;
const MAX_LOOP_ITEMS = 100;
const LOOP_IDENTIFIER = /^[a-z][a-z0-9_]{0,31}$/u;
const ISSUE_OR_PR_NUMBER = /^[1-9][0-9]{0,15}$/u;
const INPUT_KEYS = new Set(["command", "description", "timeout"]);

interface EnvironmentReference {
  env: string;
}

type ShellToken = ParseEntry | EnvironmentReference;

function isEnvironmentReference(token: ShellToken | undefined): token is EnvironmentReference {
  return token != null && typeof token === "object" && "env" in token && typeof token.env === "string";
}

function isOperator(token: ShellToken | undefined, operator: string): boolean {
  return token != null && typeof token === "object" && "op" in token && token.op === operator;
}

function isPlainArgument(token: ShellToken | undefined): token is string {
  return typeof token === "string" && !token.includes("`");
}

function isReadOnlyGhInspection(tokens: ShellToken[], loopVariable: string): boolean {
  if (tokens.length < 4 || tokens[0] !== "gh") return false;
  const resource = tokens[1];
  const action = tokens[2];
  const supported = resource === "issue"
    ? action === "view"
    : resource === "pr" && (action === "view" || action === "checks" || action === "diff");
  if (!supported || !isEnvironmentReference(tokens[3]) || tokens[3].env !== loopVariable) return false;
  return tokens.slice(4).every(isPlainArgument);
}

function isSeparator(tokens: ShellToken[]): boolean {
  return tokens.length === 2 && tokens[0] === "echo" && tokens[1] === "----";
}

function isReadOnlyLoopBody(tokens: ShellToken[], loopVariable: string): boolean {
  let command: ShellToken[] = [];
  let inspected = 0;
  for (const token of tokens) {
    if (isOperator(token, ";")) {
      if (command.length === 0) return false;
      if (isReadOnlyGhInspection(command, loopVariable)) inspected += 1;
      else if (!isSeparator(command)) return false;
      command = [];
      continue;
    }
    if (typeof token === "object" && !isEnvironmentReference(token)) return false;
    command.push(token);
  }
  if (command.length > 0) {
    if (isReadOnlyGhInspection(command, loopVariable)) inspected += 1;
    else if (!isSeparator(command)) return false;
  }
  return inspected > 0;
}

/**
 * Claude's Bash permission matcher treats a shell loop as `Bash(for …)`, so the provider's
 * narrower `Bash(gh issue view:*)` rules cannot authorize it. This parser recognizes only the
 * routine batching shape used by issue orchestration and fails closed on every other shell form.
 */
export function isRoutineClaudeOrchestratorBash(command: string): boolean {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH || /[\r\n]/u.test(command)) return false;
  let tokens: ShellToken[];
  try {
    tokens = parse<EnvironmentReference>(command, (env) => ({ env }));
  } catch {
    return false;
  }

  if (tokens[0] !== "for" || !isPlainArgument(tokens[1]) || !LOOP_IDENTIFIER.test(tokens[1]) ||
      tokens[2] !== "in") return false;
  const loopVariable = tokens[1];
  const listEnd = tokens.findIndex((token, index) => index >= 3 && isOperator(token, ";"));
  if (listEnd < 4 || listEnd - 3 > MAX_LOOP_ITEMS) return false;
  if (!tokens.slice(3, listEnd).every((token) => isPlainArgument(token) && ISSUE_OR_PR_NUMBER.test(token))) {
    return false;
  }
  if (tokens[listEnd + 1] !== "do" || tokens.at(-1) !== "done" ||
      !isOperator(tokens.at(-2), ";")) return false;
  return isReadOnlyLoopBody(tokens.slice(listEnd + 2, -2), loopVariable);
}

/** Auto-approval is confined to provider-mode Orchestrator Bash asks with a bounded input shape. */
export function isRoutineClaudeOrchestratorPermission(toolName: unknown, input: unknown): boolean {
  if (toolName !== "Bash" || input == null || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  if (!Object.keys(record).every((key) => INPUT_KEYS.has(key)) || typeof record.command !== "string") return false;
  if (record.description !== undefined && typeof record.description !== "string") return false;
  if (record.timeout !== undefined &&
      (!Number.isSafeInteger(record.timeout) || (record.timeout as number) < 0 || (record.timeout as number) > 120_000)) {
    return false;
  }
  return isRoutineClaudeOrchestratorBash(record.command);
}
