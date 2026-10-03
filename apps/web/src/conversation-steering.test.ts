import assert from "node:assert/strict";
import test from "node:test";
import type { SteeringAttemptView } from "@wollipog/protocol";
import {
  conversationSteeringAvailability,
  queuedPromptEditingAvailability,
  queuedPromptSteeringAvailability,
  shouldReloadReservedDraft,
  DELIVERY_REASON_FALLBACK,
  deliveryReason,
  steeringReceiptPresentation,
  type ConversationSteeringAvailabilityInput,
  type DeliveryReasonCode,
} from "./conversation-steering.js";

test("slow hydration reloads when its reservation was released or replaced", () => {
  const first = Symbol("first");
  const replacement = Symbol("replacement");
  assert.equal(shouldReloadReservedDraft(undefined, undefined), false);
  assert.equal(shouldReloadReservedDraft(first, first), false);
  assert.equal(shouldReloadReservedDraft(first, undefined), true);
  assert.equal(shouldReloadReservedDraft(first, replacement), true);
});

const available: ConversationSteeringAvailabilityInput = {
  runnerProtocolVersion: 73,
  runnerOnline: true,
  sessionStatus: "running",
  activeTurnId: "turn-a",
  supportsSteering: true,
  policyPaused: false,
  inputPending: false,
  queueHeld: false,
  stopPending: false,
};

function attempt(
  state: SteeringAttemptView["state"],
  patch: Partial<SteeringAttemptView> = {},
): SteeringAttemptView {
  return {
    submissionId: "submission-a",
    turnId: "turn-a",
    source: "direct",
    text: "Change direction",
    state,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

test("direct steering availability requires every UI-known affirmative gate", () => {
  assert.deepEqual(conversationSteeringAvailability(available), { available: true });

  const cases: Array<[Partial<ConversationSteeringAvailabilityInput>, RegExp]> = [
    [{ runnerProtocolVersion: 72 }, /needs a newer runner for conversation steering\./],
    [{ runnerProtocolVersion: undefined }, /needs a newer runner for conversation steering\./],
    [{ runnerOnline: false }, /runner is offline/i],
    [{ supportsSteering: false }, /has not verified/i],
    [{ supportsSteering: undefined }, /has not verified/i],
    [{ policyPaused: true }, /guardrail decision/i],
    [{ inputPending: true }, /pending agent input/i],
    [{ queueHeld: true }, /turn to settle or resolve the visible control-plane decision/i],
    [{ stopPending: true }, /stop request to settle/i],
    [{ sessionStatus: "idle" }, /active provider turn/i],
    [{ sessionStatus: "starting" }, /active provider turn/i],
    [{ activeTurnId: undefined }, /active provider turn/i],
    [{ activeTurnId: "   " }, /active provider turn/i],
  ];
  for (const [patch, reason] of cases) {
    const result = conversationSteeringAvailability({ ...available, ...patch });
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, reason);
  }

  const inputRequired = conversationSteeringAvailability({ ...available, sessionStatus: "input_required" });
  assert.equal(inputRequired.available, false);
  if (!inputRequired.available) assert.match(inputRequired.reason, /pending agent input/i);
});

test("queued promotion requires explicit per-entry eligibility and blocks reservations", () => {
  assert.deepEqual(
    queuedPromptSteeringAvailability(available, { id: "queue-a", text: "Eligible", steerable: true }),
    { available: true },
  );

  const omitted = queuedPromptSteeringAvailability(available, { id: "queue-a", text: "Legacy" });
  assert.equal(omitted.available, false);
  if (!omitted.available) assert.match(omitted.reason, /not eligible/i);

  const projected = queuedPromptSteeringAvailability(available, {
    id: "queue-a",
    text: "Different config",
    steerable: false,
    steerDisabledReason: "The queued configuration differs from the active turn.",
  });
  assert.deepEqual(projected, {
    available: false,
    reason: "The queued configuration differs from the active turn.",
  });

  const contradictory = queuedPromptSteeringAvailability(available, {
    id: "queue-a",
    text: "Contradictory projection",
    steerable: true,
    steerDisabledReason: "Runner projection is inconsistent.",
  });
  assert.deepEqual(contradictory, {
    available: false,
    reason: "Runner projection is inconsistent.",
  });

  const promoting = queuedPromptSteeringAvailability(available, {
    id: "queue-a", text: "Reserved", steerable: true, steeringState: "promoting",
  });
  assert.equal(promoting.available, false);
  if (!promoting.available) assert.match(promoting.reason, /already in progress/i);

  const uncertain = queuedPromptSteeringAvailability(available, {
    id: "queue-a", text: "Uncertain", steerable: true, steeringState: "uncertain",
  });
  assert.equal(uncertain.available, false);
  if (!uncertain.available) assert.match(uncertain.reason, /resolve uncertain delivery/i);

  const oldRunner = queuedPromptSteeringAvailability(
    { ...available, runnerProtocolVersion: 72 },
    { id: "queue-a", text: "Misleading projection", steerable: true },
  );
  assert.equal(oldRunner.available, false);
  if (!oldRunner.available) assert.match(oldRunner.reason, /needs a newer runner for conversation steering\./);
});

test("queued editing requires v99 and affirmative live per-entry eligibility", () => {
  const prompt = {
    id: "queue-a",
    text: "Editable",
    liveQueueObserved: true,
    editable: true,
    editRevision: "qer_opaque",
  } as const;
  assert.deepEqual(queuedPromptEditingAvailability({
    runnerProtocolVersion: 99,
    runnerOnline: true,
    requestBusy: false,
  }, prompt), { available: true });

  for (const [patch, reason] of [
    [{ runnerProtocolVersion: 98 }, /needs a newer runner for queued prompt editing\./],
    [{ runnerOnline: false }, /runner is offline/i],
    [{ requestBusy: true }, /current message action/i],
  ] as const) {
    const result = queuedPromptEditingAvailability({
      runnerProtocolVersion: 99,
      runnerOnline: true,
      requestBusy: false,
      ...patch,
    }, prompt);
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, reason);
  }

  const absentProjection = queuedPromptEditingAvailability({
    runnerProtocolVersion: 99,
    runnerOnline: true,
    requestBusy: false,
  }, { id: "queue-a", text: "Legacy" });
  assert.equal(absentProjection.available, false);
  if (!absentProjection.available) assert.match(absentProjection.reason, /live runner admission/i);

  const immutable = queuedPromptEditingAvailability({
    runnerProtocolVersion: 99,
    runnerOnline: true,
    requestBusy: false,
  }, { ...prompt, editable: false, editDisabledReason: "Slash commands cannot be edited." });
  assert.deepEqual(immutable, { available: false, reason: "Slash commands cannot be edited." });

  const reserved = queuedPromptEditingAvailability({
    runnerProtocolVersion: 99,
    runnerOnline: true,
    requestBusy: false,
  }, { ...prompt, steeringState: "promoting" });
  assert.equal(reserved.available, false);
  if (!reserved.available) assert.match(reserved.reason, /resolve steering/i);
});

