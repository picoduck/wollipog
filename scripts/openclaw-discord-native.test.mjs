import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { executeNativeCommand, nativeCommandIdentity, parseNativeCommand, readNativeSettings,
  registerNativeCommand, selectNativeBinding } from "../integrations/openclaw-discord/index.mjs";
import { ControlPlaneDb } from "../apps/control-plane/src/db.ts";
import { Hub } from "../apps/control-plane/src/hub.ts";
import { SessionsService } from "../apps/control-plane/src/sessions.ts";
import { createAssistantManagement } from "../apps/control-plane/src/assistant-composition.ts";
import { registerAssistantRoutes } from "../apps/control-plane/src/assistant-routes.ts";
import { registerAssistantDiscordIngress } from "../apps/control-plane/src/assistant-discord-ingress.ts";
import { PROTOCOL_VERSION } from "../packages/protocol/src/index.ts";
const Fastify = createRequire(new URL("../apps/control-plane/package.json", import.meta.url))("fastify");

const env = {NATIVE_ASSISTANT_FIXTURE: `wollipoga_${"a".repeat(43)}`, NATIVE_CONNECTOR_FIXTURE: `wollipogc_${"c".repeat(43)}`};
const settings = {version: 1, connections: [{name: "local", origin: "http://127.0.0.1", controlPlaneId: "plane-fixture", connectionId: "connection-fixture",
  assistantTokenEnv: "NATIVE_ASSISTANT_FIXTURE", launchTargets: {repo: {locationId: "location-fixture", agentId: "worker-fixture"}},
  bindings: [{bindingId: "binding-fixture", requesterId: "requester-fixture", accountId: "account-fixture", destination: "channel:123",
    agentId: "assistant-fixture", connectorTokenEnv: "NATIVE_CONNECTOR_FIXTURE"}]}]};
const context = {channel: "discord", isAuthorizedSender: true, senderId: "requester-fixture", accountId: "account-fixture", agentId: "assistant-fixture", to: "discord:channel:123",
  args: "launch local job-1 repo Synthetic task"};
const api = {pluginConfig: {}, runtime: {version: "2026.11.3"}, config: {tools: {profile: "minimal"}}};
const discovery = selected => new Response(JSON.stringify({result: {content: [{type: "text", text: JSON.stringify({controlPlane: {id: selected.controlPlaneId}, connection: {id: selected.connectionId}})}]}}), {headers: {"content-type": "application/json"}});

test("native command parser and host-bound selection reject forged/missing sender, account, conversation and connection facts", () => {
  assert.equal(parseNativeCommand(context.args).text, "Synthetic task");
  for (const body of ["", "launch local id repo", "status local id extra", "launch local bad/id repo task"]) assert.throws(() => parseNativeCommand(body));
  const selected = selectNativeBinding(settings, context, "local", env);
  assert.equal(selected.binding.bindingId, "binding-fixture");
  assert.equal(nativeCommandIdentity(selected, "job-1"), nativeCommandIdentity(selected, "job-1"));
  for (const replacement of [{channel: "webchat"}, {isAuthorizedSender: false}, {senderId: "other"}, {accountId: undefined},
    {agentId: "other"}, {to: "channel:456"}, {to: "123"}, {messageThreadId: "456"}, {messageThreadId: Number.MAX_SAFE_INTEGER + 1}]) {
    assert.throws(() => selectNativeBinding(settings, {...context, ...replacement}, "local", env));
  }
  assert.throws(() => selectNativeBinding(settings, context, "missing", env));
  const ambiguous = structuredClone(settings);
  ambiguous.connections[0].bindings.push({...ambiguous.connections[0].bindings[0]});
  assert.throws(() => selectNativeBinding(ambiguous, context, "local", env));
  const threadSettings = structuredClone(settings);
  threadSettings.connections[0].bindings[0].destination = "channel:456";
  assert.equal(selectNativeBinding(threadSettings, {...context, messageThreadId: "456", threadParentId: "123"}, "local", env).binding.destination, "channel:456");
});

