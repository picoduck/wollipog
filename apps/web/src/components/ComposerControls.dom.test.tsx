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
  const render = (
    contextChoice: Parameters<typeof ModelEffortMenuChoices>[0]["contextChoice"],
    effortVal = "low",
  ) => act(async () => {
    root.render(
      <div role="menu" onKeyDown={(event) => handleMenuKeyDown(event, () => undefined)}>
        <ModelEffortMenuChoices
          models={[{ id: "opus[1m]", displayName: "Opus 5" }, { id: "sonnet", displayName: "Sonnet 5" }]}
          modelVal="opus[1m]"
          selectedModel={{ id: "opus[1m]", displayName: "Opus 5" }}
          contextChoice={contextChoice}
          modelEfforts={["low", "high"]}
          effortVal={effortVal}
          apply={(patch) => applied.push(patch)}
        />
      </div>,
    );
  });
  const choice = {
    baseModelId: "opus",
    options: [
      { id: "opus", contextWindow: 200_000, label: "200K" },
      { id: "opus[1m]", contextWindow: 1_000_000, label: "1M" },
    ],
    selectedId: "opus[1m]",
  };
  try {
    await render(choice);
    const group = container.querySelector('[role="group"][aria-label="Context Window"]');
    assert.ok(group, "a real choice renders a Context Window group");
    const radios = [...group!.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[];
    assert.deepEqual(radios.map((radio) => radio.textContent), ["200K", "1M"]);
    assert.deepEqual(radios.map((radio) => radio.getAttribute("aria-checked")), ["false", "true"]);
    assert.equal(radios[0]!.title, "200,000 tokens; applies to the next turn");
    await act(async () => { radios[0]!.click(); });
    // The effort has to be sent explicitly: the control plane reads a model-only patch as "no
    // effort chosen" and resolves an explicit `low` back to the model's default effort.
    assert.deepEqual(applied, [{ model: "opus", effort: "low" }],
      "a window switch changes the model id and carries the explicit effort along");

    applied.length = 0;
    // A variant that advertises a narrower effort set must not be sent an effort it would reject.
    await render({
      ...choice,
      options: [
        { ...choice.options[0]!, efforts: ["low", "high"] },
        { ...choice.options[1]!, efforts: ["high"] },
      ],
      selectedId: "opus",
    }, "low");
    const asymmetric = [...container
      .querySelectorAll('[role="group"][aria-label="Context Window"] [role="menuitemradio"]')] as HTMLButtonElement[];
    await act(async () => { asymmetric[1]!.click(); });
    assert.deepEqual(applied, [{ model: "opus[1m]" }],
      "the 1M variant does not advertise low, so the switch lets its own default effort apply");

    applied.length = 0;
    await render(choice, "");
    const defaultEffortRadios = [...container
      .querySelectorAll('[role="group"][aria-label="Context Window"] [role="menuitemradio"]')] as HTMLButtonElement[];
    await act(async () => { defaultEffortRadios[0]!.click(); });
    assert.deepEqual(applied, [{ model: "opus" }],
      "an unset effort stays unset so the new model's own default applies");

    await render(null);
    assert.equal(container.querySelector('[role="group"][aria-label="Context Window"]'), null,
      "no group without a real provider-listed choice");
    assert.ok(container.querySelector('[role="group"][aria-label="Model"]'));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
