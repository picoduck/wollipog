import assert from "node:assert/strict";
import test from "node:test";
import type { SessionView } from "@wollipog/protocol";
import { hiddenColumnFailures, hiddenColumnRequestAnnouncement } from "./hidden-column-conditions.js";

type Continuation = NonNullable<NonNullable<SessionView["orchestratorCampaign"]>["continuation"]>;

const continuation = (overrides: Partial<Continuation>): Continuation => ({
  state: "failed", pendingEvents: 2, attemptCount: 3, updatedAt: 1, commandId: "continue-1", canRetry: true,
  ...overrides,
} as Continuation);

test("a terminal delivery is a failure whether it failed or is uncertain; one still pending is not (#2894)", () => {
  const failures = hiddenColumnFailures({
    queued: [
      { id: "a", text: "one", steerable: false, durableDeliveryState: "failed", durableDeliveryError: "lost" },
      { id: "b", text: "two", steerable: false, durableDeliveryState: "uncertain", durableDeliveryError: "timed out" },
      { id: "c", text: "three", steerable: false, durableDeliveryState: "pending", durableDeliveryError: "retrying" },
      { id: "d", text: "four", steerable: false, durableDeliveryState: "failed" },
    ],
    continuation: undefined,
    notices: [],
  });
  assert.deepEqual(failures, [
    { key: "queued:a:failed", title: "Message Not Delivered", target: { kind: "notice", noticeKey: "queued-delivery:a" } },
    { key: "queued:b:uncertain", title: "Delivery Uncertain", target: { kind: "notice", noticeKey: "queued-delivery:b" } },
  ]);
});

test("only a continuation whose automatic retries stopped is a failure, once per attempt (#2894)", () => {
  assert.deepEqual(hiddenColumnFailures({ queued: [], continuation: continuation({}), notices: [] }), [
    { key: "continuation:continue-1:3", title: "Couldn't Resume the Orchestrator", target: { kind: "campaign" } },
  ]);
  assert.deepEqual(hiddenColumnFailures({ queued: [], continuation: continuation({ canRetry: false }), notices: [] }), [],
    "the still-retrying warning is not a failure");
  assert.deepEqual(hiddenColumnFailures({ queued: [], continuation: continuation({ state: "running" }), notices: [] }), []);
  assert.notDeepEqual(
    hiddenColumnFailures({ queued: [], continuation: continuation({ attemptCount: 4 }), notices: [] })[0]?.key,
    "continuation:continue-1:3",
    "a later attempt that fails again is a new arrival",
  );
});

test("danger notices are failures; warning and info notices never are (#2894)", () => {
  const failures = hiddenColumnFailures({
    queued: [],
    continuation: undefined,
    notices: [
      { key: "history-quarantine", severity: "danger", title: "Conversation Quarantined" },
      { key: "runner-offline", severity: "warning", title: "Runner Offline" },
      { key: "skills-unavailable", severity: "info", title: "Skills Unavailable" },
      // An action's own failure restores the panel where the action runs (#2845).
      { key: "composer-error:stop", severity: "danger", title: "Couldn't Stop the Turn" },
      // The queued message's own slot entry is keyed above, by its delivery state.
      { key: "queued-delivery:a", severity: "danger", title: "Message Not Delivered" },
    ],
  });
  assert.deepEqual(failures, [{
    key: "notice:history-quarantine",
    title: "Conversation Quarantined",
    target: { kind: "notice", noticeKey: "history-quarantine" },
  }]);
});

test("the request announcement counts what arrived", () => {
  assert.equal(hiddenColumnRequestAnnouncement(1), "New request waiting.");
  assert.equal(hiddenColumnRequestAnnouncement(2), "2 new requests waiting.");
});
