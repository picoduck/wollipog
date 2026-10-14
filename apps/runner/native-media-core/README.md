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
This library never calls `ThreadManager.start_thread`, opens an account, or submits provider input.
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

Current App Server preflight stays `builtin_tool_allowlist_unavailable`; media 221 stays
unadvertised. Actual executable selection, driver registration, account use and SDK/provider/media
launch require a separately audited contract and exact Human gate. The source is not an activation.

Pure standard-library tests can be compiled directly with the existing Rust toolchain without
resolving or initializing any SDK dependencies. Full `cargo check/test --features native-core`
needs an explicit host scheduling slot; use task-private Cargo/target caches, never mutate
installed SDKs, user configuration, credentials, protected policy or the hosting stack.
