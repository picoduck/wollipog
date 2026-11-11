// Dormant fixed MCP-child launcher. No provider launch references this module.
// One bounded private frame precedes the RPC stream; the frame never reaches the MCP child.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { constants } from "node:os";

const FAILURE = "Pi inert control entrypoint refused execution.\n";
const MAX_FRAME = 262_144;
let child;
let completed = false;
let failed = false;
const deadline = setTimeout(fail, 5_000);
function fail() {
  if (failed || completed) return;
  failed = true;
  clearTimeout(deadline);
  process.stdin.destroy();
  child?.kill("SIGKILL");
  process.stderr.write(FAILURE);
  process.exitCode = 125;
}
process.stdout.on("error", fail);
process.stderr.on("error", () => { process.exitCode = 125; });

function launch(bytes) {
  const [runtime, entrypoint, cwd, ...extra] = process.argv.slice(2);
  if (extra.length || [runtime, entrypoint, cwd].some(path => !path || !isAbsolute(path) || realpathSync(path) !== path)) throw new Error();
  const payload = JSON.parse(bytes.toString("utf8"));
  if (!payload || Array.isArray(payload) || Object.keys(payload).sort().join(",") !== "env,version" ||
      payload.version !== 1 || !payload.env || typeof payload.env !== "object" || Array.isArray(payload.env)) throw new Error();
  const entries = Object.entries(payload.env);
  if (entries.length > 256) throw new Error();
  const env = Object.create(null);
  for (const [key, value] of entries) {
    if (key.length > 256 || !(key === "HOME" || key === "PATH" || key === "LANG" || /^WOLLIPOG_[A-Z0-9_]+$/u.test(key)) ||
        typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 32_768) throw new Error();
    env[key] = value;
  }
  if (env.PATH !== "/usr/bin:/bin" || env.LANG !== "C" || !env.HOME || realpathSync(env.HOME) !== env.HOME) throw new Error();
  // The executable, loader flags and MCP selector are fixed. Environment cannot inject Node/ELF
  // loader options. No executable/argv field is accepted from the handoff or RPC messages.
  child = spawn(runtime, ["--no-addons", "--no-global-search-paths", entrypoint, "--agent-control-mcp"],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.once("error", fail);
  child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.once("close", (code, signal) => {
    completed = true;
    clearTimeout(deadline);
    process.stdin.destroy(); // Child exit must not wait forever on an open RPC input.
    if (!failed) process.exitCode = code ?? (signal && constants.signals[signal] ? 128 + constants.signals[signal] : 125);
  });
  clearTimeout(deadline);
}

// Incremental framing bounds allocation before JSON.parse. Sequential writes propagate
// backpressure; only the post-frame bytes are forwarded to the helper's stdin.
void (async () => {
  const header = Buffer.alloc(4);
  let headerSize = 0, length = 0, size = 0;
  let chunks = [];
  try {
    for await (const chunk of process.stdin) {
      let offset = 0;
      if (!child) {
        if (headerSize < 4) {
          const amount = Math.min(4 - headerSize, chunk.length);
          chunk.copy(header, headerSize, 0, amount); headerSize += amount; offset += amount;
          if (headerSize !== 4) continue;
          length = header.readUInt32BE();
          if (!length || length > MAX_FRAME) throw new Error();
        }
        const amount = Math.min(length - size, chunk.length - offset);
        chunks.push(chunk.subarray(offset, offset + amount)); size += amount; offset += amount;
        if (size !== length) continue;
        launch(Buffer.concat(chunks, length)); chunks = [];
      }
      if (offset < chunk.length) {
        await new Promise((resolve, reject) => child.stdin.write(chunk.subarray(offset), error => error ? reject(error) : resolve()));
      }
    }
    if (!child) throw new Error();
    if (!completed) child.stdin.end();
  } catch { if (!completed) fail(); }
})();
