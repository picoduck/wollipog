import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionConfig } from "@wollipog/protocol";
import {
  ApprovalsMenuChoices,
  ModelEffortMenuChoices,
  ModelSettingsPopover,
} from "./ComposerControls.js";
import { handleMenuKeyDown } from "./interactions.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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

test("each permission row is one menu radio: arrows move between modes and choosing one applies it and closes", async () => {
  const applied: Partial<SessionConfig>[] = [];
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
            permissionModes: ["auto-review", "danger-full-access"],
            elicitation: { "danger-full-access": ["app-server"] },
          }}
          driver="codex-app-server"
          permModes={["auto-review", "danger-full-access"]}
          permVal="auto-review"
          apply={(patch) => applied.push(patch)}
          close={() => { closeCount += 1; }}
        />
      </div>,
    );
  });

  try {
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    const radios = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    assert.equal(radios.length, 3, "Default, Approve for Me and Full Access");
    assert.deepEqual(buttons, radios, "every focusable row is exactly one menuitemradio");
    for (const radio of radios) {
      assertNoDomNode(radio.querySelector("button, [role='menuitem']"), "a row holds no control of its own");
      assert.ok(radio.querySelector(".menu-desc")?.textContent, "every row shows its meaning as a second line");
    }
    const [defaultRow, approveRow, fullAccess] = radios as [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement];
    // The second line describes the row; it does not rename it.
    assert.equal(
      domWindow.document.getElementById(fullAccess.getAttribute("aria-labelledby")!)?.textContent,
      "Full Access (No Sandbox)",
    );
    assert.match(fullAccess.querySelector(".menu-desc")!.textContent!, /no sandbox and no command approvals, but questions can still reach you/);
    assert.ok(fullAccess.querySelector(".menu-icon .permission-mode-risk"), "Full Access carries the amber shield");
    assertNoDomNode(approveRow.querySelector(".menu-icon"), "a mode that keeps approvals carries no warning");
    assert.equal(approveRow.getAttribute("aria-checked"), "true");
    assert.ok(approveRow.querySelector(".menu-check"), "the selected mode has a trailing check");

    // Default and Approve for Me have no reported delivery here, so one note names both; Full
    // Access reports its own.
    const notes = menu.querySelectorAll<HTMLElement>(".menu-note");
    assert.equal(notes.length, 1);
    assert.equal(menu.lastElementChild, notes[0], "the note sits at the bottom of the menu");
    assert.equal(notes[0]!.textContent,
      "Wollipog hasn't confirmed that approval prompts from Default and Approve for Me reach you here.");
    for (const row of [defaultRow, approveRow]) {
      assert.ok(row.getAttribute("aria-describedby")!.split(" ").includes(notes[0]!.id));
    }
    assert.ok(!fullAccess.getAttribute("aria-describedby")!.split(" ").includes(notes[0]!.id));

    approveRow.focus();
    await act(async () => {
      approveRow.dispatchEvent(
        new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event,
      );
    });
    assert.equal(domWindow.document.activeElement, fullAccess, "ArrowDown goes straight to the next mode");

    await act(async () => { fullAccess.click(); });
    assert.deepEqual(applied, [{ permissionMode: "danger-full-access" }]);
    assert.equal(closeCount, 1, "choosing a mode closes the menu");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Model Settings close control dismisses without selecting and restores trigger focus", async () => {
  let selectionCount = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ModelSettingsPopover label="Current Model" ariaLabel="Model Settings: Current Model">
        {() => (
          <div role="radiogroup" aria-label="Model">
            <button type="button" role="radio" aria-checked="true" tabIndex={0} onClick={() => { selectionCount += 1; }}>
              Current Model
            </button>
          </div>
        )}
      </ModelSettingsPopover>,
    );
  });

  try {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Model Settings: Current Model"]');
    assert.ok(trigger);
    await act(async () => { trigger.click(); });

    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
    // The popover is portalled to <body> (the shared MenuSurface).
    const dialog = domWindow.document.querySelector('[role="dialog"][aria-label="Model Settings"]');
    assert.ok(dialog, "Model Settings is a dialog of radio groups, not a menu");
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));
    const current = dialog.querySelector('[role="radio"]');
    assert.ok(domWindow.document.activeElement === current, "opening lands on the current choice, not on Close");
    const close = domWindow.document.querySelector('[aria-label="Close Model Settings"]') as unknown as HTMLButtonElement | null;
    assert.ok(close, "the open surface exposes an explicitly labelled close control");
    assert.equal(close.getAttribute("role"), null, "a plain button inside the dialog");
    await act(async () => {
      close.click();
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });

    assert.equal(selectionCount, 0, "closing does not activate the selected setting");
    assertNoDomNode(domWindow.document.querySelector('[role="dialog"]'));
    assert.equal(domWindow.document.activeElement, trigger, "focus returns to the Model Settings trigger");

    // Escape closes it too, and Tab stays inside while it is open.
    await act(async () => { trigger.click(); });
    const reopened = domWindow.document.querySelector('[role="dialog"][aria-label="Model Settings"]')!;
    const radio = reopened.querySelector('[role="radio"]')!;
    await act(async () => {
      radio.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }) as never);
    });
    assert.ok(domWindow.document.activeElement === reopened.querySelector('[aria-label="Close Model Settings"]'),
      "Tab from the last stop wraps to the first, the Close button");
    await act(async () => {
      (domWindow.document.activeElement as unknown as HTMLElement).dispatchEvent(
        new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never,
      );
      // Focus returns to the trigger on the next task.
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });
    assertNoDomNode(domWindow.document.querySelector('[role="dialog"]'));
    // Compare booleans: a failed equality between two happy-dom nodes inspects the whole document.
    assert.ok(domWindow.document.activeElement === trigger, "Escape returns focus to the trigger");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Model Settings keeps descriptions and Service Tier selection in one popover, and arrows only move", async () => {
  const applied: Partial<SessionConfig>[] = [];
  let closeCount = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <div>
        <ModelEffortMenuChoices
          models={[
            { id: "gpt", displayName: "GPT Astra", description: "GPT Astra · Best for complex work" },
            { id: "mini", displayName: "GPT Mini" },
          ]}
          modelVal="gpt"
          selectedModel={{ id: "gpt", displayName: "GPT Astra" }}
          modelEfforts={["high"]}
          effortVal="high"
          serviceTierState={{
            choices: [
              { id: "default", name: "Standard", description: "Standard response speed." },
              { id: "fast", name: "Fast", description: "Faster responses." },
            ],
            selected: { id: "default", name: "Standard", description: "Standard response speed." },
          }}
          close={() => { closeCount += 1; }}
          apply={(patch) => applied.push(patch)}
        />
      </div>,
    );
  });

  try {
    assert.match(container.textContent ?? "", /GPT AstraBest for complex work\./);
    assert.match(container.textContent ?? "", /Changes apply from the next turn\./);
    // Arrowing past a model must not choose it: each choice is a live request and resets the effort.
    const models = [...container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Model"] [role="radio"]')];
    models[0]!.focus();
    await act(async () => {
      models[0]!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }) as never);
    });
    assert.ok((domWindow.document.activeElement as unknown) === models[1], "the arrow key moves to the next model");
    assert.deepEqual(applied, [], "and does not choose it");
    const tierGroup = container.querySelector('[role="radiogroup"][aria-label="Service Tier"]');
    assert.ok(tierGroup);
    const fast = [...tierGroup.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes("Fast"));
    assert.ok(fast);
    await act(async () => { fast.click(); });
    assert.deepEqual(applied, [{ serviceTier: "fast" }]);
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
  let staged: string | undefined;
  const render = (
    contextChoice: Parameters<typeof ModelEffortMenuChoices>[0]["contextChoice"],
    effortVal = "low",
    agentEffortLevels: readonly string[] = ["low", "high"],
  ) => act(async () => {
    root.render(
      <div>
        <ModelEffortMenuChoices
          models={[{ id: "opus[1m]", displayName: "Opus 5" }, { id: "sonnet", displayName: "Sonnet 5" }]}
          modelVal="opus[1m]"
          selectedModel={{ id: "opus[1m]", displayName: "Opus 5" }}
          contextChoice={contextChoice}
          modelEfforts={["low", "high"]}
          agentEffortLevels={agentEffortLevels}
          effortVal={effortVal}
          pendingEffort={() => staged}
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
    const group = container.querySelector('[role="radiogroup"][aria-label="Context Window"]');
    assert.ok(group, "a real choice renders a Context Window radio group");
    assert.ok(group!.classList.contains("seg"), "drawn as the segmented control (§10.2)");
    const radios = [...group!.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
    assert.deepEqual(radios.map((radio) => radio.textContent), ["200K", "1M"]);
    assert.deepEqual(radios.map((radio) => radio.getAttribute("aria-checked")), ["false", "true"]);
    assert.equal(radios[0]!.title, "200,000 tokens", "the tooltip keeps the exact token count");
    await act(async () => { radios[0]!.click(); });
    // The effort has to be sent explicitly: the control plane reads a model-only patch as "no
    // effort chosen" and resolves an explicit `low` back to the model's default effort.
    assert.deepEqual(applied, [{ model: "opus", effort: "low", serviceTier: "" }],
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
      .querySelectorAll('[role="radiogroup"][aria-label="Context Window"] [role="radio"]')] as HTMLButtonElement[];
    await act(async () => { asymmetric[1]!.click(); });
    // An explicit reset, not an omitted key: omitting it would leave `low` staged in the composer's
    // pending config, which then rides along with the next prompt and is rejected as unsupported.
    assert.deepEqual(applied, [{ model: "opus[1m]", effort: "", serviceTier: "" }],
      "the 1M variant does not advertise low, so the switch clears it and its own default applies");

    applied.length = 0;
    // An effort chosen moments ago is staged for the next prompt but not yet in `effortVal`, which
    // only catches up after setConfig round-trips. The switch must carry the newer choice, not
    // reset it: read it at click time.
    staged = "high";
    await render(choice, "low");
    const racing = [...container
      .querySelectorAll('[role="radiogroup"][aria-label="Context Window"] [role="radio"]')] as HTMLButtonElement[];
    await act(async () => { racing[0]!.click(); });
    assert.deepEqual(applied, [{ model: "opus", effort: "high", serviceTier: "" }],
      "a just-staged effort survives a window switch made before the session view catches up");
    staged = undefined;

    applied.length = 0;
    // Neither variant advertises its own efforts, so both inherit the agent's levels. The session
    // still shows a persisted `low` that discovery has since dropped; it must not be carried over.
    await render(choice, "low", ["high"]);
    const stale = [...container
      .querySelectorAll('[role="radiogroup"][aria-label="Context Window"] [role="radio"]')] as HTMLButtonElement[];
    await act(async () => { stale[0]!.click(); });
    assert.deepEqual(applied, [{ model: "opus", effort: "", serviceTier: "" }],
      "an effort the agent no longer advertises is cleared rather than sent");

    applied.length = 0;
    await render(choice, "");
    const defaultEffortRadios = [...container
      .querySelectorAll('[role="radiogroup"][aria-label="Context Window"] [role="radio"]')] as HTMLButtonElement[];
    await act(async () => { defaultEffortRadios[0]!.click(); });
    assert.deepEqual(applied, [{ model: "opus", effort: "", serviceTier: "" }],
      "an unset effort stays unset so the new model's own default applies");

    await render(null);
    assertNoDomNode(container.querySelector('[role="radiogroup"][aria-label="Context Window"]'),
      "no group without a real provider-listed choice");
    assert.ok(container.querySelector('[role="radiogroup"][aria-label="Model"]'));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a refused person's composer setting is disabled with the reason and never opens (#1857)", async () => {
  const reason = "Your Viewer role is read-only.";
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let selectionCount = 0;
  await act(async () => {
    root.render(
      <ModelSettingsPopover label="Current Model" ariaLabel="Model Settings: Current Model" title="Choose a model" disabledReason={reason}>
        {() => (
          <button type="button" role="radio" aria-checked="true" onClick={() => { selectionCount += 1; }}>
            Current Model
          </button>
        )}
      </ModelSettingsPopover>,
    );
  });
  try {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Model Settings: Current Model"]')!;
    assert.equal(trigger.disabled, true);
    assert.equal(trigger.title, reason, "the trigger says why instead of its usual hint");
    const described = trigger.getAttribute("aria-describedby");
    assert.equal(described ? domWindow.document.getElementById(described)?.textContent : null, reason);
    await act(async () => {
      trigger.click();
      trigger.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never);
    });
    assertNoDomNode(domWindow.document.querySelector('[role="dialog"]'), "the popover never opens");
    assert.equal(selectionCount, 0);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
