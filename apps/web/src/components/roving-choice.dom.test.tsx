import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { SegmentedControl } from "./ui/ChoiceControls.js";

const domWindow = new Window({ url: "http://localhost/usage" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/**
 * What the roving keys DO, which static markup cannot answer.
 *
 * The rest of the primitive's tests render to a string and read the semantics out of it. This one
 * needs a real event loop, because the defect was in what a key press caused rather than in what
 * the markup said: Home resolved to the option already selected and clicked it anyway.
 */

function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host as never);
  const root = createRoot(host as unknown as Element);
  act(() => root.render(node));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const press = (element: Element, key: string) => {
  act(() => {
    element.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as never);
  });
};

test("Home on the option already selected does not re-activate it", () => {
  // Usage treats re-selecting the current range as a REFRESH, so an unconditional click here is one
  // API request per keydown — and holding Home is many. The button row this replaced ignored Home
  // and End entirely, so the amplification arrived with the migration rather than surviving it.
  const chosen: string[] = [];
  const { host, unmount } = mount(
    <SegmentedControl
      label="Range"
      value="7"
      options={[{ value: "7", label: "7d" }, { value: "30", label: "30d" }]}
      onChange={(next) => chosen.push(next)}
    />,
  );
  const options = host.querySelectorAll('[role="radio"]');
  (options[0] as unknown as HTMLElement).focus();
  press(options[0]!, "Home");
  assert.deepEqual(chosen, [], "Home resolved to the selected option, so there was nothing to change");

  // And it still MOVES: End lands on the last option and activates it, because that IS a change.
  press(options[0]!, "End");
  assert.deepEqual(chosen, ["30"], "End must still select the option it moves to");
  unmount();
});

test("arrow keys still select as they move", () => {
  // The guard is "already selected", not "keyboard". Weakening it to skip activation entirely would
  // make the group navigable and unusable, which is the failure mode on the other side.
  const chosen: string[] = [];
  const { host, unmount } = mount(
    <SegmentedControl
      label="Range"
      value="7"
      options={[{ value: "7", label: "7d" }, { value: "30", label: "30d" }]}
      onChange={(next) => chosen.push(next)}
    />,
  );
  const options = host.querySelectorAll('[role="radio"]');
  (options[0] as unknown as HTMLElement).focus();
  press(options[0]!, "ArrowRight");
  assert.deepEqual(chosen, ["30"]);
  unmount();
});

test("a held arrow key does not queue a request per repeat", async () => {
  // The Home/End guard only stopped RE-clicking the option already selected. Every arrow lands on a
  // different unchecked option, so each repeat was a genuine change and a genuine fetch — and the
  // control plane aggregates up to 100,000 rows synchronously per request, which a client-side
  // generation check cannot undo. The selection stays immediate; the fetch is what waits.
  const loads: number[] = [];
  function Harness() {
    const [days, setDays] = React.useState(7);
    React.useEffect(() => {
      const timer = window.setTimeout(() => loads.push(days), 120);
      return () => window.clearTimeout(timer);
    }, [days]);
    return (
      <SegmentedControl
        label="Range"
        value={String(days)}
        options={[7, 30, 90, 365].map((range) => ({ value: String(range), label: `${range}d` }))}
        onChange={(next) => setDays(Number(next))}
      />
    );
  }
  const { host, unmount } = mount(<Harness />);
  const options = host.querySelectorAll('[role="radio"]');
  (options[0] as unknown as HTMLElement).focus();
  // THREE presses, not four: four wraps back to 7, and `[7]` would then also be what a control
  // that never moved produced. This has to prove coalescing and movement at once.
  for (let repeat = 0; repeat < 3; repeat += 1) {
    press(document.activeElement as Element, "ArrowRight");
  }
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  assert.deepEqual(loads, [365], "three key repeats must coalesce into the one range they ended on");
  unmount();
});
