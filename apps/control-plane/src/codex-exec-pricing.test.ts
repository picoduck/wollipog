import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { SessionEventPayload } from "@wollipog/protocol";
import { CodexDriver } from "../../runner/src/drivers/codex.js";
import type { AgentProcess } from "../../runner/src/spawn.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { parseRateTable } from "./usage-pricing.js";

test("Codex exec usage without request context stays incomplete through accounting and budget checks", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  t.after(() => db.close());
  db.registerRunner({ runnerId: "exec-runner", hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: "ws", name: "Repo", path: "/tmp/exec-pricing" }],
    agents: [{ id: "exec", name: "Codex Exec", command: "codex", args: [], env: {}, driver: "codex",
      available: true, context: { kind: "native" } }],
  }, 1);
  db.setUsageRateTable(parseRateTable({
    "context-model": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001,
      input_cost_per_token_above_272k_tokens: 0.000004, output_cost_per_token_above_272k_tokens: 0.00002 },
    "tier-model": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001,
      input_cost_per_token_priority: 0.000004, output_cost_per_token_priority: 0.00002 },
  }));
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const principal = { kind: "human" as const, actorId: "usr_local_owner", userId: "usr_local_owner",
    userName: "Local owner", organizationId: "org_personal", organizationName: "Personal",
    role: "owner" as const, deviceId: null, localBootstrap: true };

  for (const model of ["context-model", "tier-model"]) {
    db.createSession({ id: model, runnerId: "exec-runner", workspaceId: "ws", agentId: "exec",
      title: "Pricing regression", useWorktree: false, driver: "codex", config: { model }, now: 1000 });
    db.updateSessionCostBudget(model, 10, 1000);
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 12345,
    }) as unknown as AgentProcess;
    const events: SessionEventPayload[] = [];
    const driver = new CodexDriver({ command: "codex", args: [], cwd: "/tmp/exec-pricing", env: {},
      config: { model }, context: { kind: "native" },
    }, { onEvent: (payload) => events.push(payload), onStderr() {}, onExit() {} },
    { spawn: () => child, kill() {} });
    t.after(() => driver.dispose());
    const turn = driver.prompt("synthetic accounting fixture");
    stdout.write(JSON.stringify({ type: "turn.completed",
      usage: { input_tokens: 300000, cached_input_tokens: 200000, output_tokens: 100, reasoning_output_tokens: 40 },
    }) + "\n");
    child.emit("close", 0, null);
    assert.equal(await turn, "end_turn");
    assert.deepEqual(events, [{ kind: "token_usage", model, inputTokens: 300000, cachedInputTokens: 200000,
      outputTokens: 100, reasoningOutputTokens: 40 }], "turn totals supply neither request input size nor actual tier");
    db.appendEvent(model, events[0]!, 3_600_100, { accrueUsage: true });
    const session = db.getSession(model)!;
    assert.equal(session.costUsd, 0);
    assert.equal(session.costSource, "unpriced");
    assert.equal(db.sessionUsageUnpriced(model), true);
    const byModel = db.sessionUsageByModel(model);
    assert.equal(byModel.totals.costSource, "unpriced");
    assert.equal(byModel.totals.unpricedRecords, 1);
    assert.equal(byModel.totals.processedTokens, 300100);
    assert.equal(byModel.totals.cacheSavingsUsd, 0);
    svc.onSessionStatus(model, "idle");
    assert.equal(db.getSession(model)!.status, "input_required");
    assert.equal(db.getSession(model)!.pendingApproval?.kind, "cost_unpriced",
      "a budget cannot silently compare missing variant costs against zero");
  }
  let usage = db.queryUsageAggregation(principal, { since: 0, through: 10_000_000, granularity: "hour" });
  for (const amount of [usage.totals, ...usage.series, ...usage.seriesByDriver, ...usage.byDriver,
    ...usage.byAgent, ...usage.byRunner, ...usage.byModel]) {
    assert.equal(amount.costSource, "unpriced");
    assert.ok(amount.unpricedRecords > 0);
    assert.equal(amount.costUsd, 0);
  }
  assert.equal(usage.totals.inputTokens, 600000);
  assert.equal(usage.totals.cachedInputTokens, 400000);
  assert.equal(usage.totals.reasoningTokens, 80);

  // A trustworthy cost can still accrue, while the mixed total keeps its incomplete provenance.
  db.appendEvent("tier-model", { kind: "token_usage", inputTokens: 10, outputTokens: 1, costUsd: 0.5 },
    3_600_200, { accrueUsage: true });
  assert.equal(db.getSession("tier-model")!.costUsd, 0.5);
  assert.equal(db.getSession("tier-model")!.costSource, "unpriced");
  assert.equal(db.sessionUsageUnpriced("tier-model"), false, "the existing mixed-cost lower-bound policy is preserved");
  usage = db.queryUsageAggregation(principal, { since: 0, through: 10_000_000, granularity: "hour" });
  assert.equal(usage.totals.costUsd, 0.5);
  assert.equal(usage.totals.costSource, "unpriced");
  assert.equal(usage.totals.unpricedRecords, 2);
});
