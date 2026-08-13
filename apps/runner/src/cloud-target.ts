import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  AgentContext,
  ExecutionHandoffArtifactRef,
  ExecutionHandoffGitProvenance,
  ExecutionHandoffReceipt,
  ExecutionTargetDefinition,
  ExecutionTargetRef,
  SessionConfig,
} from "@wollipog/protocol";
import type { RunnerCloudTarget } from "./config.js";
import { resolveNative, run, type ExecResult, type ResolvedBinary } from "./discovery/resolve.js";
import { sensitiveEnvironmentName } from "./env-security.js";
import type { CloudSpawnIsolation } from "./spawn.js";

const ADAPTER_PROTOCOL_VERSION = 1;
const MAX_GIT_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 256;
const ARTIFACT_KINDS = new Set(["html_preview", "patch", "review_report", "screenshot", "test_log", "verdict"]);

export interface CloudTargetDeps {
  resolveAdapter(command: string): Promise<ResolvedBinary | null>;
  resolveGit(): Promise<ResolvedBinary | null>;
  runGit(file: string, args: string[], opts: { timeoutMs?: number; maxBuffer?: number }): Promise<ExecResult>;
  runAdapter(file: string, args: string[], opts: { timeoutMs: number; env: Record<string, string>; maxBuffer: number }): Promise<ExecResult>;
  now(): number;
}

interface PreparedCloudTarget {
  config: RunnerCloudTarget;
  definition: ExecutionTargetDefinition;
  adapter?: ResolvedBinary;
  adapterEnv?: Record<string, string>;
}

export interface PreparedCloudLaunch {
  isolation: CloudSpawnIsolation;
  receipt: ExecutionHandoffReceipt;
  adapterHandoffKey: string;
}

function safeAdapterEnvironment(config: RunnerCloudTarget, hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value !== undefined && !sensitiveEnvironmentName(name)) env[name] = value;
  }
  for (const [name, reference] of Object.entries(config.adapterEnv ?? {})) {
    const value = hostEnv[reference.fromEnv];
    if (value === undefined) throw new Error(`adapter environment '${name}' is unavailable`);
    env[name] = value;
  }
  return env;
}

function runAdapter(
  file: string,
  args: string[],
  opts: { timeoutMs: number; env: Record<string, string>; maxBuffer: number },
): Promise<ExecResult> {
  return new Promise((resolveResult) => {
    execFile(file, args, {
      timeout: opts.timeoutMs,
      windowsHide: true,
      env: opts.env,
      maxBuffer: opts.maxBuffer,
    }, (error, stdout, stderr) => {
      const detail = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      const stringErrorCode = typeof detail?.code === "string" ? detail.code : undefined;
      const timedOut = detail?.code === "ETIMEDOUT" || (detail?.killed === true && !stringErrorCode);
      const code = error && typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : error ? 1 : 0;
      resolveResult({
        code,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        ...(timedOut ? { timedOut: true } : {}),
        ...(stringErrorCode && stringErrorCode !== "ETIMEDOUT" ? { errorCode: stringErrorCode } : {}),
      });
    });
  });
}

async function resolveAdapter(command: string): Promise<ResolvedBinary | null> {
  if (isAbsolute(command) && existsSync(command)) {
    return { path: command, via: "path", launch: { command, args: [] } };
  }
  return resolveNative(command);
}

