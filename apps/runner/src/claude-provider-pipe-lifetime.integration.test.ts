import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { claudeProviderPipeHelper } from "./claude-provider-pipe-helper.js";

test("the real supervisor reaps an orphaned task before successful termination without bwrap cleanup", {
  skip: process.platform !== "linux", timeout: 15_000,
}, async () => {
  // Running the actual supervisor without bwrap makes a missing TERMINATE cleanup
  // deterministic: no outer namespace teardown can hide a surviving task.
  const root = mkdtempSync(join(tmpdir(), "wollipog-supervisor-lifetime-"));
  const ready = join(root, "task-pid");
  const marker = basename(root);
  const task = [
    "const fs = require('node:fs');",
    `const ready = ${JSON.stringify(ready)};`,
    "fs.writeFileSync(ready + '.tmp', String(process.pid));",
    "fs.renameSync(ready + '.tmp', ready);",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const provider = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(task)}, ${JSON.stringify(marker)}], { detached: true, stdio: 'ignore' }).unref();`;
  const token = Buffer.alloc(16, 1);
  const frame = (kind: number, generation: number, payload = Buffer.alloc(0)) => {
    const header = Buffer.alloc(26);
    header[0] = 1; header[1] = kind; token.copy(header, 2);
    header.writeUInt32BE(generation, 18); header.writeUInt32BE(payload.length, 22);
    return Buffer.concat([header, payload]);
  };
  const args = [process.execPath, "-e", provider];
  const count = Buffer.alloc(2); count.writeUInt16BE(args.length);
  const payload = Buffer.concat([count, ...args.flatMap(word => {
    const bytes = Buffer.from(word), size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); return [size, bytes];
  }), Buffer.alloc(2)]); // An empty provider environment.
  const supervisor = spawn(claudeProviderPipeHelper().path, ["--supervisor", token.toString("hex")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(supervisor, "close");
  let ended = false, providerExited = false, pid: number | undefined;
  let buffered = Buffer.alloc(0), stderr = "";
  supervisor.once("close", () => { ended = true; });
  supervisor.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-4096); });
  supervisor.stdout.on("data", (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    while (buffered.length >= 26) {
      const length = buffered.readUInt32BE(22);
      if (buffered.length < 26 + length) break;
      if (buffered[1] === 9) providerExited = true;
      buffered = buffered.subarray(26 + length);
    }
  });
  // Bound infrastructure failures as well as readiness. Cleanup below owns only
  // this supervisor and the uniquely marked fixture task.
  const deadline = setTimeout(() => { supervisor.kill("SIGKILL"); }, 10_000);
  try {
    supervisor.stdin.write(frame(2, 1, payload));
    const readyBy = Date.now() + 5_000;
    while (!providerExited || !existsSync(ready)) {
      assert.ok(!ended && Date.now() < readyBy, `fixture provider did not exit with a live task: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    pid = Number(readFileSync(ready, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.ok(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(marker));
    supervisor.stdin.end(frame(6, 0));
    const [code, signal] = await closed;
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" }, "successful TERMINATE reaped the task");
  } finally {
    clearTimeout(deadline);
    // A failed readiness check may still have produced the fixture's PID file.
    if ((pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) && existsSync(ready)) {
      pid = Number(readFileSync(ready, "utf8"));
    }
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(marker)) process.kill(pid, "SIGKILL");
      } catch { /* already exited */ }
    }
    if (!ended) supervisor.kill("SIGKILL");
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
