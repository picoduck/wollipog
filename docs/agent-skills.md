# Agent Skills Management and Deployment

Status: managed Linux/macOS/Windows deployment, Git import, Linux/Windows machine snapshots,
guarded Linux adoption/recovery, version history with library rollback, machine-wide version pins,
and assignable groups implemented; remaining mixed-context WSL work is phased.

## Assignable Group API

New groups created through `POST /api/skill-groups` carry the creator's default resource scope:
organization scope for owners/admins, private scope for other members. Legacy groups remain shared
organizational metadata and cannot deploy until explicitly converted with
`POST /api/skill-groups/:id/convert` and `{ "accepted": true }`. Conversion requires every current
member to have the proposed scope; it never transfers skill ownership. Mixed-scope legacy groups
must be reorganized before conversion. An owned group's members must share its exact ownership scope.

`GET`/`POST /api/skill-groups/:id/assignments` lists or creates group rules. Creation accepts
`scopeKind` (`instance` or `runner`), `runnerId` for a machine rule, `agentSelector`, `invocation`
(`agent` or `manual`), and optional `enabled`. `PATCH`/`DELETE` on
`/api/skill-groups/:id/assignments/:assignmentId` changes policy or removes a rule. Reads and writes
require group access and, for machine rules, machine access. All writes require a human identity.

Membership is expanded at reconciliation time and ownership is rechecked, including after later
membership or ownership changes. Existing scope/agent specificity precedence is preserved; a direct
skill rule beats a group rule at equal specificity. Rules do not override machine-wide version pins.
Member addition/removal, skill deletion, and group deletion push an authoritative update; deleting a
group preserves its library skills and their direct assignments. Registration preserves group rules,
while deleting a machine clears its machine-specific rules. Offline and older runners retain the
existing reconciliation/capability behavior. Import previews count group rules in assignment impact.

The Skills dashboard exposes group creation, conversion, membership, and inherited assignment rules.

## Machine-Wide Version Pins

**Machine Versions** selects one version policy for a skill on a machine: **Track Latest** or a
specific immutable revision. Preview the current and proposed files and explicitly accept the
machine-wide impact before saving. Pins affect every assigned agent on that machine without
creating assignments or changing targeting. Offline machines apply the policy when they reconnect.
Library imports, updates, and rollback do not advance pinned machines. Returning to **Track Latest**
adopts the current library revision and future updates. Concurrent library or policy changes reject
stale previews, including changes away from and back to the same policy.

This follows the explicitly selected single-canonical-copy design: versions are machine-wide,
not independently pinnable per agent. Conflicting per-agent version requests are not supported.
Policies persist across runner registration, require access to both skill and machine, and enforce
the same audience-containment and capability rules as deployment. Group assignments and guarded
source adoption are described below.

## Version History and Library Rollback

Open a skill's **Version History** to browse immutable revisions, 50 at a time.
**Preview Version** compares every historical file with the current library content, including
removed files, scripts, and binary content. Preview does not run instructions or scripts.
After accepting the diff and assignment impact, **Restore Version** copies the selected content
into a new immutable revision and syncs assignments on unpinned machines. Earlier and newer revisions remain
available, with original Git and machine-snapshot provenance preserved. The restore note identifies
the source revision. A concurrent library update rejects the restore; preview again before retrying.

This is library-wide rollback; pinned machines keep their selected revision. Offline machines
reconcile when they reconnect; unsupported platforms retain their existing no-write behavior.
Group assignments retain the selected machine-wide version policy when they expand dynamically.

## Implemented machine snapshot import

**Import from Machine** discovers real skill directories in `.agents/skills` and configured native
Claude/Codex harness locations on an online Linux runner using protocol 111 or newer, or a Windows
runner using protocol 119 or newer. An owner or administrator must have access to the source
machine. The control plane requests opaque candidate
IDs from an on-demand inventory, never arbitrary host paths, and never adds file contents to the
periodic `skills_state` report. Discovery lists at most 64 candidates, examines at most 256 entries
per harness directory, and retains at most 256 expiring candidate IDs on the runner. Shared harness
locations are scanned once; divergent same-name directories remain separate candidates. A separate
4,096-entry raw iteration ceiling keeps skipped private journals from removing the hard discovery
bound while preserving the 256-entry useful-work budget.

