import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { LocalRunnerSetupButton, OnboardingRecommendedSkills } from "./OnboardRunnerDialog.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("the rendered bundled setup connects with the stable deconflicted machine identity", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const connected: string[] = [];

  try {
    await act(async () => {
      root.render(
        <LocalRunnerSetupButton
          status={{
            available: true,
            enabled: false,
            running: false,
            runnerId: null,
            suggestedRunnerId: "this-machine-a1b2c3d4",
          }}
          existingRunnerIds={["this-machine-a1b2c3d4"]}
          busy={false}
          onConnect={(runnerId) => { connected.push(runnerId); }}
        />,
      );
    });
    assert.equal(container.querySelector("button")?.textContent, "Set Up This Machine");
    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    assert.deepEqual(connected, ["this-machine-a1b2c3d4-2"]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("onboarding points to built-in skills that are neither assigned nor dismissed, and hides when none remain", async () => {
  const builtIn = { release: "0.28.0", heldUpdate: null };
  const render = async (skills: unknown[]) => {
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.append(container as never);
    const root = createRoot(container);
    const opened: string[] = [];
    const client = { ...api, listSkills: async () => ({ skills }) } as unknown as ApiClient;
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <OnboardingRecommendedSkills onOpen={(skillId) => { opened.push(skillId); }} />
        </ApiProvider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    return {
      container, opened,
      async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
    };
  };

  const shown = await render([
    { id: "a", name: "orchestrate-issues", builtIn, recommendation: { dismissed: false }, assignmentCount: 0 },
    { id: "b", name: "using-wollipog", builtIn, recommendation: { dismissed: false }, assignmentCount: 0 },
    { id: "c", name: "assigned", builtIn, recommendation: { dismissed: false }, assignmentCount: 1 },
    { id: "d", name: "dismissed", builtIn, recommendation: { dismissed: true }, assignmentCount: 0 },
    { id: "e", name: "user-skill", assignmentCount: 0 },
  ]);
  try {
    const section = shown.container.querySelector('section[aria-label="Recommended Skills"]');
    assert.ok(section);
    assert.equal(section!.querySelector("h3")?.textContent, "Recommended Skills");
    assert.deepEqual([...section!.querySelectorAll("li")].map((item) => item.textContent), ["orchestrate-issues", "using-wollipog"]);
    const open = section!.querySelector("button")!;
    assert.equal(open.textContent, "Open Skills");
    await act(async () => { open.click(); });
    assert.deepEqual(shown.opened, ["a"]);
  } finally {
    await shown.unmount();
  }

  const hidden = await render([
    { id: "c", name: "assigned", builtIn, recommendation: { dismissed: false }, assignmentCount: 1 },
    { id: "d", name: "dismissed", builtIn, recommendation: { dismissed: true }, assignmentCount: 0 },
  ]);
  try {
    assert.equal(hidden.container.querySelector('section[aria-label="Recommended Skills"]'), null);
  } finally {
    await hidden.unmount();
  }
});
