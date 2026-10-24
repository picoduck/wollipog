---
name: using-wollipog
description: Operate Wollipog sessions from inside an agent session through the injected CLI or the general Wollipog MCP server.
---

# Using Wollipog

For campaign authority, read [Campaign Authority Preflight](references/campaign-authority.md).
It covers effective mode/boundary, exact decision owners, unresolved human gates, and evidence
upload/provider disclosure; it does not authorize a campaign or change installed policies.

Use the `wollipog` command when it is on `PATH`. A Wollipog-hosted session supplies
`WOLLIPOG_CONTROL_PLANE_URL`, `WOLLIPOG_SESSION_ID`, and a protected token file automatically; do
not print, copy, or pass that token on the command line.

Core commands:

```text
wollipog session list --json
wollipog session get <session-id> --json
wollipog session events <session-id> [--after <seq> [--event-epoch <n>]] [--limit <n>] --json
wollipog session capabilities --runner <id> --agent <id> [--offset <n>] [--limit <n>] [--include-hidden] --json
wollipog session capabilities --runner <id> --agent <id> --model <id> --json
wollipog session create --runner <id> --agent <id> --workspace <id> --prompt <task> [--model <id>] [--effort <level>] --json
wollipog session prompt <session-id> <message> --json
wollipog session wait <session-id> --for input_required,completed,failed,stopped --json
wollipog session stop <session-id> --json
wollipog session stop-job <session-id> <job-id> --json
wollipog pr wait <number|owner/name#number|host/group/project!iid|url> [--head <sha>] [--timeout <ms>] --json
wollipog review session run --repo <owner/name> --pr <number> --head <sha> --brief-file <path> [--full-reason <text>] --json
wollipog review session get <review-session-id> --json
wollipog artifact attach --file <absolute-path> [--name <display-name>] --json
wollipog worktree create --branch <name> [--base <ref>] --json
wollipog worktree attach --path <absolute-path> --json
wollipog worktree select --path <absolute-path> --json
wollipog worktree discard --path <absolute-path> --json
wollipog worktree delete-refs [--path <absolute-path>] --ref <ref>=<object-id> [--ref ...] --json
wollipog decision request --request-id <id> --resource-key <key> --snapshot '<json>' --json
wollipog decision get <occurrence-id> [--session <descendant-id>] --json
wollipog decision list [--session <descendant-id>] [--limit <1-100>] [--cursor <occurrence-id>] --json
wollipog decision consume <occurrence-id> --snapshot '<json>' [--action '<json>'] --json
wollipog decision reconcile <occurrence-id> --snapshot '<json>' --json
```

Without `--after`, `session events` returns the newest `--limit` events (default 30, maximum 100).
To read a long range, such as everything a child did since a known point, page forward: start with
`--after 0`, or with a seq you already read together with the `eventEpoch` it came from, then repeat
with `--after <lastSeq> --event-epoch <eventEpoch>` from the previous page until `hasMore` is false.
`historyIncomplete` means the control plane has not yet loaded the whole log, so later events may
exist: keep the returned `lastSeq` and retry later instead of treating the page as the end. If the
call fails because the event history was replaced, restart from `--after 0` without the old epoch.
Each event is one summary line capped at 400 characters, so a long message is truncated. The MCP
`get_session_events` tool takes the same `after`, `limit`, and `eventEpoch`.

Every event read stays paged while history hydrates; a short or empty incomplete page is not the
end of the log. Without `--after`, an incomplete result is the newest cached window, so retry
without `--after` for the true newest window once hydration catches up. Direct HTTP reads of
`GET /api/sessions/:id/events` default to 200 events when `limit` is omitted; use `nextAfter` and
`eventEpoch` to continue rather than treating one response as the whole log.
Protocol-222 runners use the bounded reader throughout hydration. Update older CLI/MCP
installations before upgrading a control plane that serves default pages: an old reader's
whole-log fallback can mistake a bounded first page for the newest window. Identifiable old
agent-session fallbacks fail with runner-upgrade guidance; paired-device CLI calls need the
same upgrade-first migration because their human credentials do not identify the reader version.

