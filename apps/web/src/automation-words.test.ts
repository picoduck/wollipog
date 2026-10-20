import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationAction, RunnerView } from "@wollipog/protocol";
import { actionSentence, actionText, describeSchedule, policyCopy } from "./automation-form.js";
import { formatCalendarTime } from "./format.js";

// Tuesday, October 20, 2026 at 12:00 UTC: 7:00 AM in Chicago (CDT), 2:00 PM in Berlin (CEST).
const NOW = Date.UTC(2026, 9, 20, 12);
const CHICAGO = "America/Chicago";
const inChicago = { viewerTimeZone: CHICAGO, locale: "en-US" };

function described(cron: string, options = inChicago, timezone = CHICAGO) {
  return describeSchedule(cron, timezone, NOW, options);
}

test("describeSchedule words every hour, with its minute when it is not on the hour", () => {
  assert.deepEqual(described("0 * * * *"), { label: "Every hour", nextLabel: "Today, 8:00 AM" });
  assert.deepEqual(described("15 * * * *"), { label: "Every hour at :15", nextLabel: "Today, 7:15 AM" });
});

test("describeSchedule words a daily schedule and its next run tomorrow", () => {
  assert.deepEqual(described("0 2 * * *"), { label: "Every day at 2:00 AM", nextLabel: "Tomorrow, 2:00 AM" });
});

test("describeSchedule words weekdays and weekends", () => {
  assert.deepEqual(described("0 9 * * 1-5"), { label: "Weekdays at 9:00 AM", nextLabel: "Today, 9:00 AM" });
  assert.deepEqual(described("0 10 * * 0,6"), { label: "Weekends at 10:00 AM", nextLabel: "Sat, 10:00 AM" });
});

test("describeSchedule words a weekly schedule, Sunday as 0 or 7", () => {
  assert.deepEqual(described("30 9 * * 1"), { label: "Every Monday at 9:30 AM", nextLabel: "Mon, 9:30 AM" });
  assert.equal(described("0 8 * * 7").label, "Every Sunday at 8:00 AM");
  assert.equal(described("0 8 * * 0").label, "Every Sunday at 8:00 AM");
});

test("describeSchedule words a monthly schedule, across the end of daylight saving time", () => {
  // November 1, 2026 is the day Chicago leaves daylight saving time; 6:00 AM is after the change.
  assert.deepEqual(described("0 6 1 * *"), { label: "Monthly on the 1st at 6:00 AM", nextLabel: "Nov 1, 6:00 AM" });
  assert.equal(described("0 6 22 * *").label, "Monthly on the 22nd at 6:00 AM");
  assert.equal(described("0 6 13 * *").label, "Monthly on the 13th at 6:00 AM");
});

test("describeSchedule words a quarterly schedule, naming next year's run with its year", () => {
  assert.deepEqual(described("0 9 15 1,4,7,10 *"), {
    label: "Quarterly on the 15th at 9:00 AM", nextLabel: "Jan 15, 2027, 9:00 AM",
  });
  assert.equal(described("0 9 1 */3 *").label, "Quarterly on the 1st at 9:00 AM");
  assert.equal(described("0 9 1 1-12/3 *").label, "Quarterly on the 1st at 9:00 AM");
  assert.equal(described("0 9 1 2,5,8,11 *").nextLabel, "Nov 1, 9:00 AM");
});

test("describeSchedule's next run skips a wall-clock minute daylight saving time skips, as the scheduler does", () => {
  // Each expectation is the control plane's `nextCronFire` (automation-schedule.ts) for the same
  // schedule, zone and moment (CR-1.1).
  const next = (cron: string, zone: string, after: number) =>
    describeSchedule(cron, zone, after, { viewerTimeZone: zone, locale: "en-US" }).nextLabel;
  // 2:30 AM does not exist on March 10, 2024 in New York, so the next run is March 11.
  assert.equal(next("30 2 * * *", "America/New_York", Date.UTC(2024, 2, 9, 8)), "Mon, 2:30 AM");
  // Hourly at :30 after 1:31 AM that day: 2:30 is skipped, 3:30 runs.
  assert.equal(next("30 * * * *", "America/New_York", Date.UTC(2024, 2, 10, 6, 31)), "Today, 3:30 AM");
  // Lord Howe Island moves its clock by 30 minutes: 2:15 AM on October 6, 2024 does not exist.
  assert.equal(next("15 2 * * *", "Australia/Lord_Howe", Date.UTC(2024, 9, 5, 12)), "Mon, 2:15 AM");
  // Samoa skipped December 30, 2011 entirely.
  assert.equal(next("0 9 * * *", "Pacific/Apia", Date.UTC(2011, 11, 29, 20, 30)), "Sat, 9:00 AM");
  // A weekly run inside Berlin's skipped hour waits a week.
  assert.equal(next("30 2 * * 0", "Europe/Berlin", Date.UTC(2026, 2, 28, 12)), "Apr 5, 2:30 AM");
});

