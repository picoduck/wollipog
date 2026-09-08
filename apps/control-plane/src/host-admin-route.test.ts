import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type HostAdminStatusView } from "@wollipog/protocol";
import Fastify, { type FastifyRequest } from "fastify";
import { registerAuthGate } from "./http-auth.js";
import { HOST_ADMIN_FORBIDDEN, hostAdminStatus, registerHostAdminRoute, type HostAdminRouteDeps } from "./host-admin-route.js";
import { isLoopback } from "./net.js";

const BOOTSTRAP = "local-bootstrap-token";
const DEVICE = "paired-device-token";

function fixture(root: string, overrides: Partial<HostAdminRouteDeps> = {}): HostAdminRouteDeps {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = join(dataDir, "control-plane.db");
  writeFileSync(databasePath, "", { mode: 0o600 });
  const credentialPath = `${databasePath}.local-device-token`;
  writeFileSync(credentialPath, "x".repeat(43) + "\n", { mode: 0o600 });
  const artifactStorePath = join(dataDir, "artifacts");
  mkdirSync(artifactStorePath, { recursive: true, mode: 0o700 });
  return {
    localBootstrapPrincipal: (req: FastifyRequest) =>
      isLoopback(req.ip) && !req.headers["x-forwarded-for"] && req.headers.authorization === `Bearer ${BOOTSTRAP}`
        ? { userId: "local" }
        : null,
    startedAt: 1_000,
    bind: { host: "127.0.0.1", port: 4317, tailnetOnly: false },
    publicOrigin: null,
    publicOriginWarning: null,
    webServed: () => true,
    pairingHosts: () => [],
    databasePath,
    artifactStorePath,
    localCredentialPath: credentialPath,
    runners: () => [{ runnerId: "dev-box", status: "online", version: "0.22.0", protocolVersion: PROTOCOL_VERSION }],
    pairedDeviceCount: () => 2,
    now: () => 61_000,
    ...overrides,
  };
}

async function buildApp(deps: HostAdminRouteDeps) {
  const app = Fastify();
  registerAuthGate(app, {
    authenticate: (req: FastifyRequest) => {
      const bearer = req.headers.authorization;
      if (bearer === `Bearer ${DEVICE}`) return { id: "dev_remote", name: "Remote Device" };
      if (bearer === `Bearer ${BOOTSTRAP}` && isLoopback(req.ip)) return { id: "local", name: "Local" };
      return null;
    },
    isAllowedOrigin: () => true,
  });
  registerHostAdminRoute(app, deps);
  await app.ready();
  return app;
}

test("GET /api/admin/status is refused remotely, through proxies, and for ordinary paired devices", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-admin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = await buildApp(fixture(root));
  t.after(() => app.close());

  const remoteBootstrap = await app.inject({
    method: "GET", url: "/api/admin/status", remoteAddress: "100.64.0.10",
    headers: { authorization: `Bearer ${BOOTSTRAP}` },
  });
  assert.equal(remoteBootstrap.statusCode, 401);

  const proxied = await app.inject({
    method: "GET", url: "/api/admin/status", remoteAddress: "127.0.0.1",
    headers: { authorization: `Bearer ${BOOTSTRAP}`, "x-forwarded-for": "100.64.0.10" },
  });
  assert.equal(proxied.statusCode, 403);
  assert.equal(proxied.json().error, HOST_ADMIN_FORBIDDEN);

  const pairedOnLoopback = await app.inject({
    method: "GET", url: "/api/admin/status", remoteAddress: "127.0.0.1",
    headers: { authorization: `Bearer ${DEVICE}` },
  });
  assert.equal(pairedOnLoopback.statusCode, 403);
  assert.equal(pairedOnLoopback.json().error, HOST_ADMIN_FORBIDDEN);
});

test("GET /api/admin/status returns operational facts for the loopback bootstrap credential without secrets", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-admin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deps = fixture(root);
  const app = await buildApp(deps);
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET", url: "/api/admin/status", remoteAddress: "127.0.0.1",
    headers: { authorization: `Bearer ${BOOTSTRAP}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const status = response.json<HostAdminStatusView>();
  assert.equal(status.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(status.health, { ok: true, startedAt: 1_000, uptimeMs: 60_000 });
  assert.deepEqual(status.bind, { host: "127.0.0.1", port: 4317, mode: "loopback", tailnetOnly: false, boundBeyondLoopback: false });
  assert.equal(status.database.ready, true);
  assert.equal(status.artifactStore.ready, true);
  assert.deepEqual(status.localCredential, { path: deps.localCredentialPath, safe: true, issues: [] });
  assert.deepEqual(status.runners, {
    registered: 1, online: 1,
    items: [{ runnerId: "dev-box", status: "online", version: "0.22.0", protocolVersion: PROTOCOL_VERSION }],
  });
  assert.deepEqual(status.devices, { paired: 2 });
  assert.deepEqual(status.warnings, []);
  assert.ok(!JSON.stringify(status).includes("x".repeat(43)), "credential contents never leave the host");
});

test("hostAdminStatus surfaces bind, origin, credential, store, and runner mismatch warnings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-admin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deps = fixture(root, {
    bind: { host: "0.0.0.0", port: 4317, tailnetOnly: false },
    publicOrigin: "http://100.64.0.10:4317",
    publicOriginWarning: "plain HTTP warning",
    webServed: () => false,
    pairingHosts: () => ["100.64.0.10"],
    artifactStorePath: join(root, "missing-artifacts"),
    runners: () => [{ runnerId: "old-box", status: "offline", version: "0.21.0", protocolVersion: PROTOCOL_VERSION - 1 }],
  });
  chmodSync(deps.localCredentialPath, 0o644);
  const status = hostAdminStatus(deps);
  assert.equal(status.bind.mode, "wildcard");
  assert.equal(status.bind.boundBeyondLoopback, true);
  assert.equal(status.localCredential.safe, process.platform === "win32");
  assert.equal(status.artifactStore.ready, false);
  assert.equal(status.runners.online, 0);
  const text = status.warnings.join("\n");
  assert.match(text, /plain HTTP warning/u);
  assert.match(text, /no built web dashboard bundle/u);
  assert.match(text, /artifact store is not a writable directory/u);
  assert.match(text, /no registered runner is online/u);
  assert.match(text, new RegExp(`old-box speaks protocol v${PROTOCOL_VERSION - 1}`, "u"));
  if (process.platform !== "win32") assert.match(text, /local credential file is unsafe: credential file mode 0644/u);
});
