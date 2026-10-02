import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BackgroundDeliveryView, PendingApproval } from "@wollipog/protocol";
import {
  sessionStatusSummary,
  statusMeta,
  statusValues,
  type SessionStatusSource,
  type StatusDomain,
  type StatusTone,
} from "./status-meta.js";

type Row = [domain: StatusDomain, value: string, label: string, tone: StatusTone];

/** docs/design-system.md §11.2, row by row. A label or tone that drifts from the table fails here. */
const TABLE: readonly Row[] = [
  // Session attention
  ["attention", "approval_required", "Approval Required", "warning"],
  ["attention", "answer_required", "Answer Required", "warning"],
  ["attention", "authentication_required", "Authentication Required", "warning"],
  ["attention", "account_required", "Account Required", "warning"],
  ["attention", "recovery_required", "Recovery Required", "danger"],
  // Session lifecycle
  ["session", "starting", "Starting", "info"],
  ["session", "running", "Running", "info"],
  ["session", "stopping", "Stopping", "info"],
  ["session", "idle", "Awaiting Prompt", "neutral"],
  ["session", "stalled", "Stalled", "danger"],
  ["session", "failed", "Failed", "danger"],
  ["session", "stop_failed", "Stop Failed", "danger"],
  ["session", "stopped", "Stopped", "neutral"],
  ["session", "archived", "Archived", "neutral"],
  ["session", "snoozed", "Snoozed", "neutral"],
  ["session", "completed", "Completed", "success"],
  ["session", "stop_pending", "Stop Pending", "info"],
  ["session", "stop_waiting_for_runner", "Stop Waiting for Runner", "neutral"],
  // Machine, instance and device
  ["machine", "online", "Online", "success"],
  ["machine", "connecting", "Connecting", "info"],
  ["machine", "offline", "Offline", "neutral"],
  ["machine", "update_required", "Update Required", "warning"],
  ["machine", "sign_in_required", "Sign-In Required", "warning"],
  ["machine", "pairing_required", "Pairing Required", "warning"],
  ["machine", "unreachable", "Unreachable", "danger"],
  ["machine", "error", "Error", "danger"],
  // Skill deployment
  ["skill", "linked", "Linked", "success"],
  ["skill", "pending", "Pending", "neutral"],
  ["skill", "edited", "Edited", "warning"],
  ["skill", "update_held", "Update Held", "warning"],
  ["skill", "error", "Error", "danger"],
  // Automation and run
  ["automation", "enabled", "Enabled", "success"],
  ["automation", "paused", "Paused", "neutral"],
  ["automation", "running", "Running", "info"],
  ["automation", "failed", "Failed", "danger"],
  // Tool call
  ["tool", "pending", "Pending", "neutral"],
  ["tool", "running", "Running", "info"],
  ["tool", "completed", "Completed", "success"],
  ["tool", "failed", "Failed", "danger"],
  // Session family rollup
  ["family", "awaiting_input", "Awaiting Input", "warning"],
  ["family", "idle", "Idle", "neutral"],
  // Subagent and background job
  ["job", "queued", "Queued", "neutral"],
  ["job", "canceled", "Canceled", "neutral"],
  ["job", "running", "Running", "info"],
  ["job", "stalled", "Stalled", "warning"],
  ["job", "completed", "Completed", "success"],
  ["job", "failed", "Failed", "danger"],
  ["job", "unverified", "Unverified", "neutral"],
  ["job", "lost", "Lost", "danger"],
  ["job", "result_missing", "Result Missing", "warning"],
  // Session header, background work
  ["background_work", "orphaned", "Background Work Lost", "danger"],
  // Queued message (the transcript's pending bubbles and the composer's queue)
  ["queuedMessage", "pending", "Pending", "neutral"],
  ["queuedMessage", "sent", "Sending", "info"],
  ["queuedMessage", "accepted", "Accepted", "info"],
  ["queuedMessage", "queued", "Queued", "neutral"],
  ["queuedMessage", "started", "Starting", "info"],
  ["queuedMessage", "pending_delivery", "Pending Delivery", "info"],
  ["queuedMessage", "steering", "Steering…", "info"],
  ["queuedMessage", "held", "Held", "warning"],
  ["queuedMessage", "uncertain", "Delivery Uncertain", "warning"],
  ["queuedMessage", "failed", "Delivery Failed", "danger"],
  ["queuedMessage", "not_sent", "Not Sent", "danger"],
  ["queuedMessage", "cancelled", "Canceled", "neutral"],
  // Delivery receipt
  ["delivery", "delivered", "Delivered", "success"],
  ["delivery", "delivery_failed", "Delivery Failed", "danger"],
  // Workflow gate and run decision
  ["workflow", "awaiting_decision", "Awaiting Decision", "warning"],
  ["workflow", "approved", "Approved", "success"],
  ["workflow", "rejected", "Rejected", "neutral"],
  // Pod
  ["pod", "active", "Active", "info"],
  ["pod", "paused", "Paused", "neutral"],
  ["pod", "conflicted", "Conflicted", "warning"],
  ["pod", "failed", "Failed", "danger"],
  // Provider account
  // Member
  ["member", "active", "Active", "success"],
  ["member", "suspended", "Suspended", "danger"],
  ["provider_account", "signed_in", "Signed In", "success"],
  ["provider_account", "sign_in_required", "Sign-In Required", "warning"],
  ["provider_account", "signed_out", "Signed Out", "neutral"],
  // Transcript share link
  ["share", "active", "Active", "success"],
  ["share", "expired", "Expired", "neutral"],
  ["share", "revoked", "Revoked", "neutral"],
  // Usage
  ["usage", "available", "Available", "success"],
  ["usage", "approaching_limit", "Approaching Limit", "warning"],
  ["usage", "temporarily_unavailable", "Temporarily Unavailable", "danger"],
];

