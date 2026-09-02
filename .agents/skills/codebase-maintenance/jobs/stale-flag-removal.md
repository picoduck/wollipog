# Job: Stale Flag Removal

Find fully-resolved conditionals still carried as configuration: feature gates that are always on,
config keys nothing reads, and compatibility shims whose floor has moved.

## Ground Truth

Enumerate the candidate surfaces:

- feature flags and gates — `git grep -n "features\.\|feature flag\|enabled:" -- 'apps/**' 'packages/**'`,
  and the `features` block in runner configuration;
- config keys — every key defined in configuration types and example configs, cross-referenced
  against readers with `git grep`;
- protocol compatibility shims — `git grep -n "runnerSupportsProtocol\|protocolVersion"` and compare
  each version floor against the current protocol version in `packages/protocol`;
- environment variables — `git grep -n "process\.env\." | sort -u` against what is documented and set.

For each candidate, determine whether both sides of the condition are still reachable.

## Gate

- A config key is stale only when no reader exists anywhere, including docs, tests, example configs,
  and the desktop Rust sources.
- A protocol shim is stale only when the minimum supported runner version is provably above its
  floor. Check `docs/` for the stated support window before concluding this. Getting this wrong
  breaks mixed-version deployments, which is the most expensive failure in this repository.
- A feature gate is stale only when it is set in one direction everywhere it is set, and nothing
  reads it from user-controlled configuration.

## Known False Positives

A flag with no current callers may be a deliberate kill switch. A protocol shim may exist for
runners the repository still supports even if none are connected on this machine. Environment
variables consumed only by deployment scripts will look unreferenced from application code.

The "floor has moved" half of the protocol-shim category is unprovable by construction: this
repository states no minimum supported runner protocol version anywhere in `docs/` (per-capability
floors exist in `docs/runner-updates.md`, but no support window or drop policy). Do not spend the
protocol budget re-deriving that absent window each week. The one shim finding this job CAN prove
is a capability-floor entry with no reader at any version — a `RUNNER_CAPABILITY_MIN_PROTOCOL` key
that nothing passes to `runnerSupportsProtocol` or reads directly — so put the protocol budget
there. (Two runs confirmed the absent window; the second found exactly such an unread floor.)

## Report

For each finding: the flag or key, every definition and reader, the evidence it is fully resolved,
and the code that deletion would simplify. Say explicitly which supported version window you checked
for any protocol shim.
