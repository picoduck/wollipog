# Forge review reconciliation

The Review panel can import the current branch's GitHub pull-request or GitLab merge-request
discussions with **Sync GitHub** or **Sync GitLab**. Both operations are read-only
toward the forge: Wollipog never posts, edits, resolves, or dismisses a remote comment.

GitLab.com repositories are detected from exact SSH or HTTP(S) remote hosts. A self-managed GitLab
host becomes active only when global `glab` configuration contains that exact host; Wollipog checks
that non-secret host-scoped configuration before running `glab auth status --hostname <host>`, so it does not
probe a generic Git server over the network. Install and authenticate `glab` in the same Machine
context as the session (`glab auth login --hostname <host>`). Native and WSL sessions deliberately
do not share CLI or authentication assumptions.

## Reconciliation contract

- The runner executes `gh` or `glab` in the session's native or WSL context, so repository and authentication
  state match the worktree where the agent is running.
- A bounded read loads at most 500 GitHub review threads or 500 GitLab discussions. Authentication
  failures, malformed data, pagination overflow, or a change-request revision that moves during the
  read abort the entire operation. Partial data is never applied.
- One durable finding represents each top-level review thread. Replies remain remote context and do
  not create duplicate findings. GitLab discussions without a trustworthy diff position remain
  remote-only; they are never fabricated into a current file or line comment.
- Open remote threads are `required` findings and block review completion. Resolved threads become
  resolved locally; reopened threads become open again. A thread missing from a later complete sync
  is dismissed locally.
- Forge-authored findings show the author, provider, change request, remote link, and outdated state.
  Their body and status are remote-owned; resolve or reopen them on the forge and sync again. They may still
  be bundled into a prompt to the owning agent.

## Anchor safety

An active, non-outdated thread is anchored to the current `all_branch` diff only when the local HEAD
exactly matches the change-request head read from the forge. Otherwise it receives a stable remote snapshot hash and
is shown as stale instead of being attached to a potentially unrelated local line.

The uncommitted staged and unstaged panes also carry separate hashes. A comment created in one pane
therefore cannot appear current at the same numeric line in the other pane.

## Merge-request creation and compatibility

After pushing a GitLab branch, an authenticated runner creates the merge request through the exact
remote host's API. If authentication or creation is unavailable, Wollipog returns a validated,
prefilled GitLab creation page and clearly reports that only the branch was pushed. Tokens are never
placed in generated URLs or error messages.

Forge-neutral summaries, GitLab creation, and GitLab reconciliation require runner protocol v106.
The control plane continues accepting the legacy GitHub action and result fields, so older runners
keep existing GitHub and local review behavior. A newer web client hides GitLab reconciliation when
the connected runner lacks the v106 forge capability and explains that the runner must be updated.
