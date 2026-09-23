import type {
  AgentContext,
  ExecutionHandoffArtifactRef,
  ExecutionHandoffRequest,
  ExecutionHandoffReceipt,
  ExecutionTargetDefinition,
  ExecutionTargetRef,
  TargetHarnessInstallation,
  RunnerView,
} from "@wollipog/protocol";

export type HostExecutionTargetSource = Pick<RunnerView, "runnerId" | "hostname" | "status" | "runtime">;

function validateTargetHarnessInstallations(
  value: ExecutionTargetDefinition["harnessInstallations"],
  compatibleAgentIds: string[],
  provenance: TargetHarnessInstallation["provenance"],
): TargetHarnessInstallation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 288) throw new Error("runner advertised too many target harness installations");
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || !compatibleAgentIds.includes(item.agentId) || !/^[a-f0-9]{24}$/.test(item.id) || ids.has(item.id) ||
        !/^\/[A-Za-z0-9_./+-]{1,255}$/.test(item.path) || item.path.split("/").includes("..") ||
        item.provenance !== provenance ||
        (item.version !== undefined && !/^\d+\.\d+\.\d+[\w.-]*$/.test(item.version)) ||
        !["authenticated", "unauthenticated", "unknown"].includes(item.authentication) ||
        !["verified", "unknown"].includes(item.capability) ||
        (item.authenticationEvidence !== undefined &&
          !["claude-auth-status", "codex-login-status"].includes(item.authenticationEvidence)) ||
        (item.capabilityEvidence !== undefined &&
          !["claude-help", "codex-app-server-help"].includes(item.capabilityEvidence)) ||
        (item.authenticationEvidence === "claude-auth-status" && item.agentId !== "claude-code") ||
        (item.authenticationEvidence === "codex-login-status" && !["codex", "codex-exec"].includes(item.agentId)) ||
        (item.capabilityEvidence === "claude-help" && item.agentId !== "claude-code") ||
        (item.capabilityEvidence === "codex-app-server-help" && item.agentId !== "codex") ||
        typeof item.available !== "boolean") {
      throw new Error("runner advertised an invalid target harness installation");
    }
    ids.add(item.id);
    // No concrete cloud adapter supplies an independently checked probe contract yet. Its v2
    // identity proof selects an executable, but cannot substantiate auth or capability claims.
    const probed = provenance === "container-image" && item.available;
    const authentication = probed && item.authenticationEvidence ? item.authentication : "unknown";
    const capability = probed && item.capabilityEvidence ? item.capability : "unknown";
    return { agentId: item.agentId, id: item.id, path: item.path, provenance,
      authentication, capability, available: item.available,
      ...(authentication !== "unknown" ? { authenticationEvidence: item.authenticationEvidence } : {}),
      ...(capability === "verified" ? { capabilityEvidence: item.capabilityEvidence } : {}),
      ...(item.version ? { version: item.version } : {}) };
  });
}

function projectedTargetInstallations(items: TargetHarnessInstallation[], targetAvailable: boolean): TargetHarnessInstallation[] {
  return items.map((item) => targetAvailable ? item : {
    ...item, available: false, authentication: "unknown", capability: "unknown",
    authenticationEvidence: undefined, capabilityEvidence: undefined,
  });
}

function targetId(runnerId: string, workspace: "in_place" | "worktree"): string {
  return `runner:${encodeURIComponent(runnerId)}:host:${workspace}`;
}

