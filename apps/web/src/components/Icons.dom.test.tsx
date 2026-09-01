import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GitHubIcon, GridIcon, ShieldIcon, StopTurnIcon } from "./Icons.js";

function renderedSvg(markup: string): SVGSVGElement {
  const window = new Window();
  window.document.body.innerHTML = markup;
  const svg = window.document.querySelector("svg");
  assert.ok(svg, "the icon must render an SVG element");
  return svg as unknown as SVGSVGElement;
}

test("a rendered Lucide icon preserves the complete shared SVG contract", () => {
  const svg = renderedSvg(renderToStaticMarkup(<GridIcon size={20} className="sample" />));
  assert.equal(svg.getAttribute("width"), "20");
  assert.equal(svg.getAttribute("height"), "20");
  assert.equal(svg.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(svg.getAttribute("fill"), "none");
  assert.equal(svg.getAttribute("stroke"), "currentColor");
  assert.equal(svg.getAttribute("stroke-width"), "1.8");
  assert.equal(svg.getAttribute("stroke-linecap"), "round");
  assert.equal(svg.getAttribute("stroke-linejoin"), "round");
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  assert.equal(svg.getAttribute("focusable"), "false");
  assert.ok(svg.classList.contains("app-icon"));
  assert.ok(svg.classList.contains("sample"));
});

test("the adapter renders every commonly used icon size without changing the viewBox", () => {
  for (const size of [13, 14, 16, 20, 26, 28]) {
    const svg = renderedSvg(renderToStaticMarkup(<GridIcon size={size} />));
    assert.equal(svg.getAttribute("width"), String(size));
    assert.equal(svg.getAttribute("height"), String(size));
    assert.equal(svg.getAttribute("viewBox"), "0 0 24 24");
  }
});

test("explicit accessibility and styling overrides remain available", () => {
  const svg = renderedSvg(renderToStaticMarkup(
    <GridIcon aria-hidden={undefined} aria-label="Grid" role="img" stroke="rebeccapurple" />,
  ));
  assert.equal(svg.hasAttribute("aria-hidden"), false);
  assert.equal(svg.getAttribute("aria-label"), "Grid");
  assert.equal(svg.getAttribute("role"), "img");
  assert.equal(svg.getAttribute("stroke"), "rebeccapurple");
});

test("intentional filled and brand marks keep their distinct rendered contracts", () => {
  const shield = renderedSvg(renderToStaticMarkup(<ShieldIcon size={14} />));
  assert.equal(shield.getAttribute("fill"), "currentColor");
  assert.equal(shield.getAttribute("stroke"), "none");
  assert.ok(shield.classList.contains("app-icon"));

  const stop = renderedSvg(renderToStaticMarkup(<StopTurnIcon size={14} />));
  assert.equal(stop.getAttribute("fill"), "currentColor");
  assert.equal(stop.getAttribute("stroke"), "none");
  assert.equal(stop.style.transform, "scale(0.67)");
  assert.equal(stop.style.transformOrigin, "center");

  const github = renderedSvg(renderToStaticMarkup(<GitHubIcon size={14} />));
  assert.equal(github.getAttribute("viewBox"), "0 0 16 16");
  assert.equal(github.getAttribute("fill"), "currentColor");
  assert.equal(github.getAttribute("aria-hidden"), "true");
  assert.equal(github.getAttribute("focusable"), "false");
  assert.ok(github.classList.contains("app-icon"));
});
