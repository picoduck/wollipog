import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_FONT_FACE, TERMINAL_FONT_FAMILY, TERMINAL_FONT_LOAD_SPEC, loadTerminalFont } from "./terminal-font.js";

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
