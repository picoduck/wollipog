import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { SessionEventPayload } from "@wollipog/protocol";
import { CLAUDE_PERSISTENT_FLAG, ClaudeCodeDriver } from "./claude-code.js";
import type { ClaudeLiveUsage, ClaudeUsageCheckpoint } from "./claude-usage-accounting.js";
import type { DriverCallbacks, DriverOptions } from "./driver.js";

/**
 * #4069: after a runner restart, a resumed Claude Code session was billed the conversation's
 * running total on every turn, because the recorded CLI version that chose the accounting scope
 * was missing or stale while the installed CLI restored conversation totals.
 */

type Usage = Extract<SessionEventPayload, { kind: "token_usage" }>;
type Request = { input: number; output: number; cacheRead: number; cacheCreation: number };
type Tokens = { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheCreationInputTokens: number };

const MODEL = "claude-opus-5";
const price = (r: Request) => r.input * 3e-6 + r.output * 15e-6 + r.cacheRead * 0.3e-6 + r.cacheCreation * 3.75e-6;
const tokens = (requests: Request[]): Tokens => ({
  inputTokens: requests.reduce((sum, r) => sum + r.input, 0),
  outputTokens: requests.reduce((sum, r) => sum + r.output, 0),
  cachedInputTokens: requests.reduce((sum, r) => sum + r.cacheRead, 0),
  cacheCreationInputTokens: requests.reduce((sum, r) => sum + r.cacheCreation, 0),
});
const cost = (requests: Request[]) => requests.reduce((sum, r) => sum + price(r), 0);

/** Each turn's own requests. Cache reads grow with the conversation, as in the observed session. */
const turnRequests = (turn: number): Request[] => [
  { input: 10 + turn, output: 400 + 7 * turn, cacheRead: 70_000 + 9_000 * turn, cacheCreation: 2_000 + turn },
  { input: 3, output: 250 + 11 * turn, cacheRead: 74_000 + 9_000 * turn, cacheCreation: 900 },
];

/**
 * A Claude Code CLI that persists its conversation totals (2.1.277+) and restores them whenever the
 * conversation is resumed, including after its process was terminated mid-turn.
 */
class FakeClaude {
  readonly requests: Request[] = [];
  readonly children: Array<{ child: any; resume: boolean }> = [];
  constructor(readonly version: string | undefined) {}

  init(sessionId: string) {
    return { type: "system", subtype: "init", session_id: sessionId, ...(this.version ? { claude_code_version: this.version } : {}) };
  }

  /** The conversation's cumulative totals, as every result (and the resume probe) reports them. */
  totals(sessionId: string, mainLoop: Record<string, number> = {}) {
    const t = tokens(this.requests);
    return { type: "result", subtype: "success", session_id: sessionId, total_cost_usd: cost(this.requests), usage: mainLoop,
      modelUsage: { [MODEL]: { inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheReadInputTokens: t.cachedInputTokens,
        cacheCreationInputTokens: t.cacheCreationInputTokens, costUSD: cost(this.requests), costBasis: "list" } } };
  }

  spawn = (spawned: { args: string[] }) => {
    const child = new EventEmitter() as any;
    child.pid = 4069;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const at = (flag: string) => spawned.args.indexOf(flag);
    const id = spawned.args[(at("--resume") >= 0 ? at("--resume") : at("--session-id")) + 1]!;
    if (spawned.args.includes("--tools")) {
      // The resume accounting probe: a local command that reports the restored totals.
      child.stdin.once("data", () => {
        child.stdout.write(JSON.stringify(this.init(id)) + "\n");
        child.stdout.write(JSON.stringify(this.totals(id)) + "\n");
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    }
    this.children.push({ child, resume: at("--resume") >= 0 });
    return child;
  };

  /** Play one turn on the newest process: its requests stream live, then (unless the turn is
   * interrupted) its result reports the conversation totals and the one-shot process exits. */
  play(sessionId: string, requests: Request[], complete = true) {
    const { child } = this.children.at(-1)!;
    const write = (record: unknown) => child.stdout.write(JSON.stringify(record) + "\n");
    write(this.init(sessionId));
    requests.forEach((r, index) => {
      write({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: `msg_${this.requests.length}_${index}`, model: MODEL,
        usage: { input_tokens: r.input, cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheCreation, output_tokens: 1 } } } });
      write({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage: { output_tokens: r.output } } });
      write({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } });
      // Claude persists its cost state as it goes, so even an interrupted turn is restored later.
      this.requests.push(r);
    });
    if (!complete) return;
    const last = requests.at(-1)!;
    write(this.totals(sessionId, { input_tokens: last.input, output_tokens: last.output }));
    setImmediate(() => child.emit("close", 0));
  }
}

