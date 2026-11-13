# Temporary Campaign Branches

Protocol 377 adds `create_temporary_branch`, also available as
`wollipog branch create-temporary --request-id <id> --branch <name> --head <sha> --json`.
Only the authenticated campaign member can publish for itself. The control plane resolves its
repository from the current campaign Location; a caller cannot supply a repository or a receipt.
The current implementation requires a live Full Control campaign and GitHub.

The runner uses its session's forge login from a neutral directory. It never executes worktree
Git configuration, hooks, credential helpers, or a caller's command. It checks that the full tip
is already contained in the remote default branch, that no open pull request uses the name as
head or base, and that the name is not the default branch. The remote mutation uses GitHub
`updateRefs` with a zero `beforeOid`: an existing ref is refused even at the requested tip.
The default ref and PR evidence are read again after the immutable-commit compare.

Before dispatch, the server records an immutable intent bound to the campaign, member,
repository, branch and exact tip. Only a matching successful runner response promotes it to a
creation receipt. Reusing a request ID with the same coordinates returns an already proven
receipt without another write. An interrupted, refused, malformed or lost response cannot be
replayed or turned into provenance by reading a matching ref. Creation attempts are bounded to
64 per member. Historical provenance cannot be established: raw-shell, pre-existing and unknown
branches keep person-owned decisions.

While the original server call is still live, a retry reports that creation is in progress and
asks for the same request ID again; it never publishes another ref or prematurely calls the
intent unproven. The agent client's timeout exceeds the server's runner RPC budget. After a
server restart an orphaned pending intent remains unproven and cannot be replayed.

The receipt also retains the verified default branch name and immutable default-head SHA from
creation. At decision admission the server replaces any caller-supplied `creation` facts with
these receipt facts and the creating session's label, or removes them when provenance is unknown.
The card distinguishes the proven created tip from a requested tip, identifies the creating
member, and dates the containment claim to creation; execution still checks containment afresh.
The creation facts normalize to the same digest as the admitted snapshot. Temporary deletion
cannot be consumed as a shell-command handoff; managed execution is mandatory.
An idempotent replay retains the first admitted session label, even if the session is renamed.
Campaign recovery uses the same server-recorded receipts as admission when displaying authority.

Temporary deletion uses the existing typed `merged_branch_deletion` category with `merged:false`,
`headSha`, optional `temporaryReceiptId`, and `dependentPullRequests` evidence. It does not
invent a merged PR or merge commit. Only a matching server receipt from this exact campaign
member permits delegation. Missing, borrowed and mismatched receipts keep the decision human-owned
under both Custom and Full Control. An older peer cannot delegate or execute this variant.

Approval remains a separate, exact typed gate. `execute_workflow_decision` revalidates the receipt,
reads GitHub again, proves the current tip equals the created tip and remains default-contained,
and refuses any open head or base PR. GitHub applies compare-and-delete at that exact tip using
`beforeOid`; a moved tip cannot be deleted. An uncertain deletion may be retried under the same
occurrence, but only after the complete proof is repeated. A proven deletion retires its receipt,
so a known deletion followed by recreation cannot borrow the old provenance. The proven deletion
result and receipt retirement are recorded in one database transaction, even if approval
consumption is interrupted. No receipt authorizes arbitrary refs.

A forge ref has a name and tip, without an immutable generation ID. An external delete and
recreation at the identical tip entirely between observations cannot be distinguished by these
reads. The receipt attests the recorded creation and exact authorized tuple; it is not a claim
that the forge proved uninterrupted ownership. No historical or raw-shell creation can mint a
receipt, and a deletion observed through this route permanently retires its receipt.

GitHub's [Git GraphQL reference](https://docs.github.com/en/graphql/reference/git) specifies the
create/update/delete and compare-and-swap behavior of `updateRefs`.
The [commit comparison API](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
supplies ancestry evidence between immutable object IDs. PR absence and default containment are
fresh observations; GitHub atomically pins the temporary ref's tip, not those separate observations.

Diagnostics record fixed outcomes and server identifiers, without forge output or repository
contents. Tests use fixture forge responses and never create validation branches on a real remote.
