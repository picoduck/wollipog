# ADR 0009: Additive Orchestrator Role for Codex

- Status: Accepted
- Date: 2026-09-18
- Amends: [ADR 0008](0008-orchestrator-as-an-additive-session-role.md)

## Context

ADR 0008 made the Orchestrator role additive for native Claude Code only. A Codex or Codex App
Server Orchestrator still launched with the coupled preset: `--strict-config`, a fixed granular
approval policy reviewed by Guardian, a forced workspace-write sandbox, `--disable` for apps,
plugins, hooks, multi-agent tools, browser use, computer use and image generation, and an MCP
isolation probe that disabled every configured server but Wollipog's. A user could not run a Codex
Orchestrator with the permission mode and integrations they use for a normal Codex session (#1293).

## Decision

Extend the additive role to the native Codex drivers, gated separately from Claude Code.

- Protocol v161 adds `RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveCodex`. The per-harness
  mapping lives in `orchestratorAdditiveCapability()`, which the control plane, the runner, and the
  New Session dialog all read, so no caller re-derives which driver needs which version. Harnesses
  with no entry (Pi, ACP, and anything new) still require the coupled preset.
- A non-strict Codex Orchestrator launches from the ordinary launch configuration for its selected
  permission mode and adds exactly two settings: `-c mcp_servers.wollipog=<inline table>` carrying
  the `WOLLIPOG_PERMISSION_PRESET` marker that exposes the campaign tools, and
  `-c developer_instructions=<Orchestrator instructions>`. No sandbox, approval policy, reviewer,
  `web_search`, `--add-dir`, `--disable`, or `--strict-config` override is injected, and per-turn
  approval and sandbox parameters in both drivers continue to be derived from the permission mode
  alone.
- The dotted `mcp_servers.<name>` override merges into the user's table rather than replacing it
  (verified against codex-cli 0.154.0), so configured servers survive and the MCP isolation probe is
  unnecessary. The coupled preset's whole-table form merges too, which is precisely why it needs
  `--strict-config` plus the explicit probe to disable the rest; both remain for strict isolation.
- Codex offers no append form for instructions: `developer_instructions` is a plain string, the last
  `-c` wins, and `additional_developer_instructions` is managed-configuration-only and ignored from
  the CLI. Setting it therefore replaces a user's own top-level `developer_instructions` for the
  duration of an Orchestrator session. This is accepted because the coupled preset already does it,
  because the campaign contract is safety-relevant, and because the alternatives (parsing the user's
  `config.toml`, or replacing `base_instructions`) are more fragile or more destructive. A user's own
  `-c developer_instructions=` launch argument is left in place and only loses the last-wins race;
  the runner's resume strip removes only the value carrying its own instructions prefix.
- Strict Project Isolation, Native TUI, and every pre-existing `permission_mode='orchestrator'`
  session keep the coupled preset. No database migration is needed.
- Creation and restart refuse the combination when the runner predates v161, when the harness is not
  a native Codex or Claude Code agent on the host, when the agent does not advertise the Orchestrator
  role, when Strict Project Isolation is enabled, or for a Native TUI launch, each naming the
  required protocol version or the preset as the alternative.

## Consequences

A Codex Orchestrator now holds the same external credentials, integrations, and side-effect
capabilities as a normal Codex session, and the New Session dialog says so rather than implying that
typed workflow decisions govern integrations they cannot intercept. Pi and ACP (#1294) and an
explicit integration-isolation policy (#1295) remain follow-ups.

### Reserved MCP Server Name

The additive launch names its single entry `mcp_servers.wollipog`. A launch whose own arguments
already configure a server under that name is refused with guidance rather than having the user's
server silently replaced or stripped on resume. A server of that name defined only in the user's
Codex configuration file is not detected before launch and is overridden for the Orchestrator
session; `wollipog` is therefore a reserved server name for Orchestrator harnesses.
