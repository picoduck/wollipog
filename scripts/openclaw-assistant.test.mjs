import assert from "node:assert/strict";
import { test } from "node:test";
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
