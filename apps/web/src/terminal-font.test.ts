import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_FONT_FACE,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_LOAD_SPEC,
  TERMINAL_NARROW_WIDTH,
  loadTerminalFont,
  terminalFontMetrics,
} from "./terminal-font.js";

test("the terminal font helper settles the bundled face before readiness", async () => {
  const events: string[] = [];
  let settleReady!: () => void;
  const ready = new Promise<FontFaceSet>((resolve) => {
    settleReady = () => {
      events.push("ready");
      resolve({} as FontFaceSet);
    };
  });
  const fonts = {
    ready,
    async load(spec: string) {
      events.push(`load:${spec}`);
      settleReady();
      return [];
    },
  } as unknown as FontFaceSet;

  await loadTerminalFont(fonts);
  assert.deepEqual(events, [`load:${TERMINAL_FONT_LOAD_SPEC}`, "ready"]);
  assert.match(TERMINAL_FONT_FAMILY, new RegExp(`^"${TERMINAL_FONT_FACE}"`));
  assert.match(TERMINAL_FONT_FAMILY, /ui-monospace/);
});

test("font loading failure preserves terminal fallback behavior", async () => {
  const fonts = {
    ready: Promise.resolve({} as FontFaceSet),
    load: async () => { throw new Error("font unavailable"); },
  } as unknown as FontFaceSet;
  await assert.doesNotReject(loadTerminalFont(fonts));
  await assert.doesNotReject(loadTerminalFont(undefined));
});

test("a host narrower than 560px gets 12px text; wider and unmeasured hosts keep 12.5px (#2865)", () => {
  assert.equal(TERMINAL_NARROW_WIDTH, 560);
  assert.equal(terminalFontMetrics(390).fontSize, 12);
  assert.equal(terminalFontMetrics(559).fontSize, 12);
  assert.equal(terminalFontMetrics(560).fontSize, 12.5);
  assert.equal(terminalFontMetrics(1440).fontSize, 12.5);
  assert.equal(terminalFontMetrics(0).fontSize, 12.5, "a hidden host is not a phone");
});
