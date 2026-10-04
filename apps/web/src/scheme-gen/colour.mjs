/**
 * The colour arithmetic the scheme generator and its derivations share: hex parsing, an sRGB mix
 * and the WCAG contrast ratio. One copy, so a tier derived in its own module measures exactly what
 * `generate.mjs` measures.
 */

export const hexToRgb = (hex) => {
  // Validated, because `parseInt` does not complain: a typo that left `#9d9mad` in an anchor parsed
  // as a real colour and generated a whole scheme around it. A silent wrong answer is the worst
  // kind, so this is a throw rather than a fallback.
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`not a 6-digit hex colour: ${JSON.stringify(hex)}`);
  const h = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
export const rgbToHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
export const mix = (a, b, t) => rgbToHex(hexToRgb(a).map((v, i) => v + (hexToRgb(b)[i] - v) * t));
export const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const lum = (hex) => { const [r, g, b] = hexToRgb(hex); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
