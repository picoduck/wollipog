#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("2.1.205 (Claude Code)\n");
  process.exit(0);
}

if (args.includes("--help")) {
  process.stdout.write(`
  --input-format <format>  text or stream-json
  --output-format <format> text, json, stream-json
  --permission-mode <mode> (choices: "acceptEdits", "auto", "plan")
  --effort <level> (choices: low, medium, high)
`);
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(`${JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "test",
  })}\n`);
  process.exit(0);
}

const receiptPath = process.env.WOLLIPOG_FAKE_CLAUDE_RECEIPT;
if (!receiptPath) throw new Error("WOLLIPOG_FAKE_CLAUDE_RECEIPT is required");
const recoveryStatePath = process.env.WOLLIPOG_FAKE_QUESTION_STATE;
const recovering = Boolean(recoveryStatePath && existsSync(recoveryStatePath));
const sessionFlagIndex = Math.max(args.indexOf("--session-id"), args.indexOf("--resume"));
const providerSessionId = sessionFlagIndex >= 0 ? args[sessionFlagIndex + 1] : "fixture-claude-question";

const requestId = "live-question-1";
const questions = [
  {
    question: "Which rollout strategy should we use?",
    header: "Strategy",
    options: [
      { label: "Canary", description: "Release to a small cohort first." },
      { label: "Blue-Green", description: "Switch traffic between complete environments." },
    ],
    multiSelect: false,
  },
  {
    question: "Which checks should run before promotion?",
    header: "Checks",
    options: [
      { label: "Unit Tests", description: "Run the unit test suite." },
      { label: "Browser Tests", description: "Run the browser test suite." },
      { label: "Smoke Test", description: "Run a post-deploy smoke test." },
    ],
    multiSelect: true,
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let buffer = "";
let asked = false;
let answered = false;

function userText(message) {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("\n");
}

function recoveredPayload(message) {
  const text = userText(message);
  const line = text.trim().split("\n").at(-1);
  return line ? JSON.parse(line) : null;
}

async function handleMessage(message) {
  if (message?.type === "user" && !asked) {
    asked = true;
    send({ type: "system", subtype: "init", session_id: providerSessionId });
    if (recovering) {
      const payload = recoveredPayload(message);
      const expected = {
        requestId,
        responses: [
          {
            id: "Which rollout strategy should we use?",
            question: "Which rollout strategy should we use?",
            answer: "Canary",
          },
          {
            id: "Which checks should run before promotion?",
            question: "Which checks should run before promotion?",
            answer: ["Unit Tests", "Browser Tests"],
          },
        ],
      };
      if (JSON.stringify(payload) !== JSON.stringify(expected)) {
        throw new Error(`unexpected recovered structured response: ${JSON.stringify(payload)}`);
      }
      const state = JSON.parse(await readFile(recoveryStatePath, "utf8"));
      const recoveredState = {
        initialQuestions: state.initialQuestions,
        recoveryTurns: state.recoveryTurns + 1,
      };
      await writeFile(recoveryStatePath, `${JSON.stringify(recoveredState)}\n`, "utf8");
      await writeFile(receiptPath, `${JSON.stringify({
        requestId,
        recovered: true,
        answers: Object.fromEntries(payload.responses.map((response) => [response.id, response.answer])),
        ...recoveredState,
      })}\n`, "utf8");
      send({ type: "stream_event", event: { type: "message_start", message: { id: "live-recovery-message" } } });
      send({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Recovered question answers received by Claude Code." },
        },
      });
      send({ type: "stream_event", event: { type: "message_stop" } });
      send({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
        total_cost_usd: 0,
      });
      return;
    }
    if (recoveryStatePath) {
      await writeFile(recoveryStatePath, `${JSON.stringify({ initialQuestions: 1, recoveryTurns: 0 })}\n`, "utf8");
    }
    send({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions },
      },
    });
    return;
  }

  if (message?.type !== "control_response" || answered) return;
  if (message.response?.request_id !== requestId) return;
  answered = true;
  const providerResponse = message.response?.response;
  const answers = providerResponse?.updatedInput?.answers;
  await writeFile(receiptPath, `${JSON.stringify({
    requestId: message.response.request_id,
    behavior: providerResponse?.behavior,
    answers,
  })}\n`, "utf8");

  send({ type: "stream_event", event: { type: "message_start", message: { id: "live-answer-message" } } });
  send({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Question answers received by Claude Code." },
    },
  });
  send({ type: "stream_event", event: { type: "message_stop" } });
  send({
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    total_cost_usd: 0,
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void handleMessage(JSON.parse(line)).catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
      });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  }
});
