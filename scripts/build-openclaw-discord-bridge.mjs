import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// Reuse the runner's existing esbuild toolchain; no new runtime package/install manager.
const require = createRequire(new URL("../apps/runner/package.json", import.meta.url));
const {build} = require("esbuild");
await build({entryPoints: [fileURLToPath(new URL("../apps/control-plane/src/assistant-discord-bridge.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../integrations/openclaw-discord/dist/bridge.mjs", import.meta.url)),
  bundle: true, platform: "node", format: "esm", target: "node22", sourcemap: false,
  banner: {js: 'import { createRequire as __wollipogCreateRequire } from "node:module"; const require = __wollipogCreateRequire(import.meta.url);'},
});
