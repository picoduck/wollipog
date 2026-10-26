# Review Writer Recovery

Codex reviewer admission retains an obligation for each unprotected provider or Agent TUI writer.
The refusal lists every retaining session and record, whether it belongs to the current runner,
a previous runner, or has unknown identity, and its recovery step. A properly protected unrelated
session is not blamed for a record merely because its UUID sorts first.

On native Linux with delegated cgroup v2, each new writer has its own parent beneath the existing
provider cgroup subtree. Provider launches, asynchronous preparation probes, ACP terminals and
Agent TUIs run in child leaves. The record stores the parent's boot, mount root, path and inode,
plus the enclosing delegated unit identity when available. Successful live tree settlement retires
the record only if the parent is empty. A later runner automatically retires it after proving the
recorded runner gone and the exact parent empty, or the recorded enclosing unit removed. A reboot
also proves contained processes gone. Unrelated unreadable processes do not participate in this
proof. The parent stays present until its record is retired, including interrupted launches.

Run the runner in an operator-configured `Delegate=yes` unit for future boundary recovery. The
runner never creates systemd scopes or moves itself into another delegation. Without delegation,
or on macOS/WSL, it preserves conservative process-tree proof and records why containment is
unavailable. Restart and age never clear uncontained legacy evidence automatically. Deliberate
same-user migration out of a cgroup is outside this lifecycle proof's threat model.

## Legacy Records

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
5. After successful retirement, start the runner normally and retry the review. Hand-deleting
   writer JSON files is not the recovery procedure.

These commands do not alter the policy that unprotected writers block reviewer admission.

## Diagnostics

The runner emits `review_writer_recovery` JSON events when a recovered record's outcome changes.
`recordId` and `sessionId` correlate the event with the refusal; `entryPoint` distinguishes startup
from admission-time retry, and `outcome`/`reason` distinguish retirement, a populated or unverifiable
boundary, a live recorded runner, and unavailable legacy boundary evidence. Unchanged refusals do
not emit repeated events. Paths, inherited markers, and process environments are not logged.
