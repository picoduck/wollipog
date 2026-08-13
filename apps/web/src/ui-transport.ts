export interface UiSocketMessageEvent {
  data: string;
}

export interface UiSocketCloseEvent {
  code: number;
}

export interface UiSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: UiSocketMessageEvent) => void) | null;
  onclose: ((event: UiSocketCloseEvent) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface UiConnectionRuntime {
  readonly instanceId: string;
  /** Changes whenever credentials, endpoint, or another connection-defining input changes. */
  readonly runtimeKey: string;
  createSocket(): UiSocket;
  onCredentialChange?(listener: () => void): () => void;
  close(): void;
}

export interface BrowserUiConnectionOptions {
  instanceId: string;
  runtimeKey: string;
  websocketOrigin: string;
  token?: () => string | null;
  createWebSocket?: (url: string) => UiSocket;
  onCredentialChange?: (listener: () => void) => () => void;
}

export const UI_SOCKET_OPEN = 1;
const UI_SOCKET_CLOSING = 2;
const UI_SOCKET_CLOSED = 3;

function websocketOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("The control-plane socket origin must use WS or WSS.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      value.includes("?") || value.includes("#")) {
    throw new TypeError("The control-plane socket origin must not include credentials, a path, query, or fragment.");
  }
  return url.origin;
}

/** Creates sockets bound to one immutable instance origin. */
export function createBrowserUiConnection(options: BrowserUiConnectionOptions): UiConnectionRuntime {
  const origin = websocketOrigin(options.websocketOrigin);
  const sockets = new Set<UiSocket>();
  let closed = false;
  return {
    instanceId: options.instanceId,
    runtimeKey: options.runtimeKey,
    createSocket() {
      if (closed) throw new DOMException("The instance connection is closed.", "AbortError");
      for (const socket of sockets) {
        if (socket.readyState === UI_SOCKET_CLOSING || socket.readyState === UI_SOCKET_CLOSED) {
          sockets.delete(socket);
        }
      }
      const token = options.token?.();
      const url = `${origin}/ui${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      const createSocket = options.createWebSocket ?? ((target: string) => new WebSocket(target) as UiSocket);
      const socket = createSocket(url);
      sockets.add(socket);
      return socket;
    },
    onCredentialChange: options.onCredentialChange,
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
