import assert from "node:assert/strict";
import test from "node:test";
import "../test-dom-events.js";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { fireDomEvent } from "../test-dom-events.js";
import { ariaReferencedText, assertNoDomNode } from "../../dom-test-assertions.js";
import { InlineListbox, SearchableCombobox, Select, type PickerCreateOption } from "./ChoiceControls.js";

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

const OPTIONS = [
  { value: "alpha", label: "Dashboard", description: "Local · ~/dev/alpha" },
  {
    value: "review",
    label: "Review Agent",
    description: "Advanced Agent",
    disabled: true,
    disabledReason: "Setup Required",
  },
  { value: "beta", label: "Dashboard", description: "Remote · /srv/beta" },
  { value: "legacy", label: "Legacy Agent", disabled: true, disabledReason: "Runner Too Old" },
] as const;

function mount(
  onChange: (value: string) => void = () => undefined,
  disabled = false,
  extra: { noun?: string; createOption?: PickerCreateOption; leadingIcon?: React.ReactNode } = {},
) {
  const host = document.createElement("div");
  const after = document.createElement("button");
  after.textContent = "After";
  document.body.append(host, after);
  const root = createRoot(host as unknown as Element);
  const bubbledKeys: string[] = [];
  act(() => root.render(
    <div onKeyDown={(event) => bubbledKeys.push(event.key)}>
      <SearchableCombobox
        label="Agent"
        options={OPTIONS}
        value="alpha"
        onChange={onChange}
        placeholder="Choose an Agent"
        disabled={disabled}
        {...extra}
      />
    </div>,
  ));
  return {
    host,
    after,
    input: host.querySelector<HTMLInputElement>('[role="combobox"]')!,
    bubbledKeys,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
      after.remove();
    },
  };
}

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

test("typing filters the InlineListbox and exposes the active option", () => {
  const { host, input, unmount } = mount();
  try {
    act(() => input.focus());
    assert.equal(input.getAttribute("aria-expanded"), "true");
    const popup = host.querySelector<HTMLElement>('[role="listbox"]')!;
    assert.ok(popup, "the popup uses the shared listbox primitive");
    assert.equal(popup.style.position, "fixed", "the anchored placement reaches InlineListbox");
    assert.notEqual(popup.style.maxHeight, "", "the line-count height budget reaches the popup");
    assert.notEqual(popup.style.width, "", "the popup is sized from its input anchor");

    type(input, "remote beta");
    const results = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(results.length, 1);
    assert.match(results[0]?.textContent ?? "", /Remote · \/srv\/beta/);
    assert.equal(input.getAttribute("aria-activedescendant"), results[0]?.id);
    assert.equal(results[0]?.getAttribute("aria-selected"), "true");
  } finally {
    unmount();
  }
});

test("Home and End use the same enabled boundaries as Select", () => {
  const { host, input, unmount } = mount();
  try {
    act(() => input.focus());
    press(input, "End");
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(input.getAttribute("aria-activedescendant"), options[2]?.id,
      "End skips the trailing unavailable result while arrows can still inspect it");
    press(input, "Home");
    assert.equal(input.getAttribute("aria-activedescendant"), options[0]?.id);
  } finally {
    unmount();
  }
});

test("arrows inspect unavailable options, while Enter only commits an available option", () => {
  const chosen: string[] = [];
  const { host, input, unmount } = mount((value) => chosen.push(value));
  try {
    act(() => input.focus());
    press(input, "ArrowDown");
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(input.getAttribute("aria-activedescendant"), options[1]?.id);
    assert.equal(options[1]?.getAttribute("aria-disabled"), "true");
    assert.match(options[1]?.textContent ?? "", /Setup Required/);

    assert.equal(press(input, "Enter"), false, "an open popup owns Enter");
    assert.deepEqual(chosen, [], "an unavailable option cannot be committed");
    assert.equal(input.getAttribute("aria-expanded"), "true", "its explanation stays open");

    press(input, "ArrowDown");
    press(input, "Enter");
    assert.deepEqual(chosen, ["beta"]);
    assert.equal(input.value, "Dashboard");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement === input, true, "selection keeps focus on the combobox");
  } finally {
    unmount();
  }
});

