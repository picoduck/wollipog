# Job: Architectural Simplification

Find working code whose structure makes a concrete change or guarantee unnecessarily hard to
understand, implement, or verify. Propose a bounded, behavior-preserving refactor. Follow the
parent skill's report-only rules, freshness checks, exclusions, duplicate searches, verdict
ledger, issue approval, and output format. This job never edits code or opens a refactor PR.

## Scope and Ground Truth

After the parent's fetch, pin the baseline with `baseline_sha="$(git rev-parse origin/main)"`
and record it. Use that exact commit for every history, caller, blame, and source read below;
do not rely on the primary checkout's HEAD or a remote-tracking ref that another session can move.

Use the named subsystem when supplied. Otherwise inspect the pinned baseline's change history
with `git log "$baseline_sha" --since='90 days ago' --name-only --format='%h %s' -- apps packages scripts` and
select one subsystem with recurring maintenance activity. State the scope and selection reason.
Churn prioritizes investigation; it does not establish a defect. Apply the parent skill's
per-line recent-change and open-PR exclusions before admitting candidates. If those exclusions
leave no suitable area, report no findings rather than reviewing active work as abandoned debt.

For each candidate:

- Trace an actual caller through the affected functions, state owners, and externally visible
  result. Use `git grep -n -F '<symbol>' "$baseline_sha" -- apps packages scripts` and
  `git show "$baseline_sha":<path>` for targeted source reads, following
  re-exports, dispatch tables, and dynamic consumers where relevant. Record the caller knowledge
  required: ordering, configuration, ownership, errors, retries, and recovery.
- Investigate why the shape exists with targeted `git blame "$baseline_sha" -- <path>`,
  `git log --follow -p "$baseline_sha" -- <path>`,
  relevant PRs and issues via `gh`, and recorded design decisions or tests. Quote the evidence
  that establishes a constraint; label inferred rationale and missing history explicitly.
- Demonstrate maintenance friction with a historical change, regression, or concrete current
  caller trace: for example, one rule manually synchronized across several paths, a forwarding
  layer that exposes all its internals, or repeated special cases caused by a misplaced owner.
  File size, nesting, number of modules, and similarity alone are not findings.
- Apply the deletion test: if a layer disappeared, would complexity disappear, move into callers,
  or expose a necessary boundary? Sketch a simpler caller usage and the affected responsibilities.
  Favor concentrating rules behind a useful interface; do not introduce a generic framework or
  merge modules solely to reduce their count.

Keep observations and proposals separate. A source trace can establish that callers must repeat
a rule; it cannot prove that a proposed abstraction is better or that a refactor preserves
behavior. Do not claim runtime, performance, or equivalence results that were not executed.
Existing tests may supply evidence when run under the parent skill's execution preflight; this
report-only job does not write new characterization tests or prototypes.

## Admission Gate

Draft a candidate only when all of these are concrete:

- **Burden:** the caller trace or historical change shows an avoidable maintenance cost, with
  baseline commit, exact source locations, commands and relevant output, and affected callers.
- **Rationale:** the proposal accounts for recorded decisions and uncertainty about intent.
  Reopening an intentional design decision requires new evidence of actual friction.
- **Alternative:** name what would move or disappear, show before/after caller usage or a small
  diagram when helpful, and explain which knowledge becomes local. State expected benefits as
  hypotheses, not measured improvements. Enumerate affected callers; defer if their extent is
  unknown rather than claiming a safe migration.
- **Guarantees:** preserve authorization, validation, durability, recovery, mixed-version
  compatibility, observability, and accessibility. Control plane, runner, provider and forge
  state remain distinct authorities. Superficial similarity never justifies combining owners,
  removing boundary checks, or deleting compatibility paths still needed by supported peers.
- **Verification:** identify existing behavioral coverage and gaps. Outline characterization,
  replay, or old-versus-new comparisons needed before restructuring; typechecking alone is
  insufficient. Preserve meaningful tests until replacement coverage owns their guarantees.
- **Scope:** propose one independently reviewable refactor with a clear stopping point. Separate
  bugs, feature requests, and broader redesigns from the behavior-preserving proposal. Do not
  pad the report with speculative candidates or reinterpret a code smell as a correctness bug.

If relevant history establishes a recurring mistake, consider whether a single owner, type,
lint rule, or behavioral test would prevent it more effectively than another written instruction.
Cite actual occurrences and describe how a proposed check would catch one. Do not assert that a
check works until it has been run against the past failure.

## Report and Repeat Runs

Use the parent report format. For each candidate include verified observations, historical
rationale, the proposed alternative, preserved guarantees, verification plan, and limits of the
evidence. Use `enhancement` for a structural proposal unless a separately demonstrated bug
justifies `bug`. Revalidate prior verdicts and tracker references so rejected designs and deliberate
boundaries are not repeatedly proposed without changed evidence. No qualifying findings is success.

## Automation Invocation

A standalone read-only schedule can use this prompt:

> Fetch current origin/main without changing the primary checkout, read its current
> .agents/skills/codebase-maintenance/SKILL.md and jobs/architectural-simplification.md, then run
> architectural-simplification on one eligible Wollipog subsystem. Report evidence-backed
> candidates and sanitized issue drafts only; do not publish, refactor, or launch follow-up work.

The same prompt can be a recurring child task with key `architectural-simplification` and title
`Architectural Simplification`. Adding it to a saved campaign requires an explicit automation
edit; the parent must preserve the investigator's report-only scope and use the campaign's
existing approval and admission gates for any subsequent work. Prefer a weekly pilot with finite
cost/tool ceilings and no overlapping runs. Scheduling is separate from merging this job file.

## Sources

Adapted principles, rather than imported upstream workflows:

- [Ponytail audit](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail-audit/SKILL.md):
  scoped investigation, concrete simplification proposals, and no speculative findings.
- [pstack refactoring](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/refactoring.md)
  and [why](https://github.com/cursor/plugins/blob/main/pstack/skills/why/SKILL.md): behavioral
  contracts and historical rationale before structural changes.
- [Matt Pocock's codebase design](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md):
  caller knowledge, useful interfaces, locality, and the deletion test.
