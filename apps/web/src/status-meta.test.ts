import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { statusMeta, statusValues, type StatusDomain, type StatusTone } from "./status-meta.js";

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
