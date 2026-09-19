# Agent Control CLI and MCP

Wollipog protocol v100 gives each native host session a purpose-specific control credential. The
runner stores the plaintext in a mode-0600 session file, sends only its SHA-256 digest to the
control plane, and waits for an exact positive acknowledgement marker before the CLI or MCP server
makes its first request. Stopping the session makes the credential unusable; deleting it cascades
the hash row and removes runner-local credential/config files.

The runner injects these non-transcript environment values at launch:

- `WOLLIPOG_CONTROL_PLANE_URL`: HTTP origin for the session's control plane.
- `WOLLIPOG_SESSION_ID`: the principal and ownership scope of every request.
- `WOLLIPOG_SESSION_TOKEN_FILE`: protected bearer source; never pass its contents in argv.
- `WOLLIPOG_SESSION_CREDENTIAL_READY_FILE`: runner/control-plane registration fence.
- `WOLLIPOG_CLI`: standalone executable location.
- `WOLLIPOG_CLI_ARGS`: JSON-encoded re-entry arguments for development/non-SEA launches.

The standalone installer publishes the same verified SEA bytes as both `wollipog-runner` and
`wollipog` (`wollipog.exe` on Windows). The invocation name selects the user-facing CLI; no Node
runtime or second download is required. A paired-device client may instead set
`WOLLIPOG_CONTROL_PLANE_URL` plus `WOLLIPOG_TOKEN` or `WOLLIPOG_TOKEN_FILE`. Device calls remain
human-principal requests and do not send an agent-session claim header.

## Commands

```text
wollipog session list [--archived] --json
wollipog session get ID --json
wollipog session events ID [--after SEQ] [--limit COUNT] --json
wollipog session create --runner ID --agent ID (--workspace ID | --path PATH) [--prompt TEXT] [--model MODEL] [--effort EFFORT] [--cost-budget USD] [--max-tool-calls N] [--max-child-sessions N] --json
wollipog session prompt ID TEXT --json
wollipog session wait ID [--for STATE,...] [--timeout MS] [--interval MS] --json
wollipog session stop ID --json
wollipog session restart ID --json
wollipog session archive ID --json
wollipog session guardrails ID [--cost-budget USD] [--max-tool-calls N] [--max-child-sessions N] --json
wollipog worktree create [--session ID] --branch NAME [--base REF] --json
wollipog worktree attach [--session ID] --path PATH --json
wollipog worktree select [--session ID] --path PATH --json
wollipog worktree discard [--session ID] --path PATH --json
wollipog admin <pairing-url|status|user list|device list|device create|device revoke|runner-credential ...> [--json]
wollipog service <install|status|restart|logs|upgrade|uninstall> [options]
wollipog doctor
wollipog update
wollipog pair <create|list|revoke|url> [options]
wollipog help [doctor|update|pair|service|admin|session|worktree]
```

`wollipog admin` is host administration for an SSH operator on the control-plane machine. It
authenticates with the control plane's protected local credential over loopback instead of a
session or device token and is documented in [host administration](./host-administration.md).
`wollipog service` manages the Linux systemd deployment; see [headless deployment](./headless-deployment.md).
The concise `doctor`, `update`, and `pair` commands delegate to `admin doctor`, `service upgrade`,
and the corresponding `admin device` or `admin pairing-url` commands. They preserve the canonical
validation, confirmation, secret-output, JSON, and exit-code behavior. Run `wollipog help` for a
workflow-oriented overview or `wollipog help <topic>` for complete topic commands and options.

