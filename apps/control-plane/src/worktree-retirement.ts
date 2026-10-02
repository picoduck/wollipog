import {
  runnerCapabilityRequirementError,
  runnerSupportsProtocol,
  type RunnerCapabilityRequirementDetails,
} from "@wollipog/protocol";

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
 *
 * The runner-update sentence is the shared requirement copy, which names no protocol numbers
 * (docs/design-system.md §17.2); the versions travel beside `error` as structured fields.
 */
export function legacyPeerWorktreeRetirement(
  protocolVersion: number | null | undefined,
  runnerError: string,
): ({ error: string; retirement: UnsupportedWorktreeRetirement } & RunnerCapabilityRequirementDetails) | null {
  if (runnerSupportsProtocol(protocolVersion, "sessionWorktreeRetirement")) return null;
  const requirement = runnerCapabilityRequirementError(
    protocolVersion,
    "sessionWorktreeRetirement",
    "deferred worktree retirement",
  );
  return {
    ...requirement,
    error: `${runnerError} — no retirement was recorded, so this refusal will not replay on its own. ` +
      `Retry the discard once the session's provider has exited. ${requirement.error}`,
    retirement: { status: "unsupported", reason: "legacy_runner" },
  };
}
