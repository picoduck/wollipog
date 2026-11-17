import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const hardening = fileURLToPath(new URL("./runner-process-hardening.ts", import.meta.url));

/** Starts a Node process, signals it the way a same-user agent could, and reports whether the
 * inspector began listening. */
async function inspectorOpensOnSignal(hardened: boolean): Promise<boolean> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const code = hardened
    ? `const { refuseSignalInspector } = await import(${JSON.stringify(hardening)}); refuseSignalInspector(); console.log("ready"); setTimeout(() => {}, 10000);`
    : `console.log("ready"); setTimeout(() => {}, 10000);`;
  const child = spawn(process.execPath, ["--import", "tsx", `--inspect-port=${port}`, "--input-type=module", "-e", code],
    { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => { if (String(chunk).includes("ready")) resolve(); });
      child.once("exit", () => reject(new Error("probe exited early")));
    });
    process.kill(child.pid!, "SIGUSR1");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
  } finally {
    child.kill("SIGKILL");
  }
}

test("SIGUSR1 cannot open the runner's inspector to read credentials from its memory", { timeout: 30_000 }, async () => {
  assert.equal(await inspectorOpensOnSignal(false), true, "the probe detects Node's default behavior");
  assert.equal(await inspectorOpensOnSignal(true), false, "a hardened runner keeps its inspector closed");
});
