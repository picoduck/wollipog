/** Exact managed-media launch identity. Receipt authentication comes from the owning runner
 * channel, never the digest itself or a worker message. No media/budget/gate access is granted. */
export interface MediaDispatchFenceIdentity {
  rootSessionId: string; sessionId: string; runnerId: string; generation: string;
  commandSha256: string; dispatchSha256: string;
}
export interface MediaNeverDispatchedFence extends MediaDispatchFenceIdentity {
  outcome: "never_dispatched";
  fenceSha256: string;
}
export function validMediaDispatchFenceIdentity(value: MediaDispatchFenceIdentity): boolean {
  const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/u.test(v);
  const sha = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 6 && Object.keys(value).every((key) =>
      ["rootSessionId", "sessionId", "runnerId", "generation", "commandSha256", "dispatchSha256"].includes(key)) &&
    [value.rootSessionId, value.sessionId, value.runnerId, value.generation].every(id) &&
    value.rootSessionId !== value.sessionId && sha(value.commandSha256) && sha(value.dispatchSha256));
}
/** Stable serialization; reordered JSON properties cannot change the command identity. */
export function mediaDispatchFenceBody(identity: MediaDispatchFenceIdentity): Omit<MediaNeverDispatchedFence, "fenceSha256"> {
  if (!validMediaDispatchFenceIdentity(identity)) throw new Error("Exact managed media command identity is required.");
  return { rootSessionId: identity.rootSessionId, sessionId: identity.sessionId, runnerId: identity.runnerId,
    generation: identity.generation, commandSha256: identity.commandSha256, dispatchSha256: identity.dispatchSha256,
    outcome: "never_dispatched" as const };
}
export function validMediaNeverDispatchedFence(value: MediaNeverDispatchedFence): boolean {
  if (!value || Object.keys(value).length !== 8 || value.outcome !== "never_dispatched") return false;
  const { outcome: _outcome, fenceSha256, ...identity } = value;
  // The authenticated Node consumer separately hashes the canonical body. Browser-safe shape
  // validation cannot certify the channel, permanent runner fence, or receipt integrity.
  return validMediaDispatchFenceIdentity(identity) && typeof fenceSha256 === "string" && /^[a-f0-9]{64}$/u.test(fenceSha256);
}
