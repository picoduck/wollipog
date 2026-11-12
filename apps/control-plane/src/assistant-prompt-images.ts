import {AsyncLocalStorage} from "node:async_hooks";
import {createHash} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {MAX_PROMPT_IMAGE_BYTES, PROMPT_IMAGE_MIME_TYPES} from "@wollipog/protocol";
import {extractBearer} from "./auth.js";
import {AssistantRefusal, type AssistantOperations} from "./assistant-connections.js";
import type {ControlPlaneDb} from "./db.js";
import type {SessionsService} from "./sessions.js";
import {OwnerManagement} from "./owner-management.js";
import {workflowActorForPrincipal, type AuthPrincipal} from "./identity.js";
import {failureBody} from "./capability-refusal.js";

/** Binary transport is server-owned context, never image bytes or filesystem paths in model args. */
export class AssistantPromptImages {
  readonly management = new OwnerManagement<AuthPrincipal>();
  private readonly upload = new AsyncLocalStorage<{connectionId: string; sessionId: string; commandId: string; mimeType: string; bytes: Buffer}>();
  constructor(private readonly db: ControlPlaneDb, svc: SessionsService) {
    this.management.define("POST", "/api/sessions/:id/prompt-images", async (input, reply) => {
      const {id} = input.params as {id: string};
      if (!db.canAccessSession(input.principal, id)) return reply.code(404).send({error: "session not found"});
      const {mimeType, bytes} = input.body as {mimeType: string; bytes: Buffer};
      if (!Buffer.isBuffer(bytes)) return reply.code(415).send({error: "an allowed raw image media type is required"});
      await input.recheck?.();
      input.beforeEffect?.();
      const result = svc.createPromptImageArtifact(id, mimeType, bytes, workflowActorForPrincipal(input.principal, db.localIdentityContext().userId));
      reply.header("cache-control", "private, no-store").header("pragma", "no-cache");
      return reply.code(result.status).send(result.ok ? result.data : failureBody(result));
    });
  }
  prepare(args: Record<string, unknown>, connectionId: string, operations: AssistantOperations) {
    let mimeType: string, bytes: Buffer;
    const source = args.sourceArtifactId;
    const recheck = () => {
      if (source === undefined) return;
      const scope = typeof source === "string" ? this.db.workflowArtifactScope(source) : null;
      const session = scope?.sessionId ? this.db.getSession(scope.sessionId) : null;
      if (!session) throw new AssistantRefusal("Image source is unavailable or outside current access.");
      operations.authorize(connectionId, "prompt_image_add", {kind: "session", id: session.id, ...(session.projectId ? {projectId: session.projectId} : {})});
    };
    if (source !== undefined) {
      if (typeof source !== "string") throw new AssistantRefusal("sourceArtifactId must be an opaque artifact reference.");
      recheck();
      const metadata = this.db.workflowArtifactExportPreflight(source)?.artifact;
      if (!metadata || !(PROMPT_IMAGE_MIME_TYPES as readonly string[]).includes(metadata.mimeType) || metadata.sizeBytes > MAX_PROMPT_IMAGE_BYTES) throw new AssistantRefusal("Use an allowed, bounded image artifact.");
      mimeType = metadata.mimeType;
      const stored = this.db.readWorkflowArtifactBytes(source);
      if (!stored) throw new AssistantRefusal("Image source is unavailable.");
      bytes = stored;
    } else {
      const upload = this.upload.getStore();
      if (!upload || upload.connectionId !== connectionId || upload.sessionId !== args.sessionId || upload.commandId !== args.commandId) {
        throw new AssistantRefusal("Supply sourceArtifactId or upload a raw image to the authenticated Assistant image endpoint. Never put image bytes or filesystem paths in tool arguments.");
      }
      ({mimeType, bytes} = upload);
    }
    return {body: {mimeType, bytes}, recheck, fingerprint: {mimeType, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")}};
  }
  registerHttp(app: FastifyInstance, operations: AssistantOperations): void {
    for (const mime of PROMPT_IMAGE_MIME_TYPES) if (!app.hasContentTypeParser(mime)) app.addContentTypeParser(mime,
      {parseAs: "buffer", bodyLimit: MAX_PROMPT_IMAGE_BYTES}, (_req, body, done) => done(null, body));
    app.post("/assistant/sessions/:sessionId/prompt-images/:commandId", {
      bodyLimit: MAX_PROMPT_IMAGE_BYTES,
      onRequest: async (request, reply) => {
        if (request.headers.origin) {
          let same = false;
          try {same = new URL(request.headers.origin).host === request.headers.host;} catch { /* invalid Origin */ }
          if (!same) return reply.code(403).send({error: "Cross-origin Assistant image request refused."});
        }
        const credential = this.db.assistantConnections.authenticate(extractBearer(request.headers.authorization));
        if (!credential) return reply.code(401).send({error: "A current Assistant credential is required."});
        try {
          const {sessionId} = request.params as {sessionId: string};
          const session = this.db.getSession(sessionId);
          if (!session) return reply.code(404).send({error: "session not found"});
          operations.authorize(credential.connectionId, "prompt_image_add", {kind: "session", id: sessionId, ...(session.projectId ? {projectId: session.projectId} : {})});
        } catch {return reply.code(403).send({error: "Image upload is outside current owner, operation or Project access."});}
      },
    }, async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const credential = this.db.assistantConnections.authenticate(extractBearer(request.headers.authorization));
      if (!credential) return reply.code(401).send({error: "A current Assistant credential is required."});
      if (!Buffer.isBuffer(request.body)) return reply.code(415).send({error: "an allowed raw image media type is required"});
      const mimeType = String(request.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      const {sessionId, commandId} = request.params as {sessionId: string; commandId: string};
      try {
        return await this.upload.run({connectionId: credential.connectionId, sessionId, commandId, mimeType, bytes: request.body},
          () => operations.call(credential, "prompt_image_add", {sessionId, commandId}));
      } catch (error) {
        if (error instanceof AssistantRefusal) return reply.code(403).send({error: error.message});
        return reply.code(500).send({error: "Image upload outcome unavailable. Reconcile command_get before retrying."});
      }
    });
  }
}
