# Harness Assumption Probes

Wollipog drives installed Codex, Claude Code and Pi CLIs and depends on behaviour those CLIs do not
document or promise to keep. Each supported harness therefore has a credential-free probe set that
`.github/workflows/harness-assumptions.yml` re-measures whenever the harness publishes a release.
Results feed reviewed changes only: no probe widens a trust range, moves a version pin or restores
withheld hardening automatically.

| Harness | Probe Set | Targets Each Full Run |
| --- | --- | --- |
| Codex | `pnpm probe:codex-assumptions` ([Codex Assumption Probes](codex-assumption-probes.md)) | Newest `@openai/codex` release and the lower bound of `CODEX_GUARD_TRUST_VERSION_RANGE` |
| Pi | `pnpm probe:pi-assumptions` ([Pi Assumption Probes](pi-assumption-probes.md)) | Newest `@earendil-works/pi-coding-agent` release |

Claude Code (#3797) adds its probe set to the same workflow.

## Workflow

The workflow runs daily at 09:17 UTC (outside 00:00–02:00 UTC) and on manual dispatch, on hosted
`ubuntu-24.04` runners. It has `contents: read` permissions, uses no secrets, checks out without
persisting the job token, and runs in one concurrency group (`harness-assumption-probes`) so runs
never overlap on the shared runner pool; a queued run waits rather than cancelling a measurement.
The job matrix has one entry per harness, and each entry is independent: one harness's release
neither triggers nor skips another harness's suite, and `fail-fast` is off.

Each harness job:

1. **Detect.** Reads the newest stable version from the npm registry's `latest` dist-tag, reads the
   harness's baseline versions from repository source, and hashes the harness's probe sources.
   Detection needs only Node, so a day without a new release costs only checkout and this step.
   If the registry cannot be reached or returns anything other than a stable version of the
   expected package, or a baseline cannot be read, the job reports **could not run** and fails.
   It never treats an unreachable registry as "no new release".
2. **Decide.** Restores the harness's measurement record from the Actions cache under an exact key
   built from every target version and the probe-source hash. Only a record of a fully matched
   measurement of exactly that key skips the suite; the job summary then says that no suite ran
   and links the run that measured it. A missing, evicted, unreadable or mismatched record always
   measures. A manual dispatch measures `all` harnesses, or only the one named in the `harness`
   input (the others still run detection); an unknown name is could not run.
3. **Measure.** Runs the harness's preparation, stages the isolation boundary below, then for
   each target installs the exact version into a disposable prefix with `npm install
   --ignore-scripts` and runs the suite in a minimal environment: a throwaway `HOME`, a private
   `TMPDIR` beside it (outside `/tmp`), `PATH`, `LANG`, `CI` and the binary variable. No job
   token, credential, provider configuration or operator acknowledgement reaches it.
4. **Report.** Writes `latest.json` and `latest.md`, appends `latest.md` to the job summary and
   uploads the report directory as the `harness-assumptions-<harness>` artifact (30 days), on every
   outcome including detection failures.
5. **Record.** Saves the measurement record only when every target matched. A changed or
   could-not-run result is not recorded, so the next scheduled run measures it again and fails
   again until a reviewed change resolves it.

The record lives in the Actions cache because the workflow has no write permission and no secret.
Cache entries are scoped to the branch that saved them and evicted after seven days without use or
under repository cache pressure. Every loss fails safe: an evicted record costs one extra full
measurement, never a skipped one. The key includes a hash of the driver and the harness's declared
probe sources, so changing them re-measures; dispatch the workflow after changing other code the
suite depends on.

### Isolating Unreviewed Releases

A newly published release is code nobody has reviewed, and the hosted runner's own user has
passwordless sudo plus the job's runtime token, which can write Actions cache entries in the
default branch's scope. The driver therefore never runs a release as that user in CI; without
`HARNESS_PROBE_USER` and `HARNESS_PROBE_ROOT` it reports could not run.
`scripts/harness-assumptions-isolate.sh` creates the system user `harness-probe` without sudo,
cron, at or privileged groups, stages a copy of the checkout (`git archive HEAD` plus `pnpm install
--frozen-lockfile`, then `chmod -R go-w`) under `/opt/harness-probe/repo` that the user can read
but not write, and denies the user traversal of the runner's home with an ACL. The hosted tool
cache is writable by every user (the measured Node binary there is mode 777), so the user is also
denied every `/opt` tree other than its own (the tool cache, pipx and other preinstalled tools,
several of them world-writable) and runs a private, unwritable copy of Node placed first on its
`PATH`; any other entry on the runner's `PATH` it could write gets an ACL removing that access. The script verifies each property, including that nothing in the copy, its Node, or any
directory on the runner's `PATH` is writable by the user, and fails closed. Each suite runs through
`sudo -n -u harness-probe -- /usr/bin/env -i ...` from the staged copy; its throwaway home and
report directory are owned by the probe user. After each suite every process of that user is
killed before anything else happens, and its crontab and files in `/tmp`, `/var/tmp` and
`/dev/shm` are removed so nothing carries into the next target. Only a regular file owned by the
probe user named `latest.json` or `latest.md`, under 2 MiB, is read back, and it is read as that
user, so a planted symlink cannot pull another file into the published report. Workflow commands are stopped while suite
output reaches the log. Host preparation and installs, which run no release code, still run as
the runner user.

## Shared Report and Exit Contract

Every harness suite and the workflow driver share one contract:

- **Exit 0, matched**: every required measurement matched its recorded behaviour. Optional drift is
  advisory and never a launch requirement.
- **Exit 1, changed**: at least one assumption changed, including mixed runs with other failures.
- **Exit 2, could not run**: a measurement could not be taken: missing or incompatible binary,
  failed install, network refusal, sandbox restriction, failed host preparation, timeout,
  incomplete output, or a version change during measurement.

Changed and could not run are kept distinct, and both fail the run. Nothing is ever reported as a
false pass. The driver re-validates each suite: it treats the target as could not run unless the
suite exited 0, 1 or 2 within its deadline and wrote a complete `latest.json` whose `version` is
exactly the installed version, whose `exitCode` equals the process exit, and whose non-empty
`results` contain only `unchanged`, `changed`, `could not run` or `optional drift` statuses that
recompute to that same exit. An operator acknowledgement (`acknowledged unavailable`) is never a
CI measurement and also reads as could not run. Across targets, changed wins over could not run;
an unmeasured target or failed preparation is could not run.

A suite's `latest.json` must contain at least:

```json
{ "version": "1.2.3", "complete": true, "exitCode": 0,
  "results": [{ "probe": "id", "status": "unchanged", "observed": "...", "documentation": "..." }] }
```

The suite writes an incomplete report before long-running work, so an interrupted run never leaves
an earlier green report behind. It also writes a human-readable `latest.md`, which the driver embeds
in the harness report. The harness report's `latest.json` lists each target's label, version,
status and reason, the preparation outcome, the event, the run URL and, for a skipped day, the
record that justified the skip.

## Adding a Harness

Supporting a new harness includes adding its probe set here. To add one:

1. Write a suite that measures the behaviour the runner depends on, honours the contract above,
   accepts `--report-dir DIR` (or the flag named in `reportDirArg`), and reads the executable from
   its binary environment variable. Probes must be credential-free: never read a real provider home
   or configuration directory, use throwaway homes created per run and removed afterwards, keep any
   dummy key inside that throwaway environment, and use scripted loopback model servers only.
   Exclude any probe that needs real credentials or a real model, and record why. The suite runs
   as the unprivileged probe user from a read-only checkout, so it must write only under its
   report directory, its `HOME` and `TMPDIR`, and must not need sudo; do host preparation in the
   harness's `prepare` command instead.
2. Add an entry to `HARNESSES` in `scripts/harness-assumptions.mjs`: its npm package and
   executable, binary variable, baseline versions (each read from a repository file), optional
   host preparation, suite command, report flag, per-target timeout, documentation and the probe
   sources that invalidate its record.
3. Add its id to the workflow matrix (`scripts/harness-assumptions.test.mjs` checks that the matrix
   and registry agree), document the probe inventory, and dispatch the workflow on the pull
   request's branch before merge: `gh workflow run harness-assumptions.yml --ref <branch> -f harness=<id>`.
   Note that a dispatch from a branch saves its record only to that branch's cache.

## Local Use

The driver also runs locally for debugging. Set `RUNNER_TEMP` to a scratch directory and run
`node scripts/harness-assumptions.mjs detect --harness codex`, then `decide` and `measure`. Each
suite also runs directly; see its own document.
