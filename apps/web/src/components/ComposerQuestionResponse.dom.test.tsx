import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentQuestion, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { clearQuestionDrafts, questionDraftIdentity, storedQuestionDrafts, storedQuestionStep, storeQuestionStep } from "../question-response.js";
import { ComposerQuestionResponse, answerSelectionSummary } from "./ComposerQuestionResponse.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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
  for (const requestId of ["ask-single", "ask-flow", "ask-choices", "ask-replacement", "ask-context", "ask-steps", "ask-busy"]) {
    clearQuestionDrafts("session-1", requestId);
  }
});

function mount() {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  return { container, root: createRoot(container) };
}

function recordingClient(calls: Array<Parameters<ApiClient["answerQuestion"]>[1]>): ApiClient {
  return {
    ...api,
    answerQuestion: async (_sessionId: string, body: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push(structuredClone(body));
      return { id: "session-1" } as SessionView;
    },
  } as ApiClient;
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  fireDomEvent.change(input, { target: { value } } as never);
}

function press(target: Element, key: string) {
  target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as never);
}

function answerInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(".composer-answer-input");
  assert.ok(input, "the answer field");
  return input;
}

/** The choice row inputs of the current question, by their visible titles. */
function row(container: HTMLElement, title: string): HTMLInputElement {
  const found = [...container.querySelectorAll<HTMLElement>(".answer-options .choice-row")]
    .find((candidate) => candidate.querySelector(".choice-row-title")?.textContent === title);
  assert.ok(found, `the ${title} row`);
  return found.querySelector<HTMLInputElement>("input")!;
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name);
  assert.ok(found, `the ${name} button`);
  return found;
}

/** As SessionDetail: Answer Mode while it is open, and the dock's Answer while it is closed. */
function Harness({
  client,
  questions,
  requestId,
  runnerOnline = true,
  revealRef,
}: {
  client: ApiClient;
  questions: AgentQuestion[];
  requestId: string;
  runnerOnline?: boolean;
  revealRef?: React.MutableRefObject<((requestId: string) => boolean) | null>;
}) {
  const [active, setActive] = useState(true);
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <ApiProvider client={client}>
      <ComposerQuestionResponse
        sessionId="session-1"
        requestId={requestId}
        questions={questions}
        runnerOnline={runnerOnline}
        active={active}
        inputRef={inputRef}
        revealRef={revealRef}
        onExit={() => setActive(false)}
      />
      {!active && <button type="button" data-dock-answer="" onClick={() => setActive(true)}>Answer</button>}
    </ApiProvider>
  );
}

