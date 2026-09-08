import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type HostAdminStatusView } from "@wollipog/protocol";
import type { McpFetch } from "./session-management-mcp.js";
import {
  formatStatus,
  isDesktopCleartextHost,
  isLoopbackHostname,
  isTailnetIpv4Literal,
  pairingLinkConsumers,
  readProtectedLocalToken,
  resolveLocalTokenPath,
  runHostAdminCli,
  writeProtectedSecretFile,
  type HostAdminIo,
} from "./host-admin-cli.js";
import { runWollipogCli } from "./wollipog-cli.js";

const TOKEN = "A".repeat(43);
const DEVICE_TOKEN = "device-secret-token-0123456789";
const RUNNER_TOKEN = "wollipogr_" + "r".repeat(43);

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-admin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const tokenFile = join(dataDir, "control-plane.db.local-device-token");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  return { root, dataDir, tokenFile };
}

function makeIo(overrides: Partial<HostAdminIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: HostAdminIo = {
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
    stdoutIsTTY: false,
    stdinIsTTY: false,
    confirm: async () => false,
    ...overrides,
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

function status(overrides: Partial<HostAdminStatusView> = {}): HostAdminStatusView {
  return {
    service: "wollipog-control-plane",
    appVersion: "0.22.0",
    protocolVersion: PROTOCOL_VERSION,
    apiVersion: 1,
    health: { ok: true, startedAt: 0, uptimeMs: 3_720_000 },
    bind: { host: "127.0.0.1", port: 4317, mode: "loopback", tailnetOnly: false, boundBeyondLoopback: false },
    publicOrigin: "https://wollipog.example.ts.net",
    dashboard: { webServed: true, pairingHosts: [] },
    database: { path: "/srv/wollipog/control-plane.db", ready: true },
    artifactStore: { path: "/srv/wollipog/control-plane.db.artifacts", ready: true },
    localCredential: { path: "/srv/wollipog/control-plane.db.local-device-token", safe: true, issues: [] },
    runners: { registered: 1, online: 1, items: [{ runnerId: "dev-box", status: "online", version: "0.22.0", protocolVersion: PROTOCOL_VERSION }] },
    devices: { paired: 2 },
    warnings: [],
    ...overrides,
  };
}

function server(options: {
  protocolVersion?: number;
  publicOrigin?: string | null;
  hosts?: string[];
  boundBeyondLoopback?: boolean;
  webServed?: boolean;
  revokeNewDeviceStatus?: number;
  mintedToken?: string;
  omitDevice?: boolean;
  runnerToken?: string;
  runnerRevokeStatus?: number;
} = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body });
    const respond = (statusCode: number, body: unknown) => ({
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    });
    if (init?.headers?.authorization !== `Bearer ${TOKEN}`) return respond(401, { error: "unauthorized" });
    const path = url.replace(/^https?:\/\/[^/]+/u, "");
    if (path === "/api/compatibility") return respond(200, { protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION });
    if (path === "/api/admin/status") return respond(200, status());
    if (path === "/api/identity") {
      return respond(200, { memberships: [
        { organizationId: "org_personal", organizationName: "Personal", userId: "usr_local", userName: "Local Owner", userStatus: "active", role: "owner", createdAt: 1_700_000_000_000 },
      ] });
    }
    if (path === "/api/devices" && init?.method === "GET") {
      return respond(200, { devices: [
        { deviceId: "dev_1", name: "Pixel 9", createdAt: 1_700_000_000_000, lastSeenAt: null, userId: "usr_local", userName: "Local Owner", organizationId: "org_personal", organizationName: "Personal", role: "owner" },
      ] });
    }
    if (path === "/api/devices" && init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as { name: string; userId?: string };
      return respond(201, {
        ...(options.omitDevice ? {} : { device: { deviceId: "dev_new", name: body.name, createdAt: 1, lastSeenAt: null, userId: body.userId ?? "usr_local", userName: "Local Owner", organizationId: "org_personal", organizationName: "Personal", role: "owner" } }),
        token: options.mintedToken ?? DEVICE_TOKEN,
        pairing: {
          hosts: options.hosts ?? [],
          port: 4317,
          webServed: options.webServed ?? true,
          boundBeyondLoopback: options.boundBeyondLoopback ?? false,
          publicOrigin: options.publicOrigin ?? null,
        },
      });
    }
    const credentialRow = (runnerId: string, status: string, label = "Runner credential") => ({
      credentialId: `rc_${runnerId}`, runnerId, organizationId: "org_personal",
      scope: { owner: { kind: "organization", organizationId: "org_personal" } }, label, status,
      createdAt: 1_700_000_000_000, expiresAt: status === "pending" ? 1_700_086_400_000 : null,
      activatedAt: status === "active" ? 1_700_000_060_000 : null, lastUsedAt: null, revokedAt: null, legacy: false,
    });
    if (path === "/api/runner-credentials" && init?.method === "GET") {
      return respond(200, { credentials: [credentialRow("dev-box", "active"), credentialRow("new-box", "pending", "Rack 2")] });
    }
    if (path === "/api/runner-credentials" && init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as { runnerId: string; label?: string };
      if (body.runnerId === "dev-box") return respond(409, { error: "registered runner already has an active credential; rotate it instead" });
      return respond(201, { credential: credentialRow(body.runnerId, "pending", body.label), token: options.runnerToken ?? RUNNER_TOKEN });
    }
    if (path === "/api/runner-credentials/dev-box/rotate" && init?.method === "POST") {
      return respond(200, { credential: credentialRow("dev-box", "pending"), token: options.runnerToken ?? RUNNER_TOKEN });
    }
    if (path.startsWith("/api/runner-credentials/") && init?.method === "DELETE") {
      const statusCode = options.runnerRevokeStatus ?? (path.endsWith("/ghost") ? 404 : 204);
      return respond(statusCode, statusCode === 204 ? undefined : { error: statusCode === 404 ? "runner not found" : "control plane restarting" });
    }
    if (path === "/api/devices/dev_1" && init?.method === "DELETE") return respond(204, undefined);
    if (path === "/api/devices/dev_new" && init?.method === "DELETE") {
      const statusCode = options.revokeNewDeviceStatus ?? 204;
      return respond(statusCode, statusCode === 204 ? undefined : { error: "control plane restarting" });
    }
    if (path.startsWith("/api/devices/") && init?.method === "DELETE") return respond(404, { error: "device not found" });
    return respond(404, { error: `unexpected ${path}` });
  };
  return { fetch, calls };
}

function env(tokenFile: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CONTROL_PLANE_LOCAL_TOKEN_FILE: tokenFile, ...extra };
}

const host = { platform: process.platform, uid: process.getuid?.() ?? null, cwd: () => "/nonexistent-cwd" };

