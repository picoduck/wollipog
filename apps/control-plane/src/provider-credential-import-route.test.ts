import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { PROTOCOL_VERSION, PROVIDER_CREDENTIAL_IMPORT_DEFAULT_SOURCE_LABEL as DEFAULT_CODEX_SIGN_IN_LABEL, type ControlPlaneToRunner, type ProviderAccountDefinition, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { Hub, RunnerRequestResult } from "./hub.js";
import { PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import { parseProviderCredentialImport, reconcileProviderProfileGrants, registerProviderProfileRoutes } from "./provider-profile-route.js";

const PROFILE = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const IMPORT = "/api/runners/runner-a/provider-imports";
const CAPABILITY = { version: 1 as const, providers: ["codex" as const] };

function principal(role: HumanPrincipal["role"] = "owner", organizationId = PERSONAL_ORGANIZATION_ID): HumanPrincipal {
  return {
    kind: "human", actorId: "user-1", userId: "user-1", userName: "Test User", organizationId,
    organizationName: organizationId, role, deviceId: null, localBootstrap: false,
  };
}

const codexAccount = (id: string, label = id): ProviderAccountDefinition => ({ id, label, provider: "codex", authStatus: "authenticated" });

type Handler = (runnerId: string, message: ControlPlaneToRunner) => RunnerRequestResult | Promise<RunnerRequestResult>;

async function fixture(options: { protocolVersion?: number; runtime?: RunnerMetadata["runtime"] | null; handler?: Handler } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const runtime = options.runtime === null ? undefined : options.runtime ?? {
    dataDir: "/data", worktreeRoot: "/data/worktrees", maxConcurrentSessions: 4, providerCredentialImport: CAPABILITY,
  };
  db.registerRunner({ runnerId: "runner-a", hostname: "runner-a", os: "linux", version: "1", agents: [], workspaces: [],
    providerAccounts: [codexAccount("legacy", "Legacy Codex"), { ...codexAccount("claude"), provider: "claude" }],
    ...(runtime ? { runtime } : {}) }, 1, options.protocolVersion ?? PROTOCOL_VERSION);
  const sent: ControlPlaneToRunner[] = [];
  let handler: Handler = options.handler ?? ((_runnerId, message) => {
    const m = message as Extract<ControlPlaneToRunner, { type: "import_provider_credential" }>;
    return { type: "import_provider_credential_result", requestId: m.requestId, ok: true, accountId: "work-1a2b3c4d", profileId: PROFILE };
  });
  const hub = {
    isRunnerOnline: () => true,
    runnerChanged: () => {},
    requestFromRunner: async (runnerId: string, _requestId: string, message: ControlPlaneToRunner) => { sent.push(message); return handler(runnerId, message); },
  } as unknown as Pick<Hub, "isRunnerOnline" | "requestFromRunner" | "runnerChanged">;
  let caller: HumanPrincipal | null = principal();
  const app = Fastify();
  registerProviderProfileRoutes(app, { db, hub, requestHuman: () => caller, now: () => 100 });
  await app.ready();
  return {
    db, app, sent,
    setHandler(next: Handler) { handler = next; },
    as(next: HumanPrincipal | null) { caller = next; },
    async close() { await app.close(); db.close(); },
  };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  provider: "codex", label: "Work", source: { kind: "default_home" },
  confirmation: { acknowledgeCredentialImport: true, sourceLabel: DEFAULT_CODEX_SIGN_IN_LABEL, destinationLabel: "Work" }, ...overrides,
});

function importsOf(db: ControlPlaneDb) {
  return db.raw().prepare("SELECT * FROM provider_credential_imports").all() as Array<Record<string, unknown>>;
}

test("an Owner's confirmed import records its audit and grant, sends no path, and the account report completes the grant", async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ method: "POST", url: IMPORT, payload: body() });
    assert.equal(response.statusCode, 201, response.body);
    const message = f.sent[0] as Extract<ControlPlaneToRunner, { type: "import_provider_credential" }>;
    assert.deepEqual(Object.keys(message).sort(), ["label", "profileGrantId", "provider", "requestId", "runnerId", "source", "type"]);
    assert.deepEqual(message.source, { kind: "default_home" });
    assert.equal(response.json().profileId, PROFILE);
    const [row] = importsOf(f.db);
    assert.deepEqual({ ...row, import_id: undefined }, {
      import_id: undefined, organization_id: PERSONAL_ORGANIZATION_ID, owner_kind: "organization", owner_id: PERSONAL_ORGANIZATION_ID,
      runner_id: "runner-a", provider: "codex", source_kind: "default_home", source_account_id: null, grant_id: message.profileGrantId,
      destination_account_id: "work-1a2b3c4d", destination_profile_id: PROFILE, status: "imported", result_code: null,
      authorized_by: "user-1", authorized_role: "owner", created_at: 100, completed_at: 100,
    });
    const grant = f.db.getProviderProfileGrant(message.profileGrantId);
    assert.equal(grant?.status, "pending");
    assert.equal(grant?.grantedRole, "owner");
    reconcileProviderProfileGrants(f.db, "runner-a", [{ ...codexAccount("work-1a2b3c4d", "Work"), profile: { id: PROFILE, access: "granted" } }], 101);
    assert.equal(f.db.getProviderProfileGrant(message.profileGrantId)?.status, "active");
  } finally { await f.close(); }
});