An injected session defaults worktree commands to its own id and cannot override that target.
Paired-device callers may supply `--session`. A create without `--base` fetches and
resolves the remote default branch. Create, attach, and select return the selected absolute path;
the already-running provider process keeps its original operating-system cwd, so it must use the
returned path explicitly during that turn. A later resume or restart launches in the selection.
Discard is intentionally fail-closed: it removes only a runner-owned tree with a clean status and
no commits ahead of its configured upstream. If a provider still owns the path, the result reports
a durable deferred retirement; the runner resumes it automatically after provider exit. If a
merged pull or merge request's remote
branch has already been deleted, its forge-verified head OID can replace the missing upstream proof
only when it exactly matches the local branch head. Attached, active, dirty, other upstream-less,
unpushed, branch-drifted, and Git-unavailable worktrees are retained. The runner applies the same
checks during startup and periodic reconciliation after a linked change request is definitively
merged or closed; an unavailable forge keeps the durable open linkage unchanged.

Discard is the only supported way to retire a runner-owned worktree. `git worktree remove` bypasses
every check above and leaves the session selecting a path that no longer exists, so agent cleanup
workflows must not use it for a session-linked path. Provider approval also refuses raw Git and
filesystem retirement aimed at runner-owned paths while ordinary work beneath those roots remains
available. A deferred worktree is reported with the provider boundary it is waiting for; that is a
durable retirement request, not a failed cleanup or an invitation to force-remove the path.

Because a worktree can still disappear outside Wollipog, every launch that carries a persisted
worktree re-proves it immediately before the provider process is created — start, resume, worktree
rebind, and queued app-server recovery alike, and on every execution target, since container
placements bind-mount that same host directory and cloud placements snapshot it. A conversation
fork re-proves the source worktree before constructing its temporary provider. The path must still
be registered with the session's repository, healthy, on the recorded branch, and inside the
permitted boundary. A worktree that is missing, unregistered, unhealthy, moved, or branch-drifted
fails that one session with a durable error naming the invalid path; the runner never substitutes
the primary workspace, and no worktree lease, provider-home lease, or provider process is taken
before the check runs. A launch refused this way retains the worktree rather than reaping it: a
tree whose identity the runner just declined to confirm may hold work the session never made.

A session row written before the runner recorded `worktreeBranch` has no stored identity, so these
checks derive one from the layout that named the worktree. Worktree reconciliation records that
identity on such a row once it can confirm the worktree still carries it — and deliberately records
nothing when it does not, because persisting a branch someone switched to would bless the drift and
retire the check that catches it.

Shells, the Native TUI, and the Files browser resolve the same selection and re-prove it the same
way before opening. They skip only the Project Locations boundary — the coordinate is the session's
own persisted selection, already located by the create or attach that stored it, and the boundary's
directory preparation has no business running on a read path a user triggers by opening a folder.
A session whose worktree is missing, unregistered, unhealthy, or branch-drifted therefore reports
the invalid path and the remedy instead of a bare filesystem error, and no shell or TUI process is
started in it.

These requests are interactive and overlap freely, so one positive proof stands for a couple of
seconds against the exact path and branch it proved. Any selection the runner makes changes what the
proof is keyed on and is therefore never answered from it; only a change made outside Wollipog waits
out that window, which is shorter than the gap between proving a root and using it. Failures are not
retained, so a repaired worktree is usable again on the next request.

Claude Code launches also receive an additive `wollipog` stdio MCP configuration. Both adapters
execute the existing manager tool table, including bounded output projection and `wait_session`, so
their schemas, self-targeting checks, and REST paths cannot drift.

Agent-created children do not receive invented cost or tool-call limits. Explicit creation values
take precedence over the parent Project's child defaults, and a finite parent's remaining ceiling
still bounds every child at creation. If none of those sources supplies a limit, the child remains
unlimited for that dimension; explicit zero also requests no limit when the parent is unbounded.
Creation results report the effective limits, including `null` for none. `maxChildSessions` defaults to four
concurrent live children and accepts zero through 64. New Orchestrator sessions expose and persist
that initial limit before their first turn. Session views report the effective limit, occupied live
slots, and remaining capacity. Completed, failed, stopped, and archived
children release live slots, while their lifetime usage reservations remain charged to a finite
parent. Live cost/tool edits require delivery to an online current runner and fail closed rather
than leaving control-plane and runner thresholds out of sync.

