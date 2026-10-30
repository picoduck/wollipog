# Pi Assumption Probes

`pnpm probe:pi-assumptions` re-measures the Pi behavior the Pi driver
(`apps/runner/src/drivers/pi-rpc.ts`) and Pi discovery (`apps/runner/src/discovery/pi-rpc.ts`)
depend on, against an installed `@earendil-works/pi-coding-agent`. It is an operator maintenance
command: it never changes discovery, launch eligibility, a version pin, a trust range or any
hardening. A changed result needs a reviewed code change.

Run it on Linux with Node 24, the repository dependencies, an installed `pi` (or set `PI_BIN` to the
executable), and one way to create a network namespace: bubblewrap with user namespaces, unprivileged
`unshare -rn`, or passwordless `sudo` with `unshare`, `ip` and `setpriv`. Install Pi into a scratch
prefix rather than using an account's own installation:

```sh
npm install --prefix "$SCRATCH" --userconfig /dev/null --ignore-scripts @earendil-works/pi-coding-agent@latest
PI_BIN="$SCRATCH/node_modules/.bin/pi" pnpm probe:pi-assumptions --report-dir "$REPORT_DIR"
```

## Report and Exit Contract

The suite follows the [Codex Assumption Probes](codex-assumption-probes.md) contract and reuses its
`reportExit` and `reportFresh` functions:

- **Exit 0** means every assumption matched.
- **Exit 1** means an assumption changed, including runs mixed with other failures.
- **Exit 2** means a probe **could not run**: missing or incompatible binary, no verified network
  isolation, a timeout, a dependency failure, malformed or incomplete output, or a Pi version that
  changed during the run. It never becomes a passing measurement.

`latest.json` and `latest.md` are written atomically under `$XDG_STATE_HOME/wollipog-pi-probes`
(default `$HOME/.local/state/wollipog-pi-probes`), or under `--report-dir PATH`. An incomplete report
replaces the previous one before any probe starts. `--check-fresh` fails for a missing, incomplete or
stale report (older than 48 hours) and otherwise returns the last complete run's exit code. The
report names the measured version, the baseline version (1.4.0), the isolation mechanism and every
assumption with its observed behavior and the source that holds the old measurement. Pi's stderr is
never persisted.

Each probe group runs in its own process. A group whose output is missing, malformed, below its
assumption count or inconsistent with its exit code is recorded as could not run. `pi --version` is
read before and after the run; a difference marks every result could not run.

## Network Isolation

Every group runs inside a fresh network namespace with loopback up. The suite tries, in order:

1. `bwrap --unshare-net`, which configures loopback itself. Hosted CI uses this, because the suite
   runs there as an unprivileged user without sudo.
   `scripts/harness-assumptions-prepare-pi.sh` installs bubblewrap and grants it user namespaces
   through `scripts/configure-ci-bubblewrap.sh`, as the Codex preparation does.
2. `unshare -rn`, followed by `ip link set lo up`.
3. `sudo -n unshare -n`, which brings loopback up and then drops back to the invoking user with
   `setpriv` before running anything else.

A launcher is used only if the probe's own negative control passes inside it, and every group
repeats that control before starting Pi:

- the network namespace differs from the suite's own;
- `/proc/net/dev` lists only `lo`;
- a TCP connect to TEST-NET `192.0.2.1:9` fails at once with `ENETUNREACH`/`EHOSTUNREACH`;
- a DNS lookup of `example.com` fails;
- loopback still accepts connections.

The TEST-NET and DNS controls run only after the namespace and interface checks pass, so no control
traffic is sent from the host's own namespace.

Inside the namespace, every Pi process also preloads `apps/runner/scripts/pi-net-observer.mjs`. It
records each Node socket, DNS lookup and UDP send, and refuses any that is not loopback. **The
observer is not isolation**: it cannot see non-Node children. It is used to measure whether Pi
attempts network, for the `PI_OFFLINE` assumption, and as a second line of defense.

When no launcher verifies, the three network assumptions report **could not run**, so the run exits
1 or 2. The other groups still run, with only the observer and `PI_OFFLINE=1` between Pi and the
network, so the report stays informative on hosts without namespaces. Help text is never accepted as
a measurement.

## Account Isolation

