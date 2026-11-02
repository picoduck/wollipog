import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ErrorBoundary, errorDetailsText } from "./ErrorBoundary.js";
import {
  destination,
  GLOBAL_VIEW_ITEMS,
  SETTINGS_DESCRIPTION,
  viewDescription,
  viewHasHeaderTabs,
  viewPageWidth,
  viewSubjectName,
} from "../navigation.js";
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
    <ErrorBoundary name="Automations" pageTitle="Automations" pageDescription={viewDescription({ name: "automations" })}>
      <TimelineRow />
    </ErrorBoundary>,
  );
  try {
    const notice = view.container.querySelector('[role="alert"]')!;
    const header = view.container.querySelector(".page > header.page-header")!;
    assert.equal(header.querySelector("h1#page-title")?.textContent, "Automations");
    assert.equal(header.querySelector(".page-heading > p.page-desc")?.textContent,
      "Run a prompt on a schedule, from a webhook, or from a chat message.",
      "the destination's description stays under the title, so the header keeps its height");
    assert.ok(header.compareDocumentPosition(notice as never) & 4, "the notice sits below the header");
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
    const reloadIcon = buttonNamed(notice, "Reload Page")!.querySelector("svg");
    assert.ok(reloadIcon?.classList.contains("lucide-refresh-cw"), "Reload Page carries the refresh icon (§3.1)");
    assert.equal(reloadIcon?.getAttribute("width"), "14");
    assert.equal(view.container.querySelector(".page")?.className, "page", "a list page keeps the default container");

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
  // A run is a Multi-Agent Run before it loads (#1945), so it is never the bare "Run".
  assert.equal(viewSubjectName({ name: "run", id: "r1" }), "This Multi-Agent Run");
  assert.equal(viewSubjectName({ name: "pod", id: "p1" }), "This Pod");
});

test("a crashed route keeps its own container width, so the header's hairline does not move", async () => {
  for (const [width, className] of [["wide", "page wide"], ["full", "page full"], ["fill", "page full fill"]] as const) {
    const view = await mount(
      <ErrorBoundary name="Usage and Cost" pageTitle="Usage and Cost" pageWidth={width}><TimelineRow /></ErrorBoundary>,
    );
    try {
      assert.equal(view.container.querySelector(".page")?.className, className);
      assert.ok(view.container.querySelector(".page > .notice.view-error"), "the notice is the header's sibling");
    } finally {
      await view.unmount();
    }
  }
  assert.equal(viewPageWidth({ name: "usage" }), "wide");
  for (const name of ["projects", "skills", "settings"] as const) {
    assert.equal(viewPageWidth({ name }), "full", `${name} is a full-width page`);
  }
  // Their content fills the column edge to edge; only the header takes the gutter.
  assert.equal(viewPageWidth({ name: "inbox" }), "fill");
  assert.equal(viewPageWidth({ name: "board" }), "fill");
  assert.equal(viewPageWidth({ name: "runners" }), "fill", "Connections opens on Machines, a master-detail");
  assert.equal(viewPageWidth({ name: "runners", section: "machines", machineId: "m1" }), "fill");
  assert.equal(viewPageWidth({ name: "runners", section: "people" }), null);
  for (const name of ["archived", "automations", "runs", "pods"] as const) {
    assert.equal(viewPageWidth({ name }), null, `${name} is a list page`);
  }
});

test("a crashed route's description is the one its working header draws", () => {
  for (const item of GLOBAL_VIEW_ITEMS) {
    assert.equal(viewDescription({ name: item.id }), item.description, `${item.name} reads the registry`);
  }
  assert.equal(viewDescription({ name: "runs" }), "Give one task to several agents and compare what each one does.");
  assert.equal(viewDescription({ name: "board" }), destination("inbox").description, "board mode is Sessions");
  // Sessions and Connections spend that line on their header controls and tabs.
  assert.equal(viewDescription({ name: "inbox" }), undefined);
  assert.equal(viewDescription({ name: "runners", section: "people" }), undefined);
  assert.equal(viewDescription({ name: "automations", tab: "outbound" }), destination("automations").description);
  assert.equal(viewDescription({ name: "automations", editor: { kind: "new" } }), undefined, "the editor draws a detail bar");
  assert.equal(viewDescription({ name: "settings", section: "about" }), SETTINGS_DESCRIPTION,
    "Settings is not in the registry, but its header has a description");
  for (const view of [
    { name: "session", id: "s1" },
    { name: "run", id: "r1" },
    { name: "pod", id: "p1" },
    { name: "automation", id: "a1" },
  ] as const) {
    assert.equal(viewDescription(view), undefined, `${view.name} keeps its own header`);
  }
});

