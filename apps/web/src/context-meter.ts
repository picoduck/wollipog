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
  /** The ring's and bar's tone (§11.6): warning from 75%, danger from 90%, neutral below. */
  tone: ContextFillTone;
  /** False when we couldn't compute (no/zero context window). */
  known: boolean;
}

export type ContextFillTone = "neutral" | "warning" | "danger";

/** Where the level starts needing attention, and where compaction is imminent. */
const WARNING_PCT = 75;
const DANGER_PCT = 90;

const UNKNOWN: ContextFill = { fillPct: 0, formatPct: "—", isFull: false, tone: "neutral", known: false };

/** What the popover says about compaction. Every native harness compacts on its own once the
 * window fills; none advertises the threshold, and Wollipog exposes no manual compact, so the
 * sentence names the fact rather than a number. ACP agents are opaque about it. */
export function compactionNote(driver: string | undefined): string {
  if (driver === "claude-code" || driver === "codex" || driver === "codex-app-server" || driver === "pi") {
    return "Context compacts automatically when the window fills.";
  }
  return "Compaction is up to the agent.";
}

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
  const tone: ContextFillTone = clamped >= DANGER_PCT ? "danger" : clamped >= WARNING_PCT ? "warning" : "neutral";
  return { fillPct: clamped, formatPct, isFull: clamped >= DANGER_PCT, tone, known: true };
}
