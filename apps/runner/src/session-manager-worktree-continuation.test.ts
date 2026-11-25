import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionWorktreeIsolationNotice } from "@wollipog/protocol";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { SessionManager, worktreeContinuationPrompt } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

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
function fakeProvider(options: {
  during?: (text: string) => Promise<void>;
  failRelaunch?: boolean;
  /** Runs before the numbered provider launch finishes starting. */
  beforeInitialize?: (launch: number) => Promise<void>;
}) {
  const prompts: Array<{ cwd: string; text: string }> = [];
  const launchEnvironments: DriverOptions["env"][] = [];
  let launches = 0;
  const factory = (
    _driver: unknown,
    launch: Pick<DriverOptions, "cwd" | "env">,
    cb: DriverCallbacks,
  ) => {
    launches++;
    launchEnvironments.push(launch.env);
    const generation = launches;
    const relaunch = launches > 1;
    return {
      pid: launches,
      initialize: async () => {
        await options.beforeInitialize?.(generation);
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
  return { factory, prompts, launches: () => launches, launchEnvironments };
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
    beforeInitialize?: (launch: number) => Promise<void>;
    prepareLaunch?: (meta: SessionMeta) => void;
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
      beforeInitialize: options.beforeInitialize,
    });
    manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);
    if (options.prepareLaunch) Object.defineProperty(manager, "prepareLaunch", { value: options.prepareLaunch });
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
  const sentinel = randomUUID();
  await withSession("own", {
    prepareLaunch: (meta) => {
      if (meta.worktreePath) meta.env = { TEST_LAUNCH_ENV: sentinel };
    },
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
    assert.equal(fake.launchEnvironments[1]?.TEST_LAUNCH_ENV, sentinel);
    store.flush(sessionId);
    const directory = store.sessionPath(sessionId);
    assert.deepEqual(store.readMeta(sessionId)?.env, {});
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")).env, {});
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      assert.equal(readFileSync(join(entry.parentPath, entry.name)).includes(sentinel), false, entry.name);
    }
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

/** A promise the test resolves, and one that resolves when the code under test reaches it. */
function gate() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  return { open, arrived, wait: () => { reached(); return opened; } };
}

test("an interrupt that lands while the switch is still activating is not undone when activation finishes (#3810)", { skip: !haveGit() }, async () => {
  const activation = gate();
  let switched: Promise<Switched> | undefined;
  let interrupted: string | undefined;
  await withSession("interrupt-mid-activation", {
    during: async ({ manager, sessionId }, text) => {
      if (text !== "start the fix") return;
      // Hold activation where it reads the live sandbox, after the request was admitted for this turn.
      const internals = manager as unknown as {
        worktreeIsolationNotice: (meta: unknown, path: string) => Promise<SessionWorktreeIsolationNotice>;
      };
      const notice = internals.worktreeIsolationNotice.bind(manager);
      internals.worktreeIsolationNotice = async (meta, path) => {
        await activation.wait();
        return notice(meta, path);
      };
      switched = manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/interrupt-mid-activation" },
        undefined, { requestedBySession: true });
      await activation.arrived;
      interrupted = manager.interruptTurn(sessionId);
      activation.open();
      await switched;
    },
  }, async ({ manager, store, sessionId, fake }) => {
    manager.prompt(sessionId, "start the fix");
    await waitFor(() => fake.launches() === 2 && store.readMeta(sessionId)?.status === "idle",
      "the relaunch after the interrupt did not finish");
    await settle();
    assert.equal(interrupted, "applied");
    assert.equal(fake.prompts.length, 1, "the interrupted turn's switch does not restart the work");
    assert.equal((await switched!).isolation.continuesAfterRelaunch, undefined);
    assert.equal(stderr(store, sessionId).some((text) => text.startsWith("Relaunching this session")), false);
  });
});

