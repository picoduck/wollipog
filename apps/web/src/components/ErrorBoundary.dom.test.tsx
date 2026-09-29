import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ErrorBoundary, errorDetailsText } from "./ErrorBoundary.js";
import { viewSubjectName } from "../navigation.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window();
const priorWindow = globalThis.window;
const priorDocument = globalThis.document;
const priorNavigator = globalThis.navigator;
const priorActEnvironment = (globalThis as unknown as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"];
const priorElementGlobals = {
  HTMLElement: (globalThis as Record<string, unknown>)["HTMLElement"],
  HTMLButtonElement: (globalThis as Record<string, unknown>)["HTMLButtonElement"],
};
const priorConsoleError = console.error;
const reloads: number[] = [];
const copied: string[] = [];

before(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: domWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: domWindow.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: domWindow.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: domWindow.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: domWindow.HTMLButtonElement });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  Object.defineProperty(domWindow.location, "reload", { configurable: true, value: () => reloads.push(1) });
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
});

after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: priorWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: priorDocument });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: priorNavigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLElement });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, writable: true, value: priorElementGlobals.HTMLButtonElement });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: priorActEnvironment });
});

beforeEach(() => {
  reloads.length = 0;
  copied.length = 0;
  // React and the boundary both log the caught error; the test asserts on the page instead.
  console.error = () => undefined;
});

afterEach(() => {
  console.error = priorConsoleError;
});

function Broken(): React.ReactNode {
  throw new Error("transcript row 12 has no kind");
}

function TimelineRow() {
  return <Broken />;
}

async function mount(node: React.ReactNode) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    root,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent === name) as HTMLButtonElement | undefined;

const click = async (target: HTMLElement) => {
  await act(async () => { target.click(); });
};

test("a crashed view names the destination in user words and keeps the exception behind Show Details", async () => {
  const view = await mount(
    <ErrorBoundary name="Automations" pageTitle="Automations"><TimelineRow /></ErrorBoundary>,
  );
  try {
    const notice = view.container.querySelector('[role="alert"]')!;
    assert.ok(notice.classList.contains("t-danger"), "a render failure is a danger notice");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Automations Couldn't Be Shown");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Part of this page failed to display. Nothing was changed.");
    // The developer labels and the old copy are gone from everything a person reads.
    for (const word of ["View", "App", "Something broke", "Something Went Wrong"]) {
      assert.ok(!(notice.textContent ?? "").includes(word), `"${word}" must not appear in the notice`);
    }
    assert.ok(!(notice.textContent ?? "").includes("transcript row 12"), "the exception waits for Show Details");

    assert.deepEqual([...notice.querySelectorAll("button")].map((button) => button.textContent),
      ["Reload Page", "Copy Error Details", "Show Details"]);
    assert.equal(buttonNamed(notice, "Try Again"), undefined, "re-rendering the same data crashes the same way");
    assert.ok(buttonNamed(notice, "Reload Page")!.classList.contains("primary"), "Reload Page is the next step");

    await click(buttonNamed(notice, "Show Details")!);
    const well = notice.querySelector(".notice-details-body .code-well pre");
    assert.ok(well, "the details are a mono well");
    const lines = (well!.textContent ?? "").split("\n");
    assert.equal(lines[0], "Error: transcript row 12 has no kind");
    assert.equal(lines.length, 4, "the message and the first three component frames");
    assert.match(lines[1]!, /^at Broken\b/);
    assert.match(lines[2]!, /^at TimelineRow\b/);
    assert.ok(buttonNamed(notice, "Hide Details"), "the toggle reads Hide Details while open");
  } finally {
    await view.unmount();
  }
});

test("Reload Page reloads the window and Copy Error Details copies the message and component frames", async () => {
  const view = await mount(<ErrorBoundary name="Automations"><TimelineRow /></ErrorBoundary>);
  try {
    await click(buttonNamed(view.container, "Reload Page")!);
    assert.equal(reloads.length, 1);

    await click(buttonNamed(view.container, "Copy Error Details")!);
    assert.equal(copied.length, 1);
    assert.match(copied[0]!, /^Error: transcript row 12 has no kind\n/);
    assert.match(copied[0]!, /\nat Broken\b/);
    assert.match(copied[0]!, /\nat TimelineRow\b/);
  } finally {
    await view.unmount();
  }
});