test("Escape closes one layer, and Tab closes without taking over traversal", () => {
  const { input, bubbledKeys, unmount } = mount();
  try {
    act(() => input.focus());
    type(input, "remote");
    assert.equal(press(input, "Escape"), false);
    assert.deepEqual(bubbledKeys, [], "Escape must not reach the dialog while the popup is open");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(input.value, "Dashboard", "dismissal restores the committed label");
    assert.equal(press(input, "Enter"), true, "closed Enter belongs to the enclosing form");
    assert.deepEqual(bubbledKeys, ["Enter"]);

    act(() => { input.blur(); input.focus(); });
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(press(input, "Tab"), true, "native Tab traversal must remain available");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.deepEqual(bubbledKeys, ["Enter", "Tab"]);

    act(() => { input.blur(); input.focus(); });
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(press(input, "Tab", { shiftKey: true }), true,
      "native reverse traversal must remain available");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.deepEqual(bubbledKeys, ["Enter", "Tab", "Tab"]);
  } finally {
    unmount();
  }
});

test("an empty search keeps Enter inside the popup without inventing a choice", () => {
  const chosen: string[] = [];
  const { host, input, unmount } = mount((value) => chosen.push(value));
  try {
    act(() => input.focus());
    type(input, "no such agent");
    assert.equal(host.querySelectorAll('[role="option"]').length, 0);
    assert.equal(host.querySelector('[role="listbox"]')?.textContent, "No options match “no such agent”.",
      "the no-match row is a sentence naming the search (§12.2), not a Title Case label");
    assert.equal(input.hasAttribute("aria-activedescendant"), false);
    assert.equal(press(input, "Enter"), false, "open autocomplete Enter must not submit its form");
    assert.deepEqual(chosen, []);
    assert.equal(input.getAttribute("aria-expanded"), "true");
  } finally {
    unmount();
  }
});

test("pointer activation uses InlineListbox selection and keeps focus on the owner", () => {
  const chosen: string[] = [];
  const { host, input, unmount } = mount((value) => chosen.push(value));
  try {
    act(() => input.focus());
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    act(() => fireDomEvent.click(options[1]!));
    assert.deepEqual(chosen, [], "pointer activation also refuses an unavailable option");
    assert.equal(input.getAttribute("aria-expanded"), "true");

    act(() => fireDomEvent.click(options[2]!));
    assert.deepEqual(chosen, ["beta"]);
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement === input, true);
  } finally {
    unmount();
  }
});

test("IME Enter neither selects an option nor closes the popup", () => {
  const chosen: string[] = [];
  const { input, unmount } = mount((value) => chosen.push(value));
  try {
    act(() => input.focus());
    assert.equal(press(input, "Enter", { isComposing: true }), true,
      "the browser or IME keeps ownership of composed Enter");
    assert.deepEqual(chosen, []);
    assert.equal(input.getAttribute("aria-expanded"), "true");
  } finally {
    unmount();
  }
});

test("a disabled combobox stays readable without accepting edits", () => {
  const chosen: string[] = [];
  const { input, unmount } = mount((value) => chosen.push(value), true);
  try {
    assert.equal(input.readOnly, true, "native read-only behavior refuses text edits without eating them");
    assert.equal(input.getAttribute("aria-disabled"), "true");
    act(() => input.focus());
    assert.equal(input.getAttribute("aria-expanded"), "false");
    type(input, "changed");
    assert.equal(input.value, "Dashboard");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.deepEqual(chosen, []);
  } finally {
    unmount();
  }
});

test("a closed combobox shows a chevron that opens the list and closes it again", () => {
  const { host, input, unmount } = mount();
  try {
    const chevron = host.querySelector<HTMLElement>(".ui-picker-chevron");
    assert.ok(chevron?.querySelector(".ui-select-caret"), "the closed field draws Select's chevron");
    assert.equal(chevron?.getAttribute("aria-hidden"), "true", "the combobox itself is the announced control");
    assert.equal(input.getAttribute("aria-expanded"), "false");

    act(() => fireDomEvent.click(chevron!));
    assert.equal(input.getAttribute("aria-expanded"), "true", "the first click opens the list");
    assert.equal(document.activeElement === input, true, "opening from the chevron focuses the field");

    act(() => fireDomEvent.click(chevron!));
    assert.equal(input.getAttribute("aria-expanded"), "false", "the second click closes it");
    assert.equal(document.activeElement === input, true, "closing leaves focus and the caret in the field");

    let pressAllowed = true;
    act(() => {
      pressAllowed = chevron!.dispatchEvent(new domWindow.MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      }) as never);
    });
    assert.equal(pressAllowed, false, "pressing the chevron never takes focus from the field");
  } finally {
    unmount();
  }
});