test("admin pairing-url reprints the loopback recovery link offline from the protected credential", async (t) => {
  const { tokenFile } = fixture(t);
  const { fetch, calls } = server();
  const { io, stdout } = makeIo();
  assert.equal(await runHostAdminCli(["admin", "pairing-url"], env(tokenFile), io, fetch, host), 0);
  assert.equal(stdout(), `http://127.0.0.1:4317/#pair=${TOKEN}\n`);
  assert.equal(calls.length, 0, "recovery must not need a running control plane");

  const jsonIo = makeIo();
  assert.equal(await runHostAdminCli(["admin", "pairing-url", "--json"], env(tokenFile, { CONTROL_PLANE_PORT: "5000" }), jsonIo.io, fetch, host), 0);
  assert.deepEqual(JSON.parse(jsonIo.stdout()), { pairingUrl: `http://127.0.0.1:5000/#pair=${TOKEN}`, tokenFile });
});

test("credential path resolution mirrors the control plane's own defaults", () => {
  assert.equal(resolveLocalTokenPath(["admin", "status", "--token-file", "/x/tok"], { CONTROL_PLANE_LOCAL_TOKEN_FILE: "/env/tok" }, "/cwd"), "/x/tok");
  assert.equal(resolveLocalTokenPath(["admin", "status"], { CONTROL_PLANE_LOCAL_TOKEN_FILE: "rel/tok" }, "/cwd"), "/cwd/rel/tok");
  assert.equal(resolveLocalTokenPath(["admin", "status"], { CONTROL_PLANE_DB: "/srv/wollipog/cp.db" }, "/cwd"), "/srv/wollipog/cp.db.local-device-token");
  assert.equal(resolveLocalTokenPath(["admin", "status"], {}, "/cwd"), "/cwd/data/control-plane.db.local-device-token");
});

test("admin commands fail closed for non-loopback targets before touching the credential", async (t) => {
  const { tokenFile } = fixture(t);
  const { fetch, calls } = server();
  for (const url of ["http://100.64.0.10:4317", "https://wollipog.example.ts.net", "http://dev-box.local:4317"]) {
    const { io, stderr } = makeIo();
    assert.equal(await runHostAdminCli(["admin", "status", "--url", url], env(tokenFile), io, fetch, host), 2, url);
    assert.match(stderr(), /only on the control-plane host over loopback/u);
  }
  assert.equal(calls.length, 0);
  const { io, stdout } = makeIo();
  assert.equal(await runHostAdminCli(["admin", "status", "--url", "ws://127.0.0.1:4317", "--json"], env(tokenFile), io, fetch, host), 2);
  assert.match(JSON.parse(stdout()).error, /must use http or https/u);
});

test("credential reads refuse symlinks, permissive modes, foreign owners, and malformed contents", async (t) => {
  const { dataDir, tokenFile } = fixture(t);
  assert.equal(readProtectedLocalToken(tokenFile, host), TOKEN);

  const link = join(dataDir, "link-token");
  symlinkSync(tokenFile, link);
  assert.throws(() => readProtectedLocalToken(link, host), /symbolic link/u);

  const missing = join(dataDir, "missing");
  assert.throws(() => readProtectedLocalToken(missing, host), /not found .* --token-file/u);

  const malformed = join(dataDir, "malformed");
  writeFileSync(malformed, "not-a-token\n", { mode: 0o600 });
  assert.throws(() => readProtectedLocalToken(malformed, host), /invalid contents/u);

  if (process.platform !== "win32") {
    chmodSync(tokenFile, 0o640);
    assert.throws(() => readProtectedLocalToken(tokenFile, host), /mode 0640 grants group or other access/u);
    const { io, stderr } = makeIo();
    assert.equal(await runHostAdminCli(["admin", "status"], env(tokenFile), io, server().fetch, host), 1);
    assert.match(stderr(), /mode 0640/u);
    chmodSync(tokenFile, 0o600);
    assert.throws(() => readProtectedLocalToken(tokenFile, { ...host, uid: (host.uid ?? 0) + 1 }), /owned by uid/u);
    assert.equal(readProtectedLocalToken(tokenFile, { ...host, platform: "win32", uid: 999_999 }), TOKEN);
  }
});

test("admin status rejects control planes older than the host-administration protocol", async (t) => {
  const { tokenFile } = fixture(t);
  const { fetch, calls } = server({ protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.hostAdministration - 1 });
  const { io, stdout } = makeIo();
  assert.equal(await runHostAdminCli(["admin", "status", "--json"], env(tokenFile), io, fetch, host), 1);
  assert.match(JSON.parse(stdout()).error, new RegExp(`requires v${RUNNER_CAPABILITY_MIN_PROTOCOL.hostAdministration}`, "u"));
  assert.deepEqual(calls.map((call) => call.url), ["http://127.0.0.1:4317/api/compatibility"]);
});

test("admin status emits stable JSON and a readable summary authenticated with the local credential", async (t) => {
  const { tokenFile } = fixture(t);
  const { fetch, calls } = server();
  const { io, stdout } = makeIo();
  assert.equal(await runHostAdminCli(["admin", "status", "--json"], env(tokenFile), io, fetch, host), 0);
  assert.deepEqual(JSON.parse(stdout()), status());
  assert.ok(calls.every((call) => call.headers.authorization === `Bearer ${TOKEN}`));
  assert.equal(calls.at(-1)?.url, "http://127.0.0.1:4317/api/admin/status");

  const readable = formatStatus(status({ warnings: ["no registered runner is online"], localCredential: { path: "/p", safe: false, issues: ["credential file mode 0644 grants group or other access; expected 0600"] } }));
  assert.match(readable, /Control Plane {5}wollipog-control-plane 0\.22\.0 \(protocol v\d+, api v1\)/u);
  assert.match(readable, /Health {12}ok, up 1h 2m/u);
  assert.match(readable, /Public Origin {5}https:\/\/wollipog\.example\.ts\.net/u);
  assert.match(readable, /Local Credential {2}UNSAFE {2}\/p\n {2}! credential file mode 0644/u);
  assert.match(readable, /Warnings\n {2}- no registered runner is online/u);
  assert.ok(!readable.includes(TOKEN));
});

test("admin user list and device list render tables and JSON", async (t) => {
  const { tokenFile } = fixture(t);
  const { fetch } = server();
  const users = makeIo();
  assert.equal(await runHostAdminCli(["admin", "user", "list"], env(tokenFile), users.io, fetch, host), 0);
  assert.match(users.stdout(), /^USER ID\s+NAME\s+ROLE\s+STATUS\s+CREATED\nusr_local\s+Local Owner\s+owner\s+active\s+2023-11-14T22:13:20\.000Z\n$/u);
  const usersJson = makeIo();
  assert.equal(await runHostAdminCli(["admin", "user", "list", "--json"], env(tokenFile), usersJson.io, fetch, host), 0);
  assert.deepEqual(JSON.parse(usersJson.stdout()), { users: [
    { userId: "usr_local", userName: "Local Owner", role: "owner", status: "active", organizationId: "org_personal", createdAt: 1_700_000_000_000 },
  ] });

  const devices = makeIo();
  assert.equal(await runHostAdminCli(["admin", "device", "list"], env(tokenFile), devices.io, fetch, host), 0);
  assert.match(devices.stdout(), /^DEVICE ID\s+NAME\s+USER\s+ROLE\s+CREATED\s+LAST SEEN\ndev_1\s+Pixel 9\s+Local Owner\s+owner\s+2023-11-14T22:13:20\.000Z\s+never\n$/u);
  const devicesJson = makeIo();
  assert.equal(await runHostAdminCli(["admin", "device", "list", "--json"], env(tokenFile), devicesJson.io, fetch, host), 0);
  assert.equal(JSON.parse(devicesJson.stdout()).devices[0].deviceId, "dev_1");
});

