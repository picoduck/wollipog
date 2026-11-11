import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HumanPrincipal } from "./identity.js";

/** Shared application operation, invoked by HTTP and Assistant adapters with explicit authority.
 * No HTTP injection, bearer impersonation, or session ancestry is involved. */
export interface OwnerManagementInput {
  principal: HumanPrincipal;
  params: unknown;
  body: unknown;
  query: unknown;
  /** Assistant callers must recheck after asynchronous inspection, before later writes. */
  recheck?: () => Promise<HumanPrincipal>;
}
export interface OwnerManagementReply {
  code(status: number): OwnerManagementReply;
  send(body: unknown): unknown;
}
export interface OwnerManagementResult { status: number; body: unknown }
export type OwnerManagementHandler = (input: OwnerManagementInput, reply: OwnerManagementReply) => unknown | Promise<unknown>;
export class OwnerManagement {
  private handlers = new Map<string, OwnerManagementHandler>();
  define(method: string, path: string, handler: OwnerManagementHandler): void {
    const key = `${method.toUpperCase()} ${path}`;
    if (this.handlers.has(key)) throw new Error(`Duplicate management operation: ${key}`);
    this.handlers.set(key, handler);
  }
  keys(): string[] { return [...this.handlers.keys()]; }
  async execute(key: string, input: OwnerManagementInput): Promise<OwnerManagementResult> {
    const handler = this.handlers.get(key);
    if (!handler) throw new Error("Unknown management operation");
    let status = 200, sent = false, body: unknown;
    const reply: OwnerManagementReply = {
      code(value) { status = value; return reply; },
      send(value) { sent = true; body = value; },
    };
    const returned = await handler(input, reply);
    return {status, body: sent ? body : returned};
  }
  registerHttp(app: FastifyInstance, principal: (request: FastifyRequest) => HumanPrincipal | null, exclude: readonly string[] = []): void {
    for (const key of this.keys()) {
      if (exclude.includes(key)) continue;
      const space = key.indexOf(" ");
      app.route({method: key.slice(0, space) as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: key.slice(space + 1),
        handler: async (request, reply) => {
          const owner = principal(request);
          if (!owner) return reply.code(403).send({error: "human identity is required"});
          const result = await this.execute(key, {principal: owner, params: request.params, body: request.body, query: request.query});
          return reply.code(result.status).send(result.body);
        }});
    }
  }
}
