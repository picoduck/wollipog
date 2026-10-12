import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { SessionEventPayload } from "@wollipog/protocol";
import { CLAUDE_PERSISTENT_FLAG, ClaudeCodeDriver } from "./claude-code.js";
import type { ClaudeUsageCheckpoint } from "./claude-usage-accounting.js";
import type { DriverCallbacks, DriverOptions } from "./driver.js";

type Usage = Extract<SessionEventPayload, { kind: "token_usage" }>;

/** One real Claude Code 2.1.296 turn (two requests) reduced to its usage-bearing records. Each
 * request's `assistant` copy repeats `message_start`'s partial output count; only the stream's
 * `message_delta` carries the final one, and the two requests sum exactly to `result.modelUsage`. */
const recorded = JSON.parse(readFileSync(new URL("./fixtures/claude-live-usage-stream.json", import.meta.url), "utf8")) as any[];
const turn = recorded.filter((record) => record.type !== "result");
const result = recorded.find((record) => record.type === "result")!;
const modelUsage = result.modelUsage["claude-haiku-5-5"];

const baseOpts: DriverOptions = {
  command: "claude", args: [], cwd: "/tmp/work", env: { [CLAUDE_PERSISTENT_FLAG]: "1" },
  config: { permissionMode: "acceptEdits" } as DriverOptions["config"],
  context: {} as DriverOptions["context"], agentVersion: "2.1.296",
};

function fakeProcess() {
  const child = new EventEmitter() as any;
  child.pid = 123;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));
const usage = (events: SessionEventPayload[]) => events.filter((event): event is Usage => event.kind === "token_usage");
const sum = (events: Usage[], field: "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheCreationInputTokens") =>
  events.reduce((total, event) => total + (event[field] ?? 0), 0);

/** A persistent Claude driver whose resume probe reports `restored` as the persisted prefix. */
function harness(options: { live?: boolean; restored?: () => unknown } = {}) {
  const children: any[] = [];
  const events: SessionEventPayload[] = [];
  const checkpoints: ClaudeUsageCheckpoint[] = [];
  const capability = { live: true };
  const cb: DriverCallbacks = {
    onEvent: (event) => events.push(event), onStderr: () => {}, onExit: () => {},
    onClaudeUsageCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    ...(options.live === false ? {} : { supportsLiveClaudeUsage: () => capability.live }),
  };
  const driver = new ClaudeCodeDriver(baseOpts, cb, {
    spawn: (spawned: any) => {
      const child = fakeProcess();
      if (spawned.args.includes("--tools")) {
        const id = spawned.args[spawned.args.indexOf("--resume") + 1];
        child.stdin.on("data", () => {
          child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: id }) + "\n");
          child.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: id, usage: {},
            ...(options.restored?.() as object) }) + "\n");
          setImmediate(() => child.emit("close", 0));
        });
        return child;
      }
      children.push(child);
      return child;
    },
    kill: () => {}, setTimer: () => ({ unref() {} }) as any, clearTimer: () => {},
  } as any);
  const write = (child: any, records: unknown[]) => {
    for (const record of records) child.stdout.write(JSON.stringify(record) + "\n");
  };
  return { driver, children, events, checkpoints, write, capability };
}

test("a running Claude turn publishes each completed request before its result, and the result alone accounts them", async () => {
  const h = harness();
  const prompt = h.driver.prompt("one");
  await nextTask();
  h.write(h.children[0], turn);
  await nextTask();
  const live = usage(h.events);
  assert.equal(live.length, 2, "one provisional record per request, not one per content block");
  assert.ok(live.every((event) => event.liveUsage === "provisional" && event.model === "claude-haiku-5-5" && event.costUsd === undefined));
  assert.equal(sum(live, "outputTokens"), modelUsage.outputTokens, "message_delta's final output count, not the assistant copy's");
  assert.equal(sum(live, "inputTokens"), modelUsage.inputTokens);
  assert.equal(sum(live, "cachedInputTokens"), modelUsage.cacheReadInputTokens);
  assert.equal(sum(live, "cacheCreationInputTokens"), modelUsage.cacheCreationInputTokens);
  assert.deepEqual(live[0]!.pricingContext, { requestInputTokens: 2 + 13182 + 20213, serviceTier: "standard" });

  h.write(h.children[0], [{ ...result, type: "result" }]);
  assert.equal(await prompt, "end_turn");
  const all = usage(h.events);
  const settlement = all.slice(2);
  assert.deepEqual(settlement.map((event) => event.liveUsage), ["settled"], "the result closes the live window");
  // Live records are display-only, so the cumulative result is accounted exactly as before.
  assert.equal(settlement[0]!.costUsd, result.total_cost_usd);
  assert.equal(settlement[0]!.inputTokens, modelUsage.inputTokens);
  assert.equal(settlement[0]!.outputTokens, modelUsage.outputTokens);
  assert.equal(settlement[0]!.cachedInputTokens, modelUsage.cacheReadInputTokens);
  assert.equal(settlement[0]!.claudeUsageCheckpoint?.totalCostUsd, result.total_cost_usd);
  h.driver.dispose();
});

