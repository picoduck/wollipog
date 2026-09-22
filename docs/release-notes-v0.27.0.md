# Wollipog v0.27.0 — Pi Sessions, Provider Accounts, and Safer Workflows

Wollipog v0.27.0 adds first-class Pi RPC sessions, multiple provider accounts with automatic
failover, richer snoozes and usage views, and safer orchestration workflows. It also makes the
Orchestrator role additive across native Claude Code, Codex, and Pi sessions, strengthens
runner-owned worktree protection and recovery, improves control-plane performance under session
load, and signs release builds on both macOS and Windows.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. Runner protocol advances
from v154 to v174 through capability-gated messages. Current runners are required for Pi RPC
discovery and execution, non-destructive external Pi session adoption, provider-account selection
and sign-in, usage reporting, typed workflow decisions, durable worktree recovery, additive
Orchestrator launches, and optional Integration Isolation. Older runners remain connectable but do
not advertise these capabilities and fail closed when a workflow requires them.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.26.0 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.27.0 processes before restoring the backup
and starting the retained binaries.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## First-Class Pi RPC Sessions

- Discover and verify native Pi RPC installations, including their live model, effort, and command
  catalogs, before offering them as session targets.
- Run Pi as a native harness with bounded RPC parsing, durable session recovery, provider-aware
  authentication state, and fail-closed launch identity checks.
- Inject Wollipog orchestration tools into Pi sessions through a scoped Agent Control bridge, with
  cancellation and extension-failure isolation.
- Preserve durable trust and tool-approval decisions across Pi turns while enforcing permission
  changes at the live bridge boundary.
- Clone completed Pi conversations with bounded checkpoint refresh and cleanup of late responses.
- Discover external Pi JSONL sessions and adopt them through a runner-owned copy, leaving the
  source history untouched and fencing lifecycle ownership before the adopted session can run.

## Safer Managed Worktrees and Recovery

- Protect runner-owned worktrees from provider commands in every supported Claude permission mode,
  with a verified guard hook, control-channel defense in depth, and conservative fallback when the
  guard cannot be proven ready.
- Make the managed worktree's Git link read-only at the sandbox boundary and protect guard state
  with restricted files, integrity checks, and fail-closed invalidation.
- Protect a worktree created during the current provider turn immediately instead of waiting for a
  later relaunch, while preserving the selected permission mode for ordinary commands.
- Recover sessions whose worktree is missing without losing retained prompts, show replacement
  worktree creation progress, and disable Retry while recovery is already live.
- Restart sessions in the worktree they actually own and guarantee that deferred worktree
  retirement receives another replay trigger after the provider releases it.
- Retain shared or moved branch refs until managed-worktree cleanup is safe, journal deferred
  deletion durably, reclaim offline refs, and surface pending-reclamation diagnostics.
- Re-check pull-request state immediately before discarding a worktree so a newly opened or updated
  pull request cannot be retired from stale information.
- Refine command checks so the control channel rejects only location-independent violations while
  the guard evaluates relative paths from the shell's actual working directory.

## Harness-First, Additive Orchestration

- Bind each Orchestrator child policy to a harness, model, and effort as one capability-checked
  selection rather than assuming one provider family.
- Reject stale or malformed campaign policy and require an upgraded runner when a fixed-harness
  campaign cannot preserve its harness binding.
- Keep saved child defaults explainable when a harness, model, or effort becomes unavailable, and
  surface repaired selections without silently changing policy.
- Separate the Orchestrator role from provider permissions for native Claude Code, Codex, Codex App
  Server, and Pi. Additive launches keep the normal session's permission mode, built-in tools, and
  configured integrations while adding Wollipog's orchestration surface.
- Advertise additive Orchestrator support independently from the coupled preset, so compatible
  native harnesses remain selectable without claiming that stricter preset isolation is available.
- Add Integration Isolation as an explicit policy for additive Orchestrators. When enabled it
  removes ambient integrations while preserving the selected provider permissions, built-in tools,
  and project boundary; unsupported peers fail closed.
