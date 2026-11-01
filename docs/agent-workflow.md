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
item through the supported assignment operation, and select its dedicated worktree based on the
fetched remote default branch before releasing implementation. A bootstrap prompt is not a
recorded work-item assignment.
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

## Worktree Bases and Checkout Maintenance

Create new issue worktrees with `wollipog worktree create --branch <branch>` and omit `--base`.
Wollipog fetches the remote default branch and uses it as the base, independently of the primary
checkout's HEAD. Use an explicit base for intentional stacks or another task-specific starting
point; that path uses the supplied ref without the default-branch fetch, so verify its freshness
when the task requires it. Resuming an existing worktree preserves its work rather than rebasing
it automatically.

Do not pull or fast-forward the primary checkout as post-merge cleanup. Delivery requires the
verified merge, tracker updates, and appropriate session-owned cleanup, not a current local
`main`. Do not report a stale primary checkout or the sandbox's refusal to update it as an
unfinished delivery step.

Primary-checkout maintenance is a separate, explicitly requested operation. Preserve local work
and check whether a running process uses the checkout before updating it; never update a checkout
hosting the live stack. Runtime updates remain a separately authorized deployment operation.

For reviews, maintenance sweeps, or tools that read the primary checkout directly, establish the
required baseline explicitly. Fetch the remote default branch and inspect its files, or run code
in a separate worktree pinned to the required commit. Record that commit and do not assume the
primary checkout is current or change it merely to obtain fresh input.

## Decisions and Delivery

Before the first dispatch, the root may declare completion relationships in `record_campaign_plan`
using `fixedBy: [{ issue: { repository, number }, workItemKeys: ["unit:a", "unit:b"] }]`.
The target issue must already be in the human-established scope; every key must name an item in
this campaign (including items in the same plan call). Record all required units together. These
relationships are immutable and cannot be added after dispatch, including after an attempt ends.
They supplement the target issue's own work items, including items recorded later; every own item
still needs its existing completion proof. They grant no scope or delivery authority: every cited unit must remain in scope and independently
pass delivery, report verification and exact merged-PR checks before the completed closure can be
Orchestrator-owned. Missing proof retains human ownership with a server-derived delivery gap.
Existing closure requests never gain authority retroactively. Issues without relationships retain
their own-work-item behavior. Epic prose and other agent-written text cannot create a relationship;
this implementation supports the recorded-plan source. Clients need protocol 268 to send `fixedBy`;
older servers keep such closures human-owned. Do not update the hosting stack to gain support.

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
still apply across attempts. The older bridge and controlled campaign review jobs are retired.
Upgrade unsupported peers; never use a native subprocess to bypass an admission or budget refusal.

Run the required cross-model review using the installed workflow's exact reviewer model/effort,
read-only contract, attempt limits and private ledger. Independently adjudicate every finding.
Delegated review does not permit extra attempts after an exhausted limit or treating an invalid
attempt as valid. External unmetered reviewers are unsupported for production admission when
managed budget reservations are required; do not disguise an ordinary CLI review as accounted work.

Hosted review sessions preserve the required harness/model/effort, read-only snapshot, coverage
contract and attempt limits. Native reviewer subprocesses outside managed Session accounting remain
unaccounted for protected admission; disclose their actual raw cost and invalid attempts. Retirement
adds no native fallback or paid-launch authority. Drain historical jobs with their prior runner and
follow the control-plane-first transition in `docs/agent-control.md`; never update the hosting stack
from this session. Old grants and unknown charges require their existing human/accounting recovery.

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
