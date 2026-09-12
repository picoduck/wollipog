import assert from "node:assert/strict";
import test from "node:test";
import type { BackgroundDeliveryWatchdogState } from "@wollipog/protocol";
import {
  BACKGROUND_DELIVERY_STATUS,
  backgroundDeliveryAccessibleName,
  backgroundDeliveryAttentionDescription,
} from "./background-delivery-status.js";

const states: BackgroundDeliveryWatchdogState[] = [
  "terminal_without_continuation",
  "accepted_without_result",
  "result_not_projected",
  "dashboard_observation_pending",
];

test("delivery-watchdog copy stays compact, plain-language, and complete", () => {
  assert.deepEqual(states.map((state) => BACKGROUND_DELIVERY_STATUS[state].label), [
    "Result Pending",
    "Result Missing",
    "Transcript Delayed",
    "Notification Pending",
  ]);
  const longestLabel = "Notification Pending".length;
  for (const state of states) {
    const copy = BACKGROUND_DELIVERY_STATUS[state];
    assert.ok(copy.label.length <= longestLabel, state);
    assert.doesNotMatch(copy.label, /background delivery|terminal|continuation|projection|dashboard observation/i, state);
    for (const sentence of [copy.description, copy.completed, copy.outstanding, copy.recovery, copy.action]) {
      assert.match(sentence, /[.!?]$/, `${state}: ${sentence}`);
    }
    assert.match(backgroundDeliveryAccessibleName(state), new RegExp(`^Background Work: ${copy.label}\\.`));
    assert.equal(
      backgroundDeliveryAttentionDescription(state),
      `${copy.description} ${copy.recovery} ${copy.action}`,
    );
  }
});

test("only a confirmed missing result uses the missing-result severity", () => {
  assert.equal(BACKGROUND_DELIVERY_STATUS.accepted_without_result.severity, "missing");
  assert.deepEqual(
    states.filter((state) => BACKGROUND_DELIVERY_STATUS[state].severity === "pending"),
    ["terminal_without_continuation", "result_not_projected", "dashboard_observation_pending"],
  );
});