test("admin device create prints the one-time link only on a terminal and prefers the configured public origin", async (t) => {
  const { tokenFile } = fixture(t);
  const { fetch, calls } = server({ publicOrigin: "https://wollipog.example.ts.net" });

  const piped = makeIo();
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "Phone"], env(tokenFile), piped.io, fetch, host), 2);
  assert.match(piped.stderr(), /refusing to print a one-time pairing secret/u);
  assert.ok(!calls.some((call) => call.method === "POST"), "no device is minted when the secret cannot be delivered");

  const terminal = makeIo({ stdoutIsTTY: true });
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "Phone", "--user", "usr_other"], env(tokenFile), terminal.io, fetch, host), 0);
  assert.match(terminal.stdout(), /Paired device dev_new \(Phone\) for Local Owner\./u);
  assert.match(terminal.stdout(), /Add Remote Instance:\nhttps:\/\/wollipog\.example\.ts\.net\/#pair=device-secret-token-0123456789\n$/u);
  assert.equal(terminal.stderr(), "");
  const created = calls.find((call) => call.method === "POST")!;
  assert.deepEqual(JSON.parse(created.body!), { name: "Phone", userId: "usr_other" });
  assert.ok(!created.url.includes(DEVICE_TOKEN) && !created.body!.includes(TOKEN));

  const terminalJson = makeIo({ stdoutIsTTY: true });
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "Tablet", "--json"], env(tokenFile), terminalJson.io, fetch, host), 0);
  const parsed = JSON.parse(terminalJson.stdout());
  assert.equal(parsed.originSource, "public-origin");
  assert.equal(parsed.pairingUrl, `https://wollipog.example.ts.net/#pair=${DEVICE_TOKEN}`);
  assert.equal(parsed.device.deviceId, "dev_new");
});

test("admin device create --output writes the link once to a new 0600 file and never echoes it", async (t) => {
  const { root, tokenFile } = fixture(t);
  const { fetch } = server({ publicOrigin: "https://wollipog.example.ts.net" });
  const output = join(root, "phone.pair");
  const { io, stdout, stderr } = makeIo();
  const cwdHost = { ...host, cwd: () => root };
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "Phone", "--output", "phone.pair", "--json"], env(tokenFile), io, fetch, cwdHost), 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.outputPath, output);
  assert.equal(parsed.pairingUrl, undefined);
  assert.ok(!stdout().includes(DEVICE_TOKEN) && !stderr().includes(DEVICE_TOKEN));
  assert.equal(readFileSync(output, "utf8"), `https://wollipog.example.ts.net/#pair=${DEVICE_TOKEN}\n`);
  if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.ok(!existsSync(`${output}.pending`), "no staged file remains");

  const again = makeIo();
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "Phone", "--output", output], env(tokenFile), again.io, fetch, host), 1);
  assert.match(again.stderr(), /refusing to overwrite existing output file/u);
  assert.equal(readFileSync(output, "utf8"), `https://wollipog.example.ts.net/#pair=${DEVICE_TOKEN}\n`);

  assert.throws(() => writeProtectedSecretFile(output, "x"), /refusing to overwrite/u);
});

test("admin device create validates --origin, warns on plain HTTP, and falls back to bind hosts or loopback", async (t) => {
  const { tokenFile } = fixture(t);
  const tty = { stdoutIsTTY: true };

  const bad = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--origin", "https://host.example/dash"], env(tokenFile), bad.io, server().fetch, host), 2);
  assert.match(bad.stderr(), /bare origin/u);

  const explicit = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--origin", "http://100.64.0.10:4317/", "--json"], env(tokenFile), explicit.io, server({ publicOrigin: "https://configured.example" }).fetch, host), 0);
  assert.equal(JSON.parse(explicit.stdout()).pairingUrl, `http://100.64.0.10:4317/#pair=${DEVICE_TOKEN}`);
  assert.equal(JSON.parse(explicit.stdout()).originSource, "flag");
  assert.match(explicit.stderr(), /plain HTTP beyond loopback/u);

  const bindHost = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--json"], env(tokenFile), bindHost.io, server({ hosts: ["192.168.1.20"], boundBeyondLoopback: true }).fetch, host), 0);
  assert.equal(JSON.parse(bindHost.stdout()).pairingUrl, `http://192.168.1.20:4317/#pair=${DEVICE_TOKEN}`);
  assert.equal(JSON.parse(bindHost.stdout()).originSource, "bind-host");
  assert.match(bindHost.stderr(), /no CONTROL_PLANE_PUBLIC_ORIGIN is configured; the link uses plain HTTP/u);
  assert.match(bindHost.stderr(), /desktop app refuses plain HTTP to 192\.168\.1\.20; this link works only in a browser/u);
  assert.deepEqual(JSON.parse(bindHost.stdout()).consumers, { browser: true, desktop: false });

  const loopback = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--json"], env(tokenFile), loopback.io, server({ webServed: false }).fetch, host), 0);
  assert.equal(JSON.parse(loopback.stdout()).pairingUrl, `http://127.0.0.1:4317/#pair=${DEVICE_TOKEN}`);
  assert.equal(JSON.parse(loopback.stdout()).originSource, "loopback");
  assert.match(loopback.stderr(), /only works on this machine/u);
  assert.match(loopback.stderr(), /serves no web dashboard bundle; this link works only in the desktop app/u);
  assert.deepEqual(JSON.parse(loopback.stdout()).consumers, { browser: false, desktop: true });
});