`session stop-job` (MCP `stop_background_job`) ends one unfinished background job of a child
session by its id, which `session get` lists as `unfinishedBackgroundJobs`. Use it when a job that
never ends, such as a monitor whose condition never fires, keeps a finished sibling's result or a
queued handoff waiting. Only that job ends and is recorded as killed; the child's conversation, its
other jobs, and its queued prompts are kept. If the provider does not confirm the stop in time, the
job is left running; should it end later, it is still recorded as your stop, so do not repeat the
request just to be named. `session stop` and `session restart` end every job
instead: a stop discards the queued prompts, while a restart keeps them and runs them after it, but
starts a new Claude Code conversation. Only the session's owner and its controlling Orchestrator may
use `stop-job`.

An Orchestrator campaign must use the management tools as the policy boundary, not infer authority
from its prompt. Call `get_campaign` at campaign start and after a human changes policy. It returns
the effective behavior, typed decision owners, revision, admission and guardrail limits, child and
follow-up counts, UI-review compatibility, and one of `waiting_human`, `active`, `blocked`, or
`verified_complete`, without returning credentials.

The Orchestrator role defaults to **Delegate Implementation**: plan, delegate, monitor, and review.
An ordinary request covering several issues does not authorize a campaign or child creation unless
the human explicitly asks for orchestration or delegation. A parent may maintain permitted planning
artifacts directly. If the human explicitly asks the parent to implement, first inspect open child
assignments and pull requests for overlap, then create and select a dedicated Wollipog worktree for
the parent and follow the repository's normal testing, review, UI evidence, merge, and
cleanup workflow. Provider permissions and governance still apply throughout.

**Strict Project Isolation** is a separate human-controlled execution setting. New sessions default
to it being disabled. When enabled, project locations are OS-enforced read-only, the parent works
only in session-private scratch, and parent implementation and self-worktree operations are refused.
The required `bwrap`, Seatbelt, or audited provider boundary is checked before launch. Existing
Orchestrator sessions without an execution-policy field are treated as strict and cannot relax
themselves.

Every child creation receives a server-derived campaign-policy block in its initial assignment.
For Automatic model or effort, use `get_agent_capabilities` and send the selected pair in the same
`create_session` call; fixed values are server-enforced. The block is not blanket approval. Children
must use `request_workflow_decision`, `get_workflow_decision`, and `consume_workflow_decision` for
implementation questions, PR merge, merged-branch deletion, follow-up publication, and UI evidence.
When those MCP tools are unavailable, use the equivalent self-scoped `wollipog decision request`,
`get`, and `consume` commands above; the exact resource snapshot and optional PR-merge action are
JSON objects. The CLI refuses `--session` for request, consume, and reconcile and exposes no resolution operation.
Read-only `get_workflow_decision` accepts an optional `sessionId`; `list_workflow_decisions`
enumerates pending and approved decisions with optional `sessionId`, `limit`, and `cursor`.
Omitting the target reads self. An Orchestrator can target an accessible descendant, with access
to both sessions required. Exact reads include terminal states; a 404 never proves consumption.
Follow `nextCursor` until absent. Pages reflect current state, so decisions settled during paging
may disappear; read a known occurrence exactly when its outcome matters.
Descendant reads and lists require control plane protocol v214. Older runners without the tool
can use an updated CLI or the read-only HTTP endpoints
`GET /api/sessions/:id/workflow-decisions/:occurrenceId` and
`GET /api/sessions/:id/workflow-decisions?limit=50&cursor=<occurrence-id>` with their existing
session credential where a token is provisioned. Provider-isolated sessions hold only a runner
relay key, which cannot authenticate direct HTTP calls; upgrade the runner/CLI for the tools rather
than seeking a bearer token. Older control planes expose only pending requests through
`list_descendant_requests`; update them for authoritative descendant state inspection.
Only the current owner may resolve the exact pending occurrence. Authentication, secrets,
persistent grants, governance changes, budget increases, and tool guardrails remain human-only.
Separate human-established budget authority may permit bounded managed-worker reservations and
allocations; never infer it from a campaign name or use an unmetered worker to evade accounting.
A stop or restart revokes every decision the session has not consumed. After a restart the session
receives a `[Wollipog Session Restart]` message naming each revoked occurrence: do not act on an
earlier approval of it, and request again what you still need.
If an exact armed PR merge command already succeeded but its approved occurrence remained
unconsumed, use `reconcile_workflow_decision` (or `wollipog decision reconcile`) with that
occurrence's unchanged resource snapshot.
It never reruns the command. For a Codex App Server child it proves the exact completed admission,
provider command, and merged forge head; resume the same App Server session first. A Claude Code
child's enqueue produces no permission receipt in auto or Full Access mode, so call it once the
forge reports the PR merged; its proof is that merged approved head. Treat any unavailable or
mismatched proof as a blocker rather than requesting a replacement approval or replaying the action.

