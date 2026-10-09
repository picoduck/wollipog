import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import type { SessionEvent } from "@wollipog/protocol";
import { continueStreamingText, TimelineBuilder, timelineItemIsStreaming, type TimelineItem } from "../timeline.js";
import { onlyContinuesTrailingText } from "./live-timeline-tail.js";

/**
 * The session view is not rendered for a chunk that only lengthens the trailing reply (#2763); the
 * transcript folds it in with `continueStreamingText`. These tests pin which chunks qualify, and
 * hold the fold to exactly what `TimelineBuilder` derives from the same events.
 */

let nextSeq = 0;
const at = (payload: SessionEvent["payload"], sessionId = "s1"): SessionEvent => {
  nextSeq += 1;
  return { id: nextSeq, sessionId, seq: nextSeq, ts: 1_000 + nextSeq, payload };
};
const chunk = (text: string, extra: { kind?: "agent_message" | "agent_thought"; messageId?: string; final?: boolean; parentToolUseId?: string } = {}) =>
  at({ kind: extra.kind ?? "agent_message", text, ...(extra.messageId ? { messageId: extra.messageId } : {}),
    ...(extra.final ? { final: true } : {}), ...(extra.parentToolUseId ? { parentToolUseId: extra.parentToolUseId } : {}) });

test("only more chunks of the reply the history ends with continue its trailing text", () => {
  const base = [at({ kind: "user_message", text: "Go", images: [] }), chunk("One ")];
  assert.equal(onlyContinuesTrailingText(base, [...base, chunk("two "), chunk("three")]), true);

  const identified = [...base, chunk("A ", { messageId: "m1" })];
  assert.equal(onlyContinuesTrailingText(identified, [...identified, chunk("B", { messageId: "m1" })]), true);
  const thought = [...base, chunk("Hmm ", { kind: "agent_thought" })];
  assert.equal(onlyContinuesTrailingText(thought, [...thought, chunk("more", { kind: "agent_thought" })]), true);

  const refused: Array<[string, SessionEvent[], SessionEvent[]]> = [
    ["the same array", base, base],
    ["a reasoning chunk after a reply", base, [...base, chunk("x", { kind: "agent_thought" })]],
    ["another provider message", identified, [...identified, chunk("C", { messageId: "m2" })]],
    ["an identified chunk after an anonymous one", base, [...base, chunk("D", { messageId: "m1" })]],
    ["a final message", base, [...base, chunk("done", { final: true })]],
    ["a subagent's chunk", base, [...base, chunk("sub", { parentToolUseId: "tool-1" })]],
    // The builder tells an explicitly empty parent apart from none, and starts a new item for it.
    ["a chunk with an empty parent", base, [...base, { ...chunk("x"), payload: { kind: "agent_message", text: "x", parentToolUseId: "" } }]],
    ["a tool call", base, [...base, at({ kind: "tool_call", toolCallId: "t", title: "Read", status: "completed" })]],
    ["a chunk after a tool call", [...base, at({ kind: "tool_call", toolCallId: "t", title: "Read", status: "completed" })],
      [...base, at({ kind: "tool_call", toolCallId: "t2", title: "Read", status: "completed" }), chunk("x")]],
    ["a rebuilt prefix", base, [base[0]!, { ...base[1]! }, chunk("x")]],
    ["a shorter history", base, base.slice(0, 1)],
    ["another session's chunk", base, [...base, chunk("x", {}), { ...chunk("y"), sessionId: "s2" }]],
    ["an out-of-order chunk", base, [...base, { ...chunk("x"), seq: base[1]!.seq }]],
    ["a chunk timed before the last one", base, [...base, { ...chunk("x"), ts: base[1]!.ts - 1 }]],
    ["no history yet", [], [chunk("x")]],
  ];
  for (const [name, previous, next] of refused) assert.equal(onlyContinuesTrailingText(previous, next), false, name);
  assert.equal(onlyContinuesTrailingText(undefined, base), false);
});

function derive(events: readonly SessionEvent[]): TimelineItem[] {
  const builder = new TimelineBuilder();
  for (const event of events) builder.push(event);
  return builder.snapshot();
}

test("folding chunks onto the derived reply equals deriving them, for any split", () => {
  fc.assert(fc.property(
    fc.array(fc.string({ maxLength: 6 }), { minLength: 2, maxLength: 12 }),
    fc.constantFrom<"agent_message" | "agent_thought">("agent_message", "agent_thought"),
    fc.option(fc.constantFrom("m1", "provider-msg"), { nil: undefined }),
    fc.array(fc.integer({ min: -5, max: 5 }), { minLength: 12, maxLength: 12 }),
    fc.nat(),
    (texts, kind, messageId, jitter, splitSeed) => {
      nextSeq = 0;
      const prompt = at({ kind: "user_message", text: "Explain", images: [] });
      // Timestamps may go backwards: the builder keeps the latest activity time.
      const chunks = texts.map((text, index) => ({
        ...chunk(text, { kind, messageId }),
        ts: 2_000 + index * 3 + jitter[index]!,
      }));
      const split = 1 + (splitSeed % (chunks.length - 1));
      const derivedFrom = [prompt, ...chunks.slice(0, split)];
      const live = [prompt, ...chunks];
      const forward = chunks.slice(split - 1).every((event, index, all) => index === 0 || event.ts >= all[index - 1]!.ts);
      assert.equal(onlyContinuesTrailingText(derivedFrom, live), forward,
        "a chunk timed before the one it follows is left to the session view");

      const expected = derive(live);
      const items = derive(derivedFrom);
      const index = items.length - 1;
      let folded = items[index] as Extract<TimelineItem, { kind: "agent_message" | "agent_thought" }>;
      for (const event of chunks.slice(split)) {
        folded = continueStreamingText(folded, event.seq, (event.payload as { text: string }).text, event.ts);
      }
      assert.deepEqual(folded, expected[index]);
      assert.equal(timelineItemIsStreaming(folded), timelineItemIsStreaming(expected[index]!));
      assert.deepEqual(items.slice(0, index), expected.slice(0, index), "nothing before the reply changes");
    },
  ), { numRuns: 500 });
});
