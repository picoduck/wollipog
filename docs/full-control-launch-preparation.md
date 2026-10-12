# Full Control Launch Preparation

Issue #2940 prepares Custom and Full Control in Orchestrator defaults, New Session, and active
Orchestrator Controls. Selecting Full Control opens a shared preflight. Activation is explicitly
unavailable; Save Defaults and Create Session are fenced while this preview is selected. Returning
to Custom preserves the existing controls. Previewing an active campaign never changes its mode.

This preparation is stacked on the immutable authority foundation from PR #3061. It does not
advertise a protocol capability, create a grant, persist Full Control defaults, or expose an agent
route for human admission. It retains the original server-owned control object, including evolving
authority subobjects, rather than reconstructing authorization from display facts.

The preflight shows the stored repository, objective, issue scope and revisions when available,
fixed root and child choices, isolation, completion, Session ceilings, and authorized operations.
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
- Add the authenticated default/launch/active operations only after all prerequisites are integrated.
  Defaults affect new campaigns; active enable/revoke checks the current revision and revokes
  incompatible unused grants. Preserve harness, model, effort, isolation, and completion choices.
- Verify the complete live flow on final main, including informational completion, through #2939.

The deterministic browser fixtures test the real components and the unsupported state. Their
captures prove layout and launch fencing, not unattended readiness or live provider media support.