Keep the campaign work ledger current (control plane protocol v196+; `wollipog campaign …` from the
CLI). Every record lands in the root campaign, including from a nested Orchestrator:

- `record_campaign_plan` upserts work items by a stable key (issue or planned slice) with dispatch
  state, queue position, and dependencies; set `planComplete` once the original scope is listed.
- Pass `campaignWorkItemId` to `create_session` (`session create --work-item`, protocol v220+) so the
  child's attempt is recorded before its first prompt; if the attempt cannot be recorded, no child is
  created.
  Verify the actual client schema. On a Custom host lacking that input, a read-only bootstrap may
  verify configuration before the supported assignment operation binds the original work item;
  select the dedicated worktree before releasing implementation. This fallback is not atomic
  creation and cannot bypass required protected admission. Missing assignment support is a blocker,
  not permission to update the hosting stack or invent an input.
- `assign_campaign_work_item` records which descendant works on an item. Reusing a child for another
  item or moving an item to another child opens a new attempt; earlier attempts keep their
  verification and accounting.
- `update_campaign_work_item` records reported stages, blockers, next actions, cancellations, and
  scope removals, and closes a failed or abandoned attempt with `endAttempt` so the item waits for
  dispatch again. A reported stage is a claim: `merged` does not mark the item delivered. Name the
  item's pull requests in the stage (`pullRequests`); Wollipog observes their GitHub review,
  checks, and merge-queue state separately, through the runner's `gh` login, beside your claim.
  For GitLab merge requests it observes approvals, the head pipeline, and merge-train state
  through the runner's `glab` login, so do not poll `glab` from your own turns to watch them.
- Issue and pull request refs are `{repository, number}`. A GitHub repository is `owner/repo`. A
  GitLab project names its host and full namespace (`gitlab.example.com/group/subgroup/project`),
  never a bare path; `number` is the issue or merge request IID. Older control planes refuse
  GitLab refs, and older runners leave them unobserved.
- `adjudicate_campaign_recommendation` records accepted, rejected, deferred, or duplicate for a
  recorded follow-up; pass `originWorkItemIds` when recording it.
- `get_campaign_work_items` reads the summary and a page or one item. Restart from the first page
  when a cursor is refused because the ledger changed.

These records grant no authority: they never dispatch, publish, merge, or resolve a decision.

Record each proposed follow-up with `record_campaign_follow_up` before starting it. Server-side
repository/title normalization deduplicates recommendations across children. `Recommend Only`
returns `recommend_only_stop` and ends at reporting. `Execute Approved` returns
`requires_typed_gates` only for a unique recommendation; that disposition is not approval, and
publication, UI evidence, merge, and deletion still require their separate
typed decisions plus sanitization, dependency checks, cross-model review, and exact-head CI. An
enqueued pull request remains unfinished until merge-group CI passes and the forge reports actual
`MERGED` state; continue supervising unrelated children while any one child waits for a human gate.

Once a child is Idle or Completed, use its exact completed report event sequence with
`verify_campaign_child` and attest that follow-ups were recorded. Pass `workItem` (`delivered` or
`incomplete`) to record delivery of the child's assigned work item; idleness, a closed issue, or an
enqueued merge never does. `Retain` keeps it visible.
`Stop and Archive` starts the durable stop/archive operation and automatically requests managed
retirement of each clean, fully delivered runner-owned child worktree when the runner supports it.
Check `get_campaign.cleanupWorktrees`: pending, provider-deferred, and safety-refused paths all
block Verified Complete. Safety-refused paths stay on disk with a per-child reason and are not
retried automatically; resolve their safety condition and explicitly discard them.
An older runner leaves cleanup pending and requires the explicit recovery shown in that reason.

