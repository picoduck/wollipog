import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { Window } from "happy-dom";
import type { AgentQuestion, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
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

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  Simulate.change(input, { target: { value } } as never);
}

async function renderBanner(
  root: ReturnType<typeof createRoot>,
  questions: AgentQuestion[],
  runnerOnline: boolean,
  client: ApiClient = api,
) {
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <SessionQuestionBanner
          sessionId="session-1"
          requestId="question-1"
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
