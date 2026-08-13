import { WOLLIPOG_TRANSCRIPT_SHARE_AUTH_SCHEME } from "@wollipog/protocol";

const SHARE_FRAGMENT_KEY = "share";
const SHARE_HISTORY_KEY = "wollipogTranscriptShareToken";
const LEGACY_SHARE_HISTORY_KEY = "mamTranscriptShareToken";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface TranscriptShareBoot {
  requested: boolean;
  token: string | null;
}

export function parseTranscriptShareFragment(hash: string): TranscriptShareBoot {
  const prefix = hash.startsWith("#") ? "#" : "";
  const requested = hash.startsWith(`${prefix}${SHARE_FRAGMENT_KEY}=`);
  if (!requested) return { requested: false, token: null };
  const match = new RegExp(`^${prefix ? "#" : ""}${SHARE_FRAGMENT_KEY}=([A-Za-z0-9_-]{43})$`).exec(hash);
  return { requested: true, token: match?.[1] && TOKEN_PATTERN.test(match[1]) ? match[1] : null };
}

function validHistoryToken(value: unknown): string | null {
  return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : null;
}

function shareHistoryState(state: unknown, token: string | null): Record<string, unknown> {
  const current = state && typeof state === "object" ? state as Record<string, unknown> : {};
  const {
    [SHARE_HISTORY_KEY]: _currentToken,
    [LEGACY_SHARE_HISTORY_KEY]: _legacyToken,
    ...rest
  } = current;
  return token ? { ...rest, [SHARE_HISTORY_KEY]: token } : rest;
}

/** Move a fragment capability out of the address bar before any network or application boot. */
export function adoptTranscriptShareFragment(): TranscriptShareBoot {
  const parsed = parseTranscriptShareFragment(window.location.hash);
  if (parsed.requested) {
    const state = shareHistoryState(window.history.state, parsed.token);
    window.history.replaceState(state, "", `${window.location.pathname}${window.location.search}`);
    return parsed;
  }
  const state = window.history.state;
  const record = state && typeof state === "object" ? state as Record<string, unknown> : {};
  const retained = validHistoryToken(record[SHARE_HISTORY_KEY]) ??
    validHistoryToken(record[LEGACY_SHARE_HISTORY_KEY]);
  if (Object.hasOwn(record, SHARE_HISTORY_KEY) || Object.hasOwn(record, LEGACY_SHARE_HISTORY_KEY)) {
    // Canonicalize even invalid state so a stale capability never survives under either name.
    window.history.replaceState(shareHistoryState(record, retained), "");
  }
  return retained ? { requested: true, token: retained } : parsed;
}

export function transcriptShareRequest(baseUrl: string, token: string): { url: string; init: RequestInit } {
  return {
    url: `${baseUrl}/api/public/transcript-share`,
    init: {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: { authorization: `${WOLLIPOG_TRANSCRIPT_SHARE_AUTH_SCHEME} ${token}`, accept: "application/json" },
    },
  };
}

/** Host/proxy headers are never trusted to construct a credential-bearing link. */
export function transcriptShareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/#share=${encodeURIComponent(token)}`;
}

/** Refuse links that would send a recipient to their own machine or to a wildcard bind address. */
export function reachableTranscriptShareOrigin(
  pageOrigin: string,
  controlPlaneOrigin: string,
  sameOriginServed: boolean,
): string | null {
  const candidate = sameOriginServed ? pageOrigin : controlPlaneOrigin;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const loopbackV4 = /^127(?:\.\d{1,3}){3}$/.test(host);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" ||
      host === "0.0.0.0" || host === "::" || host.startsWith("::ffff:") || loopbackV4) return null;
  return url.origin;
}
