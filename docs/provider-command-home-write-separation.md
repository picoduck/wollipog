# Provider and Command Credential-Home Write Separation

This is the implementation plan for the remaining enforcement in #3922. The initial disclosure
slice does not implement command write denial and must not be presented as delivery of that issue.
The reported capability is narrowly **runner-enforced provider/command credential-home write
separation**, not the effectiveness of a provider's own sandbox.

## Current Control Points

The runner's `preserveProviderHome` bwrap path grants the containing provider directory writable
because refresh replaces files by rename. Descendants inherit it. A read-only bind on credential
files would break provider refresh and does not implement the requested separation.

Claude's driver supplies permission decisions and hooks, Codex's driver supplies turn policies
and approval responses, and Pi's extension intercepts `tool_call`. These current integrations
do not put the model command in a narrower runner-owned filesystem boundary. ACP's
`terminal/create` does give the runner a real spawn point, but the protocol does not establish
that an arbitrary adapter uses it for every command. Protecting only that service cannot justify
a harness-wide protection claim.

## Primary-Source Audit (2026-11-10)

* [Claude sandboxing](https://code.claude.com/docs/en/sandboxing) documents OS containment for
  Bash and its descendants, distinct from provider execution. Candidate settings include
  `sandbox.enabled`, `filesystem.denyWrite`, `allowUnsandboxedCommands: false`, and
  `failIfUnavailable`. This is a real candidate for native Linux/macOS, not a shell-text wrapper.
  Settings precedence, exclusions, writable settings, version support, and nested namespace
  availability still need proof. Enabling strict mode on a host where it cannot start would
  disable all commands, which is not acceptable as a silent compatibility change.
* [Codex App Server](https://developers.openai.com/codex/app-server/) documents per-turn sandbox
  policies and explicitly says `externalSandbox` skips its own enforcement. `command/exec` is
  a client request to execute inside the server; it is not a callback intercepting model tools.
  Dynamic tools provide client-executed callbacks, but do not by themselves replace built-ins.
  [The configuration reference](https://developers.openai.com/codex/config-reference/) exposes
  command tool controls. A replacement execution backend must prove complete coverage, including
  resumable commands, code-mode/REPL processes, subagents and resumed threads. This audit has not
  proven an integrated, complete replacement for externalSandbox sessions.
* [Pi extension documentation](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/extensions.md)
  describes `BashOperations`, `PowerShellOperations`, tool overrides, and a spawn hook. A custom
  operations backend could execute through a trusted runner broker rather than prefixing shell
  text. Coverage must include `user_bash`, extension tools, RPC commands and tool overrides, with
  installed-version and extension-order validation. This is a concrete prototype candidate,
  not evidence the current Pi driver enforces the boundary.
* [ACP terminals](https://agentclientprotocol.com/protocol/v1/terminals) specify client-controlled
  command creation. A terminal backend can use narrower binds, but adapter-owned subprocesses
  remain outside that coverage until an exact adapter contract and conformance test prove otherwise.

These are documentation findings, not live-provider tests or a claim that upstream cannot support
the feature. No provider, authentication, credential, or model operation was run for this audit.

## Bounded Enforcement Prototype

First prototype a trusted runner command broker with synthetic providers. Keep the provider in
its existing writable boundary; give broker-created commands a separate child boundary with the
entire canonical credential home read-only. Require complete argv-based mediation and retain the
boundary for descendants, background tasks and cancellation. Reject canonical aliases, remapped
writable sources and worktree grants that could expose the same home writable. Do not authenticate
broker requests from command-readable writable files or treat an approval hook as spawn ownership.

The first real integration candidate is Pi's operations backend or a specifically attested ACP
terminal-only adapter. That proves only its bounded scope. Claude needs a validated strict native
command sandbox integration or another trusted execution backend. Codex under externalSandbox
needs a complete execution backend or a compatible provider-supported command containment path.
Neither a new MCP tool nor a shell-input prefix establishes complete interception by itself.

Native Linux must prove the narrower child namespace can start inside the actual outer boundary.
This host's namespace restriction is an unavailable test environment, not a passing conformance
result. Native macOS needs a child Seatbelt profile that narrows the inherited write grants without
breaking provider writes. Windows Job Objects do not enforce filesystem restrictions. WSL and
remote adapters need target-local proof; no host-side assumption is sufficient.

## Synthetic Conformance and Compatibility

Use only inert providers and temporary synthetic homes. For each integrated harness, capture the
actual command-spawn path and test command create/overwrite/delete/replace, temp-file-and-rename,
symlink aliases, nested descendants, background work and cancellation. The paired provider process
must still refresh via temp-file-and-rename, write transcripts/session state and execute synthetic
configuration value, batch and skills writes. Reads must retain existing behavior. A namespace
denial is reported unavailable; never weaken the host policy or reinterpret it as a pass.

Advertise protection only after exact-harness/version/backend coverage and successful conformance
are established. A configured isolation mode, an externalSandbox turn, ACP terminal capability,
or an unsuccessful provider sandbox probe is not proof. Old or absent reports remain unknown;
rollback and mixed versions must not inherit a newer runner's report. None of this changes current
provider permissions, account bindings, credential access, or provider-state write semantics.
