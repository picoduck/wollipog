import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRecentSessions,
  RECENT_SESSIONS_LIMIT,
  withRecentSession,
} from "./recent-sessions.js";

test("withRecentSession: the opened session moves to the front, once, and the list keeps five", () => {
  assert.deepEqual(withRecentSession([], "a"), ["a"]);
  assert.deepEqual(withRecentSession(["a", "b", "c"], "c"), ["c", "a", "b"], "reopening moves it up, not in twice");
  const full = ["a", "b", "c", "d", "e"];
  assert.equal(full.length, RECENT_SESSIONS_LIMIT);
  assert.deepEqual(withRecentSession(full, "f"), ["f", "a", "b", "c", "d"], "the oldest falls off");
});

test("parseRecentSessions: only a list of ids loads, deduplicated and capped", () => {
  assert.deepEqual(parseRecentSessions(null), []);
  assert.deepEqual(parseRecentSessions("not json"), []);
  assert.deepEqual(parseRecentSessions(JSON.stringify({ ids: ["a"] })), []);
  assert.deepEqual(parseRecentSessions(JSON.stringify(["a", 3, "", "a", "b"])), ["a", "b"]);
  assert.deepEqual(parseRecentSessions(JSON.stringify(["1", "2", "3", "4", "5", "6"])), ["1", "2", "3", "4", "5"]);
});