export function validateRunnerContainerTargets(
  runnerId: string,
  targets: ExecutionTargetDefinition[] | undefined,
  online = true,
): ExecutionTargetDefinition[] {
  if (targets === undefined) return [];
  if (!Array.isArray(targets) || targets.length > 16) throw new Error("runner advertised too many container targets");
  const ids = new Set<string>();
  return targets.map((target) => {
    const template = target.environment;
    const expectedId = template
      ? `runner:${encodeURIComponent(runnerId)}:container:${encodeURIComponent(template.id)}`
      : "";
    if (target.runnerId !== runnerId || target.id !== expectedId || ids.has(target.id)) {
      throw new Error("runner advertised an invalid or duplicate container target identity");
    }
    ids.add(target.id);
    if (target.kind !== "container" || target.adapter !== "container" || target.workspaceStrategy !== "worktree") {
      throw new Error("runner advertised unsupported container placement semantics");
    }
    if (target.boundaries.filesystem !== "container" ||
        (target.boundaries.network !== "deny" && target.boundaries.network !== "policy") ||
        target.boundaries.secrets !== "none" || target.boundaries.billing !== "none") {
      throw new Error("runner advertised unsupported container boundary claims");
    }
    if (!template || !/^[a-z][a-z0-9-]{0,63}$/.test(template.id) ||
        !Number.isInteger(template.revision) || template.revision < 1 || template.revision > 1_000_000 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}@sha256:[a-f0-9]{64}$/.test(template.image) ||
        !/^[a-f0-9]{64}$/.test(template.setupCheckDigest)) {
      throw new Error("runner advertised an invalid container environment template");
    }
    if (typeof target.name !== "string" || !target.name.trim() || target.name.length > 180 ||
        /[\u0000-\u001f\u007f]/.test(target.name)) {
      throw new Error("runner advertised an invalid container target name");
    }
    const compatibleAgentIds = target.compatibleAgentIds;
    if (!Array.isArray(compatibleAgentIds) || compatibleAgentIds.length < 1 || compatibleAgentIds.length > 32 ||
        compatibleAgentIds.some((agentId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId)) ||
        new Set(compatibleAgentIds).size !== compatibleAgentIds.length) {
      throw new Error("runner advertised invalid container agent compatibility");
    }
    const available = online && target.available === true;
    const harnessInstallations = validateTargetHarnessInstallations(target.harnessInstallations, compatibleAgentIds, "container-image");
    const unavailableReason = online
      ? (available ? undefined : (target.unavailableReason?.trim().slice(0, 300) || "container target is unavailable"))
      : "runner is offline";
    return {
      id: target.id,
      runnerId: target.runnerId,
      name: target.name.trim(),
      kind: "container",
      workspaceStrategy: "worktree",
      adapter: "container",
      boundaries: {
        filesystem: "container",
        network: target.boundaries.network,
        secrets: "none",
        billing: "none",
      },
      environment: {
        id: template.id,
        revision: template.revision,
        image: template.image,
        setupCheckDigest: template.setupCheckDigest,
      },
      compatibleAgentIds: [...compatibleAgentIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      ...(harnessInstallations ? { harnessInstallations: projectedTargetInstallations(harnessInstallations, available) } : {}),
      available,
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  });
}

export function validateRunnerCloudTargets(
  runnerId: string,
  targets: ExecutionTargetDefinition[] | undefined,
  online = true,
): ExecutionTargetDefinition[] {
  if (targets === undefined) return [];
  if (!Array.isArray(targets) || targets.length > 16) throw new Error("runner advertised too many cloud targets");
  const ids = new Set<string>();
  return targets.map((target) => {
    const template = target.environment;
    const expectedId = template ? `runner:${encodeURIComponent(runnerId)}:cloud:${encodeURIComponent(template.id)}` : "";
    if (target.runnerId !== runnerId || target.id !== expectedId || ids.has(target.id)) {
      throw new Error("runner advertised an invalid or duplicate cloud target identity");
    }
    ids.add(target.id);
    if (target.kind !== "cloud" || target.adapter !== "cloud" || target.workspaceStrategy !== "snapshot") {
      throw new Error("runner advertised unsupported cloud placement semantics");
    }
    if (target.boundaries.filesystem !== "snapshot" || target.boundaries.network !== "policy" ||
        target.boundaries.secrets !== "references" || target.boundaries.billing !== "target_metered") {
      throw new Error("runner advertised unsupported cloud boundary claims");
    }
    if (!template || !/^[a-z][a-z0-9-]{0,63}$/.test(template.id) ||
        !Number.isInteger(template.revision) || template.revision < 1 || template.revision > 1_000_000 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}@sha256:[a-f0-9]{64}$/.test(template.image) ||
        !/^[a-f0-9]{64}$/.test(template.setupCheckDigest)) {
      throw new Error("runner advertised an invalid cloud environment template");
    }
    if (typeof target.name !== "string" || !target.name.trim() || target.name.length > 180 || /[\u0000-\u001f\u007f]/.test(target.name)) {
      throw new Error("runner advertised an invalid cloud target name");
    }
    const compatibleAgentIds = target.compatibleAgentIds;
    if (!Array.isArray(compatibleAgentIds) || compatibleAgentIds.length < 1 || compatibleAgentIds.length > 32 ||
        compatibleAgentIds.some((agentId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId)) ||
        new Set(compatibleAgentIds).size !== compatibleAgentIds.length) {
      throw new Error("runner advertised invalid cloud agent compatibility");
    }
    const policy = target.policy;
    const cost = policy?.cost;
    const admission = policy?.admission;
    const validMoney = (amount: unknown) => typeof amount === "number" && Number.isFinite(amount) && amount > 0 && amount <= 1_000_000;
    if (!policy || cost?.currency !== "USD" || !validMoney(cost.estimatedHourlyRateUsd) ||
        !validMoney(cost.minimumBudgetUsd) || !validMoney(cost.maximumBudgetUsd) ||
        cost.minimumBudgetUsd > cost.maximumBudgetUsd || !Number.isInteger(admission?.maxConcurrentSessions) ||
        admission!.maxConcurrentSessions < 1 || admission!.maxConcurrentSessions > 256 || admission?.queue !== "fifo") {
      throw new Error("runner advertised an invalid cloud cost or admission policy");
    }
    const available = online && target.available === true;
    const harnessInstallations = validateTargetHarnessInstallations(target.harnessInstallations, compatibleAgentIds, "cloud-adapter");
    const unavailableReason = online
      ? (available ? undefined : (target.unavailableReason?.trim().slice(0, 300) || "cloud target is unavailable"))
      : "runner is offline";
    return {
      id: target.id,
      runnerId: target.runnerId,
      name: target.name.trim(),
      kind: "cloud",
      workspaceStrategy: "snapshot",
      adapter: "cloud",
      boundaries: { filesystem: "snapshot", network: "policy", secrets: "references", billing: "target_metered" },
      environment: { ...template },
      policy: {
        cost: {
          currency: "USD",
          estimatedHourlyRateUsd: cost.estimatedHourlyRateUsd,
          minimumBudgetUsd: cost.minimumBudgetUsd,
          maximumBudgetUsd: cost.maximumBudgetUsd,
        },
        admission: { maxConcurrentSessions: admission!.maxConcurrentSessions, queue: "fifo" },
      },
      compatibleAgentIds: [...compatibleAgentIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      ...(harnessInstallations ? { harnessInstallations: projectedTargetInstallations(harnessInstallations, available) } : {}),
      available,
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  });
}

export function validateExecutionHandoffReceipt(
  value: ExecutionHandoffReceipt | undefined,
  target: ExecutionTargetRef | undefined,
  expectedRequest?: ExecutionHandoffRequest,
  expectedBudgetUsd?: number,
): ExecutionHandoffReceipt | undefined {
  if (value === undefined) return undefined;
  const policy = target?.policy;
  if (!target || target.adapter !== "cloud" || value.targetId !== target.id || !policy ||
      (value.sourceSessionId !== undefined && (!value.sourceSessionId || value.sourceSessionId.length > 256 || /[\0-\x1f\x7f]/.test(value.sourceSessionId))) ||
      !/^[a-f0-9]{64}$/.test(value.manifestDigest) || !/^[a-f0-9]{64}$/.test(value.adapterHandoffIdHash) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.git?.headCommit ?? "") ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.git?.headTree ?? "") ||
      (value.git.remoteUrlHash !== undefined && !/^[a-f0-9]{64}$/.test(value.git.remoteUrlHash)) ||
      !/^[a-f0-9]{64}$/.test(value.git?.workingTreeDigest ?? "") || typeof value.git?.dirty !== "boolean" ||
      !Number.isInteger(value.git?.untrackedFiles) || value.git.untrackedFiles < 0 || value.git.untrackedFiles > 256 ||
      !Array.isArray(value.artifacts) || value.artifacts.length > 32 ||
      typeof value.budgetUsd !== "number" || !Number.isFinite(value.budgetUsd) ||
      value.budgetUsd < policy.cost.minimumBudgetUsd || value.budgetUsd > policy.cost.maximumBudgetUsd ||
      (expectedBudgetUsd !== undefined && value.budgetUsd !== expectedBudgetUsd) ||
      typeof value.quotedCostUsd !== "number" || !Number.isFinite(value.quotedCostUsd) || value.quotedCostUsd < 0 ||
      value.quotedCostUsd > value.budgetUsd || !Number.isInteger(value.acceptedAt) || value.acceptedAt <= 0) {
    throw new Error("runner advertised an invalid cloud handoff receipt");
  }
  const artifacts = validateExecutionHandoffArtifacts(value.artifacts);
  if (expectedRequest && (value.sourceSessionId !== expectedRequest.sourceSessionId ||
      JSON.stringify(artifacts) !== JSON.stringify(expectedRequest.artifacts))) {
    throw new Error("runner advertised a cloud handoff receipt that does not match its durable request");
  }
  return { ...value, git: { ...value.git }, artifacts };
}

