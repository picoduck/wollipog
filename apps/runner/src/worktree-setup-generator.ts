import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentContext } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";
import {
  parseWorktreeSetupConfig,
  WORKTREE_SETUP_CONFIG,
  type WorktreeSetupConfig,
  type WorktreeSetupConfigStatus,
  worktreeSetupSourceHash,
} from "./worktree-setup.js";

const MAX_CONFIG_BYTES = 256 * 1024;

const REPOSITORY_SIGNALS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
] as const;

const COPY_CANDIDATES = [
  ".env",
  ".env.local",
  ".env.development.local",
  ".env.test.local",
  "runner.config.json",
] as const;

export interface WorktreeSetupRepositoryObservation {
  files: string[];
  ignoredCopyCandidates: string[];
}

export interface GeneratedWorktreeSetupConfig {
  config: WorktreeSetupConfig;
  source: string;
  detected: string[];
}

export interface WrittenWorktreeSetupConfig extends GeneratedWorktreeSetupConfig {
  path: typeof WORKTREE_SETUP_CONFIG;
  status: Extract<WorktreeSetupConfigStatus, { status: "valid" }>;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

/** Read only bounded file NAMES through Git. Detected tools are never invoked. */
export async function observeWorktreeSetupRepository(
  context: AgentContext,
  repository: string,
  copySourceRepository = repository,
): Promise<WorktreeSetupRepositoryObservation> {
  const tracked = await runContextCommand(context, "git", [
    "ls-files", "--cached", "--others", "--exclude-standard", "--", ...REPOSITORY_SIGNALS,
  ], { cwd: repository, timeoutMs: 30_000, maxBuffer: 32 * 1024 });
  const ignored = await runContextCommand(context, "git", [
    "ls-files", "--others", "--ignored", "--exclude-standard", "--", ...COPY_CANDIDATES,
  ], { cwd: copySourceRepository, timeoutMs: 30_000, maxBuffer: 32 * 1024 });
  return {
    files: [...new Set(lines(tracked.stdout))].sort(),
    ignoredCopyCandidates: [...new Set(lines(ignored.stdout))].sort(),
  };
}

function setupSteps(files: ReadonlySet<string>): { steps: WorktreeSetupConfig["setup"]; detected: string[] } {
  const steps: WorktreeSetupConfig["setup"] = [];
  const detected: string[] = [];
  if (files.has("pnpm-lock.yaml")) {
    steps.push({ name: "Install Node Dependencies", command: ["pnpm", "install", "--frozen-lockfile"], timeoutSeconds: 600, optional: false });
    detected.push("pnpm-lock.yaml");
  } else if (files.has("package-lock.json") || files.has("npm-shrinkwrap.json")) {
    steps.push({ name: "Install Node Dependencies", command: ["npm", "ci"], timeoutSeconds: 600, optional: false });
    detected.push(files.has("package-lock.json") ? "package-lock.json" : "npm-shrinkwrap.json");
  } else if (files.has("yarn.lock")) {
    steps.push({ name: "Install Node Dependencies", command: ["yarn", "install", "--immutable"], timeoutSeconds: 600, optional: false });
    detected.push("yarn.lock");
  } else if (files.has("bun.lock") || files.has("bun.lockb")) {
    steps.push({ name: "Install Node Dependencies", command: ["bun", "install", "--frozen-lockfile"], timeoutSeconds: 600, optional: false });
    detected.push(files.has("bun.lock") ? "bun.lock" : "bun.lockb");
  }
  if (files.has("uv.lock")) {
    steps.push({ name: "Sync Python Dependencies", command: ["uv", "sync", "--frozen"], timeoutSeconds: 600, optional: false });
    detected.push("uv.lock");
  }
  if (files.has("Cargo.lock")) {
    steps.push({ name: "Fetch Rust Dependencies", command: ["cargo", "fetch", "--locked"], timeoutSeconds: 600, optional: false });
    detected.push("Cargo.lock");
  }
  if (files.has("go.sum")) {
    steps.push({ name: "Download Go Modules", command: ["go", "mod", "download"], timeoutSeconds: 600, optional: false });
    detected.push("go.sum");
  }
  if (files.has("Gemfile.lock")) {
    steps.push({ name: "Install Ruby Dependencies", command: ["bundle", "install"], timeoutSeconds: 600, optional: false });
    detected.push("Gemfile.lock");
  }
  return { steps, detected };
}

/** Deterministic detector and serializer. It has no process or filesystem access. */
export function generateWorktreeSetupConfig(
  observation: WorktreeSetupRepositoryObservation,
): GeneratedWorktreeSetupConfig {
  const files = new Set(observation.files);
  const { steps, detected } = setupSteps(files);
  const copyFiles = [...new Set(observation.ignoredCopyCandidates)]
    .filter((candidate): candidate is typeof COPY_CANDIDATES[number] => COPY_CANDIDATES.includes(candidate as typeof COPY_CANDIDATES[number]))
    .sort()
    .map((candidate) => ({ source: candidate, destination: candidate }));
  const config: WorktreeSetupConfig = { version: 1, copyFiles, environment: {}, setup: steps, teardown: [] };
  const source = `${JSON.stringify(config, null, 2)}\n`;
  // The generator is downstream of the production parser, never a second schema implementation.
  parseWorktreeSetupConfig(source);
  return { config, source, detected: [...detected, ...copyFiles.map((copy) => copy.source)] };
}

async function readCheckoutConfig(context: AgentContext, repository: string): Promise<string | null> {
  const target = join(repository, WORKTREE_SETUP_CONFIG);
  if (context.kind === "wsl") {
    const script = "if [ -L \"$1\" ]; then printf 'unsafe\\n'; exit 0; fi; " +
      "if [ ! -e \"$1\" ]; then printf 'absent\\n'; exit 0; fi; " +
      "if [ ! -f \"$1\" ]; then printf 'unsafe\\n'; exit 0; fi; printf 'file\\n'; exec cat -- \"$1\"";
    const result = await runContextCommand(context, "sh", ["-c", script, "wollipog-read-config", target], {
      cwd: repository, timeoutMs: 30_000, maxBuffer: MAX_CONFIG_BYTES + 32,
    });
    const newline = result.stdout.indexOf("\n");
    const kind = newline < 0 ? result.stdout.trim() : result.stdout.slice(0, newline).trim();
    if (kind === "absent") return null;
    if (kind === "unsafe") throw new Error(`${WORKTREE_SETUP_CONFIG} must be a regular file, not a symbolic link or directory`);
    if (kind !== "file") throw new Error(`${WORKTREE_SETUP_CONFIG} could not be read safely`);
    return result.stdout.slice(newline + 1);
  }
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`${WORKTREE_SETUP_CONFIG} must be a regular file, not a symbolic link or directory`);
    }
    if (entry.size > MAX_CONFIG_BYTES) throw new Error(`${WORKTREE_SETUP_CONFIG} is too large`);
    return await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function inspectCheckoutWorktreeSetupConfig(
  context: AgentContext,
  repository: string,
): Promise<WorktreeSetupConfigStatus> {
  try {
    const source = await readCheckoutConfig(context, repository);
    if (source === null) return { status: "absent" };
    parseWorktreeSetupConfig(source);
    return { status: "valid", hash: worktreeSetupSourceHash(source) };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

async function writeExclusiveConfig(context: AgentContext, repository: string, source: string): Promise<void> {
  const target = join(repository, WORKTREE_SETUP_CONFIG);
  if (context.kind === "wsl") {
    const script = "if [ -e \"$1\" ] || [ -L \"$1\" ]; then exit 75; fi; " +
      "set -C; umask 022; exec 3> \"$1\" || exit 75; " +
      "cat >&3 || { exec 3>&-; rm -f -- \"$1\"; exit 76; }";
    try {
      await runContextCommand(context, "sh", ["-c", script, "wollipog-write-config", target], {
        cwd: repository, stdin: source, timeoutMs: 30_000, maxBuffer: 4_096,
      });
    } catch (error) {
      const exitCode = (error as { cause?: { code?: unknown } }).cause?.code;
      if (exitCode === 75 || exitCode === "75") {
        throw new Error(`${WORKTREE_SETUP_CONFIG} already exists; it was not changed`);
      }
      throw error;
    }
    return;
  }
  try {
    await writeFile(target, source, { encoding: "utf8", flag: "wx", mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${WORKTREE_SETUP_CONFIG} already exists; it was not changed`);
    }
    throw error;
  }
}

export async function resolveWorktreeSetupRepositoryRoot(
  context: AgentContext,
  directory: string,
): Promise<string> {
  try {
    const result = await runContextCommand(context, "git", ["rev-parse", "--show-toplevel"], {
      cwd: directory, timeoutMs: 30_000, maxBuffer: 16 * 1024,
    });
    const root = result.stdout.trim();
    if (!root) throw new Error("Git returned an empty repository root");
    return context.kind === "wsl" ? root : resolve(root);
  } catch (error) {
    throw new Error(`not a Git repository: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Generate exactly one root config. This does not stage, commit, trust, or execute anything. */
export async function writeStarterWorktreeSetupConfig(
  context: AgentContext,
  repository: string,
  copySourceRepository = repository,
): Promise<WrittenWorktreeSetupConfig> {
  const observation = await observeWorktreeSetupRepository(context, repository, copySourceRepository);
  const generated = generateWorktreeSetupConfig(observation);
  await writeExclusiveConfig(context, repository, generated.source);
  return {
    ...generated,
    path: WORKTREE_SETUP_CONFIG,
    status: { status: "valid", hash: worktreeSetupSourceHash(generated.source) },
  };
}
