// Dormant Pi prototype only. Runs inside the command namespace with a fixed loader environment.
// The private stdin payload is never copied into argv, files, logs or error messages.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

const FAILURE = "Pi command-home prototype entrypoint refused execution.\n";
const MAX_BYTES = 262_144;
let child;
let failed = false;
function fail() {
  if (failed) return;
  failed = true;
  clearTimeout(deadline);
  process.stdin.destroy();
  child?.kill("SIGKILL");
  process.stderr.write(FAILURE);
  process.exitCode = 125;
}
process.stdout.on("error", fail);
process.stderr.on("error", () => { process.exitCode = 125; });
const deadline = setTimeout(fail, 5_000);
const chunks = [];
let size = 0;
process.stdin.on("error", fail);
process.stdin.on("data", chunk => {
  size += chunk.length;
  if (size > MAX_BYTES) { fail(); return; }
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  clearTimeout(deadline);
  if (failed) return;
  try {
    const [shell, cwd, ...extra] = process.argv.slice(2);
    if (extra.length || !shell || !cwd || !isAbsolute(shell) || !isAbsolute(cwd) ||
        realpathSync(shell) !== shell || realpathSync(cwd) !== cwd) throw new Error();
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    chunks.length = 0;
    if (!payload || Array.isArray(payload) || Object.keys(payload).sort().join(",") !== "command,env,version" ||
        payload.version !== 1 || typeof payload.command !== "string" || payload.command.includes("\0") ||
        Buffer.byteLength(payload.command) > 65_536 || !payload.env || Array.isArray(payload.env) ||
        typeof payload.env !== "object") throw new Error();
    const entries = Object.entries(payload.env);
    if (entries.length > 256) throw new Error();
    const env = Object.create(null);
    for (const [key, value] of entries) {
      // Process environments support exported shell-function names too; only '=' and NUL
      // are structurally invalid. Values remain in the child environment, never argv.
      if (!key || key.length > 256 || /[=\0]/u.test(key) || typeof value !== "string" ||
          value.includes("\0") || Buffer.byteLength(value) > 32_768) throw new Error();
      env[key] = value;
    }
    child = spawn(shell, ["-c", payload.command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.once("error", fail);
    child.stdout.on("error", fail); child.stderr.on("error", fail);
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.once("close", (code, signal) => {
      if (!failed) process.exitCode = code ?? (signal && constants.signals[signal] ? 128 + constants.signals[signal] : 125);
    });
  } catch { fail(); }
});
