/**
 * Strict parsing for adding a remote Wollipog instance.
 *
 * A pairing token is a credential. Callers may persist/display `endpoint`, but must send
 * `token` to the credential store instead of serializing the whole pairing result.
 */

const MAX_URL_LENGTH = 2048;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const PAIRING_FRAGMENT_RE = /^#pair=([A-Za-z0-9_-]{16,256})$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const ALLOWED_PATHS = new Set(["/", "/index.html"]);

export interface RemoteInstanceEndpoint {
  /** Canonical HTTP(S) origin. Safe to persist and display; never includes the token. */
  httpOrigin: string;
  /** Canonical WebSocket origin derived from `httpOrigin`. */
  wsOrigin: string;
  /** Plaintext Tailscale links still require native route ownership verification before use. */
  transportSecurity: "tls" | "loopback" | "tailscale-route-required";
}

export interface RemoteInstancePairing {
  /** Non-secret connection metadata. */
  endpoint: RemoteInstanceEndpoint;
  /** Secret credential. Store separately from the instance profile. */
  token: string;
}

export type InstancePairingField = "link" | "origin" | "token";

export type InstancePairingErrorCode =
  | "EMPTY_INPUT"
  | "INPUT_TOO_LONG"
  | "CONTROL_CHARACTER"
  | "INVALID_URL"
  | "UNSUPPORTED_SCHEME"
  | "CREDENTIALS_NOT_ALLOWED"
  | "WILDCARD_HOST_NOT_ALLOWED"
  | "INVALID_PORT"
  | "PATH_NOT_ALLOWED"
  | "QUERY_NOT_ALLOWED"
  | "FRAGMENT_NOT_ALLOWED"
  | "PAIRING_FRAGMENT_REQUIRED"
  | "TOKEN_INVALID"
  | "CLEARTEXT_NOT_ALLOWED";

export interface InstancePairingError {
  code: InstancePairingErrorCode;
  field: InstancePairingField;
  message: string;
}

export type InstancePairingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: InstancePairingError };

function failure<T>(
  code: InstancePairingErrorCode,
  field: InstancePairingField,
  message: string,
): InstancePairingResult<T> {
  return { ok: false, error: { code, field, message } };
}

function tokenResult(token: string, field: InstancePairingField): InstancePairingResult<string> {
  if (!token) return failure("EMPTY_INPUT", field, "Enter the pairing token.");
  if (token.length > 256) return failure("INPUT_TOO_LONG", field, "The pairing token is too long.");
  if (CONTROL_CHARACTER_RE.test(token)) {
    return failure("CONTROL_CHARACTER", field, "The pairing token contains a control character.");
  }
  if (!TOKEN_RE.test(token)) {
    return failure(
      "TOKEN_INVALID",
      field,
      "Enter the complete pairing token (16 to 256 base64url characters).",
    );
  }
  return { ok: true, value: token };
}

function cleartextHostPolicy(hostname: string): "loopback" | "tailscale-route-required" | null {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (host === "[::1]") return "loopback";

  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return null;
  const numbers = octets.map(Number);
  if (numbers.some((octet) => octet > 255)) return null;

  // 127.0.0.0/8 is loopback. 100.64.0.0/10 is the literal Tailscale/CGNAT range.
  if (numbers[0] === 127) return "loopback";
  if (numbers[0] === 100 && numbers[1]! >= 64 && numbers[1]! <= 127) {
    return "tailscale-route-required";
  }
  return null;
}

interface ParsedUrl {
  endpoint: RemoteInstanceEndpoint;
  url: URL;
}

