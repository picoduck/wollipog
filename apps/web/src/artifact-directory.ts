import type { WorkflowArtifactPage, WorkflowArtifactView } from "@wollipog/protocol";

export type ArtifactResolution =
  | { state: "pending" }
  | { state: "resolved"; artifact: WorkflowArtifactView }
  | { state: "missing" };

const PENDING: ArtifactResolution = Object.freeze({ state: "pending" });
const MISSING: ArtifactResolution = Object.freeze({ state: "missing" });

/**
 * What one session's artifact ids name, for references in its transcript (#3970). It knows the
 * artifacts the transcript attached, and asks the session's artifact list (metadata only, under
 * the session's own access check) for any other id it is asked about, page by page until every
 * asked id is found or the list ends. It never fetches an artifact's bytes. An id the list does not
 * carry (another session's, a deleted one, or none) is missing and stays plain text; a failed list
 * read counts as missing too, so a reply never shows an error for an id it merely mentions.
 */
export class SessionArtifactDirectory {
  private readonly known = new Map<string, WorkflowArtifactView>();
  private readonly missing = new Set<string>();
  /** Asked about and not yet known; looked for by the next load. */
  private readonly wanted = new Set<string>();
  /** Asked about while a load was already past its first page: that load may not have seen them. */
  private readonly lateWanted = new Set<string>();
  private loading = false;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly resolutions = new Map<string, ArtifactResolution>();

  constructor(
    private readonly sessionId: string,
    private readonly listArtifacts: (sessionId: string, cursor?: string) => Promise<WorkflowArtifactPage>,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = (): number => this.version;

  /** Artifacts the transcript already holds: an attachment needs no list read to be named. */
  remember(artifacts: Iterable<WorkflowArtifactView>): void {
    let changed = false;
    for (const artifact of artifacts) {
      if (artifact.sessionId !== undefined && artifact.sessionId !== this.sessionId) continue;
      if (this.known.get(artifact.artifactId) === artifact) continue;
      this.known.set(artifact.artifactId, artifact);
      this.missing.delete(artifact.artifactId);
      this.resolutions.delete(artifact.artifactId);
      changed = true;
    }
    if (changed) this.notify();
  }

  /** Identity-stable per state, so a reader that compares resolutions re-renders only on change. */
  resolve(id: string): ArtifactResolution {
    const artifact = this.known.get(id);
    if (artifact) {
      let resolution = this.resolutions.get(id);
      if (resolution?.state !== "resolved" || resolution.artifact !== artifact) {
        resolution = { state: "resolved", artifact };
        this.resolutions.set(id, resolution);
      }
      return resolution;
    }
    return this.missing.has(id) ? MISSING : PENDING;
  }

  /** Look the ids up, once each; only ids this directory has not settled start a list read. */
  request(ids: Iterable<string>): void {
    let added = false;
    for (const id of ids) {
      if (this.known.has(id) || this.missing.has(id) || this.wanted.has(id)) continue;
      this.wanted.add(id);
      if (this.loading) this.lateWanted.add(id);
      added = true;
    }
    if (added && !this.loading) {
      this.loading = true;
      queueMicrotask(() => void this.load());
    }
  }

  private async load(): Promise<void> {
    this.lateWanted.clear();
    try {
      let cursor: string | undefined;
      do {
        const page = await this.listArtifacts(this.sessionId, cursor);
        this.remember(page.artifacts);
        if ([...this.wanted].every((id) => this.known.has(id))) break;
        cursor = page.nextCursor;
      } while (cursor);
    } catch {
      // The ids that were not found are missing: a mention stays text, with no error to show.
    } finally {
      const again: string[] = [];
      for (const id of this.wanted) {
        if (this.known.has(id)) continue;
        if (this.lateWanted.has(id)) again.push(id);
        else this.missing.add(id);
      }
      this.wanted.clear();
      this.lateWanted.clear();
      this.loading = false;
      this.notify();
      if (again.length > 0) this.request(again);
    }
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
