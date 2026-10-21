# Full Control Launch Preparation

Issue #2940 offers Custom and Full Control in Orchestrator defaults, New Session, and active
Orchestrator Controls. Full Control launches exactly like a Custom Orchestrator session: choose
it in Orchestrator Policy, press the same Create Session, and write the first message in the
session once it opens. Nothing is filled in or reviewed first. There is no task or issue field,
no readiness banner, no summary rows and no limit entry. The only addition is the Policy row's one
line, "The Orchestrator runs this campaign end to end." The first message is the task.

On Create Session the client runs the server preflight and admits its exact digest in one action,
with one request identity. If the server's facts change in between (a runner reconnect, or a saved
default), the action is retried once. Only a genuine impossibility stops the launch: an
unverifiable repository, a provider path that cannot enforce the authority contract, or an
explicit saved ceiling that cannot be enforced. It appears as the one inline "Couldn't Start the
Session" error, where every launch error appears. Ordinary Create Session never runs for Full
Control. A live root campaign's Enable Full Control is the same single action through the enable
route; Revoke is unchanged. Orchestrator defaults save the preferred mode and a Full Control
campaign budget. Neither grants authority, and older settings APIs refuse saving the mode. With
no saved campaign budget, the campaign has no limit.

The Full Control boundary owns every operation it lists, so the Custom per-decision owners never
apply under it, whatever their toggles say (Review Round Extensions follow Parent Control, #3369).
When Full Control is chosen or in effect, Orchestrator Controls shows only the mode, its line, any
inline blocker, and Enable Full Control or Revoke. Child Session Requests, Workflow Decisions, the
evidence and retention notes, and Campaign Behavior return when Custom is chosen. On the
Customize… Decisions tab, Full Control likewise hides Descendant Requests and the per-gate owners.
A row that has a problem blocking the launch stays visible.

## The First Message Is the Task

A launch that names no task, issue numbers or objective (`FullControlLaunchRequest` with only a
workspace and session overrides) is admitted through the same atomic launch admission. Its
boundary is task-only: the inspected repository, no issues, and the placeholder objective
`FULL_CONTROL_FIRST_MESSAGE_OBJECTIVE`. The root starts with no initial prompt and waits, like any
Orchestrator. Its policy carries `firstMessageScope: { state: "pending" }`.

The authenticated Human's first message to that root (`POST /api/sessions/:id/prompt`, Human lane
only) establishes the boundary before the Orchestrator's first turn:

- Only the person who authorized the launch can send it; anyone else gets 403. It must contain
  text: a slash command or image-only message is refused, so that the task is stated.
- The objective is the message, normalized to one line and bounded to 4000 characters. The
  boundary records the SHA-256 digest of the exact message text (`messageDigest`).
- The issue scope is the message's references to the campaign's own repository (`#123`,
  `owner/repo#123`, `https://github.com/owner/repo/issues/123`). References to other repositories
  and pull request URLs are ignored. The runner then reads each reference, and only verified
  issues are kept: a pull request, a missing issue, or an unreadable origin leaves that reference
  out. With none, the scope stays task-only.
- The next issue-scope revision, and the boundary revision that names it, commit together in one
  compare-and-set on the policy revision (`establishFirstMessageScope`). The launch records which
  limits it derived (`derivedLimits`, no Human override). Only a derived Accepted Follow-Ups or
  Maximum Issues grows to what a launch naming those issues derives, and never shrinks. An
  explicit ceiling never changes, and an explicit Maximum Issues bounds how many referenced issues
  enter the scope. Operations, policy asks, evidence and cost or tool ceilings are unchanged.
- The scope and boundary are synchronized to the runner (`campaign_issue_scope synchronize`)
  before the message is delivered. A runner that misses the update keeps its older revision, which
  authorizes no issue write, and every issue operation synchronizes again before it acts.
- Delivery is crash-safe. The commit records `delivering` with the message digest, so the fence
  is durable, and only the admitted delivery settles it as `established`
  (`settleFirstMessageDelivery`). A message that is not delivered reopens the wait, and the next
  first message establishes a newer revision. On startup, a root still `delivering` is settled
  without resending: `established` if its message was recorded or durably queued, otherwise
  waiting again, still fenced. A first message is therefore never resent.

While the root waits or delivers, every other ingress that can start a provider turn is refused:
prompts from an agent or an automation, direct steering, provider command invocations and campaign
continuations. Agent-authored text therefore can never establish or widen the scope. Later
messages, the owner's included, never change it: scope changes go through the existing scope
review. Revoking Full Control restores Custom: the wait applies only while the control is Full
Control.

Enabling Full Control on an existing campaign that has no issue scope derives one. The repository
comes from the runner's inspection of the root's checkout. The issues are only those parsed from
the authenticated Human's own create request (`issueNumbersSource: "human_launch_request"`), as
the runner verifies them. Transcript messages record no author, and a restart backfill reads the
transcript, so neither is ever scope. Without such issues, the scope is task-only and the campaign
waits for the owner's next message through the same fenced first-message path. A campaign whose scope another person established can't be enabled
by someone else.

## Server Evaluation

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

