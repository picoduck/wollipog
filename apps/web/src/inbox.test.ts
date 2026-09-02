import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectView, SessionStatus, SessionView } from "@wollipog/protocol";
import { workspaceLocationKey } from "./projects.js";
import {
  INBOX_ALL_SPLIT_KEY,
  INBOX_NO_PROJECT_SPLIT_KEY,
  INBOX_SPLIT_RATIO_DEFAULT,
  INBOX_SPLIT_RATIO_MAX,
  INBOX_SPLIT_RATIO_MIN,
  approvalOptionForIntent,
  buildInboxSplits,
  clampInboxSplitRatio,
  deriveInboxSplits,
  durableInboxProjectKey,
  extendInboxHeldOrder,
  inboxProjectName,
  migrateInboxProjectPins,
  newSessionPresetForInboxSplit,
  inboxSelectionAfterMove,
  inboxSelectionAfterArchive,
  inboxSelectionAfterRemoval,
  inboxSplitByKey,
  isInboxActiveStatus,
  isInboxBlocked,
  isInboxRunning,
  parseInboxSplitRatio,
  nextInboxSplitKey,
  repairInboxSelection,
  repairInboxSelectionAfterSnapshot,
  repairInboxSelectionForHeldOrder,
  reconcileInboxItems,
  reconcileInboxOrder,
  serializeInboxSplitRatio,
  shouldRestoreInboxScroll,
  sortInboxSessions,
} from "./inbox.js";

function project(id: string, options: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    name: id,
    hidden: false,
    locations: [],
    activeSessionCount: 0,
    unarchivedSessionCount: 0,
    totalSessionCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...options,
  };
}

function session(
  id: string,
  options: Partial<SessionView> & { status?: SessionStatus } = {},
): SessionView {
  return {
    id,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Project One",
    agentId: "agent-1",
    agentName: "Codex",
    title: id,
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    messageCount: 0,
    preview: null,
    pendingApproval: null,
    driver: "codex",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    ...options,
  };
}

test("sortInboxSessions pins first and otherwise uses last event time descending", () => {
  const sorted = sortInboxSessions([
    session("old", { lastEventAt: 10 }),
    session("none", { lastEventAt: null, updatedAt: 100 }),
    session("new", { lastEventAt: 30 }),
    session("pinned", { lastEventAt: 1 }),
  ], new Set(["pinned"]));
  assert.deepEqual(sorted.map(({ id }) => id), ["pinned", "new", "old", "none"]);
});

test("sortInboxSessions uses updated time and id as deterministic fallbacks", () => {
  const sorted = sortInboxSessions([
    session("b", { lastEventAt: 5, updatedAt: 8 }),
    session("c", { lastEventAt: 5, updatedAt: 9 }),
    session("a", { lastEventAt: 5, updatedAt: 8 }),
    session("null-b", { lastEventAt: null, updatedAt: 7 }),
    session("null-a", { lastEventAt: null, updatedAt: 8 }),
  ]);
  assert.deepEqual(sorted.map(({ id }) => id), ["c", "a", "b", "null-a", "null-b"]);
});

test("deriveInboxSplits emits All, pinned projects, other projects, then Chats", () => {
  const alphaKey = workspaceLocationKey("runner-1", "alpha");
  const zuluKey = workspaceLocationKey("runner-1", "zulu");
  const splits = deriveInboxSplits([
    session("alpha", { workspaceId: "alpha", workspaceName: "Alpha", lastEventAt: 20 }),
    session("zulu", { workspaceId: "zulu", workspaceName: "Zulu", lastEventAt: 10 }),
    session("chat", { workspaceId: null, workspaceName: null, lastEventAt: 30 }),
    session("archived", { workspaceId: "alpha", workspaceName: "Alpha", archived: true, lastEventAt: 40 }),
  ], new Set([zuluKey]));

  assert.deepEqual(splits.map(({ key, name }) => [key, name]), [
    [null, "All"],
    [zuluKey, "Zulu"],
    [alphaKey, "Alpha"],
    [" chats", "Chats"],
  ]);
  assert.deepEqual(splits[0]!.sessions.map(({ id }) => id), ["chat", "alpha", "zulu"]);
  assert.equal(splits.some((split) => split.sessions.some(({ id }) => id === "archived")), false);
});