`create_session` and `wollipog session create` accept an optional reasoning effort alongside the
model. The control plane validates the requested pair against the selected runner harness before
creating the session, and the same create request carries both values through governance approval,
persistence, and the initial provider launch. Explicit values take precedence over saved Agent
Harness defaults. Omitting effort preserves the existing default-resolution behavior, including
harnesses that expose no configurable effort. The creation result and `get_session` report the
effective model and effort so callers can verify what launched.

Explicit effort selection requires protocol v138 between the current CLI or MCP adapter and the
control plane. The adapter rejects an older control plane before creation and tells the caller to
update Wollipog or omit effort; it never retries without the value. Older clients do not expose
this option and must be upgraded before a caller can request it. Calls that omit effort remain
compatible with the protocol-v100 Agent Control creation contract.

Creating an Orchestrator as an authenticated human authorizes its ordinary child-session creation
within the audience, workspace access, runner capacity, concurrency, cost, tool-call, and
child-admission limits already attached to the session. Explicit applicable governance policies
retain precedence and may still ask or deny. The control plane derives eligibility from the
persisted Orchestrator configuration and its own creation-actor record; children, imported sessions,
and ambiguous legacy rows do not inherit or infer it from prompts, titles, or client claims. Existing
rows are upgraded only when their stored campaign-policy provenance establishes human creation.
This decision is control-plane-local, so mixed-version runners and clients continue through the same
spawn gate without a protocol fallback or broadened resource access.

## Orchestrator Role and Execution Policy

Protocol v144 separates the Orchestrator's coordination role from its execution boundary. New
sessions default to **Delegate Implementation** with `execution.strictProjectIsolation=false`.
The parent plans, assigns explicitly authorized child work, monitors progress, and reviews results;
an ordinary multi-issue request is not itself authorization to create a campaign or children. The
parent may maintain planning artifacts permitted by its provider policy and governance settings.

When a human explicitly asks the parent to implement, its launch instructions require it to inspect
child assignments and open pull requests for overlapping ownership, create and select its own
dedicated Wollipog worktree, and use the repository's normal testing, cross-model review, UI
evidence, merge, and cleanup workflow. The exact-session credential can request that self-worktree
only when the control plane's immutable campaign snapshot says strict isolation is disabled. No MCP
argument or session configuration mutation can change that snapshot.

**Strict Project Isolation** remains a human-controlled default for newly created sessions. It keeps
the previous session-private scratch directory, project-write refusal, restricted launch tools, and
host-boundary requirements. Legacy policy snapshots that lack the execution field normalize to
strict mode, so an upgrade never silently broadens an existing session. The Settings and creation
interfaces distinguish provider permission controls from OS-enforced read-only filesystem
isolation. Provider-mode native Claude Code requires interactive Default approval support. Strict
structured Claude also uses that runner control channel inside `bwrap` on Linux or Seatbelt on
macOS: routine coordination is auto-authorized by the shared semantic contract, and everything else
is denied. In provider mode, a routine-looking command that is not in canonical safe form is denied
back to the agent with retry guidance instead of producing a human approval card; genuine mutations
and unknown operations retain the normal provider approval path. Existing human-created root
campaigns recover missing issue scope from their immutable initial request on restart. Native TUI
and ACP launches without the channel retain `dontAsk`. Provider permission
checks, Parent Control, typed workflow decisions, authentication exclusions, child admission,
resource limits, and audit provenance are unchanged. The full operation and campaign issue-scope
contract is recorded in [ADR 0007](adr/0007-separate-orchestrator-role-from-project-isolation.md).

## Managed Worktree Administrative Paths

A runner-owned session worktree is protected against provider commands that remove or unregister it,
but that protection lives at the command-approval boundary and cannot see a write a script or tool
performs at runtime. The worktree's `.git` link file is the one path inside an otherwise writable
worktree where a single stray write is unrecoverable: Git reads it to locate the real administrative
directory, so a damaged link breaks every later Git operation and the session's pre-launch
verification while the worktree root and its repository registration both survive.