test("a selection made while the relaunch runs supersedes the switch, even one back to the same worktree (#3810)", { skip: !haveGit() }, async () => {
  const relaunch = gate();
  let other: Switched | undefined;
  let target: Switched | undefined;
  await withSession("reselected", {
    beforeInitialize: async (launch) => { if (launch === 2) await relaunch.wait(); },
    during: async ({ manager, sessionId }, text) => {
      if (text !== "start the fix") return;
      other = await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/reselected-other" }, undefined,
        { requestedBySession: true });
      target = await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/reselected-target" }, undefined,
        { requestedBySession: true });
    },
  }, async ({ manager, store, sessionId, fake }) => {
    manager.prompt(sessionId, "start the fix");
    await relaunch.arrived;
    assert.equal(target?.isolation.continuesAfterRelaunch, true);
    // Someone else moves the selection away and back while the replacement provider starts.
    await manager.selectWorktree(sessionId, other!.worktree.path);
    await manager.selectWorktree(sessionId, target!.worktree.path);
    relaunch.open();
    await waitFor(() => store.readMeta(sessionId)?.status === "idle" && fake.launches() >= 2,
      "the relaunch did not finish");
    await settle();
    assert.equal(fake.prompts.length, 1, "the superseded switch does not continue");
    assert.ok(stderr(store, sessionId).includes(
      "The session did not continue on its own after the relaunch. Send a message to continue.",
    ), "the relaunch notice's promise is withdrawn plainly");
  });
});

/** Every distinct `worktreeSwitch` the runner published for the session, in order. */
function publishedSwitches(sent: RunnerToControlPlane[], sessionId: string): unknown[] {
  const values: unknown[] = [];
  for (const message of sent) {
    if (message.type !== "session_runtime_updated" || message.snapshot.id !== sessionId ||
        !("worktreeSwitch" in message.snapshot)) continue;
    const value = message.snapshot.worktreeSwitch ?? null;
    const shape = value && { phase: value.phase, branch: value.branch };
    if (JSON.stringify(values.at(-1)) !== JSON.stringify(shape)) values.push(shape);
  }
  return values;
}

test("a session reports Switching Worktree from its switch until the relaunch ends, then clears it (#3810)", { skip: !haveGit() }, async () => {
  const relaunch = gate();
  let since: number | undefined;
  await withSession("status", {
    beforeInitialize: async (launch) => { if (launch === 2) await relaunch.wait(); },
    during: async ({ manager, sessionId }, text) => {
      if (text !== "start the fix") return;
      await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/status" }, undefined,
        { requestedBySession: true });
    },
  }, async ({ manager, store, sessionId, fake, sent }) => {
    manager.prompt(sessionId, "start the fix");
    await relaunch.arrived;
    assert.deepEqual(publishedSwitches(sent, sessionId).slice(-2), [
      { phase: "pending", branch: "fix/status" },
      { phase: "relaunching", branch: "fix/status" },
    ], "pending from the switch, relaunching once the old provider is retired");
    const latest = [...sent].reverse().find((message) => message.type === "session_runtime_updated" &&
      message.snapshot.id === sessionId && message.snapshot.worktreeSwitch) as
      Extract<RunnerToControlPlane, { type: "session_runtime_updated" }> | undefined;
    since = latest?.snapshot.worktreeSwitch?.since;
    assert.ok(since, "the switch says when it began");
    relaunch.open();
    await waitFor(() => fake.prompts.length === 2 && store.readMeta(sessionId)?.status === "idle",
      "the continuation did not run");
    await settle();
    assert.equal(publishedSwitches(sent, sessionId).at(-1), null, "the relaunch's end clears it explicitly");
    const first = sent.find((message) => message.type === "session_runtime_updated" &&
      message.snapshot.id === sessionId && message.snapshot.worktreeSwitch) as
      Extract<RunnerToControlPlane, { type: "session_runtime_updated" }> | undefined;
    assert.equal(first?.snapshot.worktreeSwitch?.since, since, "one switch keeps one start time across phases");
  });
});

