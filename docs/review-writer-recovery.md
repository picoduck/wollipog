# Review Writer Recovery

Reviewer admission uses static installation trust, available tools and the native agent catalog.
It never reads writer records, session statuses, worktree leases or launch generations. Existing
records under `unprotected-agent-writers` are ignored for admission after upgrade, including
legacy, malformed, previous-runner and uncertain records. No manual cleanup is required after a
runner restart or host reboot. Running Orchestrators, Agent TUIs and unsandboxed sessions do not
change admission. Unsandboxed processes already have host-user access to the runner itself.

Every native bubblewrap and Seatbelt launch protects configured Codex package trees and the
resolved reviewer executable, symlink-container and interpreter installation directories. Linux
places read-only mounts after writable grants; macOS denies writes and pins ancestors against
renaming. An unverifiable installation fails the launch with its path. Missing package trees
beneath writable roots are created empty and protected before launch, so a sandbox cannot plant
a future installation. Other session-writable executable locations remain refused at admission.

Both review sessions and the older bridge accept the conventional
`~/.codex/packages/standalone` installation based on that launch invariant. Trust still rejects
other-user ownership, session-writable locations outside that exception, world-writable paths
and shared writable groups. A writable user-private group is accepted only when the system
passwd/group database proves the owning user's primary gid and no other primary or supplementary
members. Environment variables supply no identity evidence. Unknown or remote NSS sources fail
closed with the source named. `files` and local `systemd` sources are supported; a listed `sss`
source is non-contributing only when SSSD configuration, fragments, sockets and processes are
provably absent. Unreadable evidence refuses the exception.

The writer registry and `--state-doctor review-writers` remain **non-blocking diagnostics**.
Retaining them avoids coupling this admission change to process-tree containment and shutdown
cleanup. Their exact proof rules still apply to retiring a diagnostic record, but neither a
retained record nor a failed cleanup blocks any reviewer. Admission does not reconcile them.
Codex reviews may still record the existing informational snapshot of known host-access sessions.

## Optional Legacy Diagnostic Cleanup

These commands are local OS-owner maintenance, not agent RPCs. An operator outside the hosting
stack must perform the stop; a session hosted by that stack must never stop or restart it.
Run recovery as the OS user who owns the runner data directory. `sudo` or another user is refused
because scanning a different user's processes would not prove the original writer tree gone.

1. Stop the runner cleanly and wait for its provider processes to exit. Its bwrap providers normally
   exit with it. The state doctor takes the same exclusive data-directory maintenance lease as
   other offline doctor operations. It refuses an active or unrecovered runner lease; follow the
   existing runner lease recovery procedure rather than deleting the lock to bypass ownership.
2. Inspect the retained records using the runner executable (or the source equivalent
   `pnpm runner --state-doctor …`):

   ```sh
   wollipog-runner --state-doctor review-writers inspect --data-dir <runner-data-dir>
   ```

   Inspection does not retire records. It returns each record's `recordId` and exact `sha256`.
3. For each uncontained legacy record with valid recorded process identity, request exact proof:

   ```sh
   wollipog-runner --state-doctor review-writers retire-legacy \
     --data-dir <runner-data-dir> --record-id <recordId> --sha256 <sha256>
   ```

   The command checks boot identity and the recorded runner PID's kernel start time. On the same
   boot, the recorded runner must be gone and a stable scan must find no same-user marked process
   or uninspectable potentially related process. It rechecks runner identity and the exact record
   digest before removing only that record. A different boot provides an explicit reboot proof.
   Changed bytes, malformed or missing identity, an unreadable process table, surviving marked
   processes, or uncertainty retain the record. There is no force flag, age threshold or
   cgroup-name exemption, and the command never kills anything.
4. A refusal emits a JSON reason and every observed blocking PID, its start time and command name
   when verifiable, and `marked` or `uninspectable`. Missing diagnostic fields mean the identity
   could not be read or changed; PID `-1` in the scan summary means the process table never settled.
   End the listed live processes or restore inspection access, inspect again, and retry with the
   unchanged digest. A later SSH login can still block proof even when no provider remains.
   Zombies count as exited and unreadable processes that started before the recorded runner are
   excluded; surviving live descendants are inspected independently. Unknown/malformed records
   require independent operator investigation and are not deletable through this proof command.
5. After successful retirement, start the runner normally. This cleanup is optional and does not
   change reviewer admission. Hand-deleting writer JSON files is not the recovery procedure.

These commands retire diagnostic records only. A refusal here does not prevent a review.

## Diagnostics

The runner emits `review_writer_recovery` JSON events when startup reconciliation changes a
record's outcome. `recordId` and `sessionId` identify the diagnostic record; `outcome` and `reason`
distinguish retirement from retained evidence. These events are not admission refusals. An
unchanged outcome is not repeatedly logged. Paths, inherited markers and process environments
are not logged. Review capability diagnostics instead report missing tools, agents or untrusted
installation paths, with bounded reasons that preserve the other reviewer.

The optional release-digest pin is not implemented. Static trust does not detect tampering that
predates installation protection or writes by processes with unsandboxed host-user access.
