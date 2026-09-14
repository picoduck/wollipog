# Signed automation triggers

Webhook and chat-ops triggers are authenticated, out-of-band ways to invoke an existing durable
automation. Every trigger selects one fixed automation revision and, unless configured with an
explicit delivery policy, accepts no prompt, parameters, target, runner, workflow, approval,
callback URL, or limit overrides. A configured policy can admit bounded prompt text, named string
parameters, and (for `prompt_session`) a session selector. It can never change the automation's
agent, runner policy, concurrency policy, cost ceiling, or tool-call ceiling. Cron scheduling
remains independent.

Create a trigger from the Automations view or through the paired-device-authenticated management
API. Creation and rotation return a 256-bit HMAC secret once. Copy it immediately; normal reads
never return it. Rotation invalidates the previous secret immediately, and revocation clears the
active row's secret and rejects unclaimed deliveries. Older SQLite pages or backups can still
contain prior key material, so revocation is not a substitute for protecting or expiring backups.
Newly created and rotated secrets use the `wollipogwhsec_` prefix followed by exactly 43 base64url
characters. Existing `mamwhsec_` secrets remain valid until they are rotated or revoked.

Management routes are:

- `GET /api/automations/:id/triggers`
- `POST /api/automations/:id/triggers` with `{"kind":"webhook|chatops","name":"..."}` and an
  optional `deliveryPolicy`
- `POST /api/automations/:id/triggers/:triggerId/rotate`
- `DELETE /api/automations/:id/triggers/:triggerId`

The ingress endpoint is:

```text
POST /hooks/v1/automation-triggers/<triggerId>
Content-Type: application/vnd.wollipog.automation-trigger+json
Content-Encoding: identity
X-Wollipog-Timestamp: <Unix seconds>
X-Wollipog-Nonce: <16-128 URL-safe characters>
X-Wollipog-Signature: v1=<lowercase HMAC-SHA256 hex>
```

`Content-Encoding` may be omitted, which also means identity. The body is limited to 16 KiB. Sign
the exact bytes sent on the wire; whitespace changes the digest. The timestamp must be within five
minutes of the control-plane clock.

During the compatibility window, ingress also accepts
`application/vnd.mam.automation-trigger+json` and the complete legacy header set
`X-MAM-Timestamp` / `X-MAM-Nonce` / `X-MAM-Signature`. The media type is selected independently,
but the three signature headers must all come from one namespace. Do not mix partial generations or
send conflicting dual values.

## Body and signature contract

A legacy webhook body has exactly one field:

```json
{"eventId":"provider-stable-delivery-id"}
```

A legacy chat-ops body has exactly these fields:

```json
{"eventId":"provider-stable-event-id","command":"run","sender":"provider actor identity"}
```

The command is deliberately restricted to `run`. The sender is never retained verbatim; the
control plane stores only its SHA-256 digest for audit attribution. Event IDs are 1-128 characters
from `A-Z a-z 0-9 . _ : -`. They appear in durable invocation/execution history, so never put
credentials, message content, or personal data in an event ID.

### Delivery policy and optional fields

Omitting `deliveryPolicy` at trigger creation preserves the legacy contracts above exactly. A
delivery policy has this shape:

```json
{
  "allowPrompt": true,
  "parameterNames": ["issue", "run_id"],
  "missingReferences": "reject",
  "sessionSelectors": ["session_id", "branch", "pull_request"]
}
```

`allowPrompt` admits a non-empty `prompt` of at most 8 KiB UTF-8. `parameterNames` contains at most
16 unique names matching `A-Z a-z 0-9 _` and beginning with a letter. A delivery's `parameters`
object may contain only those names; every value is a string of at most 512 UTF-8 bytes. The 16 KiB
whole-body limit still applies. Empty parameter values are valid. Any field or parameter not named
by the policy rejects the delivery with `400` before the event ID is consumed.

`sessionSelectors` is valid only when the stored action is `prompt_session`. A delivery may carry
exactly one selector:

```json
{"target":{"sessionId":"s_abc123"}}
{"target":{"branch":"fix/issue-1099"}}
{"target":{"pullRequest":"https://github.com/acme/widget/pull/42"}}
```

