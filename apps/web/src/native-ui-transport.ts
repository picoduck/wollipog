import { Channel, invoke } from "@tauri-apps/api/core";
import type { UiConnectionRuntime, UiSocket, UiSocketCloseEvent } from "./ui-transport.js";

export type NativeUiEvent =
  | { type: "open" }
  | { type: "message"; data: string }
  | { type: "error" }
  | { type: "close"; code: number };

export interface NativeUiChannel<T> {
  onmessage: (event: T) => void;
}

export interface NativeUiRuntime {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  channel<T>(): NativeUiChannel<T>;
}

const runtime: NativeUiRuntime = {
  invoke,
  channel<T>() { return new Channel<T>(); },
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class NativeUiSocket implements UiSocket {
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: UiSocketCloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  private handlersReady = false;
  private pending: NativeUiEvent[] = [];

  constructor(
    private readonly desktop: NativeUiRuntime,
    private readonly runtimeKey: string,
  private readonly socketId: string,
  channel: NativeUiChannel<NativeUiEvent>,
  ) {
    channel.onmessage = (event) => {
      if (!this.handlersReady) this.pending.push(event);
      else this.receive(event);
    };
    this.opened = desktop.invoke<void>("remote_ui_open", {
      runtimeKey,
      socketId,
      onEvent: channel,
    }).catch(() => this.fail());
    queueMicrotask(() => {
      this.handlersReady = true;
      for (const event of this.pending.splice(0)) this.receive(event);
    });
  }

  private readonly opened: Promise<void>;

  private receive(event: NativeUiEvent): void {
    if (this.readyState === CLOSED) return;
    if (event.type === "open") {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.();
    } else if (event.type === "message") {
      if (this.readyState === OPEN) this.onmessage?.({ data: event.data });
    } else if (event.type === "error") {
      if (this.readyState < CLOSED) this.onerror?.();
    } else {
      this.finish(event.code);
    }
  }

  private fail(): void {
    if (this.readyState === CLOSED) return;
    this.onerror?.();
    this.finish(1006);
  }

  private finish(code: number): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.({ code });
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new DOMException("The socket is not open.", "InvalidStateError");
    void this.desktop.invoke("remote_ui_send", {
      runtimeKey: this.runtimeKey,
      socketId: this.socketId,
      data,
    }).catch(() => this.fail());
  }

  close(): void {
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    void this.opened.then(() => this.desktop.invoke("remote_ui_close", {
        runtimeKey: this.runtimeKey,
        socketId: this.socketId,
      })).catch(() => {});
    this.finish(1000);
  }
}

export interface NativeUiConnectionOptions {
  instanceId: string;
  runtimeKey: string;
  desktop?: NativeUiRuntime;
}

export function createNativeUiConnection(options: NativeUiConnectionOptions): UiConnectionRuntime {
  const desktop = options.desktop ?? runtime;
  const sockets = new Set<NativeUiSocket>();
  let nextSocket = 0;
  let closed = false;
  return {
    instanceId: options.instanceId,
    runtimeKey: options.runtimeKey,
    createSocket() {
      if (closed) throw new DOMException("The instance connection is closed.", "AbortError");
      for (const socket of sockets) {
        if (socket.readyState === CLOSED) sockets.delete(socket);
      }
      const socket = new NativeUiSocket(desktop, options.runtimeKey, `socket-${++nextSocket}`, desktop.channel());
      sockets.add(socket);
      return socket;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        socket.close();
      }
      sockets.clear();
    },
  };
}
