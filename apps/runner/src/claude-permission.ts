import type { SessionConfig } from "@wollipog/protocol";

/** One source of truth for the provider mode used when the session leaves the picker unset. */
export function effectiveClaudePermissionMode(
  config: Pick<SessionConfig, "permissionMode">,
  strictProjectIsolation = true,
): string {
  return config.permissionMode === "orchestrator"
    ? strictProjectIsolation ? "dontAsk" : "default"
    : config.permissionMode || "acceptEdits";
}
