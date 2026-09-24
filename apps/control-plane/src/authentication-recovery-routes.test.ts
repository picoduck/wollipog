import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToRunner,
  type RunnerMetadata,
} from "@wollipog/protocol";
import { registerAuthenticationRecoveryRoutes } from "./authentication-recovery-routes.js";
import { ControlPlaneDb } from "./db.js";
import type { RunnerRequestResult } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";

const SESSION = "auth-route-session";
const CARD = "provider-auth:recovery-1";

const runner: RunnerMetadata = {
  runnerId: "auth-route-runner",
  hostname: "host",
  os: "linux",
  version: "1",
  agents: [],
  workspaces: [{ id: "auth-route-workspace", name: "Workspace", path: "/repo" }],
  providerAccounts: [
    { id: "claude-work", label: "Claude Work", provider: "claude", authStatus: "authenticated" },
    { id: "claude-personal", label: "Claude Personal", provider: "claude", authStatus: "authenticated" },
    { id: "claude-old", label: "Claude Old", provider: "claude", authStatus: "unauthenticated" },
    { id: "claude-maybe", label: "Claude Maybe", provider: "claude", authStatus: "unknown" },
    { id: "codex-work", label: "Codex Work", provider: "codex", authStatus: "authenticated" },
  ],
};

async function setup(
  t: TestContext,
  options: {
    protocolVersion?: number;
    human?: boolean;
    reply?: (message: ControlPlaneToRunner) => RunnerRequestResult;
  } = {},
) {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner, 1, options.protocolVersion ?? PROTOCOL_VERSION);
  db.createSession({
    id: SESSION,
    runnerId: runner.runnerId,
    agentId: "claude",
    workspaceId: "auth-route-workspace",
    title: "Session",
    useWorktree: false,
    driver: "claude-code",
    config: {},
    now: 1,
    providerAccountId: "claude-work",
    providerAccountLabel: "Claude Work",
  });
  db.setPendingApproval(SESSION, {
    requestId: CARD,
    kind: "authentication",
    title: "Authentication Required — Claude Code",
    options: [{ optionId: "auth:revalidate", name: "Recheck Authentication", kind: "allow_once" }],
  });
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { kind: "human", actorId: identity.userId, ...identity, role: "owner" };
  const sent: ControlPlaneToRunner[] = [];
  const app = Fastify();
  registerAuthenticationRecoveryRoutes(app, {
    db,
    hub: {
      isRunnerOnline: () => true,
      requestFromRunner: async (_runnerId, _requestId, message) => {
        sent.push(message);
        if (!options.reply) throw new Error("no runner reply configured");
        return options.reply(message);
      },
    },
    requestHuman: () => options.human === false ? null : principal,
  });
  await app.ready();
  t.after(async () => { await app.close(); db.close(); });
  return { app, db, sent };
}

test("recovery lists every same-provider account with its real availability", async (t) => {
  const { app } = await setup(t);
  const response = await app.inject({ method: "GET", url: `/api/sessions/${SESSION}/authentication/accounts` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().accounts.map((account: { id: string; availability: string }) => [account.id, account.availability]),
    [
      ["claude-work", "current"],
      ["claude-personal", "available"],
      ["claude-old", "sign_in_required"],
      ["claude-maybe", "status_unknown"],
    ],
    "signed-out and unknown accounts stay visible; other providers never appear",
  );
});

test("the current identity reaches only a person viewing the exact card and is never cached", async (t) => {
  const { app, sent } = await setup(t, {
    reply: (message) => ({
      type: "inspect_provider_authentication_result",
      requestId: (message as { requestId: string }).requestId,
      ok: true,
      identity: { status: "authenticated", emailSupported: true, email: "person@example.test", observedAt: 5 },
    }),
  });
  const inspect = (requestId: string) => app.inject({
    method: "POST",
    url: `/api/sessions/${SESSION}/authentication/current-identity`,
    payload: { requestId },
  });

  const stale = await inspect("provider-auth:older");
  assert.equal(stale.statusCode, 409);
  assert.equal(sent.length, 0, "a stale card never reaches the runner");

  const response = await inspect(CARD);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json(), {
    identity: { status: "authenticated", emailSupported: true, email: "person@example.test", observedAt: 5 },
  });
  assert.deepEqual(sent, [{
    type: "inspect_provider_authentication",
    requestId: (sent[0] as { requestId: string }).requestId,
    sessionId: SESSION,
    recoveryRequestId: CARD,
  }]);
});

test("agents and older runners cannot reach recovery identity or selection", async (t) => {
  const agent = await setup(t, { human: false });
  const denied = await agent.app.inject({
    method: "POST",
    url: `/api/sessions/${SESSION}/authentication/current-identity`,
    payload: { requestId: CARD },
  });
  assert.equal(denied.statusCode, 403);

  const older = await setup(t, { protocolVersion: 179 });
  const unsupported = await older.app.inject({
    method: "POST",
    url: `/api/sessions/${SESSION}/authentication/account`,
    payload: { requestId: CARD, providerAccountId: "claude-personal", expectedProviderAccountId: "claude-work" },
  });
  assert.equal(unsupported.statusCode, 409);
  assert.match(unsupported.json().error, /Update and restart the runner/);
  assert.equal(older.sent.length, 0);
});

test("account selection validates the card, binding, and compatibility before the runner rechecks it", async (t) => {
  const { app, sent } = await setup(t, {
    reply: (message) => ({
      type: "select_provider_authentication_account_result",
      requestId: (message as { requestId: string }).requestId,
      ...((message as { providerAccountId: string }).providerAccountId === "claude-old"
        ? { ok: false, code: "sign_in_required" as const, error: "The provider reports that this account is signed out." }
        : { ok: true }),
    }),
  });
  const select = (payload: Record<string, unknown>) => app.inject({
    method: "POST",
    url: `/api/sessions/${SESSION}/authentication/account`,
    payload: { requestId: CARD, expectedProviderAccountId: "claude-work", ...payload },
  });

  const staleCard = await select({ requestId: "provider-auth:older", providerAccountId: "claude-personal" });
  assert.deepEqual([staleCard.statusCode, staleCard.json().code], [409, "recovery_changed"]);
  const moved = await select({ providerAccountId: "claude-personal", expectedProviderAccountId: "claude-old" });
  assert.deepEqual([moved.statusCode, moved.json().code], [409, "account_changed"]);
  const current = await select({ providerAccountId: "claude-work" });
  assert.deepEqual([current.statusCode, current.json().code], [409, "account_unavailable"]);
  const otherProvider = await select({ providerAccountId: "codex-work" });
  assert.deepEqual([otherProvider.statusCode, otherProvider.json().code], [409, "account_unavailable"]);
  const malformed = await select({ providerAccountId: "../escape" });
  assert.equal(malformed.statusCode, 400);
  assert.equal(sent.length, 0, "nothing invalid reaches the runner");

  const signedOut = await select({ providerAccountId: "claude-old" });
  assert.deepEqual([signedOut.statusCode, signedOut.json().code], [409, "sign_in_required"],
    "a signed-out account is offered for a recheck, and the runner's refusal is explained");
  const accepted = await select({ providerAccountId: "claude-personal" });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), { accepted: true });
  assert.deepEqual(sent.map((message) => (message as { providerAccountId: string }).providerAccountId),
    ["claude-old", "claude-personal"]);
});