test("a switch landed by another provider replacement, such as an account switch, clears too (#3810)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-continuation-account-"));
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
    const sessionId = "s_continuation_account";
    let switched: Switched | undefined;
    let accountSwitch: unknown;
    const fake = fakeProvider({
      during: async (text) => {
        if (text !== "start the fix") return;
        switched = await manager!.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/account" });
        accountSwitch = await manager!.switchProviderAccount(sessionId, "claude-personal");
      },
    });
    manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 1);
    const accounts = [
      { id: "claude-work", label: "work@example.test", provider: "claude" as const, credentialHome: "/claude/work" },
      { id: "claude-personal", label: "personal@example.test", provider: "claude" as const, credentialHome: "/claude/personal" },
    ];
    const internals = manager as unknown as {
      resolveProviderAccount: (spec: { providerAccountId?: string }) => unknown;
      transferAccountTranscript: () => Promise<void>;
    };
    internals.resolveProviderAccount = (spec) => accounts.find((account) => account.id === spec.providerAccountId);
    internals.transferAccountTranscript = async () => {};
    assert.equal(await manager.start({ ...claudeSpec(sessionId, repo), providerAccountId: "claude-work" }), true);

    manager.prompt(sessionId, "start the fix");
    await waitFor(() => fake.launches() >= 2 && store.readMeta(sessionId)?.status === "idle" &&
      !(manager as unknown as { launchGenerations: Map<string, number> }).launchGenerations.has(sessionId),
    "the replacement did not settle");
    await settle();
    assert.deepEqual(accountSwitch, { ok: true, scheduled: true });
    assert.equal(store.readMeta(sessionId)?.providerAccountId, "claude-personal");
    const switches = publishedSwitches(sent, sessionId);
    assert.ok(switches.some((value) => JSON.stringify(value) === JSON.stringify({ phase: "pending", branch: "fix/account" })),
      "the switch was reported while it waited");
    assert.equal(switches.at(-1), null, "whichever replacement landed it, the switch is cleared");
    const last = [...sent].reverse().find((message) => message.type === "session_runtime_updated" &&
      message.snapshot.id === sessionId) as Extract<RunnerToControlPlane, { type: "session_runtime_updated" }>;
    assert.equal(last.snapshot.worktreeSwitch, null, "later idle snapshots stay clear");
    assert.ok(switched);
    manager.stop(sessionId);
    await manager.delete(sessionId);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal turn completion while a session's own worktree create is still activating still continues after relaunch (#4904)", { skip: !haveGit() }, async () => {
  const activation = gate();
  let switched: Promise<Switched> | undefined;
  await withSession("ended-before-activation", {
    during: async ({ manager, sessionId }, text) => {
      if (text !== "start the fix") return;
      const internals = manager as unknown as {
        worktreeIsolationNotice: (meta: unknown, path: string) => Promise<SessionWorktreeIsolationNotice>;
      };
      const notice = internals.worktreeIsolationNotice.bind(manager);
      internals.worktreeIsolationNotice = async (meta, path) => {
        await activation.wait();
        return notice(meta, path);
      };
      // Start the worktree request without awaiting it inside the turn, mirroring a backgrounded CLI
      // command whose requesting turn completes normally before setup finishes.
      switched = manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/ended-before-activation" },
        undefined, { requestedBySession: true });
      await activation.arrived;
    },
  }, async ({ manager, store, sessionId, fake }) => {
    manager.prompt(sessionId, "start the fix");
    await waitFor(() => store.readMeta(sessionId)?.status === "idle" && fake.prompts.length === 1,
      "the requesting turn did not finish normally before activation");
    assert.ok(switched, "the worktree create should be in flight");

    // Now setup/activation finishes while the session is already idle.
    activation.open();
    const result = await switched!;
    assert.deepEqual(result.isolation, {
      writableNow: false,
      writableAtNextLaunch: true,
      continuesAfterRelaunch: true,
    });
    await waitFor(() => fake.prompts.length === 2 && store.readMeta(sessionId)?.status === "idle",
      "the runner did not relaunch and continue automatically");
    const worktree = { path: result.worktree.path, branch: "fix/ended-before-activation" };
    assert.deepEqual(fake.prompts[1], { cwd: worktree.path, text: worktreeContinuationPrompt(worktree) });
    assert.equal(fake.launches(), 2);
    await settle();
    assert.equal(fake.prompts.length, 2, "continuation runs exactly once");
  });
});

