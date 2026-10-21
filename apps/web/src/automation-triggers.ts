import type {
  AutomationTriggerDeliveryPolicy,
  AutomationTriggerKind,
  AutomationTriggerSessionSelector,
  AutomationTriggerView,
  CreateAutomationTriggerRequest,
} from "@wollipog/protocol";
import { formatCalendarTime } from "./format.js";

/**
 * The words and request shapes of an automation's signed triggers (#2972): what a row says about a
 * trigger, the request New Trigger sends, and the reference How to Call shows. The wire contract
 * itself is docs/automation-triggers.md; nothing here changes it.
 */

/** A trigger's kind as a row and a dialog title say it. */
export const TRIGGER_KIND_LABEL: Record<AutomationTriggerKind, string> = {
  webhook: "Webhook",
  chatops: "Chat-Ops",
};

/** The ways a delivery may choose its session, in the order New Trigger lists them. */
export const SESSION_SELECTORS: ReadonlyArray<readonly [AutomationTriggerSessionSelector, string]> = [
  ["session_id", "Session ID"],
  ["branch", "Branch"],
  ["pull_request", "Pull Request"],
];

/** What New Trigger holds while it is open. */
export interface TriggerDraft {
  name: string;
  /** Let Callers Add Details: without it the trigger takes no delivery policy at all. */
  configurable: boolean;
  allowPrompt: boolean;
  /** As typed: comma-separated names. */
  parameterNames: string;
  missingReferences: AutomationTriggerDeliveryPolicy["missingReferences"];
  sessionSelectors: AutomationTriggerSessionSelector[];
}

export function emptyTriggerDraft(automationName: string, kind: AutomationTriggerKind): TriggerDraft {
  return {
    name: `${automationName} ${kind === "chatops" ? "chat-ops" : "webhook"}`.slice(0, 80),
    configurable: false,
    allowPrompt: false,
    parameterNames: "",
    missingReferences: "reject",
    sessionSelectors: [],
  };
}

/** The typed names, trimmed, without blanks or repeats, in the order typed. */
export function parseParameterNames(text: string): string[] {
  return [...new Set(text.split(",").map((name) => name.trim()).filter(Boolean))];
}

/** The delivery policy a draft asks for; none unless callers may add details. */
export function draftDeliveryPolicy(draft: TriggerDraft): AutomationTriggerDeliveryPolicy | undefined {
  if (!draft.configurable) return undefined;
  return {
    allowPrompt: draft.allowPrompt,
    parameterNames: parseParameterNames(draft.parameterNames),
    missingReferences: draft.missingReferences,
    ...(draft.sessionSelectors.length ? { sessionSelectors: draft.sessionSelectors } : {}),
  };
}

/** The create request for a draft: the same request the trigger form sent before #2972. */
export function createTriggerRequest(kind: AutomationTriggerKind, draft: TriggerDraft): CreateAutomationTriggerRequest {
  const deliveryPolicy = draftDeliveryPolicy(draft);
  return { kind, name: draft.name, ...(deliveryPolicy ? { deliveryPolicy } : {}) };
}

/** Where a trigger is called, or null while this dashboard has no address others can reach. */
export function triggerEndpoint(publicOrigin: string | null, triggerId: string): string | null {
  return publicOrigin ? `${publicOrigin}/hooks/v1/automation-triggers/${triggerId}` : null;
}

/** "a, b and c" (or "a, b or c"). */
function listInWords(items: readonly string[], conjunction: "and" | "or" = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** "Accepts prompt text and issue, run_id", or null for a trigger that takes no details. */
export function triggerAcceptsLabel(policy: AutomationTriggerDeliveryPolicy | undefined): string | null {
  if (!policy) return null;
  const parts = [
    ...(policy.allowPrompt ? ["prompt text"] : []),
    ...(policy.parameterNames.length ? [policy.parameterNames.join(", ")] : []),
    ...(policy.sessionSelectors?.length ? ["a session"] : []),
  ];
  return parts.length ? `Accepts ${listInWords(parts)}` : null;
}

/** "Never called", or "Last called Today, 9:12 AM" with its count as a meta item of its own. */
export function triggerUseLabels(trigger: Pick<AutomationTriggerView, "invocationCount" | "lastInvokedAt">, now: number): string[] {
  if (trigger.invocationCount === 0) return ["Never called"];
  const calls = trigger.invocationCount === 1 ? "1 call" : `${trigger.invocationCount} calls`;
  return trigger.lastInvokedAt === undefined
    ? [calls]
    : [`Last called ${formatCalendarTime(trigger.lastInvokedAt, now)}`, calls];
}

/** The signed request's reference, as How to Call shows it. */
export interface TriggerRequestShape {
  /** The request line and the headers. */
  headers: string;
  /** The body, with each field it may carry. */
  body: string;
  /** The text the signature is computed over. */
  signing: string;
}

/** A trigger not created yet has no ID: the reference names the place it goes. */
const TRIGGER_ID_PLACEHOLDER = "<trigger ID>";

const SELECTOR_TARGET: Record<AutomationTriggerSessionSelector, readonly [string, string]> = {
  session_id: ["sessionId", "<session ID>"],
  branch: ["branch", "<branch>"],
  pull_request: ["pullRequest", "<pull request URL>"],
};

/**
 * The request a trigger of this kind and policy takes (docs/automation-triggers.md): the headers,
 * the body with only the fields it accepts, and the signed text. A body names one target, the first
 * way the trigger may choose its session.
 */
export function triggerRequestShape(
  kind: AutomationTriggerKind,
  policy: AutomationTriggerDeliveryPolicy | undefined,
  triggerId: string = TRIGGER_ID_PLACEHOLDER,
): TriggerRequestShape {
  const body: Record<string, unknown> = { eventId: "<unique event ID>" };
  if (kind === "chatops") {
    body.command = "run";
    body.sender = "<sender>";
  }
  if (policy?.allowPrompt) body.prompt = "<prompt text>";
  if (policy?.parameterNames.length) {
    body.parameters = Object.fromEntries(policy.parameterNames.map((name) => [name, `<${name}>`]));
  }
  const selector = policy?.sessionSelectors?.[0];
  if (selector) {
    const [field, value] = SELECTOR_TARGET[selector];
    body.target = { [field]: value };
  }
  return {
    headers: [
      `POST /hooks/v1/automation-triggers/${triggerId}`,
      "Content-Type: application/vnd.wollipog.automation-trigger+json",
      "X-Wollipog-Timestamp: <Unix seconds>",
      "X-Wollipog-Nonce: <16–128 URL-safe characters>",
      "X-Wollipog-Signature: v1=<HMAC-SHA256 hex>",
    ].join("\n"),
    body: JSON.stringify(body, null, 2),
    signing: ["v1", "<timestamp>", "<nonce>", triggerId, "<body SHA-256 hex>"].join("\n"),
  };
}

/** What How to Call says about a target, when the trigger can choose its session more than one way. */
export function targetChoiceNote(policy: AutomationTriggerDeliveryPolicy | undefined): string | null {
  const selectors = policy?.sessionSelectors ?? [];
  if (selectors.length < 2) return null;
  const fields = selectors.map((selector) => SELECTOR_TARGET[selector][0]);
  return `Send one of ${listInWords(fields, "or")} in target.`;
}
