import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  MAX_PROMPT_IMAGE_BYTES,
  PROMPT_IMAGE_MIME_TYPES,
  type PromptImage,
  type PromptImageReference,
} from "@wollipog/protocol";
import { deriveCpHttpUrl } from "./conductor.js";

export interface PromptImageFetchConfig {
  controlPlaneUrl: string;
  runnerId: string;
  tokenFile: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  allowInsecureTransport?: boolean;
}

async function boundedBody(response: Response, expectedBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error("prompt image response has no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedBytes || total > MAX_PROMPT_IMAGE_BYTES) {
        throw new Error("prompt image response exceeds its declared byte length");
      }
      chunks.push(Buffer.from(value));
    }
    if (total !== expectedBytes) throw new Error("prompt image response byte length does not match its reference");
    return Buffer.concat(chunks, total);
  } catch (error) {
    // Refusal must stop the producer too: releasing the lock alone leaves an oversized response
    // free to continue buffering into the runner after the caller has already rejected it.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Fetch and verify one immutable reference. No redirects, ambient cookies, or cached credentials. */
export async function fetchPromptImageReference(
  config: PromptImageFetchConfig,
  sessionId: string,
  reference: PromptImageReference,
): Promise<PromptImage> {
  if (!(PROMPT_IMAGE_MIME_TYPES as readonly string[]).includes(reference.mimeType) ||
      !reference.artifactId || reference.artifactId.length > 256 || /[\x00-\x1f\x7f]/.test(reference.artifactId) ||
      !Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes <= 0 ||
      reference.sizeBytes > MAX_PROMPT_IMAGE_BYTES || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
    throw new Error("prompt image reference metadata is invalid");
  }
  const token = readFileSync(config.tokenFile, "utf8").trim();
  if (!token) throw new Error("runner credential file is empty");
  const root = deriveCpHttpUrl(config.controlPlaneUrl, config.allowInsecureTransport);
  const url = new URL(
    `/runner/${encodeURIComponent(config.runnerId)}/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(reference.artifactId)}`,
    `${root}/`,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
  try {
    const response = await (config.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: reference.mimeType },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`prompt image fetch failed with HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== reference.mimeType) throw new Error("prompt image response MIME type does not match its reference");
    const contentLength = response.headers.get("content-length");
    if (!contentLength || !/^\d+$/.test(contentLength) || Number(contentLength) !== reference.sizeBytes) {
      throw new Error("prompt image response content length does not match its reference");
    }
    const bytes = await boundedBody(response, reference.sizeBytes);
    if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
      throw new Error("prompt image response digest does not match its reference");
    }
    return { mimeType: reference.mimeType, data: bytes.toString("base64") };
  } finally {
    clearTimeout(timer);
  }
}

export function createPromptImageFetcher(config: PromptImageFetchConfig) {
  return async (sessionId: string, references: PromptImageReference[]): Promise<PromptImage[]> =>
    Promise.all(references.map((reference) => fetchPromptImageReference(config, sessionId, reference)));
}
