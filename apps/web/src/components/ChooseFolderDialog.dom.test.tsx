import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { RUNNER_CAPABILITY_MIN_PROTOCOL } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode, assertSameDomNode } from "../dom-test-assertions.js";
import { ChooseFolderDialog } from "./ChooseFolderDialog.js";
import { FOLDER_PICKER_SKELETON_DELAY_MS } from "./DirectoryPicker.js";
import { Modal } from "./Modal.js";

/**
 * Choose Folder (#2956): a breadcrumb from the machine's home folder, folder rows, a failed path
 * that keeps the last listing, the old-runner path field, and Escape that belongs to the dialog.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const MISSING_MESSAGE = "cannot read directory: /does/not/exist";

/** A home folder with one nested repository and an empty folder; anything else fails. */
const FOLDERS: Record<string, { parent: string | null; entries: string[] }> = {
  "/": { parent: null, entries: ["home"] },
  "/home": { parent: "/", entries: ["ada"] },
  "/home/ada": { parent: "/home", entries: ["notes", "repos"] },
  "/home/ada/notes": { parent: "/home/ada", entries: [] },
  "/home/ada/repos": { parent: "/home/ada", entries: ["billing"] },
  "/home/ada/repos/billing": { parent: "/home/ada/repos", entries: [] },
};

function client(requests: string[], hold?: { promise: Promise<void> }): ApiClient {
  return {
    listDirectory: async (_runnerId: string, path: string) => {
      requests.push(path);
      if (hold) await hold.promise;
      const at = path || "/home/ada";
      const folder = FOLDERS[at];
      if (!folder) throw new Error(MISSING_MESSAGE);
      return {
        path: at,
        parent: folder.parent,
        entries: folder.entries.map((name) => ({ name, path: `${at === "/" ? "" : at}/${name}`, isDir: true })),
      };
    },
  } as unknown as ApiClient;
}

/** New Workspace's shape: a form dialog with a read-only Folder field and Browse…, which stacks
 * Choose Folder over it. */
function Host({ protocolVersion }: { protocolVersion: number }) {
  const [folder, setFolder] = useState("");
  const [choosing, setChoosing] = useState(false);
  const browseRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Modal title="New Workspace" onClose={() => undefined}>
        <input aria-label="Folder" value={folder} readOnly />
        <button ref={browseRef} type="button" className="btn" onClick={() => setChoosing(true)}>Browse…</button>
      </Modal>
      {choosing && (
        <ChooseFolderDialog
          runnerId="runner-1"
          machineName="Build Box"
          protocolVersion={protocolVersion}
          returnFocusRef={browseRef}
          onClose={() => setChoosing(false)}
          onPick={(path) => {
            setFolder(path);
            setChoosing(false);
          }}
        />
      )}
    </>
  );
}

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

async function mount(options: { protocolVersion?: number; hold?: { promise: Promise<void> } } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const requests: string[] = [];
  await act(async () => {
    root.render(
      <ApiProvider client={client(requests, options.hold)}>
        <Host protocolVersion={options.protocolVersion ?? RUNNER_CAPABILITY_MIN_PROTOCOL.directoryListing} />
      </ApiProvider>,
    );
  });
  const dialog = (title: string) => [...document.querySelectorAll<HTMLElement>("[role=dialog]")]
    .find((element) => element.querySelector(".modal-title")?.textContent === title);
  const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((element) => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === name);
  const settle = async () => { await act(async () => { await tick(); await tick(); }); };
  const press = async (element: HTMLElement | undefined) => {
    assert.ok(element, "expected an element to press");
    await act(async () => { element.click(); });
    await settle();
  };
  const key = async (target: Element, keyName: string) => {
    let event!: KeyboardEvent;
    await act(async () => {
      event = new domWindow.KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
      target.dispatchEvent(event);
    });
    await settle();
    return event;
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
      // react-dom decided at import, before these globals existed, that input events are
      // unsupported, so it reads value changes on keyup.
      input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });
  };
  const host = dialog("New Workspace")!;
  const open = async () => {
    await press(button(host, "Browse…"));
    const chooser = dialog("Choose Folder");
    assert.ok(chooser, "Browse… opens Choose Folder");
    return chooser;
  };
  const crumbs = (chooser: HTMLElement) => [...chooser.querySelectorAll(".crumbs .crumb")].map((crumb) => crumb.textContent);
  const rows = (chooser: HTMLElement) => [...chooser.querySelectorAll(".folder-picker-list > .row")].map((row) => row.textContent);
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  };
  return { host, requests, dialog, button, press, key, type, open, crumbs, rows, settle, unmount };
}

