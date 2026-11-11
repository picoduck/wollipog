import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
// Runs only in a child process with a new fixture database. Never import the hosting instance.
const root = mkdtempSync(join(tmpdir(), "owner-parity-"));
const listener = createServer();
await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = (listener.address() as {port: number}).port;
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
for (const key of Object.keys(process.env)) if (key.startsWith("CONTROL_PLANE_")) delete process.env[key];
Object.assign(process.env, {CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
  CONTROL_PLANE_DB: join(root, "fixture.db"), CONTROL_PLANE_ARTIFACT_DIR: join(root, "artifacts"),
  CONTROL_PLANE_TOKEN: "owner-parity-fixture-token", CONTROL_PLANE_USAGE_PRICING_URL: "off"});
const {app, ownerManagementInventory, assistantOperations} = await import("../src/index.js");
await app.ready();
const connection = {id: "inventory-fixture", name: "Fixture", ownerUserId: "fixture", organizationId: "fixture",
  revision: 1, revoked: false, grant: {operations: "all" as const, projects: "all" as const}};
const tools = assistantOperations.list(connection).map(op => op.name).sort();
console.log("OWNER_PARITY_SNAPSHOT " + JSON.stringify({routes: ownerManagementInventory.list(), tools}));
if (process.argv.includes("--verify-runtime-identity")) {
  // This is the same brand-new fixture DB as the isolated production process, never hosting
  // state. Read back through real HTTP/MCP to prove the owner has access but no session identity.
  const {ControlPlaneDb} = await import("../src/db.js");
  const {PROTOCOL_VERSION} = await import("@wollipog/protocol");
  const {AssistantCommandReceipts} = await import("../src/assistant-command-receipts.js");
  const {hashToken} = await import("../src/auth.js");
  const fixture = ControlPlaneDb.open(join(root, "fixture.db"));
  try {
    const local = fixture.localIdentityContext(), owner = fixture.operatingHumanPrincipal(local.userId, local.organizationId)!;
    fixture.createDevice({id: "runtime-owner-device", name: "Runtime Owner Fixture", tokenHash: hashToken("runtime-owner-fixture-token"), now: Date.now()});
    fixture.registerRunner({runnerId: "runtime-fixture", hostname: "fixture", os: "linux", version: "fixture", agents: [], workspaces: []}, Date.now(), PROTOCOL_VERSION);
    fixture.createSession({id: "s_runtime_fence", runnerId: "runtime-fixture", workspaceId: null, agentId: null,
      title: "Fixture", driver: "acp", useWorktree: false, config: {}, now: Date.now()});
    fixture.updateSessionStatus("s_runtime_fence", "running", Date.now());
    const issued = fixture.assistantConnections.create(owner, "Runtime Fence Fixture", {operations: "all", projects: "all"});
    const ownerHeaders = {authorization: "Bearer runtime-owner-fixture-token"};
    let ownerRead;
    for (let attempt = 0; attempt < 500; attempt++) {
      ownerRead = await app.inject({method: "GET", url: "/api/sessions/s_runtime_fence", headers: ownerHeaders});
      if (ownerRead.statusCode !== 503) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(ownerRead?.statusCode, 200);
    const writes = [
      {path: "pull-request-watch", name: "session_watch", commandId: "forged-watch", body: {repository: "fixture/repo", number: 7, headSha: "a".repeat(40)}},
      {path: "waits", name: "session_wait_report", commandId: "forged-progress", body: {waitId: "wait_fixture0001", kind: "wait_pull_request", state: "active",
        target: {kind: "pull_request", repository: "fixture/repo", number: 7}, elapsedMs: 0, remainingMs: 10000, intervalMs: 1000}},
    ];
    const receipts = new AssistantCommandReceipts(fixture.raw());
    for (const write of writes) {
      const ownerResponse = await app.inject({method: "POST", url: `/api/sessions/s_runtime_fence/${write.path}`, headers: ownerHeaders, payload: write.body});
      assert.equal(ownerResponse.statusCode, 403);
      assert.equal(ownerResponse.json().error, "a matching session credential is required");
      const response = await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${issued.token}`},
        payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: write.name,
          arguments: {sessionId: "s_runtime_fence", commandId: write.commandId, ...(write.path === "waits" ? {report: write.body} : write.body)}}}});
      assert.equal(response.json().result.isError, true);
      assert.equal(receipts.get(issued.connection.id, write.commandId), null);
    }
    const read = await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${issued.token}`},
      payload: {jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "session_watch_get", arguments: {sessionId: "s_runtime_fence"}}}});
    const state = JSON.parse(read.json().result.content[0].text);
    assert.equal(state.watch ?? null, null);
    assert.deepEqual(state.waits, []);
    console.log("OWNER_RUNTIME_IDENTITY_FENCES " + JSON.stringify({ownerReads: 1, ownerWritesDenied: 2, assistantWritesDenied: 2, effects: 0}));
  } catch {
    console.error("Production session-runtime identity fence regression failed; fixture request bodies withheld.");
    process.exitCode = 1;
  } finally {fixture.close();}
}
if (process.argv.includes("--require-complete")) {
  const manifest = JSON.parse(readFileSync(new URL("../../../docs/assistant-owner-capabilities.json", import.meta.url), "utf8"));
  const coverage = Object.fromEntries(Object.entries(manifest).filter(([, entry]) => {
    const value = entry as Record<string, unknown>;
    return "tools" in value || "exclusion" in value;
  }));
  try {
    ownerManagementInventory.assertComplete(coverage as Parameters<typeof ownerManagementInventory.assertComplete>[0], new Set(tools));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Owner parity verification failed.");
    process.exitCode = 1;
  }
}
await app.close();
rmSync(root, {recursive: true, force: true});
process.exit(process.exitCode ?? 0);
