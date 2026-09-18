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

Protocol v163 adds `RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditivePi` and a `pi` entry in
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

### The role is advertised separately from the preset

Review round 1 found additive Pi unreachable under the default runner configuration, from a single
root cause: the literal `"orchestrator"` in `capabilities.permissionModes` was doing double duty for
two different claims — "the coupled preset is launchable here" and "the Orchestrator role is
launchable here". Those genuinely differ. The preset advertisement also encodes the Strict Project
Isolation filesystem boundary, so a bridge-verified Pi installation on a runner using the default
`provider` execution isolation (or on Windows) offered neither, and the control plane refused the
additive launch at its advertised-mode check.

The preset advertisement is unchanged — it correctly describes the preset, boundary requirements
included. A second, independent one is added beside it:

- `AgentCapabilities.orchestratorAdditive` (additive field; no protocol bump beyond v163 is needed,
  because only a v163+ runner publishes it and the per-harness gates already exist).
- `withOrchestratorAdditiveRole` sets it exactly when `provisionAgentControl` would accept the
  additive launch: an additive-capable driver, a native context, and the per-harness precondition —
  for Pi the verified Agent Control bridge and **not** the filesystem boundary. Never for WSL or
  ACP. Claude keeps the precondition it already used, so its behaviour is unchanged. Codex keeps
  today's effective requirement; its additive role does not strictly need the granular-approval
  capability or the audited sandbox, but widening it is deliberately out of scope here.
- `advertisesOrchestratorAdditiveRole(driver, capabilities)` is the single rule read by session
  creation, session restart, and the New Session dialog, so they cannot drift. For Claude and Codex
  it falls back to the preset advertisement, keeping v160–v162 runners working; **Pi is excluded
  from that fallback**, because its preset advertisement requires the strict boundary — reading one
  as the other is exactly the false negative — and no pre-v163 runner has an additive Pi shape.
- For Pi this attestation is also how the verified bridge reaches the control plane at all:
  `agentsForControlPlane` deliberately clears `piAgentControl` before publishing, and the
  control-plane database never persists it, so neither the server nor the dialog can read it.

