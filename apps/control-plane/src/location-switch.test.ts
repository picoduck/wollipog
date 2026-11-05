import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCATION_SWITCH_GUIDANCE, PROTOCOL_VERSION, locationSwitchRole, withRepositoryMismatchGuidance,
  type CreateSessionRequest, type LocationSwitchSnapshot, type RunnerMetadata, type SessionView,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AgentPrincipal, HumanPrincipal } from "./identity.js";
import { SessionsService } from "./sessions.js";
import { LocationSwitchService, type LocationInspection } from "./location-switch.js";
import { isAgentControlApiRouteAllowed } from "./auth.js";

const agent = { id: "agent", name: "Agent", command: "agent", args: [], env: {}, available: true, driver: "acp" as const,
  context: { kind: "native" as const }, capabilities: { models: [{ id: "model", default: true, efforts: ["high"] }], effortLevels: ["high"],
    permissionModes: ["default"], slashCommands: [], supportsImages: false, supportsApprovals: true } };
const workstation: RunnerMetadata = { runnerId: "runner", hostname: "workstation", os: "linux", version: "test", agents: [agent],
  workspaces: [{ id: "app", name: "App", path: "/src/app" }, { id: "docs", name: "Docs", path: "/src/docs" }] };
const laptop: RunnerMetadata = { runnerId: "laptop", hostname: "laptop", os: "linux", version: "test", agents: [agent],
  workspaces: [{ id: "docs-copy", name: "Docs Copy", path: "/home/me/docs" }, { id: "broken", name: "Broken", path: "/home/me/broken" }] };

function harness(options: { role?: "orchestrator"; parent?: boolean; project?: boolean } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const hub = { isRunnerOnline: () => true, sessionChangedById() {}, sessionEvent() {}, sessionChanged() {} } as unknown as Hub;
  const now = Date.now();
  db.registerRunner(workstation, now, PROTOCOL_VERSION);
  db.registerRunner(laptop, now, PROTOCOL_VERSION);
  if (options.parent) {
    db.createSession({ id: "parent", runnerId: "runner", workspaceId: "app", agentId: "agent", title: "Parent", driver: "acp",
      useWorktree: false, config: {}, now });
  }
  db.createSession({ id: "self", runnerId: "runner", workspaceId: "app", agentId: "agent", title: "App Session", driver: "acp",
    useWorktree: true, config: { model: "model", effort: "high" }, now, ...(options.parent ? { parentSessionId: "parent" } : {}) });
  db.updateSessionStatus("self", "running", now);
  if (options.role) db.raw().prepare("UPDATE sessions SET session_role='orchestrator' WHERE id='self'").run();
  const project = db.createProject({ name: "Acme" });
  const locations = {
    app: db.addProjectLocation(project.id, { runnerId: "runner", workspaceId: "app" }),
    docs: db.addProjectLocation(project.id, { runnerId: "runner", workspaceId: "docs" }),
    laptop: db.addProjectLocation(project.id, { runnerId: "laptop", workspaceId: "docs-copy" }),
    broken: db.addProjectLocation(project.id, { runnerId: "laptop", workspaceId: "broken" }),
  };
  db.setSessionProject("self", options.project === false ? null : project.id, options.project === false ? null : locations.app.id);
  const repositories = new Map<string, string | null>([[locations.app.id, "acme/app"], [locations.docs.id, "acme/docs"],
    [locations.laptop.id, "Acme/Docs"], [locations.broken.id, null]]);
  const inspected: string[] = [];
  const inspect = async (locationId: string): Promise<LocationInspection> => {
    inspected.push(locationId);
    const location = db.projectLocation(locationId)!;
    const repository = repositories.get(locationId);
    return repository
      ? { ok: true, location: { locationId, projectId: location.projectId, runnerId: location.runnerId, workspaceId: location.workspaceId,
        repository, digest: "f".repeat(64) } }
      : { ok: false, locationId, failure: "not_repository", reason: "The Location's folder is not a git repository with a valid HEAD." };
  };
  const created: Array<{ human: HumanPrincipal; body: CreateSessionRequest }> = [];
  let createFailure: string | null = null;
  const sessions = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const service = new LocationSwitchService(db, sessions, hub, {
    inspect,
    createSession: (human, body) => {
      created.push({ human, body });
      if (createFailure) return { ok: false, status: 409, error: createFailure };
      return { ok: true, status: 201, data: { id: `handoff-${created.length}` } as SessionView };
    },
  });
  const scope = db.sessionScope("self")!;
  const principal: AgentPrincipal = { kind: "agent", actorId: "self", credentialSessionId: "self", organizationId: scope.organizationId, delegatedScope: scope };
  const owner = db.localIdentityContext().userId;
  const request = (requestId = "switch-1", input: Record<string, unknown> = {}) => service.request("self", {
    requestId, repository: "acme/docs", reason: "Issue acme/docs#12 belongs to the documentation repository.",
    handoff: "Fix the broken install link (acme/docs#12).", ...input,
  } as never, principal);
  const resolve = (occurrenceId: string, selectedOptionId?: string, actor: { kind: "human" | "agent"; id: string } = { kind: "human", id: owner }) =>
    sessions.resolveWorkflowDecision("self", "self", occurrenceId,
      selectedOptionId ? { outcome: "approve", selectedOptionId } : { outcome: "deny" }, "human", actor, () => true);
  return { db, sessions, service, principal, owner, project, locations, repositories, inspected, created, request, resolve,
    failCreation: (message: string | null) => { createFailure = message; } };
}

