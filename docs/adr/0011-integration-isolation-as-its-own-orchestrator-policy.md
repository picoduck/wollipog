# ADR 0011: Integration Isolation as Its Own Orchestrator Policy

- Status: Accepted
- Date: 2026-09-18
- Amends: [ADR 0007](0007-separate-orchestrator-role-from-project-isolation.md),
  [ADR 0008](0008-orchestrator-as-an-additive-session-role.md),
  [ADR 0009](0009-additive-orchestrator-role-for-codex.md),
  [ADR 0010](0010-additive-orchestrator-role-for-pi.md)

## Context

ADR 0007 required that any policy which intentionally removes provider integrations be independently
configurable, accurately disclosed, and not inferred from the Orchestrator role. Strict Project
Isolation was the only such policy, and it bundled two unrelated things: the scratch-only project
boundary, and the removal of hooks, settings sources, configured MCP servers, and most built-in
tools.

A user who wants ordinary project permissions but no ambient integrations for a campaign parent had
no way to ask for that (#1295).

## Decision

`OrchestratorExecutionDefaults.integrationIsolation` is a second, independent execution policy. It
travels through user defaults, per-session overrides, the stored campaign snapshot (with its own
provenance entry), the launch policy sent to the runner, and the runner's persisted session meta. It
is fixed at creation like the rest of the execution policy, and a nested Orchestrator inherits it
from the controlling campaign snapshot. The system default is `false`.

When enabled, the Orchestrator launches with **only Wollipog's management tools as integrations**.
The provider permission mode, built-in tool inventory, sandbox and approval behaviour, and the
working directory are exactly those of the ordinary additive launch. The launch adds no
permission-mode, sandbox, approval, reviewer, tool-inventory, or `--add-dir` argument, and when the
policy is disabled the launch is byte-identical to the v163 additive launch.

### Scope: ambient discovery, not the operator's launch arguments

Integration Isolation removes integrations the user's *environment* supplies implicitly — settings
files, installed plugins, discovered extensions and skills, configured MCP servers. It does **not**
remove an integration named explicitly in the agent definition's launch arguments (a catalog
`--mcp-config`, `--extension`, or `-c mcp_servers.<name>=…`). Those are part of the harness
installation an operator deliberately configured and are visible in the Agents catalog; removing
them would also mean deleting user-supplied launch arguments, which every strip function in this
codebase is forbidden to do. The rule is uniform across all three harnesses so the disclosure can be
one sentence.

### Claude Code

`--strict-mcp-config` plus `--setting-sources ""`. Wollipog's own managed policy-hook `--settings`
file is **kept**.

Measured against the installed claude 2.1.270, with a `SessionStart` hook that touches a marker file
and `claude … -p x --model <invalid>` so the run ends before a model call:

| probe | result |
| --- | --- |
| `--settings hooks.json` | marker written — a `--settings` file's hooks run |
| `--settings both.json` (hooks **and** `"disableAllHooks":true`) | no marker — `disableAllHooks` stops hooks in the very same file |
| `CLAUDE_CONFIG_DIR=… --settings hooks.json` | both the user-settings marker and the `--settings` marker |
| `CLAUDE_CONFIG_DIR=… --setting-sources "" --settings hooks.json` | only the `--settings` marker — user settings are ignored, ours still runs |
| `--settings a.json --settings b.json` | only `b.json`'s marker — a second `--settings` replaces the first |
| `--setting-sources project --setting-sources ""` | no project marker — the last occurrence wins |

`disableAllHooks` is therefore rejected: it would also disable Wollipog's manager policy hooks, which
are governance, not a user integration, and which carry the `hook` elicitation transport the
permission mode uses to ask a human for approval. Removing them would change the permission surface,
which this policy must not do. `--setting-sources ""` is the only lever Claude offers that separates
the two hook sources, and the measurement above shows it does exactly that.

`--restricted` and `--bare` were also rejected: `--restricted` removes built-in tools and confines
the file tools, and `--bare` changes authentication, attribution, and CLAUDE.md discovery. Both are
far more than the integration surface.

**Known residual, disclosed rather than hidden.** Permission *rules* (`permissions.allow` / `ask` /
`deny` and `defaultMode`) declared in user, project, or local settings files are dropped together
with those files, because Claude has no per-source hook switch. The permission *mode* is unaffected —
the Claude driver always passes an explicit `--permission-mode` — but a `deny` rule declared in user
settings does not apply to an integration-isolated Orchestrator. There is no way to re-declare those
rules: the measurement above shows a second `--settings` replaces the first, so re-emitting them
would displace either the runner's own governance hook settings or the user's. This is the one place
where the policy reaches beyond integrations, and it is stated in the UI, here, and in DRIVERS.md.