test("admin device revoke requires confirmation or --yes and reports control-plane errors", async (t) => {
  const { tokenFile } = fixture(t);
  const { fetch, calls } = server();

  const piped = makeIo();
  assert.equal(await runHostAdminCli(["admin", "device", "revoke", "dev_1"], env(tokenFile), piped.io, fetch, host), 2);
  assert.match(piped.stderr(), /pass --yes in non-interactive use/u);
  assert.ok(!calls.some((call) => call.method === "DELETE"));

  const declined = makeIo({ stdinIsTTY: true, confirm: async () => false });
  assert.equal(await runHostAdminCli(["admin", "device", "revoke", "dev_1"], env(tokenFile), declined.io, fetch, host), 1);
  assert.match(declined.stdout(), /was not revoked/u);
  assert.ok(!calls.some((call) => call.method === "DELETE"));

  const questions: string[] = [];
  const confirmed = makeIo({ stdinIsTTY: true, confirm: async (question) => { questions.push(question); return true; } });
  assert.equal(await runHostAdminCli(["admin", "device", "revoke", "dev_1", "--json"], env(tokenFile), confirmed.io, fetch, host), 0);
  assert.deepEqual(JSON.parse(confirmed.stdout()), { revoked: true, deviceId: "dev_1" });
  assert.match(questions[0] ?? "", /Revoke device dev_1\?/u);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(calls.find((call) => call.method === "DELETE")?.url, "http://127.0.0.1:4317/api/devices/dev_1");

  const missing = makeIo();
  assert.equal(await runHostAdminCli(["admin", "device", "revoke", "dev_missing", "--yes", "--json"], env(tokenFile), missing.io, fetch, host), 1);
  assert.match(JSON.parse(missing.stdout()).error, /device not found/u);
});

test("wollipog admin dispatches from the main CLI without session credentials and prints usage when incomplete", async (t) => {
  const { tokenFile } = fixture(t);
  const { fetch } = server();
  const { io, stdout, stderr } = makeIo();
  const code = await runWollipogCli(
    ["/usr/local/bin/wollipog", "admin", "status", "--json", "--token-file", tokenFile],
    {},
    { stdout: io.stdout, stderr: io.stderr },
    fetch,
    io,
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout()).protocolVersion, PROTOCOL_VERSION);
  assert.equal(stderr(), "");

  const usage = makeIo();
  assert.equal(await runWollipogCli(["node", "cli.js", "--wollipog-cli", "admin"], {}, { stdout: usage.io.stdout, stderr: usage.io.stderr }, fetch, usage.io), 2);
  assert.match(usage.stderr(), /Usage: wollipog admin <command>/u);
  const unknown = makeIo();
  assert.equal(await runWollipogCli(["node", "cli.js", "--wollipog-cli", "admin", "bogus"], {}, { stdout: unknown.io.stdout, stderr: unknown.io.stderr }, fetch, unknown.io), 2);
  assert.match(unknown.stderr(), /Usage: wollipog admin <command>/u);
});

test("loopback detection accepts only literal loopback hosts, never look-alike DNS names", () => {
  for (const ok of ["localhost", "LOCALHOST", "127.0.0.1", "127.5.5.5", "::1", "[::1]"]) assert.equal(isLoopbackHostname(ok), true, ok);
  for (const bad of ["127.evil.example", "127.0.0.1.nip.io", "foo.localhost", "localhost.", "0.0.0.0", "127.0.0.256", "128.0.0.1", "::2", "2001:db8::1"]) {
    assert.equal(isLoopbackHostname(bad), false, bad);
  }
});

test("admin device create brackets IPv6 bind hosts in fallback links", async (t) => {
  const { tokenFile } = fixture(t);
  const { io, stdout } = makeIo({ stdoutIsTTY: true });
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--json"], env(tokenFile), io, server({ hosts: ["2001:db8::1"], boundBeyondLoopback: true }).fetch, host), 0);
  const url = JSON.parse(stdout()).pairingUrl as string;
  assert.equal(url, `http://[2001:db8::1]:4317/#pair=${DEVICE_TOKEN}`);
  assert.equal(new URL(url).hostname, "[2001:db8::1]");
});

test("admin device create never mints a device it cannot deliver, and revokes one whose delivery fails", async (t) => {
  const { root, tokenFile } = fixture(t);
  const existing = join(root, "existing.pair");
  writeFileSync(existing, "old\n", { mode: 0o600 });
  const reserved = server({ publicOrigin: "https://wollipog.example.ts.net" });
  const { io, stderr } = makeIo();
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--output", existing], env(tokenFile), io, reserved.fetch, host), 1);
  assert.match(stderr(), /refusing to overwrite existing output file/u);
  assert.ok(!reserved.calls.some((call) => call.method === "POST"), "no device is minted when the output path is already occupied");
  assert.equal(readFileSync(existing, "utf8"), "old\n");

  const undeliverable = server({ publicOrigin: "https://wollipog.example.ts.net" });
  const late = makeIo();
  const missingParent = join(root, "missing-dir", "phone.pair");
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--output", missingParent, "--json"], env(tokenFile), late.io, undeliverable.fetch, host), 1);
  const error = JSON.parse(late.stdout()).error as string;
  assert.match(error, /could not create .*phone\.pair/u);
  assert.match(error, /device dev_new was revoked/u);
  assert.ok(!error.includes(DEVICE_TOKEN));
  const methods = undeliverable.calls.map((call) => `${call.method} ${call.url.replace(/^http:\/\/[^/]+/u, "")}`);
  assert.deepEqual(methods.filter((entry) => !entry.endsWith("/api/compatibility")), ["POST /api/devices", "DELETE /api/devices/dev_new"]);
  assert.ok(!existsSync(missingParent));

  const unrevocable = server({ publicOrigin: "https://wollipog.example.ts.net", revokeNewDeviceStatus: 503 });
  const stuck = makeIo();
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--output", missingParent, "--json"], env(tokenFile), stuck.io, unrevocable.fetch, host), 1);
  const stuckError = JSON.parse(stuck.stdout()).error as string;
  assert.match(stuckError, /device dev_new could not be revoked \(DELETE \/api\/devices\/dev_new failed: control plane restarting\); run: wollipog admin device revoke dev_new --yes/u);
  assert.ok(!stuckError.includes(DEVICE_TOKEN));
});

test("writeProtectedSecretFile stays no-replace without hard links and removes a partial fallback file", async (t) => {
  const { root } = fixture(t);
  const noLink = { link: () => { const e = new Error("EPERM") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; }, write: (fd: number, contents: string) => writeFileSync(fd, contents, "utf8") };
  const target = join(root, "fallback.pair");
  writeProtectedSecretFile(target, "secret\n", noLink);
  assert.equal(readFileSync(target, "utf8"), "secret\n");
  if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.throws(() => writeProtectedSecretFile(target, "again\n", noLink), /refusing to overwrite/u);
  assert.equal(readFileSync(target, "utf8"), "secret\n");

  let writes = 0;
  const failingSecondWrite = { ...noLink, write: (fd: number, contents: string) => { writes += 1; if (writes === 2) throw new Error("disk full"); writeFileSync(fd, contents, "utf8"); } };
  const partial = join(root, "partial.pair");
  assert.throws(() => writeProtectedSecretFile(partial, "secret\n", failingSecondWrite), /could not write .*disk full/u);
  assert.ok(!existsSync(partial), "a failed fallback write leaves no partial file");
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".pending-")), []);
});

