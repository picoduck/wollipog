import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type DurableSessionCommandErrorCode,
  type QueuedPromptView,
  type SessionCommandInvocationErrorCode,
  type SessionView,
  type SteeringAttemptView,
  type SteerResultReason,
} from "@wollipog/protocol";
import { statusMeta, type StatusTone, type StatusValue } from "./status-meta.js";

export interface ConversationSteeringAvailabilityInput {
  runnerProtocolVersion: number | null | undefined;
  runnerOnline: boolean;
  sessionStatus: SessionView["status"];
  activeTurnId: string | null | undefined;
  supportsSteering: boolean | null | undefined;
  policyPaused: boolean;
  inputPending: boolean;
  queueHeld: boolean;
  stopPending: boolean;
}

export type SteeringAvailability =
  | { available: true }
  | { available: false; reason: string };

export type MessageReceiptStatus = StatusValue<"messageReceipt">;

export interface SteeringReceiptPresentation {
  /** The receipt's place in the one message-receipt vocabulary (§11.2). */
  status: MessageReceiptStatus;
  label: string;
  tone: StatusTone;
  actionRequired: boolean;
  /** Why it ended this way, in words for people (`deliveryReason`). */
  reason?: string;
  detail?: string;
}

/** Every code a sent message's receipt can carry: a steering result, a durable prompt failure or
 * a provider command failure. */
export type DeliveryReasonCode =
  | SteerResultReason
  | DurableSessionCommandErrorCode
  | SessionCommandInvocationErrorCode;

/** What a receipt says when its code is missing or unknown. */
export const DELIVERY_REASON_FALLBACK = "Wollipog couldn't confirm this message was delivered.";

/** One sentence per code, for people (§17.2). The record is exhaustive, so a new protocol code
 * fails typechecking until it has words here. Raw provider text stays behind Show Details. */
const DELIVERY_REASONS: Record<DeliveryReasonCode, string> = {
  accepted: "The agent took this message into the current turn.",
  stale_turn: "The turn ended before this could steer it.",
  no_active_provider_turn: "No turn was running to steer.",
  unsupported_protocol: "This machine needs an update before it can steer a turn.",
  unsupported_driver: "This agent can't take messages during a turn.",
  configuration_mismatch: "The session's settings changed before this could steer the turn.",
  policy_blocked: "A guardrail stopped this message.",
  governance_blocked: "A governance rule stopped this message.",
  queue_item_absent: "The queued message was already gone.",
  queue_item_started: "The queued message had already started.",
  queue_capacity_exceeded: "The queue was full, so this message wasn't sent.",
  provider_rejected: "The agent didn't accept this message.",
  transport_uncertain: DELIVERY_REASON_FALLBACK,
  history_integrity_failure: "The conversation history couldn't be checked, so this message wasn't sent.",
  COMMAND_ID_CONFLICT: "Another message already had this message's delivery slot.",
  COMMAND_EXPIRED: "This message waited too long and wasn't sent.",
  INVALID_COMMAND: "This message couldn't be sent as written.",
  SESSION_NOT_FOUND: "The session wasn't on its machine, so this message wasn't sent.",
  QUEUE_FULL: "The queue was full, so this message wasn't sent.",
  COMMAND_CANCELLED: "This message was canceled before it was sent.",
  PROVIDER_AUTHENTICATION_REQUIRED: "Sign-in was dismissed, so this message wasn't sent.",
  WORKTREE_RECOVERY_REQUIRED: "This session's worktree needs recovery before this message can be sent.",
  RECEIPT_STORE_FULL: "Wollipog had no room to track this message, so it wasn't sent.",
  COMMAND_CATALOG_STALE: "The agent's commands changed, so this command wasn't run.",
  COMMAND_UNAVAILABLE: "This command isn't available right now.",
  COMMAND_MODE_UNSUPPORTED: "This agent can't run this command that way.",
};

/** A receipt's reason in plain words. Unknown and missing codes say delivery is unconfirmed. */
export function deliveryReason(code: string | null | undefined): string {
  return code != null && Object.hasOwn(DELIVERY_REASONS, code)
    ? DELIVERY_REASONS[code as DeliveryReasonCode]
    : DELIVERY_REASON_FALLBACK;
}

/** A slow draft read must be repeated whenever the reservation generation it observed was
 * released or replaced before hydration completed. */
export function shouldReloadReservedDraft(
  capturedToken: symbol | undefined,
  currentToken: symbol | undefined,
): boolean {
  return capturedToken !== undefined && currentToken !== capturedToken;
}

/** Why nothing can steer when the agent itself has not said it takes messages mid-turn. The queue
 * tray names the agent instead (#2178). */
export const STEERING_UNVERIFIED_REASON = "The active provider has not verified conversation steering support.";

/** UI-known direct steering gates. Server-side workflow, automation, and pod ownership remain
 * authoritative because they are deliberately absent from SessionView. */
