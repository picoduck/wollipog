# Signed automation triggers

Webhook and chat-ops triggers are authenticated, out-of-band ways to invoke an existing durable
automation. They select no action and accept no prompt, runner, workflow, approval, callback URL,
or limit overrides: the control plane executes the automation revision that was current when it
accepted the delivery. Cron scheduling remains independent.

Create a trigger from the Automations view or through the paired-device-authenticated management
API. Creation and rotation return a 256-bit HMAC secret once. Copy it immediately; normal reads
never return it. Rotation invalidates the previous secret immediately, and revocation clears the
active row's secret and rejects unclaimed deliveries. Older SQLite pages or backups can still
contain prior key material, so revocation is not a substitute for protecting or expiring backups.
Newly created and rotated secrets use the `wollipogwhsec_` prefix followed by exactly 43 base64url
characters. Existing `mamwhsec_` secrets remain valid until they are rotated or revoked.

Management routes are:

- `GET /api/automations/:id/triggers`
- `POST /api/automations/:id/triggers` with `{"kind":"webhook|chatops","name":"..."}`
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

A webhook body has exactly one field:

```json
{"eventId":"provider-stable-delivery-id"}
```

A chat-ops body has exactly these fields:

```json
{"eventId":"provider-stable-event-id","command":"run","sender":"provider actor identity"}
```

The command is deliberately restricted to `run`. The sender is never retained verbatim; the
control plane stores only its SHA-256 digest for audit attribution. Event IDs are 1-128 characters
from `A-Z a-z 0-9 . _ : -`. They appear in durable invocation/execution history, so never put
credentials, message content, or personal data in an event ID.

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

const body = Buffer.from(JSON.stringify({ eventId: "deploy:123" }), "utf8");
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(18).toString("base64url");
const bodySha256 = createHash("sha256").update(body).digest("hex");
const input = `v1\n${timestamp}\n${nonce}\n${triggerId}\n${bodySha256}`;
const signature = `v1=${createHmac("sha256", secret).update(input, "utf8").digest("hex")}`;
```

Send `body` without reserializing it after signing.

## Delivery semantics and bounds

The pair `(triggerId, eventId)` is the durable idempotency key. Replaying the same exact delivery
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
Verified exact duplicates bypass the new-delivery rate bound. A bounded response is `429` with
`Retry-After: 60`. After 30 days, terminal inbox rows discard the accepted action snapshot and
chat-ops sender hash. A compact tombstone retains only the event/body fingerprint and public receipt
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
exposure, and revoke unused triggers. The public trigger list, invocation response, audit detail,
and runner receipt journal never expose the secret, raw request body, body digest, accepted spec
snapshot, or sender identity. Broader secret-reference and external secret-store work belongs to
roadmap item 11.