test("admin device create revokes a minted device when the token or composed link is unusable", async (t) => {
  const { tokenFile } = fixture(t);
  const tty = { stdoutIsTTY: true };

  const badToken = server({ publicOrigin: "https://wollipog.example.ts.net", mintedToken: "not a token!" });
  const bad = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--json"], env(tokenFile), bad.io, badToken.fetch, host), 1);
  assert.match(JSON.parse(bad.stdout()).error, /unusable device token; the newly minted device dev_new was revoked/u);
  assert.ok(badToken.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/api/devices/dev_new")));

  const scoped = server({ hosts: ["fe80::1%eth0"], boundBeyondLoopback: true });
  const link = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--json"], env(tokenFile), link.io, scoped.fetch, host), 1);
  const error = JSON.parse(link.stdout()).error as string;
  assert.match(error, /cannot form a valid pairing link; set CONTROL_PLANE_PUBLIC_ORIGIN or pass --origin/u);
  assert.match(error, /device dev_new was revoked/u);
  assert.ok(!error.includes(DEVICE_TOKEN));
  assert.ok(scoped.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/api/devices/dev_new")));

  const rescued = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--origin", "https://box.example.ts.net", "--json"], env(tokenFile), rescued.io, server({ hosts: ["fe80::1%eth0"], boundBeyondLoopback: true }).fetch, host), 0);
  assert.equal(JSON.parse(rescued.stdout()).pairingUrl, `https://box.example.ts.net/#pair=${DEVICE_TOKEN}`);
});

test("pairing link consumer policy mirrors the desktop cleartext rules", () => {
  for (const ok of ["100.64.0.1", "100.101.58.119", "100.127.255.255"]) assert.equal(isTailnetIpv4Literal(ok), true, ok);
  for (const bad of ["100.63.255.255", "100.128.0.1", "10.0.0.1", "100.64.0.256", "100.64.0.1.nip.io"]) assert.equal(isTailnetIpv4Literal(bad), false, bad);
  assert.deepEqual(pairingLinkConsumers("https://box.example.ts.net", false), { browser: false, desktop: true });
  assert.deepEqual(pairingLinkConsumers("http://100.101.58.119:4317", false), { browser: false, desktop: true });
  assert.deepEqual(pairingLinkConsumers("http://127.0.0.1:4317", true), { browser: true, desktop: true });
  assert.deepEqual(pairingLinkConsumers("http://192.168.1.20:4317", true), { browser: true, desktop: false });
  assert.deepEqual(pairingLinkConsumers("http://192.168.1.20:4317", false), { browser: false, desktop: false });
});

test("admin device create refuses and revokes a link no advertised consumer can open", async (t) => {
  const { tokenFile } = fixture(t);
  const tty = { stdoutIsTTY: true };
  const dead = server({ hosts: ["192.168.1.20"], boundBeyondLoopback: true, webServed: false });
  const { io, stdout } = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--json"], env(tokenFile), io, dead.fetch, host), 1);
  const error = JSON.parse(stdout()).error as string;
  assert.match(error, /neither a browser nor the desktop app can use the link; set CONTROL_PLANE_PUBLIC_ORIGIN to an HTTPS origin/u);
  assert.match(error, /device dev_new was revoked/u);
  assert.ok(!error.includes(DEVICE_TOKEN));
  assert.ok(dead.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/api/devices/dev_new")));

  const explicitDead = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--origin", "http://box.example:4317"], env(tokenFile), explicitDead.io, server({ webServed: false }).fetch, host), 1);
  assert.match(explicitDead.stderr(), /neither a browser nor the desktop app can use the link/u);

  const tailnet = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--json"], env(tokenFile), tailnet.io, server({ hosts: ["100.101.58.119"], boundBeyondLoopback: true, webServed: false }).fetch, host), 0);
  assert.equal(JSON.parse(tailnet.stdout()).pairingUrl, `http://100.101.58.119:4317/#pair=${DEVICE_TOKEN}`);
  assert.deepEqual(JSON.parse(tailnet.stdout()).consumers, { browser: false, desktop: true });
  assert.match(tailnet.stderr(), /works only in the desktop app/u);
});

test("admin device create revokes when the response lacks a device record or the terminal write fails", async (t) => {
  const { tokenFile } = fixture(t);
  const tty = { stdoutIsTTY: true };

  const headless = server({ publicOrigin: "https://wollipog.example.ts.net", omitDevice: true });
  const missing = makeIo(tty);
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P", "--json"], env(tokenFile), missing.io, headless.fetch, host), 1);
  const missingError = JSON.parse(missing.stdout()).error as string;
  assert.match(missingError, /returned no device record; the control plane response named no device to revoke/u);
  assert.ok(!missingError.includes(DEVICE_TOKEN));
  assert.ok(!headless.calls.some((call) => call.method === "DELETE"));

  const broken = server({ publicOrigin: "https://wollipog.example.ts.net" });
  const written: string[] = [];
  const failingStdout = makeIo({ ...tty, stdout: (text) => { if (text.includes("#pair=")) throw new Error("EPIPE"); written.push(text); } });
  assert.equal(await runHostAdminCli(["admin", "device", "create", "--name", "P"], env(tokenFile), failingStdout.io, broken.fetch, host), 1);
  assert.match(failingStdout.stderr(), /EPIPE; the newly minted device dev_new was revoked/u);
  assert.ok(!written.join("").includes(DEVICE_TOKEN) && !failingStdout.stderr().includes(DEVICE_TOKEN));
  assert.ok(broken.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/api/devices/dev_new")));
});

test("pairing link consumer gate accepts every localhost form the desktop accepts without widening --url", () => {
  for (const ok of ["localhost", "localhost.", "foo.localhost", "FOO.LOCALHOST.", "127.0.0.1", "[::1]", "100.64.0.1"]) assert.equal(isDesktopCleartextHost(ok), true, ok);
  for (const bad of ["127.evil.example", "box.example", "192.168.1.20", "localhost.example"]) assert.equal(isDesktopCleartextHost(bad), false, bad);
  assert.deepEqual(pairingLinkConsumers("http://foo.localhost:4317", false), { browser: false, desktop: true });
  assert.deepEqual(pairingLinkConsumers("http://localhost.:4317", false), { browser: false, desktop: true });
  assert.equal(isLoopbackHostname("foo.localhost"), false, "--url stays literal-only");
});

test("admin runner-credential list renders credentials and JSON", async (t) => {
  const { tokenFile } = fixture(t);
  const { fetch } = server();
  const readable = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "list"], env(tokenFile), readable.io, fetch, host), 0);
  assert.match(readable.stdout(), /^RUNNER ID\s+CREDENTIAL\s+STATUS\s+LABEL\s+CREATED\s+ACTIVATED\s+LAST USED\s+EXPIRES\n/u);
  assert.match(readable.stdout(), /dev-box\s+rc_dev-box\s+active\s+Runner credential\s+2023-11-14T22:13:20\.000Z\s+2023-11-14T22:14:20\.000Z\s+never\s+never\n/u);
  assert.match(readable.stdout(), /new-box\s+rc_new-box\s+pending\s+Rack 2\s+.*\s+never\s+never\s+2023-11-15T22:13:20\.000Z\n$/u);
  const json = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "list", "--json"], env(tokenFile), json.io, fetch, host), 0);
  assert.equal(JSON.parse(json.stdout()).credentials.length, 2);
  assert.ok(!json.stdout().includes(RUNNER_TOKEN));
});

