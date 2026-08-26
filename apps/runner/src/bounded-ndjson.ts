import { Buffer } from "node:buffer";

/** Large enough for image-bearing provider events, while still containing a hostile stdout line. */
export const AGENT_NDJSON_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Incrementally frames newline-delimited text without ever retaining more than maxLineBytes.
 * An oversized record is discarded through its newline, then parsing resumes with the next record.
 */
export class BoundedNdjsonBuffer {
  private buffer = "";
  private bufferBytes = 0;
  private discarding = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
    private readonly maxLineBytes = AGENT_NDJSON_MAX_LINE_BYTES,
  ) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
  }

  push(chunk: string): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.slice(offset, end);

      if (!this.discarding) {
        const segmentBytes = Buffer.byteLength(segment);
        if (segmentBytes > this.maxLineBytes - this.bufferBytes) {
          this.buffer = "";
          this.bufferBytes = 0;
          this.discarding = true;
          this.onOverflow();
        } else {
          this.buffer += segment;
          this.bufferBytes += segmentBytes;
        }
      }

      if (newline < 0) return;
      if (!this.discarding) this.onLine(this.buffer);
      this.buffer = "";
      this.bufferBytes = 0;
      this.discarding = false;
      offset = newline + 1;
    }
  }

  /** Return and clear a bounded unterminated tail. Oversized tails were already discarded. */
  takeTrailing(): string {
    const trailing = this.discarding ? "" : this.buffer;
    this.reset();
    return trailing;
  }

  reset(): void {
    this.buffer = "";
    this.bufferBytes = 0;
    this.discarding = false;
  }
}
