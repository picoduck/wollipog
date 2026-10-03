import { versionAtLeast } from "../discovery/codex-app-server.js";

export interface CodexInferenceConfiguration {
  provider: "openai" | "custom" | "unknown";
  configuredTransport: "websocket" | "http" | "unknown";
  reason: "native_openai_default" | "custom_provider_opt_in" | "provider_websockets_disabled" |
    "version_unverified" | "configuration_unavailable";
}

/** The provider id comes from thread/start or thread/resume, not the launch default: a resumed
 * thread may retain a custom provider. Never serialize provider names, endpoints, or config. */
export function codexInferenceConfiguration(
  providerId: unknown,
  config: unknown,
  serverIdentity: string,
): CodexInferenceConfiguration {
  if (typeof providerId !== "string" || !providerId) {
    return { provider: "unknown", configuredTransport: "unknown", reason: "configuration_unavailable" };
  }
  if (providerId === "openai") {
    // Official source at the verified App Server floor 0.147.0 and at 0.160.0 sets this built-in
    // provider's supports_websockets=true. 0.160.0 rejects redefining it as a reserved provider;
    // the removed responses_websockets feature flags are not a supported way to enable it.
    // initialize uses the client's name (wollipog) with the server's installed CLI version.
    const version = serverIdentity.match(/\b(?:wollipog|codex[^/\s]*)\/(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i)?.[1];
    return version && versionAtLeast(version)
      ? { provider: "openai", configuredTransport: "websocket", reason: "native_openai_default" }
      : { provider: "openai", configuredTransport: "unknown", reason: "version_unverified" };
  }
  const providers = record(record(config)?.model_providers);
  const definition = providers && Object.hasOwn(providers, providerId) ? record(providers[providerId]) : null;
  if (!definition) {
    return { provider: "custom", configuredTransport: "unknown", reason: "configuration_unavailable" };
  }
  return definition.supports_websockets === true
    ? { provider: "custom", configuredTransport: "websocket", reason: "custom_provider_opt_in" }
    : { provider: "custom", configuredTransport: "http", reason: "provider_websockets_disabled" };
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Match Codex's fixed warning, then discard its provider-controlled error suffix. That suffix
 * may contain response bodies, URLs, or credentials. Configuration alone never proves traffic. */
export function codexHttpFallbackWarning(value: unknown): boolean {
  return typeof value === "string" &&
    /Falling back from WebSockets to HTTPS transport\b|\bfalling back to HTTP\b/i.test(value);
}
