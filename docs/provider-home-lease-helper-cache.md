# Provider-HOME Lease Helper Storage

The runner uses an already distributed POSIX executable or fixed Windows managed bytes.
Starting a runner, private lease worker or native transaction never compiles, downloads or extracts
a lease helper. The helper-specific runtime storage budget is **zero new entries and zero logical
disk bytes**, including named files, anonymous compiler outputs and intermediate artifacts.
Canonical provider-HOME journals, guards, checkpoints and their existing recovery protocol are
separate evidence; this change does not delete, migrate or reset them.

POSIX releases contain the runner, `wollipog-provider-home-lease-io-<target>` and
`wollipog-runner-lease-contract-<target>.json`. Windows releases contain the runner and association;
the managed image is inside independently built code. The closed `WPLR1` association binds the
finished runner digest to its `WPLI1` helper tuple: native target, `WPLL4`, exact source revision,
ABI, byte length and SHA-256. Canonical and legacy runner names retain identical executable bytes.
Missing or mismatched inputs refuse before lease publication; there is no compiler or old-cache
fallback. Historical quota-unaware releases do not gain this contract by adoption.

## Installation Limits

All cooperating POSIX publishers sharing one unchanged protected physical installation parent
reserve the same eight names, `wollipog-lease-helper-00` through `wollipog-lease-helper-07`, by exclusive
directory creation. Admission never reads a separate allowance and then creates a random slot.
Each position has an image of at most 2 MiB and a closed record of at most 16 KiB. Source builds
also have two fixed read-only source records, each at most 16 KiB. The conservative budget is
**34 new entries and 16,941,056 new logical bytes**, including reserved directory/control capacity,
partial publications, failed producers, retained uncertainty and live versions. The current
publisher emits two files per completed position and no FIFO. No successful or incomplete
position is rewritten, resumed, deleted or automatically retired. Windows has no helper-file
installation producer or source selection records.

The byte pump rejects an excessive chunk before writing it, accepts chunks of at most 64 KiB,
and has a monotonic, cooperative 30-second producer deadline and a finite chunk count. Closed associations are at
most 16 KiB. The fixed Windows image is at most 64 KiB; built source checks canonical encoding
and computed decoded size before allocation, then verifies digest and tuple before native loading.
The actual private worker input remains at most 1 MiB. Native probes retain their 10-second limit;
the existing transaction, fencing, request and heartbeat limits remain unchanged.

Offline compilers and package builders run explicitly in their build workspace. Their final output
sizes are admission observations, **not** quotas on earlier compiler assembly, object, linker or
anonymous writes. They are not runner/helper runtime producers. Generic runner executable downloads,
OS application-version storage and their interrupted staging are separate lifetimes.

## Identity and Preservation

POSIX lookup visits only eight fixed names and at most 256 protected ancestry components. It
checks owner, directory identity, completed layout and immutable single-link file identity through
held reads, before and after content verification. An installed record cannot replace the runner's
independently expected tuple. Source records are explicitly published trusted source/build inputs;
they are not seals adopted from arbitrary crash directories. Windows source uses fixed code literals,
and SEA uses a build-admitted image; mutable helper paths never select a DLL.

Foreign, live, linked, substituted, unreadable, unknown and incomplete evidence stays in place.
An inventory that exceeds its small bound, an unproved parent or an exhausted set refuses with
an inspection instruction. A dead PID, filename, matching hash or elapsed timeout never authorizes
stale deletion. Normal verified cleanup of historical runtime-owned staging remains unchanged.
New immutable installed inputs survive normal exits and crashes because concurrent versions can
still need them. No liveness inference is required to delete a new cache artifact: none is created
or automatically deleted.

