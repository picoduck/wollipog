import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { randomUUID } from "node:crypto";
import {
  WOLLIPOG_OUTBOUND_EVENT_MEDIA_TYPE,
  type CreateOutboundEventSubscriptionRequest,
  type GitSummaryInfo,
  type GovernanceActor,
  type OutboundEventKind,
  type OutboundEventSubscriptionCredential,
  type OutboundEventSubscriptionView,
} from "@wollipog/protocol";
import { newAutomationTriggerSecret, signAutomationTrigger } from "./automation-trigger-ingress.js";
import type { ClaimedOutboundEventDelivery, ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { ServiceResult } from "./sessions.js";

export const OUTBOUND_EVENT_MAX_CONCURRENCY = 16;
export const OUTBOUND_EVENT_REQUEST_TIMEOUT_MS = 10_000;
export const OUTBOUND_EVENT_LEASE_MS = 30_000;
export const OUTBOUND_EVENT_RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;
const OUTBOUND_EVENT_KINDS = new Set<OutboundEventKind>([
  "session.created", "session.input_required", "session.idle", "session.completed",
  "session.failed", "session.stopped", "pull_request.opened", "pull_request.merged",
  "checks.failed", "cost.checkpoint", "cost.budget_exhausted",
]);

type ResolvedTarget = { url: URL; address: string; family: 4 | 6 };
type Lookup = typeof dnsLookup;
type DeliveryResponse = { statusCode: number };
type Transport = (target: ResolvedTarget, delivery: ClaimedOutboundEventDelivery,
  signal: AbortSignal) => Promise<DeliveryResponse>;
type Logger = {
  info: (fields: Record<string, unknown>, message?: string) => void;
  warn: (fields: Record<string, unknown>, message?: string) => void;
};
type DeliveryAbortReason = "timeout" | "rotation" | "revocation" | "shutdown";
type OutboundCheckHub = Pick<Hub, "isRunnerOnline" | "requestFromRunner">;

function ok<T>(data: T, status = 200): ServiceResult<T> {
  return { ok: true, status, data };
}
function fail<T>(error: string, status = 400): ServiceResult<T> {
  return { ok: false, status, error };
}
function shortId(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "").slice(0, 20);
}

function ipv4Parts(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

const BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");

/** Fail closed for every non-global address. Literal loopback is an explicit local-development
 * exception; hostnames resolving to loopback do not inherit it, which prevents DNS rebinding. */
export function isBlockedOutboundAddress(address: string): boolean {
  const family = isIP(address);
  const mappedDotted = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedDotted) return isBlockedOutboundAddress(mappedDotted);
  const mappedHex = address.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    return isBlockedOutboundAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return family === 4
    ? BLOCKED_ADDRESSES.check(address, "ipv4")
    : family === 6 ? BLOCKED_ADDRESSES.check(address, "ipv6") : true;
}

function isLiteralLoopback(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const v4 = ipv4Parts(hostname);
  return Boolean(v4 && v4[0] === 127) || hostname === "::1" || hostname === "[::1]";
}

function isLoopbackAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  return Boolean(v4 && v4[0] === 127) || address.toLowerCase() === "::1";
}

export function validateOutboundCallbackUrl(raw: string): ServiceResult<URL> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) {
    return fail("callback URL must be between 1 and 2,048 characters");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("callback URL is invalid");
  }
  if (url.username || url.password) return fail("callback URL must not contain credentials");
  if (url.hash) return fail("callback URL must not contain a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLiteralLoopback(url.hostname))) {
    return fail("callback URL must use HTTPS except for a literal loopback target");
  }
  if (!url.hostname || url.hostname.includes("%")) return fail("callback URL hostname is invalid");
  return ok(url);
}

export async function resolveOutboundTarget(raw: string, lookup: Lookup = dnsLookup): Promise<ServiceResult<ResolvedTarget>> {
  const parsed = validateOutboundCallbackUrl(raw);
  if (!parsed.ok || !parsed.data) return fail(parsed.error ?? "callback URL is invalid", parsed.status);
  const url = parsed.data;
  const literalLoopback = isLiteralLoopback(url.hostname);
  const lookupHostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = isIP(lookupHostname)
      ? [{ address: lookupHostname, family: isIP(lookupHostname) }]
      : await lookup(lookupHostname, { all: true, verbatim: true });
  } catch {
    return fail("callback hostname could not be resolved");
  }
  if (addresses.length === 0) return fail("callback hostname did not resolve to an address");
  if (addresses.some(({ address }) => literalLoopback
    ? !isLoopbackAddress(address)
    : isBlockedOutboundAddress(address))) {
    return fail("callback hostname resolves to a private, loopback, link-local, or reserved address");
  }
  const selected = addresses.find(({ address, family }) =>
    (family === 4 || family === 6) && (literalLoopback
      ? isLoopbackAddress(address)
      : !isBlockedOutboundAddress(address)));
  return selected
    ? ok({ url, address: selected.address, family: selected.family as 4 | 6 })
    : fail("callback hostname did not resolve to an allowed address");
}

