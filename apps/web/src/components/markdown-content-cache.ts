/** Content keys include the parser profile; presentation and component state never enter the cache. */
export type MarkdownContentProfile = "document" | "inline";

export const MARKDOWN_CACHE_LIMITS = {
  entries: 256,
  sourceCharacters: 524_288,
  entryCharacters: 65_536,
} as const;

/**
 * A bounded, in-memory LRU of immutable parsed output. Both keys and parsed trees are evicted;
 * no mounted React state, DOM nodes, callbacks from callers, or persistent transcript storage.
 * Input limits bound the retained parse trees as well as their source keys. Large documents still
 * render normally, but bypass admission rather than evicting the useful working set.
 */
export class MarkdownContentCache<T> {
  private readonly entries = new Map<string, { value: T; characters: number }>();
  private characters = 0;
  private parses = 0;
  private hits = 0;

  constructor(private readonly limits: { entries: number; sourceCharacters: number; entryCharacters: number } = MARKDOWN_CACHE_LIMITS) {}

  canAdmit(profile: MarkdownContentProfile, source: string, admit = true): boolean {
    const characters = profile.length + 1 + source.length;
    return admit && this.limits.entries >= 1 && characters <= this.limits.entryCharacters && characters <= this.limits.sourceCharacters;
  }

  get(profile: MarkdownContentProfile, source: string): T | undefined {
    const key = `${profile}:${source}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.hits++;
      return cached.value;
    }
    return undefined;
  }

  render(profile: MarkdownContentProfile, source: string, parse: () => T, admit = true): T {
    const cached = this.get(profile, source);
    if (cached !== undefined) return cached;
    const key = `${profile}:${source}`;
    this.parses++;
    const value = parse();
    const characters = key.length;
    if (!this.canAdmit(profile, source, admit)) return value;
    while (this.entries.size >= this.limits.entries || this.characters + characters > this.limits.sourceCharacters) {
      const oldest = this.entries.keys().next().value!;
      this.characters -= this.entries.get(oldest)!.characters;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, characters });
    this.characters += characters;
    return value;
  }

  /** Counts only: useful for tests and synthetic profiling, never exposes transcript contents. */
  snapshot() {
    return { entries: this.entries.size, sourceCharacters: this.characters, parses: this.parses, hits: this.hits };
  }
}
