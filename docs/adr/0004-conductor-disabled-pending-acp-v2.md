# ADR 0004: Disable the Conductor Pending ACP v2

- Status: Accepted (amended 2026-08-23: gate mechanism changed, see Amendment)
- Date: 2026-07-25
- Decision owners: Wollipog maintainers

## Context

The Conductor is synthesized from an available native Claude Code installation and provisioned with
a session-scoped manager MCP configuration. It is not load-bearing for ordinary sessions, runs,
workflows, governance, or automation. Its current implementation nevertheless adds Claude-specific
launch provisioning, permission-mode clamps, credential-file handling, cleanup, and restart
invariants to every runner release.

ACP v2 is the intended point to reconsider a provider-neutral conductor. Its draft session setup
supports MCP servers and its permission-request work is a better foundation than extending the
current native-Claude special case.

## Decision

The runner does not advertise or launch the Conductor by default. Operators may temporarily opt in
by setting `MAM_CONDUCTOR=1` on the runner and restarting it.

The gate applies before the runner's initial registration and after every discovery refresh. It
removes both synthesized and explicitly configured agents whose id is `conductor`. Stale durable
start snapshots and retained runner sessions also fail while the flag is off, so they cannot route
around the missing-agent response or resume with half-provisioned manager tools.

`MAM_CONDUCTOR` is runner-only configuration. It is removed from inherited and explicitly
configured child environments, including standalone agent TUI launches.

## Retained Defenses

Disabling advertisement is not deletion. The following defenses stay active:

- all control-plane Conductor permission-mode validation and clamps;
- capability narrowing to the interactive `default` mode when the feature is enabled;
- the scoped Conductor credential and API-route allowlist;
- startup cleanup of legacy per-session MCP configuration files;
- Conductor MCP recursion and delegation guards.

Keeping these defenses makes an opt-in or stale request fail safely without preserving the feature's
default maintenance burden.

## Reopen Criterion

Reconsider the Conductor after ACP v2 is stable and an ACP-based design can demonstrate:

1. session-scoped MCP injection;
2. per-tool permission requests that preserve confirm-before-apply behavior;
3. a provider-neutral launch and resume lifecycle across native, WSL, and remote runners;
4. equivalent scoped credentials, cleanup, and stale-session defenses.

Stabilization is a capability trigger, not a calendar date. Until those conditions are met, the
native Claude implementation remains opt-in.

## Consequences

- New runners no longer advertise Conductor-Led Work unless explicitly enabled.
- Existing Conductor history remains visible, but it cannot launch or resume while disabled.
- Ordinary agents, workflows, automations, and governance behavior are unchanged.
- Operators relying on the legacy Conductor must set one documented runner environment variable.

## Amendment (2026-08-23)

The runner environment gate (`WOLLIPOG_CONDUCTOR` / legacy `MAM_CONDUCTOR`) is removed. The
runner now always synthesizes and advertises a conductor when an available native Claude Code
installation can donate one, and always provisions the manager MCP when a conductor session
starts. The opt-in moves to the client: the Conductor-Led Work switch in Experimental Settings,
which now defaults OFF, is the feature's gate. It is device-local UI exposure, matching how the
Multi-Agent Runs and Collaboration Pods experiments already gate their surfaces.

What this changes and what it does not:

- The opt-in remains. It no longer requires runner environment configuration and a restart, and
  it no longer applies runner-wide; each device chooses for itself.
- Every Retained Defense above is unchanged: the control-plane permission-mode validation and
  clamps, the `default`-mode capability narrowing, the scoped conductor credential and API-route
  allowlist, startup MCP-config cleanup, and the recursion/delegation guards.
- The stale-snapshot refusal is narrowed: a retained conductor session now resumes, because the
  runner side is always provisioned. The control-plane clamps still bound what such a session
  can do.
- A non-UI API caller can start a conductor session regardless of any device's switch, exactly
  as `/api/runs` and `/api/pods` are served regardless of their experiment flags.

The Reopen Criterion is unaffected: the native Claude implementation remains the interim design,
and an ACP-v2-based conductor is still the intended replacement.
