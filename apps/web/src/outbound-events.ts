import type {
  OutboundEventDeliveryView,
  OutboundEventKind,
  OutboundEventSubscriptionView,
} from "@wollipog/protocol";
import { statusMeta, type StatusMeta, type StatusValue } from "./status-meta.js";

/**
 * What the Outbound Events tab says about a subscription and its deliveries (#2973), in words: the
 * event names, the callback's host and path, a delivery's result and next retry, and the
 * subscription's one badge. Nothing here prints a timestamp, an id or a placeholder dash.
 */

/** The event kinds in the New Subscription dialog's three groups, in the order they are listed. */
export const OUTBOUND_EVENT_GROUPS: ReadonlyArray<{ label: string; kinds: readonly OutboundEventKind[] }> = [
  {
    label: "Sessions",
    kinds: ["session.created", "session.input_required", "session.idle", "session.completed", "session.failed", "session.stopped"],
  },
  { label: "Pull Requests", kinds: ["pull_request.opened", "pull_request.merged", "checks.failed"] },
  { label: "Cost", kinds: ["cost.checkpoint", "cost.budget_exhausted"] },
];

const EVENT_LABELS: Record<OutboundEventKind, string> = {
  "session.created": "Session Created",
  "session.input_required": "Input Required",
  "session.idle": "Session Idle",
  "session.completed": "Session Completed",
  "session.failed": "Session Failed",
  "session.stopped": "Session Stopped",
  "pull_request.opened": "Pull Request Opened",
  "pull_request.merged": "Pull Request Merged",
  "checks.failed": "Checks Failed",
  "cost.checkpoint": "Cost Checkpoint",
  "cost.budget_exhausted": "Budget Exhausted",
};

/** An event kind as a Title Case name: "Session Completed", "Checks Failed". */
export function outboundEventLabel(kind: OutboundEventKind): string {
  return EVENT_LABELS[kind] ?? "Event";
}

/** The kinds in dialog order, so a row lists them the way they were chosen. */
export function orderedEventKinds(kinds: readonly OutboundEventKind[]): OutboundEventKind[] {
  const order = OUTBOUND_EVENT_GROUPS.flatMap((group) => group.kinds);
  return [...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** "1 event", "4 events". */
export function eventCountLabel(count: number): string {
  return `${count} ${count === 1 ? "event" : "events"}`;
}

/** The address a person recognises: host and path, never the scheme, a query or a fragment. */
export function callbackParts(callbackUrl: string): { host: string; hostAndPath: string } {
  try {
    const url = new URL(callbackUrl);
    const path = url.pathname === "/" ? "" : url.pathname;
    return { host: url.host, hostAndPath: `${url.host}${path}` };
  } catch {
    return { host: callbackUrl, hostAndPath: callbackUrl };
  }
}

/** The Callback URL field's error (§8.5), or null when the address is a full HTTPS URL. */
export const CALLBACK_URL_ERROR = "Enter a full HTTPS address, such as https://example.com/hooks.";

export function callbackUrlError(value: string): string | null {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && url.hostname ? null : CALLBACK_URL_ERROR;
  } catch {
    return CALLBACK_URL_ERROR;
  }
}

/** A retry the server deferred (a secret rotation, a shutdown) rather than one a failure caused. */
function deferred(delivery: OutboundEventDeliveryView): boolean {
  return delivery.status === "retrying" && delivery.statusCode === undefined &&
    /^Delivery deferred\b/i.test(delivery.error ?? "");
}

/**
 * What went wrong with the delivery's last attempt, in words ("HTTP 500", "Connection Refused"), or
 * null when it has not failed. A failed or retrying delivery always has an answer.
 */
export function deliveryFailure(delivery: OutboundEventDeliveryView): string | null {
  if (delivery.status !== "failed" && delivery.status !== "retrying") return null;
  if (deferred(delivery)) return null;
  const code = delivery.statusCode;
  if (code !== undefined && (code < 200 || code >= 300)) return `HTTP ${code}`;
  const error = delivery.error ?? "";
  if (/ECONNREFUSED|connection refused/i.test(error)) return "Connection Refused";
  if (/timed out|ETIMEDOUT|timeout/i.test(error)) return "Timed Out";
  // The control plane's own refusals of the resolved address come before the lookup failures, whose
  // wording ("did not resolve to an address") they share.
  if (/private|loopback|reserved|allowed address/i.test(error)) return "Address Not Allowed";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|could not be resolved|did not resolve/i.test(error)) return "Address Not Found";
  if (/ECONNRESET|socket hang up/i.test(error)) return "Connection Reset";
  if (/certificate|CERT_|SSL|TLS/i.test(error)) return "Certificate Error";
  if (/lease expired/i.test(error)) return "Interrupted";
  if (/aborted/i.test(error)) return "Canceled";
  return "Delivery Failed";
}

