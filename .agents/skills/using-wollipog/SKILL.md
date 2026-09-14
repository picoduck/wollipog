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
wollipog session events <session-id> --after <seq> --json
wollipog session capabilities --runner <id> --agent <id> [--offset <n>] [--limit <n>] [--include-hidden] --json
wollipog session capabilities --runner <id> --agent <id> --model <id> --json
wollipog session create --runner <id> --agent <id> --workspace <id> --prompt <task> [--model <id>] [--effort <level>] --json
wollipog session prompt <session-id> <message> --json
wollipog session wait <session-id> --for input_required,completed,failed,stopped --json
wollipog session stop <session-id> --json
wollipog worktree create --branch <name> [--base <ref>] --json
wollipog worktree attach --path <absolute-path> --json
wollipog worktree select --path <absolute-path> --json
wollipog worktree discard --path <absolute-path> --json
```

An Orchestrator campaign must use the management tools as the policy boundary, not infer authority
from its prompt. Call `get_campaign` at campaign start and after a human changes policy. It returns
the effective behavior, typed decision owners, revision, admission and guardrail limits, child and
follow-up counts, UI-review compatibility, and one of `waiting_human`, `active`, `blocked`, or
`verified_complete`, without returning credentials.

Every child creation receives a server-derived campaign-policy block in its initial assignment.
For Automatic model or effort, use `get_agent_capabilities` and send the selected pair in the same
`create_session` call; fixed values are server-enforced. The block is not blanket approval. Children
must use `request_workflow_decision`, `get_workflow_decision`, and `consume_workflow_decision` for
implementation questions, PR merge, merged-branch deletion, follow-up publication, and UI evidence.
Only the current owner may resolve the exact pending occurrence. Authentication, secrets,
persistent grants, governance, budgets, and tool guardrails remain human-only.

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
upstream deleted with the remote branch, but only when it exactly matches the local head. Discard
refuses attached, dirty, arbitrary upstream-less, or unpushed trees.

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

Discard is deliberately conservative. It retains the worktree and explains why whenever the tree is
still in use — including the one this session is running in, which stays until the session's own
provider exits. That is a deferral, not a failure: report the retained path and its reason in the
cleanup summary and leave it alone. Runner reconciliation removes a clean, fully pushed worktree
whose pull request reached a terminal state once nothing is using it.

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
