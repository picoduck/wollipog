/** Shared transport policy for every runner connection that carries a control-plane credential. */

import { isIP } from "node:net";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") ||
    normalized === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."));
}

/** Parse and enforce the runner's credential-bearing control-plane transport policy. */
export function validateControlPlaneUrl(
  controlPlaneUrl: string,
  allowInsecureTransport = false,
): URL {
  const configured = new URL(controlPlaneUrl);
  if (configured.protocol !== "ws:" && configured.protocol !== "wss:") {
    throw new Error("control-plane URL must use ws:// or wss://");
  }
  if (configured.username || configured.password) {
    throw new Error("control-plane URL must not contain embedded credentials");
  }
  if (configured.protocol === "ws:" && !isLoopbackHostname(configured.hostname) && !allowInsecureTransport) {
    throw new Error(
      "refusing insecure ws:// control-plane transport to a non-loopback host; " +
      "use wss:// or pass --allow-insecure-transport to acknowledge token exposure",
    );
  }
  return configured;
}

/** Derive the HTTP side-channel root only after applying the same credential transport policy. */
export function deriveControlPlaneHttpUrl(
  controlPlaneUrl: string,
  allowInsecureTransport = false,
): string {
  const configured = validateControlPlaneUrl(controlPlaneUrl, allowInsecureTransport);
  configured.protocol = configured.protocol === "wss:" ? "https:" : "http:";
  configured.pathname = configured.pathname.replace(/\/runner\/?$/u, "");
  return configured.toString().replace(/\/+$/u, "");
}
