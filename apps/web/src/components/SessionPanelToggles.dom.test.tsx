import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { shortcutDisplay } from "../shortcuts.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { SessionPanelToggles, TERMINAL_UPDATE_NOTE } from "./SessionPanelToggles.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
let coarsePointer = false;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    get matches() { return query === "(pointer: coarse)" && coarsePointer; },
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/** The shell's wiring: each toggle flips its own panel; an old runner's Terminal opens the launcher. */
function Toggles({ terminalSupported = true, onLauncher }: { terminalSupported?: boolean; onLauncher?: () => void }) {
  const [pinned, setPinned] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [side, setSide] = useState(false);
  return (
    <SessionPanelToggles
      small={false}
      pinnedSummaryOpen={pinned}
      onPinnedSummary={() => setPinned((value) => !value)}
      terminalSupported={terminalSupported}
      terminalOpen={terminal}
      onTerminal={() => terminalSupported ? setTerminal((value) => !value) : onLauncher?.()}
      sidePanelOpen={side}
      onSidePanel={() => setSide((value) => !value)}
    />
  );
}

async function mount(element: React.ReactElement) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    button: (name: string) => {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
      assert.ok(button, `${name} is rendered`);
      return button;
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("the panel toggles keep one name in both states and report the state through aria-pressed (#2164)", async () => {
  coarsePointer = false;
  const mounted = await mount(<Toggles />);
  try {
    const group = mounted.container.querySelector('[role="group"]');
    assert.equal(group?.getAttribute("aria-label"), "Panels");
    const names = ["Pinned Summary", "Terminal", "Side Panel"];
    assert.deepEqual([...group!.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")), names);
    for (const pressed of ["false", "true", "false"]) {
      for (const name of names) {
        const button = mounted.button(name);
        assert.equal(button.getAttribute("aria-pressed"), pressed, `${name} reports ${pressed}`);
        for (const text of [button.getAttribute("aria-label"), button.getAttribute("title")]) {
          assert.doesNotMatch(text ?? "", /^(Show|Hide|Toggle)\b/, `${name}: ${text}`);
        }
      }
      for (const name of names) await act(async () => { mounted.button(name).click(); });
    }
  } finally {
    await mounted.cleanup();
  }
});

test("each tooltip repeats the name, and the Terminal's and Side Panel's name their chords on a fine pointer only (§11.5)", async () => {
  coarsePointer = false;
  const fine = await mount(<Toggles />);
  try {
    assert.equal(fine.button("Pinned Summary").title, "Pinned Summary");
    // The Side Panel toggle shows its chord (#2843, #1260).
    assert.equal(fine.button("Side Panel").title, `Side Panel (${shortcutDisplay("toggle-side-panel")})`);
    assert.ok(fine.button("Side Panel").getAttribute("aria-keyshortcuts"));
    assert.equal(fine.button("Terminal").title, `Terminal (${shortcutDisplay("toggle-terminal")})`);
    assert.match(fine.button("Terminal").title, /`/, "the chord is Ctrl+` (⌘` on a Mac)");
    assert.ok(fine.button("Terminal").getAttribute("aria-keyshortcuts"));
  } finally {
    await fine.cleanup();
  }

  coarsePointer = true;
  const coarse = await mount(<Toggles />);
  try {
    assert.equal(coarse.button("Terminal").title, "Terminal", "a coarse pointer shows no keycap");
    assert.equal(coarse.button("Side Panel").title, "Side Panel");
  } finally {
    await coarse.cleanup();
  }
});

test("a runner without session shells keeps the name Terminal and says why in its tooltip and description", async () => {
  coarsePointer = false;
  let launcher = 0;
  const mounted = await mount(<Toggles terminalSupported={false} onLauncher={() => { launcher += 1; }} />);
  try {
    const terminal = mounted.button("Terminal");
    assert.equal(terminal.title, TERMINAL_UPDATE_NOTE);
    assert.equal(TERMINAL_UPDATE_NOTE, "Update the runner to use the terminal.");
    const description = mounted.container.querySelector(`#${terminal.getAttribute("aria-describedby")}`);
    assert.equal(description?.textContent, TERMINAL_UPDATE_NOTE);
    assert.equal(terminal.getAttribute("aria-pressed"), "false");
    assert.equal(terminal.getAttribute("aria-keyshortcuts"), null);
    await act(async () => { terminal.click(); });
    assert.equal(launcher, 1, "the toggle still opens the panel launcher");
    assert.equal(terminal.getAttribute("aria-label"), "Terminal");
  } finally {
    await mounted.cleanup();
  }
});