const defaultDeps: CloudTargetDeps = {
  resolveAdapter,
  resolveGit: () => resolveNative("git"),
  runGit: run,
  runAdapter,
  now: Date.now,
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unavailableReason(value: string): string {
  return (value.replace(/\s+/g, " ").trim() || "cloud adapter check failed").slice(0, 300);
}

export function executionTargetDisplayName(hostname: string, name: string): string {
  const normalized = `${hostname.trim()} · ${name.trim()}`.replace(/[\u0000-\u001f\u007f]/g, "");
  return normalized.slice(0, 180).trim() || "cloud execution target";
}

export function cloudTargetId(runnerId: string, targetId: string): string {
  return `runner:${encodeURIComponent(runnerId)}:cloud:${encodeURIComponent(targetId)}`;
}

function policy(config: RunnerCloudTarget): NonNullable<ExecutionTargetDefinition["policy"]> {
  return {
    cost: {
      currency: "USD",
      estimatedHourlyRateUsd: config.policy.estimatedHourlyRateUsd,
      minimumBudgetUsd: config.policy.minimumBudgetUsd,
      maximumBudgetUsd: config.policy.maximumBudgetUsd,
    },
    admission: { maxConcurrentSessions: config.policy.maxConcurrentSessions, queue: "fifo" },
  };
}

function exactTargetPolicy(left: ExecutionTargetRef["policy"], right: ExecutionTargetDefinition["policy"]): boolean {
  return Boolean(left && right &&
    left.cost.currency === "USD" && left.cost.currency === right.cost.currency &&
    left.cost.estimatedHourlyRateUsd === right.cost.estimatedHourlyRateUsd &&
    left.cost.minimumBudgetUsd === right.cost.minimumBudgetUsd &&
    left.cost.maximumBudgetUsd === right.cost.maximumBudgetUsd &&
    left.admission.maxConcurrentSessions === right.admission.maxConcurrentSessions &&
    left.admission.queue === "fifo" && left.admission.queue === right.admission.queue);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function validateArtifacts(artifacts: ExecutionHandoffArtifactRef[]): ExecutionHandoffArtifactRef[] {
  if (!Array.isArray(artifacts) || artifacts.length > 32) throw new Error("cloud handoff has too many artifacts");
  const ids = new Set<string>();
  return artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== "object" || !artifact.artifactId || artifact.artifactId.length > 256 ||
        /[\0-\x1f\x7f]/.test(artifact.artifactId) || ids.has(artifact.artifactId) ||
        !ARTIFACT_KINDS.has(artifact.kind) ||
        !Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || artifact.sizeBytes > 8 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error("cloud handoff contains invalid artifact provenance");
    }
    ids.add(artifact.artifactId);
    return { ...artifact };
  });
}

async function gitProvenance(
  sourcePath: string,
  deps: CloudTargetDeps,
): Promise<ExecutionHandoffGitProvenance> {
  const git = await deps.resolveGit();
  if (!git) throw new Error("git is not installed in the runner's native context");
  const invoke = (args: string[], maxBuffer = 1024 * 1024) =>
    deps.runGit(git.launch.command, [...git.launch.args, "-C", sourcePath, ...args], { timeoutMs: 30_000, maxBuffer });
  const [head, tree, status, diff, remote] = await Promise.all([
    invoke(["rev-parse", "HEAD"]),
    invoke(["rev-parse", "HEAD^{tree}"]),
    invoke(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    invoke(["diff", "--binary", "--no-ext-diff", "HEAD", "--"], MAX_GIT_DIFF_BYTES + 1),
    invoke(["config", "--get", "remote.origin.url"]),
  ]);
  if (head.code !== 0 || tree.code !== 0 || status.code !== 0 || diff.code !== 0) {
    throw new Error("cloud handoff git provenance could not be computed");
  }
  if (Buffer.byteLength(diff.stdout, "utf8") > MAX_GIT_DIFF_BYTES) throw new Error("cloud handoff patch exceeds 8 MiB");
  const headCommit = head.stdout.trim();
  const headTree = tree.stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headCommit) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headTree)) {
    throw new Error("cloud handoff git object identity is invalid");
  }
  const untracked = status.stdout.split("\0").filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3));
  if (untracked.length > MAX_UNTRACKED_FILES) throw new Error("cloud handoff has more than 256 untracked files");
  const untrackedDigests: Array<{ pathHash: string; blob: string }> = [];
  for (const path of untracked) {
    if (!path || path.length > 1024 || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ||
        path.split(/[\\/]/).includes("..") || /[\0\r\n]/.test(path)) {
      throw new Error("cloud handoff contains an unsafe untracked path");
    }
    const hashed = await invoke(["hash-object", "--", path]);
    const blob = hashed.stdout.trim();
    if (hashed.code !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob)) {
      throw new Error("cloud handoff could not hash an untracked file");
    }
    untrackedDigests.push({ pathHash: sha256(path), blob });
  }
  untrackedDigests.sort((left, right) => left.pathHash < right.pathHash ? -1 : left.pathHash > right.pathHash ? 1 : 0);
  const workingTreeDigest = sha256(JSON.stringify({
    status: sha256(status.stdout),
    patch: sha256(diff.stdout),
    untracked: untrackedDigests,
  }));
  const remoteUrl = remote.code === 0 ? remote.stdout.trim() : "";
  return {
    headCommit,
    headTree,
    ...(remoteUrl ? { remoteUrlHash: sha256(remoteUrl) } : {}),
    workingTreeDigest,
    dirty: status.stdout.length > 0,
    untrackedFiles: untracked.length,
  };
}

