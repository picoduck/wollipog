import assert from "node:assert/strict";
import test from "node:test";
import "../test-dom-events.js";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { fireDomEvent } from "../test-dom-events.js";
import { ariaReferencedText, assertNoDomNode } from "../../dom-test-assertions.js";
import {
  SearchableCombobox,
  Select,
  type PickerCreateOption,
  type PickerFooterAction,
  type SearchableComboboxOption,
} from "./ChoiceControls.js";

/**
 * #2951: grouped combobox options, the chosen check, the footer action row on Select and
 * SearchableCombobox, and a combobox a form can focus without opening its list.
 */

const domWindow = new Window({ url: "http://localhost/choices" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  PointerEvent: domWindow.PointerEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  // Select moves focus into its open list on a frame.
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const AGENTS: readonly SearchableComboboxOption<string>[] = [
  { value: "claude", label: "Claude Code", description: "Local", group: "Ready" },
  { value: "codex", label: "Codex", group: "Ready" },
  { value: "payments", label: "Payments Agent", description: "Remote", group: "Ready" },
  { value: "pi", label: "Pi", group: "Needs Setup", disabled: true, disabledReason: "Sign In Required" },
  { value: "gemini", label: "Gemini", group: "Needs Setup", disabled: true, disabledReason: "Not Installed" },
];

function press(element: Element, key: string, init: KeyboardEventInit = {}) {
  let allowed = true;
  act(() => {
    allowed = element.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    } as never) as never);
  });
  return allowed;
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    fireDomEvent.change(input, { target: { value } });
  });
}

