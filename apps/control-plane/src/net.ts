/** Small networking helpers for the onboarding endpoint. Pure + unit-tested. */

/**
 * True for loopback client addresses. Direct loopback remains the trusted bootstrap
 * boundary; forwarded/proxied requests are deliberately not treated as local.
 */
export function isLoopback(ip: string | undefined | null): boolean {
  if (!ip) return false;
  // Express/Fastify may report IPv4-mapped IPv6 (::ffff:127.0.0.1).
  const v = normalizedIp(ip);
  return v === "::1" || v === "127.0.0.1" || v.startsWith("127.");
}

/**
 * Tailscale assigns device IPv4 addresses from 100.64.0.0/10. Keep this check deliberately
 * literal: the tailnet-only listener gate uses the socket peer/local addresses and never trusts
 * forwarding headers, DNS names, or browser input.
 */
export function isTailnetIpv4(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const parts = normalizedIp(ip).split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet, index) => !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index])) {
    return false;
  }
  return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

/**
 * Tailnet access is accepted only when the request arrived through a Tailscale address on this
 * machine. Checking both endpoints prevents a LAN client from reaching the wildcard listener
 * through a Wi-Fi/Ethernet address, even if that client's own address happens to use CGNAT space.
 * Loopback stays available so the packaged desktop shell continues to use its local sidecar.
 */
export function isTailnetOrLoopbackConnection(
  remoteAddress: string | undefined | null,
  localAddress: string | undefined | null,
): boolean {
  return (
    (isLoopback(remoteAddress) && isLoopback(localAddress)) ||
    (isTailnetIpv4(remoteAddress) && isTailnetIpv4(localAddress))
  );
}

/** Only the IPv4 addresses that can produce a working tailnet-only browser URL. */
export function tailnetIpv4(addresses: string[]): string[] {
  return addresses.filter((address) => isTailnetIpv4(address));
}

function normalizedIp(ip: string): string {
  const unwrapped = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  return unwrapped.startsWith("::ffff:") ? unwrapped.slice(7) : unwrapped;
}

/**
 * Is the control plane's BIND host loopback-only? Unlike `isLoopback` (which classifies a peer
 * IP), this sees the configured `CONTROL_PLANE_HOST`, which may be a NAME — `localhost` binds to
 * loopback but is not an IP literal, so an IP-only check would wrongly advertise LAN pairing
 * links for a server nothing else can reach.
 */
export function isLoopbackBindHost(host: string): boolean {
  // Strip brackets (IPv6 literal), any IPv6 zone id, and a single FQDN trailing dot — `localhost.`
  // resolves to loopback exactly like `localhost`.
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "").replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || isLoopback(h);
}

/** Does this bind host accept connections on every interface? */
export function isWildcardBindHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "");
  return h === "0.0.0.0" || h === "::" || h === "";
}

/**
 * Hosts a pairing link may legitimately point at, given the bind host and this machine's LAN
 * addresses. Loopback bind → none (nothing else can reach it). Wildcard bind → every LAN
 * address. A specific bind → only that address: advertising the other interfaces would hand out
 * links to ports nothing is listening on.
 */
export function pairingHosts(bindHost: string, lanIps: string[]): string[] {
  if (isLoopbackBindHost(bindHost)) return [];
  if (isWildcardBindHost(bindHost)) return lanIps;
  return [bindHost];
}

/**
 * Build the runner WebSocket URL from the control plane's bound host + port.
 * A loopback/any-address bind isn't reachable from another machine, so we show
 * 127.0.0.1 as the default; IPv6 literals are bracketed so the URL stays valid.
 */
export function buildRunnerWsUrl(host: string, port: number): string {
  const display = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const hostPart = isIpv6Literal(display) ? `[${display}]` : display;
  return `ws://${hostPart}:${port}/runner`;
}

/** An IPv6 literal (has a colon) that isn't already bracketed. */
function isIpv6Literal(host: string): boolean {
  return host.includes(":") && !host.startsWith("[");
}

/**
 * Whether a browser Origin may use the control plane. Used by BOTH the REST CORS
 * policy and the /ui WebSocket gate (browsers don't enforce CORS on WS upgrades, so
 * that route must check the Origin itself). Allows loopback and the reserved
 * `.localhost` TLD (RFC 6761 — always loopback; covers the Tauri shell's
 * `http://tauri.localhost`). A missing Origin = a non-browser client (curl, native
 * app), which isn't a browser CSRF/snooping vector, so it's allowed.
 */
export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}
