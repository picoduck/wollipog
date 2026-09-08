import { randomUUID } from "node:crypto";
import type {
  SessionSnapshot,
  SessionWorktreeProgressMessage,
  SessionWorktreeProgressPhase,
  SessionWorktreeView,
} from "@wollipog/protocol";

export interface WorktreeCreateCoordinates {
  runnerId: string;
  sessionId: string;
  branch: string;
  baseRef?: string;
}

export interface WorktreeCreateCompletion {
  snapshot: SessionSnapshot;
  worktree?: SessionWorktreeView;
}

export type WorktreeCreateOperation =
  | { id: string; status: "in_progress"; phase?: SessionWorktreeProgressPhase }
  | ({ id: string; status: "completed" } & WorktreeCreateCompletion)
  | { id: string; status: "failed"; error: string };

interface Entry extends WorktreeCreateCoordinates {
  key: string;
  operation: WorktreeCreateOperation;
  expiry?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TERMINAL_RETENTION_MS = 5 * 60_000;

/**
 * Coordinates retryable HTTP requests with one exact runner request. Progress and completion stay
 * correlated to the runner, session, and request id that created the entry; terminal state is
 * retained briefly so a polling client can recover after its original connection disappears.
 */
export class WorktreeCreateCoordinator {
  private readonly entriesByKey = new Map<string, Entry>();
  private readonly entriesById = new Map<string, Entry>();

  constructor(
    private readonly terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
    private readonly createId: () => string = () => `worktree_${randomUUID().slice(0, 8)}`,
  ) {}

  startOrJoin(
    coordinates: WorktreeCreateCoordinates,
    start: (requestId: string) => Promise<WorktreeCreateCompletion>,
  ): WorktreeCreateOperation {
    const key = JSON.stringify([
      coordinates.runnerId,
      coordinates.sessionId,
      coordinates.baseRef ?? null,
      coordinates.branch,
    ]);
    const existing = this.entriesByKey.get(key);
    if (existing) return existing.operation;

    const id = this.createId();
    const entry: Entry = {
      ...coordinates,
      key,
      operation: { id, status: "in_progress" },
    };
    this.entriesByKey.set(key, entry);
    this.entriesById.set(id, entry);

    // Defer runner work so the first caller is always acknowledged before a fast completion.
    void Promise.resolve()
      .then(() => start(id))
      .then((completion) => {
        if (this.entriesById.get(id) !== entry) return;
        entry.operation = { id, status: "completed", ...completion };
        this.retainTerminal(entry);
      })
      .catch((error: unknown) => {
        if (this.entriesById.get(id) !== entry) return;
        entry.operation = {
          id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        this.retainTerminal(entry);
      });

    return entry.operation;
  }

  recordProgress(runnerId: string, message: SessionWorktreeProgressMessage): boolean {
    const entry = this.entriesById.get(message.requestId);
    if (!entry || entry.operation.status !== "in_progress") return false;
    if (entry.runnerId !== runnerId || entry.sessionId !== message.sessionId) return false;
    entry.operation = { id: message.requestId, status: "in_progress", phase: message.phase };
    return true;
  }

  releaseTerminal(id: string): void {
    const entry = this.entriesById.get(id);
    if (!entry || entry.operation.status === "in_progress") return;
    this.deleteEntry(entry);
  }

  invalidateSession(sessionId: string): void {
    for (const entry of this.entriesById.values()) {
      if (entry.sessionId === sessionId) this.deleteEntry(entry);
    }
  }

  private retainTerminal(entry: Entry): void {
    entry.expiry = setTimeout(() => this.deleteEntry(entry), this.terminalRetentionMs);
    entry.expiry.unref?.();
  }

  private deleteEntry(entry: Entry): void {
    if (entry.expiry) clearTimeout(entry.expiry);
    if (this.entriesById.get(entry.operation.id) === entry) this.entriesById.delete(entry.operation.id);
    if (this.entriesByKey.get(entry.key) === entry) this.entriesByKey.delete(entry.key);
  }
}