test("a configured account source is named by its id and must be confirmed by its label", async () => {
  const f = await fixture();
  try {
    const mismatch = await f.app.inject({ method: "POST", url: IMPORT, payload: body({ source: { kind: "account", accountId: "legacy" } }) });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.json().code, "CONFIRMATION_MISMATCH");
    const ok = await f.app.inject({ method: "POST", url: IMPORT, payload: body({ source: { kind: "account", accountId: "legacy" },
      confirmation: { acknowledgeCredentialImport: true, sourceLabel: "Legacy Codex", destinationLabel: "Work" } }) });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.deepEqual((f.sent[0] as { source: unknown }).source, { kind: "account", accountId: "legacy" });
    assert.equal(importsOf(f.db)[0]!.source_account_id, "legacy");
    const foreign = await f.app.inject({ method: "POST", url: IMPORT, payload: body({ source: { kind: "account", accountId: "claude" },
      confirmation: { acknowledgeCredentialImport: true, sourceLabel: "claude", destinationLabel: "Work" } }) });
    assert.equal(foreign.json().code, "SOURCE_FOREIGN");
    assert.equal(f.sent.length, 1);
  } finally { await f.close(); }
});

test("members, other organizations' Owners, and callers without a person are refused", async () => {
  const f = await fixture();
  try {
    for (const caller of [principal("operator"), principal("viewer"), null]) {
      f.as(caller);
      assert.equal((await f.app.inject({ method: "POST", url: IMPORT, payload: body() })).statusCode, 403);
    }
    // canAccessRunner confines Owners and Admins to the runner's organization.
    f.as(principal("owner", "org-other"));
    assert.equal((await f.app.inject({ method: "POST", url: IMPORT, payload: body() })).statusCode, 404);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(importsOf(f.db), []);
  } finally { await f.close(); }
});

test("older runners and runners without the capability never receive an import", async () => {
  for (const options of [{ protocolVersion: 259 }, { runtime: null }, { runtime: { dataDir: "/d", worktreeRoot: "/w", maxConcurrentSessions: 1,
    providerCredentialImport: { version: 1, providers: ["claude"] } as never } }]) {
    const f = await fixture(options);
    try {
      const response = await f.app.inject({ method: "POST", url: IMPORT, payload: body() });
      assert.equal(response.statusCode, 409, JSON.stringify(options));
      assert.equal(f.sent.length, 0);
      assert.deepEqual(importsOf(f.db), []);
    } finally { await f.close(); }
  }
});

test("a refused import spends its grant and records the code; a lost reply leaves the grant pending", async () => {
  const f = await fixture({ handler: (_runnerId, message) => ({ type: "import_provider_credential_result",
    requestId: (message as { requestId: string }).requestId, ok: false, code: "SOURCE_UNSUPPORTED", error: "Only a Codex sign-in that uses an API key can be copied." }) });
  try {
    const refused = await f.app.inject({ method: "POST", url: IMPORT, payload: body() });
    assert.equal(refused.statusCode, 409);
    assert.deepEqual(refused.json(), { error: "Only a Codex sign-in that uses an API key can be copied.", code: "SOURCE_UNSUPPORTED" });
    const grantId = (f.sent[0] as { profileGrantId: string }).profileGrantId;
    assert.equal(f.db.getProviderProfileGrant(grantId)?.status, "revoked");
    assert.deepEqual([importsOf(f.db)[0]!.status, importsOf(f.db)[0]!.result_code], ["refused", "SOURCE_UNSUPPORTED"]);

    f.setHandler(() => { throw new Error("runner request timed out"); });
    assert.equal((await f.app.inject({ method: "POST", url: IMPORT, payload: body({ label: "Second",
      confirmation: { acknowledgeCredentialImport: true, sourceLabel: DEFAULT_CODEX_SIGN_IN_LABEL, destinationLabel: "Second" } }) })).statusCode, 504);
    const lost = (f.sent[1] as { profileGrantId: string }).profileGrantId;
    assert.equal(f.db.getProviderProfileGrant(lost)?.status, "pending");
    assert.equal(importsOf(f.db)[1]!.status, "unknown");
  } finally { await f.close(); }
});

test("the confirmation must acknowledge the import and name the new profile exactly", () => {
  assert.equal(parseProviderCredentialImport(body()).ok, true);
  for (const value of [
    body({ provider: "claude" }),
    body({ label: " " }),
    body({ source: { kind: "path", path: "/home/user/.codex" } }),
    body({ source: { kind: "default_home", path: "/home/user/.codex" } }),
    body({ source: { kind: "account", accountId: "../x" } }),
    body({ confirmation: { acknowledgeCredentialImport: false, sourceLabel: DEFAULT_CODEX_SIGN_IN_LABEL, destinationLabel: "Work" } }),
    body({ confirmation: { acknowledgeCredentialImport: true, sourceLabel: DEFAULT_CODEX_SIGN_IN_LABEL, destinationLabel: "Other" } }),
    body({ confirmation: undefined }),
    null, [],
  ]) assert.equal(parseProviderCredentialImport(value).ok, false, JSON.stringify(value));
});
