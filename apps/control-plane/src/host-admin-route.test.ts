import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type HostAdminDoctorView, type HostAdminStatusView } from "@wollipog/protocol";
import Fastify, { type FastifyRequest } from "fastify";
import { registerAuthGate } from "./http-auth.js";
import { HOST_ADMIN_FORBIDDEN, hostAdminDoctor, hostAdminStatus, probePublicOriginWithFetch, registerHostAdminRoute, type HostAdminRouteDeps } from "./host-admin-route.js";
import { APP_RELEASE_VERSION } from "./release-version.js";
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

test("GET /api/admin/doctor shares the bootstrap-only boundary and reports passing checks for a healthy host", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-admin-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deps = fixture(root, {
    publicOrigin: "https://box.example.ts.net",
    doctor: {
      probePublicOrigin: async () => ({ reachable: true, service: "wollipog-control-plane", detail: "answered" }),
      legacyRunnerCredentials: () => 0,
      defaultLegacyToken: false,
      tailnetAddresses: () => ["100.64.0.5"],
    },
  });
  const app = await buildApp(deps);
  t.after(() => app.close());
  const paired = await app.inject({ method: "GET", url: "/api/admin/doctor", remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${DEVICE}` } });
  assert.equal(paired.statusCode, 403);
  const response = await app.inject({ method: "GET", url: "/api/admin/doctor", remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${BOOTSTRAP}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const doctor = response.json<HostAdminDoctorView>();
  assert.equal(doctor.ok, true);
  assert.deepEqual(doctor.checks.map((c) => `${c.id}:${c.status}`), [
    "control-plane:pass", "database:pass", "artifact-store:pass", "local-credential:pass", "dashboard-bundle:pass",
    "exposure:pass", "public-origin:pass", "runners:pass", "legacy-credentials:pass", "devices:pass",
  ]);
  assert.equal(doctor.status.protocolVersion, PROTOCOL_VERSION);
  assert.ok(!JSON.stringify(doctor).includes("x".repeat(43)), "no credential contents");
});

test("hostAdminDoctor turns exposure, reachability, credential, and skew problems into warn/fail with remedies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-admin-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = fixture(root, {
    bind: { host: "0.0.0.0", port: 4317, tailnetOnly: false },
    publicOrigin: "http://100.64.0.10:4317",
    publicOriginWarning: "plain HTTP warning",
    webServed: () => false,
    pairingHosts: () => ["100.64.0.10"],
    runners: () => [
      { runnerId: "old-box", status: "offline", version: "0.21.0", protocolVersion: PROTOCOL_VERSION - 1 },
      { runnerId: "new-box", status: "online", version: APP_RELEASE_VERSION, protocolVersion: PROTOCOL_VERSION },
    ],
    pairedDeviceCount: () => 0,
    doctor: {
      probePublicOrigin: async () => ({ reachable: true, service: "nginx", detail: "answered as nginx" }),
      legacyRunnerCredentials: () => 2,
      defaultLegacyToken: true,
      tailnetAddresses: () => [],
    },
  });
  chmodSync(base.localCredentialPath, 0o644);
  const doctor = await hostAdminDoctor(base);
  const byId = Object.fromEntries(doctor.checks.map((c) => [c.id, c]));
  assert.equal(doctor.ok, false);
  if (process.platform !== "win32") assert.equal(byId["local-credential"]!.status, "fail");
  assert.equal(byId["dashboard-bundle"]!.status, "warn");
  assert.equal(byId.exposure!.status, "warn");
  assert.match(byId.exposure!.detail ?? "", /plain HTTP warning/u);
  assert.equal(byId["public-origin"]!.status, "fail", "a different service answering at the public origin is a misconfiguration");
  assert.equal(byId.runners!.status, "pass");
  assert.equal(byId["runner-protocol:old-box"]!.status, "warn");
  assert.equal(byId["runner-version:old-box"]!.status, "warn");
  assert.equal(byId["runner-version:new-box"], undefined);
  assert.equal(byId["legacy-credentials"]!.status, "fail", "default token derived credentials beyond loopback");
  assert.match(byId["legacy-credentials"]!.remedy ?? "", /runner-credential rotate/u);
  assert.match(byId.devices!.detail ?? "", /admin device create/u);
  for (const item of doctor.checks) if (item.status !== "pass") assert.ok(item.remedy, `${item.id} needs a remedy`);
  chmodSync(base.localCredentialPath, 0o600);

  const tailnet = await hostAdminDoctor(fixture(root, {
    bind: { host: "0.0.0.0", port: 4317, tailnetOnly: true },
    doctor: { probePublicOrigin: async () => ({ reachable: false, service: null, detail: "ECONNREFUSED" }), legacyRunnerCredentials: () => 1, defaultLegacyToken: true, tailnetAddresses: () => [] },
  }));
  const tailnetById = Object.fromEntries(tailnet.checks.map((c) => [c.id, c]));
  assert.equal(tailnetById.exposure!.status, "fail");
  assert.match(tailnetById.exposure!.summary, /no Tailscale IPv4 address/u);
  assert.equal(tailnetById["legacy-credentials"]!.status, "fail");

  const unreachable = await hostAdminDoctor(fixture(root, {
    publicOrigin: "https://box.example.ts.net",
    doctor: { probePublicOrigin: async () => ({ reachable: false, service: null, detail: "ENOTFOUND" }), legacyRunnerCredentials: () => 0, defaultLegacyToken: false, tailnetAddresses: () => ["100.64.0.5"] },
  }));
  const unreachableById = Object.fromEntries(unreachable.checks.map((c) => [c.id, c]));
  assert.equal(unreachableById["public-origin"]!.status, "warn", "a host may not reach its own tailnet name; warn, not fail");
  assert.match(unreachableById["public-origin"]!.detail ?? "", /ENOTFOUND/u);
  assert.equal(unreachable.ok, true);
});

test("probePublicOriginWithFetch classifies health answers without throwing", async () => {
  const ok = await probePublicOriginWithFetch("https://box.example/", (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, service: "wollipog-control-plane" }) })) as unknown as typeof fetch);
  assert.deepEqual(ok, { reachable: true, service: "wollipog-control-plane", detail: "answered as wollipog-control-plane" });
  const html = await probePublicOriginWithFetch("https://box.example", (async () => ({ ok: true, status: 200, text: async () => "<html>" })) as unknown as typeof fetch);
  assert.equal(html.service, null);
  const down = await probePublicOriginWithFetch("https://box.example", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
  assert.deepEqual(down, { reachable: false, service: null, detail: "ECONNREFUSED" });
  const denied = await probePublicOriginWithFetch("https://box.example", (async () => ({ ok: false, status: 502, text: async () => "" })) as unknown as typeof fetch);
  assert.deepEqual(denied, { reachable: true, service: null, detail: "HTTP 502" });
});