test("a regular session's request lists the verified Locations of the task's repository for its owner to choose", async () => {
  const h = harness();
  try {
    const result = await h.request();
    assert.equal(result.status, 201, result.error);
    const decision = result.data!;
    assert.equal(decision.category, "location_switch");
    assert.equal(decision.authority, "human");
    assert.equal(decision.controllingSessionId, "self");
    assert.equal(h.db.getSession("self")!.status, "input_required");
    const snapshot = decision.resourceSnapshot as LocationSwitchSnapshot;
    // Every Project Location is inspected in its own right, including the current one.
    assert.deepEqual(new Set(h.inspected), new Set(Object.values(h.locations).map((location) => location.id)));
    assert.equal(snapshot.current.repository, "acme/app");
    assert.equal(snapshot.current.locationId, h.locations.app.id);
    // Repositories compare case-insensitively; a Location of another repository is not a candidate.
    const byId = (a: { locationId: string }, b: { locationId: string }) => a.locationId.localeCompare(b.locationId);
    assert.deepEqual([...snapshot.candidates].sort(byId).map((candidate) => [candidate.locationId, candidate.sameRunner, candidate.machineName]),
      [[h.locations.docs.id, true, "workstation"], [h.locations.laptop.id, false, "laptop"]]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    assert.deepEqual(snapshot.unavailable.map((item) => [item.locationId, item.reason]),
      [[h.locations.broken.id, "The Location's folder is not a git repository with a valid HEAD."]]);
    assert.deepEqual(snapshot.options.map((option) => [option.optionId, option.label]),
      snapshot.candidates.map((candidate) => [`new_session:${candidate.locationId}`, "Start a New Session"]));
    const card = h.db.getSession("self")!.pendingApproval!;
    assert.equal(card.title, "Location Switch Approval Required");
    assert.deepEqual(card.options.map((option) => option.name), ["Start a New Session", "Start a New Session", "Stay Here"]);
    // The same request is idempotent, and a different one under the same id is refused.
    assert.equal((await h.request()).data!.occurrenceId, decision.occurrenceId);
    assert.equal((await h.request("switch-1", { reason: "Another reason." })).ok, false);
  } finally { h.db.close(); }
});

test("approving a Location on another machine starts a session there with the handoff, exactly once", async () => {
  const h = harness();
  try {
    const decision = (await h.request()).data!;
    const option = `new_session:${h.locations.laptop.id}`;
    assert.equal((await h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal)).ok, false,
      "nothing happens before the owner approves");
    assert.equal(h.resolve(decision.occurrenceId, option).ok, true);
    assert.equal((await h.service.execute("self", decision.occurrenceId, "0".repeat(64), h.principal)).ok, false);
    const executed = await h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.equal(executed.status, 201, executed.error);
    assert.equal(executed.data!.status, "consumed");
    assert.deepEqual(executed.data!.locationSwitchResult && { ...executed.data!.locationSwitchResult, completedAt: 0 }, {
      action: "new_session", locationId: h.locations.laptop.id, sessionId: "handoff-1",
      navigationPath: `/sessions/~${Buffer.from("handoff-1", "utf16le").toString("base64url")}`, completedAt: 0 });
    assert.equal(h.created.length, 1);
    const { human, body } = h.created[0]!;
    assert.equal(human.userId, h.owner, "the owner who approved creates the session");
    assert.deepEqual({ ...body, prompt: undefined }, { runnerId: "laptop", workspaceId: "docs-copy", projectId: h.project.id,
      projectLocationId: h.locations.laptop.id, agentId: "agent", useWorktree: true, title: "App Session",
      config: { model: "model", effort: "high" }, prompt: undefined });
    assert.match(body.prompt!, /handed off from session "App Session", which ran in repository acme\/app, because it belongs to repository Acme\/Docs/u);
    assert.match(body.prompt!, /Fix the broken install link \(acme\/docs#12\)\.$/u);
    // A retry returns the receipt and never starts a second session.
    const again = await h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.equal(again.data!.locationSwitchResult!.sessionId, "handoff-1");
    assert.equal(h.created.length, 1);
    // The requesting session keeps its own Location.
    assert.equal(h.db.getSession("self")!.projectLocationId, h.locations.app.id);
    assert.equal(h.db.getSession("self")!.workspaceId, "app");
  } finally { h.db.close(); }
});

test("Stay Here leaves the session where it is and nothing can be executed", async () => {
  const h = harness();
  try {
    const decision = (await h.request()).data!;
    const denied = h.resolve(decision.occurrenceId);
    assert.equal(denied.ok, true, denied.error);
    assert.equal(denied.data!.status, "denied");
    assert.equal((await h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal)).ok, false);
    assert.equal(h.created.length, 0);
    const session = h.db.getSession("self")!;
    assert.deepEqual([session.workspaceId, session.projectLocationId, session.runnerId], ["app", h.locations.app.id, "runner"]);
  } finally { h.db.close(); }
});

test("only the session's authenticated owner chooses, and only an offered Location", async () => {
  const h = harness();
  try {
    const decision = (await h.request()).data!;
    assert.equal(h.resolve(decision.occurrenceId, `new_session:${h.locations.docs.id}`, { kind: "agent", id: "self" }).ok, false);
    assert.equal(h.resolve(decision.occurrenceId, `new_session:${h.locations.docs.id}`, { kind: "human", id: "someone-else" }).ok, false);
    assert.equal(h.resolve(decision.occurrenceId, `new_session:${h.locations.broken.id}`).ok, false, "an unverified Location is not offered");
    assert.equal(h.resolve(decision.occurrenceId, `new_session:${h.locations.app.id}`).ok, false, "the current Location is not offered");
    assert.equal(h.sessions.resolveWorkflowDecision("self", "self", decision.occurrenceId, { outcome: "approve" }, "human",
      { kind: "human", id: h.owner }, () => true).ok, false, "an approval must name a Location");
    // The card cannot be forged through the generic route, nor consumed there.
    assert.equal(h.sessions.createWorkflowDecision("self", { requestId: "forged", resourceKey: "forged",
      resourceSnapshot: decision.resourceSnapshot }).status, 403);
    assert.equal(h.resolve(decision.occurrenceId, `new_session:${h.locations.docs.id}`).ok, true);
    assert.equal((await h.sessions.consumeWorkflowDecision("self", decision.occurrenceId,
      { resourceSnapshot: decision.resourceSnapshot })).status, 403);
  } finally { h.db.close(); }
});

test("a Location that changed after approval is verified again and refused, and the approval stays retryable", async () => {
  const h = harness();
  try {
    const decision = (await h.request()).data!;
    assert.equal(h.resolve(decision.occurrenceId, `new_session:${h.locations.docs.id}`).ok, true);
    h.repositories.set(h.locations.docs.id, "acme/other");
    const refused = await h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /changed; ask again/u);
    assert.equal(h.created.length, 0);
    h.repositories.set(h.locations.docs.id, "acme/docs");
    h.failCreation("the runner is offline");
    const failed = await h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.match(failed.error!, /could not start: the runner is offline/u);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "approved", "a failed start gives its claim back");
    h.failCreation(null);
    const started = await h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.equal(started.status, 201, started.error);
    assert.equal(h.created.at(-1)!.body.projectLocationId, h.locations.docs.id);
  } finally { h.db.close(); }
});

