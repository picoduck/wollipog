# Job: Tracker Reconciliation

Find drift between what the issue tracker says and what the repository contains, and clean up the
residue that concurrent issue work leaves behind.

## Ground Truth

**Tracker against repository.** Review up to 60 closed issues per run against the merged
code, including unfinished reviews carried forward from earlier runs. Split the reading across
read-only helper agents when the count is large. The review cap bounds investigation, not the
number of closures retained: the 2026-10-02 run found 281 closures and reviewed 60; selecting only
the newest 60 and advancing the next run's window would permanently drop the other 221.

**Record the window and retain the backlog.** At launch, write the actual UTC start time to
`run-start.txt` in this run's scratch directory. Use the automation session's `createdAt` for a
resumed run; never replace it with the resume time or infer it from scratch-file mtimes. Before
the shared 30-day scratch prune, load the most recent earlier `closed-issue-audit.json` and carry
its audit state into this run's scratch directory, so an old backlog survives the prune.
The audit artifact records `harvestedThrough`, `pending`, and `reviewed`; each issue entry is
keyed by both `number` and `closedAt`, so a reopened and reclosed issue receives another review.

Harvest closures since the previous audit's `harvestedThrough` (inclusively), then merge them
with its pending entries, preserve its reviewed keys, and exclude closures already reviewed
under the same key. On the first run without an audit artifact,
use the last successful run's recorded start time. If that marker is unavailable, establish the
start from its session metadata or a verified earlier report and disclose the bootstrap boundary.
Set `TRACKER_PREVIOUS_START` to that UTC lower bound. Select by close date, not creation date:

```
gh issue list --state closed --search "closed:>=${TRACKER_PREVIOUS_START}" --limit 300 \
  --json number,title,closedAt,body --jq 'sort_by([.closedAt, .number])'
```

Do not slice this inventory to 30 or 60 before saving it. If the result reaches 300, completeness
is unproven: split the close-time window into smaller searches until each interval returns fewer
than 300 entries. Raising the requested limit is not proof that a search returned everything.
If a saturated interval cannot be split further, use a fully paginated repository issue listing
filtered by close time, or leave the harvest incomplete. Do not advance `harvestedThrough` for an
incomplete harvest. Keep the previous boundary and retrieved pending entries for a later retry.
For a complete harvest, advance the boundary only to this run's recorded start time; overlapping
entries are harmless because of deduplication. Save the merged inventory before investigating.

Review the oldest 60 pending entries first. Update the audit artifact after each completed review,
moving only fully assessed entries to `reviewed`; interrupted or budget-limited entries remain
pending. Fetch the issue's current state and criteria when reviewing a carried entry; record a
reopened issue as superseded and move that closure key to `reviewed` with this outcome. Treat a
confirmed transfer or deletion likewise, without claiming its criteria were delivered; transport
or authorization failures remain pending. Write artifact updates through a temporary sibling and
atomic rename. Report the number reviewed, the remaining pending count, and the oldest pending
close date. If the backlog grows across consecutive runs, recommend exact schedule or capacity
changes sized to the observed inflow; do not silently raise the budget or review cap. A partial
run must never claim a complete reconciliation.

`gh issue list --state closed --limit 30` on its own orders by creation, so an old issue closed
this week falls outside the window while a young one crowds in. One run's window silently
omitted eleven issues closed in the same three days. Partial delivery is the common failure:
an issue closed by a PR that implemented most of the checklist. For each open issue, check whether
it was already fixed incidentally by other work. When checking whether a symbol an issue names is
gone, never pipe `git grep` through `head`: alphabetical path order can fill the window with hits
from an unrelated package and read as "already removed". Scope the grep to the paths the issue
names, or count the matches.

**Assess every criterion before completing a review.** Give each helper the complete issue
body and acceptance criteria, including referenced requirements needed for the verdict. Do not
truncate them to fit a batch: reduce the batch or provide complete files instead. Count helper
tool use alongside the coordinator's tool use against the existing aggregate run budget; track
the combined usage before assigning more work and leave unfinished criteria pending when it runs
out.

Keep a per-criterion assessment with its exact requirement, status, merged revision, evidence and
reasoning. Persist partial and completed criterion assessments on their pending or reviewed audit
entries, using the same atomic-update rule, and carry them forward with the backlog before prune.
Before reusing an assessment, check for changes in its cited implementation and relevant callers
since its recorded merged revision; re-investigate affected requirements. Every code criterion
needs supported evidence: inspect the implementation and relevant
call sites, and explain how their behavior satisfies or fails the requirement, using focused
tests or other ground-truth checks where applicable. A script proving a cited line exists only
checks the reference; it does not prove that code meets the criterion. A helper's `complete` flag
cannot override a missing criterion, an uninvestigated criterion or unsupported evidence. Such an
entry stays pending until the coordinator validates full criterion coverage and support.

Completed assessment and delivered behavior are different: a fully investigated issue may have
unmet criteria. Record verified approved deviations with their decision evidence, and deliberate
later replacements with the merged change that superseded the original behavior; do not report
either as accidental delivery drift. Unknown approval is not an approved deviation. Keep the
separate unverified-process category from the Gate below rather than claiming missing process
evidence proves missing behavior or approval.

For epics, assess the full epic criteria as well as the child requirements. Reuse supported child
code assessments and inspect unresolved pieces in merged code, including cross-child behavior.
Closed checkboxes, merged commit subjects and child closure alone cannot certify epic delivery.

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
- Distinguish absent code behavior from process evidence. For screenshots or approval criteria,
  inspect the issue and PR comments and the originating Wollipog session's evidence and approval
  record when available. Screenshots absent from the PR body do not prove they were never captured
  or approved. If the record cannot be inspected, report the evidence as unverified, not waived.
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
commit or PR that fixed it. List unverified process evidence separately from unmet criteria,
including which evidence source could not be inspected. List verified approved deviations and
deliberate later replacements separately, with their decision or merged-change evidence.

**Hygiene** — the exact branch and worktree cleanup commands you would run, with a note on any
worktree holding uncommitted changes. Present them for the human to run; do not run them.
