import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationNotificationEvent } from "@wollipog/protocol";
import { automationPushMessage } from "./automation-push-decision.js";

const SYNTHETIC_PRIVATE_MARKER = "SYNTHETIC-PRIVATE-CONTENT-7f31c2";
const automation = {
  automationId: "auto-notification-test",
  name: `Private automation ${SYNTHETIC_PRIVATE_MARKER}`,
};
const execution = {
  error: `Synthetic execution failure ${SYNTHETIC_PRIVATE_MARKER}`,
};

test("failed and expired automation push messages are fixed and content-free", () => {
  const expected = {
    failed: {
      title: "Automation Failed",
      body: "Open Automations to inspect the failed execution.",
    },
    expired: {
      title: "Automation Expired",
      body: "Open Automations to inspect the expired execution.",
    },
  } as const;

  for (const event of ["failed", "expired"] as const) {
    const message = automationPushMessage(automation, execution, event);
    assert.equal(message.title, expected[event].title);
    assert.equal(message.body, expected[event].body);
    assert.equal(message.notificationKey, "automation:auto-notification-test");
    assert.equal(message.view, "automations");
    assert.equal(message.urgency, "high");
    assert.doesNotMatch(JSON.stringify(message), new RegExp(SYNTHETIC_PRIVATE_MARKER));
  }
});

test("started and succeeded automation push messages preserve ordinary lifecycle behavior", () => {
  const cases: Array<{
    event: AutomationNotificationEvent;
    title: string;
    body: string;
  }> = [
    {
      event: "started",
      title: `${automation.name} started`,
      body: "The scheduled action was accepted and is running.",
    },
    {
      event: "succeeded",
      title: `${automation.name} completed`,
      body: "The scheduled action completed successfully.",
    },
  ];

  for (const { event, title, body } of cases) {
    assert.deepEqual(automationPushMessage(automation, execution, event), {
      title,
      body,
      notificationKey: "automation:auto-notification-test",
      view: "automations",
      urgency: "normal",
    });
  }
});
