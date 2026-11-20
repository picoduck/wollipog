import type { FastifyInstance, FastifyRequest } from "fastify";
import { ASSISTANT_EVIDENCE_INSPECT, ASSISTANT_EVIDENCE_RELAY_ACK, ASSISTANT_EVIDENCE_RELAY_DELIVER } from "@wollipog/protocol";
import { ASSISTANT_EVIDENCE_ACKNOWLEDGEMENT } from "./assistant-decision-operations.js";
import { extractBearer } from "./auth.js";
import { PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import { assistantGrant, AssistantOperations, AssistantRefusal, AssistantConflict, ASSISTANT_OPERATION_NAME } from "./assistant-connections.js";
import { AssistantConnectionManagement } from "./assistant-connection-management.js";
import {ManagementUncertainOutcome} from "./assistant-management-command.js";
import { WOLLIPOG_ASSISTANT_SKILL } from "./assistant-skill.js";
export { assistantActivityTargetLabel } from "./assistant-connection-management.js";

/** Budget for the escaped MCP text payload. Codex's fallback model metadata limits tool output
 * to 10,000 bytes (#4727). Leave room for the surrounding MCP envelope and Codex's output header. */
export const ASSISTANT_DISCOVERY_MAX_BYTES = 9_000;
/** Most operation names one schema request may name. */
export const ASSISTANT_DISCOVERY_MAX_SCHEMA_NAMES = 64;
const SCHEMA_HINT = "Call assistant_discover with {\"operations\": [\"<name>\", ...]} for those operations' full input schemas.";
const SKILL_HINT = "Call assistant_discover with {\"skill\": true} for the full Wollipog Assistant guide.";
// MCP embeds the result JSON in a text string. Count escaping, excluding that string's outer quotes
// so array entries and reserved object fields can be counted separately.
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(JSON.stringify(value))) - 2;

/** Appends items to `base[key]` while the whole result stays within the bound.
 * Returns how many were taken. `reserve` holds room for a field the caller adds afterwards. */
function fill<T>(base: Record<string, unknown>, key: string, items: readonly T[], reserve: number): number {
  const list: T[] = [];
  base[key] = list;
  let size = bytes(base) + reserve;
  if (size > ASSISTANT_DISCOVERY_MAX_BYTES) throw new AssistantRefusal("Discovery metadata exceeds the tool-result limit.");
  for (const item of items) {
    const next = bytes(item) + (list.length ? 1 : 0);
    if (size + next > ASSISTANT_DISCOVERY_MAX_BYTES) break;
    list.push(item);
    size += next;
  }
  return list.length;
}

function discoveryArguments(args: unknown): {operations?: string[]; cursor?: string; skill?: true} {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new AssistantRefusal("Supply an object of tool arguments.");
  const {operations: names, cursor, skill, ...rest} = args as Record<string, unknown>;
  if (Object.keys(rest).length) throw new AssistantRefusal("assistant_discover accepts only operations, cursor or skill.");
  if (skill !== undefined) {
    if (skill !== true) throw new AssistantRefusal("Set skill to true to read the Wollipog Assistant guide.");
    if (names !== undefined || cursor !== undefined) throw new AssistantRefusal("Send skill by itself.");
    return {skill};
  }
  if (names !== undefined && cursor !== undefined) throw new AssistantRefusal("Send operations or cursor, not both.");
  if (cursor !== undefined && (typeof cursor !== "string" || !ASSISTANT_OPERATION_NAME.test(cursor))) throw new AssistantRefusal("cursor must be the nextCursor of an earlier result.");
  // Names are echoed in `unavailable`, so each must have a registered name's bounded shape.
  if (names !== undefined && (!Array.isArray(names) || !names.length || names.length > ASSISTANT_DISCOVERY_MAX_SCHEMA_NAMES ||
    names.some(name => typeof name !== "string" || !ASSISTANT_OPERATION_NAME.test(name)))) {
    throw new AssistantRefusal(`operations must list 1 to ${ASSISTANT_DISCOVERY_MAX_SCHEMA_NAMES} operation names, each lowercase letters, digits and underscores, at most 32 characters.`);
  }
  return {...(names ? {operations: [...new Set(names as string[])]} : {}), ...(cursor ? {cursor: cursor as string} : {})};
}

