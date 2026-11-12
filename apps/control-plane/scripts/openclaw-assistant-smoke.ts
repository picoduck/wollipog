/** Real OpenClaw client + production Assistant routes + isolated SQLite.
 * No provider, Discord, remote host or runner execution is implied by this test.
 */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ControlPlaneDb } from "../src/db.js";
import { createAssistantOperations, registerAssistantRoutes } from "../src/assistant-routes.js";
import { Hub } from "../src/hub.js";
import { SessionsService } from "../src/sessions.js";
import { registerAssistantSessionOperations } from "../src/assistant-session-operations.js";
import { assistantRequestDigest } from "../src/assistant-command-receipts.js";
import { ManagementMutations } from "../src/assistant-management-command.js";
import { registerAssistantSkills } from "../src/assistant-skills.js";
import { makeSkillsSyncPusher } from "../src/skills-route.js";
import { PROTOCOL_VERSION, type RunnerMetadata, type ControlPlaneToRunner } from "@wollipog/protocol";
import { checkOpenClawVersion, isConnectionRefusal, OpenClawSetupError, runOpenClaw, writeIsolatedProfile } from "../../../scripts/openclaw-assistant.mjs";

const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary)) throw new Error("Pass the absolute OpenClaw executable path. No runtime is installed automatically.");
const scratch = await mkdtemp(path.join(tmpdir(), "wollipog-openclaw-smoke-"));
const instances: Awaited<ReturnType<typeof start>>[] = [];

async function start(name: string, previous?: { issued: {token: string; connection: {id: string}}; port: number; transport: {sent: ControlPlaneToRunner[]; uncertain: boolean} }) {
  const db = ControlPlaneDb.open(path.join(scratch, `${name}.sqlite`));
  const app = Fastify({ logger: false });
  const responseCodes: number[] = [];
  app.addHook("onResponse", async (_request, reply) => { responseCodes.push(reply.statusCode); });
  try {
    const local = db.localIdentityContext();
    const owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
    // Test-only issuance, never a live owner grant or a copied session credential.
    const issued = previous?.issued ?? db.assistantConnections.create(owner, name, { operations: "all", projects: "all" });
    const metadata: RunnerMetadata = { runnerId: "smoke-fixture", hostname: "fixture", os: "linux", version: "synthetic",
      agents: [{id: "fixture", name: "Simulated Agent", command: "inert", args: [], env: {}, driver: "acp", available: true,
        capabilities: {models: [{id: "fixture", default: true}], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true}}],
      workspaces: [{id: "fixture", name: "Simulated Workspace", path: "/synthetic/never-executed"}] };
    db.registerRunner(metadata, Date.now(), PROTOCOL_VERSION);
    const project = db.listProjects().find(item => item.name === "Smoke Fixture") ?? db.createProject({name: "Smoke Fixture"});
    const location = db.listProjects().find(item => item.id === project.id)!.locations[0] ?? db.addProjectLocation(project.id, {runnerId: metadata.runnerId, workspaceId: "fixture"});
    const transport = previous?.transport ?? {sent: [] as ControlPlaneToRunner[], uncertain: false};
    const hub = new Hub(db);
    hub.isRunnerOnline = () => true;
    hub.sendToRunner = (_id, command) => {
      transport.sent.push(command);
      if (transport.uncertain && command.type === "prompt_session") throw new Error("synthetic response loss after simulated acceptance");
      return true;
    };
    const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
    const operations = createAssistantOperations(db);
    const receipts = registerAssistantSessionOperations(operations, db, svc);
    const mutations = new ManagementMutations(receipts, db.instanceId(), assistantRequestDigest,
      id => db.assistantConnections.get(id)!, id => db.assistantConnections.destructiveConfirmation(id));
    registerAssistantSkills(operations, {db, hub, requestHuman: () => null, requestPrincipal: () => null,
      pushSkillsSync: makeSkillsSyncPusher({db, hub})}, mutations);
    registerAssistantRoutes(app, { db, operations, requestHuman: () => null });
    const address = await app.listen({ host: "127.0.0.1", port: previous?.port ?? 0 });
    let closed = false;
    return { db, app, issued, responseCodes, transport, location, port: Number(new URL(address).port), url: `${address}/assistant/mcp`,
      async close() { if (!closed) { closed = true; await app.close(); db.close(); } } };
  } catch (error) { await app.close(); db.close(); throw error; }
}