function validateExecutionHandoffArtifacts(value: unknown): ExecutionHandoffArtifactRef[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("cloud handoff artifacts are invalid");
  const ids = new Set<string>();
  const kinds = new Set(["html_preview", "patch", "review_report", "screenshot", "test_log", "verdict"]);
  return value.map((artifact) => {
    if (!artifact || !artifact.artifactId || artifact.artifactId.length > 256 || /[\0-\x1f\x7f]/.test(artifact.artifactId) ||
        ids.has(artifact.artifactId) || !kinds.has(artifact.kind) || !Number.isInteger(artifact.sizeBytes) ||
        artifact.sizeBytes < 0 || artifact.sizeBytes > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error("runner advertised invalid cloud handoff artifact provenance");
    }
    ids.add(artifact.artifactId);
    return { ...artifact };
  });
}

export function validateExecutionHandoffRequest(value: ExecutionHandoffRequest | undefined): ExecutionHandoffRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value.sourceSessionId !== undefined && (!value.sourceSessionId || value.sourceSessionId.length > 256 ||
        /[\0-\x1f\x7f]/.test(value.sourceSessionId)))) {
    throw new Error("cloud handoff request is invalid");
  }
  return {
    ...(value.sourceSessionId ? { sourceSessionId: value.sourceSessionId } : {}),
    artifacts: validateExecutionHandoffArtifacts(value.artifacts),
  };
}

