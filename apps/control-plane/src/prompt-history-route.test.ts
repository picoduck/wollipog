import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import { registerPromptHistoryRoute } from "./prompt-history-route.js";

function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({ runnerId: "runner", hostname: "synthetic", os: "linux", version: "test", agents: [], workspaces: [] }, 1);
  for (const id of ["session", "other"]) db.createSession({ id, runnerId: "runner", workspaceId: null,
    agentId: null, title: "Synthetic", useWorktree: false, driver: "acp", config: {}, now: 1 });
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { kind: "human", actorId: identity.userId, ...identity };
  return { db, principal };
}

test("indexed recall pages contain only user text/identity, preserve repeats, and isolate sessions", () => {
  const { db } = fixture();
  try {
    db.appendEvent("session", { kind: "user_message", text: "same", images: [{ mimeType: "image/png", data: "private image" }] }, 1);
    for (let i = 0; i < 500; i++) db.appendEvent("session", { kind: "agent_message", text: "agent output" }, i + 2);
    db.appendEvent("session", { kind: "user_message", text: "same", turnId: "turn", submissionId: "submit" }, 502);
    db.appendEvent("other", { kind: "user_message", text: "other session" }, 1);
    const newest = db.listPromptHistoryPage("session", undefined, 1);
    assert.deepEqual(newest, { prompts: [{ seq: 502, text: "same", turnId: "turn", submissionId: "submit" }], nextBefore: 502, hasMore: true });
    assert.deepEqual(db.listPromptHistoryPage("session", newest.nextBefore, 1), {
      prompts: [{ seq: 1, text: "same" }], nextBefore: 1, hasMore: false,
    });
    const plan = db.raw().prepare(`EXPLAIN QUERY PLAN SELECT seq FROM session_events
      WHERE session_id=? AND kind='user_message' AND seq<? ORDER BY seq DESC LIMIT ?`).all("session", 1000, 2);
    assert.ok(plan.some(row => String(row.detail).includes("idx_session_events_user_message")));
    for (const limit of [0, 101, 1.5]) assert.throws(() => db.listPromptHistoryPage("session", undefined, limit), RangeError);
  } finally { db.close(); }
});

test("prompt-history route authorizes, bounds pages, joins hydration and fences replaced histories", async t => {
  const { db, principal } = fixture();
  const app = Fastify();
  let hydrate = async () => {};
  let hydrationCalls = 0;
  registerPromptHistoryRoute(app, { db, requestPrincipal: req => req.headers.authorization === "owner" ? principal : null,
    hydrateHistory: async () => { hydrationCalls++; await hydrate(); } });
  t.after(async () => { await app.close(); db.close(); });
  const request = (query = "eventEpoch=0", auth = "owner", id = "session") =>
    app.inject({ method: "GET", url: `/api/sessions/${id}/prompt-history?${query}`, headers: { authorization: auth } });
  assert.equal((await request("eventEpoch=0", "denied")).statusCode, 404);
  assert.equal((await request("eventEpoch=0", "owner", "missing")).statusCode, 404);
  for (const query of ["", "eventEpoch=-1", "eventEpoch=1.5", "eventEpoch=0&limit=101", "eventEpoch=0&before=0"]) {
    assert.equal((await request(query)).statusCode, 400, query);
  }
  assert.equal((await request("eventEpoch=99")).statusCode, 409);
  assert.equal(hydrationCalls, 0);
  hydrate = async () => { db.appendEvent("session", { kind: "user_message", text: "hydrated prompt" }, 1); };
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json().prompts, [{ seq: 1, text: "hydrated prompt" }]);
  assert.equal(response.json().cacheComplete, true);
  hydrate = async () => { db.clearSessionEvents("session"); };
  assert.equal((await request()).statusCode, 409, "an epoch replaced during hydration is rejected");
});
