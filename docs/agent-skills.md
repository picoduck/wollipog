# Agent Skills Management and Deployment

Status: design proposal (not yet implemented)

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