- Keep ACP Orchestrators on the coupled preset after auditing the adapter's permission contract;
  the additive role is not offered where its behavior cannot be established safely.
- Preauthorize bounded routine Claude coordination and issue-workflow loops while keeping GitHub
  writes interactive and bounding provider-side Git inspection.

## Provider Accounts and Authentication

- Configure multiple accounts for the same provider on one runner and select the account used by a
  new session without leaking account credentials into the agent environment.
- Switch an existing session between compatible provider accounts while preserving its conversation
  and launch context.
- Automatically move a session to another compatible account when the active account is exhausted,
  while fencing stale processes and prompt completions during recovery.
- Drive provider sign-in through the runner, including structured Codex device-code authentication,
  and bind credential-backed skills to the account that owns them.

## Snoozes, Usage, and Earlier Activity

- Snooze work until calendar-relative times or an explicit Someday state, then replace a fired
  reminder atomically when it is snoozed again.
- Aggregate provider usage by hour, day, and week, with compact controls that appear only when the
  connected runner supports them.
- Replace the persistent Earlier Activity button with incremental history paging that preserves
  keyboard focus while older content loads.

## Performance and Session Reliability

- Collapse and batch quiescent snapshot hydration, skip identical terminal snapshot writes, and
  separate replay identities to reduce database churn on busy histories.
- Register the WebSocket upgrade handler once and refresh liveness after runner registration,
  avoiding reconnect storms and long initial-heartbeat stalls.
- Fence Codex completions to the active prompt turn, defer legacy turn failures safely, and clear
  stale provider processes during account recovery.
- Keep live and terminal delivery receipts consistent across queued messages, cancellation, and
  session deletion, including messages sent while an agent is mid-turn.

## Desktop Distribution

- Sign macOS applications and embedded Node sidecars with Developer ID, enable the hardened
  runtime with the V8 JIT entitlements it requires, notarize the bundle, and staple the ticket.
- Fail tag-triggered macOS release builds when signing credentials are absent or incomplete rather
  than publishing an unsigned artifact under a signed-release claim.
- Prefer App Store Connect API-key notarization with an Apple ID fallback, and verify signatures,
  Gatekeeper acceptance, and stapled tickets before the release can proceed.
- Authenticode-sign Windows x64 and ARM64 applications, installers, runner binaries, and headless
  control-plane binaries through Azure Artifact Signing with GitHub OIDC.
- Verify every shipped Windows executable and installer is signed and timestamped before release;
  SmartScreen may still warn until the signing certificate builds download reputation.

## Requests, Review, and Session Continuity

- Keep the generic side panel usable after requests resolve and avoid reopening an empty persisted
  Requests mode.
- Preserve the Requests panel during polling and avoid render churn when descendant request data is
  temporarily unavailable.
- Preserve the selected right-panel mode across switches, keep ended side chats recoverable, and
  remove the obsolete placeholder mode and duplicate launcher affordances.
- Keep review selections anchored through diff refreshes and improve long handoff disclosure
  readability.
- Label checkpoint turn boundaries so conversation history and recovery points are easier to scan.
- Align rewind and fork transcript dividers, avoid duplicate pre-launch recovery errors, and
  preserve recovered answer authentication across replay.
- Present artifact-backed UI evidence directly in campaign review cards and let assigned
  Orchestrators approve or reject it through typed workflow decisions.
- Preserve review anchors, caret position, and selection direction across legitimate diff refreshes,
  and keep right-panel scratch state synchronized across reloads and browser tabs.
- Remove the remaining retired Conductor experiment paths; historical protocol and release records
  remain intact.

The release workflow builds all six supported native targets. Its final verification fails unless
the draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. Canonical and compatibility runner names must be byte-identical, each headless control
plane must match its desktop sidecar, and every manifest entry must match GitHub's publisher digest.
Publishing the verified draft remains a manual operator step.
