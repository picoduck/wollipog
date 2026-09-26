---
name: using-wollipog
description: Operate Wollipog sessions from inside an agent session through the injected CLI or the general Wollipog MCP server.
---

# Using Wollipog

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
wollipog worktree create --branch <name> [--base <ref>] --json
wollipog worktree attach --path <absolute-path> --json
wollipog worktree select --path <absolute-path> --json
wollipog worktree discard --path <absolute-path> --json
wollipog decision request --request-id <id> --resource-key <key> --snapshot '<json>' --json
wollipog decision get <occurrence-id> --json
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

`session stop-job` (MCP `stop_background_job`) ends one unfinished background job of a child
session by its id, which `session get` lists as `unfinishedBackgroundJobs`. Use it when a job that
never ends, such as a monitor whose condition never fires, keeps a finished sibling's result or a
queued handoff waiting. Only that job ends and is recorded as killed; the child's conversation, its
other jobs, and its queued prompts are kept. `session stop` and `session restart` end every job
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
JSON objects. The CLI refuses `--session` for these commands and exposes no resolution operation.
Only the current owner may resolve the exact pending occurrence. Authentication, secrets,
persistent grants, governance, budgets, and tool guardrails remain human-only.
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

Record each proposed follow-up with `record_campaign_follow_up` before starting it. Server-side
repository/title normalization deduplicates recommendations across children. `Recommend Only`
returns `recommend_only_stop` and ends at reporting. `Execute Approved` returns
`requires_typed_gates` only for a unique recommendation; that disposition is not approval, and
publication, UI evidence, merge, and deletion still require their separate
typed decisions plus sanitization, dependency checks, cross-model review, and exact-head CI. An
enqueued pull request remains unfinished until merge-group CI passes and the forge reports actual
`MERGED` state; continue supervising unrelated children while any one child waits for a human gate.

Once a child is Idle or Completed, use its exact completed report event sequence with
`verify_campaign_child` and attest that follow-ups were recorded. `Retain` keeps it visible.
`Stop and Archive` starts the existing durable stop/archive operation; verify the archived state and
retire its runner-owned worktree through Wollipog. Campaign completion is not verified until every
campaign child has a verified report and required worktree cleanup has finished.

Worktree commands default to `WOLLIPOG_SESSION_ID`; paired-device callers add `--session <id>`.
Creation without `--base` fetches the repository's remote default branch. Use the returned path
for file and Git commands in the current turn; a later provider launch resumes in the selection.
Discard permanently removes only a runner-owned worktree that is not used by a live provider, is
clean, and has no commits ahead of its upstream. A forge-verified merged head may replace an
upstream deleted with the remote branch, but only when it exactly matches the local head. An
unchanged recorded branch may instead prove its stable head is contained by the current
remote-tracking default branch. Discard refuses attached, dirty, other upstream-less, or unpushed
trees.

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

If `wollipog` is not on `PATH`, invoke the runner-provided location with its mode:

```text
"$WOLLIPOG_CLI" --wollipog-cli session list --json
```

Claude Code sessions also receive a general `wollipog` MCP server with the same manager tool
schemas. Prefer MCP tools when attached; use the CLI for scripts, CI, ACP, or Codex sessions.

The credential is scoped to the current live session and its ownership audience. It may manage
only that session's worktrees. A command may
receive `404` for an out-of-scope resource or `403` for a route outside the fixed agent allowlist.
Never attempt to approve the current session's own permission or governance cards.
