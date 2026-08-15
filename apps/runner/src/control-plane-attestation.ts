import {
  isControlPlaneService,
  type RunnerControlPlaneAttestation,
} from "@wollipog/protocol";
import { deriveCpHttpUrl } from "./conductor.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_RESPONSE_BYTES = 4_096;

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
}

function validated(value: unknown): RunnerControlPlaneAttestation | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<RunnerControlPlaneAttestation>;
  return isControlPlaneService(result.service) && typeof result.instanceId === "string" &&
      UUID_V4.test(result.instanceId) && Number.isSafeInteger(result.protocolVersion) &&
      (result.protocolVersion ?? 0) > 0
    ? result as RunnerControlPlaneAttestation
    : null;
}

/** Authenticate the configured runner credential without opening or mutating any local store. */
export async function attestRunnerControlPlane(
  options: ControlPlaneAttestationOptions,
): Promise<RunnerControlPlaneAttestation> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  timeout.unref?.();
  try {
    let response: Response;
    try {
      const root = deriveCpHttpUrl(options.controlPlaneUrl);
      response = await (options.fetchImpl ?? fetch)(
        `${root}/runner/attestation/${encodeURIComponent(options.runnerId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${options.token}` },
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new ControlPlaneAttestationError(`control-plane attestation unavailable: ${(error as Error).message}`, true);
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new ControlPlaneAttestationError(
        "control-plane attestation rejected the runner credential or is not supported; verify the runner URL and credential",
        false,
      );
    }
    if (!response.ok) {
      throw new ControlPlaneAttestationError(`control-plane attestation returned HTTP ${response.status}`, response.status >= 500);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new ControlPlaneAttestationError("control-plane attestation response is too large", false);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new ControlPlaneAttestationError("control-plane attestation response is too large", false);
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
