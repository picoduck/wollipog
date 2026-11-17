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
- The `sessions.session_role` column keeps `normal` for these sessions; `assistant_thread_id`
  carries the role, because widening that column's CHECK would mean rebuilding the sessions table.
