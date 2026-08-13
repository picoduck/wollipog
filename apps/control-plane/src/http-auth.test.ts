import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { extractBearer } from "./auth.js";
import { isApiRoute, isPublicTranscriptShareRead, registerAuthGate } from "./http-auth.js";
import { isAllowedOrigin } from "./net.js";
import { mutationAuthorizationError, type HumanPrincipal } from "./identity.js";

const VALID = "valid-device-token";

/**
 * A miniature control plane wired with the REAL gate, the REAL loopback/origin policies, and a
 * fake device lookup. Includes a wildcard route standing in for @fastify/static, so the
 * "explicit /api routes beat the wildcard" invariant is exercised by Fastify's actual router.
 */
async function buildTestApp(onAuthorize?: () => void): Promise<FastifyInstance> {
  const app = Fastify();
  const authenticate = (req: FastifyRequest, allowQueryToken = false) => {
    let token = extractBearer(req.headers.authorization);
    if (!token && allowQueryToken && req.url.includes("?")) {
      token = new URLSearchParams(req.url.slice(req.url.indexOf("?") + 1)).get("token");
    }
    return token === VALID ? { id: "dev_1", name: "Phone" } : null;
  };
  registerAuthGate(app, {
    authenticate,
    isAllowedOrigin,
    ...(onAuthorize ? {
      authorize: () => {
        onAuthorize();
        return null;
      },
    } : {}),
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/runners", async () => ({ runners: [] }));
  app.get("/api/public/transcript-share", async () => ({ shared: true }));
  app.get("/api/public/transcript-share/extra", async () => ({ shared: false }));
  app.post("/api/public/transcript-share", async () => ({ mutated: true }));
  app.post("/api/sessions/:id/stop", async () => ({ stopped: true }));
  app.get("/runner", async () => ({ runner: true }));
  // Stand-in for @fastify/static's catch-all.
  app.get("/*", async () => "<html>app shell</html>");
  await app.ready();
  return app;
}

const REMOTE = "10.0.0.5";
const LOCAL = "127.0.0.1";

test("loopback API calls require the same bearer credential as every other client", async (t) => {
  const app = await buildTestApp();
  t.after(() => app.close());
  const anonymous = await app.inject({ method: "GET", url: "/api/runners", remoteAddress: LOCAL });
  assert.equal(anonymous.statusCode, 401);
  const authenticated = await app.inject({
    method: "GET",
    url: "/api/runners",
    remoteAddress: LOCAL,
    headers: { authorization: `Bearer ${VALID}` },
  });
  assert.equal(authenticated.statusCode, 200);
});

test("non-loopback /api/* requires a valid bearer token", async (t) => {
  const app = await buildTestApp();
  t.after(() => app.close());

  const anon = await app.inject({ method: "GET", url: "/api/runners", remoteAddress: REMOTE });
  assert.equal(anon.statusCode, 401);

  const bad = await app.inject({
    method: "GET",
    url: "/api/runners",
    remoteAddress: REMOTE,
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(bad.statusCode, 401);

  const good = await app.inject({
    method: "GET",
    url: "/api/runners",
    remoteAddress: REMOTE,
    headers: { authorization: `Bearer ${VALID}` },
  });
  assert.equal(good.statusCode, 200);
});

test("only the exact public transcript GET bypasses device auth", async (t) => {
  const app = await buildTestApp();
  t.after(() => app.close());

  const shared = await app.inject({
    method: "GET",
    url: "/api/public/transcript-share",
    remoteAddress: REMOTE,
    headers: { authorization: `MAM-Share ${"x".repeat(43)}` },
  });
  assert.equal(shared.statusCode, 200);
  assert.deepEqual(shared.json(), { shared: true });
  assert.equal((await app.inject({
    method: "GET",
    url: "/api/public/transcript-share",
    remoteAddress: REMOTE,
    headers: { authorization: `Wollipog-Share ${"x".repeat(43)}` },
  })).statusCode, 200);
  assert.equal((await app.inject({ method: "HEAD", url: "/api/public/transcript-share", remoteAddress: REMOTE })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/public/transcript-share", remoteAddress: REMOTE })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/public/transcript-share/extra", remoteAddress: REMOTE })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/runners", remoteAddress: REMOTE,
    headers: { authorization: `MAM-Share ${"x".repeat(43)}` } })).statusCode, 401,
    "a share capability is never a device Bearer token");
  assert.equal((await app.inject({ method: "GET", url: "/api/runners", remoteAddress: REMOTE,
    headers: { authorization: `Wollipog-Share ${"x".repeat(43)}` } })).statusCode, 401,
    "a Wollipog share capability is never a device Bearer token");

  const foreign = await app.inject({ method: "GET", url: "/api/public/transcript-share", remoteAddress: REMOTE,
    headers: { origin: "https://evil.example", authorization: `MAM-Share ${"x".repeat(43)}` } });
  assert.equal(foreign.statusCode, 403, "the existing Origin boundary remains in force");
});

