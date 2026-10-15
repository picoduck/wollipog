import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";

const available = process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/cc");
const root = mkdtempSync(join(tmpdir(), "wollipog-claude-cancel-test-"));
const tasks = join(root, "tasks");
mkdirSync(tasks);
after(() => rmSync(root, { recursive: true, force: true }));

interface Message { kind: number; generation: number; data: Buffer }

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function workerPid(marker: string): number {
  const matches: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (cmdline.startsWith("/proc/self/exe\0") && cmdline.includes(marker)) matches.push(Number(name));
    } catch { /* process exited */ }
  }
  assert.equal(matches.length, 1, `worker PID scan: ${matches}`);
  return matches[0]!;
}

test("cancel after worker EXIT is queued emits one generation EXIT and preserves retained tasks", {
  skip: !available, timeout: 20_000,
}, async () => {
  const helper = join(root, "supervisor");
  const source = fileURLToPath(new URL("../native/claude-provider-pipe.c", import.meta.url));
  const built = spawnSync("/usr/bin/cc", [
    "-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-static",
    "-DTEST_DUPLICATE_EXIT_FRAME", source, "-o", helper,
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
  let stderr = "";
  outer.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const messages: Message[] = [];
  let buffered = Buffer.alloc(0);
  outer.stdout.on("data", (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    while (buffered.length >= 26) {
      const length = buffered.readUInt32BE(22);
      assert.equal(buffered[0], 1);
      assert.ok(buffered.subarray(2, 18).equals(token));
      assert.ok(length <= 1024 * 1024);
      if (buffered.length < 26 + length) break;
      messages.push({ kind: buffered[1]!, generation: buffered.readUInt32BE(18),
        data: Buffer.from(buffered.subarray(26, 26 + length)) });
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
    await waitFor(() => messages.some((message) => message.kind === kind && message.generation === generation) ||
      outer.exitCode != null, `frame ${kind}/${generation}: ${stderr}`);
    const found = messages.find((message) => message.kind === kind && message.generation === generation);
    assert.ok(found, `supervisor exited ${outer.exitCode}: ${stderr}`);
    return found;
  };
  let stoppedSupervisor: number | undefined;
  try {
    await until(1, 0);
    start(1, "require('node:child_process').spawn('/bin/sh',['-c','sleep .3; echo kept > /tmp/claude/earlier-task; sleep 8'],{detached:true,stdio:['ignore','inherit','inherit']}).unref()");
    await until(12, 1);
    assert.equal((await until(9, 1)).data.readInt32BE(0), 0);
    const marker = `cancel-race-${process.pid}-${Date.now()}`;
    start(2, `const fs=require('node:fs');require('node:child_process').spawn('/bin/sleep',['8'],{detached:true,stdio:['ignore','inherit','inherit']}).unref();process.stdout.write('armed');const timer=setInterval(()=>{if(fs.existsSync('/tmp/claude/release')){clearInterval(timer);process.exit(0)}},1);/*${marker}*/`);
    await until(12, 2);
    await until(7, 2);
    const worker = workerPid(marker);
    const provider = Number(readFileSync(`/proc/${worker}/task/${worker}/children`, "utf8").trim());
    assert.ok(Number.isSafeInteger(provider) && provider > 0);
    const status = readFileSync(`/proc/${worker}/status`, "utf8");
    const supervisor = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
    assert.ok(Number.isSafeInteger(supervisor) && supervisor > 0);
    process.kill(supervisor, "SIGSTOP");
    stoppedSupervisor = supervisor;
    writeFileSync(join(tasks, "release"), "go");
    await waitFor(() => !existsSync(`/proc/${provider}`), "provider exit while supervisor stopped");
    await new Promise((resolve) => setTimeout(resolve, 80));
    process.kill(worker, "SIGUSR1"); // what a queued CANCEL delivers before supervisor reads worker EXIT
    await new Promise((resolve) => setTimeout(resolve, 80));
    process.kill(supervisor, "SIGCONT");
    stoppedSupervisor = undefined;
    assert.equal((await until(9, 2)).data.readInt32BE(0), 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(messages.filter((message) => message.kind === 9 && message.generation === 2).length, 1,
      "worker cancellation duplicated a completed generation EXIT");
    await waitFor(() => existsSync(join(tasks, "earlier-task")), "earlier task output");
    assert.equal(readFileSync(join(tasks, "earlier-task"), "utf8").trim(), "kept");
    assert.equal(outer.exitCode, null);
    start(3, "process.stdout.write('next')");
    await until(12, 3);
    assert.equal((await until(9, 3)).data.readInt32BE(0), 0);
    // Independently fault-inject two EXIT frames from a worker. The
    // supervisor must never synthesize a third one after forwarding the first.
    const duplicateMarker = `duplicate-exit-${process.pid}-${Date.now()}`;
    start(4, `const fs=require('node:fs');process.stdout.write('armed');const timer=setInterval(()=>{if(fs.existsSync('/tmp/claude/release-duplicate')){clearInterval(timer);process.exit(0)}},1);/*${duplicateMarker}*/`,
      ["WOLLIPOG_TEST_DUPLICATE_EXIT_FRAME=1"]);
    await until(12, 4);
    await until(7, 4);
    const duplicateWorker = workerPid(duplicateMarker);
    const duplicateProvider = Number(readFileSync(`/proc/${duplicateWorker}/task/${duplicateWorker}/children`, "utf8").trim());
    assert.ok(Number.isSafeInteger(duplicateProvider) && duplicateProvider > 0);
    process.kill(supervisor, "SIGSTOP");
    stoppedSupervisor = supervisor;
    writeFileSync(join(tasks, "release-duplicate"), "go");
    await waitFor(() => !existsSync(`/proc/${duplicateProvider}`), "fault-injected provider exit");
    process.kill(supervisor, "SIGCONT");
    stoppedSupervisor = undefined;
    assert.equal((await until(9, 4)).data.readInt32BE(0), 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(messages.filter((message) => message.kind === 9 && message.generation === 4).length, 1,
      "supervisor reported a second EXIT after a worker protocol violation");
    assert.equal(readFileSync(join(tasks, "earlier-task"), "utf8").trim(), "kept");
    start(5, "process.stdout.write('still-ready')");
    await until(12, 5);
    assert.equal((await until(9, 5)).data.readInt32BE(0), 0);
    send(6, 0);
    await new Promise<void>((resolve) => outer.once("close", () => resolve()));
  } finally {
    if (stoppedSupervisor) {
      try { process.kill(stoppedSupervisor, "SIGCONT"); } catch { /* already gone */ }
    }
    if (outer.pid && outer.exitCode == null) {
      try { process.kill(-outer.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});