The runner opens every untrusted path component with `O_NOFOLLOW` relative to pinned directory
descriptors through `/proc/self/fd` on Linux. Windows uses pinned native handles opened with
`FILE_FLAG_OPEN_REPARSE_POINT` and without delete sharing. Symlinks, junctions,
hard links, special files, excessive depth/entry counts, and trees
exceeding the existing 64-file / 512 KiB-per-file / 2 MiB-total limits fail closed. Two bounded reads
must agree before content is returned. The configured HOME itself may resolve through a symlink;
its untrusted descendants may not. macOS and mixed-context WSL imports are not implemented.

The preview shows the complete proposed files, digest, script-path indicators, and any existing
version's files. An import commits exactly those previewed bytes with machine/directory/name,
digest, and import-time provenance, even if the source subsequently changes or disconnects.
Identical content reuses the latest version. Different same-name content requires explicit
acceptance as a new version; a changed library version or replaced preview rejects stale acceptance.
Rename-on-collision is deferred. Four expiring control-plane discoveries each retain at most one
snapshot; one content/discovery request is active at a time. Internal runner errors are sanitized.

Import is not adoption: new library skills stay unassigned, and no source directory is replaced.
Explicitly accepted updates to existing skills retain their assignments and trigger the existing
managed deployment reconciler, which refuses to overwrite unmanaged directories. Git upstream
metadata remains intact when a machine snapshot updates a Git-backed skill. The separate adoption
flow (durable snapshot + explicit assignment + source-digest check before replacing a directory)
is documented below.

### Read-only adoption preflight

`POST /api/skill-machine/:discoveryId/adoption-preflight` accepts the current `previewId` from
the machine snapshot preview. Import consumes that preview, so preview the source again after
importing it and creating an explicit assignment. This owner/admin-only endpoint is read-only:
it does not adopt a directory, create assignments, change pins, or send a deployment command.
It uses the same online Linux/protocol-111 gate and bounded opaque-candidate read as import.

The source is read again and must match the preview's full content digest and discovery identity.
After that read, current ownership, effective direct/group assignments, disabled overrides, and
machine-wide pins are resolved again. The selected immutable library version must have valid bytes
matching the source. At least one effective target must read the source's native harness directory
(or the canonical directory); unsupported manual invocation or conflicting policies in a shared
Claude directory block the whole report. Manual Claude targets carry a content-transformation
advisory because the deployed harness variant may inject `disable-model-invocation: true` into
`SKILL.md`; the canonical copy remains untransformed. The report lists configured siblings without
an effective target (including disabled assignments) that share the source directory instead of
promising per-agent file isolation. Reader fields describe potential configured deployment exposure,
not current filesystem links or observed reads, especially for an unmanaged canonical directory.
It does not certify which running harnesses have loaded those files.

`status: "prerequisites_met"` is an observation, not an adoption authorization. On a protocol-115
Linux runner it also mints a one-use, preview-bound adoption token. Closing, importing, replacing,
or expiring the preview invalidates it. The owner/admin must separately confirm the operation and
any named shared-directory readers. Manual invocation variants remain blocked because their
deployed frontmatter can differ from the approved source bytes.

### Internal recoverable adoption transaction

The runner's `adoptMachineSkill` module implements the Linux filesystem transaction. Protocol 115
exposes it through a serialized runner command, owner/admin API, and the machine-import dialog.
Its trusted caller must resolve the opaque candidate and expiry, verify the durable
library version and current explicit assignment/invocation/shared-directory consent, and serialize
the whole operation with reconciliation and store GC. A read-only preflight report is not that grant.
The module requires synchronous lease acquisition and an authorization callback, repeats the latter
before source movement and link publication, and rejects async guards.

