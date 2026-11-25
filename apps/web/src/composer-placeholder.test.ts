import assert from "node:assert/strict";
import test from "node:test";
import type { PendingApproval } from "@wollipog/protocol";
import { composerAgentName, composerPlaceholder, composerUnavailableReason, workflowDecisionPause } from "./composer-placeholder.js";

const ready = {
  refusal: null,
  archivedReason: undefined,
  status: "idle",
  runnerOnline: true,
  machineName: "Build Box",
  noticeReason: undefined,
  policyPaused: false,
} as const;

const placeholder = (patch: Partial<Parameters<typeof composerPlaceholder>[0]> = {}) => composerPlaceholder({
  unavailableReason: null,
  agent: "Claude Code",
  narrow: false,
  inputPending: false,
  turnActive: false,
  fileReferences: true,
  ...patch,
});

test("the composer names the agent by its product name", () => {
  assert.equal(composerAgentName("claude-code", "Claude Code (Native)"), "Claude Code");
  assert.equal(composerAgentName("codex", "codex exec"), "Codex");
  assert.equal(composerAgentName("codex-app-server", null), "Codex");
  assert.equal(composerAgentName("pi", "Pi RPC"), "Pi");
  assert.equal(composerAgentName("acp", "Gemini"), "Gemini");
  assert.equal(composerAgentName("acp", null, "gemini-cli"), "gemini-cli");
  assert.equal(composerAgentName("acp", null, null), "the agent");
});

test("a ready composer says who a message goes to and what / and @ do", () => {
  assert.equal(placeholder(), "Message Claude Code. Type / for commands or @ for files.");
  assert.equal(placeholder({ narrow: true }), "Message Claude Code");
  assert.equal(placeholder({ fileReferences: false }), "Message Claude Code. Type / for commands.");
});

test("a composer that can send says when a message sent now will go", () => {
  assert.equal(placeholder({ turnActive: true }), "Add a message. It sends when this turn ends; Ctrl+Enter steers now.");
  assert.equal(placeholder({ inputPending: true, turnActive: true }),
    "Messages you send now wait until you answer the request above.");
  assert.equal(placeholder({ unavailableReason: "Why not.", inputPending: true }), "Why not.");
});

test("each blocked state has its own sentence, never a status string", () => {
  const cases: Array<[Partial<Parameters<typeof composerUnavailableReason>[0]>, string]> = [
    [{ status: "failed" }, "This session failed and can't take new messages."],
    [{ status: "stopped" }, "This session is stopped. Restart it to send a message."],
    [{ status: "completed" }, "This session has completed and can't take new messages."],
    [{ runnerOnline: false }, "Build Box is offline. You can send again when it reconnects."],
    [{ runnerOnline: false, machineName: "" }, "This machine is offline. You can send again when it reconnects."],
    [{ policyPaused: true }, "Paused by a guardrail. Continue or stop in the request above."],
    [{ noticeReason: "Worktree recovery is required before sending another message." },
      "Worktree recovery is required before sending another message."],
  ];
  for (const [patch, sentence] of cases) {
    const reason = composerUnavailableReason({ ...ready, ...patch });
    assert.equal(reason, sentence);
    assert.doesNotMatch(reason ?? "", /^(Do anything|Session is \w+\.|Runner is offline\.)$/u);
  }
  assert.equal(composerUnavailableReason(ready), null);
});

test("the reasons keep the order a person has to act on them", () => {
  const everything = {
    ...ready,
    refusal: "Viewers can read this session but not send messages.",
    archivedReason: "Unarchive the session to send a message.",
    status: "stopped",
    runnerOnline: false,
    noticeReason: "Conversation quarantined. Recover this session to continue.",
    policyPaused: true,
  } as const;
  assert.equal(composerUnavailableReason(everything), everything.refusal, "a Viewer keeps the refusal sentence");
  assert.equal(composerUnavailableReason({ ...everything, refusal: null }), everything.archivedReason);
  assert.equal(composerUnavailableReason({ ...everything, refusal: null, archivedReason: undefined }),
    "This session is stopped. Restart it to send a message.");
  assert.equal(composerUnavailableReason({ ...everything, refusal: null, archivedReason: undefined, status: "idle" }),
    "Build Box is offline. You can send again when it reconnects.");
  assert.equal(composerUnavailableReason({
    ...everything, refusal: null, archivedReason: undefined, status: "idle", runnerOnline: true,
  }), everything.noticeReason, "a notice-slot condition comes before a guardrail pause (#2037)");
});

test("a workflow decision pauses the composer in words about the decision, not a guardrail (#4713)", () => {
  const guardrail = "Paused by a guardrail. Continue or stop in the request above.";
  assert.equal(composerUnavailableReason({ ...ready, policyPaused: true, workflowDecision: "yours" }),
    "Waiting for your decision. Answer the request above to continue.");
  assert.equal(composerUnavailableReason({ ...ready, policyPaused: true, workflowDecision: "orchestrator" }),
    "Waiting for the Orchestrator's decision on the request above.");
  assert.equal(composerUnavailableReason({ ...ready, policyPaused: true, workflowDecision: "unknown" }),
    "Waiting for a decision on the request above.");
  assert.equal(composerUnavailableReason({ ...ready, policyPaused: true, workflowDecision: null }), guardrail);
  for (const sentence of [composerUnavailableReason({ ...ready, policyPaused: true, workflowDecision: "yours" }),
    composerUnavailableReason({ ...ready, policyPaused: true, workflowDecision: "orchestrator" })]) {
    assert.doesNotMatch(sentence ?? "", /guardrail|Continue or stop/u);
  }

  const decision = (authority?: "human" | "orchestrator") => ({
    kind: "workflow_decision",
    ...(authority ? { workflowDecision: { authority } } : {}),
  }) as unknown as PendingApproval;
  assert.equal(workflowDecisionPause(decision("human")), "yours");
  assert.equal(workflowDecisionPause(decision("orchestrator")), "orchestrator");
  assert.equal(workflowDecisionPause(decision()), "unknown");
  assert.equal(workflowDecisionPause({ kind: "cost_budget" } as unknown as PendingApproval), null, "a guardrail keeps its sentence");
  assert.equal(workflowDecisionPause(null), null);
});
