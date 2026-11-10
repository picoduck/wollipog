# Managed Profile Directory Creation

New managed account directories use the existing verified native lease helper in a separate
`--profile-create` mode. This does not change WPLL4 or `--probe`. The runner checks the creation
capability before requesting any directory creation; an older helper fails closed, without a
path-based fallback. Resolver, asset verification and distribution remain shared with leases.

The runner supplies its trusted OS-home context and a generated lowercase UUID v4, never a
remote or CLI path. The only possible layout is `.agent-manager/profiles/<profileId>`. Each
component is opened relative to its pinned parent with no symlink following, checked for expected
UID, directory type, group/other write bits and unsupported ACLs, and rechecked before the next
mkdir and before success. Existing `0750` and `0755` roots remain accepted; `0775` roots remain
refused. Fresh directories use `0700` subject to the process umask. Existing payloads are never
read, moved, removed or modified. Creation never chmods, chowns or repairs anything.

Linux is the validated creation platform. macOS, Windows and other platforms return explicit
unsupported guidance before creation; shared POSIX APIs alone do not establish equivalent ACL
and metadata behavior. Existing account directories do not pass through this new-account path.

Failures use the existing `managed_profile_directory` error with a fixed `component`:
`os_home`, `manager_root`, `profiles_root` or `profile_home`. Fixed reasons include `symlink`,
`not_directory`, `wrong_owner`, `group_or_other_write`, `unsupported_acl`, `unsupported_layout`,
`unsupported_platform`, `unsupported_helper`, `unavailable`, `already_exists` and
`identity_changed`. Paths, filesystem values and raw subprocess errors are excluded.

After any successful mkdir, a subsequent failure reports `may_have_changed`, preserving its
original fixed reason as `failureReason` when known. A lost or malformed response also reports
`may_have_changed`; it cannot establish whether a directory was created. There is no automatic
retry, rollback or cleanup. The directories and any ownership evidence must be preserved for
operator inspection. This is diagnostic data, never repair authorization.

This is race-aware validation, not exclusion of all same-UID writers. Linux `mkdirat` does not
return a descriptor. The helper observes and opens the new directory immediately, then verifies
the observed inode against its named binding; a same-UID writer can replace it before that first
observation. Likewise a same-UID process can rename a directory after the helper's last check.
Private parents exclude other OS users, descriptor-relative operations never follow replacement
links, and observed substitutions refuse success while preserving possible creations. Provider
marker/lease validation remains independently required before sign-in. This slice changes no
provider launcher, transport, readiness projection, consent or remote authorization protocol.

Synthetic regression tests exercise actual compiled native code and the runner adapter, ACL
refusals, stale bindings, partial creation, substitutions before and after the final mkdir, mixed
helper versions and response loss. Compile-time barriers are absent from packaged helpers.
Fresh SSH bootstrap under ambient `0002` is a separate required fix (PR #4444); this slice retains
its existing `0775` refusal and does not make an unsafe bootstrap succeed.
