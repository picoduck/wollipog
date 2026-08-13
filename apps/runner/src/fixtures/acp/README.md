# ACP conformance fixtures

These credential-free `initialize` responses pin real protocol-v1 adapter shapes for deterministic
CI conformance. They contain no prompts, model responses, identities, tokens, or credential values.

- `claude-agent-acp-0.58.1.initialize.json` was captured on 2026-07-11 from
  `npx -y @agentclientprotocol/claude-agent-acp@0.58.1`.
- `gemini-cli-0.50.0.initialize.json` was captured on 2026-07-11 from
  `npx -y @google/gemini-cli@0.50.0 --acp`.

Each process received only the standard `initialize` request emitted by `acpInitializeRequest()`
and was terminated after its first response. Refresh deliberately when a registry-pinned adapter
version changes; never silently rewrite a fixture to match generated types.
