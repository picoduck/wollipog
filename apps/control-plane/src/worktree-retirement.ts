import { RUNNER_CAPABILITY_MIN_PROTOCOL, runnerSupportsProtocol } from "@wollipog/protocol";

/**
 * What a managed discard reports when the answering runner predates durable deferred retirement.
 *
 * A v159+ runner answers a discard it cannot complete immediately with a durable receipt
 * (`deferred`), which the caller may simply wait on. An older runner has no journal to write, so
 * it answers the same situation with an ordinary retention error that is indistinguishable from a
 * dirty tree or an unpushed branch: nothing was recorded, and nothing will replay it.
 *
 * `unsupported` states that difference. It is control-plane-originated and never crosses the
 * runner wire — a runner reports `removed`, `deferred`, or, on an older build, nothing at all.
 */
export interface UnsupportedWorktreeRetirement {
  status: "unsupported";
  reason: "legacy_runner";
}

/**
 * Turn a legacy peer's ambiguous retention refusal into an explicit result with a recovery step.
 *
 * Returns null when the runner can report retirement itself, so a capable peer's refusal is
 * relayed exactly as it was given. The capability is only consulted for a discard that already
 * failed: a legacy runner still discards an idle worktree perfectly well, and that path keeps
 * working untouched.
 */
export function legacyPeerWorktreeRetirement(
  protocolVersion: number | null | undefined,
  runnerError: string,
): { error: string; retirement: UnsupportedWorktreeRetirement } | null {
  if (runnerSupportsProtocol(protocolVersion, "sessionWorktreeRetirement")) return null;
  const reported = Number.isInteger(protocolVersion)
    ? `v${protocolVersion}`
    : "an unknown version (pre-v15, malformed, or not reported)";
  return {
    error: `${runnerError} — this runner reports protocol ${reported}, and durable deferred ` +
      `worktree retirement requires v${RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRetirement}. ` +
      "No retirement was recorded, so this refusal will not replay on its own: retry the discard " +
      "once the session's provider has exited, or update and restart the runner to receive a " +
      "durable receipt instead.",
    retirement: { status: "unsupported", reason: "legacy_runner" },
  };
}
