import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type AntigravitySetupCommandMessage,
  type AntigravitySetupView,
  type RunnerMetadata,
} from "@wollipog/protocol";
import { registerAntigravitySetupRoutes } from "./antigravity-setup-routes.js";
import { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";

const SUPPORTED = RUNNER_CAPABILITY_MIN_PROTOCOL.antigravitySetup;

const owner: HumanPrincipal = {
  kind: "human", actorId: "usr_local_owner", userId: "usr_local_owner", userName: "Local owner",
  organizationId: "org_personal", organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: true,
};

function meta(): RunnerMetadata {
  return { runnerId: "runner-1", hostname: "host-1", os: "linux", version: "1.0.0", agents: [], workspaces: [] };
}

const signInRequired: AntigravitySetupView = {
  version: 1, status: "sign_in_required", checkedAt: 1_000,
  executable: { path: "/home/fixture/.local/bin/agy", version: "1.4.2" }, credentialStore: "shared_os_keyring",
};

test("a runner's setup is validated, version-gated, cleared on reconnect, and shown to Machine managers", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    db.registerRunner(meta(), 500, SUPPORTED - 1);
    assert.throws(() => db.updateRunnerAntigravitySetup("runner-1", signInRequired, 510), /does not support/);
    assert.equal(db.getRunner("runner-1")?.antigravitySetup, undefined);

    db.registerRunner(meta(), 600, SUPPORTED);
    assert.equal(db.getRunner("runner-1")?.antigravitySetup, undefined, "nothing is reported before the runner sends it");
    db.updateRunnerAntigravitySetup("runner-1", signInRequired, 610);
    assert.deepEqual(db.getRunner("runner-1")?.antigravitySetup, signInRequired);
    assert.deepEqual(db.listRunnersForPrincipal(owner).find((runner) => runner.runnerId === "runner-1")?.antigravitySetup,
      signInRequired);

    assert.throws(() => db.updateRunnerAntigravitySetup("runner-1", { ...signInRequired, status: "ready" }, 620), /invalid/,
      "ready needs advertised models and an executable in a valid report");
    assert.throws(() => db.updateRunnerAntigravitySetup("runner-1", { ...signInRequired, output: "token" }, 620), /invalid/);
    assert.deepEqual(db.getRunner("runner-1")?.antigravitySetup, signInRequired, "a refused report changes nothing");

    // A reconnect forgets the previous connection's setup (and any sign-in link it held) until the
    // runner republishes its current one.
    db.registerRunner(meta(), 700, SUPPORTED);
    assert.equal(db.getRunner("runner-1")?.antigravitySetup, undefined);
  } finally {
    db.close();
  }
});

function harness(options: {
  canManage?: boolean | ((principal: HumanPrincipal) => boolean);
  /** The caller as its credential resolves now; null once its device is revoked. */
  caller?: () => HumanPrincipal | null;
  online?: boolean; protocolVersion?: number; reply?: (msg: AntigravitySetupCommandMessage) => unknown;
} = {}) {
  const sent: AntigravitySetupCommandMessage[] = [];
  const stored: unknown[] = [];
  const db = {
    canManageRunner: (principal: HumanPrincipal) =>
      typeof options.canManage === "function" ? options.canManage(principal) : options.canManage ?? true,
    getRunner: (id: string) => id === "runner-1" ? { runnerId: id, protocolVersion: options.protocolVersion ?? SUPPORTED } : null,
    updateRunnerAntigravitySetup: (_id: string, setup: unknown) => { stored.push(setup); },
  } as unknown as ControlPlaneDb;
  const hub = {
    isRunnerOnline: () => options.online ?? true,
    runnerChanged: () => {},
    requestFromRunner: async (_runnerId: string, requestId: string, msg: AntigravitySetupCommandMessage) => {
      sent.push(msg);
      return options.reply?.(msg) ?? { type: "antigravity_setup_result", requestId, ok: true, setup: signInRequired };
    },
  } as unknown as Hub;
  const app = Fastify();
  registerAntigravitySetupRoutes(app, db, hub, () => options.caller ? options.caller() : owner);
  return { app, sent, stored };
}