test("a crashed tabbed destination keeps an empty tab row, hidden and out of reach", async () => {
  const view = await mount(
    <ErrorBoundary name="Automations" pageTitle="Automations" pageDescription={viewDescription({ name: "automations" })} pageTabs>
      <TimelineRow />
    </ErrorBoundary>,
  );
  try {
    const header = view.container.querySelector(".page > header.page-header")!;
    const heading = header.querySelector(".page-header-row > .page-heading")!;
    assert.equal(heading.querySelector("h1#page-title")?.textContent, "Automations", "the focus target is unchanged");
    assert.equal(heading.querySelector("h1#page-title")?.getAttribute("tabindex"), "-1");
    assert.ok(heading.querySelector("p.page-desc"), "the description stays");
    const row = header.querySelector(":scope > .page-tabs");
    assert.ok(row, "the header's last row is its tab slot, so it keeps the working header's height");
    assert.equal(header.lastElementChild, row);
    assert.equal(row!.textContent, "", "no tab labels are guessed at");
    assert.equal(row!.querySelectorAll("button, a, [tabindex], [role]").length, 0, "nothing to reach or announce");
    assert.ok([...row!.children].every((child) => child.getAttribute("aria-hidden") === "true"));
    const notice = view.container.querySelector('[role="alert"]')!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Automations Couldn't Be Shown");
    assert.ok(header.compareDocumentPosition(notice as never) & 4, "the notice still sits below the header");
  } finally {
    await view.unmount();
  }
  const untabbed = await mount(<ErrorBoundary name="Projects" pageTitle="Projects"><TimelineRow /></ErrorBoundary>);
  try {
    assertNoDomNode(untabbed.container.querySelector(".page-tabs"), "a header without tabs gets no row");
  } finally {
    await untabbed.unmount();
  }
});

test("a crashed route reserves a tab row exactly where its working header draws one", () => {
  const wide = { phone: false, compact: false };
  const compact = { phone: false, compact: true };
  const phone = { phone: true, compact: false };
  for (const layout of [wide, compact, phone]) {
    assert.equal(viewHasHeaderTabs({ name: "automations" }, layout), true);
    assert.equal(viewHasHeaderTabs({ name: "automations", tab: "outbound" }, layout), true);
    assert.equal(viewHasHeaderTabs({ name: "automations", editor: { kind: "new" } }, layout), false, "the editor has no tabs");
    assert.equal(viewHasHeaderTabs({ name: "usage", tab: "subscriptions" }, layout), true);
    assert.equal(viewHasHeaderTabs({ name: "runners", section: "people" }, layout), true);
    for (const name of ["projects", "runs", "pods", "skills", "archived"] as const) {
      assert.equal(viewHasHeaderTabs({ name }, layout), false, `${name} has no tabs`);
    }
  }
  for (const name of ["inbox", "board"] as const) {
    assert.equal(viewHasHeaderTabs({ name }, wide), true, "the Sessions group tabs");
    assert.equal(viewHasHeaderTabs({ name }, compact), true);
    assert.equal(viewHasHeaderTabs({ name }, phone), false, "a phone's Sessions draws its own bar");
  }
  assert.equal(viewHasHeaderTabs({ name: "runners", section: "machines", machineId: "m1" }, wide), true);
  assert.equal(viewHasHeaderTabs({ name: "runners", section: "machines", machineId: "m1" }, phone), false,
    "an open machine takes a phone's whole header");
  assert.equal(viewHasHeaderTabs({ name: "settings" }, wide), false);
  assert.equal(viewHasHeaderTabs({ name: "settings", section: "about" }, compact), true, "section tabs show only when compact");
  assert.equal(viewHasHeaderTabs({ name: "settings" }, phone), false);
});

test("the shell passes the destination's name, and both app boundaries take the window", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  assert.equal(app.match(/<ErrorBoundary scope="app">/g)?.length, 2, "the browser and the desktop roots");
  assert.match(app, /<ErrorBoundary\s+name=\{viewSubjectName\(view\)\}\s+resetKey=\{viewPath\(view\)\}/);
  assert.match(app, /pageWidth=\{viewPageWidth\(view\)\}/, "with the route's container width");
  assert.match(app, /<ErrorBoundary\s+name=\{viewSubjectName\(view\)\}[^>]*\bpageDescription=\{viewDescription\(view\)\}/,
    "and the route's description");
  assert.match(app, /pageTabs=\{viewHasHeaderTabs\(view, \{ phone: isMobile, compact: isCompact \}\)\}/,
    "and whether its header ends in tabs at this width");
  assert.doesNotMatch(app, /<ErrorBoundary[^>]*\blabel=/, "a developer label never reaches the page");
});
