import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { ComposerIdlePreview, ComposerTextarea, ComposerTextStore } from "./ComposerTextInput.js";

const domWindow = new Window({ url: "http://localhost/" });
const { cleanup } = installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const placeholder = "Message Codex";

async function mountDraft(text: string) {
  const store = new ComposerTextStore();
  store.setText(text);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup(async () => { await act(async () => root.unmount()); });
  await act(async () => root.render(
    <>
      <ComposerIdlePreview store={store} placeholder={placeholder} onClick={() => {}} />
      <ComposerTextarea store={store} aria-label="Message" readOnly />
    </>,
  ));
  return {
    store,
    preview: container.querySelector("button")!,
    textarea: container.querySelector("textarea")!,
  };
}

for (const { name, draft } of [
  { name: "multiple lines", draft: "First line\nSecond line\nThird line" },
  { name: "leading blank lines", draft: "\n \t\n  First line  \nSecond line\n" },
  { name: "CRLF and leading blank lines", draft: "\r\n\t\r\nFirst line\r\nSecond line" },
]) {
  test(`idle preview names and shows only the first non-empty line: ${name}`, async () => {
    const { store, preview, textarea } = await mountDraft(draft);
    assert.equal(preview.getAttribute("aria-label"), "Edit Draft: First line");
    assert.equal(preview.textContent, "First line");
    assert.equal(preview.classList.contains("is-empty"), false);
    assert.equal(store.text, draft, "deriving the preview must preserve the full editable draft");
    assert.equal(textarea.value, draft);
  });
}

for (const draft of ["", " \t\n\r\n "]) {
  test(`an ${draft ? "all-whitespace" : "empty"} draft retains the placeholder`, async () => {
    const { store, preview } = await mountDraft(draft);
    assert.equal(preview.getAttribute("aria-label"), placeholder);
    assert.equal(preview.textContent, placeholder);
    assert.equal(preview.classList.contains("is-empty"), true);
    assert.equal(store.text, draft);
  });
}

test("idle preview and textarea track draft updates without replacing the full draft", async () => {
  const { store, preview, textarea } = await mountDraft("Single line");
  assert.equal(preview.getAttribute("aria-label"), "Edit Draft: Single line");
  assert.equal(preview.textContent, "Single line");

  const draft = "\nUpdated first line\nKeep this later line";
  await act(async () => store.setText(draft));
  assert.equal(preview.getAttribute("aria-label"), "Edit Draft: Updated first line");
  assert.equal(preview.textContent, "Updated first line");
  assert.equal(textarea.value, draft);
  assert.equal(store.text, draft);

  await act(async () => store.setText(""));
  assert.equal(preview.getAttribute("aria-label"), placeholder);
  assert.equal(preview.textContent, placeholder);
  assert.equal(preview.classList.contains("is-empty"), true);
  assert.equal(textarea.value, "");
});