The source and already-materialized untransformed store version are read twice through pinned,
no-follow descriptors with the existing snapshot bounds. Both must match the approved digest, and
the source must retain its discovery generation and directory identity. Store/source overlap is
rejected. The engine supports original agent-invocable content only; manual variants fail closed.

Before moving the source, it creates a private mode-0700 sibling directory named
`.wollipog-adoption-<uuid>` with a mode-0600 `intent.json` describing source/parent/target identities
and digest. It flushes content, directory ancestry and the journal, then renames the original into
that directory as `original` on the same filesystem. It checks the preserved identity/content again,
records `preserved.json`, and exclusively creates the managed store-target symlink. A newly occupied
source path makes publication fail; it is never overwritten. `linked.json` records completion.
Normal serialized reconciliation can subsequently route a harness link through the canonical link.

First adoption has a short gap between source preservation and link publication; it is not an
atomic directory-to-symlink exchange. `recovery_required` means inspect the operation before any retry
or further reconciliation: the source may be untouched, absent, newly occupied, or already linked.
The engine never deletes a backup, auto-restores over a path, or rolls back by removing a concurrent
occupant. Journals and backups survive runner process death and are not collected by ordinary skill
disable/GC. Tests kill a child process at each journal boundary; hardware/power-loss recovery has
not been tested, and durability depends on filesystem support for `fsync`.

The returned backup directory is home-relative to the original parent and is displayed after
completion or a recovery-required result. If that parent was moved,
locate the operation UUID in the moved directory and compare its recorded identity; do not follow a
replacement parent symlink or blindly move `original`. A last-instant source-name swap may preserve
the substituted tree, which is detected as an identity mismatch rather than deleted. The command is serialized
with reconciliation/GC, rechecks the latest desired digest and targets, and runs a solicited sync
first so the target is materialized. Lost or uncorrelated results instruct the operator to inspect
for a journal before retrying. Backups are intentionally retained without automatic cleanup.
macOS snapshots and mixed-context WSL snapshot/deployment remain under #251. Standalone WSL
runners report Linux and use this path.

### Adoption recovery inspection and restore

Protocol 116 adds a bounded recovery command. **Inspect Recovery** asks an online Linux runner to
scan at most 4,096 raw entries in each known native harness directory and return at most 64 validated
journals. The control plane accepts only fixed harness-relative journal paths and projected operation
fields; arbitrary client paths and malformed runner results are rejected. Inspection and restore are
owner/admin-only, correlated, re-authorized after the runner response, and serialized with adoption,
reconciliation, and store GC.

Operations report `intent_only`, `source_preserved`, `managed_linked`, `restored`, or `blocked`.
Intent-only and already-restored states need no mutation. A restore requires an explicit per-operation
confirmation. It reopens the journal and parent through pinned no-follow descriptors, verifies the
preserved inode and full digest, and writes durable, retry-safe checkpoints. An active managed link is
moved into the journal first. An exclusive recovery link then exposes the journal's verified `original`
at the vacated source name. Link creation fails on any last-instant file, link, or directory occupant;
nothing at the source name is unlinked, recursively deleted, or overwritten. A changed parent,
malformed record, target mismatch, or race stops safely. Every checkpoint is retryable, including a
process interruption after the managed-link move or recovery-link publication. The original retains
its inode, bytes, and source metadata inside the private journal, and both it and the prior managed link
remain available for manual inspection. Journals are intentionally retained; the recovery link is
reported as unmanaged until the operator deliberately adopts or relocates that source again.
The solicited reconciliation after restore can remove verified managed harness links that routed
through the former canonical link, because the restored canonical source is now unmanaged. A
managed link archived inside the journal can also outlive its referenced store version after
ordinary retention GC. The journal preserves both artifacts for inspection; it does not promise
that reconciliation will keep serving the former managed deployment.

## Implemented Git import

