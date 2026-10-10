import type { SessionEvent, SessionEventPayload } from "@wollipog/protocol";

/** 500 completed synthetic turns × 21 events, followed by a three-event current turn. */
export function transcriptScrollEvents(): SessionEvent[] {
  const events: SessionEvent[] = [];
  const append = (payload: SessionEventPayload) => {
    const seq = events.length + 1;
    events.push({ id: seq, sessionId: "synthetic-scroll", seq, ts: 1_700_000_000_000 + seq * 10, payload });
  };
  for (let turn = 0; turn < 500; turn++) {
    append({ kind: "user_message", text: `Inspect synthetic module ${turn}. Preserve the public interface.` });
    for (let tool = 0; tool < 3; tool++) {
      const toolCallId = `synthetic-${turn}-${tool}`;
      append({ kind: "tool_call", toolCallId, title: `Read synthetic module ${turn}/${tool}`,
        toolKind: "read", status: "running", text: "Synthetic input." });
      for (let update = 0; update < 5; update++) append({ kind: "tool_call_update", toolCallId,
        status: update === 4 ? "completed" : "running", text: `Synthetic output ${update}.` });
    }
    append({ kind: "agent_message", final: true, text: [
      `## Synthetic Module ${turn}`,
      "",
      "The module preserves **stable callbacks**, validates inputs, and keeps the reader anchored. ".repeat(3),
      "",
      "| Module | Read | Write | Status | Details |",
      "| --- | ---: | ---: | --- | --- |",
      ...Array.from({ length: 6 }, (_, row) => `| \`src/module_${turn}/part_${row}.ts\` | ${row + 10} | ${row} | Verified | Synthetic measurement with a deliberately wide description |`),
      "",
      "```typescript",
      `export function module${turn}(input: readonly number[]) {`,
      "  return input.filter(Number.isFinite).map(value => value * 2);",
      "}",
      "```",
      "",
      "- [x] Validate the public interface",
      "- [x] Preserve safe markdown rendering",
      "- [ ] Review the synthetic result",
    ].join("\n") });
    append({ kind: "conversation_checkpoint", turn: turn + 1 });
  }
  append({ kind: "user_message", text: "Read this current turn from its beginning." });
  append({ kind: "agent_message", text: "Current synthetic turn.", final: true });
  append({ kind: "conversation_checkpoint", turn: 501 });
  return events;
}