function parseEndpointUrl(raw: string, field: "link" | "origin"): InstancePairingResult<ParsedUrl> {
  if (!raw) return failure("EMPTY_INPUT", field, `Enter the remote instance ${field}.`);
  if (raw.length > MAX_URL_LENGTH) {
    return failure("INPUT_TOO_LONG", field, `The remote instance ${field} is too long.`);
  }
  if (CONTROL_CHARACTER_RE.test(raw)) {
    return failure("CONTROL_CHARACTER", field, `The remote instance ${field} contains a control character.`);
  }
  if (raw !== raw.trim()) {
    return failure("INVALID_URL", field, `The remote instance ${field} must not contain surrounding whitespace.`);
  }
  if (raw.includes("*")) {
    return failure("WILDCARD_HOST_NOT_ALLOWED", field, "Wildcard hosts are not allowed.");
  }
  if (raw.includes("\\")) {
    return failure("INVALID_URL", field, `The remote instance ${field} must not contain backslashes.`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return failure("INVALID_URL", field, `Enter a valid remote instance ${field}.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return failure("UNSUPPORTED_SCHEME", field, "Remote instances must use an HTTP or HTTPS address.");
  }
  // URL accepts shorthand such as `https:example.com`; require an unambiguous absolute URL.
  if (!raw.toLowerCase().startsWith(`${url.protocol}//`)) {
    return failure("INVALID_URL", field, `Enter a complete remote instance ${field}, including //.`);
  }
  if (url.username || url.password) {
    return failure("CREDENTIALS_NOT_ALLOWED", field, "The address must not include a username or password.");
  }
  if (!url.hostname) return failure("INVALID_URL", field, "The address must include a host.");
  if (url.port === "0") return failure("INVALID_PORT", field, "Port 0 is not a valid remote instance port.");
  // URL resolves dot segments before exposing pathname. Check the input spelling as well so
  // `/admin/../` and encoded dot segments do not become an accepted `/` by normalization.
  const authorityStart = raw.indexOf("://") + 3;
  const pathStart = raw.indexOf("/", authorityStart);
  const pathEndCandidates = [raw.indexOf("?", authorityStart), raw.indexOf("#", authorityStart)]
    .filter((index) => index >= 0);
  const endpointEnd = pathEndCandidates.length > 0 ? Math.min(...pathEndCandidates) : raw.length;
  const rawPath = pathStart < 0 || pathStart >= endpointEnd ? "" : raw.slice(pathStart, endpointEnd);
  if (rawPath !== "" && !ALLOWED_PATHS.has(rawPath)) {
    return failure("PATH_NOT_ALLOWED", field, "The address path must be / or /index.html.");
  }
  if (!ALLOWED_PATHS.has(url.pathname)) {
    return failure("PATH_NOT_ALLOWED", field, "The address path must be / or /index.html.");
  }
  // Inspect the raw input too: URL normalizes a trailing `?` to an empty `search` value.
  if (raw.includes("?")) return failure("QUERY_NOT_ALLOWED", field, "The address must not include a query string.");
  // A DNS trailing dot names the same host. Normalize it before applying the transport policy so
  // `localhost.` cannot be treated differently from the reserved `localhost` name.
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  const cleartextPolicy = url.protocol === "http:" ? cleartextHostPolicy(url.hostname) : null;
  if (url.protocol === "http:" && !cleartextPolicy) {
    return failure(
      "CLEARTEXT_NOT_ALLOWED",
      field,
      "HTTP is allowed only for loopback or a literal 100.64.0.0/10 Tailscale address. Use HTTPS for other hosts.",
    );
  }

  const httpOrigin = url.origin;
  const wsOrigin = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  const transportSecurity = url.protocol === "https:" ? "tls" : cleartextPolicy!;
  return { ok: true, value: { endpoint: { httpOrigin, wsOrigin, transportSecurity }, url } };
}

/** Parse a complete link such as `https://host/#pair=<token>`. */
export function parseRemoteInstancePairingLink(link: string): InstancePairingResult<RemoteInstancePairing> {
  const parsed = parseEndpointUrl(link, "link");
  if (!parsed.ok) return parsed;
  const match = PAIRING_FRAGMENT_RE.exec(parsed.value.url.hash);
  if (!match) {
    return failure(
      "PAIRING_FRAGMENT_REQUIRED",
      "link",
      "Paste the complete pairing link ending in #pair=<token>.",
    );
  }
  const token = tokenResult(match[1]!, "link");
  if (!token.ok) return token;
  return { ok: true, value: { endpoint: parsed.value.endpoint, token: token.value } };
}

/** Parse the Advanced form, where the non-secret origin and token are entered separately. */
export function parseRemoteInstanceAdvanced(
  origin: string,
  token: string,
): InstancePairingResult<RemoteInstancePairing> {
  const parsed = normalizeRemoteInstanceOrigin(origin);
  if (!parsed.ok) return parsed;
  const checkedToken = tokenResult(token, "token");
  if (!checkedToken.ok) return checkedToken;
  return { ok: true, value: { endpoint: parsed.value, token: checkedToken.value } };
}

/** Validate and canonicalize a token-free remote origin for profile storage and comparisons. */
export function normalizeRemoteInstanceOrigin(origin: string): InstancePairingResult<RemoteInstanceEndpoint> {
  const parsed = parseEndpointUrl(origin, "origin");
  if (!parsed.ok) return parsed;
  // Inspect the raw input too because URL represents a trailing `#` as an empty hash.
  if (origin.includes("#")) {
    return failure("FRAGMENT_NOT_ALLOWED", "origin", "The origin must not include a fragment or pairing token.");
  }
  return { ok: true, value: parsed.value.endpoint };
}

export interface RemoteInstanceReference {
  id: string;
  httpOrigin: string;
  controlPlaneId?: string | null;
}

/** Find an existing profile for the same canonical endpoint, optionally excluding an edited profile. */
export function findRemoteInstanceOriginDuplicate(
  httpOrigin: string,
  instances: readonly RemoteInstanceReference[],
  excludeId?: string,
): RemoteInstanceReference | null {
  const candidate = normalizeRemoteInstanceOrigin(httpOrigin);
  if (!candidate.ok) return null;
  return instances.find((instance) => {
    if (instance.id === excludeId) return false;
    const existing = normalizeRemoteInstanceOrigin(instance.httpOrigin);
    return existing.ok && existing.value.httpOrigin === candidate.value.httpOrigin;
  }) ?? null;
}

/** Find an existing profile after discovery proves two endpoints are the same control plane. */
export function findRemoteInstanceIdentityDuplicate(
  controlPlaneId: string,
  instances: readonly RemoteInstanceReference[],
  excludeId?: string,
): RemoteInstanceReference | null {
  if (!controlPlaneId) return null;
  return instances.find((instance) =>
    instance.id !== excludeId && instance.controlPlaneId === controlPlaneId
  ) ?? null;
}
