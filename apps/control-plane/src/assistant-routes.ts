import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractBearer } from "./auth.js";
import { PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import { assistantGrant, AssistantOperations, AssistantRefusal, AssistantConflict, ASSISTANT_OPERATION_NAME } from "./assistant-connections.js";
import { AssistantConnectionManagement } from "./assistant-connection-management.js";
import {ManagementUncertainOutcome} from "./assistant-management-command.js";
import { WOLLIPOG_ASSISTANT_SKILL } from "./assistant-skill.js";
export { assistantActivityTargetLabel } from "./assistant-connection-management.js";

/** Most UTF-8 bytes one `assistant_discover` result may serialize to (#4679). Claude Code saves an
 * MCP text result over 50,000 characters to a file and warns past 10,000 tokens; Codex keeps
 * 10,000 tokens (about 40,000 bytes) of a tool result for its catalog models. This stays under all
 * three with room for the MCP envelope. */
export const ASSISTANT_DISCOVERY_MAX_BYTES = 24_000;
/** Most operation names one schema request may name. */
export const ASSISTANT_DISCOVERY_MAX_SCHEMA_NAMES = 64;
const SCHEMA_HINT = "Call assistant_discover with {\"operations\": [\"<name>\", ...]} for those operations' full input schemas.";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Appends items to `base[key]` while the whole result stays within the bound, always at least one.
 * Returns how many were taken. `reserve` holds room for a field the caller adds afterwards. */
function fill<T>(base: Record<string, unknown>, key: string, items: readonly T[], reserve: number): number {
  const list: T[] = [];
  base[key] = list;
  let size = bytes(base) + reserve;
  for (const item of items) {
    const next = bytes(item) + (list.length ? 1 : 0);
    if (list.length && size + next > ASSISTANT_DISCOVERY_MAX_BYTES) break;
    list.push(item);
    size += next;
  }
  return list.length;
}

function discoveryArguments(args: unknown): {operations?: string[]; cursor?: string} {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new AssistantRefusal("Supply an object of tool arguments.");
  const {operations: names, cursor, ...rest} = args as Record<string, unknown>;
  if (Object.keys(rest).length) throw new AssistantRefusal("assistant_discover accepts only operations or cursor.");
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
  const operations = new AssistantOperations(db.assistantConnections, (user, organization) => db.operatingHumanPrincipal(user, organization));
  operations.register({
    name: "assistant_discover",
    description: "Read this installation's identity, connection grant and operation names; name operations for their full input schemas.",
    inputSchema: { type: "object", properties: {
      operations: {type: "array", items: {type: "string", pattern: ASSISTANT_OPERATION_NAME.source}, minItems: 1, maxItems: ASSISTANT_DISCOVERY_MAX_SCHEMA_NAMES,
        description: "Granted operation names whose full input schemas to return. Request any listed in `remaining` again."},
      cursor: {type: "string", description: "An earlier result's nextCursor, to read the rest of the operation list."},
    }, additionalProperties: false }, metadata: true,
    resolveTarget: () => ({ kind: "control_plane", id: db.instanceId() }), ownerCanAccess: () => true,
    // Every form lists only what the connection's grant allows; it is shaped to fit one tool result.
    execute: (args, context) => {
      const request = discoveryArguments(args);
      const granted = operations.list(context.connection);
      if (request.operations) {
        const byName = new Map(granted.map(operation => [operation.name, operation]));
        const found = request.operations.filter(name => byName.has(name));
        const unavailable = request.operations.filter(name => !byName.has(name));
        const result: Record<string, unknown> = unavailable.length ? {unavailable} : {};
        const schemas = found.map(name => { const {description, inputSchema} = byName.get(name)!; return {name, description, inputSchema}; });
        const remaining = found.slice(fill(result, "operations", schemas, bytes({remaining: found})));
        return remaining.length ? {...result, remaining} : result;
      }
      let start = 0;
      if (request.cursor) {
        start = granted.findIndex(operation => operation.name === request.cursor);
        if (start < 0) throw new AssistantRefusal("The cursor no longer names a granted operation. Call assistant_discover again without a cursor.");
      }
      const result: Record<string, unknown> = request.cursor ? {} : {
        controlPlane: { id: db.instanceId(), name: db.assistantConnections.installationName() },
        connection: context.connection,
        transport: { endpoint: "/assistant/mcp", protocolVersion: "2025-06-18", authentication: "Bearer" },
        // The guide every Wollipog Assistant thread follows, shared with outside assistants.
        skill: WOLLIPOG_ASSISTANT_SKILL,
      };
      result.inputSchemas = SCHEMA_HINT;
      const rest = granted.slice(start).map(({name, description}) => ({name, description}));
      const longestName = Math.max(0, ...rest.map(operation => operation.name.length));
      const taken = fill(result, "operations", rest, bytes({nextCursor: "x".repeat(longestName)}));
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
    const message = req.body as {jsonrpc?: unknown; id?: unknown; method?: unknown; params?: {name?: unknown; arguments?: unknown; protocolVersion?: unknown}} | null;
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string" || (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")) return reply.code(400).send({ error: "Expected a single JSON-RPC 2.0 request. Batches are unsupported." });
    const rpcError = (code: number, text: string) => ({jsonrpc: "2.0", id: message.id ?? null, error: {code, message: text}});
    try {
      const connection = store.current(credential);
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
      else if (message.method === "tools/call") {
        if (typeof message.params?.name !== "string") return rpcError(-32602, "A registered tool name is required.");
        const output = await deps.operations.call(credential, message.params.name, message.params.arguments ?? {});
        result = { content: [{type: "text", text: JSON.stringify(output ?? null)}] };
      } else return rpcError(-32601, "Method not supported. Use initialize, ping, tools/list or tools/call with MCP Streamable HTTP.");
      return {jsonrpc: "2.0", id: message.id, result};
    } catch (error) {
      // Only explicit application-safe errors may expose text; uncertainty is a failed call in
      // activity, not an authorization refusal or proof that the command had no effects.
      if (error instanceof AssistantRefusal || error instanceof ManagementUncertainOutcome) {
        if (message.method !== "tools/call") return rpcError(-32001, error.message);
        return {jsonrpc: "2.0", id: message.id ?? null, result: {isError: true, content: [{type: "text", text: error.message}]}};
      }
      req.log.error("Assistant operation failed");
      return rpcError(-32603, "Assistant operation failed. Inspect connection activity and control-plane health; do not blindly retry a mutation.");
    }
  }});
}
