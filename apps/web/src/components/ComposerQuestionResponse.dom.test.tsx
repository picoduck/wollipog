import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentQuestion, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { clearQuestionDrafts, storedQuestionDrafts } from "../question-response.js";
import { ComposerQuestionResponse } from "./ComposerQuestionResponse.js";

const domWindow = new Window({ url: "http://localhost/" });
domWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  callback(0);
  return 1;
}) as unknown as typeof domWindow.requestAnimationFrame;
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
  for (const requestId of ["ask-single", "ask-flow", "ask-palette", "ask-replacement"]) {
    clearQuestionDrafts("session-1", requestId);
  }
});

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  fireDomEvent.change(input, { target: { value } } as never);
}

function Harness({
  client,
  questions,
  requestId,
  initiallyActive = true,
  runnerOnline = true,
}: {
  client: ApiClient;
  questions: AgentQuestion[];
  requestId: string;
  initiallyActive?: boolean;
  runnerOnline?: boolean;
}) {
  const [active, setActive] = useState(initiallyActive);
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <ApiProvider client={client}>
      <ComposerQuestionResponse
        sessionId="session-1"
        requestId={requestId}
        questions={questions}
        runnerOnline={runnerOnline}
        active={active}
        showWaiting
        inputRef={inputRef}
        onEnter={() => setActive(true)}
        onExit={() => setActive(false)}
      />
    </ApiProvider>
  );
}

test("Enter keeps invalid input focused and submits one deterministic choice through the exact request", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const calls: Array<{ sessionId: string; body: Parameters<ApiClient["answerQuestion"]>[1] }> = [];
  const client = {
    ...api,
    answerQuestion: async (sessionId: string, body: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push({ sessionId, body: structuredClone(body) });
      return {} as SessionView;
    },
  } as ApiClient;
  const questions: AgentQuestion[] = [{
    id: "language",
    question: "Choose a language",
    context: "Used for the generated client",
    options: [{ label: "TypeScript" }, { label: "Python" }],
  }];

  try {
    await act(async () => root.render(<Harness client={client} questions={questions} requestId="ask-single" />));
    const input = container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(input);
    input.focus();
    await act(async () => {
      setInputValue(input, "not offered");
      input.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
    });
    assert.equal(input.value, "not offered");
    assert.equal(domWindow.document.activeElement, input);
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /displayed number/);
    assert.deepEqual(calls, []);

    await act(async () => {
      setInputValue(input, "2");
      input.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
      await tick();
    });
    assert.deepEqual(calls, [{
      sessionId: "session-1",
      body: { requestId: "ask-single", answers: { language: "Python" }, action: "submit" },
    }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("multiple questions advance in sequence while a masked secret survives mode exit without persistence", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const client = {
    ...api,
    answerQuestion: async (_sessionId: string, body: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push(structuredClone(body));
      return {} as SessionView;
    },
  } as ApiClient;
  const questions: AgentQuestion[] = [
    { id: "target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }] },
    { id: "token", question: "Enter the token", options: [], allowOther: true, secret: true },
  ];

  try {
    await act(async () => root.render(<Harness client={client} questions={questions} requestId="ask-flow" />));
    let input = container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(input);
    await act(async () => {
      setInputValue(input!, "Production");
      input!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
    });
    input = container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.equal(input?.type, "password");
    assert.match(container.textContent ?? "", /Answering Question 2 of 2/);
    await act(async () => setInputValue(input!, "page-only-secret"));
    assert.deepEqual(storedQuestionDrafts("session-1", "ask-flow"), {
      target: { kind: "entry", value: "Production" },
    });

    const exit = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Exit Answer Mode");
    assert.ok(exit);
    await act(async () => exit.click());
    assert.equal(container.querySelector(".composer-answer-input"), null);
    const respond = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Respond");
    assert.ok(respond);
    await act(async () => respond.click());
    input = container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.equal(input?.value, "page-only-secret");
    await act(async () => {
      input!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
      await tick();
    });
    assert.deepEqual(calls, [{
      requestId: "ask-flow",
      answers: { target: "Production", token: "page-only-secret" },
      action: "submit",
    }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("choice palette keys stay scoped to palette buttons and enforce multi-select bounds", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const client = {
    ...api,
    answerQuestion: async (_sessionId: string, body: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push(structuredClone(body));
      return {} as SessionView;
    },
  } as ApiClient;
  const questions: AgentQuestion[] = [{
    id: "checks",
    question: "Choose two checks",
    multiSelect: true,
    minSelections: 2,
    maxSelections: 2,
    options: [{ label: "Unit Tests" }, { label: "Browser Tests" }, { label: "Smoke Test" }],
  }];

  try {
    await act(async () => root.render(<Harness client={client} questions={questions} requestId="ask-palette" />));
    const input = container.querySelector<HTMLInputElement>(".composer-answer-input");
    assert.ok(input);
    await act(async () => setInputValue(input, "1"));
    assert.equal(input.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never), true,
      "printable-entry focus retains ordinary arrow-key behavior");
    await act(async () => {
      input.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
    });
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /at least 2/);

    const choices = [...container.querySelectorAll<HTMLButtonElement>(".composer-answer-choice")];
    choices[0]!.focus();
    await act(async () => {
      choices[0]!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never);
    });
    assert.equal(domWindow.document.activeElement, choices[1]);
    await act(async () => {
      choices[1]!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "x", bubbles: true }) as never);
    });
    assert.equal(input.value, "Unit Tests, Browser Tests");
    await act(async () => {
      choices[1]!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
      await tick();
    });
    assert.deepEqual(calls, [{
      requestId: "ask-palette",
      answers: { checks: ["Unit Tests", "Browser Tests"] },
      action: "submit",
    }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
