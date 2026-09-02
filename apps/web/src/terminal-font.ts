/** Bundled terminal face. Keep xterm and adjacent prompt/input surfaces on the exact same stack. */
export const TERMINAL_FONT_FACE = "Wollipog JetBrainsMono Nerd Font";
export const TERMINAL_FONT_FAMILY =
  `"${TERMINAL_FONT_FACE}", "Cascadia Code", "Consolas", ui-monospace, SFMono-Regular, monospace`;
export const TERMINAL_FONT_LOAD_SPEC = `12.5px "${TERMINAL_FONT_FACE}"`;

type FontFaceSetLike = Pick<FontFaceSet, "load" | "ready">;

/** Settle the bundled face before xterm measures cells. Failure keeps the local fallback stack. */
export async function loadTerminalFont(fonts: FontFaceSetLike | undefined): Promise<void> {
  if (!fonts) return;
  try {
    await fonts.load(TERMINAL_FONT_LOAD_SPEC);
    await fonts.ready;
  } catch {
    // A damaged or unsupported font must not prevent the terminal itself from opening.
  }
}
