# Codex Assumption Probes

Run `pnpm probe:codex-assumptions` on a Linux machine with an installed standalone `codex`, Node 24,
the repository dependencies, Git, `/bin/sh`, Bash, curl and Python 3. Set `CODEX_BIN` to test another
installed executable. This is an operator maintenance command, independent of provider discovery
and launch eligibility. It never changes permission profiles, withheld hardening, or trust ranges.
Hosted CI runs fixture tests only; it must not run the real probe suite.

The command measures the installed CLI version, executes every safe probe sequentially, and writes
`latest.json` and `latest.md` atomically under `$XDG_STATE_HOME/wollipog-codex-probes` (default
`$HOME/.local/state/wollipog-codex-probes`). `--report-dir PATH` selects an explicit destination.
An incomplete report replaces any previous green report before long-running work begins.
Every assumption records its name, observed behavior and documentation holding the old measurement.

Exit 0 means every required measurement matched. Exit 1 means an assumption changed. Exit 2 means a
probe **could not run**, including missing/incompatible binaries, missing dependencies, sandbox
restrictions, timeouts or incomplete results. A mixed run retains each individual result and fails
overall; it never converts an environment failure to a behavior measurement. Optional diagnostic
drift is advisory, explicitly identified, and cannot become a provider-launch requirement or
evidence of successful WebSocket traffic. The CLI version is checked again at the end; an upgrade
during measurement invalidates the run.

## Probe Inventory and Support Matrix

| Command / Assumption | Required Environment | Last Measurement / Source |
| --- | --- | --- |
| `check:codex-schema`: required app-server RPC contract | Schema generation; no model or shell sandbox | 0.163.0 passed, 2026-10-25. Curated contract in `apps/runner/src/discovery/fixtures/codex-app-server-required-contract.json`, floor 0.147.0; `docs/DRIVERS.md`. |
| `probe:codex-escalation`: permission-profile deny, approved network and denied-directory controls | Native Linux with working Codex sandbox; curl; local HTTP servers | Old network-loss measurement: 0.155.1, ADR 0012, “A deny entry disables approved network escalation.” This session's 0.163.0 host **could not run** the sandbox control (unprivileged namespaces unavailable); no new escalation claim. |
| `probe:codex-guard-hook`: exec, interactive TUI, structured app-server, hook inventory, hash trust, foreign trust gate, inline `hooks.state` disables and trust readback | POSIX shell, Bash, Git, Python PTY; local scripted provider | Full previous matrix: 0.155.1, 0.157.0, 0.158.0, 0.159.0, 0.159.2, 0.160.0, 0.162.1 and 0.163.0, ADR 0012 / PR #3665. Expanded measurements below. |
| Guard `apply_patch` freeform and function-call wire forms | Fixture catalog (`gpt-5.4` before 0.158, `gpt-6-sol` for 0.158–0.159, `gpt-6.1-sol` thereafter); local scripted provider, no authenticated model | All eight installed trusted releases above passed the new patch cases: freeform edits normalize to `tool_input.command`, allow creates a file and deny prevents it; function-call `{input: patch}` is rejected before hook dispatch (`aborted` or `unsupported call: apply_patch`) with no write. Function-call is an executable negative control, not claimed supported editing. A fixture catalog that cannot expose apply_patch reports **could not run**. The old ADR measured freeform only. |
| `probe:codex-mcp-wait`: injected session entry, long wait without intervening model/Guardian requests; Orchestrator entry and approval/default-timeout controls | Local stdio MCP stub and scripted Responses server | 0.163.0 passed the 1,860-second session wait with two model requests total, zero during the wait, zero Guardian/client approvals, 2026-10-25; short approved/unapproved/default-limit cases passed for both entry kinds. Old default-timeout measurement: 0.162.1, `docs/DRIVERS.md` and `skills/using-wollipog/SKILL.md`. Suite also performs 310-second Orchestrator approved/unapproved waits and a default-limit control expected to stop at 300 seconds. |
| `probe:codex-diagnostics`: optional `modelProvider`, `config/read` transport fields, `warning.message` fallback payload | Local RPC and scripted HTTP/WebSocket-rejection server; no sandbox needed | 0.147.0, 0.160.0 and 0.163.0 passed all three live isolated shape checks, 2026-10-25. Historical source/configuration fixtures: `docs/DRIVERS.md`, “OpenAI Inference Transport”. Missing/renamed optional fields report optional drift with sanitized unknown/unverified classifications. |
| `probe:codex-inference-transport` | Real file-backed account authentication and external model traffic | **Excluded**, including its `--force-http-fallback` variant. It cannot satisfy this suite's account-isolation contract. This suite never reads its authentication source or invokes it. Optional diagnostics do not replace its real-traffic evidence. |

The full suite normally takes about 47 minutes, chiefly waiting on the MCP stub; it makes no paid
model requests. Each probe has a finite deadline and bounded output. The service has a 160-minute
outer limit for slow/failing cases. A CLI lacking a working Linux sandbox can still measure schema,
guard and diagnostic contracts, but its overall result remains **could not run**.

