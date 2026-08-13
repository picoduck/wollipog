# Wollipog — desktop shell (Tauri)

A [Tauri v2](https://v2.tauri.app) window that wraps the existing web UI (`apps/web`)
in a native desktop app. The UI is unchanged — it still talks to the control plane over
HTTP/WebSocket.

To make the packaged app **self-contained**, the control plane and local runner are bundled as
[sidecars](https://v2.tauri.app/develop/sidecar/). `scripts/build-sidecar.mjs` compiles each into a
single executable (esbuild → Node SEA). On launch, the shell starts the control plane (port-gated —
if one is already running, e.g. the dev stack, it's left alone). **Connections → Set Up This
Machine** provisions a private credential and starts the bundled runner, which automatically
discovers supported native and WSL coding agents. Both managed processes stop with the app, and a
configured local runner starts again automatically on the next launch. No separate Node, `pnpm
dev`, runner installation, config file, or terminal command is required.

The managed control plane stores its local dashboard credential at a deterministic app-data path.
The shell adopts it through native IPC before the first API or live-stream connection. If the shell
finds an externally managed control plane on port 4317, it does not reuse that managed credential;
pair the desktop with the external process's startup URL.

The packaged dashboard is also copied into the app resources so the sidecar can serve it to a
paired browser. **Settings → Enable Tailnet Access** persists an opt-in desktop setting and restarts
the managed sidecar with an IPv4 wildcard listener plus `CONTROL_PLANE_TAILNET_ONLY=1`. The control
plane requires a bearer credential on loopback and accepts remote traffic only when both socket
endpoints are Tailscale CGNAT addresses and the browser has a paired-device credential. An
externally managed process already using port 4317 is never restarted or reconfigured by the
desktop setting.

## Prerequisites

- **Rust** (`rustup` + a stable toolchain).
- A platform C toolchain/linker:
  - **Windows:** Visual Studio **C++ Build Tools** (MSVC linker). On ARM64, include
    the **ARM64 VC tools** component. WebView2 ships with Windows 11.
  - **macOS:** Xcode Command Line Tools.
  - **Linux:** `webkit2gtk`, `libgtk`, etc. (see the Tauri Linux prerequisites).

## Dev

A debug build loads `http://localhost:5173`, so start the stack first, then the window
(`pnpm desktop` also rebuilds the sidecar binary, which Tauri requires to exist):

```bash
pnpm dev        # control plane (:4317) + web (:5173)
pnpm desktop    # builds the sidecar, opens the native window onto the running UI
```

## Build

```bash
pnpm desktop:build   # builds the sidecar + apps/web, then bundles the native app
```

`scripts/build-sidecar.mjs` (run by `dev`/`bundle`, or directly via
`pnpm --filter @wollipog/desktop sidecar:build`) produces
`src-tauri/binaries/control-plane-<target-triple>` and
`src-tauri/binaries/runner-<target-triple>` — standalone executables Tauri bundles as
`externalBin` sidecars.

Icons (`src-tauri/icons/`) are generated from a source image with
`pnpm --filter @wollipog/desktop tauri icon <path-to-512px.png>`.

## Releasing

CI builds the per-OS/arch bundles from a `v*` git tag. Before tagging, bump the version in
lockstep across `tauri.conf.json`, `Cargo.toml`, this app's `package.json`, and the repo-root
`package.json` — see [`docs/RELEASING.md`](../../docs/RELEASING.md).

## Layout

```
scripts/
  build-sidecar.mjs  esbuild + Node SEA -> standalone control-plane and runner binaries
src-tauri/
  Cargo.toml         Rust crate (tauri v2 + tauri-plugin-shell)
  tauri.conf.json    window + build config (devUrl / frontendDist / externalBin)
  build.rs           tauri-build codegen
  src/main.rs        binary entry -> lib::run()
  src/lib.rs         tauri::Builder setup + control-plane/local-runner sidecar lifecycle
  capabilities/      window permission set (core:default)
  binaries/          built sidecar executable (gitignored)
```
