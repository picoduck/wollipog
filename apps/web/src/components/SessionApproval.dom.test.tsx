import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { Window } from "happy-dom";
import type { AgentQuestion, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { clearQuestionDrafts } from "../question-response.js";
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

afterEach(() => {
  for (const requestId of ["question-1", "question-old", "question-new", "question-virtualized"]) {
    clearQuestionDrafts("session-1", requestId);
  }
});

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  Simulate.change(input, { target: { value } } as never);
}

async function renderBanner(
  root: ReturnType<typeof createRoot>,
  questions: AgentQuestion[],
  runnerOnline: boolean,
  client: ApiClient = api,
  requestId = "question-1",
) {
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <SessionQuestionBanner
          sessionId="session-1"
          requestId={requestId}
          questions={questions}
          runnerOnline={runnerOnline}
        />
      </ApiProvider>,
    );
  });
}

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

test("style changes preserve compatible drafts and submit exact labels with Ctrl+Enter", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [{
    id: "language",
    question: "Choose a language",
    options: [{ label: "TypeScript" }, { label: "Python" }],
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
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    await renderBanner(root, questions, true, client);
    const firstChoice = container.querySelector<HTMLButtonElement>('[role="radio"]');
    assert.ok(firstChoice);
    await act(async () => { firstChoice.click(); });

    await act(async () => { setQuestionResponseStyle("text", domWindow as never); });
    const input = container.querySelector<HTMLInputElement>(".question-text-input");
    assert.ok(input);
    assert.equal(input.value, "TypeScript");
    assert.ok(input.list, "fixed choices expose native keyboard autocomplete suggestions");
    assert.deepEqual([...container.querySelectorAll(".question-text-options li")].map((item) => item.textContent?.trim()), [
      "TypeScript",
      "Python",
    ]);

    await act(async () => { setInputValue(input, "2"); });
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    assert.equal(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.trim(), "●Python");

    await act(async () => { setQuestionResponseStyle("text", domWindow as never); });
    const textInput = container.querySelector<HTMLInputElement>(".question-text-input");
    assert.ok(textInput);
    textInput.focus();
    await act(async () => {
      textInput.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }) as never);
      await tick();
    });
    assert.deepEqual(calls, [{ requestId: "question-1", answers: { language: "Python" }, action: "submit" }]);
  } finally {
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("invalid text submission preserves responses, explains every error, and focuses the first invalid field", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [
    { id: "language", question: "Choose a language", options: [{ label: "TypeScript" }, { label: "Python" }] },
    {
      id: "checks",
      question: "Choose two checks",
      multiSelect: true,
      minSelections: 2,
      options: [{ label: "Unit Tests" }, { label: "Browser Tests" }],
    },
  ];

  try {
    setQuestionResponseStyle("text", domWindow as never);
    await renderBanner(root, questions, true);
    const inputs = [...container.querySelectorAll<HTMLInputElement>(".question-text-input")];
    assert.equal(inputs.length, 2);
    await act(async () => {
      setInputValue(inputs[0]!, "not offered");
      setInputValue(inputs[1]!, "1");
    });
    inputs[1]!.focus();
    await act(async () => {
      inputs[1]!.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
      }) as never);
      await tick();
    });

    assert.equal(inputs[0]!.value, "not offered");
    assert.equal(inputs[1]!.value, "1");
    assert.equal(container.querySelectorAll(".question-field-error").length, 2);
    assert.match(container.textContent ?? "", /displayed number or unambiguous option label/);
    assert.match(container.textContent ?? "", /Select at least 2 options/);
    assert.equal(domWindow.document.activeElement, inputs[0]);
  } finally {
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a replacement request clears text drafts even when question ids repeat", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const questions: AgentQuestion[] = [{
    id: "language",
    question: "Choose a language",
    options: [{ label: "TypeScript" }, { label: "Python" }],
  }];

  try {
    setQuestionResponseStyle("text", domWindow as never);
    await renderBanner(root, questions, true, api, "question-old");
    const input = container.querySelector<HTMLInputElement>(".question-text-input");
    assert.ok(input);
    await act(async () => { setInputValue(input, "1"); });
    assert.equal(input.value, "1");

    await renderBanner(root, questions, true, api, "question-new");
    assert.equal(container.querySelector<HTMLInputElement>(".question-text-input")?.value, "");
    assert.equal(submitButton(container).disabled, true);
  } finally {
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("text drafts survive unmount and remount for transcript virtualization", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const questions: AgentQuestion[] = [{
    id: "language",
    question: "Choose a language",
    options: [{ label: "TypeScript" }, { label: "Python" }],
  }];

  try {
    setQuestionResponseStyle("text", domWindow as never);
    const firstRoot = createRoot(container);
    await renderBanner(firstRoot, questions, true, api, "question-virtualized");
    const input = container.querySelector<HTMLInputElement>(".question-text-input");
    assert.ok(input);
    await act(async () => { setInputValue(input, "2"); });
    await act(async () => { firstRoot.unmount(); });

    const secondRoot = createRoot(container);
    await renderBanner(secondRoot, questions, true, api, "question-virtualized");
    assert.equal(container.querySelector<HTMLInputElement>(".question-text-input")?.value, "2");
    await act(async () => { secondRoot.unmount(); });
  } finally {
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
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

test("secret drafts survive mounted style changes but are not recovered after virtualization", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const questions: AgentQuestion[] = [{
    id: "token",
    question: "Enter the token",
    options: [],
    allowOther: true,
    secret: true,
  }];

  try {
    setQuestionResponseStyle("text", domWindow as never);
    const firstRoot = createRoot(container);
    await renderBanner(firstRoot, questions, true, api, "question-virtualized");
    let input = container.querySelector<HTMLInputElement>(".question-text-input");
    assert.ok(input);
    await act(async () => { setInputValue(input!, "page-only-secret"); });
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    input = container.querySelector<HTMLInputElement>(".question-input");
    assert.equal(input?.value, "page-only-secret", "mounted style changes preserve the secret response");
    await act(async () => { setQuestionResponseStyle("text", domWindow as never); });
    assert.equal(container.querySelector<HTMLInputElement>(".question-text-input")?.value, "page-only-secret");
    await act(async () => { firstRoot.unmount(); });

    const secondRoot = createRoot(container);
    await renderBanner(secondRoot, questions, true, api, "question-virtualized");
    assert.equal(container.querySelector<HTMLInputElement>(".question-text-input")?.value, "");
    assert.equal(submitButton(container).disabled, true);
    await act(async () => { secondRoot.unmount(); });
  } finally {
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    container.remove();
  }
});
