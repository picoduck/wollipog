# ADR 0007: Separate the Orchestrator Role From Project Isolation

- Status: Accepted
- Date: 2026-09-14
- Amends: [ADR 0006](0006-orchestration-as-a-session-capability.md)

## Context

ADR 0006 made Orchestrator a session capability, but its first implementation coupled two choices:
the parent should normally delegate implementation, and the parent must be unable to write project
files. That coupling excluded approval-capable provider configurations such as native Claude Code
without Bubblewrap and prevented explicitly requested parent implementation.

## Decision

Keep `permissionMode: "orchestrator"` as the coordination role. Add an independent, immutable
campaign execution snapshot, `strictProjectIsolation`, controlled by human defaults and optional
creation overrides. New sessions default to `false`; persisted sessions whose snapshots lack the
field normalize to `true` with legacy provenance.

Delegate Implementation remains the behavioral default. An ordinary multi-issue request does not
authorize child creation. The parent may maintain permitted planning artifacts. Explicit parent
implementation requires a child/PR ownership-overlap check, a dedicated parent worktree, and the
normal testing, cross-model review, UI-evidence, merge, and cleanup workflow.

With strict isolation disabled, supported native structured harnesses launch in their selected
repository or worktree under ordinary provider permissions and existing governance. Native Claude
Code must advertise interactive Default approval support, and eligible operations reach that
approval path instead of being forced to `dontAsk`. This mode makes no OS-level read-only claim.

With strict isolation enabled, the existing scratch-only project boundary and restricted launch
configuration remain in force. Claude requires `bwrap` on Linux or Seatbelt on macOS and `dontAsk`;
Direct WSL requires its attested bwrap launcher; audited Codex provider isolation remains supported.
Unsupported combinations fail before launch. The control plane, not the agent-visible MCP adapter,
checks the immutable snapshot before permitting a self-worktree operation.

Parent Control, typed workflow decisions, authentication exclusions, child admission, resource
limits, and audit provenance are unchanged. ACP remains strict-only until an adapter-specific
provider-mode permission contract is audited.

## Consequences

Orchestrator availability no longer implies a read-only filesystem guarantee. The settings and
creation interfaces therefore name the effective boundary explicitly. Existing sessions retain
their restrictions, while new sessions can use provider approvals and perform explicitly requested,
coordinated parent implementation without weakening strict mode.
