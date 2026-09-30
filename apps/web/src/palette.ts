import { sessionAttentionStatus, type SessionView } from "@wollipog/protocol";
import { sessionAgentLabel } from "./components/agent-options.js";
import { sessionArchiveSearchDetail } from "./archive-browser.js";
import type { GlobalViewName } from "./navigation.js";
import { statusMeta, type StatusMeta } from "./status-meta.js";
import type { View } from "./store.js";

/**
 * The command palette's model (#1978; docs/design-system.md §4.1 Search). Pure, so the sections,
 * their order, Recent's cap and the transcript deduplication are unit-tested without a DOM.
 */

/** The palette actions. Each names the state it switches to, so its label changes with the state. */
export type PaletteActionId = "toggle-sessions-view" | "toggle-rail-labels";

interface PaletteRow {
  /** Stable within one render: the React key and the option id's seed. */
  key: string;
  label: string;
  /** The second line. */
  detail?: string;
  /** A transcript snippet with ⟪⟫ match marks: the third line of a session, the second of a hit. */
  snippet?: string;
  /** The keycap text, when the row has a binding. */
  keys?: string;
}

/** One selectable palette row. `view` is the navigation target. */
export type PaletteEntry =
  | PaletteRow & { kind: "session"; status: StatusMeta; view: View }
  | PaletteRow & { kind: "transcript"; view: View }
  | PaletteRow & { kind: "destination"; icon: GlobalViewName | "settings"; view: View }
  | PaletteRow & { kind: "action"; action: PaletteActionId; icon: "board" | "list" | "labels-on" | "labels-off" };

export type PaletteSectionId = "recent" | "sessions" | "transcripts" | "go-to" | "actions";

/** Title Case section labels (§9.1). */
export const PALETTE_SECTION_LABELS: Readonly<Record<PaletteSectionId, string>> = {
  recent: "Recent",
  sessions: "Sessions",
  transcripts: "In Transcripts",
  "go-to": "Go To",
  actions: "Actions",
};

export interface PaletteSection {
  id: PaletteSectionId;
  label: string;
  entries: PaletteEntry[];
}

/** One transcript hit as the search API returns it. */
export interface TranscriptHit {
  sessionId: string;
  snippet: string;
  title: string;
}

/** The transcript search API's minimum query length. The palette does not change it. */
export const TRANSCRIPT_QUERY_MIN = 3;

/** Title matches listed under Sessions. */
export const PALETTE_SESSION_LIMIT = 8;

/** A query long enough to show, too short to search transcripts: the hint row's condition. */
export function transcriptQueryTooShort(query: string): boolean {
  const length = query.trim().length;
  return length > 0 && length < TRANSCRIPT_QUERY_MIN;
}

/** What a session row's dot says: a pending request outranks the lifecycle, as on every surface. */
export function paletteSessionStatus(session: SessionView): StatusMeta {
  const attention = session.pendingApproval ? sessionAttentionStatus(session) : null;
  return attention ? statusMeta("attention", attention.kind) : statusMeta("session", session.status);
}

function sessionEntry(session: SessionView, key: string): PaletteEntry & { kind: "session" } {
  return {
    kind: "session",
    key,
    label: session.title || session.id,
    detail: sessionArchiveSearchDetail(session),
    status: paletteSessionStatus(session),
    view: { name: "session", id: session.id },
  };
}

function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Rank sessions for the palette: every whitespace-separated term must match somewhere in
 * title/workspace/agent (case-insensitive); title hits rank above workspace/agent-only hits,
 * then most-recently-updated wins. Empty query = most recent sessions.
 */
export function matchSessions(sessions: SessionView[], q: string, limit: number): Array<PaletteEntry & { kind: "session" }> {
  const terms = queryTerms(q);
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
  return scored.slice(0, limit).map(({ s }) => sessionEntry(s, `session:${s.id}`));
}

