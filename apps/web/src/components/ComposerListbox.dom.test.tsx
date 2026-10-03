import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { ComposerListbox, ComposerListboxState } from "./ComposerListbox.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

interface Item { key: string; label: string; disabled?: boolean }

const items: Item[] = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Beta", disabled: true },
  { key: "c", label: "Gamma" },
];

type Props = React.ComponentProps<typeof ComposerListbox<Item>>;

async function mount(overrides: Partial<Props> = {}) {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const container = host as unknown as HTMLDivElement;
  const root = createRoot(container);
  const props: Props = {
    listboxId: "picker-test",
    label: "Test Picker",
    sections: [{ key: "first", label: "First", items: items.slice(0, 2) }, { key: "second", label: "Second", items: items.slice(2) }],
    getKey: (item) => item.key,
    getOptionId: (item) => `picker-test-${item.key}`,
    activeKey: "a",
    isDisabled: (item) => item.disabled === true,
    renderItem: (item) => <span className="picker-line">{item.label}</span>,
    onSelect: () => {},
    enterLabel: "Insert",
    ...overrides,
  };
  await act(async () => root.render(<ComposerListbox {...props} />));
  return {
    container,
    rerender: (next: Partial<Props>) => act(async () => root.render(<ComposerListbox {...props} {...next} />)),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("one listbox of labelled groups, options, state rows and a footer", async () => {
  const view = await mount({
    states: <ComposerListboxState role="status">Searching…</ComposerListboxState>,
    note: "More matches exist.",
  });
  try {
    const picker = view.container.querySelector(".picker")!;
    const listbox = picker.querySelector('[role="listbox"]')!;
    assert.equal(listbox.id, "picker-test");
    assert.equal(listbox.getAttribute("aria-label"), "Test Picker");
    const groups = [...listbox.querySelectorAll('[role="group"].picker-group')];
    assert.deepEqual(groups.map((group) => group.querySelector(".picker-group-label")?.textContent), ["First", "Second"]);
    assert.equal(groups[0]!.getAttribute("aria-labelledby"), groups[0]!.querySelector(".picker-group-label")?.id);

    const options = [...listbox.querySelectorAll<HTMLButtonElement>('[role="option"].picker-item')];
    assert.deepEqual(options.map((option) => option.id), ["picker-test-a", "picker-test-b", "picker-test-c"]);
    assert.equal(options.every((option) => option.tabIndex === -1), true);
    assert.equal(options[0]!.getAttribute("aria-selected"), "true");
    assert.equal(options[0]!.classList.contains("is-active"), true);
    assert.equal(options[1]!.getAttribute("aria-disabled"), "true");
    assert.equal(options[1]!.disabled, false, "disabled options stay reachable and announce their reason");

    // State rows and the footer sit outside the listbox, so it owns only options and groups.
    assertNoDomNode(listbox.querySelector(".picker-empty, .picker-foot"));
    assert.equal(picker.querySelector(".picker-empty")?.getAttribute("role"), "status");
    const foot = picker.querySelector(".picker-foot")!;
    assert.equal(foot.querySelector(".picker-note")?.textContent, "More matches exist.");
    assert.equal(foot.querySelector(".picker-keys")?.getAttribute("aria-hidden"), "true");
    assert.deepEqual([...foot.querySelectorAll("kbd")].map((key) => key.textContent), ["↑", "↓", "Enter", "Tab", "Esc"]);
    assert.deepEqual([...foot.querySelectorAll(".shortcut-hint-label")].map((label) => label.textContent),
      ["Move", "Insert", "Complete", "Close"]);
  } finally {
    await view.unmount();
  }
});

test("with no options the footer offers only Escape", async () => {
  const view = await mount({
    sections: [{ key: "paths", items: [] }],
    states: <ComposerListboxState role="status">Nothing here.</ComposerListboxState>,
  });
  try {
    assert.deepEqual([...view.container.querySelectorAll(".picker-keys .shortcut-hint-label")]
      .map((label) => label.textContent), ["Close"]);
    assert.equal(view.container.querySelectorAll('[role="option"]').length, 0);
  } finally {
    await view.unmount();
  }
});

test("a section without a label renders its options directly", async () => {
  const view = await mount({ sections: [{ key: "paths", items }] });
  try {
    assertNoDomNode(view.container.querySelector('[role="group"]'));
    assert.equal(view.container.querySelectorAll('[role="listbox"] > [role="option"]').length, 3);
  } finally {
    await view.unmount();
  }
});

test("pressing keeps the composer's focus; a click chooses an enabled option only", async () => {
  const selected: string[] = [];
  const hovered: string[] = [];
  const composer = domWindow.document.createElement("textarea");
  domWindow.document.body.append(composer);
  composer.focus();
  const view = await mount({
    onSelect: (item) => selected.push(item.key),
    onActiveChange: (item) => hovered.push(item.key),
  });
  try {
    const [alpha, beta, gamma] = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const down = new domWindow.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    gamma!.dispatchEvent(down as unknown as Event);
    assert.equal(down.defaultPrevented, true);
    assert.equal(domWindow.document.activeElement, composer);

    for (const option of [alpha!, beta!, gamma!]) {
      option.dispatchEvent(new domWindow.MouseEvent("mousemove", { bubbles: true }) as unknown as Event);
      option.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }) as unknown as Event);
    }
    // The active row does not re-announce itself, and a disabled row is never active or chosen.
    assert.deepEqual(hovered, ["c"]);
    assert.deepEqual(selected, ["a", "c"]);
  } finally {
    await view.unmount();
    composer.remove();
  }
});

test("a new active option scrolls into the nearest view", async () => {
  const scrolled: Array<{ id: string; options: ScrollIntoViewOptions | undefined }> = [];
  Object.defineProperty(domWindow.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement, options?: ScrollIntoViewOptions) {
      scrolled.push({ id: this.id, options });
    },
  });
  const view = await mount();
  try {
    scrolled.length = 0;
    await view.rerender({ activeKey: "c" });
    assert.deepEqual(scrolled, [{ id: "picker-test-c", options: { block: "nearest" } }]);
  } finally {
    await view.unmount();
  }
});

test("a state row carries an optional icon, tone and second line", async () => {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const container = host as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ComposerListboxState tone="danger" role="alert" detail="Second line.">First line.</ComposerListboxState>,
    ));
    const row = container.querySelector(".picker-empty.t-danger")!;
    assert.equal(row.getAttribute("role"), "alert");
    assert.equal(row.querySelector(".picker-empty-detail")?.textContent, "Second line.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