test("focus opens the list with the caret after the value instead of selecting it", () => {
  const { host, input, unmount } = mount();
  try {
    act(() => input.focus());
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(input.selectionStart, input.selectionEnd, "no text is selected");
    assert.equal(input.selectionEnd, "Dashboard".length, "the caret sits after the value");

    type(input, "remote beta");
    assert.equal(host.querySelectorAll('[role="option"]').length, 1, "typing still filters");
  } finally {
    unmount();
  }
});

test("a leading icon renders inside the field, before the value, hidden from assistive technology", () => {
  const { host, input, unmount } = mount(undefined, false, {
    leadingIcon: <svg className="probe-icon" />,
  });
  try {
    const root = host.querySelector(".ui-searchable-combobox")!;
    assert.ok(root.classList.contains("has-leading-icon"), "the field indents its text past the icon");
    const slot = root.querySelector(".ui-picker-leading-icon")!;
    assert.ok(slot.querySelector(".probe-icon"));
    assert.equal(slot.getAttribute("aria-hidden"), "true");
    assert.equal(slot.nextElementSibling === input, true, "the icon leads the field it sits inside");
  } finally {
    unmount();
  }
});

test("a search with no results names the caller's noun and offers the create row", () => {
  const created: string[] = [];
  const chosen: string[] = [];
  const { host, input, unmount } = mount((value) => chosen.push(value), false, {
    noun: "agents",
    createOption: { label: "Create Agent…", onSelect: (query) => created.push(query) },
  });
  try {
    act(() => input.focus());
    assertNoDomNode(host.querySelector('[role="option"][id$="-create"]'),
      "the create row follows a failed search, not every list");

    type(input, "  zzz ");
    const listbox = host.querySelector<HTMLElement>('[role="listbox"]')!;
    assert.match(listbox.textContent ?? "", /^No agents match “zzz”\./);
    const create = listbox.querySelector<HTMLElement>('[role="option"]')!;
    assert.equal(create.textContent, "Create Agent…");
    assert.equal(input.getAttribute("aria-activedescendant"), create.id, "the only row is the active one");

    assert.equal(press(input, "Enter"), false);
    assert.deepEqual(created, ["zzz"], "the create row receives the trimmed query");
    assert.deepEqual(chosen, []);
    assert.equal(input.getAttribute("aria-expanded"), "false");
  } finally {
    unmount();
  }
});

/* ------------------------------------------------------------------------------------------------
 * A searchable Select: the touch form of the combobox
 * ---------------------------------------------------------------------------------------------- */

const PROJECTS = [
  { value: "alpha", label: "Alpha", description: "Local · ~/dev/alpha" },
  { value: "archived", label: "Archive", disabled: true, disabledReason: "Runner Offline" },
  { value: "beta", label: "Beta", description: "Remote · /srv/beta" },
] as const;

