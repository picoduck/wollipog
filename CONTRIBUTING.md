# Contributing to Wollipog

Thank you for helping improve Wollipog.

## Before You Start

- Search existing issues and pull requests before opening a duplicate.
- Use a focused issue for substantial features or architectural changes so the design can be discussed first.
- Never include credentials, private transcripts, proprietary code, personal data, or internal repository material in an issue, test fixture, or pull request.
- Keep documentation factual and focused on Wollipog and its supported integrations. Do not add competitor comparisons, private review reports, or internal research notes.

## Development Setup

Wollipog requires Node.js 22.13 or newer (24 recommended), pnpm, and Git. Rust and the platform C toolchain are required for desktop work.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Run `pnpm check:rust` when changing the Tauri application. Run the relevant Playwright coverage for user-interface changes.

## Pull Requests

- Keep each pull request scoped to one coherent change.
- Add or update tests for behavioral changes.
- Update public documentation when commands, configuration, security boundaries, or user-visible behavior change.
- Use Title Case for non-prose visible control labels and normal sentence case for descriptions, warnings, validation messages, and helper text.
- Explain security implications and compatibility behavior when a change crosses a process, network, credential, shell, Git, or filesystem boundary.
- Confirm that generated files, snapshots, and fixtures contain no credentials or private data.

## Commit and License Terms

Use clear commit messages that describe the change. By submitting a contribution, you represent that you have the right to submit it and agree that it will be licensed under the Apache License 2.0.

## Reporting Security Issues

Do not open a public issue for a vulnerability. Follow the private reporting instructions in [SECURITY.md](SECURITY.md).