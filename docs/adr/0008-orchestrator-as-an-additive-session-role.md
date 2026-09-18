# ADR 0008: Orchestrator as an Additive Session Role

- Status: Accepted
- Date: 2026-09-17
- Amends: [ADR 0007](0007-separate-orchestrator-role-from-project-isolation.md)

## Context

ADR 0007 separated Strict Project Isolation from delegation behavior, but the Orchestrator role was
still encoded as the provider permission mode `permissionMode: "orchestrator"`. Choosing the role
therefore consumed the one field that otherwise carries the harness's ordinary approval policy. For
native Claude Code the value was always translated to the interactive `default` mode, the launch
was pinned to a single Wollipog MCP server (`--strict-mcp-config`), and manager hooks were removed.
A user could not run an Orchestrator with the same Auto or Accept Edits policy, tool inventory,
hooks, and configured MCP servers as an equivalent normal session (#1281).

## Decision

Represent the role independently of the provider permission mode.

- Protocol v160 adds `SessionRole = "normal" | "orchestrator"` on `CreateSessionRequest` and
  `SessionView`, and the control plane persists it in a dedicated `session_role` column. The
  runner treats the launch policy block (`SessionLaunchSpec.orchestrator`, present for every
  Orchestrator since v144) as the role signal; `permissionMode === "orchestrator"` remains the
  legacy encoding for peers and clients that predate the field.
- The literal `permissionMode: "orchestrator"` now means the coupled **Orchestrator preset** provider
  policy. It stays fixed at creation and remains the only shape for Strict Project Isolation, Native
  TUI, Codex, Pi, ACP, and every session created before this change. Existing rows are backfilled
  to the explicit role while keeping the preset, so no persisted session is broadened.
- A non-strict native Claude Code Orchestrator with an ordinary permission mode launches exactly
  like an equivalent normal session and gains only: the `WOLLIPOG_PERMISSION_PRESET` marker that
  exposes campaign tools through the general Agent Control MCP server, a pre-authorization for
  `mcp__wollipog__*`, the Orchestrator instructions, and read access to Project Locations. No
  `--strict-mcp-config`, `--tools`, `--permission-mode`, settings-source, or hook restriction is
  injected; manager hooks provision as for any Claude session. The routine-operation classifier of
  ADR 0007 keeps applying on the runner control channel, supplementing rather than replacing the
  selected policy.
- The control plane refuses the independent combination when the runner predates v160 (an older
  runner would launch the session as an ordinary one), when the harness is not native Claude Code on
  the host, when Strict Project Isolation is enabled, or for a Native TUI launch, each with guidance
  naming the preset as the alternative. Parent Control, typed workflow decisions, campaign
  projection, the scoped control-plane credential, and route allowlists are governed by the role.
- The New Session dialog exposes **Session Role** (Normal or Orchestrator) and a separate
  **Provider Permissions** summary. The summary shows the saved harness default whenever the role is
  additive and states which policy selects the preset otherwise. A saved Orchestrator harness
  default still selects the role; choosing Normal explicitly overrides it on a v160 control plane.

## Consequences

An Orchestrator no longer implies a reduced tool or integration surface unless Strict Project
Isolation or a not-yet-decoupled harness selects the preset, and the interface says which. Codex, Pi,
and ACP Orchestrators keep their audited preset launches until each harness has an equivalent
additive contract; that work, Native TUI parity, and an explicit integration-isolation policy are
follow-ups rather than inferred from the role.
