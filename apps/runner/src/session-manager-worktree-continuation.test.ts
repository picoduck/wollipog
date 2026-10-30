import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionWorktreeIsolationNotice } from "@wollipog/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DriverCallbacks } from "./drivers/driver.js";
import { SessionManager, worktreeContinuationPrompt } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

// #3810: a session that switches to a worktree its live sandbox cannot write is relaunched there
// when its turn ends. When the session's own turn made that switch, the runner continues the task
// with one automatic turn instead of going idle until someone sends a message.

async function waitFor(predicate: () => boolean, message: string, attempts = 800): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

/** Long enough for a wrongly scheduled continuation, or a second one, to have started. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
}

function haveGit(): boolean {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

interface Switched {
  worktree: { path: string; branch: string };
  isolation: SessionWorktreeIsolationNotice;
}

/** A provider whose turn for `text` stays open while `during` runs, as an agent's tool call does. */
function fakeProvider(options: { during?: (text: string) => Promise<void>; failRelaunch?: boolean }) {
  const prompts: Array<{ cwd: string; text: string }> = [];
  let launches = 0;
  const factory = (
    _driver: unknown,
    launch: { cwd: string },
    cb: DriverCallbacks,
  ) => {
    launches++;
    const relaunch = launches > 1;
    return {
      pid: launches,
      initialize: async () => {
        if (relaunch && options.failRelaunch) throw new Error("provider failed to start");
      },
      newSession: async () => {},
      close: async () => {},
      prompt: async (text: string) => {
        prompts.push({ cwd: launch.cwd, text });
        cb.onPromptAccepted?.();
        await options.during?.(text);
        cb.onEvent({ kind: "agent_message", text: `answer to: ${text.slice(0, 40)}`, final: true });
        return "end_turn" as const;
      },
      cancel: () => {},
      dispose: () => {},
      setConfig: () => {},
      resolvePermission: () => false,
      agentSessionId: () => "provider-session-id",
    };
  };
  return { factory, prompts, launches: () => launches };
}

function claudeSpec(sessionId: string, repo: string): SessionLaunchSpec {
  return {
    sessionId, workspaceId: "repo", workspacePath: repo, agentId: "claude",
    command: "claude", args: [], env: {}, useWorktree: false, driver: "claude-code",
    context: { kind: "native" },
  };
}

interface Harness {
  manager: SessionManager;
  store: SessionStore;
  sessionId: string;
  fake: ReturnType<typeof fakeProvider>;
  sent: RunnerToControlPlane[];
}

async function withSession(
  name: string,
  options: {
    during?: (harness: Harness, text: string) => Promise<void>;
    /** The live process cannot write a worktree created after it launched, as in production. */
    managedGitBoundary?: boolean;
    failRelaunch?: boolean;
  },
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `wollipog-worktree-continuation-${name}-`));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));
    const sent: RunnerToControlPlane[] = [];
    let harness!: Harness;
    const fake = fakeProvider({
      during: options.during ? (text) => options.during!(harness, text) : undefined,
      failRelaunch: options.failRelaunch,
    });
    manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);
    const sessionId = `s_continuation_${name.replaceAll("-", "_")}`;
    harness = { manager, store, sessionId, fake, sent };
    await manager.start(claudeSpec(sessionId, repo));
    if (options.managedGitBoundary !== false) {
      const internals = manager as unknown as { active: Map<string, { managedGitBoundary?: true }> };
      internals.active.get(sessionId)!.managedGitBoundary = true;
    }
    await body(harness);
    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
}

function stderr(store: SessionStore, sessionId: string): string[] {
  return store.readEvents(sessionId).flatMap((event) =>
    event.payload.kind === "stderr" ? [event.payload.text] : []);
}

test("a session's own switch to a worktree it cannot write continues there once after the relaunch (#3810)", { skip: !haveGit() }, async () => {
  let switched: Switched | undefined;
  await withSession("own", {
    during: async ({ manager, sessionId }, text) => {
      if (text !== "start the fix") return;
      switched = await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/own-switch" }, undefined,
        { requestedBySession: true });
    },
  }, async ({ manager, store, sessionId, fake }) => {
    manager.prompt(sessionId, "start the fix");
    await waitFor(() => fake.prompts.length === 2, "the session did not continue after the relaunch");
    assert.deepEqual(switched?.isolation, { writableNow: false, writableAtNextLaunch: true, continuesAfterRelaunch: true },
      "the agent is told to end its turn and that the work continues on its own");
    const worktree = { path: switched!.worktree.path, branch: "fix/own-switch" };
    assert.deepEqual(fake.prompts[1], { cwd: worktree.path, text: worktreeContinuationPrompt(worktree) },
      "the continuation runs in the new worktree, in the relaunched provider");
    assert.equal(fake.launches(), 2);
    await waitFor(() => store.readMeta(sessionId)?.status === "idle", "the continuation turn did not finish");

    // Exactly one: the continuation turn ends without a switch, and nothing follows it.
    await settle();
    assert.equal(fake.prompts.length, 2, "a continuation never chains into another");
    assert.equal(fake.launches(), 2);
    assert.equal(store.readMeta(sessionId)?.status, "idle");
    const notices = stderr(store, sessionId);
    assert.ok(notices.includes("Relaunching this session in worktree fix/own-switch so it can write there. " +
      "It continues the task on its own once the relaunch finishes."), notices.join("\n"));
    assert.ok(notices.includes("Runner continued the task in worktree fix/own-switch after relaunching the session there."),
      notices.join("\n"));
    // The automatic turn is never shown as something a person typed.
    assert.equal(store.readEvents(sessionId).filter((event) => event.payload.kind === "user_message").length, 1);
  });
});

