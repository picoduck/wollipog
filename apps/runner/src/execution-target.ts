import type { ExecutionTargetRef, SessionLaunchSpec } from "@wollipog/protocol";
import type { RunnerExecutionIsolation } from "./config.js";
import type { ContainerTargetRegistry } from "./container-target.js";
import type { CloudTargetRegistry } from "./cloud-target.js";

export function validateHostExecutionTarget(
  target: ExecutionTargetRef | undefined,
  runnerId: string,
  useWorktree: boolean,
  isolation: RunnerExecutionIsolation,
): string | null {
  if (!target) return null; // rolling compatibility with pre-v60 control planes
  const strategy = useWorktree ? "worktree" : "in_place";
  const expectedId = `runner:${encodeURIComponent(runnerId)}:host:${strategy}`;
  if (target.runnerId !== runnerId || target.id !== expectedId) return "execution target does not belong to this runner";
  if (target.adapter !== "host" || (target.kind !== "local" && target.kind !== "ssh")) {
    return "execution target requires an unsupported adapter";
  }
  if (target.workspaceStrategy !== strategy) return "execution target workspace strategy conflicts with the launch";
  if (target.boundaries.filesystem !== (useWorktree ? "worktree" : "host")) {
    return "execution target filesystem boundary conflicts with the launch";
  }
  if (target.boundaries.network !== isolation.network) return "execution target network boundary is stale";
  if (target.boundaries.secrets !== "runner_local" || target.boundaries.billing !== "agent_account") {
    return "execution target secret or billing boundary is unsupported for a host launch";
  }
  return null;
}

export function executionTargetLaunchError(
  spec: Pick<SessionLaunchSpec, "executionTarget" | "executionHandoff" | "useWorktree" | "context" | "agentId" | "config" | "acpSessionContext">,
  runnerId: string,
  isolation: RunnerExecutionIsolation,
  containerTargets?: ContainerTargetRegistry,
  cloudTargets?: CloudTargetRegistry,
): string | null {
  if (spec.executionTarget?.adapter === "container") {
    if (!containerTargets) return "execution target requires an unsupported container adapter";
    if ((spec.acpSessionContext?.additionalDirectories?.length ?? 0) > 0 ||
        (spec.acpSessionContext?.mcpServers?.length ?? 0) > 0) {
      return "container targets do not permit ACP additional directories or MCP servers";
    }
    return containerTargets.validationError(
      spec.executionTarget,
      spec.useWorktree,
      spec.context ?? { kind: "native" },
      spec.agentId,
    );
  }
  if (spec.executionTarget?.adapter === "cloud") {
    if (!cloudTargets) return "execution target requires an unsupported cloud adapter";
    if ((spec.acpSessionContext?.additionalDirectories?.length ?? 0) > 0 ||
        (spec.acpSessionContext?.mcpServers?.length ?? 0) > 0) {
      return "cloud targets do not permit ACP additional directories or MCP servers";
    }
    return cloudTargets.validationError(
      spec.executionTarget,
      spec.useWorktree,
      spec.context ?? { kind: "native" },
      spec.agentId,
      spec.config,
    );
  }
  if (spec.executionHandoff) return "execution handoff is valid only for a cloud target";
  return validateHostExecutionTarget(spec.executionTarget, runnerId, spec.useWorktree, isolation);
}
