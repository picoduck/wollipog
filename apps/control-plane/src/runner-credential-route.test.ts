import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunnerMetadata } from "@wollipog/protocol";
import Fastify from "fastify";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import { registerRunnerCredentialRoutes } from "./runner-credential-route.js";

function principal(role: HumanPrincipal["role"] = "owner", organizationId = PERSONAL_ORGANIZATION_ID): HumanPrincipal {
  return {
    kind: "human",
    actorId: LOCAL_OWNER_USER_ID,
    userId: LOCAL_OWNER_USER_ID,
    userName: "Owner",
    organizationId,
    organizationName: organizationId,
    role,
    deviceId: null,
    localBootstrap: true,
  };
}

async function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  const closed: string[] = [];
  const app = Fastify();
  registerRunnerCredentialRoutes(app, {
    db,
    hub: { closeRunner: (runnerId: string) => { closed.push(runnerId); return true; } } as Hub,
    requestHuman: (req) => {
      const role = req.headers["x-test-role"];
      const org = req.headers["x-test-org"];
      return principal(
        role === "operator" || role === "viewer" ? role : "owner",
        typeof org === "string" ? org : PERSONAL_ORGANIZATION_ID,
      );
    },
  });
  await app.ready();
  return { app, db, closed };
}

const registeredRunner = (runnerId: string): RunnerMetadata => ({
  runnerId,
  hostname: "legacy-host",
  os: "linux",
  version: "1.0.0",
  agents: [],
  workspaces: [],
});

test("credential route issues one-time no-store secrets, lists metadata, rotates, and revokes", async () => {
  const { app, db, closed } = await fixture();
  try {
    const issued = await app.inject({
      method: "POST",
      url: "/api/runner-credentials",
      payload: { runnerId: "runner-1", label: "Studio runner" },
    });
    assert.equal(issued.statusCode, 201);
    assert.equal(issued.headers["cache-control"], "private, no-store");
    assert.equal(issued.headers.pragma, "no-cache");
    assert.equal(issued.headers.vary, "Authorization");
    const initial = issued.json();
    assert.match(initial.token, /^wollipogr_[A-Za-z0-9_-]{43}$/u);
    assert.equal(initial.credential.runnerId, "runner-1");
    assert.equal(initial.credential.status, "pending");

    const duplicate = await app.inject({ method: "POST", url: "/api/runner-credentials", payload: { runnerId: "runner-1" } });
    assert.equal(duplicate.statusCode, 201, "lost pending plaintext can be safely replaced before first registration");
    const duplicateSecret = duplicate.json();
    assert.match(duplicateSecret.token, /^wollipogr_[A-Za-z0-9_-]{43}$/u);
    assert.notEqual(duplicateSecret.token, initial.token);
    assert.equal(duplicate.body.includes(initial.token), false);

    const rotated = await app.inject({ method: "POST", url: "/api/runner-credentials/runner-1/rotate", payload: {} });
    assert.equal(rotated.statusCode, 200);
    assert.equal(rotated.headers["cache-control"], "private, no-store");
    const rotatedSecret = rotated.json();
    assert.match(rotatedSecret.token, /^wollipogr_[A-Za-z0-9_-]{43}$/u);
    assert.notEqual(rotatedSecret.token, initial.token);

    const listed = await app.inject({ method: "GET", url: "/api/runner-credentials" });
    assert.equal(listed.statusCode, 200);
    for (const token of [initial.token, duplicateSecret.token, rotatedSecret.token]) {
      assert.equal(listed.body.includes(token), false);
    }
    assert.equal(listed.body.includes("mamr_"), false);
    assert.equal(listed.body.includes("wollipogr_"), false);
    assert.deepEqual(listed.json().credentials.map((item: { status: string }) => item.status), [
      "pending",
      "revoked",
      "revoked",
    ]);

    const revoked = await app.inject({ method: "DELETE", url: "/api/runner-credentials/runner-1" });
    assert.equal(revoked.statusCode, 204);
    assert.deepEqual(closed, ["runner-1"]);
    assert.equal(db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID)[0]?.status, "revoked");
  } finally {
    await app.close();
    db.close();
  }
});

test("credential routes require owner/admin and hide cross-organization runner existence", async () => {
  const { app, db } = await fixture();
  try {
    await app.inject({ method: "POST", url: "/api/runner-credentials", payload: { runnerId: "runner-secret" } });
    const credentialsBeforeDeniedMutations = db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID);
    const operator = await app.inject({
      method: "GET",
      url: "/api/runner-credentials",
      headers: { "x-test-role": "operator" },
    });
    assert.equal(operator.statusCode, 403);

    for (const request of [
      { method: "POST" as const, url: "/api/runner-credentials", payload: { runnerId: "runner-denied" } },
      { method: "POST" as const, url: "/api/runner-credentials/runner-secret/rotate", payload: {} },
      { method: "DELETE" as const, url: "/api/runner-credentials/runner-secret" },
    ]) {
      const response = await app.inject({ ...request, headers: { "x-test-role": "operator" } });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { error: "organization owner or admin permission is required" });
      assert.deepEqual(db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID), credentialsBeforeDeniedMutations,
        "denied credential mutations must leave credential rows unchanged");
    }

    for (const request of [
      { method: "POST" as const, url: "/api/runner-credentials", payload: { runnerId: "runner-secret" } },
      { method: "POST" as const, url: "/api/runner-credentials/runner-secret/rotate", payload: {} },
      { method: "DELETE" as const, url: "/api/runner-credentials/runner-secret" },
    ]) {
      const response = await app.inject({ ...request, headers: { "x-test-org": "org_other" } });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "runner not found" });
    }
  } finally {
    await app.close();
    db.close();
  }
});

test("a registered runner without credentials can complete fail-closed fleet migration", async () => {
  const { app, db } = await fixture();
  try {
    db.registerRunner(registeredRunner("legacy-runner"), 100, 53);
    assert.equal(db.activeRunnerCredential("legacy-runner"), null);

    const hidden = await app.inject({
      method: "POST",
      url: "/api/runner-credentials",
      headers: { "x-test-org": "org_other" },
      payload: { runnerId: "legacy-runner" },
    });
    assert.equal(hidden.statusCode, 404, "preserved runner ownership cannot be claimed cross-organization");

    const issued = await app.inject({
      method: "POST",
      url: "/api/runner-credentials",
      payload: { runnerId: "legacy-runner", label: "Migration credential" },
    });
    assert.equal(issued.statusCode, 201);
    const secret = issued.json();
    assert.equal(secret.credential.runnerId, "legacy-runner");
    assert.equal(
      db.registerRunnerWithCredential(registeredRunner("legacy-runner"), hashToken(secret.token), 200, 53)?.activated,
      true,
    );

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/runner-credentials",
      payload: { runnerId: "legacy-runner" },
    });
    assert.equal(duplicate.statusCode, 409, "an active migrated runner must rotate instead");
  } finally {
    await app.close();
    db.close();
  }
});

test("invalid runner ids are rejected before any secret is minted", async () => {
  const { app, db } = await fixture();
  try {
    for (const runnerId of ["", " runner", "runner/id", "runner?id"]) {
      const response = await app.inject({ method: "POST", url: "/api/runner-credentials", payload: { runnerId } });
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.includes("mamr_"), false);
      assert.equal(response.body.includes("wollipogr_"), false);
    }
    assert.deepEqual(db.listRunnerCredentials(PERSONAL_ORGANIZATION_ID), []);
  } finally {
    await app.close();
    db.close();
  }
});