/** Runner-owned registry for operator-installed cloud proxies. The repository ships no paid
 * provider adapter; tests inject a deterministic adapter implementing the same inspect/prepare API. */
export class CloudTargetRegistry {
  private readonly prepared = new Map<string, PreparedCloudTarget>();

  constructor(
    private readonly runnerId: string,
    private readonly hostname: string,
    private readonly targets: RunnerCloudTarget[],
    private readonly deps: CloudTargetDeps = defaultDeps,
  ) {}

  async initialize(): Promise<void> {
    this.prepared.clear();
    for (const config of this.targets) {
      const id = cloudTargetId(this.runnerId, config.id);
      const environment = {
        id: config.id,
        revision: config.revision,
        image: config.image,
        setupCheckDigest: config.setupCheckDigest,
      };
      const base: ExecutionTargetDefinition = {
        id,
        runnerId: this.runnerId,
        name: executionTargetDisplayName(this.hostname, config.name),
        kind: "cloud",
        workspaceStrategy: "snapshot",
        adapter: "cloud",
        boundaries: { filesystem: "snapshot", network: "policy", secrets: "references", billing: "target_metered" },
        environment,
        policy: policy(config),
        compatibleAgentIds: Object.keys(config.agentCommands).sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
        available: false,
      };
      const adapter = await this.deps.resolveAdapter(config.adapterCommand);
      if (!adapter) {
        this.prepared.set(id, { config, definition: { ...base, unavailableReason: `cloud adapter '${config.adapterCommand}' is not installed` } });
        continue;
      }
      let adapterEnv: Record<string, string>;
      try {
        adapterEnv = safeAdapterEnvironment(config);
      } catch (error) {
        this.prepared.set(id, { config, adapter, definition: { ...base, unavailableReason: unavailableReason((error as Error).message) } });
        continue;
      }
      const inspected = await this.deps.runAdapter(adapter.launch.command, [
        ...adapter.launch.args, ...(config.adapterArgs ?? []), "inspect",
        "--protocol", String(ADAPTER_PROTOCOL_VERSION),
        "--target", config.id,
        "--revision", String(config.revision),
        "--image", config.image,
        "--setup-check-digest", config.setupCheckDigest,
      ], { timeoutMs: 30_000, env: adapterEnv, maxBuffer: 64 * 1024 });
      const response = parseJsonObject(inspected.stdout);
      const ready = inspected.code === 0 && response?.protocolVersion === ADAPTER_PROTOCOL_VERSION &&
        response.targetId === config.id && response.revision === config.revision &&
        response.image === config.image && response.setupCheckDigest === config.setupCheckDigest && response.available === true;
      this.prepared.set(id, {
        config,
        adapter,
        adapterEnv,
        definition: ready
          ? { ...base, available: true }
          : { ...base, unavailableReason: unavailableReason(inspected.stderr || "cloud adapter readiness response did not match the target") },
      });
    }
  }

