import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  EXIT_RISK_REQUEST_DOMAIN,
  EXIT_RISK_RESPONSE_DOMAIN,
  PROVISION_REQUEST_DOMAIN,
  PROVISION_RESPONSE_DOMAIN,
  managedDesktopMac,
  type ManagedDesktopIdentity,
} from "./managed-desktop-auth.js";
import {
  MANAGED_CHALLENGE_HEADER,
  MANAGED_EXIT_RISK_PATH,
  MANAGED_LAUNCH_ID_HEADER,
  MANAGED_PROVISION_PATH,
  MANAGED_REQUEST_MAC_HEADER,
  MANAGED_RESPONSE_MAC_HEADER,
  managedDesktopSessionsForRunner,
  registerManagedDesktopRoutes,
} from "./managed-desktop-routes.js";

const identity: ManagedDesktopIdentity = {
  launchId: "0123456789abcdef0123456789abcdef",
  secret: Buffer.from(["AAECAwQFBgcICQoLDA0OD", "xAREhMUFRYXGBkaGxwdHh8"].join(""), "base64url"),
};
const challenge = Buffer.from("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8", "base64url");
const runnerId = "this-machine-2f5a7c9d";

function headers(domain = EXIT_RISK_REQUEST_DOMAIN) {
  return {
    [MANAGED_LAUNCH_ID_HEADER]: identity.launchId,
    [MANAGED_CHALLENGE_HEADER]: challenge.toString("base64url"),
    [MANAGED_REQUEST_MAC_HEADER]: managedDesktopMac(identity, domain, challenge, runnerId),
  };
}

test("no launch environment means both desktop-private routes are absent", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerManagedDesktopRoutes(app, null, {
    trustedLoopback: () => true,
    sessionsForRunner: () => [],
    provisionRunner: () => ({}),
  });
  assert.equal((await app.inject({ method: "POST", url: MANAGED_EXIT_RISK_PATH })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: MANAGED_PROVISION_PATH })).statusCode, 404);
});

test("the managed projection requests archived sessions and keeps an archived running side chat", () => {
  const calls: Array<{ includeArchived: true }> = [];
  const sessions = managedDesktopSessionsForRunner((options) => {
    calls.push(options);
    return [
      { runnerId, status: "running", pendingApproval: null, archivedAt: 123 },
      { runnerId: "another-runner", status: "running", pendingApproval: null, archivedAt: 456 },
    ];
  }, runnerId);
  assert.deepEqual(calls, [{ includeArchived: true }]);
  assert.deepEqual(sessions, [{ runnerId, status: "running", pendingApproval: null }]);
});

test("exit-risk is loopback-only, rejects Bearer and wrong proofs, and signs exact response bytes", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerManagedDesktopRoutes(app, identity, {
    trustedLoopback: (req) => req.ip === "127.0.0.1",
    sessionsForRunner: (id) => [{
      runnerId: id,
      status: "running",
      pendingApproval: null,
    }],
    provisionRunner: () => ({ token: "not-used" }),
  });

  const good = await app.inject({
    method: "POST",
    url: MANAGED_EXIT_RISK_PATH,
    remoteAddress: "127.0.0.1",
    headers: headers(),
    payload: { runnerId },
  });
  assert.equal(good.statusCode, 200);
  assert.equal(
    good.headers[MANAGED_RESPONSE_MAC_HEADER],
    managedDesktopMac(identity, EXIT_RISK_RESPONSE_DOMAIN, challenge, good.rawPayload),
  );
  assert.deepEqual(good.json(), {
    sessions: [{ runnerId, status: "running", pendingApproval: null }],
  });

  const remote = await app.inject({
    method: "POST", url: MANAGED_EXIT_RISK_PATH, remoteAddress: "100.64.0.5",
    headers: headers(), payload: { runnerId },
  });
  assert.equal(remote.statusCode, 401);
  const bearer = await app.inject({
    method: "POST", url: MANAGED_EXIT_RISK_PATH, remoteAddress: "127.0.0.1",
    headers: { ...headers(), authorization: "Bearer owner-secret" }, payload: { runnerId },
  });
  assert.equal(bearer.statusCode, 401);
  const wrong = await app.inject({
    method: "POST", url: MANAGED_EXIT_RISK_PATH, remoteAddress: "127.0.0.1",
    headers: { ...headers(), [MANAGED_REQUEST_MAC_HEADER]: "A".repeat(43) }, payload: { runnerId },
  });
  assert.equal(wrong.statusCode, 401);
  const changedBody = await app.inject({
    method: "POST", url: MANAGED_EXIT_RISK_PATH, remoteAddress: "127.0.0.1",
    headers: headers(), payload: { runnerId, ownerToken: "must-not-be-accepted" },
  });
  assert.equal(changedBody.statusCode, 401);
});