/** Project one existing runner into provider-neutral execution placements. The SSH distinction is
 * control-plane topology, while filesystem/network claims come only from runner-advertised state. */
export function executionTargetsForHost(
  runner: HostExecutionTargetSource,
  sshBox: boolean,
): ExecutionTargetDefinition[] {
  const kind = sshBox ? "ssh" as const : "local" as const;
  const online = runner.status === "online";
  const network = runner.runtime?.executionIsolation?.network ?? "inherit";
  const common = {
    runnerId: runner.runnerId,
    kind,
    adapter: "host" as const,
    available: online,
    ...(online ? {} : { unavailableReason: "runner is offline" }),
  };
  return [
    {
      ...common,
      id: targetId(runner.runnerId, "in_place"),
      name: `${runner.hostname} · in place`,
      workspaceStrategy: "in_place",
      boundaries: { filesystem: "host", network, secrets: "runner_local", billing: "agent_account" },
    },
    {
      ...common,
      id: targetId(runner.runnerId, "worktree"),
      name: `${runner.hostname} · isolated worktree`,
      workspaceStrategy: "worktree",
      boundaries: { filesystem: "worktree", network, secrets: "runner_local", billing: "agent_account" },
    },
  ];
}

export function executionTargetsForRunner(runner: RunnerView, sshBox: boolean): ExecutionTargetDefinition[] {
  return executionTargetsForHost(runner, sshBox);
}

