# Worktree Patch Delivery Proof

A clean runner-created worktree without an upstream may hold commits that were reapplied under
new IDs in another pull request and then squash-merged. Ancestry cannot prove those commits landed,
and the combined squash commit does not preserve their individual patches.

Protocol 370 adds bounded candidate identities to discard and archive-retirement frames. The
control plane derives them from consumed merge decisions of the exact child in its current
campaign. Siblings, root sessions, pending decisions, and agent-written delivery claims supply no
candidates. Older peers keep the existing proofs and refusals.

The runner checks GitHub's current default branch and verifies that a candidate is merged into it
at the exact admitted head. It anonymously fetches that head and the observed default head using
the existing restricted retirement transport. Every local commit outside the fetched default
history must have a whitespace-preserving Git patch ID in the fetched PR head history. The squash
commit alone is insufficient. Replacement refs and grafts are disabled; diff helpers and textconv
cannot run, and submodule changes cannot be hidden by repository configuration.

The proof is pinned to the local tip and immutable fetched objects. Safe removal rechecks the
patches, cleanliness, branch and directory identity. Deferred retirement persists candidate
provenance across provider exit and restart. The retained-ref reclaimer repeats patch proof and its
existing generation and compare-and-delete checks before deleting a local branch.

Proof is deliberately bounded: five candidate PRs, 128 local commits, 512 candidate commits,
8 MiB per patch, and a 90-second attempt deadline. Empty or merge commits, undecodable patches,
unavailable forge evidence, and unsupported Git features retain the worktree. No credentials are
requested to fetch private heads. These limits never authorize deleting unproved work.

For diagnosis, ask:

- Why was this checkout accepted? Its private cleanup history has `patchDelivery`, including the
  exact local tip, candidate PR/head, and fetched default head.
- Was patch proof attempted or did it remain unavailable? The runner's structured
  `worktree_patch_delivery` event records `matched` or `unproven`, candidate count and duration.
- Which lifecycle attempted it? That event carries `sessionId`, `worktreeId`, `cleanupId`, and the
  original `entryPoint` (`explicit_discard` or `archive_retirement`), retained on deferred replay.

The event contains no patch content, command output, pathname, or credentials. Ordinary safe-discard
refusals remain in force when proof is unavailable. Fixture tests inspect both the success receipt
and structured event; testing never requires modifying a real campaign worktree.