The Skills view's **Import from Git** action accepts HTTPS and SSH remotes (or GitHub
`owner/repository` shorthand), a branch/tag/commit, and an optional repository subdirectory.
Only the instance's local owner identity can use the control plane's ambient Git credentials,
including from a paired device. Organization owners and administrators do not acquire that
authority from their organization role. Credential-bearing
URLs, local-file transports, symlinks, and submodules are refused. Git objects are read without a
checkout, hooks, or script execution. Fetches have a 60-second command timeout, a 90-second overall
deadline, and a monitored 128 MiB temporary repository budget; skill payload limits also apply.
Discovery is capped at 32 candidates and 16 MiB of content; narrow the subdirectory if necessary.
An invalid candidate fails the preview, so choose a valid skill's exact directory to import it.

Preview shows every proposed and current file, highlights scripts, and records the resolved commit.
The user selects one or more skills to import. New imports have no assignments. Existing different
content requires explicit diff acceptance and updates existing track-latest assignments; identical
content reuses the current version. A concurrent library change invalidates acceptance. Previews
are scoped to the requesting human and organization, expire after ten minutes, and are discarded
on restart. At most four previews and one discovery are active at once.
The existing skill-file format and digest do not preserve executable bits. Protocol 115 machine
snapshots therefore report executable paths separately, without changing version identity. Such a
snapshot can still be imported as content, but adoption fails closed so replacing the original
cannot silently discard its execution metadata. Imported scripts deploy as ordinary files and
should be invoked through their interpreter. Supporting executable adoption requires a future,
rolling-compatible metadata format.

Git-imported versions retain URL, requested ref, repository path, and resolved commit separately
from skill content. **Check for Updates** repeats the preview flow; there is no automatic polling
or update. Import does not rename collisions: use a new source name or cancel. Non-Linux machine
snapshot import now includes native Windows; macOS snapshots and mixed-context WSL deployment
remain under #251. Native Windows deployment uses directory junctions. Standalone WSL
runners report Linux and use the Linux path. Later
sections describe that broader target design.

This document describes a planned feature that lets users manage a library of agent skills in
Wollipog and deploy them to the Machines they have connected. A skill is a directory tree containing
a `SKILL.md` file plus optional supporting files (for example harness sidecars such as
`agents/openai.yaml` and payload documents). Skills are consumed by coding-agent harnesses like
Claude Code and Codex from harness-specific directories.

The feature covers:

- A control-plane-owned Skill Library with groups, versions, and ownership.
- Targeting: which Machines and which Coding Agents each skill applies to.
- Per-assignment enable/disable and invocation policy (agent-invocable vs manual-only).
- Deployment to a single canonical location per machine (`~/.agents/skills`) with symlinks into
  each harness's skill directory.
- Optional git-repo backing as an upstream source for the library.

## Motivation

Today each harness reads its own copy of every skill (`~/.claude/skills`, `~/.codex/skills`, …),
and copies drift. There is no way to see, from one place, which skills exist on which machine,
to target a skill at a subset of agents (for example a `codex-review` skill that only the Codex
harness should see), or to disable a skill everywhere at once. `docs/SCOPE.md` already anticipates
scanning `~/.claude/skills/*/SKILL.md`, and `docs/DRIVERS.md` documents Codex `{type:"skill"}`
input items, but nothing is implemented: skills are greenfield in the product.

## Current state of the codebase

Skills have no table, protocol message, scanner, or UI. The design reuses these existing
mechanisms:

| Need | Existing precedent |
| --- | --- |
| Harness directory knowledge | `apps/runner/src/discovery/discover.ts` (`KNOWN`, `COMMAND_DIRS`) |
| Safe file writes | `apps/runner/src/hook-settings.ts` `protectedWrite()` (atomic rename, 0600, symlink refusal) |
| Bounded scan + containment | `apps/runner/src/discovery/claude-commands.ts` (`CLAUDE_COMMAND_LIMITS`, `assertClaudeCommandPathContained`, non-YAML frontmatter parser) |
| CP→runner mutation with confirmation | ACP registry approval flow (`acp_registry_approval` end to end) |
| Authoritative inventory reporting | `agents_updated`, `SubscriptionUsageInventoryMessage` |
| Scoped config merge | `resolveAcpSessionContext()` (runner < workspace < agent precedence) |
| Version gating | `RUNNER_CAPABILITY_MIN_PROTOCOL` + `runnerSupportsProtocol()` |
| Serializing provider-home writers | `apps/runner/src/provider-home-lease.ts` |

