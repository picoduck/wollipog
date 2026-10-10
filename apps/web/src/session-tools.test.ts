import assert from "node:assert/strict";
import test from "node:test";
import { RIGHT_PANEL_MODES } from "./right-panel.js";
import type { PendingApproval } from "@wollipog/protocol";
import {
  NO_REQUESTS_FACT,
  SESSION_TOOL_GROUPS,
  SESSION_TOOLS,
  SIDE_CHAT_FACT,
  TERMINAL_FACT,
  agentsFact,
  backgroundFact,
  browserFact,
  campaignFact,
  decisionsFact,
  filesFact,
  requestKindPhrase,
  requestsFact,
  reviewFact,
  sessionToolAvailability,
  type SessionToolContext,
} from "./session-tools.js";

const CONTEXT: SessionToolContext = {
  filesSupported: true,
  filesHint: "Update the runner for session file browsing.",
  terminalSupported: true,
  terminalHint: "Update the runner for session terminal access.",
  backgroundAvailable: true,
  campaignAvailability: { kind: "hidden" },
};

test("the tools run Session Tools, then Code, Work and Decisions, in the order the switcher shows them (#2843)", () => {
  assert.deepEqual(SESSION_TOOL_GROUPS, ["Code", "Work", "Decisions"]);
  assert.deepEqual(SESSION_TOOLS.map((tool) => [tool.group, tool.name]), [
    [null, "Session Tools"],
    ["Code", "Review"], ["Code", "Files"], ["Code", "Browser"], ["Code", "Terminal"],
    ["Work", "Agents"], ["Work", "Side Chat"], ["Work", "Background Work"], ["Work", "Campaign Status"],
    ["Decisions", "Requests"], ["Decisions", "Decision History"],
  ]);
  // Groups are contiguous, so a group heading never repeats.
  const groups = SESSION_TOOLS.map((tool) => tool.group).filter((group) => group !== null);
  assert.deepEqual([...new Set(groups)], [...SESSION_TOOL_GROUPS]);
});

test("every panel mode is a tool, and Terminal is the one tool that is not a mode (#2843)", () => {
  const ids = SESSION_TOOLS.map((tool) => tool.id);
  assert.deepEqual([...ids].filter((id) => id !== "terminal").sort(), [...RIGHT_PANEL_MODES].sort());
  assert.equal(new Set(ids).size, ids.length);
});

test("an unavailable tool is listed with its reason; Campaign Status is listed only for campaign sessions (#2843)", () => {
  assert.deepEqual(sessionToolAvailability("review", CONTEXT), { listed: true, unavailableReason: null });
  assert.deepEqual(sessionToolAvailability("files", { ...CONTEXT, filesSupported: false }),
    { listed: true, unavailableReason: CONTEXT.filesHint });
  assert.deepEqual(sessionToolAvailability("terminal", { ...CONTEXT, terminalSupported: false }),
    { listed: true, unavailableReason: CONTEXT.terminalHint });
  assert.match(String((sessionToolAvailability("background", { ...CONTEXT, backgroundAvailable: false }) as { unavailableReason: string })
    .unavailableReason), /No background-work capability/);
  assert.deepEqual(sessionToolAvailability("campaign", CONTEXT), { listed: false });
  assert.deepEqual(sessionToolAvailability("campaign", {
    ...CONTEXT,
    campaignAvailability: { kind: "unavailable", campaignSessionId: "c", reason: "The campaign could not be loaded." },
  }), { listed: true, unavailableReason: "The campaign could not be loaded." });
});

test("each tool with a chord names it, for the keycap the switcher and Session Tools show (#2862)", () => {
  assert.deepEqual(SESSION_TOOLS.filter((tool) => tool.shortcut).map((tool) => [tool.name, tool.shortcut]), [
    ["Review", "open-review"], ["Files", "open-files"], ["Terminal", "toggle-terminal"], ["Side Chat", "open-side-chat"],
  ]);
});

/* --- Facts: each Session Tools row's second line (#2844) --- */

