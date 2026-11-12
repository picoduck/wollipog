import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";

/** Shared application operation, invoked by HTTP and Assistant adapters with explicit authority.
 * No HTTP injection or bearer impersonation. Handlers retain each actual principal's rules. */
export interface OwnerManagementInput<P extends AuthPrincipal = HumanPrincipal> {
  principal: P;
  params: unknown;
  body: unknown;
  query: unknown;
  /** Trusted transport context, never supplied by the operation's payload/query. */
  log?: FastifyRequest["log"];
  entryPoint?: "dashboard" | "assistant";
  /** Trusted adapter constraint, never copied from caller payload/query. Applied before paging. */
  projectIds?: readonly string[];
  /** Assistant callers must recheck after asynchronous inspection, before later writes. */
  recheck?: () => Promise<P>;
  /** Server-created intersection with transport grants, never supplied in a request body. */
  access?: { session(id: string): boolean; runner(id: string): boolean };
  /** Service-owned boundary: immediately before a call that could apply an effect. */
  beforeEffect?: () => void;
}
export interface OwnerManagementReply {
  code(status: number): OwnerManagementReply;
  send(body: unknown): unknown;
  header(name: string, value: string): OwnerManagementReply;
}
export interface OwnerManagementResult { status: number; body: unknown; headers?: Record<string, string> }
export type OwnerManagementHandler<P extends AuthPrincipal = HumanPrincipal> = (input: OwnerManagementInput<P>, reply: OwnerManagementReply) => unknown | Promise<unknown>;
export class OwnerManagement<P extends AuthPrincipal = HumanPrincipal> {
  private handlers = new Map<string, OwnerManagementHandler<P>>();
  define(method: string, path: string, handler: OwnerManagementHandler<P>): void {
    const key = `${method.toUpperCase()} ${path}`;
    if (this.handlers.has(key)) throw new Error(`Duplicate management operation: ${key}`);
    this.handlers.set(key, handler);
  }
  keys(): string[] { return [...this.handlers.keys()]; }
  async execute(key: string, input: OwnerManagementInput<P>): Promise<OwnerManagementResult> {
    const handler = this.handlers.get(key);
    if (!handler) throw new Error("Unknown management operation");
    let status = 200, sent = false, body: unknown;
    const headers: Record<string, string> = {};
    const reply: OwnerManagementReply = {
      code(value) { status = value; return reply; },
      send(value) { sent = true; body = value; },
      header(name, value) { headers[name] = value; return reply; },
    };
    const returned = await handler(input, reply);
    return {status, body: sent ? body : returned, ...(Object.keys(headers).length ? {headers} : {})};
  }
  registerHttp(app: FastifyInstance, principal: (request: FastifyRequest) => P | null,
    unauthenticated: number | {status: number; error: string} = 403, exclude: readonly string[] = []): void {
    const refusal = typeof unauthenticated === "number" ? {status: unauthenticated,
      error: unauthenticated === 403 ? "human identity is required" : "authentication required"} : unauthenticated;
    for (const key of this.keys()) {
      if (exclude.includes(key)) continue;
      const space = key.indexOf(" ");
      app.route({method: key.slice(0, space) as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: key.slice(space + 1),
        handler: async (request, reply) => {
          const owner = principal(request);
          if (!owner) return reply.code(refusal.status).send({error: refusal.error});
          const result = await this.execute(key, {principal: owner, params: request.params, body: request.body, query: request.query,
            log: request.log, entryPoint: "dashboard"});
          if (result.headers) reply.headers(result.headers);
          return reply.code(result.status).send(result.body);
        }});
    }
  }
}
