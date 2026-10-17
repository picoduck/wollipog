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

The server half of the launch is integrated (see Atomic Launch below). Remaining work under
#2940 is the simple web launch experience on that protocol and verification of the complete live
flow on final main through #2939. Production video review remains #1321.

The deterministic browser fixtures test the real components and the unsupported state. Their
captures prove layout and launch fencing, not unattended readiness or live provider media support.

## Atomic Launch

`POST /api/full-control-campaigns/preflight` and `POST /api/full-control-campaigns` are
Human-only. The request names a workspace (and optionally its Project), a task and/or issue
numbers, and optional overrides (`FullControlLaunchRequest` in
`packages/protocol/src/campaign-control-launch.ts`). The server derives everything else:

- Repository from the runner's inspection of the registered workspace origin; objective from the
  task (or the issue list); the root installation defaults to the controlled reviewer's Claude
  Code installation, else the first available native Claude Code or Codex App Server one, and
  the root joins the workspace's Project.
- Concurrency from `behavior.maximumConcurrentChildren`; accepted follow-ups from the saved
  follow-up policy (none for Recommend Only); closure reasons default to completed. The cost and
  tool-call envelope is always entered by the Human: saved per-session limits (root ceilings,
  Project child-session defaults) are tighter ceilings, and controlled review refuses to run under
  them, so they block readiness instead of becoming the envelope.
- `controlledReview` from the runner's discovered `campaignReview` profile.

The preflight returns `ready`, a digest, a concise `summary` (scope, budget, follow-up policy,
evidence destination/provider with the verbatim retention disclosure, Human Required exceptions,
blockers), per-capability readiness and an `advanced` block with the derived proposal and plan.
Each capability is `verified`, `unsupported` (blocks launch, with an actionable reason) or
`human_required` (a disclosed exception routing that decision class to the Human). Repository
scope, the authority contract, accounting/budget, controlled review and the runner's enforced
execution isolation are mandatory. Screenshot review is delegated when the Orchestrator can review
images; video and external evidence are Human Required until #1321.

Admission requires request identity and the exact reviewed digest. The preflight is computed
from facts re-read after the runner inspection, and admission creates the root synchronously from
those same facts, so saved defaults changed during the inspection invalidate the digest. A request
identity that already committed returns its retained root before readiness is re-evaluated. It then mints the issue scope
from the inspection and the Full Control boundary, and creates the Orchestrator root in one
transaction: scope, matching control and policy revision, original Session ceilings, allowance,
root reservation and request identity. The root is user-owned, so campaign spend and controlled
review are charged to the authorizing Human. A provider command is sent only after commit.
Duplicate identity returns the retained root without another send; a changed identity or a late
SQL failure leaves no partial authority. A Hub send failure cannot prove that zero bytes escaped,
so the root and reservation are retained with uncertain dispatch state and are never replayed
automatically.

The paced-media evidence envelope (`evidenceAuthority`) is minted by the same launch only when
every peer declares the private media contract. The hosting control plane supplies its disclosures:
private Session artifacts of the Human's organization, and the audited native providers with their
advertised models. Disclosure revisions are part of the digest.

The runner inspection lives only as long as its request. Request expiry or a closed connection
drops the pending request, so a late result is discarded and never admits a launch. Version-2
runners receive `campaign_launch_inspect_cancel` for that one request id; they stop scheduling
issue reads and terminate only that inspection's commands, and a runner-side lifetime bounds a
lost cancel. Version-1 runners report `inspectionCancellation: "unsupported"` and remain bounded
by per-command timeouts.

The `full_control_launch_preflight` and `full_control_launch_admission` structured events record
the entry point, readiness, missing and Human Required capability ids, digest and duration. They
exclude task text, scope contents, origin URLs and credentials.
