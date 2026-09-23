import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentContext, ExecutionTargetDefinition, ExecutionTargetRef, TargetHarnessInstallation } from "@wollipog/protocol";
import type { RunnerContainerTarget } from "./config.js";
import {
  CANONICAL_CONTAINER_LABELS,
  CONTAINER_LABEL_GENERATIONS,
  LEGACY_CONTAINER_LABELS,
  containerLabelArgs,
} from "./container-identity.js";
import { resolveNative, run, type ExecResult, type ResolvedBinary } from "./discovery/resolve.js";
import { sensitiveEnvironmentName } from "./env-security.js";
import type { ContainerSpawnIsolation } from "./spawn.js";
import { probeTargetHarness } from "./target-harness-probe.js";

interface ContainerTargetDeps {
  resolveRuntime(name: string): Promise<ResolvedBinary | null>;
  run(file: string, args: string[], opts: {
    timeoutMs?: number; maxBuffer?: number; env?: Record<string, string>; replaceEnv?: boolean;
  }): Promise<ExecResult>;
  warnLegacyContainerLabels?(message: string): void;
}

const defaultDeps: ContainerTargetDeps = {
  resolveRuntime: resolveNative,
  run,
  warnLegacyContainerLabels: (message) => console.warn(`[runner] ${message}`),
};
const MAX_RUNNER_CONTAINER_INVENTORY = 128;
const LEGACY_CONTAINER_LABEL_WARNING =
  "legacy-only com.misko-agent-manager.* container state was found during orphan cleanup; " +
  "compatibility remains active for this migration window";

/** Match the real container launch's host-credential boundary even when a runtime is configured
 * to forward its own client environment into containers. */
export function targetProbeEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) =>
    value !== undefined && !sensitiveEnvironmentName(name))) as Record<string, string>;
}

interface PreparedContainerTarget {
  config: RunnerContainerTarget;
  definition: ExecutionTargetDefinition;
  runtime?: ResolvedBinary;
  installations?: Map<string, { agentId: string; command: string; args: string[]; info: TargetHarnessInstallation }>;
}

export function containerTargetId(runnerId: string, templateId: string): string {
  return `runner:${encodeURIComponent(runnerId)}:container:${encodeURIComponent(templateId)}`;
}

export function containerSetupCheckDigest(template: Pick<RunnerContainerTarget, "revision" | "image" | "agentCommands" | "alternateCommands" | "setupChecks">): string {
  return createHash("sha256").update(JSON.stringify({
    revision: template.revision,
    image: template.image,
    agentCommands: Object.fromEntries(Object.entries(template.agentCommands).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)),
    ...(template.alternateCommands && Object.keys(template.alternateCommands).length ? {
      alternateCommands: Object.fromEntries(Object.entries(template.alternateCommands).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0)),
    } : {}),
    setupChecks: template.setupChecks.map((check) => ({
      name: check.name,
      command: check.command,
      args: check.args ?? [],
    })),
  })).digest("hex");
}

const RESOLVE_IN_IMAGE = 'case "$1" in /*) path="$1";; *) path=$(command -v "$1") || exit 1;; esac; case "$path" in /*) ;; *) exit 1;; esac; real=$(readlink -f "$path") || exit 1; case "$real" in /*) ;; *) exit 1;; esac; test -x "$real" || exit 1; printf "%s\\n" "$real"';

function candidateCommands(template: RunnerContainerTarget): Array<{ agentId: string; command: string; args: string[] }> {
  return Object.entries(template.agentCommands).flatMap(([agentId, primary]) => [
    { agentId, command: primary.command, args: primary.args ?? [] },
    ...(template.alternateCommands?.[agentId] ?? []).map((candidate) => ({
      agentId, command: candidate.command, args: candidate.args ?? [],
    })),
  ]);
}

function unavailableReason(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return (normalized || "container environment check failed").slice(0, 300);
}

function localRuntimePath(value: string): string {
  if (!isAbsolute(value) || value.length > 4096 || /[\r\n\0]/u.test(value)) {
    throw new Error("container runtime path is not safe to forward");
  }
  return value;
}

