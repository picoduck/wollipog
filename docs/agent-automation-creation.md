# Agent-Requested Automation Creation

Normal and Orchestrator sessions can propose a Wollipog automation through the
injected CLI or MCP server. Every creation requires the authenticated session
owner's approval, including under Full Control. The owner must also meet existing
automation administration permissions: owner or admin of the personal control-plane
organization. This capability does not expose
general automation administration or agent approval of persistent scheduled work.

## Propose, Inspect, and Execute

```sh
"$WOLLIPOG_CLI" automation request --proposal '<json>' --json
"$WOLLIPOG_CLI" automation get <occurrence-id> --json
"$WOLLIPOG_CLI" automation execute <occurrence-id> --digest <resource-digest> --json
```

The MCP equivalents are `request_automation_creation`, `get_automation_creation`
and `execute_automation_creation`. Creation works only for the calling session;
there is no `--session` override or agent-facing approval command.

The proposal contains `requestId`, `resourceKey` and a complete `spec`:

```json
{
  "requestId": "weekly-health-v1",
  "resourceKey": "weekly-health",
  "spec": {
    "name": "Weekly Health Review",
    "cron": "0 8 * * 2",
    "timezone": "UTC",
    "enabled": true,
    "action": {
      "kind": "create_session",
      "request": {
        "runnerId": "<machine-id>",
        "workspaceId": "<workspace-id>",
        "agentId": "<agent-id>",
        "useWorktree": true,
        "prompt": "Review project health and report findings without changes."
      }
    },
    "misfirePolicy": { "kind": "skip" },
    "runnerPolicy": { "kind": "wait" },
    "concurrencyPolicy": "wait",
    "limits": { "maxCostUsd": 5, "maxToolCalls": 50 },
    "notifications": { "pushEvents": ["succeeded", "failed"] }
  }
}
```

Read visible machines, workspaces and installation capabilities before choosing a
target. The server validates the normal AutomationSpec, pins advertised
installations, records an effective settings preview for each target and exact
Project placement, and presents the resulting configuration to the human. Prompt
session and workflow actions use the existing automation schema and admission.

The request returns a pending typed decision, not an automation. Its approval card
shows the schedule, timezone, next occurrence, enabled state, task and complete
configuration. The proposed occurrence is a preview: execution calculates the
next future occurrence again. A paused automation stays paused after creation.

Explicit model, effort and permission settings remain explicit. Omitted settings
are inherited at each normal execution; the per-target preview describes current
defaults without converting them into overrides. A prompt-session automation
therefore does not restore its target's former permission mode after the owner
changes that session. Workflow roles and alternate machines resolve their own
defaults independently. The preview is revalidated at creation time.

Proposals expire after 24 hours; an approval must be executed within 30 minutes
and before the proposal expires. Execution accepts only the occurrence identifier
and its exact resource digest. Changed settings require a new request identifier
and fresh human approval. Reusing a resource key supersedes prior unconsumed
proposals for the same intended automation.

## Recovery and Audit

Reuse the same request identifier with identical contents after a lost proposal
response. Reuse the same occurrence and digest after a lost execution response.
Consumption, automation insertion, the created audit event and immutable receipt
commit in one local database transaction. A crash cannot leave a consumed grant
without the automation or create the same approved automation twice.

The decision's `automationCreationResult` contains the original automation
identifier, navigation path, approved saved specification and creation time.
This is a historical creation receipt: later human edits or deletion do not
rewrite it or authorize creating a replacement.

Before creation the server rechecks requester ownership, the approving human's
session ownership, referenced workspaces, Project placement, installation
identity and capabilities. Drift refuses creation and requires fresh approval.
Discovery timestamps and online/offline availability are not target identity:
an unchanged runner reconnect does not invalidate human approval.
Creation does not reserve runner capacity, bypass governance or grant blanket
approval for actions taken by scheduled sessions. Runtime admission and finite
limits remain unchanged.

Pending proposals and unexecuted approvals become terminal `revoked` decisions
when their applicable deadline expires. The control plane retires them on startup,
during periodic maintenance, and before inspection, role conversion and approval
resume delivery, even if the requesting runner is offline. They no longer block
role conversion. Configuration, approving identity, original approval time and
audit history remain available; consumed creation receipts never expire.
Card and audit settlement commits before notifications or workflow/pod lifecycle
callbacks run. Owed lifecycle work survives restart; a failed expiration is retried
without stopping unrelated prompt delivery. Expired approval resumes remain fenced
even while cleanup is deferred.
Held or unsent approval resumes are abandoned. Delivery already handed to a runner
cannot be recalled; it is retained as uncertain without further control-plane retries,
and the expired decision cannot authorize creation. Parent Control or campaign policy changes also conservatively
revoke unconsumed proposals; request fresh human approval after those changes.

Requires updated runner and control-plane components advertising
`agentAutomationCreation`. Older or unverified peers refuse without sending a
creation request; update them outside any session hosted by that stack.

For diagnosis, correlate `automation_creation_proposed` and
`automation_creation_executed` logs by session/occurrence and HTTP request ID.
They contain status and receipt identifiers, never the prompt or configuration.
The human resolution is recorded in the workflow decision audit; the created
automation event links back to the exact occurrence and resource digest. Check
the durable receipt before retrying an uncertain operation.
