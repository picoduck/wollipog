import { createHmac, timingSafeEqual } from "node:crypto";

export const MANAGED_DESKTOP_LAUNCH_ID_ENV = "WOLLIPOG_DESKTOP_LAUNCH_ID";
export const MANAGED_DESKTOP_SECRET_ENV = "WOLLIPOG_DESKTOP_LAUNCH_SECRET";

export const EXIT_RISK_REQUEST_DOMAIN = "wollipog.desktop.exit-risk.request.v1\0";
export const EXIT_RISK_RESPONSE_DOMAIN = "wollipog.desktop.exit-risk.response.v1\0";
export const PROVISION_REQUEST_DOMAIN = "wollipog.desktop.managed-provision.request.v1\0";
export const PROVISION_RESPONSE_DOMAIN = "wollipog.desktop.managed-provision.response.v1\0";

const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface ManagedDesktopIdentity {
  launchId: string;
  secret: Buffer;
}

/** Decode unpadded canonical base64url with an exact decoded length. */
export function decodeCanonicalBase64url(value: unknown, byteLength: number): Buffer | null {
  if (typeof value !== "string" || !CANONICAL_BASE64URL.test(value) || value.includes("=")) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === byteLength && decoded.toString("base64url") === value ? decoded : null;
}

/**
 * Remove inherited launch material from the live environment before any server, worker or
 * descendant starts, so this process cannot pass it onward. Some operating systems retain an
 * initial process-environment snapshot readable by the same user; that user can already read the
 * local owner-token file, so this proof does not claim a stronger same-user isolation boundary.
 * Deletion happens before validation and on every path.
 */
export function takeManagedDesktopIdentity(
  env: NodeJS.ProcessEnv = process.env,
): ManagedDesktopIdentity | null {
  const launchId = env[MANAGED_DESKTOP_LAUNCH_ID_ENV];
  const encodedSecret = env[MANAGED_DESKTOP_SECRET_ENV];
  delete env[MANAGED_DESKTOP_LAUNCH_ID_ENV];
  delete env[MANAGED_DESKTOP_SECRET_ENV];

  if (typeof launchId !== "string" || !/^[0-9a-f]{32}$/u.test(launchId)) return null;
  const secret = decodeCanonicalBase64url(encodedSecret, 32);
  return secret ? { launchId, secret } : null;
}

export function managedDesktopMac(
  identity: ManagedDesktopIdentity,
  domain: string,
  challenge: Buffer,
  payload: Buffer | string,
): string {
  return createHmac("sha256", identity.secret)
    .update(domain, "utf8")
    .update(challenge)
    .update(payload)
    .digest("base64url");
}

export function verifyManagedDesktopRequest(input: {
  identity: ManagedDesktopIdentity;
  domain: string;
  launchId: unknown;
  challenge: unknown;
  mac: unknown;
  runnerId: string;
}): { challenge: Buffer } | null {
  if (input.launchId !== input.identity.launchId) return null;
  const challenge = decodeCanonicalBase64url(input.challenge, 32);
  const presented = decodeCanonicalBase64url(input.mac, 32);
  if (!challenge || !presented) return null;
  const expected = Buffer.from(
    managedDesktopMac(input.identity, input.domain, challenge, input.runnerId),
    "base64url",
  );
  return timingSafeEqual(presented, expected) ? { challenge } : null;
}