test("authoritative Project splits preserve empty Projects, exclude hidden tabs, and keep No Project explicit", () => {
  const alpha = project("alpha", {
    name: "Alpha",
    unarchivedSessionCount: 2,
    locations: [{
      id: "loc-alpha", projectId: "alpha", runnerId: "runner-1", workspaceId: "alpha-ws",
      name: "Alpha", path: "/alpha", source: "managed", availability: "available", isDefault: true,
      createdAt: 1, updatedAt: 1,
    }],
  });
  const empty = project("empty", { name: "Empty", unarchivedSessionCount: 0 });
  const hidden = project("hidden", { name: "Hidden", hidden: true, unarchivedSessionCount: 1 });
  const sameName = project("same", { name: "Alpha", unarchivedSessionCount: 0 });
  const sessions = [
    session("alpha-one", { projectId: "alpha", workspaceId: "alpha-ws" }),
    session("hidden-one", { projectId: "hidden", workspaceId: "hidden-ws" }),
    session("unassigned", { projectId: null, workspaceId: "alpha-ws" }),
    session("missing", { projectId: "missing", workspaceId: "missing-ws" }),
    session("archived", { projectId: "alpha", archived: true }),
  ];
  const legacyAlphaKey = workspaceLocationKey("runner-1", "alpha-ws");
  const splits = deriveInboxSplits(
    sessions,
    new Set([legacyAlphaKey]),
    new Set(),
    new Set(),
    [empty, hidden, sameName, alpha],
    true,
  );

  assert.deepEqual(splits.map(({ key, name }) => [key, name]), [
    [null, "All"],
    [durableInboxProjectKey("alpha"), "Alpha"],
    [durableInboxProjectKey("same"), "Alpha"],
    [durableInboxProjectKey("empty"), "Empty"],
    [INBOX_NO_PROJECT_SPLIT_KEY, "No Project"],
  ]);
  assert.deepEqual(splits[0]!.sessions.map(({ id }) => id).sort(), ["alpha-one", "hidden-one", "missing", "unassigned"]);
  assert.equal(splits.some((split) => split.name === "Hidden"), false);
  assert.equal(splits.find((split) => split.key === durableInboxProjectKey("empty"))?.sessions.length, 0);
  assert.equal(splits.find((split) => split.key === durableInboxProjectKey("alpha"))?.count, 2, "server Project count is authoritative");
  assert.deepEqual(splits.at(-1)?.sessions.map(({ id }) => id), ["unassigned"]);
});

