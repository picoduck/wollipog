import "./test-dom-events.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { FieldError } from "./FieldError.js";
import { FieldWarning } from "./FieldWarning.js";
import { FilterButton } from "./FilterButton.js";
import { ListFoot } from "./ListFoot.js";
import { OneLineCodeWell } from "./OneLineCodeWell.js";
import { SaveBar } from "./SaveBar.js";
import { StaleContent } from "./StaleContent.js";
import { Steps } from "./Steps.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

/*
 * The shared components that carry the promoted classes of docs/design-system.md §19.4 before any
 * screen uses them. Each test pins the class the stylesheet styles and the behavior the section
 * describes, so the first area to adopt one gets the documented recipe.
 */

const domWindow = new Window({ url: "http://localhost/" });
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of previous) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

async function render(element: ReactElement) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    rerender: (next: ReactElement) => act(async () => root.render(next)),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const sheet = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
/** The declarations of the one top-level rule written exactly as `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
  assert.ok(match, `${selector} must be styled`);
  return match[1]!;
}

test("StaleContent dims last-known content without hiding it (§12.5)", async () => {
  const view = await render(<StaleContent stale><button type="button">Open Session</button></StaleContent>);
  try {
    const wrapper = view.container.firstElementChild!;
    assert.equal(wrapper.className, "is-stale");
    assert.equal(wrapper.getAttribute("aria-hidden"), null, "stale content stays readable");
    assert.equal(wrapper.hasAttribute("inert"), false, "and operable");
    // Token dimming, never subtree opacity (light-theme-lock.test.ts).
    assert.match(rule(".is-stale"), /--text:\s*var\(--text-dim\);/);
    assert.doesNotMatch(rule(".is-stale"), /opacity/);
    await view.rerender(<StaleContent stale={false}><button type="button">Open Session</button></StaleContent>);
    assertNoDomNode(view.container.querySelector(".is-stale"), "live content is not dimmed");
  } finally {
    await view.unmount();
  }
});

test("FieldWarning is a helper-colored line with a warning icon, addressable by the field (§8.5)", async () => {
  const view = await render(<FieldWarning id="branch-warning">This branch already has a worktree.</FieldWarning>);
  try {
    const warning = view.container.querySelector<HTMLElement>(".field-warn")!;
    const words = view.container.querySelector<HTMLElement>('[id="branch-warning"]');
    assert.ok(words && warning.contains(words), "a field can point aria-describedby at it");
    assert.equal(words.textContent, "This branch already has a worktree.");
    assert.equal(warning.textContent, "This branch already has a worktree.");
    assert.ok(warning.querySelector(".field-warn-icon"), "the icon carries the tone");
    assert.equal(warning.getAttribute("role"), null, "a warning is not an alert");
    assert.match(rule(".field-warn"), /color:\s*var\(--text-dim\);/);
    assert.match(rule(".field-warn-icon"), /color:\s*var\(--amber\);/);
  } finally {
    await view.unmount();
  }
});

test("FieldWarning's action follows its words without joining the description the field points at (#2953)", async () => {
  const view = await render(
    <FieldWarning id="agent-warning" action={<button type="button" className="btn sm">Use Codex App Server</button>}>
      Your saved default is no longer supported.
    </FieldWarning>,
  );
  try {
    const warning = view.container.querySelector<HTMLElement>(".field-warn")!;
    assert.equal(view.container.querySelector('[id="agent-warning"]')?.textContent, "Your saved default is no longer supported.");
    assert.equal(warning.querySelector("button.btn.sm")?.textContent, "Use Codex App Server");
  } finally {
    await view.unmount();
  }
});

/** The dark theme's value of a token, as the shared `:root` block declares it. */
function rootToken(name: string): string {
  const root = /\n:root,\n:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(root, "the shared token block must exist");
  const value = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(root[1]!)?.[1];
  assert.ok(value, `${name} must be a token`);
  return value.trim();
}

/** What a screen reader announces as the description: the texts `aria-describedby` names, in order. */
function accessibleDescription(element: Element): string {
  return (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean).join(" ");
}

