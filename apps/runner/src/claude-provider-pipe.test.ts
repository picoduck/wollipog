import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "wollipog-claude-provider-pipe-"));
after(() => rmSync(root, { recursive: true, force: true }));
const worker = join(root, "provider-pipe");
const source = fileURLToPath(new URL("../native/claude-provider-pipe.c", import.meta.url));

function buildWorker(): void {
  const built = spawnSync("/usr/bin/cc", [
    "-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-static", source, "-o", worker,
  ], { timeout: 30_000, encoding: "utf8" });
  assert.equal(built.status, 0, `${built.stdout ?? ""}${built.stderr ?? ""}`);
}

interface Frame { kind: number; data: Buffer }

async function runProvider(script: string, observeAfterExitMs = 0): Promise<{ frames: Frame[]; elapsedMs: number; workerStillAlive: boolean }> {
  const child = spawn(worker, [process.execPath, "-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const frames: Frame[] = [];
  let buffered = Buffer.alloc(0);
  const began = Date.now();
  let resolveExit!: (result: { frames: Frame[]; elapsedMs: number; workerStillAlive: boolean }) => void;
  let rejectExit!: (error: Error) => void;
  const exitFrame = new Promise<{ frames: Frame[]; elapsedMs: number; workerStillAlive: boolean }>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 6) {
      assert.equal(buffered[0], 1, "worker protocol version changed");
      const length = buffered.readUInt32BE(2);
      assert.ok(length <= 16_384, "worker frame exceeded its bound");
      if (buffered.length < 6 + length) break;
      const frame = { kind: buffered[1]!, data: Buffer.from(buffered.subarray(6, 6 + length)) };
      frames.push(frame);
      buffered = buffered.subarray(6 + length);
      if (frame.kind === 3) resolveExit({ frames, elapsedMs: Date.now() - began, workerStillAlive: child.exitCode === null });
    }
  });
  child.once("error", rejectExit);
  child.once("close", (code) => {
    if (!frames.some((frame) => frame.kind === 3)) rejectExit(new Error(`worker closed without exit frame: ${code}`));
  });
  child.stdin.end();
  const deadline = setTimeout(() => rejectExit(new Error("provider exit frame timed out")), 4_000);
  try {
    const result = await exitFrame;
    if (observeAfterExitMs > 0) await new Promise((resolve) => setTimeout(resolve, observeAfterExitMs));
    return result;
  } finally {
    clearTimeout(deadline);
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  }
}

test("Linux worker drains provider bytes before exit while an inherited pipe stays open", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async () => {
  buildWorker();
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeSync } = require('node:fs');",
    "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();",
    "writeSync(1, Buffer.alloc(4 * 1024 * 1024, 65));",
    "writeSync(2, Buffer.from('final stderr'));",
  ].join(" ");
  const result = await runProvider(script);
  const stdout = Buffer.concat(result.frames.filter((frame) => frame.kind === 1).map((frame) => frame.data));
  const stderr = Buffer.concat(result.frames.filter((frame) => frame.kind === 2).map((frame) => frame.data));
  const exit = result.frames.find((frame) => frame.kind === 3);
  assert.equal(stdout.length, 4 * 1024 * 1024);
  assert.equal(stdout.subarray(0, 16).toString(), "A".repeat(16));
  assert.equal(stderr.toString(), "final stderr");
  assert.equal(exit?.data.readInt32BE(0), 0);
  assert.equal(exit?.data.readInt32BE(4), 0);
  assert.ok(result.workerStillAlive, "detached output holder should not delay provider exit");
  assert.ok(result.elapsedMs < 2_000, `provider exit frame took ${result.elapsedMs} ms`);
});

test("Linux worker reports a provider signal separately from process close", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async () => {
  buildWorker();
  const result = await runProvider("process.kill(process.pid, 'SIGTERM')");
  const exit = result.frames.find((frame) => frame.kind === 3);
  assert.equal(exit?.data.readInt32BE(0), -1);
  assert.equal(exit?.data.readInt32BE(4), 15);
});

test("Linux worker discards writes from inherited stdio after provider exit", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async () => {
  buildWorker();
  const script = [
    "const { spawn } = require('node:child_process');",
    "spawn('/bin/sh', ['-c', 'sleep .1; printf late'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();",
    "process.stdout.write('provider');",
  ].join(" ");
  const result = await runProvider(script, 300);
  assert.equal(Buffer.concat(result.frames.filter((frame) => frame.kind === 1).map((frame) => frame.data)).toString(), "provider");
  assert.equal(result.frames.filter((frame) => frame.kind === 3).length, 1);
});

test("Linux worker emits provider exit despite a descendant continuously refilling stdout", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async () => {
  buildWorker();
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeSync } = require('node:fs');",
    "spawn(process.execPath, ['-e', \"setInterval(() => process.stdout.write('x'), 1)\"], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();",
    "writeSync(1, Buffer.from('provider-result'));",
  ].join(" ");
  const result = await runProvider(script);
  const stdout = Buffer.concat(result.frames.filter((frame) => frame.kind === 1).map((frame) => frame.data));
  assert.ok(stdout.includes(Buffer.from("provider-result")));
  assert.equal(result.frames.find((frame) => frame.kind === 3)?.data.readInt32BE(0), 0);
  assert.ok(result.elapsedMs < 2_000, `continuous descendant output held the turn ${result.elapsedMs} ms`);
});
