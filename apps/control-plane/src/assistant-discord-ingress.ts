import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractBearer, hashToken } from "./auth.js";
import { AssistantCommandReceipts, assistantRequestDigest, type AssistantCommandReceipt } from "./assistant-command-receipts.js";
import { AssistantRefusal, type AssistantCredential, type AssistantOperations, type AssistantTarget } from "./assistant-connections.js";
import type { AuthenticatedAssistantWorkOrigin } from "./assistant-work-origin.js";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";

type ConnectorOperation = "session_launch" | "session_prompt";
interface ConnectorRow {
  id: string; connection_id: string; binding_id: string; binding_revision: number;
  operations_json: string; revoked: number;
}
interface AuthenticatedCommand {
  credential: AssistantCredential;
  connectorHash: string;
  operation: ConnectorOperation;
  commandId: string;
  argumentsDigest: string;
  target: AssistantTarget;
  origin: AuthenticatedAssistantWorkOrigin;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("Supply a command object.");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[\w.:-]{1,128}$/.test(value)) throw new AssistantRefusal("Supply a canonical resource ID.");
  return value;
}

/** The connector credential is a capability held ONLY by trusted Discord ingress, never in a
 * model's tool configuration/arguments. It attests an owner-bound requester/conversation, while
 * the separate Assistant bearer still supplies current Wollipog authority. No human login reuse.
 * This first correlated-command adapter covers launch/prompt; other families remain separate. */
export class AssistantDiscordIngress {
  private readonly context = new AsyncLocalStorage<Readonly<AuthenticatedCommand>>();
  constructor(private readonly db: ControlPlaneDb, private readonly operations: AssistantOperations) {
    db.raw().exec(`CREATE TABLE IF NOT EXISTS assistant_discord_connectors (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, binding_id TEXT NOT NULL,
      binding_revision INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      operations_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(connection_id) REFERENCES assistant_connections(id),
      FOREIGN KEY(binding_id) REFERENCES assistant_destination_bindings(id));`);
  }

  private owner(owner: HumanPrincipal, connectionId: string): void {
    const connection = this.db.assistantConnections.get(connectionId);
    if (owner.kind !== "human" || owner.role !== "owner" || !connection || connection.revoked ||
        connection.ownerUserId !== owner.userId || connection.organizationId !== owner.organizationId ||
        this.db.operatingHumanPrincipal(owner.userId, owner.organizationId)?.role !== "owner") {
      throw new AssistantRefusal("Only this connection's current owner can issue connector authority.");
    }
  }

  issue(owner: HumanPrincipal, connectionId: string, bindingId: string, operations: unknown): {id: string; token: string} {
    this.owner(owner, connectionId);
    const binding = this.db.assistantWork.binding(connectionId, bindingId);
    if (!binding || binding.revoked || !Array.isArray(operations) || !operations.length || operations.length > 2 ||
        new Set(operations).size !== operations.length || operations.some(name => name !== "session_launch" && name !== "session_prompt")) {
      throw new AssistantRefusal("Select a current destination binding and explicit session_launch/session_prompt connector operations.");
    }
    const id = `adc_${randomUUID()}`, token = `wollipogc_${randomBytes(32).toString("base64url")}`;
    this.db.raw().prepare("INSERT INTO assistant_discord_connectors VALUES (?,?,?,?,?,?,0)")
      .run(id, connectionId, bindingId, binding.revision, hashToken(token), JSON.stringify(operations));
    return {id, token};
  }

  revoke(owner: HumanPrincipal, connectionId: string, connectorId: string): void {
    this.owner(owner, connectionId);
    this.db.raw().prepare("UPDATE assistant_discord_connectors SET revoked=1,token_hash=? WHERE id=? AND connection_id=?")
      .run(`revoked:${randomUUID()}`, connectorId, connectionId);
  }

  private connector(credential: AssistantCredential, connectorHash: string, operation: ConnectorOperation, target: AssistantTarget): AuthenticatedAssistantWorkOrigin {
    const connection = this.db.assistantConnections.current(credential);
    const row = this.db.raw().prepare("SELECT * FROM assistant_discord_connectors WHERE token_hash=? AND connection_id=? AND revoked=0")
      .get(connectorHash, connection.id) as ConnectorRow | undefined;
    const binding = row && this.db.assistantWork.binding(connection.id, row.binding_id);
    if (!row || !binding || binding.revoked || binding.revision !== row.binding_revision ||
        !(JSON.parse(row.operations_json) as string[]).includes(operation) ||
        (binding.projects !== "all" && (!target.projectId || !binding.projects.includes(target.projectId)))) {
      throw new AssistantRefusal("The connector, requester binding, operation or target project is not authorized.");
    }
    this.operations.authorize(connection.id, operation, target);
    return {bindingId: binding.id, requesterId: binding.requesterId, workId: ""};
  }

