import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
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
