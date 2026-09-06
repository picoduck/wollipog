import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentQuestion, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { claimQuestionResponseOperation, clearQuestionDrafts, storedQuestionDrafts } from "../question-response.js";
import { setQuestionResponseStyle } from "../question-response-style.js";
import { SessionQuestionBanner } from "./SessionApproval.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

function deferredAnswer() {
  let resolve!: (session: SessionView) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SessionView>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const action of ["submit", "dismiss"] as const) {
  for (const transition of ["clear", "replace", "remount", "return", "unchanged"] as const) {
    for (const result of ["resolve", "reject"] as const) {
      test(`delayed form ${action} ${result} respects ownership after ${transition}`, async () => {
        const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
        domWindow.document.body.append(container as never);
        const root = createRoot(container);
        const answer = deferredAnswer();
        const updates: SessionView[] = [];
        const calls: Parameters<ApiClient["answerQuestion"]>[1][] = [];
        const client = { ...api, answerQuestion: (_id, body) => { calls.push(body); return answer.promise; } } as ApiClient;
        const returned = { id: "session-1" } as SessionView;
        const render = (requestId: string | null) => root.render(<ApiProvider client={client}>
          {requestId && <SessionQuestionBanner sessionId="session-1" requestId={requestId}
            questions={[{ id: "note", question: `Question ${requestId}`, options: [], allowOther: true }]}
            runnerOnline onSessionUpdate={(session) => updates.push(session)} />}
        </ApiProvider>);
        try {
          setQuestionResponseStyle("interactive", domWindow as never);
          await act(async () => render("question-old"));
          await act(async () => setInputValue(container.querySelector("input")!, "Old Draft"));
          await act(async () => container.querySelector<HTMLButtonElement>(`[data-session-request-control=${action}]`)!.click());
          assert.equal(calls.length, 1);
          assert.equal(calls[0]!.action, action);
          assert.deepEqual(calls[0]!.answers, action === "submit" ? { note: "Old Draft" } : {});
          if (transition === "clear" || transition === "remount") await act(async () => render(null));
          if (transition === "replace" || transition === "return") await act(async () => render("question-new"));
          if (transition === "remount" || transition === "return") await act(async () => render("question-old"));
          const replaced = transition !== "clear" && transition !== "unchanged";
          const replacement = container.querySelector<HTMLInputElement>("input");
          if (replaced) {
            await act(async () => setInputValue(replacement!, "Replacement Draft"));
            replacement!.focus();
          }
          await act(async () => {
            if (result === "resolve") answer.resolve(returned);
            else answer.reject(new Error("Old answer rejected"));
            await tick();
          });
          assert.deepEqual(updates, transition === "unchanged" && result === "resolve" ? [returned] : []);
          assert.equal(container.querySelector('[role="alert"]')?.textContent ?? "",
            transition === "unchanged" && result === "reject" ? "Could not answer the question: Old answer rejected" : "");
          if (replaced) {
            assert.equal(replacement!.value, "Replacement Draft");
            assert.equal(domWindow.document.activeElement, replacement);
            assert.equal(container.querySelector("section")!.getAttribute("aria-busy"), "false");
            assert.deepEqual(storedQuestionDrafts("session-1", transition === "replace" ? "question-new" : "question-old"),
              { note: { kind: "other", value: "Replacement Draft" } });
          }
          const release = claimQuestionResponseOperation("session-1", "question-old");
          assert.ok(release, "every settled response releases its own lease even when retired");
          release();
        } finally {
          answer.resolve(returned);
          await act(async () => root.unmount());
          container.remove();
        }
      });
    }
  }
}

