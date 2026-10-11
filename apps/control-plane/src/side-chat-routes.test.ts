import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { RunnerMetadata, SideChatView } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import type { ServiceResult } from "./sessions.js";
import { registerSideChatRoutes } from "./side-chat-routes.js";

const runner: RunnerMetadata = {
  runnerId: "side-chat-runner",
  hostname: "host",
  os: "linux",
  version: "1",
  agents: [],
  workspaces: [{ id: "side-chat-workspace", name: "Workspace", path: "/repo" }],
};

/**
 * #2863: Side Chat's Stop Turn needs the side chat's live turn coordinate, which exists only in the
 * hub's overlay, and its Stop Turn refusal needs the asking person's command permissions. The side
 * chat routes answer with both, as the session lookup does, for a read and for a create alike.
 */
test("the side chat routes answer with the child's live turn and the person's command permissions", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner, 1, 55);
  for (const id of ["parent", "child"]) {
    db.createSession({
      id, runnerId: runner.runnerId, agentId: null, workspaceId: runner.workspaces[0]!.id,
      title: id, useWorktree: false, driver: "acp", config: {}, now: 2,
    });
  }
  const identity = db.localIdentityContext();
  const owner: HumanPrincipal = { kind: "human", actorId: identity.userId, ...identity };
  const relation = (): SideChatView => ({ parentSessionId: "parent", session: db.getSession("child")!, createdAt: 3 });
  let refuse: ServiceResult<SideChatView> | null = null;
  const overlaid: string[] = [];
  const app = Fastify();
  registerSideChatRoutes(app, {
    service: {
      sideChat: (id) => id === "parent" ? { ok: true, status: 200, data: relation() } : { ok: true, status: 200, data: null },
      createSideChat: () => refuse ?? { ok: true, status: 200, data: relation() },
    },
    permissions: db,
    requestPrincipal: (req) => req.headers.authorization === "Bearer owner" ? owner : null,
    withQueue: (session) => {
      overlaid.push(session.id);
      return { ...session, activeTurnId: "live-turn", queueHeld: false };
    },
  });
  await app.ready();
  t.after(async () => { await app.close(); db.close(); });

  const read = await app.inject({ method: "GET", url: "/api/sessions/parent/side-chat", headers: { authorization: "Bearer owner" } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().sideChat.session.id, "child");
  assert.equal(read.json().sideChat.session.activeTurnId, "live-turn", "the live turn the database view lacks");
  assert.ok(read.json().sideChat.session.commandPermissions?.cancelTurn, "what the person may do to the side chat");

  const none = await app.inject({ method: "GET", url: "/api/sessions/other/side-chat", headers: { authorization: "Bearer owner" } });
  assert.deepEqual(none.json(), { sideChat: null });

  const created = await app.inject({
    method: "POST", url: "/api/sessions/parent/side-chat", headers: { authorization: "Bearer owner" }, payload: { replaceEnded: true },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().session.activeTurnId, "live-turn");
  assert.deepEqual(overlaid, ["child", "child"]);

  const invalid = await app.inject({ method: "POST", url: "/api/sessions/parent/side-chat", payload: { replaceEnded: "yes" } });
  assert.equal(invalid.statusCode, 400);

  refuse = { ok: false, status: 409, error: "the current side chat is still active" };
  const refused = await app.inject({ method: "POST", url: "/api/sessions/parent/side-chat", payload: { replaceEnded: true } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, "the current side chat is still active");
});