test("interrupt, queued user prompt, superseding selection, or stop while an ended turn's create activates still suppresses continuation (#4904)", { skip: !haveGit() }, async () => {
  // 1. Interrupting the turn (even when the provider races and returns end_turn) before activation finishes.
  {
    const activation = gate();
    let switched: Promise<Switched> | undefined;
    await withSession("ended-after-interrupt", {
      during: async ({ manager, sessionId }, text) => {
        if (text !== "start the fix") return;
        const internals = manager as unknown as {
          worktreeIsolationNotice: (meta: unknown, path: string) => Promise<SessionWorktreeIsolationNotice>;
        };
        const notice = internals.worktreeIsolationNotice.bind(manager);
        internals.worktreeIsolationNotice = async (meta, path) => {
          await activation.wait();
          return notice(meta, path);
        };
        switched = manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/ended-after-interrupt" },
          undefined, { requestedBySession: true });
        await activation.arrived;
        assert.equal(manager.interruptTurn(sessionId), "applied");
      },
    }, async ({ manager, store, sessionId, fake }) => {
      manager.prompt(sessionId, "start the fix");
      await waitFor(() => store.readMeta(sessionId)?.status === "idle" && fake.prompts.length === 1,
        "the interrupted turn did not finish");
      activation.open();
      const result = await switched!;
      assert.equal(result.isolation.continuesAfterRelaunch, undefined);
      await waitFor(() => fake.launches() === 2 && store.readMeta(sessionId)?.status === "idle",
        "the relaunch did not settle");
      await settle();
      assert.equal(fake.prompts.length, 1, "an interrupted turn never continues automatically");
    });
  }

  // 2. A user prompt sent after the requesting turn ended, before activation finishes, supersedes continuation.
  {
    const activation = gate();
    let switched: Promise<Switched> | undefined;
    await withSession("ended-then-prompted", {
      during: async ({ manager, sessionId }, text) => {
        if (text !== "start the fix") return;
        const internals = manager as unknown as {
          worktreeIsolationNotice: (meta: unknown, path: string) => Promise<SessionWorktreeIsolationNotice>;
        };
        const notice = internals.worktreeIsolationNotice.bind(manager);
        internals.worktreeIsolationNotice = async (meta, path) => {
          await activation.wait();
          return notice(meta, path);
        };
        switched = manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/ended-then-prompted" },
          undefined, { requestedBySession: true });
        await activation.arrived;
      },
    }, async ({ manager, store, sessionId, fake }) => {
      manager.prompt(sessionId, "start the fix");
      await waitFor(() => store.readMeta(sessionId)?.status === "idle" && fake.prompts.length === 1,
        "turn 1 did not finish");
      manager.prompt(sessionId, "human follow-up");
      await waitFor(() => store.readMeta(sessionId)?.status === "idle" && fake.prompts.length === 2,
        "turn 2 did not finish");
      activation.open();
      const result = await switched!;
      assert.equal(result.isolation.continuesAfterRelaunch, undefined);
      await waitFor(() => fake.launches() === 2 && store.readMeta(sessionId)?.status === "idle",
        "the relaunch did not settle");
      await settle();
      assert.deepEqual(fake.prompts.map((prompt) => prompt.text), ["start the fix", "human follow-up"]);
    });
  }

  // 3. A queued superseding selectWorktree during the create window suppresses continuation even
  //    while the newer selection is still waiting to activate (no manual revision mutation).
  {
    const firstActivation = gate();
    const secondActivation = gate();
    let other: Switched | undefined;
    let switched: Promise<Switched> | undefined;
    await withSession("ended-then-reselected", {
      during: async ({ manager, sessionId }, text) => {
        if (text !== "start the fix") return;
        other = await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/other-before-gate" });
        const internals = manager as unknown as {
          worktreeIsolationNotice: (meta: unknown, path: string) => Promise<SessionWorktreeIsolationNotice>;
        };
        const notice = internals.worktreeIsolationNotice.bind(manager);
        let calls = 0;
        internals.worktreeIsolationNotice = async (meta, path) => {
          calls += 1;
          if (calls === 1) await firstActivation.wait();
          else if (calls === 2) await secondActivation.wait();
          return notice(meta, path);
        };
        switched = manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/superseded-by-select" },
          undefined, { requestedBySession: true });
        await firstActivation.arrived;
      },
    }, async ({ manager, store, sessionId, fake }) => {
      manager.prompt(sessionId, "start the fix");
      await waitFor(() => store.readMeta(sessionId)?.status === "idle" && fake.prompts.length === 1,
        "turn 1 did not finish");
      // Issue the public selectWorktree call while the first create is still blocked in activation.
      const selectionPromise = manager.selectWorktree(sessionId, other!.worktree.path);
      firstActivation.open();
      const result = await switched!;
      await secondActivation.arrived;
      // Hold the newer selection before its own activation long enough for the first relaunch to
      // finish; it still must not queue an automatic continuation.
      await waitFor(() => fake.launches() >= 2 && store.readMeta(sessionId)?.status === "idle",
        "first relaunch did not settle while newer selection waited");
      await settle();
      assert.equal(result.isolation.continuesAfterRelaunch, undefined);
      assert.equal(fake.prompts.length, 1, "a queued superseding selection must prevent continuation");
      secondActivation.open();
      await selectionPromise;
      await waitFor(() => store.readMeta(sessionId)?.status === "idle", "session did not settle");
      await settle();
      assert.equal(fake.prompts.length, 1, "a superseded selection must not trigger continuation");
    });
  }
});

