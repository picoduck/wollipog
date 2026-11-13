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

The network proof runs before the session-wide cleanup lease, followed by a fresh metadata and
provider/launch fence check. The proof is pinned to the local tip and immutable fetched objects. Safe removal rechecks the
patches, cleanliness, branch and directory identity. Deferred retirement persists candidate
provenance across provider exit and restart. The retained-ref reclaimer repeats patch proof and its
existing generation and compare-and-delete checks before deleting a local branch.

Proof is deliberately bounded: five candidate PRs, 128 local commits, 512 candidate commits,
8 MiB per history batch, and a 90-second attempt deadline. Each history uses one commit walk,
one batched diff and one patch-ID process. The local set is reused across candidates with the same
observed default head. Empty or merge commits, undecodable patches,
unavailable forge evidence, and unsupported Git features retain the worktree. A fixed-material
runtime capability check requires whitespace-preserving patch IDs that distinguish file modes;
it never guesses support from a version string. Private repositories, missing GitHub CLI,
authentication-required CLI responses and unsupported Git keep the ordinary terminal refusal.
No credentials are requested to fetch private heads. Unknown outages become a durable deferred
cleanup intent with at most three unavailable proof attempts, including across runner restart.
Exhaustion emits a terminal refusal and retains the worktree; a later explicit retry is a new
intent. These limits never authorize deleting unproved work.

For diagnosis, ask:

- Why was this checkout accepted? Its private cleanup history has `patchDelivery`, including the
  exact local tip, candidate PR/head, and fetched default head.
- Was patch proof attempted or did it remain unavailable? The runner's structured
  `worktree_patch_delivery` event distinguishes `matched`, `not_matched`, `unavailable` and
  `ineligible`, with candidate count, duration, unavailable-attempt count and a fixed reason for
  ineligible cases. Initial and deferred unknown outages share the bounded journaled retry path;
  permanent failures and exhausted retries emit an ordinary refusal instead of waiting forever.
- Which lifecycle attempted it? That event carries `sessionId`, `worktreeId`, `cleanupId`, and the
  original `entryPoint` (`explicit_discard` or `archive_retirement`), retained on deferred replay.

The event contains no patch content, command output, pathname, or credentials. Ordinary safe-discard
refusals remain in force when proof cannot be established. Fixture tests inspect both the success receipt
and structured event; testing never requires modifying a real campaign worktree.
