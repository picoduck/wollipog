import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { LocalRunnerSetupButton } from "./OnboardRunnerDialog.js";

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