Two constraints shape the design:

1. The runner never writes into `~/.claude` or `~/.codex` today, and nothing in the codebase
   creates symlinks; several code paths actively refuse them. Skill deployment is the first
   feature that must write into harness homes, so it needs explicit, narrow invariants.
2. No `git clone`, `fetch`, or `pull` exists anywhere, and the runner has no credential-injection
   path for private repositories. Distribution therefore rides the existing runner WebSocket, not
   per-machine git operations.

## Concepts

### Skill

A named, versioned directory tree owned by the Instance. The directory name and the `name:`
frontmatter key in `SKILL.md` must match. Content is immutable per version and identified by a
content digest computed over a manifest of file paths, sizes, and per-file hashes.

### Skill Group

An ordered, user-visible grouping of skills. Groups organize the library UI and are also
assignable: assigning a group to a target deploys every enabled skill in it.

### Skill Assignment

A targeting rule: `(skill or group) × scope × agent selector`, with per-assignment `enabled`,
`invocation` policy, and version policy (`track-latest` or a pinned version).

- Scope: instance-wide default or one Machine. Workspace/Project scope is a later phase.
- Agent selector: all agents, a driver kind (`claude-code`, `codex`, …), or one exact agent id.
- Precedence resolves like the MCP merge: instance default < machine < agent-specific.

### Deployed Skill State

The runner-reported truth for one Machine: which skills are materialized at which digest, the
health of each harness link, conflicts with unmanaged content, and any unmanaged skills discovered
in harness directories.

## Data model (control plane)

New tables appended to `SCHEMA` in `apps/control-plane/src/db.ts`, following existing conventions
(idempotent DDL, JSON columns for rich shapes, a `skill_ownership` table mirroring
`project_ownership`):

- `skills` — `id`, `name`, `description`, `group_id`, `source` (`library` | `git` |
  `imported-from-machine`), timestamps.
- `skill_versions` — `id`, `skill_id`, `digest`, `manifest` (JSON: files, sizes, hashes),
  `git_commit`, `note`, `created_at`. File content is stored through the existing artifact blob
  storage.
- `skill_groups` — `id`, `name`, `sort_order`.
- `skill_assignments` — `id`, `skill_id` or `group_id`, `scope_kind` (`instance` | `runner`),
  `runner_id`, `agent_selector` (JSON), `enabled`, `invocation` (`agent` | `manual` | `inherit`),
  `version_policy` (JSON), timestamps.
- `skill_ownership` — `organization_id`, `owner_kind`, `owner_id` (uniform `ResourceScope` shape).
- `runner_skill_state` — per-runner reported inventory (JSON snapshot, replaced wholesale).

Assignments deliberately live outside `runners`, `runner_agents`, and `workspaces`, which are
replaced on every runner re-registration (the same reason `machine_overrides` exists).

## On-disk layout on a Machine

A versioned, immutable store plus two symlink hops:

```text
<dataDir>/skills/store/<name>/<digest>/   immutable materialized versions (runner-owned)
~/.agents/skills/<name>                   symlink -> active version in the store
~/.claude/skills/<name>                   symlink -> ~/.agents/skills/<name>
~/.codex/skills/<name>                    symlink -> ~/.agents/skills/<name>
```

Properties:

- **Atomic update and rollback.** A new version is materialized fully in the store, then one
  symlink flips. Rollback repoints the link. Superseded versions survive the configured
  `skillRetention.previousVersionMinutes` grace period so running sessions keep a consistent tree,
  then are garbage-collected.