  definitions(): ExecutionTargetDefinition[] {
    return [...this.prepared.values()].map((item) => item.definition);
  }

  validationError(
    target: ExecutionTargetRef,
    useWorktree: boolean,
    context: AgentContext,
    agentId: string,
    config: SessionConfig | undefined,
  ): string | null {
    const prepared = this.prepared.get(target.id);
    if (!prepared || target.runnerId !== this.runnerId) return "execution target does not belong to this runner";
    if (target.adapter !== "cloud" || target.kind !== "cloud") return "execution target requires an unsupported adapter";
    if (!useWorktree || target.workspaceStrategy !== "snapshot") return "cloud targets require an isolated source worktree";
    if (context.kind !== "native") return "cloud targets require a native gateway runner context";
    if (!prepared.config.agentCommands[agentId]) return `cloud target does not configure agent '${agentId}'`;
    if (!prepared.definition.available || !prepared.adapter || !prepared.adapterEnv) {
      return prepared.definition.unavailableReason ?? "cloud target is unavailable";
    }
    if (target.boundaries.filesystem !== "snapshot" || target.boundaries.network !== "policy" ||
        target.boundaries.secrets !== "references" || target.boundaries.billing !== "target_metered") {
      return "cloud target boundary claims are stale or unsupported";
    }
    const actual = target.environment;
    const expected = prepared.definition.environment;
    if (!actual || !expected || actual.id !== expected.id || actual.revision !== expected.revision ||
        actual.image !== expected.image || actual.setupCheckDigest !== expected.setupCheckDigest) {
      return "cloud environment template is stale";
    }
    if (!exactTargetPolicy(target.policy, prepared.definition.policy)) return "cloud target cost or admission policy is stale";
    const budget = config?.costBudgetUsd;
    if (typeof budget !== "number" || !Number.isFinite(budget) ||
        budget < prepared.config.policy.minimumBudgetUsd || budget > prepared.config.policy.maximumBudgetUsd) {
      return `cloud target requires a cost budget from $${prepared.config.policy.minimumBudgetUsd} to $${prepared.config.policy.maximumBudgetUsd}`;
    }
    return null;
  }

  isolation(
    target: ExecutionTargetRef,
    agentId: string,
    hostAgentCommand: string,
    hostAgentArgs: string[],
    sessionId: string,
    handoffId: string,
  ): CloudSpawnIsolation {
    const prepared = this.prepared.get(target.id);
    const agent = prepared?.config.agentCommands[agentId];
    if (!prepared?.adapter || !prepared.adapterEnv || !prepared.definition.available || !agent) {
      throw new Error("cloud target is unavailable for this agent");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(handoffId)) throw new Error("cloud adapter handoff id is invalid");
    return {
      backend: "cloud",
      command: prepared.adapter.launch.command,
      args: [...prepared.adapter.launch.args, ...(prepared.config.adapterArgs ?? [])],
      env: { ...prepared.adapterEnv },
      targetId: prepared.config.id,
      handoffId,
      sessionId,
      hostAgentCommand,
      hostAgentArgs: [...hostAgentArgs],
      agentCommand: agent.command,
      agentArgs: [...(agent.args ?? [])],
    };
  }

  async cancel(target: ExecutionTargetRef, handoffId: string): Promise<void> {
    const prepared = this.prepared.get(target.id);
    if (!prepared?.adapter || !prepared.adapterEnv || !prepared.definition.available) {
      throw new Error("cloud target is unavailable");
    }
    if (target.adapter !== "cloud" || target.kind !== "cloud" || target.runnerId !== this.runnerId) {
      throw new Error("cloud execution target is invalid");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(handoffId)) throw new Error("cloud adapter handoff id is invalid");
    const response = await this.deps.runAdapter(prepared.adapter.launch.command, [
      ...prepared.adapter.launch.args, ...(prepared.config.adapterArgs ?? []), "cancel",
      "--protocol", String(ADAPTER_PROTOCOL_VERSION), "--target", prepared.config.id, "--handoff", handoffId,
    ], { timeoutMs: 30_000, env: prepared.adapterEnv, maxBuffer: 64 * 1024 });
    if (response.code !== 0) {
      throw new Error(unavailableReason(response.stderr || "cloud adapter could not cancel the handoff"));
    }
  }

