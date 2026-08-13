import {
  validatePromptImageInputs,
  type ResolveSteeringAttemptMessage,
  type ResolveSteeringAttemptResultMessage,
  type SteerSessionMessage,
  type SteerSessionResultMessage,
} from "@wollipog/protocol";
import type { SessionManager } from "./session-manager.js";

type SteeringSessions = Pick<SessionManager, "steerSession">;
type SteeringResolutionSessions = Pick<SessionManager, "resolveSteeringAttempt">;
type SendSteeringResult = (message: SteerSessionResultMessage) => void;
const MAX_STEERING_RESULT_MESSAGE_CHARS = 4_096;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_STEERING_RESULT_MESSAGE_CHARS);
}

/** Keep request correlation at the transport edge: every steering envelope receives exactly the
 * requestId it arrived with, while submissionId remains the provider-delivery idempotency key. */
export function handleSteerSessionMessage(
  message: SteerSessionMessage,
  sessions: SteeringSessions,
  send: SendSteeringResult,
): void {
  if (!validatePromptImageInputs(message.images ?? []).ok) {
    send({
      type: "steer_session_result",
      requestId: message.requestId,
      submissionId: message.submissionId,
      sessionId: message.sessionId,
      turnId: message.turnId,
      disposition: "rejected",
      reason: "provider_rejected",
      message: "steering images are malformed",
    });
    return;
  }
  const { type: _type, requestId, ...request } = message;
  void sessions.steerSession(request).then(
    (result) => send({ type: "steer_session_result", requestId, ...result }),
    (error) => send({
      type: "steer_session_result",
      requestId,
      submissionId: message.submissionId,
      sessionId: message.sessionId,
      turnId: message.turnId,
      disposition: "uncertain",
      reason: "transport_uncertain",
      message: errorText(error),
    }),
  );
}

export function handleResolveSteeringAttemptMessage(
  message: ResolveSteeringAttemptMessage,
  sessions: SteeringResolutionSessions,
  send: (message: ResolveSteeringAttemptResultMessage) => void,
): void {
  const raw = message as Partial<ResolveSteeringAttemptMessage> & { action?: unknown };
  const validatedRequestId = typeof raw.requestId === "string" ? raw.requestId : "";
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  const submissionId = typeof raw.submissionId === "string" ? raw.submissionId : "";
  if (raw.action !== "queue_again" && raw.action !== "dismiss") {
    send({
      type: "resolve_steering_attempt_result",
      requestId: validatedRequestId,
      sessionId,
      submissionId,
      // Echo the invalid wire value for correlation; the frame is explicitly unapplied.
      action: raw.action as unknown as ResolveSteeringAttemptResultMessage["action"],
      applied: false,
      reason: "invalid_action",
    });
    return;
  }
  if (!validatedRequestId || !sessionId || !submissionId) {
    send({
      type: "resolve_steering_attempt_result",
      requestId: validatedRequestId,
      sessionId,
      submissionId,
      action: raw.action,
      applied: false,
      reason: "invalid_envelope",
    });
    return;
  }
  const { type: _type, requestId: _requestId, ...request } = message;
  send({
    type: "resolve_steering_attempt_result",
    requestId: validatedRequestId,
    ...sessions.resolveSteeringAttempt(request),
  });
}
