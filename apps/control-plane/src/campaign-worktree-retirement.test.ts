import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { PROTOCOL_VERSION, type CampaignWorktreeRetirementState } from "@wollipog/protocol";
import { registerCampaignWorktreeRetirementRoutes } from "./campaign-worktree-retirement.js";
import { isAgentControlApiRouteAllowed } from "./auth.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";

test("only a human operator can retire a refused archived campaign checkout; the server supplies attribution", async () => {
  const human: HumanPrincipal = { kind: "human", actorId: "human:person", userId: "person", userName: "Person",
    organizationId: "org_personal", organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: false };
  let principal: AuthPrincipal | null = human;
  let archived = true, refused = true, accessible = true, online = true, protocolVersion = PROTOCOL_VERSION, mismatched = false;
  const state: CampaignWorktreeRetirementState = { worktreeId: "worktree", path: "/fixture/worktree", registeredBranch: "fix/work",
    branch: "fix/work", headSha: "a".repeat(40), clean: true, pathIdentity: "1:2" };
  const sent: Array<Record<string, unknown>> = [], audits: Array<Record<string, unknown>> = [], updated: string[] = [];
  const db = {
    getSession: (id: string) => id === "root" ? { orchestratorPolicy: {} } : id === "child" ? { runnerId: "runner", archived } : null,
    campaignRootForMember: () => "root", canAccessSession: () => accessible, canAccessRunner: () => accessible,
    campaignWorktreeCleanup: () => [{ path: state.path, status: refused ? "refused" : "pending" }],
    getRunner: () => ({ protocolVersion }), recordMutationAudit: (entry: Record<string, unknown>) => audits.push(entry),
    updateSessionFromSnapshot: (id: string) => updated.push(id),
  } as unknown as ControlPlaneDb;
  const hub = { isRunnerOnline: () => online,
    requestFromRunner: async (_runner: string, _id: string, message: Record<string, unknown>) => {
      sent.push(message);
      return { type: "session_worktree_result", ok: true, sessionId: mismatched ? "another-child" : "child",
        operation: message.operation, snapshot: {}, retirementState: message.operation === "inspect_retirement" ? state : undefined,
        retirement: message.operation === "confirm_retirement" ? { status: "removed" } : undefined };
    },
  } as unknown as Hub;
  const app = Fastify();
  registerCampaignWorktreeRetirementRoutes(app, { db, hub, requestPrincipal: () => principal });
  const route = (operation: string) => `/api/sessions/root/orchestrator-campaign/cleanup/worktree/${operation}`;
  const inspect = () => app.inject({ method: "POST", url: route("inspect"), payload: { childSessionId: "child", path: state.path } });
  const confirm = (value: unknown = state) => app.inject({ method: "POST", url: route("confirm"), payload: {
    childSessionId: "child", state: value, confirmedBy: { userId: "forged", at: 0 }, ownerRule: "delegated", approved: true } });
  try {
    for (const denied of [null, { ...human, role: "viewer" as const }, { kind: "agent" as const, actorId: "agent:root", credentialSessionId: "root",
      orchestrator: true, organizationId: "org_personal", delegatedScope: { organizationId: "org_personal", owner: { kind: "user" as const, userId: "person" } } }]) {
      principal = denied;
      assert.equal((await inspect()).statusCode, 403);
      assert.equal((await confirm()).statusCode, 403);
    }
    assert.equal(sent.length, 0); assert.equal(audits.length, 0);
    principal = human;
    accessible = false; assert.equal((await inspect()).statusCode, 404); accessible = true;
    archived = false; assert.equal((await confirm()).statusCode, 409); archived = true;
    refused = false; assert.equal((await confirm()).statusCode, 409); refused = true;
    protocolVersion = 371; assert.equal((await inspect()).statusCode, 409); protocolVersion = PROTOCOL_VERSION;
    online = false; assert.equal((await confirm()).statusCode, 409); online = true;
    assert.equal((await confirm({ ...state, clean: false })).statusCode, 400);
    assert.equal(sent.length, 0);
    assert.deepEqual((await inspect()).json().state, state);
    const before = Date.now();
    assert.equal((await confirm()).statusCode, 200);
    const message = sent.at(-1)!;
    assert.deepEqual(message.state, state);
    const actor = message.confirmedBy as { userId: string; at: number };
    assert.equal(actor.userId, human.userId); assert.ok(actor.at >= before);
    assert.equal(audits.length, 1); assert.equal(audits[0]!.now, actor.at);
    assert.equal(audits[0]!.principal, human); assert.equal(audits[0]!.targetId, "child:worktree");
    assert.deepEqual(updated, ["child", "child"]);
    mismatched = true; assert.equal((await inspect()).statusCode, 502); assert.equal(updated.length, 2);
    for (const operation of ["inspect", "confirm"]) for (const role of ["default", "orchestrator"]) {
      assert.equal(isAgentControlApiRouteAllowed("POST", `/api/sessions/:id/orchestrator-campaign/cleanup/worktree/${operation}`, role), false);
    }
  } finally { await app.close(); }
});
