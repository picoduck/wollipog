# Assistant Session Work Management

Refs #4468. This is the first group-3 parity slice; lifecycle/placement and the remaining
watch, wait and content-management candidates remain explicit audit gaps.

Use `session_work_get` to inspect the current queue, active turn ID, provider command catalog
and durable invocation states. The queue includes runner-live and durable prompt projections,
so a disconnected runner does not establish that a previously queued prompt was removed.

| Tool | Management Operation |
| --- | --- |
| `queue_get` | Read a not-yet-started prompt and its opaque `editRevision`. |
| `queue_edit` | Replace text/attachments with the exact `expectedRevision` and a fresh `submissionId`. |
| `queue_cancel` | Request cancellation of a queued prompt by its current `promptId`. |
| `session_steer` | Send text/attachments to the active `turnId`, or promote a queued `promotePromptId`. |
| `session_invoke` | Invoke a provider command using its current `providerCommandId` and `catalogRevision`. |

Every mutation takes a stable `commandId`. Edit, steering and invocation also carry their
provider/runner submission ID; retain both identities. A duplicate `commandId` returns only its
receipt and never dispatches again. Changed arguments require a new command ID only after the
original outcome is reconciled. `command_get`, `steering_get` and `session_work_get` provide the
receipt and current work readback; a successful service receipt establishes admission, not
provider completion. Cancellation is fire-and-forget and needs a runner queue update to prove
removal. After a lost edit reply, read the prompt revision before proposing any further edit.
Accepted or uncertain receipts after interruption never permit blind retry or another-installation
failover. Receipts persist command identity/digests and resource coordinates, not prompt bodies.

Cancellation and provider command invocation honor the owner's `destructiveConfirmation` policy.
Provider commands can alter conversation state, so this lane conservatively confirms every
invocation when confirmation is required. Inspect the preview, then repeat unchanged arguments
with its short-lived `confirmationId`. A changed grant, target placement or observed queue
invalidates the preview. Confirmation consumption and receipt reservation are atomic.

All tools check current grants and the granting owner's session access, including source-project
placement and access changes while waiting for a runner. They support unrelated sessions without
fabricating controlling ancestry. Queued-message HTTP and Assistant adapters share the same queue
service, including attachment validation and lease cleanup, protocol floors, offline refusals,
revision and response identity checks. Steering and invocation call the existing session services;
first-message, policy, budget, provider support and workflow/automation fences remain enforced.
Assistant steering cannot acknowledge a human's reviewed result revision.

Tests use real isolated SQLite, Fastify HTTP/MCP and session/queue services with synthetic owners
and mocked runner transport. This is **MOCKED integration evidence**. No real model, Discord,
SSH, remote OpenClaw, remote TLS or hosting deployment is demonstrated by this slice.
