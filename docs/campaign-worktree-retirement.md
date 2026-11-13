# Person-Confirmed Campaign Worktree Retirement

Campaign Status offers **Inspect Worktree** on a refused cleanup item. Only a signed-in human
operator with access to the campaign, the child and its runner can inspect or confirm retirement.
The child must be fully archived. Neither session tools, Assistant connections, CLI operations nor
delegated workflow decisions expose these HTTP-only actions. A typed question answer is not a
confirmation.

Inspection reads the real checkout. The confirmation dialog names its path, actual branch, full
tip and clean state. The runner also pins its directory identity, registered branch and managed
worktree ID. Confirmation repeats inspection, then the normal cleanup lease, provider fences,
process retirement and approved teardown. The safe removal helper repeats cleanliness, head,
branch and directory/repository identity checks after teardown awaits. It never force-removes a
dirty or changed checkout. A refusal closes the dialog and requires fresh inspection and a new
explicit confirmation. A prior human attempt can be re-inspected and confirmed at a new clean
state, reusing its durable cleanup identity and process/teardown progress. Its old confirmation
never automatically follows changed work. Automatic cleanup intents and active providers still
block this action. Unproven ownership offers no inspection/confirmation that could waive it.

This action retires a clean checkout, preserving **all local branch refs**. It does not turn human
confirmation into evidence that commits landed. Keeping those refs means even unique, unpushed
commits remain reachable after retirement. Ordinary agent discard retains its existing delivery
requirements. Branch deletion still requires its own existing proof and authorization.

Before dispatch, the control plane records a durable `CONFIRM` mutation audit with the authenticated
person, time and child/worktree coordinate. The runner's durable cleanup record and completion
history retain that same person/time and the complete inspected state. Lost replies do not erase
that audit; refresh cleanup before retrying. An interrupted cleanup can replay only its pinned
directory generation and branch/tip. It cannot follow a replacement checkout. The confirmation time
is audit attribution from the control plane; freshness comes from exact-state comparison, without
assuming that the control plane and runner share a clock or that the operation's queue is short.

Protocol 372 gates inspection and confirmation. Older/offline runners return an explicit refusal;
they receive no confirmation. Deploy compatible peers through the normal authorized operator
workflow, separately from implementing this feature.

This slice implements #4535's person-only retirement and matching guidance. Missing selected or
still-registered checkout reconciliation and temporary remote branch deletion remain separate
criteria of that issue. No shell command is a substitute for confirmation.