test("public transcript exemption is canonical, exact, and GET-only", () => {
  assert.equal(isPublicTranscriptShareRead("GET", "/api/public/transcript-share"), true);
  assert.equal(isPublicTranscriptShareRead("HEAD", "/api/public/transcript-share"), false);
  assert.equal(isPublicTranscriptShareRead("POST", "/api/public/transcript-share"), false);
  assert.equal(isPublicTranscriptShareRead("GET", "/api/public/transcript-share/:id"), false);
  assert.equal(isPublicTranscriptShareRead("GET", "/api/public/transcript-share/extra"), false);
});

// The round-1 P0. Fastify percent-decodes before routing, so `/%61pi/...` reaches the /api
// handler; a raw-URL prefix check in the gate would have skipped auth entirely.
test("REGRESSION (P0): a percent-encoded /api path cannot bypass device auth", async (t) => {
  const app = await buildTestApp();
  t.after(() => app.close());

  const encoded = await app.inject({ method: "GET", url: "/%61pi/runners", remoteAddress: REMOTE });
  assert.equal(encoded.statusCode, 401, "encoded /api must be gated exactly like /api");

  // ...and it still WORKS with a token (proving it really does reach the /api handler).
  const authed = await app.inject({
    method: "GET",
    url: "/%61pi/runners",
    remoteAddress: REMOTE,
    headers: { authorization: `Bearer ${VALID}` },
  });
  assert.equal(authed.statusCode, 200);
  assert.deepEqual(authed.json(), { runners: [] });

  // A mutating route via the same trick is gated too.
  const mutate = await app.inject({ method: "POST", url: "/%61pi/sessions/s1/stop", remoteAddress: REMOTE });
  assert.equal(mutate.statusCode, 401);
});

test("a static wildcard match never reaches a gated route (explicit routes win)", async (t) => {
  const app = await buildTestApp();
  t.after(() => app.close());

  // The wildcard serves the public shell to anyone — that's intended.
  const shell = await app.inject({ method: "GET", url: "/some/client/route", remoteAddress: REMOTE });
  assert.equal(shell.statusCode, 200);

  // But a real API route still resolves to its explicit pattern and stays gated.
  const api = await app.inject({ method: "GET", url: "/api/runners", remoteAddress: REMOTE });
  assert.equal(api.statusCode, 401);
});

