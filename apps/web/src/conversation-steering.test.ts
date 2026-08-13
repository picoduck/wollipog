import assert from "node:assert/strict";
import test from "node:test";
import type { SteeringAttemptView } from "@wollipog/protocol";
import {
  conversationSteeringAvailability,
  queuedPromptSteeringAvailability,
  shouldReloadReservedDraft,
  steeringReceiptPresentation,
  type ConversationSteeringAvailabilityInput,
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
    [{ runnerProtocolVersion: 72 }, /requires protocol v73/i],
    [{ runnerProtocolVersion: undefined }, /is unknown/i],
    [{ runnerOnline: false }, /runner is offline/i],
    [{ supportsSteering: false }, /has not verified/i],
    [{ supportsSteering: undefined }, /has not verified/i],
    [{ policyPaused: true }, /guardrail decision/i],
    [{ queueHeld: true }, /resume the held queue/i],
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

  assert.deepEqual(
    conversationSteeringAvailability({ ...available, sessionStatus: "input_required" }),
    { available: true },
    "non-policy input-required turns remain eligible like the control-plane route",
  );
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
  if (!oldRunner.available) assert.match(oldRunner.reason, /requires protocol v73/i);
});

test("durable steering receipts map to stable Title Case presentation", () => {
  assert.deepEqual(steeringReceiptPresentation(attempt("pending")), {
    label: "Steering…", tone: "pending", actionRequired: false,
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("accepted")), {
    label: "Accepted", tone: "success", actionRequired: false,
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("converted_to_queue")), {
    label: "Converted to Queue", tone: "neutral", actionRequired: false,
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("rejected")), {
    label: "Rejected", tone: "danger", actionRequired: false,
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("uncertain")), {
    label: "Delivery Uncertain", tone: "warning", actionRequired: true,
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("uncertain", {
    resolution: { action: "queue_again", state: "pending" },
  })), {
    label: "Delivery Uncertain", tone: "warning", actionRequired: false,
    detail: "Queue Again is pending.",
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("uncertain", {
    resolution: { action: "dismiss", state: "pending" },
  })), {
    label: "Delivery Uncertain", tone: "warning", actionRequired: false,
    detail: "Dismiss is pending.",
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("uncertain", {
    resolution: { action: "queue_again", state: "applied", queuedPromptId: "queue-new" },
  })), {
    label: "Queued Again", tone: "neutral", actionRequired: false,
  });
  assert.deepEqual(steeringReceiptPresentation(attempt("uncertain", {
    resolution: { action: "dismiss", state: "applied" },
  })), {
    label: "Dismissed", tone: "neutral", actionRequired: false,
  });
});
