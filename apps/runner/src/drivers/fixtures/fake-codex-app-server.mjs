import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "resume";
const threadId = scenario === "fresh"
  ? "fixture-fresh"
  : scenario === "question" || scenario === "dogfood-question"
    ? "fixture-question"
    : scenario === "subagents"
      ? "fixture-subagents"
      : "fixture-resume";
const questionRequestId = scenario === "dogfood-question"
  ? 5
  : "live-codex-question-1";
let dogfoodTurnCount = 0;
const expectedQueuedDogfoodPrompts = [
  "Keep this long message queued until both structured questions are answered.",
  "The complete two-question form must remain visible and reachable above the composer.",
];
const expectedLaunchArgs = ["--enable", "default_mode_request_user_input", "app-server"];
if (JSON.stringify(process.argv.slice(3)) !== JSON.stringify(expectedLaunchArgs)) {
  process.stderr.write("unexpected app-server launch arguments: " + JSON.stringify(process.argv.slice(3)) + "\n");
  process.exit(3);
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if ((scenario === "question" || scenario === "dogfood-question") && message.method == null && message.id === questionRequestId) {
    const expected = scenario === "dogfood-question"
      ? {
          answers: {
            merge_pr_342: { answers: ["Merge Now (Recommended)"] },
            delete_remote_branch: { answers: ["Delete Branch (Recommended)"] },
          },
        }
      : {
          answers: {
            environment: { answers: ["Staging"] },
            note: { answers: ["Ship after checks pass"] },
          },
        };
    if (JSON.stringify(message.result) !== JSON.stringify(expected)) {
      process.stderr.write("unexpected structured answer: " + JSON.stringify(message.result) + "\n");
      process.exitCode = 2;
      return;
    }
    const receipt = process.env.WOLLIPOG_FAKE_CODEX_RECEIPT;
    if (receipt) writeFileSync(receipt, JSON.stringify({ requestId: message.id, result: message.result }));
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "fixture-turn", itemId: "m1", delta: "Question answers received by Codex." } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "fixture-turn", status: "completed" } } });
    return;
  }
  if (message.id == null) return;
  if (message.method === "initialize") {
    if (message.params?.clientInfo?.name !== "wollipog") {
      send({ id: message.id, error: { code: -32602, message: "expected Wollipog client identity" } });
      return;
    }
    send({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/read" && scenario === "resume") {
    send({ id: message.id, result: { thread: { id: threadId, status: { type: "idle" }, turns: [{ id: "historical" }] } } });
    return;
  }
  if (message.method === "thread/resume" && scenario === "resume") {
    send({ id: message.id, result: { thread: { id: threadId, turns: [{ id: "historical" }] } } });
    return;
  }
  if (message.method === "thread/start" && (
    scenario === "fresh" || scenario === "question" || scenario === "dogfood-question" || scenario === "subagents"
  )) {
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    if (scenario === "dogfood-question") dogfoodTurnCount += 1;
    const turnId = dogfoodTurnCount > 1 ? `fixture-turn-${dogfoodTurnCount}` : "fixture-turn";
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    if (scenario === "question") {
      send({
        id: questionRequestId,
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId: "fixture-turn",
          itemId: "question-tool",
          isBlocking: true,
          questions: [
            {
              id: "environment",
              header: "Environment",
              question: "Where should this be deployed?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "Staging", description: "Deploy to staging" },
                { label: "Production", description: "Deploy to production" },
              ],
            },
            {
              id: "note",
              header: "Release Note",
              question: "Add a release note",
              isOther: true,
              isSecret: false,
              options: null,
            },
          ],
        },
      });
      return;
    }
    if (scenario === "dogfood-question") {
      if (dogfoodTurnCount > 1) {
        const expected = expectedQueuedDogfoodPrompts[dogfoodTurnCount - 2];
        const actual = message.params?.input?.find((input) => input?.type === "text")?.text;
        if (actual !== expected) {
          process.stderr.write("unexpected queued prompt: " + JSON.stringify(actual) + "\n");
          process.exitCode = 2;
          return;
        }
        send({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId,
            itemId: `queued-${dogfoodTurnCount}`,
            delta: "Queued prompt delivered after the questions.",
          },
        });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      send({
        id: questionRequestId,
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId: "fixture-turn",
          itemId: "question-tool",
          isBlocking: true,
          questions: [
            {
              id: "merge_pr_342",
              header: "Merge PR",
              question: "Should I squash-merge pull request #342 now?",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Merge Now (Recommended)", description: "Squash-merge the pull request now." },
                { label: "Leave Open", description: "Leave the pull request open." },
              ],
            },
            {
              id: "delete_remote_branch",
              header: "Delete Branch",
              question: "Should I delete the remote branch after merging?",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Delete Branch (Recommended)", description: "Delete the remote branch after merging." },
                { label: "Keep Branch", description: "Keep the remote branch." },
              ],
            },
          ],
        },
      });
      return;
    }
    if (scenario === "subagents") {
      send({
        method: "item/started",
        params: {
          threadId,
          turnId: "fixture-turn",
          item: {
            type: "collabAgentToolCall",
            id: "fixture-spawn",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: threadId,
            receiverThreadIds: ["fixture-child"],
            prompt: "Inspect background work",
            agentsStates: { "fixture-child": { status: "running" } },
          },
        },
      });
      send({ method: "turn/completed", params: { threadId, turn: { id: "fixture-turn", status: "completed" } } });
      setTimeout(() => {
        send({
          method: "item/completed",
          params: {
            threadId: "fixture-child",
            turnId: "fixture-child-turn",
            item: { type: "agentMessage", id: "fixture-child-message", text: "Background inspection complete." },
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId,
            turnId: "fixture-turn",
            item: {
              type: "collabAgentToolCall",
              id: "fixture-wait",
              tool: "wait",
              status: "completed",
              senderThreadId: threadId,
              receiverThreadIds: ["fixture-child"],
              agentsStates: { "fixture-child": { status: "completed", message: "Background inspection complete." } },
            },
          },
        });
      }, 10);
      return;
    }
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "fixture-turn", itemId: "m1", delta: "continued" } });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId: "fixture-turn",
        tokenUsage: {
          total: { inputTokens: 999, outputTokens: 999 },
          last: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
        },
      },
    });
    send({ method: "turn/completed", params: { threadId, turn: { id: "fixture-turn", status: "completed" } } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `unexpected method ${message.method} in ${scenario}` } });
});