test("a view may pass a more specific sentence", async () => {
  const view = await mount(
    <ErrorBoundary name="This Session" body="The transcript failed to display. Nothing was changed."><TimelineRow /></ErrorBoundary>,
  );
  try {
    assert.equal(view.container.querySelector(".notice-title")?.textContent, "This Session Couldn't Be Shown");
    assert.equal(view.container.querySelector(".notice-body")?.textContent, "The transcript failed to display. Nothing was changed.");
  } finally {
    await view.unmount();
  }
});

test("navigating to another route clears a view error", async () => {
  let crash = true;
  function MaybeBroken() {
    if (crash) throw new Error("boom");
    return <p className="content">Usage</p>;
  }
  const view = await mount(<ErrorBoundary name="Automations" resetKey="/automations"><MaybeBroken /></ErrorBoundary>);
  try {
    assert.ok(view.container.querySelector('[role="alert"]'));
    crash = false;
    // Same route: the error stays, because re-rendering is not a recovery.
    await act(async () => view.root.render(<ErrorBoundary name="Automations" resetKey="/automations"><MaybeBroken /></ErrorBoundary>));
    assert.ok(view.container.querySelector('[role="alert"]'), "the error holds until the route changes");
    await act(async () => view.root.render(<ErrorBoundary name="Usage and Cost" resetKey="/usage"><MaybeBroken /></ErrorBoundary>));
    assertNoDomNode(view.container.querySelector('[role="alert"]'));
    assert.equal(view.container.querySelector(".content")?.textContent, "Usage");
  } finally {
    await view.unmount();
  }
});

test("an app-level crash takes the window with Reload Wollipog, Copy Error Details and the same details", async () => {
  const view = await mount(<ErrorBoundary scope="app"><TimelineRow /></ErrorBoundary>);
  try {
    const crash = view.container.querySelector(".app-crash[role=\"alert\"]")!;
    assert.ok(crash, "the full-window state");
    assert.equal(crash.querySelector("h1.state-title")?.textContent, "Wollipog Couldn't Show This Screen");
    assertNoDomNode(crash.querySelector(".notice"), "a State, not a notice in a missing content area");
    assert.deepEqual([...crash.querySelectorAll("button")].map((button) => button.textContent),
      ["Reload Wollipog", "Copy Error Details", "Show Details"]);
    assert.ok(!(crash.textContent ?? "").includes("transcript row 12"));

    await click(buttonNamed(crash, "Reload Wollipog")!);
    assert.equal(reloads.length, 1);
    await click(buttonNamed(crash, "Copy Error Details")!);
    assert.match(copied[0] ?? "", /^Error: transcript row 12 has no kind\nat Broken\b/);

    const toggle = buttonNamed(crash, "Show Details")!;
    await click(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.match(crash.querySelector(".state-details .code-well pre")?.textContent ?? "", /^Error: transcript row 12 has no kind\nat Broken/);
  } finally {
    await view.unmount();
  }
});

test("the details keep at most three frames and survive a thrown non-error", () => {
  const stack = "\n    at A (a.tsx:1:1)\n    at B\n    at C\n    at D\n";
  assert.equal(errorDetailsText(new Error("x"), stack), "Error: x\nat A (a.tsx:1:1)\nat B\nat C");
  assert.equal(errorDetailsText("plain string", null), "plain string");
  assert.equal(errorDetailsText(undefined, undefined), "undefined");
});

test("a route's error title reads as its destination, and a detail route as This …", () => {
  assert.equal(viewSubjectName({ name: "automations" }), "Automations");
  assert.equal(viewSubjectName({ name: "board" }), "Sessions");
  assert.equal(viewSubjectName({ name: "settings", section: "about" }), "Settings");
  assert.equal(viewSubjectName({ name: "session", id: "s1" }), "This Session");
  assert.equal(viewSubjectName({ name: "run", id: "r1" }), "This Run");
  assert.equal(viewSubjectName({ name: "pod", id: "p1" }), "This Pod");
});

test("the shell passes the destination's name, and both app boundaries take the window", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  assert.equal(app.match(/<ErrorBoundary scope="app">/g)?.length, 2, "the browser and the desktop roots");
  assert.match(app, /<ErrorBoundary\s+name=\{viewSubjectName\(view\)\}\s+resetKey=\{viewPath\(view\)\}/);
  assert.doesNotMatch(app, /<ErrorBoundary[^>]*\blabel=/, "a developer label never reaches the page");
});
