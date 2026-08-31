# Wollipog v0.22.0 — Session Naming, Subagents, and Transcript Refinement

Wollipog v0.22.0 makes session organization more adaptable, agent activity easier to follow, and
managed skills safer at scale. Session naming can now use the session's authenticated agent account,
an explicitly selected agent and model, or a runner-local custom model endpoint. Codex App Server
subagent events gain authoritative lifecycle tracking, and questions, media, history, and mobile
session controls are integrated more naturally into the transcript.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. Runner protocol advances
from v91 to v96 through additive, capability-gated messages. Older runners can remain connected,
but authoritative subagent lifecycle, runner-hosted session naming, runner-local custom naming
models, explicit naming targets, chunked managed-skill delivery, and managed-link removal reports
require a current runner. The desktop bundle upgrades its embedded control plane and local runner
together.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.21.0 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.22.0 processes before restoring the backup
and starting the retained binaries. The v0.19.0 runner-ownership and legacy-adoption boundaries and
the v0.20.0 secure-transport requirements remain in force.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Configurable Session Naming

- Choose prompt-only naming, the session agent's authenticated account, or a runner-local custom
  model endpoint from Runtime Settings.
- Target an explicit runner, agent harness, advertised model, and reasoning effort instead of
  inheriting the active session's defaults.
- Keep custom-model API keys runner-local and write-only while the control plane stores only
  secret-free readiness and configuration state.
- Surface correlated naming failures instead of silently falling back when an authoritative rename
  request fails.

## Agent Interaction and Transcript Clarity

- Track Codex App Server subagents with provider-authored lifecycle states and attribute command
  output to the agent that spawned it.
- Enable Codex structured questions in Default mode, add a keyboard-first text response style, and
  keep pending questions visible in the transcript after hydration.
- Make rejected steering receipts dismissible, including after transcript compaction, and
  distinguish accepted Stop attempts from terminal completion or retry exhaustion.
- Render supported media URLs inline while preserving streaming, focus, horizontal overflow, and
  virtual-scroll anchors as earlier activity loads.

## Managed Skills and Runner Reliability

- Deliver large managed-skill desired states as bounded, digest-addressed chunks and request only
  versions missing from a runner.
- Retain removed managed-skill versions safely, report recent managed-link removals, and avoid
  deleting links the runner did not create.
- Strengthen provider-home leasing, runner shutdown process-tree containment, durable prompt
  delivery, and recovery of cancelled Claude conversations.
- Validate workflow automation capabilities at admission and preserve compatibility when newer
  runners exchange events with older control planes.

## Mobile, Inbox, and Release Quality

- Compact mobile session chrome, keep status badges and project actions visible, and move Settings
  into the rail's More menu.
- Keep live Inbox and transcript viewports anchored, offer manual reordering after a long-held Inbox
  order, and disclose additional session statuses when the header runs out of room.
- Validate production browser bundles and exercise the production build with real xterm smoke
  coverage.
- Pin the package manager and Node runtime floor, expand dependency automation, and update React,
  xterm, Fastify, and Vite while preserving compatibility coverage.

Desktop bundles remain unsigned, so operating systems may show an unidentified-developer warning
on first launch. The release workflow builds all six supported native targets. Its final
verification fails unless the draft holds exactly 27 assets:
14 desktop bundles, 12 runner names, and
`SHA256SUMS`, with canonical and compatibility runner names verified byte-identical and GitHub
publisher digests matching the manifest. Publishing the verified draft remains a
manual operator step.
