/**
 * Where each browser history entry sits, so Back and Forward can be held (#3218).
 *
 * By the time a page hears of Back or Forward (`popstate`) the history position has already moved,
 * and nothing in the event says by how much: one entry, or several from a long press on the Back
 * button. Each entry this app writes therefore records its own position in its state. The distance
 * between the entry on screen and the one arrived at is what `history.go` needs to return to the
 * editor without pushing anything, so no forward entry is lost, and then to complete the move.
 *
 * Positions are counted within one run of entries, named by `run`: an entry written before this was
 * recorded, or by another document, starts a run of its own. Between runs the distance is unknown,
 * and such a move is not held.
 */

import { browserRandomUUID } from "./browser-crypto.js";

const ENTRY_KEY = "wollipogEntry";

interface EntryPosition {
  run: string;
  index: number;
}

/** A Back or Forward that can be undone and redone. */
export interface HistoryTraversal {
  /** Returns to the entry that was on screen, then calls `then`. */
  undo(then: () => void): void;
  /** Completes the move that was undone. */
  redo(): void;
}

export interface PositionedHistory {
  state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  /** Absent in a test double that cannot traverse; nothing is held then. */
  go?(delta?: number): void;
}

function positionOf(state: unknown): EntryPosition | null {
  if (!state || typeof state !== "object") return null;
  const entry = (state as Record<string, unknown>)[ENTRY_KEY];
  if (!entry || typeof entry !== "object") return null;
  const { run, index } = entry as Record<string, unknown>;
  return typeof run === "string" && typeof index === "number" && Number.isSafeInteger(index) ? { run, index } : null;
}

function withPosition(state: unknown, position: EntryPosition): Record<string, unknown> {
  return { ...(state && typeof state === "object" ? state : {}), [ENTRY_KEY]: position };
}

function newRun(): EntryPosition {
  return { run: browserRandomUUID(), index: 0 };
}

/** The current entry's position, recording a new run's first one where it has none. */
function stamp(history: PositionedHistory): EntryPosition {
  const existing = positionOf(history.state);
  if (existing) return existing;
  const position = newRun();
  history.replaceState(withPosition(history.state, position), "");
  return position;
}

/**
 * Pushes `path` one position past the current entry, keeping the rest of the current state as every
 * push here always has. Anything that pushes an entry the app's own navigation can arrive at uses
 * this, or the distances counted across that entry are wrong.
 */
export function pushPositionedEntry(history: PositionedHistory, path: string): void {
  const here = positionOf(history.state);
  history.pushState(withPosition(history.state, here ? { run: here.run, index: here.index + 1 } : newRun()), "", path);
}

/**
 * Corrections one return may make before it gives up and shows where the history is. Each is needed
 * only when the person moves again before the return lands, so this is far more than a hand makes;
 * the bound guarantees that a browser behaving unlike the model below cannot keep the history moving
 * forever.
 */
export const MAX_CORRECTIONS = 32;

/** A return to the entry on screen that is under way. */
interface Return {
  then: () => void;
  /** Where the last `popstate` left the history. */
  at: EntryPosition;
  /** This class's own moves not yet arrived, in the order asked for. */
  moves: number[];
  corrections: number;
}

/** The positions of one navigation's entries: the one on screen, and the move a `popstate` made. */
export class HistoryPositions {
  private shown: EntryPosition | null = null;
  private restoring: Return | null = null;

  constructor(private readonly history: PositionedHistory) {}

  /** Records the current entry as the one on screen. */
  adopt(): void {
    this.shown = stamp(this.history);
  }

  push(path: string): void {
    pushPositionedEntry(this.history, path);
    this.shown = positionOf(this.history.state);
  }

  /**
   * After a `popstate`: `null` when the move was part of this class's own return to the entry on
   * screen, which the app must not see; otherwise the move to show, with a traversal when it can be
   * held.
   */
  arrive(): { traversal?: HistoryTraversal } | null {
    const from = this.shown;
    const to = stamp(this.history);
    const go = this.history.go?.bind(this.history);
    const restoring = this.restoring;
    if (restoring && go && from && to.run === from.run) {
      // Browsers run history moves in the order they were asked for, so an arrival that is the next
      // of this class's own moves is that move; any other is the person's, made before it landed.
      if (restoring.moves.length > 0 && restoring.at.index + restoring.moves[0]! === to.index) restoring.moves.shift();
      restoring.at = to;
      const landing = restoring.moves.reduce((index, delta) => index + delta, to.index);
      if (landing !== from.index) {
        if (++restoring.corrections <= MAX_CORRECTIONS) {
          restoring.moves.push(from.index - landing);
          go(from.index - landing);
          return null;
        }
        // Give up holding: show where the history is.
        this.restoring = null;
        this.shown = to;
        return {};
      }
      if (restoring.moves.length > 0) return null;
      this.restoring = null;
      restoring.then();
      return null;
    }
    this.restoring = null;
    this.shown = to;
    if (!go || !from || from.run !== to.run || from.index === to.index) return {};
    const delta = to.index - from.index;
    return {
      traversal: {
        undo: (then) => {
          this.shown = from;
          this.restoring = { then, at: to, moves: [-delta], corrections: 0 };
          go(-delta);
        },
        redo: () => go(delta),
      },
    };
  }
}
