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
wollipog session create --runner <id> --agent <id> --workspace <id> --prompt <task> --json
wollipog session prompt <session-id> <message> --json
wollipog session wait <session-id> --for input_required,completed,failed,stopped --json
wollipog session stop <session-id> --json
wollipog worktree create --branch <name> [--base <ref>] --json
wollipog worktree attach --path <absolute-path> --json
wollipog worktree select --path <absolute-path> --json
```

Worktree commands default to `WOLLIPOG_SESSION_ID`; paired-device callers add `--session <id>`.
Creation without `--base` fetches the repository's remote default branch. Use the returned path
for file and Git commands in the current turn; a later provider launch resumes in the selection.

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