test("routes relay each setup action to the runner and record the setup it returns", async () => {
  const { app, sent, stored } = harness();
  try {
    const operationId = "agy_login_123e4567-e89b-12d3-a456-426614174000";
    assert.equal((await app.inject({ method: "POST", url: "/api/runners/runner-1/antigravity-setup/check" })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/runners/runner-1/antigravity-setup/sign-in" })).statusCode, 200);
    const submitted = await app.inject({ method: "POST", url: `/api/runners/runner-1/antigravity-setup/sign-in/${operationId}/code`,
      payload: { code: "  FIXTURE-CODE  " } });
    assert.equal(submitted.statusCode, 200);
    assert.deepEqual(submitted.json(), { setup: signInRequired });
    assert.ok(!submitted.body.includes("FIXTURE-CODE"), "the code is never echoed back");
    assert.equal((await app.inject({ method: "DELETE", url: `/api/runners/runner-1/antigravity-setup/sign-in/${operationId}` })).statusCode, 200);
    assert.deepEqual(sent.map((msg) => [msg.action, msg.operationId, msg.code]), [
      ["check", undefined, undefined],
      ["start_sign_in", undefined, undefined],
      ["submit_code", operationId, "FIXTURE-CODE"],
      ["cancel_sign_in", operationId, undefined],
    ]);
    assert.equal(stored.length, 4);
  } finally {
    await app.close();
  }
});

test("manage access revoked while the runner answers withholds the reply and its sign-in link", async () => {
  let managing = true;
  const pending: AntigravitySetupView = { ...signInRequired, signIn: {
    operationId: "agy_login_1", status: "awaiting_code", startedAt: 1, verificationUrl: "https://accounts.google.com/o?state=fixture",
  } };
  const { app } = harness({ canManage: () => managing, reply: (msg) => {
    managing = false;
    return { type: "antigravity_setup_result", requestId: msg.requestId, ok: true, setup: pending };
  } });
  try {
    const response = await app.inject({ method: "POST", url: "/api/runners/runner-1/antigravity-setup/check" });
    assert.equal(response.statusCode, 403);
    assert.ok(!response.body.includes("accounts.google.com"));
  } finally {
    await app.close();
  }

  // The caller is resolved again from its credential: a demotion or a revoked device while the
  // runner answers withholds the reply too, even though the principal captured earlier could manage.
  for (const change of ["demoted", "device revoked"] as const) {
    let caller: HumanPrincipal | null = owner;
    const changed = harness({
      caller: () => caller,
      canManage: (principal) => principal.role === "owner",
      reply: (msg) => {
        caller = change === "demoted" ? { ...owner, role: "viewer" } : null;
        return { type: "antigravity_setup_result", requestId: msg.requestId, ok: true, setup: pending };
      },
    });
    try {
      const response = await changed.app.inject({ method: "POST", url: "/api/runners/runner-1/antigravity-setup/check" });
      assert.equal(response.statusCode, 403, change);
      assert.ok(!response.body.includes("accounts.google.com"), change);
    } finally {
      await changed.app.close();
    }
  }
});

test("routes refuse non-managers, offline or older runners, malformed input and runner refusals", async () => {
  const check = (app: ReturnType<typeof Fastify>) => app.inject({ method: "POST", url: "/api/runners/runner-1/antigravity-setup/check" });
  for (const [options, status] of [
    [{ canManage: false }, 403],
    [{ online: false }, 409],
    [{ protocolVersion: SUPPORTED - 1 }, 409],
  ] as const) {
    const { app, sent } = harness(options);
    try {
      assert.equal((await check(app)).statusCode, status, JSON.stringify(options));
      assert.equal(sent.length, 0);
    } finally {
      await app.close();
    }
  }
  const older = harness({ protocolVersion: SUPPORTED - 1 });
  try {
    const body = (await check(older.app)).json() as { error: string };
    assert.match(body.error, /newer runner for Google Antigravity setup/);
  } finally {
    await older.app.close();
  }

  const { app, sent } = harness({ reply: (msg) => ({ type: "antigravity_setup_result", requestId: "x", ok: false,
    error: "A Google Antigravity sign-in is already running on this machine.", setup: { ...signInRequired, extra: true } }) });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/runners/runner-1/antigravity-setup/sign-in/login_1/code",
      payload: { code: "x" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/runners/runner-1/antigravity-setup/sign-in/agy_login_1/code",
      payload: { code: "line\nbreak" } })).statusCode, 400);
    assert.equal(sent.length, 0);
    const refused = await app.inject({ method: "POST", url: "/api/runners/runner-1/antigravity-setup/sign-in" });
    assert.equal(refused.statusCode, 409);
    assert.match((refused.json() as { error: string }).error, /already running/);
  } finally {
    await app.close();
  }
});
