import type { NavigationWindow } from "./navigation.js";

/**
 * A browser's session history for tests (#3218): pushing drops the forward entries, and
 * `history.go` moves later, as a task, then fires `popstate` as browsers do. `flush` runs the moves
 * the app asked for; `traverse`, `back` and `forward` are the person pressing Back or Forward.
 */
export class TestBrowserHistory {
  entries: Array<{ path: string; state: unknown }>;
  index = 0;
  readonly window: NavigationWindow;
  private readonly listeners = new Set<() => void>();
  readonly pending: number[] = [];

  constructor(path: string) {
    this.entries = [{ path, state: null }];
    const url = () => new URL(this.path, "https://wollipog.test");
    const entries = () => this.entries;
    const at = () => this.index;
    this.window = {
      location: {
        get pathname() { return url().pathname; },
        get search() { return url().search; },
        get hash() { return url().hash; },
      },
      history: {
        get state(): unknown { return entries()[at()]!.state; },
        pushState: (state: unknown, _unused: string, path?: string | URL | null) => {
          this.entries.splice(this.index + 1, Infinity, { path: path == null ? this.path : String(path), state });
          this.index += 1;
        },
        replaceState: (state: unknown, _unused: string, path?: string | URL | null) => {
          this.entries[this.index] = { path: path == null ? this.path : String(path), state };
        },
        go: (delta = 0) => { this.pending.push(delta); },
      },
      addEventListener: (_type, listener) => { this.listeners.add(listener); },
      removeEventListener: (_type, listener) => { this.listeners.delete(listener); },
    };
  }

  get path(): string {
    return this.entries[this.index]!.path;
  }

  paths(): string[] {
    return this.entries.map((entry) => entry.path);
  }

  /** Back or Forward by the person, `delta` entries at once. */
  traverse(delta: number): void {
    this.move(delta);
  }

  back(): void { this.traverse(-1); }
  forward(): void { this.traverse(1); }

  /** Runs every `history.go` the app asked for, including any it asks for while they run. */
  flush(): void {
    for (let delta = this.pending.shift(); delta !== undefined; delta = this.pending.shift()) this.move(delta);
  }

  private move(delta: number): void {
    const next = this.index + delta;
    if (delta === 0 || next < 0 || next >= this.entries.length) return;
    this.index = next;
    for (const listener of [...this.listeners]) listener();
  }
}
