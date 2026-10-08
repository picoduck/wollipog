import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ControlPlaneToUi, ResourceScope, RunnerMetadata, SessionEvent } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub, type Socket } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";

/**
 * #2761: the hub caches each dashboard's session access decisions, because checking them for every
 * client on every streamed frame was a measurable share of ingest. The cache is security-sensitive:
 * every change to what decides access must invalidate it, so a client that lost access receives
 * nothing for that session from the very next send, and one that gained it receives the next frame.
 */

const RUNNER_ID = "access-runner";
const ORG = "org-access";
const NOW = 1_000_000;

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: "ws", name: "Repo", path: "/tmp/access" }],
    agents: [{ id: "agent", name: "Agent", command: "claude", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" } }],
  };
}

function principal(userId: string, role: HumanPrincipal["role"] = "viewer", deviceId: string | null = null): HumanPrincipal {
  return { kind: "human", actorId: userId, userId, userName: userId, organizationId: ORG, organizationName: "Org",
    role, deviceId, localBootstrap: false };
}

class Dashboard implements Socket {
  readonly frames: ControlPlaneToUi[] = [];
  closed = false;
  send(data: string): void {
    this.frames.push(JSON.parse(data) as ControlPlaneToUi);
  }
  eventsFor(sessionId: string): number {
    return this.frames.filter((frame) => frame.type === "session_event" && frame.event.sessionId === sessionId).length;
  }
}

function harness(location = ":memory:") {
  const db = ControlPlaneDb.open(location);
  db.raw().prepare("INSERT INTO identity_organizations (organization_id, name, created_at, updated_at) VALUES (?, 'Org', ?, ?)")
    .run(ORG, NOW, NOW);
  // A second organization a team can move to.
  db.raw().prepare("INSERT INTO identity_organizations (organization_id, name, created_at, updated_at) VALUES ('org-other', 'Other', ?, ?)")
    .run(NOW, NOW);
  for (const userId of ["alice", "bob", "carol"]) {
    db.createIdentityMember({ userId, displayName: userId, organizationId: ORG, role: "viewer", now: NOW });
  }
  db.createIdentityTeam({ teamId: "team-a", organizationId: ORG, name: "Team A", memberUserIds: ["alice", "bob"], now: NOW });
  db.createIdentityTeam({ teamId: "team-b", organizationId: ORG, name: "Team B", memberUserIds: ["carol"], now: NOW });
  db.registerRunner(runnerMeta(), NOW);
  const hub = new Hub(db);
  const checks = { count: 0 };
  const canAccessSession = db.canAccessSession.bind(db);
  db.canAccessSession = (who, sessionId) => {
    checks.count++;
    return canAccessSession(who, sessionId);
  };
  const createSession = (id: string, owner: ResourceScope["owner"]) => db.createSession({
    id, runnerId: RUNNER_ID, workspaceId: "ws", agentId: "agent", title: id, useWorktree: false,
    driver: "claude-code", config: {}, now: NOW, scope: { organizationId: ORG, owner },
  });
  const connect = (who: HumanPrincipal) => {
    const dashboard = new Dashboard();
    hub.addUiClient(dashboard, { deviceId: who.deviceId, principal: who, close: () => { dashboard.closed = true; } });
    return dashboard;
  };
  let ts = NOW;
  const emit = (sessionId: string) => {
    const event: SessionEvent = db.appendEvent(sessionId, { kind: "agent_message", text: "streamed" }, ++ts);
    hub.sessionEvent(event);
  };
  return { db, hub, checks, createSession, connect, emit };
}

test("a client's session access decision is reused while nothing that decides access changes", (t) => {
  const h = harness();
  t.after(() => h.db.close());
  h.createSession("s-team", { kind: "team", teamId: "team-a" });
  const alice = h.connect(principal("alice"));
  const carol = h.connect(principal("carol"));
  h.checks.count = 0;
  for (let i = 0; i < 20; i++) h.emit("s-team");
  assert.equal(alice.eventsFor("s-team"), 20);
  assert.equal(carol.eventsFor("s-team"), 0);
  assert.equal(h.checks.count, 2, "one decision per client and session, not one per frame");
});

interface AccessChange {
  name: string;
  /** The session's owner before the change. */
  owner: ResourceScope["owner"];
  /** The client whose access the change affects. */
  client: string;
  allowedBefore: boolean;
  allowedAfter: boolean;
  change: (h: ReturnType<typeof harness>) => void;
}

