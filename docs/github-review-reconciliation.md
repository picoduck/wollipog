# GitHub review reconciliation

The Review panel can import the current branch pull request's inline GitHub review threads with
**Sync GitHub**. The sync is read-only toward GitHub: it never posts, edits, resolves, or dismisses
a remote comment.

## Reconciliation contract

- The runner executes `gh` in the session's native or WSL context, so repository and authentication
  state match the worktree where the agent is running.
- A bounded GraphQL read loads at most 500 review threads. Authentication failures, malformed data,
  pagination overflow, or a PR head that moves during the read abort the entire operation. Partial
  data is never applied.
- One durable finding represents each top-level review thread. Replies remain GitHub context and do
  not create duplicate findings. File-level review threads are labeled explicitly and always use a
  stale anchor; they are never fabricated into a current line comment.
- Open GitHub threads are `required` findings and block review completion. Resolved threads become
  resolved locally; reopened threads become open again. A thread missing from a later complete sync
  is dismissed locally.
- GitHub-authored findings show the author, pull request, remote link, and outdated state. Their
  body and status are remote-owned; resolve or reopen them on GitHub and sync again. They may still
  be bundled into a prompt to the owning agent.

## Anchor safety

An active, non-outdated thread is anchored to the current `all_branch` diff only when the local HEAD
exactly matches the PR head read from GitHub. Otherwise it receives a stable remote snapshot hash and
is shown as stale instead of being attached to a potentially unrelated local line.

The uncommitted staged and unstaged panes also carry separate hashes. A comment created in one pane
therefore cannot appear current at the same numeric line in the other pane.

## Compatibility

GitHub reconciliation requires runner protocol v51. Older runners keep local review features, and
the Sync GitHub control explains that the runner must be updated.
