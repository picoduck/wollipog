# Contributor Campaign Workflow

Read `AGENTS.md`, the shipped `using-wollipog` authority reference, applicable installed issue and
review workflows, and `.github/ISSUE_REPORTING.md`. Repository workflows belong here and under
`.agents/`; shipped `skills/` must remain usable in other projects. Run
`pnpm generate:built-in-skills` whenever shipped skills change and commit its generated module.

## Preflight and External Rules

Record the managed worktree/branch/base, campaign assignment, effective harness/model/effort,
Custom or Full Control mode, human-established boundary and revisions, exact decision owners,
compatibility, Human Required exceptions, evidence hosting/retention and reviewer provider/model.
Recheck claims, dependencies and overlapping PRs before implementing in the isolated worktree.
Never overwrite a dirty primary checkout or update a checkout hosting the live stack.

Protocol-v220 clients can pass `campaignWorkItemId` at child creation. Verify the actual tool
schema as well as the runner version. If the active host lacks this input, a Custom campaign may
create a read-only bootstrap child, verify its effective configuration, bind the original work
item through the supported assignment operation, and select its dedicated fresh-main worktree
before releasing implementation. A bootstrap prompt is not a recorded work-item assignment.
Do not claim atomic creation, omit required protected admission, or update the hosting stack to
make an unavailable interface appear. Report an unsupported mandatory path during preflight.

Installed or user-authored workflows are independent instructions. Name any unresolved mandatory
human rule with its exact file, quoted requirement and affected action before proceeding to that
gate. For example, an installed issue-workflow may require per-PR user merge/deletion approval,
external private-bucket uploads or human evidence review; an installed issue-reporting skill may
require user payload review. Those instructions are not changed by this repository's Full Control
policy. Do not edit installed skills or live provider configuration to remove the conflict.
Explicitly authorized repository policy alignment must itself pass normal review and merge gates.
Committed wording never overrides the current session's higher-priority instructions.

## Decisions and Delivery

Custom preserves existing user approval rules. Full Control delegates an eligible exact decision
only when the server-established human boundary, current occurrence owner and repository rules
permit it. Use request/get/consume with unchanged resources immediately before acting. Human
Required, authentication, secrets, persistent permissions, provider access expansion, governance
changes, guardrail changes and budget increases remain human-only. A separate budget boundary may
permit bounded worker reservations/allocations; never expand allowances or use unmetered workers.