export function createAssistantOperations(db: ControlPlaneDb): AssistantOperations {
  const operations = new AssistantOperations(db.assistantConnections,
    (user, organization) => db.operatingHumanPrincipal(user, organization),
    (threadId) => db.assistantThreads.harnessChangeInProgress(threadId));
  operations.register({
    name: "assistant_discover",
    description: "Read this installation's identity, connection scope and operation names. Request full input schemas by name or the Assistant guide with skill.",
    inputSchema: { type: "object", properties: {
      operations: {type: "array", items: {type: "string", pattern: ASSISTANT_OPERATION_NAME.source}, minItems: 1, maxItems: ASSISTANT_DISCOVERY_MAX_SCHEMA_NAMES,
        description: "Granted operation names whose full input schemas to return. Request any listed in `remaining` again. Request `requestSeparately` by itself."},
      cursor: {type: "string", description: "An earlier result's nextCursor, to read the rest of the operation list."},
      skill: {type: "boolean", const: true, description: "Read the full Wollipog Assistant guide. Send this argument by itself."},
    }, additionalProperties: false }, metadata: true,
    resolveTarget: () => ({ kind: "control_plane", id: db.instanceId() }), ownerCanAccess: () => true,
    // Every form lists only what the connection's grant allows; it is shaped to fit one tool result.
    execute: (args, context) => {
      const request = discoveryArguments(args);
      if (request.skill) {
        const result = {skill: WOLLIPOG_ASSISTANT_SKILL};
        if (bytes(result) > ASSISTANT_DISCOVERY_MAX_BYTES) throw new AssistantRefusal("The Wollipog Assistant guide exceeds the tool-result limit.");
        return result;
      }
      const granted = operations.list(context.connection);
      if (request.operations) {
        const byName = new Map(granted.map(operation => [operation.name, operation]));
        const found = request.operations.filter(name => byName.has(name));
        const unavailable = request.operations.filter(name => !byName.has(name));
        const result: Record<string, unknown> = unavailable.length ? {unavailable} : {};
        const schemas = found.map(name => { const {description, inputSchema} = byName.get(name)!; return {name, description, inputSchema}; });
        const reserve = found.length > 1 ? bytes({remaining: found.slice(1)}) : 0;
        const taken = fill(result, "operations", schemas, reserve);
        if (!taken && schemas.length) {
          const [requestSeparately, ...remaining] = found;
          if (request.operations.length === 1) throw new AssistantRefusal("The requested schema does not fit. Use MCP tools/list.");
          // The leading schema and batch metadata do not fit together. Keep the rest of the
          // batch reachable and require a single-name retry to keep the continuation moving.
          return {...result, requestSeparately, ...(remaining.length ? {remaining} : {})};
        }
        const remaining = found.slice(taken);
        return remaining.length ? {...result, remaining} : result;
      }
      let start = 0;
      if (request.cursor) {
        start = granted.findIndex(operation => operation.name === request.cursor);
        if (start < 0) throw new AssistantRefusal("The cursor no longer names a granted operation. Call assistant_discover again without a cursor.");
      }
      const rest = granted.slice(start).map(({name, description}) => ({name, description}));
      const reserve = rest.length ? bytes({nextCursor: "x".repeat(Math.max(...rest.map(operation => operation.name.length)))}) : 0;
      const result: Record<string, unknown> = {inputSchemas: SCHEMA_HINT, operations: []};
      if (!request.cursor) {
        result.controlPlane = {id: db.instanceId(), name: db.assistantConnections.installationName()};
        result.connection = context.connection;
        result.transport = {endpoint: "/assistant/mcp", protocolVersion: "2025-06-18", authentication: "Bearer"};
        result.skillHint = SKILL_HINT;
        if (bytes(result) + reserve > ASSISTANT_DISCOVERY_MAX_BYTES) {
          // A selected grant can contain hundreds of IDs. Keep the connection identity and
          // granted-operation paging available without returning a misleading partial grant.
          const {grant, ...identity} = context.connection;
          result.connection = identity;
          result.destructiveConfirmation = grant.destructiveConfirmation;
          result.grantNotice = "The exact grant exceeds the tool-result limit. The owner can inspect it in Assistant Connections. This operation list is still filtered by the grant.";
        }
        if (bytes({...result, skillHint: undefined, skill: WOLLIPOG_ASSISTANT_SKILL}) + reserve <= ASSISTANT_DISCOVERY_MAX_BYTES) {
          delete result.skillHint;
          result.skill = WOLLIPOG_ASSISTANT_SKILL;
        }
      }
      const taken = fill(result, "operations", rest, reserve);
      if (!taken && rest.length && request.cursor) throw new AssistantRefusal("The next operation description exceeds the tool-result limit. Use MCP tools/list.");
      return taken < rest.length ? {...result, nextCursor: rest[taken]!.name} : result;
    },
  });
  return operations;
}

