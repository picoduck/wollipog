import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentQuestion, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import {
  claimQuestionResponseOperation,
  clearQuestionDrafts,
  storeQuestionDrafts,
  storedQuestionDrafts,
  storedQuestionStep,
} from "../question-response.js";
import { setQuestionResponseStyle } from "../question-response-style.js";
import { SessionQuestionBanner } from "./SessionApproval.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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
/** The card moves focus after the next paint. */
const frame = () => act(async () => {
  await new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve()));
});

function mount() {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  return { container, root: createRoot(container) };
}

function recordingClient(calls: Array<Parameters<ApiClient["answerQuestion"]>[1]>): ApiClient {
  return {
    ...api,
    answerQuestion: async (_sessionId: string, action: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push(structuredClone(action));
      return {} as SessionView;
    },
  } as ApiClient;
}

function control(container: HTMLElement, name: string): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>("[data-session-request-control]")]
    .find((candidate) => candidate.dataset.sessionRequestControl === name) ?? null;
}

function button(container: HTMLElement, name: "submit" | "dismiss" | "next" | "back"): HTMLButtonElement {
  const found = control(container, name);
  assert.ok(found, `the ${name} button`);
  return found as HTMLButtonElement;
}

/** A button's label without the keycap it carries on a fine pointer. */
function label(element: Element): string {
  return [...element.childNodes].filter((node) => (node as Element).tagName !== "KBD")
    .map((node) => node.textContent).join("");
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  return button(container, "submit");
}

/** The row inputs of the current step, by their visible titles. */
function rows(container: HTMLElement): Array<{ title: string; input: HTMLInputElement }> {
  return [...container.querySelectorAll<HTMLElement>(".choice-row")].map((row) => ({
    title: row.querySelector(".choice-row-title")!.textContent!,
    input: row.querySelector<HTMLInputElement>("input")!,
  }));
}

function row(container: HTMLElement, title: string): HTMLInputElement {
  const found = rows(container).find((candidate) => candidate.title === title);
  assert.ok(found, `the ${title} row`);
  return found.input;
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  fireDomEvent.change(input, { target: { value } } as never);
}

function press(target: Element, key: string, init: Record<string, unknown> = {}) {
  target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }) as never);
}

function footerOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>(".request-card-foot > button, .question-step-note")]
    .map((element) => element.matches(".question-step-note") ? "note" : element.dataset.sessionRequestControl ?? "?");
}

afterEach(() => {
  for (const requestId of ["question-1", "question-old", "question-new", "question-virtualized", "question-steps"]) {
    clearQuestionDrafts("session-1", requestId);
  }
});

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

