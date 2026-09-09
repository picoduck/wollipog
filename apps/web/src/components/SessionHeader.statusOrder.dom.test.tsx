import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { statusKeepOrder } from "./SessionHeader.js";

const domWindow = new Window({ url: "http://localhost/" });
const { document } = domWindow;

/**
 * The measured status row's priority contract (#784), asserted without a browser: the geometry that
 * decides HOW MANY badges fit is covered by status-badge-parity.spec.ts, but which badge wins the
 * space is a rule, and a rule can be read directly.
 */
function row(html: string): HTMLElement[] {
  const container = document.createElement("div");
  container.className = "session-header-statuses";
  container.innerHTML = html;
  return [...container.querySelectorAll(
    ".session-status-indicators > .status-badge, " +
    ".change-status-indicators > .status-badge, " +
    ":scope > .background-work-badge",
  )] as unknown as HTMLElement[];
}

const label = (items: HTMLElement[]) => items.map((item) => item.getAttribute("aria-label"));

test("background work is offered the row before lifecycle and change statuses", () => {
  const items = row(`
    <span class="session-status-indicators">
      <span class="status-badge" aria-label="Activity: Running"></span>
      <span class="status-badge" aria-label="Attention: Approval Required"></span>
    </span>
    <button class="background-work-badge" aria-label="Background Work: Waiting on External Job"></button>
    <span class="change-status-indicators">
      <span class="status-badge" aria-label="Changes: No Changes"></span>
    </span>
  `);

  assert.deepEqual(label(statusKeepOrder(items)), [
    "Background Work: Waiting on External Job",
    "Activity: Running",
    "Attention: Approval Required",
    "Changes: No Changes",
  ]);
});

test("the active-subagents badge ranks with the lifecycle group it runs inside", () => {
  // It wears the background-work badge's class, which is exactly how a rank check goes wrong.
  const items = row(`
    <span class="session-status-indicators">
      <span class="status-badge" aria-label="Activity: Running"></span>
    </span>
    <button class="background-work-badge" aria-label="Background Work: Continuation Pending"></button>
    <span class="change-status-indicators">
      <span class="status-badge" aria-label="Changes: No Changes"></span>
    </span>
    <button class="background-work-badge active-subagents-badge" aria-label="1 Worker Active"></button>
  `);

  assert.deepEqual(label(statusKeepOrder(items)), [
    "Background Work: Continuation Pending",
    "Activity: Running",
    "1 Worker Active",
    "Changes: No Changes",
  ]);
});

test("badges of one rank are claimed left to right, so survivors still read in order", () => {
  const items = row(`
    <span class="change-status-indicators">
      <span class="status-badge" aria-label="Changes: Ready for Review"></span>
      <span class="status-badge" aria-label="Changes: Uncommitted Changes"></span>
    </span>
  `);

  assert.deepEqual(label(statusKeepOrder(items)), [
    "Changes: Ready for Review",
    "Changes: Uncommitted Changes",
  ]);
});
