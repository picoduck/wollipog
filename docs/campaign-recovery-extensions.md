# Owner Recovery Extensions

An exhausted campaign stays blocked until its owner explicitly admits additional recovery
instructions. This control-plane HTTP API is human-only; Orchestrator tools and automatic recovery
cannot initiate or approve an extension. It adds no runner operation and uses the existing
capability-gated, budget-gated durable continuation lane.

The authenticated campaign owner can use these endpoints under
`/api/sessions/<campaign-id>/campaign/recovery-extensions`:

- `GET` lists active recovery records and durable authorization receipts.
- `POST /preview` accepts `{ recoveryId, extraInstructions }`, with an integer allowance of 1–4.
  Inspect the returned campaign, exact record (repository/PR, action, observed head, attempts,
  existing blocks), original requester, restoration guidance and snapshot before deciding.
- `POST /apply` accepts `{ requestId, snapshot }`, using the exact preview snapshot and a unique
  bounded request ID. This is the owner's explicit authorization. Reusing the same ID and payload
  reconciles the original receipt even after dispatch, revocation or a lost response. A different
  payload under that ID is refused. A second request cannot add another unspent allowance.
- `POST /<requestId>/revoke` revokes remaining admission. It never undelivers an instruction or
  rewrites its spent attempt. Reconciliation still returns the revoked historical receipt.

Eligible records are exhausted PR check repairs or rereviews with fresh open forge facts, current
campaign scope and authority, one proven original review requester and its preserved linked unmerged
worktree. Unknown or ambiguous original ownership fails closed. Human restoration of that requester
through Unarchive and Restart is separate and must precede admission. The API never replaces the
requester, detaches the worktree, starts a worker or changes review epochs, findings or round usage.
Worktree cleanliness and execution permissions retain their existing runner checks.

Dispatch revalidates the exact head, owner, policy, scope, requester, worktree and lifecycle.
Changes revoke incompatible admission; attempts remain cumulative across heads. Hard denials,
credential restrictions, human rules, stops, budgets and unrelated dispatch fences remain enforced.
In particular, a legacy `dispatchFenced` record with no proof that exhaustion is its only block is
ineligible: this API is not an override for an earlier cancellation or authority fence.

The immutable receipt stores the authorizing owner, exact snapshot, added allowance and admission
time. Revocation time is retained separately. Existing attempts and action history remain intact;
each newly reserved instruction increments the same record in the same transaction as its durable
wake. Exhausting the new cumulative ceiling blocks it again. No automatic extension request is made.

Admission authorizes only instructions. CI reruns, review-round extensions, code review, exact-head
CI, merge approval, merge queue landing, publication and spending retain their separate gates.
Existing clients continue showing exhausted recovery as blocked. Servers without these endpoints
return an unsupported route; upgrade the control plane through an authorized outside operator or
leave the resource blocked. No counter reset or internal-state edit is a supported substitute.

Verification uses isolated synthetic SQLite/session/forge fixtures. It does not demonstrate that a
historical campaign has been restored, nor authorize touching live exhausted records.

## Request One Recovery Instruction in Wollipog

In a Wollipog Assistant thread, ask to recover an exhausted campaign PR and give the
campaign, GitHub PR and current head. The Assistant uses `campaign_recovery_request`
to place an exact approval in the campaign owner's Inbox. Include `after` when a
separate same-repository PR must merge first. Wollipog also checks the campaign's
recorded merge prerequisites. The card identifies the original review requester,
preserved worktree, spent attempts and the single additional instruction.

On approval, Wollipog reads the forge again, selects the linked worktree, and
restores the original requester if specified by the approval. It stages the
instruction through the durable prompt outbox and commits the attempt and
consumption together. An unavailable read holds delivery for a retry. A changed
target or binding requires a new request. A decline holds recovery for that head.
Handoffs, older decision revocations and the parent continuation's fence are retained.
This operates on one PR in the original session and leaves approval for CI reruns,
review rounds, merges and other effects to their existing workflows.

The typed path accepts an exhausted, current-policy GitHub PR repair. A fenced
or historical record also needs a recorded owner handoff. The forge must confirm
the open PR, exact branch tip and check failure or review objection. There must be
one proven original review requester with a matching preserved worktree.

The owner can grant **Authorize Campaign Recovery** in an individual Assistant
thread's **Decision Delegation** settings by choosing the category and selecting the
campaign. **Delegate All** and default grants exclude this category. Use a separate
thread from the one that requested recovery. Instruct it to resolve the exact
occurrence using its current digest. Resolution is recorded with the thread and
grant revision.
