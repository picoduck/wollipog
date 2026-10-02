import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("Create Project describes a Project in user nouns", async () => {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <ApiProvider client={api}>
        <CreateProjectDialog accessScopeManagementSupported={false} onClose={() => {}} onCreated={() => {}} />
      </ApiProvider>,
    );
    await Promise.resolve();
  });
  try {
    // The dialog is portalled to <body>.
    const description = domWindow.document.getElementById("create-project-description")?.textContent ?? "";
    assert.match(description, /^A Project keeps related sessions together\. Choose who can discover and manage it;/u);
    // docs/design-system.md §17.2 retires these system nouns from user copy.
    assert.doesNotMatch(description, /control plane|durable/iu);
  } finally {
    await act(async () => root.unmount());
    mountPoint.remove();
  }
});
