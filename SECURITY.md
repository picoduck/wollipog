# Security Policy

Wollipog runs coding agents, shells, Git operations, and development tools on connected machines. Treat every runner as a privileged service and every enabled agent as code that can act with the permissions granted to its process.

## Supported Versions

Security fixes are applied to the latest release and the current `main` branch. Older releases may not receive backports while the project is under active development.

## Report a Vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/picoduck/wollipog/security/advisories/new). Do not open a public issue, discussion, or pull request containing exploit details, credentials, private transcripts, or sensitive host information.

Include:

- the affected version or commit;
- the operating system and execution context;
- the affected boundary, such as browser, control plane, runner, agent, shell, Git, filesystem, or updater;
- reproduction steps or a minimal proof of concept;
- the likely impact and any known mitigations.

You should receive an acknowledgement within seven days. Disclosure timing will be coordinated after the issue is understood and a fix or mitigation is available.

## Deployment Guidance

- Keep the control plane on loopback unless remote access is required.
- Use the tailnet-only listener and per-device pairing for remote browser access.
- Store runner and device credentials in protected files; never commit them.
- Use least-privilege agent modes and isolated worktrees.
- Treat full-access modes, shells, and external tools as equivalent to granting local code execution.
- Review installer scripts and release checksums before installation.
- Keep the operating system, coding agents, Node.js, Rust toolchain, and dependencies updated.

The project does not claim that a worktree, provider sandbox, platform sandbox, container, or process job object is a complete security boundary. Operators remain responsible for the trust level of agents and the credentials available on runner machines.