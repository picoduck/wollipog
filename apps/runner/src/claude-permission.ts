import type { SessionConfig } from "@wollipog/protocol";

/** One source of truth for structured-driver permission transport. Orchestrators always use the
 * runner-owned Default control channel; strict isolation is enforced by the sandbox and handler. */
export function effectiveClaudePermissionMode(
  config: Pick<SessionConfig, "permissionMode">,
  _strictProjectIsolation = true,
): string {
  return config.permissionMode === "orchestrator"
    ? "default"
    : config.permissionMode || "acceptEdits";
}
