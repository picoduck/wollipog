#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

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

async function handleMessage(message) {
  if (message?.type === "user" && !asked) {
    asked = true;
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
