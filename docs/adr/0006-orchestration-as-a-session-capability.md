# ADR 0006: Orchestration Is a Session Capability

- Status: Accepted
- Date: 2026-09-06
- Supersedes: [ADR 0004](0004-conductor-disabled-pending-acp-v2.md)

## Context

The session-scoped Wollipog CLI and MCP interface provides session management to ordinary agents.
The synthesized Claude-only Conductor no longer owns a distinct capability. Its runner credential,
launch provisioning, and special permission clamps add an unnecessary second authentication path.
The original runner environment gate was already removed by ADR 0004's August amendment.

## Decision

Retire the Conductor agent and its dedicated MCP entry point. Reject its reserved identity during
creation and durable launch recovery, filter configured and discovered advertisements, and retain
historical definitions and transcripts. Keep only cleanup for old credential-reference files.
General session management authenticates with the exact live session's separately bound credential.

The authenticated creator supplies child attribution. Request bodies and runner snapshots cannot
choose or overwrite a parent. A nullable parent reference is persisted on the child and exposed in
session views; removing a parent preserves the child's history and clears the reference.

Agent-created children receive finite guardrails before their initial prompt can execute.
An unbounded parent defaults each child to $5 and 100 tool calls. A bounded parent divides its
remaining, unreserved allowance across its remaining spawn slots; explicit child limits can narrow
that allocation. The default lifetime spawn cap is four, configurable at session creation with
`config.maxChildSessions` from zero through 64. Reservations survive deletion of child history.
These are admission allowances; existing runtime cost and tool-call enforcement remains responsible
for stopping a child when it reaches its limit.

Apply the built-in `builtin:session-spawn-human-gate` to the
`wollipog.create_session` operation. The fallback permits sessions individually owned by an active
organization owner and asks for shared audiences and other roles. An explicit stored governance
policy can override that fallback. Bind each approval to the parent, exact creation request, and
spawn ordinal. Use the existing durable governance approval queue, audit, expiry, rejection, and
human response checks. The creating tool polls the same request while awaiting the human's decision.

The orchestrator preset is a separate permission boundary for an ordinary session. It must expose
only session-management operations and governance reads, and must enforce refusal of its own
worktree writes and shell commands. Advertise it only where the harness can enforce that boundary;
unsupported adapters must fail closed. ACP transport availability alone does not establish tool
restriction capability.

The initial implementation supports native host Codex and Claude Code. Codex disables native
execution features, hooks, extensions, web search and ambient MCP servers; it uses read-only
sandboxing with no approval escalation. Its configuration probe runs at the effective launch
directory and refuses launch if MCP isolation cannot be verified. Claude Code starts with no
built-in tools, disabled hooks, and a strict runner-owned MCP configuration. The shared MCP
server exposes a reduced management-only tool list, and the control plane independently permits
mutations only on trusted direct children. Neither the user nor a child can switch this preset
on an existing session. Native TUI and ACP preset support are deferred until their launch
boundaries can enforce the same restrictions. Standard ACP sessions remain available.

The device-local Conductor experiment is a permanently disabled compatibility tombstone;
saved opt-ins are ignored and the switch is removed. Session creation offers the native preset
without an experiment gate; advertised permission modes also expose it in per-agent defaults.

## Consequences

Parent attribution provides the durable session relationship consumed by #563 and #562.
The child remains subject to its existing session authorization; a parent relationship is not a
grant to answer approvals. Legacy sessions remain readable without invented parentage.
General session management and workflow dispatch keep their ordinary agent identities.

Removing the old Conductor does not restart or deploy any running stack.
