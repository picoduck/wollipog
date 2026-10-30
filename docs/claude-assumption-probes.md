# Claude Code Assumption Probes

The runner depends on Claude Code behaviour that is measured rather than documented: the
`PreToolUse` hooks behind the managed worktree guard, how `--settings` arguments combine, the
undocumented stdio control channel, the version floors in `apps/runner/src/discovery/claude-code.ts`,
the transcript layout used for resume, and the release the reviewers pin.
`pnpm probe:claude-assumptions` re-measures all of it against a real `claude` without credentials.

```sh
CLAUDE_BIN=/absolute/path/to/claude pnpm probe:claude-assumptions [--report-dir DIR] [--check-fresh]
```

`CLAUDE_BIN` defaults to `claude` on `PATH` and must be the real executable. Under
`npm install --ignore-scripts`, `node_modules/.bin/claude` is only a placeholder: the native binary is
`node_modules/@anthropic-ai/claude-code-<platform>/claude`. The command needs Linux, Node 24, the
repository dependencies, Bash and `strace`. It is an operator and CI maintenance command, and it
never changes discovery, launch policy, a floor or a pin.

## Report and Exit Contract

The report and exit contract is the one the Codex suite uses
([Codex Assumption Probes](codex-assumption-probes.md)). `latest.json` and `latest.md` are written
atomically to `--report-dir`, or by default to `$XDG_STATE_HOME/wollipog-claude-probes`. An incomplete
report replaces any earlier one before measurement starts.

- **Exit 0:** every assumption matched its recorded behaviour.
- **Exit 1:** at least one assumption **changed**, including mixed runs with other failures.
- **Exit 2:** something **could not run**: a missing or placeholder binary, a missing or blind
  network detector, a timeout, a scripted turn that never completed, incomplete output, an
  interruption, or a version change during the run.

"Changed" and "could not run" stay distinct. A probe that could not measure is never reported as a
pass. Every assumption names its old measurement, and the report also states:

- the measured version;
- each floor, and whether the version meets it;
- the reviewer pin comparison.

`--check-fresh` fails for a missing, incomplete or inconsistent report, or one older than 48 hours.

Each probe is a separate process (`apps/runner/scripts/claude-assumption-probes.ts --probe <id>`)
with its own deadline. The suite runs every probe and checks the CLI version again at the end. A
full run of about 40 assumptions took under two minutes per release on the measuring host, and it
makes no paid model request.

## Feasibility

**Feasible.** Measured on 2026-10-29 and 2026-10-30. Each release below was installed from npm into
its own scratch prefix. The host's signed-in installation and its configuration were never used.

| Release | Role | Result |
| --- | --- | --- |
| 2.1.314 | npm `latest` / `next` (`stable` was 2.1.308) | Text turn and two-request Bash `tool_use` turn completed |
| 2.1.296 | Reviewer pin | Same tool turn completed |
| 2.1.277 | MCP image floor | Same tool turn completed |
| 2.1.241 | Steering floor | Same tool turn completed |
| 2.1.205 | Stdio contract floor | Same tool turn completed |

Every run used an `env -i` environment containing:

