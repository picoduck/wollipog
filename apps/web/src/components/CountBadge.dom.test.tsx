import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CountBadge } from "./CountBadge.js";

/** The badge's one element, parsed from the markup it renders. */
function rendered(markup: string) {
  const window = new Window();
  window.document.body.innerHTML = markup;
  const elements = window.document.body.children;
  assert.equal(elements.length, 1, "the badge is one element");
  const element = elements[0]!;
  return {
    classes: [...element.classList],
    text: element.textContent,
    hidden: element.getAttribute("aria-hidden"),
    children: element.children.length,
  };
}

test("a count badge is the warning variant by default: one aria-hidden element holding the number", () => {
  assert.deepEqual(rendered(renderToStaticMarkup(<CountBadge count={3} />)), {
    classes: ["count-badge"],
    text: "3",
    hidden: "true",
    children: 0,
  });
});

test("the danger tone adds the danger class and nothing else", () => {
  assert.deepEqual(rendered(renderToStaticMarkup(<CountBadge count={12} tone="danger" />)).classes, ["count-badge", "danger"]);
  assert.deepEqual(rendered(renderToStaticMarkup(<CountBadge count={12} tone="warning" />)).classes, ["count-badge"]);
});

test("on an icon the badge adds on-icon, in either tone", () => {
  assert.deepEqual(rendered(renderToStaticMarkup(<CountBadge count={128} onIcon />)), {
    classes: ["count-badge", "on-icon"],
    text: "128",
    hidden: "true",
    children: 0,
  });
  assert.deepEqual(rendered(renderToStaticMarkup(<CountBadge count={1} tone="danger" onIcon />)).classes,
    ["count-badge", "danger", "on-icon"]);
});

test("an owner class is kept alongside the badge's own", () => {
  assert.deepEqual(rendered(renderToStaticMarkup(<CountBadge count={2} className="rail-count" />)).classes,
    ["count-badge", "rail-count"]);
});

test("zero, a negative count and NaN render nothing, so zero is never shown in colour", () => {
  for (const count of [0, -1, Number.NaN]) {
    assert.equal(renderToStaticMarkup(<CountBadge count={count} />), "", `count ${count}`);
    assert.equal(renderToStaticMarkup(<CountBadge count={count} tone="danger" onIcon />), "", `danger on-icon count ${count}`);
  }
});
