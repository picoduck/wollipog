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
 * Corrections one return may make before it stops. Each is needed only when the person moves again
 * before the return lands, so this is far more than a hand makes; the bound guarantees that a browser
 * behaving unlike the model below cannot keep the history moving forever.
 */
export const MAX_CORRECTIONS = 32;

/**
 * How long a return waits for a move it asked for before taking it to have landed nowhere. A move
 * past either end of the history fires no `popstate`; that happens when the person moved first.
 * Same-document moves land within a frame or two, so this is only ever reached by such a move.
 */
export const RETURN_QUIET_MS = 1000;

/** A return to the entry on screen that is under way. */
interface Return {
  then: () => void;
  /** Where the last `popstate` left the history, or `null` in another run, where it cannot be placed. */
  at: EntryPosition | null;
  /** This class's own moves not yet arrived, in the order asked for. */
  moves: number[];
  corrections: number;
  quiet?: ReturnType<typeof setTimeout>;
}

/** The positions of one navigation's entries: the one on screen, and the move a `popstate` made. */
export class HistoryPositions {
  private shown: EntryPosition | null = null;
  /**
   * The furthest entry of the shown run known to exist. A move past it lands nowhere and fires no
   * `popstate`. Entries after the shown one may exist unseen (a reload keeps them), so this can be
   * short of the real last entry; arrivals extend it.
   */
  private last: EntryPosition | null = null;
  private restoring: Return | null = null;

  constructor(private readonly history: PositionedHistory) {}

  /** Records the current entry as the one on screen. */
  adopt(): void {
    this.shown = this.see(stamp(this.history));
  }

  push(path: string): void {
    pushPositionedEntry(this.history, path);
    const pushed = positionOf(this.history.state)!;
    // A push drops every entry after the one it leaves.
    this.last = pushed;
    this.shown = pushed;
  }

  private see(position: EntryPosition): EntryPosition {
    if (!this.last || this.last.run !== position.run || this.last.index < position.index) this.last = position;
    return position;
  }

  /**
   * After a `popstate`: `null` when the move was part of this class's own return to the entry on
   * screen, which the app must not see; otherwise the move to show, with a traversal when it can be
   * held.
   */
  arrive(): { traversal?: HistoryTraversal } | null {
    const from = this.shown;
    const to = this.see(stamp(this.history));
    const go = this.history.go?.bind(this.history);
    const restoring = this.restoring;
    if (restoring && go && from) {
      this.settle(restoring, from, to, go);
      return null;
    }
    this.shown = to;
    if (!go || !from || from.run !== to.run || from.index === to.index) return {};
    const delta = to.index - from.index;
    return {
      traversal: {
        undo: (then) => {
          this.shown = from;
          const restoring: Return = { then, at: to, moves: [-delta], corrections: 0 };
          this.restoring = restoring;
          go(-delta);
          this.waitFor(restoring, from, go);
        },
        redo: () => go(delta),
      },
    };
  }

  /**
   * Takes a return one step on from where `to` left the history: done once it is back on `from` with
   * nothing still to land, otherwise corrected with one more move. The editor stays on screen
   * throughout, whatever happens to the history.
   */
  private settle(restoring: Return, from: EntryPosition, to: EntryPosition | null, go: (delta: number) => void): void {
    clearTimeout(restoring.quiet);
    const next = restoring.moves[0];
    if (to && to.run !== from.run) {
      // In another run: the next own move, if it lands before this run's first entry, put it here.
      if (next !== undefined && restoring.at && restoring.at.index + next < 0) restoring.moves.shift();
      restoring.at = null;
      this.waitFor(restoring, from, go);
      return;
    }
    // An arrival that one of this class's own moves would make is taken to be that move; any other
    // is the person's, made before it landed. Own moves land in the order asked for, so the ones
    // before it landed nowhere.
    if (to && restoring.at) {
      const before = restoring.at.index;
      const landed = restoring.moves.findIndex((delta) => before + delta === to.index);
      if (landed >= 0) restoring.moves.splice(0, landed + 1);
    }
    if (to) restoring.at = to;
    const at = restoring.at;
    if (!at) {
      this.waitFor(restoring, from, go);
      return;
    }
    // The moves still to come run from here, in order. One that would pass the last entry never
    // lands (the person's move got there first), so it is not waited for.
    let landing = at.index;
    restoring.moves = restoring.moves.filter((delta) => {
      if (landing + delta > this.last!.index) return false;
      landing += delta;
      return true;
    });
    if (landing !== from.index) {
      if (++restoring.corrections > MAX_CORRECTIONS) {
        this.stop(at);
        return;
      }
      restoring.moves.push(from.index - landing);
      go(from.index - landing);
    } else if (restoring.moves.length === 0) {
      this.restoring = null;
      restoring.then();
      return;
    }
    this.waitFor(restoring, from, go);
  }

  /** Moves that have not landed after a quiet spell landed nowhere: settle from where things are. */
  private waitFor(restoring: Return, from: EntryPosition, go: (delta: number) => void): void {
    clearTimeout(restoring.quiet);
    restoring.quiet = setTimeout(() => {
      if (this.restoring !== restoring) return;
      restoring.moves = [];
      if (restoring.at) this.settle(restoring, from, null, go);
      else this.stop(null);
    }, RETURN_QUIET_MS);
  }

  /**
   * Stops a return that cannot be completed. The editor stays on screen and is not asked, and its
   * draft is kept; the next Back or Forward counts from where the history actually is.
   */
  private stop(at: EntryPosition | null): void {
    if (this.restoring) clearTimeout(this.restoring.quiet);
    this.restoring = null;
    this.shown = at ?? stamp(this.history);
  }
}