const changes: AccessChange[] = [
  {
    name: "removing a member from the owning team",
    owner: { kind: "team", teamId: "team-a" }, client: "bob", allowedBefore: true, allowedAfter: false,
    change: (h) => h.db.updateIdentityTeamMembers({ teamId: "team-a", organizationId: ORG, memberUserIds: ["alice"], now: NOW }),
  },
  {
    name: "adding a member to the owning team",
    owner: { kind: "team", teamId: "team-b" }, client: "bob", allowedBefore: false, allowedAfter: true,
    change: (h) => h.db.updateIdentityTeamMembers({ teamId: "team-b", organizationId: ORG, memberUserIds: ["carol", "bob"], now: NOW }),
  },
  {
    name: "deleting the owning team",
    owner: { kind: "team", teamId: "team-a" }, client: "bob", allowedBefore: true, allowedAfter: false,
    // The admin route refuses while the team owns resources; a direct delete still cascades its
    // members away, and the session's owner then names no team anyone belongs to.
    change: (h) => h.db.raw().prepare("DELETE FROM identity_teams WHERE team_id='team-a'").run(),
  },
  {
    name: "narrowing the session's audience to one user",
    owner: { kind: "team", teamId: "team-a" }, client: "bob", allowedBefore: true, allowedAfter: false,
    change: (h) => assert.equal(h.db.setResourceScope({ resource: "session", resourceId: "s-1",
      scope: { organizationId: ORG, owner: { kind: "user", userId: "alice" } }, now: NOW }), true),
  },
  {
    name: "transferring the session to another team",
    owner: { kind: "team", teamId: "team-a" }, client: "carol", allowedBefore: false, allowedAfter: true,
    change: (h) => assert.equal(h.db.setResourceScope({ resource: "session", resourceId: "s-1",
      scope: { organizationId: ORG, owner: { kind: "team", teamId: "team-b" } }, now: NOW }), true),
  },
  {
    name: "deleting a team membership row and nothing else",
    owner: { kind: "team", teamId: "team-a" }, client: "bob", allowedBefore: true, allowedAfter: false,
    change: (h) => h.db.raw().prepare("DELETE FROM identity_team_members WHERE team_id='team-a' AND user_id='bob'").run(),
  },
  {
    name: "moving the owning team to another organization and nothing else",
    owner: { kind: "team", teamId: "team-a" }, client: "bob", allowedBefore: true, allowedAfter: false,
    change: (h) => h.db.raw().prepare("UPDATE identity_teams SET organization_id='org-other' WHERE team_id='team-a'").run(),
  },
  {
    name: "deleting the session's ownership row (fail closed)",
    owner: { kind: "team", teamId: "team-a" }, client: "alice", allowedBefore: true, allowedAfter: false,
    change: (h) => h.db.raw().prepare("DELETE FROM session_ownership WHERE session_id='s-1'").run(),
  },
];

for (const scenario of changes) {
  test(`access is rechecked on the very next send after ${scenario.name}`, (t) => {
    const h = harness();
    t.after(() => h.db.close());
    h.createSession("s-1", scenario.owner);
    const client = h.connect(principal(scenario.client));
    h.emit("s-1");
    h.emit("s-1");
    assert.equal(client.eventsFor("s-1"), scenario.allowedBefore ? 2 : 0, "before the change");
    const revision = h.db.sessionAccessRevision();
    scenario.change(h);
    assert.notEqual(h.db.sessionAccessRevision(), revision, "the change advanced the access revision");
    h.emit("s-1");
    assert.equal(client.eventsFor("s-1"), (scenario.allowedBefore ? 2 : 0) + (scenario.allowedAfter ? 1 : 0),
      "the first send after the change follows the new decision");
  });
}

