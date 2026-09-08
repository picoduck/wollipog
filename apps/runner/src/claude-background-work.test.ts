import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeProjectPathKey, discoverClaudeTaskLifecycle, discoverIncompleteClaudeTasks, discoverIncompleteClaudeTasksInContext, inspectClaudeBackgroundWork, inspectClaudeBackgroundWorkInContext } from "./claude-background-work.js";

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

test("native receipt cache avoids repeated reads and invalidates append, replacement, truncation, and roots", (t) => {
  const f = fixture();
  const notification = (id: string) => `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>`;
  let reads = 0;
  const original = fs.readFileSync;
  const spy = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === f.transcript) reads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    writeFileSync(f.transcript, `${" ".repeat(8 * 1024 * 1024)}${notification("done")}`);
    const inspect = () => inspectClaudeBackgroundWork(f.cwd, f.sessionId, ["done", "pending"], f);
    assert.deepEqual([...inspect().terminalTaskIds], ["done"]);
    for (let attempt = 0; attempt < 10; attempt++) assert.deepEqual([...inspect().terminalTaskIds], ["done"]);
    assert.equal(reads, 1, "ten unchanged retries read zero additional ledger bytes");
    const mutable = inspect();
    mutable.terminalTaskIds.clear();
    mutable.terminalTaskStatuses?.clear();
    assert.ok(inspect().terminalTaskIds.has("done"), "caller mutations do not alter cached proof");
    appendFileSync(f.transcript, notification("pending"));
    assert.equal(inspect().terminalTaskIds.size, 2);
    assert.equal(reads, 2);
    writeFileSync(`${f.transcript}.new`, notification("pending"));
    renameSync(`${f.transcript}.new`, f.transcript);
    assert.deepEqual([...inspect().terminalTaskIds], ["pending"]);
    truncateSync(f.transcript, 0);
    assert.equal(inspect().terminalTaskIds.size, 0);
    writeFileSync(f.transcript, notification("done"));
    assert.equal(inspect().terminalTaskIds.size, 1);
    writeFileSync(f.transcript, notification("else"));
    assert.equal(inspect().terminalTaskIds.size, 0, "same-length edits invalidate terminal proof");
    assert.equal(inspectClaudeBackgroundWork(f.cwd, f.sessionId, ["done"], {
      ...f, projectsRoot: join(f.root, "different-projects"),
    }).terminalTaskIds.size, 0);
    rmSync(f.transcript);
    assert.equal(inspect().terminalTaskIds.size, 0);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("WSL receipt cache revalidates fingerprints and isolates contexts and command runners", async () => {
  let version = "__WOLLIPOG_LEDGER__:1:2:100:mtime:ctime:600";
  let reads = 0;
  let changedDuringRead = false;
  const run = async (_context: unknown, _command: string, args: string[]) => {
    if (args[1]!.includes("find")) return { stdout: `done.output\n${version}\n`, stderr: "" };
    reads++;
    return { stdout: "<task-id>done</task-id><status>killed</status></task-notification>",
      stderr: changedDuringRead ? "__WOLLIPOG_LEDGER__:changed" : `WSL startup notice\n${version}\n` };
  };
  const context = { kind: "wsl" as const, distro: "test-distro" };
  const inspect = () => inspectClaudeBackgroundWorkInContext(context, "/repo", "session", ["done", "pending"], { run });
  assert.equal((await inspect()).terminalTaskStatuses?.get("done"), "killed");
  for (let retry = 0; retry < 10; retry++) assert.equal((await inspect()).terminalTaskIds.size, 1);
  assert.equal(reads, 1);
  version += ":replacement";
  await inspect();
  assert.equal(reads, 2);
  await inspectClaudeBackgroundWorkInContext({ ...context, distro: "other-distro" }, "/repo", "session", ["done", "pending"], { run });
  assert.equal(reads, 3);
  await inspectClaudeBackgroundWorkInContext(context, "/repo", "session", ["done", "pending"], { run, projectsRoot: "/sandbox/projects" });
  assert.equal(reads, 4);
  version += ":append";
  changedDuringRead = true;
  assert.equal((await inspect()).terminalTaskIds.size, 0, "a changing ledger cannot become cached completion proof");
  const unknown = await inspectClaudeBackgroundWorkInContext(context, "/repo", "session", ["done"], {
    run: async () => ({ stdout: "", stderr: "" }),
  });
  assert.equal(unknown.terminalTaskIds.size, 0);
});

test("context discovery and receipt recovery share four inspection slots", async () => {
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const run = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return { stdout: "", stderr: "" };
  };
  const operations = Array.from({ length: 12 }, (_, index) => index % 2
    ? inspectClaudeBackgroundWorkInContext({ kind: "wsl", distro: "test" }, "/repo", `session-${index}`, [], { run })
    : discoverIncompleteClaudeTasksInContext({ kind: "wsl", distro: "test" }, "/repo", `session-${index}`, { run }));
  for (let batch = 0; batch < 3; batch++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(active, 4);
    releases.splice(0).forEach((release) => release());
  }
  await Promise.all(operations);
  assert.equal(peak, 4);
  assert.equal(active, 0);
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
