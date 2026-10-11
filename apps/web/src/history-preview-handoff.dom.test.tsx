import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionEvent, SessionHistoryHandoff } from "@wollipog/protocol";
import { TimelineBuilder } from "./timeline.js";
import { EventTimeline, type TimelineReadingState, type TimelineRenderRow } from "./components/EventTimeline.js";
import { convertPreviewReadingState, timelineRowSource } from "./history-preview-handoff.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";
import { useHistoryPreview } from "./use-history-preview.js";
import type { ApiClient } from "./api.js";

const dom = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { cleanup } = installDomTestCleanup(dom);

test("navigation can wait for the actual preview older-read owner before inspecting progress", async () => {
  let release!: (page: Awaited<ReturnType<ApiClient["getSessionHistoryPreview"]>>) => void;
  const api = { getSessionHistoryPreview: () => new Promise(done => { release = done; }) } as unknown as ApiClient;
  let reader!: ReturnType<typeof useHistoryPreview>;
  function Reader() { reader = useHistoryPreview(api, "s", 0, () => null, () => false, "owner-test"); return null; }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  cleanup(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<Reader />));
  await act(async () => { reader.accept({ eventEpoch: 0, logEpoch: 1, throughSeq: 20, turnStartSeq: 20,
    nextAfterSeq: 20, hasMore: false, events: [{ seq: 20, ts: 1, payload: { kind: "user_message", text: "Latest turn" } }] }); });
  await act(async () => { assert.equal(reader.loadOlder(), true); });
  assert.equal(reader.isLoadingOlder(), true);
  let settled = false;
  const waiting = reader.waitForOlder().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false, "pending work cannot be judged no progress");
  await act(async () => {
    release({ preview: { eventEpoch: 0, logEpoch: 1, throughSeq: 20, turnStartSeq: 20, nextAfterSeq: 19,
      hasMore: true, events: Array.from({ length: 19 }, (_, i) => ({ seq: i + 1, ts: 1,
        payload: { kind: "user_message", text: `Turn ${i + 1}` } })) } });
    await waiting;
  });
  assert.equal(reader.isLoadingOlder(), false);
  assert.equal(reader.events?.[0]?.seq, 1, "target discovery runs after the actual page is committed");
});

test("proven handoff preserves expanded tool and nested agent anchors across CP-only work boundaries", async () => {
  const payloads: SessionEvent["payload"][] = [
    { kind: "user_message", text: "Current prompt" },
    { kind: "tool_call", toolCallId: "read", toolKind: "read", title: "Read: first.ts", status: "completed", text: "First tool output" },
    { kind: "tool_call", toolCallId: "agent", toolKind: "agent", title: "Agent: Inspect Sources", status: "completed", text: "Agent output" },
    { kind: "tool_call", toolCallId: "child", parentToolUseId: "agent", toolKind: "read", title: "Read: child.ts", status: "completed", text: "Nested tool output" },
  ];
  const preview = payloads.map((payload, i) => ({ payload, seq: 501 + i, id: -(501 + i), ts: i, sessionId: "s" }));
  const builder = new TimelineBuilder();
  for (const event of preview) builder.push(event);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  cleanup(async () => { await act(async () => root.unmount()); container.remove(); });
  const reading = { current: null as TimelineReadingState | null };
  const disclosure = new Map([["work:user_message:501", true], ["agent:agent", true],
    ["row-details:item:tool:read", true], ["row-details:item:tool:child", true], ["row-details:agent-output:agent", true]]);
  await act(async () => root.render(<EventTimeline items={builder.snapshot()} historyKey="preview"
    readingStateRef={reading} initialDisclosure={disclosure} />));
  assert.ok(reading.current);
  const events: SessionEvent[] = preview.map((event, i) => ({ ...event, id: i + 1, seq: 507 + i + (i > 1 ? 1 : 0) }));
  events.splice(2, 0, { id: 10, sessionId: "s", seq: 509, ts: 1,
    payload: { kind: "agent_message", text: "Control-plane-only boundary", final: true } });
  const identities = preview.map((event, i) => ({ runnerSeq: event.seq, seq: 507 + i + (i > 1 ? 1 : 0) }));
  for (const [source, kind] of [[502, "item"], [504, "item"], [503, "subagent_output"]] as const) {
    const row: TimelineRenderRow | undefined = reading.current.rows.find(value => value.kind === kind && timelineRowSource(value) === source);
    assert.ok(row, "the expanded rendered source is captured rather than reprojected closed");
    const page: SessionHistoryHandoff = { events, identities, windowStartSeq: 507, windowEndSeq: 511,
      anchorSeq: identities.find(value => value.runnerSeq === source)!.seq, hasMoreHandoff: false,
      eventEpoch: 0, nextAfter: 511, tailSeq: 600, cacheComplete: true, hasMoreLater: true, hasMoreOlder: true };
    const converted = convertPreviewReadingState(reading.current, page,
      { seq: source, kind: preview[source - 501]!.payload.kind, rowKind: row.kind, rowKey: row.key, offset: -17 });
    assert.ok(converted);
    assert.equal(converted.anchor.offset, -17);
    assert.equal(converted.disclosure.get("row-details:item:tool:read"), true);
    assert.equal(converted.disclosure.get("row-details:item:tool:child"), true);
    assert.equal(converted.disclosure.get("row-details:agent-output:agent"), true);
    assert.equal(converted.disclosure.get("work:user_message:507"), true);
    assert.equal(converted.disclosure.get("work:agent_message:509"), true, "a CP-only boundary preserves both open pieces");
  }
});