test("every change that can affect access advances the revision", (t) => {
  const h = harness();
  t.after(() => h.db.close());
  h.createSession("s-1", { kind: "team", teamId: "team-a" });
  const advances = (name: string, change: () => void) => {
    const revision = h.db.sessionAccessRevision();
    assert.notEqual(revision, undefined);
    change();
    assert.notEqual(h.db.sessionAccessRevision(), revision, name);
  };
  advances("a role change", () => h.db.updateIdentityMember({ organizationId: ORG, userId: "bob", displayName: "bob",
    role: "admin", status: "active", now: NOW + 1 }));
  advances("a suspension", () => h.db.updateIdentityMember({ organizationId: ORG, userId: "bob", displayName: "bob",
    role: "admin", status: "suspended", now: NOW + 2 }));
  advances("a project permission change", () => h.db.raw().prepare(
    "UPDATE project_ownership SET owner_kind='user', owner_id='alice'").run());
  advances("a workspace permission change", () => h.db.raw().prepare(
    "UPDATE workspace_ownership SET owner_kind='team', owner_id='team-b'").run());
  advances("a runner permission change", () => h.db.raw().prepare(
    "UPDATE runner_ownership SET owner_kind='team', owner_id='team-b'").run());
  advances("pairing a device", () => h.db.createDevice({ id: "dev-1", name: "Phone", tokenHash: "a".repeat(64),
    userId: "alice", organizationId: ORG, now: NOW }));
  advances("revoking a device", () => assert.equal(h.db.deleteDevice("dev-1"), true));
  advances("archiving the session", () => h.db.setSessionArchived("s-1", true, NOW + 3));
  advances("moving the session to another runner", () => h.db.raw().prepare(
    "UPDATE sessions SET runner_id=runner_id WHERE id='s-1'").run());
  advances("creating a session", () => h.createSession("s-2", { kind: "user", userId: "carol" }));
  advances("deleting a session", () => h.db.deleteSession("s-2"));
  advances("removing a member from the organization", () => h.db.raw().prepare(
    "DELETE FROM identity_memberships WHERE user_id='carol'").run());
  advances("a role-revoked agent credential", () => h.db.raw().prepare(
    "INSERT INTO role_revoked_credentials (session_id, token_hash) VALUES ('s-1', ?)").run("b".repeat(64)));
});

test("streamed writes do not discard cached decisions", (t) => {
  const h = harness();
  t.after(() => h.db.close());
  h.createSession("s-1", { kind: "team", teamId: "team-a" });
  h.connect(principal("alice"));
  const revision = h.db.sessionAccessRevision();
  for (let i = 0; i < 10; i++) h.emit("s-1");
  h.db.updateSessionStatus("s-1", "running", NOW + 10);
  h.db.raw().prepare("UPDATE devices SET last_seen_at=? WHERE 1").run(NOW + 11);
  assert.equal(h.db.sessionAccessRevision(), revision, "events, status and device activity leave access alone");
});

test("a revoked device's dashboard receives nothing from the next send", (t) => {
  const h = harness();
  t.after(() => h.db.close());
  h.createSession("s-1", { kind: "team", teamId: "team-a" });
  h.db.createDevice({ id: "dev-bob", name: "Phone", tokenHash: "c".repeat(64), userId: "bob", organizationId: ORG, now: NOW });
  const phone = h.connect(principal("bob", "viewer", "dev-bob"));
  h.emit("s-1");
  assert.equal(phone.eventsFor("s-1"), 1);
  h.db.deleteDevice("dev-bob");
  h.hub.closeUiClientsForDevice("dev-bob");
  h.emit("s-1");
  assert.equal(phone.closed, true);
  assert.equal(phone.eventsFor("s-1"), 1, "nothing after revocation");
});

test("a role change closes the organization's dashboards, and a reconnect decides afresh", (t) => {
  const h = harness();
  t.after(() => h.db.close());
  h.createSession("s-user", { kind: "user", userId: "alice" });
  const asAdmin = h.connect(principal("bob", "admin"));
  h.emit("s-user");
  assert.equal(asAdmin.eventsFor("s-user"), 1, "an admin sees another member's session");
  h.db.updateIdentityMember({ organizationId: ORG, userId: "bob", displayName: "bob", role: "viewer", status: "active", now: NOW });
  h.hub.closeOrganizationUiClients(ORG);
  h.emit("s-user");
  assert.equal(asAdmin.eventsFor("s-user"), 1, "the closed dashboard receives nothing more");
  const asViewer = h.connect(principal("bob", "viewer"));
  h.emit("s-user");
  assert.equal(asViewer.eventsFor("s-user"), 0, "the reconnected viewer is checked under its new role");
});

test("without an access revision every send checks access in full", (t) => {
  const h = harness();
  t.after(() => h.db.close());
  h.createSession("s-1", { kind: "team", teamId: "team-a" });
  h.db.sessionAccessRevision = () => undefined;
  h.connect(principal("alice"));
  h.checks.count = 0;
  for (let i = 0; i < 5; i++) h.emit("s-1");
  assert.equal(h.checks.count, 5);
});

test("the access triggers live only on the control plane's connection", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-access-revision-"));
  const location = join(root, "control-plane.db");
  try {
    const h = harness(location);
    h.createSession("s-1", { kind: "team", teamId: "team-a" });
    h.db.close();
    // Another connection or build opening the file finds no trigger calling a function it lacks.
    const other = new DatabaseSync(location);
    try {
      const triggers = other.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'session_access_%'").all();
      assert.deepEqual(triggers, []);
      other.prepare("UPDATE identity_team_members SET created_at=created_at+1").run();
      other.prepare("DELETE FROM session_ownership WHERE session_id='s-1'").run();
    } finally {
      other.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
