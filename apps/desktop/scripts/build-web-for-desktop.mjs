/**
 * Build the web app for the DESKTOP bundle — §23.6.
 *
 * The only difference is `WOLLIPOG_DESKTOP_BUILD=1`, which makes the Vite plugin drop `sw.js`,
 * `manifest.webmanifest`, and the manifest link. A shell prefix (`VAR=1 pnpm …`) does not work on
 * Windows and `cross-env` would be a dependency added for one variable, so this sets it directly.
 */
import { spawn } from "node:child_process";

const child = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@wollipog/web", "build"],
  {
    stdio: "inherit",
    env: { ...process.env, WOLLIPOG_DESKTOP_BUILD: "1" },
    shell: process.platform === "win32",
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