test("a switch someone else made, or one the live sandbox can already write, relaunches without continuing (#3810)", { skip: !haveGit() }, async () => {
  for (const [name, requestedBySession, managedGitBoundary] of [
    ["other", false, true],
    ["writable", true, false],
  ] as const) {
    let switched: Switched | undefined;
    await withSession(name, {
      managedGitBoundary,
      during: async ({ manager, sessionId }, text) => {
        if (text !== "start the fix") return;
        switched = await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: `fix/${name}` }, undefined,
          { requestedBySession });
      },
    }, async ({ manager, store, sessionId, fake }) => {
      manager.prompt(sessionId, "start the fix");
      await waitFor(() => fake.launches() === 2 && store.readMeta(sessionId)?.status === "idle",
        `${name}: the relaunch did not finish`);
      await settle();
      assert.equal(fake.prompts.length, 1, `${name}: the session waits for the next prompt as before`);
      assert.equal(switched?.isolation.continuesAfterRelaunch, undefined, name);
      assert.equal(switched?.isolation.writableNow, !managedGitBoundary, name);
      assert.equal(stderr(store, sessionId).some((text) => text.startsWith("Relaunching this session")), false, name);

      // The next prompt runs in the selected worktree, as it always has.
      manager.prompt(sessionId, "next");
      await waitFor(() => fake.prompts.length === 2, `${name}: the next prompt did not run`);
      assert.equal(fake.prompts[1]!.cwd, switched!.worktree.path, name);
    });
  }
});

test("an interrupt, a waiting prompt, or a failed relaunch each prevent the continuation (#3810)", { skip: !haveGit() }, async () => {
  // Interrupting the turn that switched says a person is deciding what runs next.
  await withSession("interrupted", {
    during: async ({ manager, sessionId }, text) => {
      if (text !== "start the fix") return;
      await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/interrupted" }, undefined,
        { requestedBySession: true });
      manager.interruptTurn(sessionId);
    },
  }, async ({ manager, store, sessionId, fake }) => {
    manager.prompt(sessionId, "start the fix");
    await waitFor(() => fake.launches() === 2 && store.readMeta(sessionId)?.status === "idle",
      "the relaunch after the interrupt did not finish");
    await settle();
    assert.equal(fake.prompts.length, 1);
    assert.equal(stderr(store, sessionId).some((text) => text.startsWith("Relaunching this session")), false);
  });

  // A prompt sent while the turn ran is the next turn, and no continuation follows it.
  await withSession("queued", {
    during: async ({ manager, sessionId }, text) => {
      if (text !== "start the fix") return;
      await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/queued" }, undefined,
        { requestedBySession: true });
      manager.prompt(sessionId, "a message sent meanwhile");
    },
  }, async ({ manager, store, sessionId, fake }) => {
    manager.prompt(sessionId, "start the fix");
    await waitFor(() => fake.prompts.length === 2 && store.readMeta(sessionId)?.status === "idle",
      "the waiting prompt did not run");
    await settle();
    assert.deepEqual(fake.prompts.map((prompt) => prompt.text), ["start the fix", "a message sent meanwhile"]);
    assert.notEqual(fake.prompts[1]!.cwd, fake.prompts[0]!.cwd, "the waiting prompt runs in the new worktree");
  });

  // A relaunch that fails leaves the session to a person, and says why.
  await withSession("failed", {
    failRelaunch: true,
    during: async ({ manager, sessionId }, text) => {
      if (text !== "start the fix") return;
      await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/failed" }, undefined,
        { requestedBySession: true });
    },
  }, async ({ manager, store, sessionId, fake }) => {
    manager.prompt(sessionId, "start the fix");
    await waitFor(() => fake.launches() === 2 && store.readMeta(sessionId)?.status !== "running",
      "the failed relaunch did not settle");
    await settle();
    assert.equal(fake.prompts.length, 1);
    assert.equal(stderr(store, sessionId).some((text) => text.startsWith("Runner continued the task")), false);
  });
});