Sandbox modes that can express a per-path rule therefore present that link read-only to the provider
and leave the rest of the worktree writable. Git never rewrites the link, so ordinary edits, staging,
commits, branch switches, and test runs are unaffected. The repository's own `.git` directory is
deliberately **not** covered — every worktree's real administrative directory lives inside it, and
freezing it would break the commits this rule exists to keep working. Attached operator worktrees
contribute no rule at all: only runner-created identities are managed.

| Isolation mode | Enforces the read-only rule | Why |
| --- | --- | --- |
| `bwrap` (native Linux) | Yes | The link is bind-mounted read-only over itself after every writable bind, so writes fail with `EROFS` and delete or rename with `EBUSY`. |
| `seatbelt` (native macOS) | Yes | The profile denies `file-write*` on the link after the `allow` that grants the containing worktree; Seatbelt takes the last matching rule. |
| `bwrap` in Direct WSL | No | The target-local launcher attests only directories as bind sources, so a link **file** cannot be bound. Raising that needs a new attested launcher protocol version. |
| `windows-job` | No | Job Objects manage a process tree. They do not restrict filesystem access at all. |
| `container` execution targets | No | The workspace is one read-write bind into the image; the rule is not expressed per path today. |
| `cloud` execution targets | No | The filesystem boundary belongs to the remote adapter, not to this runner. |
| `provider` | No | There is no runner-owned boundary; the provider's own sandbox decides, and none of the supported providers expose a per-path exclusion inside a writable root. |

On a non-enforcing mode the behavior is exactly what it was before this rule existed. Nothing is
newly permitted anywhere: the rule only ever removes provider write access to one runner-owned path.

**The rule is bound at launch, like every other filesystem boundary here.** A `bwrap` or Seatbelt
sandbox is constructed when the provider starts, so the read-only entries are the ones that exist
then. A worktree the provider requests *during* a turn is created inside the session's
requested-worktree boundary, which is already writable, and a worktree switch schedules a relaunch
rather than rebinding a live sandbox — so that new worktree's link is writable until the relaunch,
exactly as the **Attach** notice already reports for the worktree root itself. This is the same
same-turn window the command-approval boundary has, tracked separately; closing it means retiring
the provider at creation time, not changing the sandbox rule.

## Typed Parent Control Decisions

An Orchestrator that cannot continue without a human response must create a structured blocking
request: `request_user_input` in Codex or `AskUserQuestion` in Claude. Writing the question only in
prose does not create attention and must not be treated as a fallback. A provider that cannot expose
its structured question action reports a visible compatibility failure and stops. The campaign
projection derives ownership from durable request and policy records; it never parses transcripts.

The root campaign surfaces human-owned descendant requests as **Needs Your Input** in its parent
status and request panel, even while its lifecycle remains **Awaiting Prompt**. Those requests use
the parent's ordinary Inbox, reminder, push, and browser-notification paths. Requests assigned to
the Orchestrator appear separately as **Orchestrator Action** and do not notify the human. Human
clients can inspect both groups. A session-scoped credential can list and resolve only its own
Orchestrator-assigned group; human-owned questions and approvals remain unavailable through agent
credentials.