/** The Deliveries table's Result: the outcome's badge, its label the failure in words. */
export function deliveryResult(delivery: OutboundEventDeliveryView): StatusMeta {
  const failure = deliveryFailure(delivery);
  if (failure) return { ...statusMeta("outbound_delivery", "failed"), label: failure };
  const value: StatusValue<"outbound_delivery"> = delivery.status === "delivered" ? "delivered"
    : delivery.status === "delivering" ? "sending"
      : delivery.status === "dropped" ? "dropped"
        : "pending";
  return statusMeta("outbound_delivery", value);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A span in words: "less than a minute", "1 minute", "6 minutes", "2 hours", "3 days". */
export function spanInWords(ms: number): string {
  const span = Math.max(0, ms);
  const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (span < MINUTE) return "less than a minute";
  if (span < HOUR) return count(Math.round(span / MINUTE), "minute");
  if (span < DAY) return count(Math.round(span / HOUR), "hour");
  return count(Math.round(span / DAY), "day");
}

/**
 * The Deliveries table's Next Retry: "In 6 minutes" while a retry waits, "Due now" once its time has
 * come, "Gave up" when there are no attempts left, and nothing when no retry applies.
 */
export function nextRetryLabel(delivery: OutboundEventDeliveryView, now: number): string | null {
  if (delivery.status === "failed") return "Gave up";
  if (delivery.status !== "retrying" || delivery.nextRetryAt === undefined) return null;
  const wait = delivery.nextRetryAt - now;
  return wait < 30_000 ? "Due now" : `In ${spanInWords(wait)}`;
}


/** The delivery whose attempt settled last: delivered, failed, or failed and waiting to retry. */
export function latestSettledDelivery(deliveries: readonly OutboundEventDeliveryView[]): OutboundEventDeliveryView | undefined {
  let latest: OutboundEventDeliveryView | undefined;
  for (const delivery of deliveries) {
    if (delivery.status !== "delivered" && !deliveryFailure(delivery)) continue;
    const at = delivery.lastAttemptAt ?? delivery.updatedAt;
    if (!latest || at > (latest.lastAttemptAt ?? latest.updatedAt)) latest = delivery;
  }
  return latest;
}

/**
 * The subscription's one badge (§11.1): Delivery Failed when its latest settled delivery failed,
 * which includes a pause the failures caused; otherwise Paused or Active.
 */
export function subscriptionStatus(
  subscription: OutboundEventSubscriptionView,
  deliveries: readonly OutboundEventDeliveryView[],
): StatusValue<"subscription"> {
  const latest = latestSettledDelivery(deliveries);
  if (latest && latest.status !== "delivered") return "delivery_failed";
  return subscription.state === "paused" ? "paused" : "active";
}

/** The row's last delivery, in words: "Last delivered 4 minutes ago", "No deliveries yet". */
export function lastDeliveryLabel(
  subscription: OutboundEventSubscriptionView,
  deliveries: readonly OutboundEventDeliveryView[],
  now: number,
): string {
  const ago = (at: number) => now - at < MINUTE ? "just now" : `${spanInWords(now - at)} ago`;
  const latest = latestSettledDelivery(deliveries);
  if (latest && latest.status !== "delivered") return `Last delivery failed ${ago(latest.lastAttemptAt ?? latest.updatedAt)}`;
  const delivered = Math.max(subscription.lastDeliveredAt ?? 0, latest?.lastAttemptAt ?? latest?.updatedAt ?? 0);
  return delivered > 0 ? `Last delivered ${ago(delivered)}` : "No deliveries yet";
}

/** What the subscription also sends, as the expanded row's "Also Includes", or null when nothing. */
export function alsoIncludesLabel(subscription: Pick<OutboundEventSubscriptionView, "includeSessionName" | "includeQuestionTitle">): string | null {
  if (subscription.includeSessionName && subscription.includeQuestionTitle) return "Session names and question titles";
  if (subscription.includeSessionName) return "Session names";
  if (subscription.includeQuestionTitle) return "Question titles";
  return null;
}