test("private native configuration requires an isolated profile and an owner-only file outside model config", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-native-"));
  mkdirSync(join(root, "private"), {mode: 0o700});
  const configPath = join(root, "private", "native.json"), profile = "wollipog-native-fixture";
  writeFileSync(configPath, JSON.stringify(settings), {mode: 0o600});
  writeFileSync(join(root, "openclaw.json"), "{}", {mode: 0o600});
  const environment = {...env, OPENCLAW_PROFILE: profile, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: join(root, "openclaw.json")};
  try {
    assert.deepEqual(readNativeSettings({profile, configPath}, environment), settings);
    assert.throws(() => readNativeSettings({profile: "default", configPath}, environment));
    assert.throws(() => readNativeSettings({profile, configPath}, {...environment, OPENCLAW_PROFILE: "different"}));
    chmodSync(configPath, 0o644);
    assert.throws(() => readNativeSettings({profile, configPath}, environment));
    chmodSync(configPath, 0o600);
    writeFileSync(configPath, "x".repeat(64 * 1024 + 1));
    assert.throws(() => readNativeSettings({profile, configPath}, environment));
  } finally {rmSync(root, {recursive: true, force: true});}
});

test("native component verifies installation, reloads binding policy after discovery, and never retries an uncertain command", async () => {
  let commands = 0, loaded = settings;
  const request = async (_url, options) => {
    if (new URL(_url).pathname === "/assistant/mcp") return discovery(settings.connections[0]);
    commands++;
    assert.equal(options.headers["x-wollipog-connector-token"], env.NATIVE_CONNECTOR_FIXTURE);
    const command = JSON.parse(options.body);
    assert.equal("requesterId" in command, false);
    assert.equal(command.operation, "session_launch");
    assert.equal(command.arguments.locationId, "location-fixture");
    throw new Error("Synthetic uncertain transport");
  };
  const deps = {env, loadSettings: () => loaded, request};
  await assert.rejects(executeNativeCommand(api, context, deps));
  assert.equal(commands, 1);
  commands = 0;
  await assert.rejects(executeNativeCommand(api, context, {...deps, request: async () => discovery({...settings.connections[0], controlPlaneId: "wrong-plane"})}));
  assert.equal(commands, 0);
  await assert.rejects(executeNativeCommand(api, context, {...deps, request: async () => {
    loaded = {version: 1, connections: []};
    return discovery(settings.connections[0]);
  }}));
  assert.equal(commands, 0);
  let currentConfig = {tools: {profile: "minimal"}};
  const changingApi = {...api, runtime: {...api.runtime, config: {current: () => currentConfig}}};
  await assert.rejects(executeNativeCommand(changingApi, context, {...deps, loadSettings: () => settings, request: async () => {
    currentConfig = {tools: {profile: "full"}};
    return discovery(settings.connections[0]);
  }}), /dedicated_native_profile/);
  assert.equal(commands, 0, "a changed runtime tool policy cannot expose the connector between discovery and mutation");
  await assert.rejects(executeNativeCommand({...api, runtime: {version: "2026.11.4"}}, context, deps), /untested_host_version/);
  await assert.rejects(executeNativeCommand({...api, config: {tools: {profile: "full"}}}, context, deps), /dedicated_native_profile/);
  await assert.rejects(executeNativeCommand({...api, config: {tools: {profile: "minimal"}, mcp: {servers: {owner: {}}}}}, context, deps), /dedicated_native_profile/);
});

test("native command registrar bypasses the model and emits no keys or private HTTP errors", async () => {
  let command, toolRegistrations = 0;
  const logs = [];
  registerNativeCommand({...api, registerCommand(value) {command = value;}, registerTool() {toolRegistrations++;},
    logger: {warn(line) {logs.push(line);}}}, {env, loadSettings: () => settings, request: async () => {throw new Error(env.NATIVE_ASSISTANT_FIXTURE);}});
  assert.equal(command.requireAuth, true);
  assert.deepEqual(command.channels, ["discord"]);
  assert.equal(toolRegistrations, 0);
  const result = await command.handler(context);
  assert.equal(result.continueAgent, undefined);
  assert.ok(!JSON.stringify({result, logs}).includes(env.NATIVE_ASSISTANT_FIXTURE));
  assert.ok(!JSON.stringify({result, logs}).includes(env.NATIVE_CONNECTOR_FIXTURE));
});