The guarantee covers new helper growth by cooperating upgraded publishers under the same protected
physical parent. Preexisting unknown bytes, quota-unaware old writers, operator-changed roots and
arbitrary replacement of trusted source/program code are outside that guarantee. Aliasing a parent
does not create another allowance for the same physical positions. This is not a machine-wide disk
quota or a general asset-authenticity guarantee. POSIX pathname checks are not an atomic exec-by-inode
primitive; arbitrary trusted-account replacement of code lies outside the existing trust boundary.

## Producer Bound and Acceptance

The bound follows from exclusive admission and checks before effects, not from a final-size sample.
Only eight fixed position directories may be exclusively created. Each has one exclusive image
writer capped at 2,097,152 bytes and one exclusive closed contract capped at 16,384 bytes. Two
exclusive source records are capped at 16,384 bytes each. Thus regular-file logical body growth is
at most `8 * (2097152 + 16384) + 2 * 16384 = 16941056` bytes. The 26 named positions/files fit
within the conservative 34-entry allowance. Filesystem block allocation and directory metadata
are not a measured physical disk quota. A crash retains its occupied name and partial body, so a
new producer cannot reclaim that charge; simultaneous producers contend on the same fixed names.
No completed/partial position is rewritten or automatically removed. Monotonic checks are cooperative:
blocked system calls and process termination are not an independent whole-lifetime time proof.

CI must pass the real process-death phases, 32-process concurrent admission, excess/stalled input,
identity/refusal/exhaustion and immutable source-record cases. The unchanged four-OS job also runs
native canonical lease tests, raw-source refusal, and actual built-source and SEA daemons with
native owner-death recovery and exact graceful release. Windows native unit fixtures receive the
same offline managed-image inputs in a separate source test product; original raw TypeScript stays
unmodified and must refuse. These fixtures do not authorize production adoption of mutable records.
CI success is required evidence, not by itself proof of physical quotas, all future lifetimes or
legacy artifact closure. Failed/unproved old opportunities and evidence retain their original status.

CI prepares the protected default `apps/runner/dist-bin` before unit tests and Chromium's live
runner specs, and exports the same path for worker delivery fixtures. The live question spec's
`hermeticEnv` strips `RUNNER_*` and `CONTROL_PLANE_*`, so it retains that locator. The relay and
policy-hook re-registration unit integrations also strip `WOLLIPOG_*`; their real source runners
therefore use the already-prepared default path, with the same tuple/identity checks. Other native
lease child fixtures inherit the environment, or explicitly select their own prepared immutable
input. This is offline test setup, not a compiler fallback inside a runner or worker.
WebKit currently selects only `number-fields.spec.ts` through `playwright.webkit.config.ts`, with
the static Vite harness; it has no live provider-HOME consumer and needs no helper producer step.
If WebKit later opts into a real-runner spec, its setup must be reviewed again.

## Source and Recovery

Linux/macOS source execution requires explicit offline preparation:

```sh
node apps/runner/scripts/prepare-lease-helper-assets.mjs
```

Use `WOLLIPOG_LEASE_HELPER_ROOT` only to select an existing protected build/installation parent;
it cannot alter the tuple, budgets or deletion authority. Do not point it into canonical provider-HOME
lease evidence or service trees that are recursively removed/chowned. Missing source inputs refuse
with a preparation instruction rather than building during startup.

Windows raw TypeScript/tsx execution refuses lease I/O before mutable metadata lookup or native
loading. Explicitly build `node apps/runner/scripts/build-binary.mjs`, then run the source product
with `node apps/runner/.bin-build/cli.cjs`. It contains the actual daemon and actual private
worker with the same admitted managed bytes as the SEA. No PowerShell 7, runtime SDK or new
credentials are required. Native Windows PowerShell 5, actual loaded CLR architecture and the exact
Framework reference/ABI contract are checked; timeouts remain refusals, not compatibility proof.

If eight positions or two source records are occupied, preserve them and inspect their ownership,
live consumers and provenance. Do not reset the pool, delete by glob/PID, chmod an unknown artifact
or substitute a new root to claim the old storage has been bounded. Changing the operator's
installation root creates a different documented guarantee domain.
