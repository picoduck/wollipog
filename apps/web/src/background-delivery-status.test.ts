import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BackgroundDeliveryView, BackgroundDeliveryWatchdogState } from "@wollipog/protocol";
import {
  BACKGROUND_DELIVERY_STATUS,
  backgroundDeliveryAccessibleName,
  backgroundDeliveryAttentionDescription,
  backgroundLostSentence,
  backgroundRecoverySentence,
  shownWatchdogDelivery,
  backgroundDeliveryAcknowledgement,
  requestBackgroundDeliveryAcknowledgement,
} from "./background-delivery-status.js";

const states: BackgroundDeliveryWatchdogState[] = [
  "terminal_without_continuation",
  "continuation_blocked",
  "capacity_retry_exhausted",
  "accepted_without_result",
  "result_not_projected",
  "dashboard_observation_pending",
];

test("delivery-watchdog copy stays compact, plain-language, and complete", () => {
  assert.deepEqual(states.map((state) => BACKGROUND_DELIVERY_STATUS[state].label), [
    "Result Pending",
    "Result Blocked",
    "Retry Exhausted",
    "Result Missing",
    "Transcript Delayed",
    "Notification Pending",
  ]);
  const longestLabel = "Notification Pending".length;
  for (const state of states) {
    const copy = BACKGROUND_DELIVERY_STATUS[state];
    assert.ok(copy.label.length <= longestLabel, state);
    assert.doesNotMatch(copy.label, /background delivery|terminal|continuation|projection|dashboard observation/i, state);
    for (const sentence of [copy.description, copy.recovery, copy.action]) {
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
  assert.equal(BACKGROUND_DELIVERY_STATUS.capacity_retry_exhausted.severity, "blocked");
  assert.deepEqual(
    states.filter((state) => BACKGROUND_DELIVERY_STATUS[state].severity === "pending"),
    ["terminal_without_continuation", "result_not_projected", "dashboard_observation_pending"],
  );
});

const delivery = (parentTurnId: string, watchdogState?: BackgroundDeliveryWatchdogState): BackgroundDeliveryView => ({
  parentTurnId, jobCount: 1, terminalCount: 1, ...(watchdogState ? { watchdogState } : {}),
});

test("a session shows the delivery that waits on the person, else the first with a watchdog (#2329)", () => {
  const pending = delivery("turn-1", "dashboard_observation_pending");
  const blocked = delivery("turn-2", "continuation_blocked");
  const missing = delivery("turn-3", "accepted_without_result");
  const delayed = delivery("turn-4", "result_not_projected");
  const healthy = delivery("turn-5");
  // The control plane lists retained deliveries first and appends Result Blocked ones after them.
  assert.equal(shownWatchdogDelivery([pending, blocked]), blocked);
  assert.equal(BACKGROUND_DELIVERY_STATUS[shownWatchdogDelivery([pending, blocked])!.watchdogState].label,
    "Result Blocked");
  assert.equal(shownWatchdogDelivery([healthy, delayed, missing]), missing);
  assert.equal(shownWatchdogDelivery([pending, missing, blocked]), missing,
    "among deliveries that wait on the person, the first listed");
  assert.equal(shownWatchdogDelivery([healthy, pending, delayed]), pending, "with only pending ones, the first, as before");
  assert.equal(shownWatchdogDelivery([healthy]), undefined);
  assert.equal(shownWatchdogDelivery([]), undefined);
  assert.equal(shownWatchdogDelivery(undefined), undefined);
});

/** Every non-test web source file, the Playwright harness included. */
function webSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { webSources(path, out); continue; }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

/** A `find` whose predicate picks a delivery for having any watchdog state: the per-surface
 * selection #2329 replaced. Comparing the state to a value (`=== "continuation_blocked"`) is not one. */
const OWN_SELECTION = [
  /\.find(?:Last)?(?:Index)?\(\s*\(?\s*([A-Za-z_$][\w$]*)(?:\s*:[^)=]*)?\s*\)?\s*=>\s*\(?\s*\1\??\s*\.\s*watchdogState\b(?!\s*(?:==|\?\?|!==?(?!\s*(?:null|undefined)\b)))/,
  /\.find(?:Last)?(?:Index)?\(\s*\(\s*\{[^}]*\bwatchdogState\b[^}]*\}[^)]*\)\s*=>\s*\(?\s*watchdogState\b(?!\s*(?:==|\?\?|!==?(?!\s*(?:null|undefined)\b)))/,
];

test("no surface keeps its own watchdog delivery selection (#2329)", () => {
  for (const sample of [
    "session.backgroundDeliveries?.find((delivery) => delivery.watchdogState)?.watchdogState",
    "deliveries.find((candidate) =>\n    candidate.watchdogState && backgroundDeliveryNeedsYou(candidate.watchdogState))",
    "groupDeliveries.find(delivery => delivery.watchdogState)",
    "deliveries.findLast((d: BackgroundDeliveryView) => d.watchdogState != null)",
    "deliveries.find(({ watchdogState }) => watchdogState)",
  ]) assert.ok(OWN_SELECTION.some((pattern) => pattern.test(sample)), `the guard reads: ${sample}`);
  for (const sample of [
    "deliveries.find((delivery) => delivery.watchdogState === \"continuation_blocked\")",
    "deliveries.find((delivery) => delivery.watchdogState !== \"continuation_blocked\")",
    "deliveries.find((delivery) => delivery.watchdogState !== \"continuation_blocked\")",
    "deliveries.filter((delivery) => delivery.watchdogState || delivery.missingResultAt != null)",
  ]) assert.ok(!OWN_SELECTION.some((pattern) => pattern.test(sample)), `the guard allows: ${sample}`);

  const root = fileURLToPath(new URL(".", import.meta.url));
  const owner = fileURLToPath(new URL("./background-delivery-status.ts", import.meta.url));
  const offenders = webSources(root)
    .filter((path) => path !== owner && OWN_SELECTION.some((pattern) => pattern.test(readFileSync(path, "utf8"))))
    .map((path) => relative(root, path));
  assert.deepEqual(offenders, [], "use shownWatchdogDelivery() from background-delivery-status.ts");

  for (const surface of [
    "status-meta.ts",
    "session-reminders.ts",
    "components/PinnedSummary.tsx",
    "components/BackgroundWorkPanel.tsx",
  ]) {
    assert.match(readFileSync(join(root, surface), "utf8"), /\bshownWatchdogDelivery\(/, surface);
  }
});

test("a recovery notice's one sentence names its job, or counts them (#2859)", () => {
  const job = { job: "shell job a1f3c9" };
  assert.equal(backgroundRecoverySentence("accepted_without_result", job),
    "Shell job a1f3c9 finished, but its result never reached this conversation. Wollipog won't retry on its own, " +
    "so the step can't run twice.");
  assert.equal(backgroundRecoverySentence("accepted_without_result", { count: 2 }),
    "2 background jobs finished, but their result never reached this conversation. Wollipog won't retry on its own, " +
    "so the step can't run twice.");
  assert.equal(backgroundRecoverySentence("continuation_blocked", job),
    "Shell job a1f3c9 finished, but its result can't be returned while another job from the same turn is still running.");
  assert.equal(backgroundRecoverySentence("terminal_without_continuation", job),
    "Returning shell job a1f3c9's result to this conversation.");
  assert.equal(backgroundRecoverySentence("terminal_without_continuation", { count: 1 }),
    "Returning the result of a background job to this conversation.");
  assert.equal(backgroundRecoverySentence("result_not_projected", job),
    "Shell job a1f3c9's result reached Wollipog and is being added to this conversation.");
  assert.equal(backgroundRecoverySentence("dashboard_observation_pending", { count: 3 }),
    "Confirming that this dashboard shows the result of 3 background jobs.");
  for (const state of states) {
    const sentence = backgroundRecoverySentence(state, job);
    assert.doesNotMatch(sentence, /terminal|continuation|projection|delivery|barrier/iu, `${state}: ${sentence}`);
    for (const part of sentence.split(/(?<=\.) /u)) {
      assert.match(part, /^[A-Z][^A-Z]*(?:Wollipog[^A-Z]*)*\.$/u, `${state}: "${part}" is sentence case`);
    }
  }
});

test("the Lost sentence names the machine and the job, or counts the jobs (#2859)", () => {
  assert.equal(backgroundLostSentence("Studio Workstation", [{ launchType: "monitor", id: "task-7be210" }]),
    "Studio Workstation restarted while monitor job 7be210 was running, so its result can't come back to this conversation.");
  assert.equal(backgroundLostSentence(null, []),
    "The machine restarted while a background job was running, so its result can't come back to this conversation.");
  assert.equal(backgroundLostSentence("Build Box", [{ launchType: "shell", id: "a" }, { launchType: "agent", id: "b" }]),
    "Build Box restarted while 2 background jobs were running, so their results can't come back to this conversation.");
});

test("exhaustion acknowledgement has separate authority from accepted missing results", async () => {
  const exhausted: BackgroundDeliveryView = {
    continuationId: "continuation", parentTurnId: "parent", jobCount: 1, terminalCount: 1,
    retryExhaustedAt: 5, watchdogState: "capacity_retry_exhausted",
  };
  assert.deepEqual(backgroundDeliveryAcknowledgement(exhausted), { kind: "retry_exhaustion", continuationId: "continuation" });
  assert.equal(backgroundDeliveryAcknowledgement({ ...exhausted, acceptedAt: 6 }), null);
  assert.equal(backgroundDeliveryAcknowledgement({ ...exhausted, retryExhaustionAcknowledgedAt: 6 }), null);
  assert.equal(backgroundDeliveryAcknowledgement({ ...exhausted, runnerResultPersistedAt: 6 }), null);
  const missing = { ...exhausted, acceptedAt: 6, missingResultAt: 7, retryExhaustionAcknowledgedAt: 6,
    watchdogState: "accepted_without_result" as const };
  assert.deepEqual(backgroundDeliveryAcknowledgement(missing), { kind: "missing_result", continuationId: "continuation" });
  const calls: string[] = [];
  const api = {
    acknowledgeBackgroundMissingResult: async () => { calls.push("missing"); return {} as import("@wollipog/protocol").SessionView; },
    acknowledgeBackgroundRetryExhaustion: async () => { calls.push("exhaustion"); return {} as import("@wollipog/protocol").SessionView; },
  };
  assert.equal(await requestBackgroundDeliveryAcknowledgement(api, "session", backgroundDeliveryAcknowledgement(exhausted)!), null);
  assert.equal(await requestBackgroundDeliveryAcknowledgement(api, "session", backgroundDeliveryAcknowledgement(missing)!), null);
  assert.deepEqual(calls, ["exhaustion", "missing"]);
});