test("admin runner-credential issue writes the token once to a 0600 file and leaves an undeliverable pending credential to expire", async (t) => {
  const { root, tokenFile } = fixture(t);
  const issued = server();
  const output = join(root, "rack2.token");
  const { io, stdout, stderr } = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", "rack-2", "--label", "Rack 2", "--output", output, "--json"], env(tokenFile), io, issued.fetch, host), 0);
  const parsed = JSON.parse(stdout());
  assert.equal(parsed.outputPath, output);
  assert.equal(parsed.operation, "issue");
  assert.equal(parsed.credential.runnerId, "rack-2");
  assert.equal(parsed.token, undefined);
  assert.ok(!stdout().includes(RUNNER_TOKEN) && !stderr().includes(RUNNER_TOKEN));
  assert.equal(readFileSync(output, "utf8"), `${RUNNER_TOKEN}\n`);
  if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
  const post = issued.calls.find((call) => call.method === "POST")!;
  assert.deepEqual(JSON.parse(post.body!), { runnerId: "rack-2", label: "Rack 2" });

  const piped = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", "rack-3"], env(tokenFile), piped.io, server().fetch, host), 2);
  assert.match(piped.stderr(), /refusing to print a one-time runner credential to a non-interactive stdout/u);

  const terminal = makeIo({ stdoutIsTTY: true });
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", "rack-3"], env(tokenFile), terminal.io, server().fetch, host), 0);
  assert.match(terminal.stdout(), /Issued a pending credential rc_rack-3 for runner rack-3; it activates on the runner's first registration/u);
  assert.match(terminal.stdout(), new RegExp(`--token-file <file> or RUNNER_TOKEN_FILE.*\\n${RUNNER_TOKEN}\\n$`, "u"));

  const conflict = makeIo({ stdoutIsTTY: true });
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", "dev-box", "--json"], env(tokenFile), conflict.io, server().fetch, host), 1);
  assert.match(JSON.parse(conflict.stdout()).error, /already has an active credential; rotate it instead/u);

  const undeliverable = server();
  const lost = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", "rack-4", "--output", join(root, "missing", "t"), "--json"], env(tokenFile), lost.io, undeliverable.fetch, host), 1);
  const lostError = JSON.parse(lost.stdout()).error as string;
  assert.match(lostError, /could not create .*; the pending credential for runner rack-4 was not delivered, expires unused in 24 hours, and is replaced by running the issue command again/u);
  assert.ok(!lostError.includes(RUNNER_TOKEN));
  assert.ok(!undeliverable.calls.some((call) => call.method === "DELETE"), "an inert pending credential is never revoked: a revoke would also close a legacy runner's socket");

  for (const token of ["bad token", "A".repeat(43), "wollipogr_" + "A".repeat(42), "other_" + "A".repeat(43)]) {
    const badToken = makeIo({ stdoutIsTTY: true });
    assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", "rack-5", "--json"], env(tokenFile), badToken.io, server({ runnerToken: token }).fetch, host), 1, token);
    assert.match(JSON.parse(badToken.stdout()).error, /unusable runner token; the pending credential for runner rack-5 was not delivered/u);
    assert.ok(!badToken.stdout().includes(token.replace(/ /gu, "")) || token === "bad token", token);
  }
  const legacy = makeIo({ stdoutIsTTY: true });
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", "rack-6", "--json"], env(tokenFile), legacy.io, server({ runnerToken: "mamr_" + "L".repeat(43) }).fetch, host), 0);
  assert.equal(JSON.parse(legacy.stdout()).token, "mamr_" + "L".repeat(43));

  const bad = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", "bad/id", "--output", join(root, "x")], env(tokenFile), bad.io, server().fetch, host), 2);
  assert.match(bad.stderr(), /--runner must be an exact runner id/u);
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--output", join(root, "y")], env(tokenFile), makeIo().io, server().fetch, host), 2);
});

test("admin runner-credential rotate keeps the active credential and never revokes on delivery failure", async (t) => {
  const { root, tokenFile } = fixture(t);
  const rotated = server();
  const output = join(root, "devbox.token");
  const { io, stdout } = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "rotate", "--runner", "dev-box", "--output", output], env(tokenFile), io, rotated.fetch, host), 0);
  assert.match(stdout(), /Rotated runner dev-box: pending credential rc_dev-box replaces the current one when the runner registers with it; the current credential stays active until then/u);
  assert.equal(readFileSync(output, "utf8"), `${RUNNER_TOKEN}\n`);
  assert.equal(rotated.calls.find((call) => call.method === "POST")?.url, "http://127.0.0.1:4317/api/runner-credentials/dev-box/rotate");

  const lost = server();
  const failed = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "rotate", "--runner", "dev-box", "--output", join(root, "missing", "t"), "--json"], env(tokenFile), failed.io, lost.fetch, host), 1);
  assert.match(JSON.parse(failed.stdout()).error, /pending credential for runner dev-box was not delivered, expires unused in 24 hours, and is replaced by running the rotate command again/u);
  assert.ok(!lost.calls.some((call) => call.method === "DELETE"), "rotation failure must not revoke the still-active credential");
});

test("admin runner-credential revoke requires confirmation or --yes and reports unknown runners", async (t) => {
  const { tokenFile } = fixture(t);
  const { fetch, calls } = server();
  const piped = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "revoke", "--runner", "dev-box"], env(tokenFile), piped.io, fetch, host), 2);
  assert.match(piped.stderr(), /pass --yes in non-interactive use/u);
  assert.ok(!calls.some((call) => call.method === "DELETE"));

  const declined = makeIo({ stdinIsTTY: true, confirm: async () => false });
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "revoke", "--runner", "dev-box"], env(tokenFile), declined.io, fetch, host), 1);
  assert.match(declined.stdout(), /was not revoked/u);

  const questions: string[] = [];
  const confirmed = makeIo({ stdinIsTTY: true, confirm: async (q) => { questions.push(q); return true; } });
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "revoke", "--runner", "dev-box", "--json"], env(tokenFile), confirmed.io, fetch, host), 0);
  assert.deepEqual(JSON.parse(confirmed.stdout()), { revoked: true, runnerId: "dev-box" });
  assert.match(questions[0] ?? "", /Revoke the active and pending credentials of runner dev-box\?/u);
  assert.equal(calls.find((call) => call.method === "DELETE")?.url, "http://127.0.0.1:4317/api/runner-credentials/dev-box");

  const missing = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "revoke", "--runner", "ghost", "--yes", "--json"], env(tokenFile), missing.io, fetch, host), 1);
  assert.match(JSON.parse(missing.stdout()).error, /runner not found/u);

  const before = calls.filter((call) => call.method === "DELETE").length;
  for (const raw of ["dev-box ", " dev-box", "dev-box\t", ""]) {
    const padded = makeIo();
    assert.equal(await runHostAdminCli(["admin", "runner-credential", "revoke", "--runner", raw, "--yes"], env(tokenFile), padded.io, fetch, host), 2, JSON.stringify(raw));
    assert.match(padded.stderr(), raw === "" ? /requires --runner|requires a value/u : /exact runner id/u);
  }
  assert.equal(calls.filter((call) => call.method === "DELETE").length, before, "a padded id must never retarget a revoke");

  const swallowed = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "revoke", "--runner", "--yes"], env(tokenFile), swallowed.io, fetch, host), 2);
  assert.match(swallowed.stderr(), /--runner requires a value/u);
  for (const dot of [".", ".."]) {
    const traversal = makeIo();
    assert.equal(await runHostAdminCli(["admin", "runner-credential", "revoke", "--runner", dot, "--yes"], env(tokenFile), traversal.io, fetch, host), 2, dot);
    assert.match(traversal.stderr(), /dot segments/u);
  }
  assert.equal(calls.filter((call) => call.method === "DELETE").length, before, "an omitted or dot-segment id must never reach a request");
  const equalsForm = makeIo();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "revoke", "--runner=--yes", "--yes", "--json"], env(tokenFile), equalsForm.io, fetch, host), 0);
  assert.deepEqual(JSON.parse(equalsForm.stdout()), { revoked: true, runnerId: "--yes" });
  assert.equal(calls.at(-1)?.url, "http://127.0.0.1:4317/api/runner-credentials/--yes", "the explicit = form still targets a literal id");
});

