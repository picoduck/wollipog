# Job: Duplicate Abstraction Unification

Find near-duplicated abstractions that have drifted apart and should be one thing.

This is the highest-risk category. Unifying two things that are only superficially alike breaks
callers in ways tests may not catch. Bias hard toward reporting fewer, more certain findings.

## Ground Truth

Start mechanically, then verify semantically:

- `npx -y jscpd --min-lines 25 --min-tokens 120 --reporters console --silent apps packages` for
  literal and near-literal duplication;
- `git grep -n "^export function \|^export const \|^export class "` to build a symbol inventory, then
  look for families of similar names across packages — the same concept implemented per-package.

Mechanical duplication is only the candidate list. For each candidate, read both implementations
fully and establish whether they mean the same thing, not merely whether they look alike.

## Gate

A finding qualifies only when:

- the two implementations have the same contract — same inputs, same outputs, same error behavior,
  same edge-case handling. Enumerate the differences explicitly; if any difference is behavioral,
  the abstractions are not duplicates;
- unifying them does not cross a deliberate boundary. Control plane, runner, protocol, and web are
  separated on purpose. Duplication that exists to keep `packages/protocol` dependency-free, or to
  keep the runner independent of control-plane internals, is intentional;
- every call site is enumerated and would behave identically under the unified version.

## Known False Positives

Test helpers that look alike across packages are usually fine as they are. Two state machines with
the same shape and different invariants are not duplicates. Generated or schema-derived code will
duplicate heavily by design.

## Report

For each finding: both implementations with file and line ranges, a full enumeration of their
behavioral differences, every call site, and what the unified contract would be. Explicitly state
the boundary you checked and why crossing it is safe. If you cannot enumerate all call sites, say
so and drop the finding.
