import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION, type ResourceOwner, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { createOwnerMachineManagement } from "./owner-machine-management.js";
import { createAssistantOperations } from "./assistant-routes.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { registerAssistantMachineManagement } from "./assistant-machine-management.js";

/** Add Workspace's access choice (#4683): both registration routes take an optional owner. */
function harness() {
  const db = ControlPlaneDb.open(":memory:"), identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const metadata: RunnerMetadata = {runnerId: "studio", hostname: "studio", os: "linux", version: "test", agents: [], workspaces: []};
  db.registerRunner(metadata, Date.now(), PROTOCOL_VERSION);
  const now = Date.now();
  db.createIdentityMember({userId: "usr_other", displayName: "Other", organizationId: identity.organizationId, role: "operator", now});
  db.createIdentityTeam({teamId: "team_builders", organizationId: identity.organizationId, name: "Builders", memberUserIds: [owner.userId], now});
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sendToRunner = () => true;
  const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
  const service = createOwnerMachineManagement(db, hub, svc);
  let path = 0;
  const add = (route: "register" | "legacy", body: Record<string, unknown> = {}) => service.execute(
    `POST /api/runners/:runnerId/workspaces${route === "register" ? "/register" : ""}`,
    {principal: owner, params: {runnerId: metadata.runnerId}, body: {name: "Site", path: `/srv/site-${++path}`, ...body}, query: {}},
  );
  const scopeOf = (result: {body: unknown}) =>
    db.workspaceScope(metadata.runnerId, (result.body as {workspace: {id: string}}).workspace.id);
  return {db, owner, metadata, service, add, scopeOf, organizationId: identity.organizationId};
}

for (const route of ["register", "legacy"] as const) {
  test(`${route} registration keeps the private default and registers each owner kind the person may assign`, async () => {
    const h = harness();
    try {
      const unchanged = await h.add(route);
      assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
      assert.deepEqual(h.scopeOf(unchanged), {organizationId: h.organizationId, owner: {kind: "user", userId: h.owner.userId}},
        "a request without an owner is private to the person adding it, as before");
      const owners: ResourceOwner[] = [
        {kind: "user", userId: h.owner.userId},
        {kind: "team", teamId: "team_builders"},
        {kind: "organization", organizationId: h.organizationId},
      ];
      for (const owner of owners) {
        const added = await h.add(route, {owner});
        assert.equal(added.status, 200, `${owner.kind}: ${JSON.stringify(added.body)}`);
        assert.deepEqual(h.scopeOf(added), {organizationId: h.organizationId, owner});
      }
    } finally { h.db.close(); }
  });

  test(`${route} registration refuses an owner the person can't assign, and registers nothing`, async () => {
    const h = harness();
    try {
      const refusals: Array<[unknown, number, RegExp]> = [
        [{kind: "user", userId: "usr_other"}, 403, /private scope can only be assigned to the current user/u],
        [{kind: "team", teamId: "team_missing"}, 403, /team is not available/u],
        [{kind: "organization", organizationId: "org_elsewhere"}, 400, /current organization/u],
        [{kind: "everyone"}, 400, /valid access scope/u],
        [null, 400, /valid access scope/u],
      ];
      for (const [owner, status, error] of refusals) {
        const refused = await h.add(route, {owner});
        assert.equal(refused.status, status, JSON.stringify(owner));
        assert.match((refused.body as {error: string}).error, error);
      }
      // A Machine shared only with a team can't hold a Workspace the whole organization reaches.
      h.db.raw().prepare("UPDATE runner_ownership SET owner_kind='team', owner_id='team_builders' WHERE runner_id=?").run(h.metadata.runnerId);
      const wider = await h.add(route, {owner: {kind: "organization", organizationId: h.organizationId}});
      assert.equal(wider.status, 403);
      assert.match((wider.body as {error: string}).error, /broader than its Machine/u);
      assert.equal((await h.add(route, {owner: {kind: "team", teamId: "team_builders"}})).status, 200, "the Machine's own audience fits");
      // Naming yourself is the private default, which registers on any Machine the person manages.
      h.db.raw().prepare("UPDATE runner_ownership SET owner_kind='user', owner_id='usr_other' WHERE runner_id=?").run(h.metadata.runnerId);
      assert.equal((await h.add(route, {owner: {kind: "team", teamId: "team_builders"}})).status, 403);
      assert.equal((await h.add(route, {owner: {kind: "user", userId: h.owner.userId}})).status, 200);
      assert.equal((await h.add(route)).status, 200);
      const workspaces = h.db.getRunner(h.metadata.runnerId)!.workspaces;
      assert.equal(workspaces.length, 3, `only the fitting requests registered: ${JSON.stringify(workspaces)}`);
    } finally { h.db.close(); }
  });
}

test("an Assistant thread can't choose a new Workspace's access; leaving it out keeps the private default", async () => {
  const h = harness();
  try {
    const hub = new Hub(h.db);
    hub.isRunnerOnline = () => true;
    const svc = new SessionsService(h.db, hub, {info() {}, warn() {}, error() {}});
    const operations = createAssistantOperations(h.db);
    registerAssistantMachineManagement(operations, h.db, h.service, registerAssistantSessionOperations(operations, h.db, svc));
    const issued = h.db.assistantConnections.create(h.owner, "Workspace Access", {operations: "all", projects: "all"});
    const credential = h.db.assistantConnections.authenticate(issued.token)!;
    for (const name of ["workspace_register", "workspace_create"]) {
      await assert.rejects(operations.call(credential, name, {runnerId: h.metadata.runnerId, commandId: `${name}-wide`,
        payload: {name: "Wide", path: `/srv/${name}-wide`, owner: {kind: "organization", organizationId: h.organizationId}}}),
      /private to its owner; leave out payload\.owner/u);
    }
    assert.equal(h.db.getRunner(h.metadata.runnerId)!.workspaces.length, 0, "nothing was registered");
    const added = await operations.call(credential, "workspace_register", {runnerId: h.metadata.runnerId, commandId: "private",
      payload: {name: "Private", path: "/srv/private"}}) as {receipt: {status: string}; body: {workspace: {id: string}}};
    assert.equal(added.receipt.status, "succeeded");
    assert.equal(h.db.workspaceScope(h.metadata.runnerId, added.body.workspace.id)?.owner.kind, "user");
  } finally { h.db.close(); }
});
