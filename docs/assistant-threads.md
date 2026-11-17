# Wollipog Assistant Threads

A thread is an owner's conversation with the built-in Wollipog Assistant (#4662). Each thread is
backed by one Claude Code or Codex session in the `assistant` role. The thread's transcript and
composer are that session's own routes and events; the thread record adds the lifecycle, the
harness choice and, later, its thread-scoped Assistant connection.

## Owner API

Every route requires an authenticated organization owner and only ever reads or changes that
owner's own threads; another owner gets 404. Responses never carry a credential value or hash.

| Route | Result |
| --- | --- |
| `GET /api/assistant-threads` | `{ threads }`, newest activity first. Archived threads appear only with `?includeArchived=true`. |
| `GET /api/assistant-threads/defaults` | `{ harness, harnesses: [{ id, label, available, reason? }] }` |
| `POST /api/assistant-threads` | Body `{ harness?, title?, runnerId?, workspaceId? }`, result `{ thread }`. |
| `GET /api/assistant-threads/:threadId` | `{ thread }` |
| `PATCH /api/assistant-threads/:threadId` | Body `{ title }`, result `{ thread }`. |
| `POST /api/assistant-threads/:threadId/archive` | `{ thread }`. Archives the backing session through the ordinary session archive. |

`harness` defaults to the owner's saved Orchestrator Child Harness: Codex when it names a Codex
driver, otherwise Claude Code. Without `runnerId`, the first online Machine the owner can use that
supports the role, has the harness installed natively and has a Location is chosen; without
`workspaceId`, that Machine's first Location. A Machine whose runner predates protocol v383, or one
without the harness, is refused with HTTP 409 and guidance. Nothing is launched in that case, and
never an ordinary session in its place.

Without a `title`, the thread shows "New Thread" until its session is named by the first message.

`status` is `needs_you` while the backing session waits for its owner, `working` while it is
queued, starting or running, `done` when it is idle or finished, and `archived` once the thread is
archived or its session is archived or deleted outside it.

Each change is published to the owner's dashboards as the `assistant_thread_upsert` web event
(`{ type, userId, thread }`), including every published change of the backing session.

## The Assistant Role

- Only thread creation makes an `assistant`-role session. `role: "assistant"` in session request
  JSON is refused, and the role is never converted to another one.
- The control plane sends `SessionLaunchSpec.assistant` (`{ threadId }`) on every start and
  restart. The runner (capability `assistantRole`) launches it with the role instructions and
  without the general Wollipog agent-control MCP server, CLI or credential, so the session cannot
  launch or steer sessions outside its thread's grant and limits. The runner keeps the marker on
  every relaunch and refuses it for any harness other than Claude Code and Codex.
- The control plane refuses every agent-control route for an `assistant`-role session regardless.
- The session is owned by the thread's owner alone and never joins a Project, even when its
  Location belongs to one. Only that owner can read, list, prompt or steer it: organization owners
  and admins, who otherwise reach every session in the organization, and agents are refused, since
  the session acts with its owner's Assistant authority.
- The `sessions.session_role` column keeps `normal` for these sessions; `assistant_thread_id`
  carries the role, because widening that column's CHECK would mean rebuilding the sessions table.

## Thread Limits

`ASSISTANT_THREAD_LIMITS` bounds what one thread does, so a runaway or recursive assistant stops:

- The backing session's own cost budget is the thread budget ($25).
- While a thread's Assistant call executes, every session it creates counts as a launch of that
  thread. This covers `session_launch`, side chats and every other operation that passes through
  session creation inside the call. A launch is refused with a message to the
  assistant once the thread has launched 10 sessions, or once its budget is spent or held.
  - Each launch is capped at whatever the backing assistant has not spent and launched work does
    not hold, rounded down to whole cents. A missing, zero or negative requested budget gets that
    cap too, never "no budget".
  - The backing session's own cap is lowered by the same amount once every other check has passed,
    just before the session is created. The launch is refused if the cap cannot be lowered. All
    of the thread's caps together therefore never exceed its budget.
  - Each admission first settles the backing cap to what launched work holds. A reservation whose
    launch then failed, or the unspent cap of a deleted launch, goes back to the assistant. A cap
    the owner changed is only ever lowered.
  - Each launched tree holds the larger of its spend and its root's cap. A tree is the launched
    session and every descendant, recorded when each is created.
  - Deleting a session never refunds its spend, whether one at a time or with its Machine: the
    thread keeps the deleted session's final cost inside its own tree.
