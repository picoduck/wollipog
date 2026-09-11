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
it reports only once the parallel jobs it summarises have finished, so it appears late. While those
jobs run, `gh pr checks <n> --required` prints `no required checks reported`. On a PR into `main`
with a run in progress that means *pending*, not passing, so it is never a green light.

That string is ambiguous, though, and the other readings mean "waiting will not help":

- The ruleset applies only to the default branch. A PR into any other branch — a release branch, for
  example — has no required checks at all, so the message is permanent and no aggregator will ever
  appear.
- A workflow that never started prints it too, including while a fork PR waits for approval to run.

So confirm which case you are in with plain `gh pr checks <n>` before waiting. Jobs listed as
`pending` mean the aggregator is coming. An empty list means it is not, and the base branch and
workflow state are what to check next.

`Browser End-to-End Tests` is the long pole at roughly 20–30 minutes, and the merge group re-runs it,
so expect that wait twice: once on the branch and once after enqueueing.

The `Platform Isolation` jobs are not required. A failure there does not block the merge, but it
should be explained rather than ignored — check whether it reproduces on the base commit before
attributing it to your change.