Worktree commands default to `WOLLIPOG_SESSION_ID`; paired-device callers add `--session <id>`.
Creation without `--base` fetches the repository's remote default branch. Use the returned path
for file and Git commands in the current turn; a later provider launch resumes in the selection.
Discard permanently removes only a runner-owned worktree that is not used by a live provider, is
clean, and has no commits ahead of its upstream. A forge-verified merged head may replace an
upstream deleted with the remote branch, but only when it exactly matches the local head, whatever
the pull request branch is named. An unchanged recorded branch may instead prove its stable head is
contained by the current remote-tracking default branch. Discard refuses attached, dirty, other
upstream-less, or unpushed trees. Push a worktree branch with upstream tracking, for example
`git push -u origin HEAD:<branch>`, so the tree stays retirable without forge recovery.

Child creation may select a supported model and reasoning effort in the same request. Explicit
values apply before the initial prompt and override saved harness defaults; read the effective pair
back from the creation result or `session get`. Omit `--effort` to retain default resolution. An
explicit effort requires protocol v138, and a current client fails closed against older components
instead of retrying without it.

Use `session capabilities` (the MCP equivalent is `get_agent_capabilities`) before selecting a
child model or effort. It returns paginated installation-specific models, labels per-model versus
harness fallback efforts, distinguishes unavailable discovery from no configurable effort, and
excludes hidden models unless explicitly requested. Follow `page.nextOffset` until `truncated` is
false; creation still revalidates the chosen pair against current discovery.

## Waiting for Pull Request Checks

Wait for a pull request's required checks or merge-queue outcome with one blocking call, not a
polling loop: `wollipog pr wait <pr> --head <reviewed-sha> --timeout <ms> --json`, or the MCP tool
`wait_pull_request`. The runner polls GitHub through this machine's `gh` login, read-only, so no
model request happens while it waits. It returns once with an `outcome` (`checks_passed`,
`checks_failed`, `no_required_checks`, `merged`, `closed`, `queue_failed`, `queue_ejected`,
`head_changed`, or `timeout`) and a bounded summary: head SHA, each required check, merge-queue
position and state, failed jobs with run links, and whether it merged.

- Required checks come from the base branch's rules. One that has not been reported yet is
  `pending`, never passing, so the wait does not end early the way `gh pr checks --required --watch`
  does while an aggregator check is unreported. A base with no required checks returns at once.
- A GitLab merge request works the same way: pass its URL, `<gitlab-host>/group/project!<iid>`, or
  the IID with the project including its host as the repository. The runner reads it through this
  machine's `glab` login and returns when its head pipeline or merge-train pipeline finishes, it
  leaves the train, merges, closes, or its head moves. Only a successful pipeline passes; a skipped
  pipeline, or one waiting for a manual action, returns `checks_blocked`.
- Use the longest timeout one call can survive in your harness (up to 3 hours) and call again on
  `timeout`. A background shell command that wakes you on exit can use the maximum; an MCP call or
  foreground command must finish inside the harness's tool-call limit.
- In Codex, use the `wait_pull_request` MCP tool rather than a shell `pr wait`, which Codex checks on
  through the model. Its per-call limit is 3 hours 1 minute, so any `timeoutMs` up to the 3-hour
  maximum fits. Without the `wollipog` MCP server (an older runner, or your own server under that
  name), Codex's default limit is 5 minutes: keep `timeoutMs` at or below the 4-minute default.
- The wait grants nothing. Enqueueing, retrying, and merging keep their existing gates. After
  enqueueing, wait again: only `merged` means landed; `queue_failed` means GitHub marked the entry
  unmergeable and `queue_ejected` that it left the queue without merging. A failed merge-group
  check alone keeps the wait going, because GitHub may rebuild the group and still merge it.
