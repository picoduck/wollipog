import assert from "node:assert/strict";
// The whole module, so its asynchronous execFile can be held for one exact call (review CR-3.1).
import childProcess from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentControlFifoRelays } from "./agent-control-fifo-relay.js";

const SKIP = process.platform !== "linux" ? "the FIFO relay is provisioned only on Linux" : false;

type Callback = (error: Error | null, stdout?: unknown, stderr?: unknown) => void;

test("shutdown while a channel's mkfifo is still running publishes nothing and leaves nothing", { skip: SKIP }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wollipog-fifo-relay-shutdown-"));
  const base = join(dataDir, "agent-control", "fifo-relay");
  const original = childProcess.execFile;
  let releaseMkfifo!: () => void;
  const released = new Promise<void>((resolve) => { releaseMkfifo = resolve; });
  let mkfifoFinished!: () => void;
  const finished = new Promise<void>((resolve) => { mkfifoFinished = resolve; });
  // Run this session's doorbell mkfifo for real, but deliver its result only after shutdown, so the
  // creation is provably in flight: its directory and doorbell exist and nothing is published yet.
  childProcess.execFile = ((file: string, args: readonly string[], options: object, callback: Callback) => {
    if (!file.endsWith("/mkfifo") || !args.some((arg) => arg.includes("/s_held."))) {
      return original(file, args, options, callback);
    }
    return original(file, args, options, (...result: Parameters<Callback>) => {
      mkfifoFinished();
      void released.then(() => callback(...result));
    });
  }) as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();
  const channel = new AgentControlFifoRelays(base, async () => ({ status: 200, body: "{}" }));
  try {
    const creating = channel.ensure("s_held");
    await finished;
    chmodSync(base, 0o700);
    const [directory] = readdirSync(base);
    chmodSync(base, 0o300);
    assert.match(directory ?? "", /^s_held\.[0-9a-f]{32}$/u, "the channel directory exists while mkfifo is held");

    channel.closeAllNow();
    assert.equal(existsSync(base), false, "shutdown removes the in-flight channel with everything else");
    releaseMkfifo();
    await assert.rejects(() => creating, /has shut down/, "the creation is refused once its mkfifo returns");
    assert.equal(existsSync(base), false, "nothing is recreated or published after shutdown");
    assert.doesNotThrow(() => rmSync(dataDir, { recursive: true, force: true }));
  } finally {
    releaseMkfifo();
    childProcess.execFile = original;
    syncBuiltinESMExports();
    channel.closeAllNow();
    if (existsSync(base)) chmodSync(base, 0o700);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
