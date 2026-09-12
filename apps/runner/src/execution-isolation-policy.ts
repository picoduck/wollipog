import type { AgentContext } from "@wollipog/protocol";
import type { RunnerExecutionIsolation } from "./config.js";

export const WSL_BWRAP_UNAVAILABLE_ERROR =
  "bubblewrap isolation is unavailable for WSL because Wollipog cannot hold target-local no-follow path handles through process launch; use a supported native Linux, container, or cloud execution target";

/** WSL path operands cross a Windows relay before bwrap opens them. Without a target-local helper
 * that resolves and holds no-follow directory descriptors through exec, accepting those names
 * would leave both alias substitution and check/open races. Keep the launch unavailable instead
 * of presenting pathname canonicalization as a security boundary. */
export function assertExecutionIsolationContextSupported(
  policy: RunnerExecutionIsolation,
  context: AgentContext,
): void {
  if (policy.mode === "bwrap" && context.kind === "wsl") {
    throw new Error(WSL_BWRAP_UNAVAILABLE_ERROR);
  }
}
