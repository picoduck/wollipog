# Native Media Core Source Preparation

This library has the distinct identity `wollipog-native-media-core-v1`. It is not the installed
Codex App Server and is not a registered Wollipog driver. Identical model IDs do not make those
execution identities interchangeable. No executable or SDK session launcher is supplied here.

The optional `native-core` feature pins official Codex release 0.162.1 to commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. It constructs the actual native startup `ToolPolicy`
and `SessionIsolation::Isolated` through `StartThreadOptions.thread_extension_init`, a route the
installed public App Server does not expose. It constructs fresh options with no retained
history, instructions provider, inherited environments, capability roots or client MCP extensions;
it refuses ambient instruction/MCP configuration, persistent threads and feedback collection,
and uses the existing two scoped tool schemas.
The host bridge contains guarded SDK-call adapters, including `ThreadManager.start_thread` and
provider-input submission. Production admission has no available issuer, so this source preparation
does not provide an admitted startup path. No account or provider process is opened by these tests.
The manifest retains that SDK workspace's exact public dependency patches, which downstream Cargo
packages do not inherit automatically. The release commit's Git tree is
`572cdecd45cd985f0ad80b63d8b86ffcb345f47a`; commit and tree identities are distinct.

The pure bindings freeze execution identity, SDK revision, actual Session coordinates, generation,
model, command, scope, namespace and context-manifest commitments. Generic model tools and all
resume/fork requests are refused. A future actual host must independently authenticate every
namespace/context observation, inspect the complete SDK input surface and immutable resume
behavior, and enforce the OS filesystem/network boundary after materialization. Caller-supplied
booleans, these tests and successful compilation do not establish those runtime facts or mint a
Human permit. Real frame/criteria delivery, final same-generation pricing/usage, terminal cleanup,
private hosting and independent blind candidate/paced/maximum validation remain required.

Current App Server preflight stays `builtin_tool_allowlist_unavailable`. Private media protocol 223
requires the separate exact compatibility identity `{ id: "wollipog-paced-video-review-v1", revision: 1 }`
and stays unadvertised; an integer protocol version alone cannot establish media support. Actual
executable selection, driver registration, account use and SDK/provider/media launch require a separately audited contract and exact Human gate. The source is not an activation.

Pure standard-library tests can be compiled directly with the existing Rust toolchain without
resolving or initializing any SDK dependencies. Full `cargo check/test --features native-core`
needs an explicit host scheduling slot; use task-private Cargo/target caches, never mutate
installed SDKs, user configuration, credentials, protected policy or the hosting stack.

## Dependency Advisories

`Cargo.lock` resolves the pinned Codex release's dependency tree behind `native-core`. No workflow,
script or package manifest builds that feature, so none of those crates reach a Wollipog artifact,
and an advisory against this lockfile is not a shipped vulnerability. The policy (#3766):

- Dependabot alerts for `apps/runner/native-media-core/Cargo.lock` are dismissed as "vulnerable
  code is not actually used", citing this section.
- Dependabot security pull requests for this path are closed rather than merged. No build compiles
  them, so CI cannot verify them, and the lockfile moves with the Codex pin rather than crate by
  crate.
- Before any workflow builds `--features native-core`, it runs
  `cargo audit --file apps/runner/native-media-core/Cargo.lock`, which fails on vulnerabilities
  that are not explicitly ignored. `scripts/native-media-core-advisory-gate.test.mjs` refuses a
  workflow build unless that audit runs earlier in the same job and its failure stops the build,
  and refuses a feature build from anywhere else.
- Moving the Codex pin re-resolves this lockfile; clear or record its advisories then.
