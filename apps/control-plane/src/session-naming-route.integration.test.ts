/** Production-process coverage for session-naming route classification through the real auth gate. */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "./local-device-credential.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const MEMBER_TOKEN = "session-naming-integration-member-token";
const FOREIGN_ADMIN_TOKEN = "session-naming-integration-foreign-admin-token";
const FOREIGN_ORGANIZATION_ID = "org_session_naming_integration_other";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  if (await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(3_000)]);
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      /* listen has not completed */
    }
    await delay(50);
  }
  throw new Error(`control plane did not become healthy\n${logs()}`);
}

function api(base: string, token: string, method: string): Promise<Response> {
  return fetch(`${base}/api/session-naming`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === "PUT" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "PUT" ? { body: JSON.stringify({ mode: "prompt_text_only" }) } : {}),
  });
}

test("the real auth gate admits organization members and non-personal administrators", { timeout: 30_000 }, async (t) => {
  const port = await reservePort();
  const temp = mkdtempSync(join(tmpdir(), "wollipog-session-naming-route-"));
  const databasePath = join(temp, "control-plane.db");
  loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));

  const seed = ControlPlaneDb.open(databasePath);
  const identity = seed.localIdentityContext();
  seed.createIdentityMember({
    userId: "usr_session_naming_member",
    displayName: "Session Naming Member",
    organizationId: identity.organizationId,
    role: "operator",
    now: 1,
  });
  seed.createDevice({
    id: "dev_session_naming_member",
    name: "Session Naming Member Device",
    tokenHash: hashToken(MEMBER_TOKEN),
    userId: "usr_session_naming_member",
    organizationId: identity.organizationId,
    now: 2,
  });
  seed.close();

  const raw = new DatabaseSync(databasePath);
  raw.prepare(
    "INSERT INTO identity_organizations (organization_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(FOREIGN_ORGANIZATION_ID, "Session Naming Integration Other Org", 3, 3);
  raw.close();

  const reseed = ControlPlaneDb.open(databasePath);
  reseed.createIdentityMember({
    userId: "usr_session_naming_foreign_admin",
    displayName: "Foreign Session Naming Admin",
    organizationId: FOREIGN_ORGANIZATION_ID,
    role: "admin",
    now: 4,
  });
  reseed.createDevice({
    id: "dev_session_naming_foreign_admin",
    name: "Foreign Session Naming Admin Device",
    tokenHash: hashToken(FOREIGN_ADMIN_TOKEN),
    userId: "usr_session_naming_foreign_admin",
    organizationId: FOREIGN_ORGANIZATION_ID,
    now: 5,
  });
  reseed.close();

  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NO_COLOR: undefined,
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: databasePath,
      WOLLIPOG_TITLE_MODEL_URL: "",
      WOLLIPOG_TITLE_MODEL: "",
      WOLLIPOG_TITLE_MODEL_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  t.after(async () => {
    await stopChild(child);
    rmSync(temp, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, child, () => output);

  const memberRead = await api(base, MEMBER_TOKEN, "GET");
  assert.equal(memberRead.status, 200, "an ordinary organization member can read the settings");
  assert.equal((await memberRead.json() as { canManage: boolean }).canManage, false);
  assert.equal((await api(base, MEMBER_TOKEN, "PUT")).status, 403, "an ordinary member cannot update the setting");

  const foreignRead = await api(base, FOREIGN_ADMIN_TOKEN, "GET");
  assert.equal(foreignRead.status, 200, "a non-personal-organization admin can read its setting");
  assert.equal((await foreignRead.json() as { canManage: boolean }).canManage, true);
  const foreignWrite = await api(base, FOREIGN_ADMIN_TOKEN, "PUT");
  assert.equal(foreignWrite.status, 200, "a non-personal-organization admin can update its setting");
  assert.equal((await foreignWrite.json() as { source: string }).source, "organization");

  const memberCustom = await fetch(`${base}/api/session-naming/custom-model`, {
    method: "PUT",
    headers: { authorization: `Bearer ${MEMBER_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(memberCustom.status, 403, "an ordinary member cannot provision a runner-local key");
  const foreignCustom = await fetch(`${base}/api/session-naming/custom-model`, {
    method: "PUT",
    headers: { authorization: `Bearer ${FOREIGN_ADMIN_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(foreignCustom.status, 400, "a non-personal-organization admin reaches the scoped custom-model route");
});