test("admin runner-credential reports a possibly delivered token when output fails midway", async (t) => {
  const { tokenFile } = fixture(t);
  const seen: string[] = [];
  const broken = makeIo({ stdoutIsTTY: true, stdout: (text) => { seen.push(text); if (text.includes("wollipogr_")) throw new Error("EPIPE"); } });
  const srv = server();
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", "rack-9"], env(tokenFile), broken.io, srv.fetch, host), 1);
  assert.match(broken.stderr(), /EPIPE; the token for runner rack-9 may have been partially delivered and the pending credential rc_rack-9 stays usable until it expires in 24 hours: run the issue command again to supersede it, or revoke it with: wollipog admin runner-credential revoke --runner 'rack-9' --yes/u);
  assert.ok(!broken.stderr().includes(RUNNER_TOKEN));
  assert.ok(!srv.calls.some((call) => call.method === "DELETE"), "the CLI does not guess; the operator chooses supersede or revoke");
});

test("an option with an omitted value is a usage error, never a silent fallback to the default", async (t) => {
  const { tokenFile } = fixture(t);
  const tty = { stdoutIsTTY: true };
  const srv = server();
  const cases: Array<[string[], RegExp]> = [
    [["admin", "runner-credential", "issue", "--runner", "rack-1", "--output", "--json"], /--output requires a value/u],
    [["admin", "runner-credential", "issue", "--runner", "rack-1", "--label"], /--label requires a value/u],
    [["admin", "device", "create", "--name", "P", "--origin", "--json"], /--origin requires a value/u],
    [["admin", "device", "create", "--name", "P", "--user", "--json"], /--user requires a value/u],
    [["admin", "status", "--url", "--json"], /--url requires a value/u],
    [["admin", "status", "--token-file"], /--token-file requires a value/u],
    [["admin", "runner-credential", "issue", "--runner", "rack-1", "--output="], /--output requires a value/u],
    [["admin", "runner-credential", "issue", "--runner=", "--output=/x"], /--runner requires a value/u],
    [["admin", "device", "create", "--name", "P", "--origin=", "--json"], /--origin requires a value/u],
    [["admin", "status", "--token-file="], /--token-file requires a value/u],
  ];
  for (const [args, expected] of cases) {
    const { io, stdout, stderr } = makeIo(tty);
    assert.equal(await runHostAdminCli(args, env(tokenFile), io, srv.fetch, host), 2, args.join(" "));
    // With --json present the usage error is emitted as JSON on stdout; otherwise on stderr.
    assert.match(stdout() + stderr(), expected, args.join(" "));
    assert.ok(!stdout().includes(RUNNER_TOKEN) && !stdout().includes(DEVICE_TOKEN), args.join(" "));
  }
  assert.ok(!srv.calls.some((call) => call.method === "POST"), "nothing is minted when an option value is missing");
});

test("the recovery command shell-quotes runner ids that contain metacharacters", async (t) => {
  const { tokenFile } = fixture(t);
  const hostile = "rack;touch${IFS}pwned;true";
  const broken = makeIo({ stdoutIsTTY: true, stdout: (text) => { if (text.includes("wollipogr_")) throw new Error("EPIPE"); } });
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", hostile], env(tokenFile), broken.io, server().fetch, host), 1);
  assert.ok(broken.stderr().includes(`revoke --runner 'rack;touch\${IFS}pwned;true' --yes`), broken.stderr());
  const quoted = makeIo({ stdoutIsTTY: true, stdout: (text) => { if (text.includes("wollipogr_")) throw new Error("EPIPE"); } });
  assert.equal(await runHostAdminCli(["admin", "runner-credential", "issue", "--runner", "it's"], env(tokenFile), quoted.io, server().fetch, host), 1);
  assert.ok(quoted.stderr().includes(`--runner 'it'\\''s' --yes`), quoted.stderr());
});

test("writeProtectedSecretFile removes the fallback file when the final close fails", async (t) => {
  const { root } = fixture(t);
  const noLink = { link: () => { const e = new Error("EPERM") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; }, write: (fd: number, contents: string) => { writeFileSync(fd, contents, "utf8"); } };
  const target = join(root, "close-fails.pair");
  let closes = 0;
  const failingClose = { ...noLink, write: (fd: number, contents: string) => { writeFileSync(fd, contents, "utf8"); closes += 1; if (closes === 2) { closeSync(fd); } } };
  // Closing the descriptor inside write() makes the helper's own fsync/close fail with EBADF after
  // the live file was fully written: the helper must throw the wrapped error (not a second EBADF from
  // cleanup) and remove the file.
  assert.throws(() => writeProtectedSecretFile(target, "secret\n", failingClose), /^Error: could not write .*EBADF/u);
  assert.ok(!existsSync(target), "a file whose close failed is not published");
});

function doctorServer(options: { protocolVersion?: number; fail?: boolean } = {}) {
  const calls: string[] = [];
  const view = {
    generatedAt: 1_700_000_000_000,
    ok: !options.fail,
    checks: [
      { id: "control-plane", status: "pass", summary: "responding" },
      { id: "exposure", status: "warn", summary: "loopback only", remedy: "set CONTROL_PLANE_PUBLIC_ORIGIN" },
      ...(options.fail ? [{ id: "database", status: "fail", summary: "not writable", remedy: "chown" }] : []),
    ],
    status: status({ appVersion: "9.9.9" }),
  };
  const fetch: McpFetch = async (url, init) => {
    calls.push(url);
    const respond = (statusCode: number, body: unknown) => ({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, text: async () => JSON.stringify(body) });
    if (init?.headers?.authorization !== `Bearer ${TOKEN}`) return respond(401, { error: "unauthorized" });
    const path = url.replace(/^https?:\/\/[^/]+/u, "");
    if (path === "/api/compatibility") return respond(200, { protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION });
    if (path === "/api/admin/doctor") return respond(200, view);
    return respond(404, { error: `unexpected ${path}` });
  };
  return { fetch, calls };
}