### Codex and Codex App Server

`--disable apps --disable plugins --disable hooks`, plus the existing live `codex mcp list --json`
isolation probe, which enumerates the effective MCP inventory at the real launch cwd and emits
`-c mcp_servers.<name>.enabled=false` for everything but Wollipog's entry. `--disable <feature>` is
exactly `-c features.<name>=false` (`codex --help`, codex-cli 0.154.0).

`multi_agent`, `browser_use`, `computer_use`, and `image_generation` are deliberately **not**
disabled. They are Codex's own built-in tool inventory, not integrations the user configured, and the
additive contract preserves the tool inventory exactly; the issue's list is "hooks, plugins,
extensions, or skills" plus MCP servers. The coupled preset disables them because it replaces the
whole tool surface, which this policy does not.

`--strict-config` is not used either. It makes Codex reject unrecognised `config.toml` fields, which
is a launch-failure policy rather than an integration boundary, and it would make an isolated
Orchestrator fail on configuration an ordinary session accepts.

Codex 0.154.0 exposes no stable feature flag for host-discovered skills (`skip_host_skill_discovery`
is "under development", and the runner's rule is that unknown or unstable feature flags fail launch
rather than degrade). Disabling `plugins` removes the plugin channel skills arrive through; the
residual is recorded here rather than claimed away.

### Pi

`--no-extensions --no-skills --no-prompt-templates --no-context-files`, and **not**
`--exclude-tools`: excluding built-in tools is tool inventory, which the coupled preset owns.

`pi --help` (0.85.0) states that `--no-extensions` "Disable[s] extension discovery (explicit -e paths
still work)", so the discovery-verified Wollipog Agent Control extension that provisioning appends as
`--extension <session file>` still loads and the orchestration tools remain available.

Pi's isolation switches are plain booleans with no runner-owned value, so a catalog definition that
already carries one is indistinguishable from the runner's injection. The additive Pi identity check
therefore compares the launch against the discovery-verified definition with those switches removed
from **both** sides, so a user flag can neither break the check nor be silently duplicated.

## Compatibility

`RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorIntegrationIsolation = 164`. An older runner accepts the
launch policy block but has no field for the policy, so it would launch WITH every ambient
integration the human asked to remove.

The control plane therefore **refuses** creation and restart of an additive Orchestrator with
`integrationIsolation: true` on a pre-v164 runner, and the runner throws before minting a credential
if the control plane is older than v164 or the harness has no additive shape.

This deliberately diverges from `delegatedParentControl`, where a saved account default downgrades to
a `compatibility_fallback` source instead of failing. That downgrade is safe because dropping
delegation only *narrows* what a session may do. Silently dropping this policy would *broaden* the
launch's reach into the user's credentials and tools, so it fails closed for a saved user default
exactly as it does for an explicit per-session override.

The coupled preset needs nothing new: every preset launch — Native TUI, ACP, legacy, and the
non-strict Claude/Codex preset shapes — already replaces the provider surface, on every runner ever
shipped. Its effective and stored value is `true`, attributed to the provenance of the boundary that
implied it, and an explicit override asking for `false` under the preset is refused rather than
stored as a value the launch would contradict.

The one residual in that claim: the non-strict Claude *preset* shape does not pass
`--setting-sources ""`, so user settings hooks are still evaluated for it. They cannot introduce
integration tools, because that shape's `--allowedTools`/`--disallowedTools` allowlist is closed. It
is recorded here rather than fixed, because this issue must not change any preset launch.

## Migration

Existing campaigns keep the launch they already have. The migration reads `permission_mode`, the only
durable record of which shape a session was created with: a coupled-preset session becomes `true`
(it launches through the runner-owned planning surface, which carries no user integration), and an
additive session created since v160 becomes `false`. The provenance is `legacy_session`. The
per-user settings column defaults to 0.

`orchestratorCampaignPolicyFromJson` carries a read-time derivation for rows an older control plane
writes after that migration has run; it falls back to `strictProjectIsolation`, because a strict
policy is only ever delivered by a preset launch.

## Consequences

- A user can now ask for ordinary project permissions with no ambient integrations, which ADR 0007
  required and Strict Project Isolation could not express.
- Two independent execution policies mean two provenance entries and two capability stories; both
  are resolved in `resolveOrchestratorCampaignPolicy` so no caller re-derives either.
- The Claude permission-rule residual is real and is disclosed. If Claude ever gains a per-source
  hook switch, or a way to merge a second `--settings` file, this ADR should be revisited.
