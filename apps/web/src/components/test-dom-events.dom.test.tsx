import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  writable: true,
  value: true,
});

test("change reaches React handlers for text and checkable inputs", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let textValue = "";
  let checked = false;
  try {
    await act(async () => {
      root.render(
        <>
          <input aria-label="Text" onChange={(event) => { textValue = event.currentTarget.value; }} />
          <input
            aria-label="Checkable"
            type="checkbox"
            onChange={(event) => { checked = event.currentTarget.checked; }}
          />
        </>,
      );
    });
    const textInput = container.querySelector<HTMLInputElement>('[aria-label="Text"]');
    const checkbox = container.querySelector<HTMLInputElement>('[aria-label="Checkable"]');
    assert.ok(textInput);
    assert.ok(checkbox);

    await act(async () => {
      fireDomEvent.change(textInput, { target: { value: "updated" } });
      fireDomEvent.change(checkbox, { target: { checked: true } });
    });

    assert.equal(textValue, "updated");
    assert.equal(checked, true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