Because an installation can now offer the role without the preset, the dialog must refuse the two
shapes that still require the preset: Strict Project Isolation and Native TUI both surface a
blocking sentence naming the preset as the missing piece, rather than letting the user submit a
launch the control plane would reject.

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
  > **Corrected by the audit below (#1306).** The `_meta` half of this is right; the
  > conclusion drawn from it is too strong. The mode *is* observable and constrainable over the
  > standard ACP session-mode channel, which `AcpClient` already speaks. Read
  > [Answer 1](#answer-1--observing-and-constraining-the-effective-permission-mode) before relying
  > on this bullet. The determination is unchanged — ACP stays on the preset — but for different
  > reasons.
- `AcpClient`'s single `orchestrator` boolean couples several independent concerns: the exact-adapter
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

### Incidental finding (fixed by #1306; see the audit below)

While reading 0.75.1 it became clear that the coupled preset's `permissionMode: "dontAsk"` in
`orchestratorAcpSessionMeta` is **silently ignored** by the audited adapter, for the reason in the
second bullet above. The preset is still fail-closed — `allowedTools` plus `AcpClient`'s
cancellation of every permission request close it — but it is closed by those two mechanisms, not by
`dontAsk`, and `orchestrator-preset.test.ts` asserts that field as though the adapter honored it.
This is pre-existing and orthogonal to #1294; it belongs with the audit above. #1306 corrected that
assertion: `dontAsk` is still asserted as present, but now documented as inert — the audit found it
is overwritten *and* is not an available ACP mode — alongside a new assertion on the tool boundary
that does the enforcing.

## Audit Result: ACP Stays on the Coupled Preset (#1306)

- Date: 2026-09-18
- Verdict: **not sound** — the additive ACP launch is not delivered.
- Evidence: `@agentclientprotocol/claude-agent-acp` **0.75.1**, the pinned release named by
  `CLAUDE_AGENT_ACP_ORCHESTRATOR_VERSION`, fetched from the registry and read as shipped
  (`npm pack`, tarball sha `d307461a7c974c2fbf6bb0871bc5a1d0ec7a846d`). Line numbers below are
  `dist/acp-agent.js` unless stated otherwise.

The five questions are answered. Two of them are answered *better* than the section above assumed,
and one of those answers corrects it. The verdict is unchanged, because the remaining gaps are
design decisions that cannot be settled by reading the adapter.

### Answer 1 — observing and constraining the effective permission mode

**Answered, and the earlier finding is corrected: the mode is both observable and constrainable.**
It is simply not addressable through `_meta`.

The `_meta` half of the original finding holds exactly as written. `options` is assembled at 5960
with `...userProvidedOptions` spread at 5964, and `permissionMode: initialPermissionMode` assigned
after it at 5981, so `_meta.claudeCode.options.permissionMode` is overwritten and ignored. The mode
actually used is `initialPermissionMode = creationOpts.permissionMode ?? permissionMode` (5857),
where `permissionMode` is `resolvePermissionMode(settings.permissions?.defaultMode)` (5856).
`creationOpts` is `createSession`'s *second, internal* argument (5763), and `newSession` — the ACP
`session/new` entry point — passes only `{ resume }` (958). So at creation the mode does come from
the user's own settings, and a user default of `bypassPermissions` is honored whenever
`ALLOW_BYPASS` (`permissions/modes.js:3`, true unless the process is root).

What the original finding missed is that ACP has a **first-class session-mode channel**, and the
adapter implements all of it:

- **Observed.** `createSession` returns `{ sessionId, modes, configOptions }`, `modes` being
  `{ currentModeId, availableModes }` from `SessionModeManager.initialize` (6214). That is the
  `session/new` response, and `getOrCreateSession` (5708) returns it for `session/load` and
  `session/resume` too. `AcpClient` *already* reads it — `acceptSessionState(res.modes, …)` at
  `acp.ts:261/286/295`.
- **Constrained.** `session/set_mode` is wired to `setSessionMode` (8202), which calls
  `query.setPermissionMode()` and throws on refusal (`session-mode.js:98-129`). `AcpClient` already
  drives it — `setMode` at `acp.ts:435`, via `setConfig`/`restoreInitialConfig`.
- **Tracked.** Changes arrive as `current_mode_update`, which `AcpClient` already consumes
  (`acp.ts:740`).
- **Not unilaterally escalatable by the model.** Every `setMode` update originates in
  `applyClaudePermissionSelection` (`permissions/effects.js:140`), which is driven by the
  `optionId` *the client itself selected* in its `session/request_permission` response. Even the
  `bypassPermissions` escalation out of plan mode (`effects.js:76,109`) requires the client to have
  picked that option. The model cannot move the mode on its own.

There is no execution window at creation: no turn runs until `session/prompt`, so a client may read
the mode from the `session/new` response and correct it before anything executes.

Two residual gaps remain, and they are why this answer is "yes, but":

1. **No read-back primitive.** ACP has no "get current mode" request. A client's knowledge of the
   effective mode is only as fresh as the last response or notification it received.
2. **Silent reversion on internal query recreation.** Three paths recreate the query by calling
   `createSession` with **no** `permissionMode` in `creationOpts` — provider update (6367),
   sign-out respawn (1557), and the never-persisted fallback (1567). Each therefore re-derives the
   mode from `settings.permissions.defaultMode`, discarding a mode the client had set. And
   `SessionModeManager.initialize` publishes **no** `current_mode_update`
   (`session-mode.js:12-35`), so the client is never told. Combined with (1), the client's view can
   diverge from the live mode silently and in the permissive direction. The sign-out variant is the
   sharp one: it runs *inside* `prompt()` (1384-1386), i.e. after the client's last opportunity to
   set the mode and before the turn executes — a window a client cannot close from its side.

   Neither path is reachable under Wollipog's current launch: Wollipog never sends `providers/set`
   or `providers/disable`, and never passes `--hide-claude-auth`, which
   `markSessionForSignOutRespawn` requires (1487). So this is a latent contract hazard rather than
   a live defect — but it is unpinned by anything Wollipog controls, and it is precisely the
   property an additive Orchestrator would have to depend on.

### Answer 2 — `session/request_permission` for an Orchestrator

**Mechanically answered; the policy is not.** The adapter deliberately does **not** auto-allow on
mode: "Claude Code applies bypassPermissions before invoking canUseTool; a request that still
reaches this callback is deliberately bypass-immune" (5273-5278). So requests that arrive are safety
checks that survived the provider's own mode, and cancelling them — which `AcpClient` does today for
every preset session (`acp.ts:824`) — is right for the preset (cancel reads as deny, fail-closed)
and wrong for an additive session.

The transport for doing better already exists: with the preset flag clear, `handlePermission`
(`acp.ts:823-847`) surfaces the request to the Wollipog UI exactly as it does for any ordinary ACP
session. What is *not* settled is the policy: an Orchestrator is an autonomous session holding a
scoped control-plane credential, and this ADR does not decide who answers a bypass-immune safety
prompt on its behalf, or what a timeout means. That is a design decision, not a reading of 0.75.1.

### Answer 3 — client-side fs/terminal services

**Not answered; genuinely undecided.** The current blanket refusal (`acp.ts:851-901`) is defense in
depth for the preset, and an ordinary ACP session allows these services. Which of them an additive
ACP Orchestrator should expose depends on the answer to Question 2 and on the execution-isolation
policy, and cannot be derived from the adapter. Left open deliberately.

### Answer 4 — splitting `AcpClient.orchestrator`

**Answered, and the identity half is delivered in this change.** The boolean couples *five*
concerns in `AcpClient`, not the four counted above — identity assertion (`acp.ts:236`), runner-owned
`_meta` injection (324), permission cancellation (824), client fs/terminal refusal (851-901), and
slash-command suppression (150, 737) — plus two more in `AcpDriver`: provider-command refusal and the
`providerConfig` permission-mode strip.

The identity concern is now separated. `AcpClient` takes an `orchestratorRole` flag distinct from
the preset `orchestrator` flag, and the exact-adapter assertion keys on the role. `AcpDriver` derives
the role from `config.permissionMode === "orchestrator"` **or** the presence of runner-owned
`orchestrator` role metadata, so either signal alone arms the assertion. This is monotonic: it is
never weaker than the preset literal it replaces, including for legacy sessions that predate the
metadata field, and an additive shape could not silently drop it. A test in
`acp-conformance.test.ts` pins all three cases — additive, coupled preset, and ordinary session.

The remaining four concerns stay coupled to the preset flag and are untouched here.

### Answer 5 — a pinned adapter release

**Answered for the preset; unchanged for an additive contract.** The pin is 0.75.1, enforced twice:
statically by `supportsClaudeAgentAcpOrchestrator` against the registry entry or an exactly pinned
`npx` argv, and again at runtime by `assertClaudeAgentAcpOrchestratorIdentity` against the live
`initialize` response. Everything recorded in this audit was verified against that release. An
additive contract would need the same pin re-verified against whichever release it targets —
including the Answer 1 recreation paths, which are adapter-internal and may move between releases.

### Why this is still "not sound"

Question 1 is in materially better shape than this ADR previously recorded, and Question 4's
identity risk is now closed. But Questions 2 and 3 are open **design** questions rather than
verification gaps, and Question 1 retains a silent-divergence path with no read-back primitive to
detect it. An additive ACP Orchestrator holds a scoped control-plane credential and child-spawning
authority; the standing rule for that combination is that an unresolved question resolves to "not
sound". ACP therefore keeps the coupled preset, and the refusals in the runner, the control plane,
and the New Session dialog remain accurate as written: there is still no audited additive ACP
contract to launch.

This is a narrowing of the open surface, not a reversal. A future attempt starts from Questions 2
and 3, and from a mode-enforcement design that does not assume the client's cached `currentModeId`
is authoritative.

## Consequences

A Pi Orchestrator now keeps the permission mode, extensions, skills, prompt templates, context
files, and tool inventory of a normal Pi session, and its approvals behave identically. Strict
Project Isolation, Native TUI, ACP, and every pre-existing `permission_mode='orchestrator'` session
keep the coupled preset. No database migration is needed. Creation and restart refuse an additive Pi
launch when the runner predates v163, when the agent no longer advertises the Orchestrator role
(`orchestratorAdditive`, which is how the loss of the verified bridge reaches the control plane,
since `piAgentControl` is not persisted), when the context is not native on the host, when Strict
Project Isolation is enabled, or for a Native TUI launch. An explicit integration-isolation policy (#1295)
remains a follow-up.

The ACP audit is no longer a follow-up: #1306 completed it and recorded the result above. ACP keeps
the coupled preset. What changed in the code is confined to the identity concern — the exact-adapter
assertion now keys on the Orchestrator role rather than the preset permission-mode literal, so it
cannot be dropped by a future additive shape — plus the corrected `dontAsk` test assertion. No
protocol bump was needed, because no new launch shape was added.