function mountCombobox(props: {
  value?: string | null;
  footerAction?: PickerFooterAction;
  createOption?: PickerCreateOption;
  openOnFocus?: boolean;
  options?: readonly SearchableComboboxOption<string>[];
} = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  const chosen: string[] = [];
  act(() => root.render(
    <SearchableCombobox
      label="Agent"
      options={props.options ?? AGENTS}
      value={props.value === undefined ? "codex" : props.value}
      onChange={(value) => chosen.push(value)}
      noun="agents"
      footerAction={props.footerAction}
      createOption={props.createOption}
      openOnFocus={props.openOnFocus}
    />,
  ));
  return {
    host,
    chosen,
    input: host.querySelector<HTMLInputElement>('[role="combobox"]')!,
    listbox: () => host.querySelector<HTMLElement>('[role="listbox"]'),
    options: () => [...host.querySelectorAll<HTMLElement>('[role="option"]')],
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** The rows of the open list in document order, as a reader meets them. */
function rowSummary(listbox: Element): string[] {
  return [...listbox.querySelectorAll<HTMLElement>('.menu-label, [role="option"], .menu-sep, .ui-select-empty')]
    .map((row) => row.classList.contains("menu-label") ? `label:${row.textContent}`
      : row.classList.contains("menu-sep") ? "sep"
        : row.classList.contains("ui-select-empty") ? `empty:${row.textContent}`
          : `option:${ariaReferencedText(row, "aria-labelledby") || row.textContent}`);
}

/* ------------------------------------------------------------------------------------------------
 * Groups and the chosen check
 * ---------------------------------------------------------------------------------------------- */

test("a grouped combobox lists each group's label once, inside a group it names", () => {
  const view = mountCombobox();
  try {
    act(() => view.input.focus());
    const groups = [...view.listbox()!.querySelectorAll<HTMLElement>('[role="group"]')];
    assert.deepEqual(groups.map((group) => ariaReferencedText(group, "aria-labelledby")), ["Ready", "Needs Setup"]);
    assert.deepEqual(
      groups.map((group) => [...group.querySelectorAll('[role="option"]')].length),
      [3, 2],
      "each group holds its own consecutive options",
    );
    assert.deepEqual(
      [...view.listbox()!.querySelectorAll(".menu-label")].map((label) => label.textContent),
      ["Ready", "Needs Setup"],
      "each label shows once, as the caller's Title Case words",
    );

    type(view.input, "pay");
    assert.deepEqual(rowSummary(view.listbox()!), ["label:Ready", "option:Payments Agent"],
      "a group with no match loses its label");
    type(view.input, "sign in");
    assert.deepEqual(rowSummary(view.listbox()!), ["label:Needs Setup", "option:Pi"]);
    // Option ids still count the list shown, so the active descendant names the one result.
    assert.equal(view.input.getAttribute("aria-activedescendant"), view.options()[0]!.id);
  } finally {
    view.unmount();
  }
});

test("the combobox's chosen option shows a check while aria-selected follows the active option", () => {
  const view = mountCombobox();
  try {
    act(() => view.input.focus());
    const checked = () => view.options().map((option) => Boolean(option.querySelector("svg")));
    assert.deepEqual(checked(), [false, true, false, false, false], "only Codex, the value, has the check");
    assert.equal(view.options()[1]!.classList.contains("is-selected"), true);
    assert.deepEqual(view.options().map((option) => option.getAttribute("aria-selected")),
      ["false", "true", "false", "false", "false"], "opening highlights the chosen option");

    press(view.input, "ArrowDown");
    assert.deepEqual(view.options().map((option) => option.getAttribute("aria-selected")),
      ["false", "false", "true", "false", "false"], "aria-selected moves with the highlight");
    assert.equal(view.input.getAttribute("aria-activedescendant"), view.options()[2]!.id);
    assert.deepEqual(checked(), [false, true, false, false, false], "the check stays on the value");
    assert.equal(view.options()[2]!.classList.contains("is-active"), true);
    assert.equal(view.options()[2]!.classList.contains("is-selected"), false);
  } finally {
    view.unmount();
  }
});

test("a combobox with no value draws no check", () => {
  const view = mountCombobox({ value: null });
  try {
    act(() => view.input.focus());
    assert.equal(view.listbox()!.querySelectorAll(".is-selected").length, 0);
    assert.equal(view.listbox()!.querySelectorAll("svg").length, 0);
  } finally {
    view.unmount();
  }
});

/* ------------------------------------------------------------------------------------------------
 * The footer action row
 * ---------------------------------------------------------------------------------------------- */

function footerProbe(label = "Set Up Agents in Connections") {
  const runs: Array<{ activeElement: Element | null }> = [];
  const action: PickerFooterAction = {
    label,
    icon: <svg className="probe-footer-icon" />,
    onSelect: () => runs.push({ activeElement: document.activeElement }),
  };
  return { action, runs };
}

test("a combobox's footer action is the last row, after a separator, with and without a search", () => {
  const { action } = footerProbe();
  const view = mountCombobox({ footerAction: action });
  try {
    act(() => view.input.focus());
    assert.deepEqual(rowSummary(view.listbox()!).slice(-2), ["sep", "option:Set Up Agents in Connections"]);
    const footer = view.options().at(-1)!;
    assert.equal(footer.querySelector(".menu-icon")?.getAttribute("aria-hidden"), "true",
      "the leading icon is decoration; the label names the row");
    assert.ok(footer.querySelector(".menu-icon .probe-footer-icon"));
    assertNoDomNode(footer.querySelector("svg:not(.probe-footer-icon)"), "the footer action never draws a check");
    assert.equal(footer.textContent, "Set Up Agents in Connections");

    type(view.input, "codex");
    assert.deepEqual(rowSummary(view.listbox()!),
      ["label:Ready", "option:Codex", "sep", "option:Set Up Agents in Connections"]);

    type(view.input, "zzz");
    assert.match(view.listbox()!.textContent ?? "", /^No agents match “zzz”\./, "the no-match sentence still leads");
    assert.deepEqual(rowSummary(view.listbox()!), ["empty:No agents match “zzz”.", "sep", "option:Set Up Agents in Connections"]);
    assert.equal(view.input.hasAttribute("aria-activedescendant"), false,
      "a search that found nothing does not highlight the footer action for Enter");
    assert.equal(press(view.input, "Enter"), false);
    assert.equal(view.input.getAttribute("aria-expanded"), "true", "Enter on nothing runs nothing");
  } finally {
    view.unmount();
  }
});

test("Arrow Down from a combobox's last option reaches the footer action, and Enter runs it once after closing", () => {
  const { action, runs } = footerProbe();
  const view = mountCombobox({ footerAction: action });
  try {
    act(() => view.input.focus());
    press(view.input, "End");
    const footer = view.options().at(-1)!;
    assert.equal(view.input.getAttribute("aria-activedescendant"), footer.id, "End reaches the footer action");
    press(view.input, "Home");
    assert.equal(view.input.getAttribute("aria-activedescendant"), view.options()[0]!.id);
    press(view.input, "ArrowUp");
    assert.equal(view.input.getAttribute("aria-activedescendant"), footer.id, "Up from the first row wraps to it");
    for (let step = 0; step < 5; step += 1) press(view.input, "ArrowDown");
    assert.equal(view.input.getAttribute("aria-activedescendant"), view.options().at(-2)!.id,
      "the arrows walk every option, unavailable ones included");
    press(view.input, "ArrowDown");
    assert.equal(view.input.getAttribute("aria-activedescendant"), view.options().at(-1)!.id);
    assert.equal(view.options().at(-1)!.getAttribute("aria-selected"), "true");

    assert.equal(press(view.input, "Enter"), false);
    assert.equal(runs.length, 1, "onSelect runs once");
    assert.ok(runs[0]!.activeElement === view.input, "focus is on the field when the action runs");
    assert.equal(view.input.getAttribute("aria-expanded"), "false", "the list closed first");
    assert.deepEqual(view.chosen, [], "the footer action is never the chosen value");
    assert.equal(view.input.value, "Codex");
  } finally {
    view.unmount();
  }
});

test("the combobox scrolls a row the keyboard highlights into view, footer action included, but not a hovered one", () => {
  const revealed: string[] = [];
  const prototype = domWindow.HTMLElement.prototype as unknown as { scrollIntoView?: (options?: unknown) => void };
  const original = prototype.scrollIntoView;
  prototype.scrollIntoView = function (this: HTMLElement) { revealed.push(this.id); };
  const { action } = footerProbe();
  const view = mountCombobox({ footerAction: action });
  try {
    act(() => view.input.focus());
    assert.equal(revealed.at(-1), view.options()[1]!.id, "opening reveals the highlighted value");
    press(view.input, "End");
    const footer = view.options().at(-1)!;
    assert.equal(view.input.getAttribute("aria-activedescendant"), footer.id);
    assert.equal(revealed.at(-1), footer.id, "End reveals the footer action it highlights");
    press(view.input, "Home");
    assert.equal(revealed.at(-1), view.options()[0]!.id);

    const before = revealed.length;
    act(() => { view.options()[2]!.dispatchEvent(new domWindow.MouseEvent("mousemove", { bubbles: true }) as never); });
    assert.equal(view.input.getAttribute("aria-activedescendant"), view.options()[2]!.id, "the pointer moves the highlight");
    assert.equal(revealed.length, before, "but the list does not scroll under the pointer");
  } finally {
    view.unmount();
    prototype.scrollIntoView = original;
  }
});

test("a click on a combobox's footer action closes the list and runs it once", () => {
  const { action, runs } = footerProbe();
  const view = mountCombobox({ footerAction: action });
  try {
    act(() => view.input.focus());
    act(() => fireDomEvent.click(view.options().at(-1)!));
    assert.equal(runs.length, 1);
    assert.ok(runs[0]!.activeElement === view.input);
    assert.equal(view.input.getAttribute("aria-expanded"), "false");
  } finally {
    view.unmount();
  }
});

test("with a create row and a footer action, a failed search lists the create row first", () => {
  const { action, runs } = footerProbe("New Agent…");
  const created: string[] = [];
  const view = mountCombobox({
    footerAction: action,
    createOption: { label: "Create Agent…", onSelect: (query) => created.push(query) },
  });
  try {
    act(() => view.input.focus());
    type(view.input, "zzz");
    assert.deepEqual(rowSummary(view.listbox()!), ["empty:No agents match “zzz”.", "option:Create Agent…", "sep", "option:New Agent…"]);
    const [create, footer] = view.options();
    assert.equal(view.input.getAttribute("aria-activedescendant"), create!.id, "the create row is active");
    press(view.input, "ArrowDown");
    assert.equal(view.input.getAttribute("aria-activedescendant"), footer!.id);
    press(view.input, "Enter");
    assert.equal(runs.length, 1);
    assert.deepEqual(created, []);
  } finally {
    view.unmount();
  }
});

const PROJECTS = [
  { value: "alpha", label: "Alpha", description: "Local · ~/dev/alpha" },
  { value: "archived", label: "Archive", disabled: true, disabledReason: "Runner Offline" },
  { value: "beta", label: "Beta", description: "Remote · /srv/beta" },
] as const;

function mountSelect(searchable: boolean, footerAction: PickerFooterAction, createOption?: PickerCreateOption) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  const chosen: string[] = [];
  act(() => root.render(
    <Select
      label="Project"
      options={PROJECTS}
      value="alpha"
      onChange={(value) => chosen.push(value)}
      searchable={searchable}
      noun="projects"
      footerAction={footerAction}
      createOption={createOption}
    />,
  ));
  const trigger = host.querySelector<HTMLButtonElement>(".ui-select-trigger")!;
  return {
    host,
    trigger,
    chosen,
    /** Opens the list and returns what holds its keyboard: the filter, or the listbox itself. */
    open: () => {
      act(() => fireDomEvent.click(trigger));
      return searchable
        ? host.querySelector<HTMLInputElement>('input[role="combobox"]')!
        : host.querySelector<HTMLElement>('[role="listbox"]')!;
    },
    listbox: () => host.querySelector<HTMLElement>('[role="listbox"]')!,
    options: () => [...host.querySelectorAll<HTMLElement>('[role="option"]')],
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

for (const searchable of [false, true]) {
  const name = searchable ? "a searchable Select" : "a Select";

  test(`${name}'s footer action follows a separator as the list's last row`, () => {
    const { action } = footerProbe("New Project…");
    const view = mountSelect(searchable, action);
    try {
      view.open();
      assert.deepEqual(rowSummary(view.listbox()),
        ["option:Alpha", "option:Archive", "option:Beta", "sep", "option:New Project…"]);
      const footer = view.options().at(-1)!;
      assert.equal(footer.classList.contains("is-selected"), false);
      assert.equal(footer.querySelectorAll("svg").length, 1, "its icon, and no check");
    } finally {
      view.unmount();
    }
  });

  test(`Arrow Down from ${name}'s last option reaches the footer action; Enter returns focus to the trigger, then runs it once`, () => {
    const { action, runs } = footerProbe("New Project…");
    const view = mountSelect(searchable, action);
    try {
      const keys = view.open();
      const descendant = () => keys.getAttribute("aria-activedescendant");
      assert.equal(descendant(), view.options()[0]!.id);
      press(keys, "ArrowDown");
      assert.equal(descendant(), view.options()[1]!.id, "the unavailable option is reached, so its reason is heard (#2953)");
      press(keys, "ArrowDown");
      assert.equal(descendant(), view.options()[2]!.id);
      press(keys, "ArrowDown");
      assert.equal(descendant(), view.options()[3]!.id, "the next row is the footer action");
      press(keys, "ArrowDown");
      assert.equal(descendant(), view.options()[0]!.id, "and past it the list wraps");
      press(keys, "End");
      assert.equal(descendant(), view.options()[3]!.id, "End reaches it too");
      press(keys, "Home");
      assert.equal(descendant(), view.options()[0]!.id);
      press(keys, "End");

      assert.equal(press(keys, "Enter"), false);
      assert.equal(runs.length, 1, "onSelect runs once");
      assert.ok(runs[0]!.activeElement === view.trigger, "focus is back on the trigger when it runs");
      assert.equal(view.trigger.getAttribute("aria-expanded"), "false");
      assert.deepEqual(view.chosen, [], "it is never the chosen value");
    } finally {
      view.unmount();
    }
  });

  test(`${name} still announces one selected value while its footer action is highlighted`, () => {
    const { action } = footerProbe("New Project…");
    const view = mountSelect(searchable, action);
    try {
      const keys = view.open();
      press(keys, "End");
      const footer = view.options().at(-1)!;
      assert.equal(keys.getAttribute("aria-activedescendant"), footer.id, "the footer is highlighted");
      assert.equal(footer.getAttribute("aria-selected"), "false", "an action is never a selected value");
      assert.deepEqual(
        view.options().filter((option) => option.getAttribute("aria-selected") === "true")
          .map((option) => ariaReferencedText(option, "aria-labelledby")),
        ["Alpha"],
        "the single-select list keeps exactly one selected option, its value",
      );
    } finally {
      view.unmount();
    }
  });

  test(`a click on ${name}'s footer action closes the list and runs it once`, () => {
    const { action, runs } = footerProbe("New Project…");
    const view = mountSelect(searchable, action);
    try {
      view.open();
      act(() => fireDomEvent.click(view.options().at(-1)!));
      assert.equal(runs.length, 1);
      assert.ok(runs[0]!.activeElement === view.trigger);
      assert.equal(view.trigger.getAttribute("aria-expanded"), "false");
    } finally {
      view.unmount();
    }
  });
}

test("a searchable Select keeps its footer action under the filtered rows and after the no-match sentence", () => {
  const { action, runs } = footerProbe("New Project…");
  const created: string[] = [];
  const view = mountSelect(true, action, { label: "Create Project…", onSelect: (query) => created.push(query) });
  try {
    const filter = view.open() as HTMLInputElement;
    type(filter, "remote");
    assert.deepEqual(rowSummary(view.listbox()), ["option:Beta", "sep", "option:New Project…"]);
    type(filter, "wolipog");
    assert.match(view.listbox().textContent ?? "", /^No projects match “wolipog”\./);
    assert.deepEqual(rowSummary(view.listbox()), ["empty:No projects match “wolipog”.", "option:Create Project…", "sep", "option:New Project…"],
      "the create row comes before the footer action");
    assert.equal(filter.getAttribute("aria-activedescendant"), view.options()[0]!.id);
    press(filter, "ArrowDown");
    assert.equal(filter.getAttribute("aria-activedescendant"), view.options()[1]!.id);
    press(filter, "Enter");
    assert.equal(runs.length, 1);
    assert.deepEqual(created, []);
  } finally {
    view.unmount();
  }
});

test("a filter that found nothing without a create row highlights nothing, so Enter runs nothing", () => {
  const { action, runs } = footerProbe("New Project…");
  const view = mountSelect(true, action);
  try {
    const filter = view.open() as HTMLInputElement;
    type(filter, "wolipog");
    assert.equal(filter.hasAttribute("aria-activedescendant"), false);
    press(filter, "Enter");
    assert.equal(runs.length, 0);
    press(filter, "ArrowDown");
    assert.equal(filter.getAttribute("aria-activedescendant"), view.options()[0]!.id, "the arrows still reach it");
  } finally {
    view.unmount();
  }
});

/* ------------------------------------------------------------------------------------------------
 * openOnFocus={false}
 * ---------------------------------------------------------------------------------------------- */

test("with openOnFocus={false}, focus leaves the list closed and typing starts a filtered search", () => {
  const view = mountCombobox({ value: "claude", openOnFocus: false });
  try {
    act(() => view.input.focus());
    assert.equal(view.input.getAttribute("aria-expanded"), "false");
    assertNoDomNode(view.listbox(), "nothing floats over the form before anything is typed");
    assert.equal(view.input.selectionStart, "Claude Code".length, "the caret sits after the value");
    assert.equal(view.input.selectionEnd, "Claude Code".length);

    // The browser appends the first character after the label the caret follows.
    type(view.input, "Claude Codep");
    assert.equal(view.input.value, "p", "the first character typed is the first character of the query");
    assert.equal(view.input.getAttribute("aria-expanded"), "true");
    type(view.input, "pa");
    type(view.input, "pay");
    assert.equal(view.input.value, "pay");
    assert.deepEqual(rowSummary(view.listbox()!), ["label:Ready", "option:Payments Agent"]);
  } finally {
    view.unmount();
  }
});

test("with openOnFocus={false}, Arrow Down opens the list unfiltered", () => {
  const view = mountCombobox({ value: "claude", openOnFocus: false });
  try {
    act(() => view.input.focus());
    press(view.input, "ArrowDown");
    assert.equal(view.input.getAttribute("aria-expanded"), "true");
    assert.equal(view.options().length, AGENTS.length, "every option, no filter");
    assert.equal(view.input.value, "Claude Code");
    assert.equal(view.input.getAttribute("aria-activedescendant"), view.options()[0]!.id, "on the chosen option");
  } finally {
    view.unmount();
  }
});

test("with openOnFocus={false}, Alt+Arrow Down, a click in the field and the chevron open the list", () => {
  const view = mountCombobox({ value: "claude", openOnFocus: false });
  try {
    act(() => view.input.focus());
    assert.equal(press(view.input, "ArrowDown", { altKey: true }), false);
    assert.equal(view.input.getAttribute("aria-expanded"), "true");
    assert.equal(view.options().length, AGENTS.length);
    press(view.input, "Escape");
    assert.equal(view.input.getAttribute("aria-expanded"), "false");

    act(() => fireDomEvent.click(view.input));
    assert.equal(view.input.getAttribute("aria-expanded"), "true", "a click in the field opens it");
    press(view.input, "Escape");

    act(() => view.input.blur());
    const chevron = view.host.querySelector<HTMLElement>(".ui-picker-chevron")!;
    act(() => fireDomEvent.click(chevron));
    assert.equal(view.input.getAttribute("aria-expanded"), "true", "the chevron opens it from an unfocused field");
    assert.ok(document.activeElement === view.input, "and focuses the field");
  } finally {
    view.unmount();
  }
});

test("by default focus still opens the list, and typing still edits from the shown label", () => {
  const view = mountCombobox({ value: "claude" });
  try {
    act(() => view.input.focus());
    assert.equal(view.input.getAttribute("aria-expanded"), "true", "openOnFocus defaults to today's behaviour");
    type(view.input, "Claude Codex");
    assert.equal(view.input.value, "Claude Codex");
  } finally {
    view.unmount();
  }
});

/* ------------------------------------------------------------------------------------------------
 * #2952: a separated option, a closed field that says more than the label, and an invalid combobox
 * ---------------------------------------------------------------------------------------------- */

const DOCS: readonly SearchableComboboxOption<string>[] = [
  { value: "docs-1", label: "Docs Site", description: "Studio Mac · 1 location", selectedLabel: "Docs Site · Studio Mac" },
  { value: "docs-2", label: "Docs Site", description: "Build Server · 2 locations", selectedLabel: "Docs Site · Build Server" },
  { value: "none", label: "No Project", description: "Run in any folder.", separator: true },
];

test("a separated option follows a separator, which a search drops while it leads the list", () => {
  const view = mountCombobox({ options: DOCS, value: null, footerAction: { label: "New Project…", onSelect: () => {} } });
  try {
    act(() => fireDomEvent.click(view.input));
    assert.deepEqual(rowSummary(view.listbox()!), [
      "option:Docs Site", "option:Docs Site", "sep", "option:No Project", "sep", "option:New Project…",
    ]);
    type(view.input, "no");
    assert.deepEqual(rowSummary(view.listbox()!), ["option:No Project", "sep", "option:New Project…"],
      "a separator never leads the list");
  } finally {
    view.unmount();
  }
});

test("the closed field shows the chosen option's selected label, and a typed search starts after it", () => {
  const view = mountCombobox({ options: DOCS, value: "docs-2", openOnFocus: false });
  try {
    assert.equal(view.input.value, "Docs Site · Build Server");
    act(() => view.input.focus());
    type(view.input, "Docs Site · Build Serverj");
    assert.deepEqual(view.options().map((option) => ariaReferencedText(option, "aria-labelledby")), ["No Project"],
      "the first character typed after the shown value starts the query");
    press(view.input, "Escape");
    assert.equal(view.input.value, "Docs Site · Build Server");
    act(() => fireDomEvent.click(view.input));
    assert.deepEqual(view.options().map((option) => ariaReferencedText(option, "aria-labelledby")),
      ["Docs Site", "Docs Site", "No Project"], "the list still shows each label alone");
  } finally {
    view.unmount();
  }
});

test("an invalid combobox carries aria-invalid, and Select's trigger shows the selected label", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  try {
    act(() => root.render(<>
      <SearchableCombobox label="Project" options={DOCS} value="docs-1" onChange={() => {}} invalid describedBy="project-error" />
      <Select label="Location" options={DOCS} value="docs-1" onChange={() => {}} />
    </>));
    const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(input.getAttribute("aria-describedby"), "project-error");
    const trigger = host.querySelector<HTMLButtonElement>(".ui-select-trigger")!;
    assert.equal(trigger.getAttribute("aria-label"), "Location: Docs Site · Studio Mac");
    assert.equal(trigger.querySelector(".ui-select-value")?.textContent, "Docs Site · Studio Mac");
    act(() => fireDomEvent.click(trigger));
    assert.deepEqual(rowSummary(host.querySelector('[role="listbox"]')!),
      ["option:Docs Site", "option:Docs Site", "sep", "option:No Project"]);
    act(() => root.render(
      <SearchableCombobox label="Project" options={DOCS} value="docs-1" onChange={() => {}} />,
    ));
    assert.equal(host.querySelector('[role="combobox"]')?.getAttribute("aria-invalid"), null);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
