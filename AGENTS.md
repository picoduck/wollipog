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
- **No workflow run at all.** Draft pull requests deliberately do not consume runners (CI triggers
  on `ready_for_review`), and a fork pull request waits for approval to run. Nothing is pending, so
  waiting will not help — mark it ready, or get the run approved.

`Browser End-to-End Tests` is the long pole at roughly 20–30 minutes, and the merge group re-runs it,
so expect that wait twice: once on the branch and once after enqueueing.

The `Platform Isolation` jobs are not required. A failure there does not block the merge, but it
should be explained rather than ignored — check whether it reproduces on the base commit before
attributing it to your change.
