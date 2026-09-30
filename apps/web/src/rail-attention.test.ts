import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, type SessionStatus } from "@wollipog/protocol";
import { GLOBAL_VIEW_ITEMS } from "./navigation.js";
import { NO_MACHINE_ATTENTION, machineAttention, railAttention, type RailAttentionState } from "./rail-attention.js";

const state = (overrides: Partial<RailAttentionState> = {}): RailAttentionState => ({
  blocked: 0,
  stalled: 0,
  machines: NO_MACHINE_ATTENTION,
  ...overrides,
});

test("Sessions shows one count: red with any stalled session, amber with only blocked ones", () => {
  assert.deepEqual(railAttention("inbox", state({ blocked: 12, stalled: 3 })),
    { kind: "count", count: 15, tone: "danger", note: "12 waiting on you, 3 stalled" });
  assert.deepEqual(railAttention("inbox", state({ blocked: 12 })),
    { kind: "count", count: 12, tone: "warning", note: "12 waiting on you" });
  assert.deepEqual(railAttention("inbox", state({ stalled: 1 })),
    { kind: "count", count: 1, tone: "danger", note: "1 stalled" });
});

test("zero is never shown", () => {
  assert.equal(railAttention("inbox", state()), null);
  assert.equal(railAttention("runners", state()), null);
  // A count that went negative through a stale subtraction is still nothing, not a smaller total.
  assert.equal(railAttention("inbox", state({ blocked: -1, stalled: 0 })), null);
  assert.deepEqual(railAttention("inbox", state({ blocked: 2, stalled: -1 })),
    { kind: "count", count: 2, tone: "warning", note: "2 waiting on you" });
});

test("Connections shows a warning dot, never a count, and says why", () => {
  assert.deepEqual(railAttention("runners", state({ machines: { offlineWithActiveSessions: 1, updateRequired: 0 } })),
    { kind: "dot", tone: "warning", note: "1 machine is offline with active sessions" });
  assert.deepEqual(railAttention("runners", state({ machines: { offlineWithActiveSessions: 0, updateRequired: 1 } })),
    { kind: "dot", tone: "warning", note: "1 machine needs an update" });
  assert.deepEqual(railAttention("runners", state({ machines: { offlineWithActiveSessions: 2, updateRequired: 3 } })),
    { kind: "dot", tone: "warning", note: "2 machines are offline with active sessions, 3 machines need an update" });
});

test("every other destination carries nothing, whatever is waiting elsewhere", () => {
  const busy = state({ blocked: 4, stalled: 2, machines: { offlineWithActiveSessions: 1, updateRequired: 1 } });
  for (const item of GLOBAL_VIEW_ITEMS) {
    if (item.id === "inbox" || item.id === "runners") continue;
    assert.equal(railAttention(item.id, busy), null, item.id);
  }
});

const runner = (runnerId: string, status: "online" | "offline", protocolVersion: number | null = PROTOCOL_VERSION) =>
  ({ runnerId, status, protocolVersion });
const session = (runnerId: string, status: SessionStatus, archived = false) => ({ runnerId, status, archived });

test("online and idle machines need nothing", () => {
  assert.deepEqual(machineAttention([], []), NO_MACHINE_ATTENTION);
  assert.deepEqual(machineAttention(
    [runner("a", "online"), runner("b", "online")],
    [session("a", "running"), session("b", "idle"), session("b", "input_required")],
  ), NO_MACHINE_ATTENTION);
  // Offline with nothing in flight on it is normal: a laptop that is closed.
  assert.deepEqual(machineAttention(
    [runner("a", "offline")],
    [session("a", "idle"), session("a", "completed"), session("a", "failed"), session("a", "stopped")],
  ), NO_MACHINE_ATTENTION);
});

test("a machine offline while one of its sessions has work in flight needs the user", () => {
  for (const status of ["queued", "starting", "running", "input_required"] as const) {
    assert.deepEqual(machineAttention([runner("a", "offline")], [session("a", status)]),
      { offlineWithActiveSessions: 1, updateRequired: 0 }, status);
  }
  // Another machine's session, or an archived one, does not count against it.
  assert.deepEqual(machineAttention(
    [runner("a", "offline"), runner("b", "online")],
    [session("b", "running"), session("a", "running", true)],
  ), NO_MACHINE_ATTENTION);
  // Several sessions on one machine are still one machine.
  assert.deepEqual(machineAttention([runner("a", "offline")], [session("a", "running"), session("a", "queued")]),
    { offlineWithActiveSessions: 1, updateRequired: 0 });
});

test("an outdated runner needs an update; an unknown protocol is not proof of one", () => {
  assert.deepEqual(machineAttention([runner("a", "online", PROTOCOL_VERSION - 1)], []),
    { offlineWithActiveSessions: 0, updateRequired: 1 });
  assert.deepEqual(machineAttention([runner("a", "online", null), runner("b", "online", PROTOCOL_VERSION)], []),
    NO_MACHINE_ATTENTION);
  // Each machine counts once, under its more urgent reason.
  assert.deepEqual(machineAttention(
    [runner("a", "offline", PROTOCOL_VERSION - 1), runner("b", "offline", PROTOCOL_VERSION - 1)],
    [session("a", "running")],
  ), { offlineWithActiveSessions: 1, updateRequired: 1 });
});