/** Stateless Streamable HTTP: no retained session can outlive a credential or grant change. */
export function registerAssistantRoutes(app: FastifyInstance, deps: {
  db: ControlPlaneDb;
  operations: AssistantOperations;
  requestHuman(req: FastifyRequest): HumanPrincipal | null;
}): void {
  const store = deps.db.assistantConnections;
  const management = new AssistantConnectionManagement(deps.db);
  const owner = (req: FastifyRequest) => {
    const principal = deps.requestHuman(req);
    return principal?.role === "owner" ? principal : null;
  };
  app.get("/api/assistant-connections", async (req, reply) => {
    const principal = owner(req);
    if (!principal) return reply.code(403).send({ error: "Only an organization owner can manage Assistant Connections." });
    return management.list(principal, deps.operations);
  });
  app.post("/api/assistant-connections/installation", async (req, reply) => {
    const principal = owner(req);
    if (!principal || principal.organizationId !== PERSONAL_ORGANIZATION_ID) return reply.code(403).send({ error: "Only an owner of the installation's personal organization can rename this control plane." });
    try {
      return management.rename(principal, (req.body as {name?: unknown} | null)?.name);
    } catch (error) {
      if (error instanceof AssistantRefusal) return reply.code(400).send({error: error.message});
      throw error;
    }
  });
  app.post("/api/assistant-connections", async (req, reply) => {
    const principal = owner(req);
    if (!principal) return reply.code(403).send({ error: "Only an organization owner can issue standing Assistant authority." });
    const body = req.body as { name?: unknown; grant?: unknown } | null;
    try {
      if (typeof body?.name !== "string") throw new AssistantRefusal("A connection name is required.");
      return reply.code(201).header("cache-control", "no-store").send(store.create(principal, body.name, assistantGrant(body.grant)));
    } catch (error) {
      if (error instanceof AssistantRefusal) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
  for (const action of ["configure", "rotate", "revoke", "activity"] as const) {
    app.route({ method: action === "activity" ? "GET" : "POST", url: `/api/assistant-connections/:id/${action}`, handler: async (req, reply) => {
      const principal = owner(req);
      const id = (req.params as {id: string}).id;
      const connection = store.get(id);
      if (!principal || !connection || connection.ownerUserId !== principal.userId || connection.organizationId !== principal.organizationId) return reply.code(404).send({ error: "Assistant connection not found for this owner." });
      reply.header("cache-control", "no-store");
      try {
        if (action === "activity") return management.activity(principal, id);
        if (action === "configure") {
          const body = req.body as {grant?: unknown; name?: unknown; expectedRevision?: number} | null;
          store.configure(id, body?.grant, body?.name, body?.expectedRevision);
        }
        if (action === "revoke") store.revoke(id);
        if (action === "rotate") {
          if (connection.revoked) throw new AssistantRefusal("This connection is revoked. Create a new connection instead.");
          const token = store.rotate(id);
          return { connection: store.get(id), token };
        }
        return { connection: store.get(id) };
      } catch (error) {
        if (error instanceof AssistantConflict) return reply.code(409).send({error: error.message});
        if (error instanceof AssistantRefusal) return reply.code(400).send({ error: error.message });
        throw error;
      }
    }});
  }
  app.route({ method: ["GET", "POST", "DELETE"], url: "/assistant/mcp", handler: async (req, reply) => {
    reply.header("cache-control", "no-store");
    // Reject browser cross-origin requests even when CORS merely hides their response.
    if (req.headers.origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* invalid origin */ }
      if (!sameOrigin) return reply.code(403).send({ error: "Cross-origin Assistant MCP request refused. Use a direct authenticated MCP client." });
    }
    const credential = store.authenticate(extractBearer(req.headers.authorization));
    if (!credential) return reply.code(401).header("www-authenticate", "Bearer").send({ error: "Assistant credential is missing, invalid, rotated or revoked. Ask the owner to issue a credential in Assistant Connections." });
    if (req.method !== "POST") return reply.code(405).header("allow", "POST").send();
    const version = req.headers["mcp-protocol-version"];
    if (version && version !== "2025-06-18" && version !== "2025-03-26") return reply.code(400).send({ error: "Unsupported MCP version. Configure Streamable HTTP with MCP 2025-06-18 or 2025-03-26, or upgrade the client." });
    const message = req.body as {jsonrpc?: unknown; id?: unknown; method?: unknown; params?: {name?: unknown; arguments?: unknown;
      protocolVersion?: unknown; acknowledgement?: { receiptId: unknown; sha256: unknown }}} | null;
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string" || (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")) return reply.code(400).send({ error: "Expected a single JSON-RPC 2.0 request. Batches are unsupported." });
    const rpcError = (code: number, text: string) => ({jsonrpc: "2.0", id: message.id ?? null, error: {code, message: text}});
    const relayDelivery = message.method === ASSISTANT_EVIDENCE_RELAY_DELIVER;
    const relayAck = message.method === ASSISTANT_EVIDENCE_RELAY_ACK;
    try {
      const connection = store.current(credential);
      if (connection.threadId && deps.db.assistantThreads.harnessChangeInProgress(connection.threadId)) {
        throw new AssistantRefusal("This Assistant thread is changing harnesses. Try again when the change finishes.");
      }
      const principal = deps.db.operatingHumanPrincipal(connection.ownerUserId, connection.organizationId);
      if (principal?.role !== "owner") throw new AssistantRefusal("The granting owner is no longer active. An active owner must recreate this connection.");
      if (message.id === undefined) {
        if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return reply.code(202).send();
        return reply.code(400).send(rpcError(-32600, "Unsupported notification."));
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: {name: "wollipog-assistant", version: "1"}, instructions: "Call assistant_discover to identify this installation and its granted operations. Never send credentials as tool arguments." };
      } else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools: deps.operations.list(connection).map(({name, description, inputSchema}) => ({name, description, inputSchema})) };
      else if (relayDelivery || relayAck) {
        const args = message.params?.arguments;
        if (!args || typeof args !== "object" || Array.isArray(args) ||
            relayAck && (!message.params?.acknowledgement?.receiptId || !message.params.acknowledgement.sha256)) {
          throw new AssistantRefusal("Invalid evidence relay request.");
        }
        const output = await deps.operations.call(credential, ASSISTANT_EVIDENCE_INSPECT, relayAck
          ? { ...args, [ASSISTANT_EVIDENCE_ACKNOWLEDGEMENT]: message.params!.acknowledgement } : args);
        return { jsonrpc: "2.0", id: message.id, ...(relayDelivery ? { delivery: output } : { result: output }) };
      }
      else if (message.method === "tools/call") {
        if (typeof message.params?.name !== "string") return rpcError(-32602, "A registered tool name is required.");
        if (message.params.name === ASSISTANT_EVIDENCE_INSPECT) {
          throw new AssistantRefusal("Assistant screenshot inspection requires a compatible Wollipog runner.");
        }
        const output = await deps.operations.call(credential, message.params.name, message.params.arguments ?? {});
        result = { content: [{type: "text", text: JSON.stringify(output ?? null)}] };
      } else return rpcError(-32601, "Method not supported. Use initialize, ping, tools/list or tools/call with MCP Streamable HTTP.");
      return {jsonrpc: "2.0", id: message.id, result};
    } catch (error) {
      // Only explicit application-safe errors may expose text; uncertainty is a failed call in
      // activity, not an authorization refusal or proof that the command had no effects.
      if (error instanceof AssistantRefusal || error instanceof ManagementUncertainOutcome) {
        if (message.method !== "tools/call" && !relayDelivery && !relayAck) return rpcError(-32001, error.message);
        return {jsonrpc: "2.0", id: message.id ?? null, result: {isError: true, content: [{type: "text", text: error.message}]}};
      }
      req.log.error("Assistant operation failed");
      return rpcError(-32603, "Assistant operation failed. Inspect connection activity and control-plane health; do not blindly retry a mutation.");
    }
  }});
}