  async prepareLaunch(input: {
    target: ExecutionTargetRef;
    agentId: string;
    hostAgentCommand: string;
    hostAgentArgs: string[];
    sessionId: string;
    sourceSessionId?: string;
    sourcePath: string;
    artifacts: ExecutionHandoffArtifactRef[];
    budgetUsd: number;
  }): Promise<PreparedCloudLaunch> {
    const prepared = this.prepared.get(input.target.id);
    if (!prepared?.adapter || !prepared.adapterEnv || !prepared.definition.available) throw new Error("cloud target is unavailable");
    const agent = prepared.config.agentCommands[input.agentId];
    if (!agent) throw new Error(`cloud target does not configure agent '${input.agentId}'`);
    const artifacts = validateArtifacts(input.artifacts);
    const git = await gitProvenance(input.sourcePath, this.deps);
    const manifest = {
      version: 1,
      sessionId: input.sessionId,
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      target: {
        id: input.target.id,
        environment: input.target.environment,
        policy: input.target.policy,
        boundaries: input.target.boundaries,
      },
      git,
      artifacts,
      budgetUsd: input.budgetUsd,
    };
    const manifestJson = JSON.stringify(manifest);
    const manifestDigest = sha256(manifestJson);
    const responseRaw = await this.deps.runAdapter(prepared.adapter.launch.command, [
      ...prepared.adapter.launch.args, ...(prepared.config.adapterArgs ?? []), "prepare",
      "--protocol", String(ADAPTER_PROTOCOL_VERSION),
      "--target", prepared.config.id,
      "--source", input.sourcePath,
      "--idempotency-key", manifestDigest,
      "--manifest", Buffer.from(manifestJson, "utf8").toString("base64url"),
    ], { timeoutMs: 120_000, env: prepared.adapterEnv, maxBuffer: 64 * 1024 });
    const response = parseJsonObject(responseRaw.stdout);
    const handoffId = typeof response?.handoffId === "string" ? response.handoffId : "";
    const quotedCostUsd = response?.quotedCostUsd;
    const validHandoffId = /^[A-Za-z0-9._:-]{1,128}$/.test(handoffId);
    if (responseRaw.code !== 0 || response?.protocolVersion !== ADAPTER_PROTOCOL_VERSION ||
        response.targetId !== prepared.config.id || response.manifestDigest !== manifestDigest ||
        !validHandoffId || typeof quotedCostUsd !== "number" ||
        !Number.isFinite(quotedCostUsd) || quotedCostUsd < 0 || quotedCostUsd > input.budgetUsd ||
        quotedCostUsd > prepared.config.policy.maximumBudgetUsd) {
      if (validHandoffId) {
        await this.cancel(input.target, handoffId).catch(() => {});
      }
      throw new Error(unavailableReason(responseRaw.stderr || "cloud adapter rejected or malformed the handoff receipt"));
    }
    const receipt: ExecutionHandoffReceipt = {
      targetId: input.target.id,
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      manifestDigest,
      adapterHandoffIdHash: sha256(handoffId),
      git,
      artifacts,
      budgetUsd: input.budgetUsd,
      quotedCostUsd,
      acceptedAt: this.deps.now(),
    };
    return {
      receipt,
      adapterHandoffKey: handoffId,
      isolation: this.isolation(
        input.target,
        input.agentId,
        input.hostAgentCommand,
        input.hostAgentArgs,
        input.sessionId,
        handoffId,
      ),
    };
  }
}