test("selecting a newer worktree while an earlier continuation waits in the queue drops the stale continuation and preserves ordinary prompts (#4904)", { skip: !haveGit() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-continuation-drop-queued-"));
  let manager: SessionManager | undefined;
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
    const dataDir = join(root, "data");
    const store = new SessionStore(join(dataDir, "sessions"));

    const blockerTurn = gate();
    let wtA: Switched | undefined;
    let wtB: Switched | undefined;
    const promptsBySession = new Map<string, Array<{ cwd: string; text: string }>>();
    const launchesBySession = new Map<string, number>();

    const factory = (_driver: unknown, launch: Pick<DriverOptions, "cwd" | "env">, cb: DriverCallbacks) => {
      // Tag each created provider by prompt text/cwd.
      return {
        pid: 1,
        initialize: async () => {},
        newSession: async () => {},
        close: async () => {},
        prompt: async (text: string) => {
          const sid = text === "hold capacity" ? "s_blocker" : "s_target";
          const list = promptsBySession.get(sid) ?? [];
          list.push({ cwd: launch.cwd, text });
          promptsBySession.set(sid, list);
          cb.onPromptAccepted?.();
          if (text === "hold capacity") {
            await blockerTurn.wait();
          } else if (text === "switch to A") {
            wtB = await manager!.requestWorktree("s_target", { baseRef: "HEAD", branch: "fix/worktree-b" });
            wtA = await manager!.requestWorktree("s_target", { baseRef: "HEAD", branch: "fix/worktree-a" },
              undefined, { requestedBySession: true });
          }
          cb.onEvent({ kind: "agent_message", text: "ok", final: true });
          return "end_turn" as const;
        },
        cancel: () => {},
        dispose: () => {},
        setConfig: () => {},
        resolvePermission: () => false,
        agentSessionId: () => "provider-session-id",
      };
    };

    // maxConcurrentSessions = 2 with activeTurnLimit = 1 so s_blocker can hold active-turn capacity
    // while s_target stays live and its continuation sits queued.
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
      factory as never, dataDir, 2, undefined, undefined, { activeTurnLimit: 1, agentLimits: {}, agentWeights: {} });

    const relaunchGate = gate();
    const origLaunch = (manager as unknown as { launch: (...args: unknown[]) => Promise<unknown> }).launch.bind(manager);
    (manager as unknown as { launch: (...args: unknown[]) => Promise<unknown> }).launch = async (...args: unknown[]) => {
      const spec = args[0] as SessionLaunchSpec;
      const count = (launchesBySession.get(spec.sessionId) ?? 0) + 1;
      launchesBySession.set(spec.sessionId, count);
      if (spec.sessionId === "s_target" && count === 2) await relaunchGate.wait();
      return origLaunch(...args);
    };

    await manager.start(claudeSpec("s_target", repo));
    await manager.start(claudeSpec("s_blocker", repo));
    const internals = manager as unknown as {
      active: Map<string, { managedGitBoundary?: true; queue: Array<{ id: string; text: string }> }>;
    };
    internals.active.get("s_target")!.managedGitBoundary = true;

    // 1. s_target creates B and A (requestedBySession) and enters relaunch into A.
    manager.prompt("s_target", "switch to A");
    await relaunchGate.arrived;

    // 2. While s_target is relaunching into A, s_blocker takes the single active-turn slot.
    manager.prompt("s_blocker", "hold capacity");
    await blockerTurn.arrived;

    // 3. Let s_target finish relaunching into A -> continuation for A is queued behind capacity.
    relaunchGate.open();
    await waitFor(() => Boolean(internals.active.get("s_target")?.queue.some((item) => item.id.startsWith("worktreecont_"))),
      "continuation for A was not queued while capacity was held");

    // 4. Queue an ordinary user prompt too, then select worktree B while capacity is still held.
    manager.prompt("s_target", "ordinary follow-up");
    await manager.selectWorktree("s_target", wtB!.worktree.path);
    assert.equal(
      internals.active.get("s_target")?.queue.some((item) => item.id.startsWith("worktreecont_")),
      false,
      "selecting B must drop the queued continuation for A",
    );
    assert.equal(
      internals.active.get("s_target")?.queue.some((item) => item.text === "ordinary follow-up"),
      true,
      "selecting B must preserve ordinary queued prompts",
    );

    // Wait for the rebind into B to complete, then release capacity on s_blocker.
    await waitFor(() => (launchesBySession.get("s_target") ?? 0) >= 3, "s_target did not relaunch into B");
    blockerTurn.open();
    await waitFor(() => store.readMeta("s_blocker")?.status === "idle" &&
      store.readMeta("s_target")?.status === "idle" &&
      (promptsBySession.get("s_target")?.length ?? 0) === 2,
    "ordinary follow-up did not run after releasing capacity");
    await settle();

    const targetPrompts = promptsBySession.get("s_target")!;
    assert.deepEqual(targetPrompts.map((p) => p.text), ["switch to A", "ordinary follow-up"],
      "provider must never receive the stale continuation for A");
    assert.equal(targetPrompts[1]!.cwd, wtB!.worktree.path,
      "ordinary queued prompt runs in worktree B");

    manager.stop("s_target");
    manager.stop("s_blocker");
    await manager.delete("s_target");
    await manager.delete("s_blocker");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("selecting a newer worktree while a dequeued continuation awaits pre-submission Git proof cancels the stale continuation (#4904)", { skip: !haveGit() }, async () => {
  const proofGate = gate();
  const selectBActivationGate = gate();
  let wtA: Switched | undefined;
  let wtB: Switched | undefined;
  await withSession("dequeued-continuation-superseded", {
    during: async ({ manager, sessionId }, text) => {
      if (text !== "start the fix") return;
      wtB = await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/dequeued-target-b" });
      wtA = await manager.requestWorktree(sessionId, { baseRef: "HEAD", branch: "fix/dequeued-target-a" },
        undefined, { requestedBySession: true });
    },
  }, async ({ manager, store, sessionId, fake }) => {
    const internals = manager as unknown as {
      persistedWorktreeFailure: (meta: unknown, path: string, branch: string) => Promise<string | null>;
      worktreeIsolationNotice: (meta: unknown, path: string) => Promise<SessionWorktreeIsolationNotice>;
    };
    const origProof = internals.persistedWorktreeFailure.bind(manager);
    let proofCalls = 0;
    internals.persistedWorktreeFailure = async (meta, path, branch) => {
      if (wtA && path === wtA.worktree.path) {
        proofCalls += 1;
        // Gate the final pre-submission proof (second call inside runPrompt) after the continuation
        // has already left the queue.
        if (proofCalls === 2) await proofGate.wait();
      }
      return origProof(meta, path, branch);
    };

    const origNotice = internals.worktreeIsolationNotice.bind(manager);
    let gatedB = false;
    internals.worktreeIsolationNotice = async (meta, path) => {
      if (!gatedB && wtB && path === wtB.worktree.path && proofCalls >= 2) {
        gatedB = true;
        await selectBActivationGate.wait();
      }
      return origNotice(meta, path);
    };

    manager.prompt(sessionId, "start the fix");
    // Wait until the automatic continuation for A has dequeued and reached its final pre-submission proof.
    await proofGate.arrived;

    // Select B while A's dequeued continuation is paused in its final pre-submission proof.
    const selectB = manager.selectWorktree(sessionId, wtB!.worktree.path);
    await selectBActivationGate.arrived;

    // Release A's proof while B is still waiting before activation -> A's continuation MUST NOT submit!
    proofGate.open();
    await waitFor(() => store.readMeta(sessionId)?.status === "idle",
      "superseded continuation did not unwind cleanly");
    await settle();
    assert.equal(fake.prompts.length, 1, "provider must receive no automatic continuation prompt for A");

    // Release B's activation and verify an ordinary follow-up runs in B.
    selectBActivationGate.open();
    await selectB;
    manager.prompt(sessionId, "ordinary prompt in B");
    await waitFor(() => fake.prompts.length === 2 && store.readMeta(sessionId)?.status === "idle",
      "ordinary prompt did not run in B");
    assert.deepEqual(fake.prompts.map((p) => p.text), ["start the fix", "ordinary prompt in B"]);
    assert.equal(fake.prompts[1]!.cwd, wtB!.worktree.path);
  });
});
