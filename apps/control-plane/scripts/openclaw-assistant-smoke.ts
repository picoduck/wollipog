/** Real OpenClaw client + production Assistant routes + isolated SQLite.
 * No provider, Discord, remote host or runner execution is implied by this test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ControlPlaneDb } from "../src/db.js";
import { createAssistantOperations, registerAssistantRoutes } from "../src/assistant-routes.js";
import { checkOpenClawVersion, isConnectionRefusal, OpenClawSetupError, runOpenClaw, writeIsolatedProfile } from "../../../scripts/openclaw-assistant.mjs";

const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary)) throw new Error("Pass the absolute OpenClaw executable path. No runtime is installed automatically.");
const scratch = await mkdtemp(path.join(tmpdir(), "wollipog-openclaw-smoke-"));
const instances: Awaited<ReturnType<typeof start>>[] = [];

async function start(name: string) {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify({ logger: false });
  const responseCodes: number[] = [];
  app.addHook("onResponse", async (_request, reply) => { responseCodes.push(reply.statusCode); });
  try {
    const local = db.localIdentityContext();
    const owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
    // Test-only issuance, never a live owner grant or a copied session credential.
    const issued = db.assistantConnections.create(owner, name, { operations: "all", projects: "all" });
    const operations = createAssistantOperations(db);
    registerAssistantRoutes(app, { db, operations, requestHuman: () => null });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    return { db, app, issued, responseCodes, url: `${address}/assistant/mcp` };
  } catch (error) { await app.close(); db.close(); throw error; }
}

try {
  const alpha = await start("Alpha"); instances.push(alpha);
  const beta = await start("Beta"); instances.push(beta);
  const profile = await writeIsolatedProfile(path.join(scratch, "profile"), [
    { name: "wollipog-alpha", url: alpha.url, tokenEnv: "WOLLIPOG_ALPHA_TOKEN" },
    { name: "wollipog-beta", url: beta.url, tokenEnv: "WOLLIPOG_BETA_TOKEN" },
  ]);
  const credentials = { WOLLIPOG_ALPHA_TOKEN: alpha.issued.token, WOLLIPOG_BETA_TOKEN: beta.issued.token };
  const version = await checkOpenClawVersion(binary, profile);
  const probe = async (name: string, success = true) => {
    const result = await runOpenClaw(binary, ["mcp", "probe", name, "--json"], profile, credentials);
    assert.equal(result.outcome, "exit", "A timeout, signal or output-limit failure is not transport evidence.");
    assert.equal(result.code === 0, success, `OpenClaw probe ${name}: unexpected outcome (raw diagnostics withheld).`);
    if (success) {
      const report = JSON.parse(result.output);
      assert.deepEqual(report.diagnostics, []);
      assert.ok(report.tools.includes(`${name}__assistant_discover`), "Named tool discovery must preserve routing.");
    }
    return result;
  };
  await probe("wollipog-alpha");
  await probe("wollipog-beta");
  console.log(`PASS REAL OpenClaw ${version}: authenticated discovery through two independently named loopback control planes.`);

  // Explicit calls verify the identity behind each named endpoint, without a model.
  const discover = async (instance: typeof alpha, token: string) => {
    const response = await fetch(instance.url, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "assistant_discover", arguments: {} } }) });
    assert.equal(response.status, 200);
    const rpc = await response.json() as { result: { content: { text: string }[] } };
    return JSON.parse(rpc.result.content[0]!.text);
  };
  const a = await discover(alpha, credentials.WOLLIPOG_ALPHA_TOKEN);
  const b = await discover(beta, credentials.WOLLIPOG_BETA_TOKEN);
  assert.equal(a.controlPlane.id, alpha.db.instanceId());
  assert.equal(b.controlPlane.id, beta.db.instanceId());
  assert.notEqual(a.controlPlane.id, b.controlPlane.id);
  assert.equal(a.connection.id, alpha.issued.connection.id);
  assert.equal(b.connection.id, beta.issued.connection.id);
  console.log("PASS REAL HTTP operation routing: discovery identities match the selected control plane and connection. No model routing exercised.");

  const rotated = alpha.db.assistantConnections.rotate(alpha.issued.connection.id);
  alpha.responseCodes.length = 0;
  await probe("wollipog-alpha", false);
  assert.ok(alpha.responseCodes.includes(401), "Rotation refusal must reach the real Assistant endpoint.");
  credentials.WOLLIPOG_ALPHA_TOKEN = rotated;
  await probe("wollipog-alpha");
  alpha.db.assistantConnections.revoke(alpha.issued.connection.id);
  alpha.responseCodes.length = 0;
  await probe("wollipog-alpha", false);
  assert.ok(alpha.responseCodes.includes(401), "Revocation refusal must reach the real Assistant endpoint.");
  await probe("wollipog-beta");
  console.log("PASS REAL OpenClaw: old credential refused after rotation, replacement accepted, revoked credential refused, second connection unaffected.");

  const incompatible = await fetch(beta.url, { method: "POST", headers: {
    authorization: `Bearer ${credentials.WOLLIPOG_BETA_TOKEN}`, "content-type": "application/json", "mcp-protocol-version": "unsupported",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(incompatible.status, 400);
  assert.match((await incompatible.json() as { error: string }).error, /Unsupported MCP version/);
  await beta.app.close();
  assert.ok(isConnectionRefusal(await probe("wollipog-beta", false), "wollipog-beta"), "Unavailable-peer evidence requires a named ECONNREFUSED diagnostic.");
  console.log("PASS REAL HTTP incompatible-protocol refusal; REAL OpenClaw unavailable-control-plane refusal.");
  console.log("PENDING: session launch, follow-up, status/result retrieval, configuration mutation and receipt reconciliation await #4464/#4465 contracts. Model, Discord, remote TLS/host and SSH evidence remain unverified.");
} catch (error) {
  if (error instanceof OpenClawSetupError) console.error(error.message);
  console.error("FAIL OpenClaw Assistant smoke test. Raw diagnostics are withheld to protect credentials. Check the isolated runtime version, transport contract and local networking; no mutation should be blindly replayed.");
  process.exitCode ||= 1;
} finally {
  for (const instance of instances) { await instance.app.close(); instance.db.close(); }
  await rm(scratch, { recursive: true, force: true });
}