/** Whether every term of the query appears in the row's label or second line. */
function rowMatches(entry: PaletteEntry, terms: readonly string[]): boolean {
  const text = `${entry.label} ${entry.detail ?? ""}`.toLowerCase();
  return terms.every((term) => text.includes(term));
}

/**
 * A snippet that starts on a word boundary.
 *
 * The index cuts a snippet at a token, and its tokenizer splits words at apostrophes and
 * underscores, so a snippet taken from the middle of a text can open on the tail of a word
 * ("…t work", "…name is"). After the leading ellipsis the first word is dropped unless it holds the
 * match, along with any punctuation left in front of the next one. A snippet from the start of its
 * text has no ellipsis and is kept whole.
 */
export function snippetFromWordBoundary(snippet: string): string {
  const text = snippet.trimStart();
  if (!text.startsWith("…")) return text;
  const body = text.slice(1);
  const firstWord = /^\S*\s+/.exec(body);
  if (!firstWord || firstWord[0].includes("⟪")) return `…${body.trimStart()}`;
  const rest = body.slice(firstWord[0].length).replace(/^[^\p{L}\p{N}⟪]+/u, "");
  return rest ? `…${rest}` : `…${body.trimStart()}`;
}

export interface PaletteModelInput {
  query: string;
  /** Every session the palette can name, live and archived, by id. */
  sessions: ReadonlyMap<string, SessionView>;
  /** Recently opened session ids, newest first. */
  recent: readonly string[];
  /** Transcript hits for the current query, in rank order. */
  hits: readonly TranscriptHit[];
  /** Go To rows, already limited to what this device shows. */
  destinations: readonly PaletteEntry[];
  actions: readonly PaletteEntry[];
}

/**
 * The palette's sections, in order, without the empty ones.
 *
 * An empty query shows where the user was (Recent), where they can go (Go To) and what they can do
 * (Actions). A query shows title matches (Sessions), transcript hits on other sessions (In
 * Transcripts), then the destinations and actions it matches. A hit on a session already listed is
 * that row's third line rather than a second row for the same session.
 */
export function paletteSections(input: PaletteModelInput): PaletteSection[] {
  const terms = queryTerms(input.query);
  const section = (id: PaletteSectionId, entries: PaletteEntry[]): PaletteSection =>
    ({ id, label: PALETTE_SECTION_LABELS[id], entries });
  if (terms.length === 0) {
    const recent = input.recent.flatMap((id) => {
      const session = input.sessions.get(id);
      return session ? [sessionEntry(session, `recent:${id}`)] : [];
    });
    return [
      section("recent", recent),
      section("go-to", [...input.destinations]),
      section("actions", [...input.actions]),
    ].filter((entry) => entry.entries.length > 0);
  }
  const sessions = matchSessions([...input.sessions.values()], input.query, PALETTE_SESSION_LIMIT);
  const listed = new Map(sessions.map((entry) => [(entry.view as { id: string }).id, entry]));
  const seen = new Set<string>();
  const transcripts: PaletteEntry[] = [];
  // The server returns a session's best hit first, so the first one per session wins.
  for (const hit of input.hits) {
    if (seen.has(hit.sessionId)) continue;
    seen.add(hit.sessionId);
    const snippet = snippetFromWordBoundary(hit.snippet);
    const row = listed.get(hit.sessionId);
    if (row) {
      row.snippet = snippet;
      continue;
    }
    const session = input.sessions.get(hit.sessionId);
    transcripts.push({
      kind: "transcript",
      key: `transcript:${hit.sessionId}`,
      label: hit.title || session?.title || hit.sessionId,
      detail: session ? sessionArchiveSearchDetail(session) : "Session State Unavailable",
      snippet,
      view: { name: "session", id: hit.sessionId },
    });
  }
  return [
    section("sessions", sessions),
    section("transcripts", transcripts),
    section("go-to", input.destinations.filter((entry) => rowMatches(entry, terms))),
    section("actions", input.actions.filter((entry) => rowMatches(entry, terms))),
  ].filter((entry) => entry.entries.length > 0);
}
