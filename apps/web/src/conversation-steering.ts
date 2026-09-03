import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type QueuedPromptView,
  type SessionView,
  type SteeringAttemptView,
} from "@wollipog/protocol";

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

export type SteeringReceiptTone = "pending" | "success" | "warning" | "danger" | "neutral";

export interface SteeringReceiptPresentation {
  label: string;
  tone: SteeringReceiptTone;
  actionRequired: boolean;
  detail?: string;
}

/** A slow draft read must be repeated whenever the reservation generation it observed was
 * released or replaced before hydration completed. */
export function shouldReloadReservedDraft(
  capturedToken: symbol | undefined,
  currentToken: symbol | undefined,
): boolean {
  return capturedToken !== undefined && currentToken !== capturedToken;
}

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
        "Conversation steering",
      ),
    };
  }
  if (!input.runnerOnline) {
    return { available: false, reason: "The runner is offline." };
  }
  if (input.supportsSteering !== true) {
    return {
      available: false,
      reason: "The active provider has not verified conversation steering support.",
    };
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
      reason: "Send a normal prompt to resume the held queue before steering.",
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
        "Queued prompt editing",
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

/** Stable visible state for a durable control-plane steering receipt. */
export function steeringReceiptPresentation(
  attempt: SteeringAttemptView,
): SteeringReceiptPresentation {
  if (attempt.resolution?.state === "applied") {
    return attempt.resolution.action === "queue_again"
      ? { label: "Queued Again", tone: "neutral", actionRequired: false }
      : { label: "Dismissed", tone: "neutral", actionRequired: false };
  }
  if (attempt.state === "uncertain") {
    const pendingAction = attempt.resolution?.state === "pending"
      ? attempt.resolution.action === "queue_again" ? "Queue Again" : "Dismiss"
      : undefined;
    return {
      label: "Delivery Uncertain",
      tone: "warning",
      actionRequired: pendingAction === undefined,
      ...(pendingAction ? { detail: `${pendingAction} is pending.` } : {}),
    };
  }
  switch (attempt.state) {
    case "pending":
      return { label: "Steering…", tone: "pending", actionRequired: false };
    case "accepted":
      return { label: "Accepted", tone: "success", actionRequired: false };
    case "converted_to_queue":
      return { label: "Converted to Queue", tone: "neutral", actionRequired: false };
    case "rejected":
      return { label: "Rejected", tone: "danger", actionRequired: false };
  }
}
