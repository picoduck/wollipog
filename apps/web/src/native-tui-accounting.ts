import type { AgentDefinition } from "@wollipog/protocol";

/** Content-free explanation of the live provider boundary. Missing metadata means an older runner,
 * so retain the generic unavailable message rather than inferring support from driver or version. */
export function nativeTuiAccountingDetail(agent: AgentDefinition | undefined): string | null {
  const boundary = agent?.nativeTuiAccounting;
  if (!boundary) return null;
  const version = boundary.installedVersion ? ` ${boundary.installedVersion}` : "";
  if (boundary.nearestStructuredSurface === "print-mode-only") {
    return `Provider Contract: Claude Code${version} exposes structured output only outside its interactive Native TUI; authoritative replay and gap detection are unavailable.`;
  }
  if (boundary.nearestStructuredSurface === "separate-app-server") {
    return `Provider Contract: Codex${version} exposes usage through a separate App Server; the Native TUI lacks authoritative pre-turn binding, replay, and gap detection.`;
  }
  return "Provider Contract: No authoritative session-bound Native TUI usage stream is available.";
}

