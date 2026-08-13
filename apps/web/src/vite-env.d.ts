/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTROL_PLANE_HTTP?: string;
  readonly VITE_CONTROL_PLANE_WS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
