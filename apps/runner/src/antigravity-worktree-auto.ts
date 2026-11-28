import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "shell-quote";
import type { ApprovalContext } from "@wollipog/protocol";
import { antigravityToolOperation, antigravityToolRecord } from "./antigravity-tool-operation.js";

export const ANTIGRAVITY_WORKTREE_AUTO_NOTICE =
  "Google Antigravity’s terminal sandbox could not start inside this managed worktree. " +
  "Wollipog’s Auto Mode approves routine file operations and local Git commands inside this worktree. " +
  "Other requests, including remote Git operations and compound shell commands, still need approval.";

/** Only a single invocation with literal words. Quoting supports paths with spaces, search
 * patterns, and commit messages. Expansions, shell operators, and escapes stay interactive. */
const WORD = "[A-Za-z0-9_./:=+%@,^-]+|'[^'\\\\`$!\\x00-\\x1f]*'|\"[^\"\\\\`$!\\x00-\\x1f]*\"";
const SINGLE_COMMAND = new RegExp(`^(?:${WORD})(?:[ \\t]+(?:${WORD}))*$`, "u");
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9_./^@-]*$/u;

function withinWorktree(root: string, cwd: string, value: unknown, allowMissing = false): boolean {
  if (typeof value !== "string" || !value || value.length > 4096 || /[:*?\[\]\\\x00-\x1f]/u.test(value) ||
      value.split("/").includes("..")) return false;
  const path = resolve(cwd, value);
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).includes(".git")) return false;
  try {
    // For new files, resolve the nearest existing ancestor. lstat distinguishes a missing
    // component from a dangling symlink, which cannot prove confinement.
    for (let current = path; ; current = dirname(current)) {
      const entry = lstatSync(current, { throwIfNoEntry: false });
      if (entry) return !entry.isSymbolicLink() && (current === path || entry.isDirectory()) &&
        realpathSync.native(current) === current;
      if (!allowMissing || current === root) return false;
    }
  } catch {
    return false;
  }
}

type OperandRule = (args: string[], flags?: string[]) => boolean;
interface CommandScope {
  paths: OperandRule;
  gitPaths: OperandRule;
}
type CommandRule = (args: string[], scope: CommandScope) => boolean;

function flagsOnly(args: string[], ...flags: string[]): boolean {
  return args.every((arg) => flags.includes(arg));
}

function revisions(args: string[], ...flags: string[]): boolean {
  return args.every((arg) => flags.includes(arg) ||
    (REVISION.test(arg) && !arg.includes("..") && !arg.split("/").includes(".git")));
}

/** Ordinary Git hooks and filters may run. Git and its children stay in the existing runner
 * boundary with the same mounts and network policy. Match exact option spellings so config
 * overrides, external tools, and remote operations stay interactive. */
const COMMANDS = new Map<string, CommandRule>([
  ["pwd", (args) => args.length === 0],
  ["ls", (args, { paths }) => paths(args, ["-a", "-l", "-al", "-la", "-lh", "-lah"])],
  ["cat", (args, { paths }) => args.length > 0 && paths(args)],
  ["rg", (args, { paths }) => search(args, paths, ["-n", "-i", "-F", "-l", "--line-number", "--fixed-strings", "--files"])],
  ["grep", (args, { paths }) => search(args, paths, ["-n", "-i", "-F", "-l", "-r"])],
  ["git status", (args) => flagsOnly(args, "-s", "-b", "-sb", "--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2")],
  ["git diff", (args, { gitPaths }) => gitPaths(args, ["--cached", "--staged", "--stat", "--name-only", "--name-status", "--no-ext-diff", "--no-textconv", "--check"])],
  ["git log", (args) => revisions(args, "--oneline", "--stat", "--no-decorate") ||
    (/^-[1-9][0-9]{0,3}$/u.test(args[0] ?? "") && revisions(args.slice(1), "--oneline", "--stat"))],
  ["git show", (args) => revisions(args, "--oneline", "--stat", "--name-only", "--no-ext-diff", "--no-textconv")],
  ["git branch", (args) => flagsOnly(args, "--list", "--show-current", "-l")],
  ["git rev-parse", (args) => args.length > 0 && revisions(args, "--show-toplevel", "--abbrev-ref", "--verify", "--short", "--is-inside-work-tree")],
  ["git ls-files", (args, { gitPaths }) => gitPaths(args, ["--cached", "--modified", "--others", "--exclude-standard", "--stage"])],
  ["git add", (args, { gitPaths }) => args.length > 0 && gitPaths(args, ["-A", "--all", "-u", "--update"])],
  ["git commit", (args) => args.length === 2 && (args[0] === "-m" || args[0] === "--message") && !!args[1]],
  ["git restore", (args, { gitPaths }) => gitPaths(args, ["--staged", "--worktree", "-S", "-W"])],
  // Linked worktrees share the stash and branch refs. Stash writes and switching the active
  // branch need approval. Checkout is eligible only for explicit paths in this worktree.
  ["git stash", (args) => args.length === 1 && args[0] === "list"],
  ["git checkout", (args, { gitPaths }) => args[0] === "--" && args.length > 1 && gitPaths(args)],
  ["git reset", (args, { gitPaths }) => args.length === 0 || (
    (args[0] === "--" || (args[0] === "--mixed" && args[1] === "--")) && gitPaths(args, ["--mixed"])
  )],
  ["git rm", (args, { gitPaths }) => gitPaths(args, ["--cached", "-r"])],
  ["git mv", (args, { gitPaths }) => args.length === 2 && !args.includes("--") && gitPaths(args)],
]);

