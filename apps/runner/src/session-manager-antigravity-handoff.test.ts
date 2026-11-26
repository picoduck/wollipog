/** Google Antigravity keeps a conversation in the folder it was created in, whatever folder a resume
 * names. A launch that would resume it in another folder (a worktree switch, or a relaunch after
 * one: parking, a runner restart, a retry) therefore starts a fresh conversation there, seeded once
 * with the conversation so far. An explicit Restart never resumes an ACP conversation, so it is a
 * new conversation by design and is not covered here. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

async function launchWith(conversationCwd: "elsewhere" | "here" | "unknown", profile: "antigravity" | "none" = "antigravity",
  behavior: { failFresh?: boolean; captureDuringNewSession?: boolean; failMarkerClear?: "always" | "once" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-antigravity-handoff-")));
  const repoPath = join(root, "repo");
  execFileSync("git", ["init", "-q", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repoPath, "commit", "-q", "--allow-empty", "-m", "base"]);
  const elsewhere = join(root, "primary-checkout");
  mkdirSync(elsewhere);
  const store = new SessionStore(join(root, "sessions"));
  const meta: SessionMeta = {
    sessionId: "s1", agentId: "google-antigravity", workspaceId: "repo", repoPath, worktreePath: null,
    driver: "acp", command: "agy", args: ["acp"], env: {}, context: { kind: "native" },
    agentSessionId: "conv-a", status: "idle", title: "s1", config: {}, tokensIn: 0, tokensOut: 0,
    costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
    acpCapabilities: { sessionResume: true, loadSession: false } as never,
    ...(conversationCwd === "elsewhere" ? { providerConversationCwd: elsewhere }
      : conversationCwd === "here" ? { providerConversationCwd: repoPath } : {}),
  };
  store.create(meta);
  store.appendEvent("s1", { kind: "user_message", text: "Remember the code word HERON-42." });
  store.appendEvent("s1", { kind: "agent_message", text: "Noted" });
  store.appendEvent("s1", { kind: "agent_message", text: ", HERON-42.", final: false });
  store.appendEvent("s1", { kind: "agent_response_completed" });
  store.appendEvent("s1", { kind: "agent_message", text: "a subagent's note", parentToolUseId: "tool-1" });
  const launched: DriverOptions[] = [];
  const callbacks: DriverCallbacks[] = [];
  const patches: Array<Partial<SessionMeta>> = [];
  const patchMeta = store.patchMeta.bind(store);
  let clearFailures = 0;
  store.patchMeta = ((id: string, patch: Partial<SessionMeta>) => {
    patches.push(patch);
    // A store that rejects clearing an existing handoff marker while other writes still work.
    const clearing = Object.prototype.hasOwnProperty.call(patch, "pendingConversationHandoffFrom") &&
      patch.pendingConversationHandoffFrom === undefined && store.readMeta(id)?.pendingConversationHandoffFrom !== undefined;
    if (clearing && (behavior.failMarkerClear === "always" || (behavior.failMarkerClear === "once" && clearFailures === 0))) {
      clearFailures += 1;
      throw new Error("EIO: metadata write failed");
    }
    return patchMeta(id, patch);
  }) as typeof store.patchMeta;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let internals: any;
  const captured: Array<SessionMeta | null> = [];
  const factory = (_driver: unknown, options: DriverOptions, cb: DriverCallbacks) => {
    launched.push(options);
    callbacks.push(cb);
    return {
      pid: 1,
      initialize: async () => {
        // A failure before the fresh conversation exists, so before its id is captured.
        if (behavior.failFresh && !options.resumeId) throw new Error("agy did not start");
      },
      newSession: async () => {
        // Another path (a worktree selection) captures the id while agy still restores its config.
        if (behavior.captureDuringNewSession && !options.resumeId) {
          internals.captureAgentSessionId("s1", internals.active.get("s1").client);
          captured.push(store.readMeta("s1"));
        }
        return options.resumeId ?? "conv-b";
      },
      // As AcpClient does once the agent answered the prompt carrying the handoff: report it, and
      // never let that bookkeeping fail the accepted turn.
      prompt: async () => {
        if (options.acpConversationHandoff) {
          try { cb.onConversationHandoffDelivered?.(); } catch { /* AcpClient logs it to stderr */ }
        }
        return "end_turn" as const;
      },
      cancel: () => {}, dispose: () => {},
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => options.resumeId ?? "conv-b",
    };
  };
  const manager = new SessionManager(
    () => {}, () => {}, store, "runner", undefined, factory as never, join(root, "state"), 2,
    undefined, undefined, { agentLimits: {}, agentWeights: {} },
    { mode: "provider", network: "inherit" }, async () => undefined,
    async () => {}, async () => {}, async () => {}, undefined, [],
    () => profile === "antigravity" ? { acpCompatibility: { profile: "antigravity" as const, resumable: true } } : undefined,
  );
  internals = manager;
  assert.equal(await internals.acquireAdmission("s1"), true);
  const ok = await internals.launch(store.readMeta("s1"), "conv-a");
  const stderr = store.readEvents("s1").filter((event) => event.payload.kind === "stderr")
    .map((event) => (event.payload as { text: string }).text);
  return {
    ok, options: launched[0], meta: store.readMeta("s1"), stderr, repoPath, elsewhere, launched, callbacks, patches, store, captured,
    /** An ordinary prompt through the manager, settled. */
    promptAndSettle: async (text: string) => {
      assert.equal(manager.prompt("s1", text), true);
      const deadline = Date.now() + 5_000;
      while (internals.active.get("s1")?.running || store.readMeta("s1")?.status === "running") {
        if (Date.now() > deadline) throw new Error("the turn did not settle");
        await new Promise((done) => setTimeout(done, 10));
      }
      await new Promise((done) => setTimeout(done, 20));
      return store.readMeta("s1");
    },
    /** The replacement retired before its first ordinary prompt (parked, or the runner restarted),
     * then launched again by the next prompt with whatever the session records now. */
    relaunch: async () => {
      const entry = internals.active.get("s1");
      if (entry) internals.deleteActiveSession("s1", entry, false);
      internals.releaseAdmission("s1");
      assert.equal(await internals.acquireAdmission("s1"), true);
      const current = store.readMeta("s1")!;
      assert.equal(await internals.launch(current, current.agentSessionId ?? undefined), true);
      return launched.at(-1)!;
    },
    deleteSession: () => manager.delete("s1"),
    hasDeliveredHandoff: () => manager["deliveredHandoffs"].has("s1"),
    cleanup: () => { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("a conversation created in another folder continues fresh in this one, seeded once with the conversation so far", async () => {
  const f = await launchWith("elsewhere");
  try {
    assert.equal(f.ok, true);
    assert.equal(f.options?.resumeId, undefined, "agy would keep running commands in the old folder");
    const handoff = f.options?.acpConversationHandoff ?? "";
    assert.match(handoff, new RegExp(`moved from ${f.elsewhere} to ${f.repoPath}`, "u"));
    assert.match(handoff, /user: Remember the code word HERON-42\.\nassistant: Noted, HERON-42\./u);
    assert.doesNotMatch(handoff, /subagent/u, "only top-level replies are carried");
    assert.equal(f.meta?.providerConversationCwd, f.repoPath, "the new conversation belongs to this folder");
    assert.equal(f.meta?.agentSessionId, "conv-b");
    assert.ok(f.stderr.some((text) => text.includes("continues in a new conversation")), f.stderr.join("\n"));
    // One write names the new conversation and where it was created: a crash can never leave the
    // new id beside a missing or earlier folder.
    assert.ok(f.patches.some((patch) => patch.agentSessionId === "conv-b" && patch.providerConversationCwd === f.repoPath &&
      patch.pendingConversationHandoffFrom === f.elsewhere),
      JSON.stringify(f.patches.filter((patch) => "agentSessionId" in patch || "providerConversationCwd" in patch)));
    assert.ok(!f.patches.some((patch) => (patch.providerConversationCwd !== undefined ||
      patch.pendingConversationHandoffFrom !== undefined) && patch.agentSessionId === undefined),
      "nothing about the new conversation is written before, or apart from, its id");
  } finally {
    f.cleanup();
  }
});

test("another path capturing the fresh id mid-launch still records it with its own folder and handoff", async () => {
  const f = await launchWith("elsewhere", "antigravity", { captureDuringNewSession: true });
  try {
    assert.equal(f.ok, true);
    const early = f.captured[0];
    assert.equal(early?.agentSessionId, "conv-b");
    assert.equal(early?.providerConversationCwd, f.repoPath, "never conv-b beside the replaced folder");
    assert.equal(early?.pendingConversationHandoffFrom, f.elsewhere);
    assert.ok(!f.patches.some((patch) => patch.agentSessionId === "conv-b" && patch.providerConversationCwd !== f.repoPath));
  } finally {
    f.cleanup();
  }
});

test("a replacement that fails before it exists leaves the old conversation to resume untouched in its folder", async () => {
  const f = await launchWith("elsewhere", "antigravity", { failFresh: true });
  try {
    assert.equal(f.ok, false);
    assert.equal(f.meta?.agentSessionId, "conv-a");
    assert.equal(f.meta?.providerConversationCwd, f.elsewhere);
    assert.equal(f.meta?.pendingConversationHandoffFrom, undefined, "no seed for a conversation that holds its history");
    // Back in the old folder: conv-a resumes there, and is never sent its own history again.
    f.store.patchMeta("s1", { repoPath: f.elsewhere });
    const back = await f.relaunch();
    assert.equal(back.resumeId, "conv-a");
    assert.equal(back.acpConversationHandoff, undefined);
  } finally {
    f.cleanup();
  }
});

test("a failure clearing a delivered handoff's marker never fails the turn the agent completed", async () => {
  const f = await launchWith("elsewhere", "antigravity", { failMarkerClear: "always" });
  try {
    const after = await f.promptAndSettle("What was the code word?");
    assert.notEqual(after?.status, "failed", f.store.readEvents("s1").map((event) => JSON.stringify(event.payload)).join("\n"));
    assert.ok(!f.store.readEvents("s1").some((event) => event.payload.kind === "error"),
      "no prompt failure for bookkeeping the agent never saw");
  } finally {
    f.cleanup();
  }
});

test("permanently deleting a session releases its delivered handoff after a failed marker clear", async () => {
  const f = await launchWith("elsewhere", "antigravity", { failMarkerClear: "always" });
  try {
    const after = await f.promptAndSettle("What was the code word?");
    assert.equal(after?.pendingConversationHandoffFrom, f.elsewhere, "the clear did not land");
    assert.equal(f.hasDeliveredHandoff(), true, "the runner recorded acceptance in memory");

    await f.deleteSession();

    assert.equal(f.store.has("s1"), false);
    assert.equal(f.hasDeliveredHandoff(), false);
  } finally {
    f.cleanup();
  }
});

test("a resumed replacement whose marker clear failed once is not sent its handoff again", async () => {
  const f = await launchWith("elsewhere", "antigravity", { failMarkerClear: "once" });
  try {
    // Parked before its first ordinary prompt, then resumed: this entry is not the fresh launch.
    const resumed = await f.relaunch();
    assert.equal(resumed.resumeId, "conv-b");
    assert.ok(resumed.acpConversationHandoff, "the replacement still needs its history");
    // The agent accepts it; clearing the durable marker fails once.
    assert.throws(() => f.callbacks.at(-1)!.onConversationHandoffDelivered?.(), /EIO/u);
    assert.equal(f.store.readMeta("s1")?.pendingConversationHandoffFrom, f.elsewhere, "the clear did not land");
    // Storage recovers and the session is parked and resumed again.
    const again = await f.relaunch();
    assert.equal(again.acpConversationHandoff, undefined, "history the agent already holds is never re-sent");
    assert.equal(f.store.readMeta("s1")?.pendingConversationHandoffFrom, undefined, "the clear is retried");
  } finally {
    f.cleanup();
  }
});

test("a handoff not yet delivered survives the replacement's parking or a runner restart, once", async () => {
  const f = await launchWith("elsewhere");
  try {
    assert.equal(f.meta?.pendingConversationHandoffFrom, f.elsewhere, "durable until agy has it");
    // Parked before any ordinary prompt: the next launch resumes the replacement in its own folder,
    // and the conversation so far must still reach it.
    const again = await f.relaunch();
    assert.equal(again.resumeId, "conv-b", "the replacement conversation is resumed, not replaced again");
    assert.match(again.acpConversationHandoff ?? "", /user: Remember the code word HERON-42\./u);
    // Delivered: the agent accepted the prompt that carried it.
    f.callbacks.at(-1)!.onConversationHandoffDelivered?.();
    assert.equal(f.store.readMeta("s1")?.pendingConversationHandoffFrom, undefined);
    const after = await f.relaunch();
    assert.equal(after.acpConversationHandoff, undefined, "never sent twice");
  } finally {
    f.cleanup();
  }
});

for (const [name, conversationCwd, profile] of [
  ["a conversation created in this folder resumes", "here", "antigravity"],
  ["an older session that never recorded its folder keeps resuming", "unknown", "antigravity"],
  ["an ACP agent without Antigravity's profile resumes as before", "elsewhere", "none"],
] as const) {
  test(name, async () => {
    const f = await launchWith(conversationCwd, profile);
    try {
      assert.equal(f.ok, true);
      assert.equal(f.options?.resumeId, "conv-a");
      assert.equal(f.options?.acpConversationHandoff, undefined);
      assert.equal(f.meta?.agentSessionId, "conv-a");
    } finally {
      f.cleanup();
    }
  });
}
