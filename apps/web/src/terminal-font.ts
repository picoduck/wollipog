/** Bundled terminal face. Keep xterm and adjacent prompt/input surfaces on the exact same stack. */
export const TERMINAL_FONT_FACE = "Wollipog JetBrainsMono Nerd Font";
export const TERMINAL_FONT_FAMILY =
  `"${TERMINAL_FONT_FACE}", "Cascadia Code", "Consolas", ui-monospace, SFMono-Regular, monospace`;
export const TERMINAL_FONT_LOAD_SPEC = `12.5px "${TERMINAL_FONT_FACE}"`;

/** 12px JetBrains Mono measures a 16px cell, so the narrow step keeps xterm's own line height. */
const NARROW_LINE_HEIGHT = 1;

/** A terminal host narrower than this (a phone) sets smaller text, so a long prompt wraps less (#2865). */
export const TERMINAL_NARROW_WIDTH = 560;

/**
 * The terminal's text for a host this wide, read each time it is fitted: 12px on 16px lines below
 * `TERMINAL_NARROW_WIDTH`, and 12.5px at xterm's own line height wider. xterm's `lineHeight` scales
 * the face's measured cell, so the narrow step names the multiple that lands on 16px.
 */
export function terminalFontMetrics(hostWidth: number): { fontSize: number; lineHeight: number } {
  return hostWidth > 0 && hostWidth < TERMINAL_NARROW_WIDTH
    ? { fontSize: 12, lineHeight: NARROW_LINE_HEIGHT }
    : { fontSize: 12.5, lineHeight: 1 };
}

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