test("statusMeta holds every row of the §11.2 vocabulary with its label and tone", () => {
  for (const [domain, value, label, tone] of TABLE) {
    const meta = statusMeta(domain, value);
    assert.equal(meta.label, label, `${domain}/${value}`);
    assert.equal(meta.tone, tone, `${domain}/${value}`);
  }
});

test("only actively progressing work pulses, and an unverified source draws a hollow dot", () => {
  const pulsing = (domain: StatusDomain) => statusValues(domain).filter((value) => statusMeta(domain, value).pulse);
  assert.deepEqual(pulsing("session"), ["starting", "running", "stopping", "stop_pending"]);
  // A Stop waiting on an offline runner is not being delivered, so it does not claim progress (#208).
  assert.equal(statusMeta("session", "stop_waiting_for_runner").pulse, false);
  assert.equal(statusMeta("job", "running").pulse, true);
  assert.deepEqual(pulsing("queuedMessage"), ["sent", "started", "steering"]);
  assert.equal(statusMeta("job", "stalled").pulse, false);
  assert.equal(statusMeta("machine", "offline").hollow, true);
  assert.equal(statusMeta("job", "unverified").hollow, true);
});

test("an unknown value reads Status Unavailable, never its raw enum or a prototype member", () => {
  for (const value of ["future_state", "constructor", "toString", "__proto__"]) {
    assert.deepEqual(statusMeta("session", value), { label: "Status Unavailable", tone: "neutral", pulse: false });
  }
});

test("every label is Title Case copy, with no glyph and no CSS transform needed", () => {
  for (const domain of ["attention", "session", "machine", "project_location", "skill", "automation", "tool", "family",
    "job", "background_work", "queuedMessage", "delivery", "notification", "workflow", "pod", "member", "provider_account",
    "share", "usage"] as const) {
    for (const value of statusValues(domain)) {
      const { label } = statusMeta(domain, value);
      for (const text of [label]) {
        assert.doesNotMatch(text, /[⚠⛔✓×]/u, `${domain}/${value}`);
        for (const word of text.split(/[\s—-]+/).filter(Boolean)) {
          if (["for", "on", "of", "to", "in"].includes(word)) continue;
          assert.match(word, /^[A-Z]/, `${domain}/${value}: "${word}" in "${text}"`);
        }
      }
    }
  }
});

test("Orphaned, Status Unverified and No Longer Reachable are retired from the web client", () => {
  // The wire value `orphaned` is unchanged; only what a person reads changes. Skill "Orphaned
  // Copies" are a different feature (library copies a machine kept), not background work.
  const root = fileURLToPath(new URL(".", import.meta.url));
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { if (entry !== "e2e") visit(path); continue; }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/"[^"\n]*(Background Work Orphaned|Status Unverified|No Longer Reachable|: Orphaned)[^"\n]*"/g)) {
        offenders.push(`${path.slice(root.length)}: ${match[0]}`);
      }
    }
  };
  visit(root);
  assert.deepEqual(offenders, []);
});

test("both canceled states read Canceled, the US spelling the copy rules require", () => {
  // The keys differ (`job.canceled`, `queuedMessage.cancelled`) and stay as they are; only what a
  // person reads is one word (docs/design-system.md §17.2).
  assert.equal(statusMeta("job", "canceled").label, "Canceled");
  assert.equal(statusMeta("queuedMessage", "cancelled").label, "Canceled");
});

test("no visible string in the web client spells canceled the British way", () => {
  // Quoted literals only, so the `cancelled` wire value and code comments are not copy. The native
  // transport's abort errors reach only a caller that already stopped waiting, so none is shown.
  const root = fileURLToPath(new URL(".", import.meta.url));
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { if (entry !== "e2e") visit(path); continue; }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry) || entry === "native-api-transport.ts") continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/(["'`])(?:(?!\1).)*?[Cc]ancell(?:ed|ing)(?:(?!\1).)*?\1/g)) {
        if (match[0].slice(1, -1) === "cancelled") continue;
        offenders.push(`${path.slice(root.length)}: ${match[0]}`);
      }
    }
  };
  visit(root);
  assert.deepEqual(offenders, []);
});

