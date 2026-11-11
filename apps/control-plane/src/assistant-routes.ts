import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractBearer } from "./auth.js";
import type { HumanPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import { assistantGrant, AssistantOperations, AssistantRefusal } from "./assistant-connections.js";

export function createAssistantOperations(db: ControlPlaneDb): AssistantOperations {
  const operations = new AssistantOperations(db.assistantConnections, (user, organization) => db.operatingHumanPrincipal(user, organization));
  operations.register({
    name: "assistant_discover", description: "Read this installation's identity, connection restrictions and granted operation inventory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, metadata: true,
    resolveTarget: () => ({ kind: "control_plane", id: db.instanceId() }), ownerCanAccess: () => true,
    execute: (_args, context) => ({
      controlPlane: { id: db.instanceId(), name: db.assistantConnections.installationName() },
      connection: context.connection,
      operations: operations.list(context.connection).map(({name, description, inputSchema}) => ({name, description, inputSchema})),
      transport: { endpoint: "/assistant/mcp", protocolVersion: "2025-06-18", authentication: "Bearer" },
    }),
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
  const owner = (req: FastifyRequest) => {
    const principal = deps.requestHuman(req);
    return principal?.role === "owner" ? principal : null;
  };
  app.get("/api/assistant-connections", async (req, reply) => {
    const principal = owner(req);
    if (!principal) return reply.code(403).send({ error: "Only an organization owner can manage Assistant Connections." });
    return { connections: store.list(principal) };
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
        if (action === "activity") return { activity: store.activity(id) };
        if (action === "configure") store.configure(id, (req.body as {grant?: unknown} | null)?.grant);
        if (action === "revoke") store.revoke(id);
        if (action === "rotate") {
          if (connection.revoked) throw new AssistantRefusal("This connection is revoked. Create a new connection instead.");
          const token = store.rotate(id);
          return { connection: store.get(id), token };
        }
        return { connection: store.get(id) };
      } catch (error) {
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
      if (error instanceof AssistantRefusal) {
        if (message.method !== "tools/call") return rpcError(-32001, error.message);
        return {jsonrpc: "2.0", id: message.id ?? null, result: {isError: true, content: [{type: "text", text: error.message}]}};
      }
      req.log.error("Assistant operation failed");
      return rpcError(-32603, "Assistant operation failed. Inspect connection activity and control-plane health; do not blindly retry a mutation.");
    }
  }});
}
