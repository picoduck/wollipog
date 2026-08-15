# ADR 0003: Runner-owned execution isolation

- Status: Accepted for Linux/WSL, native macOS, and native Windows
- Date: 2026-07-12
- Decision owners: Wollipog maintainers

## Context

Claude, Codex, and ACP expose different permission vocabularies. Provider sandboxes remain useful,
but they cannot express one operator-owned host boundary or prove that a configured network denial
applies equally to every driver. ACP also launches command terminals through the runner, outside the
adapter process, so wrapping only the adapter would leave a policy gap.

## Decision

`executionIsolation.mode: "provider"` remains the compatibility default. The runner advertises this
honestly as provider-owned behavior and does not claim a uniform OS boundary. Native mutable provider
launches take an owner-attested process-lifetime lease for the whole canonical effective `HOME`, shared
by Claude, Codex, unknown ACP adapters, Seatbelt, Windows Job, and standalone Agent TUI processes.
Direct WSL provider mode fails closed; bwrap or a dedicated distro/account is required. Container and
cloud provider homes are independent.

`mode: "bwrap"` is an opt-in runner-owned profile for native Linux and WSL. Before constructing a
driver, the runner resolves `bwrap` in the target process namespace. It then launches every provider
session-serving process and provider helper with:

- a read-only bind of `/`;
- a writable bind of the exact session or activated terminal root;
- fresh `/proc`, `/dev`, and ephemeral `/tmp` mounts;
- a new PID/session boundary and parent-death cleanup;
- separate IPC and UTS namespaces plus a private `/dev/shm` directory;
- an optional unshared network namespace for `network: "deny"`.

Argument boundaries remain argv-native; no workspace, command, or provider argument is interpolated
into shell text. WSL resolution and execution both happen inside the selected distro. The profile is
forwarded through Claude one-shot/persistent/fork processes, Codex exec/app-server, ACP itself, and
ACP terminal creation. ACP filesystem operations retain their separate canonical-root and explicit
additional-directory-grant enforcement.

Strict mode never falls back. A missing binary, native Windows/macOS target, or launch failure ends
the session before an unisolated driver is constructed. Root callers are refused on native Linux and
inside WSL because a privileged process could remount or otherwise escape a write-containment claim.

