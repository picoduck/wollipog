import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { SessionEventPayload } from "@wollipog/protocol";

export interface RetentionSource { path: string; bytes: number; sha256?: string }
export interface RetentionEvent { seq: number; ts: number; payload: SessionEventPayload }

/** Bounded reads, record buffers and parsing slices. The caller pins the source topology and
 * checks its identity again before publication. No provider-native files are ever opened. */
export async function scanRetentionSources(
  sources: RetentionSource[], maxRecordBytes: number,
  visit: (event: RetentionEvent, line: Buffer) => Promise<void> | void,
  prunedThrough = 0,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let previous = 0;
  for (const source of sources) {
    const handle = await open(source.path, "r");
    const hash = createHash("sha256");
    let pending = Buffer.alloc(0);
    try {
      for (let offset = 0; offset < source.bytes;) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, source.bytes - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) throw new Error("retention source was truncated");
        offset += bytesRead;
        hash.update(chunk.subarray(0, bytesRead));
        const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let start = 0;
        for (;;) {
          const end = data.indexOf(10, start);
          if (end < 0) break;
          if (end - start > maxRecordBytes) throw new Error("retention record exceeds history page limit");
          const line = data.subarray(start, end + 1);
          const event = JSON.parse(decoder.decode(line)) as RetentionEvent;
          if (!Number.isSafeInteger(event.seq) || event.seq <= previous ||
              (event.seq !== previous + 1 && !(previous < prunedThrough && event.seq <= prunedThrough + 1)) ||
              !Number.isFinite(event.ts) || typeof event.payload?.kind !== "string") {
            throw new Error("invalid retention source event");
          }
          previous = event.seq;
          await visit(event, line);
          start = end + 1;
        }
        pending = Buffer.from(data.subarray(start));
        if (pending.length > maxRecordBytes) throw new Error("retention record exceeds history page limit");
        await yieldToLoop();
      }
      if (pending.length) throw new Error("retention source has a torn suffix");
      if (source.sha256 && hash.digest("hex") !== source.sha256) throw new Error("retention source failed integrity verification");
    } finally { await handle.close(); }
  }
}

/** The last untagged response is a contiguous run, ignoring usage records, matching #2777. */
const REMOVABLE = new Set(["agent_thought", "tool_call", "tool_call_update", "command_output",
  "file_edit", "stderr", "status", "error", "plan"]);

export class RetentionResponse {
  messageId: string | undefined;
  afterSeq = 0;
  lastSeq = 0;
  private boundary = 0;
  observe(event: RetentionEvent): void {
    const p = event.payload;
    if (p.kind === "agent_message" && p.parentToolUseId === undefined) {
      this.messageId = p.messageId;
      this.afterSeq = this.boundary;
      this.lastSeq = event.seq;
    }
    if (p.kind !== "token_usage" && !(p.kind === "agent_message" &&
        p.parentToolUseId === undefined && p.messageId === undefined && !p.final)) this.boundary = event.seq;
  }
  keep(event: RetentionEvent): boolean {
    const p = event.payload;
    if (p.kind === "agent_message") return p.parentToolUseId === undefined && (
      (p.final === true && p.text.trim() !== "") ||
      (this.messageId !== undefined ? p.messageId === this.messageId :
        p.messageId === undefined && event.seq > this.afterSeq && event.seq <= this.lastSeq));
    // Remove only known transcript-only kinds. Unknown/additive audit and resume evidence is
    // retained conservatively, including checkpoints, approvals, reviews and provenance.
    return !REMOVABLE.has(p.kind);
  }
}
