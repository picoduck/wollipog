# Wollipog

<img src="apps/web/public/icons/icon-192.png" alt="Wollipog" width="96" align="right" />

Wollipog is a local-first control plane for running and supervising coding agents across development machines. It gives you one browser or desktop interface for sessions, approvals, worktrees, terminals, diffs, reviews, automations, and remote runners while execution stays on the machine that owns each repository and toolchain.

> [!IMPORTANT]
> Wollipog is under active development. Keep the control plane on loopback by default and limit remote access to trusted devices using authenticated Tailscale or HTTPS connections.

## Architecture

```text
Browser or Desktop UI
  -> Control Plane API       HTTP commands and WebSocket events
    -> Runner                outbound authenticated WebSocket
      -> Agent Driver        Claude Code, Codex, Pi, or ACP stdio
        -> Local Repository  shell, Git, tools, and isolated worktree
```

The runner owns provider processes and filesystem access. The control plane stores normalized session state and events, while the UI remains a control surface. ACP stays runner-local and is never exposed directly to the browser.

See [Concepts and Glossary](docs/concepts-and-glossary.md) for the relationship between Instances, Machines, Runners, Projects, Locations, Workspaces, and Sessions.

## Current Capabilities

- Connect native, WSL, SSH, container, and operator-configured cloud execution targets.
- Discover supported coding-agent installations and their authentication state.
- Run Claude Code, Codex, and Pi through native drivers, plus compatible agents through ACP.
- Use supported agents in Native TUI sessions alongside structured conversations.
- Create isolated Git worktrees and inspect status, diffs, commits, branches, and pull requests.
- Stream agent messages, reasoning summaries, plans, tool calls, file changes, terminal output, and errors.
- Handle approvals, structured questions, authentication prompts, and policy decisions.
- Fork or resume supported conversations while preserving filesystem provenance.
- Coordinate multi-agent runs, pods, workflows, durable automations, and review queues.
- Manage multiple Claude and Codex accounts and choose defaults for each Machine.
- Import, version, assign, and deploy agent skills through the opt-in Skills Library.
- Export transcripts and artifacts, create expiring share links, and track usage and cost.
- Use the React dashboard in a browser or the self-contained Tauri desktop application.
- Pair remote browser devices over a Tailscale-only listener.
- Operate a headless Linux control plane and runner through systemd and the host administration CLI.

## Install a Release