test("Choose Folder names the machine, trails from Home, and opens an ancestor from its crumb", async () => {
  const view = await mount();
  try {
    const chooser = await view.open();
    assert.equal(chooser.querySelector(".modal-desc")?.textContent, "On Build Box");
    assert.deepEqual(view.crumbs(chooser), ["Home"]);
    assert.deepEqual(view.rows(chooser), ["Up One Level", "notes", "repos"]);
    assert.ok(chooser.querySelector(".folder-picker-list > .row .row-icon svg"), "each row leads with its icon");

    await view.press(view.button(chooser, "repos"));
    await view.press(view.button(chooser, "billing"));
    assert.deepEqual(view.crumbs(chooser), ["Home", "repos", "billing"]);
    const current = chooser.querySelector(".crumbs .crumb.is-current")!;
    assert.equal(current.tagName, "SPAN", "the current folder is plain text");
    assert.equal(current.getAttribute("aria-current"), "location");
    assert.equal(chooser.querySelectorAll(".crumbs .crumb-sep svg").length, 2, "chevrons separate the crumbs");

    await view.press(view.button(chooser, "Home"));
    assert.equal(view.requests.at(-1), "/home/ada", "the Home crumb lists the home folder");
    assert.deepEqual(view.crumbs(chooser), ["Home"]);
    await view.press(view.button(chooser, "Up One Level"));
    assert.deepEqual(view.crumbs(chooser), ["/", "home"], "above home the trail starts at the root");
    await view.press(view.button(chooser, "/"));
    assert.deepEqual(view.rows(chooser), ["home"], "the root has no Up One Level");

    await view.press(view.button(chooser, "home"));
    await view.press(view.button(chooser, "Use This Folder"));
    assertNoDomNode(view.dialog("Choose Folder") ?? null, "Use This Folder closes Choose Folder");
    assert.equal(view.host.querySelector<HTMLInputElement>("input")!.value, "/home");
  } finally {
    await view.unmount();
  }
});

test("a path that cannot be opened keeps the last listing under a danger notice with the runner's words", async () => {
  const view = await mount();
  try {
    const chooser = await view.open();
    await view.press(view.button(chooser, "repos"));
    await view.press(view.button(chooser, "Edit Path"));
    const field = chooser.querySelector<HTMLInputElement>(".folder-picker-bar input")!;
    assert.equal(field.value, "/home/ada/repos", "Edit Path starts from the current folder");
    assertSameDomNode(document.activeElement, field, "Edit Path focuses its field");
    assertNoDomNode(chooser.querySelector(".crumbs"), "the field replaces the trail");

    await view.type(field, "/does/not/exist");
    await view.press(view.button(chooser, "Go"));
    const notice = chooser.querySelector<HTMLElement>(".notice.t-danger.compact")!;
    assert.ok(notice, "the failure is a compact danger notice");
    assert.equal(notice.getAttribute("role"), "alert");
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Can't open /does/not/exist on Build Box. Check the path, or pick a folder below.");
    assert.deepEqual(view.rows(chooser), ["Up One Level", "billing"], "the last listing stays");
    assert.ok(notice.compareDocumentPosition(chooser.querySelector(".folder-picker-list")!) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING,
      "the notice is above the listing");
    assert.doesNotMatch(chooser.textContent ?? "", /cannot read directory/, "the runner's words wait behind Show Details");
    await view.press(view.button(notice, "Show Details"));
    assert.equal(notice.querySelector(".notice-details-body")?.textContent, MISSING_MESSAGE);
    assert.equal(field.isConnected, true, "the field stays open to fix the typo");

    await view.press(view.button(chooser, "Use This Folder"));
    assert.equal(view.host.querySelector<HTMLInputElement>("input")!.value, "/home/ada/repos",
      "Use This Folder keeps the last folder that listed");
  } finally {
    await view.unmount();
  }
});

test("a typed path that lists closes the field, and a row clears the failure", async () => {
  const view = await mount();
  try {
    const chooser = await view.open();
    await view.press(view.button(chooser, "Edit Path"));
    const field = chooser.querySelector<HTMLInputElement>(".folder-picker-bar input")!;
    await view.type(field, "/nowhere");
    await view.key(field, "Enter");
    assert.ok(chooser.querySelector(".notice.t-danger"), "Enter goes, like Go");
    await view.type(field, "/home/ada/repos");
    await view.key(field, "Enter");
    assertNoDomNode(chooser.querySelector(".notice"), "a path that lists clears the notice");
    assert.deepEqual(view.crumbs(chooser), ["Home", "repos"], "and brings the trail back");
    assertSameDomNode(document.activeElement, view.button(chooser, "Edit Path"), "focus returns to Edit Path");
  } finally {
    await view.unmount();
  }
});