Protocol v139 lets a human assign five workflow decisions independently to the human or the
controlling Orchestrator: implementation questions, pull-request merge approval, deletion of an
already-merged branch, publication of a sanitized follow-up issue, and UI-evidence approval. The
policy is revisioned. Every request records the exact controlling ancestor, child, category,
authority, policy revision, and a digest of its validated resource snapshot. A policy change,
ancestry change, audience loss, changed resource snapshot, duplicate response, or superseding
request fails closed. Approval is one-shot: the child must consume it against the same snapshot
immediately before starting the action. Protocol v142 gives PR merge consumption a narrower
two-step boundary. The child supplies the canonical command
`gh pr merge https://github.com/<owner>/<repository>/pull/<number> --squash --match-head-commit <approved-head-sha>`; the control plane
arms that exact command while the decision remains approved. The matching one-shot Bash or Codex
command permission is then admitted and the decision is marked consumed only after the allow
response is delivered to the runner. A changed command, failed delivery, stale policy, changed
ancestry, ambiguous match, persistent grant, or unsupported provider cannot consume the grant.
Other categories retain immediate consumption. Consumption records that the external action may
have started. A UI-evidence approval gates a later action rather than authorizing one, so campaign
child verification settles an approved evidence decision as consumed instead of requiring the child
to consume it first; a pending evidence decision, and every other approved category, still blocks
verification. A later policy change can revoke only approvals that have not been consumed; it does
not claim to roll back an action already in progress.

Protocol v150 adds a read-only reconciliation path for a PR merge that completed before its exact
armed occurrence was consumed. The child must be resumed on the same App Server thread and submit
the unchanged resource snapshot. Full provider history proves the exact successful command followed
its exact completed Wollipog admission call in the same turn, and the forge proves the approved
merged head. Only then does the control plane consume the original occurrence with
a content-safe audit receipt. Reconciliation never executes the command, and unavailable history,
duplicate commands, failed execution, forge mismatch, or mixed-version peers leave the occurrence
approved and retryable. Stale policy, ancestry, authority, or resource evidence revokes it.

Protocol v151 separates Wollipog's runner turn from the App Server's provider turn throughout
action admission. The control plane binds retries to the runner turn while the runner records the
provider turn returned by App Server; neither identifier may be substituted for the other. This
lets the ordinary `commandExecution` and Guardian auto-review paths consume the same exact typed
occurrence without a second decision. It also extends read-only reconciliation for CLI-arm paths
that do not appear as native provider MCP items: one exact durable arm marker must precede exactly
one allowed Guardian receipt for the canonical command in the same runner-history generation, and
provider history must contain exactly one successful command with those exact thread, turn, and
item coordinates. No later arm for the same command may intervene, and the provider item retains
one shared claim across live consumption and every reconciliation proof. The forge, snapshot,
policy, ancestry, and authority checks remain unchanged.
Missing, reordered, duplicated, cross-generation, replayed, or mismatched evidence fails closed.

Protocol v153 keeps that proof available across provider and session restarts. An ordered durable
runner sequence—arm, exact Guardian receipt, and one successful terminal update for the receipt's
item—can prove completion without asking the restarted App Server to reconstruct an old turn. A
legacy CLI admission that predates those runner fences may use only the exact Codex rollout for the
stored provider thread: one successful consume call for the occurrence and one later exact command
must appear uniquely in the same completed turn. The runner does not relay rollout contents, and
all existing snapshot, forge, policy, ancestry, authority, and receipt-replay checks still apply.
If `thread/read` retains the successful command but cannot represent that old CLI admission, the
rollout proof is accepted only when its thread, turn, and command item exactly match the live
successful item; a failed, duplicate, partial, fenced, or natively mismatched live item still blocks
the fallback.

Protocol v166 lets the resolver tell the child why. `resolve_descendant_workflow_decision` accepts
an optional `childMessage` of at most 2,000 characters, separate from the audit-only `rationale`.
The rationale is still never retained. The message is: its audience is the child, so it is stored
on the resolved occurrence, returned in the child's own `get_workflow_decision` view, and delivered
to the child as an ordinary prompt that wakes an idle child or queues behind a turn still in
progress. The governance audit records only the message's digest. The runner's tool refuses a
message when the connected control plane predates v166, because an older control plane would drop
the field and resolve the decision anyway. A child whose delivery was refused, for example while its
runner is offline, still finds the message on the decision record.

