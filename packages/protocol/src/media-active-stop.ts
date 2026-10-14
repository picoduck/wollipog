import { validMediaDispatchFenceIdentity, type MediaDispatchFenceIdentity } from "./media-dispatch-fence.js";

/** Private dedicated-worker lifecycle only. Neither request nor ACK certifies terminal usage. */
export interface MediaActiveStopIdentity extends MediaDispatchFenceIdentity { childSessionId: string }
export interface MediaActiveStopRequest extends MediaActiveStopIdentity { operationId: string }
export interface MediaActiveStopAcknowledgement extends MediaActiveStopRequest {
  outcome: "stop_requested" | "unknown";
  stopFenceSha256: string;
}
const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/u.test(v);
export function mediaActiveStopIdentityBody(value: MediaActiveStopIdentity): MediaActiveStopIdentity {
  const { childSessionId, ...dispatch } = value;
  if (!validMediaDispatchFenceIdentity(dispatch) || !id(childSessionId) ||
      childSessionId === dispatch.sessionId || childSessionId === dispatch.rootSessionId) {
    throw new Error("Exact dedicated media Stop identity is required.");
  }
  return { rootSessionId: dispatch.rootSessionId, childSessionId, sessionId: dispatch.sessionId,
    runnerId: dispatch.runnerId, generation: dispatch.generation,
    commandSha256: dispatch.commandSha256, dispatchSha256: dispatch.dispatchSha256 };
}
export function mediaActiveStopRequestBody(value: MediaActiveStopRequest): MediaActiveStopRequest {
  const { operationId, ...identity } = value;
  if (!id(operationId)) throw new Error("Exact dedicated media Stop operation is required.");
  return { ...mediaActiveStopIdentityBody(identity), operationId };
}
export function mediaActiveStopAcknowledgementBody(value: MediaActiveStopAcknowledgement): Omit<MediaActiveStopAcknowledgement, "stopFenceSha256"> {
  const { outcome, stopFenceSha256: _hash, ...request } = value;
  if (!["stop_requested", "unknown"].includes(outcome) || typeof _hash !== "string" || !/^[a-f0-9]{64}$/u.test(_hash)) {
    throw new Error("Dedicated media Stop acknowledgement is malformed.");
  }
  return { ...mediaActiveStopRequestBody(request), outcome };
}
