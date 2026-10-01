import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { transferCodexAccountTranscript, WSL_CODEX_TRANSFER } from "./codex-account-transcript.js";

const exec = promisify(execFile);
const id = "11111111-2222-4333-8444-555555555555";
const childId = "22222222-2222-4333-8444-555555555555";
const grandchildId = "33333333-2222-4333-8444-555555555555";
const otherId = "44444444-2222-4333-8444-555555555555";
const path = (home: string, threadId = id, archived = false) => join(home,
  archived ? "archived_sessions" : "sessions", "2026", "09", "30", `rollout-2026-09-30T12-00-00-${threadId}.jsonl`);
function write(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function header(threadId: string, parent?: string): string {
  return JSON.stringify({ type: "session_meta", payload: { id: threadId, ...(parent ? { parent_thread_id: parent } : {}) } }) + "\n";
}

for (const implementation of ["native", "WSL shell"] as const) {
  const skip = implementation === "WSL shell" && process.platform === "win32";
  const run = async (source: string, target: string): Promise<boolean> => {
    if (implementation === "native") return transferCodexAccountTranscript({ kind: "native" }, id, source, target);
    const result = await exec("sh", ["-c", WSL_CODEX_TRANSFER, "sh", source, target, id]);
    return result.stdout.trim() !== "missing";
  };

  test(`${implementation}: Codex transfers only the conversation family and preserves account memories and databases`, { skip }, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-transfer-"));
    try {
      const source = join(root, "source ; $literal");
      const target = join(root, "target ' spaces");
      for (const home of [source, target]) mkdirSync(home);
      write(path(source), header(id) + "parent history\n");
      write(path(source, childId, true), header(childId, id) + "child history\n");
      write(path(source, grandchildId), JSON.stringify({ type: "session_meta", payload: {
        id: grandchildId, source: { subagent: { thread_spawn: { parent_thread_id: childId } } },
      } }) + "\ngrandchild history\n");
      // A similarly named field inside unrelated metadata must not admit another conversation.
      write(path(source, otherId), JSON.stringify({ type: "session_meta", payload: {
        id: otherId, metadata: { parent_thread_id: id },
      } }) + "\nunrelated history\n");
      write(path(target, otherId), "target unrelated history\n");
      for (const home of [source, target]) {
        write(join(home, "auth.json"), home === source ? "source credential" : "target credential");
        write(join(home, "state_5.sqlite"), home === source ? "source index and memory state" : "target index and memory state");
        write(join(home, "memories", "memory_summary.md"), home === source ? "work memories" : "personal memories");
      }
      assert.equal(await run(source, target), true);
      for (const [threadId, archived] of [[id, false], [childId, true], [grandchildId, false]] as const) {
        assert.equal(readFileSync(path(target, threadId, archived), "utf8"), readFileSync(path(source, threadId, archived), "utf8"));
      }
      assert.equal(readFileSync(path(target, otherId), "utf8"), "target unrelated history\n");
      assert.equal(readFileSync(join(target, "auth.json"), "utf8"), "target credential");
      assert.equal(readFileSync(join(target, "state_5.sqlite"), "utf8"), "target index and memory state");
      assert.equal(readFileSync(join(target, "memories", "memory_summary.md"), "utf8"), "personal memories");
      write(path(target), header(id) + "parent history\nnew turn\n");
      write(path(target, childId, true), header(childId, id) + "child history\nnew child turn\n");
      assert.equal(await run(target, source), true);
      assert.match(readFileSync(path(source), "utf8"), /new turn/);
      assert.match(readFileSync(path(source, childId, true), "utf8"), /new child turn/);
      assert.equal(readFileSync(join(source, "memories", "memory_summary.md"), "utf8"), "work memories");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`${implementation}: Codex reports missing history, reuses exact target history and refuses ambiguity`, { skip }, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-transfer-missing-"));
    try {
      const source = join(root, "source"); const target = join(root, "target");
      for (const home of [source, target]) mkdirSync(home);
      assert.equal(await run(source, target), false);
      write(path(target), header(id) + "target history\n");
      assert.equal(await run(source, target), true);
      assert.match(readFileSync(path(target), "utf8"), /target history/);
      write(path(source), header(id) + "source history\n");
      write(path(source, id, true), header(id) + "duplicate history\n");
      await assert.rejects(run(source, target));
      assert.match(readFileSync(path(target), "utf8"), /target history/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`${implementation}: Codex accepts a configured home alias and refuses transcript and directory symlinks`, { skip: skip || process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-transfer-link-"));
    try {
      const source = join(root, "source"); const target = join(root, "target"); const alias = join(root, "alias");
      for (const home of [source, target]) mkdirSync(home);
      symlinkSync(target, alias, "dir");
      write(path(source), header(id));
      assert.equal(await run(source, alias), true);
      const outside = join(root, "outside"); write(outside, "retained");
      rmSync(path(target)); symlinkSync(outside, path(target));
      await assert.rejects(run(source, target));
      assert.equal(readFileSync(outside, "utf8"), "retained");
      rmSync(join(target, "sessions"), { recursive: true });
      mkdirSync(join(root, "outside-directory"));
      symlinkSync(join(root, "outside-directory"), join(target, "sessions"), "dir");
      await assert.rejects(run(source, target));
      assert.equal(existsSync(join(root, "outside-directory", "2026")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`${implementation}: Codex reuses an already shared rollout store`, { skip: skip || process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-transfer-shared-"));
    try {
      const source = join(root, "source"); const target = join(root, "target");
      mkdirSync(target);
      write(path(source), header(id) + "shared history\n");
      symlinkSync(join(source, "sessions"), join(target, "sessions"), "dir");
      assert.equal(await run(source, target), true);
      assert.match(readFileSync(path(source), "utf8"), /shared history/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