test("a mismatch without a usable Location is explained instead of creating a card", async () => {
  const h = harness();
  try {
    h.repositories.set(h.locations.docs.id, null);
    h.repositories.set(h.locations.laptop.id, null);
    const missing = await h.request("switch-2", { repository: "acme/website" });
    assert.equal(missing.status, 409);
    assert.match(missing.error!, /^No Location of acme\/website in Project "Acme" can continue this task\. .*Broken on laptop: The Location's folder is not a git repository/u);
    h.repositories.set(h.locations.broken.id, "acme/broken");
    h.repositories.set(h.locations.docs.id, "acme/docs");
    h.repositories.set(h.locations.laptop.id, "acme/docs");
    assert.match((await h.request("switch-3", { repository: "acme/website" })).error!,
      /^No Location in Project "Acme" belongs to acme\/website\. Add a Location of that repository/u);
    assert.match((await h.request("switch-4", { repository: "acme/app" })).error!, /already in a Location of acme\/app/u);
    assert.equal((await h.request("switch-5", { repository: "not a repository" })).status, 400);
    assert.equal(h.db.getSession("self")!.pendingApproval ?? null, null);
  } finally { h.db.close(); }
  const adHoc = harness({ project: false });
  try {
    assert.match((await adHoc.request()).error!, /not in a Project/u);
  } finally { adHoc.db.close(); }
});

test("Orchestrators and child sessions never get a Location switch card; each hears its own role's guidance", async () => {
  for (const [options, role] of [[{ role: "orchestrator" as const }, "orchestrator"], [{ parent: true }, "report_to_parent"]] as const) {
    const h = harness(options);
    try {
      const refused = await h.request();
      assert.equal(refused.status, 403);
      assert.equal(refused.error, LOCATION_SWITCH_GUIDANCE[role]);
      assert.equal(h.inspected.length, 0, "no Location is inspected for a refused role");
      assert.equal(h.db.getSession("self")!.pendingApproval ?? null, null);
    } finally { h.db.close(); }
  }
  // Orchestrator credentials cannot even reach the route; regular session credentials can.
  for (const route of ["POST /api/sessions/:id/location-switch-requests", "POST /api/sessions/:id/location-switch-requests/:occurrenceId/execute"]) {
    const [method, path] = route.split(" ") as [string, string];
    assert.equal(isAgentControlApiRouteAllowed(method, path, "normal"), true, route);
    assert.equal(isAgentControlApiRouteAllowed(method, path, "orchestrator"), false, route);
  }
});

test("repository-mismatch refusals carry each role's recovery, and other refusals are unchanged", () => {
  assert.equal(locationSwitchRole({ role: "normal", parentSessionId: null }), "offer");
  assert.equal(locationSwitchRole({ role: "normal", parentSessionId: "parent" }), "report_to_parent");
  assert.equal(locationSwitchRole({ role: "orchestrator", parentSessionId: "parent" }), "orchestrator");
  const attach = "worktree path is not registered by the repository it was matched against (/src/app)";
  assert.match(withRepositoryMismatchGuidance("offer", "worktree_attach", attach),
    /^worktree path is not registered.*\(\/src\/app\)\. If the task belongs to another repository, call request_location_switch .*trigger "worktree_attach"/u);
  assert.equal(withRepositoryMismatchGuidance("orchestrator", "worktree_attach", attach), `${attach}. ${LOCATION_SWITCH_GUIDANCE.orchestrator}`);
  assert.equal(withRepositoryMismatchGuidance("report_to_parent", "worktree_attach", attach), `${attach}. ${LOCATION_SWITCH_GUIDANCE.report_to_parent}`);
  const review = "the review must cover the session's own native managed worktree";
  assert.match(withRepositoryMismatchGuidance("offer", "review", review), /trigger "review"/u);
  assert.equal(withRepositoryMismatchGuidance("offer", "review", "the requested head is not the pull request's pushed head"),
    "the requested head is not the pull request's pushed head");
  assert.equal(withRepositoryMismatchGuidance("offer", "worktree_attach", review), review, "each trigger matches only its own refusals");
});
