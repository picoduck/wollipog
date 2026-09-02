import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CursorEditorIcon,
  GitHubIcon,
  GridIcon,
  ShieldIcon,
  StopTurnIcon,
  VisualStudioCodeIcon,
  ZedEditorIcon,
} from "./Icons.js";

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

  const styledStop = renderedSvg(renderToStaticMarkup(<StopTurnIcon style={{ opacity: 0.6 }} />));
  assert.equal(styledStop.style.transform, "scale(0.67)");
  assert.equal(styledStop.style.transformOrigin, "center");
  assert.equal(styledStop.style.opacity, "0.6");

  const github = renderedSvg(renderToStaticMarkup(<GitHubIcon size={14} />));
  assert.equal(github.getAttribute("viewBox"), "0 0 16 16");
  assert.equal(github.getAttribute("fill"), "currentColor");
  assert.equal(github.getAttribute("aria-hidden"), "true");
  assert.equal(github.getAttribute("focusable"), "false");
  assert.ok(github.classList.contains("app-icon"));
});

test("Cursor and Zed render their pinned Simple Icons product marks", () => {
  const cursor = renderedSvg(renderToStaticMarkup(<CursorEditorIcon size={14} />));
  assert.equal(cursor.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(cursor.getAttribute("fill"), "currentColor");
  assert.equal(cursor.getAttribute("stroke"), "none");
  assert.equal(
    cursor.querySelector("path")?.getAttribute("d"),
    "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  );

  const zed = renderedSvg(renderToStaticMarkup(<ZedEditorIcon size={14} />));
  assert.equal(zed.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(zed.getAttribute("fill"), "currentColor");
  assert.equal(zed.getAttribute("stroke"), "none");
  assert.equal(
    zed.querySelector("path")?.getAttribute("d"),
    "M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z",
  );
});

test("VS Code renders Microsoft's official stable multicolor mark", () => {
  const vscode = renderedSvg(renderToStaticMarkup(<VisualStudioCodeIcon size={14} />));
  assert.equal(vscode.getAttribute("viewBox"), "0 0 100 100");
  assert.equal(vscode.getAttribute("fill"), "none");
  assert.equal(vscode.getAttribute("stroke"), "none");
  assert.ok(vscode.querySelector('path[fill="#0065A9"]'));
  assert.ok(vscode.querySelector('path[fill="#007ACC"]'));
  assert.ok(vscode.querySelector('path[fill="#1F9CF0"]'));
  assert.ok(vscode.querySelector("linearGradient"));
  assert.ok(vscode.classList.contains("app-icon"));
});

test("multiple VS Code marks receive unique paint-server ids", () => {
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(
    <><VisualStudioCodeIcon /><VisualStudioCodeIcon /></>,
  );
  const icons = [...window.document.querySelectorAll("svg")];
  assert.equal(icons.length, 2);
  const maskIds = icons.map((icon) => icon.querySelector("mask")?.id);
  assert.ok(maskIds[0]);
  assert.ok(maskIds[1]);
  assert.notEqual(maskIds[0], maskIds[1]);
  assert.equal(icons[0]?.querySelector("g")?.getAttribute("mask"), `url(#${maskIds[0]})`);
  assert.equal(icons[1]?.querySelector("g")?.getAttribute("mask"), `url(#${maskIds[1]})`);
});