Every Pi launch gets a new HOME, agent directory, XDG directories and project directory under the
system temporary directory, and they are removed afterwards. Probes build the environment from
scratch, so no provider credential, endpoint or account configuration reaches Pi. Host Git
configuration is disabled. The only model is `probe/probe-model`: an OpenAI-compatible
chat-completions server on `127.0.0.1`, configured through the throwaway `models.json` with the dummy
key `scripted-local-provider`. The `PI_OFFLINE` control adds a dummy `ANTHROPIC_API_KEY` that exists
only in that throwaway environment and that run, and only inside the verified namespace. No probe
reads `~/.pi` or makes a paid or real model call. Pi creates `auth.json`, `models-store.json` and,
when trust is remembered, `trust.json` in the throwaway agent directory; these are observations, not
credentials.

## Feasibility Result

Pi can run complete RPC turns against a scripted loopback provider in a throwaway HOME. On
2026-10-29, pi 1.4.0 answered `get_state`, accepted `prompt` (`disposition: "started"`), streamed
`agent_start` through `agent_settled`, and relayed the scripted reply after exactly one provider
request.

The development host blocks unprivileged user namespaces (`unshare -rn` and `bwrap --unshare-net` both
fail with EPERM), so the namespace measurements there are **could not run**. Two weaker
observations were made on that host:

- `strace -f -e trace=connect,sendto,sendmsg` across the whole Pi process tree recorded exactly one
  `connect()`, to the loopback provider.
- Under the observer, a `fetch` of `https://example.com/` and a TCP connect to `1.1.1.1:443` both
  failed visibly, were logged as refused, and never reached the kernel.

Neither is isolation. The isolated measurement is expected from a host with passwordless `sudo`,
such as a GitHub-hosted runner.

## Baseline: pi 1.4.0

Measured on 2026-10-30 with `@earendil-works/pi-coding-agent` 1.4.0 (npm, published 2026-10-21).
**Changed** marks a result that differs from what the runner assumes today. Each changed result is
reported every run until a reviewed change aligns the runner or the fixture with it.

| Assumption | Probe | Observed on 1.4.0 | Status |
| --- | --- | --- | --- |
| `--mode rpc` speaks LF-framed JSONL with `id`-correlated responses | every group | Holds for every request below. | Unchanged |
| `get_state` | `rpc-contract`, `sessions` | Returns `model`, `thinkingLevel`, `isStreaming`, `sessionId` and `sessionFile`, plus more fields the runner ignores. | Unchanged |
| `get_available_models`, `set_model`, `get_available_thinking_levels` | `rpc-contract` | Models carry `provider`, `id`, `name`, `input`, `contextWindow` and `reasoning`. `set_model` returns the selected model in `data`. Levels are a string array. | Unchanged |
| `get_commands` command catalog | `rpc-contract` | Skills report `source: "skill"`, prompt templates `"prompt"`, extensions `"extension"`. | Unchanged |
| `get_commands` `location` read by `commandSource()` | `rpc-contract` | **Absent.** Pi reports `sourceInfo.scope` (`"user"`, `"project"`, `"temporary"`) instead; its changelog records `location` being replaced by `sourceInfo` in an earlier release. `commandSource()` therefore never reports a project command. | Changed |
| Optional `get_entries`: `entries: []` and `leafId: null` under `--no-session` | `rpc-contract` | **Not empty.** A fresh `--no-session` process already has `model_change` and `thinking_level_change` entries (only `thinking_level_change` with no provider configured), so `leafId` is a string. Discovery therefore stops advertising conversation fork. | Changed |
| `extension_ui_request` / `extension_ui_response` round trip | `rpc-contract` | A tool call raises one nonce-bound `confirm` per call from the runner's Agent Control extension (kind `tool_call`). Answering `confirmed: true` runs the tool and returns its output to the model. | Unchanged |
| `steer` and `abort` during a running turn | `rpc-contract` | With the model request held open, both answer `success: true`, and the run settles with an assistant `message_end` whose `stopReason` is `"aborted"`. | Unchanged |
| `project_trust` reaches the driver as a nonce-bound security `select` that holds startup | `project-trust` | **Not delivered.** Pi dispatches `project_trust` to CLI extensions with `hasUI: false` and a no-op UI in RPC mode (`dist/main.js`: `hasUI` only for interactive mode). The runner extension declines, no `select` reaches the client, `get_state` answers and project resources are skipped. A verified Pi session can never ask to trust a project. | Changed |
| Discovery probe extension sees `project_trust` before `session_start` | `rpc-contract` | Holds, because that extension decides without a UI. | Unchanged |
| A CLI extension's remembered decision | `project-trust` | `{ trusted: "yes", remember: true }` loads `.pi/extensions` and writes the canonical project path to `<agent-dir>/trust.json`; a later launch applies it. | Unchanged |
| `--no-approve` | `project-trust` | Project resources are skipped and `project_trust` is never dispatched. | Unchanged |
| Session store location | `sessions` | `<agent-dir>/sessions/--<cwd with path separators replaced by ->--/<ISO timestamp>_<uuid>.jsonl`; the first line is `{"type":"session","id":<uuid>}`. `<agent-dir>` is `~/.pi/agent`. | Unchanged |
| Project `sessionDir` under `--no-approve` | `sessions` | Ignored; the session stays in the agent directory. Pi's security documentation says a project `sessionDir` is read before trust is resolved, so this is measured rather than assumed. | Unchanged |
| `--session <id>` | `sessions` | Resumes the same id, file and leaf. | Unchanged |
| `--fork <id> --session-id <uuid>` | `sessions` | Creates `<timestamp>_<uuid>.jsonl` beside the source, reports the requested id, and keeps the source leaf for `get_entries` with `since`. | Unchanged |
| `PI_OFFLINE=1` and `--offline` | `network` | Needs the verified namespace, so it is **could not run** on the development host. Observer-only on that host: with a dummy built-in key and no `PI_OFFLINE`, Pi tried `pi.dev:443` three times (catalog refresh); with `PI_OFFLINE=1` it tried nothing. | Pending isolated run |
| ADR 0010: repeated `--append-system-prompt` | `adr-0010` | Both values reach the system prompt in order, separated by one blank line. | Unchanged |
| ADR 0010: `--append-system-prompt=TEXT` | `adr-0010` | Pi exits 1 with `Unknown option: --append-system-prompt`; 0.85.0 handed it to extensions. It still never appends, so the resume strip is unaffected. The probe expects the 1.4.0 refusal. | Unchanged (new baseline) |
| ADR 0010: `-e` under `--no-extensions` | `adr-0010` | The explicit extension loads; the user extension in `<agent-dir>/extensions` and the built-in `llama` and `mcp` extensions do not. | Unchanged |

