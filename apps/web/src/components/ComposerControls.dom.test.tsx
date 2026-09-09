import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionConfig } from "@wollipog/protocol";
import {
  ApprovalsMenuChoices,
  ModelEffortMenuChoices,
  type PermissionModeDetails,
} from "./ComposerControls.js";
import { handleMenuKeyDown } from "./interactions.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

test("permission details are keyboard reachable and do not select the mode", async () => {
  const applied: Partial<SessionConfig>[] = [];
  const opened: PermissionModeDetails[] = [];
  let openedBy: HTMLButtonElement | null = null;
  let closeCount = 0;

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <div role="menu" onKeyDown={(event) => handleMenuKeyDown(event, () => undefined)}>
        <ApprovalsMenuChoices
          capabilities={{
            models: [],
            effortLevels: [],
            slashCommands: [],
            supportsImages: true,
            supportsApprovals: true,
            permissionModes: ["danger-full-access"],
            elicitation: { "danger-full-access": ["app-server"] },
          }}
          driver="codex-app-server"
          permModes={["danger-full-access"]}
          permVal=""
          apply={(patch) => applied.push(patch)}
          close={() => { closeCount += 1; }}
          onDetails={(details, trigger) => {
            opened.push(details);
            openedBy = trigger;
          }}
        />
      </div>,
    );
  });

  try {
    const detailsButton = [
      ...container.querySelectorAll<HTMLButtonElement>(".cbar-permission-details-trigger"),
    ].find((button) => button.getAttribute("aria-label") === "Full Access (No Sandbox) Details");
    assert.ok(detailsButton, "every compact row exposes a labelled details action");
    const modeButton = detailsButton.closest(".cbar-permission-row")
      ?.querySelector<HTMLButtonElement>('[role="menuitemradio"]');
    assert.ok(modeButton, "the compact row keeps selection and details as separate controls");

    modeButton.focus();
    await act(async () => {
      modeButton.dispatchEvent(
        new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event,
      );
    });
    assert.equal(domWindow.document.activeElement, detailsButton,
      "ArrowDown reaches the row's details action");

    await act(async () => { detailsButton.click(); });
    assert.deepEqual(applied, [], "opening details does not select a mode");
    assert.equal(closeCount, 0, "opening details does not dismiss the selector");
    assert.equal(opened.length, 1);
    assert.equal(openedBy, detailsButton, "the dialog can restore focus to its exact trigger");
    assert.equal(opened[0]!.label, "Full Access (No Sandbox)");
    assert.equal(opened[0]!.outcome.label, "No Command Approvals");
    assert.match(opened[0]!.description, /Questions and MCP elicitations can still reach you/);
    assert.match(opened[0]!.description, /without sandbox or approval checks/);

    await act(async () => { modeButton.click(); });
    assert.deepEqual(applied, [{ permissionMode: "danger-full-access" }]);
    assert.equal(closeCount, 1);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the Context Window group offers provider-stated variants and switches only the model id", async () => {
  const applied: Partial<SessionConfig>[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (contextChoice: Parameters<typeof ModelEffortMenuChoices>[0]["contextChoice"]) => act(async () => {
    root.render(
      <div role="menu" onKeyDown={(event) => handleMenuKeyDown(event, () => undefined)}>
        <ModelEffortMenuChoices
          models={[{ id: "opus[1m]", displayName: "Opus 5" }, { id: "sonnet", displayName: "Sonnet 5" }]}
          modelVal="opus[1m]"
          selectedModel={{ id: "opus[1m]", displayName: "Opus 5" }}
          contextChoice={contextChoice}
          modelEfforts={["low", "high"]}
          effortVal="high"
          apply={(patch) => applied.push(patch)}
        />
      </div>,
    );
  });
  try {
    await render({
      baseModelId: "opus",
      options: [
        { id: "opus", contextWindow: 200_000, label: "200K" },
        { id: "opus[1m]", contextWindow: 1_000_000, label: "1M" },
      ],
      selectedId: "opus[1m]",
    });
    const group = container.querySelector('[role="group"][aria-label="Context Window"]');
    assert.ok(group, "a real choice renders a Context Window group");
    const radios = [...group!.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[];
    assert.deepEqual(radios.map((radio) => radio.textContent), ["200K", "1M"]);
    assert.deepEqual(radios.map((radio) => radio.getAttribute("aria-checked")), ["false", "true"]);
    assert.equal(radios[0]!.title, "200,000 tokens; applies to the next turn");
    await act(async () => { radios[0]!.click(); });
    assert.deepEqual(applied, [{ model: "opus" }], "a window switch changes the model id and keeps the effort");

    await render(null);
    assert.equal(container.querySelector('[role="group"][aria-label="Context Window"]'), null,
      "no group without a real provider-listed choice");
    assert.ok(container.querySelector('[role="group"][aria-label="Model"]'));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
