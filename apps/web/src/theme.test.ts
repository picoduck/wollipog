import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";
import {
  applyThemeToDocument,
  parseThemePreference,
  resolveTheme,
  terminalTheme,
  themeColor,
} from "./theme.js";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (lighter! + 0.05) / (darker! + 0.05);
}

test("theme preferences fail closed to system and resolve against the live OS preference", () => {
  assert.equal(parseThemePreference("light"), "light");
  assert.equal(parseThemePreference("dark"), "dark");
  assert.equal(parseThemePreference("system"), "system");
  assert.equal(parseThemePreference("sepia"), "system");
  assert.equal(parseThemePreference(null), "system");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
});

test("the no-flash bootstrap runs in the head before application styles and uses the shared contract", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const bootstrap = html.indexOf("const storedAppearance");
  assert.ok(bootstrap > 0);
  assert.ok(bootstrap < html.indexOf('<link rel="manifest"'));
  assert.ok(bootstrap < html.indexOf('<script type="module"'));
  assert.match(html, /preference === "system" \? \(systemDark \? "dark" : "light"\) : preference/);
  assert.match(html, /theme === "dark" \? "#0b1118" : "#f6f8fa"/);
  assert.match(html, /localStorage\.getItem\(currentKey\)/, "appearance reads Wollipog keys first");
  assert.match(html, /localStorage\.getItem\(legacyKey\)/, "then falls back to the legacy key");
  assert.match(html, /storedAppearance\("theme"\)/);
  assert.match(html, /storedAppearance\("scheme"\)/);
  assert.match(html, /storedAppearance\("density"\)/);
});

test("applying a theme synchronizes CSS color-scheme and installed browser chrome", () => {
  const window = new Window();
  window.document.head.innerHTML = '<meta name="theme-color" content="#000000">';

  applyThemeToDocument(window.document, "light");
  assert.equal(window.document.documentElement.dataset.theme, "light");
  assert.equal(window.document.documentElement.style.colorScheme, "light");
  assert.equal(window.document.querySelector('meta[name="theme-color"]')?.getAttribute("content"), themeColor("light"));

  applyThemeToDocument(window.document, "dark");
  assert.equal(window.document.documentElement.dataset.theme, "dark");
  assert.equal(window.document.querySelector('meta[name="theme-color"]')?.getAttribute("content"), themeColor("dark"));
});

test("terminal palettes have theme-matched surfaces and readable ANSI colors", () => {
  const light = terminalTheme("light");
  const dark = terminalTheme("dark");
  assert.equal(light.background, "#f7f9fc");
  assert.equal(dark.background, "#0a0c10");
  assert.notEqual(light.foreground, dark.foreground);
  assert.notEqual(light.selectionBackground, dark.selectionBackground);
  const lightAnsi = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
    "brightMagenta", "brightCyan", "brightWhite",
  ] as const;
  for (const color of lightAnsi) {
    assert.ok(contrast(light[color], light.background) >= 4.5, `${color} must remain readable on the light terminal`);
  }
  assert.ok(dark.red && dark.green && dark.blue && dark.cursor);
});

test("light UI semantic text tokens meet normal-text contrast on their owning surfaces", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const block = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block);
  const token = (name: string) => {
    const value = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    assert.ok(value, `missing light theme token --${name}`);
    return value;
  };
  const pairs = [
    ["code-text", "code-bg"],
    ["code-muted", "code-bg"],
    ["code-accent", "code-bg"],
    ["purple", "code-bg"],
    ["danger-text", "bg"],
    ["positive-text", "diff-add-bg"],
    ["selected-accent-text", "bg-elev-3"],
    ["dropzone-text", "dropzone-bg"],
  ] as const;
  for (const [foreground, background] of pairs) {
    assert.ok(contrast(token(foreground), token(background)) >= 4.5, `${foreground} must contrast with ${background}`);
  }
});
