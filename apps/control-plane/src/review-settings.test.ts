import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REVIEW_SETTINGS, PROTOCOL_VERSION, type ReviewSettings } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { parseReviewSettings, ReviewSettingsService } from "./review-settings.js";
import { registerReviewSettingsRoutes } from "./review-settings-route.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";

function human(db: ControlPlaneDb, deviceId = "one"): HumanPrincipal {
  const local = db.localIdentityContext();
  return { ...local, kind: "human", actorId: local.userId, role: "owner", deviceId, localBootstrap: false };
}

test("review settings survive a restart, follow the user across devices and replace the entire user document per project", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-settings-"));
  const file = join(dir, "control.sqlite");
  let db = ControlPlaneDb.open(file);
  try {
    const user = human(db);
    const project = db.createProject({ name: "Project" });
    assert.deepEqual(db.reviewSettings.effective(user.userId, project.id), { settings: DEFAULT_REVIEW_SETTINGS, source: "system_default" });
    const settings: ReviewSettings = { version: 1, roundBudget: 7, reviewers: [] };
    db.reviewSettings.set(user.userId, null, settings);
    db.reviewSettings.set(user.userId, project.id, { ...settings, roundBudget: 2 });
    db.close(); db = ControlPlaneDb.open(file);
    const otherDevice = human(db, "two");
    const service = new ReviewSettingsService(db);
    assert.equal(service.view(otherDevice, null).settings.roundBudget, 7);
    assert.equal(service.view(otherDevice, project.id).settings.roundBudget, 2);
    service.update(otherDevice, project.id, null);
    assert.equal(service.view(user, project.id).source, "user_default");
    assert.equal(service.view(user, project.id).settings.roundBudget, 7);
    assert.equal(db.reviewSettings.get("another-user"), null);
    service.update(user, null, null);
    assert.equal(service.view(user, null).source, "system_default");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("settings reject commands, unknown fields, duplicate harness rules and invalid round budgets", () => {
  const rule = { implementer: { agentId: "claude", driver: "claude-code", context: { kind: "native" } },
    harness: "codex", model: null, effort: null, allowSameFamily: false };
  for (const value of [null, { ...DEFAULT_REVIEW_SETTINGS, roundBudget: 0 }, { ...DEFAULT_REVIEW_SETTINGS, roundBudget: 33 },
    { ...DEFAULT_REVIEW_SETTINGS, command: "evil" }, { ...DEFAULT_REVIEW_SETTINGS, reviewers: [{ ...rule, command: "evil" }] },
    { ...DEFAULT_REVIEW_SETTINGS, reviewers: [{ ...rule, harness: "evil" }] }, { ...DEFAULT_REVIEW_SETTINGS, reviewers: [rule, rule] }]) {
    assert.equal(parseReviewSettings(value), null);
  }
  assert.ok(parseReviewSettings({ ...DEFAULT_REVIEW_SETTINGS, reviewers: [rule] }));
});

test("settings writes require a discovered model/effort pair and explicit same-family permission", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const principal = human(db);
    db.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "test", workspaces: [], agents: [{
      id: "claude", name: "Claude Code", driver: "claude-code", command: "claude", args: [], env: {}, available: true,
      capabilities: { models: [{ id: "claude-opus-5-5", default: true, efforts: ["high"] }], effortLevels: ["high"],
        slashCommands: [], supportsImages: false, supportsApprovals: true },
    }], runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
      reviewSession: { configuration: true, reviewers: [{ harness: "claude-code", agentId: "claude" }] } } }, Date.now(), PROTOCOL_VERSION);
    db.updateRunnerReviewSessionCapability("r", { configuration: true, reviewers: [{ harness: "claude-code", agentId: "claude" }] });
    const service = new ReviewSettingsService(db);
    assert.equal(service.view(principal, null).reviewers.length, 1, "registration and refresh preserve configuration support");
    const rule = { implementer: { agentId: "claude", driver: "claude-code" as const, context: { kind: "native" as const } },
      harness: "claude-code" as const, model: "claude-opus-5-5", effort: "high", allowSameFamily: false };
    assert.throws(() => service.update(principal, null, { ...DEFAULT_REVIEW_SETTINGS, reviewers: [rule] }), /model family/u);
    assert.throws(() => service.update(principal, null, { ...DEFAULT_REVIEW_SETTINGS, reviewers: [{ ...rule, allowSameFamily: true, model: "unknown" }] }), /unknown.*unavailable/u);
    assert.throws(() => service.update(principal, null, { ...DEFAULT_REVIEW_SETTINGS, reviewers: [{ ...rule, allowSameFamily: true, effort: "low" }] }), /low.*unavailable/u);
    assert.equal(service.update(principal, null, { ...DEFAULT_REVIEW_SETTINGS, reviewers: [{ ...rule, allowSameFamily: true }] }).source, "user_default");
    db.raw().prepare("UPDATE runners SET status='offline' WHERE runner_id='r'").run();
    const retained = service.update(principal, null, { ...DEFAULT_REVIEW_SETTINGS, roundBudget: 6, reviewers: [{ ...rule, allowSameFamily: true }] });
    assert.equal(retained.settings.roundBudget, 6, "an unchanged admitted rule can be retained while its machine is offline");
    assert.throws(() => service.update(principal, null, { ...retained.settings, reviewers: [{ ...rule, allowSameFamily: true, effort: "low" }] }), /unavailable/u);
  } finally { db.close(); }
});

test("the route authenticates humans, validates project access and stores only the caller's settings", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  let principal: AuthPrincipal | null = human(db);
  registerReviewSettingsRoutes(app, new ReviewSettingsService(db), () => principal);
  try {
    const saved = await app.inject({ method: "PUT", url: "/api/review-settings", payload: { settings: { ...DEFAULT_REVIEW_SETTINGS, roundBudget: 6 } } });
    assert.equal(saved.statusCode, 200);
    assert.match(saved.headers["cache-control"]!, /no-store/u);
    assert.equal((await app.inject("/api/review-settings")).json().settings.roundBudget, 6);
    assert.equal((await app.inject("/api/review-settings?projectId=unknown")).statusCode, 404);
    principal = null;
    assert.equal((await app.inject("/api/review-settings")).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: "/api/review-settings", payload: { settings: null } })).statusCode, 403);
  } finally { await app.close(); db.close(); }
});