test("native component over real HTTP composes with real session/origin/outbox services and deduplicates across component recreation", async () => {
  const db = ControlPlaneDb.open(":memory:"), app = Fastify();
  const local = db.localIdentityContext(), owner = db.operatingHumanPrincipal(local.userId, local.organizationId);
  db.registerRunner({runnerId: "runner-fixture", hostname: "fixture", os: "linux", version: "test", agents: [{id: "worker-fixture", name: "Worker",
    command: "fixture", args: [], env: {}, driver: "acp", available: true, capabilities: {models: [{id: "fixture", default: true}], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true}}],
    workspaces: [{id: "workspace-fixture", name: "Fixture", path: "/fixture"}]}, Date.now(), PROTOCOL_VERSION);
  const project = db.createProject({name: "Fixture"}), location = db.addProjectLocation(project.id, {runnerId: "runner-fixture", workspaceId: "workspace-fixture"});
  const issued = db.assistantConnections.create(owner, "Native Fixture", {operations: "all", projects: "all"});
  const binding = db.assistantWork.createBinding(owner, issued.connection.id, {requesterId: context.senderId, accountId: context.accountId, conversationId: "conversation-fixture",
    destination: "channel:123", agentId: context.agentId, sessionKey: "agent:assistant-fixture:discord:channel:123", projects: [project.id]});
  const hub = new Hub(db);
  let sends = 0;
  hub.isRunnerOnline = () => true;
  hub.sendToRunner = () => {sends++; return true;};
  const service = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
  const {operations, ingress} = createAssistantManagement(db, service);
  const credential = ingress.issue(owner, issued.connection.id, binding.id, ["session_launch", "session_prompt"]);
  registerAssistantRoutes(app, {db, operations, requestHuman: () => null});
  registerAssistantDiscordIngress(app, {db, ingress, requestHuman: () => null});
  db.createOutboundEventSubscription({subscriptionId: "subscription-native-fixture", callbackUrl: "http://127.0.0.1/hook", secret: "synthetic-fixture",
    scope: {kind: "assistant", connectionId: issued.connection.id}, eventKinds: ["session.created"], includeSessionName: false, includeQuestionTitle: false,
    actor: {kind: "human", id: owner.userId}, now: Date.now()});
  await app.listen({host: "127.0.0.1", port: 0});
  const address = app.server.address(), configured = structuredClone(settings);
  configured.connections[0].origin = `http://127.0.0.1:${address.port}`;
  configured.connections[0].controlPlaneId = db.instanceId();
  configured.connections[0].connectionId = issued.connection.id;
  configured.connections[0].bindings[0].bindingId = binding.id;
  configured.connections[0].launchTargets.repo.locationId = location.id;
  const secrets = {NATIVE_ASSISTANT_FIXTURE: issued.token, NATIVE_CONNECTOR_FIXTURE: credential.token};
  const deps = {env: secrets, loadSettings: () => configured};
  try {
    const result = await executeNativeCommand(api, context, deps);
    assert.equal(result.receipt.status, "succeeded", JSON.stringify(result));
    const sent = sends;
    assert.ok(sent > 0);
    const repeated = await executeNativeCommand({...api}, {...context}, {...deps});
    assert.deepEqual(repeated.receipt, result.receipt);
    assert.equal(sends, sent);
    const selected = selectNativeBinding(configured, context, "local", secrets);
    const work = db.assistantWork.get(issued.connection.id, nativeCommandIdentity(selected, "job-1", "work"));
    assert.equal(work.sessionId, result.sessionId);
    assert.equal(db.listOutboundEventDeliveries("subscription-native-fixture").length, 1);
    const status = await executeNativeCommand(api, {...context, args: "status local job-1"}, deps);
    assert.deepEqual(status.receipt, result.receipt);
    db.updateSessionStatus(result.sessionId, "idle", Date.now());
    const followup = await executeNativeCommand(api, {...context, args: "prompt local job-2 job-1 Synthetic follow-up"}, deps);
    assert.equal(followup.receipt.status, "succeeded", JSON.stringify(followup));
    assert.equal(db.assistantWork.forSession(result.sessionId).length, 1);
    db.assistantWork.revokeBinding(owner, issued.connection.id, binding.id);
    await assert.rejects(executeNativeCommand(api, {...context, args: "launch local job-3 repo Do not run"}, deps));
    assert.equal(db.listSessions().length, 1);
  } finally {await app.close(); db.close();}
});
