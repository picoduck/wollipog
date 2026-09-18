# ADR 0012: Advertise the Additive Codex Orchestrator Independently of the Preset

- Status: Accepted
- Date: 2026-09-18
- Amends: [ADR 0009](0009-additive-orchestrator-role-for-codex.md)

## Context

[ADR 0008](0008-orchestrator-as-an-additive-session-role.md) made the Orchestrator role additive;
ADR 0009 extended it to the native Codex drivers, and [ADR 0010](0010-additive-orchestrator-role-for-pi.md)
to Pi. #1294 then separated the two advertisements a runner publishes: the `orchestrator` permission
mode says the **coupled preset** is launchable here, and `capabilities.orchestratorAdditive` says the
**role** is launchable with ordinary provider permissions.

That separation was applied to Pi and Claude Code. For the Codex drivers the additive advertisement
was deliberately left tied to the preset's two preconditions — the granular-approval probe
(`codexAppServer.orchestratorApproval.status === "supported"`) and Codex's audited Linux or macOS
sandbox — as out of scope at the time. The control plane's non-strict gate carried the same platform
rule, at creation and at restart, and the New Session dialog mirrored it.

Neither precondition is a condition of the additive launch (#1308):

- Granular approval support is what lets the coupled preset impose its fixed `approval_policy`
  reviewed by Guardian. The additive launch injects no `approval_policy`.
- The audited sandbox is what makes the preset's forced `sandbox_mode="workspace-write"`
  enforceable. The additive launch injects no sandbox setting.

`additiveOrchestratorLaunchArgs` adds exactly `-c mcp_servers.wollipog=<table>` and
`-c developer_instructions=<the Orchestrator instructions>`, and `provisionAgentControl` accepts the
launch for any additive-capable driver running natively on the host. So a Codex installation that
lacks granular approval support, or that runs on Windows, could support an additive Orchestrator and
was instead offered no Orchestrator role at all.

## Decision

`withOrchestratorAdditiveRole` advertises the additive role for `codex` and `codex-app-server`
whenever the runner would accept the additive launch: an additive-capable driver, a native context,
and nothing else. The function no longer takes a host platform or execution-isolation argument,
because no branch needs one — Pi's verified bridge and Claude Code's approval channel are properties
of the installation, and the platform rules `provisionAgentControl` does have belong to Strict
Project Isolation, which the additive role never enables. A matrix test covers driver × platform ×
execution isolation × approval probe.

The coupled preset is unchanged. `withOrchestratorPreset` still withholds the `orchestrator`
permission mode from a Codex installation without granular approval support or without the audited
sandbox, and the same matrix test asserts that.

The control plane's "audited Linux or macOS sandbox" gate now applies only to the coupled preset:

- **Creation** keeps it for a non-strict *preset* launch, with a message that names the preset's
  forced sandbox and offers independent provider permissions as the alternative.
- **Restart** drops it. That check sat inside the block reached only by a session with independent
  provider permissions, so it had no preset case to protect.

The New Session dialog derives non-strict availability from the shape the launch will actually use.
The additive shape reads `advertisesOrchestratorAdditiveRole`, the same predicate creation and
restart read. The coupled-preset shape keeps the Claude-Code-or-Codex harness rule and Codex's
platform rule, and additionally requires the **preset** advertisement, because a preset launch
submits `permissionMode: "orchestrator"` and `capabilityConfigError` refuses that mode from an
installation that does not advertise it. That last condition is load-bearing only because of this
change: the two advertisements now diverge for real, so a Codex CLI without granular approvals
offers the additive role and not the preset, and a control plane too old to request the role — which
forces every Orchestrator onto the preset — would otherwise have had the dialog submit a launch that
installation cannot run.

No protocol bump. Nothing new is communicated: the control plane already consults
`orchestratorAdditive`, and every disagreement between a new and an old peer fails closed. A new
runner behind an old control plane has its wider advertisement refused by that control plane's own
gate, and the dialog it serves refuses identically. An old runner behind a new control plane simply
does not set the flag, and `advertisesOrchestratorAdditiveRole`'s legacy fallback to the preset
advertisement stays conservative, because the preset's preconditions remain a superset of the
additive ones.

## Consequences

A Codex Orchestrator is now offered on every platform and installation where it can actually run,
including Windows and installations whose CLI predates granular approvals. On a platform without
Codex's audited sandbox, such a session runs with whatever sandbox and approval behaviour its
selected permission mode gives a **normal** Codex session there. That is parity with a normal
session, not a new boundary, and the interface describes it that way: the Execution Permissions copy
already states that provider approval controls and governance still apply and that no read-only
operating-system boundary is claimed, and no platform sentence is shown, because no platform
restriction remains on the additive launch.

Credential scope is unchanged. Strict Project Isolation, Native TUI, ACP, and every pre-existing
`permission_mode='orchestrator'` session keep the coupled preset and its preconditions.
