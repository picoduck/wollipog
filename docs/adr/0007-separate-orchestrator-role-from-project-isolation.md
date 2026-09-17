# ADR 0007: Separate the Orchestrator Role From Project Isolation

- Status: Accepted
- Date: 2026-09-14
- Amends: [ADR 0006](0006-orchestration-as-a-session-capability.md)

## Context

ADR 0006 made Orchestrator a session capability, but its first implementation coupled two choices:
the parent should normally delegate implementation, and the parent must be unable to write project
files. That coupling excluded approval-capable provider configurations such as native Claude Code
without Bubblewrap and prevented explicitly requested parent implementation.

## Decision

Keep `permissionMode: "orchestrator"` as the coordination role. Add an independent, immutable
campaign execution snapshot, `strictProjectIsolation`, controlled by human defaults and optional
creation overrides. New sessions default to `false`; persisted sessions whose snapshots lack the
field normalize to `true` with legacy provenance.

Delegate Implementation remains the behavioral default. An ordinary multi-issue request does not
authorize child creation. The parent may maintain permitted planning artifacts. Explicit parent
implementation requires a child/PR ownership-overlap check, a dedicated parent worktree, and the
normal testing, cross-model review, UI-evidence, merge, and cleanup workflow.

With strict isolation disabled, supported native structured harnesses launch in their selected
repository or worktree under ordinary provider permissions and existing governance. Native Claude
Code must advertise interactive Default approval support, and eligible operations reach that
approval path instead of being forced to `dontAsk`. This mode makes no OS-level read-only claim.

With strict isolation enabled, the existing scratch-only project boundary and restricted launch
configuration remain in force. Claude requires `bwrap` on Linux or Seatbelt on macOS. Structured
Claude sessions use the runner-owned permission channel described below; Native TUI and ACP launches
without that channel retain `dontAsk`. Direct WSL requires its attested bwrap launcher; audited Codex
provider isolation remains supported. Unsupported combinations fail before launch. The control
plane, not the agent-visible MCP adapter, checks the immutable snapshot before permitting a
self-worktree operation.

Parent Control, typed workflow decisions, authentication exclusions, child admission, resource
limits, and audit provenance are unchanged. ACP remains strict-only until an adapter-specific
provider-mode permission contract is audited.

### Routine Claude Operation Contract

Structured provider-mode and strictly isolated Claude sessions route every Bash request through one
runner-owned semantic classifier. Static `Bash(...)` prefixes are removed from these launches; they
remain only as a read-only compatibility surface for Native TUI and audited ACP launches that do not
have the runner control channel.

The classifier automatically authorizes:

- read-only Git state, history, diff, reference, worktree-list, and search operations after rejecting
  output-file, external-diff, text-conversion, pager-launch, branch mutation, and tag mutation flags;
- read-only GitHub issue, pull-request, check, run, repository, and search inspection, excluding web
  launches and cross-repository overrides;
- self-assignment/unassignment, label additions/removals, and `--body` plan or status comments only
  for issue numbers in the immutable campaign issue scope; and
- bounded numeric loops, `;`, `&&`, `||`, harmless `echo`, and stdout redirection to `/dev/null` only
  when every leaf independently satisfies the contract.

The campaign issue scope is extracted only from an authenticated human's explicit initial request of
the form “claim/orchestrate/coordinate/manage issue(s) …”, is capped at 100 unique positive safe
integers, persists in the campaign policy and runner launch metadata, and is inherited without
broadening by nested Orchestrators. Ambiguous prose and agent-authored prompts produce no scope.
Protocol peers older than v158 cannot enforce this field, so scoped issue coordination fails at
admission with an upgrade requirement instead of silently degrading to approval cards or denial.

Provider-mode operations outside the contract use the ordinary visible approval path. Strictly
isolated sessions deny them without creating a futile human approval because the filesystem boundary
cannot be overridden. `AskUserQuestion` remains visible, and Wollipog management tools retain their
explicit allowlist plus server-side typed gates. Authentication, secrets, persistent grants,
governance, budgets, implementation writes, pull-request merge, merged-branch deletion, follow-up
issue publication, UI evidence, and unknown operations are never admitted by this classifier.

## Consequences

Orchestrator availability no longer implies a read-only filesystem guarantee. The settings and
creation interfaces therefore name the effective boundary explicitly. Existing sessions retain
their restrictions, while new sessions can use provider approvals and perform explicitly requested,
coordinated parent implementation without weakening strict mode.