Branch names match the runner-authoritative branch of a session-linked worktree. Pull requests
match their canonical forge URL (an optional trailing slash is ignored). Selection succeeds only
when exactly one non-archived owning session is idle; no idle owner or multiple idle owners returns
`409`. A selector changes only the target session ID inside the accepted action snapshot. The
selected session's runner and existing guardrails still govern delivery.

### Prompt templates and session parameter context

The stored `create_session` prompt or `prompt_session` text is the template. Configurable delivery
fields are not available for workflow actions. A session-action template may place delivered
content with these references:

```text
Work issue {{delivery.parameters.issue}}.
{{delivery.prompt}}
```

If delivered prompt text is allowed but the template has no `{{delivery.prompt}}` reference, the
text is appended to the stored template. Every delivered parameter is also visible to the launched
or prompted session in a machine-readable preamble, so a skill does not need to parse prose:

```text
<automation-trigger-delivery>
{"triggerId":"atr_...","eventId":"github-42","parameters":{"issue":"42"}}
</automation-trigger-delivery>
```

The preamble is followed by a blank line and the rendered stored template. For a target override it
also contains `"targetSelector":"branch|pull_request|session_id"`, never the selector value. The
single JSON line escapes less-than characters as `\u003c`, so delivered values cannot imitate the
closing-tag delimiter; JSON decoding restores the original parameter string. The
`triggerId` and `eventId` are the inbound correlation pair; the accepted invocation adds an
`invocationId`, and dispatch adds an `executionId`. These four identities let downstream work and
audit history correlate one signed delivery without repeating its content.

#### Outbound event integration boundary

Issue #1099 provides the following reusable guarantees for outbound-event work:

- `automation_trigger_invocations.invocation_id` is generated once when a signed delivery is
  accepted, returned as `invocationId`, and retained as the stable invocation identity. The row's
  `execution_id` links it to the claimed automation execution.
- Delivery parameters have already passed the trigger policy's name allowlist, string-only shape,
  count, and UTF-8 byte bounds before acceptance. The exact signed body is not stored; only its
  SHA-256 digest is retained. Accepted values are currently materialized into the private action
  snapshot and machine preamble, while public invocation and execution views expose only parameter
  names and other content-free provenance.
- For a `create_session` action, the deterministic session ID is staged durably on the execution
  and its start command before the session row is created or the command is activated. Existing
  session prompts retain the same invocation-to-execution-to-command correlation without changing
  the target session's origin.

This is a delivery boundary, not yet a session-origin or outbound-event schema. Issue #1100 must
add a first-class accepted-parameter map from the already validated values; it must not parse the
rendered prompt or retain the raw signed request. For created sessions it must also copy
`invocationId` and that map into durable session-origin metadata. The origin write must be in the
same transaction as session creation, or otherwise complete before `session.created` becomes
observable, so an outbound event cannot see a trigger-created session without its origin. #1100
owns the outbound retention and privacy projection of that metadata; #1099's private action
snapshot on an execution is cleared at terminal state, and its invocation snapshot is compacted
after 30 days. Neither is an outbound-event payload store.

`missingReferences: "reject"` returns `400` when the delivery omits a prompt or parameter referenced
by the template, without consuming its event ID. `"use_stored"` substitutes an empty string for the
missing reference, preserving the surrounding stored text. Unsupported reference forms are rejected
when the trigger is created.

A configured webhook body can therefore be:

```json
{
  "eventId": "gh-issues-labeled-42-8f61",
  "prompt": "Work issue #42 using the issue-workflow skill and open a pull request.",
  "parameters": {"issue": "42"},
  "target": {"branch": "fix/issue-42"}
}
```

A configured chat-ops body carries the same optional fields alongside its required `command` and
`sender` fields.

Compute the signature over this UTF-8 string, where `body_sha256` is lowercase hex:

```text
v1
<timestamp>
<nonce>
<triggerId>
<body_sha256>
```

Use the complete one-time secret, including its `wollipogwhsec_` or legacy `mamwhsec_` prefix, as
the HMAC-SHA256 key. Prefix the resulting lowercase hex digest with `v1=`. The HMAC contract is
unchanged, and this legacy-secret deterministic vector remains part of the compatibility contract:

