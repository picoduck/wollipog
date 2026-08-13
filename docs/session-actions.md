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