- **Disable is link removal.** Disabling a skill for an agent removes only that harness-dir
  symlink; content stays staged for `skillRetention.removedSkillDays`, so common re-enables are
  instant while never-again-desired content remains bounded. Per-agent targeting is expressed as
  which harness directories receive links. Retention timestamps are durable runner-local state;
  malformed state resets windows conservatively instead of authorizing early deletion. The
  compact state writer sorts entries and fits the largest prefix accepted by both its 8,192-entry
  and 1 MiB reader limits; omitted entries are logged and restart their grace window. Backward
  wall-clock changes and discontinuous forward jumps preserve accrued age; expiration advances
  again only with ordinary clock progress between connected reconciliation passes, so offline time
  does not age retained content. Independently of time grace, each successfully validated and
  materialized skill retains at most 64 unprotected safe stale version directories plus its current
  desired variants; live-link-protected versions, invalid desired entries, and symlink-bearing trees
  remain untouched rather than being deleted unsafely.
- **Never clobber user content.** The runner only creates or replaces symlinks that verifiably
  resolve into its own store. A pre-existing real directory at a target path (a hand-managed
  skill) is a conflict surfaced in the UI with an offer to adopt it into the library — never an
  overwrite. This is the inverse of `protectedWrite()`'s symlink refusal and needs the same rigor:
  segment-by-segment containment checks and never following links the runner did not create.
- **Windows** uses directory junctions (no privilege or developer-mode requirement).
- **WSL**: a Machine can host native and WSL agents (`runner_agents.context`); the reconciler
  materializes into each context's home using the existing WSL path-mapping helpers. Note that
  `hook-settings.ts` currently refuses WSL for settings injection; skills must support it because
  mixed-context machines are a primary use case.

### Per-harness materialization and invocation policy

Source content stays immutable; small deterministic transforms are applied at materialization per
target, so the deployed digest is a pure function of the source digest and the transform:

- Manual-only invocation on Claude Code injects `disable-model-invocation: true` into the deployed
  `SKILL.md` frontmatter.
- Codex consumes the `agents/openai.yaml` sidecar and `$name` invocation.
- A per-driver adapter table (skill directory path, supported invocation modes, frontmatter
  dialect) parallels `COMMAND_DIRS` and `capabilitiesFor(driver)`. Harnesses that cannot express a
  requested mode get the closest fallback or are skipped with a visible "not supported on this
  harness" status.

## Sync protocol

Declarative desired state, not imperative install commands. Convergence is idempotent and re-runs
on every registration, which makes durability trivial (no receipt outbox needed).

- Capability `agentSkills` introduces managed deployment at v90; `chunkedAgentSkills` upgrades
  delivery at v96. Pre-v96 runners retain the bounded single-frame `skills_sync` protocol and its
  fail-closed 32 MiB aggregate budget.
- **CP→runner `skills_sync_manifest`** — the content-free authoritative list for the Machine. The
  runner compares its verified local store and replies with `skills_sync_need` naming only absent
  `(name, versionDigest)` pairs. The control plane sends each requested version in its own bounded
  `skills_sync_content` frame, followed by `skills_sync_complete`.
- The runner keeps multi-frame assembly ephemeral and never reconciles, especially never removes,
  before the matching completion fence. A new manifest or reconnect discards an incomplete
  transaction. An assembly with no accepted progress for 60 seconds expires conservatively so it
  cannot suppress later removal forever. Cached digests are linked directly without retransferring
  their contents.
- The control plane retains only manifest metadata and immutable version ids while negotiating.
  Requested versions are loaded and flushed one at a time under a 13 MiB encoded runner-buffer
  ceiling; the runner validates and publishes each frame to its local store immediately, so neither
  peer retains the aggregate catalog contents in transaction memory. A slow or interrupted writer
  never sends the completion fence. A manifest that never receives a valid need expires after 30
  seconds, and every stalled frame flush has the same bound; healthy per-frame progress may take
  longer than 30 seconds for the aggregate catalog. A solicited manual sync refreshes its correlated
  reply deadline on each verified need or successful frame flush, so the UI remains in progress for
  a healthy aggregate transfer while the same inactivity bound still fails a stalled one.
