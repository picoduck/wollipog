# Job: Tracker Reconciliation

Find drift between what the issue tracker says and what the repository contains, and clean up the
residue that concurrent issue work leaves behind.

## Ground Truth

**Tracker against repository.** For each issue closed since the previous run of this job (the
last successful execution's start time), up to 60, read its acceptance criteria and check each one
against the merged code. Split the reading across read-only helper agents when the count is large;
the 2026-09-25 run found 148 closures in a week and a fixed 30-issue window left 118 unchecked.
Select by close date, not creation date:

```
gh issue list --state closed --limit 100 --json number,title,closedAt,body \
  --jq 'sort_by(.closedAt) | reverse | .[0:30]'
```

`gh issue list --state closed --limit 30` on its own orders by creation, so an old issue closed
this week falls outside the window while a young one crowds in. One run's window silently
omitted eleven issues closed in the same three days, among them the one whose merged fix
explained the entire hygiene backlog it was reporting. Partial delivery is the common failure: an
issue closed by a PR that implemented most of the checklist. For each open issue, check whether it
was already fixed incidentally by other work. When checking whether a symbol an issue names is
gone, never pipe `git grep` through `head`: alphabetical path order can fill the window with hits
from an unrelated package and read as "already removed". Scope the grep to the paths the issue
names, or count the matches.

**Repository hygiene.** Check for the residue of the issue workflow:

- merged or deleted remote branches still present locally — `git branch -vv | grep ': gone]'`.
  Match a branch to its pull request by commit, not by name: a branch whose tip equals a merged
  PR's `headRefOid`, or is an ancestor of one, is merged even when its name never appeared on a
  PR (resumed `agent/<session>_resume` branches, renamed branches such as
  `issue-1600-scrub-container-setup-env` for #1625). Name matching labelled 19 merged branches
  "no PR" on 2026-09-25;
- worktrees whose branch is merged or gone — `git worktree list` cross-referenced against each
  branch's pull request state (`gh pr list --head <branch> --state merged`). Do NOT use
  `git branch --merged main`: `main` is governed by a squash merge queue, so a merged branch's tip
  is never an ancestor of `main` and `--merged` never lists it (the first post-queue run had to
  discover this and override the old instruction). For the same reason the cleanup command for a
  merged branch is `git branch -D`, not `-d`;
- local branches with no corresponding open PR that are fully merged into `main`;
- open PRs with no linked issue, and issues claimed by an assignee with no activity for over a week.

## Gate

- An acceptance criterion is unmet only when you can show the specific behavior is absent from the
  merged code. Reading the PR description is not sufficient; check the code.
- Never delete a branch or worktree. This job reports; the human decides. A worktree that looks
  abandoned may hold uncommitted work — check with `git -C <worktree> status --porcelain` and say
  what you found.
- Worktrees under `~/.wollipog-dev/` were created by Wollipog sessions and are tracked by the
  control plane. Recommend retiring those with `wollipog worktree discard`, never with
  `git worktree remove`, so the control plane's records stay consistent; only worktrees beside the
  repository (`../wollipog-worktrees/`) are plain git worktrees.
- Do not reopen issues or comment on them. Report only.
- The 7-day line exclusion applies to candidate *findings* in working code, not to checking
  whether a closed issue was delivered. A closed issue whose PR marks a criterion delivered is
  checkable the day it merges; recency there is not a sign of unfinished work.
- The control plane's session listing stops at 100 sessions even with `archived: true`. Look up
  worktree owners it does not return one at a time with `get_session` before calling a session
  unknown.

## Report

Two sections.

**Delivery drift** — for each closed issue with unmet criteria: the issue number, the specific
criterion, and the evidence it is unmet. For each open issue already fixed: the issue number and the
commit or PR that fixed it.

**Hygiene** — the exact branch and worktree cleanup commands you would run, with a note on any
worktree holding uncommitted changes. Present them for the human to run; do not run them.
