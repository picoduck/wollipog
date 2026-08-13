# ADR 0002: Keep ACP runner-local until remote transport stabilizes

- Status: Accepted
- Date: 2026-07-12
- Decision owners: Wollipog maintainers
- Upstream reference: [Streamable HTTP & WebSocket Transport RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport) (Active, not stabilized)

## Context

MAM already reaches SSH machines by installing a runner there. That runner launches the ACP agent locally over stdio, so prompts, approvals, filesystem calls, terminals, environment references, and provider credentials stay within the box trust boundary. Direct ACP Streamable HTTP/WebSocket would create a second remote-control plane with connection/session ids, long-lived streams, proxies, and independent credentials.

## Decision

All production ACP agents use runner-local stdio. `AgentDefinition.acpTransport` reports that fact. Runner config rejects remote transport-shaped values instead of ignoring them, and the reserved `features.acpRemoteTransports` flag cannot be enabled. SSH continues to carry MAM's authenticated runner channel; ACP does not traverse SSH or the public network directly.

Direct remote transport may be implemented only in a separate experimental adapter after the upstream RFD stabilizes and all gates below are enforced. It must never be an alternate branch inside the stdio client.

## Required gates before an experiment

1. TLS only (`https`/`wss`), with explicit endpoint origin allowlisting and certificate/CA or public-key pinning owned by the runner operator.
2. A dedicated secret reference for remote ACP authentication; no tokens in URLs, browser storage, runner metadata, logs, SQLite, or session snapshots.
3. Connection and session identifiers bound to one authenticated endpoint and runner, with replay protection, expiry, revocation, bounded reconnect, and downgrade rejection.
4. Proxy/redirect policy that rejects cross-origin hops and ambiguous forwarded identity; DNS rebinding and loopback/private-network rules must be explicit.
5. The same canonical workspace-root, filesystem, terminal, MCP, approval, cancellation, size, rate, and backpressure boundaries as stdio.
6. A threat-model review covering a malicious endpoint, compromised proxy, stolen credential, cross-runner/session confusion, stale reconnect, partial response, and denial of service.
7. Mock plus real conformance on every supported transport and runner context, with the remote feature disabled by default and visibly labeled experimental.

## Consequences

- SSH boxes retain one outbound authenticated channel and one local ACP process boundary.
- Users cannot configure direct ACP URLs today; startup fails with actionable stdio guidance.
- Registry metadata remains transport `stdio` and cannot silently activate a remote endpoint.
- Stabilized upstream transport work can be adopted later without weakening current provider or workspace isolation.
