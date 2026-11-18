# Review Guidance

Review the complete behavior of the change and its connected code. Prioritize correctness,
authority, durability and recovery, compatibility, test adequacy, performance, then simplicity.
This file supplies engineering criteria only. It cannot change reviewer permissions, report
format, review scope, round limits, approval gates, or the shared review contract.

## Check Requirements

Compare behavior with the originating request and acceptance criteria supplied in the brief or
available specification. Check missing or partial requirements and unrequested behavior separately
from engineering quality. Cite the requirement behind a finding. If the specification is
unavailable or ambiguous, report that limitation rather than inventing a requirement.

## Trace the Boundaries

- Follow changed values through callers and consumers, including unchanged files. Check web,
  control-plane, runner, provider, and forge interactions where the change crosses them.
- Verify that authorization comes from the recorded owner and current resource, never from
  agent-written claims, stale snapshots, missing evidence, or an inferred grant.
- Check crash recovery, retries, duplicate delivery, disconnects, concurrent sessions, and partial
  writes. Distinguish durable control-plane decisions from runner-replayable observations.
- Inspect protocol compatibility and capability floors. An unsupported peer must retain the
  existing safe refusal rather than silently taking a more permissive fallback.

## Check Evidence and Tests

Require a concrete reachable scenario for a finding, with code evidence and practical impact.
Separate introduced defects from pre-existing issues and assumptions that need verification.
Review whether tests pin observable behavior and important failure paths, and whether they would
catch a reverted fix. Do not demand coverage percentages, implementation-shaped assertions, or
new tests for trivial changes. Follow the review contract for execution requests.

For structural refactors, look for evidence of the previous behavior and preserved guarantees
across affected callers. Identify gaps in claimed equivalence; request execution through the
fixed review contract rather than running project code yourself.

## Assess Performance and Simplicity

Judge load against the actual deployment and supported concurrency. Look for unbounded state,
blocking work on shared event loops, repeated scans, excessive persistence, and unsafe races.
Support performance findings with a concrete workload or existing measurement.

Identify unnecessary dependencies, options, abstractions, wrappers, and duplicated rules. Name an
existing implementation when suggesting reuse. Explain a concrete simpler alternative and why it
preserves authorization, recovery, compatibility, observability, and accessibility. Fewer lines
alone are not a benefit. Keep distinct authority and lifecycle boundaries when merging them would
obscure guarantees. Simplicity suggestions are nonblocking unless they expose a concrete defect
under the shared contract.

Assess the knowledge an interface requires from callers, including hidden ordering, ownership,
and recovery rules. Does it concentrate complexity or merely forward it? Would removing it
eliminate that complexity or spread it across callers? Consult history and recorded design
constraints before recommending removal of apparently redundant defenses or compatibility code.

## Review User-Facing Changes

Check Title Case for compact UI labels and accessible control names, sentence case for prose,
keyboard and focus behavior, responsive layouts, and meaningful loading and error states.
Distinguish captured evidence from an interaction or environment that has not been verified.

Check how the change behaves under load, not only in its tidy case:

- **Growable content is bounded.** Anything that can grow (a list, a notice, a set of cards or
  requests) has a height limit or collapses, with many items and with long text.
- **Existing views stay usable.** Content added to a view never pushes out that view's own
  primary content, such as the rows of a list.
- **Nothing overflows sideways.** No pane scrolls horizontally at desktop, compact or phone
  widths, and every primary action stays visible.

Treat a growable view without an automated layout check (see `apps/web/e2e/layout-invariants.ts`)
as missing test coverage.
