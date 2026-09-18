# ADR 0010: Additive Orchestrator Role for Pi, and Why Not for ACP

- Status: Accepted
- Date: 2026-09-18
- Amends: [ADR 0008](0008-orchestrator-as-an-additive-session-role.md),
  [ADR 0009](0009-additive-orchestrator-role-for-codex.md)

## Context

ADR 0008 made the Orchestrator role additive for native Claude Code; ADR 0009 extended it to the
native Codex drivers. Pi and ACP were left on the coupled preset (#1294).

A Pi Orchestrator launched with `--no-extensions --no-skills --no-prompt-templates
--no-context-files --exclude-tools bash,edit,write`, never approved repository extensions, and
replaced the selected permission mode with the preset literal. An ACP Orchestrator received
runner-owned session metadata that fixed the tool allowlist, disabled hooks and settings sources,
and supplied Wollipog as the sole MCP server.

## Decision: Pi Becomes Additive

Protocol v162 adds `RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditivePi` and a `pi` entry in
`ORCHESTRATOR_ADDITIVE_CAPABILITY`. The control plane, the runner, and the New Session dialog all
read it through `orchestratorAdditiveCapability()`, so no caller re-derives the mapping.

A non-strict Pi Orchestrator launches exactly as an ordinary Pi session and gains only:

- `--append-system-prompt <Orchestrator instructions>`, and
- `WOLLIPOG_PERMISSION_PRESET=orchestrator` in the agent environment.

There is no third thing. Pi's Wollipog tools already arrive through the discovery-verified Agent
Control extension that **every** verified Pi session loads; that environment marker is what selects
the orchestration subset of the MCP tool catalog (`wollipog-cli.ts`). Nothing narrows the permission
mode, the built-in tool inventory, extensions, skills, prompt templates, or context files.

### The approval path is the ordinary one

Every permission branch in `pi-rpc.ts` keys on the **coupled preset literal**
`permissionMode === "orchestrator"`, and an additive Orchestrator carries an ordinary mode. So the
additive shape takes the normal path with no driver change at all:

- it waits for Pi's `project_trust` event (`waitsForProjectTrust`),
- it receives `--no-approve` only when a normal session of that mode would,
- approvals flow through the verified Agent Control bridge for the selected mode, and
- **it is not auto-confirmed.**

That last point is the load-bearing one. The preset's blanket auto-confirm is safe *only* because
the preset also excludes `bash`, `edit`, and `write`. The additive launch keeps those tools, so
carrying the auto-confirm across would be a real privilege escalation. A test asserts that an
additive Pi Orchestrator in an approval-enforcing mode raises a human approval (or fails closed) and
never sends `confirmed: true`.

### One preset behavior had to be split out

The Agent Control extension re-activated `read`/`grep`/`find`/`ls` whenever
`WOLLIPOG_PERMISSION_PRESET` was `orchestrator`. That restores the read-only surface the preset
itself removed, but under the additive role it would re-enable tools a user's `--tools` allowlist or
`--exclude-tools` denylist deliberately removed. The role marker and that preset-only behavior are
now separate signals: `PI_ORCHESTRATOR_PRESET_TOOLS_ENV` is set only by the coupled preset.

### Measured against the installed CLI

Against pi 0.85.0: `dist/cli/args.js` pushes every `--append-system-prompt` onto an array and
`dist/core/agent-session.js` joins them with a blank line, so the runner's append never displaces a
user's own — both reach the system prompt, and there is no reserved name to collide with. The flag
is matched by **exact string equality** and consumes the next argument; `--append-system-prompt=TEXT`
is not that flag at all (it falls through to the unknown-flag branch and is handed to extensions).
The resume strip therefore matches only the space-separated form carrying the runner's own
instructions prefix, so it can never delete a user argument Pi reads as something else.

### Pre-existing limitation, deliberately not changed

The control plane has never admitted a *coupled-preset* Pi Orchestrator: its general Orchestrator
harness gate lists only Codex, Codex App Server, Claude Code, and ACP. This ADR adds Pi to that gate
for the additive shape only. Enabling a strict, coupled-preset Pi Orchestrator is a separate change
that would need its own audit of the preset launch, and is not part of #1294.

## Decision: ACP Stays on the Coupled Preset

An additive ACP contract is **not** delivered. The mechanism exists, but soundness cannot be
established from the code available today, and the issue's own gate ("the ACP provider-mode
permission contract has not been audited") still holds.

What was established, by reading the exact audited release
`@agentclientprotocol/claude-agent-acp` 0.75.1 (`dist/acp-agent.js`):

- An additive session shape is *mechanically* possible. Dropping `settingSources: []` restores the
  adapter's `["user","project","local"]` default, which is what loads the user's own MCP servers;
  the Wollipog server arrives on the wire and is merged on top rather than replacing them
  (`mcpServers: { ...userProvidedOptions?.mcpServers, ...mcpServers }`).
- **Wollipog cannot observe or constrain the effective ACP permission mode.** `permissionMode` is
  resolved from `settingsManager.getSettings().permissions?.defaultMode` and is assigned *after* the
  `...userProvidedOptions` spread, so `_meta.claudeCode.options.permissionMode` is ignored. An
  additive ACP Orchestrator would therefore receive a control-plane credential and child-spawning
  authority under a permission posture Wollipog neither chooses, sees, nor can report — including a
  user default of `bypassPermissions`.
- `AcpClient`'s single `orchestrator` boolean couples four independent concerns: the exact-adapter
  identity assertion, the runner-owned `_meta` injection, the refusal of client fs/terminal
  services, and the cancellation of `session/request_permission`. `AcpDriver` derives that boolean
  from `permissionMode === "orchestrator"`, so an additive ACP session would clear it and
  **silently drop the exact-adapter identity assertion** — directly violating the requirement that
  identity checks are unchanged. Making this sound means splitting one flag into independently
  audited concerns and re-verifying each.

Forcing an additive ACP shape on top of these three facts would trade an audited restriction for an
unmeasured one. ACP therefore keeps the coupled preset, and the refusals in the runner, the control
plane, and the New Session dialog now name the actual reason rather than a generic harness list.

### What an audit would need to establish

1. How the adapter's effective permission mode can be **observed and constrained** by the client,
   so an Orchestrator is never granted campaign authority under an unknown posture. Today it is
   settings-derived and not addressable through `_meta`.
2. Whether `session/request_permission` reaches the Wollipog UI correctly for an Orchestrator, and
   what must happen to requests the adapter deliberately makes bypass-immune. The adapter does not
   auto-allow on mode, so requests that survive the provider's own mode must be surfaced, not
   cancelled as they are today.
3. Which client-side fs/terminal services an additive ACP Orchestrator should expose. The current
   blanket refusal is defense in depth for the preset; an ordinary ACP session allows them.
4. A separation of `AcpClient.orchestrator` into role, identity, metadata, and client-service
   concerns, so the additive shape keeps the identity assertion while relaxing only the rest.
5. A pinned adapter release for the additive contract, with the above re-verified against it.

### Incidental finding (not fixed here)

While reading 0.75.1 it became clear that the coupled preset's `permissionMode: "dontAsk"` in
`orchestratorAcpSessionMeta` is **silently ignored** by the audited adapter, for the reason in the
second bullet above. The preset is still fail-closed — `allowedTools` plus `AcpClient`'s
cancellation of every permission request close it — but it is closed by those two mechanisms, not by
`dontAsk`, and `orchestrator-preset.test.ts` asserts that field as though the adapter honored it.
This is pre-existing and orthogonal to #1294; it belongs with the audit above.

## Consequences

A Pi Orchestrator now keeps the permission mode, extensions, skills, prompt templates, context
files, and tool inventory of a normal Pi session, and its approvals behave identically. Strict
Project Isolation, Native TUI, ACP, and every pre-existing `permission_mode='orchestrator'` session
keep the coupled preset. No database migration is needed. Creation and restart refuse an additive Pi
launch when the runner predates v162, when the agent no longer advertises the Orchestrator role
(which is how the loss of the verified bridge reaches the control plane, since `piAgentControl` is
not persisted), when the context is not native on the host, when Strict Project Isolation is
enabled, or for a Native TUI launch. An explicit integration-isolation policy (#1295) and the ACP
audit above remain follow-ups.
