import type { SessionView } from "@wollipog/protocol";
import { computeContextFill } from "../context-meter.js";
import { resolveCaps } from "../caps.js";
import { useStoreSelector } from "../store.js";

/**
 * Codex-style context-fill meter: how much of the model's context window the session has consumed.
 * Reads the per-model `contextWindow` off the agent's advertised capabilities (protocol v11). Renders
 * nothing when the window is unknown (adopted/unmanaged sessions, old runners) — the token badge still
 * shows raw usage.
 */
export function ContextWindowMeter({ session }: { session: SessionView }) {
  const runners = useStoreSelector((s) => s.runners);
  const models = resolveCaps(runners.get(session.runnerId), session)?.models ?? [];
  const model = models.find((m) => m.id === session.model) ?? models.find((m) => m.default);
  const contextWindow = session.contextWindow ?? model?.contextWindow;
  const fill = computeContextFill({
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    usedTokens: session.contextTokensUsed,
    contextWindow,
  });
  if (!fill.known) return null;

  const used = session.contextTokensUsed ?? (session.tokensIn + session.tokensOut);
  const title = `${used.toLocaleString()} / ${contextWindow!.toLocaleString()} context tokens (${fill.formatPct})`;
  return (
    <span className={`context-meter${fill.isFull ? " is-full" : ""}`} title={title}>
      <span className="meter-bar">
        <span className="meter-fill" style={{ width: `${fill.fillPct}%` }} />
      </span>
      <span className="meter-label">{fill.formatPct}</span>
    </span>
  );
}