The guard probe runs even when the CLI lies outside `CODEX_GUARD_TRUST_VERSION_RANGE`. A passing
matrix outside the production range reports **measured OK, range can be widened**; a failing one
reports **changed** or **could not run**. The suite imports the production range and predicate and
never silently skips new versions or widens the range. Review the measured evidence before changing
the range in `apps/runner/src/codex-managed-worktree-guard.ts`.

If all approved profile escalation variants retain network access while the directory-denial,
ordinary-network and approval-refusal controls still hold, the escalation report explicitly names
the **provider-mode permission-profile deny withheld by #1336** as re-enablable through a reviewed
code change. It still exits nonzero because the old recorded behavior changed. No hardening is
automatically restored.

## Account Isolation and Cleanup Limits

All safe probes use newly created HOME, CODEX_HOME and XDG directories, an allowlisted environment,
disabled host Git configuration and scripted loopback Responses providers. Shell fixture commands
use a non-login `/bin/sh`. No provider account home, credential, real model, or external endpoint
is used. The schema probe also runs in a throwaway working directory. Do not substitute an
authenticated wrapper for the standalone binary.

Probe-owned child groups are killed on completion and cancellation; the PTY helper tears down its
own child group. The systemd service additionally owns the whole cgroup and removes descendants
on service termination. **Residual measurement limit from #1488:** the standalone guard probe does
not prove ownership/absence of detached Codex daemons or deliberately seed daemon reuse to verify
fresh configuration. Its existing default-daemon TUI matrix remains useful but does not establish
those stronger lifetime properties. A race-free daemon attribution/reuse test is not a cheap
addition to this maintenance slice; never scan or kill unrelated Codex/provider processes.

## Automatic Visibility on the Dogfood Host

The approved design is a dedicated daily systemd user timer, not a background job inside the
runner. GitHub had no registered self-hosted runners at preflight; existing hosted schedules do
not have Codex. Runner state/provider-home doctors do not execute CLI maintenance probes.

The timer runs at 15:00 UTC with up to 15 minutes jitter and catches a missed run after downtime.
**Changed and could-not-run both fail the service** and appear in `systemctl --user --failed` and
the journal without opening a report. The fixed timer-report paths are:

- `$HOME/.local/state/wollipog-codex-probes/latest.json`
- `$HOME/.local/state/wollipog-codex-probes/latest.md`

From the dedicated checkout, this one-line check fails for a missing, incomplete or stale report
(older than 48 hours, about two timer periods), and also returns the last complete run's failure:

```sh
pnpm probe:codex-assumptions --check-fresh --report-dir "$HOME/.local/state/wollipog-codex-probes"
```

Inspect failed status and concise classifications without reading files:

```sh
systemctl --user --failed
journalctl --user -u wollipog-codex-probes.service -n 80 --no-pager
systemctl --user list-timers wollipog-codex-probes.timer
```

## Operator Activation Handoff

These commands are for a human terminal or an operator proven outside the hosting stack. This
implementation session does not install/activate units, update the installation, or restart any
hosting component. The dedicated checkout must never be the hosting stack checkout. Update it
deliberately when adopting later probe code; the timer itself never fetches or modifies Git refs.

```sh
git clone https://github.com/picoduck/wollipog.git "$HOME/wollipog-codex-probes"
cd "$HOME/wollipog-codex-probes"
pnpm install --frozen-lockfile
install -Dm644 scripts/systemd/wollipog-codex-probes.service "$HOME/.config/systemd/user/wollipog-codex-probes.service"
install -Dm644 scripts/systemd/wollipog-codex-probes.timer "$HOME/.config/systemd/user/wollipog-codex-probes.timer"
mkdir -p "$HOME/.config/systemd/user/wollipog-codex-probes.service.d"
```

Before activation, create `~/.config/systemd/user/wollipog-codex-probes.service.d/override.conf`
with the actual standalone executable/toolchain paths (the template contains no secrets):

```ini
[Service]
Environment="PATH=/absolute/node/bin:/absolute/codex/bin:/usr/local/bin:/usr/bin:/bin"
Environment="CODEX_BIN=/absolute/codex/bin/codex"
ExecStart=
ExecStart=/absolute/node/bin/node --import tsx scripts/codex-assumptions.mjs --report-dir %h/.local/state/wollipog-codex-probes
```

Then activate and verify the dedicated units only:

```sh
systemctl --user daemon-reload
systemctl --user enable --now wollipog-codex-probes.timer
systemctl --user start --no-block wollipog-codex-probes.service
systemctl --user list-timers wollipog-codex-probes.timer
journalctl --user -u wollipog-codex-probes.service -f
```

The first measurement may take about 47 minutes. A failed sandbox capability check still permits
the independent probes to finish and produces an overall failing report. Unit activation is an
operator handoff, not an installation change performed by the hosted implementation agent.