test("FieldError is a danger-colored line with an error icon, addressable by the field and never an alert (§8.5)", async () => {
  // The real rule and the real token, so the computed color proves the declaration resolves.
  const style = domWindow.document.createElement("style");
  style.textContent = `:root { --danger-text: ${rootToken("--danger-text")}; }\n.field-error {${rule(".field-error")}}`;
  domWindow.document.head.append(style);
  const view = await render(<FieldError id="name-error">Use lowercase letters, digits, dots or dashes.</FieldError>);
  try {
    const error = view.container.querySelector<HTMLElement>(".field-error")!;
    assert.equal(error.tagName, "P");
    assert.equal(error.id, "name-error", "a field can point aria-describedby at it");
    assert.equal(error.getAttribute("role"), null, "focus on the invalid field announces it, so it is not an alert");
    assert.equal(error.getAttribute("aria-live"), null);
    const icon = error.querySelector("svg.field-error-icon")!;
    assert.equal(icon.getAttribute("width"), "14");
    assert.equal(icon.getAttribute("height"), "14");
    assert.equal(icon.getAttribute("aria-hidden"), "true", "the words carry the meaning");
    assert.equal(error.querySelector(":scope > span")?.textContent, "Use lowercase letters, digits, dots or dashes.");
    assert.equal(error.textContent, "Use lowercase letters, digits, dots or dashes.");
    assert.equal(domWindow.getComputedStyle(error as never).color, rootToken("--danger-text"));
    assert.match(rule(".field-error"), /color:\s*var\(--danger-text\);/);
    assert.doesNotMatch(rule(".field-error-icon"), /(^|[;\s])color:/, "the icon inherits the words' colour");
  } finally {
    await view.unmount();
    style.remove();
  }
});

test("an invalid field is described by its error, which replaces its helper (§8.5)", async () => {
  function NameField({ error }: { error?: string }) {
    return (
      <label className="field">
        <span>Name</span>
        <input aria-invalid={error ? true : undefined} aria-describedby={error ? "name-error" : "name-helper"} />
        {error ? <FieldError id="name-error">{error}</FieldError> : <p className="field-helper" id="name-helper">Shown in the session list.</p>}
      </label>
    );
  }
  const view = await render(<NameField />);
  try {
    const input = () => view.container.querySelector("input")!;
    assert.equal(input().getAttribute("aria-invalid"), null);
    assert.equal(accessibleDescription(input()), "Shown in the session list.");

    await view.rerender(<NameField error="Enter a name of 64 characters or fewer." />);
    assert.equal(input().getAttribute("aria-invalid"), "true");
    assert.equal(accessibleDescription(input()), "Enter a name of 64 characters or fewer.");
    assertNoDomNode(view.container.querySelector("#name-helper"), "the error replaces the helper");
    assert.equal(view.container.querySelectorAll(".field-error").length, 1);
  } finally {
    await view.unmount();
  }
});

test("ListFoot sets its entry off from the list's rows (§5.6)", async () => {
  const view = await render(<ListFoot><button type="button">Orphaned Copies</button></ListFoot>);
  try {
    const foot = view.container.querySelector(".list-foot");
    assert.equal(foot?.textContent, "Orphaned Copies");
    const declarations = rule(".list-foot");
    assert.match(declarations, /border-top:\s*1px solid var\(--border\);/);
    assert.match(declarations, /min-height:\s*var\(--row-h\);/);
  } finally {
    await view.unmount();
  }
});

