import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type WriterKind = "agent_tui" | "provider";

/** Admission evidence for host agent writers. A root process exiting, a session disappearing,
 * or a runner restart cannot substitute for a complete process-tree exit proof. */
export class ReviewWriterRegistry {
  private readonly entries = new Map<string, { sessionId: string; kind: WriterKind; file?: string }>();

  constructor(private readonly directory?: string) {
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const file = join(directory, name);
      let sessionId = "unknown (unreadable agent writer record)";
      let kind: WriterKind = "agent_tui";
      try {
        const record = JSON.parse(readFileSync(file, "utf8")) as { sessionId?: unknown; kind?: unknown };
        if (typeof record.sessionId === "string" && record.sessionId) sessionId = record.sessionId;
        if (record.kind === "provider") kind = "provider";
      } catch { /* A partial pre-spawn write is uncertain evidence too. */ }
      this.entries.set(`recovered:${name}`, { sessionId, kind, file });
    }
  }

  acquire(sessionId: string, kind: WriterKind): string {
    const id = randomUUID();
    const file = this.directory ? join(this.directory, `${id}.json`) : undefined;
    // Publish before anything can spawn. Even a partial constructor/launch failure must retain
    // its evidence when no exact process-tree proof can settle it.
    if (file) writeFileSync(file, JSON.stringify({ sessionId, kind }), { flag: "wx", mode: 0o600 });
    this.entries.set(id, { sessionId, kind, ...(file ? { file } : {}) });
    return id;
  }

  retire(id: string, proven: boolean): boolean {
    if (!proven) return false;
    const entry = this.entries.get(id);
    if (!entry) return true;
    if (entry.file) {
      try { unlinkSync(entry.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    this.entries.delete(id);
    return true;
  }

  sessions(kind?: WriterKind): string[] {
    return [...new Set([...this.entries.values()].filter((entry) => !kind || entry.kind === kind)
      .map((entry) => entry.sessionId))];
  }
}
