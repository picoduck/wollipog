import {
  isControlPlaneService,
  type RunnerControlPlaneAttestation,
} from "@wollipog/protocol";
import { deriveControlPlaneHttpUrl } from "./control-plane-transport.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_RESPONSE_BYTES = 4_096;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export class ControlPlaneAttestationError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ControlPlaneAttestationError";
  }
}

export interface ControlPlaneAttestationOptions {
  controlPlaneUrl: string;
  runnerId: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  priorCredentialHash?: string;
  allowInsecureTransport?: boolean;
}

function validated(value: unknown): RunnerControlPlaneAttestation | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<RunnerControlPlaneAttestation>;
  return isControlPlaneService(result.service) && typeof result.instanceId === "string" &&
      UUID_V4.test(result.instanceId) && Number.isSafeInteger(result.protocolVersion) &&
      (result.protocolVersion ?? 0) > 0 &&
      (result.priorCredentialValid === undefined || typeof result.priorCredentialValid === "boolean")
    ? result as RunnerControlPlaneAttestation
    : null;
}

function attestationUrl(
  controlPlaneUrl: string,
  runnerId: string,
  allowInsecureTransport = false,
): string {
  if (runnerId.length < 1 || runnerId.length > 128 || runnerId.trim() !== runnerId
      || runnerId === "." || runnerId === ".." || /[\u0000-\u0020\u007f/\\?#]/u.test(runnerId)) {
    throw new ControlPlaneAttestationError(
      "control-plane attestation configuration has an invalid runner id",
      false,
    );
  }
  let root: URL;
  try {
    root = new URL(deriveControlPlaneHttpUrl(controlPlaneUrl, allowInsecureTransport));
  } catch (error) {
    throw new ControlPlaneAttestationError(
      `control-plane attestation configuration is invalid: ${(error as Error).message}`,
      false,
    );
  }
  root.pathname = `${root.pathname.replace(/\/+$/u, "")}/runner/attestation/${encodeURIComponent(runnerId)}`;
  root.hash = "";
  return root.toString();
}

function attestationHeaders(options: ControlPlaneAttestationOptions): Record<string, string> {
  const headers = {
    authorization: `Bearer ${options.token}`,
    ...(options.priorCredentialHash
      ? { "x-wollipog-prior-runner-credential-sha256": options.priorCredentialHash }
      : {}),
  };
  if (options.priorCredentialHash !== undefined && !SHA256_HEX.test(options.priorCredentialHash)) {
    throw new ControlPlaneAttestationError(
      "control-plane attestation configuration has an invalid prior credential hash",
      false,
    );
  }
  try {
    // Fetch would reject malformed header values too, but that deterministic configuration error
    // must not be mistaken for a transient network outage and retried forever.
    new Headers(headers);
  } catch (error) {
    throw new ControlPlaneAttestationError(
      `control-plane attestation configuration has invalid headers: ${(error as Error).message}`,
      false,
    );
  }
  return headers;
}

/** Authenticate the configured runner credential without opening or mutating any local store. */
export async function attestRunnerControlPlane(
  options: ControlPlaneAttestationOptions,
): Promise<RunnerControlPlaneAttestation> {
  const url = attestationUrl(
    options.controlPlaneUrl,
    options.runnerId,
    options.allowInsecureTransport,
  );
  const headers = attestationHeaders(options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  timeout.unref?.();
  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(
        url,
        {
          method: "GET",
          headers,
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new ControlPlaneAttestationError(`control-plane attestation unavailable: ${(error as Error).message}`, true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ControlPlaneAttestationError(
        "control-plane attestation rejected the runner credential or is not supported; verify the runner URL and credential",
        false,
      );
    }
    if (response.status === 404) {
      throw new ControlPlaneAttestationError(
        "control plane does not support runner identity attestation; upgrade the control plane before this runner",
        false,
      );
    }
    if (!response.ok) {
      const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
      throw new ControlPlaneAttestationError(`control-plane attestation returned HTTP ${response.status}`, retryable);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new ControlPlaneAttestationError("control-plane attestation response is too large", false);
    }
    let text: string;
    try {
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            // The response-size violation is permanent regardless of transport cleanup behavior.
            // Do not let a broken cancel() turn it into a retryable read failure.
            await reader.cancel().catch(() => {});
            throw new ControlPlaneAttestationError("control-plane attestation response is too large", false);
          }
          chunks.push(value);
        }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        text = new TextDecoder().decode(body);
      } else {
        text = "";
      }
    } catch (error) {
      if (error instanceof ControlPlaneAttestationError) throw error;
      throw new ControlPlaneAttestationError(
        `control-plane attestation unavailable while reading the response: ${(error as Error).message}`,
        true,
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new ControlPlaneAttestationError("control-plane attestation returned invalid JSON", false);
    }
    const result = validated(decoded);
    if (!result) throw new ControlPlaneAttestationError("control-plane attestation returned an invalid identity", false);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForRunnerControlPlaneAttestation(
  options: ControlPlaneAttestationOptions & {
    wait?: (delayMs: number) => Promise<void>;
    onRetry?: (error: Error, delayMs: number) => void;
  },
): Promise<RunnerControlPlaneAttestation> {
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let delayMs = 1_000;
  for (;;) {
    try {
      return await attestRunnerControlPlane(options);
    } catch (error) {
      if (!(error instanceof ControlPlaneAttestationError) || !error.retryable) throw error;
      options.onRetry?.(error, delayMs);
      await wait(delayMs);
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}