test("a reused async request id starts a fresh draft and sends its exact occurrence", async () => {
  const { container, root } = mount();
  const calls: Parameters<ApiClient["answerQuestion"]>[1][] = [];
  const client = { ...api, answerQuestion: async (_id, body) => {
    calls.push(body);
    return { id: "session-1" } as SessionView;
  } } as ApiClient;
  const render = (occurrenceId: string) => root.render(<ApiProvider client={client}>
    <SessionQuestionBanner sessionId="session-1" requestId="question-reused"
      occurrenceId={occurrenceId} isAsync
      questions={[{ id: "0", question: "Which path?", options: [], allowOther: true }]}
      runnerOnline />
  </ApiProvider>);
  try {
    setQuestionResponseStyle("interactive", domWindow as never);
    await act(async () => render("request_old"));
    assert.match(container.querySelector(".request-card-kind")?.textContent ?? "", /^Async Question$/);
    await act(async () => setInputValue(container.querySelector("input")!, "Old answer"));
    await act(async () => render("request_new"));
    const input = container.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.value, "", "a reused provider id must not carry the old answer draft");
    await act(async () => setInputValue(input, "New answer"));
    await act(async () => submitButton(container).click());
    assert.deepEqual(calls, [{
      requestId: "question-reused", occurrenceId: "request_new",
      answers: { "0": "New answer" }, action: "submit",
    }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    clearQuestionDrafts("session-1", "question-reused:request_old");
    clearQuestionDrafts("session-1", "question-reused:request_new");
  }
});

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
        const { container, root } = mount();
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
          await act(async () => button(container, action).click());
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
          const alert = container.querySelector('[role="alert"]');
          if (transition === "unchanged" && result === "reject") {
            assert.match(alert?.textContent ?? "", action === "submit"
              ? /^Couldn't send your answers\. Try again\./ : /^Couldn't dismiss this question\. Try again\./);
          } else {
            assertNoDomNode(alert);
          }
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
    const { container, root } = mount();
    const old = deferredAnswer();
    const current = deferredAnswer();
    let calls = 0;
    const client = { ...api, answerQuestion: () => (++calls === 1 ? old.promise : current.promise) } as ApiClient;
    let newerLease: (() => void) | null = null;
    try {
      const questions = [{ id: "note", question: "Optional note", options: [], allowOther: true, required: false }];
      await renderBanner(root, questions, true, client, "question-old");
      await act(async () => button(container, action).click());
      await renderBanner(root, questions, true, client, "question-new");
      await act(async () => button(container, action).click());
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
      const alert = container.querySelector<HTMLElement>('[role="alert"]')!;
      assert.ok(alert);
      // The server's words wait behind Show Details (§8.5).
      await act(async () => alert.querySelector<HTMLButtonElement>(".notice-details-toggle")!.click());
      assert.match(alert.textContent!, /Current failure/);
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

test("validation focus lands in the same commit, so a replacement question keeps its own focus", async () => {
  const { container, root } = mount();
  const originalRaf = domWindow.requestAnimationFrame;
  let frames = 0;
  domWindow.requestAnimationFrame = ((() => { frames += 1; return 1; }) as unknown) as typeof originalRaf;
  try {
    const questions = [{ id: "note", question: "Required note", options: [], allowOther: true }];
    await renderBanner(root, questions, true, api, "question-old");
    await act(async () => press(container.querySelector("section")!, "Enter", { ctrlKey: true }));
    assert.equal(domWindow.document.activeElement, container.querySelector(".question-input"),
      "the invalid field has focus before the next key is read");
    assert.equal(frames, 0, "no focus move is left waiting for a later frame");
    await renderBanner(root, questions, true, api, "question-new");
    const dismiss = button(container, "dismiss");
    dismiss.focus();
    await renderBanner(root, questions, true, api, "question-new");
    assert.equal(domWindow.document.activeElement, dismiss);
  } finally {
    domWindow.requestAnimationFrame = originalRaf;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a resumable recovered question keeps its preserved form answerable", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const questions: AgentQuestion[] = [{
    id: "language",
    question: "Choose a language",
    options: [{ label: "TypeScript" }, { label: "Python" }],
  }];

  try {
    await renderBanner(root, questions, true, recordingClient(calls), "question-1", {
      reason: "provider_restart",
      action: "resume_answer",
    });
    assert.match(container.textContent ?? "", /resume the existing agent conversation and deliver these answers once/);
    assert.match(container.textContent ?? "", /Prior tool calls will not be replayed/);
    assert.equal(container.querySelector("section")?.dataset.tone, "danger");
    assert.equal(container.querySelector(".request-card-kind")?.textContent, "Recovery Required");
    const choice = row(container, "TypeScript");
    assert.equal(choice.getAttribute("aria-disabled"), null);
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

test("a dismiss-only recovery disables its options and offers one primary, Dismiss and Continue", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    await renderBanner(root, [{
      id: "language",
      question: "Choose a language",
      options: [{ label: "TypeScript" }, { label: "Python" }],
    }], true, recordingClient(calls), "question-1", { reason: "provider_restart" });
    assert.equal(container.querySelector("section")?.dataset.tone, "danger");
    assert.equal(container.querySelector(".request-card-kind")?.textContent, "Recovery Required");
    assert.ok(rows(container).every(({ input }) => input.getAttribute("aria-disabled") === "true"));
    await act(async () => { row(container, "TypeScript").click(); });
    assert.equal(row(container, "TypeScript").checked, false);
    const primaries = [...container.querySelectorAll<HTMLButtonElement>(".request-card-foot .btn.primary")];
    assert.deepEqual(primaries.map(label), ["Dismiss and Continue"]);
    assert.deepEqual(footerOrder(container), ["dismiss"]);
    await act(async () => { primaries[0]!.click(); await tick(); });
    assert.deepEqual(calls, [{ requestId: "question-1", answers: {}, action: "dismiss" }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("three questions show one step at a time, and Submit Answers appears only on the last step, last", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const questions: AgentQuestion[] = [
    { id: "target", header: "Target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }] },
    { id: "checks", header: "Checks", question: "Choose checks", multiSelect: true, options: [{ label: "Unit" }, { label: "Browser" }] },
    { id: "note", header: "Note", question: "Add a note", options: [], allowOther: true, required: false },
  ];
  try {
    setQuestionResponseStyle("interactive", domWindow as never);
    await renderBanner(root, questions, true, recordingClient(calls), "question-steps");
    const step = () => ({
      note: container.querySelector(".question-step-note")?.firstChild?.textContent,
      title: container.querySelector(".question-text")?.textContent,
      eyebrow: container.querySelector(".question-eyebrow")?.textContent,
    });
    assert.deepEqual(step(), { note: "Question 1 of 3", title: "Choose a target", eyebrow: "TargetChoose one" });
    assert.deepEqual(footerOrder(container), ["dismiss", "note", "next"]);
    assert.equal(button(container, "next").className, "btn primary");
    assertNoDomNode(control(container, "submit"));

    await act(async () => { row(container, "Production").click(); });
    await act(async () => { button(container, "next").click(); });
    await frame();
    assert.deepEqual(step(), { note: "Question 2 of 3", title: "Choose checks", eyebrow: "ChecksChoose any" });
    assert.deepEqual(footerOrder(container), ["dismiss", "note", "back", "next"]);
    assert.equal(domWindow.document.activeElement, container.querySelector(".question-text"),
      "the new question is read first");
    assert.equal(storedQuestionStep("session-1", "question-steps"), 1);

    await act(async () => { button(container, "back").click(); });
    assert.equal(step().note, "Question 1 of 3");
    assert.equal(row(container, "Production").checked, true, "going back keeps the answer");
    await act(async () => { button(container, "next").click(); });
    await act(async () => { row(container, "Unit").click(); });
    await act(async () => { button(container, "next").click(); });
    assert.deepEqual(step(), { note: "Question 3 of 3", title: "Add a note", eyebrow: "NoteOptional" });
    assert.deepEqual(footerOrder(container), ["dismiss", "note", "back", "submit"]);
    assert.equal(label(submitButton(container)), "Submit Answers");
    assert.equal(container.querySelector(".request-card-foot")?.lastElementChild?.previousElementSibling,
      submitButton(container), "Submit Answers is the last button (its live line follows it)");
    await act(async () => { submitButton(container).click(); await tick(); });
    assert.deepEqual(calls, [{
      requestId: "question-steps", answers: { target: "Production", checks: ["Unit"] }, action: "submit",
    }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("remounting on step 2 with a choice made returns to step 2 with the choice kept", async () => {
  const questions: AgentQuestion[] = [
    { id: "target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }] },
    { id: "window", question: "Choose a window", options: [{ label: "Morning" }, { label: "Evening" }] },
  ];
  const first = mount();
  try {
    await renderBanner(first.root, questions, true, api, "question-steps");
    await act(async () => { row(first.container, "Staging").click(); });
    await act(async () => { button(first.container, "next").click(); });
    await act(async () => { row(first.container, "Evening").click(); });
  } finally {
    await act(async () => { first.root.unmount(); });
    first.container.remove();
  }
  const second = mount();
  try {
    await renderBanner(second.root, questions, true, api, "question-steps");
    assert.equal(second.container.querySelector(".question-step-note")?.firstChild?.textContent, "Question 2 of 2");
    assert.equal(row(second.container, "Evening").checked, true);
    await act(async () => { button(second.container, "back").click(); });
    assert.equal(row(second.container, "Staging").checked, true);
  } finally {
    await act(async () => { second.root.unmount(); });
    second.container.remove();
  }
});

test("options are native radios and checkboxes inside ChoiceRows, with no drawn glyphs", async () => {
  const { container, root } = mount();
  try {
    await renderBanner(root, [
      { id: "single", question: "Pick one", options: [{ label: "A", description: "First letter" }, { label: "B" }] },
    ], true);
    const group = container.querySelector(".choice-rows");
    assert.equal(group?.getAttribute("role"), "radiogroup");
    assert.deepEqual(rows(container).map(({ title, input }) => [title, input.type]),
      [["A", "radio"], ["B", "radio"], ["Something Else…", "radio"]]);
    assert.equal(new Set(rows(container).map(({ input }) => input.name)).size, 1, "one radio group");
    assert.doesNotMatch(container.textContent ?? "", /[☑☐●○❓]|select all that apply/);
    assertNoDomNode(container.querySelector(".question-chip, .question-option, .question-mark"));
    assert.equal(container.querySelector(".choice-row-desc")?.textContent, "First letter");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("number keys pick the current step's rows, Enter advances, and Ctrl/Cmd+Enter submits from any step", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  const questions: AgentQuestion[] = [
    { id: "target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }] },
    { id: "checks", question: "Choose checks", multiSelect: true, options: [{ label: "Unit" }, { label: "Browser" }] },
    { id: "note", question: "Add a note", options: [], allowOther: true, required: false },
  ];
  try {
    await renderBanner(root, questions, true, recordingClient(calls), "question-steps");
    const title = () => container.querySelector<HTMLElement>(".question-text")!;
    title().focus();
    await act(async () => press(title(), "2"));
    assert.equal(row(container, "Production").checked, true);
    await frame();
    assert.equal(domWindow.document.activeElement, row(container, "Production"), "focus follows the picked row");
    await act(async () => press(row(container, "Production"), "Enter"));
    await frame();
    assert.equal(container.querySelector(".question-step-note")?.firstChild?.textContent, "Question 2 of 3");
    await act(async () => press(title(), "1"));
    await act(async () => press(title(), "2"));
    assert.deepEqual(rows(container).map(({ input }) => input.checked), [true, true, false]);
    await act(async () => press(title(), "1"));
    assert.deepEqual(rows(container).map(({ input }) => input.checked), [false, true, false], "a number toggles a checkbox");
    await act(async () => press(title(), "9"));
    assert.deepEqual(rows(container).map(({ input }) => input.checked), [false, true, false], "no ninth row");
    // Back to step 1: Ctrl+Enter submits the whole form from there.
    await act(async () => { button(container, "back").click(); });
    await act(async () => press(title(), "Enter", { ctrlKey: true }));
    await act(async () => { await tick(); });
    assert.deepEqual(calls, [{
      requestId: "question-steps", answers: { target: "Production", checks: ["Browser"] }, action: "submit",
    }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Ctrl/Cmd+Enter with an unanswered later question goes to it and shows its error", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    await renderBanner(root, [
      { id: "target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }] },
      { id: "window", question: "Choose a window", options: [{ label: "Morning" }, { label: "Evening" }] },
    ], true, recordingClient(calls), "question-steps");
    await act(async () => { row(container, "Staging").click(); });
    await act(async () => press(container.querySelector(".question-text")!, "Enter", { metaKey: true }));
    await frame();
    assert.deepEqual(calls, []);
    assert.equal(container.querySelector(".question-step-note")?.firstChild?.textContent, "Question 2 of 2");
    assert.equal(container.querySelector(".field-error")?.textContent, "Choose an option.");
    assert.equal(domWindow.document.activeElement, row(container, "Morning"));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("keycaps sit beside the first nine rows and inside the buttons only when key hints show", async () => {
  const { container, root } = mount();
  const options = Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index + 1}` }));
  try {
    await renderBanner(root, [{ id: "many", question: "Pick one", options }], true);
    assert.deepEqual([...container.querySelectorAll(".choice-row-meta kbd")].map((kbd) => kbd.textContent),
      ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    assert.equal(button(container, "dismiss").querySelector("kbd")?.textContent, "D");
    assert.equal(submitButton(container).querySelector("kbd")?.textContent, "Enter");
    assert.ok([...container.querySelectorAll("kbd")].every((kbd) => kbd.getAttribute("aria-hidden") === "true"));
    await act(async () => {
      root.render(<ApiProvider client={api}>
        <SessionQuestionBanner sessionId="session-1" requestId="question-1" runnerOnline showKeyHints={false}
          questions={[{ id: "many", question: "Pick one", options }]} />
      </ApiProvider>);
    });
    assertNoDomNode(container.querySelector("kbd"));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("D dismisses from a choice row, but not while typing", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    await renderBanner(root, [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
      true, recordingClient(calls));
    await act(async () => { row(container, "Something Else…").click(); });
    await act(async () => press(container.querySelector(".question-input")!, "d"));
    assert.deepEqual(calls, []);
    await act(async () => { press(row(container, "Staging"), "d"); await tick(); });
    assert.deepEqual(calls, [{ requestId: "question-1", answers: {}, action: "dismiss" }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("no helper or error text shows before Next; afterwards the unanswered question shows a field error and takes focus", async () => {
  const { container, root } = mount();
  try {
    await renderBanner(root, [
      { id: "target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }] },
      { id: "note", question: "Add a note", options: [], allowOther: true },
    ], true, api, "question-steps");
    assertNoDomNode(container.querySelector(".field-error, .field-helper, [role='alert']"));
    assert.equal(container.querySelector(".request-card-reasons")?.textContent, "", "the live line waits, empty");
    assert.doesNotMatch(container.textContent ?? "", /Complete all required responses|Correct the response errors/);
    const next = button(container, "next");
    assert.equal(next.disabled, false, "Next stays available and reveals what is missing");
    await act(async () => { next.click(); });
    await frame();
    assert.equal(container.querySelector(".question-step-note")?.firstChild?.textContent, "Question 1 of 2");
    const error = container.querySelector<HTMLElement>(".field-error")!;
    assert.equal(error.textContent, "Choose an option.");
    assert.equal(error.getAttribute("role"), null, "focus announces it, not an alert (§8.5)");
    const group = container.querySelector<HTMLElement>(".choice-rows")!;
    assert.equal(group.getAttribute("aria-invalid"), "true");
    assert.ok(group.getAttribute("aria-describedby")?.split(" ").includes(error.id));
    assert.equal(domWindow.document.activeElement, row(container, "Staging"));

    await act(async () => { row(container, "Staging").click(); });
    assertNoDomNode(container.querySelector(".field-error"), "the error clears with a valid answer");
    await act(async () => { button(container, "next").click(); });
    assertNoDomNode(container.querySelector(".field-error"), "the next question starts clean");
    await act(async () => { submitButton(container).click(); });
    await frame();
    const input = container.querySelector<HTMLInputElement>(".question-input")!;
    assert.equal(container.querySelector(".field-error")?.textContent, "Enter a response.");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(domWindow.document.activeElement, input);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Something Else… is the last row; choosing it reveals the text field and submits the typed answer (#1595)", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    await renderBanner(root, [{
      id: "target",
      question: "Choose a target",
      allowOther: true,
      options: [{ label: "Staging" }, { label: "Production" }],
    }], true, recordingClient(calls));
    assert.equal(rows(container).at(-1)?.title, "Something Else…");
    assertNoDomNode(container.querySelector(".question-input"), "the field waits for Something Else");
    await act(async () => { row(container, "Something Else…").click(); });
    const input = container.querySelector<HTMLInputElement>(".question-input")!;
    assert.ok(input);
    assert.equal(row(container, "Something Else…").checked, true);
    await act(async () => { setInputValue(input, "Canary"); });
    await act(async () => { submitButton(container).click(); await tick(); });
    assert.deepEqual(calls, [{ requestId: "question-1", answers: { target: "Canary" }, action: "submit" }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a failed submission shows a danger notice above the footer, keeps the choices, and Try Again resubmits", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  let fail = true;
  const client = {
    ...api,
    answerQuestion: async (_sessionId: string, action: Parameters<ApiClient["answerQuestion"]>[1]) => {
      calls.push(structuredClone(action));
      if (fail) throw new Error("The runner rejected this answer.");
      return {} as SessionView;
    },
  } as ApiClient;
  try {
    await renderBanner(root, [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }] }],
      true, client);
    await act(async () => { row(container, "Production").click(); });
    await act(async () => { submitButton(container).click(); await tick(); });
    const notice = container.querySelector<HTMLElement>('[role="alert"]')!;
    assert.ok(notice.classList.contains("t-danger") && notice.classList.contains("compact"));
    assert.match(notice.textContent!, /^Couldn't send your answers\. Try again\./);
    assert.equal(notice.nextElementSibling?.nextElementSibling, container.querySelector(".request-card-foot"),
      "directly above the footer, past the live line");
    assert.equal(row(container, "Production").checked, true, "the choices are kept");
    assert.equal(label(submitButton(container)), "Try Again");
    fail = false;
    await act(async () => { submitButton(container).click(); await tick(); });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { requestId: "question-1", answers: { target: "Production" }, action: "submit" });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Try Again keeps its label while the retry is pending", async () => {
  const { container, root } = mount();
  const retry = deferredAnswer();
  let calls = 0;
  const client = {
    ...api,
    answerQuestion: () => (++calls === 1 ? Promise.reject(new Error("Rejected once.")) : retry.promise),
  } as ApiClient;
  try {
    await renderBanner(root, [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }], true, client);
    await act(async () => { row(container, "Staging").click(); });
    await act(async () => { submitButton(container).click(); await tick(); });
    assert.equal(label(submitButton(container)), "Try Again");
    await act(async () => { submitButton(container).click(); });
    assert.equal(submitButton(container).getAttribute("aria-busy"), "true");
    assert.equal(label(submitButton(container)), "Try Again", "the pending retry still names what runs");
    assertNoDomNode(container.querySelector('[role="alert"]'), "the old failure clears while the retry runs");
  } finally {
    retry.resolve({} as SessionView);
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("submitting shows the busy primary without swapping its label", async () => {
  const { container, root } = mount();
  const answer = deferredAnswer();
  const client = { ...api, answerQuestion: () => answer.promise } as ApiClient;
  try {
    await renderBanner(root, [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }], true, client);
    await act(async () => { row(container, "Staging").click(); });
    await act(async () => { submitButton(container).click(); });
    const primary = submitButton(container);
    assert.equal(primary.getAttribute("aria-busy"), "true");
    assert.equal(label(primary), "Submit Answers");
    assert.equal(button(container, "dismiss").disabled, true);
    assert.doesNotMatch(container.textContent ?? "", /Submitting…|Dismissing…/);
  } finally {
    answer.resolve({} as SessionView);
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("multi-select custom text replaces choice selection and is submitted verbatim (#1595)", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    await renderBanner(root, [{
      id: "features",
      question: "Choose features or add another",
      multiSelect: true,
      allowOther: true,
      options: [{ label: "Audit" }],
    }], true, recordingClient(calls));
    const audit = row(container, "Audit");
    assert.equal(audit.type, "checkbox");
    await act(async () => { audit.click(); });
    assert.equal(row(container, "Audit").checked, true);
    await act(async () => { row(container, "Something Else…").click(); });
    assert.equal(row(container, "Audit").checked, false, "custom text is exclusive");
    await act(async () => { setInputValue(container.querySelector<HTMLInputElement>(".question-input")!, "Audit"); });
    await act(async () => { submitButton(container).click(); await tick(); });
    assert.deepEqual(calls, [{ requestId: "question-1", answers: { features: "Audit" }, action: "submit" }]);
    await act(async () => { row(container, "Something Else…").click(); });
    assertNoDomNode(container.querySelector(".question-input"), "unchecking Something Else closes its field");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("constrained free text explains its shared validation reason once the person tries to continue", async () => {
  const { container, root } = mount();
  try {
    await renderBanner(root, [{
      id: "retries",
      header: "Retries",
      question: "How many retries?",
      context: "Retry policy for this deployment",
      options: [],
      allowOther: true,
      inputFormat: "integer",
      minimum: 1,
      maximum: 5,
    }], true);
    const input = container.querySelector<HTMLInputElement>(".question-input")!;
    assert.equal(input.getAttribute("aria-required"), "true");
    await act(async () => { setInputValue(input, "8"); });
    assertNoDomNode(container.querySelector(".field-error"), "nothing shows before Submit Answers");
    await act(async () => { submitButton(container).click(); });
    const fieldError = container.querySelector<HTMLElement>(".field-error")!;
    assert.equal(fieldError.textContent, "Response is above its maximum.");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.ok(input.getAttribute("aria-describedby")?.split(" ").includes(fieldError.id));
    assert.ok(input.closest(".field"), "the shared invalid edge applies");

    await act(async () => { setInputValue(input, "3"); });
    assertNoDomNode(container.querySelector(".field-error"));
    assert.equal(input.getAttribute("aria-invalid"), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("an online-to-offline transition keeps choices reachable and explains every unavailable response", async () => {
  const { container, root } = mount();
  const questions: AgentQuestion[] = [{
    id: "target",
    question: "Choose a target",
    options: [{ label: "Staging" }, { label: "Production" }],
    allowOther: true,
  }];
  try {
    await renderBanner(root, questions, true);
    assert.ok(rows(container).every(({ input }) => input.getAttribute("aria-disabled") === null));
    const status = container.querySelector<HTMLElement>('[role="status"][aria-atomic="true"]')!;
    assert.equal(status.textContent, "");
    // The visible reason is the live line itself: one copy of the words, mounted before it is needed.
    assert.ok(status.matches(".request-card-reasons.question-reason"));
    assert.equal(container.querySelectorAll(".request-card-reasons").length, 1);

    await renderBanner(root, questions, false);
    const offline = "Responses are unavailable until the runner reconnects.";
    assert.equal(container.querySelector<HTMLElement>('[role="status"][aria-atomic="true"]'), status, "the live line stays mounted");
    assert.equal(status.textContent, offline);
    assert.equal(container.querySelector(".request-card-reasons")?.textContent, offline);
    assert.ok(rows(container).every(({ input }) => input.getAttribute("aria-disabled") === "true" && !input.disabled));
    const group = container.querySelector<HTMLElement>(".choice-rows")!;
    assert.ok(group.getAttribute("aria-describedby")?.split(" ").includes(status.id));
    for (const name of ["dismiss", "submit"] as const) {
      assert.equal(button(container, name).disabled, true);
      assert.equal(button(container, name).getAttribute("aria-describedby"), status.id);
    }
    await act(async () => { row(container, "Staging").click(); });
    assert.equal(row(container, "Staging").checked, false);
    await act(async () => press(group, "1"));
    assert.equal(row(container, "Staging").checked, false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("choosing an option clears a Something Else draft and submits the visible fixed option", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    await renderBanner(root, [{
      id: "target",
      question: "Choose a target",
      context: "Deployment destination",
      options: [{ label: "Staging" }, { label: "Production" }],
      allowOther: true,
    }], true, recordingClient(calls));
    await act(async () => { row(container, "Something Else…").click(); });
    const input = container.querySelector<HTMLInputElement>(".question-input")!;
    const requirementId = input.getAttribute("aria-describedby")?.split(" ").find((id) => id.includes("-requirement-"));
    assert.equal(requirementId ? domWindow.document.getElementById(requirementId)?.textContent?.trim() : null,
      "An answer to this question is required.");
    await act(async () => { setInputValue(input, "Canary"); });
    await act(async () => { row(container, "Production").click(); });
    assertNoDomNode(container.querySelector(".question-input"));
    await act(async () => { submitButton(container).click(); await tick(); });
    assert.deepEqual(calls, [{ requestId: "question-1", answers: { target: "Production" }, action: "submit" }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Composer Response keeps the transcript card as context without card-owned response fields", async () => {
  const { container, root } = mount();
  try {
    setQuestionResponseStyle("composer", domWindow as never);
    await renderBanner(root, [{
      id: "language",
      question: "Choose a language",
      options: [{ label: "TypeScript" }, { label: "Python" }],
    }], true);
    assertNoDomNode(container.querySelector("input, .choice-rows"));
    assert.deepEqual(footerOrder(container), ["dismiss"]);
    assert.match(container.textContent ?? "", /Respond through Answer Mode in the composer/);
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
  const { container, root } = mount();
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
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    setQuestionResponseStyle("interactive", domWindow as never);
    await renderBanner(root, [{
      id: "checks",
      question: "Choose exactly two checks",
      multiSelect: true,
      minSelections: 2,
      maxSelections: 2,
      options: [{ label: "Unit Tests" }, { label: "Browser Tests" }, { label: "Smoke Test" }],
    }], true, recordingClient(calls));
    for (const title of ["Unit Tests", "Browser Tests", "Smoke Test"]) await act(async () => { row(container, title).click(); });
    await act(async () => { submitButton(container).click(); });
    assert.equal(container.querySelector(".field-error")?.textContent, "Select at most 2 options.");
    assert.deepEqual(calls, []);
    await act(async () => { row(container, "Unit Tests").click(); });
    assertNoDomNode(container.querySelector(".field-error"));
    await act(async () => { submitButton(container).click(); await tick(); });
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

test("Something Else intent survives an exact option prefix while fixed choices remain exact", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    await renderBanner(root, [{
      id: "target",
      question: "Choose a target",
      options: [{ label: "Production" }, { label: "Staging" }],
      allowOther: true,
    }], true, recordingClient(calls));
    await act(async () => { row(container, "Something Else…").click(); });
    const input = container.querySelector<HTMLInputElement>(".question-input")!;
    for (const value of ["Prod", "Production", "Production west region"]) {
      await act(async () => { setInputValue(input, value); });
      assert.equal(input.value, value);
      assert.equal(row(container, "Production").checked, false);
      assert.equal(row(container, "Something Else…").checked, true);
    }
    await act(async () => { submitButton(container).click(); await tick(); });
    assert.deepEqual(calls[0], { requestId: "question-1", answers: { target: "Production west region" }, action: "submit" });

    await act(async () => { row(container, "Production").click(); });
    await act(async () => { submitButton(container).click(); await tick(); });
    assert.deepEqual(calls[1], { requestId: "question-1", answers: { target: "Production" }, action: "submit" });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a numeric Something Else submits its text without applying hidden ordinal syntax", async () => {
  const { container, root } = mount();
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    await renderBanner(root, [{
      id: "workers",
      question: "Choose a worker count",
      options: [{ label: "Auto" }, { label: "Two Workers" }],
      allowOther: true,
      inputFormat: "integer",
      minimum: 1,
      maximum: 10,
    }], true, recordingClient(calls));
    await act(async () => { row(container, "Something Else…").click(); });
    const input = container.querySelector<HTMLInputElement>('.question-input[type="number"]')!;
    assert.ok(input);
    await act(async () => { setInputValue(input, "2"); });
    assert.equal(row(container, "Two Workers").checked, false);
    await act(async () => { submitButton(container).click(); await tick(); });
    assert.deepEqual(calls[0], { requestId: "question-1", answers: { workers: "2" }, action: "submit" });
    await act(async () => { row(container, "Two Workers").click(); });
    await act(async () => { submitButton(container).click(); await tick(); });
    assert.deepEqual(calls[1], { requestId: "question-1", answers: { workers: "Two Workers" }, action: "submit" });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Composer Response never renders secret entry controls in the transcript card", async () => {
  const { container, root } = mount();
  try {
    setQuestionResponseStyle("composer", domWindow as never);
    await renderBanner(root, [{
      id: "token",
      question: "Enter the token",
      options: [],
      allowOther: true,
      secret: true,
    }], true, api, "question-virtualized");
    assertNoDomNode(container.querySelector("input"));
    assert.match(container.textContent ?? "", /Respond through Answer Mode/);
  } finally {
    await act(async () => { setQuestionResponseStyle("interactive", domWindow as never); });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a Viewer can read a question but not answer or dismiss it, and the card says why (#1857)", async () => {
  setQuestionResponseStyle("interactive");
  const { container, root } = mount();
  const reason = "Your Viewer role is read-only.";
  const answered: string[] = [];
  const client = {
    ...api,
    answerQuestion: async (_sessionId: string, body: { action?: string }) => {
      answered.push(body.action ?? "submit");
      return {} as SessionView;
    },
  } as unknown as ApiClient;
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <SessionQuestionBanner
            sessionId="session-viewer"
            requestId="question-viewer"
            questions={[{
              id: "target",
              question: "Choose a target",
              options: [{ label: "Staging" }, { label: "Production" }],
              allowOther: true,
            }]}
            runnerOnline
            responseRefusal={reason}
          />
        </ApiProvider>,
      );
    });
    assert.equal(container.textContent?.includes("Choose a target"), true, "the question stays readable");
    assert.equal(container.textContent?.includes("runner reconnects"), false, "the runner is not blamed");
    const status = container.querySelector<HTMLElement>('[role="status"][aria-atomic="true"]')!;
    assert.equal(status.textContent, reason, "the card says why");
    assert.equal(container.querySelector(".request-card-reasons")?.textContent, reason);
    assert.ok(rows(container).every(({ input }) => input.getAttribute("aria-disabled") === "true"));
    const actions = [...container.querySelectorAll<HTMLButtonElement>(".request-card-foot > button")];
    assert.ok(actions.length > 0);
    assert.ok(actions.every((candidate) => candidate.disabled && candidate.getAttribute("aria-describedby") === status.id));
    await act(async () => {
      row(container, "Staging").click();
      for (const candidate of actions) candidate.click();
      press(container.querySelector("section")!, "Enter", { ctrlKey: true });
      press(row(container, "Staging"), "d");
      await tick();
    });
    assert.equal(row(container, "Staging").checked, false);
    assert.deepEqual(answered, [], "nothing is sent");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("switching to Interactive Form does not present an invalid typed choice as a Something Else draft", async () => {
  const { container, root } = mount();
  const questions: AgentQuestion[] = [{
    id: "target", question: "Choose a target", allowOther: false,
    options: [{ label: "Production" }, { label: "Staging" }],
  }];
  const calls: Array<Parameters<ApiClient["answerQuestion"]>[1]> = [];
  try {
    storeQuestionDrafts("session-1", "question-1", { target: { kind: "entry", value: "Canary" } });
    setQuestionResponseStyle("interactive", domWindow as never);
    await renderBanner(root, questions, true, recordingClient(calls));
    assert.equal(row(container, "Something Else…").checked, false, "unadopted typed entry is not Something Else");
    assertNoDomNode(container.querySelector(".question-input"));
    assert.deepEqual(storedQuestionDrafts("session-1", "question-1"), {
      target: { kind: "entry", value: "Canary" },
    }, "switching styles preserves the original draft intent");
    await act(async () => { row(container, "Something Else…").click(); });
    await act(async () => { setInputValue(container.querySelector<HTMLInputElement>(".question-input")!, "Canary"); });
    await act(async () => { submitButton(container).click(); });
    assertNoDomNode(container.querySelector(".field-error"), "typing in Something Else explicitly adopts custom intent");
    assert.deepEqual(calls, [{ requestId: "question-1", answers: { target: "Canary" }, action: "submit" }]);
    storeQuestionDrafts("session-1", "question-1", { target: { kind: "entry", value: "Canary" } });
    await act(async () => setQuestionResponseStyle("composer", domWindow as never));
    await renderBanner(root, [{ ...questions[0]!, allowOther: true }], true);
    await act(async () => setQuestionResponseStyle("interactive", domWindow as never));
    assert.equal(row(container, "Something Else…").checked, true);
    assert.equal(container.querySelector<HTMLInputElement>(".question-input")!.value, "Canary",
      "a legacy single-choice typed custom answer is still displayed");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    clearQuestionDrafts("session-1", "question-1");
  }
});