For issue publication follow `.github/ISSUE_REPORTING.md` and the contributor reporting skill:
retain the drafting context, exact sanitized payload, fresh duplicate checks and verified readback.
Follow-up recommendations go to the parent for recording and deduplication before anyone acts.
Scope and closure use their dedicated exact typed routes. Current hosts without eligible issue
authority retain human review even when the campaign requests Full Control. Use non-closing PR
references in campaigns so merge cannot bypass the closure gate: write "Refs #N", and never put
close, fix or resolve (any tense, even negated as in "does not close" or hyphenated as in
"auto-close") directly before an issue reference that must stay open, in a PR description, title or
commit message. Code spans do not close an issue, but paraphrase rather than rely on them. Check a
draft with `wollipog pr closures --file <draft>` and an open PR with `wollipog pr closures <url>`. A
GitHub `pr_merge` decision is refused unless its `intendedClosures` lists exactly what the merge
would close (#3713). Delivery comments compare every
acceptance criterion and cite the actual merge commit; report remaining original work candidly.

Use `wollipog review session run` (MCP `request_review_session`) for your own pushed PR's required
cross-model review, including from an isolated campaign child. Follow the shipped `using-wollipog`
skill: provide the brief, let the completion continuation arrive when idle, read the full verdict
and report, adjudicate findings, and push fixes before delta rounds. A rewritten head starts a new
review epoch. Exhausted rounds require the exact `review_round_extension` decision; its default
owner is human and Full Control does not delegate it. With protocol 232 or later, campaign review
sessions reserve allowance before launch and record actual Session usage against it. Exhausted,
stopped or unavailable allowances refuse admission with a reason; original human cost ceilings
still apply across attempts. Use the older runner bridge
only for an unavailable version, never to bypass those limits or a missing reviewer. An explicit
human-approved native review exception must remain disclosed as such.

Run the required cross-model review using the installed workflow's exact reviewer model/effort,
read-only contract, attempt limits and private ledger. Independently adjudicate every finding.
Delegated review does not permit extra attempts after an exhausted limit or treating an invalid
attempt as valid. External unmetered reviewers are unsupported for production admission when
managed budget reservations are required; do not disguise an ordinary CLI review as accounted work.

The installed Codex cross-model-review runner launches its controlled Claude Opus 5.5 high reviewer
as a native subprocess. A manual launch outside supported campaign admission remains unaccounted
for protected admission purposes; report its actual raw costs and invalid attempts, never zero
cost. Main includes the #2936 controlled native adapter described in `docs/campaign-limits.md`.
Its availability requires the actual registered `campaignReview` profile, matching audited
controller/executable, human-established controlled-review budget authority and available limits;
a protocol number or merged feature code proves none of those. Preserve the installed runner's
strict Read-only/dontAsk contract, full pinned patch and tracked-path catalog, exact harness/model/
effort, coverage validation, no helper or MCP tools, and four-valid-round/two-attempt limits with
a 30-minute attempt timeout including infrastructure. Do not substitute a matching model on a
different harness, edit installed guardrails, change campaign settings or invent accounting.
#2939 must prove actual integrated delivery, cost and zero-prompt behavior before production
readiness is claimed. This policy alignment grants no live configuration or paid-launch authority.

Before merge, verify the reviewed head equals the pushed head and required CI passed on that SHA.
The required check is `Typecheck, Test & Sidecar Bundle`; an empty required list into `main` with
an active workflow is pending. Merge groups run full regression: the fast merge-group gate and
regression admission are disabled, and activating them needs the separate human approvals in
`docs/fast-gate-activation-proposal.md`. Agents never set `CI_MERGE_GROUP_GATE`,
`CI_REGRESSION_ADMISSION` or `CI_PR_SUITE_ROUTING`, or change the ruleset. Draft-skipped and absent runs need repair. Inspect dependencies and
direct stacked children. Request the exact typed merge decision and arm/execute the canonical
`gh pr merge URL --squash --match-head-commit SHA` command; never use `--delete-branch` on enqueue.
Wait for merge-group CI and actual `MERGED` state. Obtain a separate typed branch-deletion approval
after merge and after preserving/retargeting stacked dependents. Retire managed worktrees through
Wollipog; report provider-exit deferrals. Parent verification, rather than idleness, attests delivery.

## Evidence and Hosting

Follow explicit task/project hosting requirements and Artifact Uploads preferences. Full Control
does not authorize arbitrary uploads. A separate human-established evidence boundary narrows task,
private Session artifact destination, retention and exact reviewer provider/model; it never changes
UI Evidence Approval ownership. Initial human approval must cover hosting and provider disclosure.
Missing authority retains existing upload rules. Do not invent external storage, credentials or a
privileged fetch of a child-supplied URL to make review succeed.

Attach completed captures from disk and preserve returned artifactId/mediaType/sizeBytes/sha256.
Every item needs exact-byte reviewer delivery, receipts and a verdict; attachment alone is not
inspection. External or unsupported evidence routes to a human. Changed captures need new review.
Production video requires complete-manifest/all-frame model delivery, a temporal verdict and
managed worker/cost proof. Offline preparation and short-frame experiments do not establish this.
Missing proof remains a blocker, not a claim of production support.

The hosting-stack restriction remains absolute for a hosted agent, including detached helpers.
Deployment is a separately authorized handoff to an operator proven to be outside that stack.
Do not refresh primary main while its file watcher would deploy code. Report the deployed commit
when known; a merge does not prove deployment.
