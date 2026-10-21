import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationAction, RunnerView } from "@wollipog/protocol";
import { nextCronFire } from "@wollipog/protocol/cron-schedule";
import {
  actionSentence, actionText, describeSchedule, nextScheduleRun, policyCopy, SCHEDULE_FIVE_FIELDS_ERROR,
  SCHEDULE_NEVER_RUNS_ERROR, scheduleError, scheduleExamples, schedulePreview, timeZoneChoices, utcOffsetLabel,
} from "./automation-form.js";
import { filterSearchableComboboxOptions } from "./components/ui/ChoiceControls.js";
import { formatCalendarTime, titleCaseLabel } from "./format.js";

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
  // Each expectation is the scheduler's `nextCronFire` (packages/protocol cron-schedule.ts) for the same
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

test("describeSchedule falls back to the cron text for an expression it does not recognize, with the scheduler's next run", () => {
  // Valid expressions without words still get their next run, from the scheduler's own search (#2971).
  assert.deepEqual(described("*/5 * * * *"), { label: "*/5 * * * *", nextLabel: "Today, 7:05 AM" });
  assert.deepEqual(described("0 9 * * 1,3"), { label: "0 9 * * 1,3", nextLabel: "Tomorrow, 9:00 AM" });
  assert.deepEqual(described("0 9 1 1,2 *"), { label: "0 9 1 1,2 *", nextLabel: "Jan 1, 2027, 9:00 AM" });
  // Day of month OR weekday, as the scheduler reads two restricted day fields.
  assert.deepEqual(described("0 9 1 * 1"), { label: "0 9 1 * 1", nextLabel: "Mon, 9:00 AM" });
  for (const cron of ["0 25 * * *", "0 9 * *", "@daily"]) {
    assert.deepEqual(described(cron), { label: cron, nextLabel: null }, cron);
  }
});

test("each Example's label is its expression's preview words in Title Case (#2971)", () => {
  const examples = scheduleExamples("en-US");
  assert.deepEqual(examples, [
    { cron: "0 * * * *", label: "Every Hour" },
    { cron: "0 9 * * *", label: "Every Day at 9:00 AM" },
    { cron: "0 9 * * 1-5", label: "Weekdays at 9:00 AM" },
    { cron: "0 9 * * 1", label: "Every Monday at 9:00 AM" },
    { cron: "0 9 1 * *", label: "Monthly on the 1st at 9:00 AM" },
    { cron: "0 9 1 */3 *", label: "Quarterly on the 1st at 9:00 AM" },
  ]);
  for (const example of examples) {
    const preview = schedulePreview(example.cron, { timezone: CHICAGO, enabled: true, now: NOW, viewerTimeZone: CHICAGO, locale: "en-US" });
    const words = preview?.split(" · ")[0];
    assert.ok(words, `${example.cron} previews`);
    assert.equal(titleCaseLabel(words), example.label, example.cron);
    assert.equal(scheduleError(example.cron, { timezone: CHICAGO, enabled: true, now: NOW }), null, example.cron);
  }
});

test("schedulePreview words the schedule and its next run in the chosen zone, naming the zone when it isn't the viewer's", () => {
  const preview = (cron: string, options: Partial<Parameters<typeof schedulePreview>[1]> = {}) =>
    schedulePreview(cron, { timezone: CHICAGO, enabled: true, now: NOW, viewerTimeZone: CHICAGO, locale: "en-US", ...options });
  // Tuesday 7:00 AM in Chicago: the next weekday 9:00 is today's.
  assert.equal(preview("0 9 * * 1-5"), "Weekdays at 9:00 AM · Next Today, 9:00 AM");
  // Friday 5:00 PM: the next weekday 9:00 is Monday's.
  assert.equal(preview("0 9 * * 1-5", { now: Date.UTC(2026, 9, 23, 22) }), "Weekdays at 9:00 AM · Next Mon, 9:00 AM");
  // 9:00 AM in Tokyo, read by a viewer in Chicago: still Tokyo's 9:00, and the zone is named.
  assert.equal(preview("0 9 * * 1-5", { timezone: "Asia/Tokyo" }), "Weekdays at 9:00 AM · Next Tomorrow, 9:00 AM (Japan Standard Time)");
  assert.equal(preview("*/5 * * * *"), "Custom schedule · Next Today, 7:05 AM");
  assert.equal(preview("0 9 * * 1-5", { enabled: false }), "Weekdays at 9:00 AM · Paused");
  assert.equal(preview("0 9 * *"), null);
  assert.equal(preview("0 0 31 2 *"), "Custom schedule");
});

