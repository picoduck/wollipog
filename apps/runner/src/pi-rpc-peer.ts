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

export class PiRpcOversizedResponseError extends PiRpcResponseError {
  constructor(command: string) {
    super(`Pi RPC ${command} response exceeded the configured size limit`, command);
    this.name = "PiRpcOversizedResponseError";
  }
}

interface PendingRequest {
  command: string;
  discardOversizedResponse: boolean;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Pi's transport is strictly LF-delimited JSONL. Scanning bytes for 0x0a preserves other valid
 * Unicode separators inside JSON strings and makes the frame-size boundary unambiguous. */
export class PiRpcPeer {
  private buffer = Buffer.alloc(0);
  private discardingOversizedFrame = false;
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
    options: { discardOversizedResponse?: boolean } = {},
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
        discardOversizedResponse: options.discardOversizedResponse === true,
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
    let incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (this.discardingOversizedFrame) {
      const newline = incoming.indexOf(0x0a);
      if (newline < 0) return;
      this.discardingOversizedFrame = false;
      incoming = incoming.subarray(newline + 1);
    }
    this.buffer = Buffer.concat([this.buffer, incoming]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > this.maxFrameBytes) {
          if (this.rejectDiscardableOversizedResponse(this.buffer)) {
            this.buffer = Buffer.alloc(0);
            this.discardingOversizedFrame = true;
          } else {
            this.fail(new PiRpcTransportError("Pi RPC frame exceeded the configured size limit"));
          }
        }
        return;
      }
      if (newline > this.maxFrameBytes) {
        const oversized = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        if (this.rejectDiscardableOversizedResponse(oversized)) continue;
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

  /** Some optional Pi introspection commands can serialize the entire transcript. A caller may
   * opt into rejecting and draining only its own oversized response while every unsolicited or
   * non-opted-in oversized frame still closes the transport. */
  private rejectDiscardableOversizedResponse(framePrefix: Buffer): boolean {
    const prefix = framePrefix.subarray(0, Math.min(framePrefix.length, 4_096)).toString("utf8");
    for (const [id, pending] of this.pending) {
      if (!pending.discardOversizedResponse) continue;
      const idFirst = `{"id":"${id}","type":"response","command":"${pending.command}",`;
      const typeFirst = `{"type":"response","id":"${id}","command":"${pending.command}",`;
      if (!prefix.startsWith(idFirst) && !prefix.startsWith(typeFirst)) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new PiRpcOversizedResponseError(pending.command));
      return true;
    }
    return false;
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
