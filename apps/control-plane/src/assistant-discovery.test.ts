import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { ControlPlaneDb } from "./db.js";
import type { AssistantGrant } from "./assistant-connections.js";
import { ASSISTANT_DISCOVERY_MAX_BYTES, createAssistantOperations } from "./assistant-routes.js";
import { registerAssistantSessionOperations, SESSION_LAUNCH_CONFIG_FIELDS } from "./assistant-session-operations.js";
import { WOLLIPOG_ASSISTANT_SKILL } from "./assistant-skill.js";
import type { SessionsService } from "./sessions.js";

/** A connection over a fixture inventory far larger than any real one: 300 operations with long
 * descriptions and ~3 KB schemas, so every form of discovery must page. */
function fixture(grant: AssistantGrant = { operations: "all", projects: "all" }) {
  const db = ControlPlaneDb.open(":memory:"), identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const operations = createAssistantOperations(db);
  registerAssistantSessionOperations(operations, db, {} as SessionsService);
  for (let index = 0; index < 300; index++) {
    const name = `fixture_${String(index).padStart(3, "0")}`;
    operations.register({ name, description: `Fixture operation ${index}. ${"Describes what it does. ".repeat(8)}`,
      inputSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: 30 }, (_, field) =>
        [`field${field}`, { type: "string", description: `Field ${field} of ${name}, described at some length.` }])) },
      metadata: true, resolveTarget: () => ({ kind: "fixture", id: name }), ownerCanAccess: () => true, execute: () => ({}) });
  }
  const issued = db.assistantConnections.create(owner, "Discovery", grant);
  const credential = db.assistantConnections.authenticate(issued.token)!;
  const discover = async (args: unknown = {}) => {
    const text = JSON.stringify(await operations.call(credential, "assistant_discover", args));
    const escapedBytes = Buffer.byteLength(JSON.stringify(text)) - 2;
    assert.ok(escapedBytes <= ASSISTANT_DISCOVERY_MAX_BYTES, `discovery result of ${escapedBytes} escaped bytes`);
    return JSON.parse(text);
  };
  return { db, operations, connection: issued.connection, discover };
}

test("a Full Access discovery pages names and descriptions within the bound and lists every operation once", async () => {
  const { operations, connection, discover } = fixture();
  const first = await discover();
  assert.equal(first.skill.name, "wollipog");
  assert.equal(first.connection.id, connection.id);
  assert.deepEqual(first.connection.grant, connection.grant);
  assert.match(first.inputSchemas, /"operations"/u);
  assert.ok(first.operations.every((operation: object) => !("inputSchema" in operation)));
  const names: string[] = first.operations.map((operation: { name: string }) => operation.name);
  let cursor: string | undefined = first.nextCursor;
  assert.ok(cursor, "a 300-operation inventory needs more than one page");
  while (cursor) {
    const page = await discover({ cursor });
    assert.equal(page.skill, undefined, "later pages carry only the list");
    names.push(...page.operations.map((operation: { name: string }) => operation.name));
    cursor = page.nextCursor;
  }
  assert.deepEqual(names, operations.list(connection).map(operation => operation.name));
});

test("the guide stays discoverable when it cannot fit beside the connection's grant", async () => {
  const projects = Array.from({ length: 45 }, (_, index) => `project_${String(index).padStart(120, "0")}`);
  const { connection, discover } = fixture({ operations: ["assistant_discover", "fixture_001"], projects });
  const first = await discover();
  assert.deepEqual(first.connection, connection);
  assert.equal(first.skill, undefined);
  assert.match(first.skillHint, /\{"skill": true\}/u);
  assert.deepEqual(await discover({ skill: true }), { skill: WOLLIPOG_ASSISTANT_SKILL });
});

test("an oversized saved grant leaves identity and grant-filtered discovery available", async () => {
  const projects = Array.from({ length: 500 }, (_, index) => `project_${String(index).padStart(120, "0")}`);
  const { connection, discover } = fixture({ operations: ["assistant_discover", "fixture_001"], projects });
  const first = await discover();
  assert.equal(first.connection.id, connection.id);
  assert.equal(first.connection.revision, connection.revision);
  assert.equal(first.connection.grant, undefined);
  assert.match(first.grantNotice, /exact grant exceeds the tool-result limit/u);
  assert.deepEqual(first.operations.map((operation: { name: string }) => operation.name), ["assistant_discover", "fixture_001"]);
});

test("any granted operation's full schema is discoverable, in bounded batches", async () => {
  const { operations, connection, discover } = fixture();
  const expected = new Map(operations.list(connection).map(operation => [operation.name, operation.inputSchema]));
  const names = [...expected.keys()].slice(0, 64);
  const first = await discover({ operations: names });
  assert.ok(first.remaining.length > 0, "64 large schemas do not fit one result");
  const received = [...first.operations];
  let remaining: string[] = first.remaining;
  while (remaining.length) {
    const next = await discover({ operations: remaining });
    received.push(...next.operations);
    remaining = next.remaining ?? [];
  }
  assert.deepEqual(received.map((operation: { name: string }) => operation.name), names);
  for (const operation of received) assert.deepEqual(operation.inputSchema, expected.get(operation.name));
});

