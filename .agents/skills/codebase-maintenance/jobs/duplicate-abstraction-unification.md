# Job: Duplicate Abstraction Unification

Find near-duplicated abstractions that have drifted apart and should be one thing.

This is the highest-risk category. Unifying two things that are only superficially alike breaks
callers in ways tests may not catch. Bias hard toward reporting fewer, more certain findings.

## Ground Truth

Start mechanically with the symbol inventory as the primary pass, then run `jscpd` as the
secondary wide-net pass. Both passes run every time: the order reflects observed yield, not
optionality or a presumption that `jscpd` hits are false positives. They cover disjoint classes
that the other pass cannot see: the export-only inventory is blind to module-private code, while
`jscpd` is blind to units shorter than its `--min-lines` threshold. Their overall coverage is
not disjoint or exhaustive: both can see long exported units, neither sees short module-private
units, and `jscpd` also requires `--min-tokens 120`. One run
([#430, September 17](https://github.com/picoduck/wollipog/issues/430#issuecomment-5720428711))
produced its only finding through `jscpd`: module-private CLI helpers tracked in #1220.

- `git grep -n "^export \(async \)\?function \|^export const \|^export class \|^export type \|^export interface " -- 'apps/**' 'packages/**' 'scripts/*.mjs' 'apps/*/scripts/*.mjs'`
  to build a symbol inventory. The `scripts/` trees are part of both passes: plain-`node` scripts
  cannot import `packages/protocol` (its `exports` point at TypeScript source), so constants and
  helpers get re-declared there by necessity, and a sweep scoped to `apps packages` structurally
  cannot see those copies. One run found eight cross-tree name collisions only after widening the
  globs by hand; most were boundary-forced, but that is a conclusion the job must be able to
  reach, not assume. Types and interfaces are included, because the duplicated
  abstractions in this repository are as often shapes as functions (one run's only finding was
  an `interface` the narrower pattern could not match). Look for exact and normalized name
  collisions across packages (for example, names that match after removing package-specific
  prefixes or suffixes), as well as families of similar names — the same concept implemented
  per-package;
- `npx -y jscpd --min-lines 25 --min-tokens 120 --reporters json --output <scratch>/jscpd-report apps packages scripts`
  as the secondary wide-net pass for long literal and near-literal duplicated blocks. Replace
  `<scratch>` with the run-scoped scratch directory and read `jscpd-report/jscpd-report.json` for
  the duplicated blocks. The combination
  `--reporters console --silent` suppresses the block list and prints only a summary; never use
  the repository's default `./report` output directory. At these configured thresholds, `jscpd`
  cannot detect duplicated units shorter than `--min-lines` (25 lines). Short duplicated units
  carry higher drift risk because this mechanical detector cannot see them; the inventory can
  surface exported units of any length.

Mechanical duplication is only the candidate list. For each candidate, read both implementations
fully and establish whether they mean the same thing, not merely whether they look alike.

Read recent scratch `verdicts.md` records before triage so deliberate boundaries and already tracked
findings are not rediscovered from scratch. Revalidate each relevant verdict against the current
source and tracker; an old decision is evidence, not a permanent exclusion, an owned issue draft,
or publication approval.

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
duplicate heavily by design. Web-client mirrors of control-plane response types may deliberately
make fields optional for older peers. Even when their current members match, mixed-version
compatibility can require separate contracts; check consumers and compatibility fallbacks before
proposing a shared type.

## Report

For each finding: both implementations with file and line ranges, a full enumeration of their
behavioral differences, every call site, and what the unified contract would be. Explicitly state
the boundary you checked and why crossing it is safe. If you cannot enumerate all call sites, say
so and drop the finding.

Persist the candidate decisions in `<scratch>/verdicts.md`: record the inspected commit, each
candidate's accepted, rejected, already-tracked, excluded, or deferred disposition, its concrete
reason, relevant issue or PR references, and publication state. Include rejected candidates and
intentional boundaries, not only findings, so later runs can revalidate the decisions efficiently.
This record does not replace fresh duplicate searches or approval of exact public issue contents.