test("new-session presets distinguish durable Projects, No Project, and All", () => {
  const selectedLocation = {
    id: "location-1",
    projectId: "project-1",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    name: "Project One",
    path: "/repos/project-one",
    source: "managed" as const,
    availability: "available" as const,
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const splits = deriveInboxSplits(
    [],
    new Set(),
    new Set(),
    new Set(),
    [project("project-1", { locations: [selectedLocation] })],
    true,
  );

  assert.deepEqual(newSessionPresetForInboxSplit(inboxSplitByKey(splits, durableInboxProjectKey("project-1"))), {
    projectId: "project-1",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    projectLocationId: "location-1",
  });
  assert.deepEqual(newSessionPresetForInboxSplit(inboxSplitByKey(splits, INBOX_NO_PROJECT_SPLIT_KEY)), {
    projectId: null,
  });
  assert.equal(newSessionPresetForInboxSplit(inboxSplitByKey(splits, INBOX_ALL_SPLIT_KEY)), undefined);

  const legacyKey = workspaceLocationKey("runner-legacy", "workspace-legacy");
  const legacySplits = deriveInboxSplits([
    session("legacy", {
      runnerId: "runner-legacy",
      workspaceId: "workspace-legacy",
      workspaceName: "Legacy Project",
    }),
  ]);
  assert.deepEqual(newSessionPresetForInboxSplit(inboxSplitByKey(legacySplits, legacyKey)), {
    runnerId: "runner-legacy",
    workspaceId: "workspace-legacy",
    projectName: "Legacy Project",
  });
});

test("durable Project grouping follows stable Project IDs across Locations and migrates exact legacy selection", () => {
  const durable = project("project-1", {
    name: "One Project",
    unarchivedSessionCount: 2,
    locations: [
      { id: "loc-1", projectId: "project-1", runnerId: "r1", workspaceId: "w1", name: "one", path: "/one", source: "managed", availability: "available", isDefault: false, createdAt: 1, updatedAt: 1 },
      { id: "loc-2", projectId: "project-1", runnerId: "r2", workspaceId: "w2", name: "two", path: "/two", source: "managed", availability: "runner_offline", isDefault: true, createdAt: 1, updatedAt: 1 },
    ],
  });
  const splits = deriveInboxSplits([
    session("one", { projectId: "project-1", runnerId: "r1", workspaceId: "w1" }),
    session("two", { projectId: "project-1", runnerId: "r2", workspaceId: "w2" }),
  ], new Set(), new Set(), new Set(), [durable], true);
  const split = splits.find((candidate) => candidate.kind === "project")!;
  assert.deepEqual(split.sessions.map(({ id }) => id), ["one", "two"]);
  assert.equal(split.project?.kind === "durable" ? split.project.primaryLocation?.id : null, "loc-1",
    "an available secondary Location is preferred over an offline default");
  assert.equal(inboxSplitByKey(splits, workspaceLocationKey("r1", "w1"))?.key, durableInboxProjectKey("project-1"));
});

test("Projects with multiple available Locations require an explicit or default Location", () => {
  const locationOne = {
    id: "loc-1", projectId: "project-1", runnerId: "r1", workspaceId: "w1",
    name: "one", path: "/one", source: "managed" as const, availability: "available" as const,
    isDefault: false, createdAt: 1, updatedAt: 1,
  };
  const locationTwo = {
    id: "loc-2", projectId: "project-1", runnerId: "r2", workspaceId: "w2",
    name: "two", path: "/two", source: "managed" as const, availability: "available" as const,
    isDefault: false, createdAt: 1, updatedAt: 1,
  };
  const ambiguous = project("project-1", { locations: [locationOne, locationTwo] });
  const ambiguousSplit = deriveInboxSplits([], new Set(), new Set(), new Set(), [ambiguous], true)
    .find((candidate) => candidate.kind === "project")!;
  assert.equal(ambiguousSplit.project?.kind === "durable" ? ambiguousSplit.project.primaryLocation : undefined, null,
    "the Inbox must not make an arbitrary Location the Project default");

  const withDefault = project("project-1", {
    locations: [locationOne, { ...locationTwo, isDefault: true }],
  });
  const defaultSplit = deriveInboxSplits([], new Set(), new Set(), new Set(), [withDefault], true)
    .find((candidate) => candidate.kind === "project")!;
  assert.equal(defaultSplit.project?.kind === "durable" ? defaultSplit.project.primaryLocation?.id : null, "loc-2");
});

test("legacy Location pins canonicalize to one durable Project key without retaining movable aliases", () => {
  const durable = project("project-1", {
    locations: [
      { id: "loc-1", projectId: "project-1", runnerId: "r1", workspaceId: "w1", name: "one", path: "/one", source: "managed", availability: "available", isDefault: true, createdAt: 1, updatedAt: 1 },
      { id: "loc-2", projectId: "project-1", runnerId: "r2", workspaceId: "w2", name: "two", path: "/two", source: "managed", availability: "available", isDefault: false, createdAt: 1, updatedAt: 1 },
    ],
  });
  const unknown = workspaceLocationKey("unknown", "workspace");
  const migrated = migrateInboxProjectPins(new Set([workspaceLocationKey("r1", "w1"), unknown]), [durable]);
  assert.deepEqual([...migrated].sort(), [durableInboxProjectKey("project-1"), unknown].sort());
  assert.equal(migrated.has(workspaceLocationKey("r1", "w1")), false);
  assert.equal(migrated.has(workspaceLocationKey("r2", "w2")), false);
});

test("Project names come from live inventory while legacy names keep the workspace fallback", () => {
  const value = session("one", { projectId: "project-1", workspaceName: "Stale Name" });
  assert.equal(inboxProjectName(value, new Map([["project-1", project("project-1", { name: "Renamed" })]])), "Renamed");
  assert.equal(inboxProjectName({ ...value, projectId: null }, new Map()), "No Project");
  assert.equal(inboxProjectName(value), "Stale Name");
});

test("split counts include blocked sessions and every split uses inbox card ordering", () => {
  const key = workspaceLocationKey("runner-1", "workspace-1");
  const splits = deriveInboxSplits([
    session("new", { status: "running", lastEventAt: 20 }),
    session("blocked", { status: "input_required", lastEventAt: 10 }),
    session("pinned", { status: "idle", lastEventAt: 1 }),
  ], new Set(), new Set(["pinned"]));
  for (const split of [splits[0]!, splits.find(({ key: candidate }) => candidate === key)!]) {
    assert.equal(split.count, 3);
    assert.equal(split.blockedCount, 1);
    assert.deepEqual(split.sessions.map(({ id }) => id), ["pinned", "new", "blocked"]);
  }
});

test("split counts keep stalled sessions separate from blocked sessions", () => {
  const sessions = [
    session("both", { status: "input_required", workspaceId: "p1", workspaceName: "Project One" }),
    session("stalled", { status: "running", workspaceId: "p1", workspaceName: "Project One" }),
    session("blocked", { status: "input_required", workspaceId: null, workspaceName: null }),
  ];
  const splits = buildInboxSplits(sessions, new Set(), new Set(), new Set(["both", "stalled"]));
  const all = splits[0]!;
  assert.equal(all.blockedCount, 2);
  assert.equal(all.stalledCount, 2);
  const project = splits.find((split) => split.name === "Project One")!;
  assert.equal(project.blockedCount, 1);
  assert.equal(project.stalledCount, 2);
  const chats = splits.find((split) => split.name === "Chats")!;
  assert.equal(chats.blockedCount, 1);
  assert.equal(chats.stalledCount, 0);
});

test("status predicates distinguish active, running, and blocked states", () => {
  for (const status of ["queued", "starting", "running", "input_required"] satisfies SessionStatus[]) {
    assert.equal(isInboxActiveStatus(status), true, status);
  }
  for (const status of ["idle", "completed", "failed", "stopped"] satisfies SessionStatus[]) {
    assert.equal(isInboxActiveStatus(status), false, status);
  }
  assert.equal(isInboxRunning(session("running", { status: "running" })), true);
  assert.equal(isInboxRunning(session("queued", { status: "queued" })), false);
  assert.equal(isInboxRunning(session("starting", { status: "starting" })), false);
  assert.equal(isInboxRunning(session("blocked", { status: "input_required" })), false);
  assert.equal(isInboxBlocked(session("blocked", { status: "input_required" })), true);
  assert.equal(isInboxBlocked(session("approval", {
    pendingApproval: { requestId: "request-1", title: "Allow command?", options: [] },
  })), true);
  assert.equal(isInboxBlocked(session("legacy-idle", { pendingApproval: undefined as never })), false,
    "an omitted legacy pendingApproval does not invent a blocked state");
});

test("split lookup falls back to All and selection repair follows split order", () => {
  const splits = deriveInboxSplits([session("new", { lastEventAt: 20 }), session("old", { lastEventAt: 10 })]);
  const all = inboxSplitByKey(splits, "missing");
  assert.equal(all?.key, INBOX_ALL_SPLIT_KEY);
  assert.equal(repairInboxSelection(all, "old"), "old");
  assert.equal(repairInboxSelection(all, "removed"), "new");
  assert.equal(repairInboxSelection({ ...all!, sessions: [], count: 0 }, "old"), null);
});

test("selection repair preserves a persisted row until the first snapshot arrives", () => {
  assert.equal(repairInboxSelectionAfterSnapshot(false, null, "remembered"), "remembered");
  assert.equal(repairInboxSelectionAfterSnapshot(true, null, "remembered"), null);
});

test("displayed row movement clamps at the ends and repairs filtered-out selections", () => {
  const ids = ["first", "middle", "last"];
  assert.equal(inboxSelectionAfterMove(ids, "first", "previous"), "first");
  assert.equal(inboxSelectionAfterMove(ids, "first", "next"), "middle");
  assert.equal(inboxSelectionAfterMove(ids, "last", "next"), "last");
  assert.equal(inboxSelectionAfterMove(ids, "filtered-out", "next"), "first");
  assert.equal(inboxSelectionAfterMove(ids, null, "previous"), "last");
  assert.equal(inboxSelectionAfterMove([], "first", "next"), null);
});

test("archive selection advances into the removed slot including from the final row", () => {
  const ids = ["first", "middle", "last"];
  assert.equal(inboxSelectionAfterRemoval(ids, "first"), "middle");
  assert.equal(inboxSelectionAfterRemoval(ids, "middle"), "last");
  assert.equal(inboxSelectionAfterRemoval(ids, "last"), "middle");
  assert.equal(inboxSelectionAfterRemoval(["only"], "only"), null);
  assert.equal(inboxSelectionAfterRemoval(ids, "missing"), "first");
});

test("archive completion preserves unrelated mouse selection and newer keyboard navigation", () => {
  const ids = ["first", "middle", "last"];
  assert.deepEqual(inboxSelectionAfterArchive(ids, "middle", "first", "first"), {
    apply: false,
    sessionId: "first",
  });
  assert.deepEqual(inboxSelectionAfterArchive(ids, "middle", "middle", "last"), {
    apply: false,
    sessionId: "last",
  });
  assert.deepEqual(inboxSelectionAfterArchive(ids, "middle", "middle", "middle"), {
    apply: true,
    sessionId: "last",
  });
});

test("split cycling wraps in both directions and tolerates a removed active split", () => {
  const keys = [null, "alpha", "beta"];
  assert.equal(nextInboxSplitKey(keys, null, "next"), "alpha");
  assert.equal(nextInboxSplitKey(keys, "beta", "next"), null);
  assert.equal(nextInboxSplitKey(keys, null, "previous"), "beta");
  assert.equal(nextInboxSplitKey(keys, "removed", "next"), null);
  assert.equal(nextInboxSplitKey(keys, "removed", "previous"), "beta");
  assert.equal(nextInboxSplitKey([], "removed", "next"), "removed");
});

test("interaction order retains existing rows, removes vanished rows, and appends arrivals", () => {
  assert.deepEqual(
    reconcileInboxOrder(["selected", "older", "newest"], ["arrived", "newest", "selected"]),
    ["selected", "newest", "arrived"],
  );
});

test("successive arrivals append without moving an earlier arrival", () => {
  const afterFirst = extendInboxHeldOrder(["older", "newest"], ["arrival-1", "newest", "older"]);
  const afterSecond = extendInboxHeldOrder(afterFirst, ["arrival-2", "arrival-1", "newest", "older"]);
  assert.deepEqual(afterSecond, ["older", "newest", "arrival-1", "arrival-2"]);
  assert.deepEqual(reconcileInboxOrder(afterSecond, ["arrival-2", "arrival-1", "newest", "older"]), afterSecond);
});

test("a held order drops departed rows but keeps a vanished selection for repair", () => {
  const afterRemoval = extendInboxHeldOrder(["removed", "kept", "newest"], ["kept", "newest"], "removed");
  assert.deepEqual(afterRemoval, ["removed", "kept", "newest"]);
  // Once the selection has been repaired off the removed row, nothing pins the tombstone: a
  // day-long desktop lease must not accumulate one entry per departed session.
  assert.deepEqual(extendInboxHeldOrder(afterRemoval, ["kept", "newest", "arrival"], "kept"),
    ["kept", "newest", "arrival"]);
  assert.deepEqual(extendInboxHeldOrder(["gone-1", "gone-2"], ["kept"], null), ["kept"]);
});

test("interaction order uses current row data instead of freezing live content", () => {
  const current = [{ id: "older", status: "idle" }, { id: "newest", status: "idle" }];
  const next = [{ id: "newest", status: "needs-input" }, { id: "older", status: "failed" }];
  assert.deepEqual(reconcileInboxItems(current.map(({ id }) => id), next, ({ id }) => id), [
    { id: "older", status: "failed" },
    { id: "newest", status: "needs-input" },
  ]);
});

test("selection repair follows the held visual slot after external removal", () => {
  const held = ["first", "selected", "last"];
  assert.equal(repairInboxSelectionForHeldOrder(true, ["last", "first"], held, "selected"), "last");
  assert.equal(repairInboxSelectionForHeldOrder(true, ["first", "selected"], held, "last"), "selected");
  assert.equal(repairInboxSelectionForHeldOrder(true, ["last", "first"], held, "first"), "first");
  assert.equal(repairInboxSelectionForHeldOrder(true, ["hidden", "first"], ["first", "selected"], "selected"), "first");
  assert.equal(repairInboxSelectionForHeldOrder(false, [], held, "selected"), "selected");
  assert.equal(repairInboxSelectionForHeldOrder(true, ["third", "fourth"],
    ["first-tombstone", "selected", "third", "fourth"], "selected"), "third");
  assert.equal(repairInboxSelectionForHeldOrder(true, ["first", "last"], held, null, true), null,
    "a deliberately cleared selection must stay cleared");
});

test("approval keyboard intents require one exact semantic option and never guess", () => {
  const pending = {
    requestId: "approval",
    title: "Run command?",
    options: [
      { optionId: "yes", name: "Do It", kind: "allow_once" },
      { optionId: "no", name: "No Thanks", kind: "reject_once" },
      { optionId: "always", name: "Always", kind: "allow_always" },
    ],
  };
  assert.equal(approvalOptionForIntent(pending, "approve")?.optionId, "yes");
  assert.equal(approvalOptionForIntent(pending, "deny")?.optionId, "no");
  assert.equal(approvalOptionForIntent({ ...pending, options: pending.options.filter(({ kind }) => kind !== "reject_once") }, "deny"), null);
  assert.equal(approvalOptionForIntent({ ...pending, options: [...pending.options, { optionId: "also", name: "Also", kind: "allow_once" }] }, "approve"), null);
  assert.equal(approvalOptionForIntent({ ...pending, kind: "question", options: [] }, "deny"), null);
  assert.equal(approvalOptionForIntent(null, "approve"), null);
});

test("authentication approval is selected only when exactly one method is available", () => {
  const authentication = {
    requestId: "auth",
    title: "Choose Sign-In Method",
    kind: "authentication" as const,
    options: [
      { optionId: "browser", name: "Browser", kind: "allow_once" },
      { optionId: "cancel", name: "Cancel Sign-In", kind: "reject_once" },
    ],
  };
  assert.equal(approvalOptionForIntent(authentication, "approve")?.optionId, "browser");
  assert.equal(approvalOptionForIntent(authentication, "deny")?.optionId, "cancel");
  assert.equal(approvalOptionForIntent({
    ...authentication,
    options: [
      ...authentication.options,
      { optionId: "device", name: "Device Code", kind: "allow_once" },
    ],
  }, "approve"), null);
});

test("split ratio parsing clamps values and fails closed to 40 percent", () => {
  assert.equal(parseInboxSplitRatio(null), INBOX_SPLIT_RATIO_DEFAULT);
  assert.equal(parseInboxSplitRatio(""), INBOX_SPLIT_RATIO_DEFAULT);
  assert.equal(parseInboxSplitRatio("garbage"), INBOX_SPLIT_RATIO_DEFAULT);
  assert.equal(parseInboxSplitRatio("0.1"), INBOX_SPLIT_RATIO_MIN);
  assert.equal(parseInboxSplitRatio("0.9"), INBOX_SPLIT_RATIO_MAX);
  assert.equal(clampInboxSplitRatio(0.575), 0.575);
  assert.equal(serializeInboxSplitRatio(1), String(INBOX_SPLIT_RATIO_MAX));
});

test("shouldRestoreInboxScroll only restores when collapsing out of the expanded view", () => {
  // Collapsing back from the expanded view: the list was unmounted, so restore.
  assert.equal(shouldRestoreInboxScroll({ expanded: true }, false), true);

  // Moving the selection with J/K while already collapsed. Restoring here would clobber the
  // scrollIntoView that moveSelection just performed and strand the highlighted row off-screen.
  assert.equal(shouldRestoreInboxScroll({ expanded: false }, false), false);

  // First run, before any surface has been recorded: nothing to restore to.
  assert.equal(shouldRestoreInboxScroll(null, false), false);

  // Opening the expanded view never restores the list position.
  assert.equal(shouldRestoreInboxScroll({ expanded: false }, true), false);
  assert.equal(shouldRestoreInboxScroll({ expanded: true }, true), false);
});
