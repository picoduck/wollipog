import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentContext, WorktreeSetupState } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";
import { killTree, spawnAgent, type SpawnIsolation } from "./spawn.js";

export const WORKTREE_SETUP_CONFIG = ".wollipog.json";
export const WORKTREE_SETUP_VERSION = 1;

export interface WorktreeSetupCopy {
  source: string;
  destination: string;
}

export interface WorktreeSetupStep {
  name: string;
  command: [string, ...string[]];
  timeoutSeconds: number;
  optional: boolean;
}

export interface WorktreeSetupConfig {
  version: 1;
  copyFiles: WorktreeSetupCopy[];
  environment: Record<string, string>;
  setup: WorktreeSetupStep[];
}

export interface WorktreeSetupVariables {
  WOLLIPOG_WORKTREE_PATH: string;
  WOLLIPOG_WORKTREE_BRANCH: string;
  WOLLIPOG_WORKTREE_BASE_REF: string;
  WOLLIPOG_PRIMARY_CHECKOUT: string;
}

export interface WorktreeSetupRunOptions {
  context: AgentContext;
  primaryCheckout: string;
  worktreePath: string;
  branch: string;
  baseRef?: string;
  config: WorktreeSetupConfig;
  /** Exact hash of the repository-owned config bytes. Falls back to the normalized config hash in
   * direct callers and tests that do not load the config from git. */
  configHash?: string;
  /** Isolation-adjusted values supplied by the manager (for example `/workspace` in containers). */
  environment?: Record<string, string>;
  prior?: WorktreeSetupState;
  onState?: (state: WorktreeSetupState) => void;
  onOutput?: (stepIndex: number, text: string) => void;
  isolation?: SpawnIsolation;
  signal?: AbortSignal;
  /** Resolve a launch boundary only after local copies finish. Cloud preparation snapshots the
   * worktree, so resolving it earlier would omit copied files from setup and the later agent. */
  prepareExecution?: () => Promise<{ environment: Record<string, string>; isolation?: SpawnIsolation }>;
}

function setupCancelled(): Error {
  return Object.assign(new Error("worktree setup was cancelled"), { name: "AbortError" });
}

function throwIfSetupCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw setupCancelled();
}

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_COPIES = 128;
const MAX_ENVIRONMENT = 128;
const MAX_STEPS = 64;
const MAX_ARGS = 128;
const MAX_STRING = 4_096;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 3_600;
const MAX_TRUST_PROJECTION_BYTES = 10 * 1024;
const MAX_COPY_FILE_BYTES = 64 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/gu;
const RESERVED_ENV = /^WOLLIPOG_/iu;
const WORKTREE_SETUP_VARIABLES = new Set([
  "WOLLIPOG_WORKTREE_PATH",
  "WOLLIPOG_WORKTREE_BRANCH",
  "WOLLIPOG_WORKTREE_BASE_REF",
  "WOLLIPOG_PRIMARY_CHECKOUT",
]);
// Repository setup values are deliberately omitted from durable trust events. Prevent unseen
// values from redirecting provider authentication, executable loading, or runner-owned state.
const RESERVED_PROCESS_ENV = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION", "OPENAI_ORG_ID", "OPENAI_PROJECT",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GITHUB_TOKEN", "GH_TOKEN",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "TMPDIR", "TMP", "TEMP", "PATH", "PATHEXT", "NODE_OPTIONS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
]);

interface WorktreeSetupTrustFile {
  version: 1;
  approvals: Array<{ projectDigest: string; configHash: string; approvedAt: number }>;
}

/** Content-free, box-local trust ledger. Project paths are keyed by digest and config values never
 * enter the file; changing any command, copy, or environment value changes the config hash. */