/** #2275: a background result that waits on the person ranks with their requests. */
function deliverySession(
  watchdogState: NonNullable<BackgroundDeliveryView["watchdogState"]>,
  overrides: Partial<SessionStatusSource> = {},
): SessionStatusSource {
  return {
    status: "idle",
    pendingApproval: null,
    attentionOwners: undefined,
    backgroundDeliveries: [{ parentTurnId: "turn-1", jobCount: 2, terminalCount: 1, watchdogState }],
    ...overrides,
  };
}

test("an idle session with a blocked result shows Result Blocked as its status (#2275)", () => {
  const summary = sessionStatusSummary(deliverySession("continuation_blocked"));
  assert.equal(summary.primary.kind, "background_delivery");
  assert.equal(summary.primary.meta.label, "Result Blocked");
  assert.equal(summary.primary.meta.tone, "warning");
  assert.equal(summary.primary.needsYou, true);
  assert.equal(summary.primary.delivery?.parentTurnId, "turn-1");
  assert.equal(summary.more, 0);
  // It needs the person, so the lifecycle is not listed after it.
  assert.deepEqual(summary.conditions.map((condition) => condition.meta.label), ["Result Blocked"]);
});

test("an idle session with a missing result shows Result Missing as its status (#2275)", () => {
  const summary = sessionStatusSummary(deliverySession("accepted_without_result"));
  assert.equal(summary.primary.meta.label, "Result Missing");
  assert.equal(summary.primary.needsYou, true);
  assert.equal(summary.more, 0);
});

test("an approval leads a missing result, which counts as +1 (#2275)", () => {
  const approval: PendingApproval = { requestId: "approval-1", title: "Run the tests", options: [], kind: "permission" };
  const summary = sessionStatusSummary(deliverySession("accepted_without_result", {
    status: "input_required",
    pendingApproval: approval,
  }));
  assert.equal(summary.primary.meta.label, "Approval Required");
  assert.equal(summary.more, 1);
  assert.deepEqual(summary.conditions.map((condition) => condition.meta.label), ["Approval Required", "Result Missing"]);
});

test("a delivery that waits on the person ranks after requests and before Background Work Lost (#2275)", () => {
  const summary = sessionStatusSummary(deliverySession("continuation_blocked", {
    orchestratorCampaign: { pendingRequests: { human: 1, orchestrator: 0 } },
    backgroundWorkState: "orphaned",
  } as Partial<SessionStatusSource>), { descendantRequests: 2, runnerOnline: false });
  assert.deepEqual(summary.conditions.map((condition) => condition.kind),
    ["campaign_requests", "background_delivery", "background_work", "disconnected"]);
  assert.equal(summary.more, 1);
});

test("a result still on its way back stays passive and leaves +N unchanged (#2275)", () => {
  for (const [state, label] of [
    ["terminal_without_continuation", "Result Pending"],
    ["result_not_projected", "Transcript Delayed"],
    ["dashboard_observation_pending", "Notification Pending"],
  ] as const) {
    const idle = sessionStatusSummary(deliverySession(state));
    assert.equal(idle.primary.meta.label, "Awaiting Prompt", state);
    assert.equal(idle.more, 0, state);
    const row = idle.conditions.find((condition) => condition.kind === "background_delivery")!;
    assert.equal(row.meta.label, label);
    assert.equal(row.meta.tone, "info");
    assert.equal(row.needsYou, false);
    const approval: PendingApproval = { requestId: "approval-1", title: "Run the tests", options: [], kind: "permission" };
    const asking = sessionStatusSummary(deliverySession(state, { status: "input_required", pendingApproval: approval }));
    assert.equal(asking.primary.meta.label, "Approval Required", state);
    assert.equal(asking.more, 0, state);
  }
});

test("a delivery that waits on the person is the one shown, even after a passive one (#2275)", () => {
  const summary = sessionStatusSummary(deliverySession("continuation_blocked", {
    backgroundDeliveries: [
      { continuationId: "c-1", parentTurnId: "turn-1", jobCount: 1, terminalCount: 1, watchdogState: "dashboard_observation_pending" },
      { parentTurnId: "turn-2", jobCount: 2, terminalCount: 1, watchdogState: "continuation_blocked" },
    ],
  }));
  assert.equal(summary.primary.meta.label, "Result Blocked");
  assert.equal(summary.conditions.filter((condition) => condition.kind === "background_delivery").length, 1);
});

test("with only passive deliveries the first listed is shown (#2329)", () => {
  const summary = sessionStatusSummary(deliverySession("dashboard_observation_pending", {
    backgroundDeliveries: [
      { continuationId: "c-1", parentTurnId: "turn-1", jobCount: 1, terminalCount: 1, watchdogState: "dashboard_observation_pending" },
      { parentTurnId: "turn-2", jobCount: 1, terminalCount: 1, watchdogState: "result_not_projected" },
    ],
  }));
  const shown = summary.conditions.filter((condition) => condition.kind === "background_delivery");
  assert.deepEqual(shown.map((condition) => condition.meta.label), ["Notification Pending"]);
});
