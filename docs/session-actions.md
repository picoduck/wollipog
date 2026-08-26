# Session actions

Roadmap slice 13.3 adds explicit session rename and safe ways to reuse a historical user message.
These actions deliberately preserve the boundary between preparing a prompt and submitting work.

## Rename ownership

An explicit rename is control-plane-owned presentation metadata. The control plane normalizes
whitespace, requires 1–120 characters, records `titleSource: "user"`, publishes a normal
`session_upsert`, and accepts the mutation while the runner is offline. Mutation authorization,
resource scoping, and content-free audit attribution use the existing session-route middleware.

Runner and provider title snapshots cannot replace an existing user-owned control-plane title,
including when a stale runner snapshot also labels its older title as user-owned. Prompt-derived
auto-title applies only to generated ownership, so explicitly naming a session `Untitled session`
does not hand ownership back to the next prompt. An explicit Restart later carries the current
control-plane title into runner metadata; no runner protocol change or migration is required.

## Edit and resend

`Edit & resend` opens an accessible confirmation dialog with an editable copy of the stored user
message and its original image attachments. Confirming replaces the current composer draft and
focuses the composer. It is offered only while the session can accept a prompt, and it does not
call the prompt API. The user must review the draft and press Send, which is a deliberate new turn
rather than a retry of an ambiguously delivered operation.

Stored slash-command text is reused as text. The normal composer resolves it only against the
session's currently advertised commands; the action does not replay an old command operation.

## Edit in fork

Editing completed turn N means forking the provider conversation and files after turn N-1, saving
the edited message as the child session's composer draft, and navigating to that child. A bounded
one-shot memory handoff preserves the draft when both IndexedDB and localStorage are unavailable.
The action never submits the child prompt automatically.

The action is available only when all of these are true:

- the provider is Codex app-server, which supports historical provider-turn forks;
- both turn N and its exact predecessor N-1 have durable conversation checkpoints;
- the source has an actual isolated worktree path (requesting one is insufficient when a non-git
  workspace has fallen back in place);
- the runner is online and proves protocol-v28 conversation-fork support;
- the source is not queued, running, starting, or waiting for input;
- no prompt is queued and no other fork/action is in flight.

Turn 1 has no predecessor and is unavailable. A cancelled/refused predecessor has no conversation
checkpoint and cannot be silently skipped. Claude's verified `--fork-session` remains available
through the existing latest-conversation fork action, but it cannot remove an earlier message from
the transcript, so it is not presented as edit-and-fork. Native Codex and stable ACP likewise do
not advertise historical edit-and-fork.

## Retry boundary

Normal UI prompts and forks have no caller idempotency key. The UI therefore never retries or
automatically resubmits them after a network-ambiguous failure. A session-scoped fork lease survives
view remounts; an ambiguous network/5xx outcome retains that lease, disables the active dialog's
retry, and directs the user to wait and check the Board. A request that resolves after its source
view unmounts cannot hijack later navigation. Transcript history Retry remains safe because it
performs only an idempotent history GET. Timeline error rows remain informational because they do
not carry enough delivery correlation to identify a safe prompt retry.

## Semantic Session Names

The prompt-derived title remains the immediate fallback. Deployments opt into isolated semantic
naming with `WOLLIPOG_TITLE_MODEL_URL` and `WOLLIPOG_TITLE_MODEL`. The URL must be an explicit
OpenAI-compatible chat-completions endpoint. `WOLLIPOG_TITLE_MODEL_API_KEY` supplies an optional
bearer credential, and `WOLLIPOG_TITLE_MODEL_TIMEOUT_MS` sets a 250–30,000 ms timeout (5,000 ms by
default). `WOLLIPOG_TITLE_GENERATION=disabled` disables generation even when a model is configured.

Both URL and model are required, so content is never silently routed across a new provider or
privacy boundary. The custom-endpoint request has no tools, bounded completed user/assistant input,
a 40-token output limit, zero temperature, minimal reasoning, and a short timeout. It never enters
the runner, transcript, agent context, prompt queue, or session lifecycle.

Settings → Session Naming exposes this legacy endpoint as **Custom Model Endpoint** and also keeps
the credential-free **Prompt Text Only** mode available. An organization with no saved choice
inherits the environment behavior above, preserving existing deployments during migration. Once an
owner or admin saves a mode, that organization setting takes precedence and applies to subsequent
naming requests without restarting Wollipog. Endpoint/model/key changes still come from the startup
environment in this compatibility phase; the API returns only the endpoint origin, model, timeout,
and whether a key is configured, never the key itself.

**Use Session Agent Account** is available when an online protocol-v93 runner reports a verified,
authenticated native Codex or Claude account. Each naming request targets the session's existing
Machine and exact agent definition; an organization-wide selection never moves content to another
Machine or provider. Settings reports only provider, billing classification, and an aggregate
Machine count. It never reports account identifiers, credential values, credential paths, or raw
provider status.

The runner owns this metadata task independently of the agent turn and prompt queue:

- Codex runs through the verified app-server interface using an ephemeral thread, read-only
  sandbox, `never` approvals, no dynamic tools, and empty environment/capability roots. Wollipog
  does not read or copy cached Codex authentication tokens. General app-server sessions retain the
  repository's existing Codex version floor; this narrower naming surface requires Codex 0.149.1
  or newer and is advertised separately by runner discovery.
- Claude runs noninteractively with Safe Mode, Plan permissions, an empty tool set, strict empty
  MCP configuration, disabled setting sources, slash commands, browser integration, and session
  persistence. Authentication remains owned by Claude Code; an explicitly configured runner-local
  credential retains the same precedence as ordinary sessions.
- Both providers run from a disposable neutral temporary directory, receive at most nine completed
  semantic messages and 12,000 characters, have an 8 KiB output ceiling and a 15-second hard
  timeout clamp, and return only a normalized 120-character title plus a sanitized status.
- Each runner admits at most two concurrent naming tasks and twelve starts per minute. Overload,
  timeouts, provider errors, missing accounts, unsupported providers, and older runners all fail
  closed to the prompt-derived title.

Initial automatic naming still sends only the first completed user message. The explicit
**Rename Session** action may send the bounded, redacted context described below. Neither path
alters the provider transcript or blocks the normal turn.

The reserved `/rename-session` command has the visible label **Rename Session**. It derives a title from the
original objective and recent completed semantic context. Images, reasoning, tool and shell output,
provider commands, partial messages, and queued prompts are excluded. Successful explicit results
are user-owned; manual renames and newer requests fence stale results. Disabled, malformed, failed,
or timed-out generation leaves the current title unchanged.
