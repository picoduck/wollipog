import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureLiveProcess, terminateOriginalProcess, waitForLiveProcessPidFile } from "../test-support/posix-process.js";

test("an empty but existing PID file waits for a live child", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-pid-handoff-"));
  const file = join(dir, "child.pid");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    writeFileSync(file, "");
    const handoff = waitForLiveProcessPidFile(file, 1_000);
    writeFileSync(file, String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeFileSync(file, `${child.pid}\n`);
    const identity = await handoff;
    assert.equal(identity?.pid, child.pid);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture teardown never signals a process with a changed identity", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const identity = await captureLiveProcess(child.pid!);
    assert.ok(identity);
    assert.equal(await terminateOriginalProcess({ ...identity, startedAt: "another process" }), false);
    assert.equal((await captureLiveProcess(child.pid!))?.startedAt, identity.startedAt);
    assert.equal(await terminateOriginalProcess(identity), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
