/**
 * Why Native TUI cannot be launched here, or `undefined` when it can.
 *
 * The dialog used to render six mutually exclusive `<span className="muted">` sentences below the
 * Harness group, each guarded by its own condition, while the option itself was `disabled` — so the
 * control said "unavailable" in one place and the reason lived in another, and a screen-reader user
 * tabbing to the group never met the two together. `nativeTuiSupported` was assembled from the same
 * conditions a second time, which is how one of them came to have no sentence at all: an agent that
 * needs setup disabled the option silently.
 *
 * One function, one order, and availability derived from it — the same shape
 * `orchestratorUnavailableReason` uses, for the same reason: a disabled control whose explanation
 * disagrees with why it is disabled is worse than one that says nothing.
 *
 * Ordered most-actionable first. Where several apply the user has to clear them all, and the ones
 * they can act on without changing what they are launching come first.
 */
export function nativeTuiUnavailableReason(input: {
  /** The control plane advertises the launch surface at all. */
  launchSupported: boolean;
  /** The chosen agent is installed and usable — a setup-pending agent cannot launch anything. */
  agentReady: boolean;
  /** Whether the session will run under the Orchestrator permission preset. */
  orchestrator: boolean;
  orchestratorTuiSupported: boolean;
  /** Orchestrator Native TUI requires a native host context, not WSL. */
  orchestratorTuiHostContext: boolean;
  /** The runner advertises a Claude Code or Codex agent on a supported OS. */
  runnerSupported: boolean;
  startFenceSupported: boolean;
  hostExecutionTarget: boolean;
  /** Capability sentences the caller resolves from the runner's protocol version. */
  orchestratorTuiRequirement: string;
  startFenceHint: string;
}): string | undefined {
  if (!input.launchSupported) return "Native TUI launch requires a newer control plane.";
  // Before the orchestrator branches: an agent that cannot start at all is the user's first
  // problem, and it is the condition that previously disabled the option with no sentence.
  if (!input.agentReady) return "This agent needs setup before it can launch a Native TUI session.";
  if (input.orchestrator && !input.orchestratorTuiSupported) return input.orchestratorTuiRequirement;
  if (input.orchestrator && !input.orchestratorTuiHostContext) {
    return "Orchestrator Native TUI is unavailable for WSL agents. Use a native host.";
  }
  if (!input.runnerSupported) {
    return "Native TUI requires a supported Claude Code or Codex agent on a Windows or Linux runner.";
  }
  if (!input.startFenceSupported) return input.startFenceHint;
  if (!input.hostExecutionTarget) return "Native TUI currently runs only on the host execution target.";
  return undefined;
}
