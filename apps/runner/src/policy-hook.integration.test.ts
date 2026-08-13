import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LEGACY_POLICY_HOOK_SESSION_HEADER,
  WOLLIPOG_POLICY_HOOK_SESSION_HEADER,
} from "@wollipog/protocol";
import { POLICY_HOOK_ENV } from "./hook-settings.js";

const POLICY_HOOK_BUDGET_MS = 2_000;

test("policy-hook CLI performs authenticated deny round-trips in every fixed Claude mode", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-policy-hook-e2e-"));
  const tokenFile = join(root, "active-runner-token");
  writeFileSync(tokenFile, "mamh_integration_secret", "utf8");
  const received: Array<{ authorization?: string; claim?: string; legacyClaim?: string; body: unknown }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({
        authorization: request.headers.authorization,
        claim: request.headers[WOLLIPOG_POLICY_HOOK_SESSION_HEADER] as string | undefined,
        legacyClaim: request.headers[LEGACY_POLICY_HOOK_SESSION_HEADER] as string | undefined,
        body: JSON.parse(body),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ decision: "deny", reason: "Integration policy denied." }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const packagedRunner = process.env.POLICY_HOOK_RUNNER?.trim();
  const command = packagedRunner || process.execPath;
  const commandArgs = packagedRunner
    ? ["--policy-hook", "--hook-event", "PreToolUse"]
    : ["--import", "tsx", cli, "--policy-hook", "--hook-event", "PreToolUse"];
  const durations: number[] = [];
  try {
    for (const mode of ["acceptEdits", "plan", "bypassPermissions"]) {
      const circuitFile = join(root, `${mode}.circuit.json`);
      const readyFile = join(root, `${mode}.ready`);
      writeFileSync(
        readyFile,
        createHash("sha256").update("mamh_integration_secret").digest("hex"),
        "utf8",
      );
      const payload = JSON.stringify({
        session_id: `provider-${mode}`,
        hook_event_name: "PreToolUse",
        permission_mode: mode,
        tool_name: "Read",
        tool_use_id: `tool-${mode}`,
        tool_input: { file_path: join(root, "fixture.txt") },
      });
      const started = performance.now();
      const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
        const child = spawn(command, commandArgs, {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MANAGER_TOKEN_FILE: tokenFile,
            [POLICY_HOOK_ENV.cpUrl]: `http://127.0.0.1:${address.port}`,
            [POLICY_HOOK_ENV.sessionId]: "sess-integration",
            [POLICY_HOOK_ENV.settingsFile]: join(root, `${mode}.settings.json`),
            [POLICY_HOOK_ENV.circuitFile]: circuitFile,
            [POLICY_HOOK_ENV.readyFile]: readyFile,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("policy-hook CLI integration timed out"));
        }, 10_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code });
        });
        child.stdin.end(payload);
      });
      durations.push(performance.now() - started);
      assert.equal(output.code, 0, output.stderr);
      assert.equal(JSON.parse(output.stdout).hookSpecificOutput.permissionDecision, "deny");
      assert.ok(!output.stdout.includes("mamh_integration_secret"));
    }
    assert.equal(received.length, 3);
    for (const request of received) {
      assert.equal(request.authorization, "Bearer mamh_integration_secret");
      assert.equal(request.claim, "sess-integration");
      assert.equal(request.legacyClaim, undefined);
    }
    // `node --import tsx` compiles the entire runner graph on each fresh process and is highly
    // sensitive to concurrent full-suite load. It proves the source entry point and wire behavior,
    // while the packaged SEA invocation is the production latency gate recorded by the roadmap.
    if (packagedRunner) {
      assert.ok(
        Math.max(...durations) < POLICY_HOOK_BUDGET_MS,
        `hook exceeded ${POLICY_HOOK_BUDGET_MS} ms budget: ${durations.join(", ")}`,
      );
    }
    t.diagnostic(
      `${packagedRunner ? "packaged runner" : "tsx runner"} policy-hook durations: ${durations
        .map((duration) => `${duration.toFixed(1)} ms`)
        .join(", ")}`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
