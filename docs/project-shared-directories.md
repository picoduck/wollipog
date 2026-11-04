# Project Shared Runtime Directories

Native Linux provider sessions normally get a read-only host root and a writable
session worktree. Their `/tmp` is private to the launch. Credentials elsewhere on
the host can be readable while shared login locks or renewed browser cookies fail
to save with `EROFS`. A per-session temporary directory cannot coordinate a shared
mailbox across sessions.

An operator can grant an exact existing runtime directory to one configured
workspace in the runner's own configuration:

```json
{
  "workspaces": [
    {
      "id": "project-id",
      "name": "Project",
      "path": "/home/developer/dev/project",
      "sharedWritableDirectories": [
        "/home/developer/.local/share/project/qa/runtime"
      ]
    }
  ]
}
```

Keep the containing QA directory and its credential files read-only. Create the
runtime leaf outside the session, with directory mode `0700`; authenticated state
files inside it should have mode `0600`. Do not grant the containing credential
directory, a checkout, HOME, runner state, runner configuration or provider account
directories. The grant is a persistent permission change made by the human
operator, not something a repository's `.wollipog.json`, a session prompt or an
agent tool can enable. This option changes no network permission.

The runner matches both workspace ID and the session's canonical repository path,
including sessions working in linked worktrees. Only exact existing canonical
directory paths are accepted; symlink aliases, overlapping grants, protected roots
and more than sixteen paths fail closed. The directory is mounted at the same
absolute path for each eligible session. Codex receives the same root in its inner
workspace policy. Review sessions, scratch-only Orchestrators, remote execution
targets and other workspaces receive no host grant. Unsupported local isolation
modes fail if a matching provider launch requests the grant; the initial support
is native Linux bubblewrap, including forced managed-worktree protection.

Configuration changes take effect when the runner restarts and a provider next
launches. Existing namespaces do not gain a mount mid-turn. Revoke by removing the
operator grant and relaunching affected providers. Do not restart or deploy the
stack that is hosting an agent from that agent session; hand off to an operator
outside that stack.

Shared state needs its own application-level concurrency controls. One session's
atomic exclusive lock must exclude another session using the same account. Retain
uncertain-operation markers, never steal live locks, and do not sign out a shared
identity while another session uses it. The grant does not approve application
mutations, account privileges, paid operations or access to production.

After installation, verify from two fresh sessions in the intended workspace that
they see the same runtime lock/cache, can write that leaf, and still cannot write
the containing credential files. Verify another workspace cannot write the leaf.
Then run the application's normal login, cached-session reuse and expired-session
renewal checks. Unit tests and constructed mount arguments alone do not prove
those live acceptance checks passed.

The independent review bootstrap treats configured shared directories as
session-writable and therefore untrusted locations for its executable or policy.
Store the reviewer installation outside all session-writable roots.
