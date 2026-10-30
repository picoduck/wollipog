# ADR 0013: Review Sessions Replace Native Review Jobs

Status: Accepted

## Context

Review sessions provide exact-head snapshots, validated review runs, campaign admission and actual
Session accounting. The older runner-mediated bridge and controlled campaign review job duplicated
execution, recovery and trust paths. The campaign adapter also depended on an obsolete installed
controller. Keeping either as a fallback could hide missing admission or budget support.

## Decision

Retire both native executors and their MCP/CLI entry points. Recognize old names only to refuse
with actionable review-session guidance. Legacy HTTP admission returns 410 after its existing
identity checks. Archive reads and authenticated receipts remain for historical accounting;
reconnect may cancel old work but never dispatch it again.

Protocol 243 allows an optional immutable review-session citation on a merge decision. The server
verifies requester/run ownership, PR, exact head, valid UPVOTE and absence of a newer valid vote.
Failed or invalid attempts do not supersede an upvote. Current evidence is projected in decision
views and rechecked at authorization. A review grants no human approval, merge authority or CI.
Record-only reconciliation and lifecycle settlement preserve a completed authorized action after
a later vote, while still requiring the exact armed command, current authority and forge proof.

Protocol 251 gates retirement. Drain legacy jobs under the prior runner, preserving their final
receipts and charges; upgrade the control plane before the runner. A new runner explicitly refuses
an older or unverified control plane before registration resumes work: old servers can replay
legacy dispatch and sanitize new refusal reasons into a generic failure. New runner startup also
refuses unfinished, malformed or still-live/uninspectable legacy execution without editing records
or starting recovery executors. An external operator must drain recorded processes and controller
groups under the prior version. Terminal unpriced receipts cannot become priced through retry;
once execution has drained, they permit upgrade and replay unchanged while unknown cost and its
reservation remain. Cancellation-only older runners may not re-send a lost terminal update; the
upgraded runner delivers that historical receipt without re-dispatching a job.

Settled receipts replay verbatim. Missing receipts cannot prove that a previous runner never
launched, so unknown campaign usage retains reservations and stops protected admission. No costs,
human boundaries or obsolete controlled-review grants are silently converted. Replacing an old
grant remains the campaign owner's action. Review sessions retain their own exact reviewer,
read-only snapshot, admission, usage and round/attempt contracts.

## Consequences

There is one supported review execution model. Mixed deployments fail explicitly and require the
documented upgrade order. Historical ledgers and daily costs remain auditable without reviving a
controller or fabricating zero usage. The legacy bridge worktree refusal and extra unsandboxed
admission-context work for those removed executors become moot. Composer `/review cross-model`
remains a separate UI/target-selection integration; retirement does not implement that command.
