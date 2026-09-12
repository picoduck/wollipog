import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { DescendantRequestView, ParentControlMode, SessionConfig, SessionView } from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { ComposerPlusMenu, useDescendantRequestPolling } from "./SessionDetail.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  FocusEvent: domWindow.FocusEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

test("the Composer guardrails expose and persist the concurrent live-child limit", async () => {
  const applied: Partial<SessionConfig>[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ComposerPlusMenu
      session={{ costBudgetUsd: null, costCheckpointsUsd: null, maxToolCalls: null,
        maxChildSessions: undefined } as SessionView}
      planActive={false}
      planSupported={false}
      onTogglePlan={() => {}}
      onApply={(patch) => applied.push(patch)}
      disabled={false}
      imageMimeTypes={[]}
      onAttachImages={() => {}}
    />);
  });
  try {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]');
    assert.ok(trigger);
    await act(async () => fireDomEvent.click(trigger));
    const liveChildLabel = [...container.querySelectorAll<HTMLLabelElement>("label")]
      .find((candidate) => candidate.textContent === "Live Child Limit");
    const input = liveChildLabel?.htmlFor
      ? container.querySelector<HTMLInputElement>(`#${liveChildLabel.htmlFor}`)
      : null;
    assert.ok(input, "the Composer menu includes a labelled live-child control");
    assert.equal(input.value, "");
    assert.equal(input.placeholder, "4");
    assert.equal(input.max, "64");
    assert.match(container.textContent ?? "", /Live Child Limit/);
    assert.doesNotMatch(container.textContent ?? "", /Pauses when spend reaches this amount/,
      "verbose guardrail guidance stays out of the compact menu by default");
    const costHelp = container.querySelector<HTMLButtonElement>('[aria-label="About Recurring Cost Threshold"]');
    assert.ok(costHelp, "each guardrail exposes its guidance through an info control");
    assert.equal(costHelp.getAttribute("aria-expanded"), "false");
    await act(async () => fireDomEvent.click(costHelp));
    assert.equal(costHelp.getAttribute("aria-expanded"), "true");
    assert.match(container.textContent ?? "", /Pauses when spend reaches this amount/);
    const helpPopover = container.querySelector<HTMLElement>(".plus-budget-help-popover");
    assert.ok(helpPopover);
    assert.equal(costHelp.getAttribute("aria-controls"), helpPopover.id);
    assert.equal(costHelp.getAttribute("aria-describedby"), helpPopover.id);
    const toolHelp = container.querySelector<HTMLButtonElement>('[aria-label="About Tool-Call Threshold"]');
    assert.ok(toolHelp);
    await act(async () => {
      fireDomEvent.pointerDown(toolHelp);
      fireDomEvent.click(toolHelp);
    });
    assert.equal(container.querySelectorAll(".plus-budget-help-popover").length, 1,
      "an outside pointer dismisses the previous disclosure before opening another");
    assert.equal(costHelp.getAttribute("aria-expanded"), "false");
    assert.equal(toolHelp.getAttribute("aria-expanded"), "true");
    await act(async () => fireDomEvent.keyDown(toolHelp, { key: "Escape" }));
    assert.equal(toolHelp.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelectorAll(".plus-budget-help-popover").length, 0);
    await act(async () => {
      input.focus();
    });
    // Opening the menu focuses the first cost input; moving focus here may commit its empty clear.
    // Isolate this assertion to the live-child field's own blur behavior.
    applied.length = 0;
    await act(async () => {
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(applied, [], "leaving an untouched default field does not pause child admission");
    await act(async () => {
      input.focus();
      fireDomEvent.change(input, { target: { value: "9" } });
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(applied.at(-1), { maxChildSessions: 9 });
    applied.length = 0;
    await act(async () => {
      input.focus();
      fireDomEvent.change(input, { target: { value: "-5" } });
      input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(applied, [], "an underflow typo cannot pause child admission");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the Composer exposes human-controlled Parent Control only for Orchestrator sessions", async () => {
  const selected: ParentControlMode[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (permissionMode: string) => root.render(<ComposerPlusMenu
    session={{ permissionMode, parentControl: "off", costBudgetUsd: null,
      costCheckpointsUsd: null, maxToolCalls: null } as SessionView}
    planActive={false}
    planSupported={false}
    onTogglePlan={() => {}}
    onApply={() => {}}
    onSetParentControl={(mode) => selected.push(mode)}
    disabled={false}
    imageMimeTypes={[]}
    onAttachImages={() => {}}
  />);
  await act(async () => render("default"));
  try {
    await act(async () => fireDomEvent.click(
      container.querySelector<HTMLButtonElement>('[aria-label="Add and Modes"]')!,
    ));
    assert.equal(container.querySelector('[aria-label^="Parent Control:"]'), null);

    await act(async () => render("orchestrator"));
    const select = container.querySelector<HTMLButtonElement>('[aria-label="Parent Control: Off"]');
    assert.ok(select);
    await act(async () => fireDomEvent.click(select));
    const questions = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("Questions") && !option.textContent?.includes("Approvals"));
    assert.ok(questions);
    await act(async () => fireDomEvent.click(questions));
    assert.deepEqual(selected, ["questions"]);
    assert.match(container.textContent ?? "", /Only an authenticated human can change/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function descendantRequest(title: string): DescendantRequestView {
  return {
    sessionId: `session-${title}`,
    sessionTitle: title,
    runnerId: "runner",
    runnerOnline: true,
    occurrenceId: `request-${title}`,
    request: {
      requestId: `provider-${title}`,
      occurrenceId: `request-${title}`,
      kind: "question",
      title: "Question",
      options: [],
      questions: [{ id: "q", header: "Next", question: "What next?", options: [] }],
    },
  };
}

test("descendant polling coalesces intervals and rejects superseded responses", async () => {
  const requests: Array<Deferred<{ requests: DescendantRequestView[] }> & {
    sessionId: string;
    signal?: AbortSignal;
  }> = [];
  const client = {
    ...api,
    descendantRequests: async (sessionId: string, signal?: AbortSignal) => {
      const request = { ...deferred<{ requests: DescendantRequestView[] }>(), sessionId, signal };
      requests.push(request);
      return request.promise;
    },
  } as ApiClient;
  let intervalHandler: (() => void) | undefined;
  const originalSetInterval = domWindow.setInterval;
  const originalClearInterval = domWindow.clearInterval;
  Object.defineProperty(domWindow, "setInterval", {
    configurable: true,
    value: ((handler: () => void) => {
      intervalHandler = handler;
      return 1 as unknown as ReturnType<typeof domWindow.setInterval>;
    }) as unknown as typeof domWindow.setInterval,
  });
  Object.defineProperty(domWindow, "clearInterval", {
    configurable: true,
    value: (() => {}) as typeof domWindow.clearInterval,
  });
  let requestReferenceChanges = 0;
  let exposedRefreshAfterResolution: (() => void) | undefined;
  function Harness({ sessionId, enabled }: { sessionId: string; enabled: boolean }) {
    const polling = useDescendantRequestPolling({ sessionId, enabled });
    exposedRefreshAfterResolution = polling.refreshAfterResolution;
    const priorRequests = React.useRef(polling.requests);
    React.useEffect(() => {
      if (priorRequests.current === polling.requests) return;
      requestReferenceChanges += 1;
      priorRequests.current = polling.requests;
    }, [polling.requests]);
    return <div>
      <button onClick={polling.refreshAfterResolution}>Refresh After Resolution</button>
      <span>{polling.requests.map((request) => request.sessionTitle).join(",")}</span>
    </div>;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (sessionId: string, enabled: boolean) => root.render(
    <ApiProvider client={client}><Harness sessionId={sessionId} enabled={enabled} /></ApiProvider>,
  );
  try {
    await act(async () => render("parent-a", true));
    assert.equal(requests.length, 1);
    await act(async () => intervalHandler?.());
    assert.equal(requests.length, 1, "a slow request coalesces the next interval poll");

    await act(async () => fireDomEvent.click(container.querySelector("button")!));
    assert.equal(requests.length, 2, "a resolution forces an immediate replacement request");
    assert.equal(requests[0]!.signal?.aborted, true);
    await act(async () => {
      requests[1]!.resolve({ requests: [descendantRequest("new")] });
      await requests[1]!.promise;
    });
    assert.equal(container.querySelector("span")?.textContent, "new");
    await act(async () => {
      requests[0]!.resolve({ requests: [descendantRequest("stale")] });
      await requests[0]!.promise;
    });
    assert.equal(container.querySelector("span")?.textContent, "new",
      "a superseded response cannot overwrite the current list");

    const referenceChangesAfterNewResult = requestReferenceChanges;
    await act(async () => intervalHandler?.());
    await act(async () => {
      requests[2]!.resolve({ requests: [descendantRequest("new")] });
      await requests[2]!.promise;
    });
    assert.equal(requestReferenceChanges, referenceChangesAfterNewResult,
      "a structurally unchanged poll retains the current state reference");

    await act(async () => intervalHandler?.());
    await act(async () => fireDomEvent.click(container.querySelector("button")!));
    assert.equal(requests[3]!.signal?.aborted, true);
    await act(async () => {
      requests[4]!.resolve({ requests: [descendantRequest("newer")] });
      await requests[4]!.promise;
    });
    await act(async () => {
      requests[3]!.reject(new Error("late failure"));
      await requests[3]!.promise.catch(() => {});
    });
    assert.equal(container.querySelector("span")?.textContent, "newer",
      "a superseded failure cannot clear a newer successful result");

    await act(async () => fireDomEvent.click(container.querySelector("button")!));
    await act(async () => {
      requests[5]!.reject(new Error("offline"));
      await requests[5]!.promise.catch(() => {});
    });
    assert.equal(container.querySelector("span")?.textContent, "",
      "a current request failure clears stale request controls");

    await act(async () => fireDomEvent.click(container.querySelector("button")!));
    await act(async () => render("parent-b", true));
    assert.equal(requests[6]!.signal?.aborted, true, "changing sessions aborts the old request");
    assert.equal(requests.length, 8);
    assert.equal(requests[7]!.sessionId, "parent-b");
    assert.equal(container.querySelector("span")?.textContent, "");
    const enabledRefresh = exposedRefreshAfterResolution;
    await act(async () => render("parent-b", false));
    assert.equal(requests[7]!.signal?.aborted, true, "disabling Parent Control aborts the request");
    assert.equal(container.querySelector("span")?.textContent, "");
    await act(async () => enabledRefresh?.());
    assert.equal(requests.length, 8, "a stale resolution callback cannot restart disabled polling");
    await act(async () => render("parent-b", true));
    assert.equal(requests.length, 9);
    await act(async () => root.unmount());
    assert.equal(requests[8]!.signal?.aborted, true, "unmounting aborts the active request");
  } finally {
    if (container.isConnected) await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(domWindow, "setInterval", { configurable: true, value: originalSetInterval });
    Object.defineProperty(domWindow, "clearInterval", { configurable: true, value: originalClearInterval });
  }
});
