import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentQuestion, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { clearQuestionDrafts, questionDraftIdentity, storedQuestionDrafts, storedQuestionStep, storeQuestionDrafts, storeQuestionStep } from "../question-response.js";
import { TOUCH_PHONE_MEDIA } from "../mobile-viewport.js";
import { focusSessionRequest } from "./SessionApproval.js";
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
  for (const requestId of ["ask-single", "ask-flow", "ask-choices", "ask-replacement", "ask-context", "ask-steps", "ask-busy", "ask-many"]) {
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

test("an expanded owner question can be dismissed without entering an answer", async () => {
  const { container, root } = mount();
  const calls: Parameters<ApiClient["answerQuestion"]>[1][] = [];
  let exited = false;
  try {
    await act(async () => root.render(<ApiProvider client={recordingClient(calls)}>
      <ComposerQuestionResponse sessionId="session-1" requestId="owner-handoff"
        occurrenceId="workflow-owner-handoff" isAsync
        questions={[{ id: "owner_question_answer", header: "Owner Question", question: "What should happen next?", options: [], allowOther: true }]}
        runnerOnline active inputRef={{ current: null }} onExit={() => { exited = true; }} />
    </ApiProvider>));
    assert.equal(answerInput(container).value, "");
    await act(async () => { buttonNamed(container, "Dismiss").click(); await tick(); });
    assert.deepEqual(calls, [{ requestId: "owner-handoff", occurrenceId: "workflow-owner-handoff", answers: {}, action: "dismiss" }]);
    assert.equal(exited, true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a failed expanded-question dismissal keeps the draft and can be retried", async () => {
  const { container, root } = mount();
  const calls: Parameters<ApiClient["answerQuestion"]>[1][] = [];
  let exited = false;
  const client = recordingClient(calls);
  client.answerQuestion = async (_id, body) => {
    calls.push(structuredClone(body));
    if (calls.length === 1) throw new Error("Runner disconnected");
    return { id: "session-1" } as SessionView;
  };
  try {
    await act(async () => root.render(<ApiProvider client={client}>
      <ComposerQuestionResponse sessionId="session-1" requestId="dismiss-retry"
        occurrenceId="workflow-dismiss-retry" isAsync
        questions={[{ id: "answer", question: "What next?", options: [], allowOther: true }]}
        runnerOnline active inputRef={{ current: null }} onExit={() => { exited = true; }} />
    </ApiProvider>));
    await act(async () => setInputValue(answerInput(container), "Keep this draft"));
    await act(async () => { buttonNamed(container, "Dismiss").click(); await tick(); });
    assert.equal(exited, false);
    assert.equal(answerInput(container).value, "Keep this draft");
    assert.match(container.textContent!, /Couldn't dismiss this question/);
    await act(async () => { buttonNamed(container, "Dismiss").click(); await tick(); });
    assert.equal(exited, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.action === "dismiss" && Object.keys(call.answers).length === 0));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("expanded recovery questions keep Dismiss and Continue", async () => {
  const { container, root } = mount();
  try {
    await act(async () => root.render(<ApiProvider client={recordingClient([])}>
      <ComposerQuestionResponse sessionId="session-1" requestId="dismiss-recovery" recovery
        questions={[{ id: "answer", question: "What next?", options: [], allowOther: true }]}
        runnerOnline active inputRef={{ current: null }} onExit={() => {}} />
    </ApiProvider>));
    assert.ok(buttonNamed(container, "Dismiss and Continue"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Dismiss never describes itself with a missing offline help element", async () => {
  const { container, root } = mount();
  const questions: AgentQuestion[] = [{ id: "answer", question: "What next?", options: [], allowOther: true }];
  const render = (runnerOnline: boolean) => root.render(<ApiProvider client={recordingClient([])}>
    <ComposerQuestionResponse sessionId="session-1" requestId="dismiss-offline" questions={questions}
      runnerOnline={runnerOnline} active inputRef={{ current: null }} onExit={() => {}} />
  </ApiProvider>);
  try {
    await act(async () => render(true));
    await act(async () => { buttonNamed(container, "Submit Answers").click(); });
    assert.match(container.textContent!, /Enter a response/);
    await act(async () => render(false));
    const dismiss = buttonNamed(container, "Dismiss");
    assert.equal(dismiss.disabled, true);
    const description = dismiss.getAttribute("aria-describedby");
    assert.ok(!description || [...container.querySelectorAll("[id]")].some((node) => node.id === description));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

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

test("secret answers never reach the DOM while typed, across steps or after a failed submit (#3814)", async () => {
  const { container, root } = mount();
  let attempts = 0;
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const client = {
    ...api,
    answerQuestion: async (_sessionId: string, body: Parameters<ApiClient["answerQuestion"]>[1]) => {
      attempts += 1;
      if (attempts === 1) throw new Error("The runner went offline.");
      calls.push(structuredClone(body));
      return { id: "session-1" } as SessionView;
    },
  } as ApiClient;
  const questions: AgentQuestion[] = [
    { id: "user", question: "Enter the user", options: [], allowOther: true },
    { id: "first", question: "Enter the first token", options: [], allowOther: true, secret: true },
    { id: "second", question: "Enter the second token", options: [], allowOther: true, secret: true },
  ];
  const html = () => container.innerHTML;
  try {
    await act(async () => root.render(<Harness client={client} questions={questions} requestId="ask-secrets" />));
    await act(async () => setInputValue(answerInput(container), "plain-user"));
    await act(async () => press(answerInput(container), "Enter"));
    assert.equal(answerInput(container).type, "password");
    await act(async () => setInputValue(answerInput(container), "first-secret-answer"));
    assert.doesNotMatch(html(), /first-secret-answer/, "a typed secret is not mirrored into a value attribute");
    await act(async () => press(answerInput(container), "Enter"));
    assert.equal(answerInput(container).value, "", "the next secret starts empty");
    await act(async () => setInputValue(answerInput(container), "second-secret-answer"));
    await act(async () => { buttonNamed(container, "Back").click(); });
    assert.equal(answerInput(container).value, "first-secret-answer", "Back brings the first secret back to its field");
    await act(async () => { buttonNamed(container, "Back").click(); });
    assert.equal(answerInput(container).type, "text");
    assert.equal(answerInput(container).value, "plain-user", "a plain answer is still a controlled field");
    await act(async () => press(answerInput(container), "Enter"));
    await act(async () => press(answerInput(container), "Enter"));
    assert.equal(answerInput(container).value, "second-secret-answer");
    assert.doesNotMatch(html(), /first-secret-answer|second-secret-answer/);

    await act(async () => {
      press(answerInput(container), "Enter");
      await tick();
    });
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /\S/, "the failure is shown");
    assert.equal(answerInput(container).value, "second-secret-answer", "a failed submit keeps the answer");
    assert.doesNotMatch(html(), /first-secret-answer|second-secret-answer/, "nor are secrets in the DOM after it");

    await act(async () => {
      press(answerInput(container), "Enter");
      await tick();
    });
    assert.deepEqual(calls, [{
      requestId: "ask-secrets",
      answers: { user: "plain-user", first: "first-secret-answer", second: "second-secret-answer" },
      action: "submit",
    }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a Codex async card with the runner's maximum of 20 questions steps through and submits every answer (#3724)", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  // The runner's normalized Codex async shape: index ids, string-only choices, free text allowed.
  const questions: AgentQuestion[] = Array.from({ length: 20 }, (_, index) => ({
    id: String(index), question: `Authorize decision ${index + 1}?`,
    options: [{ label: "Approve" }, { label: "Hold" }],
    allowOther: true, inputFormat: "text", maxLength: 4000,
  }));
  try {
    await act(async () => root.render(<Harness client={recordingClient(calls)} questions={questions} requestId="ask-many" />));
    for (let index = 0; index < questions.length; index++) {
      assert.equal(container.querySelector(".answer-step")?.textContent, `Question ${index + 1} of 20`);
      await act(async () => { row(container, index % 2 ? "Hold" : "Approve").click(); });
      await act(async () => {
        press(answerInput(container), "Enter");
        await tick();
      });
    }
    assert.deepEqual(calls, [{
      requestId: "ask-many",
      answers: Object.fromEntries(questions.map((question, index) => [question.id, index % 2 ? "Hold" : "Approve"])),
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

for (const action of ["navigate to request", "Enter while reading"] as const) {
  test(`the keyboard reading panel stays safe after ${action} (#3256)`, async () => {
    const { container, root } = mount();
    const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
    try {
      await act(async () => root.render(<Harness client={recordingClient(calls)} requestId="ask-single"
        questions={[{ id: "note", question: "Read before answering.", options: [], required: false, allowOther: true }]} />));
      const panel = container.querySelector<HTMLElement>(".composer-answer")!;
      if (action === "navigate to request") {
        await act(async () => { assert.equal(focusSessionRequest("session-1", "ask-single"), true); });
        assert.equal(panel.tabIndex, 0, "request navigation preserves the reading Tab stop");
      } else {
        panel.focus();
        await act(async () => { press(panel, "Enter"); await tick(); });
        assert.deepEqual(calls, [], "Enter on the reading surface never submits");
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}

/** Stubs the touch-phone media query for the lifetime of `run` (#4714). */
async function asTouchPhone(run: () => Promise<void>) {
  const priorMatchMedia = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query === TOUCH_PHONE_MEDIA, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  try {
    await run();
  } finally {
    domWindow.matchMedia = priorMatchMedia;
  }
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  field.value = value;
  fireDomEvent.change(field, { target: { value } } as never);
}

const somethingElseQuestions: AgentQuestion[] = [
  {
    id: "runner",
    question: "The child hasn't started yet. What should I do?",
    context: "It has waited in the queue for an hour.",
    options: [{ label: "Check the runner" }, { label: "Keep waiting" }],
    allowOther: true,
  },
  { id: "notes", question: "Anything else to pass on?", options: [], allowOther: true },
];

test("a touch phone types Something Else in a growing field, with the options behind Show Options (#4714)", async () => {
  await asTouchPhone(async () => {
    const { container, root } = mount();
    const calls: Parameters<ApiClient["answerQuestion"]>[1][] = [];
    const key = questionDraftIdentity("ask-own-answer", somethingElseQuestions);
    // The card chose Something Else and opened Answer Mode on it.
    storeQuestionDrafts("session-1", key, { runner: { kind: "other", value: "" } });
    try {
      await act(async () => root.render(<ApiProvider client={recordingClient(calls)}>
        <ComposerQuestionResponse sessionId="session-1" requestId="ask-own-answer" questions={somethingElseQuestions}
          runnerOnline active inputRef={{ current: null }} onExit={() => {}}
          usage={<span className="usage-probe">usage</span>} usageOwnRow />
      </ApiProvider>));
      const section = container.querySelector<HTMLElement>(".composer-answer")!;
      const field = answerInput(container) as unknown as HTMLTextAreaElement;
      assert.equal(field.tagName, "TEXTAREA", "the answer wraps and grows instead of scrolling sideways");
      assert.equal(field.getAttribute("enterkeyhint"), "next");
      assert.equal(field.getAttribute("placeholder"), "Type your answer");
      assert.equal(section.querySelector(".answer-kind")?.textContent, "Answering Question 1 of 2");
      assert.equal(section.querySelector(".answer-own")?.textContent, "Something Else");
      assert.ok(section.hasAttribute("data-own-answer"));
      // The field's name is the question and Something Else, as the card's field is.
      const names = field.getAttribute("aria-labelledby")!.split(" ").map((id) => domWindow.document.getElementById(id)?.textContent);
      assert.deepEqual(names, ["The child hasn't started yet. What should I do?", "Something Else"]);
      // The options, the context and the usage triggers give the keyboard their room.
      assert.equal(section.querySelector<HTMLElement>(".answer-options")!.hidden, true);
      assert.equal(section.querySelector<HTMLElement>(".answer-context")!.hidden, true);
      assertNoDomNode(container.querySelector(".usage-probe"), "the usage triggers step aside");
      assertNoDomNode(container.querySelector(".answer-context-toggle"), "Show Options takes Show Context's place");
      const toggle = buttonNamed(container, "Show Options");
      assert.equal(toggle.getAttribute("aria-expanded"), "false");

      await act(async () => toggle.click());
      assert.equal(section.querySelector<HTMLElement>(".answer-options")!.hidden, false);
      assert.equal(section.querySelector<HTMLElement>(".answer-context")!.hidden, false);
      assert.equal(buttonNamed(container, "Hide Options").getAttribute("aria-expanded"), "true");
      assert.equal(row(container, "Something Else…").checked, true);

      await act(async () => setFieldValue(field, "I restarted it. Check again before replacing anything."));
      // Shift+Enter is a new line, never Next.
      await act(async () => {
        field.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }) as never);
      });
      assert.equal(section.querySelector(".answer-kind")?.textContent, "Answering Question 1 of 2");
      // Enter is the keyboard's Next.
      await act(async () => press(field, "Enter"));
      assert.deepEqual(storedQuestionDrafts("session-1", key), {
        runner: { kind: "other", value: "I restarted it. Check again before replacing anything." },
      });
      assert.equal(storedQuestionStep("session-1", key), 1);
      // A question without options is not Something Else: its field is the composer's line.
      assert.equal(answerInput(container).tagName, "INPUT");
      assert.ok(container.querySelector(".usage-probe"), "the usage triggers are back");

      await act(async () => setFieldValue(answerInput(container), "Nothing else."));
      await act(async () => { buttonNamed(container, "Submit Answers").click(); await tick(); });
      assert.deepEqual(calls, [{
        requestId: "ask-own-answer",
        answers: { runner: "I restarted it. Check again before replacing anything.", notes: "Nothing else." },
        action: "submit",
      }], "the answer sent is the one the card's field would send");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      clearQuestionDrafts("session-1", key);
    }
  });
});

test("Answer Mode keeps its line field and its options for Something Else off a touch phone (#4714)", async () => {
  const { container, root } = mount();
  const key = questionDraftIdentity("ask-own-answer-desk", somethingElseQuestions);
  storeQuestionDrafts("session-1", key, { runner: { kind: "other", value: "Typed on a desk" } });
  try {
    await act(async () => root.render(<ApiProvider client={recordingClient([])}>
      <ComposerQuestionResponse sessionId="session-1" requestId="ask-own-answer-desk" questions={somethingElseQuestions}
        runnerOnline active inputRef={{ current: null }} onExit={() => {}} />
    </ApiProvider>));
    const field = answerInput(container);
    assert.equal(field.tagName, "INPUT");
    assert.equal(field.value, "Typed on a desk");
    assert.equal(container.querySelector<HTMLElement>(".answer-options")!.hidden, false);
    assert.equal(container.querySelector(".answer-kind")?.textContent, "Question");
    assertNoDomNode(container.querySelector(".answer-own"), "no Something Else head");
    assertNoDomNode(container.querySelector(".answer-mic"), "no mic of its own");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    clearQuestionDrafts("session-1", key);
  }
});

test("a touch phone dictates Something Else into the answer, and a step change ends dictation (#4714)", async () => {
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    continuous = false;
    interimResults = false;
    lang = "";
    started = false;
    aborted = false;
    onresult: ((ev: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor() { FakeRecognition.last = this; }
    start() { this.started = true; }
    stop() {}
    abort() { this.aborted = true; }
  }
  const win = domWindow as unknown as { webkitSpeechRecognition?: unknown };
  win.webkitSpeechRecognition = FakeRecognition;
  await asTouchPhone(async () => {
    const { container, root } = mount();
    const key = questionDraftIdentity("ask-own-dictation", somethingElseQuestions);
    storeQuestionDrafts("session-1", key, { runner: { kind: "other", value: "Restarted it." } });
    try {
      await act(async () => root.render(<ApiProvider client={recordingClient([])}>
        <ComposerQuestionResponse sessionId="session-1" requestId="ask-own-dictation" questions={somethingElseQuestions}
          runnerOnline active inputRef={{ current: null }} onExit={() => {}} />
      </ApiProvider>));
      const mic = buttonNamed(container, "Dictate");
      assert.equal(mic.getAttribute("aria-pressed"), "false");
      // Enter, Space and assistive technology click without a pointer.
      await act(async () => { mic.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, detail: 0 }) as never); });
      const recognition = FakeRecognition.last!;
      assert.ok(recognition.started);
      assert.equal(buttonNamed(container, "Stop Dictating").getAttribute("aria-pressed"), "true");
      await act(async () => recognition.onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: " check again " } }] }));
      assert.equal((answerInput(container) as unknown as HTMLTextAreaElement).value, "Restarted it. check again");
      assert.deepEqual(storedQuestionDrafts("session-1", key), { runner: { kind: "other", value: "Restarted it. check again" } });

      await act(async () => press(answerInput(container), "Enter"));
      assert.equal(recognition.aborted, true, "Next ends dictation, so no phrase lands in the next step");
      assertNoDomNode(container.querySelector(".answer-mic"), "the next step is not Something Else");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      clearQuestionDrafts("session-1", key);
      delete win.webkitSpeechRecognition;
    }
  });
});

test("Answer Mode that opens by itself on a touch phone's Something Else leaves focus alone (#4714)", async () => {
  await asTouchPhone(async () => {
    const { container, root } = mount();
    const key = questionDraftIdentity("ask-own-quiet", somethingElseQuestions);
    storeQuestionDrafts("session-1", key, { runner: { kind: "other", value: "Restored after a reload" } });
    const outside = domWindow.document.createElement("button");
    domWindow.document.body.append(outside);
    outside.focus();
    try {
      await act(async () => root.render(<ApiProvider client={recordingClient([])}>
        <ComposerQuestionResponse sessionId="session-1" requestId="ask-own-quiet" questions={somethingElseQuestions}
          runnerOnline active inputRef={{ current: null }} onExit={() => {}} />
      </ApiProvider>));
      const field = answerInput(container);
      assert.equal(field.tagName, "TEXTAREA");
      assert.equal((field as unknown as HTMLTextAreaElement).value, "Restored after a reload");
      assert.equal(domWindow.document.activeElement, outside, "no keyboard opens unasked");
      outside.blur();
      await act(async () => root.render(<ApiProvider client={recordingClient([])}>
        <ComposerQuestionResponse sessionId="session-1" requestId="ask-own-quiet" questions={somethingElseQuestions}
          runnerOnline active inputRef={{ current: null }} onExit={() => {}} usage={<span>usage</span>} />
      </ApiProvider>));
      assert.notEqual(domWindow.document.activeElement, field, "nor on a later render with focus on the page");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      outside.remove();
      clearQuestionDrafts("session-1", key);
    }
  });
});

test("dictation ends whenever its mic goes: an offered option chosen, or the runner offline (#4714)", async () => {
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    continuous = false;
    interimResults = false;
    lang = "";
    started = false;
    aborted = false;
    onresult: ((ev: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor() { FakeRecognition.last = this; }
    start() { this.started = true; }
    stop() {}
    abort() { this.aborted = true; }
  }
  const win = domWindow as unknown as { webkitSpeechRecognition?: unknown };
  win.webkitSpeechRecognition = FakeRecognition;
  await asTouchPhone(async () => {
    const { container, root } = mount();
    const key = questionDraftIdentity("ask-own-mic-life", somethingElseQuestions);
    const render = (runnerOnline: boolean) => act(async () => root.render(<ApiProvider client={recordingClient([])}>
      <ComposerQuestionResponse sessionId="session-1" requestId="ask-own-mic-life" questions={somethingElseQuestions}
        runnerOnline={runnerOnline} active inputRef={{ current: null }} onExit={() => {}} />
    </ApiProvider>));
    const startDictating = async () => {
      await act(async () => {
        buttonNamed(container, "Dictate").dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, detail: 0 }) as never);
      });
      const recognition = FakeRecognition.last!;
      assert.ok(recognition.started && !recognition.aborted);
      return recognition;
    };
    try {
      storeQuestionDrafts("session-1", key, { runner: { kind: "other", value: "" } });
      await render(true);
      let recognition = await startDictating();
      // Choosing an offered option takes Something Else, and with it the mic, away.
      await act(async () => buttonNamed(container, "Show Options").click());
      await act(async () => row(container, "Check the runner").click());
      assertNoDomNode(container.querySelector(".answer-mic"), "no mic once an option is chosen");
      assert.equal(recognition.aborted, true, "nothing listens without a control to stop it");
      assert.equal(recognition.onresult, null, "and no late phrase lands");

      // Back on Something Else, the runner going offline disables the mic: dictation ends with it.
      await act(async () => row(container, "Something Else…").click());
      recognition = await startDictating();
      await render(false);
      assert.equal(recognition.aborted, true, "an offline runner ends dictation");
      assert.equal(buttonNamed(container, "Dictate").getAttribute("aria-pressed"), "false");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      clearQuestionDrafts("session-1", key);
      delete win.webkitSpeechRecognition;
    }
  });
});

test("leaving Answer Mode while a stopped dictation still finalizes drops its last phrase (#4714)", async () => {
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    continuous = false;
    interimResults = false;
    lang = "";
    started = false;
    stopped = false;
    aborted = false;
    onresult: ((ev: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor() { FakeRecognition.last = this; }
    start() { this.started = true; }
    // The engine finalizes asynchronously: its last phrase and its end arrive later.
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
  }
  const win = domWindow as unknown as { webkitSpeechRecognition?: unknown };
  win.webkitSpeechRecognition = FakeRecognition;
  await asTouchPhone(async () => {
    const { container, root } = mount();
    const key = questionDraftIdentity("ask-own-finalizing", somethingElseQuestions);
    const render = (active: boolean) => act(async () => root.render(<ApiProvider client={recordingClient([])}>
      <ComposerQuestionResponse sessionId="session-1" requestId="ask-own-finalizing" questions={somethingElseQuestions}
        runnerOnline active={active} inputRef={{ current: null }} onExit={() => {}} />
    </ApiProvider>));
    const click = (button: HTMLButtonElement) => act(async () => {
      button.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, detail: 0 }) as never);
    });
    try {
      storeQuestionDrafts("session-1", key, { runner: { kind: "other", value: "Restarted it." } });
      await render(true);
      await click(buttonNamed(container, "Dictate"));
      const recognition = FakeRecognition.last!;
      await click(buttonNamed(container, "Stop Dictating"));
      assert.ok(recognition.stopped && !recognition.aborted, "Stop lets the engine finalize");
      assert.ok(recognition.onresult, "its last phrase could still arrive");

      await render(false);
      assert.equal(recognition.aborted, true, "leaving Answer Mode ends the finalizing engine");
      assert.equal(recognition.onresult, null, "and detaches it");
      assert.deepEqual(storedQuestionDrafts("session-1", key), { runner: { kind: "other", value: "Restarted it." } },
        "the hidden answer is what it showed");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      clearQuestionDrafts("session-1", key);
      delete win.webkitSpeechRecognition;
    }
  });
});