for (const action of ["submit", "dismiss"] as const) {
  test(`retired form ${action} cleanup preserves a replacement operation and newer same-key lease`, async () => {
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.append(container as never);
    const root = createRoot(container);
    const old = deferredAnswer();
    const current = deferredAnswer();
    let calls = 0;
    const client = { ...api, answerQuestion: () => (++calls === 1 ? old.promise : current.promise) } as ApiClient;
    let newerLease: (() => void) | null = null;
    try {
      const questions = [{ id: "note", question: "Optional note", options: [], allowOther: true, required: false }];
      await renderBanner(root, questions, true, client, "question-old");
      await act(async () => container.querySelector<HTMLButtonElement>(`[data-session-request-control=${action}]`)!.click());
      await renderBanner(root, questions, true, client, "question-new");
      await act(async () => container.querySelector<HTMLButtonElement>(`[data-session-request-control=${action}]`)!.click());
      assert.equal(calls, 2, "a replacement request can start while its predecessor is pending");
      newerLease = claimQuestionResponseOperation("session-1", "question-old", Date.now() + 60_001);
      assert.ok(newerLease, "expired old lease can be replaced independently");
      await act(async () => { old.resolve({} as SessionView); await tick(); });
      assert.equal(container.querySelector("section")!.getAttribute("aria-busy"), "true");
      assert.equal(claimQuestionResponseOperation("session-1", "question-old"), null,
        "old finally must not release a newer lease for its key");
      assert.equal(claimQuestionResponseOperation("session-1", "question-new"), null,
        "old finally must not release the replacement request lease");
      await act(async () => { current.reject(new Error("Current failure")); await tick(); });
      assert.match(container.querySelector('[role="alert"]')!.textContent!, /Current failure/);
      assert.equal(container.querySelector("section")!.getAttribute("aria-busy"), "false");
    } finally {
      old.resolve({} as SessionView);
      current.resolve({} as SessionView);
      newerLease?.();
      await act(async () => root.unmount());
      container.remove();
    }
  });
}

test("retired form validation cannot focus the replacement question", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const originalRaf = domWindow.requestAnimationFrame;
  let focusCallback: FrameRequestCallback | undefined;
  domWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => { focusCallback = callback; return 1; }) as unknown as typeof originalRaf;
  try {
    const questions = [{ id: "note", question: "Required note", options: [], allowOther: true }];
    await renderBanner(root, questions, true, api, "question-old");
    await act(async () => container.querySelector("section")!.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, bubbles: true,
    }) as never));
    assert.ok(focusCallback);
    await renderBanner(root, questions, true, api, "question-new");
    const dismiss = container.querySelector<HTMLButtonElement>('[data-session-request-control="dismiss"]')!;
    dismiss.focus();
    focusCallback(0);
    assert.equal(domWindow.document.activeElement, dismiss);
  } finally {
    domWindow.requestAnimationFrame = originalRaf;
    await act(async () => root.unmount());
    container.remove();
  }
});

afterEach(() => {
  for (const requestId of ["question-1", "question-old", "question-new", "question-virtualized"]) {
    clearQuestionDrafts("session-1", requestId);
  }
});

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  fireDomEvent.change(input, { target: { value } } as never);
}

async function renderBanner(
  root: ReturnType<typeof createRoot>,
  questions: AgentQuestion[],
  runnerOnline: boolean,
  client: ApiClient = api,
  requestId = "question-1",
  recovery?: { reason: "provider_restart"; action?: "resume_answer" },
) {
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <SessionQuestionBanner
          sessionId="session-1"
          requestId={requestId}
          questions={questions}
          recoveryReason={recovery?.reason}
          recoveryAction={recovery?.action}
          runnerOnline={runnerOnline}
        />
      </ApiProvider>,
    );
  });
}