The control plane owns this lifecycle. A generic question answer or provider permission response
cannot satisfy a typed workflow decision. Authentication, identity, governance-policy changes,
secret access, and persistent permission grants are not typed categories and remain human-only.
The merge snapshot binds the repository, pull request, exact head SHA, cross-model review result,
and passing required checks from that same head. Branch deletion binds the merged branch and merge
commit and requires an explicit empty dependent-pull-request check. Follow-up publication binds the
sanitized repository, title, body, and labels. UI approval binds immutable evidence identifiers,
URIs, and SHA-256 digests, and resolution records which evidence was actually inspected.

### Orchestrator Review of UI Evidence

**UI Evidence Approval** is the one category whose saved owner is not automatically effective.
Assigning it to the Orchestrator is the human's opt-in to both decision ownership and the narrowly
scoped evidence access needed to exercise it; there is no separate access toggle. The Orchestrator
owns a decision only when all of the following hold, and otherwise the decision is created
human-owned with a `humanFallback` code and reason shown on the request card:

- the Orchestrator's runner speaks protocol v167 (`orchestratorUiEvidenceReview`);
- its harness hands MCP image content to the model (Claude Code, Codex App Server), its installation
  supports images, and its exact model advertises `image` input — unknown is treated as unsupported,
  and a selected model missing from the catalog never inherits the default model's capability;
- every evidence item names an `artifactId` of a `screenshot` Session artifact owned by the requesting
  child, declares an allowed image `mediaType`, and matches that artifact's type, size, and SHA-256.

Video (`media_video_unsupported`), unknown or non-raster media (`media_unsupported`), and evidence
that lives only behind a URI (`provider_untrusted`) always go to the human. The control plane never
fetches a child-supplied URL; the URI is display material for the human reviewer only. Campaign-level
unavailability is reported as `uiEvidenceReview.reasonCode` and `reason` on the campaign projection.
A human fallback is scoped to that one decision: other children and other assigned categories are
unaffected.

The Orchestrator inspects evidence with `review_descendant_ui_evidence` (`sessionId`,
`occurrenceId`, `evidenceId`). Delivery re-runs every gate that guards resolution — root campaign
controller, ancestry, audience, pending status, policy revision, and current authority — then reads
the artifact bytes, recomputes their SHA-256 against the digest in the decision snapshot, and revokes
the decision on mismatch instead of showing anything. The runner recomputes the digest again, then
acknowledges the exact receipt id and digest; only then does it return the image as MCP image
content. An unacknowledged receipt supports no approval, and a failed acknowledgement withholds the
image, so a dropped response or refused bytes can never stand in for a review. The text block carries only the receipt, so the CLI path,
transcripts of tool text, campaign projections, and audit never hold evidence bytes or signed query
parameters.

Each delivery records a server-side review receipt bound to the reviewer, child, occurrence, policy
revision, evidence identifier, artifact, and digest. `resolve_descendant_workflow_decision` approves a
UI-evidence decision only when an acknowledged, unexpired (one hour), unconsumed, unrevoked receipt exists for every
item; repeating `evidenceReviewed` identifiers is not sufficient. Denial needs no receipts. Receipts
are spent by resolution and revoked with the decision, so a policy-revision or ownership change,
supersession, or revocation invalidates them. The resolution audit lists evidence identifier and
digest pairs and the receipt ids spent; each delivery is a `review`-stage audit entry.

This boundary governs actions performed through Wollipog's workflow-decision tools. It cannot
intercept a separate shell, forge client, browser, or other credential that can independently
perform the action. Orchestrator instructions must therefore require `request_workflow_decision`,
the assigned authority's exact resolution, and `consume_workflow_decision` immediately before
using a supported mutation path. For PR merge, the command returned in the durable action admission
must be executed byte-for-byte. The GitHub CLI rejects enqueue if the PR head changed after review;
a generic or altered forge command deliberately falls back to its
ordinary human-only permission boundary. Audit entries correlate the typed decision occurrence and
matching permission through content-safe digests and outcomes without retaining raw rationale or
credentials or recording a second user decision.
For the exceptional case where that exact command already succeeded but the armed occurrence was
not consumed, `reconcile_workflow_decision` performs the v150/v151 proof above against the original
occurrence and snapshot. It is not a retry mechanism and must never be followed by replaying the
merge command.