export function conversationSteeringAvailability(
  input: ConversationSteeringAvailabilityInput,
): SteeringAvailability {
  if (!runnerSupportsProtocol(input.runnerProtocolVersion, "conversationSteering")) {
    return {
      available: false,
      reason: runnerCapabilityRequirement(
        input.runnerProtocolVersion,
        "conversationSteering",
        "conversation steering",
      ),
    };
  }
  if (!input.runnerOnline) {
    return { available: false, reason: "The runner is offline." };
  }
  if (input.supportsSteering !== true) {
    return { available: false, reason: STEERING_UNVERIFIED_REASON };
  }
  if (input.policyPaused) {
    return {
      available: false,
      reason: "Resolve the guardrail decision before steering the active turn.",
    };
  }
  if (input.inputPending || input.sessionStatus === "input_required") {
    return {
      available: false,
      reason: "Resolve the pending agent input before steering the active turn.",
    };
  }
  if (input.stopPending) {
    return {
      available: false,
      reason: "Wait for the current stop request to settle before steering.",
    };
  }
  if (input.queueHeld) {
    return {
      available: false,
      reason: "Wait for the active turn to settle or resolve the visible control-plane decision before steering.",
    };
  }
  if (input.sessionStatus !== "running" || typeof input.activeTurnId !== "string" || !input.activeTurnId.trim()) {
    return { available: false, reason: "Wait for an active provider turn before steering." };
  }
  return { available: true };
}

/** Queue promotion additionally requires the runner's per-entry affirmative projection. Missing
 * metadata is never treated as support, including during a mixed-version rollout. */
export function queuedPromptSteeringAvailability(
  input: ConversationSteeringAvailabilityInput,
  prompt: QueuedPromptView,
): SteeringAvailability {
  const active = conversationSteeringAvailability(input);
  if (!active.available) return active;
  if (prompt.steeringState === "promoting") {
    return { available: false, reason: "Steering is already in progress for this queued message." };
  }
  if (prompt.steeringState === "uncertain") {
    return { available: false, reason: "Resolve uncertain delivery before steering this queued message." };
  }
  if (prompt.steerable !== true || prompt.steerDisabledReason) {
    return {
      available: false,
      reason: prompt.steerDisabledReason ?? "This queued message is not eligible for steering.",
    };
  }
  return { available: true };
}

/** Queue editing is independent of active-turn steering. The runner's per-entry projection is the
 * authority; missing metadata fails closed during mixed-version rollout. */
export function queuedPromptEditingAvailability(
  input: { runnerProtocolVersion: number | null | undefined; runnerOnline: boolean; requestBusy: boolean },
  prompt: QueuedPromptView,
): SteeringAvailability {
  if (!runnerSupportsProtocol(input.runnerProtocolVersion, "queuedPromptEditing")) {
    return {
      available: false,
      reason: runnerCapabilityRequirement(
        input.runnerProtocolVersion,
        "queuedPromptEditing",
        "queued prompt editing",
      ),
    };
  }
  if (!input.runnerOnline) return { available: false, reason: "The runner is offline." };
  if (input.requestBusy) return { available: false, reason: "Wait for the current message action to finish." };
  if (prompt.steeringState) return { available: false, reason: "Resolve steering before editing this queued message." };
  if (prompt.liveQueueObserved !== true) {
    return { available: false, reason: "Wait for live runner admission before editing this queued message." };
  }
  if (prompt.editable !== true || prompt.editDisabledReason) {
    return {
      available: false,
      reason: prompt.editDisabledReason ?? "This queued message cannot be edited safely.",
    };
  }
  return { available: true };
}

function receiptPresentation(
  status: MessageReceiptStatus,
  actionRequired: boolean,
  extra: Pick<SteeringReceiptPresentation, "reason" | "detail"> = {},
): SteeringReceiptPresentation {
  const { label, tone } = statusMeta("messageReceipt", status);
  return { status, label, tone, actionRequired, ...extra };
}

/** Stable visible state for a durable control-plane steering receipt. */
export function steeringReceiptPresentation(
  attempt: SteeringAttemptView,
): SteeringReceiptPresentation {
  if (attempt.resolution?.state === "applied") {
    return attempt.resolution.action === "queue_again"
      ? receiptPresentation("queued", false, { reason: "Waiting for the next turn." })
      : receiptPresentation("dismissed", false);
  }
  if (attempt.state === "uncertain") {
    const pendingAction = attempt.resolution?.state === "pending"
      ? attempt.resolution.action === "queue_again" ? "Queue Again" : "Dismiss"
      : undefined;
    return receiptPresentation("uncertain", pendingAction === undefined, {
      reason: deliveryReason(attempt.reason),
      ...(pendingAction ? { detail: `${pendingAction} is pending.` } : {}),
    });
  }
  switch (attempt.state) {
    case "pending":
      return receiptPresentation("sending", false);
    case "accepted":
      return receiptPresentation("steered", false);
    case "converted_to_queue":
      return receiptPresentation("queued", false, { reason: deliveryReason(attempt.reason) });
    case "rejected":
      return receiptPresentation("not_accepted", false, { reason: deliveryReason(attempt.reason) });
  }
}
