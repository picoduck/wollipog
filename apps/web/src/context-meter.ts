/**
 * Context-window fill math for the thread-header meter (Codex-style % of the model's context used).
 * Pure + framework-free so it unit-tests with `node:test` (per docs/codex-parity-plan.md Phase 0).
 */

export interface ContextFill {
  /** Bar width, 0–100 (clamped). */
  fillPct: number;
  /** Human label: "0.8%", "42%", "100%", or "—" when the window is unknown. */
  formatPct: string;
  /** At/over the effective ceiling — the UI can warn (compaction imminent). */
  isFull: boolean;
  /** False when we couldn't compute (no/zero context window). */
  known: boolean;
}

const UNKNOWN: ContextFill = { fillPct: 0, formatPct: "—", isFull: false, known: false };

/**
 * `(tokensIn + tokensOut) / contextWindow`, clamped to [0,100]. Small fills keep one decimal
 * (e.g. 1500/200000 → "0.8%"); larger ones round to a whole percent. Unknown window ⇒ "—".
 */
export function computeContextFill(input: {
  tokensIn: number;
  tokensOut: number;
  /** Provider-reported current context occupancy (ACP); preferred over additive token totals. */
  usedTokens?: number | null;
  contextWindow?: number | null;
}): ContextFill {
  const { tokensIn, tokensOut, usedTokens, contextWindow } = input;
  if (!contextWindow || contextWindow <= 0) return UNKNOWN;
  const used = Math.max(0, usedTokens ?? ((tokensIn || 0) + (tokensOut || 0)));
  const pct = (used / contextWindow) * 100;
  const clamped = Math.min(100, Math.max(0, pct));
  const formatPct = clamped < 10 ? `${clamped.toFixed(1)}%` : `${Math.round(clamped)}%`;
  return { fillPct: clamped, formatPct, isFull: clamped >= 90, known: true };
}