Before creating a child, an Orchestrator can call `get_agent_capabilities` with an exact `runnerId`
and `agentId`. The matching CLI command is:

```sh
wollipog session capabilities --runner <runner-id> --agent <agent-id> --limit 50 --json
```

The response returns a bounded page of exact model identifiers and advertised display names,
defaults, descriptions, context windows, input modalities, and effective reasoning efforts.
`effortSource` says whether each model uses its own efforts, the harness-level fallback, or has no
configurable effort. Discovery is separately labeled available or unavailable, and known model
sources are labeled `live` or `cached`. An unavailable result identifies whether discovery was not
advertised or is negotiated only after starting an ACP session. Hidden models are excluded by default; use
`--include-hidden` to page through them or `--model <exact-model-id>` to inspect one persisted
hidden selection. Continue a truncated page with its `page.nextOffset`. The lookup is advisory:
`session create` revalidates the requested model and effort against the installation's current
capabilities immediately before launch, so capability drift fails closed.

Protocol v124 completes that contract for structured Direct WSL sessions. Discovery must resolve an
absolute, root-owned Linux Node 22+ runtime plus distro-owned compiler and bubblewrap runtimes with
the fd-bind contract. Before each provider launch, the Windows
runner rotates and registers the exact-session credential, waits for the control plane's positive
hash acknowledgement, and atomically installs a root-owned, mode-0555 helper and compiled native
launcher at fixed paths in that distro. The launcher uses `openat2` without following symlinks,
reopens and fingerprints the authoritative cwd, HOME, and every writable bind, and retains their
directory descriptors through bubblewrap exec. Session provider state and relay files live below a
root-owned runner/session hash anchor; only their exact leaves are writable. A target-local shared
HOME lease remains held until the sandbox is gone. The provider receives only a mode-0600 token and
MCP configuration in its private bwrap `/tmp`.

The helper connects to a per-launch mode-0600 Unix socket. A sibling relay outside bwrap is entered
through the same native launcher's held directory descriptor; its Node and helper files are opened
without following links and pinned through exec. It carries versioned bounded frames over that process's
standard input/output to the Windows runner, which checks the
session, token, readiness marker, and CLI command family before reusing the existing Orchestrator
tool table. The bwrap process sees only the one socket directory; it never sees `wsl.exe`, `/init`,
a TCP listener, or a general process-execution RPC. Relay exit removes the socket, provider stop
reaps both processes, restart rotates the token, and terminal/delete/startup cleanup removes
credential files. Direct WSL conversation fork/state adoption, provider-mode sessions, non-Orchestrator
sessions, WSL Native TUI, generic ACP, container, and cloud targets remain fail-closed.

## Authorization and compatibility

The general surface has a closed method-and-canonical-route allowlist. The control plane converts a valid exact-session claim into an `AgentPrincipal`, applies
the session's delegated resource scope, and records authorized mutations in the content-free
mutation audit under that session id. New API routes remain denied until explicitly added.

The CLI reads the authenticated `/api/compatibility` endpoint before a command and rejects a
control plane older than the protocol required by that command. The public `/healthz` probe keeps
only service-readiness metadata and does not expose the protocol version. During the unreleased
protocol-v100–v102 compatibility window, a 404 from the authenticated endpoint falls back to the
legacy health version; authentication failures remain fail-closed, including API-only peers that
answer 401 before routing the missing endpoint.
Runners connected to older control planes do not inject the general surface. WSL runners also
withhold the Orchestrator capability unless both peers negotiate v124 and fresh discovery proves the
complete target-local launcher contract.

See [Using Wollipog](../.agents/skills/using-wollipog/SKILL.md) for the compact agent-facing skill.