test("a resumable recovered question keeps its preserved form answerable", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const client = {
    ...api,
    answerQuestion: async (_sessionId: string, action: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push(structuredClone(action));
      return {} as SessionView;
    },
  } as ApiClient;
  const questions: AgentQuestion[] = [{
    id: "language",
    question: "Choose a language",
    options: [{ label: "TypeScript" }, { label: "Python" }],
  }];

  try {
    await renderBanner(root, questions, true, client, "question-1", {
      reason: "provider_restart",
      action: "resume_answer",
    });
    assert.match(container.textContent ?? "", /resume the existing agent conversation and deliver these answers once/);
    assert.match(container.textContent ?? "", /Prior tool calls will not be replayed/);
    const choice = container.querySelector<HTMLButtonElement>('[role="radio"]');
    assert.ok(choice);
    assert.equal(choice.disabled, false);
    await act(async () => { choice.click(); });
    assert.equal(submitButton(container).disabled, false);
    await act(async () => {
      submitButton(container).click();
      await tick();
    });
    assert.deepEqual(calls, [{
      requestId: "question-1",
      answers: { language: "TypeScript" },
      action: "submit",
    }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

function submitButton(container: HTMLDivElement): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".approval-actions button")]
    .find((candidate) => candidate.textContent?.trim() === "Submit");
  assert.ok(button);
  return button;
}

test("unsupported multi-select Other responses are deactivated while Dismiss remains usable", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const calls: Array<{ sessionId: string; action: Parameters<ApiClient["answerQuestion"]>[1] }> = [];
  const client = {
    ...api,
    answerQuestion: async (sessionId: string, action: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push({ sessionId, action: structuredClone(action) });
      return {} as SessionView;
    },
  } as ApiClient;
  const questions: AgentQuestion[] = [{
    id: "features",
    question: "Choose features or add another",
    multiSelect: true,
    allowOther: true,
    options: [{ label: "Audit" }],
  }];

  try {
    await renderBanner(root, questions, true, client);
    assert.equal(container.querySelector(".question-input"), null);
    const choice = container.querySelector<HTMLButtonElement>('[role="checkbox"]');
    assert.ok(choice);
    assert.equal(choice.disabled, true);
    assert.equal(choice.getAttribute("aria-disabled"), "true");
    assert.equal(choice.tabIndex, -1);
    assert.equal(submitButton(container).disabled, true);

    const dismiss = [...container.querySelectorAll<HTMLButtonElement>(".approval-actions button")]
      .find((candidate) => candidate.textContent?.trim().startsWith("Dismiss"));
    assert.ok(dismiss);
    assert.equal(dismiss.disabled, false);
    await act(async () => {
      dismiss.click();
      await tick();
    });
    assert.deepEqual(calls, [{
      sessionId: "session-1",
      action: { requestId: "question-1", answers: {}, action: "dismiss" },
    }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("constrained free text exposes its shared validation reason and accessible field state", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [{
    id: "retries",
    header: "Retries",
    question: "How many retries?",
    context: "Retry policy for this deployment",
    options: [],
    allowOther: true,
    inputFormat: "integer",
    minimum: 1,
    maximum: 5,
  }];

  try {
    await renderBanner(root, questions, true);
    const input = container.querySelector<HTMLInputElement>(".question-input");
    assert.ok(input);
    assert.equal(input.required, true);
    assert.equal(input.getAttribute("aria-required"), "true");
    assert.equal(submitButton(container).disabled, true);

    await act(async () => { setInputValue(input, "8"); });
    const fieldError = container.querySelector<HTMLElement>(".question-field-error");
    assert.ok(fieldError);
    assert.equal(fieldError.textContent, "Response is above its maximum.");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.ok(input.getAttribute("aria-describedby")?.split(" ").includes(fieldError.id));
    assert.match(container.querySelector(".question-submit-hint")?.textContent ?? "", /Correct the response errors/);
    assert.equal(submitButton(container).disabled, true);

    await act(async () => { setInputValue(input, "3"); });
    assert.equal(container.querySelector(".question-field-error"), null);
    assert.equal(input.getAttribute("aria-invalid"), null);
    assert.equal(submitButton(container).disabled, false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("an online-to-offline transition keeps choices reachable and explains every unavailable response", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [{
    id: "target",
    question: "Choose a target",
    options: [{ label: "Staging" }, { label: "Production" }],
    allowOther: true,
  }];

  try {
    await renderBanner(root, questions, true);
    assert.equal(container.querySelector<HTMLButtonElement>(".question-option")?.disabled, false);
    assert.equal(container.querySelector<HTMLInputElement>(".question-input")?.disabled, false);
    const availability = container.querySelector(".question-availability");
    assert.ok(availability);
    assert.equal(availability.textContent, "");
    assert.equal(availability.getAttribute("role"), "status");
    assert.equal(availability.getAttribute("aria-atomic"), "true");

    assert.ok(availability.id);
    await renderBanner(root, questions, false);
    const choices = [...container.querySelectorAll<HTMLButtonElement>(".question-option")];
    assert.equal(choices.length, 2);
    assert.ok(choices.every((choice) => !choice.disabled));
    assert.ok(choices.every((choice) => choice.getAttribute("aria-disabled") === "true"));
    assert.deepEqual(choices.map((choice) => choice.tabIndex), [0, -1]);
    const input = container.querySelector<HTMLInputElement>(".question-input");
    assert.ok(input?.disabled);
    assert.ok([...container.querySelectorAll<HTMLButtonElement>(".approval-actions button")]
      .every((control) => control.disabled));
    assert.equal(
      container.querySelector(".question-availability")?.textContent,
      "Responses are unavailable until the runner reconnects.",
    );
    const offlineAvailability = container.querySelector<HTMLElement>(".question-availability");
    assert.equal(offlineAvailability?.getAttribute("role"), "status");
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]');
    assert.ok(group?.getAttribute("aria-describedby")?.split(" ").includes(offlineAvailability!.id));
    assert.ok(input.getAttribute("aria-describedby")?.split(" ").includes(offlineAvailability!.id));
    assert.ok([...container.querySelectorAll<HTMLButtonElement>(".approval-actions button")]
      .every((control) => control.getAttribute("aria-describedby") === offlineAvailability!.id));

    await act(async () => { choices[0]!.click(); });
    assert.equal(choices[0]!.getAttribute("aria-checked"), "false");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("keyboard choice selection clears an Other draft and submits the visible fixed option", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [{
    id: "target",
    question: "Choose a target",
    context: "Deployment destination",
    options: [{ label: "Staging" }, { label: "Production" }],
    allowOther: true,
  }];
  const calls: Array<{ sessionId: string; action: Parameters<ApiClient["answerQuestion"]>[1] }> = [];
  const client = {
    ...api,
    answerQuestion: async (sessionId: string, action: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push({ sessionId, action: structuredClone(action) });
      return {} as SessionView;
    },
  } as ApiClient;

  try {
    await renderBanner(root, questions, true, client);
    const input = container.querySelector<HTMLInputElement>(".question-input");
    assert.ok(input);
    assert.equal(input.required, false, "Other is an alternative to the required fixed choices");
    const requirementId = input.getAttribute("aria-describedby")?.split(" ")
      .find((id) => id.includes("-requirement-"));
    assert.equal(
      requirementId ? domWindow.document.getElementById(requirementId)?.textContent?.trim() : null,
      "An answer to this question is required.",
    );
    await act(async () => { setInputValue(input, "Canary"); });
    assert.equal(input.value, "Canary");
    assert.equal(submitButton(container).disabled, false);

    const firstChoice = container.querySelector<HTMLButtonElement>('[role="radio"]');
    assert.ok(firstChoice);
    firstChoice.focus();
    await act(async () => {
      firstChoice.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never);
    });

    const selected = container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]');
    assert.equal(selected?.textContent?.trim(), "●Production");
    assert.equal(input.value, "");
    assert.equal(submitButton(container).disabled, false);

    await act(async () => {
      submitButton(container).click();
      await tick();
    });
    assert.deepEqual(calls, [{
      sessionId: "session-1",
      action: { requestId: "question-1", answers: { target: "Production" }, action: "submit" },
    }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Composer Response keeps the transcript card as context without card-owned response fields", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [{
    id: "language",
    question: "Choose a language",
    options: [{ label: "TypeScript" }, { label: "Python" }],
  }];

  try {
    setQuestionResponseStyle("composer", domWindow as never);
    await renderBanner(root, questions, true);
    assert.equal(container.querySelector(".question-input"), null);
    assert.equal(container.querySelector(".approval-actions button")?.textContent?.trim(), "Dismiss D");
    assert.match(container.textContent ?? "", /Respond through Answer Mode in the Session composer/);
    assert.deepEqual([...container.querySelectorAll(".question-text-options li")].map((item) => item.textContent?.trim()), [
      "TypeScript",
      "Python",
    ]);
  } finally {
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Composer Response does not advertise Answer Mode without a question schema", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    setQuestionResponseStyle("composer", domWindow as never);
    await renderBanner(root, [], true);
    assert.doesNotMatch(container.textContent ?? "", /Press R|\/respond/);
  } finally {
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Interactive Form accumulates bounded multi-select choices and recovers after exceeding the maximum", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [{
    id: "checks",
    question: "Choose exactly two checks",
    multiSelect: true,
    minSelections: 2,
    maxSelections: 2,
    options: [{ label: "Unit Tests" }, { label: "Browser Tests" }, { label: "Smoke Test" }],
  }];
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const client = {
    ...api,
    answerQuestion: async (_sessionId: string, action: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push(structuredClone(action));
      return {} as SessionView;
    },
  } as ApiClient;

  try {
    setQuestionResponseStyle("interactive", domWindow as never);
    await renderBanner(root, questions, true, client);
    const choices = [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    await act(async () => { choices[0]!.click(); });
    assert.equal(choices[0]!.getAttribute("aria-checked"), "true");
    assert.equal(submitButton(container).disabled, true);

    await act(async () => { choices[1]!.click(); });
    assert.deepEqual(choices.slice(0, 2).map((choice) => choice.getAttribute("aria-checked")), ["true", "true"]);
    assert.equal(submitButton(container).disabled, false);

    await act(async () => { choices[2]!.click(); });
    assert.ok(choices.every((choice) => choice.getAttribute("aria-checked") === "true"));
    assert.equal(submitButton(container).disabled, true);
    assert.match(container.textContent ?? "", /Select at most 2 options/);

    await act(async () => { choices[0]!.click(); });
    assert.deepEqual(choices.map((choice) => choice.getAttribute("aria-checked")), ["false", "true", "true"]);
    assert.equal(submitButton(container).disabled, false);
    await act(async () => {
      submitButton(container).click();
      await tick();
    });
    assert.deepEqual(calls, [{
      requestId: "question-1",
      answers: { checks: ["Browser Tests", "Smoke Test"] },
      action: "submit",
    }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Interactive Other intent survives an exact option prefix while fixed clicks remain exact choices", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [{
    id: "target",
    question: "Choose a target",
    options: [{ label: "Production" }, { label: "Staging" }],
    allowOther: true,
  }];
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const client = {
    ...api,
    answerQuestion: async (_sessionId: string, action: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push(structuredClone(action));
      return {} as SessionView;
    },
  } as ApiClient;

  try {
    setQuestionResponseStyle("interactive", domWindow as never);
    await renderBanner(root, questions, true, client);
    const input = container.querySelector<HTMLInputElement>(".question-input");
    assert.ok(input);
    for (const value of ["Prod", "Production", "Production west region"]) {
      await act(async () => { setInputValue(input, value); });
      assert.equal(input.value, value);
      assert.equal(container.querySelector('[role="radio"][aria-checked="true"]'), null);
    }
    await act(async () => {
      submitButton(container).click();
      await tick();
    });
    assert.deepEqual(calls[0], {
      requestId: "question-1",
      answers: { target: "Production west region" },
      action: "submit",
    });

    const production = container.querySelector<HTMLButtonElement>('[role="radio"]');
    assert.ok(production);
    await act(async () => { production.click(); });
    assert.equal(input.value, "");
    await act(async () => {
      submitButton(container).click();
      await tick();
    });
    assert.deepEqual(calls[1], {
      requestId: "question-1",
      answers: { target: "Production" },
      action: "submit",
    });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Interactive numeric Other submits prose without applying hidden ordinal syntax", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [{
    id: "workers",
    question: "Choose a worker count",
    options: [{ label: "Auto" }, { label: "Two Workers" }],
    allowOther: true,
    inputFormat: "integer",
    minimum: 1,
    maximum: 10,
  }];
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const client = {
    ...api,
    answerQuestion: async (_sessionId: string, action: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push(structuredClone(action));
      return {} as SessionView;
    },
  } as ApiClient;

  try {
    setQuestionResponseStyle("interactive", domWindow as never);
    await renderBanner(root, questions, true, client);
    const input = container.querySelector<HTMLInputElement>('.question-input[type="number"]');
    assert.ok(input);
    await act(async () => { setInputValue(input, "2"); });
    assert.equal(container.querySelector('[role="radio"][aria-checked="true"]'), null);
    await act(async () => {
      submitButton(container).click();
      await tick();
    });
    assert.deepEqual(calls[0], {
      requestId: "question-1",
      answers: { workers: "2" },
      action: "submit",
    });

    const fixedChoice = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((choice) => choice.textContent?.includes("Two Workers"));
    assert.ok(fixedChoice);
    await act(async () => { fixedChoice.click(); });
    await act(async () => {
      submitButton(container).click();
      await tick();
    });
    assert.deepEqual(calls[1], {
      requestId: "question-1",
      answers: { workers: "Two Workers" },
      action: "submit",
    });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Composer Response never renders secret entry controls in the transcript card", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [{
    id: "token",
    question: "Enter the token",
    options: [],
    allowOther: true,
    secret: true,
  }];

  try {
    setQuestionResponseStyle("composer", domWindow as never);
    await renderBanner(root, questions, true, api, "question-virtualized");
    assert.equal(container.querySelector("input"), null);
    assert.match(container.textContent ?? "", /Respond through Answer Mode/);
  } finally {
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