function localDockerEndpoint(value: string): string {
  if (value.startsWith("unix://")) return `unix://${localRuntimePath(value.slice("unix://".length))}`;
  const pipe = "npipe:////./pipe/";
  if (process.platform === "win32" && value.startsWith(pipe) &&
      /^[A-Za-z0-9_.-]{1,128}$/u.test(value.slice(pipe.length))) return value;
  throw new Error("Docker endpoint is not local");
}

/** Keep client config and credentials isolated while retaining only local, non-secret runtime
 * locations needed to find a rootless image store or Unix daemon socket. */
function setupCheckRuntimeEnvironment(home: string, runtime: RunnerContainerTarget["runtime"]): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.platform === "win32" ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32` : "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    DOCKER_CONFIG: home,
    XDG_CONFIG_HOME: home,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
  };
  if (runtime === "podman" && process.platform === "linux") {
    // Podman may expand $HOME inside storage.conf, even when the config file itself is
    // selected explicitly. Its general config root remains isolated below.
    env.HOME = localRuntimePath(homedir());
    env.XDG_DATA_HOME = localRuntimePath(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
    if (process.env.XDG_RUNTIME_DIR !== undefined) {
      env.XDG_RUNTIME_DIR = localRuntimePath(process.env.XDG_RUNTIME_DIR);
    }
    const configHome = localRuntimePath(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
    const storageConfig = localRuntimePath(process.env.CONTAINERS_STORAGE_CONF ??
      join(configHome, "containers", "storage.conf"));
    if (process.env.CONTAINERS_STORAGE_CONF !== undefined || existsSync(storageConfig)) {
      env.CONTAINERS_STORAGE_CONF = storageConfig;
    }
  }
  if (runtime === "podman" && process.env.CONTAINER_CONNECTION) {
    throw new Error("remote Podman connection is unsupported for setup checks");
  }
  const socket = runtime === "docker" ? process.env.DOCKER_HOST : process.env.CONTAINER_HOST;
  if (socket) {
    if (runtime === "docker") env.DOCKER_HOST = localDockerEndpoint(socket);
    else {
      if (!socket.startsWith("unix://")) throw new Error("nonlocal container endpoint is unsupported for setup checks");
      env.CONTAINER_HOST = `unix://${localRuntimePath(socket.slice("unix://".length))}`;
    }
  }
  return env;
}

function setupCheckArgs(
  template: RunnerContainerTarget,
  check: RunnerContainerTarget["setupChecks"][number],
  runnerKey: string,
): string[] {
  const containerName = setupCheckContainerName(template, check, runnerKey);
  return [
    "run", "--rm", "--pull=never",
    "--name", containerName,
    ...containerLabelArgs(runnerKey, template.id),
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--tmpfs", "/tmp:rw,nosuid,nodev",
    "--entrypoint", check.command,
    template.image,
    ...(check.args ?? []),
  ];
}

function setupCheckContainerName(
  template: RunnerContainerTarget,
  check: RunnerContainerTarget["setupChecks"][number],
  runnerKey: string,
): string {
  const checkKey = createHash("sha256").update(`${template.id}\0${check.name}`).digest("hex").slice(0, 16);
  return `wollipog-check-${runnerKey}-${checkKey}`;
}

/** Holds only templates that were validated at startup. Missing runtimes, absent digest-pinned
 * images, and failing checks stay visible but unavailable; the runner never pulls or falls back. */
export class ContainerTargetRegistry {
  private readonly prepared = new Map<string, PreparedContainerTarget>();
  private readonly runtimeCleanup = new Map<string, Promise<string | null>>();
  private readonly runnerKey: string;
  private readonly warnLegacyContainerLabels: (message: string) => void;
  private warnedLegacyContainerLabels = false;

  constructor(
    private readonly runnerId: string,
    private readonly hostname: string,
    private readonly templates: RunnerContainerTarget[],
    private readonly deps: ContainerTargetDeps = defaultDeps,
  ) {
    this.runnerKey = createHash("sha256").update(runnerId).digest("hex").slice(0, 20);
    this.warnLegacyContainerLabels = deps.warnLegacyContainerLabels ?? defaultDeps.warnLegacyContainerLabels!;
  }