test("SaveBar shows only while there is something to save, and a failed save offers Try Again (§8.6)", async () => {
  const actions: string[] = [];
  const bar = (props: { dirty: boolean; busy?: boolean; error?: string | null }) => (
    <SaveBar {...props} onDiscard={() => actions.push("discard")} onSave={() => actions.push("save")} />
  );
  const view = await render(bar({ dirty: false }));
  try {
    assertNoDomNode(view.container.querySelector(".save-bar"), "a clean editor has no bar");

    await view.rerender(bar({ dirty: true }));
    const dirty = view.container.querySelector<HTMLElement>(".save-bar")!;
    assert.equal(dirty.classList.contains("is-error"), false);
    assert.equal(dirty.querySelector(".save-bar-message")?.textContent, "Unsaved changes");
    const buttons = () => [...view.container.querySelectorAll<HTMLButtonElement>(".save-bar button")];
    assert.deepEqual(buttons().map((button) => button.textContent), ["Discard", "Save"]);
    await act(async () => { buttons()[0]!.click(); buttons()[1]!.click(); });
    assert.deepEqual(actions, ["discard", "save"]);

    await view.rerender(bar({ dirty: true, error: "The defaults could not be saved." }));
    const failed = view.container.querySelector<HTMLElement>(".save-bar")!;
    assert.equal(failed.classList.contains("is-error"), true);
    assert.equal(failed.getAttribute("role"), "alert");
    assert.ok(failed.querySelector(".save-bar-icon"));
    assert.deepEqual(buttons().map((button) => button.textContent), ["Discard", "Try Again"]);

    assert.match(rule(".save-bar"), /position:\s*sticky;/);
    assert.match(rule(".save-bar.is-error"), /background:\s*color-mix\(in srgb, var\(--red\) 7%, var\(--bg-elev\)\);/);
  } finally {
    await view.unmount();
  }
});

test("SaveBar names its actions, and a new record's bar shows from the start with Save enabled (§8.6)", async () => {
  const actions: string[] = [];
  const bar = (props: { dirty: boolean; error?: string | null }) => (
    <SaveBar {...props} saveLabel="Create Automation" discardLabel="Cancel" alwaysShown
      onDiscard={() => actions.push("cancel")} onSave={() => actions.push("create")} />
  );
  const view = await render(bar({ dirty: false }));
  try {
    const buttons = () => [...view.container.querySelectorAll<HTMLButtonElement>(".save-bar button")];
    const clean = view.container.querySelector<HTMLElement>(".save-bar");
    assert.ok(clean, "a new record's bar renders while the form is clean");
    assert.equal(clean.querySelector(".save-bar-message")?.textContent, "", "nothing is unsaved yet");
    assert.deepEqual(buttons().map((button) => button.textContent), ["Cancel", "Create Automation"]);
    for (const button of buttons()) {
      assert.equal(button.disabled, false, `${button.textContent} is enabled`);
      assert.equal(button.getAttribute("aria-disabled"), null, `${button.textContent} is not aria-disabled`);
    }
    await act(async () => { buttons()[1]!.click(); buttons()[0]!.click(); });
    assert.deepEqual(actions, ["create", "cancel"], "an empty form still submits, so the editor's validation runs");

    await view.rerender(bar({ dirty: true }));
    assert.equal(view.container.querySelector(".save-bar-message")?.textContent, "Unsaved changes");
    assert.deepEqual(buttons().map((button) => button.textContent), ["Cancel", "Create Automation"]);

    await view.rerender(bar({ dirty: true, error: "The automation could not be created." }));
    assert.deepEqual(buttons().map((button) => button.textContent), ["Cancel", "Try Again"], "Try Again replaces the custom label");
  } finally {
    await view.unmount();
  }

  const saved = await render(<SaveBar dirty saveLabel="Save Defaults" onDiscard={() => {}} onSave={() => {}} />);
  try {
    assert.deepEqual([...saved.container.querySelectorAll(".save-bar button")].map((button) => button.textContent), ["Discard", "Save Defaults"]);
  } finally {
    await saved.unmount();
  }
});

