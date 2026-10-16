import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";

const available = process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/cc");
const root = mkdtempSync(join(tmpdir(), "wollipog-claude-cap-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const helper = join(root, "supervisor");
const tasks = join(root, "tasks");
mkdirSync(tasks);

interface Message { kind: number; generation: number; data: Buffer }

test("retired worker cap refuses only that start and retains earlier background work", {
  skip: !available, timeout: 20_000,
}, async () => {
  const source = fileURLToPath(new URL("../native/claude-provider-pipe.c", import.meta.url));
  const built = spawnSync("/usr/bin/cc", [
    "-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-static",
    "-DMAX_RETIRED_WORKERS=2", "-DTEST_CLOSE_WORKER_STDIN", source, "-o", helper,
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(built.status, 0, built.stderr);
  const token = randomBytes(16);
  const target = "/tmp/wollipog-claude-provider-pipe";
  const outer = spawn("/usr/bin/bwrap", [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--dir", "/tmp/claude", "--bind", tasks, "/tmp/claude",
    "--ro-bind", helper, target, "--", target, "--supervisor", token.toString("hex"),
  ], { stdio: ["pipe", "pipe", "pipe"], detached: true });
  const messages: Message[] = [];
  let buffered = Buffer.alloc(0);
  let stderr = "";
  outer.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  outer.stdout.on("data", (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    while (buffered.length >= 26) {
      const length = buffered.readUInt32BE(22);
      assert.equal(buffered[0], 1);
      assert.ok(buffered.subarray(2, 18).equals(token));
      assert.ok(length <= 1024 * 1024);
      if (buffered.length < 26 + length) break;
      messages.push({
        kind: buffered[1]!,
        generation: buffered.readUInt32BE(18),
        data: Buffer.from(buffered.subarray(26, 26 + length)),
      });
      buffered = buffered.subarray(26 + length);
    }
  });
  const send = (kind: number, generation: number, payload = Buffer.alloc(0)) => {
    const header = Buffer.alloc(26);
    header[0] = 1; header[1] = kind;
    token.copy(header, 2);
    header.writeUInt32BE(generation, 18);
    header.writeUInt32BE(payload.length, 22);
    outer.stdin.write(Buffer.concat([header, payload]));
  };
  const start = (generation: number, script: string, env: string[] = []) => {
    const argv = [process.execPath, "-e", script];
    const parts: Buffer[] = [Buffer.alloc(2)];
    parts[0]!.writeUInt16BE(argv.length);
    for (const arg of argv) {
      const data = Buffer.from(arg);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      parts.push(length, data);
    }
    const envCount = Buffer.alloc(2);
    envCount.writeUInt16BE(env.length);
    parts.push(envCount);
    for (const entry of env) {
      const data = Buffer.from(entry);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      parts.push(length, data);
    }
    send(2, generation, Buffer.concat(parts));
  };
  const until = async (kind: number, generation: number): Promise<Message> => {
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      const found = messages.find((message) => message.kind === kind && message.generation === generation);
      if (found) return found;
      if (outer.exitCode != null) throw new Error(`supervisor exited ${outer.exitCode}: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`supervisor did not send ${kind}/${generation}: ${stderr}`);
  };
  try {
    await until(1, 0);
    for (const generation of [1, 2]) {
      const script = `require('node:child_process').spawn('/bin/sh',['-c','sleep 1; echo kept > /tmp/claude/task-${generation}; sleep 3'],{detached:true,stdio:['ignore','inherit','inherit']}).unref();process.stdout.write('launched')`;
      start(generation, script);
      await until(12, generation);
      assert.equal((await until(9, generation)).data.readInt32BE(0), 0);
    }
    start(3, "process.stdout.write('must not run')");
    const rejected = await until(10, 3);
    assert.equal(rejected.data.toString(), "retained provider drainer limit");
    assert.equal(messages.some((message) => message.kind === 12 && message.generation === 3), false);
    assert.equal(messages.some((message) => message.kind === 9 && message.generation === 3), false);
    assert.equal(outer.exitCode, null);
    for (let i = 0; i < 200 && (!existsSync(join(tasks, "task-1")) || !existsSync(join(tasks, "task-2"))); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(readFileSync(join(tasks, "task-1"), "utf8").trim(), "kept");
    assert.equal(readFileSync(join(tasks, "task-2"), "utf8").trim(), "kept");
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    // Invalid START is a generation-scoped refusal even if CANCEL was already
    // queued behind it. A second stale-generation ERROR would dispose older
    // retained tasks in the host virtual-provider adapter.
    send(2, 4, Buffer.alloc(0));
    send(5, 4);
    assert.equal((await until(10, 4)).data.toString(), "invalid provider start");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(messages.filter((message) => message.kind === 10 && message.generation === 4)
      .map((message) => message.data.toString()), ["invalid provider start"]);
    assert.equal(readFileSync(join(tasks, "task-1"), "utf8").trim(), "kept");
    start(5, "require('node:child_process').spawn('/bin/sh',['-c','sleep .3; echo survived > /tmp/claude/epipe-retained; sleep 2'],{detached:true,stdio:'ignore'}).unref();process.stdout.write(require('node:fs').readFileSync('/tmp/claude/task-1','utf8'))");
    await until(12, 5);
    assert.equal((await until(9, 5)).data.readInt32BE(0), 0);
    assert.equal(Buffer.concat(messages.filter((message) => message.kind === 7 && message.generation === 5).map((message) => message.data)).toString().trim(), "kept");
    // The worker drops its input read end after READY. A write then gets EPIPE;
    // only generation 6 may fail, while generation 5's detached task survives.
    start(6, "setTimeout(()=>{},1000)", ["WOLLIPOG_TEST_CLOSE_WORKER_STDIN=1"]);
    await until(12, 6);
    send(3, 6, Buffer.from("prompt"));
    await until(13, 6);
    send(5, 6);
    await until(9, 6);
    for (let i = 0; i < 100 && !existsSync(join(tasks, "epipe-retained")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(readFileSync(join(tasks, "epipe-retained"), "utf8").trim(), "survived");
    assert.equal(outer.exitCode, null);
    const closed = new Promise<number | null>((resolve) => outer.once("close", resolve));
    send(6, 0);
    assert.equal(await closed, 0);
  } finally {
    if (outer.pid && outer.exitCode == null) {
      try { process.kill(-outer.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});