test("durable steering receipts map onto the one message-receipt vocabulary with plain reasons", () => {
  assert.deepEqual(steeringReceiptPresentation(attempt("pending")), {
    status: "sending", label: "Sending", tone: "info", actionRequired: false,
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("accepted")), {
    status: "steered", label: "Steered the Current Turn", tone: "success", actionRequired: false,
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("converted_to_queue", { reason: "stale_turn" })), {
    status: "queued", label: "Queued", tone: "neutral", actionRequired: false,
    reason: "The turn ended before this could steer it.",
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("rejected", { reason: "provider_rejected" })), {
    status: "not_accepted", label: "Not Accepted", tone: "danger", actionRequired: false,
    reason: "The agent didn't accept this message.",
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("uncertain", { reason: "transport_uncertain" })), {
    status: "uncertain", label: "Delivery Uncertain", tone: "warning", actionRequired: true,
    reason: "Wollipog couldn't confirm this message was delivered.",
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("uncertain", {
    resolution: { action: "queue_again", state: "pending" },
  })), {
    status: "uncertain", label: "Delivery Uncertain", tone: "warning", actionRequired: false,
    reason: DELIVERY_REASON_FALLBACK, detail: "Queue Again is pending.",
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("uncertain", {
    resolution: { action: "dismiss", state: "pending" },
  })), {
    status: "uncertain", label: "Delivery Uncertain", tone: "warning", actionRequired: false,
    reason: DELIVERY_REASON_FALLBACK, detail: "Dismiss is pending.",
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("uncertain", {
    resolution: { action: "queue_again", state: "applied", queuedPromptId: "queue-new" },
  })), {
    status: "queued", label: "Queued", tone: "neutral", actionRequired: false,
    reason: "Waiting for the next turn.",
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("uncertain", {
    resolution: { action: "dismiss", state: "applied" },
  })), {
    status: "dismissed", label: "Dismissed", tone: "neutral", actionRequired: false,
  });
});

test("deliveryReason speaks to people for every code and falls back for unknown ones", () => {
  assert.equal(deliveryReason("PROVIDER_AUTHENTICATION_REQUIRED"), "Sign-in was dismissed, so this message wasn't sent.");
  assert.equal(deliveryReason("stale_turn"), "The turn ended before this could steer it.");
  for (const unknown of [undefined, null, "", "future_code", "constructor", "__proto__", "toString"]) {
    assert.equal(deliveryReason(unknown), "Wollipog couldn't confirm this message was delivered.", String(unknown));
  }
  const codes: DeliveryReasonCode[] = [
    "accepted", "stale_turn", "unsupported_protocol", "unsupported_driver", "no_active_provider_turn",
    "policy_blocked", "governance_blocked", "queue_item_absent", "queue_item_started", "configuration_mismatch",
    "queue_capacity_exceeded", "provider_rejected", "transport_uncertain", "history_integrity_failure",
    "COMMAND_ID_CONFLICT", "COMMAND_EXPIRED", "INVALID_COMMAND", "SESSION_NOT_FOUND", "QUEUE_FULL",
    "COMMAND_CANCELLED", "PROVIDER_AUTHENTICATION_REQUIRED", "WORKTREE_RECOVERY_REQUIRED", "RECEIPT_STORE_FULL",
    "COMMAND_CATALOG_STALE", "COMMAND_UNAVAILABLE", "COMMAND_MODE_UNSUPPORTED",
  ];
  for (const code of codes) {
    const reason = deliveryReason(code);
    // A sentence for a person: capitalized, ending in a period, and never the enum spelled out.
    assert.match(reason, /^[A-Z].*\.$/u, code);
    assert.doesNotMatch(reason, /_/u, code);
    assert.doesNotMatch(reason.toLowerCase(), new RegExp(code.toLowerCase().replaceAll("_", " ")), code);
  }
});
