# Outbound events

Outbound event subscriptions send durable, signed lifecycle facts from Wollipog to an external
HTTPS callback. A subscription belongs to one Project or one automation and selects its event
kinds explicitly. Manage subscriptions in the Automations view or through the paired-device API.
Creation and rotation return a 256-bit HMAC secret once; copy it immediately because list, detail,
and delivery-journal reads never return it.

Management routes are:

- `GET /api/outbound-event-subscriptions`
- `POST /api/outbound-event-subscriptions`
- `GET /api/outbound-event-subscriptions/:id`
- `GET /api/outbound-event-subscriptions/:id/deliveries`
- `POST /api/outbound-event-subscriptions/:id/rotate`
- `POST /api/outbound-event-subscriptions/:id/resume`
- `DELETE /api/outbound-event-subscriptions/:id`

A creation body has this shape:

```json
{
  "callbackUrl": "https://events.example.com/wollipog",
  "scope": {"kind": "project", "projectId": "prj_..."},
  "eventKinds": ["session.created", "session.input_required", "pull_request.opened"],
  "includeSessionName": false,
  "includeQuestionTitle": false
}
```

An automation scope uses `{"kind":"automation","automationId":"auto_..."}`. The two content
options default to false and are visible on every subscription card.

## Request and signature contract

Each attempt is one `POST` with the exact UTF-8 JSON bytes used to compute its signature:

```text
Content-Type: application/vnd.wollipog.outbound-event+json
X-Wollipog-Timestamp: <Unix seconds>
X-Wollipog-Nonce: <random URL-safe value>
X-Wollipog-Subscription-Id: <subscription id>
X-Wollipog-Event-Id: <event id>
X-Wollipog-Signature: v1=<lowercase HMAC-SHA256 hex>
```

Compute `body_sha256` over the received bytes. Then compute HMAC-SHA256 with the complete one-time
secret as the key and this signing input:

```text
v1
<timestamp>
<nonce>
<subscriptionId>
<body_sha256>
```

Compare the signature in constant time, reject timestamps outside the receiver's chosen clock-skew
window, and deduplicate on `eventId`. Rotation invalidates the previous key immediately and aborts
in-flight requests. Revocation clears the active key, aborts in-flight requests, drops every
pending delivery, and prevents new deliveries from being staged.

The receiver must return a 2xx response only after it has durably accepted the event. Wollipog
does not follow redirects.

## Event envelope

Every body is versioned and content-minimized:

```json
{
  "version": "v1",
  "eventId": "oev_...",
  "kind": "session.created",
  "occurredAt": 1789400000000,
  "sessionId": "s_...",
  "projectId": "prj_...",
  "automationId": "auto_...",
  "automationExecutionId": "aex_...",
  "triggerId": "atr_...",
  "triggerInvocationId": "ati_...",
  "parameters": {"issue": "1100"}
}
```

`projectId` is omitted for a deliberately unassigned No Project session. Automation fields appear
only for an automation-created session. For a signed-trigger-created session, `parameters` is the
already validated accepted string map from the inbound trigger. Wollipog stores that map as
first-class invocation data and copies the invocation identity and map into durable session origin
in the same transaction that creates the session and stages `session.created`. It never reconstructs
parameters by parsing a rendered prompt or retains the raw inbound signed body.

The supported kinds and their additive fields are:

- `session.created`, `session.idle`, `session.completed`, `session.failed`, and `session.stopped`:
  the base session and origin fields;
- `session.input_required`: base fields, plus `questionTitle` only when that subscription explicitly
  enables the option;
- `pull_request.opened`: `branch` and `pullRequest` with `url` and `state: "open"`;
- `pull_request.merged`: the same fields with `state: "merged"` and the forge-verified `headOid`;
- `checks.failed`: `branch`, the pull-request URL, and `checks` with a bounded failing count, names,
  and optional checks URL. A new event is emitted only when the failing-set signature changes;
- `cost.checkpoint`: `cost.costUsd` and `cost.checkpointUsd` when the runner supplied a structured
  threshold;
- `cost.budget_exhausted`: `cost.costUsd` and `cost.budgetUsd` when available.

`sessionName` appears only when `includeSessionName` is true. `questionTitle` appears only when
`includeQuestionTitle` is true. Prompt text, transcripts, answers, permission context, tool input,
credentials, and signing secrets are never outbound event fields. Delivery-journal reads expose
only event identity, kind, status, attempt count, last attempt, HTTP status, next retry, and a
bounded error reason; they never expose request bodies or secrets.

## Delivery, retries, and retention

Staging is transactional with the source session mutation. Delivery is asynchronous and
**at least once**: a receiver may accept a request before a connection failure prevents Wollipog
from recording its receipt, so receivers must use `eventId` as an idempotency key. A stable source
key suppresses duplicate staging when the same runner snapshot or input-request occurrence is
observed again.

Bounds are fixed:

- at most 100 pending, retrying, or leased deliveries per subscription; reaching the bound pauses
  the subscription with a visible reason;
- at most 16 delivery attempts execute concurrently across the control plane;
- each attempt has a 10-second timeout and each JSON body is at most 16 KiB;
- network failures and 5xx responses retry at 5 seconds, 30 seconds, 2 minutes, 10 minutes, and
  30 minutes after attempts one through five. Failure on attempt six pauses the subscription;
- secret rotation and graceful control-plane shutdown abort in-flight requests without consuming
  a delivery attempt. Rotation retries with the current secret, while shutdown leaves the retry
  durably queued for recovery;
- `410 Gone` never retries and pauses immediately. Redirects are never followed. Other permanent
  HTTP failures do not retry; three consecutive permanent delivery failures pause the subscription;
- terminal receipts are retained for 30 days. Terminal delivery rows discard their request body,
  while content-free journal fields remain until compaction.

Resume clears the pause reason and consecutive-failure counter. It does not recreate a delivery
dropped by revocation or by the pending bound.

## Network and operations boundary

Callbacks must use HTTPS. Literal loopback targets may use HTTP for local development. URLs with
embedded credentials or fragments are rejected. At creation and before every attempt, Wollipog
resolves the hostname and rejects any DNS answer that is private, loopback (unless the URL itself is
the explicit loopback exception), link-local, multicast, or reserved. The validated address is
pinned for that request while TLS still verifies the original hostname, preventing a second DNS
lookup from bypassing validation. Redirects are not followed, so they cannot cross the boundary.

The worker emits structured, secret-free attempt logs keyed by delivery, subscription, event, kind,
attempt, disposition, HTTP status, duration, and whether the durable receipt was recorded. Operators
can answer “what is stuck?” and “why is this paused?” from the subscription state and journal without
exposing callback bodies or credentials. Monitor paused subscriptions, old `nextRetryAt` values,
repeated transport failures, callback latency, and database health. Protect the SQLite file, WAL,
backups, crash dumps, and process memory as credential-bearing material; revocation cannot erase old
secrets from historical backups.