test("SaveBar's blocked reason refuses Save, says why in the message's place and describes Save (§8.6)", async () => {
  const actions: string[] = [];
  const bar = (props: { blockedReason?: string | null; error?: string | null }) => (
    <SaveBar dirty {...props} onDiscard={() => actions.push("discard")} onSave={() => actions.push("save")} />
  );
  const view = await render(bar({ blockedReason: "Fix 1 setting to save" }));
  try {
    const element = () => view.container.querySelector<HTMLElement>(".save-bar")!;
    const [discard, save] = [...element().querySelectorAll<HTMLButtonElement>("button")];
    const message = element().querySelector<HTMLElement>(".save-bar-message")!;
    assert.equal(message.textContent, "Fix 1 setting to save", "the reason replaces \"Unsaved changes\"");
    assert.ok(message.id, "the message has an id to be referenced");
    assert.equal(save!.getAttribute("aria-describedby"), message.id, "Save is described by the reason");
    assert.equal(save!.getAttribute("aria-disabled"), "true");
    assert.equal(save!.disabled, false, "Save stays focusable to explain itself");
    assert.equal(discard!.disabled, false, "Discard stays enabled");
    await act(async () => { save!.click(); discard!.click(); });
    assert.deepEqual(actions, ["discard"], "a blocked Save does nothing");

    await view.rerender(bar({ blockedReason: "Fix 1 setting to save", error: "The defaults could not be saved." }));
    assert.equal(element().classList.contains("is-error"), false, "a block outranks a failure from an earlier draft");
    assert.equal(element().getAttribute("role"), null);
    assert.equal(message.textContent, "Fix 1 setting to save");
    assert.equal(save!.textContent, "Save");

    await view.rerender(bar({ blockedReason: null }));
    assert.equal(message.textContent, "Unsaved changes");
    assert.equal(save!.getAttribute("aria-describedby"), null);
    assert.equal(save!.getAttribute("aria-disabled"), null);
    await act(async () => { save!.click(); });
    assert.deepEqual(actions, ["discard", "save"]);
  } finally {
    await view.unmount();
  }
});

test("SaveBar's busy Save keeps its label and width beside a spinner, and Discard is disabled (§3.1, §8.6)", async () => {
  // happy-dom has no layout: a button is as wide as its label plus its spinner, unless an inline
  // width says otherwise, which is the one fact that would let a busy Save grow (BusyButton.dom.test.tsx).
  const layout = (element: Element) => {
    const inline = (element as HTMLElement).style?.width;
    if (inline) return Number.parseFloat(inline);
    return 24 + (element.querySelector(".spinner") ? 22 : 0) + (element.textContent ?? "").length * 7;
  };
  const native = Object.getOwnPropertyDescriptor(domWindow, "getComputedStyle");
  Object.defineProperty(domWindow, "getComputedStyle", {
    configurable: true, writable: true, value: (element: Element) => ({ width: `${layout(element)}px` }),
  });
  const bar = (busy: boolean, error: string | null = null) => (
    <SaveBar dirty busy={busy} error={error} saveLabel="Save Changes" onDiscard={() => {}} onSave={() => {}} />
  );
  const view = await render(bar(false));
  try {
    const buttons = () => [...view.container.querySelectorAll<HTMLButtonElement>(".save-bar button")];
    const idleWidth = layout(buttons()[1]!);

    await view.rerender(bar(true));
    const [discard, save] = buttons();
    assert.equal(discard!.disabled, true, "Discard is disabled while saving");
    assert.equal(save!.textContent, "Save Changes", "the label stays");
    assert.equal(save!.getAttribute("aria-busy"), "true");
    assert.equal(save!.getAttribute("aria-disabled"), "true");
    assert.ok(save!.querySelector(".spinner"), "a spinner shows the save running");
    assert.equal(layout(save!), idleWidth, "the width does not change");
    assert.equal(view.container.querySelector('.save-bar [role="status"]')?.textContent, "Saving changes…");

    await view.rerender(bar(true, "The defaults could not be saved."));
    assert.equal(buttons()[1]!.textContent, "Try Again", "a retry keeps Try Again while it runs");

    assert.doesNotMatch(view.container.textContent ?? "", /Saving…/);
  } finally {
    await view.unmount();
    if (native) Object.defineProperty(domWindow, "getComputedStyle", native);
    else delete (domWindow as unknown as Record<string, unknown>).getComputedStyle;
  }
});

