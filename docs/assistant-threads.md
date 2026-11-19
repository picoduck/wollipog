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
| `POST /api/assistant-threads/:threadId/confirmations/:confirmationId/approve` | `{ confirmation, thread }`. Approve Once: runs the bound command, then answers with how it ended. See Owner Confirmations. |
| `POST /api/assistant-threads/:threadId/confirmations/:confirmationId/deny` | `{ confirmation, thread }`. Refuses the bound command. |

`harness` defaults to the owner's saved Orchestrator Child Harness: Codex when it names a Codex
driver, otherwise Claude Code. Without `runnerId`, the first online Machine the owner can use that
supports the role, has the harness installed natively and has a Location is chosen; without
`workspaceId`, that Machine's first Location. A Machine whose runner predates protocol v383, or one
without the harness, is refused with HTTP 409 and guidance. Nothing is launched in that case, and
never an ordinary session in its place.

Without a `title`, the thread shows "New Thread" until its session is named by the first message.

`status` is `needs_you` while the backing session waits for its owner or one of the thread's owner
confirmations is pending (listed in `confirmations`), `working` while it is
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

Owners can set a default cost budget and session launch limit under **Settings → Behavior →
Assistant Threads**. The defaults are $25 and 10 launches, and each new thread keeps the limits
it starts with. Threads created before these settings also keep $25 and 10 launches.

To edit an existing thread, open **Thread Actions → Thread Limits**. The header shows what the
thread has spent and launched. Clearing a field removes its limit, and a launch limit of zero
pauses new launches. A budget below spend and outstanding commitments is refused. Setting a
finite budget again requires that any work launched without a cap and its descendants have been
deleted. These settings are owner-only.

- The backing session starts with the thread budget as its own cost budget, when set.
- While a thread's Assistant call executes, every session it creates counts as a launch of that
  thread. This covers `session_launch`, side chats and every other operation that passes through
  session creation inside the call. A launch is refused with a message to the
  assistant when the thread reaches its launch limit or its remaining budget is spent or held.
  - With a budget, each launch is capped at the remaining budget the backing assistant can use,
    rounded down to whole cents. The launch result tells the assistant what cap was applied when
    the request did not set one or set a higher one.
  - Without a thread budget, the launch keeps any explicit session cap. If none was requested it
    has no cost cap, and the launch result tells the assistant why.
  - The backing session's own cap is lowered by the same amount once every other check has passed,
    just before the session is created. The launch is refused if the cap cannot be lowered. All
    of the thread's caps together therefore never exceed its budget.
  - Each admission first settles the backing cap to what launched work holds. A reservation whose
    launch then failed, or the unspent cap of a deleted launch, goes back to the assistant. A cap
    the owner changed is only ever lowered.
  - Each launched tree holds the larger of its spend and its root's launch cap (or its current cap,
    if the owner raised it), even after the root's own cap is carved down for its children. A tree
    is the launched session and every descendant, recorded when each is created.
  - A child created anywhere in a launched tree is carved out of its creator's own cap (#4671).
    The creator's allowance is the cap it was launched or created with. Its own cap is that
    allowance less what its children hold, settled at each child creation and restart, so a
    finished child's unspent cap comes back. Every session in the tree together therefore stays
    within the launched cap, and so within the thread's budget. A cap the owner changed is only
    ever lowered.
  - A creator shares what it has not spent across its open child slots plus one share it keeps
    for itself, in whole cents. Once no share reaches one cent, child creation is refused with a
    message naming the shared thread budget.
  - A session in a launched tree cannot start runs. An agent may lower a tree member's
    cost budget but never raise or clear it.
  - Deleting a session never refunds its spend, whether one at a time or with its Machine: the
    thread keeps the deleted session's final cost inside its own tree.
- An ordinary thread launch cannot select the Orchestrator role, including from a saved default.
  To propose an independent campaign, use `campaign_start` with a Project Location, a first
  message and explicit Custom or Full Control mode. Only the thread's owner can start it from
  the **Start Campaign** confirmation card. The root counts as one launch against the thread's
  launch limit. The root and its workers spend from their own campaign allowance.
- A thread cannot start scheduled runs. Its connection also
  cannot call `auto_create`, `auto_update`, `auto_enable`, `auto_test`,
  `session_role`, `session_adopt` or `session_fork`, since scheduled work, a converted role, an
  adopted session or a fork (materialized on the runner without that session creation) would run
  outside these limits. The owner can still do any of these directly.
