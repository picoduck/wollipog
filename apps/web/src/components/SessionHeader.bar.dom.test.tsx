import assert from "node:assert/strict";
import test from "node:test";
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { api } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionHeader } from "./SessionHeader.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/session/session-bar", width: 1440, height: 900 });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const GENERATED_TITLE = "Add a dark mode toggle to the site header.\n\nRequirements:\n- x";

/** Menus are portalled to <body> (the shared MenuSurface), so queries look there. */
function page(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

function button(label: string): HTMLButtonElement {
  const match = [...page().querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
  assert.ok(match, `missing button: ${label}`);
  return match;
}

/** The More Actions menu's rows in order: item names, and "—" for a separator. */
function moreActionsRows(): string[] {
  const menu = page().querySelector('[role="menu"][aria-label="More Actions"]');
  assert.ok(menu, "More Actions is open");
  return [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((row) =>
    row.getAttribute("role") === "separator" ? "—" : (row.querySelector(".menu-text")?.textContent ?? row.textContent ?? "").trim());
}

async function renderBar(props: {
  projectName?: string;
  projectControl?: ReactNode;
  onOpenProject?: () => void;
}): Promise<Root> {
  const session = { id: "session-bar", runnerId: "runner-1", title: GENERATED_TITLE, status: "idle" } as SessionView;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider client={api}>
        <FeedbackContext.Provider value={{
          confirm: async () => false,
          showToast: () => 1,
          showUndo: () => 1,
          dismissToast: () => undefined,
        }}>
          <SessionHeader
            session={session}
            onBack={() => undefined}
            runnerOnline
            runnerProtocolVersion={85}
            providerLogoutSupported={false}
            stopBeforeArchiveSupported
            exportReady
            projectControl={props.projectControl}
            projectName={props.projectName}
            onOpenProject={props.onOpenProject}
            renderMoveProjectDialog={() => <div role="dialog" aria-label="Move Session" />}
            titleId="page-title"
          />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  return root;
}

async function cleanUp(root: Root) {
  await act(async () => { root.unmount(); });
  domWindow.document.body.innerHTML = "";
  await act(async () => { domWindow.happyDOM.setViewport({ width: 1440, height: 900 }); });
}

test("the desktop bar is one header with Back, the project slot and the one-line title it owns", async () => {
  const root = await renderBar({ projectName: "Payments Service", projectControl: <button type="button">Payments Service</button> });
  try {
    const bar = page().querySelector("header.detail-bar.session-bar");
    assert.ok(bar, "the bar reuses the detail bar's recipe");
    const children = [...bar.children].slice(0, 3);
    assert.deepEqual(children.map((child) => child.className),
      ["icon-btn detail-bar-back", "session-bar-project", "detail-bar-title session-bar-title"]);
    const back = button("Back to Sessions");
    assert.equal(back.title, "Back to Sessions", "the tooltip repeats the accessible name");
    assert.equal(bar.querySelector(".session-bar-sep")?.textContent, "/");

    const title = bar.querySelector("h1")!;
    assert.equal(title.id, "page-title", "the bar still owns the focus-rescue anchor on desktop");
    assert.equal(title.textContent, "Add a dark mode toggle to the site header");
    assert.equal(title.title, "Add a dark mode toggle to the site header");

    assert.equal(button("Share").title, "Share");
    assert.equal(button("More Actions").title, "More Actions");
  } finally {
    await cleanUp(root);
  }
});

test("above the compact tier More Actions does not repeat the visible project button", async () => {
  const root = await renderBar({
    projectName: "Payments Service",
    projectControl: <button type="button">Payments Service</button>,
    onOpenProject: () => undefined,
  });
  try {
    await act(async () => { button("More Actions").click(); });
    assert.equal(moreActionsRows()[0], "Rename…");
  } finally {
    await cleanUp(root);
  }
});

test("when the stylesheet hides the project button, its actions lead More Actions", async () => {
  let opened = 0;
  const root = await renderBar({
    projectName: "Payments Service",
    projectControl: <button type="button">Payments Service</button>,
    onOpenProject: () => { opened += 1; },
  });
  try {
    // The compact tier is a container query; stand in for it by hiding the slot the way it does.
    const slot = page().querySelector<HTMLElement>(".session-bar-project")!;
    slot.style.display = "none";
    await act(async () => { button("More Actions").click(); });
    assert.deepEqual(moreActionsRows().slice(0, 4),
      ["Open Payments Service", "Move to Another Project…", "—", "Rename…"]);
    await act(async () => { button("Open Payments Service").click(); });
    assert.equal(opened, 1);

    await act(async () => { button("More Actions").click(); });
    await act(async () => { button("Move to Another Project…").click(); });
    assert.ok(page().querySelector('[role="dialog"][aria-label="Move Session"]'), "the move dialog opens");
  } finally {
    await cleanUp(root);
  }
});

test("on a phone More Actions leads with the project and the sheet is titled with the session", async () => {
  await act(async () => { domWindow.happyDOM.setViewport({ width: 390, height: 844 }); });
  const root = await renderBar({ projectName: "Payments Service", onOpenProject: () => undefined });
  try {
    assert.equal(page().querySelector(".session-bar")?.className, "session-bar",
      "the phone's second line takes no detail-bar safe-area geometry");
    assertNoDomNode(page().querySelector(".session-bar h1, .detail-bar-back"),
      "the phone top bar owns Back and the title");
    for (const label of ["Share", "More Actions"]) {
      assert.match(button(label).className, /\bicon-btn sm session-header-action\b/,
        `${label} is the small control, with the borrowed 44px touch target`);
    }
    await act(async () => { button("More Actions").click(); });
    assert.deepEqual(moreActionsRows().slice(0, 3), ["Open Payments Service", "Move to Another Project…", "—"]);
    const sheetHead = page().querySelector('[role="menu"][aria-label="More Actions"] > .menu-head');
    assert.equal(sheetHead?.textContent, "Add a dark mode toggle to the site header");
  } finally {
    await cleanUp(root);
  }
});

test("a session with no project offers only Move to a Project…", async () => {
  await act(async () => { domWindow.happyDOM.setViewport({ width: 390, height: 844 }); });
  const root = await renderBar({ onOpenProject: undefined });
  try {
    await act(async () => { button("More Actions").click(); });
    assert.deepEqual(moreActionsRows().slice(0, 3), ["Move to a Project…", "—", "Rename…"]);
  } finally {
    await cleanUp(root);
  }
});