- CLI exit status: 0 for `checks_passed`, `merged`, or `no_required_checks`; 3 for other outcomes;
  124 for `timeout`; 1 when GitHub could not be read.
- Where the command or tool is missing (an older runner) or `gh` cannot read the repository, fall
  back to one long blocking shell loop that sleeps minutes between checks.

## Review Sessions

Use a review session for the required cross-model review of your own pull request, including from
an isolated campaign child. Push first, then request it through MCP `request_review_session`
(`repository`, `number`, `headSha`, `brief`) or the CLI:

```text
wollipog review session run --repo <owner/name> --pr <number> --head <sha> --brief-file <path> --json
```

The runner launches the other model family as its own read-only Wollipog session against a private
checkout of exactly that pushed head. It never writes to your worktree or loads the repository's
settings, hooks, skills or MCP servers. The pull request must be open, from your project's
repository, on your managed worktree's branch, with `headSha` equal to its current pushed head.
The brief supplies intent, acceptance criteria, applicable invariants and verification already run;
reuse it for later requests. Preserve your workflow's reviewer, isolation and admission requirements.

- Automatic launch worktrees keep their existing identity. If an older session lacks launch proof,
  resume it once so the runner can verify its worktree before requesting a review.
- The request returns `reviewSessionId` at once. Continue independent work, or end your turn and
  wait: a finished review delivers a `[Wollipog Cross-Model Review — …]` continuation once you are
  idle. There is no need to poll mid-turn. On continuation, read `get_review_session` or
  `wollipog review session get <id> --json` for the full `verdict`, `output` report and `findings`.
  Use that read to recover a missing continuation; where continuations are unavailable, poll every
  minute or two until `terminal` is true. `get_session_events` exposes the reviewer's transcript.
- Only a validated, valid report's vote and findings count. After an invalid attempt, request the
  same head again to retry that round within its attempt limit; `verdict.consumed: false` does not
  use an attempt. Preserve invalid attempts and costs. Older runners that return no verdict have
  not supplied a validated
  review. Prove every finding yourself, record its adjudication as your workflow requires, fix only
  verified defects, then commit and push before requesting the next round. Check the actual head:
  `stale` flags a newer review of another head, not every intervening push.
- Reviews of one pull request form a run. The first round reviews it in full; later rounds review
  the changes since the last valid head with its open findings. Add `--full-reason <text>` (MCP
  `fullReason`) only when a full re-review is needed. A rebased or force-pushed head that no longer
  descends from the reviewed head starts a new epoch, reviewing the range-diff with carried
  findings (in full if the earlier commits are unavailable). Each epoch starts with 4 valid rounds,
  each round with 2 counted attempts. Stop after an upvote on the current head; an upvoted or
  unchanged reviewed head is refused. A changed head needs review under the applicable workflow.