```text
secret:     mamwhsec_test_vector
triggerId:  atr_1
timestamp:  100
nonce:      nonce_1234567890
body:       {"eventId":"delivery-1"}
body sha:   e255cceb3b8d1d9be8bf7fc330b15f076b80e8c5bf8004ac1f0bcf5c4a6ea866
signature:  v1=14d0fa8cf245dbadb20187f7141f70136ba1755f8750e4cf8fb9ea3ea7acff99
```

Node.js signing example:

```js
import { createHash, createHmac, randomBytes } from "node:crypto";

const body = Buffer.from(JSON.stringify({
  eventId: "deploy:123",
  prompt: "Investigate deployment 123.",
  parameters: { deployment: "123" },
}), "utf8");
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(18).toString("base64url");
const bodySha256 = createHash("sha256").update(body).digest("hex");
const input = `v1\n${timestamp}\n${nonce}\n${triggerId}\n${bodySha256}`;
const signature = `v1=${createHmac("sha256", secret).update(input, "utf8").digest("hex")}`;
```

Send `body` without reserializing it after signing.

## Delivery semantics and bounds

The pair `(triggerId, eventId)` is the durable idempotency key. The prompt, parameters, and target
are part of the signed raw bytes and body digest. Replaying the same exact delivery
returns the original public receipt and never launches a second action, including while the
automation is paused or after retention compaction. Reusing an event ID with different raw bytes
returns `409`. A newly accepted delivery returns `200` when it can be dispatched immediately or
`202` while it remains pending under runner or concurrency policy.

All schedule policies apply: runner `wait`/bounded `expire`/`alternate`, concurrency
`wait`/`skip`/`parallel`, action ceilings, notifications, and protocol-v53 exact runner acceptance.
The automation's enabled switch is the master pause for both cron and triggers. Pausing, deleting
the automation, or revoking the trigger rejects pending unclaimed deliveries; re-enabling cannot
resurrect them. Trigger executions have their own idempotency key and do not advance `nextFireAt`.

Each trigger accepts at most 30 new verified event IDs per rolling minute and retains at most 100
pending invocations; the control plane retains at most 1,000 pending trigger invocations globally.
Verified exact duplicates bypass the new-delivery rate bound. Changing a prompt, parameter, or
target while reusing an accepted event ID returns `409`. A bounded response is `429` with
`Retry-After: 60`. After 30 days, terminal inbox rows discard the accepted action snapshot,
content-free delivery metadata, and chat-ops sender hash. A compact tombstone retains only the event/body fingerprint and public receipt
fields needed to return exact duplicates and reject conflicts permanently. The trigger's lifetime
accepted-delivery count, last-accepted timestamp, execution idempotency keys, and normal automation
audit history remain subject to their own retention rules.

Other errors are `400` for malformed bodies, `401` for missing/invalid/stale signatures, `409` for
an unavailable automation or conflicting event ID, `413` for a body over 16 KiB, and `415`
for the wrong media type or compressed body. Do not retry `400`, `401`, `409`, `413`, or `415`
without changing the request or operator state that caused it.

## Operations and secret boundary

Trigger ingress works only while the control plane is online. An external provider may send while
a runner is offline, in which case the durable inbox applies runner policy, but turning off the
control-plane host makes the HTTP endpoint unavailable. Follow the always-on deployment guidance
in [durable automations](./automations.md), keep host clocks synchronized, and expose the endpoint
only through HTTPS or a private authenticated network.

Trigger signing secrets are symmetric credentials stored in the control-plane SQLite database so
the server can verify HMACs. Database files, WAL files, online backups, crash dumps, and operators
with database access are therefore credential-bearing. Encrypt and access-control backups, avoid
copying them into tickets or source control, rotate affected trigger secrets after suspected
exposure, and revoke unused triggers. The public trigger list, invocation response, execution audit
view, audit detail, and runner receipt journal never expose the secret, raw request body, accepted
content-bearing spec snapshot, parameter values, prompt text, selector value, or sender identity.
Invocation and execution audit views expose only which optional fields were carried, sorted
parameter names, selector kind, and the delivered prompt's SHA-256 digest. Anyone who can sign a
delivery can put text in front of the agent, but the session still runs under the stored action's
governance and finite ceilings. Broader secret-reference and external secret-store work belongs to
roadmap item 11.