test("describeSchedule's next run takes the one occurrence of a repeated minute the scheduler runs", () => {
  const next = (cron: string, zone: string, after: number) =>
    describeSchedule(cron, zone, after, { viewerTimeZone: zone, locale: "en-US" }).nextLabel;
  // November 3, 2024 repeats 1:00–2:00 AM in New York. The scheduler runs 1:30 once, the first time.
  assert.equal(next("30 1 * * *", "America/New_York", Date.UTC(2024, 10, 2, 12)), "Tomorrow, 1:30 AM");
  // After that first 1:30, an hourly :30 schedule's next run is 2:30, not the repeated 1:30.
  assert.equal(next("30 * * * *", "America/New_York", Date.UTC(2024, 10, 3, 5, 31)), "Today, 2:30 AM");
});

test("describeSchedule falls back to the cron text for an expression it does not recognize", () => {
  for (const cron of ["*/5 * * * *", "0 9 * * 1,3", "0 9 1 1,2 *", "0 9 1 * 1", "0 25 * * *", "0 9 * *", "@daily"]) {
    assert.deepEqual(described(cron), { label: cron, nextLabel: null }, cron);
  }
});

test("describeSchedule reads the automation's wall clock and names its next run in the viewer's zone", () => {
  // 2:00 AM in Chicago is 9:00 AM in Berlin.
  assert.deepEqual(described("0 2 * * *", { viewerTimeZone: "Europe/Berlin", locale: "en-US" }),
    { label: "Every day at 2:00 AM", nextLabel: "Tomorrow, 9:00 AM" });
  // An unknown zone keeps the words and says nothing about when they next apply.
  assert.deepEqual(described("0 2 * * *", inChicago, "Mars/Olympus"), { label: "Every day at 2:00 AM", nextLabel: null });
});

test("formatCalendarTime names nearby days in words and has no seconds", () => {
  const at = (day: number, hour: number) => formatCalendarTime(Date.UTC(2026, 9, day, hour), NOW, CHICAGO, "en-US");
  assert.equal(at(20, 7), "Today, 2:00 AM");
  assert.equal(at(21, 7), "Tomorrow, 2:00 AM");
  assert.equal(at(19, 7), "Yesterday, 2:00 AM");
  assert.equal(at(23, 14), "Fri, 9:00 AM");
  assert.equal(at(14, 14), "Oct 14, 9:00 AM");
  assert.equal(formatCalendarTime(Date.UTC(2025, 9, 14, 14), NOW, CHICAGO, "en-US"), "Oct 14, 2025, 9:00 AM");
  assert.doesNotMatch(at(20, 7), /:\d\d:\d\d/);
});

const runners = new Map<string, RunnerView>([["runner-1", {
  runnerId: "runner-1", hostname: "build-box", os: "linux", version: "1", status: "online",
  agents: [{ id: "agent-1", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  workspaces: [{ id: "workspace-1", name: "acme-storefront", path: "/repos/acme" }],
  connectedAt: 1, lastSeen: 1, protocolVersion: 90,
}]]);
const names = {
  runners,
  machineLabel: (runnerId: string) => runnerId === "runner-1" ? "Build Server" : undefined,
  sessionTitle: (sessionId: string) => sessionId === "s-1" ? "Nightly triage" : undefined,
  workflowName: (workflowId: string) => workflowId === "build-review" ? "Build and Review" : undefined,
};

test("actionSentence names what runs where by display names, never ids", () => {
  const create: AutomationAction = { kind: "create_session", request: {
    runnerId: "runner-1", workspaceId: "workspace-1", agentId: "agent-1", prompt: "Sweep.",
  } };
  assert.equal(actionSentence(create, names), "Starts Claude Code in acme-storefront on Build Server.");
  assert.equal(actionText(create), "Sweep.");
  const workflow: AutomationAction = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "workspace-1", workflowId: "build-review", task: "Review it.",
  } };
  assert.equal(actionSentence(workflow, names), "Runs the Build and Review workflow in acme-storefront on Build Server.");
  assert.equal(actionText(workflow), "Review it.");
  const prompt: AutomationAction = { kind: "prompt_session", sessionId: "s-1", request: { text: "Triage." } };
  assert.equal(actionSentence(prompt, names), "Prompts “Nightly triage”.");
  assert.equal(actionText(prompt), "Triage.");
});

test("actionSentence says what it cannot name instead of showing an id", () => {
  const gone: AutomationAction = { kind: "create_session", request: {
    runnerId: "runner-9", workspaceId: "workspace-9", agentId: "agent-9",
  } };
  const sentence = actionSentence(gone, names);
  assert.equal(sentence, "Starts an agent that isn't on this machine in a folder that isn't available on a machine that isn't connected.");
  for (const id of ["runner-9", "workspace-9", "agent-9"]) assert.ok(!sentence.includes(id));
  assert.equal(actionSentence({ kind: "prompt_session", sessionId: "s-9", request: { text: "" } }, names),
    "Prompts a session that isn't loaded.");
  assert.equal(actionSentence({ kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "workspace-1", workflowId: "gone", task: "",
  } }, names), "Runs a workflow that isn't available in acme-storefront on Build Server.");
});

