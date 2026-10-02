# Codex Plugin Launcher Forms

For native, managed Codex accounts, Wollipog inherits enabled plugins from the default
Codex home without rewriting either config or copying credentials. It places inherited
`-c` settings after the launcher prefix and before existing Codex arguments. Explicit
account settings and later Codex CLI overrides keep precedence.

## Supported Forms

`<package>` below means `@openai/codex`, optionally followed by a version or tag such as
`@openai/codex@0.159.2` or `@openai/codex@latest`. Executable paths and Windows `.exe` /
`.cmd` / `.bat` names are recognized. Options must occur before the package or entry script.

| Launcher | Form | Supported Launcher Options |
| --- | --- | --- |
| Direct | `codex <Codex args>` | All arguments belong to Codex |
| Node | `node <entry-script> <Codex args>` | `--no-warnings`, `--enable-source-maps`, optional `--` before the script |
| npx | `npx <package> <Codex args>` | `-y`, `--yes`, `--no`, `--no-install`, `--offline`, `--ignore-scripts`, optional `--` before the package |
| npm | `npm exec -- <package> <Codex args>` (also `npm x`) | `-y`, `--yes`, `--no`, `--offline`, `--ignore-scripts` before the mandatory `--` |
| pnpm | `pnpm dlx <package> <Codex args>` | `-s`, `--silent`, optional `--` before the package |
| pnpx | `pnpx <package> <Codex args>` | `-s`, `--silent`, optional `--` before the package |
| Bun | `bun x <package> <Codex args>` or `bunx <package> <Codex args>` | `--bun`, `--no-install`, `--verbose`, `--silent`, optional `--` before the package |
| Yarn | `yarn dlx <package> <Codex args>` (modern Yarn with `dlx`) | `-q`, `--quiet`, optional `--` before the package |
| env | `env <supported launcher> <launcher/Codex args>` | `-u NAME` / `--unset NAME`, optional `--` before the command |

Package launchers also accept `--package <package>` or `--package=<package>` before
the executable `codex`; `-p <package>` is accepted by npx, Yarn, and Bun. npm uses `-p`
for something else, and pnpm/pnpx require the long option. Only Codex packages are
supported in these options. For example:

```text
bunx --bun -p @openai/codex@latest codex app-server
yarn dlx -q --package @openai/codex@0.159.2 codex app-server
npm exec --offline --package=@openai/codex -- codex app-server
/usr/bin/env -- bunx @openai/codex app-server
```

The inherited settings go immediately after `codex`, `<package>`, or the Node script
in these forms. Wollipog does not execute a launcher to discover its argument grammar.
The Node entry script must itself forward arguments to Codex.

## Safe Fallback and Account Boundaries

When inherited settings are needed, unknown wrappers, unsupported launcher options,
shell command strings (`-c` / `--call` / `--shell-mode`), and ambiguous forms fail
preparation with a fixed diagnostic directing the operator to this document. No command
path, argument, config source line, or environment value is included, and the account
plugin cache is not mutated. Use one of the supported forms to proceed. No shell
evaluation, executable probing, or guessed insertion is performed.

`npm exec` requires `--` because npm otherwise continues parsing provider options.
`env` assignments, environment clearing, nested `env` wrappers, and unsetting `HOME`,
`USERPROFILE`, or `CODEX_HOME` are unsupported: inheritance must resolve the same account
home the provider receives. Set environment values in the launch environment instead.
Node evaluation modes and runtime options other than those listed are unsupported.
Arbitrary package aliases, file/URL package specs, and other package-manager commands
are unsupported. The launchers themselves must support the chosen option/version.

Launches needing no inherited settings retain their original arguments. Existing
default-home, unmanaged-home, WSL, container, cloud, and remote-adapter boundaries
remain in place; remote execution does not inherit host plugins. Payload links remain
limited to plugin cache directories, preserving account-owned installations and data.

Argument-order tests cover every listed launcher. Forwarding tests run actual Node,
`env`, `npx`, and `npm exec` against an inert local `@openai/codex` fixture with offline
installation settings, synthetic homes, no credentials, and no model calls. Optional
`WOLLIPOG_TEST_BUNX_BINARY` exercises an installed `bunx` against the same local fixture
with `--no-install`; it is not required for the default suite. These tests do not claim
that every package-manager release has been integration-tested.

Launcher references: [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/),
[pnpm dlx / pnpx](https://pnpm.io/cli/dlx), [bunx](https://bun.sh/docs/cli/bunx),
[Yarn dlx](https://yarnpkg.com/cli/dlx).
