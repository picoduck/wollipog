import assert from "node:assert/strict";
import { test } from "node:test";
import { readSessionEventHistory } from "./read-session-event-history.js";

test("whole-transcript fixtures page beyond 200 events in order with a pinned epoch", async (t) => {
  const requests: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    assert.equal(url.pathname, "/api/sessions/a%2Fb/events");
    assert.equal(url.searchParams.get("limit"), "200");
    const after = Number(url.searchParams.get("after"));
    const events = Array.from({ length: Math.min(200, 405 - after) }, (_, i) => ({
      seq: after + i + 1, payload: { kind: "agent_message", text: String(after + i + 1) },
    }));
    return Response.json({
      events, eventEpoch: 7, nextAfter: events.at(-1)?.seq ?? after,
      hasMoreCached: after + events.length < 405, cacheComplete: true,
    });
  });
  const result = await readSessionEventHistory("http://fixture", "fixture-token", "a/b");
  assert.deepEqual(result.events.map(event => event.seq), Array.from({ length: 405 }, (_, i) => i + 1));
  assert.deepEqual(requests.map(url => url.searchParams.get("after")), ["0", "200", "400"]);
  assert.deepEqual(requests.map(url => url.searchParams.get("eventEpoch")), [null, "7", "7"]);
});

test("whole-transcript fixtures retain the cursor while an incomplete cache catches up", async (t) => {
  const pages = [
    { events: [{ seq: 1 }], eventEpoch: 3, nextAfter: 1, hasMoreCached: false, cacheComplete: false },
    { events: [], eventEpoch: 3, nextAfter: 1, hasMoreCached: false, cacheComplete: false },
    { events: [{ seq: 2 }], eventEpoch: 3, nextAfter: 2, hasMoreCached: false, cacheComplete: true },
  ];
  const cursors: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    cursors.push(new URL(input).searchParams.get("after")!);
    return Response.json(pages.shift());
  });
  const result = await readSessionEventHistory("http://fixture", "fixture-token", "s");
  assert.deepEqual(result.events.map(event => event.seq), [1, 2]);
  assert.deepEqual(cursors, ["0", "1", "1"]);
});

test("whole-transcript fixtures refuse to combine pages from replaced histories", async (t) => {
  const pages = [
    { events: [{ seq: 1 }], eventEpoch: 3, nextAfter: 1, hasMoreCached: true, cacheComplete: true },
    { events: [{ seq: 2 }], eventEpoch: 4, nextAfter: 2, hasMoreCached: false, cacheComplete: true },
  ];
  t.mock.method(globalThis, "fetch", async () => Response.json(pages.shift()));
  await assert.rejects(readSessionEventHistory("http://fixture", "fixture-token", "s"), /history was replaced/);
});