test("managed provisioning uses its own proof domain and never needs an owner token", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const provisioned: string[] = [];
  registerManagedDesktopRoutes(app, identity, {
    trustedLoopback: (req) => req.ip === "127.0.0.1",
    sessionsForRunner: () => [],
    provisionRunner: (id) => {
      provisioned.push(id);
      return {
        credential: { owner: { kind: "organization", organizationId: "org-local" } },
        token: `wollipogr_${"a".repeat(43)}`,
      };
    },
  });
  const response = await app.inject({
    method: "POST",
    url: MANAGED_PROVISION_PATH,
    remoteAddress: "127.0.0.1",
    headers: headers(PROVISION_REQUEST_DOMAIN),
    payload: { runnerId },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(provisioned, [runnerId]);
  assert.equal(
    response.headers[MANAGED_RESPONSE_MAC_HEADER],
    managedDesktopMac(identity, PROVISION_RESPONSE_DOMAIN, challenge, response.rawPayload),
  );
  assert.equal(response.json().credential.owner.organizationId, "org-local");

  const bearer = await app.inject({
    method: "POST",
    url: MANAGED_PROVISION_PATH,
    remoteAddress: "127.0.0.1",
    headers: { ...headers(PROVISION_REQUEST_DOMAIN), authorization: "Bearer owner-secret" },
    payload: { runnerId },
  });
  assert.equal(bearer.statusCode, 401);
  assert.equal(bearer.headers[MANAGED_RESPONSE_MAC_HEADER], undefined);
  assert.deepEqual(provisioned, [runnerId], "Bearer must never reach managed provisioning");

  const crossDomainReplay = await app.inject({
    method: "POST",
    url: MANAGED_PROVISION_PATH,
    remoteAddress: "127.0.0.1",
    headers: headers(EXIT_RISK_REQUEST_DOMAIN),
    payload: { runnerId },
  });
  assert.equal(crossDomainReplay.statusCode, 401);
  assert.deepEqual(provisioned, [runnerId]);
});

test("expected authenticated provisioning conflicts return a signed stable error", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let provisioningError = "runner belongs to another organization";
  registerManagedDesktopRoutes(app, identity, {
    trustedLoopback: (req) => req.ip === "127.0.0.1",
    sessionsForRunner: () => [],
    provisionRunner: () => {
      throw new Error(provisioningError);
    },
  });

  for (provisioningError of [
    "runner belongs to another organization",
    "runner belongs to another owner",
    "runner id is reserved by another owner",
  ]) {
    const response = await app.inject({
      method: "POST",
      url: MANAGED_PROVISION_PATH,
      remoteAddress: "127.0.0.1",
      headers: headers(PROVISION_REQUEST_DOMAIN),
      payload: { runnerId },
    });
    assert.equal(response.statusCode, 404, provisioningError);
    assert.deepEqual(response.json(), { error: "runner not found" });
    assert.equal(
      response.headers[MANAGED_RESPONSE_MAC_HEADER],
      managedDesktopMac(identity, PROVISION_RESPONSE_DOMAIN, challenge, response.rawPayload),
    );
  }

  const unauthorized = await app.inject({
    method: "POST",
    url: MANAGED_PROVISION_PATH,
    remoteAddress: "127.0.0.1",
    headers: { ...headers(PROVISION_REQUEST_DOMAIN), [MANAGED_REQUEST_MAC_HEADER]: "A".repeat(43) },
    payload: { runnerId },
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.headers[MANAGED_RESPONSE_MAC_HEADER], undefined);
});