  private async setupEnvironment(template: RunnerContainerTarget, runtime: ResolvedBinary, home: string): Promise<Record<string, string>> {
    const env = setupCheckRuntimeEnvironment(home, template.runtime);
    if (template.runtime === "podman") {
      const hostConfig = localRuntimePath(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
      if (process.env.CONTAINERS_CONF === "" || process.env.CONTAINERS_CONF_OVERRIDE === "") {
        throw new Error("Podman config path is invalid");
      }
      // Config drop-ins can select remote mode even when no top-level file exists. Always
      // ask the operator's Podman client before replacing its config with our private one.
      if (!process.env.CONTAINER_HOST) {
        const inspected = await this.deps.run(runtime.launch.command, [
          ...runtime.launch.args, "info", "--format", "{{json .Host.ServiceIsRemote}}",
        ], { timeoutMs: 5_000, maxBuffer: 4_096, replaceEnv: true, env: {
          PATH: env.PATH!, HOME: env.HOME!, XDG_CONFIG_HOME: hostConfig,
          ...(env.XDG_DATA_HOME ? { XDG_DATA_HOME: env.XDG_DATA_HOME } : {}),
          ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}),
          ...(env.CONTAINERS_STORAGE_CONF ? { CONTAINERS_STORAGE_CONF: env.CONTAINERS_STORAGE_CONF } : {}),
          ...(process.env.CONTAINERS_CONF ? { CONTAINERS_CONF: localRuntimePath(process.env.CONTAINERS_CONF) } : {}),
          ...(process.env.CONTAINERS_CONF_OVERRIDE ? {
            CONTAINERS_CONF_OVERRIDE: localRuntimePath(process.env.CONTAINERS_CONF_OVERRIDE),
          } : {}),
        } });
        if (inspected.code !== 0 || inspected.timedOut || inspected.errorCode ||
            inspected.stdout.trim() !== "false") {
          throw new Error("Podman is not a verified local runtime");
        }
      }
      const config = join(home, "containers.conf");
      // CONTAINERS_CONF bypasses system and user containers.conf, either of which can set
      // implicit container environment values. Storage-only configuration remains separate.
      await writeFile(config, "", { flag: "wx", mode: 0o600 });
      env.CONTAINERS_CONF = config;
    }
    if (template.runtime !== "docker" || process.env.DOCKER_HOST) return env;
    // A saved Docker context can select a local Unix socket even without DOCKER_CONTEXT. Ask
    // Docker for only that endpoint using a bounded client environment and the operator's
    // context directory; never expose its credential files to the actual setup check.
    const config = localRuntimePath(process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"));
    if (!process.env.DOCKER_CONTEXT && !existsSync(join(config, "config.json"))) return env;
    const context = process.env.DOCKER_CONTEXT;
    if (context && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(context)) {
      throw new Error("container context name is invalid");
    }
    const result = await this.deps.run(runtime.launch.command, [
      ...runtime.launch.args, "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}",
    ], { timeoutMs: 5_000, maxBuffer: 4_096, replaceEnv: true, env: {
      PATH: env.PATH!, HOME: home, DOCKER_CONFIG: config,
      ...(process.platform === "win32" ? { SystemRoot: env.SystemRoot! } : {}),
      ...(context ? { DOCKER_CONTEXT: context } : {}),
    } });
    if (result.code !== 0 || result.timedOut || result.errorCode) throw new Error("Docker context could not be resolved");
    const endpoint: unknown = JSON.parse(result.stdout.trim());
    if (typeof endpoint !== "string") throw new Error("Docker context endpoint is invalid");
    env.DOCKER_HOST = localDockerEndpoint(endpoint);
    return env;
  }

