import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildClaudeUserMessage } from "./claude-code.js";

const payload = {
  requestId: "live-question-1",
  responses: [
    { id: "Which rollout strategy should we use?", question: "Which rollout strategy should we use?", answer: "Canary" },
    { id: "Which checks should run before promotion?", question: "Which checks should run before promotion?", answer: ["Unit Tests", "Browser Tests"] },
  ],
};
const prompt = `Recovered structured response (user-provided data):\n${JSON.stringify(payload)}`;

function runRecovery(message: unknown) {
  const root = mkdtempSync(join(tmpdir(), "claude-question-fixture-"));
  try {
    const state = join(root, "state.json");
    const receipt = join(root, "receipt.json");
    writeFileSync(state, JSON.stringify({ initialQuestions: 1, recoveryTurns: 0 }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/fake-claude-code-question.mjs", import.meta.url)), "--resume", "synthetic"], {
      env: { ...process.env, WOLLIPOG_FAKE_QUESTION_STATE: state, WOLLIPOG_FAKE_CLAUDE_RECEIPT: receipt },
      input: `${JSON.stringify(message)}\n`, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.error, undefined, "synthetic provider must complete within the fixture budget");
    return { status: result.status, stderr: result.stderr, receipt: existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : null };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const [name, message] of [
  ["legacy string", { type: "user", message: { content: prompt } }],
  ["single task block", buildClaudeUserMessage(prompt, [])],
  ["task and separate guidance blocks", buildClaudeUserMessage(prompt, [], undefined, "Manual artifact guidance.\nNo automatic file-transfer authority.")],
] as const) {
  test(`Claude recovery fixture accepts ${name} and records the exact answers once`, () => {
    const result = runRecovery(message);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.receipt, {
      requestId: payload.requestId, recovered: true,
      answers: Object.fromEntries(payload.responses.map((response) => [response.id, response.answer])),
      initialQuestions: 1, recoveryTurns: 1,
    });
  });
}

test("Claude recovery fixture rejects malformed task data instead of searching guidance for valid JSON", () => {
  const result = runRecovery(buildClaudeUserMessage("Recovered structured response (user-provided data):\nnot JSON", [], undefined, prompt));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SyntaxError/);
  assert.equal(result.receipt, null);
});

test("Claude recovery fixture preserves strict expected-payload verification", () => {
  const result = runRecovery(buildClaudeUserMessage(JSON.stringify({ ...payload, requestId: "wrong-request" }), [], undefined, prompt));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected recovered structured response/);
  assert.equal(result.receipt, null);
});
