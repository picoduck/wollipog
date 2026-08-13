import type { AutomationTriggerHeaders } from "./automation-trigger-ingress.js";
import {
  LEGACY_AUTOMATION_TRIGGER_HEADERS,
  WOLLIPOG_AUTOMATION_TRIGGER_HEADERS,
} from "@wollipog/protocol";
export {
  LEGACY_AUTOMATION_TRIGGER_HEADERS,
  LEGACY_CONDUCTOR_ACTOR_SESSION_HEADER,
  LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER,
  LEGACY_POLICY_HOOK_SESSION_HEADER,
  LEGACY_TRANSCRIPT_SHARE_AUTH_SCHEME,
  WOLLIPOG_AUTOMATION_TRIGGER_HEADERS,
  WOLLIPOG_CONDUCTOR_ACTOR_SESSION_HEADER,
  WOLLIPOG_POLICY_HOOK_POLL_CAPABILITY_HEADER,
  WOLLIPOG_POLICY_HOOK_SESSION_HEADER,
  WOLLIPOG_TRANSCRIPT_SHARE_AUTH_SCHEME,
} from "@wollipog/protocol";

export type WireHeaders = { [name: string]: unknown };
export interface RawHttpHeaders {
  headers: WireHeaders;
  headersDistinct?: { [name: string]: string[] | undefined };
  rawHeaders?: string[];
}
export type CompatibleHeaderSelection =
  | { ok: true; value: string | undefined }
  | { ok: false };

/** Select one header generation without allowing duplicate arrays or contradictory identities. */
export function selectCompatibleHeader(
  headers: WireHeaders,
  wollipogName: string,
  legacyName: string,
): CompatibleHeaderSelection {
  const wollipog = headers[wollipogName];
  const legacy = headers[legacyName];
  if ((wollipog !== undefined && typeof wollipog !== "string") ||
      (legacy !== undefined && typeof legacy !== "string")) return { ok: false };
  if (wollipog !== undefined && legacy !== undefined && wollipog !== legacy) return { ok: false };
  return { ok: true, value: wollipog ?? legacy };
}

/** Read one physical HTTP header line. Security-sensitive Authorization parsing must not rely on
 * Node's normalized header map, which can discard or join duplicate field lines. */
export function selectSingleRawHeader(raw: RawHttpHeaders, name: string): CompatibleHeaderSelection {
  const lowerName = name.toLowerCase();
  const distinct = raw.headersDistinct?.[lowerName];
  if (distinct !== undefined) {
    return distinct.length === 1 ? { ok: true, value: distinct[0] } : { ok: false };
  }
  if (raw.rawHeaders) {
    const values: string[] = [];
    for (let index = 0; index + 1 < raw.rawHeaders.length; index += 2) {
      if (raw.rawHeaders[index]!.toLowerCase() === lowerName) values.push(raw.rawHeaders[index + 1]!);
    }
    if (values.length > 0) return values.length === 1 ? { ok: true, value: values[0] } : { ok: false };
  }
  const normalized = raw.headers[lowerName];
  if (normalized === undefined) return { ok: true, value: undefined };
  return typeof normalized === "string" ? { ok: true, value: normalized } : { ok: false };
}

export type AutomationTriggerHeaderSelection =
  | { ok: true; value: AutomationTriggerHeaders }
  | { ok: false };

/** Select one complete signing-header generation. Partial or mixed generations fail closed. */
export function selectAutomationTriggerHeaders(headers: WireHeaders): AutomationTriggerHeaderSelection {
  const wollipog = selectGeneration(headers, WOLLIPOG_AUTOMATION_TRIGGER_HEADERS);
  const legacy = selectGeneration(headers, LEGACY_AUTOMATION_TRIGGER_HEADERS);
  if (!wollipog.ok || !legacy.ok) return { ok: false };
  if (wollipog.value && legacy.value &&
      (wollipog.value.timestamp !== legacy.value.timestamp ||
       wollipog.value.nonce !== legacy.value.nonce ||
       wollipog.value.signature !== legacy.value.signature)) return { ok: false };
  return { ok: true, value: wollipog.value ?? legacy.value ?? {} };
}

function selectGeneration(
  headers: WireHeaders,
  names: { readonly timestamp: string; readonly nonce: string; readonly signature: string },
): { ok: true; value: Required<AutomationTriggerHeaders> | undefined } | { ok: false } {
  const values = [headers[names.timestamp], headers[names.nonce], headers[names.signature]];
  if (values.some((value) => value !== undefined && typeof value !== "string")) return { ok: false };
  const present = values.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== values.length) return { ok: false };
  if (present === 0) return { ok: true, value: undefined };
  return {
    ok: true,
    value: {
      timestamp: values[0] as string,
      nonce: values[1] as string,
      signature: values[2] as string,
    },
  };
}