try {
  let alpha = await start("Alpha"); instances.push(alpha);
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

  // Exercise the installed OpenClaw client, not a replacement SDK or a model simulator.
  const installation = path.dirname(await realpath(binary));
  const call = async (name: string, args: unknown = {}, server = "wollipog-alpha") => {
    const request = path.join(profile.cwd, "native-call.json");
    await writeFile(request, JSON.stringify({server, name, arguments: args}), {mode: 0o600});
    const result = await runOpenClaw(process.execPath, [fileURLToPath(new URL("../../../scripts/openclaw-assistant-call.mjs", import.meta.url)), installation, request], profile, credentials);
    assert.equal(result.outcome, "exit", "Native runtime call must complete normally.");
    assert.equal(result.code, 0, `Native OpenClaw ${name} failed; raw diagnostics withheld.`);
    return JSON.parse(result.output);
  };
  assert.equal((await call("assistant_discover")).controlPlane.id, a.controlPlane.id);
  assert.equal((await call("assistant_discover", {}, "wollipog-beta")).controlPlane.id, b.controlPlane.id);
  const launchArgs = {commandId: "smoke-launch", locationId: alpha.location.id, agentId: "fixture", prompt: "Synthetic smoke task", useWorktree: false};
  const launch = await call("session_launch", launchArgs);
  assert.equal(launch.receipt.status, "succeeded");
  const sessionId = launch.sessionId;
  assert.equal(alpha.db.getSession(sessionId)?.parentSessionId, null);
  assert.ok(alpha.transport.sent.some(command => command.type === "start_session"));
  alpha.db.updateSessionStatus(sessionId, "idle", Date.now()); // Simulated runner state, not execution evidence.
  const promptArgs = {commandId: "smoke-follow-up", sessionId, text: "Synthetic follow-up"};
  const followUp = await call("session_prompt", promptArgs);
  assert.equal(followUp.receipt.status, "succeeded");
  assert.equal(followUp.receipt.operationId, promptArgs.commandId);
  const count = alpha.transport.sent.length;
  const duplicateFollowUp = await call("session_prompt", promptArgs);
  assert.deepEqual(duplicateFollowUp.receipt, followUp.receipt, "Duplicate follow-up must return the original succeeded receipt.");
  assert.equal(alpha.transport.sent.length, count, "Duplicate command must not redispatch.");
  alpha.db.appendEvent(sessionId, {kind: "agent_message", text: "Synthetic runner result", final: true}, Date.now());
  alpha.db.appendEvent(sessionId, {kind: "agent_response_completed"}, Date.now());
  alpha.db.updateSessionStatus(sessionId, "completed", Date.now());
  assert.equal((await call("session_get", {sessionId})).session.status, "completed");
  assert.ok((await call("session_messages", {sessionId})).events.some((event: {text?: string}) => event.text === "Synthetic runner result"));
  assert.equal((await call("command_get", {commandId: launchArgs.commandId})).receipt.resourceId, sessionId);
  assert.equal(alpha.db.raw().prepare("SELECT COUNT(*) AS n FROM assistant_work").get()!.n, 0, "Plain MCP must stay uncorrelated with Discord work.");

  // Real configuration writes in the disposable library; no assignment or deployment.
  const initialContent = "---\nname: smoke-only\ndescription: Synthetic configuration smoke\n---\nSynthetic version one.\n";
  const createSkill = await call("skill_create", {operationId: "smoke-skill-create", payload: {
    name: "smoke-only", files: [{path: "SKILL.md", encoding: "utf8", content: initialContent}],
  }});
  assert.equal(createSkill.receipt.status, "succeeded");
  const skillId = createSkill.result.skill.id;
  assert.equal(createSkill.receipt.resourceId, skillId);
  const originalSkill = await call("skill_get", {skillId});
  const updatedContent = initialContent.replace("version one", "version two");
  const configArgs = {skillId, operationId: "smoke-skill-version", expectedRevision: originalSkill.revision,
    payload: {files: [{path: "SKILL.md", encoding: "utf8", content: updatedContent}]}};
  const configuration = await call("skill_version_add", configArgs);
  assert.equal(configuration.receipt.status, "succeeded");
  assert.equal(configuration.receipt.operationId, configArgs.operationId);
  assert.equal(configuration.receipt.resourceId, skillId);
  assert.notEqual(configuration.result.revision, originalSkill.revision);
  assert.deepEqual((await call("skill_version_add", configArgs)).receipt, configuration.receipt);
  assert.equal((await call("skill_versions", {skillId})).versions.length, 2, "A duplicate mutation must not create another immutable version.");
  assert.deepEqual((await call("command_get", {commandId: configArgs.operationId})).receipt, configuration.receipt);

  alpha.db.updateSessionStatus(sessionId, "idle", Date.now());
  alpha.transport.uncertain = true;
  const uncertainArgs = {commandId: "smoke-uncertain", sessionId, text: "Synthetic uncertain follow-up"};
  assert.equal((await call("session_prompt", uncertainArgs)).receipt.status, "uncertain");
  const uncertainCount = alpha.transport.sent.length;
  const previous = {issued: alpha.issued, port: alpha.port, transport: alpha.transport};
  await alpha.close();
  alpha = await start("Alpha", previous); instances.push(alpha);
  await probe("wollipog-alpha");
  assert.equal((await call("command_get", {commandId: uncertainArgs.commandId})).receipt.status, "uncertain");
  assert.equal((await call("session_prompt", uncertainArgs)).receipt.status, "uncertain");
  assert.equal(alpha.transport.sent.length, uncertainCount, "Reopen and duplicate uncertain command must not redispatch.");
  assert.equal((await call("command_get", {commandId: launchArgs.commandId})).receipt.resourceId, sessionId);
  assert.deepEqual((await call("command_get", {commandId: configArgs.operationId})).receipt, configuration.receipt);
  assert.equal((await call("skill_get", {skillId})).revision, configuration.result.revision);
  const persistedVersions = await call("skill_versions", {skillId});
  assert.equal(persistedVersions.versions.length, 2);
  const persistedVersion = await call("skill_version_get", {skillId, versionId: configuration.result.version.id});
  assert.ok(JSON.stringify(persistedVersion).includes("Synthetic version two."), "Configuration content must persist across control-plane reopen.");
  assert.equal(alpha.db.listSkillAssignments(skillId).length, 0, "This smoke must not deploy the fixture skill.");
  console.log("PASS REAL installed OpenClaw MCP runtime: launch, follow-up, status, transcript/result reads and durable receipt reconciliation after control-plane reopen. MOCKED runner dispatch, result and response loss; no model execution.");
  console.log("PASS REAL installed OpenClaw MCP runtime and SQLite: skill configuration creation/version mutation, readback and receipt deduplication survive control-plane reopen. No skill assignment or runner deployment.");

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
  console.log("PENDING acceptance environment: model, Discord, remote TLS/host and SSH execution remain unverified.");
} catch (error) {
  if (error instanceof OpenClawSetupError) console.error(error.message);
  console.error("FAIL OpenClaw Assistant smoke test. Raw diagnostics are withheld to protect credentials. Check the isolated runtime version, transport contract and local networking; no mutation should be blindly replayed.");
  process.exitCode ||= 1;
} finally {
  for (const instance of instances) await instance.close();
  await rm(scratch, { recursive: true, force: true });
}