test("an empty folder says it can still be used", async () => {
  const view = await mount();
  try {
    const chooser = await view.open();
    await view.press(view.button(chooser, "notes"));
    const empty = chooser.querySelector(".folder-picker-empty");
    assert.equal(empty?.textContent, "No subfolders here. You can still use this folder.");
    assert.doesNotMatch(chooser.textContent ?? "", /No Sub-Folders Here/);
    assert.equal(view.button(chooser, "Use This Folder")?.disabled, false);
  } finally {
    await view.unmount();
  }
});

test("a slow listing shows skeleton rows only after the delay, and Use This Folder waits for it", async () => {
  let release!: () => void;
  const hold = { promise: new Promise<void>((resolve) => { release = resolve; }) };
  const view = await mount({ hold });
  try {
    const chooser = await view.open();
    assertNoDomNode(chooser.querySelector(".folder-picker-skeleton"), "nothing new renders under the delay");
    assert.equal(view.button(chooser, "Use This Folder")?.disabled, true);
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, FOLDER_PICKER_SKELETON_DELAY_MS + 20)); });
    const skeleton = chooser.querySelector(".skeleton.folder-picker-skeleton");
    assert.ok(skeleton, "skeleton rows after the delay");
    assert.equal(skeleton.querySelectorAll(".row .skeleton-bar").length, 5);
    await act(async () => { release(); });
    await view.settle();
    assertNoDomNode(chooser.querySelector(".folder-picker-skeleton"));
    assert.deepEqual(view.rows(chooser), ["Up One Level", "notes", "repos"]);
  } finally {
    await view.unmount();
  }
});

test("Escape closes only Choose Folder and returns focus to Browse…, but in Edit Path restores the trail", async () => {
  const view = await mount();
  try {
    let chooser = await view.open();
    await view.press(view.button(chooser, "Edit Path"));
    const field = chooser.querySelector<HTMLInputElement>(".folder-picker-bar input")!;
    await view.type(field, "/some/half-typed");
    const claimed = await view.key(field, "Escape");
    assert.equal(claimed.defaultPrevented, true);
    assert.ok(view.dialog("Choose Folder"), "Escape in Edit Path does not close the dialog");
    assert.deepEqual(view.crumbs(chooser), ["Home"], "the trail is back");
    assertSameDomNode(document.activeElement, view.button(chooser, "Edit Path"));
    await view.press(view.button(chooser, "Edit Path"));
    assert.equal(chooser.querySelector<HTMLInputElement>(".folder-picker-bar input")!.value, "/home/ada",
      "reopening starts from the current folder, not the abandoned text");
    await view.key(chooser.querySelector(".folder-picker-bar input")!, "Escape");

    await view.key(view.button(chooser, "Edit Path")!, "Escape");
    assertNoDomNode(view.dialog("Choose Folder") ?? null, "Escape closes Choose Folder");
    assert.ok(view.dialog("New Workspace"), "and only Choose Folder");
    assertSameDomNode(document.activeElement, view.button(view.host, "Browse…"), "focus returns to Browse…");

    // Focus outside the picker (still on Browse… after a mouse press) is the same: the dialog's.
    chooser = await view.open();
    await view.key(view.button(view.host, "Browse…")!, "Escape");
    assertNoDomNode(view.dialog("Choose Folder") ?? null);
    assert.ok(view.dialog("New Workspace"));
  } finally {
    await view.unmount();
  }
});

test("on a runner that cannot list folders, a path field and Use Path fill the field Browse… came from", async () => {
  const view = await mount({ protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.directoryListing - 1 });
  try {
    const chooser = await view.open();
    assert.deepEqual(view.requests, [], "nothing asks the runner to list");
    const notice = chooser.querySelector(".notice.t-warning")!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Browsing Needs an Update");
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Update Wollipog on Build Box to browse its folders. You can still type a path.");
    assertNoDomNode(chooser.querySelector(".crumbs"), "no trail");
    assertNoDomNode(chooser.querySelector(".folder-picker-list"), "no rows");
    const footer = [...chooser.querySelectorAll(".modal-foot button")].map((element) => element.textContent);
    assert.deepEqual(footer, ["Cancel", "Use Path"]);
    const usePath = view.button(chooser, "Use Path")!;
    assert.equal(usePath.disabled, true, "Use Path waits for a path");
    const field = chooser.querySelector<HTMLInputElement>(".folder-picker input")!;
    assert.equal(chooser.querySelector(`label[for="${field.id}"]`)?.textContent, "Path");
    await view.type(field, "  /srv/app  ");
    assert.equal(usePath.disabled, false);
    await view.press(usePath);
    assertNoDomNode(view.dialog("Choose Folder") ?? null);
    assert.equal(view.host.querySelector<HTMLInputElement>("input")!.value, "/srv/app");
  } finally {
    await view.unmount();
  }
});
