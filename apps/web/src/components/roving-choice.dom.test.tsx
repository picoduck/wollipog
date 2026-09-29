import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { Checkbox, ChoiceRows, SegmentedControl } from "./ui/ChoiceControls.js";

const domWindow = new Window({ url: "http://localhost/usage" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
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

/**
 * A disabled option must be REACHABLE, or "rendered, never hidden" is only true for people using a
 * mouse.
 *
 * Both primitives say this in their comments — SegmentedControl's reads "`disabled` would remove it
 * from the roving order, so a disabled option becomes invisible to keyboard users rather than
 * explained to them" — and neither implemented it: `handleRovingChoiceKeyDown` filters out
 * `aria-disabled` unless told otherwise, and neither caller told it otherwise. The stop never lands
 * on a disabled option either, so the arrows were the ONLY way in and they skipped it.
 *
 * #832 made this load-bearing rather than theoretical. The Orchestrator preset used to be omitted
 * when unsupported; it is now rendered with the reason it cannot be chosen, and a keyboard user who
 * could not reach the card could not read the reason.
 */
test("a disabled ChoiceRow stays focusable, refuses the click, and says why", () => {
  // ChoiceRows are native radios, so the ARROWS are the browser's (choice-rows.spec.ts drives them
  // in Chromium). What a DOM can check is the contract that makes them reach the row: the input is
  // `aria-disabled` rather than `disabled` — a natively disabled radio drops out of the arrow order,
  // leaving its reason reachable by mouse and by nothing else — and the refusal holds on the row.
  const chosen: string[] = [];
  const { host, unmount } = mount(
    <ChoiceRows
      label="Permission Preset"
      value="default"
      onChange={(value) => chosen.push(value)}
      options={[
        { value: "default", title: "Harness Default" },
        { value: "orchestrator", title: "Orchestrator", disabled: true, disabledReason: "This runner is too old." },
      ]}
    />,
  );
  try {
    const [first, second] = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    assert.ok(first && second);
    assert.equal(second.hasAttribute("disabled"), false);
    assert.equal(second.getAttribute("aria-disabled"), "true");
    act(() => second.focus());
    // `assert.equal` on two DOM NODES, not a boolean: happy-dom elements reference their window, so
    // a failed comparison serialises the whole circular tree for the diff and the runner hangs for
    // ~16s before dying with no message. Compare something primitive.
    assert.equal(document.activeElement === second, true, "the disabled row can take focus");

    // Reachable is not selectable: a click anywhere on the row must not choose it or fire onChange,
    // and the controlled value puts the check back where it was.
    act(() => (second.closest("label") as HTMLElement).click());
    assert.equal(second.checked, false);
    assert.deepEqual(chosen, []);
    assert.equal(first.checked, true, "the real selection is unchanged");

    // And the reason is its accessible description, so focusing the row announces it.
    const described = (second.getAttribute("aria-describedby") ?? "").split(" ")
      .map((id) => host.querySelector(`[id="${id}"]`)?.textContent).join(" ");
    assert.match(described, /This runner is too old/);
  } finally {
    unmount();
  }
});

test("clicking anywhere on an available ChoiceRow selects it, and clicking the selected one reports it again", () => {
  const chosen: string[] = [];
  const { host, unmount } = mount(
    <ChoiceRows
      label="Wake Policy"
      value="until_activity"
      onChange={(value) => chosen.push(value)}
      options={[
        { value: "until_activity", title: "Until Activity", description: "Return sooner for activity." },
        { value: "regardless", title: "Regardless", description: "Return only at the scheduled time." },
      ]}
    />,
  );
  try {
    const rows = [...host.querySelectorAll<HTMLElement>(".choice-row")];
    act(() => (rows[1]!.querySelector(".choice-row-desc") as HTMLElement).click());
    assert.deepEqual(chosen, ["regardless"], "the description is part of the target");
    // The cards this replaced reported a re-selection, and New Session and Move to Project rely on
    // it; a checked native radio fires no `change`, so the row reports it from the click.
    act(() => rows[0]!.click());
    assert.deepEqual(chosen, ["regardless", "until_activity"]);
  } finally {
    unmount();
  }
});

test("a segmented control reaches its disabled option too", () => {
  // Same hole, same fix, stated separately because the two primitives call the handler themselves
  // and a fix applied to one would silently leave the other behind.
  const { host, unmount } = mount(
    <SegmentedControl
      label="Range"
      value="day"
      onChange={() => undefined}
      options={[
        { value: "day", label: "Day" },
        { value: "year", label: "Year", disabled: true, disabledReason: "Requires a paid plan" },
      ]}
    />,
  );
  try {
    const [first, second] = [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
    assert.ok(first && second);
    act(() => first.focus());
    press(first, "ArrowRight");
    assert.equal(document.activeElement === second, true);
    assert.equal(second.getAttribute("aria-checked"), "false");
  } finally {
    unmount();
  }
});

test("clicking a Checkbox row's label toggles it, and a disabled row does not", () => {
  // The bare 13px box this replaced was the only target; the label beside it was the caller's
  // own text and did nothing. The row is the `<label>` now, so its text toggles the box.
  const changes: boolean[] = [];
  function Harness() {
    const [checked, setChecked] = React.useState(false);
    return (
      <>
        <Checkbox label="Include Session Name" checked={checked}
          onChange={(next) => { changes.push(next); setChecked(next); }} />
        <Checkbox label="Expired" disabled checked={false} onChange={(next) => changes.push(next)} />
      </>
    );
  }
  const { host, unmount } = mount(<Harness />);
  try {
    const [enabled, disabled] = [...host.querySelectorAll<HTMLElement>(".checkbox-label")];
    act(() => enabled!.click());
    assert.deepEqual(changes, [true]);
    assert.equal(host.querySelectorAll<HTMLInputElement>("input")[0]!.checked, true);
    act(() => enabled!.click());
    assert.deepEqual(changes, [true, false]);
    act(() => disabled!.click());
    assert.deepEqual(changes, [true, false], "a disabled row refuses the click");
  } finally {
    unmount();
  }
});
