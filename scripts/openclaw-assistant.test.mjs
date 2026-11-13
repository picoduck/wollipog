import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { checkOpenClawVersion, connectionConfig, isConnectionRefusal, runOpenClaw, writeIsolatedProfile } from "./openclaw-assistant.mjs";

const connection = { name: "wollipog-alpha", url: "https://alpha.example/assistant/mcp", tokenEnv: "WOLLIPOG_ALPHA_TOKEN" };

test("remote config retains secret references and refuses ambiguous or credential-bearing endpoints", () => {
  const config = connectionConfig([connection, { ...connection, name: "wollipog-beta", tokenEnv: "WOLLIPOG_BETA_TOKEN" }]);
  assert.equal(config.mcp.servers[connection.name].headers.Authorization, "Bearer ${WOLLIPOG_ALPHA_TOKEN}");
  assert.equal(config.mcp.servers[connection.name].transport, "streamable-http");
  assert.throws(() => connectionConfig([connection, connection]), /unique/);
  assert.throws(() => connectionConfig([{ url: connection.url, tokenEnv: "TOKEN" }]), /unique/);
  assert.throws(() => connectionConfig([{ ...connection, name: null }]), /unique/);
  assert.throws(() => connectionConfig(null), /At least one/);
  for (const url of ["http://remote.example/assistant/mcp", "https://user:secret@alpha.example/assistant/mcp", "https://alpha.example/assistant/mcp?token=secret"]) {
    assert.throws(() => connectionConfig([{ ...connection, url }]), /HTTPS/);
  }
});

test("isolated profile cannot overwrite existing owner state or inherit ambient credentials", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-profile-test-"));
  const priorKey = process.env.OPENAI_API_KEY;
  const priorSession = process.env.WOLLIPOG_SESSION_TOKEN;
  try {
    process.env.OPENAI_API_KEY = "synthetic-ambient-sentinel";
    process.env.WOLLIPOG_SESSION_TOKEN = "synthetic-session-sentinel";
    const root = path.join(scratch, "dedicated");
    const profile = await writeIsolatedProfile(root, [connection]);
    const configPath = profile.env.OPENCLAW_CONFIG_PATH;
    assert.equal(profile.env.OPENAI_API_KEY, undefined);
    assert.equal(profile.env.WOLLIPOG_SESSION_TOKEN, undefined);
    assert.equal(profile.env.OPENCLAW_STATE_DIR, path.join(root, "state"));
    assert.equal(profile.env.HOME, path.join(root, "home"));
    assert.equal(profile.env.XDG_CACHE_HOME, path.join(root, "cache"));
    const saved = await readFile(configPath, "utf8");
    assert.ok(saved.includes("${WOLLIPOG_ALPHA_TOKEN}"));
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    await assert.rejects(writeIsolatedProfile(root, [connection]), { code: "EEXIST" });
    assert.equal(await readFile(configPath, "utf8"), saved);
  } finally {
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    if (priorSession === undefined) delete process.env.WOLLIPOG_SESSION_TOKEN; else process.env.WOLLIPOG_SESSION_TOKEN = priorSession;
    await rm(scratch, { recursive: true, force: true });
  }
});

test("unavailable-peer evidence rejects timeouts, crashes, unrelated diagnostics and config failures", () => {
  const result = { code: 1, outcome: "exit", output: JSON.stringify({ diagnostics: [{ serverName: "alpha", message: "connect ECONNREFUSED" }] }) };
  assert.equal(isConnectionRefusal(result, "alpha"), true);
  assert.equal(isConnectionRefusal({ ...result, outcome: "timeout" }, "alpha"), false);
  assert.equal(isConnectionRefusal({ ...result, outcome: "output-limit" }, "alpha"), false);
  assert.equal(isConnectionRefusal({ ...result, outcome: "signal" }, "alpha"), false);
  assert.equal(isConnectionRefusal(result, "beta"), false);
  assert.equal(isConnectionRefusal({ ...result, output: "" }, "alpha"), false);
  assert.equal(isConnectionRefusal({ ...result, output: JSON.stringify({ diagnostics: [{ serverName: "alpha", message: "Invalid config" }] }) }, "alpha"), false);
});

test("child process sees isolated home and no ambient sentinel; version errors are safe", { skip: process.platform === "win32" }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-child-test-"));
  const prior = process.env.WOLLIPOG_SMOKE_SENTINEL;
  try {
    process.env.WOLLIPOG_SMOKE_SENTINEL = "synthetic-ambient-sentinel";
    const profile = await writeIsolatedProfile(path.join(scratch, "profile"), [connection]);
    const result = await runOpenClaw(process.execPath, ["--input-type=module", "-e", 'import os from "node:os"; console.log(JSON.stringify({home:os.homedir(),temp:os.tmpdir(),sentinel:process.env.WOLLIPOG_SMOKE_SENTINEL}))'], profile);
    assert.equal(result.outcome, "exit");
    assert.deepEqual(JSON.parse(result.output), { home: profile.env.HOME, temp: profile.env.TMPDIR });
    const overflow = await runOpenClaw(process.execPath, ["-e", 'process.stdout.write("x".repeat(4096)); setInterval(()=>{},1000)'], profile, {}, { maxOutputBytes: 32 });
    assert.equal(overflow.outcome, "output-limit");
    assert.equal(overflow.code, null);
    await assert.rejects(checkOpenClawVersion(process.execPath, profile), /requires tested version 2026\.11\.3/);
  } finally {
    if (prior === undefined) delete process.env.WOLLIPOG_SMOKE_SENTINEL; else process.env.WOLLIPOG_SMOKE_SENTINEL = prior;
    await rm(scratch, { recursive: true, force: true });
  }
});

