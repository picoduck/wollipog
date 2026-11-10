# Managed Profile Root Diagnostics and Repair

This backend/CLI slice addresses existing SSH account roots for Refs #4437. It does not complete
the issue's diagnostic transport, UI projection or account-creation race-hardening criteria.

`wollipog profile-root inspect --component manager_root --json` inspects the current OS user's
managed root. `profiles_root` selects its fixed `profiles` child. There is no arbitrary path or
profile-payload option. Inspection reads directory metadata only; it does not enumerate contents,
read credentials or journals, create missing directories, or change permissions. Public output
contains an allowlisted component, reason, success flag and repairability flag. Raw filesystem
errors, paths, UID/mode/inode values and internal snapshot tokens are not projected.

A person in a local interactive terminal may run `wollipog profile-root repair --component
manager_root`. The CLI inspects again and prompts for the exact component phrase, displaying an
opaque fingerprint of that fresh snapshot. The response applies only to that invocation and
snapshot. There is no `--yes`, stored consent, remote grant or repair from an injected Session.
Inspection can be used unattended. Adding a command does not authorize agents to repair live state.

On supported Linux filesystems, repair is offered only for an existing, expected-owner, real
directory whose failed condition is group/other write permission. The existing verified native
helper pins no-follow ancestry and directory descriptors, checks ownership, special bits and
access/default POSIX ACLs, and binds the inspected object metadata. Indeterminate ACL inspection,
any extended ACL, unsafe ancestry, links, wrong ownership and unsupported layouts remain refused.
macOS repair is explicitly unsupported pending validated descriptor ACL coverage; Windows is
unsupported. Preserve such directories and ask an operator for guidance.

The sole mutation is `fchmod` on the pinned descriptor, clearing group/other write bits. Other
permission bits and directory contents are preserved. There is no recursive chmod, chown, broad
OS-home change, deletion, credential movement or lease bypass. The separate metadata mode leaves
the helper's probe and WPLL4 lease transaction protocol unchanged, using the same verified
packaging and resolver.

An identity change before mutation reports `identity_changed`. Once mutation is attempted,
verification failure or a lost helper response reports `may_have_changed`, naming the safe
component. This is an uncertain result: the original inspected directory may have changed even
if its path was subsequently replaced. Preserve all evidence and obtain operator guidance.
Neither automatic replay nor rollback is safe. Descriptor pinning prevents a replacement path
from redirecting the chmod, but it cannot prevent the same OS user renaming its own directories
between checks; a successful report describes the verified result at that observation.

Synthetic regression fixtures cover content/mode preservation, stale and replayed metadata,
extended ACL refusal, cancellation and unattended refusal, and substitution both before and
after mutation. Native race barriers exist only in a test compilation, never the packaged
helper. Platform packaging and hosted cross-model review remain required before delivery.
