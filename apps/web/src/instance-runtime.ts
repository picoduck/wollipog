import { createApiClient, type ApiClient } from "./api.js";
import { createBrowserApiTransport } from "./api-transport.js";
import { openRemoteTransport, type DesktopInstanceRuntime } from "./desktop-instances.js";
import { createNativeApiTransport, type NativeInvokeRuntime } from "./native-api-transport.js";
import { createNativeUiConnection, type NativeUiRuntime } from "./native-ui-transport.js";
import { createBrowserUiConnection, type UiConnectionRuntime, type UiSocket } from "./ui-transport.js";

export interface InstanceRuntime {
  readonly instanceId: string;
  readonly publicOrigin: string;
  readonly api: ApiClient;
  readonly ui: UiConnectionRuntime;
  close(): void;
}

export interface BrowserInstanceRuntimeOptions {
  instanceId: string;
  runtimeKey: string;
  httpOrigin: string;
  websocketOrigin: string;
  token?: () => string | null;
  fetch?: typeof globalThis.fetch;
  createWebSocket?: (url: string) => UiSocket;
  onCredentialChange?: (listener: () => void) => () => void;
}

/**
 * Bind the HTTP and WebSocket clients for one browser-hosted instance into one disposable
 * generation. Desktop remote instances will provide the same interface through native IPC.
 */
export function createBrowserInstanceRuntime(options: BrowserInstanceRuntimeOptions): InstanceRuntime {
  const transport = createBrowserApiTransport({
    instanceId: options.instanceId,
    origin: options.httpOrigin,
    token: options.token,
    fetch: options.fetch,
  });
  const ui = createBrowserUiConnection({
    instanceId: options.instanceId,
    runtimeKey: options.runtimeKey,
    websocketOrigin: options.websocketOrigin,
    token: options.token,
    createWebSocket: options.createWebSocket,
    onCredentialChange: options.onCredentialChange,
  });
  return {
    instanceId: options.instanceId,
    publicOrigin: transport.publicOrigin,
    api: createApiClient(transport),
    ui,
    close() {
      ui.close();
      transport.close();
    },
  };
}

export interface NativeInstanceRuntimeOptions {
  profileId: string;
  desktop?: DesktopInstanceRuntime & NativeInvokeRuntime & NativeUiRuntime;
}

/** Open a desktop-owned remote runtime after Rust revalidates its saved identity and vault token. */
export async function createNativeInstanceRuntime(options: NativeInstanceRuntimeOptions): Promise<InstanceRuntime> {
  const handle = await openRemoteTransport(options.profileId, options.desktop);
  const transport = createNativeApiTransport({
    instanceId: handle.profileId,
    runtimeKey: handle.runtimeKey,
    publicOrigin: handle.publicOrigin,
    desktop: options.desktop,
  });
  const ui = createNativeUiConnection({
    instanceId: handle.profileId,
    runtimeKey: handle.runtimeKey,
    desktop: options.desktop,
  });
  return {
    instanceId: handle.profileId,
    publicOrigin: handle.publicOrigin,
    api: createApiClient(transport),
    ui,
    close() {
      ui.close();
      transport.close();
    },
  };
}
