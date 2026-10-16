import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { ARCHIVED_HISTORY_RETENTION_DELAY_MS, type ArchivedHistoryRetentionView } from "@wollipog/protocol";
import { ArchivedHistoryRetention } from "./archived-history-retention.js";
import { registerArchivedHistoryRetentionRoutes } from "./archived-history-retention-route.js";
import { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";

function human(role: HumanPrincipal["role"]): HumanPrincipal {
  return {
    kind: "human", actorId: `${role}-user`, userId: `${role}-user`, userName: role,
    organizationId: "org_personal", organizationName: "Personal", role, deviceId: `${role}-device`, localBootstrap: false,
  };
}

test("members read archived history retention; only owners and admins change it, within its limits", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const now = Date.UTC(2026, 0, 1);
  const retention = new ArchivedHistoryRetention(db, { env: {}, log: { info() {}, warn() {} }, now: () => now });
  const principals = new Map<string, AuthPrincipal>([
    ["viewer", human("viewer")],
    ["owner", human("owner")],
    ["admin", human("admin")],
    ["agent", {
      kind: "agent", actorId: "agent", organizationId: "org_personal",
      delegatedScope: { organizationId: "org_personal", owner: { kind: "organization", organizationId: "org_personal" } },
    }],
  ]);
  const app = Fastify();
  registerArchivedHistoryRetentionRoutes(app, retention, (request) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    return token ? principals.get(token) ?? null : null;
  });
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/archived-history-retention" })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: "/api/archived-history-retention", headers: as("agent") })).statusCode, 403);

    const viewer = await app.inject({ method: "GET", url: "/api/archived-history-retention", headers: as("viewer") });
    assert.equal(viewer.statusCode, 200);
    const view = viewer.json() as ArchivedHistoryRetentionView;
    assert.equal(view.retentionDays, null);
    assert.equal(view.source, "default");
    assert.equal(view.canManage, false);
    assert.deepEqual(view.limits, { minDays: 7, maxDays: 3650, suggestedDays: 90 });

    const preview = await app.inject({ method: "GET", url: "/api/archived-history-retention?previewDays=90", headers: as("viewer") });
    assert.deepEqual((preview.json() as ArchivedHistoryRetentionView).preview,
      { retentionDays: 90, eligible: { sessions: 0, events: 0 }, prunesFrom: now + ARCHIVED_HISTORY_RETENTION_DELAY_MS });
    for (const bad of ["6", "3651", "abc", "9.5", ""]) {
      const response = await app.inject({ method: "GET", url: `/api/archived-history-retention?previewDays=${bad}`, headers: as("viewer") });
      assert.equal(response.statusCode, 400, bad);
    }

    const put = (token: string, body: unknown) => app.inject({
      method: "PUT", url: "/api/archived-history-retention", headers: as(token), payload: body as object,
    });
    assert.equal((await put("viewer", { retentionDays: 90 })).statusCode, 403);
    assert.equal((await put("agent", { retentionDays: 90 })).statusCode, 403);
    for (const bad of [{}, { retentionDays: 6 }, { retentionDays: 3651 }, { retentionDays: 9.5 }, { retentionDays: "90" }]) {
      assert.equal((await put("admin", bad)).statusCode, 400, JSON.stringify(bad));
    }
    const saved = await put("owner", { retentionDays: 90 });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(
      (({ retentionDays, source, prunesFrom, canManage }) => ({ retentionDays, source, prunesFrom, canManage }))(
        saved.json() as ArchivedHistoryRetentionView),
      { retentionDays: 90, source: "organization", prunesFrom: now + ARCHIVED_HISTORY_RETENTION_DELAY_MS, canManage: true },
    );
    const off = await put("admin", { retentionDays: null });
    assert.equal((off.json() as ArchivedHistoryRetentionView).retentionDays, null);
    assert.equal((off.json() as ArchivedHistoryRetentionView).source, "organization");
  } finally {
    await app.close();
    db.close();
  }
});
