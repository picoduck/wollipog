import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { AgentContext } from "@wollipog/protocol";
import { transferClaudeAccountTranscript, WSL_TRANSFER } from "./claude-account-transcript.js";

const id = "11111111-2222-4333-8444-555555555555";
const exec = promisify(execFile);

function snapshotFixture(root: string): unknown[] {
  const entries: unknown[] = [];
  const visit = (relative: string) => {
    const path = join(root, relative);
    const info = lstatSync(path);
    entries.push({
      path: relative, directory: info.isDirectory(), mode: info.mode,
      mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
      contents: info.isFile() ? readFileSync(path).toString("hex") : null,
    });
    if (info.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(relative, entry));
    }
  };
  visit("");
  return entries;
}

const invalidIds = [
  "", ".", "../selected", "../../selected", "nested/selected", "nested\\selected",
  "..\\..\\selected", "selected.jsonl", "space id", "semi;id", "dollar$id",
  "line\nid", "accent-é", "emoji-🦆", "nul\0id",
];

for (const context of [{ kind: "native" }, { kind: "wsl", distro: "synthetic-unused-distro" }] satisfies AgentContext[]) {
  for (const existingStore of [false, true]) {
    test(`${context.kind}: unsafe conversation IDs leave an ${existingStore ? "existing" : "absent"} destination store untouched`, async (t) => {
      for (const unsafeId of invalidIds) {
        await t.test(JSON.stringify(unsafeId), async (t) => {
          const root = mkdtempSync(join(tmpdir(), "claude-transfer-unsafe-"));
          t.after(() => rmSync(root, { recursive: true, force: true }));
          const source = join(root, "source");
          const target = join(root, "target");
          mkdirSync(join(source, "projects", "project"), { recursive: true });
          mkdirSync(target);
          writeFileSync(join(source, "projects", "project", `${id}.jsonl`), "synthetic selected conversation\n");
          // A removed guard would resolve ../../selected outside the project store, but
          // everything it could read or overwrite here still belongs to this fixture.
          for (const home of [source, target]) mkdirSync(join(home, "selected"));
          writeFileSync(join(source, "selected.jsonl"), "synthetic traversal conversation\n");
          writeFileSync(join(source, "selected", "child.jsonl"), "synthetic source child\n");
          writeFileSync(join(target, "selected", "child.jsonl"), "retained target child\n");
          writeFileSync(join(target, "marker.txt"), "retained target marker\n");
          if (existingStore) {
            mkdirSync(join(target, "projects", "project"), { recursive: true });
            writeFileSync(join(target, "projects", "project", `${id}.jsonl`), "retained destination conversation\n");
          }
          const before = snapshotFixture(root);
          try {
            // WSL must refuse in the shared entry point before dispatching any command;
            // these cases require neither an installed distro nor a real account home.
            await assert.rejects(transferClaudeAccountTranscript(context, unsafeId, source, target), {
              message: "the provider conversation id is unsafe for transcript transfer",
            });
          } finally {
            assert.deepEqual(snapshotFixture(root), before, "unsafe ID changed fixture contents or metadata");
          }
        });
      }
    });
  }
}

test("native: the full allowed ID alphabet still transfers only the selected conversation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "claude-transfer-safe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  const safeId = "Az_09-valid";
  mkdirSync(join(source, "projects", "project"), { recursive: true });
  mkdirSync(target);
  writeFileSync(join(source, "projects", "project", `${safeId}.jsonl`), "synthetic selected conversation\n");
  writeFileSync(join(source, "projects", "project", `${id}.jsonl`), "synthetic other conversation\n");
  const before = snapshotFixture(source);
  await transferClaudeAccountTranscript({ kind: "native" }, safeId, source, target);
  assert.equal(readFileSync(join(target, "projects", "project", `${safeId}.jsonl`), "utf8"), "synthetic selected conversation\n");
  assert.deepEqual(readdirSync(join(target, "projects", "project")), [`${safeId}.jsonl`]);
  assert.deepEqual(snapshotFixture(source), before);
});