const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i++) await nextTask(); };

/** Records the control plane accrues: everything but display-only provisional requests. */
const accrued = (events: SessionEventPayload[]) => events.filter((event): event is Usage =>
  event.kind === "token_usage" && !event.parentToolUseId && event.liveUsage !== "provisional");
const sumTokens = (records: Usage[]): Tokens => ({
  inputTokens: records.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
  outputTokens: records.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
  cachedInputTokens: records.reduce((sum, r) => sum + (r.cachedInputTokens ?? 0), 0),
  cacheCreationInputTokens: records.reduce((sum, r) => sum + (r.cacheCreationInputTokens ?? 0), 0),
});
const sumCost = (records: Usage[]) => records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
const near = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);

/** What the session manager hands a relaunched driver: the last journaled checkpoint and the live
 * requests published after it that nothing has settled. */
function recover(events: SessionEventPayload[], checkpoints: ClaudeUsageCheckpoint[]) {
  let live: ClaudeLiveUsage = [];
  for (const event of events) {
    if (event.kind !== "token_usage" || event.parentToolUseId) continue;
    if (event.liveUsage === "settled") live = [];
    else if (event.liveUsage === "provisional") live.push(event);
    else if (event.liveUsage === "republished") live.shift();
  }
  return { claudeUsageCheckpoint: checkpoints.at(-1), ...(live.length ? { claudeLiveUsage: live } : {}) };
}

function driverFor(cli: FakeClaude, events: SessionEventPayload[], checkpoints: ClaudeUsageCheckpoint[], opts: Partial<DriverOptions>) {
  const cb: DriverCallbacks = {
    onEvent: (event) => events.push(event), onStderr: () => {}, onExit: () => {},
    onClaudeUsageCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    supportsLiveClaudeUsage: () => true,
  };
  return new ClaudeCodeDriver({
    command: "claude", args: [], cwd: "/tmp/work", env: { [CLAUDE_PERSISTENT_FLAG]: "0" },
    config: { permissionMode: "acceptEdits" } as DriverOptions["config"], context: {} as DriverOptions["context"], ...opts,
  }, cb, { spawn: cli.spawn, kill: () => {}, setTimer: () => ({ unref() {} }) as any, clearTimer: () => {} } as any);
}

/** One completed turn on a fresh one-shot process; returns the records it accrued. */
async function completeTurn(driver: ClaudeCodeDriver, cli: FakeClaude, events: SessionEventPayload[], requests: Request[]) {
  const from = events.length;
  const spawned = cli.children.length;
  const prompt = driver.prompt("continue");
  await settle();
  assert.equal(cli.children.length, spawned + 1, "each turn runs in a new provider process");
  cli.play(driver.agentSessionId()!, requests);
  assert.equal(await prompt, "end_turn");
  return accrued(events.slice(from));
}

/** Runner life before the restart: one completed turn, then a turn interrupted by the restart. */
async function beforeRestart(cli: FakeClaude) {
  const events: SessionEventPayload[] = [];
  const checkpoints: ClaudeUsageCheckpoint[] = [];
  const driver = driverFor(cli, events, checkpoints, { agentVersion: "2.1.296" });
  await completeTurn(driver, cli, events, turnRequests(0));
  const interrupted = driver.prompt("interrupted");
  await settle();
  cli.play(driver.agentSessionId()!, turnRequests(1), false);
  await settle();
  assert.equal(events.filter((event) => event.kind === "token_usage" && event.liveUsage === "provisional").length, 4,
    "the interrupted turn's requests were shown live");
  const sessionId = driver.agentSessionId()!;
  // The runner dies: the driver is gone without a result; Claude keeps the persisted totals.
  driver.dispose();
  void interrupted;
  return { sessionId, events, recovered: recover(events, checkpoints), priorTotal: cost(cli.requests) };
}