  private cleanupOrphans(runtime: ResolvedBinary): Promise<string | null> {
    const key = `${runtime.launch.command}\0${runtime.launch.args.join("\0")}`;
    const existing = this.runtimeCleanup.get(key);
    if (existing) return existing;
    const cleanup = (async () => {
      const inventory = new Set<string>();
      const generationInventories = new Map<string, Set<string>>();
      const listings = await Promise.all(CONTAINER_LABEL_GENERATIONS.map(async (labels) => ({
        labels,
        listed: await this.deps.run(runtime.launch.command, [
          ...runtime.launch.args, "ps", "-aq", "--filter", `label=${labels.runner}=${this.runnerKey}`,
        ], { timeoutMs: 15_000 }),
      })));
      let inventoryError: string | null = null;
      for (const { labels, listed } of listings) {
        if (listed.code !== 0) {
          inventoryError ??= unavailableReason(listed.stderr || "could not list runner-owned containers");
          continue;
        }
        const ids = listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (ids.length > MAX_RUNNER_CONTAINER_INVENTORY || ids.some((id) => !/^[a-f0-9]{12,64}$/i.test(id))) {
          inventoryError ??= "container runtime returned an invalid runner-owned container inventory";
          continue;
        }
        generationInventories.set(labels.runner, new Set(ids));
        for (const id of ids) inventory.add(id);
      }
      if (inventory.size > MAX_RUNNER_CONTAINER_INVENTORY) {
        inventoryError ??= "container runtime returned an invalid runner-owned container inventory";
      }
      if (inventoryError) return inventoryError;
      const canonical = generationInventories.get(CANONICAL_CONTAINER_LABELS.runner) ?? new Set<string>();
      const legacy = generationInventories.get(LEGACY_CONTAINER_LABELS.runner) ?? new Set<string>();
      if (!this.warnedLegacyContainerLabels && [...legacy].some((id) => !canonical.has(id))) {
        this.warnedLegacyContainerLabels = true;
        this.warnLegacyContainerLabels(LEGACY_CONTAINER_LABEL_WARNING);
      }
      if (!inventory.size) return null;
      const removed = await this.deps.run(
        runtime.launch.command,
        [...runtime.launch.args, "rm", "-f", ...inventory],
        { timeoutMs: 30_000 },
      );
      return removed.code === 0 ? null : unavailableReason(removed.stderr || "could not remove orphaned runner containers");
    })();
    this.runtimeCleanup.set(key, cleanup);
    return cleanup;
  }

