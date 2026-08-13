import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent, SessionView } from "@wollipog/protocol";
import { selectComparisonEvents, selectComparisonHistory, selectComparisonSession } from "./comparison-selectors.js";

const session = (id: string): SessionView => ({
  id,
  runnerId: "runner",
  agentId: "agent",
  agentName: "Agent",
  driver: "acp",
  title: id,
  status: "idle",
  updatedAt: 1,
  useWorktree: false,
});

const event = (sessionId: string, seq: number): SessionEvent => ({
  id: seq,
  sessionId,
  seq,
  ts: seq,
  payload: { kind: "user_message", text: `${sessionId}:${seq}` },
});

test("unrelated fleet updates preserve comparison-column selector identities", () => {
  const a = session("a");
  const b = session("b");
  const aEvents = [event("a", 1)];
  const bEvents = [event("b", 1)];
  const before = {
    sessions: new Map([["a", a], ["b", b]]),
    events: new Map([["a", aEvents], ["b", bEvents]]),
  };
  const afterUnrelated = {
    sessions: new Map([["a", a], ["b", { ...b, status: "running" as const }]]),
    events: new Map([["a", aEvents], ["b", [...bEvents, event("b", 2)]]]),
  };

  assert.equal(selectComparisonSession(afterUnrelated, "a"), selectComparisonSession(before, "a"));
  assert.equal(selectComparisonEvents(afterUnrelated, "a"), selectComparisonEvents(before, "a"));
  assert.notEqual(selectComparisonSession(afterUnrelated, "b"), selectComparisonSession(before, "b"));
  assert.notEqual(selectComparisonEvents(afterUnrelated, "b"), selectComparisonEvents(before, "b"));
});

test("comparison history normalizes a missing session epoch to the stored epoch zero", () => {
  const withoutEpoch = session("legacy");
  const history = {
    eventEpoch: 0,
    recoveryGeneration: 2,
    recoveryRevision: 3,
    everComplete: true,
    refreshing: false,
    error: null,
  };
  const state = {
    sessions: new Map([[withoutEpoch.id, withoutEpoch]]),
    eventHistory: new Map([[withoutEpoch.id, history]]),
  };
  assert.equal(selectComparisonHistory(state, withoutEpoch.id), history);
  assert.equal(selectComparisonHistory({
    ...state,
    eventHistory: new Map([[withoutEpoch.id, { ...history, eventEpoch: 1 }]]),
  }, withoutEpoch.id), undefined);
});