test("FilterButton marks and counts applied filters (§4.7, §15.1)", async () => {
  let opened = 0;
  const button = (applied: number) => (
    <FilterButton applied={applied} expanded={false} controls="filters-sheet" onClick={() => { opened += 1; }} />
  );
  const view = await render(button(0));
  try {
    const element = () => view.container.querySelector<HTMLButtonElement>("button.filter-btn")!;
    assert.equal(element().classList.contains("is-set"), false);
    assert.equal(element().textContent, "Filters");
    assert.equal(element().getAttribute("aria-haspopup"), "dialog");
    assert.equal(element().getAttribute("aria-controls"), "filters-sheet");

    await view.rerender(button(2));
    assert.equal(element().classList.contains("is-set"), true);
    assert.equal(element().querySelector(".count")?.textContent, "2");
    assert.equal(element().querySelector(".sr-only")?.textContent, ", 2 applied");
    await act(async () => { element().click(); });
    assert.equal(opened, 1);
    assert.match(rule(".filter-btn.is-set"), /border-color:\s*var\(--control-outline\);/);
  } finally {
    await view.unmount();
  }
});

test("Steps numbers a real sequence, and lays short steps side by side on request (§8.7)", async () => {
  const view = await render(<Steps><li>Install</li><li>Sign In</li></Steps>);
  try {
    const list = view.container.querySelector("ol")!;
    assert.equal(list.className, "steps");
    assert.equal(list.querySelectorAll(":scope > li").length, 2);
    await view.rerender(<Steps horizontal><li>Install</li><li>Sign In</li></Steps>);
    assert.equal(view.container.querySelector("ol")?.className, "steps horizontal");
    assert.match(rule(".steps > li::before"), /content:\s*counter\(step\);/);
    assert.match(rule(".steps.horizontal"), /flex-direction:\s*row;/);
  } finally {
    await view.unmount();
  }
});

test("OneLineCodeWell keeps the whole value for Copy and screen readers, with a 44px Copy on touch (§11.7)", async () => {
  const value = `whsec_${"7Hq2Zx9KpL4mVb8NcR3tYw6UeJ5sGd1F".repeat(13)}`.slice(0, 400);
  const copied: string[] = [];
  const previousClipboard = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  const view = await render(<OneLineCodeWell value={value} name="Signing Secret" />);
  try {
    const well = view.container.firstElementChild!;
    assert.equal(well.className, "code-well one-line");
    assert.equal(well.getAttribute("aria-label"), null, "the well carries no label; a `.field` names it");
    assert.equal(well.querySelector(":scope > code")?.textContent, value, "the ellipsis clips paint, not the DOM");
    const copy = well.querySelector<HTMLButtonElement>(":scope > button")!;
    assert.equal(copy.getAttribute("aria-label"), "Copy Signing Secret");
    assert.deepEqual([...copy.classList].slice(0, 2), ["icon-btn", "sm"]);
    await act(async () => { copy.click(); });
    assert.deepEqual(copied, [value], "Copy copies all 400 characters");
    assert.equal(copy.classList.contains("copy-status-copied"), true, "with the shared copy confirmation");
  } finally {
    await view.unmount();
    if (previousClipboard) Object.defineProperty(domWindow.navigator, "clipboard", previousClipboard);
    else delete (domWindow.navigator as unknown as Record<string, unknown>).clipboard;
  }

  // One rule set, beside `.code-well`: centered, and the value on one line ending in an ellipsis.
  assert.equal(sheet.match(/\.code-well\.one-line\b/g)?.length, 2, "no second copy of the rules");
  assert.match(rule(".code-well.one-line"), /align-items:\s*center;/);
  const line = rule(".code-well.one-line > code");
  for (const declaration of [/white-space:\s*nowrap;/, /overflow:\s*hidden;/, /text-overflow:\s*ellipsis;/]) {
    assert.match(line, declaration);
  }
  assert.match(rule(".code-well > :is(code, pre)"), /white-space:\s*pre-wrap;/, "the wrapping well still wraps");
  // On a coarse pointer `.icon-btn.sm` is 36px and borrows 4px on every side: a 44×44 target.
  const coarse = sheet.slice(sheet.indexOf("Coarse-pointer sizes"));
  assert.match(coarse, /@media \(pointer: coarse\)\s*\{[^]*?--control-h-sm:\s*36px;/);
  assert.match(coarse, /:is\([^)]*\.icon-btn\.sm[^)]*\)::after\s*\{[^}]*inset:\s*-4px;/);
});