  private async discoverInstallations(template: RunnerContainerTarget, runtime: ResolvedBinary, targetId: string): Promise<
    Map<string, { agentId: string; command: string; args: string[]; info: TargetHarnessInstallation }>
  > {
    const installations = new Map<string, { agentId: string; command: string; args: string[]; info: TargetHarnessInstallation }>();
    const seen = new Set<string>();
    const probe = async (candidate: { agentId: string; command: string; args: string[] },
      phase: "resolve" | "version" | "capability" | "authentication", entrypoint: string, args: string[]): Promise<ExecResult> => {
      const probeKey = createHash("sha256").update(JSON.stringify([
        template.id, candidate.agentId, candidate.command, candidate.args, phase,
      ])).digest("hex").slice(0, 16);
      const name = `wollipog-probe-${this.runnerKey}-${probeKey}`;
      // A named, runner-labelled container can be forcibly removed after a client timeout
      // and found by startup orphan reconciliation if removal itself fails.
      const result = await this.deps.run(runtime.launch.command, [
        ...runtime.launch.args, "run", "--rm", "--name", name,
        ...containerLabelArgs(this.runnerKey, template.id),
        "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "128",
        "--tmpfs", "/tmp:rw,nosuid,nodev", "--workdir", "/tmp",
        "--entrypoint", entrypoint, template.image, ...args,
      ], { timeoutMs: 5_000, maxBuffer: 64 * 1024,
        env: targetProbeEnvironment(process.env), replaceEnv: true });
      if (result.timedOut || result.code === null || result.errorCode) {
        await this.deps.run(runtime.launch.command, [
          ...runtime.launch.args, "rm", "-f", name,
        ], { timeoutMs: 5_000 });
      }
      return result;
    };
    for (const candidate of candidateCommands(template)) {
      // No workspace mount, network, host secrets, or interactive stdin reaches these probes.
      const resolved = await probe(candidate, "resolve", "/bin/sh",
        ["-c", RESOLVE_IN_IMAGE, "sh", candidate.command]);
      const path = resolved.code === 0 ? resolved.stdout.trim() : "";
      if (!/^\/[A-Za-z0-9_./+-]{1,255}$/.test(path) || path.split("/").includes("..")) continue;
      const identity = JSON.stringify([candidate.agentId, path, candidate.args]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const id = createHash("sha256").update(JSON.stringify([
        targetId, template.revision, template.image, containerSetupCheckDigest(template), identity,
      ])).digest("hex").slice(0, 24);
      const versionProbe = await probe(candidate, "version", path, ["--version"]);
      const firstLine = (versionProbe.stdout || versionProbe.stderr).split(/\r?\n/u)[0]?.trim() ?? "";
      const version = firstLine.match(/\d+\.\d+\.\d+[\w.-]*/u)?.[0];
      const available = versionProbe.code === 0 && !versionProbe.timedOut && !versionProbe.errorCode && Boolean(version);
      const status = available && version
        ? await probeTargetHarness(candidate.agentId, version, candidate.args, (args) => probe(candidate,
          args[0] === "auth" || args[0] === "login" ? "authentication" : "capability", path, args))
        : { authentication: "unknown" as const, capability: "unknown" as const };
      const info: TargetHarnessInstallation = {
        agentId: candidate.agentId, id, path, provenance: "container-image",
        ...status, available,
        ...(version ? { version } : {}),
      };
      installations.set(id, { ...candidate, command: path, info });
    }
    return installations;
  }

  async initialize(): Promise<void> {
    this.prepared.clear();
    for (const template of this.templates) {
      const id = containerTargetId(this.runnerId, template.id);
      const environment = {
        id: template.id,
        revision: template.revision,
        image: template.image,
        setupCheckDigest: containerSetupCheckDigest(template),
      };
      const base: ExecutionTargetDefinition = {
        id,
        runnerId: this.runnerId,
        // Keep the runner/control-plane name contract identical even on unusually long FQDNs.
        name: `${this.hostname.trim()} · ${template.name}`.slice(0, 180).trim(),
        kind: "container",
        workspaceStrategy: "worktree",
        adapter: "container",
        boundaries: {
          filesystem: "container",
          network: template.network === "deny" ? "deny" : "policy",
          secrets: "none",
          billing: "none",
        },
        environment,
        compatibleAgentIds: Object.keys(template.agentCommands).sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
        available: false,
      };
      const runtime = await this.deps.resolveRuntime(template.runtime);
      if (!runtime) {
        this.prepared.set(id, {
          config: template,
          definition: { ...base, unavailableReason: `${template.runtime} runtime is not installed` },
        });
        continue;
      }
      const cleanupError = await this.cleanupOrphans(runtime);
      if (cleanupError) {
        this.prepared.set(id, {
          config: template,
          runtime,
          definition: { ...base, unavailableReason: `orphan reconciliation failed: ${cleanupError}` },
        });
        continue;
      }
      const prefix = runtime.launch.args;
      const inspected = await this.deps.run(runtime.launch.command, [...prefix, "image", "inspect", template.image], { timeoutMs: 15_000 });
      if (inspected.code !== 0) {
        this.prepared.set(id, {
          config: template,
          runtime,
          definition: { ...base, unavailableReason: unavailableReason(inspected.stderr || `image ${template.image} is not present`) },
        });
        continue;
      }
      let failed: string | null = null;
      for (const check of template.setupChecks) {
        let home: string;
        try {
          home = await mkdtemp(join(tmpdir(), "wollipog-container-check-"));
        } catch {
          failed = `setup check '${check.name}' could not prepare isolated runtime`;
          break;
        }
        try {
          const opts = { env: await this.setupEnvironment(template, runtime, home), replaceEnv: true };
          const result = await this.deps.run(runtime.launch.command,
            [...prefix, ...setupCheckArgs(template, check, this.runnerKey)], { ...opts, timeoutMs: 30_000 });
          if (result.code !== 0 || result.timedOut || result.errorCode) {
            // A timed-out client can leave a container behind. Use the same clean environment
            // for removal and let startup reconciliation handle a failed removal.
            await this.deps.run(runtime.launch.command, [
              ...prefix, "rm", "-f", setupCheckContainerName(template, check, this.runnerKey),
            ], { ...opts, timeoutMs: 15_000 });
            // Command output may contain values from the image. It is never a safe diagnostic.
            const category = result.timedOut ? "timed out" : result.errorCode ? "runtime client failed" : "exited unsuccessfully";
            failed = `setup check '${check.name}' ${category}`;
          }
        } catch {
          failed = `setup check '${check.name}' could not launch isolated runtime`;
        } finally {
          try {
            await rm(home, { recursive: true, force: true });
          } catch {
            failed = `setup check '${check.name}' could not clean isolated runtime`;
          }
        }
        if (failed) break;
      }
      const installations = failed ? new Map() : await this.discoverInstallations(template, runtime, id);
      this.prepared.set(id, {
        config: template,
        runtime,
        installations,
        definition: failed ? { ...base, unavailableReason: failed } : {
          ...base, available: true,
          ...(installations.size ? { harnessInstallations: [...installations.values()].map((item) => item.info) } : {}),
        },
      });
    }
  }

  definitions(): ExecutionTargetDefinition[] {
    return [...this.prepared.values()].map((item) => item.definition);
  }

  async refreshInstallations(): Promise<void> {
    for (const [id, item] of this.prepared) {
      if (!item.runtime || !item.definition.available) continue;
      const installations = await this.discoverInstallations(item.config, item.runtime, id);
      item.installations = installations;
      item.definition = {
        ...item.definition,
        ...(installations.size ? { harnessInstallations: [...installations.values()].map((entry) => entry.info) } :
          { harnessInstallations: undefined }),
      };
    }
  }

  validationError(target: ExecutionTargetRef, useWorktree: boolean, context: AgentContext, agentId: string): string | null {
    const prepared = this.prepared.get(target.id);
    if (!prepared || target.runnerId !== this.runnerId) return "execution target does not belong to this runner";
    if (target.adapter !== "container" || target.kind !== "container") return "execution target requires an unsupported adapter";
    if (!useWorktree || target.workspaceStrategy !== "worktree") return "container targets require an isolated worktree";
    if (context.kind !== "native") return "container targets require a native agent context";
    if (!prepared.config.agentCommands[agentId]) return `container target does not configure agent '${agentId}'`;
    if (target.harnessInstallationId) {
      const chosen = prepared.installations?.get(target.harnessInstallationId);
      if (!chosen || chosen.agentId !== agentId || !chosen.info.available) {
        return "selected container harness installation is unavailable";
      }
    }
    const expected = prepared.definition;
    if (!expected.available || !prepared.runtime) return expected.unavailableReason ?? "container target is unavailable";
    if (target.boundaries.filesystem !== "container" ||
        target.boundaries.network !== expected.boundaries.network ||
        target.boundaries.secrets !== "none" || target.boundaries.billing !== "none") {
      return "container target boundary claims are stale or unsupported";
    }
    const actualEnvironment = target.environment;
    const expectedEnvironment = expected.environment;
    if (!actualEnvironment || !expectedEnvironment ||
        actualEnvironment.id !== expectedEnvironment.id ||
        actualEnvironment.revision !== expectedEnvironment.revision ||
        actualEnvironment.image !== expectedEnvironment.image ||
        actualEnvironment.setupCheckDigest !== expectedEnvironment.setupCheckDigest) {
      return "container environment template is stale";
    }
    return null;
  }

  isolation(
    target: ExecutionTargetRef,
    agentId: string,
    hostAgentCommand: string,
    hostAgentArgs: string[],
    sessionId: string,
  ): ContainerSpawnIsolation {
    const prepared = this.prepared.get(target.id);
    if (!prepared?.runtime || !prepared.definition.available) throw new Error("container target is unavailable");
    const selected = target.harnessInstallationId
      ? prepared.installations?.get(target.harnessInstallationId)
      : undefined;
    if (target.harnessInstallationId && (!selected || selected.agentId !== agentId || !selected.info.available)) {
      throw new Error("selected container harness installation is unavailable");
    }
    const agent = selected ?? prepared.config.agentCommands[agentId];
    if (!agent) throw new Error(`container target does not configure agent '${agentId}'`);
    return {
      backend: "container",
      command: prepared.runtime.launch.command,
      args: prepared.runtime.launch.args,
      image: prepared.config.image,
      network: prepared.config.network,
      templateId: prepared.config.id,
      runnerKey: this.runnerKey,
      containerName: `wollipog-${createHash("sha256").update(`${this.runnerId}\0${sessionId}`).digest("hex").slice(0, 24)}`,
      hostAgentCommand,
      hostAgentArgs: [...hostAgentArgs],
      agentCommand: agent.command,
      agentArgs: agent.args ?? [],
    };
  }
}