function mountSelect(extra: {
  createOption?: PickerCreateOption;
  leadingIcon?: React.ReactNode;
  onChange?: (value: string) => void;
} = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  const bubbledKeys: string[] = [];
  act(() => root.render(
    <div onKeyDown={(event) => bubbledKeys.push(event.key)}>
      <Select
        label="Project"
        options={PROJECTS}
        value="alpha"
        onChange={extra.onChange ?? (() => undefined)}
        searchable
        noun="projects"
        createOption={extra.createOption}
        leadingIcon={extra.leadingIcon}
      />
    </div>,
  ));
  const trigger = host.querySelector<HTMLButtonElement>(".ui-select-trigger")!;
  return {
    host,
    trigger,
    bubbledKeys,
    open: () => {
      act(() => fireDomEvent.click(trigger));
      return host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    },
    options: () => [...host.querySelectorAll<HTMLElement>('[role="option"]')],
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("a searchable Select opens with its filter focused at the top of the list", () => {
  const { host, trigger, open, unmount } = mountSelect();
  try {
    const filter = open();
    assert.ok(filter, "the open list leads with a filter field");
    assert.equal(document.activeElement === filter, true, "focused in the gesture that opened it");
    assert.equal(filter.getAttribute("aria-label"), "Search Project Options");
    const panel = host.querySelector<HTMLElement>(".menu.listbox")!;
    assert.equal(panel.firstElementChild?.contains(filter), true, "the filter comes before every option");
    const listbox = host.querySelector<HTMLElement>('[role="listbox"]')!;
    assert.equal(filter.getAttribute("aria-controls"), listbox.id);
    assert.equal(trigger.getAttribute("aria-controls"), listbox.id, "the trigger still names the listbox it opens");
  } finally {
    unmount();
  }
});

test("typing in a searchable Select's filter narrows the options and Enter commits the active one", () => {
  const chosen: string[] = [];
  const { trigger, open, options, unmount } = mountSelect({ onChange: (value) => chosen.push(value) });
  try {
    const filter = open();
    assert.equal(options().length, 3);
    type(filter, "remote");
    assert.deepEqual(options().map((option) => option.textContent?.startsWith("Beta")), [true]);
    assert.equal(filter.getAttribute("aria-activedescendant"), options()[0]!.id);

    assert.equal(press(filter, " "), true, "Space is the filter's text, not a commit");
    assert.deepEqual(chosen, []);
    assert.equal(press(filter, "Enter"), false);
    assert.deepEqual(chosen, ["beta"]);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  } finally {
    unmount();
  }
});

test("a searchable Select's arrows skip unavailable options, as the plain list's do", () => {
  const { open, options, unmount } = mountSelect();
  try {
    const filter = open();
    assert.equal(filter.getAttribute("aria-activedescendant"), options()[0]!.id);
    press(filter, "ArrowDown");
    assert.equal(filter.getAttribute("aria-activedescendant"), options()[2]!.id);
    press(filter, "Home");
    assert.equal(filter.getAttribute("aria-activedescendant"), options()[0]!.id);
    press(filter, "End");
    assert.equal(filter.getAttribute("aria-activedescendant"), options()[2]!.id);
  } finally {
    unmount();
  }
});

test("a searchable Select shows the no-match sentence and its create row", () => {
  const created: string[] = [];
  const chosen: string[] = [];
  const { host, open, options, unmount } = mountSelect({
    onChange: (value) => chosen.push(value),
    createOption: { label: "Create Project…", onSelect: (query) => created.push(query) },
  });
  try {
    const filter = open();
    type(filter, "wolipog");
    const listbox = host.querySelector<HTMLElement>('[role="listbox"]')!;
    assert.match(listbox.textContent ?? "", /^No projects match “wolipog”\./);
    assert.deepEqual(options().map((option) => option.textContent), ["Create Project…"]);
    assert.equal(filter.getAttribute("aria-activedescendant"), options()[0]!.id);
    press(filter, "Enter");
    assert.deepEqual(created, ["wolipog"]);
    assert.deepEqual(chosen, []);
  } finally {
    unmount();
  }
});

test("Escape closes a searchable Select's list without reaching the dialog, and reopening clears the filter", () => {
  const { trigger, bubbledKeys, open, options, unmount } = mountSelect();
  try {
    const filter = open();
    type(filter, "beta");
    assert.equal(press(filter, "Escape"), false);
    assert.deepEqual(bubbledKeys.filter((key) => key === "Escape"), []);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    const reopened = open();
    assert.equal(reopened.value, "");
    assert.equal(options().length, 3);
  } finally {
    unmount();
  }
});

test("an IME's own keys in a searchable Select's filter neither commit nor close the list", () => {
  const chosen: string[] = [];
  const { trigger, bubbledKeys, open, unmount } = mountSelect({ onChange: (value) => chosen.push(value) });
  try {
    const filter = open();
    type(filter, "beta");
    // Escape dismissing a candidate list, and Enter accepting one, belong to the input method.
    assert.equal(press(filter, "Escape", { isComposing: true }), true);
    assert.equal(press(filter, "Enter", { isComposing: true }), true);
    assert.equal(trigger.getAttribute("aria-expanded"), "true", "the list stays open");
    assert.equal(document.activeElement === filter, true, "focus stays in the filter");
    assert.deepEqual(chosen, []);
    assert.deepEqual(bubbledKeys, ["Escape", "Enter"], "the keys stay the browser's and the IME's");
  } finally {
    unmount();
  }
});

test("a Select's leading icon renders inside its trigger, before the value", () => {
  const { trigger, unmount } = mountSelect({ leadingIcon: <svg className="probe-icon" /> });
  try {
    const slot = trigger.querySelector(".ui-picker-leading-icon")!;
    assert.ok(slot.querySelector(".probe-icon"));
    assert.equal(slot.getAttribute("aria-hidden"), "true");
    assert.equal(slot.nextElementSibling?.classList.contains("ui-select-value"), true);
    assert.equal(trigger.getAttribute("aria-label"), "Project: Alpha", "the icon adds nothing to the name");
  } finally {
    unmount();
  }
});

/* ------------------------------------------------------------------------------------------------
 * An option's name and description (#2285 for Select, #2369 for SearchableCombobox)
 * ---------------------------------------------------------------------------------------------- */

/** OPTIONS rendered in a list: each is named by its label alone and described by its second lines. */
function assertOptionsNamedByLabel(container: Element) {
  const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
  // The name is exactly the label: a screen reader's first-letter navigation, which matches the
  // name, reaches "Review Agent" with R rather than through its description.
  assert.deepEqual(options.map((option) => ariaReferencedText(option, "aria-labelledby")),
    ["Dashboard", "Review Agent", "Dashboard", "Legacy Agent"]);
  assert.deepEqual(options.map((option) => option.getAttribute("aria-label")), [null, null, null, null]);
  // The description, then any disabled reason, is the option's accessible description.
  assert.deepEqual(options.map((option) => ariaReferencedText(option, "aria-describedby")), [
    "Local · ~/dev/alpha",
    "Advanced Agent Setup Required",
    "Remote · /srv/beta",
    "Runner Too Old",
  ]);
  // Both still render inside the option, where a sighted user reads them.
  assert.ok(options[1]!.contains(document.getElementById(options[1]!.getAttribute("aria-describedby")!.split(" ")[1]!)));
  // Ids are unique per option, so two options with the same label keep their own descriptions.
  const ids = options.flatMap((option) => [
    option.getAttribute("aria-labelledby"),
    ...(option.getAttribute("aria-describedby")?.split(" ") ?? []),
  ]);
  assert.equal(new Set(ids).size, ids.length);
}

for (const searchable of [false, true]) {
  test(`a${searchable ? " searchable" : ""} Select option is named by its label and described by its second lines`, () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host as unknown as Element);
    act(() => root.render(
      <Select
        label="Agent"
        options={OPTIONS}
        value="alpha"
        onChange={() => undefined}
        searchable={searchable}
      />,
    ));
    try {
      act(() => fireDomEvent.click(host.querySelector(".ui-select-trigger")!));
      assertOptionsNamedByLabel(host);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
}

test("a SearchableCombobox option is named by its label and described by its second lines", () => {
  const view = mount();
  try {
    act(() => view.input.focus());
    assertOptionsNamedByLabel(view.host);
    // A search keeps the pairing: the one result is still named and described by its own lines.
    type(view.input, "runner too old");
    const [legacy, ...rest] = [...view.host.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(rest.length, 0);
    assert.equal(ariaReferencedText(legacy!, "aria-labelledby"), "Legacy Agent");
    assert.equal(ariaReferencedText(legacy!, "aria-describedby"), "Runner Too Old");
    assert.equal(view.input.getAttribute("aria-activedescendant"), legacy!.id);
  } finally {
    view.unmount();
  }
});

test("an available SearchableCombobox option keeps its disabledReason out of its description", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  act(() => root.render(
    <SearchableCombobox
      label="Agent"
      options={[{ value: "ready", label: "Ready Agent", description: "Local", disabledReason: "Stale Reason" }]}
      value={null}
      onChange={() => undefined}
    />,
  ));
  try {
    act(() => host.querySelector<HTMLInputElement>('[role="combobox"]')!.focus());
    const option = host.querySelector<HTMLElement>('[role="option"]')!;
    assert.equal(ariaReferencedText(option, "aria-labelledby"), "Ready Agent");
    assert.equal(ariaReferencedText(option, "aria-describedby"), "Local");
    assert.doesNotMatch(option.textContent ?? "", /Stale Reason/);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

test("an InlineListbox option rendered whole is named by its content, with no description", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  act(() => root.render(
    <InlineListbox
      id="paths"
      label="Workspace Paths"
      options={["src/session.ts"]}
      activeIndex={0}
      getKey={(path) => path}
      onSelect={() => undefined}
      renderOption={(path) => <><span aria-hidden="true">📄</span><span>{path}</span></>}
    />,
  ));
  try {
    const option = host.querySelector<HTMLElement>('[role="option"]')!;
    assert.equal(option.getAttribute("aria-labelledby"), null);
    assert.equal(option.getAttribute("aria-describedby"), null);
    assert.equal(option.textContent, "📄src/session.ts");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
