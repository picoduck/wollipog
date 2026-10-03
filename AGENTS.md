# Agent Instructions

## UI Copy

- Use Title Case for all non-prose visible button text and UI labels, including navigation items,
  tabs, menu items, field labels, compact section labels, badges, table headers, and definition
  terms. Preserve established acronyms and intentionally all-caps text.
- Use standard title casing: capitalize the first and last word and all principal words; keep short
  articles, coordinating conjunctions, and prepositions lowercase unless they are first or last.
- Keep complete sentences, helper text, descriptions, warnings, validation messages, tooltips, and
  user-authored content in normal sentence case.
- Accessible names for controls must match the visible convention even when the control is icon-only.

## Agent Skills

- `skills/` holds skills shipped to Wollipog users (`using-wollipog`, `orchestrate-issues`). Keep
  them free of repository-specific workflow; they must work in any project.
- Every release ships `skills/` as built-in Skill Library entries. After changing anything under
  `skills/`, run `pnpm generate:built-in-skills` and commit the regenerated
  `apps/control-plane/src/built-in-skills.generated.ts`.
- `.agents/skills/` holds contributor-only skills for this repository. Read
  `skills/using-wollipog/SKILL.md` when working with Wollipog's agent-facing tools.

## Stylesheet Debt Inventory

- `apps/web/src/stylesheet-guardrails.test.ts` compares the stylesheet's measured debt with the
  inventory in `apps/web/src/stylesheet-debt/`: one file per recorded entry, so concurrent branches
  that pay down different entries delete different files and merge without conflicts.
- Never edit that directory by hand. After paying debt down, run `pnpm regenerate:stylesheet-debt`
  and commit the result in the same commit. New debt is fixed in the source, not by regenerating.
- To resolve a conflict or a rebase that touches the inventory (including a branch that still edits
  the retired `stylesheet-debt.json`), drop that side's inventory changes, run
  `pnpm regenerate:stylesheet-debt` on the resolved tree, and commit what it writes.

## GitHub Issues

- When asked to draft, report, log, file, or create a GitHub issue, read and follow
  `.agents/skills/log-github-issue/SKILL.md` and `.github/ISSUE_REPORTING.md`.
- Do not publish an issue until the user approves the exact sanitized repository, title, body, and
  labels. After publication, read the issue back and return its verified link.

## Merge Queue and CI

`main` is protected by the `main: merge queue` ruleset: squash merge method, linear history, and a
pull request required. `gh pr merge <n> --squash` therefore does not merge — it enqueues, and GitHub
re-runs the checks against a merge group before landing the commit. Never pass `--delete-branch`
when enqueueing: the merge happens later, and deleting the branch early closes the pull request.

Exactly one status check is required: **`Typecheck, Test & Sidecar Bundle`**. It is an aggregator —
it reports only once the parallel jobs it summarises have finished, so it appears late, and until
then `gh pr checks <n> --required` prints `no required checks reported`.

That message is ambiguous, and only one of its readings means "keep waiting". **Check the base
branch first**, because that is what decides whether anything is required at all:

- **Into `main`, workflow running.** The aggregator is coming. The message means *pending*, never
  passing, so it is not a green light — wait.
- **Into any other branch.** The ruleset covers only the default branch, so no check is required
  here and the message is permanent. CI still runs — `.github/workflows/ci.yml` has no branch filter
  on `pull_request` — so jobs will appear and pass while `--required` stays empty forever. The job
  list cannot tell you which case you are in; the base branch can.
- **Draft pull request.** PR jobs admit `draft == false` or `ready_for_review`; the latter also
  admits a stale draft payload. Other draft events skip all jobs, including the aggregator.
  Skipped is not pending: waiting will not help. Mark it ready for review, which re-triggers CI.
- **No run at all.** Waiting cannot resolve this, whatever the cause — a fork pull request awaiting
  approval, a pull request GitHub cannot build a merge ref for, an explicit skip directive, and
  others. Do not enumerate; find out why this pull request has no run and fix that.

On admitted PR runs, the aggregator uses `!cancelled()` so whole-workflow cancellation can cancel it.
While the PR workflow remains active, failed, cancelled, or skipped dependencies still reach its
failure-reporting shell. Non-PR aggregation remains unconditional, including after cancellation.
See `docs/ci-aggregation.md` for the exact predicate and verification limits.

`Browser End-to-End Tests` is the long pole at roughly 20–30 minutes, and the merge group re-runs it,
so expect that wait twice: once on the branch and once after enqueueing.

The `Platform Isolation` jobs are not required. A failure there does not block the merge, but it
should be explained rather than ignored — check whether it reproduces on the base commit before
attributing it to your change.
