import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeProjectPathKey, discoverClaudeTaskLifecycle, discoverIncompleteClaudeTasks, discoverIncompleteClaudeTasksInContext } from "./claude-background-work.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-claude-tasks-"));
  const tempRoot = join(root, "temp");
  const claudeHome = join(root, "home", ".claude");
  const cwd = "C:\\code\\repo.with spaces";
  const sessionId = "session-1";
  const key = claudeProjectPathKey(cwd);
  const tasks = join(tempRoot, "claude", key, sessionId, "tasks");
  const transcript = join(claudeHome, "projects", key, `${sessionId}.jsonl`);
  mkdirSync(tasks, { recursive: true });
  mkdirSync(join(claudeHome, "projects", key), { recursive: true });
  return { root, tempRoot, claudeHome, cwd, sessionId, tasks, transcript };
}

test("Claude project keys match the provider's Windows path encoding", () => {
  assert.equal(claudeProjectPathKey("C:\\Users\\misko\\repo.with spaces"), "C--Users-misko-repo-with-spaces");
});

test("task discovery returns artifacts without a completion record and ignores completed work", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.tasks, "pending.output"), "partial");
    writeFileSync(join(f.tasks, "done.output"), "complete");
    writeFileSync(f.transcript, [
      JSON.stringify({ toolUseResult: { status: "async_launched", agentId: "done" } }),
      JSON.stringify({ content: "<task-notification><task-id>done</task-id><status>completed</status></task-notification>" }),
    ].join("\n"));
    assert.deepEqual(
      discoverIncompleteClaudeTasks(f.cwd, f.sessionId, f).map((task) => task.id),
      ["pending"],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("stopped, resumed-after-completion, and unreadable-ledger tasks remain recoverable", () => {
  const f = fixture();
  try {
    for (const id of ["stopped", "resumed", "unknown"]) writeFileSync(join(f.tasks, `${id}.output`), "partial");
    writeFileSync(f.transcript, [
      JSON.stringify({ content: "<task-notification><task-id>stopped</task-id><status>stopped</status></task-notification>" }),
      JSON.stringify({ content: "<task-notification><task-id>resumed</task-id><status>completed</status></task-notification>" }),
      JSON.stringify({ toolUseResult: { resumedAgentId: "resumed" } }),
    ].join("\n"));
    assert.deepEqual(
      discoverIncompleteClaudeTasks(f.cwd, f.sessionId, f).map((task) => task.id).sort(),
      ["resumed", "stopped", "unknown"],
    );
    rmSync(f.transcript);
    assert.equal(discoverIncompleteClaudeTasks(f.cwd, f.sessionId, f).length, 3);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("only the provider ledger can prove a known task terminal", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.tasks, "live.output"), '{"status":"completed"}<task-notification>quoted</task-notification>');
    writeFileSync(f.transcript, JSON.stringify({
      content: "<task-notification><task-id>stopped</task-id><status>stopped</status></task-notification>",
    }));
    assert.equal(discoverClaudeTaskLifecycle(f.cwd, f.sessionId, "live", f), "incomplete");
    assert.equal(discoverClaudeTaskLifecycle(f.cwd, f.sessionId, "stopped", f), "incomplete");
    writeFileSync(f.transcript, JSON.stringify({
      content: "<task-notification><task-id>live</task-id><status>completed</status></task-notification>",
    }));
    assert.equal(discoverClaudeTaskLifecycle(f.cwd, f.sessionId, "live", f), "terminal");
    rmSync(f.transcript);
    assert.equal(discoverClaudeTaskLifecycle(f.cwd, f.sessionId, "live", f), "unknown");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("WSL discovery uses positional context arguments and keeps artifacts when the ledger is unreadable", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let transcriptFails = false;
  const run = async (_context: unknown, command: string, args: string[]) => {
    calls.push({ command, args });
    if (args[1]?.includes("find")) return { stdout: "pending.output\ndone.output\n", stderr: "" };
    if (transcriptFails) throw new Error("oversized");
    return {
      stdout: JSON.stringify({
        content: "<task-notification><task-id>done</task-id><status>completed</status></task-notification>",
      }),
      stderr: "",
    };
  };
  const context = { kind: "wsl" as const, distro: "Ubuntu" };
  const complete = await discoverIncompleteClaudeTasksInContext(context, "/work/repo with spaces", "session-1", {
    env: { TMPDIR: "/custom/tmp" },
    run: run as any,
  });
  assert.deepEqual(complete.map((task) => task.id), ["pending"]);
  assert.equal(complete[0]?.outputFile, "/custom/tmp/claude/-work-repo-with-spaces/session-1/tasks/pending.output");
  assert.ok(calls.every((call) => call.command === "sh" && call.args.slice(-2).join("|") === "/work/repo with spaces|session-1"));
  calls.length = 0;
  await discoverIncompleteClaudeTasksInContext(context, "/work/repo with spaces", "session-1", {
    run: run as any,
    projectsRoot: "/runner/provider-state/projects",
  });
  assert.equal(calls.at(-1)?.args.at(-1), "/runner/provider-state/projects");
  transcriptFails = true;
  const conservative = await discoverIncompleteClaudeTasksInContext(context, "/work/repo with spaces", "session-1", { run: run as any });
  assert.deepEqual(conservative.map((task) => task.id), ["pending", "done"]);
});

test("WSL discovery skips the transcript command when there is nothing to classify", async () => {
  const calls: string[][] = [];
  const empty = await discoverIncompleteClaudeTasksInContext(
    { kind: "wsl", distro: "Ubuntu" },
    "/work/repo",
    "session-1",
    {
      run: async (_context, _command, args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      },
    },
  );
  assert.deepEqual(empty, []);
  assert.equal(calls.length, 1, "an empty task directory must not trigger a 64 MiB ledger read");
  assert.match(calls[0]?.[1] ?? "", /find/);
});

test("an oversized native ledger is read once conservatively instead of loaded into memory", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.tasks, "pending.output"), "partial");
    writeFileSync(f.transcript, "");
    truncateSync(f.transcript, 64 * 1024 * 1024 + 1);
    assert.deepEqual(discoverIncompleteClaudeTasks(f.cwd, f.sessionId, f).map((task) => task.id), ["pending"]);
    assert.equal(discoverClaudeTaskLifecycle(f.cwd, f.sessionId, "pending", f), "unknown");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