  /** Passed to #4464 at composition. Missing context returns null for ordinary owner-authorized
   * MCP calls; a present but changed context THROWS, never downgrades to uncorrelated execution. */
  authenticatedOrigin(receipt: Readonly<AssistantCommandReceipt>): AuthenticatedAssistantWorkOrigin | null {
    const context = this.context.getStore();
    if (!context) return null;
    if (receipt.connectionId !== context.credential.connectionId || receipt.operation !== context.operation ||
        receipt.operationId !== context.commandId || receipt.argumentsDigest !== context.argumentsDigest ||
        assistantRequestDigest(receipt.target) !== assistantRequestDigest(context.target)) {
      throw new AssistantRefusal("The receipt does not match its authenticated connector envelope.");
    }
    const current = this.connector(context.credential, context.connectorHash, context.operation, receipt.target);
    if (current.bindingId !== context.origin.bindingId || current.requesterId !== context.origin.requesterId) {
      throw new AssistantRefusal("The authenticated requester binding changed before command acceptance.");
    }
    return {...current, workId: context.origin.workId};
  }

  async call(credential: AssistantCredential, connectorToken: string, value: unknown): Promise<unknown> {
    if (!/^wollipogc_[A-Za-z0-9_-]{43}$/.test(connectorToken)) throw new AssistantRefusal("A trusted connector credential is required outside model arguments.");
    const input = object(value);
    if (Object.keys(input).some(key => !["operation", "arguments", "workId"].includes(key)) ||
        (input.operation !== "session_launch" && input.operation !== "session_prompt")) {
      throw new AssistantRefusal("This correlated ingress accepts session_launch/session_prompt, arguments and workId. Requester identity comes only from the connector binding.");
    }
    const operation = input.operation;
    const workId = identifier(input.workId), supplied = object(input.arguments);
    const commandId = identifier(supplied.commandId);
    if (supplied.workOriginId !== undefined && supplied.workOriginId !== workId) throw new AssistantRefusal("The work origin differs from its authenticated envelope.");
    // JSON copy isolates the caller's mutable object across target resolution and rechecks.
    const args = JSON.parse(JSON.stringify({...supplied, workOriginId: workId})) as Record<string, unknown>;
    const connection = this.db.assistantConnections.current(credential);
    const definition = this.operations.list(connection).find(item => item.name === operation);
    if (!definition) throw new AssistantRefusal("The requested session operation is unavailable or excluded by the current grant.");
    const target = await definition.resolveTarget(args);
    const connectorHash = hashToken(connectorToken);
    const origin = {...this.connector(credential, connectorHash, operation, target), workId};
    const prior = this.db.assistantWork.origin(connection.id, commandId);
    if (prior && (prior.bindingId !== origin.bindingId || prior.requesterId !== origin.requesterId || prior.workId !== workId)) {
      throw new AssistantRefusal("The command identity is already bound to another requester or work origin.");
    }
    const context: Readonly<AuthenticatedCommand> = Object.freeze({credential: Object.freeze({...credential}), connectorHash,
      operation, commandId, argumentsDigest: assistantRequestDigest(args), target: Object.freeze({...target}), origin: Object.freeze(origin)});
    return this.context.run(context, async () => {
      const result = await this.operations.call(credential, operation, args);
      // A duplicate command does not run the reservation callback. Reconcile its persisted
      // origin before returning any receipt, including after an HTTP/control-plane restart.
      this.connector(credential, connectorHash, operation, await definition.resolveTarget(args));
      const stored = this.db.assistantWork.origin(connection.id, commandId);
      if (!stored || stored.bindingId !== origin.bindingId || stored.requesterId !== origin.requesterId || stored.workId !== workId) {
        throw new AssistantRefusal("The accepted command belongs to another authenticated work origin.");
      }
      return result;
    });
  }

