import assert from "node:assert/strict";
import test from "node:test";
import { RIGHT_PANEL_MODES } from "./right-panel.js";
import { SESSION_TOOL_GROUPS, SESSION_TOOLS, sessionToolAvailability, type SessionToolContext } from "./session-tools.js";

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
