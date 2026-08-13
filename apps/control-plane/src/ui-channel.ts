import {
  MAX_UI_POD_SUBSCRIPTIONS,
  MAX_UI_SESSION_SUBSCRIPTIONS,
  type UiToControlPlane,
} from "@wollipog/protocol";

export const MAX_UI_SESSION_ID_LENGTH = 128;
export const MAX_UI_CLIENT_MESSAGE_BYTES = 64 * 1024;

export { MAX_UI_POD_SUBSCRIPTIONS, MAX_UI_SESSION_SUBSCRIPTIONS };

/** Normalize every ws.RawData shape without relying on Array#toString (which inserts commas
 * between Buffer fragments and turns ArrayBuffer into "[object ArrayBuffer]"). */
export function normalizeUiClientRawData(raw: unknown): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) return Buffer.concat(raw);
  return null;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_UI_SESSION_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

/** The browser channel has one intentionally narrow client message. Reject unknown fields and
 * duplicate ids so malformed/unbounded frames cannot become persistent per-socket state. */
export function parseUiClientMessage(text: string): UiToControlPlane | null {
  if (Buffer.byteLength(text, "utf8") > MAX_UI_CLIENT_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "session_subscriptions" || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 ||
      !Array.isArray(raw.sessionIds) || !Array.isArray(raw.podIds)) return null;
  if (Object.keys(raw).some((key) => key !== "type" && key !== "revision" && key !== "sessionIds" && key !== "podIds")) return null;
  if (raw.sessionIds.length > MAX_UI_SESSION_SUBSCRIPTIONS || !raw.sessionIds.every(validSessionId)) return null;
  if (raw.podIds.length > MAX_UI_POD_SUBSCRIPTIONS || !raw.podIds.every(validSessionId)) return null;
  if (new Set(raw.sessionIds).size !== raw.sessionIds.length) return null;
  if (new Set(raw.podIds).size !== raw.podIds.length) return null;
  return {
    type: "session_subscriptions",
    revision: raw.revision as number,
    sessionIds: raw.sessionIds,
    podIds: raw.podIds,
  };
}