test("Composer Answer Mode binds a reused async request id to its current occurrence", async () => {
  const { container, root } = mount();
  const calls: Parameters<ApiClient["answerQuestion"]>[1][] = [];
  const render = (occurrenceId: string) => root.render(<ApiProvider client={recordingClient(calls)}>
    <ComposerQuestionResponse sessionId="session-1" requestId="ask-reused"
      occurrenceId={occurrenceId} isAsync
      questions={[{ id: "0", question: "Which path?", options: [], allowOther: true }]}
      runnerOnline active inputRef={{ current: null }} onExit={() => {}} />
  </ApiProvider>);
  try {
    await act(async () => render("request_old"));
    assert.equal(container.querySelector(".answer-kind")?.textContent, "Async Question");
    await act(async () => setInputValue(answerInput(container), "Old answer"));
    await act(async () => render("request_new"));
    const input = answerInput(container);
    assert.equal(input.value, "");
    await act(async () => {
      setInputValue(input, "New answer");
      press(input, "Enter");
      await tick();
    });
    assert.deepEqual(calls, [{
      requestId: "ask-reused", occurrenceId: "request_new",
      answers: { "0": "New answer" }, action: "submit",
    }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    clearQuestionDrafts("session-1", "ask-reused:request_old");
    clearQuestionDrafts("session-1", "ask-reused:request_new");
  }
});

for (const transition of ["clear", "replace", "remount", "unchanged"] as const) {
 for (const result of ["resolve", "reject"] as const) {
  test(`delayed answer ${result} respects live question ownership after ${transition}`, async () => {
    const { container, root } = mount();
    let resolveAnswer!: (session: SessionView) => void;
    let rejectAnswer!: (error: Error) => void;
    const answer = new Promise<SessionView>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
    const updates: SessionView[] = [];
    let exits = 0;
    let calls = 0;
    const client = { ...api, answerQuestion: () => { calls++; return answer; } } as ApiClient;
    const returnedSession = { id: "session-1" } as SessionView;
    const renderQuestion = (requestId: string | null) => root.render(
      <ApiProvider client={client}>
        {requestId && <ComposerQuestionResponse
          sessionId="session-1"
          requestId={requestId}
          questions={[{ id: "target", question: `Question ${requestId}`, options: [{ label: "Staging" }] }]}
          runnerOnline active inputRef={{ current: null }}
          onExit={() => { exits++; }}
          onSessionUpdate={(session) => { updates.push(session); }}
        />}
      </ApiProvider>,
    );
    try {
      await act(async () => renderQuestion("ask-single"));
      const input = answerInput(container);
      await act(async () => {
        setInputValue(input, "1");
        press(input, "Enter");
      });
      assert.equal(calls, 1);
      if (transition === "clear" || transition === "remount") await act(async () => renderQuestion(null));
      if (transition === "replace" || transition === "remount") await act(async () => renderQuestion("ask-replacement"));
      await act(async () => {
        if (result === "resolve") resolveAnswer(returnedSession);
        else rejectAnswer(new Error("Answer rejected"));
        await tick();
      });
      const ownedSuccess = transition === "unchanged" && result === "resolve";
      assert.deepEqual(updates, ownedSuccess ? [returnedSession] : []);
      assert.equal(exits, ownedSuccess ? 1 : 0);
      const alert = container.querySelector('[role="alert"]');
      if (transition === "unchanged" && result === "reject") {
        // A compact danger notice above the field, worded as the card words it.
        assert.ok(alert?.matches(".notice.compact"));
        assert.match(alert?.textContent ?? "", /Couldn't send your answers\. Try again\./);
        assert.ok(alert!.compareDocumentPosition(answerInput(container)) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING);
      } else {
        assertNoDomNode(alert);
      }
      if (transition === "replace" || transition === "remount") {
        assert.match(container.textContent ?? "", /Question ask-replacement/);
        assert.equal(answerInput(container).disabled, false);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
 }
}

test("Answer Mode renders rich question text and compact plain links", async () => {
  const { container, root } = mount();
  const signed = "https://evidence.example/private/capture.png?signature=secret#full";
  try {
    await act(async () => root.render(<Harness
      client={{ ...api } as ApiClient}
      requestId="ask-single"
      questions={[{
        id: "target",
        question: "Choose **one** target.\n\n- `staging`\n- production",
        context: `Review ${signed}`,
        options: [{ label: "Staging" }, { label: "Production" }],
      }]}
    />));

    assert.match(container.querySelector(".answer-title")?.innerHTML ?? "", /<strong>one<\/strong>/);
    assert.match(container.querySelector(".answer-title")?.innerHTML ?? "", /<li><code>staging<\/code><\/li>/);
    const link = container.querySelector<HTMLAnchorElement>(".answer-context a");
    assert.equal(link?.textContent, "evidence.example/capture.png");
    assert.equal(link?.href, signed);
    assertNoDomNode(container.querySelector("img, video"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the answer head is the kind, the step only with several questions, Show Context and an × named Exit Answer Mode", async () => {
  const { container, root } = mount();
  try {
    await act(async () => root.render(<Harness client={{ ...api } as ApiClient} requestId="ask-single"
      questions={[{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }]} />));
    const head = container.querySelector<HTMLElement>(".answer-head")!;
    assert.equal(head.querySelector(".answer-kind")?.textContent, "Question");
    assertNoDomNode(head.querySelector(".answer-step"), "one question has no step count");
    const exit = buttonNamed(container, "Exit Answer Mode");
    assert.ok(exit.matches(".icon-btn.sm") && head.contains(exit));
    assert.equal(exit.textContent, "", "icon-only");
    const toggle = buttonNamed(container, "Show Context");
    assert.ok(toggle.matches(".btn.sm.ghost") && head.contains(toggle));
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    // The removed mode chrome stays removed.
    assert.doesNotMatch(container.textContent ?? "", /Answering Question|ANSWER MODE|Answer Mode|Previous Question|Other Response/);
    assertNoDomNode(container.querySelector(".composer-answer-mode, .composer-question-waiting, .question-chip"));
    assertNoDomNode(container.querySelector('[data-session-request-control="back"]'));
    assert.equal([...container.querySelectorAll("button")].some((button) => button.textContent === "Back"), false,
      "Back is absent on question 1");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("an unsupported Composer Response keeps focus while remaining non-editable", async () => {
  const { container, root } = mount();
  try {
    await act(async () => root.render(<Harness
      client={{ ...api } as ApiClient}
      requestId="ask-unsupported"
      questions={[{ id: "legacy", question: "Legacy question without a response schema", options: [] }]}
    />));

    const input = answerInput(container);
    input.focus();
    assert.equal(domWindow.document.activeElement, input);
    assert.equal(input.readOnly, true);
    assert.equal(input.disabled, false);
    assert.equal(input.getAttribute("aria-disabled"), "true");
    const help = container.querySelector<HTMLElement>(`#${input.getAttribute("aria-describedby")}`);
    assert.match(help?.textContent ?? "", /question format is unsupported/);

    await act(async () => press(input, "1"));
    assert.equal(input.value, "");
    assert.equal(domWindow.document.activeElement, input);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("an invalid answer is one field error under the field, and Enter submits one deterministic choice", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const questions: AgentQuestion[] = [{
    id: "language",
    question: "Choose a language",
    context: "Used for the generated client",
    options: [{ label: "TypeScript" }, { label: "Python" }],
  }];
  try {
    await act(async () => root.render(<Harness client={recordingClient(calls)} questions={questions} requestId="ask-single" />));
    const input = answerInput(container);
    input.focus();
    await act(async () => {
      setInputValue(input, " ");
      press(input, "Enter");
    });
    assert.equal(input.value, " ");
    assert.equal(domWindow.document.activeElement, input);
    const errors = [...container.querySelectorAll(".field-error")];
    assert.equal(errors.length, 1, "one error");
    assert.equal(errors[0]!.textContent, "Choose an option.");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(input.getAttribute("aria-describedby"), errors[0]!.id);
    assert.ok(input.compareDocumentPosition(errors[0]!) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING, "under the field");
    assert.deepEqual(calls, []);

    await act(async () => {
      setInputValue(input, "2");
      press(input, "Enter");
      await tick();
    });
    assertNoDomNode(container.querySelector(".field-error"));
    assert.deepEqual(calls, [{ requestId: "ask-single", answers: { language: "Python" }, action: "submit" }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("several questions step with Back from question 2, and a masked secret survives leaving Answer Mode unpersisted", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const questions: AgentQuestion[] = [
    { id: "target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }] },
    { id: "region", question: "Choose a region", options: [{ label: "West" }, { label: "East" }] },
    { id: "token", question: "Enter the token", options: [], allowOther: true, secret: true },
  ];
  try {
    await act(async () => root.render(<Harness client={recordingClient(calls)} questions={questions} requestId="ask-flow" />));
    assert.equal(container.querySelector(".answer-step")?.textContent, "Question 1 of 3");
    assert.equal(buttonNamed(container, "Next").textContent, "Next");
    await act(async () => { row(container, "Production").click(); });
    await act(async () => { buttonNamed(container, "Next").click(); });
    assert.equal(container.querySelector(".answer-step")?.textContent, "Question 2 of 3");
    assert.equal(storedQuestionStep("session-1", questionDraftIdentity("ask-flow", questions)), 1, "the step is kept in the request's draft");
    await act(async () => { buttonNamed(container, "Back").click(); });
    assert.equal(container.querySelector(".answer-step")?.textContent, "Question 1 of 3");
    assert.equal(row(container, "Production").checked, true);
    await act(async () => press(answerInput(container), "Enter"));
    await act(async () => { row(container, "East").click(); });
    await act(async () => press(answerInput(container), "Enter"));
    assert.equal(container.querySelector(".answer-step")?.textContent, "Question 3 of 3");
    let input = answerInput(container);
    assert.equal(input.type, "password");
    assert.equal(buttonNamed(container, "Submit Answers").textContent, "Submit Answers");
    await act(async () => setInputValue(input, "page-only-secret"));
    assert.deepEqual(storedQuestionDrafts("session-1", questionDraftIdentity("ask-flow", questions)), {
      target: { kind: "choice", labels: ["Production"] },
      region: { kind: "choice", labels: ["East"] },
    });

    await act(async () => buttonNamed(container, "Exit Answer Mode").click());
    assertNoDomNode(container.querySelector(".composer-answer"));
    await act(async () => container.querySelector<HTMLButtonElement>("[data-dock-answer]")!.click());
    input = answerInput(container);
    assert.equal(container.querySelector(".answer-step")?.textContent, "Question 3 of 3", "the step is kept");
    assert.equal(input.value, "page-only-secret");
    await act(async () => {
      press(input, "Enter");
      await tick();
    });
    assert.deepEqual(calls, [{
      requestId: "ask-flow",
      answers: { target: "Production", region: "East", token: "page-only-secret" },
      action: "submit",
    }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the options are the card's ChoiceRows, numbered 1–9, and enforce multi-select bounds", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const questions: AgentQuestion[] = [{
    id: "checks",
    question: "Choose two checks",
    multiSelect: true,
    minSelections: 2,
    maxSelections: 2,
    options: [{ label: "Unit Tests" }, { label: "Browser Tests" }, { label: "Smoke Test" }],
  }];
  try {
    await act(async () => root.render(<Harness client={recordingClient(calls)} questions={questions} requestId="ask-choices" />));
    const group = container.querySelector<HTMLElement>(".answer-options > .choice-rows")!;
    assert.equal(group.getAttribute("role"), "group");
    assert.deepEqual([...group.querySelectorAll(".choice-row-title")].map((title) => title.textContent),
      ["Unit Tests", "Browser Tests", "Smoke Test", "Something Else…"]);
    assert.deepEqual([...group.querySelectorAll(".answer-option-number")].map((number) => number.textContent),
      ["1", "2", "3", "4"]);
    assert.equal(answerInput(container).placeholder, "Type numbers or options, with commas");

    const input = answerInput(container);
    await act(async () => setInputValue(input, "1"));
    assert.equal(row(container, "Unit Tests").checked, true, "a typed number chooses its row");
    await act(async () => press(input, "Enter"));
    assert.equal(container.querySelector(".field-error")?.textContent, "Select at least 2 options.");

    // A number key on a row chooses, as on the card; typing in the field stays typing.
    await act(async () => { row(container, "Unit Tests").focus(); });
    await act(async () => press(row(container, "Unit Tests"), "2"));
    assert.equal(row(container, "Browser Tests").checked, true);
    assert.equal(domWindow.document.activeElement, row(container, "Browser Tests"));
    assert.equal(input.value, "Unit Tests, Browser Tests");
    await act(async () => {
      press(row(container, "Browser Tests"), "Enter");
      await tick();
    });
    assert.deepEqual(calls, [{ requestId: "ask-choices", answers: { checks: ["Unit Tests", "Browser Tests"] }, action: "submit" }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Something Else asks for the person's own answer in the field", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    await act(async () => root.render(<Harness client={recordingClient(calls)} requestId="ask-choices" questions={[{
      id: "target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }], allowOther: true,
    }]} />));
    const input = answerInput(container);
    assert.equal(input.placeholder, "Type a number, option or your answer");
    await act(async () => { row(container, "Something Else…").click(); });
    assert.equal(domWindow.document.activeElement, input);
    assert.equal(input.placeholder, "Type your answer");
    await act(async () => setInputValue(input, "Canary"));
    assert.equal(row(container, "Something Else…").checked, true);
    await act(async () => {
      press(input, "Enter");
      await tick();
    });
    assert.deepEqual(calls, [{ requestId: "ask-choices", answers: { target: "Canary" }, action: "submit" }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("row clicks keep exact numeric provider labels instead of reparsing them as ordinals", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const questions: AgentQuestion[] = [{ id: "port", question: "Choose a port", options: [{ label: "2" }, { label: "Second Option" }] }];
  try {
    await act(async () => root.render(<Harness client={recordingClient(calls)} questions={questions} requestId="ask-choices" />));
    await act(async () => { row(container, "2").click(); });
    assert.equal(row(container, "2").checked, true);
    await act(async () => {
      press(answerInput(container), "Enter");
      await tick();
    });
    assert.deepEqual(calls, [{ requestId: "ask-choices", answers: { port: "2" }, action: "submit" }]);

    await act(async () => root.render(<Harness client={recordingClient(calls)}
      questions={[{ ...questions[0]!, options: [{ label: "3000" }, { label: "8080" }] }]} requestId="ask-replacement" />));
    // The submission closed Answer Mode; the replacement opens it from the dock.
    await act(async () => container.querySelector<HTMLButtonElement>("[data-dock-answer]")!.click());
    await act(async () => { row(container, "8080").click(); });
    assert.equal(row(container, "8080").checked, true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Show Context shrinks the panel to its head and keeps the selection, the typed draft and the step", async () => {
  const { container, root } = mount();
  const questions: AgentQuestion[] = [
    { id: "intro", question: "First question", options: [], allowOther: true },
    { id: "target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }], allowOther: true },
  ];
  try {
    storeQuestionStep("session-1", questionDraftIdentity("ask-context", questions), 1);
    await act(async () => root.render(<Harness client={{ ...api } as ApiClient} questions={questions} requestId="ask-context" />));
    const panel = container.querySelector<HTMLElement>(".composer-answer")!;
    assert.equal(container.querySelector(".answer-step")?.textContent, "Question 2 of 2", "the step comes from the draft");
    const toggle = buttonNamed(container, "Show Context");
    const body = container.querySelector<HTMLElement>(".answer-body")!;
    assert.equal(toggle.getAttribute("aria-controls"), body.id);

    // Nothing chosen yet.
    await act(async () => toggle.click());
    assert.ok(panel.hasAttribute("data-collapsed"));
    assert.equal(body.hidden, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-label"), "Show Answer");
    assert.equal(buttonNamed(container, "Show Answer"), toggle, "the same control, so focus on it stays");
    assert.equal(container.querySelector(".answer-title")?.textContent, "Choose a target");
    const summary = container.querySelector<HTMLElement>(".answer-summary")!;
    assert.equal(summary.getAttribute("aria-live"), "polite");
    assert.equal(summary.textContent, "Nothing chosen yet");

    // Choose, collapse and expand: the choice stays.
    await act(async () => toggle.click());
    assert.equal(body.hidden, false);
    assertNoDomNode(container.querySelector(".answer-summary"));
    await act(async () => { row(container, "Production").click(); });
    await act(async () => toggle.click());
    assert.equal(container.querySelector(".answer-summary")?.textContent, "Production");
    await act(async () => toggle.click());
    assert.equal(row(container, "Production").checked, true);

    // A typed draft stays too, as does the step.
    await act(async () => setInputValue(answerInput(container), "Canary"));
    await act(async () => toggle.click());
    assert.equal(container.querySelector(".answer-summary")?.textContent, "Canary");
    await act(async () => toggle.click());
    assert.equal(answerInput(container).value, "Canary");
    assert.equal(container.querySelector(".answer-step")?.textContent, "Question 2 of 2");

    // A number key opens the panel before it chooses.
    await act(async () => toggle.click());
    await act(async () => press(toggle, "1"));
    assert.equal(body.hidden, false);
    assert.equal(row(container, "Staging").checked, true);
    assert.equal(domWindow.document.activeElement, row(container, "Staging"));

    // Escape still exits Answer Mode, collapsed or not.
    await act(async () => toggle.click());
    await act(async () => press(toggle, "Escape"));
    assertNoDomNode(container.querySelector(".composer-answer"));
    await act(async () => container.querySelector<HTMLButtonElement>("[data-dock-answer]")!.click());
    assert.equal(container.querySelector(".composer-answer")?.hasAttribute("data-collapsed"), false, "it opens whole");
    assert.equal(row(container, "Staging").checked, true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Jump to Question opens a collapsed panel and focuses its field", async () => {
  const { container, root } = mount();
  const revealRef: React.MutableRefObject<((requestId: string) => boolean) | null> = { current: null };
  try {
    await act(async () => root.render(<Harness client={{ ...api } as ApiClient} requestId="ask-context" revealRef={revealRef}
      questions={[{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }]} />));
    await act(async () => buttonNamed(container, "Show Context").click());
    assert.equal(revealRef.current?.("another-request"), false, "another question is not this panel's");
    let revealed = false;
    await act(async () => { revealed = revealRef.current?.("ask-context") ?? false; });
    assert.equal(revealed, true);
    assert.equal(container.querySelector<HTMLElement>(".answer-body")!.hidden, false);
    assert.equal(domWindow.document.activeElement, answerInput(container));
    await act(async () => buttonNamed(container, "Exit Answer Mode").click());
    assert.equal(revealRef.current, null, "nothing to reveal once Answer Mode closes");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("while answers are sent the primary keeps its label and width and shows the spinner", async () => {
  const { container, root } = mount();
  let resolveAnswer!: (session: SessionView) => void;
  const client = { ...api, answerQuestion: () => new Promise<SessionView>((resolve) => { resolveAnswer = resolve; }) } as ApiClient;
  try {
    await act(async () => root.render(<Harness client={client} requestId="ask-busy"
      questions={[{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }]} />));
    await act(async () => { row(container, "Staging").click(); });
    const submit = buttonNamed(container, "Submit Answers");
    await act(async () => submit.click());
    assert.equal(submit.getAttribute("aria-busy"), "true");
    assert.equal(submit.textContent, "Submit Answers");
    assert.ok(submit.querySelector(".spinner, [data-spinner], svg"), "the inline spinner");
    assert.doesNotMatch(container.textContent ?? "", /Submitting/);
    await act(async () => { resolveAnswer({ id: "session-1" } as SessionView); await tick(); });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("no sentence in Answer Mode names a key", async () => {
  const { container, root } = mount();
  try {
    for (const questions of [
      [{ id: "a", question: "Pick", options: [{ label: "One" }], required: false }],
      [{ id: "b", question: "Type", options: [], allowOther: true }],
      [{ id: "c", question: "Many", options: [{ label: "One" }, { label: "Two" }], multiSelect: true }],
    ] satisfies AgentQuestion[][]) {
      await act(async () => root.render(<Harness client={{ ...api } as ApiClient} requestId="ask-single" questions={questions} />));
      const words = `${container.textContent} ${answerInput(container).placeholder}`;
      assert.doesNotMatch(words, /\bPress\b|\bEnter\b|\bEscape\b|\bR to\b|\/respond/, words);
    }
    await act(async () => root.render(<Harness client={{ ...api } as ApiClient} runnerOnline={false} requestId="ask-single"
      questions={[{ id: "a", question: "Pick", options: [{ label: "One" }] }]} />));
    assert.match(container.querySelector(".answer-help")?.textContent ?? "", /unavailable until the runner reconnects/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the collapsed summary names the chosen options or the typed answer, never a secret", () => {
  const choice: AgentQuestion = { id: "a", question: "Pick", options: [{ label: "One" }, { label: "Two" }], multiSelect: true };
  assert.equal(answerSelectionSummary(choice, undefined), "Nothing chosen yet");
  assert.equal(answerSelectionSummary(choice, { kind: "choice", labels: ["One", "Two"] }), "One, Two");
  assert.equal(answerSelectionSummary(choice, { kind: "entry", value: "2" }), "Two");
  const secret: AgentQuestion = { id: "s", question: "Token", options: [], allowOther: true, secret: true };
  assert.equal(answerSelectionSummary(secret, { kind: "entry", value: "hunter2" }), "Answer entered");
  assert.equal(answerSelectionSummary(secret, { kind: "entry", value: "  " }), "Nothing chosen yet");
});

test("a recovered question says so in Answer Mode, as the card does", async () => {
  const { container, root } = mount();
  try {
    for (const recovery of [true, false]) {
      await act(async () => root.render(<ApiProvider client={api}>
        <ComposerQuestionResponse sessionId="session-1" requestId="ask-single" active runnerOnline recovery={recovery}
          questions={[{ id: "0", question: "Which path?", options: [{ label: "One" }] }]}
          inputRef={{ current: null }} onExit={() => {}} />
      </ApiProvider>));
      assert.equal(container.querySelector(".answer-kind")?.textContent, recovery ? "Recovery Required" : "Question");
      assert.equal(container.querySelector(".answer-recovery")?.textContent ?? "",
        recovery ? "The runner restarted after this question was asked. Submit the preserved form to resume the existing agent conversation and deliver these answers once. Prior tool calls will not be replayed." : "");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Answer Mode renders nothing while it is closed", async () => {
  const { container, root } = mount();
  try {
    await act(async () => root.render(<ApiProvider client={api}>
      <ComposerQuestionResponse sessionId="session-1" requestId="ask-single" active={false} runnerOnline
        questions={[{ id: "0", question: "Which path?", options: [], allowOther: true }]}
        inputRef={{ current: null }} onExit={() => {}} />
    </ApiProvider>));
    assert.equal(container.innerHTML, "");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
