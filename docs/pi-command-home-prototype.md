# Pi Command-Home Operations Prototype

This is a bounded experimental slice of #3922. It is **not wired into ordinary provider launches**,
does not change any flags, tools, permissions or default, and never advertises protection. The
original Claude/Codex enforcement and cross-harness conformance requirements remain open.

## Pinned Contract

The audited installed package is `@earendil-works/pi-coding-agent` **0.85.0**. Exact SHA-256 pins
for its CLI bundle, Bash implementation/schema, RPC dispatcher, session runtime, extension loader
and extension types are recorded in `PI_COMMAND_HOME_SOURCE_PINS`. The code verifier reads only
installation code and package metadata; it does not execute Pi or read provider state.
Other versions, changed code and future APIs are unsupported by this prototype.

Primary documentation describes the operations API, but mutable upstream main is not used as a
runtime attestation: [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[Bash source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts).

| Executable Route | Installed 0.85.0 Audit | Prototype Handling |
| --- | --- | --- |
| Model `bash` | `createBashTool` delegates to supplied `BashOperations.exec` | Re-register using operations, with per-invocation provenance checks |
| RPC `bash` | Emits `user_bash`, passes returned operations into `executeBash` | Always return protected or refusing operations; never undefined/local fallback |
| Interactive `user_bash` | Same operations event contract | Same backend and refusal path |
| Reload / New Session | Reload reconstructs tools and emits session lifecycle events | Readiness resets on shutdown; recheck on startup and each invocation |
| PowerShell / Custom Tools / Extension Execution | Separate executable routes | Ineligible; no broader coverage claim |
| Code-Mode / Additional Extension Loaders | Not part of the audited default four-tool inventory | Ineligible; cannot infer coverage from tool names alone |

Eligibility requires the selected launch **already** to have exactly `--no-extensions` and no
operator overrides. The flag is not added by this work. The pinned loader's ordinary and project-
trust paths both retain only explicit CLI extensions when that flag is present. Future launch
integration must prove that the only explicit extension is immutable runner-owned code, with no
inline/custom factory injection. Active tools must remain within read/bash/edit/write; unknown
registrations or changed Bash provenance refuse the experimental execution path. Existing launches
that cannot prove this must keep their ordinary behavior and an unprotected capability report.

## Child Boundary

`createPiCommandHomePrototype` accepts a frozen copy of an existing managed-worktree bwrap policy.
It removes the identity writable bind for the canonical provider home and overlays that entire
home read-only after all remaining writable grants. It does not add worktree, Git, cache or
temporary grants. Nonidentity writable aliases, overlapping grants, pre-existing provider-home
symlinks, mutable installation/hook roots and a cwd outside the selected worktree are refused.
Policy diagnostics are fixed and do not disclose provider paths or content.

The backend calls the existing `buildBwrapArgs`, `spawnAgent`, process-tree proof and termination
primitives. The command remains a single shell payload after namespace entry; it is not rewritten
with a shell prefix. The launcher receives a fixed environment with inherited variables scrubbed.
The command's environment is passed to trusted `env -i` inside the child boundary, so loader
variables do not affect the bubblewrap launch. Policy paths are captured at construction rather
than taken from model arguments. Sandbox errors are returned as command failures; cancellation
and unproven tree retirement fail closed without an unsandboxed retry.

The provider remains in its original writable boundary. The prototype does not bind individual
credential files read-only or change provider refresh/transcript/configuration code.

## Evidence and Limits

The source prototype has inert tests for argv/env separation, immutable snapshots, overlapping
and aliased grants, wrong cwd, cancellation, failures without retries, tool provenance and reload.
A local installed-SDK contract test imports only the pinned Bash tool factory in a separate process
with a synthetic HOME and a clean environment. It executes the injected inert operations callback;
no provider CLI, sign-in, credentials, network or model is exercised.

The kernel conformance fixture first checks availability, then uses the production isolation
resolver and bwrap argument builder for the outer synthetic provider. Inside it, the actual
operations backend attempts denied create/overwrite/delete/temp-rename/alias/descendant writes,
ordinary reads and worktree writes, while the parent synthetic provider performs credential
temp-rename refresh, transcript/state and value/batch/skills configuration writes. Cancellation
uses the same production lifetime primitives. This is a synthetic OS test, not a Pi inference test.

On the implementation host the **outer namespace is refused**. The kernel test is explicitly
`UNAVAILABLE`/skipped; it establishes no write-denial conformance. Host policy is not relaxed.
Even a passing kernel fixture would not by itself attest to complete Pi launch integration: the
fixture uses a synthetic installation audit seam, while the separate installed-SDK test validates
only the operations interface. No combination of these is currently published as protected.

Before activation, a separately reviewed integration must combine the pinned loaded CLI/runtime,
all imported dependency and hook immutability in the actual outer namespace, exact extension/tool
coverage across reloads and RPC routes, and successful outer/inner conformance. Path checks before
bwrap reopens a pathname are not a general same-UID race proof. The prototype assumes the supplied
outer policy has actually pinned its mount identities; verifying that launch-local fact remains
an activation prerequisite. Unsupported topology must remain visible without silently disabling
all useful commands. Claude, Codex externalSandbox, arbitrary ACP adapters and other hosts remain
outside this prototype's coverage.