- A thread cannot start runs, workflows or Orchestrators, whose children it could not count.
  This holds even when an Orchestrator would come from a saved default. Its connection also
  cannot call `auto_create`, `auto_update`, `auto_enable`, `auto_test`, `workflow_run`,
  `session_role`, `session_adopt` or `session_fork`, since scheduled work, a converted role, an
  adopted session or a fork (materialized on the runner without that session creation) would run
  outside these limits. The owner can still do any of these directly.
- `usage` on the thread view reports both limits and what the thread has used of them.
  `launchedSessionIds` lists the sessions it launched.

## The Shared `wollipog` Skill

Every thread's session receives the shared `wollipog` assistant skill with its role instructions,
through `SessionLaunchSpec.assistant.guide`. It covers discovery, command IDs and receipts,
reporting, and never confirming or approving on the owner's behalf. Outside assistants read the
same text from `assistant_discover` (`skill`). It is not a Skill Library entry: it guides an
assistant acting through Assistant tools, not coding agents in ordinary sessions.

## Thread Credential and Runner Proxy

Each thread has its own Assistant connection (v384), listed in the owner's Assistant Connections
with its `threadId`. Its grant is Full Access with destructive confirmation required. The owner
can narrow it or revoke it there, but cannot rotate it, because its proxy owns the credential.

- **Minting.** At every launch of the backing session, the runner's proxy mints a fresh
  `wollipoga_…` credential in its own memory and sends only its SHA-256 (`assistant_credential`).
  The control plane binds it to the thread's connection for one hour
  (`ASSISTANT_THREAD_CREDENTIAL_TTL_MS`) only when the sender is the runner of the thread's live
  backing session, the thread is active and its owner is still an active owner. A new credential
  replaces the old one at once. The proxy registers a fresh one before half its lifetime has
  passed, and once more if the control plane refuses one as expired.
- **Where the credential is not.** It is never written to a file, environment variable, process
  argument, the session's worktree or its transcript. The session's harness launches the stdio
  adapter `--assistant-mcp` as the `wollipog_assistant` MCP server. The adapter holds only a
  per-session relay endpoint and key, a new one at every launch. They forward MCP requests for
  that one session to `/assistant/mcp` and nothing else, and the runner adds the credential.
  - Claude Code reads them from a runner-written `--mcp-config` file in the runner's hook state
    directory. Every sandboxed launch hides that directory and gives each session back only its
    own entries, so one session cannot read another thread's relay key.
  - Codex reads them by name from its own environment (`env_vars`), never from process arguments.
  - The file is removed when the proxy closes, and its key dies with the proxy.
- **Authorization.** Every call is authorized live by `/assistant/mcp` against the thread
  connection's current grant and owner, and recorded in that connection's activity.
- **Revocation.** Each of these revokes the connection: archiving the thread, archiving or
  deleting its backing session, or the owner revoking the connection. The control plane then
  refuses the credential and any new one. It also sends `assistant_credential_revoked`, so the
  runner forgets the credential and closes the proxy. The runner also closes it when the
  session's provider ends.
- **Limit of the boundary.** The proxy runs as the runner's OS user, as the agent does. The
  credential lives only in the runner's memory.
  - The runner installs a `SIGUSR1` listener, so a same-user process cannot make Node open its
    inspector and read that memory. Otherwise only inspecting another process's memory would
    reach it, which the kernel's ptrace restrictions normally refuse.
  - Under `provider` isolation nothing hides the runner's data directory from a session. There,
    as for every other runner-held secret, sessions on one runner account are separated only by
    the sandboxed isolation modes.