- Manifest cache checks and reconciliation share the same native-harness/manual-variant policy, so
  discovery changes fail closed instead of letting the two phases disagree about required content.
- **Runner→CP `skills_state`** — deployed digests, link health, conflicts, unmanaged skills, and
  the pass's bounded managed-link removals. Deployed state, unmanaged inventory, and the pass error
  are authoritative full replacements modeled on `SubscriptionUsageInventoryMessage`. Removals
  are instead a latest-event projection: each non-empty report replaces the prior event and gets
  its own `removalsUpdatedAt`; a later empty or omitted field retains that event and timestamp.
  History is absent only until a compatible runner reports its first non-empty event. Legacy
  persisted blobs with no removals read as empty history with no event timestamp; blobs with
  removals but no `removalsUpdatedAt` use the inventory timestamp as their compatibility fallback.
  The per-machine API identifies pre-v96 runners that cannot report removal events. Reports are sent
  after each reconcile, on registration, and on the periodic discovery tick. Unmanaged skills come
  from a bounded harness scan using the `claude-commands.ts` limits and deliberately non-YAML
  frontmatter reader.
- Sync triggers: assignment or library change, runner registration, and a manual "Sync Now"
  mirroring Rediscover.

Because content is pushed over the runner channel, Machines never need git credentials or network
access to the skill source. All writes happen in the runner process (outside session sandboxes),
taking the provider-home lease when touching `~/.claude`, consistent with bwrap mounting `/`
read-only for agents.

## Git backing

Git backs the library as an **upstream source**, not as the distribution transport:

- The library remains the source of truth for targeting and delivery and works with zero setup.
- A library (or a group) may be linked to a repository and ref. The control plane — not runners —
  fetches and imports new commits as new skill versions, recording the commit sha per version. In
  the local-first deployment the control plane runs with the user's ambient git credentials;
  a headless deployment uses a deploy key.
- Repo layout maps one directory per skill, matching the existing `.agents/skills/` convention.
- Phase one is one-way (repo → library). Authoring happens in the repo, including with agents.
  Two-way write-back (UI edit → commit) is a later phase.

## UI

- New top-level Skills view (`{ name: "skills" }` in `navigation.ts`, plus `GLOBAL_VIEW_ITEMS`):
  group rail, skill list, detail pane (rendered `SKILL.md`, file tree, version history,
  per-machine deploy status with drift badges).
- Assignment editor: a Machines × Agents matrix per skill or group, with enable toggles and
  invocation mode. Deploy confirmations pattern-match `AgentRow.changeRegistryApproval` — a
  danger-toned confirm showing exactly what will land on the machine.
- Per-machine Skills section on the Machines screen: deployed skills, drift, unmanaged skills with
  an Adopt action.
- Diff preview before updating a deployed skill (the `installPreview` precedent).

## Additional features

1. **Adopt from machine** — onboarding scan finds existing `~/.claude/skills` / `~/.codex/skills`
   trees; one action imports them into the library and converts the on-disk copy to a managed
   link. Resolves pre-existing drift immediately.
2. **Drift detection** — deployed digest mismatch (hand-edited deployed copy) surfaces as a badge
   with "adopt edit as new version" or "restore" actions.
3. **Skill lint** — validate frontmatter, name/directory match, size limits, broken relative
   references, sidecar consistency; hard failures block deploy.
4. **Usage analytics** — count skill invocations per skill/machine/agent from session events to
   identify dead skills.
5. **Pin vs track-latest** per assignment, with rollback (falls out of the version store).
6. **Project/workspace-scoped skills** (later) — deploy into `<repo>/.claude/skills` at a
   Location; interacts with worktrees, so explicitly deferred.
7. **Edit-in-session** — open a skill in a Wollipog session on the skills repo workspace so an
   agent can edit it; merge triggers re-import.
8. **Export and sharing** — bundle a skill as an archive or share link; a community registry could
   later follow the ACP registry model (signed index, fingerprint approval).

## Risks and constraints

