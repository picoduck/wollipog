# Externally Removed Campaign Worktrees

A safety refusal is never permission to retry a deletion after the checkout becomes clean.
For a fully archived, verified child in a Stop and Archive campaign, the existing campaign
maintenance tick, an agent's `get_campaign` read, or runner reconnect can instead reconcile
external removal. Protocol 374 adds the
internal `reconcile_removal` worktree operation, pinned to the recorded path and worktree ID.
There is no agent tool, CLI operation, or person confirmation for this inventory operation.

The control plane retains the refusal on older runners. Maintenance and campaign reads are
throttled to one check per child per 30 seconds; reconnect can recheck immediately. An unchanged
runner reply does not refresh the child's activity timestamp or broadcast a new snapshot. A runner
reply updates the ordinary session snapshot, so the existing cleanup projection stops counting
the retired inventory generation and can reach `verified_complete`.

Maintenance scans at most 64 archived children with current refused generations per 30-second
keyset batch, including children whose campaign root is stopped or archived. Each candidate
still passes the ordinary live ancestry, verification, policy and runner checks. Settled
inventory generations leave the sweep query. This work does not start or resume the root.

## Evidence and Preservation

On native execution contexts, Git must be readable and the parent directory accessible. The
runner checks the directory and Git registration twice, around retirement of the recorded
worktree's processes. Reconciliation accepts either an absent directory, including one still
registered with Git, or a surviving directory that Git no longer registers. A registered,
present checkout stays refused, even when it has become clean. Symlinks, unavailable Git,
remote execution contexts, live providers, another runner's lease, shared inventory, replacement
generations, and pending cleanup journals all retain the current inventory and refusal.

This operation removes no checkout files, local or remote branches, private refs, reflogs, HEAD,
index, or Git administrative registration. In particular it never runs `git worktree prune`:
a missing directory can still have unique detached-HEAD commits or private refs in its
registration. An unregistered directory's surviving files remain where the person left them.
Repository teardown hooks cannot run in an unverified checkout; cleanup history records them
as unrun failures, rather than executing them in the primary checkout. Port allocations and
runner-owned process markers follow the existing cleanup finalization path.

## Resume Recovery

For an unselected inventory row, reconciliation leaves the session's selected location alone.
For a selected row, retiring inventory and clearing selection atomically records the existing
durable worktree-recovery hold with the previous path and branch. Restart, provider launch,
Files, shells, and Native TUI root resolution must refuse a recovery hold with no selection.
They never fall back to the primary checkout or silently recreate a checkout. Selecting or
creating a verified replacement worktree clears the hold through the ordinary selection flow.
This hold concerns a future resume; it does not make an archived, verified child's absent
worktree count as pending campaign cleanup.
Ordinary successful discard or retirement clears any recovery incident for the selection it
intentionally removes; it does not inherit this external-removal fence.

Runner diagnostics emit `campaign_worktree_external_removal_reconciled` with the request ID,
bounded session ID, removal state and preservation/recovery flags. Control-plane transport
failures emit `campaign_worktree_external_reconciliation_unavailable` and retain the refusal.
Neither event includes paths, branch names, patches or private file contents.

## Verification

`worktree-missing-reconciliation.test.ts` covers removal with Git, a missing but registered
directory with a detached HEAD and private ref, surviving unregistered files, stale and replaced
inventory generations, pending cleanup, another runner's lease, unsupported contexts, symlinks,
restart with either worktree setting, and explicit replacement selection. The control-plane
sessions fixture verifies version gating, refusal preservation, throttling, reconnect, and
convergence to `verified_complete` without a deletion retry.

This is the removed-worktree criterion of #4535. Temporary remote branch deletion is a separate
remaining criterion; this operation grants no forge authority and deletes no branch.