- `usage` on the thread view reports both limits and what the thread has used of them.
  `launchedSessionIds` lists the thread-budgeted work, and `launchedCampaignIds` lists its
  independent campaign roots.

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

## Owner Confirmations

An outside Assistant connection with destructive confirmation answers a destructive command with a
preview and a short-lived `confirmationId`, which the assistant repeats once a person in its chat
agrees. A thread's assistant could repeat it alone, so a thread's connection never receives one
(#4665). Its destructive command asks the owner instead:

- **Request.** The command answers `ownerConfirmationRequired` with its preview and nothing runs.
  Wollipog records an owner confirmation bound to the exact connection, operation, target (with
  the preview the binding covers), arguments and grant revision, with the arguments it will run
  with. Asking again for the same command while it waits returns the same request. A thread holds
  at most 10 pending requests, and each expires after an hour
  (`ASSISTANT_OWNER_CONFIRMATION_TTL_MS`). The request's id is shown only to the owner.
- **Where it appears.** The thread's `confirmations` lists its pending requests, and the thread's
  status is `needs_you` while any is listed. The web app shows each as a card in the thread and in
  the Inbox, with the action, its exact target, impact and arguments, and **Approve Once** and
  **Deny**.
- **Approve Once.** The approval is recorded first. Then the control plane runs the stored command
  through `AssistantOperations.callOwnerApproved`: authorized live against the thread connection's
  current grant and owner and audited in its activity, like any call, but without the thread's
  credential. The operation computes its binding again and spends the request inside its own
  receipt reservation, so the command runs once through its ordinary receipt path, or not at all.
  A repeated or concurrent Approve waits for the same run, and an Approve after the command ran
  returns it unchanged. An approval interrupted by a restart finishes once at startup; one whose
  reservation had already committed never runs again.
- **Refused.** A changed target, arguments or grant refuses the approval, as do Deny, expiry, and
  the thread's connection being revoked (archiving or deleting the thread, or the owner revoking
  it). Nothing runs.
- **The assistant hears.** However a request ends, its outcome reaches the thread's conversation as
  a `[Wollipog Owner Confirmation]` message, queued if the assistant is busy, and the assistant
  resumes from it. Delivery is recorded per request: a session that cannot admit it now (its
  runner is offline) is retried every 15 seconds for up to a day, and a restart delivers what it
  missed, including the outcome of a run that spent its request just before the restart. A
  thread that ended has nobody to tell.
- **Nothing the assistant holds confirms.** Only the control plane's run of an approval, marked in
  `assistantCallContext`, can spend a request. A `confirmationId` from a thread's assistant is
  refused whatever its value, and a thread connection's `destructiveConfirmation` cannot be set to
  `none`.

External Assistant connections keep the preview-and-confirm behavior above, unchanged.

### Starting a Campaign

1. The thread uses `project_list` and `runner_list` to select a Location and an Orchestrator
   installation, then calls `campaign_start`. It can propose the root and child model and effort,
   and name explicit issue numbers in Full Control. It cannot set a budget, supply a delegation
   policy, or approve a request.
2. On the **Start Campaign** card, select **Review Campaign**. You can open it from the thread
   or from **Inbox → Assistant Approvals → Review**. The review shows the first message,
   Location, mode, root and child settings, budget and scope.
   Full Control uses the same inspected boundary as New Session, including delegated operations
   and human-required gates. A Custom campaign uses normal Custom issue admission.
3. The card starts with the owner's saved campaign budget. If there is no saved budget, choose
   **Set Budget**. To replace the displayed budget for this launch, choose **Change Budget**.
   Enter **Cost Budget (USD)** and **Tool Call Limit**, then select **Update Preview**.
   The revised preview does not change the saved defaults.
4. **Approve Once** approves those exact settings. If the Location, inspected scope, effective
   settings or Assistant grant changed, the launch is refused. **Deny** and expiry also leave
   no campaign. The thread hears the outcome and can read the campaign Session ID in its
   `command_get` receipt. Open the work card marked **Campaign** for live status and
   campaign questions. The thread's existing read access grants no campaign decision authority.

An older control plane has no `campaign_start` operation. The command refuses a Location on a
runner below protocol v391. An older web client cannot approve a campaign through the legacy
confirmation endpoint.
