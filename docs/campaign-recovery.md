# Campaign Recovery

Full Control campaigns expose `get_campaign.recovery` and the same metadata in Campaign Status
and existing request details. The recovery contract reports exact resource coordinates, action,
effective owner, policy revision, reason, attempted recovery and smallest required input. Provider
occurrences and steering identities are SHA-256 coordinates; request details still name the original
request. No raw command, error body, bearer URL, media or credential enters recovery metadata.

The control plane translates authoritative request ownership, session holds, worker lifecycle,
durable continuation receipts, uncertain steering receipts and fresh GitHub facts into recovery
instructions. Failed checks route to repair; reviewer objections route to adjudication, repair and
bounded re-review. An unknown external outcome routes to inspection of the original receipt before
any retry. A consumed issue closure with an uncertain result remains a human-owned reconciliation
exception. Consumed one-shot permissions are never restored by recovery.

Recovery records reserve at most four instructions per original resource. Transient failures use
exponential backoff starting at one second, capped at thirty seconds. Repeated unchanged
observations neither spend another attempt nor create another request or wake. Replacement-worker
records retain the original ledger item's ceiling. Check repair and re-review retain a repository/PR
ceiling across changed heads; the head remains an exact observation coordinate, not a counter reset.
Hard denial and exhaustion stay blocked and ask
for no override. Existing continuation transport owns its own bounded retries and ambiguous-result
fence; recovery never acknowledges an unknown parent turn to create another turn.
Denied operations stop being live exceptions when their subject's exact terminal report is
authoritatively verified; their original decision remains denied. Status, archive and an ended
attempt alone do not establish completed delivery. Durable retirement binds the exact denied
occurrence to that verified report, so reusing a session cannot resurrect its old denial or clear
a newer denial. This terminal accounting proof grants no code/media review quality or approval.
An uncertain external mutation still requires receipt reconciliation even after report completion.

Instruction reservation and durable continuation-event insertion share one SQLite transaction.
Restarting the control plane recovers the reservation and event, including any pending backoff.
The existing continuation lane preserves single-flight execution and runner receipt identities.
Stop, archive, authority revocation and explicit root restart cancel the old recovery records.
A cancellation fences the old dispatch reservation without hiding a still-live human exception.
Human gates are re-derived under the current policy; exhausted history remains blocked if work
reappears. Automatic work with the same cancelled occurrence stays visibly blocked and cannot
re-dispatch, while a fresh authoritative occurrence keeps the logical resource's spent ceiling.
A paused or input-required root is never restarted automatically. A human gate on one child allows
an otherwise idle parent with a current Full Control boundary to continue unrelated authorized work;
the child's gate stays unchanged. Custom campaigns retain their existing whole-campaign human hold.

Recovery metadata grants no authority. Every effect still passes the existing exact typed decision,
provider permissions, policy rules, scope, budget, fixed-worker configuration and evidence contracts.
The recovery layer cannot enlarge scope, reset budgets, acquire credentials, change preferences or
override Human Required rules. Missing human information/access, boundary enlargement, protected
rules and unsupported capabilities each expose an actionable exception. Stale forge data is retained
as unresolved until the background reader obtains a fresh fact; it cannot prove repair, passing
checks or merge. Routine stale/transient reads do not wake the parent or spend recovery attempts.
Actual access/capability failures still expose human exceptions.

`unattendedReady` describes unresolved recovery exceptions only. It is never a launch, scope,
budget, review, evidence or merge-readiness grant. Integrations must compose the current authority,
budget/evidence capability checks, exact-head CI and actual merged forge state. A stacked preparation
branch does not establish that the complete campaign can run unattended.

Operational questions: which exact action is blocked, why is it human-owned, and did this occurrence
already receive a recovery instruction? Query `get_campaign.recovery` for the first two and correlate
`campaign_recovery_dispatched` by `campaignId` and `recoveryId` for the last. Structured dispatch
events include the sweep entry point, policy revision, action, reason and attempt; they contain no
request text or raw errors. Repeated observations are quiet. Use the existing request to provide the
specified input; after resolution, the durable continuation lane resumes eligible work once.
