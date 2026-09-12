# Job: Duplicate Abstraction Unification

Find near-duplicated abstractions that have drifted apart and should be one thing.

This is the highest-risk category. Unifying two things that are only superficially alike breaks
callers in ways tests may not catch. Bias hard toward reporting fewer, more certain findings.

## Ground Truth

Start mechanically, then verify semantically:

- `npx -y jscpd --min-lines 25 --min-tokens 120 --reporters console --silent apps packages scripts`
  for literal and near-literal duplication (point `--output` at the scratch directory, never the
  repository's default `./report`);
- `git grep -n "^export \(async \)\?function \|^export const \|^export class \|^export type \|^export interface " -- 'apps/**' 'packages/**' 'scripts/*.mjs' 'apps/*/scripts/*.mjs'`
  to build a symbol inventory. The `scripts/` trees are part of both passes: plain-`node` scripts
  cannot import `packages/protocol` (its `exports` point at TypeScript source), so constants and
  helpers get re-declared there by necessity, and a sweep scoped to `apps packages` structurally
  cannot see those copies. One run found eight cross-tree name collisions only after widening the
  globs by hand; most were boundary-forced, but that is a conclusion the job must be able to
  reach, not assume. Types and interfaces are included, because the duplicated
  abstractions in this repository are as often shapes as functions (one run's only finding was
  an `interface` the narrower pattern could not match) — then
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