test("actionSentence never names an agent by its id, even beside an indistinguishable namesake", () => {
  // Two native Claude Code agents with no version and no installation path differ only by id:
  // agentDisplayName would print "Claude Code (agent-2)", but a sentence never shows an id (#2970).
  const namesakes = new Map<string, RunnerView>([["runner-1", {
    ...runners.get("runner-1")!,
    agents: [
      { id: "agent-1", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true },
      { id: "agent-2", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true },
    ],
  }]]);
  const sentence = actionSentence({ kind: "create_session", request: {
    runnerId: "runner-1", workspaceId: "workspace-1", agentId: "agent-2",
  } }, { ...names, runners: namesakes });
  assert.equal(sentence, "Starts Claude Code in acme-storefront on Build Server.");
  assert.ok(!sentence.includes("agent-2"));
});

test("actionSentence names the agent of a saved installation, as the scheduler resolves it", () => {
  // CR-1.2: rediscovery moved the saved installation to a new agent id, and the stored id now names
  // a different agent. The scheduler runs the installation (resolveSavedTarget), so the page names it.
  const rediscovered = new Map<string, RunnerView>([["runner-1", {
    ...runners.get("runner-1")!,
    protocolVersion: 175,
    agents: [
      { id: "agent-1", name: "Wrong Agent", command: "x", args: [], env: {}, driver: "acp", available: true },
      { id: "agent-2", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true,
        installation: { id: "system", path: "/usr/bin/claude", via: "path", selection: "selected" } },
    ],
  }]]);
  const pinned = (installationId: string): AutomationAction => ({
    kind: "create_session",
    request: { runnerId: "runner-1", workspaceId: "workspace-1", agentId: "agent-1" },
    installationBindings: { agent: { driver: "claude-code", context: { kind: "native" }, installationId } },
  });
  assert.equal(actionSentence(pinned("system"), { ...names, runners: rediscovered }),
    "Starts Claude Code in acme-storefront on Build Server.");
  // A saved installation that is gone names no agent at all, rather than the stored id's.
  assert.equal(actionSentence(pinned("missing"), { ...names, runners: rediscovered }),
    "Starts an agent whose saved installation isn't available in acme-storefront on Build Server.");
});

test("policyCopy answers each rule in plain words, with no enum chain", () => {
  assert.equal(policyCopy.missed({ kind: "skip" }), "Skip it");
  assert.equal(policyCopy.missed({ kind: "fire_once" }), "Run it once");
  assert.equal(policyCopy.missed({ kind: "catch_up", maxRuns: 3 }), "Catch up, at most 3 runs");
  assert.equal(policyCopy.missed({ kind: "catch_up", maxRuns: 1 }), "Catch up, at most 1 run");
  assert.equal(policyCopy.offline({ kind: "wait" }, names.machineLabel), "Wait until it's back");
  assert.equal(policyCopy.offline({ kind: "expire", afterMinutes: 90 }, names.machineLabel), "Give up after 90 minutes");
  assert.equal(policyCopy.offline({ kind: "alternate", targets: [{ runnerId: "runner-1", workspaceId: "w" }], expireAfterMinutes: 30 },
    names.machineLabel), "Use Build Server instead; give up after 30 minutes if neither is online");
  assert.equal(policyCopy.offline({ kind: "alternate", targets: [
    { runnerId: "runner-1", workspaceId: "w" }, { runnerId: "runner-9", workspaceId: "w" },
  ] }, names.machineLabel), "Use Build Server or a machine that isn't connected instead; wait if none is online");
  assert.equal(policyCopy.concurrency("wait"), "Wait for it to finish");
  assert.equal(policyCopy.concurrency("skip"), "Skip this run");
  assert.equal(policyCopy.concurrency("parallel"), "Run both at once");
  assert.equal(policyCopy.cost({ maxCostUsd: 5, maxToolCalls: 1 }), "$5.00 per run");
  assert.equal(policyCopy.toolCalls({ maxCostUsd: 5, maxToolCalls: 1 }), "1 tool call per run");
  assert.equal(policyCopy.toolCalls({ maxCostUsd: 5, maxToolCalls: 1200 }), "1,200 tool calls per run");
  assert.equal(policyCopy.notifications({ pushEvents: [] }), "Off");
  assert.equal(policyCopy.notifications({ pushEvents: ["expired", "failed"] }), "When a run fails or expires");
  assert.equal(policyCopy.notifications({ pushEvents: ["started", "succeeded", "failed"] }),
    "When a run starts, succeeds or fails");
});
