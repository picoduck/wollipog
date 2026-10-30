import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTriggerRequest,
  emptyTriggerDraft,
  parseParameterNames,
  targetChoiceNote,
  triggerAcceptsLabel,
  triggerEndpoint,
  triggerRequestShape,
  triggerUseLabels,
} from "./automation-triggers.js";

test("a draft without details sends no delivery policy, exactly as the inline form did", () => {
  const draft = emptyTriggerDraft("Nightly Sweep", "chatops");
  assert.equal(draft.name, "Nightly Sweep chat-ops");
  assert.deepEqual(createTriggerRequest("chatops", { ...draft, allowPrompt: true, parameterNames: "issue" }),
    { kind: "chatops", name: "Nightly Sweep chat-ops" }, "details typed and then switched off are not sent");
  assert.equal(emptyTriggerDraft("A".repeat(90), "webhook").name.length, 80, "the default name fits the 80-character field");
});

test("a draft with details sends its names trimmed and unique, and its selectors only when chosen", () => {
  const draft = { ...emptyTriggerDraft("Sweep", "webhook"), configurable: true };
  assert.deepEqual(createTriggerRequest("webhook", { ...draft, parameterNames: " issue, run_id,, issue " }), {
    kind: "webhook",
    name: "Sweep webhook",
    deliveryPolicy: { allowPrompt: false, parameterNames: ["issue", "run_id"], missingReferences: "reject" },
  });
  assert.deepEqual(createTriggerRequest("webhook", { ...draft, missingReferences: "use_stored", sessionSelectors: ["branch"] }).deliveryPolicy,
    { allowPrompt: false, parameterNames: [], missingReferences: "use_stored", sessionSelectors: ["branch"] });
  assert.deepEqual(parseParameterNames(""), []);
});

test("a row says a trigger's use and what it accepts in words", () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime();
  assert.deepEqual(triggerUseLabels({ invocationCount: 0 }, now), ["Never called"]);
  assert.deepEqual(triggerUseLabels({ invocationCount: 1 }, now), ["1 call"]);
  assert.deepEqual(triggerUseLabels({ invocationCount: 14, lastInvokedAt: new Date(2026, 9, 21, 9, 12).getTime() }, now),
    ["Last called Today, 9:12 AM", "14 calls"]);

  assert.equal(triggerAcceptsLabel(undefined), null);
  assert.equal(triggerAcceptsLabel({ allowPrompt: false, parameterNames: [], missingReferences: "reject" }), null);
  assert.equal(triggerAcceptsLabel({ allowPrompt: true, parameterNames: ["issue", "run_id"], missingReferences: "reject" }),
    "Accepts prompt text and issue, run_id");
  assert.equal(triggerAcceptsLabel({ allowPrompt: false, parameterNames: [], missingReferences: "reject", sessionSelectors: ["branch"] }),
    "Accepts a session");
});

test("a trigger's address needs a public origin", () => {
  assert.equal(triggerEndpoint(null, "atr_1"), null);
  assert.equal(triggerEndpoint("https://wollipog.example", "atr_1"), "https://wollipog.example/hooks/v1/automation-triggers/atr_1");
});

test("How to Call shows the Wollipog wire generation and only the fields a trigger accepts", () => {
  const plain = triggerRequestShape("webhook", undefined);
  assert.equal(plain.headers, [
    "POST /hooks/v1/automation-triggers/<trigger ID>",
    "Content-Type: application/vnd.wollipog.automation-trigger+json",
    "X-Wollipog-Timestamp: <Unix seconds>",
    "X-Wollipog-Nonce: <16–128 URL-safe characters>",
    "X-Wollipog-Signature: v1=<HMAC-SHA256 hex>",
  ].join("\n"));
  assert.deepEqual(JSON.parse(plain.body), { eventId: "<unique event ID>" });
  assert.equal(plain.signing, "v1\n<timestamp>\n<nonce>\n<trigger ID>\n<body SHA-256 hex>");

  const configured = triggerRequestShape("chatops", {
    allowPrompt: true, parameterNames: ["issue"], missingReferences: "reject", sessionSelectors: ["pull_request", "branch"],
  }, "atr_7");
  assert.match(configured.headers, /^POST \/hooks\/v1\/automation-triggers\/atr_7$/m);
  assert.deepEqual(JSON.parse(configured.body), {
    eventId: "<unique event ID>", command: "run", sender: "<sender>", prompt: "<prompt text>",
    parameters: { issue: "<issue>" }, target: { pullRequest: "<pull request URL>" },
  });
  assert.match(configured.signing, /\natr_7\n/);
  assert.equal(targetChoiceNote({ allowPrompt: false, parameterNames: [], missingReferences: "reject", sessionSelectors: ["branch"] }), null);
  assert.equal(targetChoiceNote({
    allowPrompt: false, parameterNames: [], missingReferences: "reject", sessionSelectors: ["session_id", "branch", "pull_request"],
  }), "Send one of sessionId, branch or pullRequest in target.");
});
