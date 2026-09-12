import { isLoopbackBindHost } from "./net.js";

export const PUBLIC_ORIGIN_ENV = "CONTROL_PLANE_PUBLIC_ORIGIN";

export interface PublicOriginResolution {
  /** Normalized `scheme://host[:port]` with no trailing slash, or null when unset. */
  origin: string | null;
  /** Non-fatal operator warning (for example plain HTTP beyond loopback). */
  warning: string | null;
  /** Fatal configuration error; the control plane must not start with a broken origin. */
  error: string | null;
}

/**
 * Validate the dashboard origin that pairing links embed when the control plane sits behind
 * Tailscale, a reverse proxy, or any address that differs from its bind host. Only an absolute
 * `http(s)` origin without path, query, fragment, or credentials is accepted, so a mis-set value
 * can never produce a link that leaks the token to an unintended host or path.
 */
export function resolvePublicOrigin(raw: string | undefined): PublicOriginResolution {
  const value = raw?.trim() ?? "";
  if (!value) return { origin: null, warning: null, error: null };
  return validatePublicOrigin(value);
}

export function validatePublicOrigin(value: string): PublicOriginResolution {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { origin: null, warning: null, error: `${PUBLIC_ORIGIN_ENV} must be an absolute http(s) origin such as https://wollipog.example.ts.net` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { origin: null, warning: null, error: `${PUBLIC_ORIGIN_ENV} must use http or https, got ${url.protocol.replace(/:$/, "")}` };
  }
  if (url.username || url.password) {
    return { origin: null, warning: null, error: `${PUBLIC_ORIGIN_ENV} must not embed credentials` };
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return { origin: null, warning: null, error: `${PUBLIC_ORIGIN_ENV} must be a bare origin without path, query, or fragment` };
  }
  const origin = url.origin;
  const warning = url.protocol === "http:" && !isLoopbackBindHost(url.hostname)
    ? `${PUBLIC_ORIGIN_ENV} ${origin} uses plain HTTP beyond loopback; pairing tokens and session data travel unencrypted. Use HTTPS or a Tailscale HTTPS origin.`
    : null;
  return { origin, warning, error: null };
}

/** A complete pairing link for a browser or the desktop app's Add Remote Instance dialog. */
export function pairingUrlForOrigin(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/#pair=${token}`;
}
