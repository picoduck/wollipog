import assert from "node:assert/strict";
import test from "node:test";
import type React from "react";
import { Window } from "happy-dom";
import { holdFieldFocus } from "./hold-field-focus.js";

/** A docked card beside the composer, on a touch phone or not. */
function page(touchPhone: boolean) {
  const window = new Window();
  // As the DOM tests install it: the helper checks the focused element against the page's HTMLElement.
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: window.HTMLElement });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: touchPhone && query.includes("pointer: coarse"), media: query }),
  });
  const document = window.document;
  document.body.innerHTML = `
    <section class="request-card">
      <form><label><span>Authorization Code</span><input type="password" class="code"></label>
        <button type="submit" class="submit"><span>Submit Code</span></button></form>
      <label class="row"><input type="radio" name="choice"><span>Rolling</span></label>
      <p class="sentence">Paste the code here.</p>
    </section>
    <textarea class="composer" aria-label="Composer"></textarea>`;
  const card = document.querySelector(".request-card") as unknown as HTMLElement;
  const $ = (selector: string) => document.querySelector(selector) as unknown as HTMLElement;
  /** A press on `selector` inside the card: whether its default (moving focus) was prevented. */
  const press = (selector: string) => {
    let prevented = false;
    holdFieldFocus({
      currentTarget: card,
      target: $(selector),
      preventDefault: () => { prevented = true; },
    } as unknown as React.MouseEvent<HTMLElement>);
    return prevented;
  };
  return { $, press };
}

test("on a touch phone a press on a card's button or row keeps its own field focused until the click (#2205, #2675)", () => {
  const { $, press } = page(true);
  $(".code").focus();
  assert.equal(press(".submit span"), true, "Submit Code");
  assert.equal(press(".row span"), true, "a choice row");
  // A press on the field itself, or on text that is not a control, moves focus as usual.
  assert.equal(press(".code"), false);
  assert.equal(press(".sentence"), false);
});

test("on a touch phone a press on a card's control keeps the composer focused too (#2675)", () => {
  const { $, press } = page(true);
  $(".composer").focus();
  assert.equal(press(".submit"), true);
  assert.equal(press(".row input"), true);
  // Pressing into the card's own field moves focus there.
  assert.equal(press(".code"), false);
});

test("nothing is held without a focused field, or away from a touch phone", () => {
  const idle = page(true);
  assert.equal(idle.press(".submit"), false, "no field has focus");
  const desktop = page(false);
  desktop.$(".composer").focus();
  assert.equal(desktop.press(".submit"), false, "a fine pointer keeps its layout on blur");
});