test("an interrupted first turn is accounted when the next launch restores its persisted total", async () => {
  // Claude persists `cost-state` on SIGTERM, so the next process restores the interrupted turn.
  const h = harness({ restored: () => ({ total_cost_usd: result.total_cost_usd, modelUsage: result.modelUsage }) });
  const first = h.driver.prompt("one");
  await nextTask();
  assert.deepEqual(h.checkpoints[0], { sessionId: h.checkpoints[0]!.sessionId, totalCostUsd: 0, models: {}, accountingScope: "conversation" },
    "a new conversation records its zero baseline before any provider work");
  h.write(h.children[0], [{ type: "system", subtype: "init", session_id: h.checkpoints[0]!.sessionId }, ...turn]);
  await nextTask();
  assert.equal(usage(h.events).length, 2);
  h.driver.cancel();
  assert.equal(await first, "cancelled");

  const second = h.driver.prompt("two");
  await nextTask();
  h.children[0].emit("close", null);
  await nextTask();
  await nextTask();
  const settlement = usage(h.events).slice(2);
  assert.deepEqual(settlement.map((event) => event.liveUsage), ["settled"]);
  assert.equal(settlement[0]!.costUsd, result.total_cost_usd, "the interrupted turn's persisted total is accounted");
  assert.equal(sum(settlement, "outputTokens"), modelUsage.outputTokens);

  assert.equal(h.children.length, 2);
  h.write(h.children[1], [{ type: "result", subtype: "success", total_cost_usd: result.total_cost_usd + 0.001,
    modelUsage: { "claude-haiku-5-5": { ...modelUsage, outputTokens: modelUsage.outputTokens + 10, costUSD: modelUsage.costUSD + 0.001 } } }]);
  assert.equal(await second, "end_turn");
  const next = usage(h.events).slice(3);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.outputTokens, 10);
  assert.equal(next[0]!.liveUsage, undefined, "a turn without live records keeps the legacy payload");
  h.driver.dispose();
});

test("a killed process whose totals were not persisted accounts exactly the requests observed live", async () => {
  // SIGKILL skips Claude's exit-time `cost-state`; the restored conversation total stays at zero.
  const h = harness({ restored: () => ({ total_cost_usd: 0, modelUsage: {} }) });
  const first = h.driver.prompt("one");
  await nextTask();
  h.write(h.children[0], [{ type: "system", subtype: "init", session_id: h.checkpoints[0]!.sessionId }, ...turn]);
  await nextTask();
  h.driver.cancel();
  await first;
  const second = h.driver.prompt("two");
  await nextTask();
  h.children[0].emit("close", null);
  await nextTask();
  await nextTask();
  const all = usage(h.events);
  assert.deepEqual(all.map((event) => event.liveUsage), ["provisional", "provisional", "republished", "settled"]);
  assert.deepEqual(all[2], { ...all[0], liveUsage: "republished" }, "each request is republished as an ordinary record, with its own pricing context");
  assert.equal(sum(all.slice(2), "outputTokens"), modelUsage.outputTokens);
  assert.equal(all.slice(2).some((event) => event.costUsd !== undefined), false, "the control plane prices them");
  h.write(h.children[1], [{ type: "result", subtype: "success", total_cost_usd: 0 }]);
  await second;
  h.driver.dispose();
});

test("without the negotiated capability a Claude turn reports usage only on its result, as before", async () => {
  const h = harness({ live: false });
  const prompt = h.driver.prompt("one");
  await nextTask();
  h.write(h.children[0], [...turn, { ...result, type: "result" }]);
  assert.equal(await prompt, "end_turn");
  const all = usage(h.events);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.liveUsage, undefined);
  assert.equal(all[0]!.outputTokens, modelUsage.outputTokens);
  assert.equal(all[0]!.costUsd, result.total_cost_usd);
  h.driver.dispose();
});

test("a request that ends after the control plane lost the capability is not published provisionally", async () => {
  const h = harness();
  const prompt = h.driver.prompt("one");
  await nextTask();
  const [start, assistant, delta, stop] = turn;
  h.write(h.children[0], [start, assistant, delta]);
  await nextTask();
  h.capability.live = false; // reconnected to a v214 control plane mid-request
  h.write(h.children[0], [stop, { ...result, type: "result" }]);
  assert.equal(await prompt, "end_turn");
  assert.deepEqual(usage(h.events).map((event) => event.liveUsage), [undefined], "only the result, accounted as before");
  h.driver.dispose();
});

test("an inconclusive result does not journal its unchanged baseline over open live requests", async () => {
  const h = harness();
  const prompt = h.driver.prompt("one");
  await nextTask();
  const journaled = h.checkpoints.length;
  h.write(h.children[0], [...turn.slice(0, 4),
    { type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0, modelUsage: {} }]);
  await prompt;
  assert.equal(h.checkpoints.length, journaled, "the recovery cursor stays before the open window");
  const incomplete = usage(h.events).at(-1)!;
  assert.deepEqual([incomplete.accountingIncomplete, incomplete.liveUsage, incomplete.claudeUsageCheckpoint], [true, undefined, undefined]);
  h.driver.dispose();
});

test("a thinking request carries its reasoning subset live and when republished", async () => {
  const h = harness({ restored: () => ({ total_cost_usd: 0, modelUsage: {} }) });
  const first = h.driver.prompt("one");
  await nextTask();
  h.write(h.children[0], [{ type: "system", subtype: "init", session_id: h.checkpoints[0]!.sessionId },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_thinking", model: "claude-haiku-5-5",
      usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta",
      usage: { output_tokens: 30, output_tokens_details: { thinking_tokens: 12 } } } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } }]);
  await nextTask();
  h.driver.cancel();
  await first;
  const second = h.driver.prompt("two");
  await nextTask();
  h.children[0].emit("close", null);
  await nextTask();
  await nextTask();
  assert.deepEqual(usage(h.events).map((event) => [event.liveUsage, event.outputTokens, event.reasoningOutputTokens]),
    [["provisional", 30, 12], ["settled", 30, 12]]);
  h.write(h.children[1], [{ type: "result", subtype: "success", total_cost_usd: 0 }]);
  await second;
  h.driver.dispose();
});
