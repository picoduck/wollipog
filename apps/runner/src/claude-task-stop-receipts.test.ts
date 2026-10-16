import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { claudeTaskStopReceipts } from "./claude-task-stop-receipts.js";

const call = (id: string, tool = "stop") => ({ type: "assistant", message: { content: [
  { type: "tool_use", id: tool, name: "TaskStop", input: { task_id: id } },
] } });
const result = (id: string, tool = "stop", is_error = false) => ({ type: "user", message: { content: [
  { type: "tool_result", tool_use_id: tool, is_error,
    content: JSON.stringify({ task_id: id, message: `Successfully stopped task: ${id}` }) },
] } });
const ledger = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

test("only matching successful provider receipts settle a TaskStop", () => {
  assert.deepEqual([...claudeTaskStopReceipts(ledger(call("one"), result("one"))).keys()], ["one"]);
  for (const records of [
    [result("one")], [call("one")], [result("one"), call("one")],
    [call("one"), result("two")], [call("one"), result("one", "other")],
    [call("one"), result("one", "stop", true)],
    [call("one"), call("one"), result("one")],
    [call("one"), { ...result("one"), type: "assistant" }],
    [call("one"), { type: "user", message: { content: "Successfully stopped task: one" } }],
    [call("one"), { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "stop", content: "No task found with ID: one" },
    ] } }],
  ]) assert.equal(claudeTaskStopReceipts(ledger(...records)).size, 0);
});

test("receipt correlation and resume invalidation hold for arbitrary task identities", () => {
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }), (id) => {
    assert.deepEqual([...claudeTaskStopReceipts(ledger(call(id), result(id))).keys()], [id]);
    assert.equal(claudeTaskStopReceipts(ledger(call(id), result(`${id}x`))).size, 0);
    const resume = { type: "assistant", message: { content: [
      { type: "tool_use", id: "resume", name: "Agent", input: { resume: id } },
    ] } };
    assert.equal(claudeTaskStopReceipts(ledger(call(id), result(id), resume)).size, 0);
    assert.equal(claudeTaskStopReceipts(ledger(call(id), resume, result(id))).size, 0);
    assert.deepEqual([...claudeTaskStopReceipts(ledger(resume, call(id), result(id))).keys()], [id]);
  }), { numRuns: 200, seed: 3280 });
});

test("quoted, malformed, and torn transcript content does not become a stop receipt", () => {
  const proof = ledger(call("one"), result("one"));
  assert.equal(claudeTaskStopReceipts(ledger({ type: "user", message: { content: proof } })).size, 0);
  assert.equal(claudeTaskStopReceipts(`${JSON.stringify(call("one"))}\n${JSON.stringify(result("one")).slice(0, -3)}`).size, 0);
  assert.equal(claudeTaskStopReceipts(`invalid\n${proof}`).size, 0);
  assert.equal(claudeTaskStopReceipts(`${proof}\n{"type":"assistant"`).size, 0, "a torn suffix may hide a resume");
  for (const launch of [
    { type: "user", toolUseResult: { resumedAgentId: "one" } },
    { type: "system", subtype: "task_started", task_id: "one" },
  ]) assert.equal(claudeTaskStopReceipts(`${proof}\n${JSON.stringify(launch)}`).size, 0);
});
