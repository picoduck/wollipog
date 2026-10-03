import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionEvent } from "@wollipog/protocol";
import { TimelineBuilder, type TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { EventTimeline, type TurnRetryControl } from "./EventTimeline.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup } = installDomTestCleanup(domWindow);

const at = (minute: number, second = 0) => Date.UTC(2026, 9, 2, 0, minute, second);
const event = (seq: number, ts: number, payload: SessionEvent["payload"]): SessionEvent =>
  ({ sessionId: "session-1", seq, ts, payload }) as SessionEvent;

/** A turn that failed on a rate limit, reported twice as the runner and the driver both do. */
function failedTurnItems(): TimelineItem[] {
  const builder = new TimelineBuilder();
  for (const ev of [
    event(1, at(25), { kind: "user_message", text: "Summarize the release notes" }),
    event(2, at(25, 4), { kind: "agent_message", text: "Reading the notes.", final: true }),
    event(3, at(25, 9), { kind: "error", message: "prompt failed: Rate limit reached" }),
    event(4, at(25, 9), { kind: "error", message: "Rate limit reached" }),
  ] as SessionEvent[]) builder.push(ev);
  return builder.snapshot();
}

interface View {
  container: HTMLElement;
  rerender: (next: React.ReactElement) => Promise<void>;
}

async function withView(element: React.ReactElement, check: (view: View) => Promise<void>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(element));
    await check({ container, rerender: (next) => act(async () => root.render(next)) });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

const describedBy = (element: Element) =>
  document.getElementById(element.getAttribute("aria-describedby") ?? "");

const notices = (container: Element) =>
  [...container.querySelectorAll(".notice")].filter((notice) =>
    notice.querySelector(".notice-title")?.textContent === "Turn Failed");
const button = (container: Element, name: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === name);

test("a provider error reported twice renders one Turn Failed notice, the transcript's last row", async () => {
  const items = failedTurnItems();
  assert.deepEqual(items.filter((item) => item.kind === "error").map((item) => item.kind === "error" && item.message),
    ["Rate limit reached"], "the duplicate merged into one error, in the provider's own words");

  await withView(<EventTimeline items={items} />, async (view) => {
    const found = notices(view.container);
    assert.equal(found.length, 1);
    const notice = found[0]!;
    assert.ok(notice.classList.contains("t-danger"));
    assert.equal(notice.querySelector(".notice-body p")?.textContent,
      "The provider's usage limit was reached. Wait for it to reset, then retry.");
    assert.doesNotMatch(view.container.textContent ?? "", /⚠/u, "no emoji renders in error rows");
    const rows = view.container.querySelectorAll('[role="listitem"]');
    assert.ok(rows[rows.length - 1]!.contains(notice), "the failed turn's tail is its notice");
  });
});

test("Show Details reveals the raw provider message in a mono well, and only then", async () => {
  await withView(<EventTimeline items={failedTurnItems()} />, async (view) => {
    const notice = notices(view.container)[0]!;
    assertNoDomNode(notice.querySelector(".code-well"), "the raw message is not in the DOM until Show Details");
    assert.doesNotMatch(notice.textContent ?? "", /Rate limit reached/);

    await act(async () => button(notice as Element, "Show Details")!.click());
    assert.equal(notice.querySelector(".notice-details-body .code-well pre")?.textContent, "Rate limit reached");
    assert.ok(button(notice as Element, "Hide Details"));
  });
});

test("Retry Turn submits the failed turn's prompt, and names why when it cannot", async () => {
  const retried: string[] = [];
  const control = (overrides: Partial<TurnRetryControl> = {}): TurnRetryControl => ({
    onRetry: (prompt) => retried.push(prompt.text),
    ...overrides,
  });
  await withView(<EventTimeline items={failedTurnItems()} turnRetry={control()} />, async (view) => {
    const retry = button(view.container, "Retry Turn")!;
    assert.equal(retry.disabled, false);
    assert.equal(retry.getAttribute("aria-describedby"), null);
    await act(async () => retry.click());
    assert.deepEqual(retried, ["Summarize the release notes"]);

    await view.rerender(<EventTimeline items={failedTurnItems()} turnRetry={control({ unavailableReason: "Runner is offline." })} />);
    const disabled = button(view.container, "Retry Turn")!;
    assert.equal(disabled.disabled, true);
    const reason = describedBy(disabled);
    assert.equal(reason?.textContent, "Runner is offline.");
    assert.ok(reason?.closest(".notice-body"), "the reason is a visible line in the notice body");

    await view.rerender(<EventTimeline items={failedTurnItems()} turnRetry={control({ pendingPromptId: 1 })} />);
    const busy = button(view.container, "Retry Turn")!;
    assert.equal(busy.getAttribute("aria-busy"), "true", "the label stays and the button shows it is running");
    assert.equal(busy.getAttribute("aria-disabled"), "true");
  });
});

test("a failed turn a provider command opened cannot be retried from the notice", async () => {
  const items = failedTurnItems().map((item) => item.kind === "user_message" ? {
    ...item,
    commandInvocation: {
      invocationId: "i", submissionId: "s", providerCommandId: "p", catalogRevision: "r",
      commandName: "review", executionMode: "prompt" as const,
    },
  } : item) as TimelineItem[];
  await withView(<EventTimeline items={items} turnRetry={{ onRetry: () => assert.fail("retried") }} />, async (view) => {
    const retry = button(view.container, "Retry Turn")!;
    assert.equal(retry.disabled, true);
    assert.equal(describedBy(retry)?.textContent,
      "Run the command again from the composer to retry this turn.");
  });
});

test("a transcript that cannot start a turn shows the notice without Retry Turn", async () => {
  await withView(<EventTimeline items={failedTurnItems()} />, async (view) => {
    assert.equal(button(view.container, "Retry Turn"), undefined);
    assert.ok(button(view.container, "Show Details"));
  });
});

test("a stopped turn has no Interrupted row; its footer reads Stopped at its time with the square icon", async () => {
  const items: TimelineItem[] = [
    { kind: "user_message", id: 1, text: "Refactor the parser", createdAt: at(24) },
    { kind: "checkpoint", id: 2, turn: 3 },
    { kind: "agent_message", id: 3, text: "Starting with the lexer.", createdAt: at(24, 10) },
    { kind: "turn_interrupted", id: 4, createdAt: at(25) },
  ];
  await withView(<EventTimeline items={items} />, async (view) => {
    assert.doesNotMatch(view.container.textContent ?? "", /Interrupted/);
    const footer = view.container.querySelector(".tl-turn-footer")!;
    const stopped = footer.querySelector(".tl-turn-stopped")!;
    assert.ok(stopped, "the stop is a footer fact");
    assert.match(stopped.textContent?.replace(stopped.querySelector(".tl-tooltip")?.textContent ?? "", "") ?? "",
      /^Stopped at \d{1,2}:\d{2} [AP]M$/);
    assert.equal(stopped.querySelector("time")?.getAttribute("dateTime"), new Date(at(25)).toISOString());
    const icon = stopped.querySelector("svg")!;
    assert.equal(icon.getAttribute("width"), "14");
    assert.equal(icon.getAttribute("aria-hidden"), "true");
    assert.equal(view.container.querySelectorAll('[role="listitem"]').length, 2, "prompt and reply, no stop row");
  });
});

test("a stop in a turn no prompt opened still says when it stopped, without a turn number", async () => {
  await withView(<EventTimeline items={[
    { kind: "agent_message", id: 1, text: "Resuming background work.", createdAt: at(30) },
    { kind: "turn_interrupted", id: 2, createdAt: at(31) },
  ]} />, async (view) => {
    const footer = view.container.querySelector(".tl-turn-footer")!;
    assert.ok(footer.querySelector(".tl-turn-stopped"));
    assertNoDomNode(footer.querySelector(".tl-turn-label"), "an unnumbered turn claims no number");
  });
});