test("scheduleError says what the scheduler refuses, in one sentence that says how to fix it", () => {
  const error = (cron: string, enabled = true) => scheduleError(cron, { timezone: CHICAGO, enabled, now: NOW });
  for (const cron of ["0 9 * *", "", "   ", "0 9 * * * *"]) assert.equal(error(cron), SCHEDULE_FIVE_FIELDS_ERROR, cron);
  assert.equal(SCHEDULE_FIVE_FIELDS_ERROR, "Use five fields: minute, hour, day of month, month, weekday.");
  assert.equal(error("60 9 * * *"), "Use 0–59 for the minute, or a range, list or step of them.");
  assert.equal(error("0 9-2 * * *"), "Use 0–23 for the hour, or a range, list or step of them.");
  assert.equal(error("0 9 0 * *"), "Use 1–31 for the day of month, or a range, list or step of them.");
  assert.equal(error("0 9 * 13 *"), "Use 1–12 for the month, or a range, list or step of them.");
  assert.equal(error("0 9 * * MON"), "Use 0–7, where 0 and 7 are Sunday for the weekday, or a range, list or step of them.");
  // February 31 never comes: the control plane refuses to enable it, so the editor does too.
  assert.equal(error("0 0 31 2 *"), SCHEDULE_NEVER_RUNS_ERROR);
  assert.equal(error("0 0 31 2 *", false), null);
  for (const cron of ["0 9 * * 1-5", "*/15 8-10 1,15 * 1-5", "0 0 * * 7", " 0  9 * * * "]) assert.equal(error(cron), null, cron);
});

test("the editor's next run is the scheduler's own for the scheduler's daylight-saving cases", () => {
  // Each case is one of the control plane's `nextCronFire` tests (cron-schedule.test.ts). The web
  // previews with that same function, so its words name exactly the instant the scheduler fires.
  const cases: [cron: string, zone: string, after: number, fire: number][] = [
    ["0 9 * * *", "America/Chicago", Date.UTC(2026, 6, 12, 13, 59), Date.UTC(2026, 6, 12, 14, 0)],
    ["30 2 * * *", "America/New_York", Date.UTC(2024, 2, 9, 8, 0), Date.UTC(2024, 2, 11, 6, 30)],
    ["30 1 * * *", "America/Chicago", Date.UTC(2026, 10, 1, 5, 0), Date.UTC(2026, 10, 1, 6, 30)],
    ["30 1 * * *", "America/Chicago", Date.UTC(2026, 10, 1, 6, 30), Date.UTC(2026, 10, 2, 7, 30)],
    ["* * * * *", "America/Chicago", Date.UTC(2026, 10, 1, 6, 59), Date.UTC(2026, 10, 1, 8, 0)],
    ["30 1 * * *", "Australia/Lord_Howe", Date.UTC(2025, 3, 5, 0, 0), Date.UTC(2025, 3, 5, 15, 0)],
    ["0 0 29 2 *", "UTC", Date.UTC(2025, 0, 1), Date.UTC(2028, 1, 29)],
  ];
  for (const [cron, zone, after, fire] of cases) {
    const label = `${cron} in ${zone}`;
    assert.equal(nextCronFire(cron, zone, after), fire, label);
    assert.equal(nextScheduleRun(cron, zone, after), fire, label);
    const preview = schedulePreview(cron, { timezone: zone, enabled: true, now: after, viewerTimeZone: zone, locale: "en-US" });
    assert.equal(preview?.split(" · Next ")[1], formatCalendarTime(fire, after, zone, "en-US"), label);
  }
});

test("Time Zone lists each zone by city and offset over its IANA name, and keeps a stored zone the browser lacks", () => {
  const choices = timeZoneChoices("America/New_York", NOW, ["America/New_York", "Asia/Kolkata", "Europe/London"]);
  assert.deepEqual(choices, [
    { value: "Asia/Kolkata", label: "Kolkata (UTC+5:30)", description: "Asia/Kolkata" },
    { value: "Europe/London", label: "London (UTC+1)", description: "Europe/London" },
    { value: "America/New_York", label: "New York (UTC−4)", description: "America/New_York" },
    { value: "UTC", label: "UTC", description: "UTC" },
  ]);
  // "york" finds New York, as the combobox filters.
  assert.deepEqual(filterSearchableComboboxOptions(choices, "york").map((choice) => choice.value), ["America/New_York"]);
  // An alias the browser does not list stays a choice, as does UTC when the browser lists nothing.
  assert.deepEqual(timeZoneChoices("US/Eastern", NOW, []).map((choice) => [choice.value, choice.label]),
    [["US/Eastern", "Eastern (UTC−4)"], ["UTC", "UTC"]]);
  // A stored zone no runtime knows keeps its name, without an offset.
  assert.deepEqual(timeZoneChoices("Mars/Olympus", NOW, []).map((choice) => choice.label), ["Olympus", "UTC"]);
  assert.equal(utcOffsetLabel("Asia/Kathmandu", NOW), "UTC+5:45");
  assert.equal(utcOffsetLabel("America/St_Johns", Date.UTC(2026, 0, 1)), "UTC−3:30");
  // The browser's own list, where there is one, includes New York.
  assert.ok(timeZoneChoices("UTC", NOW).some((choice) => choice.value === "America/New_York"));
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