for (const implementation of ["native", "WSL shell"] as const) {
  // Run the exact WSL script locally: its filesystem behavior and argument quoting need no
  // installed distro. Windows uses the native path tests; the shell suite runs on POSIX hosts.
  const run = async (source: string, target: string) => implementation === "native"
    ? transferClaudeAccountTranscript({ kind: "native" }, id, source, target)
    : exec("sh", ["-c", WSL_TRANSFER, "sh", source, target, id]);
  const skip = implementation === "WSL shell" && process.platform === "win32";

  test(`${implementation}: transfer preserves conversation and subagent history, without copying other account data`, { skip }, async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-transfer-"));
    try {
      const source = join(root, "source ; $literal");
      const target = join(root, "target ' spaces");
      for (const home of [source, target]) mkdirSync(join(home, "projects", "project", id, "subagents"), { recursive: true });
      const file = (home: string) => join(home, "projects", "project", `${id}.jsonl`);
      const child = (home: string) => join(home, "projects", "project", id, "subagents", "agent-1.jsonl");
      writeFileSync(file(source), "conversation\n");
      writeFileSync(child(source), "child conversation\n");
      writeFileSync(join(source, ".credentials.json"), "source credential");
      writeFileSync(join(target, ".credentials.json"), "target credential");
      writeFileSync(join(target, "projects", "project", "other.jsonl"), "other conversation");
      for (const home of [source, target]) mkdirSync(join(home, "projects", "project", "memory"));
      writeFileSync(join(source, "projects", "project", "memory", "MEMORY.md"), "source project memories");
      writeFileSync(join(target, "projects", "project", "memory", "MEMORY.md"), "target project memories");
      await run(source, target);
      assert.equal(readFileSync(file(target), "utf8"), "conversation\n");
      assert.equal(readFileSync(child(target), "utf8"), "child conversation\n");
      assert.equal(readFileSync(join(target, ".credentials.json"), "utf8"), "target credential");
      assert.equal(readFileSync(join(target, "projects", "project", "other.jsonl"), "utf8"), "other conversation");
      assert.equal(readFileSync(join(target, "projects", "project", "memory", "MEMORY.md"), "utf8"), "target project memories");
      writeFileSync(file(target), "conversation\nnew turn\n");
      await run(target, source);
      assert.equal(readFileSync(file(source), "utf8"), "conversation\nnew turn\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`${implementation}: missing source uses existing target history, but absent or ambiguous history fails`, { skip }, async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-transfer-missing-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      for (const home of [source, target]) mkdirSync(join(home, "projects", "project"), { recursive: true });
      const destination = join(target, "projects", "project", `${id}.jsonl`);
      await assert.rejects(run(source, target));
      writeFileSync(destination, "destination history");
      await run(source, target);
      assert.equal(readFileSync(destination, "utf8"), "destination history");
      for (const project of ["project", "duplicate"]) {
        mkdirSync(join(source, "projects", project), { recursive: true });
        writeFileSync(join(source, "projects", project, `${id}.jsonl`), "source history");
      }
      await assert.rejects(run(source, target));
      assert.equal(readFileSync(destination, "utf8"), "destination history");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`${implementation}: configured home aliases and an already shared projects store remain usable`, { skip: skip || process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-transfer-alias-"));
    try {
      const source = join(root, "source");
      const realTarget = join(root, "target");
      const alias = join(root, "alias");
      mkdirSync(join(source, "projects", "project"), { recursive: true });
      mkdirSync(realTarget);
      symlinkSync(realTarget, alias, "dir");
      writeFileSync(join(source, "projects", "project", `${id}.jsonl`), "source history");
      await run(source, alias);
      assert.equal(readFileSync(join(realTarget, "projects", "project", `${id}.jsonl`), "utf8"), "source history");

      const sharedHome = join(root, "shared-home");
      mkdirSync(sharedHome);
      symlinkSync(join(source, "projects"), join(sharedHome, "projects"), "dir");
      await run(source, sharedHome);
      assert.equal(readFileSync(join(sharedHome, "projects", "project", `${id}.jsonl`), "utf8"), "source history");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`${implementation}: refuses a destination transcript symlink`, { skip: skip || process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-transfer-link-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      for (const home of [source, target]) mkdirSync(join(home, "projects", "project"), { recursive: true });
      writeFileSync(join(source, "projects", "project", `${id}.jsonl`), "source history");
      const outside = join(root, "outside");
      writeFileSync(outside, "retained");
      symlinkSync(outside, join(target, "projects", "project", `${id}.jsonl`));
      await assert.rejects(run(source, target));
      assert.equal(readFileSync(outside, "utf8"), "retained");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
