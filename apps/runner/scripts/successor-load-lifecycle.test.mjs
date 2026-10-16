import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runFocusedValidation } from "./successor-load-lifecycle.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const messages = (error) => [error.message, ...(error.errors ?? []).map(messages), error.cause ? messages(error.cause) : ""].join("\n");
const args = (source) => ["--input-type=module", "--eval", source];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };

test("outer timeout explicitly retains escaped contenders and fixture state without touching unrelated state", async (t) => {
  const unrelated = mkdtempSync(join(tmpdir(), "wollipog-load-unrelated-"));
  writeFileSync(join(unrelated, "keep"), "unrelated evidence");
  const peer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  let report;
  const source = `
    import { spawn } from "node:child_process";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const parent = process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT;
    const root = join(parent, "race");
    mkdirSync(root);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], {
      detached: process.platform !== "win32", stdio: "ignore",
    });
    writeFileSync(join(root, "contenders.json"), JSON.stringify({ contenders: [{ pid: child.pid }] }));
    console.log(JSON.stringify({ parent, root, pid: child.pid }));
    setInterval(() => {}, 1000);
  `;
  t.after(async () => {
    peer.kill();
    if (report) {
      // Never kill a PID recovered from a file. This synthetic contender exits
      // itself after eight seconds; otherwise retain its data and fail cleanup.
      const deadline = Date.now() + 12_000;
      let zombie = false;
      while (alive(report.pid) && Date.now() < deadline) {
        // Linux PID 1 can leave a reparented child as a zombie. It cannot access
        // storage, but kill(pid, 0) still sees it.
        if (process.platform === "linux") {
          try { if (/^State:\s+Z/m.test(readFileSync(`/proc/${report.pid}/status`, "utf8"))) { zombie = true; break; } } catch {}
        }
        await pause(20);
      }
      if (alive(report.pid) && !zombie) throw new Error(`synthetic child still live; retained ${report.parent}`);
      rmSync(report.parent, { recursive: true, force: true });
    }
    rmSync(unrelated, { recursive: true, force: true });
  });
  let output = "";
  await assert.rejects(runFocusedValidation({
    args: args(source), outerMs: 5_000,
    onOutput(chunk) { output += chunk; if (output.includes("\n")) report = JSON.parse(output.trim()); },
  }), (error) => {
    const text = messages(error);
    assert.match(text, /focused validation exceeded its outer deadline/);
    assert.ok(report, "runner reached the detached-child fault");
    assert.ok(text.includes(`fixture state retained at ${report.parent}`));
    assert.match(text, /detached contenders may still be running; cleanup is unproved/);
    assert.ok(existsSync(join(report.root, "contenders.json")));
    if (process.platform !== "win32") assert.ok(alive(report.pid), "the escaped child must not be silently reported cleaned");
    assert.ok(alive(peer.pid), "unrelated process survives");
    assert.equal(readFileSync(join(unrelated, "keep"), "utf8"), "unrelated evidence");
    return true;
  });
});

test("termination and close-wait failures preserve the primary timeout and retain even empty storage", async (t) => {
  let current;
  let parent;
  t.after(async () => {
    if (current) {
      const closed = new Promise((resolve) => current.once("close", resolve));
      current.kill("SIGKILL");
      await closed;
    }
    if (parent) rmSync(parent, { recursive: true, force: true });
  });
  await assert.rejects(runFocusedValidation({
    args: args('console.log(process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT); setInterval(() => {}, 1000)'),
    outerMs: 5_000, cleanupMs: 50,
    onOutput: (chunk) => { parent = String(chunk).trim(); },
    terminate(child) { current = child; throw new Error("synthetic termination failure"); },
  }), (error) => {
    const text = messages(error);
    for (const expected of ["outer deadline", "synthetic termination failure", "owned validation tree did not close", "fixture state retained"]) assert.ok(text.includes(expected), text);
    assert.ok(existsSync(parent));
    return true;
  });
});

test("temporary-root removal failure preserves the primary validation failure", async (t) => {
  let parent;
  t.after(() => { if (parent) rmSync(parent, { recursive: true, force: true }); });
  await assert.rejects(runFocusedValidation({
    args: args('console.log(process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT); process.exitCode = 7'),
    onOutput: (chunk) => { parent = String(chunk).trim(); },
    removeRoot() { throw new Error("synthetic removal failure"); },
  }), (error) => {
    const text = messages(error);
    assert.match(text, /focused validation exit=7/);
    assert.match(text, /temporary fixture cleanup failed; state retained/);
    assert.match(text, /synthetic removal failure/);
    assert.ok(text.includes(parent));
    return true;
  });
});

test("a successful exact focused run removes its empty owned parent", async () => {
  let parent;
  await runFocusedValidation({
    args: args(`
      console.log(process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT);
      console.log("ok 1 - the exclusive successor elects one winner across real runner processes");
      for (const line of ["# tests 1", "# pass 1", "# fail 0", "# cancelled 0", "# skipped 0"]) console.log(line);
    `),
    onOutput: (chunk) => { parent ??= String(chunk).split(/\r?\n/)[0]; },
  });
  assert.ok(parent);
  assert.equal(existsSync(parent), false);
});

test("a successful runner cannot hide unremoved fixture evidence", async (t) => {
  let parent;
  t.after(() => { if (parent) rmSync(parent, { recursive: true, force: true }); });
  await assert.rejects(runFocusedValidation({
    args: args(`
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      console.log(process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT);
      writeFileSync(join(process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT, "retained"), "fixture evidence");
      console.log("ok 1 - the exclusive successor elects one winner across real runner processes");
      for (const line of ["# tests 1", "# pass 1", "# fail 0", "# cancelled 0", "# skipped 0"]) console.log(line);
    `),
    onOutput: (chunk) => { parent ??= String(chunk).split(/\r?\n/)[0]; },
  }), /fixture state retained/);
  assert.equal(readFileSync(join(parent, "retained"), "utf8"), "fixture evidence");
});