The preflight reports the stored repository, objective, issue scope and revisions when available,
bounded follow-ups and closure reasons, fixed root and child choices, isolation, completion,
Session ceilings and authorized operations. It reads the actual campaign budget projection and
distinguishes its envelope, original ceilings, generated allocation, spend and reservations.
Stale provenance or revisions are explicit blockers. Session artifacts use private storage;
unmanaged external evidence retains Human review. Provider/model and retention disclosures do
not constitute actual media-quality or native admission proof.
Unestablished facts are explicit. Codex permission-profile approvals disclose the session lifetime
and remain human-owned; command/file one-time approvals keep their existing semantics.

Verification of the complete live flow on final main remains #2939. Production video review
remains #1321.

The deterministic browser fixtures test the real components and the blocked state. Their
captures prove layout and launch fencing, not unattended readiness or live provider media support.

## Atomic Launch

`POST /api/full-control-campaigns/preflight` and `POST /api/full-control-campaigns` are
Human-only. The request names a workspace (and optionally its Project), optionally a task and/or
issue numbers (with neither, the first message is the task), and optional overrides
(`FullControlLaunchRequest` in `packages/protocol/src/campaign-control-launch.ts`). The server
derives everything else:

- Repository from the runner's inspection of the registered workspace origin; objective from the
  task (or the issue list); the root installation defaults to the controlled reviewer's Claude
  Code installation, else the first available native Claude Code or Codex App Server one, and
  the root joins the workspace's Project.
- Concurrency from `behavior.maximumConcurrentChildren`; accepted follow-ups from the saved
  follow-up policy (none for Recommend Only); closure reasons default to completed. Each of the
  cost and tool-call ceilings is this request's override, else the Human's saved Full Control
  campaign budget (`campaignBudget` in Orchestrator defaults; omitted by older clients, cleared by
  `null`), else absent. An absent ceiling is a first-class "no limit" state, never a fake large
  amount: the campaign runs unbounded on that axis while managed workers are still metered and
  priced and Campaign Status shows the usage. Any ceiling that is set is fully enforced. Saved
  per-session limits (root ceilings, Project child-session defaults) are tighter ceilings, never
  the envelope.
- `controlledReview` from the runner's discovered `campaignReview` profile, only when controlled
  review can actually run: a protocol-v218 runner, a user-owned campaign, no organization per-user
  daily limit, and no root, Project or participant per-session ceiling. Otherwise the boundary has
  no controlled reviewer, the summary says the campaign uses the regular cross-model review
  workflow, and the campaign policy tells participants to run that workflow and report its cost.

The preflight returns `ready`, a digest, a `summary` for API clients and logs (scope, budget, follow-up policy,
review, evidence destination/provider with the verbatim retention disclosure, Human Required
exceptions, blockers), per-capability readiness and an `advanced` block with the derived proposal
and plan. Each capability is `verified`, `unsupported` (blocks launch, with an actionable reason),
`human_required` (a disclosed exception routing that decision class to the Human),
`informational` (an infrastructure gap the campaign works around with the best available path) or
`orchestrator_decides` (the Orchestrator owns that class without being able to inspect it, so it
asks for inspectable evidence or denies the claim as unproven).
Only genuine impossibilities are mandatory: repository scope that can be verified, and a provider
path that enforces the authority contract. Accounting is mandatory only when the Human set a
ceiling (an unpriced model cannot enforce a cost ceiling) or the derived limits are invalid, such
as a paused campaign's zero concurrency; with no ceiling, an unpriced model only means tool calls
are counted without a cost. Controlled review and an unreported execution isolation are
informational. Full Control never routes evidence to the Human (#2940): with UI Evidence Approval
in the authorization, screenshot review is `verified` when the Orchestrator can view images and
`orchestrator_decides` otherwise, and external evidence is `orchestrator_decides`. Video is
`orchestrator_decides` unless a current Human-recorded live proof certifies an attested media-only
reviewer on the root's runner (#1321). With one, video is `verified` only when the launch also mints
the evidence envelope for that exact reviewer: UI Evidence Approval is delegated, the root is an
attested Claude Code agent that declares the paced video contract, at the certified model, with
provider disclosures and the video review adapters attached and no blocker. Otherwise the row names
the first missing condition. Only an authorization that leaves UI Evidence Approval out makes the
three evidence rows `human_required`.

The summary's Human Required list holds only what still reaches the Human: those evidence rows, and
"Human Required Governance Rules" while an enabled ask rule is marked Human Required. Its
`declinedNote` states that credential, sign-in, provider-access and lasting-grant requests are
declined automatically and shown as blocked work. See
[Full Control Without Prompts](campaign-authority.md#full-control-without-prompts).

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

An existing live root campaign enables Full Control through
`POST /api/sessions/:id/orchestrator-campaign/full-control/preflight` and
`POST /api/sessions/:id/orchestrator-campaign/full-control`. These are Human-only and the session
owner's. The preflight reuses the launch evaluation, with the campaign's own Human-established
issue scope in place of the workspace inspection. Only the person who established that scope can
enable it. Live participants holding their own cost or tool limits keep controlled review out of
the boundary, so the campaign uses the regular cross-model review workflow.
Enabling requires the exact reviewed digest, which also binds the campaign and its current policy
revision. It then runs the existing `setCampaignControl` operation. Revoke keeps using the ordinary
control endpoint.

In a campaign whose allowance includes controlled review, child creation refuses a resolved
cost or tool-call ceiling (Orchestrator-supplied or from Project child-session defaults) with an
actionable reason. Every admitted child therefore stays admissible for its required review.

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
