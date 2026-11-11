import { randomUUID } from "node:crypto";
import { isPromptImageReference, isWorkspaceReference, validatePromptImageInputs, type PromptImageInput, type RunnerProtocolCapability } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { SessionsService } from "./sessions.js";
import { failureBody, type CapabilityRefusal } from "./capability-refusal.js";
import type { OwnerManagementResult } from "./owner-management.js";

/** Shared queued-message operations. Transport failures throw: a lost reply does not prove
 * the edit failed. HTTP keeps its existing 502 contract; Assistant records uncertainty. */
export function createSessionQueueManagement(deps: {
  db: ControlPlaneDb; hub: Hub; svc: SessionsService;
  runnerCapabilityError(runnerId: string, capability: RunnerProtocolCapability, label: string): CapabilityRefusal | null;
  warn(error: unknown): void;
}) {
  const {db, hub, svc, runnerCapabilityError} = deps;
  const failure = (status: number, error: string): OwnerManagementResult => ({status, body: {error}});
  const requireQueuedPromptCapability = (sessionId: string, capability: RunnerProtocolCapability, label: string) => {
    const session = db.getSession(sessionId);
    if (!session) return {result: failure(404, "session not found")};
    if (!hub.isRunnerOnline(session.runnerId)) return {result: failure(409, "runner is offline")};
    const unsupported = runnerCapabilityError(session.runnerId, capability, label);
    if (unsupported) return {result: {status: 409, body: failureBody(unsupported)}};
    return {session};
  };
  return {
    snapshot(sessionId: string) {
      const session = db.getSession(sessionId);
      if (!session) return null;
      const live = hub.withQueue(session, true);
      return {sessionId, status: live.status, activeTurnId: live.activeTurnId, queued: live.queued ?? [],
        commands: session.agentCapabilities?.slashCommands ?? [], invocations: session.commandInvocations ?? []};
    },
    cancel(sessionId: string, promptId: unknown): OwnerManagementResult {
      if (typeof promptId !== "string" || !promptId) return failure(400, "promptId (string) is required");
      const checked = requireQueuedPromptCapability(sessionId, "queuedPromptCancellation", "queued prompt cancellation");
      if (checked.result) return checked.result;
      if (!hub.sendToRunner(checked.session!.runnerId, {type: "cancel_queued_prompt", sessionId, promptId})) return failure(409, "runner is offline");
      // Fire-and-forget acceptance. session_queue is the authoritative state readback.
      return {status: 204, body: undefined};
    },
    async read(sessionId: string, promptId: string): Promise<OwnerManagementResult> {
      if (!promptId) return failure(400, "promptId is required");
      const checked = requireQueuedPromptCapability(sessionId, "queuedPromptEditing", "queued prompt editing");
      if (checked.result) return checked.result;
      const requestId = `read_queue_${randomUUID().slice(0, 12)}`;
      const result = await hub.requestFromRunner(checked.session!.runnerId, requestId, {
        type: "read_queued_prompt", requestId, sessionId, promptId,
      }, 10_000);
      if (result.type !== "read_queued_prompt_result" || result.sessionId !== sessionId || result.promptId !== promptId) return failure(502, "unexpected runner reply");
      if (!result.ok || !result.prompt) return {status: 409, body: {error: result.error ?? "queued message cannot be edited", reason: result.reason}};
      return {status: 200, body: {prompt: result.prompt}};
    },
    async edit(sessionId: string, promptId: string, input: unknown): Promise<OwnerManagementResult> {
      const body = (input ?? {}) as {submissionId?: unknown; expectedRevision?: unknown; text?: unknown; images?: unknown};
      if (typeof body.submissionId !== "string" || !body.submissionId.trim()) return failure(400, "submissionId is required");
      if (typeof body.expectedRevision !== "string" || !body.expectedRevision.trim()) return failure(400, "expectedRevision is required");
      if (typeof body.text !== "string") return failure(400, "text must be a string");
      const images = body.images === undefined ? [] : body.images;
      if (!Array.isArray(images)) return failure(400, "images must be an array");
      const typedImages = images as PromptImageInput[];
      const validation = validatePromptImageInputs(typedImages);
      if (!validation.ok) return failure(400, validation.error!);
      if (!body.text.trim() && typedImages.length === 0) return failure(400, "a queued message cannot be empty");
      const checked = requireQueuedPromptCapability(sessionId, "queuedPromptEditing", "queued prompt editing");
      if (checked.result) return checked.result;
      if (typedImages.some(isWorkspaceReference)) {
        const unsupported = runnerCapabilityError(checked.session!.runnerId, "workspaceReferences", "workspace references");
        if (unsupported) return {status: 409, body: failureBody(unsupported)};
      }
      const prepared = svc.prepareQueuedPromptEditImages(sessionId, typedImages);
      if (!prepared.ok || !prepared.data) return {status: prepared.status, body: failureBody(prepared, "queued message images are invalid")};
      const requestId = `edit_queue_${randomUUID().slice(0, 12)}`;
      const result = await hub.requestFromRunner(checked.session!.runnerId, requestId, {
        type: "edit_queued_prompt", requestId, submissionId: body.submissionId, sessionId, promptId,
        expectedRevision: body.expectedRevision, text: body.text, images: prepared.data,
      }, 10_000);
      if (result.type !== "edit_queued_prompt_result" || result.sessionId !== sessionId || result.promptId !== promptId || result.submissionId !== body.submissionId) return failure(502, "unexpected runner reply");
      if (!result.applied || !result.prompt) return {status: 409, body: {error: result.error ?? "queued message could not be saved", reason: result.reason}};
      try {
        db.commitPreparedPromptImages(prepared.data.flatMap(image => isWorkspaceReference(image) || !isPromptImageReference(image) ? [] : [image.artifactId]));
      } catch (error) {
        // Acceptance is authoritative; lease cleanup never changes the edit's outcome.
        deps.warn(error);
      }
      return {status: 200, body: {prompt: result.prompt}};
    },
  };
}
