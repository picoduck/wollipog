import type { SessionPromptHistoryEntry, SessionPromptHistoryPage } from "@wollipog/protocol";

export interface ComposerHistoryPrompt {
  key: string;
  text: string;
  seq?: number;
  queueId?: string;
  submissionId?: string;
}

/** Recall owns its own text-only pages. Stable identities keep prepends and live messages from
 * moving the selected prompt; generation checks keep late reads from overwriting a typed draft. */
export class ComposerHistory {
  private prompts = new Map<string, ComposerHistoryPrompt>();
  private deliveredQueues = new Set<string>();
  private current: string | null = null;
  private before: number | undefined;
  private hasMore = true;
  private generation = 0;
  private controller: AbortController | null = null;

  reset(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.current = null;
  }

  private entries(local: readonly ComposerHistoryPrompt[]): ComposerHistoryPrompt[] {
    for (const prompt of local) {
      if (prompt.seq !== undefined && prompt.queueId) {
        this.deliveredQueues.add(prompt.queueId);
        const queuedKey = `queue:${prompt.queueId}`;
        this.prompts.delete(queuedKey);
        if (this.current === queuedKey) this.current = prompt.key;
      }
      if (prompt.text && !(prompt.seq === undefined && prompt.queueId && this.deliveredQueues.has(prompt.queueId))) {
        this.prompts.set(prompt.key, prompt);
      }
    }
    return [...this.prompts.values()].sort((a, b) =>
      a.seq === undefined ? b.seq === undefined ? 0 : 1 : b.seq === undefined ? -1 : a.seq - b.seq);
  }

  private select(prompt: ComposerHistoryPrompt | undefined): string | undefined {
    if (!prompt) return undefined;
    this.current = prompt.key;
    return prompt.text;
  }

  previous(local: readonly ComposerHistoryPrompt[], read: (before: number | undefined, signal: AbortSignal) => Promise<SessionPromptHistoryPage>,
    promotedQueues: ReadonlyMap<string, string> = new Map(),
    options: { localIsTail?: boolean; localIsContiguous?: boolean } = {}): string | undefined | Promise<string | undefined> {
    if (this.controller) return undefined;
    const entries = this.entries(local);
    const needsNewest = this.current === null && options.localIsTail === false;
    if (needsNewest) { this.before = undefined; this.hasMore = true; }
    // Keep the existing instant recall for the current loaded turn and locally queued messages.
    if (this.current === null && entries.length && !needsNewest) return this.select(entries.at(-1));
    const index = entries.findIndex(prompt => prompt.key === this.current);
    const previous = index < 0 ? entries.at(-1) : entries[index - 1];
    const localIndex = local.findIndex(prompt => prompt.key === this.current);
    const localFallback = localIndex < 0 ? this.current === null ? local.at(-1) : undefined : local[localIndex - 1];
    // Adjacent messages in a contiguous loaded window never need the network. Offline/partial
    // sessions retain the recall they already had, and ordinary key repeats stay synchronous.
    if (!needsNewest && options.localIsContiguous !== false && previous &&
        localIndex >= 0 && local.some(prompt => prompt.key === previous.key)) return this.select(previous);
    // A fetched page proves this range is contiguous. Below its boundary, fetch a prompt page,
    // even if the transcript happens to contain an older prompt across an unloaded gap.
    if (!needsNewest && (!this.hasMore || (this.before !== undefined && previous &&
        (previous.seq === undefined || previous.seq >= this.before)))) return this.select(previous);
    const controller = new AbortController();
    const generation = this.generation;
    this.controller = controller;
    return (async () => {
      try {
        while (true) {
          const page = await read(this.before, controller.signal);
          if (generation !== this.generation || controller.signal.aborted) return undefined;
          if (!page.cacheComplete) throw new Error("Prompt history is still loading. Press Up to try again.");
          if (page.hasMore && (page.nextBefore === undefined ||
              (this.before !== undefined && page.nextBefore >= this.before))) {
            throw new Error("Could not load older messages. Press Up to try again.");
          }
          for (const prompt of page.prompts) this.addRemote(prompt, promotedQueues);
          this.before = page.nextBefore;
          this.hasMore = page.hasMore;
          const merged = this.entries([]);
          const currentIndex = merged.findIndex(prompt => prompt.key === this.current);
          const candidate = currentIndex < 0 ? merged.at(-1) : merged[currentIndex - 1];
          if (!this.hasMore || (candidate && (candidate.seq === undefined ||
              (this.before !== undefined && candidate.seq >= this.before)))) return this.select(candidate);
        }
      } catch (cause) {
        if (generation !== this.generation || controller.signal.aborted) return undefined;
        if (localFallback) return this.select(localFallback);
        throw cause;
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    })();
  }

  private addRemote(prompt: SessionPromptHistoryEntry, promotedQueues: ReadonlyMap<string, string>): void {
    const key = `event:${prompt.seq}`;
    const queueId = (prompt.submissionId && promotedQueues.get(prompt.submissionId)) || prompt.turnId;
    if (queueId) {
      this.deliveredQueues.add(queueId);
      const queuedKey = `queue:${queueId}`;
      this.prompts.delete(queuedKey);
      if (this.current === queuedKey) this.current = key;
    }
    if (prompt.text) this.prompts.set(key, { key, seq: prompt.seq, text: prompt.text });
  }

  next(local: readonly ComposerHistoryPrompt[]): string | undefined {
    // A Down key cancels an older-page read before moving toward the draft.
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    const entries = this.entries(local);
    const index = entries.findIndex(prompt => prompt.key === this.current);
    if (index < 0) return undefined;
    if (index + 1 < entries.length) return this.select(entries[index + 1]);
    this.current = null;
    return "";
  }
}