- If an epoch exhausts its rounds without an upvote, stop and request a typed
  `review_round_extension` decision, once, using `request_workflow_decision` or `decision request`.
  Use resource key `review_round_extension:<owner/name>#<number>:epoch-<epoch>:rounds-<roundsUsed>`
  and snapshot fields `category`, `repository`, `pullRequest`, `epoch`, `headSha`, `roundsUsed`,
  `blockingFindings` (the last valid report's open blocking count), `extraRounds` (1–4) and `reason`.
  Read the exact decision's owner and outcome; it is human-owned by default and requires an
  explicit grant to delegate. Consume an approval with the unchanged snapshot immediately before
  the matching review request; the next review request also consumes an approved extension.
  An extension adds rounds to that epoch; it does not raise the per-round attempt or cost limits.
  Missing typed support or an exhausted attempt limit is a blocker, not a reason to switch routes.
- Campaign members request their own review sessions through the same interface. Campaign
  charging requires a compatible runner (protocol 232 or later): the server reserves allowance
  before launch and records actual Session usage against the campaign allowance when one exists.
  Exhausted, stopped or unavailable allowances refuse admission with a reason. Original human
  cost ceilings still apply across review attempts. Reviews take no session or child slot.
  Report admission or budget refusals; never use a native subprocess or the bridge to bypass them.
- One review session is active per requester at a time; `review session list` lists them and
  `review session cancel` stops one. A review session takes no messages; request a new one after
  pushing a new head. An upvote grants no merge authority or exemption from exact-head CI.

## Cross-Model Review Through the Runner (Fallback)

Use the older bridge only when the runner predates review sessions or refuses them with a version
reason: `wollipog review run --repo <owner/name> --pr <number> --head <sha> --brief-file <path>
--json` (MCP `request_cross_model_review`). It runs the installed controller against a private
snapshot of your own pushed pull request. Poll `review get <job-id> --json`
(`get_cross_model_review`) every minute or two until `terminal`, then read its summary, report and
read-only ledger and adjudicate the findings. Later rounds reuse the brief and review deltas;
`--scope full --full-reason <text>` requests a full review. Controller round/attempt limits apply.
A campaign member with an allowance cannot use this bridge; it requests its own review session
through `request_review_session` instead. Missing reviewer/trust, admission, budget or review-limit refusals are
blockers; do not switch routes or launch a reviewer inside the session to evade them.

## Private Session Artifacts

Session artifacts let authorized users view screenshots and short videos remotely, including when
connected from another device. The runner uploads the file directly to private control-plane
storage; the bytes do not pass through the model context. Attaching does not assign this skill or
change any hosting preference.

Supported managed harnesses receive capability and preference guidance with ordinary tasks after launch or resume.
Native slash-command turns preserve provider input; guidance arrives with the next ordinary task.
Native TUI sessions have no reliable additive mechanism for updating mutable upload preferences;
use explicit task instructions or this opt-in skill there. Awareness alone grants no transfer authority.

Honor the session's **Artifact Uploads** preference and explicit task/project instructions:

- **Manual** is the default. Upload only when the user requests it or applicable project
  instructions authorize it. Discovering the capability grants no upload authority.
- **Use Wollipog Automatically** authorizes relevant task evidence, such as a screenshot documenting
  a UI fix, never arbitrary filesystem files. Explicit hosting requirements still take precedence.
- **Use External Hosting** follows the user's configured external workflow. Do not fall back to
  Wollipog, invent a destination, or provision credentials when that workflow is missing.

Where the session's capability guidance lists the MCP tool, attach a completed file with
`attach_session_artifact` and an **absolute** `path`, optionally a `name`. Otherwise use the injected
CLI (the path must be readable in the session's execution context):

```sh
"$WOLLIPOG_CLI" artifact attach --file /absolute/path/after-desktop.png --name "Desktop After" --json
"$WOLLIPOG_CLI" artifact attach --file /absolute/path/interaction.webm --json
```

On native Windows use the PowerShell launcher form from the section below, followed by
`artifact attach --file <absolute-path> --json`. Never put base64 media into a tool argument.
PNG, JPEG, GIF, and WebP images are limited to **8 MiB** each; MP4 and WebM videos to **32 MiB** each.
Content is validated independently of the filename. Screenshots require a protocol-v169 control
plane; videos require v186. Unsupported contexts and older peers must be updated or use the user's
explicit external workflow; do not invent a working upload command.

A successful attachment returns metadata only: `artifactId`, `mediaType`, `sizeBytes`, and `sha256`.
Cite the returned values exactly, for example in a UI-evidence item with `evidenceId`, `artifactId`,
`mediaType`, and `sha256`. Refer to the Session artifact in your report; it is available in the
Session's artifact panel to authorized users. An artifact id is not a public URL, and attaching a
file does not approve evidence or a merge. External evidence URLs and review rules remain valid.
Attach the exact completed capture you intend to cite. Re-attaching an unchanged identical file
returns the existing artifact; a changed file needs new metadata and any applicable new review.
Keep files within the authorized task scope and respect privacy, retention, and approval policies.

## Deleting Refs From an Isolated Session

In a sandboxed session, Git may be unable to delete any ref, because it cannot take
`packed-refs.lock` in the read-only shared Git directory. A `git rebase` or `git cherry-pick` then
prints that lock error yet finishes, but leaves `CHERRY_PICK_HEAD` or `AUTO_MERGE` behind, so
`git status` still reports a cherry-pick in progress; `git cherry-pick --quit`, `git branch -d` and
`git update-ref -d` fail the same way. Do not delete those files by hand. Ask the runner instead,
with `wollipog worktree delete-refs` or the `delete_worktree_refs` MCP tool, giving each ref with
the object id it holds now (`git rev-parse <ref>`):

```text
wollipog worktree delete-refs --ref CHERRY_PICK_HEAD=<object-id> --ref AUTO_MERGE=<object-id> --json
```

It deletes only this session's refs: a worktree's `CHERRY_PICK_HEAD`, `REVERT_HEAD` and
`AUTO_MERGE` (not while a rebase or merge is in progress; after an interrupted cherry-pick
sequence, run `git cherry-pick --quit` first), and `refs/heads/<branch>` or
`refs/remotes/<remote>/<branch>` for a branch Wollipog recorded for this session's worktrees, once
no worktree has it checked out. A changed value deletes nothing; refs already gone are reported as
absent. `--path` names another of this session's worktrees; the default is the selected one. Only
Linux runners with bubblewrap support it; other runners refuse, and then the leftovers stay until a
person removes them. While it deletes a branch, a checkout or commit in another worktree of the
repository can fail briefly on `HEAD.lock` or `index.lock`; retry it. The result lists every
deleted ref with the object id it held.

## Retiring a Worktree

Remove a Wollipog-created worktree only with `wollipog worktree discard` (or the `discard_worktree`
MCP tool). Never run `git worktree remove` against a session-linked path, and never offer it as the
cleanup command in a report: raw Git deletes the directory without telling the control plane, so the
session keeps selecting a path that no longer exists and its next launch refuses to start there.

Discard is deliberately conservative. When the tree is still in use — including the one this
session is running in — it records a durable deferred retirement and reports what provider boundary
it is waiting for. That is not a failure: report the deferred path and reason in the cleanup summary
and leave it alone. The runner resumes retirement after provider exit and removes the worktree only
when its ownership, cleanliness, publication, and pull-request safety checks pass.

A squash-merged branch whose upstream is missing or already deleted still retires when the forge
reports a merged change request whose head is exactly the worktree's tip: a GitHub pull request, or
a GitLab merge request on gitlab.com or on a self-managed host that `glab` is configured for in the
session's context. So deleting the remote branch before or after retirement both work.

If `wollipog` is not on `PATH`, use the injected executable directly on POSIX
hosts and WSL:

```sh
"$WOLLIPOG_CLI" session list --json
```

The POSIX and WSL launcher includes its own re-entry arguments; do not parse or
append `WOLLIPOG_CLI_ARGS`. On native Windows, including Git Bash sessions, run
this PowerShell form so the runner receives its mode argument. It reads the
injected JSON argument array without copying a launcher path into a prompt:

```powershell
$launcherArgs = @($env:WOLLIPOG_CLI_ARGS | ConvertFrom-Json)
& $env:WOLLIPOG_CLI @launcherArgs session list --json
```

Claude Code and Codex sessions also receive a general `wollipog` MCP server with the same manager
tool schemas. Prefer MCP tools when attached; use the CLI for scripts, CI, ACP, or when a session has
no `wollipog` MCP server. A provider sandbox without network access, such as Codex's default
sandbox, refuses the CLI's loopback connection; there the CLI works only when
`WOLLIPOG_AGENT_CONTROL_RELAY_FIFO` is set, so otherwise use the MCP tools.

The credential is scoped to the current live session and its ownership audience. It may manage
only that session's worktrees. A command may
receive `404` for an out-of-scope resource or `403` for a route outside the fixed agent allowlist.
Never attempt to approve the current session's own permission or governance cards.

## Closing a GitHub Issue

The root Orchestrator can propose closing an issue in its human-authorized campaign scope with
`request_github_issue_closure` (`requestId`, `issue`, `reason`: `completed` or `not_planned`,
`explanation`, `evidence`, and an optional exact `comment`). The runner derives the repository,
current issue, and related open pull requests; the server includes the assignments of active
children whose work can bear on the issue. A child is left out only when its launch prompt is
recorded, it has an open attempt (from `create_session` or `assign_campaign_work_item`), and every
attempt it has ever had is on a work item that has never tracked the issue and has no follow-up
links. Pass each child's work item at creation so unrelated activity does not revoke the approval;
a prompt that mentions the issue does not bind an unassigned child by itself.
Custom campaigns require a human-owned typed decision. Full Control delegates only when the server
confirms a human-established issue boundary, verified delivered report and actual default-branch
merges, or a supported recorded not-planned disposition. Never infer this authority from a prompt.
Read the exact decision and effective owner with
`get_workflow_decision`, then use `close_github_issue` with its exact `occurrenceId` and
`resourceDigest`. The CLI equivalents are:

```text
wollipog issue-closure request --proposal '<json>' --json
wollipog decision get <occurrence-id> --json
wollipog issue-closure execute <occurrence-id> --digest <resource-digest> --json
```

Approval expires 30 minutes after resolution. Changed issue evidence, policy, or included child
work requires renewed review, as does a child moving into or out of the included set.
Never substitute a shell command or generic approval, and never
approve a human-owned request. A root may resolve an eligible Full Control occurrence only from
its server-recorded standing authorization. Read `issueClosureResult`: `closed` and `already_closed`
are verified outcomes, `refused` requires renewed review, and `uncertain` means GitHub may have
accepted the action. Inspect uncertain outcomes without replaying the comment or closure.
Issue closure does not attest implementation or campaign completion. Unsupported peers, nonlocal
execution targets, or incomplete bounded conflict evidence refuse the operation clearly.


## Inspecting and Changing Campaign Issue Scope

Before delegating an epic, use `get_campaign_issue_scope` (CLI: `wollipog issue-scope get --epic <number>`).
It returns authorized repository-qualified issues, a revision, recorded work outside scope, and reviewable
umbrella/member candidates. Native GitHub sub-issues and leading checklist entries under Units, Members,
Child Issues, Sub-Issues, or Implementation Issues are candidates; dependencies and incidental references
are not members and never grant authority. Inspect candidates and select the intended members.

To recover or extend an existing campaign, use `request_campaign_issue_scope_change` (CLI:
`wollipog issue-scope request --proposal '<json>'`) with `requestId`, `expectedRevision`, `explanation`,
and exact `additions` and `removals`, each an array of `{ "repository": "owner/repo", "number": 123 }`.
Custom requires an authenticated human to approve the exact change. In Full Control with a separate
human-established issue boundary, use `lineage: {kind: "epic", epic: <number>}` for verified intended
members or `{kind: "follow_up", publicationOccurrenceId: <id>}` for an exact authorized publication.
The server refuses incidental references, foreign repositories and changes beyond human-set limits.
Resolution applies and consumes scope atomically; do not separately consume it. A root can resolve
only an eligible occurrence backed by its standing human authorization.
Pending, denied, stale and replayed proposals leave scope unchanged. After approval, re-read the scope.
Humans can inspect, resolve epic candidates, and request changes in Campaign Status's Authorized Issue Scope.

Scope changes preserve conversation and work history. Removals display affected assignments and revoke
outstanding action decisions; issue closure retains its separate exact decision. Active Orchestrator
participants must use the campaign's runner and repository workspace. Updates require protocol v208
on the control plane and participating runners; unsupported peers must be updated and reconnected.
The authoritative revision is persisted on both sides, delivered on reconnect and restart, and checked
again by closure execution. An offline or unsynchronized runner cannot execute a revised closure.
Ledger recording, assignments, ordinary prompts, and epic links never modify authority.

Bounded Full Control issue writes require protocol v217 on every participant. The authorizing human
remains distinct from agent scope dispositions. Related follow-up publication requires a deduplicated,
accepted recommendation with authorized origin work items and exact sanitized repository, title, body
and labels; include `recommendationId` in the workflow request. Review the exact public payload before
resolving. Duplicate/sanitation and lineage checks repeat before one-shot consumption. Read the
published issue back and record it on that recommendation before proposing its scope addition.
Missing issue-boundary authority never turns ledger acceptance or ordinary prose into a grant.
