import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { TeamView } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import { registerIdentityTeamRoutes, TEAM_NAME_TAKEN } from "./identity-team-route.js";

test("owners and admins rename a team in their own organization, with a stable code for a taken name (#3000)", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  const organizationId = local.organizationId;
  const member = db.createIdentityMember({ userId: "usr_member", displayName: "Pat", organizationId, role: "operator", now: 1 });
  const team = db.createIdentityTeam({
    teamId: "team_support", organizationId, name: "Support", memberUserIds: [member.userId], now: 2,
  });
  db.createIdentityTeam({ teamId: "team_platform", organizationId, name: "Platform", memberUserIds: [], now: 3 });
  const human = (role: HumanPrincipal["role"], inOrganization = organizationId): HumanPrincipal => ({
    kind: "human", actorId: `${role}-user`, userId: `${role}-user`, userName: role,
    organizationId: inOrganization, organizationName: "Org", role, deviceId: null, localBootstrap: false,
  });
  const principals = new Map<string, HumanPrincipal>([
    ["owner", human("owner")],
    ["admin", human("admin")],
    ["operator", human("operator")],
    ["viewer", human("viewer")],
    ["other-admin", human("admin", "org_other")],
  ]);
  const app = Fastify();
  registerIdentityTeamRoutes(app, {
    db,
    requestHuman: (request) => principals.get(request.headers.authorization?.replace(/^Bearer /, "") ?? "") ?? null,
  });
  const rename = (as: string, body: unknown, teamId = team.teamId) => app.inject({
    method: "PATCH",
    url: `/api/identity/teams/${teamId}`,
    headers: { authorization: `Bearer ${as}` },
    payload: body as object,
  });
  const storedName = () => db.identityAdministration({ ...local, organizationId }).teams
    .find((item) => item.teamId === team.teamId)?.name;
  try {
    assert.equal((await rename("anonymous", { name: "Help Desk" })).statusCode, 403);
    assert.equal((await rename("viewer", { name: "Help Desk" })).statusCode, 403);
    assert.equal((await rename("operator", { name: "Help Desk" })).statusCode, 403);
    const elsewhere = await rename("other-admin", { name: "Help Desk" });
    assert.equal(elsewhere.statusCode, 404, "another organization's team is not found, not forbidden");
    assert.equal((await rename("admin", { name: "Help Desk" }, "team_missing")).statusCode, 404);
    for (const bad of [{}, { name: "" }, { name: "   " }, { name: 7 }, { name: "x".repeat(81) }]) {
      assert.equal((await rename("admin", bad)).statusCode, 400, JSON.stringify(bad));
    }
    const taken = await rename("admin", { name: " Platform " });
    assert.equal(taken.statusCode, 409);
    assert.equal((taken.json() as { code?: string }).code, TEAM_NAME_TAKEN);
    assert.equal(storedName(), "Support", "refused renames change nothing");

    const renamed = await rename("owner", { name: "  Help Desk  " });
    assert.equal(renamed.statusCode, 200);
    const view = (renamed.json() as { team: TeamView }).team;
    assert.equal(view.name, "Help Desk", "the name is trimmed");
    assert.equal(view.teamId, team.teamId);
    assert.deepEqual(view.memberUserIds, [member.userId], "a rename changes no membership");
    assert.equal(storedName(), "Help Desk");

    // Keeping its own name is not a conflict with itself; 80 characters is the limit, not past it.
    assert.equal((await rename("admin", { name: "Help Desk" })).statusCode, 200);
    assert.equal((await rename("admin", { name: "y".repeat(80) })).statusCode, 200);
  } finally {
    await app.close();
    db.close();
  }
});
