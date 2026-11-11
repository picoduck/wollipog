/** Isolated browser-test support: real SQLite/routes, synthetic owner auth, no runners or bootstrap. */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { randomBytes } from "node:crypto";
import { ControlPlaneDb } from "../src/db.js";
import { createAssistantOperations, registerAssistantRoutes } from "../src/assistant-routes.js";
import { registerAuthGate } from "../src/http-auth.js";

export async function assistantUiServer() {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
  const ownerCredential = randomBytes(32).toString("base64url");
  const app = Fastify({logger: false});
  await app.register(cors, {origin: true});
  const requestHuman = (req: {headers: {authorization?: string}}) => req.headers.authorization === `Bearer ${ownerCredential}` ? owner : null;
  registerAuthGate(app, {authenticate: req => requestHuman(req) ? {id: "synthetic-owner", name: "Owner", principal: owner} : null, isAllowedOrigin: () => false});
  const operations = createAssistantOperations(db);
  registerAssistantRoutes(app, {db, operations, requestHuman});
  const project = db.createProject({name: "Assistant Sandbox", scope: {organizationId: owner.organizationId, owner: {kind: "user", userId: owner.userId}}});
  const origin = await app.listen({host: "127.0.0.1", port: 0});
  return {db, app, origin, ownerCredential, project, async close() { await app.close(); db.close(); }};
}
