import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test } from "node:test";

const enabled = process.env.WOLLIPOG_CLAUDE_STEERING_CONFORMANCE === "1";

test("real Claude Code incorporates replay-acknowledged input before the active result", {
  skip: enabled ? false : "set WOLLIPOG_CLAUDE_STEERING_CONFORMANCE=1 to use the installed Claude account",
  timeout: 45_000,
}, async (t) => {
  const firstId = randomUUID();
  const steeringId = randomUUID();
  const child = spawn(process.env.WOLLIPOG_CLAUDE_BIN ?? "claude", [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--no-session-persistence",
    "--safe-mode",
    "--permission-mode", "bypassPermissions",
    "--tools", "Bash",
  ], { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  });

  const messages: Record<string, unknown>[] = [];
  let stdoutBuffer = "";
  let stderr = "";
  let steeringSent = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      if (!steeringSent && message.type === "user" && message.isReplay === true && message.uuid === firstId) {
        steeringSent = true;
        child.stdin.write(JSON.stringify({
          type: "user",
          uuid: steeringId,
          message: { role: "user", content: [{ type: "text", text: "Change the required final reply to exactly STEERED_ONLY." }] },
        }) + "\n");
        child.stdin.end();
      }
    }
  });

  child.stdin.write(JSON.stringify({
    type: "user",
    uuid: firstId,
    message: {
      role: "user",
      content: [{
        type: "text",
        text: "Use the Bash tool to run sleep 5. After it finishes, reply with exactly ORIGINAL_ONLY. Do not reply before the sleep finishes.",
      }],
    },
  }) + "\n");

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, stderr);
  assert.equal(steeringSent, true, "the original message was not replay-acknowledged");
  const steeringAck = messages.findIndex((message) =>
    message.type === "user" && message.isReplay === true && message.uuid === steeringId);
  const resultIndex = messages.findIndex((message) => message.type === "result");
  assert.notEqual(steeringAck, -1, "Claude did not replay-acknowledge the steering message");
  assert.ok(resultIndex > steeringAck, "the active operation settled before steering was acknowledged");
  assert.equal(messages[resultIndex]?.result, "STEERED_ONLY");
});