test("admin doctor runs local checks, appends the control plane's checks, flags version skew, and exits by severity", async (t) => {
  const { root, tokenFile } = fixture(t);
  const home = join(root, "home");
  mkdirSync(join(home, ".config", "wollipog"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  const envFile = join(home, ".config", "wollipog", "control-plane.env");
  writeFileSync(envFile, `CONTROL_PLANE_PORT=4317\nCONTROL_PLANE_LOCAL_TOKEN_FILE="${tokenFile}"\n`, { mode: 0o600 });
  const runnerToken = join(home, ".config", "wollipog", "runner.token");
  writeFileSync(runnerToken, "wollipogr_x\n", { mode: 0o640 });
  const execs: string[] = [];
  const doctorHost = {
    ...host,
    platform: "linux" as const,
    home,
    user: "op",
    env: {},
    installedControlPlaneEnv: () => ({ file: envFile, port: 4317, localTokenFile: tokenFile }),
    exec: async (command: string, args: string[]) => {
      execs.push([command, ...args].join(" "));
      if (command === "systemctl") {
        const unit = args[args.length - 1]!;
        const active = unit === "wollipog-control-plane.service";
        return { code: 0, stdout: `LoadState=loaded\nActiveState=${active ? "active" : "failed"}\nSubState=${active ? "running" : "failed"}\nUnitFileState=enabled\nMainPID=${active ? 77 : 0}\nNRestarts=3\n`, stderr: "" };
      }
      if (command === "loginctl") return { code: 0, stdout: "no\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  };
  const srv = doctorServer();
  const { io, stdout } = makeIo();
  const code = await runHostAdminCli(["admin", "doctor", "--json"], {}, io, srv.fetch, doctorHost);
  const report = JSON.parse(stdout());
  const byId = Object.fromEntries(report.checks.map((c: { id: string }) => [c.id, c]));
  assert.equal(code, 1, JSON.stringify(report.checks));
  assert.equal(report.ok, false);
  assert.equal(byId.cli.status, "pass");
  assert.match(byId["service:wollipog-control-plane.service"].summary, /active\/running \(pid 77\), 3 restart\(s\)/u);
  assert.equal(byId["service:wollipog-runner.service"].status, "fail");
  assert.match(byId["service:wollipog-runner.service"].remedy, /wollipog service logs runner/u);
  assert.equal(byId.lingering.status, "warn");
  assert.match(byId.lingering.remedy, /loginctl enable-linger op/u);
  assert.equal(byId["control-plane-env"].status, "pass");
  assert.equal(byId["runner-token"].status, process.platform === "win32" ? "pass" : "fail");
  assert.equal(byId["local-credential-file"].status, "pass");
  assert.equal(byId["control-plane-reachable"].status, "pass");
  assert.equal(byId.exposure.status, "warn", "server checks are appended");
  assert.equal(byId["version-skew"].status, "warn");
  assert.match(byId["version-skew"].summary, /differs from control plane 9\.9\.9/u);
  assert.ok(srv.calls.some((url) => url.endsWith("/api/admin/doctor")));
  assert.ok(execs.some((line) => line.startsWith("systemctl --user show")));
  assert.ok(!stdout().includes(TOKEN));

  const readable = makeIo();
  await runHostAdminCli(["admin", "doctor"], {}, readable.io, srv.fetch, doctorHost);
  assert.match(readable.stdout(), /FAIL  service:wollipog-runner\.service/u);
  assert.match(readable.stdout(), /remedy: loginctl enable-linger op/u);
  assert.match(readable.stdout(), /\d+ pass, \d+ warn, \d+ fail\n$/u);
});

test("admin doctor degrades when the control plane is down, too old, or the credential file is unsafe", async (t) => {
  const { tokenFile } = fixture(t);
  const noService = { ...host, platform: "linux" as const, home: "/nonexistent-home", user: "op", env: {}, installedControlPlaneEnv: () => null, exec: async () => ({ code: 1, stdout: "", stderr: "" }) };

  const down = makeIo();
  const unreachable: McpFetch = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await runHostAdminCli(["admin", "doctor", "--json"], env(tokenFile), down.io, unreachable, noService), 1);
  const downById = Object.fromEntries(JSON.parse(down.stdout()).checks.map((c: { id: string }) => [c.id, c]));
  assert.equal(downById["control-plane-reachable"].status, "fail");
  assert.match(downById["control-plane-reachable"].detail, /ECONNREFUSED/u);
  assert.equal(downById.service.status, "pass");
  assert.match(downById.service.detail, /wollipog service install/u);

  const old = makeIo();
  assert.equal(await runHostAdminCli(["admin", "doctor", "--json"], env(tokenFile), old.io, doctorServer({ protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.hostAdminDoctor - 1 }).fetch, noService), 0);
  const oldById = Object.fromEntries(JSON.parse(old.stdout()).checks.map((c: { id: string }) => [c.id, c]));
  assert.equal(oldById["control-plane-reachable"].status, "warn");
  assert.match(oldById["control-plane-reachable"].summary, new RegExp(`doctor needs v${RUNNER_CAPABILITY_MIN_PROTOCOL.hostAdminDoctor}\\+`, "u"));
  assert.equal(oldById.exposure, undefined, "no server checks from an old control plane");

  if (process.platform !== "win32") {
    chmodSync(tokenFile, 0o644);
    const unsafe = makeIo();
    const srv = doctorServer();
    assert.equal(await runHostAdminCli(["admin", "doctor", "--json"], env(tokenFile), unsafe.io, srv.fetch, noService), 1);
    const unsafeById = Object.fromEntries(JSON.parse(unsafe.stdout()).checks.map((c: { id: string }) => [c.id, c]));
    assert.equal(unsafeById["local-credential-file"].status, "fail");
    assert.equal(srv.calls.length, 0, "an unsafe credential file is never read or sent");
    chmodSync(tokenFile, 0o600);
  }

  const healthy = makeIo();
  assert.equal(await runHostAdminCli(["admin", "doctor", "--json"], env(tokenFile), healthy.io, doctorServer().fetch, { ...noService }), 0, healthy.stdout());
  const failing = makeIo();
  assert.equal(await runHostAdminCli(["admin", "doctor"], env(tokenFile), failing.io, doctorServer({ fail: true }).fetch, { ...noService }), 1);
  assert.match(failing.stdout(), /FAIL  database/u);
});