- a throwaway `HOME`, `CLAUDE_CONFIG_DIR`, XDG directories and `TMPDIR`;
- `ANTHROPIC_API_KEY` set to a dummy value;
- `ANTHROPIC_BASE_URL` pointing at a scripted loopback Messages API;
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`,
  `DISABLE_ERROR_REPORTING=1`, `DISABLE_BUG_COMMAND=1` and `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`.

**Endpoints contacted.** Only `POST /v1/messages?beta=true` on the loopback stub, once per model
call. No `count_tokens`, models, OAuth, telemetry or update route was requested.

**How "no other outbound calls" was established.** The measuring host refuses unprivileged user
namespaces, so silence was measured with two detectors instead of a network namespace:

1. `strace -f` recorded every `connect`, `sendto` and `sendmsg` from the CLI and all its
   descendants. On 2.1.314 a quiet run made exactly one connect, to the stub's loopback port, and no
   DNS lookup. 2.1.205 and 2.1.241 also tried the local `/var/run/nscd/socket` user-lookup socket,
   which is not network traffic.
2. A refusing, logging proxy was set as `HTTP(S)_PROXY`, with `NO_PROXY=127.0.0.1`. It received
   nothing.

**Positive control.** The same prompt with the disable variables removed produced five
`CONNECT api.anthropic.com:443` attempts. Both detectors saw them and the proxy refused them, and
the CLI then wrote `telemetry/1p_failed_events.*` into the throwaway config directory. So the
detectors do see outbound attempts, and the quiet result is a measured zero.

**Model id matters for `auto`.** With `--model claude-sonnet-4-5` the CLI silently started in
`default` when asked for `auto`. With `claude-sonnet-4-6`, `claude-opus-4-6` or `opus` it started in
`auto`. The probes use `claude-sonnet-4-6` and check the mode the init event reports; a different
mode is "could not run".

**The flagless default differs on 2.1.296.** The driver launches `default` without a
`--permission-mode` flag. With an auto-capable model and no flag, 2.1.296 started in `auto`, while
2.1.277 and 2.1.314 started in `default`. With `claude-sonnet-4-5` all three started in `default`, and
an explicit `--permission-mode default` started `default` on all three. On 2.1.296 a runner's
`default` (ask) session can therefore run under the auto classifier. The `control-channel` probe
reports this as changed, and it names the mode explicitly for its envelope cases so the envelope is
still measured. Help lists `manual`, not `default`, among the choices in every measured release,
yet `default` is accepted.

**Throwaway leftovers (observation only).** A quiet turn leaves these in the config directory:

- `.claude.json`;
- `backups/.claude.json.backup.<n>`;
- `plugins/store/cc-plugin-agents-md_builtin-*.json`;
- the session transcript.

It also leaves a file-watch probe under `TMPDIR`. Names are recorded and contents are never read.
Nothing outside the throwaway directories is read.

## How the Suite Stays Credential-Free

- **No real environment.** Every CLI environment is built from an allowlist and never inherits
  `process.env`. Provider keys, `ANTHROPIC_BASE_URL`, OAuth tokens, a real `CLAUDE_CONFIG_DIR`,
  `NODE_OPTIONS` and hosting-session variables never reach it. The dummy key exists only there.
- **Fresh homes per case.** Each case gets a new `HOME`, `CLAUDE_CONFIG_DIR` (deliberately not
  `HOME/.claude`, so a write that ignores it is visible), XDG tree, `TMPDIR` and working directory.
  All of them are removed afterwards.
- **No model.** The model is a scripted loopback server. Its replies depend only on the conversation
  it receives. Side requests get a plain reply. Auto-mode classifier requests are answered "allow".
  A route it was not scripted for answers 404 and is still recorded. A case counts only when the
  CLI exits 0 with a non-error `success` result and every scripted conversation reached its final
  answer.
- **Network silence is measured.** It is measured in every probe process.
  - Before measuring, a traced shell must be seen connecting to a closed loopback port. A host
    without a working `strace`, or a detector that misses the canary, makes every silence
    assumption **could not run**.
  - The `isolation` probe repeats the canary through the CLI's own Bash tool. This proves the
    tracer follows the CLI's process tree.
  - Any traced destination other than the stub, any proxy request, or any stub route other than
    `POST /v1/messages` reports **changed**.

## Probe Inventory

| Probe | Assumptions | Old Measurement |
| --- | --- | --- |
| `isolation` | Detector positive control through the CLI's Bash tool; a quiet turn contacts only `POST /v1/messages` and never names the real `HOME`; throwaway leftovers (observation) | Feasibility above |
| `hooks` | A `PreToolUse` hook supplied by inline `--settings` with the runner's `MANAGED_WORKTREE_GUARD_MATCHER` fires once per Bash call, with `tool_name`, `tool_input.command`, an absolute `cwd`, `permission_mode` and `hook_event_name`, in `auto`, `acceptEdits` and `bypassPermissions`. Allowed calls run. A JSON `deny` blocks the call, and so does exit 2. Either way the reason reaches the model. A subagent's call is covered too and carries `agent_id` and `agent_type`. | ADR 0012, 2.1.270 and 2.1.277 |
| `settings` | Inline JSON `--settings` is accepted; of two `--settings` (file/file, file/inline, inline/file) only the last applies | ADR 0012, 2.1.270 and 2.1.278 |
| `control-channel` | The driver's flagless `default` launch (`claudePermissionArgs("default")` passes no `--permission-mode`) starts the CLI in `default`. With those arguments plus an explicit `--permission-mode default`, and the driver's stream-json prompt, a Bash call produces exactly one `can_use_tool` frame. Its envelope is exactly `{type, request_id, request}`. The frame carries the issued command and `tool_use_id`, and has no `cwd` or `parent_tool_use_id`. Only a subagent's frame carries `request.agent_id`, and any `blocked_path` is absolute. Allow and deny responses shaped like `resolvePermission`'s are honoured. Request keys are compared with the recorded fixture and reported. | `claude-can-use-tool-subagent.json` (2.1.277); ADR 0012 |
| `mcp-image` | An MCP tool's image result reaches the next model request, checked at the stub, from `CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION`. Below that floor it is an observation. | `discovery/claude-code.ts` (2.1.277 to 2.1.281, real model) |
| `steering` | A stream-json user message written mid-turn with a `uuid` is replayed (`isReplay`) and reaches the model, from `CLAUDE_STEERING_MIN_VERSION`. Below that floor it is an observation. | `discovery/claude-code.ts`; driver `steer()` |
| `transcript` | The transcript is `CLAUDE_CONFIG_DIR/projects/<claudeProjectPathKey(cwd)>/<session-id>.jsonl`, `HOME/.claude` stays untouched, and `--resume` in a new process carries the earlier turn | `docs/DRIVERS.md`; `claude-background-work.ts` |
| `discovery` | The runner's own `probeClaudeCode` reads the version and help. It finds stream-json input and the `acceptEdits`, `auto`, `bypassPermissions` and `plan` modes. It attests the control contract, steering and MCP image results exactly from their floors. | `discovery/claude-code.ts` |
| `reviewer-pin` | Every flag the media reviewer requires is present. Under the production media reviewer arguments and environment, the events before the startup init match the pin's baseline, and init, scoped tool use and priced usage pass `ClaudeMediaReviewerStream`. | `claude-media-reviewer.ts` (2.1.296) |

Probes import the production code they rest on (`claudePermissionArgs`, `buildClaudeUserMessage`,
the guard matcher, `claudeProjectPathKey`, discovery, the reviewer arguments, environment and
stream parser) rather than copying it, so a change on either side is measured.

### Floors

The floors are `CLAUDE_CONTROL_CONTRACT_MIN_VERSION` (2.1.205), `CLAUDE_STEERING_MIN_VERSION` (2.1.241)
and `CLAUDE_IMAGE_TOOL_RESULT_MIN_VERSION` (2.1.277). At or above a floor, the behaviour behind it
must hold. Below a floor, the measurement is reported as an observation. If the behaviour is present
there, the report says so; lowering a floor stays a reviewed change. The image floor rests on a real
model reading pixels, so lowering it also needs the manual `probe:claude-mcp-image`. On 2.1.241 the
image block already reaches the request at the stub. Running the suite on a floor release verifies
that the floor itself still holds.

### Reviewer Pin

The media reviewer accepts only Claude Code 2.1.296
(`CLAUDE_MEDIA_REVIEWER_CLI_VERSION`). The controlled native review job is retired; its former
flag and pin comparison is removed rather than applied to managed review sessions, which have
their own launch contract. The report's `reviewerPin`
says whether the measured release behaves like the pin:

- **at the pin:** the measured release is 2.1.296;
- **matches the pinned behaviour:** every reviewer assumption matched, so the pin can move through a
  reviewed change;
- **differs from the pinned behaviour;**
- **below the pin:** the media reviewer refuses this release, and it is never a candidate for the pin, so
  its reviewer measurements are recorded as observations ("same as the pin" or "differs from the
  pin") instead of failing every floor run;
- **could not run**, which still fails the run below the pin.

The comparison never moves the pin.

The media reviewer's version-equality check *is* the pin, so the probe substitutes the pinned
version in the init event before it runs the production check. Every other check runs unchanged.

**Measured on 2.1.296 and 2.1.314:** under the reviewer's `--bare` flag, the CLI emits
`system/ui_invalidate` before its startup `system/init`. The same arguments without `--bare` start
with init, and 2.1.277 emits nothing before init even with `--bare`.

`ClaudeMediaReviewerStream` requires init to be the first event, so a production media reviewer
window would be refused on its own pinned release. The probe records `system/ui_invalidate` as the
pin's baseline (`REVIEWER_PIN_PRE_INIT_EVENTS`) and reports any difference as changed. It measures
the production parser from init onward, and that part passes on both releases. Whether the reviewer
should accept or reject the pre-init event is a reviewed decision outside this suite.

## Excluded Probes

| Command / Behaviour | Reason |
| --- | --- |
| `probe:claude-mcp-image` | Needs a signed-in account and a real model to read pixels back. This suite instead checks at the stub that the image block reaches the model request. Whether a model can read it stays manual. |
| `probe:claude-media-reviewer --live` | A paid run with the dedicated reviewer key inside the reviewer namespace, so it is human-only. This suite measures the reviewer's flags, event order, init shape and usage fields against the stub. |
| Auto-mode classifier decisions | Only a real model makes them. The stub's "allow" answer keeps allow-controls running and claims nothing about the classifier. Auto-mode `can_use_tool` frames, which need the classifier to escalate, stay covered by the recorded fixture replay in `claude-code-managed-worktree.test.ts`. |
| The production guard hook process | The probes measure Claude's hook semantics with a probe hook. The runner's own hook is covered by its unit and integration tests. |

## Running Under Isolation

The suite writes only under its report directory, `HOME` and `TMPDIR`. It needs neither sudo nor
write access to the checkout, so it can run as an unprivileged user from a read-only copy, under
`env -i` with only `PATH`, `HOME`, `TMPDIR`, `LANG`, `CI` and `CLAUDE_BIN`.

`strace` must be installed beforehand. The default Ubuntu `kernel.yama.ptrace_scope=1` allows it,
because it traces only its own descendants. Without it, every silence assumption is "could not run".
