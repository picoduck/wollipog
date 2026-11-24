/** Google Antigravity keeps a conversation in the folder it was created in, whatever folder a resume
 * names. A launch in another folder (after a worktree switch, or a restart after one) therefore
 * starts a fresh conversation there, seeded once with the conversation so far. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

async function launchWith(conversationCwd: "elsewhere" | "here" | "unknown", profile: "antigravity" | "none" = "antigravity") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-antigravity-handoff-")));
  const repoPath = join(root, "repo");
  execFileSync("git", ["init", "-q", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repoPath, "commit", "-q", "--allow-empty", "-m", "base"]);
  const elsewhere = join(root, "primary-checkout");
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
  const factory = (_driver: unknown, options: DriverOptions, _cb: DriverCallbacks) => {
    launched.push(options);
    return {
      pid: 1, initialize: async () => {}, newSession: async () => options.resumeId ?? "conv-b",
      prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => {},
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = manager as any;
  assert.equal(await internals.acquireAdmission("s1"), true);
  const ok = await internals.launch(store.readMeta("s1"), "conv-a");
  const stderr = store.readEvents("s1").filter((event) => event.payload.kind === "stderr")
    .map((event) => (event.payload as { text: string }).text);
  return {
    ok, options: launched[0], meta: store.readMeta("s1"), stderr, repoPath, elsewhere,
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
