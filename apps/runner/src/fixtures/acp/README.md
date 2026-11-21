# ACP conformance fixtures

These credential-free `initialize` responses pin real protocol-v1 adapter shapes for deterministic
CI conformance. They contain no prompts, model responses, identities, tokens, or credential values.

- `claude-agent-acp-0.58.1.initialize.json` was captured on 2026-07-11 from
  `npx -y @agentclientprotocol/claude-agent-acp@0.58.1`.
- `gemini-cli-0.50.0.initialize.json` was captured on 2026-07-11 from
  `npx -y @google/gemini-cli@0.50.0 --acp`.
- `antigravity-1.5.14.initialize.json` was captured on 2026-11-21 on Linux from Google's installed
  `agy acp` 1.5.14 (run with `AGY_CLI_DISABLE_AUTO_UPDATE=true`, without ambient Google credentials).
  It is the credential-free initialization fixture for Google Antigravity sessions (#4779); its
  `_meta` is kept as returned and carries no account data.

Each process received only the standard `initialize` request emitted by `acpInitializeRequest()`
and was terminated after its first response. Refresh deliberately when a registry-pinned adapter
version changes; never silently rewrite a fixture to match generated types.
