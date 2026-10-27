import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// Exercise the actual transport-test spawn sites. A slow installed Pi probe used to acquire the
// developer's native HOME and then lose its runner to SIGKILL, leaving every native harness blocked.
for (const file of ["heartbeat-liveness.integration.test.ts", "malformed-frame-survival.integration.test.ts"]) {
  test(`${file} leaves the invoking user's HOME untouched`, { skip: process.platform === "win32", timeout: 60_000 }, async () => {
    const temp = mkdtempSync(join(tmpdir(), "wollipog-test-home-regression-"));
    const home = join(temp, "invoking-home");
    const bin = join(temp, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    // No real provider or credential is used. Leave the version probe running long enough to
    // overlap the transport test's abrupt runner teardown, exactly as a local installation can.
    const calls = join(temp, "probe-calls.jsonl");
    const ready = join(temp, "probe-ready");
    mkdirSync(ready);
    writeFileSync(join(bin, "pi"), `#!${process.execPath}
const fs = require("node:fs");
setTimeout(() => { fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ home: process.env.HOME,
  codexHome: process.env.CODEX_HOME, claudeHome: process.env.CLAUDE_CONFIG_DIR,
  hasCredential: Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) }) + "\\n"); fs.writeFileSync(require("node:path").join(${JSON.stringify(ready)},
  require("node:crypto").createHash("sha256").update(process.env.RUNNER_DATA_DIR).digest("hex")), "ready"); }, 1500);
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 20).unref();
setTimeout(() => console.log("0.71.0"), 10000);
`, { mode: 0o700 });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const output: string[] = [];
      child = spawn(process.execPath, ["--import", "tsx", "--test", `apps/runner/src/${file}`], {
        cwd: REPO_ROOT,
        env: {
          PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
          HOME: home,
          USERPROFILE: home,
          WOLLIPOG_TEST_DISCOVERY_PROBE_READY: ready,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_CONFIG_DIR: join(home, "claude"),
          OPENAI_API_KEY: "synthetic-credential-must-not-be-inherited",
          ANTHROPIC_API_KEY: "synthetic-credential-must-not-be-inherited",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        timeout: 50_000,
        killSignal: "SIGKILL",
      });
      child.stdout!.on("data", (chunk) => output.push(String(chunk)));
      child.stderr!.on("data", (chunk) => output.push(String(chunk)));
      const code = await new Promise<number | null>((done, reject) => {
        child!.once("error", reject);
        child!.once("close", done);
      });
      assert.equal(code, 0, output.join(""));
      assert.ok(existsSync(calls), "the real runner must reach the synthetic installed Pi probe");
      const observedHomes = new Set<string>();
      for (const line of readFileSync(calls, "utf8").trim().split("\n")) {
        const call = JSON.parse(line) as { home: string; codexHome?: string; claudeHome?: string; hasCredential: boolean };
        observedHomes.add(call.home);
        assert.notEqual(call.home, home, "the provider must receive the test runner's private HOME");
        assert.equal(call.codexHome, undefined);
        assert.equal(call.claudeHome, undefined);
        assert.equal(call.hasCredential, false, "provider credentials must not reach a transport test runner");
      }
      assert.equal(observedHomes.size, file.startsWith("heartbeat") ? 2 : 1, "every real runner spawn must reach the synthetic probe");
      for (const path of [home, join(home, "codex"), join(home, "claude")]) {
        assert.equal(existsSync(join(path, ".agent-manager", "provider-home-leases-v1")), false,
          `${file} wrote a provider lease into the invoking user's HOME`);
      }
    } finally {
      // The nested test worker's timeout can bypass its own t.after hooks. Own the POSIX group
      // so a failed regression cannot strand synthetic runners or probes after deleting HOME.
      if (child?.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