function defaultTransport(
  target: ResolvedTarget,
  delivery: ClaimedOutboundEventDelivery,
  signal: AbortSignal,
): Promise<DeliveryResponse> {
  return new Promise((resolve, reject) => {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const nonce = randomUUID().replace(/-/g, "");
    const signature = signAutomationTrigger(
      delivery.secret,
      delivery.subscriptionId,
      timestamp,
      nonce,
      Buffer.from(delivery.payloadJson),
    );
    const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: "POST",
      signal,
      servername: target.url.protocol === "https:" && isIP(target.url.hostname) === 0
        ? target.url.hostname
        : undefined,
      family: target.family,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      headers: {
        "content-type": WOLLIPOG_OUTBOUND_EVENT_MEDIA_TYPE,
        "content-length": Buffer.byteLength(delivery.payloadJson),
        "x-wollipog-timestamp": timestamp,
        "x-wollipog-nonce": nonce,
        "x-wollipog-signature": signature,
        "x-wollipog-subscription-id": delivery.subscriptionId,
        "x-wollipog-event-id": delivery.eventId,
      },
    }, (response) => {
      // Webhook response bodies are not part of the contract. Close immediately after the status
      // so a receiver cannot retain sockets (and escape the timeout/concurrency bounds) by
      // trickling an unbounded response body after sending headers.
      response.destroy();
      resolve({ statusCode: response.statusCode ?? 0 });
    });
    request.on("error", reject);
    request.end(delivery.payloadJson);
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("delivery aborted"));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Error("delivery aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

export class OutboundEventsService {
  private readonly active = new Map<string, Set<AbortController>>();
  private activeTick?: Promise<void>;

  constructor(
    private readonly db: ControlPlaneDb,
    private readonly logger: Logger,
    private readonly lookup: Lookup = dnsLookup,
    private readonly transport: Transport = defaultTransport,
    private readonly requestTimeoutMs = OUTBOUND_EVENT_REQUEST_TIMEOUT_MS,
  ) {}

  async create(
    request: CreateOutboundEventSubscriptionRequest,
    actor: GovernanceActor,
    now = Date.now(),
  ): Promise<ServiceResult<OutboundEventSubscriptionCredential>> {
    if (!request || typeof request !== "object" || !request.scope ||
        !Array.isArray(request.eventKinds) || request.eventKinds.length === 0 ||
        request.eventKinds.length > OUTBOUND_EVENT_KINDS.size ||
        new Set(request.eventKinds).size !== request.eventKinds.length ||
        request.eventKinds.some((kind) => !OUTBOUND_EVENT_KINDS.has(kind)) ||
        typeof request.callbackUrl !== "string" ||
        (request.includeSessionName !== undefined && typeof request.includeSessionName !== "boolean") ||
        (request.includeQuestionTitle !== undefined && typeof request.includeQuestionTitle !== "boolean") ||
        (request.scope.kind === "project" && typeof request.scope.projectId !== "string") ||
        (request.scope.kind === "automation" && typeof request.scope.automationId !== "string") ||
        (request.scope.kind !== "project" && request.scope.kind !== "automation")) {
      return fail("outbound event subscription is malformed");
    }
    const target = await resolveOutboundTarget(request.callbackUrl, this.lookup);
    if (!target.ok || !target.data) return fail(target.error ?? "callback target is invalid", target.status);
    const secret = newAutomationTriggerSecret();
    const subscription = this.db.createOutboundEventSubscription({
      subscriptionId: shortId("oes_"),
      callbackUrl: target.data.url.toString(),
      secret,
      scope: request.scope,
      eventKinds: request.eventKinds,
      includeSessionName: request.includeSessionName === true,
      includeQuestionTitle: request.includeQuestionTitle === true,
      actor,
      now,
    });
    return subscription ? ok({ subscription, secret }, 201) : fail("subscription scope was not found", 404);
  }

  list(): OutboundEventSubscriptionView[] {
    return this.db.listOutboundEventSubscriptions();
  }

  get(subscriptionId: string): ServiceResult<OutboundEventSubscriptionView> {
    const subscription = this.db.getOutboundEventSubscription(subscriptionId);
    return subscription ? ok(subscription) : fail("outbound event subscription not found", 404);
  }

  rotate(subscriptionId: string, now = Date.now()): ServiceResult<OutboundEventSubscriptionCredential> {
    this.abortSubscription(subscriptionId, "rotation");
    const secret = newAutomationTriggerSecret();
    const subscription = this.db.rotateOutboundEventSubscription({ subscriptionId, secret, now });
    return subscription ? ok({ subscription, secret }) : fail("outbound event subscription not found", 404);
  }

  resume(subscriptionId: string, now = Date.now()): ServiceResult<OutboundEventSubscriptionView> {
    const subscription = this.db.resumeOutboundEventSubscription(subscriptionId, now);
    return subscription ? ok(subscription) : fail("outbound event subscription not found", 404);
  }

  revoke(subscriptionId: string, now = Date.now()): ServiceResult<{ revoked: true }> {
    this.abortSubscription(subscriptionId, "revocation");
    return this.db.revokeOutboundEventSubscription(subscriptionId, now)
      ? ok({ revoked: true })
      : fail("outbound event subscription not found", 404);
  }

  deliveries(subscriptionId: string, limit?: number): ServiceResult<ReturnType<ControlPlaneDb["listOutboundEventDeliveries"]>> {
    const deliveries = this.db.listOutboundEventDeliveries(subscriptionId, limit);
    return deliveries ? ok(deliveries) : fail("outbound event subscription not found", 404);
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.activeTick) return this.activeTick;
    const operation = (async () => {
      const activeCount = [...this.active.values()].reduce((sum, controllers) => sum + controllers.size, 0);
      const capacity = OUTBOUND_EVENT_MAX_CONCURRENCY - activeCount;
      if (capacity <= 0) return;
      const deliveries = this.db.claimOutboundEventDeliveries(now, capacity, OUTBOUND_EVENT_LEASE_MS);
      await Promise.all(deliveries.map((delivery) => this.deliver(delivery, now)));
      this.db.compactOutboundEventDeliveries(now);
    })();
    this.activeTick = operation;
    try { await operation; } finally {
      if (this.activeTick === operation) this.activeTick = undefined;
    }
  }

  async close(): Promise<void> {
    for (const subscriptionId of [...this.active.keys()]) this.abortSubscription(subscriptionId, "shutdown");
    await this.activeTick;
  }

  recordChecksFromSummary(
    sessionId: string,
    summary: GitSummaryInfo,
    now = Date.now(),
    expectedPullRequestUrl?: string,
  ): boolean {
    if (!summary.pr || summary.pr.state.toUpperCase() !== "OPEN" ||
        (expectedPullRequestUrl !== undefined && summary.pr.url !== expectedPullRequestUrl) ||
        !summary.checks || !Number.isSafeInteger(summary.checks.failing) || summary.checks.failing < 0 ||
        !Array.isArray(summary.checks.failingNames) ||
        summary.checks.failingNames.some((name) => typeof name !== "string")) return false;
    return this.db.recordOutboundCheckObservation({
      sessionId,
      branch: summary.branch,
      pullRequestUrl: summary.pr.url,
      failing: summary.checks.failing,
      failingNames: summary.checks.failingNames,
      ...(summary.checks.url ? { checksUrl: summary.checks.url } : {}),
      now,
    });
  }

  async sweepCheckObservations(hub: OutboundCheckHub, now = Date.now()): Promise<void> {
    for (const candidate of this.db.outboundCheckObservationCandidates()) {
      // Advance every selected candidate, including offline and temporarily failing runners, so
      // one cohort cannot occupy the bounded scan forever and starve newer open pull requests.
      this.db.markOutboundCheckObservationAttempt(candidate.sessionId, candidate.pullRequestUrl, now);
      if (!hub.isRunnerOnline(candidate.runnerId)) continue;
      const requestId = randomUUID();
      try {
        const result = await hub.requestFromRunner(candidate.runnerId, requestId, {
          type: "git_action",
          requestId,
          sessionId: candidate.sessionId,
          worktreePath: candidate.worktreePath,
          action: { kind: "summary" },
          timeoutMs: 30_000,
        }, 30_000);
        if (result.type === "git_result" && result.ok && result.data?.summary) {
          if (!this.db.outboundCheckObservationCandidateIsCurrent(candidate)) continue;
          this.recordChecksFromSummary(candidate.sessionId, result.data.summary, Date.now(), candidate.pullRequestUrl);
        }
      } catch (error) {
        this.logger.warn({
          event: "outbound_check_observation",
          sessionId: candidate.sessionId,
          error: error instanceof Error ? error.message : String(error),
        }, "Outbound check observation deferred");
      }
    }
  }

  private async deliver(delivery: ClaimedOutboundEventDelivery, claimedAt: number): Promise<void> {
    const controller = new AbortController();
    const controllers = this.active.get(delivery.subscriptionId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.active.set(delivery.subscriptionId, controllers);
    const timeout = setTimeout(() => controller.abort("timeout" satisfies DeliveryAbortReason), this.requestTimeoutMs);
    timeout.unref?.();
    let statusCode: number | undefined;
    let error: string | undefined;
    const startedAt = Date.now();
    try {
      const target = await abortable(resolveOutboundTarget(delivery.callbackUrl, this.lookup), controller.signal);
      if (!target.ok || !target.data) throw new Error(target.error ?? "Callback target is invalid");
      const response = await this.transport(target.data, delivery, controller.signal);
      statusCode = response.statusCode;
    } catch (caught) {
      error = controller.signal.reason === "timeout"
        ? "Delivery timed out"
        : controller.signal.aborted
          ? "Delivery was aborted"
        : caught instanceof Error ? caught.message.slice(0, 500) : "Delivery transport failed";
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
      if (controllers.size === 0) this.active.delete(delivery.subscriptionId);
    }
    const now = Date.now();
    const abortReason = controller.signal.reason as DeliveryAbortReason | undefined;
    if (abortReason === "revocation") return;
    let disposition: "delivered" | "retry" | "failed" | "deferred";
    let nextAttemptAt: number | undefined;
    let pauseReason: string | undefined;
    if (abortReason === "rotation" || abortReason === "shutdown") {
      disposition = "deferred";
      nextAttemptAt = now;
      error = abortReason === "rotation"
        ? "Delivery deferred after subscription secret rotation"
        : "Delivery deferred during control-plane shutdown";
    } else if (statusCode !== undefined && statusCode >= 200 && statusCode < 300) {
      disposition = "delivered";
      error = undefined;
    } else if (statusCode === 410) {
      disposition = "failed";
      pauseReason = "Callback returned 410 Gone; the subscription requires operator review";
      error = "Callback returned 410 Gone";
    } else {
      const retryable = statusCode === undefined || statusCode === 503 || (statusCode >= 500 && statusCode <= 599);
      const delay = OUTBOUND_EVENT_RETRY_DELAYS_MS[delivery.attempt - 1];
      if (retryable && delay !== undefined) {
        disposition = "retry";
        nextAttemptAt = claimedAt + delay;
        error ??= statusCode === undefined ? "Delivery transport failed" : `Callback returned ${statusCode}`;
      } else {
        disposition = "failed";
        if (retryable) pauseReason = `Paused after ${delivery.attempt} bounded delivery attempts`;
        error ??= statusCode === undefined ? "Delivery transport failed" :
          statusCode >= 300 && statusCode < 400
            ? `Callback redirect ${statusCode} was not followed`
            : `Callback returned ${statusCode}`;
      }
    }
    const settled = this.db.settleOutboundEventDelivery({
      deliveryId: delivery.deliveryId,
      subscriptionId: delivery.subscriptionId,
      leaseId: delivery.leaseId,
      disposition,
      now,
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      ...(error ? { error } : {}),
      ...(pauseReason ? { pauseReason } : {}),
    });
    const log = disposition === "delivered" || disposition === "deferred"
      ? this.logger.info.bind(this.logger)
      : this.logger.warn.bind(this.logger);
    log({
      event: "outbound_event_delivery",
      deliveryId: delivery.deliveryId,
      subscriptionId: delivery.subscriptionId,
      eventId: delivery.eventId,
      kind: delivery.kind,
      attempt: delivery.attempt,
      disposition,
      ...(statusCode === undefined ? {} : { statusCode }),
      durationMs: Math.max(0, now - startedAt),
      receiptRecorded: settled,
    }, "Outbound event delivery settled");
  }

  private abortSubscription(subscriptionId: string, reason: DeliveryAbortReason): void {
    const controllers = this.active.get(subscriptionId);
    if (!controllers) return;
    for (const controller of controllers) controller.abort(reason);
    this.active.delete(subscriptionId);
  }
}