Pi discovers extension files ending in `.ts` or `.js`, not `.mjs`. The probe's discovered-extension
fixtures use `.js` for that reason.

## Fixture Drift

The `rpc-contract` group drives real Pi and `apps/runner/src/drivers/fixtures/fake-pi-rpc.mjs`
through the same three exchanges:

- **Discovery.**
- **A verified session:** the startup trust request, one turn with `read` and `bash` tool calls, and
  the checkpoint reads.
- **An interrupted turn:** a mid-turn `steer`, then `abort`.

It then requires every record kind, field path, JSON type and selected enum value the fixture emits
to appear in real Pi's records; real-only fields are not drift (`apps/runner/scripts/pi-rpc-shape.ts`).
Any difference reports **changed**. `FIXTURE_SHAPE_EXCEPTIONS` in the probe lists deliberate
exceptions; it is empty.

As in the production `PiRpcPeer`, a malformed stdout record, or stdout ending inside a record, is a
transport failure. Every measurement on that process becomes could not run. A `get_entries` request
that gets no answer within 10 seconds is could not run; an explicit refusal is changed.

On 1.4.0 the comparison reports the three changed driver assumptions above: `location`, a `null`
`leafId`, and the trust `select`. This change aligned the fixture's tool `content` with Pi's array
of text parts, because the driver serializes that field either way and nothing depends on the old
string form.

## Hosted Workflow

[Harness Assumption Probes](harness-assumption-probes.md) runs this suite daily, as the `pi`
harness, against the newest `@earendil-works/pi-coding-agent` release only, because no repository
source pins or gates a Pi version. The suite follows that workflow's shared contract:

- **Report.** `latest.json` names exactly the installed version, sets `complete` and an `exitCode`
  equal to the process exit, and its results use only `unchanged`, `changed` and `could not run`.
- **Environment.** It needs only `PATH`, `HOME`, `TMPDIR`, `LANG`, `CI` and `PI_BIN`. It runs from a
  read-only checkout as the unprivileged probe user, without sudo, and writes only under its report
  directory, `HOME` and `TMPDIR`.
- **Preparation.** `scripts/harness-assumptions-prepare-pi.sh` installs bubblewrap, grants it user
  namespaces and checks `bwrap --unshare-net` before any release code runs. A preparation failure
  makes the run could not run; the probe user's namespace is still verified inside each group.

While the 1.4.0 divergences above stand, every full run exits 1 (changed) and is re-measured the
next day, because only a fully matched measurement is recorded.

To measure Pi on demand, including on a branch before merge:

```sh
gh workflow run harness-assumptions.yml --ref <branch> -f harness=pi
```
