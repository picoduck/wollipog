import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { ProcessingWindow, RUNNER_WINDOW_BYTES, RUNNER_WINDOW_FRAMES } from "./processing-window.js";

test("only matching processing ACKs release windows; snapshots are read at write time", async (t) => {
  const ids = Array.from({ length: RUNNER_WINDOW_FRAMES + 2 }, (_, id) => String(id));
  const state = new Map(ids.map((id) => [id, "old"]));
  const sent: Array<{ type: string; id?: string; state?: string }> = [];
  const window = new ProcessingWindow(ids, (id) => JSON.stringify({ type: "state", id, state: state.get(id) }),
    (wire) => sent.push(JSON.parse(wire)), () => assert.fail(), () => {});
  t.after(() => window.close());
  await turn();
  assert.equal(sent.filter((frame) => frame.type === "state").length, RUNNER_WINDOW_FRAMES);
  state.set(ids.at(-1)!, "live");
  window.acknowledge(999);
  await turn();
  assert.equal(sent.length, RUNNER_WINDOW_FRAMES + 1);
  window.acknowledge(1);
  await turn();
  assert.equal(sent.at(-2)?.state, "live");
  assert.equal(window.complete, false);
  window.acknowledge(1);
  assert.equal(window.complete, false);
  window.acknowledge(2);
  assert.equal(window.complete, true);
  assert.deepEqual(sent.filter((frame) => frame.type === "state").map((frame) => frame.id), ids);
});

test("a snapshot deferred by the byte budget is regenerated, and an oversized singleton progresses", async (t) => {
  const sent: string[] = [];
  const state = new Map([['a', 'x'.repeat(RUNNER_WINDOW_BYTES / 2 + 1)],
    ['b', 'old'.repeat(RUNNER_WINDOW_BYTES / 2)], ['c', 'oversize'.repeat(RUNNER_WINDOW_BYTES)]]);
  const window = new ProcessingWindow([...state.keys()], (id) => state.get(id)!,
    (wire) => sent.push(wire), () => assert.fail(), () => {});
  t.after(() => window.close());
  await turn();
  assert.equal(sent.length, 2);
  state.set('b', 'new');
  window.acknowledge(1);
  await turn();
  assert.equal(sent[2], 'new');
  assert.equal(sent.length, 4);
  window.acknowledge(2);
  await turn();
  assert.equal(sent[4], state.get('c'));
});

test("close discards pending inventory; replacement regenerates it without replaying old wire data", async () => {
  const sent: string[] = [];
  let state = "before";
  const window = new ProcessingWindow(['a', 'b'], () => 'x'.repeat(RUNNER_WINDOW_BYTES),
    (wire) => sent.push(wire), () => assert.fail(), () => {});
  await turn();
  window.close();
  window.acknowledge(1);
  await turn();
  assert.equal(sent.length, 2);
  const replacement = new ProcessingWindow(['a', 'b'], (id) => id + state,
    (wire) => sent.push(wire), () => assert.fail(), () => {});
  state = "after";
  await turn();
  assert.equal(sent[2], 'aafter');
  assert.equal(sent[3], 'bafter');
  replacement.close();
});

test("failed writes abandon this inventory without producing a retry suffix", async () => {
  let failures = 0;
  let writes = 0;
  const window = new ProcessingWindow(['a', 'b'], (id) => id,
    () => { writes++; throw new Error("closed"); }, () => failures++, () => {});
  await turn();
  assert.equal(failures, 1);
  window.acknowledge(1);
  await turn();
  assert.equal(writes, 1);
  window.close();
});

test("bad snapshots are skipped with bounded sanitized diagnostics rather than reconnecting", async (t) => {
  const sent: string[] = [];
  const diagnostics: unknown[] = [];
  const window = new ProcessingWindow(['bad-a', 'good', 'bad-b'], (id) => {
    if (id.startsWith('bad')) throw new Error('private snapshot content must never enter diagnostics');
    return id;
  }, (wire) => sent.push(wire), () => assert.fail("snapshot failure must not disconnect"),
    (details) => diagnostics.push(details));
  t.after(() => window.close());
  await turn();
  assert.equal(sent[0], 'good');
  assert.deepEqual(diagnostics, [{ event: 'runner_republish_snapshot_failed' }]);
  window.acknowledge(1);
  assert.equal(window.complete, true);
});
