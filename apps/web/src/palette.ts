import type { SessionView } from "@wollipog/protocol";
import { sessionAgentLabel } from "./components/agent-options.js";
import { sessionArchiveSearchDetail } from "./archive-browser.js";
import type { View } from "./store.js";

/** One selectable palette row. `view` is the navigation target. */
export interface PaletteEntry {
  kind: "session" | "transcript" | "view";
  label: string;
  detail?: string;
  snippet?: string;
  view: View;
}

/**
 * Rank sessions for the Cmd+K palette: every whitespace-separated term must match somewhere in
 * title/workspace/agent (case-insensitive); title hits rank above workspace/agent-only hits,
 * then most-recently-updated wins. Empty query = most recent sessions. Pure — unit-tested.
 */
export function matchSessions(sessions: SessionView[], q: string, limit: number): PaletteEntry[] {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { score: number; s: SessionView }[] = [];
  for (const s of sessions) {
    const title = s.title.toLowerCase();
    const agentLabel = sessionAgentLabel(s.agentName, s.driver, s.agentId);
    const rest = `${s.projectName ?? ""} ${s.workspaceName ?? ""} ${agentLabel} ${s.agentName ?? ""} ${sessionArchiveSearchDetail(s)}`.toLowerCase();
    if (terms.length === 0) {
      scored.push({ score: 0, s });
      continue;
    }
    let titleHits = 0;
    let ok = true;
    for (const t of terms) {
      if (title.includes(t)) titleHits++;
      else if (!rest.includes(t)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    scored.push({ score: titleHits, s });
  }
  scored.sort((a, b) => b.score - a.score || b.s.updatedAt - a.s.updatedAt);
  return scored.slice(0, limit).map(({ s }) => ({
    kind: "session" as const,
    label: s.title || s.id,
    detail: sessionArchiveSearchDetail(s),
    view: { name: "session", id: s.id },
  }));
}
