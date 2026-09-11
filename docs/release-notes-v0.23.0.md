# Wollipog v0.23.0 — Orchestration, Skills, and Operational Control

Wollipog v0.23.0 broadens native agent orchestration, turns managed skills into a cross-platform
administrative surface, and makes long-running sessions easier to govern and recover. It also adds
headless service installation and upgrade flows, richer usage and cost controls, GitLab support,
and substantial reliability work across provider launches, worktrees, questions, and background
automation.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. Runner protocol advances
from v96 to v130 through additive, capability-gated messages. Older runners can remain connected,
but native orchestration, Agent Control, session-requested worktrees, workspace references,
managed-skill adoption and reconciliation, service-tier selection, governance history, and newer
usage and recovery evidence require a current runner. The desktop bundle upgrades its embedded
control plane and local runner together.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.22.0 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.23.0 processes before restoring the backup
and starting the retained binaries. The v0.19.0 runner-ownership and legacy-adoption boundaries and
the v0.20.0 secure-transport requirements remain in force.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Native Orchestration and Agent Collaboration

- Extend the Orchestrator preset to supported native Claude and Codex sessions while keeping
  provider execution and child admission fail closed.
- Add a session-scoped Agent Control CLI and MCP surface, including a target-local bridge for
  Direct WSL and hardened native Windows launches.
- Track child sessions under their parent, route attention to exact worker requests, and expose
  provider-authored collaboration lifecycle and cost checkpoints.
- Add conversation forks, checkpoint handoffs, active-turn steering, and workspace-reference
  attachments without replaying uncertain provider work.

## Managed Skills Across Machines

- Import Git-backed skills through immutable previews and explicit updates, with version history,
  guarded rollback, machine-wide pins, groups, and inherited assignments.
- Support read-only machine snapshots and guarded adoption on Linux, macOS, native Windows, and WSL.
- Reconcile managed links through ownership-scoped APIs, preserve foreign files, and recover
  interrupted adoption or compaction transactions.
- Add runner-facing machine matrices and bounded diagnostics so unsupported or stale targets fail
  independently instead of collapsing the entire reconciliation pass.

## Usage, Guardrails, and Governance

- Rebuild Usage around cost and token views with per-model and per-driver breakdowns, per-turn
  accounting, context windows, and provider-reported service tiers.
- Price usage from an explicit model-rate table, preserve provenance, and fail closed when a
  configured budget cannot be measured.
- Add daily user budgets, workflow cost checkpoints, and clearer session guardrail recovery.
- Expose paged governance history and native hook events while recording provider rejections as
  bounded, content-free operational evidence.

## Sessions, Projects, and Forge Workflows

- Combine Sessions list and board views, add row/card context menus, customizable navigation, and
  clearer branch, background-work, attention, and status presentations.
- Add GitLab forge integration and normalize review readiness across supported forges.
- Support session-requested worktrees, hot worktree rebinding, repository-default-branch transport,
  and managed cleanup that is re-proven before every provider launch.
- Preserve structured questions, queued edits, steering receipts, uploads, and recovery state
  across restarts, navigation, compaction, and multi-tab use.

## Headless Deployment and Reliability

- Add `wollipog service` administration for Linux systemd deployments, including install, upgrade,
  diagnostics, host administration, runner credentials, and verified headless artifacts.
- Publish the headless control-plane executable and dashboard bundle alongside standalone runners
  and desktop installers.
- Prevent asynchronous Codex App Server spawn errors from terminating the runner, surface bounded
  provider launch diagnostics, and retry only classified transient failures.
- Strengthen process-tree containment, authentication recovery, SQLite contention handling,
  dependency advisory monitoring, CI timeouts, and merge-queue validation.

Desktop bundles remain unsigned, so operating systems may show an unidentified-developer warning
on first launch. The release workflow builds all six supported native targets. Its final
verification fails unless the draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`, with canonical and compatibility runner names verified byte-identical, each headless
control plane verified byte-identical to its desktop sidecar, and GitHub
publisher digests matching the manifest. Publishing the verified draft remains a
manual operator step.