Download installers from the [latest published release](https://github.com/picoduck/wollipog/releases/latest) or use the scripts below. Native releases support these platforms:

| Platform | Architectures | Desktop Bundles |
| --- | --- | --- |
| macOS | Apple Silicon and Intel | `.dmg`, `.app.tar.gz` |
| Windows | x64 and ARM64 | `.msi`, NSIS `.exe` |
| Linux | x64 and ARM64 | `.AppImage`, `.deb`, `.rpm` |

Published macOS bundles are Developer ID signed and notarized. Windows installers and executables, including standalone runners and control planes, are Authenticode signed through Azure Artifact Signing. SmartScreen may still warn until the signing certificate builds download reputation. Linux binaries have no platform code signature; desktop update packages on all three platforms carry a separate signature that the app verifies before installation. Local builds and unsigned branch test releases do not carry the same signing guarantees. See [Releasing](docs/RELEASING.md) for the signing and verification process.

The desktop application includes its control plane and a local runner; no separate Node.js installation is required. Open **Connections → Set Up This Machine** to provision the bundled runner and discover installed coding agents.

macOS or Linux desktop installer:

```bash
curl -fsSL https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install.sh | sh
```

On macOS, this installs the app from its DMG. On Linux, it installs the portable AppImage in `~/.local/bin`; `.deb` and `.rpm` packages are available on the release page.

Windows desktop installer:

```powershell
irm https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install.ps1 | iex
```

Install only the runner on another machine:

```bash
curl -fsSL https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install-runner.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install-runner.ps1 | iex
```

The standalone runner also includes the `wollipog` CLI. Configure its control-plane connection and runner credential as described in [Runner Credentials and Secrets](docs/runner-credentials-and-secrets.md) and [Runner Updates](docs/runner-updates.md).

The installers select the latest published stable release and verify GitHub's SHA-256 release asset digests before installation. Review the scripts before piping them to a shell if that better matches your security policy. For private repositories, clone with authenticated GitHub CLI and run the installer locally; the scripts can use GitHub CLI for authenticated release downloads.

### Desktop Updates

Desktop releases from v0.28.0 onward check for newer published stable releases through **Settings → About**. **Install and Restart** downloads and verifies a signed update, then restarts the app after checking for work in flight. Linux `.deb` and `.rpm` installations, and builds without an update key, link to the release page for manual installation. Updating the desktop app does not upgrade a remote control plane or standalone runner.

### Headless Linux Installation

Install the runner, CLI, control plane, and dashboard bundle on a Linux host with systemd:

```bash
curl -fsSL https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install-runner.sh | sh -s -- --control-plane
wollipog service install
```

The installer places executables in `~/.local/bin`; add it to `PATH` if needed. `service install` uses user services when run without root and system services when run as root. See [Headless Deployment](docs/headless-deployment.md) for remote access, upgrades, backups, and recovery, and [Host Administration](docs/host-administration.md) for pairing devices and managing credentials from a terminal.

## Develop from Source

### Prerequisites

- Node.js 22.13+ within 22.x, or 23.4+ (24 recommended; 23.0–23.3 are unsupported)
- pnpm 11.9.0 (the version pinned in `package.json`)
- Git
- Rust and the platform C toolchain when building the desktop application

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Start the browser dashboard and local runner:

```bash
pnpm dev:all
```

This starts the control plane on `http://127.0.0.1:4317/`, the Vite dashboard on `http://127.0.0.1:5173/`, and a local runner with an automatically provisioned credential and separate development state. It uses `runner.config.json` when present, otherwise [runner.config.example.json](runner.config.example.json); customize a local copy for your agents, account directories, and repositories. Use `pnpm dev:all:no-watch` to run the control plane and runner without automatic restarts when their source files change.

Or run the control plane and web application without automatically starting a runner:

```bash
pnpm dev
```

The browser dashboard requires a local device credential. After the control plane has initialized its database, print a protected pairing URL with:

```bash
pnpm --filter @wollipog/control-plane start -- --print-pair-url
```

Open the printed URL to use the dashboard served by `pnpm dev:all`, or append its `#pair=…` fragment to `http://127.0.0.1:5173/` for the Vite dashboard. The browser stores the credential and removes it from the address bar.

### Desktop Application

Run the web development servers in one terminal and the Tauri shell in another:

```bash
pnpm dev
pnpm desktop
```

Build native bundles with:

```bash
pnpm desktop:build
```

Platform prerequisites and bundle locations are documented in [apps/desktop/README.md](apps/desktop/README.md).

### Verification

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check:rust
```

End-to-end browser tests are available through `pnpm test:e2e` after installing the Playwright browser dependencies.

## Connect Coding Agents

The runner can discover supported native installations or launch explicitly configured agents. Native drivers retain provider-specific capabilities such as model selection, reasoning effort, approval modes, image input, conversation resume, and conversation fork.

| Driver | Transport | Typical Authentication |
| --- | --- | --- |
| `claude-code` | Claude Code stream JSON | Existing Claude Code login or `ANTHROPIC_API_KEY` |
| `codex-app-server` | Persistent Codex app-server over stdio | Existing Codex login |
| `codex` | Codex exec JSON | Existing Codex login |
| `pi` | Pi RPC over stdio | Provider authentication configured in Pi |
| `acp` | Agent Client Protocol over stdio | Adapter-specific |

A minimal configured native agent looks like:

```json
{
  "id": "claude",
  "name": "Claude Code",
  "command": "claude",
  "driver": "claude-code"
}
```

For a WSL installation, set an explicit execution context:

```json
{
  "id": "claude-wsl",
  "name": "Claude Code (WSL)",
  "command": "/home/you/.local/bin/claude",
  "driver": "claude-code",
  "context": { "kind": "wsl", "distro": "Ubuntu-24.04" }
}
```

The checked-in [runner.config.example.json](runner.config.example.json) contains additional examples. Keep credentials out of that file; use the agent's own host-side login or protected secret files and environment injection. Detailed lifecycle and capability behavior is documented in [Drivers](docs/DRIVERS.md), and repository hooks plus stable worktree port blocks are documented in [Worktree Hooks and Ports](docs/worktree-hooks-and-ports.md).

To use more than one Claude or Codex subscription on one runner, configure `providerAccounts`
with an opaque id, display label, provider, and absolute credential directory, then optionally set
an agent's `defaultProviderAccountId`. Wollipog maps the selected directory to
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` only on the runner; the control plane receives only the id,
label, provider, and login state. Omitting `providerAccounts` preserves the provider's ordinary
default home exactly.

Machine owners can also add and remove accounts from the Machine card. A sign-in to an account
that is already on the Machine is discarded rather than recorded twice. Removing an account deletes
the credential directory Wollipog created for it, unless a session on that Machine still uses it;
directories you configured yourself are never deleted.

In Machine settings, owners can choose a default Claude and Codex account for new native host
sessions. A choice in New Session takes precedence, and existing sessions keep their recorded
account. Clearing the setting restores the agent's configured default or the first account. If a
saved default is removed, new sessions ask for an explicit account until the owner replaces or
clears that setting.

## Security Model

Wollipog runs tools that can modify source code and execute commands. Its primary trust boundaries are:

- Runner credentials are scoped to a specific runner identity and should be stored in protected files.
- Local browser and desktop access requires a separate device credential.
- The packaged desktop control plane binds to loopback unless tailnet access is explicitly enabled.
- Tailnet mode validates both peer and local socket addresses before serving HTTP or WebSocket traffic.
- Runner processes own agent credentials; the control plane does not persist provider access tokens.
- Worktree and optional platform isolation reduce accidental cross-session writes but do not turn untrusted agents into safe code.
- Full-access agent modes intentionally remove important safeguards and should be used only in disposable or trusted environments.

Read [SECURITY.md](SECURITY.md) before exposing a control plane or runner beyond a local development machine. Additional design details are in [Runner Credentials and Secrets](docs/runner-credentials-and-secrets.md), [Device Authentication](docs/device-auth.md), and [Execution Targets](docs/execution-targets.md).

## Repository Layout

```text
apps/
  control-plane/  Fastify API, WebSocket hub, identity, and persistence
  runner/         Agent drivers, execution isolation, Git, shells, and worktrees
  web/            React and Vite user interface
  desktop/        Tauri native shell and bundled sidecars
  mock-agent/     Deterministic ACP fixture agent
packages/
  protocol/       Shared TypeScript contracts
  test-support/   Shared test fixtures and helpers
docs/             Public architecture, operations, and security documentation
scripts/          Development, installation, and release helpers
skills/           Built-in agent skills shipped with releases
```

## Documentation

- [Session Status Taxonomy](docs/session-status-taxonomy.md)
- [Concepts and Glossary](docs/concepts-and-glossary.md)
- [Scope](docs/SCOPE.md)
- [Drivers](docs/DRIVERS.md)
- [Admission Policy](docs/admission-policy.md)
- [Execution Targets](docs/execution-targets.md)
- [Worktree Setup Configuration](docs/worktree-setup.md)
- [Worktree Hooks and Ports](docs/worktree-hooks-and-ports.md)
- [Runner Credentials and Secrets](docs/runner-credentials-and-secrets.md)
- [Device Authentication](docs/device-auth.md)
- [Headless Deployment](docs/headless-deployment.md)
- [Host Administration](docs/host-administration.md)
- [Runner Updates](docs/runner-updates.md)
- [Agent Control](docs/agent-control.md)
- [Agent Skills](docs/agent-skills.md)
- [Automations](docs/automations.md)
- [Transcript Exports](docs/transcript-exports.md)
- [Releasing](docs/RELEASING.md)

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), run the relevant verification commands, and include tests for behavioral changes.

Please report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not through a public issue.

## License

Wollipog is licensed under the [Apache License 2.0](LICENSE).
