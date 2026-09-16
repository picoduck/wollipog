import type { Readable, Writable } from "node:stream";

export const PI_RPC_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class PiRpcTransportError extends Error {
  readonly transportFailure = true;

  constructor(message: string) {
    super(message);
    this.name = "PiRpcTransportError";
  }
}

export class PiRpcResponseError extends Error {
  constructor(message: string, readonly command: string) {
    super(message);
    this.name = "PiRpcResponseError";
  }
}

interface PendingRequest {
  command: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Pi's transport is strictly LF-delimited JSONL. Scanning bytes for 0x0a preserves other valid
 * Unicode separators inside JSON strings and makes the frame-size boundary unambiguous. */
export class PiRpcPeer {
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private disposed = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly onEvent: (event: Record<string, unknown>) => void,
    private readonly onError: (error: Error) => void,
    private readonly maxFrameBytes = PI_RPC_MAX_FRAME_BYTES,
  ) {
    output.on("data", (chunk: Buffer | string) => this.onData(chunk));
    output.on("error", (error: Error) => this.fail(new PiRpcTransportError(error.message)));
    input.on("error", (error: Error) => this.fail(new PiRpcTransportError(error.message)));
  }

  request<T extends Record<string, unknown> = Record<string, unknown>>(
    command: Record<string, unknown> & { type: string },
    timeoutMs = 15_000,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new PiRpcTransportError("Pi RPC transport is closed"));
    const id = `wollipog-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcTransportError(`Pi RPC ${command.type} response timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        command: command.type,
        resolve: resolve as (value: Record<string, unknown>) => void,
        reject,
        timer,
      });
      this.write({ ...command, id }, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  send(message: Record<string, unknown>): boolean {
    if (this.disposed) return false;
    this.write(message, (error) => {
      if (error) this.onError(error);
    });
    return true;
  }

  dispose(reason = "Pi RPC transport closed"): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new PiRpcTransportError(reason);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private write(message: Record<string, unknown>, done: (error?: Error) => void): void {
    let payload: string;
    try {
      payload = `${JSON.stringify(message)}\n`;
    } catch (error) {
      done(error as Error);
      return;
    }
    this.input.write(payload, "utf8", (error?: Error | null) => {
      done(error ? new PiRpcTransportError(error.message) : undefined);
    });
  }

  private onData(chunk: Buffer | string): void {
    if (this.disposed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > this.maxFrameBytes) {
          this.fail(new PiRpcTransportError("Pi RPC frame exceeded the configured size limit"));
        }
        return;
      }
      if (newline > this.maxFrameBytes) {
        this.fail(new PiRpcTransportError("Pi RPC frame exceeded the configured size limit"));
        return;
      }
      let frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      if (!frame.length) continue;
      let message: unknown;
      try {
        message = JSON.parse(frame.toString("utf8"));
      } catch {
        this.fail(new PiRpcTransportError("Pi RPC emitted malformed JSON"));
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        this.fail(new PiRpcTransportError("Pi RPC emitted a non-object frame"));
        return;
      }
      this.route(message as Record<string, unknown>);
    }
  }

  private route(message: Record<string, unknown>): void {
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success === false) {
        pending.reject(new PiRpcResponseError(
          typeof message.error === "string" ? message.error : `Pi rejected ${pending.command}`,
          pending.command,
        ));
      } else {
        pending.resolve(message);
      }
      return;
    }
    this.onEvent(message);
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.dispose(error.message);
    this.onError(error);
  }
}