export class WorktreeSetupTrustStore {
  private readonly path: string;
  private readonly approvals = new Map<string, { projectDigest: string; configHash: string; approvedAt: number }>();
  private loaded = false;
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly stateDir: string) {
    this.path = join(stateDir, "worktree-setup-trust.json");
  }

  private projectDigest(projectPath: string): string {
    return createHash("sha256").update(resolve(projectPath)).digest("hex");
  }

  private key(projectPath: string, configHash: string): string {
    return `${this.projectDigest(projectPath)}:${configHash}`;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<WorktreeSetupTrustFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.approvals)) return;
      for (const approval of parsed.approvals) {
        if (approval && typeof approval.projectDigest === "string" && typeof approval.configHash === "string" &&
            typeof approval.approvedAt === "number") {
          this.approvals.set(`${approval.projectDigest}:${approval.configHash}`, approval);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async isApproved(projectPath: string, configHash: string): Promise<boolean> {
    await this.load();
    return this.approvals.has(this.key(projectPath, configHash));
  }

  async approve(projectPath: string, configHash: string): Promise<void> {
    const write = this.mutation.then(async () => {
      await this.load();
      const projectDigest = this.projectDigest(projectPath);
      this.approvals.set(`${projectDigest}:${configHash}`, { projectDigest, configHash, approvedAt: Date.now() });
      await mkdir(this.stateDir, { recursive: true });
      const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      const body: WorktreeSetupTrustFile = { version: 1, approvals: [...this.approvals.values()] };
      await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.path);
    });
    this.mutation = write.catch(() => {});
    await write;
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${path}.${unexpected} is not supported`);
}

function boundedString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`${path} must be a non-empty string`);
  if (value.length > MAX_STRING) throw new Error(`${path} must be ${MAX_STRING} characters or fewer`);
  if (value.includes("\0")) throw new Error(`${path} must not contain NUL`);
  return value;
}

function relativePath(value: unknown, path: string): string {
  const result = boundedString(value, path);
  if (isAbsolute(result) || result.split(/[\\/]/u).some((part) => part === ".." || part === "")) {
    throw new Error(`${path} must be a normalized relative path`);
  }
  return result;
}

/** Strict, deterministic parser for the repository-owned v1 contract. */
export function parseWorktreeSetupConfig(source: string): WorktreeSetupConfig {
  if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) throw new Error(`${WORKTREE_SETUP_CONFIG} is too large`);
  let raw: unknown;
  try { raw = JSON.parse(source); } catch (error) {
    throw new Error(`${WORKTREE_SETUP_CONFIG} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = record(raw, WORKTREE_SETUP_CONFIG);
  onlyKeys(root, ["version", "copyFiles", "environment", "setup"], WORKTREE_SETUP_CONFIG);
  if (root.version !== WORKTREE_SETUP_VERSION) throw new Error(`${WORKTREE_SETUP_CONFIG}.version must be 1`);

  const copiesRaw = root.copyFiles ?? [];
  if (!Array.isArray(copiesRaw) || copiesRaw.length > MAX_COPIES) {
    throw new Error(`${WORKTREE_SETUP_CONFIG}.copyFiles must contain at most ${MAX_COPIES} entries`);
  }
  const copyFiles = copiesRaw.map((item, index) => {
    const path = `${WORKTREE_SETUP_CONFIG}.copyFiles[${index}]`;
    const entry = record(item, path);
    onlyKeys(entry, ["source", "destination"], path);
    return { source: relativePath(entry.source, `${path}.source`), destination: relativePath(entry.destination, `${path}.destination`) };
  });
  const copyDestinations = new Set<string>();
  for (const copy of copyFiles) {
    const destination = copy.destination.replaceAll("\\", "/").toLowerCase();
    if (copyDestinations.has(destination)) throw new Error(`${WORKTREE_SETUP_CONFIG}.copyFiles contains a duplicate destination`);
    copyDestinations.add(destination);
  }

  const environmentRaw = root.environment ?? {};
  const environmentRecord = record(environmentRaw, `${WORKTREE_SETUP_CONFIG}.environment`);
  if (Object.keys(environmentRecord).length > MAX_ENVIRONMENT) {
    throw new Error(`${WORKTREE_SETUP_CONFIG}.environment must contain at most ${MAX_ENVIRONMENT} entries`);
  }
  const environment: Record<string, string> = {};
  const environmentNames = new Set<string>();
  for (const key of Object.keys(environmentRecord).sort()) {
    if (!ENV_NAME.test(key)) throw new Error(`${WORKTREE_SETUP_CONFIG}.environment key ${JSON.stringify(key)} is invalid`);
    if (RESERVED_ENV.test(key) || RESERVED_PROCESS_ENV.has(key.toUpperCase())) {
      throw new Error(`${WORKTREE_SETUP_CONFIG}.environment.${key} is reserved by Wollipog`);
    }
    if (environmentNames.has(key.toLowerCase())) throw new Error(`${WORKTREE_SETUP_CONFIG}.environment contains a case-insensitive duplicate key`);
    environmentNames.add(key.toLowerCase());
    const value = boundedString(environmentRecord[key], `${WORKTREE_SETUP_CONFIG}.environment.${key}`);
    for (const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/gu)) {
      if (!WORKTREE_SETUP_VARIABLES.has(match[1]!)) {
        throw new Error(`${WORKTREE_SETUP_CONFIG}.environment.${key} uses unknown placeholder \${${match[1]}}`);
      }
    }
    environment[key] = value;
  }

  const setupRaw = root.setup ?? [];
  if (!Array.isArray(setupRaw) || setupRaw.length > MAX_STEPS) {
    throw new Error(`${WORKTREE_SETUP_CONFIG}.setup must contain at most ${MAX_STEPS} entries`);
  }
  const setup = setupRaw.map((item, index): WorktreeSetupStep => {
    const path = `${WORKTREE_SETUP_CONFIG}.setup[${index}]`;
    const entry = record(item, path);
    onlyKeys(entry, ["name", "command", "timeoutSeconds", "optional"], path);
    if (!Array.isArray(entry.command) || entry.command.length < 1 || entry.command.length > MAX_ARGS) {
      throw new Error(`${path}.command must contain between 1 and ${MAX_ARGS} argv entries`);
    }
    const command = entry.command.map((arg, argIndex) => boundedString(arg, `${path}.command[${argIndex}]`)) as [string, ...string[]];
    const timeoutSeconds = entry.timeoutSeconds ?? 600;
    if (!Number.isInteger(timeoutSeconds) || (timeoutSeconds as number) < MIN_TIMEOUT_SECONDS || (timeoutSeconds as number) > MAX_TIMEOUT_SECONDS) {
      throw new Error(`${path}.timeoutSeconds must be an integer from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`);
    }
    if (entry.optional !== undefined && typeof entry.optional !== "boolean") throw new Error(`${path}.optional must be a boolean`);
    return { name: boundedString(entry.name, `${path}.name`), command, timeoutSeconds: timeoutSeconds as number, optional: entry.optional === true };
  });
  const stepNames = new Set<string>();
  for (const step of setup) {
    if (stepNames.has(step.name)) throw new Error(`${WORKTREE_SETUP_CONFIG}.setup step names must be unique`);
    stepNames.add(step.name);
  }
  if (setup.reduce((total, step) => total + step.timeoutSeconds, 0) > MAX_TIMEOUT_SECONDS) {
    throw new Error(`${WORKTREE_SETUP_CONFIG}.setup total timeout must not exceed ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  const config: WorktreeSetupConfig = { version: 1, copyFiles, environment, setup };
  const trustProjection = JSON.stringify({ copyFiles, setup, environmentKeys: Object.keys(environment) });
  if (Buffer.byteLength(trustProjection) > MAX_TRUST_PROJECTION_BYTES) {
    throw new Error(`${WORKTREE_SETUP_CONFIG} commands and copies are too large to review exactly`);
  }
  return config;
}

export function worktreeSetupHash(config: WorktreeSetupConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function worktreeSetupSourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function expandWorktreeSetupEnvironment(
  environment: Record<string, string>,
  variables: WorktreeSetupVariables,
): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`environment variable ${key} uses unknown placeholder \${${name}}`);
    return variables[name as keyof WorktreeSetupVariables];
  })]));
}

export function resolvedWorktreeSetupEnvironment(
  config: WorktreeSetupConfig,
  values: { primaryCheckout: string; worktreePath: string; branch: string; baseRef?: string },
): Record<string, string> {
  const variables: WorktreeSetupVariables = {
    WOLLIPOG_WORKTREE_PATH: values.worktreePath,
    WOLLIPOG_WORKTREE_BRANCH: values.branch,
    WOLLIPOG_WORKTREE_BASE_REF: values.baseRef ?? "",
    WOLLIPOG_PRIMARY_CHECKOUT: values.primaryCheckout,
  };
  return { ...expandWorktreeSetupEnvironment(config.environment, variables), ...variables };
}

function confined(root: string, candidate: string): boolean {
  const inside = relative(root, candidate);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

async function copyConfiguredFile(
  context: AgentContext,
  primaryCheckout: string,
  worktreePath: string,
  item: WorktreeSetupCopy,
): Promise<void> {
  const source = resolve(primaryCheckout, item.source);
  const destination = resolve(worktreePath, item.destination);
  if (!confined(primaryCheckout, source) || !confined(worktreePath, destination)) throw new Error("copy path escapes its repository root");
  const sourceRoot = await realpath(primaryCheckout);
  const sourceReal = await realpath(source);
  if (!confined(sourceRoot, sourceReal)) throw new Error(`copy source ${item.source} resolves outside the primary checkout`);
  const sourceStat = await stat(sourceReal);
  if (!sourceStat.isFile()) throw new Error(`copy source ${item.source} is not a regular file`);
  if (sourceStat.size > MAX_COPY_FILE_BYTES) throw new Error(`copy source ${item.source} exceeds 64 MiB`);
  try {
    await runContextCommand(context, "git", ["check-ignore", "--quiet", "--", item.destination], {
      cwd: worktreePath, timeoutMs: 30_000,
    });
  } catch {
    throw new Error(`copy destination ${item.destination} must be ignored so it cannot be staged or committed`);
  }
  const worktreeReal = await realpath(worktreePath);
  const destinationParent = dirname(destination);
  const parentRelative = relative(worktreePath, destinationParent);
  let cursor = worktreePath;
  for (const component of parentRelative.split(/[\\/]/u).filter(Boolean)) {
    cursor = resolve(cursor, component);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`copy destination ${item.destination} crosses a non-directory or symbolic link`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(cursor);
    }
  }
  const parentReal = await realpath(destinationParent);
  if (!confined(worktreeReal, parentReal)) throw new Error(`copy destination ${item.destination} resolves outside the worktree`);
  try {
    const existing = await lstat(destination);
    if (!existing.isFile()) throw new Error(`copy destination ${item.destination} is not a regular file`);
    return; // Resume semantics never overwrite a file the user or an earlier attempt may have changed.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await copyFile(sourceReal, destination, constants.COPYFILE_EXCL);
}

export async function loadWorktreeSetupConfig(
  context: AgentContext,
  repository: string,
  baseCommit: string,
): Promise<{ config: WorktreeSetupConfig; hash: string } | null> {
  const listed = await runContextCommand(context, "git", ["ls-tree", "--name-only", baseCommit, "--", WORKTREE_SETUP_CONFIG], {
    cwd: repository, timeoutMs: 30_000, maxBuffer: 4_096,
  });
  if (listed.stdout.trim() !== WORKTREE_SETUP_CONFIG) return null;
  const { stdout } = await runContextCommand(context, "git", ["show", `${baseCommit}:${WORKTREE_SETUP_CONFIG}`], {
    cwd: repository, timeoutMs: 30_000, maxBuffer: MAX_CONFIG_BYTES,
  });
  const config = parseWorktreeSetupConfig(stdout);
  return { config, hash: worktreeSetupSourceHash(stdout) };
}

async function runSetupCommand(
  options: WorktreeSetupRunOptions,
  step: WorktreeSetupStep,
  environment: Record<string, string>,
  stepIndex: number,
  isolation: SpawnIsolation | undefined,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCommand, rejectCommand) => {
    if (options.signal?.aborted) {
      rejectCommand(setupCancelled());
      return;
    }
    if (isolation?.backend === "cloud") {
      const adapterNames = new Set(Object.keys(isolation.env).map((key) => key.toLowerCase()));
      const collision = Object.keys(environment).find((key) => adapterNames.has(key.toLowerCase()));
      if (collision) {
        rejectCommand(new Error(`setup environment ${collision} conflicts with a cloud adapter environment name`));
        return;
      }
    }
    const child = spawnAgent({
      command: step.command[0], args: step.command.slice(1), cwd: options.worktreePath,
      env: environment, context: options.context, isolation,
      ...(isolation?.backend === "container"
        ? { containerEnvironmentKeys: Object.keys(environment) }
        : {}),
      ...(isolation?.backend === "cloud"
        ? { cloudEnvironmentKeys: Object.keys(environment) }
        : {}),
      trackDescendants: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let cancelled = false;
    let outputLimitExceeded = false;
    let settled = false;
    const outputError = (error: Error): Error & { stdout: string; stderr: string } => Object.assign(error, {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      if (settled || cancelled || outputLimitExceeded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1024 * 1024) {
        outputLimitExceeded = true;
        killTree(child);
        return;
      }
      target.push(buffer);
      options.onOutput?.(stepIndex, buffer.toString("utf8"));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const onAbort = () => {
      if (settled || cancelled) return;
      cancelled = true;
      killTree(child);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = () => options.signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTree(child);
    }, step.timeoutSeconds * 1_000);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      finish();
      if (settled) return;
      settled = true;
      rejectCommand(outputError(cancelled
        ? setupCancelled()
        : outputLimitExceeded ? new Error(`${step.name} output exceeded 1 MiB`) : error));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      finish();
      if (settled) return;
      settled = true;
      if (cancelled) {
        rejectCommand(outputError(setupCancelled()));
      } else if (outputLimitExceeded) {
        rejectCommand(outputError(new Error(`${step.name} output exceeded 1 MiB`)));
      } else if (timedOut) {
        rejectCommand(Object.assign(outputError(new Error(`${step.name} timed out after ${step.timeoutSeconds} second(s)`)), {
          code: "ETIMEDOUT",
          ...(signal ? { signal } : {}),
        }));
      } else if (code !== 0) {
        rejectCommand(Object.assign(outputError(new Error(`${step.name} exited with ${code ?? signal ?? "unknown status"}`)), {
          ...(typeof code === "number" ? { exitCode: code } : {}),
          ...(signal ? { signal } : {}),
        }));
      } else {
        resolveCommand({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      }
    });
    child.stdin.end();
  });
}

export async function runWorktreeSetup(options: WorktreeSetupRunOptions): Promise<WorktreeSetupState> {
  throwIfSetupCancelled(options.signal);
  let environment = options.environment ?? resolvedWorktreeSetupEnvironment(options.config, options);
  let isolation = options.isolation;
  const priorSteps = options.prior?.steps ?? [];
  const firstIncomplete = priorSteps.findIndex((step) => step.status === "failed" && !step.optional);
  const startAt = firstIncomplete < 0 ? priorSteps.length : firstIncomplete;
  const state: WorktreeSetupState = {
    status: "running", configHash: options.configHash ?? worktreeSetupHash(options.config), attemptId: randomUUID(),
    startedAt: Date.now(), environmentKeys: Object.keys(environment).sort(),
    copies: options.config.copyFiles.map((copy) => ({ ...copy, status: "pending" as const })),
    steps: priorSteps.slice(0, startAt),
  };
  options.onState?.(structuredClone(state));
  try {
    const priorCopies = options.prior?.copies ?? [];
    const firstIncompleteCopy = priorCopies.findIndex((copy) => copy.status !== "completed");
    const copyStartAt = options.prior
      ? firstIncompleteCopy < 0 ? priorCopies.length : firstIncompleteCopy
      : 0;
    if (options.prior) state.copies = priorCopies.slice();
    if (copyStartAt < options.config.copyFiles.length) {
      for (let index = copyStartAt; index < options.config.copyFiles.length; index++) {
        throwIfSetupCancelled(options.signal);
        const copy = options.config.copyFiles[index]!;
        const startedAt = Date.now();
        try {
          await copyConfiguredFile(options.context, options.primaryCheckout, options.worktreePath, copy);
          throwIfSetupCancelled(options.signal);
          state.copies[index] = { ...copy, status: "completed", durationMs: Date.now() - startedAt };
        } catch (error) {
          state.copies[index] = { ...copy, status: "failed", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
          throw error;
        }
        options.onState?.(structuredClone(state));
      }
    }
    if (options.prepareExecution) {
      throwIfSetupCancelled(options.signal);
      const prepared = await options.prepareExecution();
      throwIfSetupCancelled(options.signal);
      environment = prepared.environment;
      isolation = prepared.isolation;
    }
    for (let index = startAt; index < options.config.setup.length; index++) {
      throwIfSetupCancelled(options.signal);
      const step = options.config.setup[index]!;
      const startedAt = Date.now();
      const result = { name: step.name, status: "running" as const, optional: step.optional, startedAt };
      state.steps[index] = result;
      options.onState?.(structuredClone(state));
      try {
        await runSetupCommand(options, step, environment, index, isolation);
        state.steps[index] = { ...result, status: "completed", durationMs: Date.now() - startedAt, exitCode: 0 };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        const commandError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; exitCode?: number };
        const detail = commandError.code === "ETIMEDOUT" || commandError.killed || commandError.signal === "SIGKILL"
          ? `${step.name} timed out after ${step.timeoutSeconds} second(s)`
          : error instanceof Error ? error.message : String(error);
        state.steps[index] = {
          ...result,
          status: "failed",
          durationMs: Date.now() - startedAt,
          ...(typeof commandError.exitCode === "number" ? { exitCode: commandError.exitCode } : {}),
          ...(commandError.signal ? { signal: commandError.signal } : {}),
          error: detail,
        };
        options.onState?.(structuredClone(state));
        if (!step.optional) throw new Error(detail);
      }
      options.onState?.(structuredClone(state));
    }
    state.status = "completed";
    state.completedAt = Date.now();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    state.status = "failed";
    state.completedAt = Date.now();
    state.error = error instanceof Error ? error.message : String(error);
  }
  options.onState?.(structuredClone(state));
  return state;
}
