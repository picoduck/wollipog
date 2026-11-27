import assert from "node:assert/strict";
import { test } from "node:test";
import { guardPhase } from "./codex-guard-probe-phases.ts";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCliTurnImpl, cliProbeStatus } from "./codex-guard-hook-probe.ts";

test("no model request and timeouts remain unavailable while measured mismatch remains changed", () => {
  assert.equal(cliProbeStatus("EXIT 1", 0, false), "could not run");
  assert.equal(cliProbeStatus("TIMED OUT", 2, false), "could not run");
  assert.equal(cliProbeStatus("finished", 2, false), "changed");
  assert.equal(cliProbeStatus("finished", 2, true), "unchanged");
});

test("TUI timeout resolves after bounded shutdown even when the helper never closes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const home = mkdtempSync(join(tmpdir(), "guard-phase-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = new EventEmitter();
  const signals = [];
  child.kill = signal => { signals.push(signal); };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroy = child.stderr.destroy = () => {};
  const pending = runCliTurnImpl({ codexHome: home, repo: home }, [], "tui", () => child);
  t.mock.timers.tick(90000);
  assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(5000);
  assert.match(await pending, /TIMED OUT: CLI shutdown/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close", 0);
});

test("guard phases record active operations and sanitize failures", async (t) => {
  const events = [];
  t.mock.method(console, "log", line => events.push(JSON.parse(line)));
  let reject;
  const pending = guardPhase("inventory", 30000, () => new Promise((_, fail) => { reject = fail; }));
  assert.equal(events.length, 1);
  assert.equal(events[0].state, "started");
  assert.equal(events[0].limitMs, 30000);
  const error = new Error("private transcript");
  reject(error);
  await assert.rejects(pending, e => e === error);
  assert.equal(events[1].state, "failed");
  assert.equal(events[1].id, events[0].id);
  assert.ok(events[1].elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(events), /private transcript/);
  assert.equal(await guardPhase("cli-tui", 95000, async () => "TIMED OUT"), "TIMED OUT");
  assert.equal(events.at(-1).state, "completed");
});