export function executionTargetRef(target: ExecutionTargetDefinition): ExecutionTargetRef {
  const { id, runnerId, kind, workspaceStrategy, adapter, boundaries, environment, policy } = target;
  return { id, runnerId, kind, workspaceStrategy, adapter, boundaries, ...(environment ? { environment } : {}), ...(policy ? { policy } : {}) };
}

export function resolveExecutionTarget(
  runner: RunnerView,
  sshBox: boolean,
  selection: { executionTargetId?: string; useWorktree?: boolean; agentId?: string; agentContext?: AgentContext },
): { target: ExecutionTargetDefinition; useWorktree: boolean } | { error: string } {
  const targets = runner.executionTargets ?? executionTargetsForRunner(runner, sshBox);
  const legacyStrategy = selection.useWorktree ? "worktree" : "in_place";
  const target = selection.executionTargetId
    ? targets.find((candidate) => candidate.id === selection.executionTargetId)
    : targets.find((candidate) => candidate.workspaceStrategy === legacyStrategy);
  if (!target) return { error: "execution target is unknown or does not belong to the selected runner" };
  if (!target.available) return { error: target.unavailableReason ?? "execution target is unavailable" };
  if (selection.agentId && target.compatibleAgentIds && !target.compatibleAgentIds.includes(selection.agentId)) {
    return { error: `execution target does not configure agent '${selection.agentId}'` };
  }
  if ((target.adapter === "container" || target.adapter === "cloud") && selection.agentContext?.kind === "wsl") {
    return { error: `${target.adapter} targets require a native agent context` };
  }
  const useWorktree = target.workspaceStrategy !== "in_place";
  if (selection.executionTargetId && selection.useWorktree !== undefined && selection.useWorktree !== useWorktree) {
    return { error: "executionTargetId conflicts with useWorktree" };
  }
  return { target, useWorktree };
}

/**
 * Choose the execution target a relaunch must carry. A session's workspace strategy is not fixed at
 * creation: an in-place session that later gains a runner-owned session worktree reports
 * `useWorktree` true while its stored target still names the creation-time in-place placement. The
 * runner derives the expected placement from `useWorktree` and refuses that pair, so reconcile the
 * placement to the session's current strategy here — or report why no placement can express it,
 * before any launch is sent.
 */
export function relaunchExecutionTarget(
  runner: RunnerView,
  sshBox: boolean,
  current: ExecutionTargetRef | undefined,
  useWorktree: boolean,
): { target: ExecutionTargetRef | undefined } | { error: string } {
  // Rolling compatibility with sessions launched before targets existed: they carry none, and the
  // runner accepts that absence rather than deriving an expectation from it.
  if (!current) return { target: undefined };
  // Only host placements have both an in-place and a worktree form. Container and cloud targets are
  // isolated by construction, so a session of theirs that lost its worktree has nowhere to relaunch.
  if (current.adapter !== "host") {
    if (useWorktree) return { target: current };
    return {
      error: `this session's ${current.adapter} execution target always runs in an isolated workspace, but the session no longer has one; create a new session on that target instead of restarting this one`,
    };
  }
  const strategy = useWorktree ? "worktree" : "in_place";
  if (current.workspaceStrategy === strategy) return { target: current };
  const targets = runner.executionTargets ?? executionTargetsForRunner(runner, sshBox);
  // Match the adapter too: container targets also advertise the `worktree` strategy, and this
  // session stays on the host placement family it was created with.
  const match = targets.find((candidate) =>
    candidate.adapter === "host" && candidate.workspaceStrategy === strategy);
  if (!match) {
    return {
      error: `runner '${runner.runnerId}' no longer offers a host ${
        useWorktree ? "isolated worktree" : "in place"} execution target for this session`,
    };
  }
  if (!match.available) return { error: match.unavailableReason ?? "execution target is unavailable" };
  return { target: executionTargetRef(match) };
}
