import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, type SessionView } from "@wollipog/protocol";
import type { TimelineItem } from "./timeline.js";
import {
  followUpAvailability,
  memberFinalAnswer,
  namesSentence,
  promptRunMembers,
  runMemberLabels,
  stopAgentUnavailableReason,
} from "./run-members.js";

const session = (status: SessionView["status"], extra: Partial<SessionView> = {}) =>
  ({ status, archived: false, ...extra }) as SessionView;

test("members of the same agent are numbered by their position among that agent's members", () => {
  assert.deepEqual(runMemberLabels(["Claude Code", "Codex", "Claude Code"]), ["Claude Code 1", "Codex", "Claude Code 2"]);
  assert.deepEqual(runMemberLabels(["Claude Code", "Codex"]), ["Claude Code", "Codex"]);
  assert.deepEqual(runMemberLabels(["", ""]), ["", ""], "a member not loaded yet has no name to number");
});

test("a member awaiting a prompt is ready, a working one Running, an ended one Ended", () => {
  assert.deepEqual(followUpAvailability(session("idle")), { kind: "ready" });
  assert.deepEqual(followUpAvailability(session("input_required")), { kind: "available" });
  for (const status of ["queued", "starting", "running"] as const) {
    assert.deepEqual(followUpAvailability(session(status)), { kind: "running", reason: "Running" }, status);
  }
  for (const status of ["completed", "failed", "stopped"] as const) {
    assert.deepEqual(followUpAvailability(session(status)), { kind: "ended", reason: "Ended" }, status);
  }
  assert.deepEqual(followUpAvailability(session("idle", { archived: true })), { kind: "ended", reason: "Ended" });
  assert.deepEqual(
    followUpAvailability(session("idle", { commandPermissions: { prompt: { allowed: false, reason: "Viewers can't send prompts." } } } as Partial<SessionView>)),
    { kind: "refused", reason: "Viewers can't send prompts." },
  );
});

test("Stop Agent is available only while the member's turn runs on a reachable, current machine", () => {
  const online = { online: true, protocolVersion: PROTOCOL_VERSION };
  assert.equal(stopAgentUnavailableReason(session("running", { activeTurnId: "t" }), online), null);
  assert.equal(stopAgentUnavailableReason(session("idle"), online), "Not running");
  assert.equal(stopAgentUnavailableReason(session("running"), online), "Not running", "no active turn yet");
  assert.equal(stopAgentUnavailableReason(session("running", { activeTurnId: "t" }), { online: false }), "Its machine is offline.");
  assert.equal(stopAgentUnavailableReason(session("running", { activeTurnId: "t" }), { online: true, protocolVersion: 1 }), "Update its machine to stop a turn.");
  assert.equal(stopAgentUnavailableReason(
    session("running", { activeTurnId: "t", commandPermissions: { cancelTurn: { allowed: false, reason: "Viewers can't stop turns." } } } as Partial<SessionView>),
    online,
  ), "Viewers can't stop turns.");
});

test("the final answer is the newest top-level reply, never a subagent's", () => {
  const items = [
    { kind: "agent_message", id: 1, text: "First." },
    { kind: "agent_message", id: 2, text: "**Final** answer." },
    { kind: "agent_message", id: 3, text: "A subagent's note.", parentToolUseId: "task-1" },
    { kind: "agent_message", id: 4, text: "   " },
  ] as TimelineItem[];
  assert.equal(memberFinalAnswer(items), "**Final** answer.");
  assert.equal(memberFinalAnswer([{ kind: "user_message", id: 1, text: "Go" }] as TimelineItem[]), null);
});

test("promptRunMembers sends every prompt at once and reports each member's outcome in order", async () => {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const sending = promptRunMembers((id) => {
    started.push(id);
    return new Promise<void>((resolve, reject) => {
      releases.set(id, () => (id === "b" ? reject(new Error("offline")) : resolve()));
    });
  }, ["a", "b", "c"], "Next");
  assert.deepEqual(started, ["a", "b", "c"], "all three are in flight before any settles");
  for (const id of ["c", "b", "a"]) releases.get(id)!();
  assert.deepEqual(await sending, [
    { sessionId: "a", ok: true },
    { sessionId: "b", ok: false, error: "offline" },
    { sessionId: "c", ok: true },
  ]);
});

test("names read as a sentence", () => {
  assert.equal(namesSentence(["Codex"]), "Codex");
  assert.equal(namesSentence(["Claude Code", "Codex"]), "Claude Code and Codex");
  assert.equal(namesSentence(["A", "B", "C"]), "A, B and C");
});