`mode: "seatbelt"` is an explicit native-macOS profile. The runner resolves `/usr/bin/sandbox-exec`
and supplies a parameter-free `(deny default)` profile that permits process execution and system/file
reads, restricts writes to the exact worktree, runner data root, the user's temporary root, and the
selected provider transcript leaf, and grants network operations only for `network: "inherit"`.
All writable roots and HOME are realpath-canonicalized first so macOS `/var` → `/private/var` aliases
cannot turn an intended allow rule into a mismatched policy or availability failure.
The transcript leaf is the provider's shared real store, not bwrap's per-session mount. Seatbelt mode
therefore takes a cross-process exclusive admission lease per known Claude/Codex provider family for
runners sharing the data root. Unknown ACP adapter state is not made writable or serialized by guessing.
Restart is fenced while a fork helper holds the same session lease. This prevents concurrent writers but
does not claim transcript read isolation.
The runner creates a missing Claude/Codex transcript leaf before sandbox entry so a first strict launch
does not need write access to its read-only parent directory, then realpath-canonicalizes the leaf itself
so a symlinked provider configuration directory still matches Seatbelt's vnode identity.
In deny mode the profile also withholds unrestricted Mach access, closing daemon-proxied egress paths;
the macOS conformance job proves both an out-of-profile write and a loopback socket are denied.
Wrong-host and WSL selections fail before driver construction. Apple’s current supported
[App Sandbox](https://developer.apple.com/documentation/security/app-sandbox) model is entitlement
based; arbitrary installed provider CLIs cannot inherit the manager app's entitlements. The Seatbelt
adapter therefore remains opt-in, depends on the system compatibility launcher, and is exercised on a
native macOS CI host so removal or profile drift fails visibly rather than degrading to provider mode.

`mode: "windows-job"` is an explicit native-Windows process-tree boundary. Node launches Windows
PowerShell with an encoded in-memory C# bridge; the bridge creates the real agent suspended with the
runner's standard handles, creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigns the
agent, and only then resumes it. Children join the Job by default, and closing/killing the launcher
closes the final handle and reaps the descendant tree. Assignment or setup failure terminates the
suspended process and fails the launch. This follows Microsoft’s documented
[Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) lifecycle model.
Job Objects do not restrict file or network access, and modern Windows removed job-wide security
limits; configuration therefore requires `network: "inherit"`, and diagnostics label the mode
process-only. Stronger Windows filesystem/network isolation requires a packaged
[AppContainer](https://learn.microsoft.com/en-us/windows/msix/msix-containerization-overview) or a
future execution-target sandbox, not a dishonest Job Object claim.

## Security boundary

The bwrap and Seatbelt profiles are **write containment**, not read confidentiality. The read-only root remains visible so
provider CLIs can load their installed runtimes, configuration, subscription credentials, certificates,
and toolchains. Network denial blocks exfiltration through the isolated process namespace, but inherited
network mode does not. Environment variables explicitly configured for the agent still enter the sandbox.
Secrets therefore remain governed by the separate secret-reference and credential-injection roadmap.

In bwrap mode, most provider home state is read-only. The runner creates a hashed transcript partition per manager
session under its external data directory and bind-mounts only that narrow exception onto Claude's
`.claude/projects` or Codex's `.codex/sessions`. New isolated sessions can therefore persist transcripts
without granting write access to the user's real transcript store. Functional resume/fork still depends on each installed
CLI tolerating read-only auxiliary files such as Claude's root project index/todos and Codex history;
deterministic mount tests do not claim that live parity. Provider-mode history is not copied into the
isolated store, so switching an existing session may be non-resumable.

Repository checkpoints use the same stable owner identity under
`refs/{wollipog,mam}/owners/<ownerHash>/<sessionId>`. A durable layout discriminator and cleanup-ledger
owner hash keep restarts, rollback, and deletion on the exact namespace originally selected. Legacy
unscoped refs are never automatically imported; the offline state doctor conditionally creates owner
refs in one verified transaction and leaves every source ref intact.

The control-plane session id is SHA-256 keyed before it reaches path syntax. Unrelated isolated sessions
therefore cannot mount each other's transcript stores. A provider-native conversation fork first asks the
provider to create the fork in the source partition, then copies the completed store into the child's new
partition before publishing its metadata. The runner polls for the exact Claude session JSONL or Codex
rollout JSONL in the source partition first, requiring a non-zero size that stays unchanged across two
poll intervals, so an early provider RPC response cannot publish a child whose transcript is still being
written. Missing/empty, continuously growing, and interrupted artifacts fail the fork and clean the child
partition rather than publishing state that was never observed at a stable copy boundary.
Normal session deletion removes only that session's partition. The delete path journals the exact driver,
context, and session before removing its durable row, so WSL cleanup remains retryable after a crash.
Provider forks journal their target before the provider can create state. Remaining cleanup records are
runner-ownership evidence during reconciliation, so a short-lived partition that failed exact cleanup is
claimed and remains addressable by exact retry even if it never survived to an hourly live-session claim. If the
authoritative session row survived a crash, retry leaves the cleanup intent dormant without deleting state;
the record becomes actionable only after that row disappears. In-flight fork target ids are protected from
both exact retry and age-based reconciliation until the fork publishes or rolls back. The journal file's
timestamp supplies a one-hour cross-process grace before exact retry, covering shared-root runner processes.
Startup reconciliation expires this runner's claimed orphan partitions after `providerStateRetentionDays`
(default 7), removes oldest eligible owned orphans until their per-provider/context total is below `providerStateMaxBytes` (default
5 GiB), and never counts stored-session partitions as eligible. The journal grace and explicit in-process
target set protect an unpublished child being copied by another runner process; the byte ceiling can
therefore be exceeded temporarily by protected state. External-session discovery intentionally continues to
scan the user's real CLI store, so manager-owned isolated transcripts do not appear as external/import
candidates.

Because the legacy WSL root is shared by runners using the same distro user, startup reconciliation writes
a hashed runner-ownership marker only onto partitions referenced by this runner's durable store. Age/size
GC requires that exact marker; peer-owned and unclaimed WSL partitions are never candidates. Each WSL
context fails independently, so one offline distro cannot block native or later-distro cleanup. The global
The WSL legacy leaf is not automatically retired because no one runner can prove every peer migrated.

Persisted sessions without a provider-state layout version predate partitioning. Before such a session
launches or forks under bwrap, the runner copies the legacy provider-wide store into that session's hashed
partition under the durable per-session ownership lock and records version 2. The copy double-checks the
version after lock acquisition and refreshes the lock while it runs, so concurrent runners cannot remove
or partially replace a published partition. Sessions created by a partition-aware runner start at version 2 and never
import the legacy store. The native shared legacy leaf remains while any stored session for that provider
lacks version 2 and is retired only when at least one matching session proves the v2 layout and none remain
legacy. Empty/reset stores and all unowned shared legacy leaves fail safe by retaining historical state;
automatic retirement is intentionally disabled until provider-specific inventory can prove every transcript
was migrated.
Because the legacy store itself was provider-wide, each compatibility snapshot can initially contain
sibling legacy transcript files that were already mutually readable under the legacy layout. Partitioning stops
future cross-session writes/reads but does not pretend that copied historical bytes are newly confidential;
selective retirement belongs to reconciliation once every live provider id can be proven.

Credentials, configuration, plugin state, and unknown ACP adapter layouts remain read-only. OAuth
refresh or an adapter that requires a different writable home path may fail with `EROFS`; the runner
does not broaden home write access by guessing. Provider mode remains the compatibility option.

The runner creates an empty real-home target directory when a provider has never created its transcript
path; bubblewrap needs that mountpoint under the read-only parent. An explicit absolute agent `HOME`
override is normalized and used consistently for the bind target; relative, NUL-bearing, and
traversal-bearing overrides fail closed before any host directory is created.

`network: "deny"` removes cloud model connectivity as well as arbitrary egress. It is useful only for
fully local/offline models today. A future credential-aware egress broker must be an explicit execution
target capability; the runner does not weaken denial to make a cloud request succeed.

User-opened dashboard shells and runner-owned git/filesystem operations are not agent subprocesses and
are intentionally outside this profile. They keep their existing authenticated user-action boundaries.

## Alternatives and follow-up

- Provider-only sandboxing remains available but is not represented as uniform enforcement.
- Containers would add image/runtime lifecycle and are deferred to the execution-target roadmap.
- Apple entitlement-based App Sandbox cannot be attached to arbitrary installed CLI executables;
  Seatbelt is kept explicit and fail-closed instead of being selected automatically.
- Windows restricted tokens/AppContainer or Windows Sandbox could add filesystem/network boundaries,
  but require a separately packaged execution target and compatibility matrix. Job Objects intentionally
  solve only process-tree lifecycle today.
- Selecting one platform adapter in another native OS or WSL is rejected; there is no automatic
  cross-platform fallback.

Real-host conformance runs Windows Job assignment/stdio/argv/exit and descendant-reap tests on Windows,
plus Seatbelt allow/deny write probes on macOS. Nested provider-sandbox conformance and provider-specific
macOS transcript compatibility remain separate credentialed host tests. In particular, deny mode
withholds all Mach lookup to close proxy egress and may fail a provider that requires a system service;
that is a fail-closed compatibility result until a minimal non-network service allowlist is proven.
