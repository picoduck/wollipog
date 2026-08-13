import { createHash } from "node:crypto";
import type { AgentContext, ExecutionTargetDefinition, ExecutionTargetRef } from "@wollipog/protocol";
import type { RunnerContainerTarget } from "./config.js";
import {
  CANONICAL_CONTAINER_LABELS,
  CONTAINER_LABEL_GENERATIONS,
  LEGACY_CONTAINER_LABELS,
  containerLabelArgs,
} from "./container-identity.js";
import { resolveNative, run, type ExecResult, type ResolvedBinary } from "./discovery/resolve.js";
import type { ContainerSpawnIsolation } from "./spawn.js";

interface ContainerTargetDeps {
  resolveRuntime(name: string): Promise<ResolvedBinary | null>;
  run(file: string, args: string[], opts: { timeoutMs?: number }): Promise<ExecResult>;
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

interface PreparedContainerTarget {
  config: RunnerContainerTarget;
  definition: ExecutionTargetDefinition;
  runtime?: ResolvedBinary;
}

export function containerTargetId(runnerId: string, templateId: string): string {
  return `runner:${encodeURIComponent(runnerId)}:container:${encodeURIComponent(templateId)}`;
}

export function containerSetupCheckDigest(template: Pick<RunnerContainerTarget, "revision" | "image" | "agentCommands" | "setupChecks">): string {
  return createHash("sha256").update(JSON.stringify({
    revision: template.revision,
    image: template.image,
    agentCommands: Object.fromEntries(Object.entries(template.agentCommands).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)),
    setupChecks: template.setupChecks.map((check) => ({
      name: check.name,
      command: check.command,
      args: check.args ?? [],
    })),
  })).digest("hex");
}

function unavailableReason(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return (normalized || "container environment check failed").slice(0, 300);
}

function setupCheckArgs(
  template: RunnerContainerTarget,
  check: RunnerContainerTarget["setupChecks"][number],
  runnerKey: string,
): string[] {
  const containerName = setupCheckContainerName(template, check, runnerKey);
  return [
    "run", "--rm",
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
        const result = await this.deps.run(runtime.launch.command, [...prefix, ...setupCheckArgs(template, check, this.runnerKey)], { timeoutMs: 30_000 });
        if (result.code !== 0) {
          // `execFile` timeouts can kill the attached client before --rm finishes. The stable
          // name makes cleanup exact; a normal nonzero exit already removed it, so rm failure is
          // intentionally ignored and the next startup still has runner-label reconciliation.
          await this.deps.run(runtime.launch.command, [
            ...prefix, "rm", "-f", setupCheckContainerName(template, check, this.runnerKey),
          ], { timeoutMs: 15_000 });
          failed = `setup check '${check.name}' failed: ${unavailableReason(result.stderr || result.stdout)}`;
          break;
        }
      }
      this.prepared.set(id, {
        config: template,
        runtime,
        definition: failed ? { ...base, unavailableReason: failed } : { ...base, available: true },
      });
    }
  }

  definitions(): ExecutionTargetDefinition[] {
    return [...this.prepared.values()].map((item) => item.definition);
  }

  validationError(target: ExecutionTargetRef, useWorktree: boolean, context: AgentContext, agentId: string): string | null {
    const prepared = this.prepared.get(target.id);
    if (!prepared || target.runnerId !== this.runnerId) return "execution target does not belong to this runner";
    if (target.adapter !== "container" || target.kind !== "container") return "execution target requires an unsupported adapter";
    if (!useWorktree || target.workspaceStrategy !== "worktree") return "container targets require an isolated worktree";
    if (context.kind !== "native") return "container targets require a native agent context";
    if (!prepared.config.agentCommands[agentId]) return `container target does not configure agent '${agentId}'`;
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
    const agent = prepared.config.agentCommands[agentId];
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
