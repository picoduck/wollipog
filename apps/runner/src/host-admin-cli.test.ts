import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type HostAdminStatusView } from "@wollipog/protocol";
import type { McpFetch } from "./session-management-mcp.js";
import {
  formatStatus,
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