test("loopback Origin never substitutes for a credential and bearer possession remains authoritative", async (t) => {
  let authorized = 0;
  const app = await buildTestApp(() => { authorized += 1; });
  t.after(() => app.close());

  // @fastify/cors would not have stopped this no-cors POST from reaching the handler.
  const evil = await app.inject({
    method: "POST",
    url: "/api/sessions/s1/stop",
    remoteAddress: LOCAL,
    headers: { origin: "http://evil.example" },
  });
  assert.equal(evil.statusCode, 401);
  assert.equal(authorized, 0, "a rejected Origin never reaches principal capture/audit attribution");

  // The local dashboard's own origin still needs its startup credential.
  const dash = await app.inject({
    method: "POST",
    url: "/api/sessions/s1/stop",
    remoteAddress: LOCAL,
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(dash.statusCode, 401);
  assert.equal(authorized, 0);

  // Non-browser clients send no Origin.
  const curl = await app.inject({ method: "POST", url: "/api/sessions/s1/stop", remoteAddress: LOCAL });
  assert.equal(curl.statusCode, 401);

  // A paired device isn't a CSRF vector: possession beats Origin.
  const paired = await app.inject({
    method: "POST",
    url: "/api/sessions/s1/stop",
    remoteAddress: LOCAL,
    headers: { origin: "http://evil.example", authorization: `Bearer ${VALID}` },
  });
  assert.equal(paired.statusCode, 200);
  assert.equal(authorized, 1);
});

test("REST rejects a query token; only /ui may carry ?token=", async (t) => {
  const app = await buildTestApp();
  t.after(() => app.close());
  // A token in the REST query string must not authenticate (it would leak into logs/history).
  const res = await app.inject({ method: "GET", url: `/api/runners?token=${VALID}`, remoteAddress: REMOTE });
  assert.equal(res.statusCode, 401);
});

test("a reverse proxy cannot impersonate the local dashboard", async (t) => {
  const app = await buildTestApp();
  t.after(() => app.close());
  // Peer IP is loopback (the proxy), but the forwarding header reveals a remote client.
  const res = await app.inject({
    method: "GET",
    url: "/api/runners",
    remoteAddress: LOCAL,
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  assert.equal(res.statusCode, 401);
});

test("exempt routes stay open: /healthz and /runner (own token) need no device", async (t) => {
  const app = await buildTestApp();
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: "/healthz", remoteAddress: REMOTE })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/runner", remoteAddress: REMOTE })).statusCode, 200);
});

// Fastify auto-registers HEAD for GET routes; the gate must cover it, or `HEAD /api/...` would
// confirm resource existence to an unauthenticated remote caller.
test("HEAD is gated exactly like GET", async (t) => {
  const app = await buildTestApp();
  t.after(() => app.close());

  assert.equal((await app.inject({ method: "HEAD", url: "/api/runners", remoteAddress: REMOTE })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "HEAD",
        url: "/api/runners",
        remoteAddress: REMOTE,
        headers: { authorization: `Bearer ${VALID}` },
      })
    ).statusCode,
    200,
  );
  assert.equal((await app.inject({ method: "HEAD", url: "/api/runners", remoteAddress: LOCAL })).statusCode, 401);
});

test("isApiRoute matches the collection and its children, not a lookalike", () => {
  assert.equal(isApiRoute("/api"), true);
  assert.equal(isApiRoute("/api/sessions/:id/stop"), true);
  assert.equal(isApiRoute("/apix"), false);
  assert.equal(isApiRoute("/*"), false);
});

test("role authorization runs after body parsing and blocks viewer mutations", async (t) => {
  const app = Fastify();
  const makePrincipal = (role: HumanPrincipal["role"]): HumanPrincipal => ({
    kind: "human", actorId: `user-${role}`, userId: `user-${role}`, userName: role,
    organizationId: "org", organizationName: "Org", role, deviceId: `dev-${role}`, localBootstrap: false,
  });
  const authenticate = (req: FastifyRequest) => {
    const role = extractBearer(req.headers.authorization);
    if (role !== "viewer" && role !== "operator") return null;
    return { id: `dev-${role}`, name: role, principal: makePrincipal(role) };
  };
  registerAuthGate(app, {
    authenticate,
    isAllowedOrigin,
    authorize: (req, authed) => {
      assert.deepEqual(req.body, { value: 1 }, "authorization must run after JSON parsing");
      return mutationAuthorizationError(req.method, req.routeOptions.url, authed?.principal ?? null);
    },
  });
  app.post("/api/resource", async () => ({ ok: true }));
  await app.ready();
  t.after(() => app.close());

  const viewer = await app.inject({
    method: "POST", url: "/api/resource", remoteAddress: REMOTE,
    headers: { authorization: "Bearer viewer", "content-type": "application/json" }, body: { value: 1 },
  });
  assert.equal(viewer.statusCode, 403);
  const operator = await app.inject({
    method: "POST", url: "/api/resource", remoteAddress: REMOTE,
    headers: { authorization: "Bearer operator", "content-type": "application/json" }, body: { value: 1 },
  });
  assert.equal(operator.statusCode, 200);
});