for (const [label, agentVersion] of [["missing", undefined], ["stale", "2.1.270"], ["current", "2.1.296"]] as const) {
  test(`after a runner restart with a ${label} recorded Claude version, settled turns sum to the conversation total and never repeat earlier usage`, async () => {
    const cli = new FakeClaude("2.1.296");
    const before = await beforeRestart(cli);
    const events: SessionEventPayload[] = [];
    const checkpoints: ClaudeUsageCheckpoint[] = [];
    const driver = driverFor(cli, events, checkpoints, { resumeId: before.sessionId, agentVersion, ...before.recovered });
    await driver.initialize();
    const resumeRecords = accrued(events);

    // The automatic resume, then three more turns, each in its own provider process.
    const turns: Usage[][] = [];
    for (let turn = 2; turn <= 5; turn++) turns.push(await completeTurn(driver, cli, events, turnRequests(turn)));

    const all = [...accrued(before.events), ...accrued(events)];
    assert.equal(all.some((record) => record.accountingIncomplete), false, "every difference here is provable");
    near(sumCost(all), cost(cli.requests), "settled records sum to the provider's conversation total");
    assert.deepEqual(sumTokens(all), tokens(cli.requests), "and so do their tokens");

    // The interrupted turn settles once: at the resume probe, or in the first resumed turn's total.
    const interrupted = turnRequests(1);
    const first = [...resumeRecords, ...turns[0]!];
    assert.deepEqual(sumTokens(first), tokens([...interrupted, ...turnRequests(2)]));
    near(sumCost(first), cost([...interrupted, ...turnRequests(2)]), "the resumed turn and the interrupted one");
    turns.slice(1).forEach((records, index) => {
      const own = turnRequests(index + 3);
      assert.deepEqual(sumTokens(records), tokens(own), `turn ${index + 3} accrues only its own tokens`);
      near(sumCost(records), cost(own), `turn ${index + 3} accrues only its own cost`);
      assert.ok(sumCost(records) < before.priorTotal, `turn ${index + 3} does not repeat an earlier total`);
    });
    driver.dispose();
  });
}

test("a resumed CLI that reports no version is never billed a running total: its observed requests are accounted and marked incomplete", async () => {
  const cli = new FakeClaude(undefined);
  const before = await beforeRestart(cli);
  const events: SessionEventPayload[] = [];
  const driver = driverFor(cli, events, [], { resumeId: before.sessionId, ...before.recovered });
  await driver.initialize();
  const turns: Usage[][] = [];
  for (let turn = 2; turn <= 5; turn++) turns.push(await completeTurn(driver, cli, events, turnRequests(turn)));

  // The first resumed turn also republishes the interrupted turn's observed requests.
  assert.deepEqual(sumTokens(turns[0]!), tokens([...turnRequests(1), ...turnRequests(2)]));
  turns.slice(1).forEach((records, index) => assert.deepEqual(sumTokens(records), tokens(turnRequests(index + 3)),
    `turn ${index + 3} accounts only its own observed requests`));
  for (const records of turns) {
    assert.equal(records.at(-1)!.accountingIncomplete, true, "the record is uncertain, not exact");
    assert.equal(sumCost(records), 0, "no running total is billed; the control plane prices the observed requests");
    assert.ok(records.slice(0, -1).every((record) => record.liveUsage === "republished"));
  }
  const all = [...accrued(before.events), ...accrued(events)];
  assert.deepEqual(sumTokens(all), tokens(cli.requests), "every observed request is accounted exactly once");
  driver.dispose();
});

test("an old CLI that reports its version keeps per-process totals even when the recorded version is missing", async () => {
  const cli = new FakeClaude("2.1.270");
  const events: SessionEventPayload[] = [];
  const driver = driverFor(cli, events, [], { resumeId: "old-session" });
  // An old CLI restarts its totals with each process; model that by clearing them per turn.
  for (let turn = 0; turn < 3; turn++) {
    cli.requests.length = 0;
    const records = await completeTurn(driver, cli, events, turnRequests(turn));
    assert.equal(records.some((record) => record.accountingIncomplete), false);
    near(sumCost(records), cost(turnRequests(turn)), `turn ${turn} is billed its own process total`);
  }
  driver.dispose();
});
