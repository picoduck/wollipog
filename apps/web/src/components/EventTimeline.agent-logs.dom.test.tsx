import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { setShowAgentLogs, SHOW_AGENT_LOGS_STORAGE_KEY } from "../agent-logs.js";
import { EventTimeline } from "./EventTimeline.js";

/**
 * Harness output (stderr) is an Agent Log step (#2184): a quiet row in its run of work with its text
 * in the neutral well. A run of nothing but Agent Logs renders only with Show Agent Logs on, and the
 * setting applies to an open transcript without a reload.
 */

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  // The setter announces its change with `new Event(...)`; a Node-global Event never reaches
  // happy-dom's listeners.
  Event: domWindow.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup } = installDomTestCleanup(domWindow);

beforeEach(() => domWindow.localStorage.clear());

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    setShowAgentLogs(false);
  });
  return { container, root };
}

async function openWork(container: HTMLElement) {
  for (const trigger of container.querySelectorAll<HTMLButtonElement>(".tl-work > .disclosure-trigger")) {
    if (trigger.getAttribute("aria-expanded") !== "true") await act(async () => trigger.click());
  }
}

const bootOnlyTurn: TimelineItem[] = [
  { kind: "user_message", id: 1, text: "Start the migration" },
  { kind: "stderr", id: 2, text: "codex-cli 0.48.0 starting\n" },
  { kind: "agent_message", id: 3, text: "Started." },
];

test("a turn whose only work is a boot line renders no work with Show Agent Logs off, and one Agent Log when it is on", async () => {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={bootOnlyTurn} />));
  assert.equal(container.querySelectorAll(".tl-work").length, 0, "no empty Worked line opens the turn");
  assert.doesNotMatch(container.textContent ?? "", /codex-cli|STDERR/);

  // The same open transcript, no remount: the Settings switch's store change is enough.
  await act(async () => setShowAgentLogs(true));
  assert.equal(domWindow.localStorage.getItem(SHOW_AGENT_LOGS_STORAGE_KEY), "true");
  const work = container.querySelectorAll(".tl-work");
  assert.equal(work.length, 1, "one work group appears");
  await openWork(container);
  const steps = [...container.querySelectorAll<HTMLElement>(".tl-step")];
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.querySelector(".tl-step-title")?.textContent, "Agent Log");
  assert.ok(steps[0]!.querySelector(".tl-step-icon > svg.lucide-scroll-text"), "the Agent Log icon");

  await act(async () => setShowAgentLogs(false));
  assert.equal(container.querySelectorAll(".tl-work").length, 0, "turning it off hides the run again");
});

test("a stderr line beside commands is a neutral Agent Log step, never a red box or STDERR", async () => {
  const { container, root } = await mount();
  const items: TimelineItem[] = [
    { kind: "user_message", id: 1, text: "Run the tests" },
    { kind: "tool_call", id: 2, toolCallId: "test", title: "Bash: npm test", toolKind: "execute", status: "completed", text: "ok" },
    { kind: "stderr", id: 3, text: "npm warn deprecated glob@7\nnpm warn deprecated rimraf@3\n" },
    { kind: "agent_message", id: 4, text: "All green." },
  ];
  await act(async () => root.render(<EventTimeline items={items} />));
  assert.equal(container.querySelectorAll(".tl-work").length, 1, "the run renders with the setting off");
  await openWork(container);

  const log = [...container.querySelectorAll<HTMLElement>(".tl-step")]
    .find((step) => step.querySelector(".tl-step-title")?.textContent === "Agent Log");
  assert.ok(log, "the stderr item is an Agent Log step in the work group");
  assert.equal(log.closest(".tl-work-rule") !== null, true, "it sits on its group's rule");
  assert.equal(log.querySelector(".tl-step-trail")?.textContent, "2 Lines");
  assert.equal(log.querySelector("summary")?.getAttribute("aria-label"), "Agent Log · 2 Lines");
  const output = log.querySelector(".tl-step-output");
  assert.ok(output, "its text sits in the neutral well");
  assert.equal(output.textContent, "npm warn deprecated glob@7\nnpm warn deprecated rimraf@3\n");
  assert.equal(log.querySelectorAll(".tl-step-error").length, 0, "no line takes the danger colour");
  assert.equal(container.querySelectorAll(".tl-stderr").length, 0);
  assert.doesNotMatch(container.textContent ?? "", /STDERR/i);
});
