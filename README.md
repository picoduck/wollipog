# Wollipog

<img src="apps/web/public/icons/icon-192.png" alt="Wollipog" width="96" align="right" />

Wollipog is a local-first control plane for running and supervising coding agents across development machines. It gives you one browser or desktop interface for sessions, approvals, worktrees, terminals, diffs, reviews, automations, and remote runners while execution stays on the machine that owns each repository and toolchain.

> [!IMPORTANT]
> Wollipog is under active development. Release binaries are currently unsigned, and remote access should be limited to trusted tailnet devices.

## Architecture

```text
Browser or Desktop UI
  -> Control Plane API       HTTP commands and WebSocket events
    -> Runner                outbound authenticated WebSocket
      -> Agent Driver        ACP stdio, Claude Code, or Codex
        -> Local Repository  shell, Git, tools, and isolated worktree
```

The runner owns provider processes and filesystem access. The control plane stores normalized session state and events, while the UI remains a control surface. ACP stays runner-local and is never exposed directly to the browser.

See [Concepts and Glossary](docs/concepts-and-glossary.md) for the relationship between Instances, Machines, Runners, Projects, Locations, Workspaces, and Sessions.

## Current Capabilities

- Connect native, WSL, SSH, container, and operator-configured cloud execution targets.
- Discover supported coding-agent installations and their authentication state.
- Run Claude Code and Codex through native drivers, plus compatible agents through ACP.
- Create isolated Git worktrees and inspect status, diffs, commits, branches, and pull requests.
- Stream agent messages, reasoning summaries, plans, tool calls, file changes, terminal output, and errors.
- Handle approvals, structured questions, authentication prompts, and policy decisions.
- Fork or resume supported conversations while preserving filesystem provenance.
- Coordinate multi-agent runs, pods, workflows, durable automations, and review queues.
- Export transcripts and artifacts, create expiring share links, and track usage and cost.
- Use the React dashboard in a browser or the self-contained Tauri desktop application.
- Pair remote browser devices over a Tailscale-only listener.

## Install a Release

Release bundles are built for supported macOS, Windows, and Linux targets. The desktop application includes its control plane and a local runner.

macOS or Linux desktop installer:

```bash
curl -fsSL https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install.sh | sh
```

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

The installers require a published release and verify release asset digests before replacement. Review the scripts before piping them to a shell if that better matches your security policy. See [Releasing](docs/RELEASING.md) for release construction and verification.
## Develop from Source

### Prerequisites

- Node.js 22 or newer
- pnpm
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

Or run the control plane and web application without automatically starting a runner:

```bash
pnpm dev
```

The browser dashboard requires a local device credential. After the control plane has initialized its database, print a protected pairing URL with:

```bash
pnpm --filter @wollipog/control-plane start -- --print-pair-url
```

Open the URL fragment against `http://127.0.0.1:5173/`. The browser stores the credential and removes it from the address bar.

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

The checked-in [runner.config.example.json](runner.config.example.json) contains additional examples. Keep credentials out of that file; use the agent's own host-side login or protected secret files and environment injection. Detailed lifecycle and capability behavior is documented in [Drivers](docs/DRIVERS.md).

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
docs/             Public architecture, operations, and security documentation
scripts/          Development, installation, and release helpers
```

## Documentation

- [Session Status Taxonomy](docs/session-status-taxonomy.md)
- [Concepts and Glossary](docs/concepts-and-glossary.md)
- [Scope](docs/SCOPE.md)
- [Drivers](docs/DRIVERS.md)
- [Admission Policy](docs/admission-policy.md)
- [Execution Targets](docs/execution-targets.md)
- [Runner Credentials and Secrets](docs/runner-credentials-and-secrets.md)
- [Automations](docs/automations.md)
- [Transcript Exports](docs/transcript-exports.md)
- [Releasing](docs/RELEASING.md)

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), run the relevant verification commands, and include tests for behavioral changes.

Please report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not through a public issue.

## License

Wollipog is licensed under the [Apache License 2.0](LICENSE).