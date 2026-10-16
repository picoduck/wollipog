# Full Control Launch Preparation

Issue #2940 offers Custom and Full Control in Orchestrator defaults, New Session, and active
Orchestrator Controls. Full Control opens a shared preflight. A supported settings API can save
the preferred mode for future campaigns. This preference grants no authority. Older settings APIs
retain an unsupported preview and refuse saving it. New Session initializes from the saved mode
and refuses Full Control launch while complete admission and execution support are unverified.

The owned preparation delta from PR #3069 is integrated onto main's authority, issue-scope and
budget contracts, preserving subsequent launch UI changes. It advertises no new runner capability
and exposes no agent route for Human admission. The optional preference persists per signed-in
user; legacy payload omission preserves it, and an explicit Custom choice resets it. Existing
campaigns retain their stored control and all selected configuration.

An existing Full Control root campaign has an explicit Revoke Full Control action. It calls the
existing Human-only control endpoint with the displayed current revision. The server advances
the revision and revokes unused decisions, resumes and evidence receipts. Descendants cannot
revoke separately. A conflict reloads current state without replaying the change. The hosting
campaign remains Custom; source fixture tests do not grant an agent Human authority.

The preflight shows the stored repository, objective, issue scope and revisions when available,
bounded follow-ups and closure reasons, fixed root and child choices, isolation, completion,
Session ceilings and authorized operations. It reads the actual campaign budget projection and
distinguishes its envelope, original ceilings, generated allocation, spend and reservations.
Stale provenance or revisions are explicit blockers. Session artifacts use private storage;
unmanaged external evidence retains Human review. Provider/model and retention disclosures do
not constitute actual media-quality or native admission proof.
Unestablished facts are explicit. Codex permission-profile approvals disclose the session lifetime
and remain human-owned; command/file one-time approvals keep their existing semantics.

Final integration remains required work under #2940:

- Compose issueAuthority, budgetAuthority, and evidenceAuthority from the reviewed prerequisite
  contracts behind one authenticated-human selection. Never accept human identity or authorization
  metadata from agent JSON, a role selection, a preset, or defaults.
- Bind the exact repository/objective/issue boundary and permitted related follow-ups and effects.
  Missing issue expansion or closure support must retain its Human Required gate.
- Project budget.authority, original budget.sessionLimits, generated budget.rootAllocation,
  spending and reservations, and budget.requiredNativeReview separately. Preserve the immutable
  aggregate envelope and tighter per-Session ceilings. Exact native admission binds controller/CLI
  hashes, version, read-only profile, account, and agent identity; a capability declaration or
  fixture receipt cannot replace approved admission and actual live proof.
- Disclose the actual artifact destination, retention, reviewer provider/model, media delivery and
  quality. Keep the sole UI Evidence Approval gate. No extra evidence opt-in or fabricated media
  readiness. Unsupported/external evidence continues to require a human.
- Add the atomic authenticated Human launch/enable composition only after all prerequisites are
  integrated. A preferred mode is not admission. Active revocation already uses the current
  revision and revokes incompatible unused grants. Preserve harness, model, effort, isolation,
  and completion choices.
- Verify the complete live flow on final main, including informational completion, through #2939.

The deterministic browser fixtures test the real components and the unsupported state. Their
captures prove layout and launch fencing, not unattended readiness or live provider media support.

## Atomic Launch Source Contract

The Human-only `/api/full-control-campaigns/preflight` route shares the normal session validator
through an internal inspection seam which returns before any stage, insert or provider call.
It binds the resolved model, effort, provider permissions, selected workspace/target, isolation,
child behavior, completion and exact finite proposal into a digest. A distinct admission endpoint
requires request identity and that exact digest. Neither endpoint permits agent authorization
metadata or falls back to ordinary session creation.

The optional negotiated `campaignLaunchInspection` descriptor means only that this runner can
inspect its registered workspace's sanitized GitHub origin and bounded exact issues. Numeric
protocol 220, a preset, image support or a native-review descriptor cannot prove Full readiness.
The inspection returns no origin credentials, local path, issue body or provider environment.

Production admission currently returns a blocked preflight: complete execution, native review,
media, evidence and managed usage proof remain absent. This contract cannot enable Full Control
from partial authority support or caller booleans. The source form has an exact proposal and an
explicit authorization action, fenced by that complete preflight.

Fixture Human admission exercises the internal transaction: root, Human issue-scope provenance,
matching control/policy revision, original session ceilings, allowance, root reservation and request
identity commit together. A provider command is sent only after commit. Duplicate identity reads
the retained root without another send; changed identity or a late SQL failure cannot leave partial
authority. A Hub send failure cannot prove zero escaped bytes, so the root and reservation remain
retained with uncertain dispatch state and cannot replay automatically. These are temporary source
fixture checks, never live authorization, native admission or media-readiness receipts.

The `full_control_launch_preflight` structured event answers which entry point was used, whether
preflight was blocked and which capability categories were missing. Its request ID, digest and
duration support correlation; it excludes proposal text, scope contents, origin URLs and credentials.