test("Review's fact counts uncommitted changes as Review's summary does, then required findings (#2844)", () => {
  const changes = (files: number, staged = 0, truncated = false) => ({ files, staged, truncated });
  assert.equal(reviewFact(changes(9), 1), "9 uncommitted changes, 1 required finding");
  assert.equal(reviewFact(changes(1), 0), "1 uncommitted change");
  assert.equal(reviewFact(changes(9, 1), 1), "1 of 9 changes staged, 1 required finding");
  assert.equal(reviewFact(changes(50, 0, true), 2), "50+ uncommitted changes, 2 required findings");
  assert.equal(reviewFact(changes(0), 0), "No changes yet");
  assert.equal(reviewFact(changes(0), 3), "No changes yet, 3 required findings");
  assert.equal(reviewFact("checking", 0), "Checking for changes…");
  assert.equal(reviewFact("unknown", 1), "See what this session changed, 1 required finding");
});

test("the other tools' facts read in sentence case (#2844)", () => {
  assert.equal(filesFact("wollipog-fix"), "Browse wollipog-fix");
  assert.equal(browserFact(null), "Preview a web page");
  assert.equal(browserFact({ count: 0, more: false }), "Preview a web page");
  assert.equal(browserFact({ count: 1, more: false }), "1 artifact, or preview a web page");
  assert.equal(browserFact({ count: 50, more: true }), "50+ artifacts, or preview a web page");
  assert.equal(agentsFact(0), "No subagents in this session");
  assert.equal(agentsFact(1), "1 subagent in this session");
  assert.equal(agentsFact(3), "3 subagents in this session");
  assert.equal(agentsFact(50, true), "50+ subagents in this session");
  assert.equal(backgroundFact([]), "Nothing has run in the background");
  assert.equal(backgroundFact(["running", "completed", "failed"]), "1 of 3 jobs running");
  assert.equal(backgroundFact(["running"]), "1 of 1 job running");
  // Only a verified running job counts: unverified, lost and stalled ones are not running.
  assert.equal(backgroundFact(["unverified", "lost", "stalled"]), "0 of 3 jobs running");
  assert.equal(campaignFact({ counts: { delivered: 3, committed: 7 } }), "3 of 7 delivered");
  assert.equal(campaignFact(null), "Progress of this session's campaign");
  assert.equal(decisionsFact(0, false, "ready"), "No decisions recorded yet");
  assert.equal(decisionsFact(1, false, "ready"), "1 decision recorded");
  assert.equal(decisionsFact(12, true, "ready"), "12+ decisions recorded");
  assert.equal(decisionsFact(0, false, "loading"), "Loading decisions…");
  assert.equal(decisionsFact(0, false, "error"), "Decisions can't be loaded right now");
  for (const fact of [TERMINAL_FACT, SIDE_CHAT_FACT, NO_REQUESTS_FACT]) assert.match(fact, /^[A-Z][a-z ]+$/);
});

test("Requests says what waits for you, naming two and counting the rest (#2844)", () => {
  const request = (sessionTitle: string, responseOwner: "human" | "orchestrator", request: Partial<PendingApproval>) =>
    ({ sessionTitle, responseOwner, request: { kind: "permission", ...request } as PendingApproval });
  const deploy = request("Deploy", "human", {});
  const docs = request("Write docs", "human", { kind: "question" });
  const merge = request("Fix login", "human", { kind: "workflow_decision", workflowDecision: { category: "pr_merge" } as PendingApproval["workflowDecision"] });
  const handled = request("Child", "orchestrator", { kind: "question" });
  assert.equal(requestsFact([], "ready"), "No requests are waiting for you");
  assert.equal(requestsFact([deploy], "ready"), "An approval from Deploy");
  assert.equal(requestsFact([deploy, docs], "ready"), "An approval from Deploy, and a question from Write docs");
  assert.equal(requestsFact([merge, deploy, docs], "ready"), "A PR merge from Fix login, and 2 more");
  assert.equal(requestsFact([handled, handled], "ready"), "No requests are waiting for you; the Orchestrator is handling 2");
  assert.equal(requestsFact([handled, deploy], "ready"), "An approval from Deploy", "only what waits for you is named");
  assert.equal(requestsFact([], "unavailable"), "Requests from child sessions can't be checked right now");
  assert.equal(requestsFact([], "loading"), "Checking for requests…");
  assert.equal(requestKindPhrase({ kind: "workflow_decision", workflowDecision: { category: "ui_evidence_approval" } as PendingApproval["workflowDecision"] }),
    "a UI evidence review");
});