function search(args: string[], paths: OperandRule, flags: string[]): boolean {
  const positional = args.findIndex((arg) => !flags.includes(arg));
  const hasPattern = !args.slice(0, positional < 0 ? args.length : positional).includes("--files");
  if (positional === -1) return !hasPattern;
  const delimiter = args[positional] === "--";
  const rest = args.slice(positional + (delimiter ? 1 : 0));
  if (hasPattern && (!rest[0] || (!delimiter && rest[0].startsWith("-")))) return false;
  const operands = hasPattern ? rest.slice(1) : rest;
  return paths(delimiter ? ["--", ...operands] : operands);
}

function pathOperands(args: string[], flags: string[], valid: (path: string) => boolean): boolean {
  let delimiter = false;
  let positional = false;
  for (const arg of args) {
    if (!delimiter && arg === "--") {
      delimiter = true;
      continue;
    }
    if (!delimiter && arg.startsWith("-")) {
      if (positional || !flags.includes(arg)) return false;
      continue;
    }
    positional = true;
    if (!valid(arg)) return false;
  }
  return true;
}

function commandAllowed(root: string, { input: command, cwd = root }: Extract<ApprovalContext["operation"], { kind: "command" }>): boolean {
  if (typeof cwd !== "string" || !isAbsolute(cwd) || !withinWorktree(root, root, cwd) ||
      typeof command !== "string" || command.length > 8192 || /[\x00-\x08\x0a-\x1f]/u.test(command)) return false;
  const source = command.replace(/^[ \t]+|(?<=[^ \t])[ \t]+$/gu, "");
  if (!SINGLE_COMMAND.test(source)) return false;
  const words = parse(source);
  if (!words.every((word): word is string => typeof word === "string")) return false;
  const [binary, ...args] = words;
  if (binary === "git" && (resolve(cwd) !== root || !args.length)) return false;
  const rule = binary === "git" ? COMMANDS.get(`git ${args.shift()}`) : COMMANDS.get(binary ?? "");
  return rule?.(args, {
    paths: (operands, flags = []) => pathOperands(operands, flags, (path) => withinWorktree(root, cwd, path)),
    gitPaths: (operands, flags = []) => pathOperands(operands, flags, (path) => withinWorktree(root, root, path, true)),
  }) ?? false;
}

/** Use agy's provider-specific tool name and input. The display title cannot grant authority. */
export function antigravityWorktreeAutoAllows(root: string, tool: unknown): boolean {
  if (!antigravityToolRecord(tool)) return false;
  const operation = antigravityToolOperation(tool);
  if (operation?.kind === "command") return commandAllowed(root, operation);
  const edit = tool.kind === "edit";
  if (operation?.kind !== "file" || !withinWorktree(root, root, operation.path, edit)) return false;
  return tool.locations == null || (Array.isArray(tool.locations) &&
    tool.locations.every((location) => antigravityToolRecord(location) && withinWorktree(root, root, location.path, edit)));
}
