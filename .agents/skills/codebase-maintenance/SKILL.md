---
name: codebase-maintenance
description: Run one scheduled codebase-maintenance job (dead code, useless tests, stale flags, duplicate abstractions, coverage gaps, docs freshness, flaky tests, dependency bumps, tracker reconciliation) as an unattended read-only sweep that ends in a sanitized issue draft awaiting approval. Use when an automation or user asks to run a named maintenance job for this repository.
---

# Codebase Maintenance

Each job is a narrow, evidence-anchored sweep that runs on a schedule with no human watching it
start. The prompt that launches a job is one sentence; this file and the job file are the harness
that make the result trustworthy.

Read `jobs/<job-id>.md` for the job you were asked to run. That file defines the scope, the tools
that produce ground truth, and the gate a finding must pass. This file defines everything the jobs
share.

## Phase 1: Report Only

Every job currently runs in report-only mode. A job investigates and drafts; it never changes the
repository and never publishes.

Hard rules:

1. Do not edit, create, or delete any file in the workspace. Do not commit, branch, stage, stash,
   push, or open a pull request.
2. Do not run installs, migrations, formatters, code generators, or any command whose purpose is to
   change the tree. Analysis tooling that writes only to caches, `node_modules/.cache`, or the
   scratch directory below is allowed. Put every scratch file under one run-scoped directory,
   `~/.cache/wollipog-maintenance/<job-id>-<YYYY-MM-DD>/` (create it with `mkdir -p`) — date-keyed
   rather than random, so a resumed run can re-derive its own path. Two hard-won properties of
   this location: it survives a reboot, unlike `/tmp`, which this machine wipes at boot — so the
   raw evidence behind a report stays inspectable until the report is reviewed; and it is
   namespaced per run, because a session that loses its conversation context can otherwise find
   another session's files and mistake them for its own — which happened, and turned one lost
   session into a false "already published" claim. At the start of each run, delete directories
   under `~/.cache/wollipog-maintenance/` older than 30 days; nothing else cleans this location.
3. Before finishing, run `git status --porcelain` and `git stash list`. The working tree must be
   exactly as you found it. If anything changed, say so explicitly at the top of your report and
   name the files rather than quietly reverting.
4. Do not publish a GitHub issue. Drafting and publication are separated by the gate in
   `.github/ISSUE_REPORTING.md`, and an unattended run cannot satisfy it.

Promotion to Phase 2 (opening pull requests) is a deliberate change, not a judgment call a job may
make on its own. See "Promotion Criteria" below.

## Anchor Every Finding in Ground Truth

A finding that rests only on reading code is a guess. Each job file names the tool that proves its
category — static analysis, coverage data, test runs, `git log`, `gh`. Run it, and cite what it
returned.

For every finding, record:

- the exact file and line range;
- the tool output or command that demonstrates it, not a paraphrase;
- what you checked to rule out the obvious false positive named in the job file.

Prefer reporting three findings you verified over twenty you inferred. A job that reports nothing
has succeeded, and is far more useful than one that manufactures work.

## Do Not Fight Work in Progress

Skip anything that a human is already touching:

- files changed by an open pull request (`gh pr list --state open` then `gh pr diff`);
- files with uncommitted changes or that differ from `origin/main`;
- LINES added or modified in the last 7 days, which are usually deliberate and unfinished rather
  than abandoned. Judge this per finding with `git blame` on the exact candidate lines, not per
  file: in an active repository, `git log --since='7 days ago' --name-only` excludes most of the
  tree because unrelated lines in the same files moved. (The first two runs of these jobs each
  hit that independently — one lost 363 files, the other 28 of 76 documents — and both fell back
  to per-line blame; that fallback is now the rule.) The file-level listing remains useful as the
  cheap first pass for spotting where recent work is concentrated.

Say what you excluded and why. Silent exclusion reads as coverage you did not have.

## Do Not Re-Report

These jobs run every week and will rediscover the same things.

1. Search existing issues before drafting: `gh issue list --label maintenance --state all --limit 100`,
   plus a term search over open and closed issues for the specific symbol, file, or dependency.
2. If an open issue already covers a finding, do not draft a new one. Note the issue number and
   move on. Add materially new evidence to your report only when the evidence changes the picture.
3. If a closed issue rejected a finding, treat that as a decision. Do not resurface it unless the
   surrounding code changed since the issue closed, and say what changed.

## Scope to the Budget

Every automation has a cost and tool-call ceiling. If the full sweep will not fit, narrow it
deliberately — one package, one directory, the highest-signal slice — and state plainly which parts
of the codebase you did not examine. Never let a partial sweep read as a complete one.

## Output

End with a single report. Structure it as:

1. **Job and scope** — which job ran, what it covered, what it deliberately skipped.
2. **Tree state** — the result of the `git status --porcelain` check.
3. **Findings** — each with its evidence, or an explicit "no findings" line.
4. **Already tracked** — findings suppressed as duplicates, with issue numbers.
5. **Issue drafts** — for genuinely new findings, the exact sanitized title, body, and labels,
   following the format and public-content rules in `.github/ISSUE_REPORTING.md`. Use the
   `maintenance` label plus `bug` or `enhancement`. Title each draft `Maintenance: <summary>`.

Present each draft using the Approval Preview Formatting rules in `.github/ISSUE_REPORTING.md`.
Never wrap a body that may contain code fences in a fixed three-backtick fence.

Then stop. Publishing happens only when a human replies with approval; at that point follow
`.agents/skills/log-github-issue/SKILL.md` to create and verify the issue.

Sanitize before drafting, not after. These runs read a local checkout on a personal machine, so
home-directory paths, hostnames, and device names will appear in tool output. Replace them with
`<private-path>` and `<host>`.

## Promotion Criteria

A job may move to Phase 2 only after its category has a sustained record: findings from at least two
weeks of runs reviewed, and roughly 70% or more accepted as real. Below that, the job is a noise
source and should be retuned or disabled instead of promoted.

Phase 2 adds, per job: an isolated worktree, one concern per pull request, a diff cap of about
150-300 lines, the full test suite green, cross-model review through the `codex-review` skill for
convergence jobs, and the Definition of Done from the `issue-workflow` skill. No job auto-merges.

## The Deletion and Generation Jobs Must Agree

`useless-test-deletion` removes tests and `coverage-gap-fill` adds them. They share one definition of
a worthwhile test, stated in both job files: a test earns its place only if it would fail when the
behavior it covers is broken. If you find yourself proposing a test that the other job would delete,
or deleting one that the other would recreate, report the conflict instead of acting on it.
