# Job: Tracker Reconciliation

Find drift between what the issue tracker says and what the repository contains, and clean up the
residue that concurrent issue work leaves behind.

## Ground Truth

**Tracker against repository.** For each recently closed issue (`gh issue list --state closed
--limit 30`), read its acceptance criteria and check each one against the merged code. Partial
delivery is the common failure: an issue closed by a PR that implemented most of the checklist.
For each open issue, check whether it was already fixed incidentally by other work.

**Repository hygiene.** Check for the residue of the issue workflow:

- merged or deleted remote branches still present locally — `git branch -vv | grep ': gone]'`;
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

## Report

Two sections.

**Delivery drift** — for each closed issue with unmet criteria: the issue number, the specific
criterion, and the evidence it is unmet. For each open issue already fixed: the issue number and the
commit or PR that fixed it.

**Hygiene** — the exact branch and worktree cleanup commands you would run, with a note on any
worktree holding uncommitted changes. Present them for the human to run; do not run them.