  reconcile(credential: AssistantCredential, connectorToken: string, commandId: string): {receipt: AssistantCommandReceipt | null} {
    if (!/^wollipogc_[A-Za-z0-9_-]{43}$/.test(connectorToken)) throw new AssistantRefusal("A trusted connector credential is required.");
    const connection = this.db.assistantConnections.current(credential);
    const receipt = new AssistantCommandReceipts(this.db.raw()).get(connection.id, identifier(commandId));
    if (!receipt) {
      const row = this.db.raw().prepare("SELECT * FROM assistant_discord_connectors WHERE token_hash=? AND connection_id=? AND revoked=0")
        .get(hashToken(connectorToken), connection.id) as ConnectorRow | undefined;
      const binding = row && this.db.assistantWork.binding(connection.id, row.binding_id);
      if (!binding || binding.revoked || binding.revision !== row!.binding_revision ||
          this.db.operatingHumanPrincipal(connection.ownerUserId, connection.organizationId)?.role !== "owner") {
        throw new AssistantRefusal("Connector authority is unavailable.");
      }
      return {receipt: null};
    }
    if (receipt.operation !== "session_launch" && receipt.operation !== "session_prompt") throw new AssistantRefusal("Not a correlated session command.");
    const origin = this.db.assistantWork.origin(connection.id, commandId);
    let target = receipt.target;
    if (origin?.sessionId) {
      const session = this.db.getSession(origin.sessionId);
      if (!session) throw new AssistantRefusal("The command's source session is unavailable.");
      target = {kind: "session", id: session.id, ...(session.projectId ? {projectId: session.projectId} : {})};
    }
    const authorized = this.connector(credential, hashToken(connectorToken), receipt.operation, target);
    if (!origin || origin.bindingId !== authorized.bindingId || origin.requesterId !== authorized.requesterId) {
      throw new AssistantRefusal("This command belongs to another requester binding.");
    }
    return {receipt};
  }
}

export function registerAssistantDiscordIngress(app: FastifyInstance, deps: {
  db: ControlPlaneDb; ingress: AssistantDiscordIngress;
  requestHuman(req: FastifyRequest): HumanPrincipal | null;
}): void {
  const allowedOrigin = (req: FastifyRequest): boolean => {
    if (!req.headers.origin) return true;
    try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  };
  const ownerRoute = (action: (req: FastifyRequest, owner: HumanPrincipal, connectionId: string) => unknown) =>
    async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
      reply.header("cache-control", "no-store");
      const owner = deps.requestHuman(req);
      if (!owner) return reply.code(403).send({error: "An authenticated connection owner is required."});
      try { return action(req, owner, identifier((req.params as {id: string}).id)); }
      catch (error) { if (error instanceof AssistantRefusal) return reply.code(403).send({error: error.message}); throw error; }
    };
  app.post("/api/assistant-connections/:id/discord-connectors", ownerRoute((req, owner, id) => {
    const input = object(req.body);
    return deps.ingress.issue(owner, id, identifier(input.bindingId), input.operations);
  }));
  app.delete("/api/assistant-connections/:id/discord-connectors/:connectorId", ownerRoute((req, owner, id) => {
    deps.ingress.revoke(owner, id, identifier((req.params as {connectorId: string}).connectorId));
    return {revoked: true};
  }));
  app.post("/assistant/discord/commands", {bodyLimit: 64 * 1024}, async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!allowedOrigin(req)) return reply.code(403).send({error: "Cross-origin connector request refused."});
    const credential = deps.db.assistantConnections.authenticate(extractBearer(req.headers.authorization));
    const token = req.headers["x-wollipog-connector-token"];
    if (!credential || typeof token !== "string") return reply.code(401).send({error: "Current Assistant and trusted connector credentials are required."});
    try {
      const result = await deps.ingress.call(credential, token, req.body);
      req.log.info({event: "assistant_connector_command", entryPoint: "discord_connector", requestId: req.id,
        outcome: "accepted_or_reconciled"}, "Connector command accepted or reconciled");
      return result;
    }
    catch (error) {
      if (error instanceof AssistantRefusal) {
        req.log.warn({event: "assistant_connector_command", entryPoint: "discord_connector", requestId: req.id,
          outcome: "refused"}, "Connector command refused");
        return reply.code(403).send({error: error.message});
      }
      req.log.error({event: "assistant_connector_command_failed", entryPoint: "discord_connector", requestId: req.id}, "Connector command outcome unavailable");
      return reply.code(500).send({error: "Command outcome unavailable. Reconcile the command receipt before retrying."});
    }
  });
  app.get("/assistant/discord/commands/:commandId", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!allowedOrigin(req)) return reply.code(403).send({error: "Cross-origin connector request refused."});
    const credential = deps.db.assistantConnections.authenticate(extractBearer(req.headers.authorization));
    const token = req.headers["x-wollipog-connector-token"];
    if (!credential || typeof token !== "string") return reply.code(401).send({error: "Current Assistant and trusted connector credentials are required."});
    try { return deps.ingress.reconcile(credential, token, (req.params as {commandId: string}).commandId); }
    catch (error) { if (error instanceof AssistantRefusal) return reply.code(403).send({error: error.message}); throw error; }
  });
}
