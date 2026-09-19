# Wollipog v0.27.0 — Pi Sessions, Safer Worktrees, and Additive Orchestration

Wollipog v0.27.0 adds first-class Pi RPC sessions, orchestration tools, conversation cloning, and
safe adoption of external Pi histories. It also makes the Orchestrator role additive across native
Claude Code, Codex, and Pi sessions, strengthens runner-owned worktree protection and recovery, and
ships signed, notarized, and stapled macOS desktop bundles.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. Runner protocol advances
from v154 to v164 through capability-gated messages. Current runners are required for Pi RPC
discovery and execution, non-destructive external Pi session adoption, harness-scoped Orchestrator
child policy, durable worktree recovery, additive Orchestrator launches, and optional Integration
Isolation. Older runners remain connectable but do not advertise these capabilities and fail closed
when a workflow requires them.

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

## Desktop Distribution

- Sign macOS applications and embedded Node sidecars with Developer ID, enable the hardened
  runtime with the V8 JIT entitlements it requires, notarize the bundle, and staple the ticket.
- Fail tag-triggered macOS release builds when signing credentials are absent or incomplete rather
  than publishing an unsigned artifact under a signed-release claim.
- Prefer App Store Connect API-key notarization with an Apple ID fallback, and verify signatures,
  Gatekeeper acceptance, and stapled tickets before the release can proceed.
- Keep Windows bundles unsigned; SmartScreen may still warn on first launch.

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
- Remove the remaining retired Conductor experiment paths; historical protocol and release records
  remain intact.

The release workflow builds all six supported native targets. Its final verification fails unless
the draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. Canonical and compatibility runner names must be byte-identical, each headless control
plane must match its desktop sidecar, and every manifest entry must match GitHub's publisher digest.
Publishing the verified draft remains a manual operator step.
