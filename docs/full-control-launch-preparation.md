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
