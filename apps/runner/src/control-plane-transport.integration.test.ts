import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("runner CLI refuses remote plaintext transport before startup", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "wollipog-runner-transport-"));
  try {
    const env = { ...process.env };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const tsxImport = createRequire(import.meta.url).resolve("tsx");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import", tsxImport, cli,
        "--runner-id", "transport-check",
        "--control-plane-url", "ws://manager.example.test/runner",
        "--token", "test-only-secret",
        "--workspace", "repo:/tmp",
      ], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /startup blocked: refusing insecure ws:\/\//u);
    assert.match(result.stderr, /--allow-insecure-transport/u);
    assert.doesNotMatch(result.stderr, /test-only-secret/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
