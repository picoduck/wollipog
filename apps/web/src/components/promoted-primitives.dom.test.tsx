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
    assert.equal(warning.id, "branch-warning", "a field can point aria-describedby at it");
    assert.equal(warning.textContent, "This branch already has a worktree.");
    assert.ok(warning.querySelector(".field-warn-icon"), "the icon carries the tone");
    assert.equal(warning.getAttribute("role"), null, "a warning is not an alert");
    assert.match(rule(".field-warn"), /color:\s*var\(--text-dim\);/);
    assert.match(rule(".field-warn-icon"), /color:\s*var\(--amber\);/);
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

    await view.rerender(bar({ dirty: true, busy: true }));
    assert.deepEqual(buttons().map((button) => [button.textContent, button.disabled]), [["Discard", true], ["Saving…", true]]);

    assert.match(rule(".save-bar"), /position:\s*sticky;/);
    assert.match(rule(".save-bar.is-error"), /background:\s*color-mix\(in srgb, var\(--red\) 7%, var\(--bg-elev\)\);/);
  } finally {
    await view.unmount();
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