test("timeout kills a wrapper's ordinary descendants and bounds inherited pipes", { skip: process.platform !== "linux", timeout: 10000 }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-process-test-"));
  let descendant;
  try {
    const profile = await writeIsolatedProfile(path.join(scratch, "profile"), [connection]);
    const fixture = path.join(scratch, "wrapper.mjs");
    await writeFile(fixture, 'import {spawn} from "node:child_process"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); console.log(child.pid); setInterval(()=>{},1000);');
    const result = await runOpenClaw(process.execPath, [fixture], profile, {}, { timeoutMs: 500 });
    descendant = Number(result.output.trim());
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    assert.equal(result.outcome, "timeout");
    // A killed grandchild may briefly remain a zombie until its system parent reaps it.
    await new Promise(resolve => setTimeout(resolve, 50));
    const proc = await readFile(`/proc/${descendant}/stat`, "utf8").catch(() => null);
    assert.ok(proc === null || /^.*\) Z /.test(proc), "The descendant must no longer execute.");
  } finally {
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* already retired */ } }
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Ctrl-C and SIGTERM retire a detached probe and clean the smoke profile", { skip: process.platform !== "linux", timeout: 75000 }, async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-interrupt-test-"));
    const marker = path.join(scratch, "probe.json");
    const binary = path.join(scratch, "fixture-openclaw");
    let controller;
    let probe;
    try {
      // Fixture-only runtime: no credentials, provider, Discord or real OpenClaw evidence.
      await writeFile(binary, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nif(process.argv.includes('--version')) console.log('2026.11.3');\nelse { writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid, root:process.env.OPENCLAW_HOME})); setInterval(()=>{},1000); }\n`, { mode: 0o700 });
      controller = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/scripts/openclaw-assistant-smoke.ts", binary], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), env: { PATH: process.env.PATH, TMPDIR: scratch }, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      // Imports and SQLite setup can exceed five seconds under CPU contention.
      // Distinguish an early exit from slow startup without printing raw output.
      let diagnostics = "";
      let outputBytes = 0;
      for (const stream of [controller.stdout, controller.stderr]) stream.on("data", chunk => {
        outputBytes += chunk.length;
        diagnostics = (diagnostics + chunk.toString()).slice(-4096);
      });
      let exit;
      const started = performance.now();
      const completed = new Promise(resolve => {
        controller.once("error", error => { exit = { error: error.code }; resolve(exit); });
        controller.once("exit", (code, receivedSignal) => { exit = { code, signal: receivedSignal }; resolve(exit); });
      });
      const startupState = () => JSON.stringify({
        signal, elapsedMs: Math.round(performance.now() - started), exit: exit ?? "running", outputBytes,
        // Fixed identifiers only: real smoke runs can handle credentials.
        diagnosticCodes: [...new Set(diagnostics.match(/\b(?:ERR_MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|MODULE_NOT_FOUND|ENOENT|EACCES|EADDRINUSE|SQLITE_BUSY)\b/g) ?? [])],
        smokeFailure: diagnostics.includes("FAIL OpenClaw Assistant smoke test."),
      });
      const deadline = started + 30000;
      while (performance.now() < deadline) {
        assert.equal(exit, undefined, `Controller exited before probe readiness: ${startupState()}`);
        probe = await readFile(marker, "utf8").then(JSON.parse).catch(error => {
          if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
          throw error;
        });
        if (probe) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(probe, `Probe startup deadline exceeded: ${startupState()}`);
      assert.ok(Number.isInteger(probe.pid) && probe.pid > 0);
      assert.equal(typeof probe.root, "string");
      assert.equal(exit, undefined, `Controller exited at probe readiness: ${startupState()}`);
      console.log(`Fixture ${signal} ready after ${Math.round(performance.now() - started)}ms`);
      controller.kill(signal);
      const result = await completed;
      assert.deepEqual(result, { code: signal === "SIGINT" ? 130 : 143, signal: null });
      await new Promise(resolve => setTimeout(resolve, 50));
      const proc = await readFile(`/proc/${probe.pid}/stat`, "utf8").catch(() => null);
      assert.ok(proc === null || /^.*\) Z /.test(proc), "The detached probe must stop.");
      await assert.rejects(stat(probe.root), { code: "ENOENT" });
      await assert.rejects(stat(path.dirname(probe.root)), { code: "ENOENT" });
    } finally {
      // Retire loader helpers too if startup failed, before removing their cache.
      if (controller?.pid) {
        try { process.kill(-controller.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      if (controller?.pid && controller.exitCode === null && controller.signalCode === null) {
        await new Promise(resolve => controller.once("exit", resolve));
      }
      probe ??= await readFile(marker, "utf8").then(JSON.parse).catch(() => null);
      if (probe?.pid) { try { process.kill(probe.pid, "SIGKILL"); } catch { /* already retired */ } }
      await rm(scratch, { recursive: true, force: true });
    }
  }
});
