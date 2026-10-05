# Campaign Issue Scope

Campaign issue authority is independent of the campaign work ledger. Initial explicit issue lists retain
their existing finite authorization. Epic wording and requests for an issue's children seed membership
proposals, never automatic authorization. An epic campaign cannot create delegated sessions until a
human confirms its issue scope.

Campaign Status exposes Authorized Issue Scope, revision, and recorded work outside authority. A campaign
owner can inspect an epic's umbrella and members, select candidates, and request exact additions/removals.
Native GitHub sub-issues and leading checklist issues in explicitly named member sections are candidates.
Dependencies, cross-repository members, and incidental references never grant authority. An incomplete or
oversized inspection fails closed; use an explicit set of up to 100 repository-qualified issues instead.

The root agent can use `get_campaign_issue_scope` and `request_campaign_issue_scope_change` to prepare the
same proposal after a human's prompt. Its approval is always human-owned. The exact payload includes the
expected revision, before list, additions, removals, affected assignments, and decisions that will be revoked.
Approval, persistence of the approving human/revision, and one-time consumption share one database
transaction. Pending/denied/stale/replayed requests cannot mutate scope. Changes to scope or affected work
require a fresh proposal. Removing an issue preserves history and assignments but removes issue authority.
Outstanding action decisions are revoked conservatively on any approved scope change.

Protocol v208 capability-gates the complete operation before any update. Active Orchestrator participants
must share the campaign runner and repository workspace; finish or move incompatible participants first.
The control plane persists the authoritative policy on all Orchestrator members. The runner stores the
scope revision and updates live Claude permission classification, then restores it on reconnect/restart.
Closure inspection and execution are fenced against both repository and scope revision. Synchronization
failure is recoverable by reconnecting/updating the runner; closure remains refused until synchronization.
GitHub credentials, governance, and separate human-owned issue closure approval remain authoritative.

Operational questions: which human approved the change, which revision is authoritative, and did every
active participant synchronize? Workflow audit plus `campaign_issue_scope_approved`,
`campaign_issue_scope_synchronized`, and `campaign_issue_scope_sync_pending` answer these with session,
occurrence, and revision identifiers, without logging prompts, credentials, or issue bodies.