- **Symlinks are a new trust class.** Invariants: only create or replace links that resolve into
  the runner's own store; verify containment segment by segment; never follow links the runner did
  not create.
- **Container and cloud execution targets cannot see host skills** — they mount only the workspace
  cwd. Gate exactly like `includeClaudeUserCommandsForTarget()` and report "unavailable on this
  target" honestly. Mounting the skills root into containers is a deliberate later decision.
- **Provider-home concurrency.** Content is verified and materialized in the runner-local store
  before the reconciler requests the process-lifetime `ProviderHomeLeaseRegistry` lease. Every
  canonical or harness link mutation, including removal, happens only after that lease is held.
  Diagnostic scans never follow symlink targets; foreign symlinks are always reported by entry
  name only.
  During contention the runner mutates no shared-HOME path: it reports desired managed links as
  blocked and still applies retention plus the fixed 64-unprotected-stale-version bound to its own
  store. It probes every local skill's matching canonical and supported harness names for a live
  target regardless of the current discovery result, plus a bounded set of foreign direct-store
  aliases, before GC. Releasing the lease lets the next authoritative pass converge directly to the
  latest desired digest.
  Harnesses may cache their skill list at session start, so updates apply to new sessions; the UI
  says so.
- **Frontmatter is untrusted input.** Keep the "never interpret YAML aliases, tags, objects, or
  executable extensions" stance and the bounded-traversal limits when scanning machines.
- **Codex skill support is evolving.** The per-harness adapter table isolates directory paths,
  invocation forms, and sidecar formats from the core model.

## Group Management Dashboard

The Skills view's **Manage Groups** dialog creates ownership-scoped groups, explicitly converts
legacy metadata groups, and manages membership and group deployment rules. It displays the
server-computed creation/conversion ownership before acceptance. Conversion is permanent in this
UI, may restrict visibility, and never changes member ownership. Membership changes, rule edits,
and deletion require acknowledgment of their group-wide impact; adding a rule explicitly targets
all current and future members. Library content, direct rules, and machine pins survive group
removal. Unowned legacy groups cannot have deployable assignments.

Skill details distinguish inherited group rules from direct assignments. Direct rules win at equal
targeting specificity, while machine-wide pins still choose the version. These are assignment
rules, not a claim that every target has successfully deployed; machine-reported state remains
authoritative.

The **Machine × Agents** section separates desired invocation from the last reported link for each
agent and shows each machine's pin or Track Latest policy. Untargeted but still-reported links are
explicitly labeled: a shared harness directory or a pending reconciliation can leave them visible.
Unknown/failed reads never become an empty assignment or tracking default. Unsupported execution
targets are marked unavailable, and offline reports carry their last inventory timestamp. Policy
metadata is read through the same skill-and-machine authorization checks as version preview, but
without loading files. The version picker starts from the selected machine's saved policy; saving
still requires full preview and acceptance with the existing revision/latest-version fences.
For older control planes lacking the lightweight route, the picker reads the existing authorized
preview to recover the saved policy; it never infers Track Latest from a failed request. Failed
desired-state reads stay unknown through manual sync until an authoritative refresh succeeds.

## Phasing

1. **MVP** — protocol capability, tables, `skills_sync` / `skills_state`; library CRUD via
   import-from-machine and import-from-directory; per-machine × per-agent assignment with
   enable/disable; symlink deployment for native Claude Code and Codex; Skills view and
   per-machine section.
2. **Phase 2** — git upstream sync, groups as assignable units, invocation-mode transforms, drift
   detection and adopt, versions/pin/rollback, WSL and Windows-junction support.
3. **Phase 3** — project-scoped skills, usage analytics, sharing/export, edit-in-session,
   container mounts.

## Related documentation

- [Concepts and Glossary](./concepts-and-glossary.md)
- [Runner Credentials and Local Secrets](./runner-credentials-and-secrets.md)
- [Execution Targets](./execution-targets.md)
- [Drivers](./DRIVERS.md)
- [Scope](./SCOPE.md)