test("a schema larger than the whole page is refused without producing a stuck continuation", async () => {
  const { operations, discover } = fixture();
  operations.register({
    name: "oversized_schema", description: "Fixture with an oversized schema.",
    inputSchema: { type: "object", description: '"'.repeat(3_000) },
    metadata: true, resolveTarget: () => ({ kind: "fixture", id: "oversized_schema" }),
    ownerCanAccess: () => true, execute: () => ({}),
  });
  await assert.rejects(discover({ operations: ["oversized_schema"] }), /schema does not fit/u);
});

test("discovery stays filtered by the connection's grant", async () => {
  const { discover } = fixture({ operations: ["assistant_discover", "session_launch", "fixture_001"], projects: "all" });
  const listed = await discover();
  assert.deepEqual(listed.operations.map((operation: { name: string }) => operation.name), ["assistant_discover", "session_launch", "fixture_001"]);
  assert.equal(listed.nextCursor, undefined);
  const schemas = await discover({ operations: ["fixture_001", "fixture_002", "not_registered"] });
  assert.deepEqual(schemas.operations.map((operation: { name: string }) => operation.name), ["fixture_001"]);
  assert.deepEqual(schemas.unavailable, ["fixture_002", "not_registered"]);
  await assert.rejects(discover({ cursor: "fixture_002" }), /no longer names a granted operation/u);
});

test("discovery refuses malformed arguments", async () => {
  const { discover } = fixture();
  await assert.rejects(discover({ operations: [] }), /1 to 64 operation names/u);
  await assert.rejects(discover({ operations: Array.from({ length: 65 }, (_, index) => `fixture_${index}`) }), /1 to 64/u);
  await assert.rejects(discover({ operations: ["session_launch"], cursor: "session_launch" }), /not both/u);
  await assert.rejects(discover({ schemas: true }), /only operations, cursor or skill/u);
  await assert.rejects(discover({ skill: false }), /Set skill to true/u);
  await assert.rejects(discover({ skill: true, cursor: "session_launch" }), /Send skill by itself/u);
  // Unknown names are echoed in `unavailable`, so a long one is refused rather than returned.
  await assert.rejects(discover({ operations: ["x".repeat(60_000)] }), /at most 32 characters/u);
  await assert.rejects(discover({ operations: ["x".repeat(33)] }), /at most 32 characters/u);
  await assert.rejects(discover({ cursor: "x".repeat(60_000) }), /nextCursor of an earlier result/u);
  // The most a request can echo still fits the bound (`discover` asserts it).
  const longest = Array.from({ length: 64 }, (_, index) => `z${String(index).padStart(31, "0")}`);
  assert.deepEqual((await discover({ operations: longest })).unavailable, longest);
});

test("session_launch's discovered config lists every SessionConfig field with its type", async () => {
  const { discover } = fixture();
  const [launch] = (await discover({ operations: ["session_launch"] })).operations;
  const config = launch.inputSchema.properties.config;
  assert.equal(config.type, "object");
  assert.equal(config.additionalProperties, false);
  assert.deepEqual(config.properties, SESSION_LAUNCH_CONFIG_FIELDS);
  assert.equal(config.properties.costBudgetUsd.type, "number");
  assert.equal(config.properties.model.type, "string");
  assert.equal(config.properties.effort.type, "string");
  // The mapped type catches drift at typecheck; this reads the protocol source as well, so a
  // field added to SessionConfig cannot ship without its schema.
  const source = readFileSync(new URL("../../../packages/protocol/src/index.ts", import.meta.url), "utf8");
  const body = /export interface SessionConfig \{([\s\S]*?)\n\}/u.exec(source)?.[1];
  assert.ok(body, "SessionConfig must stay an interface in packages/protocol/src/index.ts");
  const fields = [...body.matchAll(/^\s+(\w+)\?:/gmu)].map(match => match[1]).sort();
  assert.deepEqual(Object.keys(SESSION_LAUNCH_CONFIG_FIELDS).sort(), fields);
});

test("the production inventory's discovery fits the bound in every form", { timeout: 60_000 }, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url)), "--verify-discovery-size"],
    { encoding: "utf8", timeout: 55_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.status, 0, "Production discovery verification failed; raw logs withheld.");
  const line = child.stdout.split("\n").find(candidate => candidate.startsWith("ASSISTANT_DISCOVERY_SIZE "));
  assert.ok(line);
  const size = JSON.parse(line.slice("ASSISTANT_DISCOVERY_SIZE ".length)) as { operations: number; listPages: number[]; largestSchema: number; schemaPages: number[]; skillPage: number };
  assert.ok(size.operations > 100, "the snapshot must read the full production inventory");
  // Codex 0.169.1 configures 10,000 bytes for unknown models in models-manager/src/model_info.rs.
  // Assert on the actual response, including double-escaped schema text and the JSON-RPC wrapper.
  for (const bytes of [...size.listPages, size.largestSchema, ...size.schemaPages, size.skillPage]) {
    assert.ok(bytes <= 9_100, `MCP response of ${bytes} bytes must leave room below Codex's 10,000-byte fallback`);
  }
});
